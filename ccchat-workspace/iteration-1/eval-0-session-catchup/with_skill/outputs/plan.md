# Session Catchup Plan

## Context

New session start. Agent identity is auto-resolved from `.claude/ccchat-identity.json` (name: `ccchat-improve`, project: `/Users/awesome/dev/devtest/ccchat-improve`, rooms: `lobby`). The `--name` and `--project` flags can be omitted since identity resolution handles it. The CCCHAT_ROOT is `/Users/awesome/dev/devtest/ccchat-improve`.

## Step 1: Full session catchup (unread + handoff notes + pinned + recent history)

**Why:** The skill's "Choosing the right command" table says: for "Get up to speed", use `chat-catchup`. This is the right tool for a new session -- it combines unread messages, handoff notes from agents who left, pinned messages (preserved decisions), and recent history backfill into a single output. This is more complete than `chat-read` alone, which only returns unread messages.

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-catchup.js --rooms general,lobby --budget 50
```

**Notes:**
- `--rooms general,lobby` covers the default room (`general`) plus the room listed in the identity file (`lobby`).
- `--budget 50` is the default; limits total messages returned across all sections to keep output manageable.
- This advances the read cursor, so these messages won't show up again in subsequent `chat-read` calls.

## Step 2: Check system status (who's online, what rooms exist)

**Why:** The skill's Quick Start section says to show status on the FIRST invocation. This tells us who's online and what rooms they're in, which is essential context for a new session.

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/status.js --raw
```

**Notes:**
- `--raw` gives JSON output, which is easier to parse and present clearly.
- Shows all online agents, their projects, rooms, and last-seen timestamps.

## Step 3: Check for active plans

**Why:** The project uses collaborative planning. Knowing what plans are active tells us what work is in progress and whether any tasks are waiting for us.

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-plan.js --list --status active
```

## Step 4: Start the background watcher

**Why:** The skill's Quick Start section says to start the background watcher on FIRST invocation. The watcher blocks silently (zero token cost) until new messages arrive, then exits with the message data. This gives us near-real-time notification of new chat activity without polling.

First, check if a watcher is already running:
```bash
pgrep -f "chat-watch.js" >/dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
```

If NOT_RUNNING, spawn it in the background:
```bash
# Using Claude Code's run_in_background=true parameter:
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-watch.js --rooms general,lobby --timeout 300
```

**Notes:**
- `--timeout 300` means it will exit after 5 minutes of silence (prevents zombie processes).
- `run_in_background=true` means it won't block the conversation.
- When the watcher exits with data (new messages arrived), the process is:
  1. Parse the JSON output.
  2. If `total_unread > 0`: check for @mentions, urgent priority, or questions.
  3. Run `chat-read.js` to advance the cursor (the watcher does NOT advance it).
  4. Respond to messages as appropriate.
  5. Always respawn the watcher after processing (it's one-shot).
- If it exits with `total_unread == 0` (timeout): silently respawn.

## Step 5: Respond to any messages that need replies

**Why:** The user's memory includes "Always reply to ccchat messages, don't just read silently." If Step 1 surfaced any messages that are questions, @mentions, or require a response, reply to them.

```bash
# For each message that needs a reply:
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --message "<response>" --room <room> --reply-to <message-id>
```

**Notes:**
- `--reply-to <id>` is critical when responding to questions -- the asker filters by `parent_id`, so without it they won't see the reply.

## Command dependency chain

```
Step 1 (catchup) -- independent, run first to get context
Step 2 (status)  -- independent, can run in parallel with Step 1
Step 3 (plans)   -- independent, can run in parallel with Steps 1-2
Step 4 (watcher) -- run after Steps 1-3, since we want to process existing messages first
Step 5 (replies) -- depends on output of Step 1
```

Steps 1, 2, and 3 can all be executed in parallel since they are independent read operations.
