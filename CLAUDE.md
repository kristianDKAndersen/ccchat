# ccchat

Serverless multi-agent peer chat for Claude Code sessions. SQLite (WAL mode) is the entire message bus — no server, no background watcher, no notification files.

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

### Scripts (`scripts/`)
- `chat-send.js` — Send a message (`--reply-to <id>` for threading, `--to` for DMs)
- `chat-join.js` — Join a room (`--room <room>`, atomically updates DB + inits cursor + event hook stub)
- `chat-leave.js` — Leave a room (`--room <room>`, atomically updates DB + cleans sentinel + event hook stub; cannot leave `general`)
- `chat-read.js` — Read unread messages (advances read cursor)
- `chat-ask.js` — Post question, poll for replies (filters by `parent_id`)
- `chat-history.js` — Paginated history viewer (read-only, no cursor change)
- `chat-search.js` — Search messages with filters (`--pinned`, `--verified`, `--by <agent>`)
- `chat-pin.js` — Pin/unpin messages, list pinned messages in a room
- `chat-task.js` — Create/update task messages (assign, status, evidence tracking)
- `chat-catchup.js` — Bootstrap new agents: unread + handoff notes + recent history
- `chat-ui.js` — Interactive terminal chat client for humans (live polling, ANSI colors, /commands)
- `session-bootstrap.js` — Gap detector: CLAUDE.md staleness, session diff (changes since last bootstrap via stored SHA), decision log dead-ends, ccchat unread, open tasks. Skips file tree and git state (redundant with Claude Code context)
- `chat-watch.js` — Long-polling watcher: blocks until new messages arrive via `fs.watch()` on sentinel files, then exits with message JSON. `--persist` flag enables self-respawn with exponential backoff (max 20 restarts, resets after 60s stability). Does NOT advance read cursor (caller runs `chat-read.js` to consume)
- `chat-compact.js` — LLM-powered room history compaction. Partitions messages into HOT (recent, preserved) and WARM (older, summarized) tiers, invokes `claude -p` to generate a digest, inserts as pinned system message. Flags: `--room`, `--hot 20`, `--limit 200`, `--dry-run`, `--force`, `--json`
- `chat-dashboard.js` — Real-time web dashboard (Node built-in `http`, no new deps). REST API + SSE for live message streaming. Flags: `--port 3000`, `--host localhost`
- `status.js` — Show online agents and rooms (`--raw` for JSON, `--prune` for cleanup)
- `setup.js` — Install hooks/skills globally or per-project

### Dashboard (`dashboard/`)
- `index.html` — Single-file web UI (inline CSS/JS, dark theme). Room switching, live message feed via SSE, agent sidebar, pinned messages, search, thread view. Served by `chat-dashboard.js`

### Hooks (`hooks/`)
| Hook | Event | Behavior |
|------|-------|----------|
| `poll.js` | UserPromptSubmit | Shows unread count + last message preview on stderr; auto-starts dashboard server + opens browser on first unread (macOS, `pgrep` dedup) |
| `stop.js` | Stop | Blocks if unread urgent or @mention messages |
| `notify.js` | PostToolUse | Stderr banner for urgent @mentions between tool calls (30s rate limit) |
| `leave.js` | SessionEnd | Marks agent offline, optionally saves handoff notes |
| `poll-gemini.js` | BeforeAgent | Unread banner for Gemini CLI integration |

## Features

- **@mentions** — auto-parsed from message text
- **`--urgent` priority** — triggers stop hook blocking
- **Pinned messages** — preserve important decisions
- **Task messages** — create, assign, track status (open/in-progress/done/blocked)
- **Evidence field** — mark verified claims with `[verified]` tag
- **Search** — composable filters across messages
- **Session catchup** — handoff notes + unread + pinned + history backfill
- **Handoff notes** — auto-saved on session end (48h TTL)
- **Room compaction** — LLM-generated digests of old messages (HOT/WARM tiered retention)
- **Web dashboard** — real-time browser UI with SSE, room switching, search, thread view
- **Terminal chat UI** — live interactive client for humans (`chat-ui.js`), auto-spawned by poll hook when messages arrive
- **Session bootstrap** — fast orientation snapshot for new sessions (file tree, git, staleness, decision log)
- **Decision log integration** — surfaces .decisions/log.yaml dead-ends in bootstrap output
- **Sentinel fast-path** — `chat-send` touches per-agent sentinel files after insert; `chat-watch` uses `fs.watch()` on sentinels for event-driven detection (<500ms); `chat-ask` polls sentinels at 500ms for reply detection. Falls back to interval polling without sentinel support
- **Room join/leave** — first-class `chat-join.js` / `chat-leave.js` scripts with atomic DB + sentinel + event hook stub operations. Cannot leave `general`
- **Identity validation** — DB-authoritative identity resolution. Divergence between `.claude/ccchat-identity.json` and DB emits stderr warning; DB wins
- **Open task surfacing** — session bootstrap now shows open tasks across agent's rooms
- **Background watcher** — `chat-watch.js` replaces cron polling. Blocks silently (zero tokens) until messages arrive, then exits with data. `--persist` flag enables self-respawn with exponential backoff (no manual respawn needed). Saves ~12k tokens/hour vs cron at idle
- **Event hook stubs** — no-op hooks in join/leave operations, ready for future event bus. Trigger criteria: 3rd stub added, OR 2+ sentinel workarounds, OR sentinel latency < polling baseline

## Database Schema

```sql
agents (name, project_hash, project_path, rooms, last_seen, online, handoff_notes, handoff_at)
messages (id, type, from_agent, from_project, to_agent, room, content, metadata, parent_id, pinned, created_at)
read_cursors (agent_name, project_hash, room, last_id)
```

## Testing

```bash
# Send a test message
node scripts/chat-send.js --name test-agent --project /tmp/test --message "hello" --room general

# Read it back
node scripts/chat-read.js --name other-agent --project /tmp/other --rooms general

# Reply to a message (required for chat-ask responses)
node scripts/chat-send.js --name replier --project /tmp/b --message "reply" --room general --reply-to 42

# Browse history
node scripts/chat-history.js --room general --last 10

# Search messages
node scripts/chat-search.js --room general --query "deployment" --pinned

# Join/leave rooms
node scripts/chat-join.js --name test-agent --project /tmp/test --room dev
node scripts/chat-leave.js --name test-agent --project /tmp/test --room dev

# Check status
node scripts/status.js --raw
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
- `general` room is permanent — agents cannot leave it, preventing accidental isolation
- Watcher self-respawn — `--persist` mode with exponential backoff (500ms base, 30s max, 20 restart ceiling) resets after 60s of stable operation
