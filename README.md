# ccchat

Serverless multi-agent peer chat for Claude Code sessions. SQLite (WAL mode) is the entire message bus — no server, no background watcher, no notification files.

Agents in separate Claude Code sessions communicate through a shared SQLite database. Hooks provide real-time notifications. One dependency: `better-sqlite3`.

## Features

**Communication**
- Send messages, ask questions (with polling for replies), threaded replies
- Room-based channels, direct messages with `--to`

**Notifications** (4 hooks covering all agent states)
- **Poll** (UserPromptSubmit): Unread banner on each prompt
- **Stop** (Stop): Blocks on urgent messages or @mentions
- **Notify** (PostToolUse): Mid-task alerts for urgent @mentions between tool calls
- **Leave** (SessionEnd): Marks agent offline, saves handoff notes

**Collaboration**
- `@mentions` — auto-parsed from message text
- `--urgent` priority — triggers stop hook blocking
- Pinned messages — preserve important decisions
- Task messages — create, assign, track status (open/in-progress/done/blocked)
- Evidence field — mark verified claims with `[verified]` tag

**Intelligence**
- Search with composable filters (`--pinned`, `--verified`, `--by <agent>`)
- Session catchup — handoff notes, unread, pinned, history backfill
- Handoff notes — auto-saved on session end (48h TTL)

## Architecture

```
SQLite (WAL mode) = message bus
~/.claude/ccchat/ccchat.db

Scripts write --> SQLite <-- Hooks read
```

No server process. Scripts write directly to SQLite. Hooks query the DB on Claude Code lifecycle events (~2ms per query). WAL mode with `busy_timeout=5000` handles ~5 concurrent agents.

## Quick Start

```bash
npm install                          # install better-sqlite3
node scripts/setup.js --global       # install hooks/skills globally
node scripts/setup.js --name mybot   # setup current project (optional)
```

## Scripts

All scripts are in `scripts/`. Run with `node scripts/<name>.js`.

### chat-send.js — Send a message
```bash
node scripts/chat-send.js --message "hello world" --room general --name mybot
node scripts/chat-send.js --message "@bob check this" --room general --urgent
node scripts/chat-send.js --message "verified fix" --room general --evidence "tested in CI"
node scripts/chat-send.js --message "reply" --room general --reply-to 42
```
Flags: `--message`, `--name`, `--project`, `--room`, `--to`, `--type`, `--reply-to`, `--urgent`, `--evidence`, `--json`

### chat-read.js — Read unread messages
```bash
node scripts/chat-read.js --name mybot --rooms general,dev
node scripts/chat-read.js --name mybot --rooms general --json --compact
```
Advances the read cursor. Flags: `--name`, `--project`, `--rooms`, `--limit`, `--json`, `--compact`

### chat-history.js — Browse past messages
```bash
node scripts/chat-history.js --room general --last 20
node scripts/chat-history.js --room general --last 10 --before 50
```
Read-only, no cursor change. Flags: `--room`, `--last`, `--before`, `--json`

### chat-ask.js — Post question, poll for replies
```bash
node scripts/chat-ask.js --name mybot --question "Should we use FTS5?" --room general --timeout 120
node scripts/chat-ask.js --name mybot --question "@bob urgent review" --room general --urgent
```
Blocks until replies arrive or timeout. Flags: `--name`, `--project`, `--question`, `--room`, `--timeout`, `--urgent`, `--pretty`

### chat-search.js — Search messages with filters
```bash
node scripts/chat-search.js --query "hook architecture"
node scripts/chat-search.js --query "schema" --pinned --verified
node scripts/chat-search.js --query "deploy" --by maestro --limit 5
```
Composable filters for knowledge queries. Flags: `--query`, `--room`, `--limit`, `--pinned`, `--verified`, `--by`, `--json`

### chat-pin.js — Pin/unpin messages
```bash
node scripts/chat-pin.js --pin 42           # pin message #42
node scripts/chat-pin.js --unpin 42         # unpin
node scripts/chat-pin.js --room general     # list pinned
```
Flags: `--pin`, `--unpin`, `--room`, `--json`

### chat-task.js — Create and manage tasks
```bash
node scripts/chat-task.js --name mybot --message "Implement search" --assign bob
node scripts/chat-task.js --update 42 --status done --evidence "All tests pass"
```
Statuses: `open`, `in-progress`, `done`, `blocked`. Flags: `--name`, `--project`, `--message`, `--room`, `--assign`, `--urgent`, `--update`, `--status`, `--evidence`, `--json`

### chat-catchup.js — Session bootstrap
```bash
node scripts/chat-catchup.js --name mybot --rooms general --budget 50
```
Shows (in order): handoff notes, pinned messages, unread messages, history backfill. Flags: `--name`, `--project`, `--rooms`, `--budget`, `--json`, `--compact`

### status.js — Show online agents
```bash
node scripts/status.js --raw
```

### setup.js — Install hooks and skills
```bash
node scripts/setup.js --global              # install globally
node scripts/setup.js --name mybot          # project-level
node scripts/setup.js --uninstall           # remove
node scripts/setup.js --global --uninstall  # remove globally
```

## Hooks

All hooks are in `hooks/`. Registered automatically by `setup.js`.

| Hook | Event | Behavior |
|------|-------|----------|
| `poll.js` | UserPromptSubmit | Shows unread count + last message preview on stderr |
| `stop.js` | Stop | Blocks if unread urgent or @mention messages |
| `notify.js` | PostToolUse | Stderr banner for urgent @mentions between tool calls (30s rate limit) |
| `leave.js` | SessionEnd | Marks agent offline, optionally saves handoff note |

### Handoff notes
```bash
node hooks/leave.js --handoff "Was working on search filters, PR open"
```

## File Structure

```
lib/
  db.js          — SQLite access layer, schema, all queries
  identity.js    — Agent identity resolution
  format.js      — Output formatting, mention parsing, metadata parsing

scripts/
  chat-send.js   — Send a message
  chat-read.js   — Read unread messages
  chat-ask.js    — Post question, poll for replies
  chat-history.js — Browse past messages
  chat-search.js — Search with filters
  chat-pin.js    — Pin/unpin messages
  chat-task.js   — Task messages with status
  chat-catchup.js — Session bootstrap
  status.js      — Show online agents
  setup.js       — Install hooks/skills

hooks/
  poll.js        — UserPromptSubmit: unread banner
  stop.js        — Stop: block on urgent/@mentions
  notify.js      — PostToolUse: mid-task alerts
  leave.js       — SessionEnd: offline + handoff
```

## Database Schema

```sql
-- Agents (one per project per session)
agents (name, project_hash, project_path, rooms, last_seen, online, handoff_notes, handoff_at)

-- Messages (AUTOINCREMENT IDs, no race conditions)
messages (id, type, from_agent, from_project, to_agent, room, content, metadata, parent_id, pinned, created_at)

-- Read cursors (per agent, per room)
read_cursors (agent_name, project_hash, room, last_id)
```

### Metadata JSON
```json
{
  "mentions": ["bob", "carol"],
  "priority": "normal|urgent",
  "task_status": "open|in-progress|done|blocked",
  "assigned": "bob",
  "evidence": "proof text"
}
```

## Key Design Decisions

- **SQLite as message bus** — no server, no background process, no notification files
- **AUTOINCREMENT IDs** — eliminates race conditions from v1's nextSeq()
- **Hooks query DB directly** — ~2ms, no server round-trip
- **Metadata JSON column** — extensible without schema migrations
- **JS filtering over SQL** — unread sets are small (<=50), avoids coupling to SQLite JSON functions
- **Message-based knowledge** — pins + evidence + search filters instead of separate knowledge table
- **30s rate limiting** in notify.js — prevents repeated banners for the same message
- **48h TTL** on handoff notes — auto-expire stale context
