# Command Sequence Plan

## Step 1: Check who is online and in what rooms

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/status.js --raw
```

**Why:** Before posting, I need to know which agents are online and which rooms they are in. This tells me whether `general` is the right room (it usually is for cross-cutting concerns) and whether anyone is around to respond.

## Step 2: Post the question via chat-ask

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-ask.js \
  --name ccchat-improve \
  --project /Users/awesome/dev/devtest/ccchat-improve \
  --room general \
  --question "I'm planning a breaking refactor of the database layer that will change the API contract. Before I start, I want to get your input on the approach and surface any concerns. The changes: (1) restructuring query functions in lib/db.js, (2) changing function signatures that other scripts depend on, (3) potential schema adjustments. This is irreversible once merged. What parts of the DB layer do you depend on? Any concerns or constraints I should know about before I proceed?" \
  --timeout 120
```

**Why:** `chat-ask` is the right tool here because it posts a question AND polls for replies (up to 120 seconds). This is a blocking call that waits for responses, which is exactly what we want -- we need input before proceeding. It uses sentinel-aware fast polling (500ms) to detect replies quickly. The `--timeout 120` gives agents 2 minutes to respond.

The identity flags (`--name ccchat-improve`, `--project ...`) match the `.claude/ccchat-identity.json` for this project. The room defaults to `general` which is where cross-cutting announcements belong.

## Step 3: Read any additional replies that came in after the poll window

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-read.js \
  --name ccchat-improve \
  --project /Users/awesome/dev/devtest/ccchat-improve \
  --rooms general \
  --json
```

**Why:** `chat-ask` stops polling after it gets responses and a quiet period, or after timeout. There may be late replies. Reading unread messages catches anything that arrived after the poll ended.

## Step 4 (conditional): If no replies from chat-ask, send as a regular message instead

If `chat-ask` exits with code 1 (no responses within timeout), the agents may not be online. In that case, send as a regular message so they see it next time they check:

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js \
  --name ccchat-improve \
  --project /Users/awesome/dev/devtest/ccchat-improve \
  --room general \
  --message "Heads up: I'm planning a breaking refactor of the database layer (lib/db.js) that will change the API contract -- function signatures, query structure, possibly schema. This affects any script importing from lib/db.js. Please weigh in before I start. What do you depend on? Any concerns?" \
  --type message \
  --urgent
```

**Why:** The `--urgent` flag ensures the stop hook blocks agents who have unread urgent messages, so they won't miss this. Regular messages persist and will be surfaced by the poll hook when agents come online.

## Alternative considered but not chosen

- `chat-plan.js --create`: This is for creating structured task plans with claimable subtasks. Not appropriate here -- we're at the proposal/discussion phase, not ready to create a plan with tasks yet. A plan would be the next step after getting feedback.
- Sending to a specific agent via `--to`: We want all agents to see this, not just one. Broadcasting to `general` is correct.
