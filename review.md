## Code Review: ccchat-improve — Full System Review

### Summary
- Files reviewed: 20 (lib/*.js × 4, hooks/*.js × 6, scripts/*.js × 18, poll-chat.js)
- Context files read: 20 (all source files; node_modules excluded)
- Overall: **REQUEST CHANGES**

---

### Blockers (must fix)

#### [B1] `lib/db.js:96-99` — Schema migration for `handoff_at` permanently skippable after partial failure

```js
const agentCols = db.pragma('table_info(agents)').map(c => c.name);
if (!agentCols.includes('handoff_notes')) {
  db.exec('ALTER TABLE agents ADD COLUMN handoff_notes TEXT');
  db.exec('ALTER TABLE agents ADD COLUMN handoff_at TEXT');   // ← guarded by wrong condition
}
```

**Scenario where it breaks:** If the first `ALTER TABLE` (`handoff_notes`) succeeds but the process dies before the second (`handoff_at`), the column is permanently skipped. On every subsequent startup, `agentCols.includes('handoff_notes')` returns true → the entire block is skipped → `handoff_at` is never added.

**Consequence:** `setHandoffNote()` issues `UPDATE agents SET handoff_notes = ?, handoff_at = datetime('now')` — this throws `"no such column: handoff_at"`. The call site in `hooks/leave.js` swallows the exception, so handoff notes silently fail to save. `getHandoffNote()` also fails silently. The feature breaks permanently until someone manually runs `ALTER TABLE` or drops the DB.

**Fix:** Guard each column independently:
```js
if (!agentCols.includes('handoff_notes')) {
  db.exec('ALTER TABLE agents ADD COLUMN handoff_notes TEXT');
}
if (!agentCols.includes('handoff_at')) {
  db.exec('ALTER TABLE agents ADD COLUMN handoff_at TEXT');
}
```

---

### Warnings (should fix)

#### [W1] `poll-chat.js:24` — Shell injection via user-controlled arguments in `execSync`

```js
const output = execSync(
  `node scripts/chat-read.js --name "${name}" --project "${project}" --rooms "${rooms}"`
).toString();
```

`name`, `project`, and `rooms` come from `process.argv` with no sanitization. A caller passing `--name 'x"; rm -rf ~; echo "'` causes the shell to execute `rm -rf ~`. In the current context this is self-directed (you own the args), but this pattern is fragile when scripts are composed or called from automated contexts (CI, another process).

**Fix:** Use spawn with an array to avoid shell interpretation entirely:
```js
const { spawnSync } = require('child_process');
const result = spawnSync('node', [
  'scripts/chat-read.js', '--name', name, '--project', project, '--rooms', rooms
], { encoding: 'utf8' });
const output = result.stdout;
```
Or use `execFileSync` with explicit arg array.

---

#### [W2] `hooks/leave.js:42-58` — Marking ALL project agents offline when one agent leaves

```js
// Mark offline ALL agents for this project_hash
d.prepare("UPDATE agents SET online = 0 … WHERE project_hash = ? AND online = 1").run(hash);
// Also mark offline any other project registrations for this agent name
d.prepare("UPDATE agents SET online = 0 … WHERE name = ? AND online = 1").run(identity.name);
```

The second query marks *every registration of this agent name* offline — across all projects. If the same agent name is registered in two separate projects (both legitimately active), closing one session marks the other offline too.

The first query is even more aggressive: if two distinct Claude Code instances share the same `project_hash` (e.g., two windows on the same codebase), closing one marks the other's agent offline, causing it to become invisible to the system until its next poll.

**Risk:** Ghost-offline agents — agents that are active but show as offline, missing messages and not receiving DM routing.

**Fix:** Limit the first query to the specific `(name, project_hash)` pair, not all agents in the project. The ghost-agent problem being solved could be addressed more precisely: on leave, clean up only rows where `name = ? AND project_hash = ?`, not all rows for the project.

---

#### [W3] `scripts/chat-plan.js:187-206` — `--quick` mode skips the duplicate-plan guard

The `--create` path (line 69-73) correctly checks for existing draft/active plans:
```js
const existing = listPlans({ room }).filter(p => p.status === 'draft' || p.status === 'active');
if (existing.length > 0) { console.error(`Error: Room '${room}' already has …`); process.exit(1); }
```

The `--quick` path (line 179-206) calls `createPlan()` directly with no such check. Two agents running `--quick` concurrently in the same room will both succeed, creating two simultaneous active plans. This breaks the "one plan per room" invariant documented in `claimPlanner`.

**Fix:** Add the same guard at the start of the `--quick` branch:
```js
const existingPlans = listPlans({ room }).filter(p => p.status === 'draft' || p.status === 'active');
if (existingPlans.length > 0) {
  const p = existingPlans[0];
  console.error(`Room '${room}' already has a ${p.status} plan #${p.id}. Use --claim to join it.`);
  process.exit(1);
}
```

---

#### [W4] `lib/db.js:279-284` — `getOpenTasks` uses fragile JSON LIKE pattern on metadata

```js
return d.prepare(`
  SELECT * FROM messages
  WHERE room = ? AND type = 'task'
  AND metadata LIKE '%"task_status":"open"%'
  ORDER BY id DESC LIMIT ?
`).all(room, limit).reverse();
```

This works only if `JSON.stringify` produces exactly `"task_status":"open"` with no space after the colon and the keys in a specific order. If `metadata` has a space (`"task_status": "open"`), or if the JSON keys are reordered (e.g., after a parse-then-reserialize cycle), this query silently returns zero results.

The actual serialization in `insertMessage` is `JSON.stringify(metadata)` which produces compact JSON, so this likely works in practice. But it's brittle.

**Fix:** Either use SQLite JSON functions (`json_extract(metadata, '$.task_status') = 'open'`), or store task_status in its own column for indexed querying. At minimum, add a test assertion that `JSON.stringify({task_status:'open'})` produces the expected substring.

---

#### [W5] `lib/db.js:300-311` — `getOnlineAgents` issues a write (UPDATE) on every call

```js
export function getOnlineAgents() {
  const d = getDb();
  d.prepare(`UPDATE agents SET online = 0 WHERE online = 1 AND last_seen < datetime('now', '-10 minutes')`).run();
  return d.prepare(`SELECT * FROM agents WHERE online = 1`).all();
}
```

`getOnlineAgents` is called from:
- `hooks/poll.js` — on every user prompt submission
- `hooks/notify.js` — on every tool call
- `scripts/chat-dashboard.js` poll loop — every 1.5 seconds
- `scripts/chat-send.js` — for sentinel routing on every send
- `scripts/chat-ui.js` — every 1.5 seconds for the status bar

This means the agents table receives a write on every 1.5s dashboard poll and every tool call. Even when all agents are fresh (nothing to expire), the UPDATE runs and acquires a write lock. In WAL mode this is less painful but still unnecessary contention.

**Fix:** Separate expiry from reads. Either: (a) run expiry only when an agent is stale (check first with a cheap SELECT, then conditionally UPDATE), or (b) handle expiry inline in callers that call `getOnlineAgents` infrequently (dashboard, status), but use a read-only version in hot paths (poll, notify).

---

#### [W6] `lib/db.js:358-384` — N+1 query pattern in `getUnreadCountAllRooms`

```js
const countStmt = d.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE room = ? AND id > ? AND from_agent != ?');
for (const room of rooms) {
  const lastId = cursorMap.get(room) || 0;
  const row = countStmt.get(room, lastId, agentName);
  if (row.cnt > 0) counts.set(room, row.cnt);
}
```

For an agent in N rooms, this executes N+2 SQL queries (agent lookup, cursors, then N COUNT queries). Called on every user prompt (poll hook) and every tool call (notify hook), this adds latency proportional to room count.

**Fix:** One query with GROUP BY:
```sql
SELECT m.room, COUNT(*) AS cnt
FROM messages m
JOIN read_cursors rc ON rc.room = m.room
  AND rc.agent_name = ? AND rc.project_hash = ?
WHERE m.id > rc.last_id AND m.from_agent != ?
  AND m.room IN (/* agent's rooms */)
GROUP BY m.room
HAVING cnt > 0
```
This requires passing the room list as a parameter (SQLite supports `IN (?)` style with prepared statements in better-sqlite3 via expansion, or use a temp table).

---

#### [W7] `lib/db.js:109` — Index on `messages(room, content)` is unused for LIKE `%...%` queries

```js
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(room, content)');
```

SQLite cannot use a B-tree index for LIKE patterns that start with a wildcard (`%query%`). `searchMessages()` uses `content LIKE ? ESCAPE '\\'` with `pattern = '%${escaped}%'` — the leading `%` means the index is never consulted. The index is created at every startup (via `IF NOT EXISTS`, so no-op after first run), wastes disk space, and degrades write performance slightly.

**Fix:** Either drop this index (search will always full-scan the content column), or replace with FTS5:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, room, content=messages, content_rowid=id);
```
FTS5 supports fast full-text substring search and works correctly with `MATCH` queries.

---

#### [W8] `lib/db.js:607-623` — `deleteRoom` is not wrapped in a transaction

```js
export function deleteRoom(room) {
  if (PROTECTED_ROOMS.includes(room)) throw new Error(...);
  const d = getDb();
  d.prepare('DELETE FROM messages WHERE room = ?').run(room);
  d.prepare('DELETE FROM read_cursors WHERE room = ?').run(room);
  // Remove room from agents' room lists
  const agents = d.prepare('SELECT name, project_hash, rooms FROM agents').all();
  for (const a of agents) {
    // ... UPDATE agents ...
  }
}
```

If the process crashes between `DELETE FROM messages` and `DELETE FROM read_cursors` (or mid-loop through agents), the DB is left partially cleaned. Agents retain the room in their room list, but messages and cursors are gone. On reconnect, the room appears in agent lists but has no history, and unread counts behave unexpectedly.

**Fix:**
```js
d.transaction(() => {
  d.prepare('DELETE FROM messages WHERE room = ?').run(room);
  d.prepare('DELETE FROM read_cursors WHERE room = ?').run(room);
  // ... agents loop ...
})();
```

---

#### [W9] `scripts/chat-dashboard.js:295` — Message type not validated before DB insert in `/api/send`

```js
const data = JSON.parse(body);
// ...
const { id } = insertMessage({
  type: data.type || 'message',   // ← unchecked user input
  ...
});
```

If a client POSTs `{"type": "question", "message": "hello"}`, it correctly inserts a question. But if they POST `{"type": "fakeType", "message": "test"}`, `insertMessage` throws (`Invalid message type: fakeType`), which propagates to the outer try/catch and returns a 500 Internal Server Error instead of a 400 Bad Request. The DB is not corrupted, but the error response is misleading.

**Fix:** Validate `data.type` before the insert:
```js
const validTypes = ['message', 'question', 'system'];
const msgType = validTypes.includes(data.type) ? data.type : 'message';
```

---

#### [W10] `scripts/chat-dashboard.js:281-285` — JSON parse errors from malformed POST bodies return 500

```js
const body = await readBody(req);
const data = JSON.parse(body);  // ← throws SyntaxError on malformed JSON
```

A malformed body (`{invalid}`) causes `JSON.parse` to throw, which falls through to:
```js
} catch (err) {
  res.writeHead(500, { 'Content-Type': 'text/plain' });
  res.end('Internal error');
}
```

This is misleading — a client error (malformed request) should return 400, not 500.

**Fix:**
```js
let data;
try { data = JSON.parse(body); }
catch { jsonResponse(res, { error: 'invalid JSON body' }, 400); return; }
```

---

### Nits (could fix)

#### [N1] All 18 scripts define identical `getFlag` helper inline
Every script contains:
```js
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
```
A shared `lib/args.js` would eliminate ~90 lines of duplication and make changes (e.g., `--flag=value` support) apply everywhere.

#### [N2] `scripts/setup.js:89-97` — Permission list hardcoded; new scripts require manual update
The list `['chat-send.js', 'chat-read.js', ...]` must be manually maintained. Adding a new script without updating setup.js means it won't be in the auto-permission list and will trigger permission prompts in Claude Code.

#### [N3] `scripts/chat-dashboard.js:75` — Reads undocumented `compact` field from metadata
```js
compact: meta.compact || false,
```
No code path sets `compact` in message metadata. This field is read but always `false`. Either document and implement it, or remove the read.

#### [N4] `lib/db.js` — Rooms stored as JSON in TEXT column requires JS-side filtering for cross-room queries
`agents.rooms` is stored as `'["lobby","general"]'`. Any query asking "who is in room X" must fetch all agents and filter in JS. A `agent_rooms(agent_name, project_hash, room)` junction table would enable indexed SQL queries. This matters if the agent count grows significantly.

#### [N5] `scripts/adr-logger.js:35-83` — TOCTOU race on `nextAdrId` + `writeAdr` for concurrent callers
```js
const id = nextAdrId(decisionsPath);   // read max
// ... gap here ...
writeAdr({ id, ... });                 // write at max+1
```
Two concurrent callers get the same `id`. In practice this is benign (single-process in practice, and the message trigger path has no parallelism), but the file could get duplicate ADR IDs if ever called concurrently.

---

### Dimensions Checked

| Dimension | Status | Notes |
|---|---|---|
| Correctness | **FAIL** | B1 (schema migration partial failure); W3 (plan uniqueness bypass in --quick); W2 (leave marks wrong agents offline) |
| Security | **WARN** | W1 (shell injection pattern in poll-chat.js); dashboard has no auth (localhost-only, acceptable for dev tool) |
| Performance | **WARN** | W5 (write on every getOnlineAgents call); W6 (N+1 in unread counts); W7 (useless LIKE index) |
| Error Handling | **WARN** | W9, W10 (500s instead of 400s in dashboard API); B1 manifests as silent failure |
| Maintainability | **WARN** | N1 (getFlag duplication); N2 (hardcoded permission list); N4 (rooms-as-JSON hinders SQL queries) |
| Conventions | **PASS** | Consistent use of parameterized queries; WAL mode; busy_timeout; PROTECTED_ROOMS guard; sentinel pattern well-implemented |
| Test Coverage | **FAIL** | No tests exist for any module. The schema migration bug (B1) would be caught by a simple integration test |
