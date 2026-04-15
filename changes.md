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
