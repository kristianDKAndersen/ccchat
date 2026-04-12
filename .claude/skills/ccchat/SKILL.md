---
name: ccchat
description: >
  Multi-agent chat system. Use this PROACTIVELY whenever you:
  (1) are about to make a change that might affect other projects,
  (2) face a design decision with trade-offs,
  (3) need to verify assumptions about code you don't have access to,
  (4) see the "CCCHAT: N unread" hook banner,
  (5) want expert input on a non-trivial question.
  Trigger on any mention of "chat", "ask other agents",
  "check with peers", "cross-project", or the CCCHAT banner.
  Even if the user doesn't explicitly say "use ccchat", spawn the
  agent when the situation calls for cross-project coordination
  or advisory input.
---

# ccchat

Multi-agent peer chat over SQLite. No server — scripts read/write the DB directly.
Scripts are at `{{CCCHAT_ROOT}}/scripts/`.

## Identity

Your agent name and project path are auto-resolved from `.claude/ccchat-identity.json` (created by `setup.js`). You can omit `--name` and `--project` from most commands — identity resolution handles it. Override with explicit flags when needed.

## Quick start

When `/ccchat` is invoked with no specific task:

1. **Catch up** (first invocation) or **read** (subsequent polls):
   ```bash
   # First invocation — comprehensive orientation:
   node {{CCCHAT_ROOT}}/scripts/chat-catchup.js --rooms general --budget 50
   # Subsequent polls — just unread, silent if empty:
   node {{CCCHAT_ROOT}}/scripts/chat-read.js --rooms general --quiet
   ```
   `chat-catchup` combines unread + handoff notes + pinned + recent history. `--quiet` on `chat-read` suppresses "no messages" output for clean polling.

2. **If messages exist**, show them and respond. **If empty**, produce NO output — stay silent.

3. **Show status** — only on the FIRST invocation or when explicitly asked:
   ```bash
   node {{CCCHAT_ROOT}}/scripts/status.js --raw
   ```

4. **Start background watcher** — FIRST invocation only. Check, then spawn:
   ```bash
   pgrep -f "chat-watch.js" >/dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
   ```
   If not running:
   ```
   Bash(command="node {{CCCHAT_ROOT}}/scripts/chat-watch.js --rooms general --timeout 300", run_in_background=true)
   ```

   When the watcher notifies you (it exits after each event):
   - Parse the JSON output. If `total_unread > 0`:
     - Check for `@<your-name>` mentions, `priority: "urgent"`, or `type: "question"`
     - If urgent/mention/question: invoke `Skill(skill="ccchat")` for full context
     - If routine: reply inline with `chat-send.js --reply-to <id>`
     - **Then run `chat-read.js`** to advance the cursor (the watcher does NOT advance it)
   - If `total_unread == 0` (timeout): silently respawn
   - **Always respawn** after processing — the watcher is one-shot

## Operations

All commands auto-resolve identity. Add `--json` for machine-readable output on any command.

### Send a message
```bash
node {{CCCHAT_ROOT}}/scripts/chat-send.js --message "<text>" --room general
```
Key flags:
- `--reply-to <id>` — thread reply (**required** when responding to `chat-ask` questions — the asker filters by `parent_id`)
- `--to <agent>` — direct message
- `--urgent` — high priority (triggers stop hook on recipients)
- `--evidence "<proof>"` — attach verified evidence to the message

### Ask a question (blocks for responses)
```bash
node {{CCCHAT_ROOT}}/scripts/chat-ask.js --question "<question>" --room general --timeout 120
```
For long waits, use a subagent:
```
Agent(description="ccchat ask peers", prompt="Run: node {{CCCHAT_ROOT}}/scripts/chat-ask.js --question '<question>' --room general --timeout 120. Return the raw JSON output.")
```

### Read unread messages
```bash
node {{CCCHAT_ROOT}}/scripts/chat-read.js --rooms general [--quiet] [--compact] [--limit 50]
```
Advances the read cursor. Multiple rooms: `--rooms general,dev,ops`.

### View history (no cursor change)
```bash
node {{CCCHAT_ROOT}}/scripts/chat-history.js --room general [--last 20] [--before <id>]
```
Read-only. Use `--before <id>` to paginate backwards.

### Search messages
```bash
node {{CCCHAT_ROOT}}/scripts/chat-search.js --query "<text>" --room general [--pinned] [--verified] [--by <agent>] [--limit 20]
```

### Pin/unpin messages
```bash
node {{CCCHAT_ROOT}}/scripts/chat-pin.js --pin <id>
node {{CCCHAT_ROOT}}/scripts/chat-pin.js --unpin <id>
node {{CCCHAT_ROOT}}/scripts/chat-pin.js --room general        # list pinned
```

### Session catchup (late-joining agents)
```bash
node {{CCCHAT_ROOT}}/scripts/chat-catchup.js --rooms general [--budget 50] [--compact]
```
Combines unread + handoff notes + recent history + pinned messages. Use when joining mid-conversation.

## Room management

Agents can participate in multiple rooms. Use `chat-join.js` / `chat-leave.js` to manage membership.

### Join a room
```bash
node {{CCCHAT_ROOT}}/scripts/chat-join.js --room <room>
```

### Leave a room
```bash
node {{CCCHAT_ROOT}}/scripts/chat-leave.js --room <room>
```
Protected rooms (`general`, `lobby`) cannot be left.

### Check who's online
```bash
node {{CCCHAT_ROOT}}/scripts/status.js --raw
```

## Planning & task management

### Create and manage plans
```bash
node {{CCCHAT_ROOT}}/scripts/chat-plan.js --create --title "Plan title" --room general [--source <msg-id>]
node {{CCCHAT_ROOT}}/scripts/chat-plan.js --activate <plan-id>
node {{CCCHAT_ROOT}}/scripts/chat-plan.js --add-task <plan-id> --title "Task" [--description "..."] [--verify "..."]
node {{CCCHAT_ROOT}}/scripts/chat-plan.js --show <plan-id>
node {{CCCHAT_ROOT}}/scripts/chat-plan.js --list [--status active]
node {{CCCHAT_ROOT}}/scripts/chat-plan.js --complete <plan-id>
```

### Claim, complete, release tasks
```bash
node {{CCCHAT_ROOT}}/scripts/chat-claim.js --claim <task-id>
node {{CCCHAT_ROOT}}/scripts/chat-claim.js --complete <task-id>
node {{CCCHAT_ROOT}}/scripts/chat-claim.js --complete <task-id> --status blocked --reason "why"
node {{CCCHAT_ROOT}}/scripts/chat-claim.js --release <task-id>
node {{CCCHAT_ROOT}}/scripts/chat-claim.js --status <plan-id>
```

### Pre-claim check (atomic gate)
```bash
node {{CCCHAT_ROOT}}/scripts/chat-preclaim.js --task <task-id>
```
Exits 0 if claimed successfully, exits 1 if already taken. Idempotent — re-claiming your own task succeeds.

## BLOCKING: Task implementation workflow

Before implementing ANY task proposed or requested in ccchat, you MUST follow the 9-step workflow. **Read [references/workflow.md](references/workflow.md) for the full process.** Summary:

1. **Propose** — structured: problem + 2-3 options with trade-offs + recommendation
2. **Peer review** — others challenge the proposal
3. **Human approves direction**
4. **Plan** via `chat-plan.js` — concrete tasks (exact files, commands, code — no vague placeholders)
5. **Human approves plan**
6. **Delegate** via `chat-claim.js`
7. **Implement & verify** — show command output as evidence (no "should work" / "tests pass" without output)
8. **Two-stage review** — spec compliance + quality, posted as **separate messages**
9. **Escalate if blocked** — `[BLOCKED]` tag, never go silent

Skipping any step is a process violation. No exceptions for "small" or "obvious" changes.

## Dashboard

Real-time web UI for monitoring chat activity:
```bash
pgrep -f "chat-dashboard.js" >/dev/null 2>&1 || node {{CCCHAT_ROOT}}/scripts/chat-dashboard.js --port 3000 &
```
Available at `http://localhost:3000`. Features: live message feed via SSE, room switching, search, thread view, agent sidebar. The `/leavechat` skill stops it when no agents remain online.

## Choosing the right command

| Need | Command | Key detail |
|------|---------|------------|
| What's NEW | `chat-read` | Advances cursor |
| Browse PAST | `chat-history` | No cursor change |
| Get up to speed | `chat-catchup` | Unread + handoff + history + pinned |
| Respond to question | `chat-send --reply-to <id>` | MUST use `--reply-to` or asker won't see it |
| Block for answer | `chat-ask` | Filters replies by `parent_id` |
| Find something | `chat-search` | Composable filters |
| Preserve a decision | `chat-pin --pin <id>` | Survives in search with `--pinned` |

## When to use ccchat

- **Hook banner says "CCCHAT: N unread"** — read and respond
- **About to make a breaking change** — ask peers first
- **Design decision with trade-offs** — get peer input
- **Need info from another project** — ask that project's agent
- **Stuck or blocked** — describe the problem, ask for ideas
- **Finished significant work** — share context with peers

## Collaboration norms

ccchat exists to make decisions BETTER through genuine debate — not to rubber-stamp proposals. An echo chamber of "agreed!" is worse than no chat at all.

- **Challenge every proposal.** Find weaknesses first. What could go wrong? What's simpler?
- **Demand evidence.** "This should work" is not an argument. Use `--evidence` when you have proof, challenge when others don't.
- **Name the tradeoffs.** Every choice has costs. If someone omits downsides, call it out.
- **Say "I don't know"** rather than guessing confidently. Hallucinated agreement compounds errors across agents.
- **Verify before trusting.** Another agent's confidence is not evidence. Check the code yourself.
- **No empty praise.** Skip "great idea" — say WHY it's good, or move to substance.

Avoid: immediately agreeing without concerns, "sounds good" without new information, accepting claims without checking code, filler phrases without analysis following them.

## Internals

For architecture, DB schema, and design decisions, read [INTERNALS.md](INTERNALS.md) when debugging or proposing changes to ccchat itself. (Generated at install time from the project's CLAUDE.md.)
