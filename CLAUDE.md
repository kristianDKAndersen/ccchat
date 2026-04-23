# ccchat

Serverless multi-agent peer chat for Claude Code sessions. SQLite (WAL mode) is the message bus. A `chat-watch.js` daemon uses `fs.watch()` on sentinel files for near-instant (<500ms) message detection with zero token cost while idle — auto-spawned by the SessionStart hook per agent.

## Architecture

```
SQLite (WAL mode) = message bus
~/.claude/ccchat/ccchat.db

Scripts write ──→ SQLite ←── Hooks read
```

Single dependency: `better-sqlite3`. WAL mode with `busy_timeout=5000` handles ~5 concurrent agents.

## Setup

```bash
npm install                          # install better-sqlite3
node scripts/setup.js --global       # install hooks/skills globally
node scripts/setup.js --name test    # setup current project
```

## File Structure

### Library (`lib/`)
- `db.js` — SQLite access layer, schema, all queries
- `format.js` — Message formatting, parsing, mention extraction, display utilities
- `identity.js` — Agent identity resolution from flags or `.claude/ccchat-identity.json`, with DB-authoritative validation
- `sentinel.js` — Sentinel file helpers for fast-path message notification (touch, check mtime, cleanup)

### Scripts (`scripts/`)
- `chat-send.js` — Send a message (`--reply-to <id>` for threading, `--to` for DMs, `--agree`/`--disagree` + `--topic` + `--rationale` for consensus signals, `--discussion-phase brainstorming|converging|decided` for phase markers)
- `chat-join.js` — Switch your current room to `<room>` (`--room <room> [--create]`, atomically updates `current_room` + inits cursor + event hook stub)
- `chat-leave.js` — Return to `lobby` (takes no `--room` arg; atomically updates `current_room` + cleans sentinel + event hook stub; `lobby` itself cannot be left — `PROTECTED_ROOMS = ['lobby']`)
- `chat-read.js` — Read unread messages (advances read cursor)
- `chat-ask.js` — Post question, poll for replies (filters by `parent_id`)
- `chat-history.js` — Paginated history viewer (read-only, no cursor change)
- `chat-search.js` — Search messages with filters (`--pinned`, `--verified`, `--by <agent>`, `--risk` for `[RISK]`-tagged messages)
- `chat-pin.js` — Pin/unpin messages, list pinned messages in a room
- `chat-plan.js` — Collaborative planning: create/activate/add-task/show/list/complete/cancel/quick plans (`--quick` = create + activate in one call)
- `chat-claim.js` — Atomic task claiming: claim/complete/release tasks, show plan status
- `chat-preclaim.js` — Pre-claim enforcement gate: check + claim atomically (exits 0 on success, 1 if taken)
- `chat-task-legacy.js` — DEPRECATED: old task messages (use chat-plan.js + chat-claim.js instead)
- `chat-catchup.js` — Bootstrap new agents: unread + handoff notes + recent history
- `chat-ui.js` — Interactive terminal chat client for humans (live polling, ANSI colors, /commands)
- `session-bootstrap.js` — Gap detector: CLAUDE.md staleness, session diff (changes since last bootstrap via stored SHA), decision log dead-ends, ccchat unread, open tasks. Skips file tree and git state (redundant with Claude Code context)
- `chat-watch.js` — Long-polling watcher: blocks until new messages arrive via `fs.watch()` on sentinel files, then exits with message JSON. `--persist` flag enables self-respawn with exponential backoff (max 20 restarts, resets after 60s stability). Does NOT advance read cursor (caller runs `chat-read.js` to consume)
- `chat-dashboard.js` — Real-time web dashboard (Node built-in `http`, no new deps). REST API + SSE for live message streaming. Flags: `--port 3000`, `--host localhost`
- `status.js` — Show online agents and rooms (`--raw` for JSON, `--prune` for cleanup)
- `statusline.sh` — Rich terminal dashboard (agent, project, branch, context bar, model, cost, duration, lines changed, rate limits)
- `adr-logger.js` — Auto-captures `[DECISION]` tagged messages to `docs/decisions.md`. Dual-use: importable function or CLI (`--message-id <id>`). Sends warning if rejected alternatives are missing
- `chat-digest.js` — Human-readable digest: ⚡ ACTION NEEDED / ✅ DECISIONS MADE / ❓ OPEN QUESTIONS / ▼ DETAILS. Flags: `--room`, `--since-hours` (default 24), `--json`
- `chat-consensus.js` — Aggregate consensus signals by topic (counts agree/disagree votes per topic from room history)
- `chat-phase.js` — Phase state machine CLI. `--set <phase> --by <agent>` sets the current phase (validated enum); `--get` shows current phase; `--log` shows history. Valid phases: `brainstorm`, `draft`, `spec`, `execute`, `peer_review`, `review`, `done`, `hold`, `cancelled`
- `setup.js` — Install hooks/skills globally or per-project

### Docs (`docs/`)
- `decisions.md` — Auto-generated decision log (ADR records from `[DECISION]` tagged messages)
- `specs/adr-logger-spec.md` — ADR Logger specification

### Dashboard (`dashboard/`)
- `index.html` — Single-file web UI (inline CSS/JS, dark theme). Room switching, live message feed via SSE, agent sidebar, pinned messages, search, thread view. Served by `chat-dashboard.js`

### Hooks (`hooks/`)
| Hook | Event | Behavior |
|------|-------|----------|
| `start.js` | SessionStart | Auto-spawns `chat-watch.js --persist` (detached presence daemon) if `.claude/ccchat-identity.json` exists and no watcher is already running for this agent. Dedup by per-agent `pgrep` pattern. Walks ppid up to 10 levels to find the owning `claude` session PID and passes it as `--parent-pid` so the daemon self-terminates on parent death (orphan protection). Aborts the auto-spawn if `~/.claude/ccchat/suppress-teammate-joins.lock` is active and unexpired (TEAM_UP_OPT_OUT_GUARD — prevents teammate Claude Code sessions from auto-joining ccchat) |
| `poll.js` | UserPromptSubmit | Bumps heartbeat (`last_seen`) via `setOnline:false` upsert — preserves intentional offline state. Shows unread count + last message preview on stderr; shows stale unanswered Open Questions banner; auto-starts dashboard server + opens browser on first unread (macOS, `pgrep` dedup) |
| `stop.js` | Stop | Heartbeat bump (`setOnline:false`). Force-blocks the turn on addressed unread (urgent / @mention / question / DM / active-thread). Also force-blocks if the agent posted to ccchat in the last 15 min but the non-persist skill watcher is dead — safety-net for missed respawns. Skips both if the agent is explicitly offline (post-`/leavechat`) |
| `notify.js` | PostToolUse | Stderr banner for urgent @mentions between tool calls (30s rate limit); scans recent messages for `[DECISION]` tags and auto-triggers ADR logging to `docs/decisions.md` (dedupes by message ID) |
| `leave.js` | SessionEnd | Marks agent offline. Kills the exact `--persist` presence daemon for this agent+project (`pkill -f chat-watch.js --name <N> --project <P>`) — without this, the daemon keeps heartbeating and re-asserts `online=1` after the offline flip. Kills dashboard if no agents remain online |
| `task-complete.js` | TaskCompleted | Auto-posts teammate evidence to ccchat via `chat-send.js --evidence` when an Agent Teams teammate completes a task. Extracts task label + result from the payload defensively (field names unverified) and logs the raw payload to stderr for schema discovery |
| `poll-gemini.js` | BeforeAgent | Unread banner for Gemini CLI integration |
| `empty-project.js` | UserPromptSubmit | Nudges `/summon` in empty projects (no CLAUDE.md). Once per session |

## Features

- **@mentions** — auto-parsed from message text
- **`--urgent` priority** — triggers stop hook blocking
- **Pinned messages** — preserve important decisions
- **Collaborative plans** — draft/active/completed plans with atomic task claiming (replaces chat-task.js)
- **Plan guard** — `chat-send` gate when `plan.status=active && room.phase=execute`; requires `--claim <task-id>`, `--task <id>`, `--reply-to`, or `--no-plan-guard` (audited bypass via `metadata.plan_guard_bypassed`). Prevents prose work-commitments without formal task claim
- **9-step task workflow** — BLOCKING process: propose (structured) → peer review → approve direction → plan (no placeholders) → approve plan → delegate → implement & verify → two-stage implementation review (spec compliance + quality, separate messages) → escalate if blocked (`[BLOCKED]` convention). Two human approval gates. Rationalization prevention red-flag table in skill doc
- **Evidence field** — mark verified claims with `[verified]` tag
- **Search** — composable filters across messages
- **Session catchup** — handoff notes + unread + pinned + history backfill
- **Handoff notes** — auto-saved on session end (48h TTL)
- **Web dashboard** — real-time browser UI with SSE, room switching, search, thread view
- **Terminal chat UI** — live interactive client for humans (`chat-ui.js`), auto-spawned by poll hook when messages arrive
- **Session bootstrap** — fast orientation snapshot for new sessions (file tree, git, staleness, decision log)
- **Decision log integration** — surfaces .decisions/log.yaml dead-ends in bootstrap output
- **ADR Logger** — auto-captures `[DECISION]` tagged messages to `docs/decisions.md` with structured records (rejected alternatives, rationale). Warns if alternatives missing
- **Sentinel fast-path** — `chat-send` touches per-agent sentinel files after insert; `chat-watch` uses `fs.watch()` on sentinels for event-driven detection (<500ms); `chat-ask` polls sentinels at 500ms for reply detection. Falls back to interval polling without sentinel support
- **Room join/leave** — first-class `chat-join.js` / `chat-leave.js` scripts with atomic DB + sentinel + event hook stub operations. Single-room model: each agent has exactly one `current_room`; `chat-join --room X` switches, `chat-leave` always returns to `lobby`. `lobby` is the only protected room (`PROTECTED_ROOMS = ['lobby']`)
- **Identity validation** — DB-authoritative identity resolution. Divergence between `.claude/ccchat-identity.json` and DB emits stderr warning; DB wins
- **Open task surfacing** — session bootstrap now shows open tasks across agent's rooms
- **Background watcher — two-role model** — `chat-watch.js` blocks silently (zero tokens) until messages arrive on `fs.watch` sentinel events. Runs in two distinct modes:
  - **Presence daemon** (`--persist`, auto-spawned by `start.js` SessionStart hook): detached, stdout discarded, self-respawns forever with exponential backoff. Keeps the agent heartbeat fresh and online status alive even when the Claude session is idle between prompts. Accepts `--parent-pid <N>` (passed by `start.js`, walked up the ppid chain) and self-terminates with `setAgentOffline` on `process.kill(pid, 0) ESRCH` — catches crash/SIGKILL exits where `SessionEnd` doesn't fire. Checked every 30s and at each cycle start.
  - **Skill-managed wake-up watcher** (no `--persist`, spawned by `/ccchat` via `Bash(run_in_background=true)` with per-agent `--name <AGENT>`): exits on notification. The exit is what Claude Code surfaces as a background-task-complete event, which auto-wakes Claude to process the message. The watcher's stdout carries a `RESPAWN REQUIRED` banner with the exact `Bash(command="node … --name X --timeout 300", run_in_background=true)` to run next. Stop hook has a safety-net block if the watcher goes missing while the agent is actively engaged.
  - Saves ~12k tokens/hour vs cron at idle. The two watchers coexist harmlessly per agent (one `--persist`, one without).
- **Event hook stubs** — no-op hooks in join/leave operations, ready for future event bus. Trigger criteria: 3rd stub added, OR 2+ sentinel workarounds, OR sentinel latency < polling baseline
- **Open Questions banner** — `poll.js` surfaces stale unanswered `type='question'` messages (>15 min) in the hook banner so unanswered questions don't silently age out
- **Human digest** — `chat-digest.js` renders a structured snapshot (ACTION NEEDED / DECISIONS MADE / OPEN QUESTIONS / DETAILS) for quick human review; flags: `--since-hours` (default 24), `--json`
- **Consensus signals** — `chat-send.js --agree/--disagree --topic <topic>` records agreement/disagreement; `--rationale` required for `--agree`; `chat-consensus.js` aggregates vote counts per topic
- **Discussion phase markers** — `chat-send.js --discussion-phase brainstorming|converging|decided` stores discussion phase in message metadata; rendered as colored badge in dashboard and format.js output
- **ADR auto-trigger** — `notify.js` (PostToolUse) scans recent messages for `[DECISION]` tags and auto-calls `adr-logger.js`, deduping by message ID against `docs/decisions.md`
- **Phase state machine** — `room_phases` table + `setPhase`/`getPhase`/`getPhaseHistory` in `lib/db.js`; managed via `chat-phase.js`. Valid phases: `brainstorm`, `draft`, `spec`, `execute`, `peer_review`, `review`, `done`, `hold`, `cancelled`
- **[RISK] tag** — `[RISK]` in message content renders a red RISK badge; `chat-search.js --risk` filters for risk-tagged messages
- **Phase gate enforcement** — hard gates on `chat-claim.js --claim` (requires `execute` phase) and `chat-plan.js --create/--activate/--quick`; soft warnings on `chat-send.js --agree/--disagree` outside `peer_review`/`review`. Null phase (room with no phase set) passes all gates (backwards compatible)

## Database Schema

```sql
agents (name, project_hash, project_path, current_room, rooms, last_seen, online, handoff_notes, handoff_at)
messages (id, type, from_agent, from_project, to_agent, room, content, metadata, parent_id, pinned, created_at)
read_cursors (agent_name, project_hash, room, last_id)
plans (id, title, room, created_by, source_message_id, status, created_at, updated_at)
plan_tasks (id, plan_id, seq, title, description, verify, status, owner, claimed_at, completed_at, blocked_reason, created_at)
planner_locks (room, agent_name, claimed_at)
room_phases (id, room, phase, set_by, notes, set_at)
```

`current_room` is authoritative for the single-room-at-a-time model; `rooms` is a legacy JSON column kept for backwards compatibility with older migrations but no longer written by any script.

## Testing

```bash
# Send a test message (defaults to lobby; override with --room)
node scripts/chat-send.js --name test-agent --project /tmp/test --message "hello"

# Read it back (current room from identity)
node scripts/chat-read.js --name other-agent --project /tmp/other

# Reply to a message (required for chat-ask responses)
node scripts/chat-send.js --name replier --project /tmp/b --message "reply" --reply-to 42

# Browse history
node scripts/chat-history.js --room lobby --last 10

# Search messages
node scripts/chat-search.js --room lobby --query "deployment" --pinned

# Switch rooms (chat-join sets current_room; chat-leave returns to lobby)
node scripts/chat-join.js --name test-agent --project /tmp/test --room dev
node scripts/chat-leave.js --name test-agent --project /tmp/test

# ADR logging (auto-capture decisions)
node scripts/adr-logger.js --message-id 42 --project /tmp/test --room lobby

# Check status
node scripts/status.js --raw

# Run the self-contained test suite
node tests/run.js
```

## Key Design Decisions

- SQLite as message bus — no server, no background process, no notification files
- AUTOINCREMENT IDs — replaced v1's nextSeq() which had race conditions under concurrent writes
- project_hash (sha256[:12]) namespaces agents per project
- Hooks query DB directly (~2ms), no server round-trip needed
- Metadata JSON column — extensible without schema migrations
- JS filtering over SQL — unread sets are small (<=50), avoids coupling to SQLite JSON functions
- Flat threading via parent_id: chat-ask filters replies by parent_id to prevent cross-talk
- chat-history peek pattern (LIMIT N+1, pop extra) for has_more without COUNT
- Message-based knowledge — pins + evidence + search filters instead of separate knowledge table
- 30s rate limiting in notify.js — prevents repeated banners for the same message
- 48h TTL on handoff notes — auto-expire stale context
- Sentinel files (`~/.claude/ccchat/notify/`) — touched by senders, checked by chat-ask for fast-path reply detection without a daemon. Replies touch parent author only; broadcasts touch all online room agents. Best-effort — falls back to polling if sentinels are absent
- DB-authoritative identity — identity file is a write-once bootstrap artifact; DB is the source of truth. Divergence warns on stderr, DB wins
- Event hook stubs — no-op `emitEvent()` calls in join/leave, designed to become a real event bus when criteria are met (3rd stub, 2+ workarounds, or latency degradation)
- Protected rooms (`lobby` only, via `PROTECTED_ROOMS = ['lobby']`) — lobby is the fallback after `chat-leave`, so it cannot itself be left
- Watcher self-respawn — `--persist` mode with exponential backoff (500ms base, 30s max, 20 restart ceiling) resets after 60s of stable operation. Used only by the SessionStart presence daemon; the skill-managed wake-up watcher does NOT use `--persist` (its exit is the wake-up signal)
- Orphan daemon self-cull — `start.js` walks ppid up to 10 levels to find the owning `claude` PID and passes it to `chat-watch.js --parent-pid`. The daemon polls `process.kill(pid, 0)` every 30s and exits (with `setAgentOffline`) on `ESRCH`. Closes the crash/SIGKILL gap where `SessionEnd`/`leave.js` can't fire. Fail-open on `EPERM`/unknown errors — the DB TTL is still the ultimate backstop. On clean exits, `leave.js` also exact-match-kills the daemon by `--name <N> --project <P>` so the offline flip sticks without waiting for the parent-PID check
- Team-up opt-out lock — `~/.claude/ccchat/suppress-teammate-joins.lock` with `{until: <epoch-ms>}`. When present and unexpired, `start.js` skips the auto-spawn entirely so Agent Teams teammate sessions don't accidentally join the room as ghost agents
- **Presence heartbeat vs online promotion** — distinct responsibilities:
  - `last_seen` is bumped by every hook firing (via `setOnline:false` upsert in `lib/db.js`). This keeps the 10-min auto-expiry at bay whenever an agent is interacting at all.
  - `online=1` is only set by **explicit presence signals**: `chat-watch` running (presence daemon or skill watcher), `chat-send`, `chat-join`. Hooks do NOT promote to online — that would clobber intentional offline states set by `/leavechat`.
  - `online=0` is only set by explicit departure: `SessionEnd` hook or `/leavechat`.
  - Stop hook's watcher-missing safety-net reads `online` and returns early for offline agents, so `/leavechat` sticks without being nagged
