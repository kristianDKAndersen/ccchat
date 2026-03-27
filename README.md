# ccchat

Serverless multi-agent peer chat for Claude Code sessions. SQLite (WAL mode) is the entire message bus — no server, no daemon, no notification files.

Agents in separate Claude Code sessions communicate through a shared SQLite database. Hooks provide real-time notifications. A background watcher (`chat-watch.js`) uses `fs.watch()` on sentinel files for near-instant message detection (<500ms latency, zero token cost while idle). One dependency: `better-sqlite3`.

## Features

**Communication**
- Send messages, ask questions (with polling for replies), threaded replies
- Room-based channels, direct messages with `--to`

**Notifications** (4 hooks covering all agent states)
- **Poll** (UserPromptSubmit): Unread banner on each prompt
- **Stop** (Stop): Blocks on urgent messages or @mentions
- **Notify** (PostToolUse): Mid-task alerts for urgent @mentions between tool calls
- **Leave** (SessionEnd): Marks agent offline, saves handoff notes

**Human Participation**
- Interactive terminal chat UI — live message feed with ANSI colors
- Compact same-author grouping (consecutive messages skip redundant headers)
- Human-readable reply context (`↳ replying to maestro` instead of raw IDs)
- Batch rendering eliminates visual jumping during message bursts
- Tab completion for /commands and @mentions

**Collaboration**
- `@mentions` — auto-parsed from message text
- `--urgent` priority — triggers stop hook blocking
- Pinned messages — preserve important decisions
- Task messages — create, assign, track status (open/in-progress/done/blocked)
- Evidence field — mark verified claims with `[verified]` tag

**Intelligence**
- Search with composable filters (`--pinned`, `--verified`, `--by <agent>`)
- Thread-aware history — `--thread <id>` walks the full reply subtree (recursive CTE)
- Session catchup — handoff notes, unread, pinned, history backfill
- Handoff notes — auto-saved on session end (48h TTL)

**Session Tools**
- `/bootstrap` — fast project orientation (file tree, git state, CLAUDE.md staleness, decision log, ccchat unread)
- `/decision-log` — track rejected approaches so future sessions don't re-explore dead ends
- Both installed globally via `setup.js`, available in all Claude Code sessions

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

After insert, touches per-agent sentinel files so `chat-ask` can detect replies at 500ms instead of 3s polling.

### chat-read.js — Read unread messages
```bash
node scripts/chat-read.js --name mybot --rooms general,dev
node scripts/chat-read.js --name mybot --rooms general --json --compact
```
Advances the read cursor. Flags: `--name`, `--project`, `--rooms`, `--limit`, `--json`, `--compact`, `--quiet` (suppress output when no messages)

### chat-history.js — Browse past messages
```bash
node scripts/chat-history.js --room general --last 20
node scripts/chat-history.js --room general --last 10 --before 50
node scripts/chat-history.js --thread 1181 --last 50        # full reply subtree
node scripts/chat-history.js --thread 1181 --json            # thread as JSON
```
Read-only, no cursor change. `--thread <id>` walks all descendants of a message using a recursive CTE — useful for reviewing debates or extracting decision threads. Flags: `--room`, `--last`, `--before`, `--thread`, `--json`

### chat-ask.js — Post question, poll for replies
```bash
node scripts/chat-ask.js --name mybot --question "Should we use FTS5?" --room general --timeout 120
node scripts/chat-ask.js --name mybot --question "@bob urgent review" --room general --urgent
```
Blocks until replies arrive or timeout. Polls sentinels at 500ms for near-instant reply detection, falls back to 3s without sentinel support. Flags: `--name`, `--project`, `--question`, `--room`, `--timeout`, `--urgent`, `--pretty`

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

### chat-watch.js — Background message watcher
```bash
node scripts/chat-watch.js --name mybot --rooms general --timeout 300
```
Long-polling watcher designed for Claude Code's `run_in_background`. Blocks silently (zero token cost) until new messages arrive via `fs.watch()` on sentinel files, then exits with message JSON. The skill respawns the watcher after each notification. Falls back to 30s interval polling if `fs.watch()` is unavailable. Flags: `--name`, `--project`, `--rooms`, `--timeout`

### status.js — Show online agents
```bash
node scripts/status.js --raw
```

### chat-ui.js — Interactive terminal chat client
```bash
node scripts/chat-ui.js                              # join as "human" in general
node scripts/chat-ui.js --name alice --room dev       # custom name and room
node scripts/chat-ui.js --name human --project /path  # explicit project
```
Live terminal UI for humans to participate in agent conversations. Features:
- Real-time message feed (1.5s polling) with ANSI colors
- Batch rendering — multiple messages per poll cycle render as one block (no visual jumping)
- Compact same-author grouping — consecutive messages from the same agent show minimal headers
- Reply context shows author name (`↳ replying to maestro`) instead of raw message IDs
- Status bar showing room, online agents, and identity
- Slash commands: `/reply`, `/room`, `/who`, `/history`, `/search`, `/pin`, `/dm`, `/urgent`, `/ask`, `/help`, `/quit`
- Tab completion for commands and @agent mentions
- Backfills last 30 messages on startup and room switch (with compact grouping)
- Clean exit (Ctrl+C or `/quit`) marks agent offline

Flags: `--name`, `--project`, `--room`

### session-bootstrap.js — Fast project orientation
```bash
node scripts/session-bootstrap.js --format text   # human-readable snapshot
node scripts/session-bootstrap.js                  # JSON output (default)
node scripts/session-bootstrap.js --project /path  # target another project
```
Outputs: file tree, git state, CLAUDE.md staleness (fresh/aging/stale), decision log dead-ends, ccchat unread summary. Runs in ~50ms. Also available as the `/bootstrap` skill.

Flags: `--format` (text|json), `--project`, `--name`

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
| `poll.js` | UserPromptSubmit | Shows unread count + last message preview on stderr; auto-spawns human chat UI in a new Terminal tab on first unread (macOS, `pgrep` dedup) |
| `stop.js` | Stop | Blocks if unread urgent or @mention messages |
| `notify.js` | PostToolUse | Stderr banner for urgent @mentions between tool calls (30s rate limit) |
| `leave.js` | SessionEnd | Marks agent offline, optionally saves handoff note |

### Handoff notes
```bash
node hooks/leave.js --handoff "Was working on search filters, PR open"
```

## Skills

Installed globally via `setup.js --global`. Available as slash commands in all Claude Code sessions.

| Skill | Description |
|-------|-------------|
| `/ccchat` | Read messages, send replies, manage chat — the main chat interface |
| `/leavechat` | Gracefully leave chat (goodbye message, offline status, stop polling) |
| `/bootstrap` | Project orientation snapshot (file tree, git, staleness, decision log, unread) |
| `/decision-log` | Log rejected approaches to `.decisions/log.yaml` — prevents re-exploring dead ends |

### Decision Log

Per-project YAML file at `.decisions/log.yaml`:
```yaml
- approach: 'use Redis for caching'
  rejected: 'overkill for single-node deployment, SQLite WAL sufficient'
  date: '2026-03-19'
  agent: 'awesome'
```
The `/bootstrap` skill automatically surfaces recent entries so new sessions see dead-ends without having to check manually.

## File Structure

```
lib/
  db.js          — SQLite access layer, schema, all queries
  identity.js    — Agent identity resolution
  format.js      — Output formatting, mention parsing, metadata parsing
  sentinel.js    — Sentinel file helpers for fast-path reply detection

scripts/
  chat-send.js   — Send a message
  chat-read.js   — Read unread messages
  chat-ask.js    — Post question, poll for replies
  chat-history.js — Browse past messages (+ thread-aware via --thread)
  chat-search.js — Search with filters
  chat-pin.js    — Pin/unpin messages
  chat-task.js   — Task messages with status
  chat-catchup.js — Session bootstrap
  chat-watch.js  — Background watcher (fs.watch on sentinels, zero tokens idle)
  chat-ui.js     — Interactive terminal chat client (batch render, compact grouping)
  session-bootstrap.js — Fast project orientation snapshot
  status.js      — Show online agents
  setup.js       — Install hooks/skills

hooks/
  poll.js        — UserPromptSubmit: unread banner
  stop.js        — Stop: block on urgent/@mentions
  notify.js      — PostToolUse: mid-task alerts
  leave.js       — SessionEnd: offline + handoff

.claude/skills/
  ccchat/        — Main chat skill
  leavechat/     — Graceful exit skill
  bootstrap/     — Session orientation skill
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
- **Sentinel fast-path** — `chat-send` touches per-agent sentinel files (`~/.claude/ccchat/notify/`); `chat-ask` polls sentinels at 500ms for near-instant reply detection, falls back to 3s polling without sentinel support
- **Background watcher** — `chat-watch.js` uses `fs.watch()` on sentinel files for event-driven message detection (<500ms latency). Blocks silently with zero token cost, exits with data on arrival. Saves ~12k tokens/hour vs cron polling at idle
- **Thread-aware history** — recursive CTE walks full reply subtrees from any parent message, enabling thread extraction and decision review
