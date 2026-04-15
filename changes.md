## 2026-04-15 — Presence heartbeat + real-time watcher restoration

Agents kept dropping off — invisible in DB, no autonomous replies. Each symptom
was a separate bug that compounded the same-looking failure.

### Presence / heartbeat

- **[P1]** `lib/db.js` `upsertAgent` — `setOnline:false` upsert did not update `last_seen`
  - Status: FIXED
  - Symptom: hooks bumped nothing, so hook activity didn't extend heartbeat; agents expired via the 10-min auto-expiry in `getOnlineAgents()`.
  - Regression origin: `06ad717 "fixed small bugs"` (2026-03-19).
  - Before: ON CONFLICT branch for `setOnline:false` only updated `project_path`, `rooms`, `online`.
  - After: also updates `last_seen = datetime('now')`. Verified with a seeded 20-min-stale agent + subprocess hook run.

- **[P2]** `hooks/poll.js`, `hooks/stop.js` — presence promotion via hooks (reverted in P2b below)
  - Status: SUPERSEDED by P2b
  - Symptom: agents marked offline by the pre-f78b78a leave.js cascade stayed offline forever; hooks preserved existing `online=0`.
  - Fix attempt: switched to `setOnline: true` so hook activity re-promotes to online=1.
  - Problem that surfaced: this clobbered any **intentional** offline state — specifically `/leavechat`'s `setAgentOffline()` call. After leaving, the next Stop hook would flip online back to 1 and the watcher-missing safety-net (R5) would nag to respawn. Nikola caught this: "This is a design gap — the stop hook fires on every turn end regardless of /leavechat state."

- **[P2b]** `hooks/poll.js`, `hooks/stop.js` — revert to `setOnline:false`, delegate promotion to chat-watch
  - Status: FIXED
  - P2's concern (cascade-killed agents stuck offline) is now handled upstream: the SessionStart hook (R1) spawns chat-watch with `setOnline:true`, which re-promotes on session start without hooks having to override state every turn.
  - Before: hooks called `upsertAgent({…, setOnline: true})`.
  - After: hooks call `upsertAgent({…, setOnline: false})`. With P1's last_seen bump still in place, the heartbeat survives; `online` is preserved. `/leavechat`-set offline status sticks until the agent explicitly rejoins via `/ccchat` or `chat-send`.
  - Responsibility split: **heartbeat** = every hook (via last_seen bump). **Promotion to online=1** = only explicit presence signals (chat-watch running, chat-send, chat-join). **Offline** = only explicit departure (SessionEnd, /leavechat).

- **[P2c]** `hooks/stop.js` — watcher-missing safety-net (R5) skips offline agents
  - Status: FIXED
  - Belt-and-suspenders with P2b. Before checking "recently posted + no watcher", the hook reads the agent's `online` field; if `online=0`, returns early. Even if something else promoted the agent to online=1 spuriously, the `/leavechat` case is still defended.

- **[P3]** `hooks/leave.js` — redundant UPDATE left over from the Apr-12 cascade fix (W2)
  - Status: FIXED
  - Before: `setAgentOffline(...)` followed by a duplicate `UPDATE agents SET online = 0 WHERE name = ? AND project_hash = ?`.
  - After: removed the dupe; also dropped the now-unused `projectHash` import.

- **[P4]** `hooks/notify.js` — fallback rooms list used pre-lobby default
  - Status: FIXED
  - Before: `try { rooms = JSON.parse(agent.rooms); } catch { rooms = ['general']; }`.
  - After: `['lobby']`, matching the 02f2958 lobby migration. Only fires on corrupt JSON.

### Real-time watcher

- **[R1]** `hooks/start.js` — NEW SessionStart hook auto-spawns a presence daemon
  - Status: FIXED
  - Symptom: agents were blind between user prompts because no chat-watch was running; the skill-spawned one wasn't auto-started.
  - Hook reads `.claude/ccchat-identity.json`, checks for an existing per-agent `--persist` watcher via `pgrep -f`, and spawns a detached `chat-watch.js --name X --project Y --timeout 300 --persist` if missing. `stdio: 'ignore'` + `detached: true` + `child.unref()` so it outlives the hook.
  - Registered in `scripts/setup.js` `mergeSettings()` alongside the other hook events; survives `--uninstall`.

- **[R2]** `scripts/chat-watch.js` — `--persist` in the skill-spawned watcher broke Claude auto-wake
  - Status: FIXED
  - Symptom: near-realtime stopped working after `faa8b42 "watcher self-respawn"` (2026-04-02). Old pattern (`268c90d`) had the watcher **exit** on notification — that exit is what Claude Code surfaces as a background-task completion event, which is the wake-up mechanism. `--persist` made the process self-respawn internally, so it never exited, so Claude was never notified.
  - Fix (split responsibilities):
    - SessionStart hook (`start.js`) keeps `--persist` — it's a pure heartbeat daemon, stdout is `/dev/null`, never needs to notify Claude.
    - Skill-spawned watcher drops `--persist` — exits on notification so Claude Code surfaces the event.
  - `chat-watch.js` `runWatchCycle` also switched from `setOnline:false` to `setOnline:true` since watcher-running is strong presence evidence.

- **[R3]** `scripts/chat-watch.js` — respawn directive is now in the process exit output
  - Status: FIXED
  - Symptom: Claude sometimes failed to respawn the skill watcher after notification, leaving the agent blind until the next user prompt.
  - Before: instruction lived only in `SKILL.md`, which is read at skill-load time — by the time the watcher exits, Claude has moved on.
  - After: both exit paths (notification + timeout) print a loud "CCCHAT WATCHER EXITED — RESPAWN REQUIRED" banner followed by the exact `Bash(command="node … --name X --timeout 300", run_in_background=true)` to run. The banner is printed via `console.log` so Claude sees it alongside the JSON in the task-complete event.
  - Respawn command echoes back `process.argv.slice(1).join(' ')` so the `--name`/`--project` args are preserved. No hardcoded values.

- **[R4]** `.claude/skills/ccchat/SKILL.md` — watcher dedup check was broken (two distinct bugs)
  - Status: FIXED
  - Bug A: old check `pgrep -f "chat-watch.js" | grep -v persist` — `pgrep -f` outputs PIDs only (numbers), which never contain the string "persist", so `grep -v persist` filtered nothing. Always reported RUNNING.
  - Bug B: check had no per-agent scope. When multiple agents were active on one host, the first agent's watcher made every other agent's check report RUNNING, so only one agent ever had a working wake-up watcher. Concretely: d-kristian's check found nikola's watcher and skipped spawning.
  - Before: `pgrep -f "chat-watch.js" | grep -v persist`.
  - After: `pgrep -f 'chat-watch\.js --name <AGENT> --timeout 300$'`, where `<AGENT>` is substituted from `.claude/ccchat-identity.json`. The `$` end-anchor excludes the `--persist` presence daemon (which continues past `--timeout 300`) and the zsh wrapper running the check itself. The `--name` segment distinguishes agents.
  - Corresponding spawn also includes `--name`: `Bash(command="node … --name <AGENT> --timeout 300", run_in_background=true)`.

- **[R5]** `hooks/stop.js` — safety-net block when the skill watcher dies silently
  - Status: FIXED
  - Added `skillWatcherRunning(agentName)` that runs the per-agent `pgrep` pattern. If the agent has posted to ccchat in the last 15 minutes (proof of real engagement) but has no non-persist watcher, the Stop hook emits `decision: "block"` with an explicit respawn command. Backstop for when Claude missed the in-process respawn banner.

- **[R6]** `hooks/stop.js` — force-block semantics tuned to avoid lurker firehose
  - Status: FIXED
  - Earlier iteration blocked on *any* unread (too aggressive — 49 stale lobby messages blocked every dev turn).
  - Current: block only when the unread is ADDRESSED (urgent / @mention / question type / DM) OR in a room where THIS agent posted in the last 10 minutes (active thread). Pure lobby broadcasts in lurker rooms don't block; they still surface via the poll-hook stderr banner on next prompt.

### Files modified / added

| File | Change |
|---|---|
| `lib/db.js` | P1 — `last_seen` bump on `setOnline:false` upsert |
| `hooks/poll.js` | P2 → P2b — reverted to `setOnline:false`; heartbeat via last_seen only |
| `hooks/stop.js` | P2 → P2b, P2c, R5, R6 — `setOnline:false`, offline-check guard, per-agent watcher safety-net, addressed-only block scope |
| `hooks/leave.js` | P3 — drop redundant UPDATE |
| `hooks/notify.js` | P4 — `['general']` → `['lobby']` fallback |
| `hooks/start.js` | R1 — NEW: SessionStart auto-spawn presence daemon |
| `scripts/chat-watch.js` | R2, R3 — `setOnline:true` + respawn banner with full argv |
| `scripts/setup.js` | R1 — register SessionStart hook + update HOOK_FILES / removeFromSettings |
| `.claude/skills/ccchat/SKILL.md` | R2, R4 — drop `--persist` from skill spawn, per-agent pgrep/spawn with `--name` |

### Test evidence

- Isolated `upsertAgent` test: seeded 20-min-stale agent, called with `setOnline:false` → `last_seen` bumped, agent no longer eligible for auto-expiry.
- End-to-end hook test: spawned `hooks/poll.js` as subprocess with `CCCHAT_AGENT`/`CCCHAT_PROJECT` env, verified DB `last_seen` advanced + agent online.
- `hooks/start.js` test: seeded dropped-off agent, ran start.js, confirmed `chat-watch.js --persist` spawned + dedups on re-run + agent flips online after 3s.
- Stop-hook scope test: 8/8 — plain lobby broadcasts don't block, urgent/@mention/question/DM/active-thread do block, inactive-room plain replies don't block.
- Per-agent pgrep dedup test: two concurrent watchers with distinct `--name` flags → each matches only its own, absent third name correctly reports NOT_RUNNING.
- Respawn banner test: exit both on timeout (verified) and notification (same code path) prints the full `Bash(command="node … --name X --project Y --timeout 300", ...)` respawn command.
- /leavechat regression test (2-case): online agent with recent post + no watcher → safety-net FIRES ✅ ; offline agent (post-/leavechat) with goodbye message + no watcher → safety-net stays silent ✅.
- Heartbeat regression after P2b revert: seeded 15-min-stale online agent, ran `hooks/poll.js` as subprocess → `last_seen` advanced by 15 min AND `online` preserved (not clobbered). Confirms the last_seen bump works via `setOnline:false` path.

---

## Changes Applied

### Blockers

- **[B1]** `lib/db.js:96-99` — Guard each column migration independently
  - Status: FIXED
  - Before: `if (!agentCols.includes('handoff_notes')) { db.exec('ALTER TABLE agents ADD COLUMN handoff_notes TEXT'); db.exec('ALTER TABLE agents ADD COLUMN handoff_at TEXT'); }`
  - After: Two separate if-blocks, one per column. If `handoff_notes` already exists but `handoff_at` doesn't (partial migration), `handoff_at` is now correctly added.

### Warnings

- **[W1]** `poll-chat.js:24` — Replace execSync with execFileSync to prevent shell injection
  - Status: FIXED
  - Before: `import { execSync } from 'child_process';` + `execSync(\`node scripts/chat-read.js --name "${name}" ...\`)`
  - After: `import { execFileSync } from 'child_process';` + `execFileSync(process.execPath, ['scripts/chat-read.js', '--name', name, '--project', project, '--rooms', rooms])`

- **[W2]** `hooks/leave.js:42-58` — Scope UPDATE statements to (name, project_hash) pair only
  - Status: FIXED
  - Before: Two separate UPDATE blocks — one targeting all agents in the project (`WHERE project_hash = ?`), one targeting all registrations of the name (`WHERE name = ?`)
  - After: Single UPDATE scoped to `WHERE name = ? AND project_hash = ? AND online = 1` (both over-broad blocks collapsed into one correctly-scoped one)

- **[W3]** `scripts/chat-plan.js:187-206` — Add duplicate-plan guard to --quick path
  - Status: FIXED
  - Before: `--quick` called `createPlan()` without checking for existing active/draft plans
  - After: Added `listPlans({ room }).filter(p => p.status === 'draft' || p.status === 'active')` check matching the `--create` path guard at lines 69-73

- **[W4]** `lib/db.js:279-284` — Replace LIKE with json_extract in getOpenTasks
  - Status: FIXED
  - Before: `metadata LIKE '%"task_status":"open"%'`
  - After: `json_extract(metadata, '$.task_status') = 'open'`

- **[W5]** `lib/db.js:300-311` — Check stale agents exist before UPDATE in getOnlineAgents
  - Status: FIXED
  - Before: Unconditional UPDATE on every call
  - After: SELECT COUNT(*) first; UPDATE only runs when stale agents are found

- **[W6]** `lib/db.js:358-384` — Replace N+1 loop with single GROUP BY query in getUnreadCountAllRooms
  - Status: FIXED
  - Before: One SELECT per room in a JS loop
  - After: Single LEFT JOIN + GROUP BY query covers all rooms at once

- **[W7]** `lib/db.js:109` — Drop useless idx_messages_content index
  - Status: FIXED
  - Before: `db.exec('CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(room, content)')`
  - After: Line removed (leading-wildcard LIKE can't use this index)

- **[W8]** `lib/db.js:607-623` — Wrap deleteRoom body in d.transaction()
  - Status: FIXED
  - Before: Three separate writes (DELETE messages, DELETE read_cursors, UPDATE agents) with no atomicity guarantee
  - After: All wrapped in `d.transaction(() => { ... })()`

- **[W9]** `scripts/chat-dashboard.js:~295` — Validate data.type against whitelist before insertMessage
  - Status: FIXED
  - Before: `type: data.type || 'message'` passed directly to insertMessage
  - After: Validated against `['message', 'question', 'system', 'task']`; returns 400 on invalid type

- **[W10]** `scripts/chat-dashboard.js:~281` — Catch JSON.parse errors and return 400
  - Status: FIXED
  - Before: `const data = JSON.parse(body);` — throws on malformed JSON, caught by outer 500 handler
  - After: Wrapped in `try { data = JSON.parse(body); } catch { jsonResponse(res, { error: 'invalid JSON' }, 400); return; }`

### Nits

- **[N1]** Extract getFlag() into lib/args.js, update all imports
  - Status: FIXED
  - Created `lib/args.js` exporting `args`, `getFlag`, and `hasFlag`
  - Updated 18 files to import from lib/args.js instead of defining locally:
    - `poll-chat.js`, `hooks/leave.js`
    - `scripts/chat-ask.js`, `chat-catchup.js`, `chat-claim.js`, `chat-dashboard.js`, `chat-history.js`, `chat-join.js`, `chat-leave.js`, `chat-pin.js`, `chat-plan.js`, `chat-preclaim.js`, `chat-read.js`, `chat-search.js`, `chat-send.js`, `chat-task-legacy.js`, `chat-ui.js`, `chat-watch.js`
  - Skipped 3 files with non-standard getFlag (returns `true` for boolean flags or scoped inside a conditional block): `scripts/setup.js`, `scripts/session-bootstrap.js`, `scripts/adr-logger.js`

- **[N3]** `scripts/chat-dashboard.js:~75` — Remove dead compact field read
  - Status: FIXED
  - Before: `compact: meta.compact || false,` in formatMsg return object
  - After: Line removed

### Summary
- Applied: 13/13 fixes (B1, W1–W10, N1, N3)
- Skipped: 0 fixes
- Files modified:
  - `lib/db.js` (B1, W4, W5, W6, W7, W8)
  - `lib/args.js` (N1 — new file)
  - `poll-chat.js` (W1, N1)
  - `hooks/leave.js` (W2, N1)
  - `scripts/chat-plan.js` (W3, N1)
  - `scripts/chat-dashboard.js` (W9, W10, N1, N3)
  - `scripts/chat-ask.js` (N1)
  - `scripts/chat-catchup.js` (N1)
  - `scripts/chat-claim.js` (N1)
  - `scripts/chat-history.js` (N1)
  - `scripts/chat-join.js` (N1)
  - `scripts/chat-leave.js` (N1)
  - `scripts/chat-pin.js` (N1)
  - `scripts/chat-preclaim.js` (N1)
  - `scripts/chat-read.js` (N1)
  - `scripts/chat-search.js` (N1)
  - `scripts/chat-send.js` (N1)
  - `scripts/chat-task-legacy.js` (N1)
  - `scripts/chat-ui.js` (N1)
  - `scripts/chat-watch.js` (N1)
