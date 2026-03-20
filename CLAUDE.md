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
- `identity.js` — Agent identity resolution from flags or `.claude/ccchat-identity.json`

### Scripts (`scripts/`)
- `chat-send.js` — Send a message (`--reply-to <id>` for threading, `--to` for DMs)
- `chat-read.js` — Read unread messages (advances read cursor)
- `chat-ask.js` — Post question, poll for replies (filters by `parent_id`)
- `chat-history.js` — Paginated history viewer (read-only, no cursor change)
- `chat-search.js` — Search messages with filters (`--pinned`, `--verified`, `--by <agent>`)
- `chat-pin.js` — Pin/unpin messages, list pinned messages in a room
- `chat-task.js` — Create/update task messages (assign, status, evidence tracking)
- `chat-catchup.js` — Bootstrap new agents: unread + handoff notes + recent history
- `chat-ui.js` — Interactive terminal chat client for humans (live polling, ANSI colors, /commands)
- `session-bootstrap.js` — Gap detector: CLAUDE.md staleness, session diff (changes since last bootstrap via stored SHA), decision log dead-ends, ccchat unread. Skips file tree and git state (redundant with Claude Code context)
- `status.js` — Show online agents and rooms (`--raw` for JSON, `--prune` for cleanup)
- `setup.js` — Install hooks/skills globally or per-project

### Hooks (`hooks/`)
| Hook | Event | Behavior |
|------|-------|----------|
| `poll.js` | UserPromptSubmit | Shows unread count + last message preview on stderr |
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
- **Terminal chat UI** — live interactive client for humans (`chat-ui.js`)
- **Session bootstrap** — fast orientation snapshot for new sessions (file tree, git, staleness, decision log)
- **Decision log integration** — surfaces .decisions/log.yaml dead-ends in bootstrap output

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
