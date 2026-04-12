# Command Sequence for Claiming and Completing Task #7

## Step 1: Find the active plan

First, identify which plan is active so we can inspect its tasks and confirm task #7 exists and is claimable.

```bash
node scripts/chat-plan.js --list --status active
```

**Why:** We need the plan ID to inspect tasks. The user said "there's an active plan" but didn't specify which one. This lists all active plans.

## Step 2: Show the plan and its tasks

```bash
node scripts/chat-plan.js --show <plan-id>
```

**Why:** We need to see the full task list to determine the actual database task ID for "task #7". The user might mean seq=7 (the 7th task in the plan) or id=7 (the database primary key). The `--show` output displays both `seq` numbers and task titles/statuses. We need to confirm the task is in `pending` status before claiming.

## Step 3: Claim the task

Using the task's database ID (confirmed from step 2):

```bash
node scripts/chat-claim.js --claim <task-id> --name ccchat-improve --project /Users/awesome/dev/devtest/ccchat-improve
```

**Why:** This atomically claims the task via `claimTask()` in db.js, which uses a conditional UPDATE (`WHERE status = 'pending'`) to prevent race conditions. It also posts a system message to the plan's room announcing the claim. The `--name` and `--project` flags resolve identity; since we have `.claude/ccchat-identity.json` with name "ccchat-improve", we could also rely on auto-resolution, but being explicit is safer.

**Alternative:** Could also use `chat-preclaim.js --task <task-id> --name ccchat-improve` which is a lighter-weight claim gate (no system message posted, just the atomic claim). However, `chat-claim.js --claim` is the canonical approach because it announces the claim to the room.

## Step 4: Verify the claim succeeded

```bash
node scripts/chat-plan.js --show <plan-id>
```

**Why:** Confirm the task now shows status `in_progress` with owner `ccchat-improve`. This catches any race condition where another agent claimed it between our check and our claim (though `claimTask` is atomic, the system message might confuse if the claim silently failed).

## Step 5: Mark the task as complete

After the user confirms implementation is done and tests pass:

```bash
node scripts/chat-claim.js --complete <task-id> --name ccchat-improve --project /Users/awesome/dev/devtest/ccchat-improve
```

**Why:** This calls `completeTask()` which sets status to `done` and records `completed_at`. It also posts a system message announcing completion. The `--status done` flag is implicit (it defaults to `done`). The script validates that the current agent is the owner before allowing completion.

## Step 6: Verify completion and check remaining plan status

```bash
node scripts/chat-claim.js --status <plan-id>
```

**Why:** Shows the full task breakdown (done, in_progress, pending, blocked) so we can confirm the task is marked done and see if the overall plan is progressing. This is the `--status` view from chat-claim.js which groups tasks by state.

## Notes on task ID ambiguity

"Task #7" is ambiguous:
- It could mean the task with `seq = 7` within the plan (the 7th task listed)
- It could mean the task with database `id = 7`

The `--show` output from step 2 displays tasks as `seq. [status] title`, and the database ID is visible in JSON mode (`--json`). If there's any doubt, running with `--json` gives precise IDs:

```bash
node scripts/chat-plan.js --show <plan-id> --json
```

The `--claim` and `--complete` flags on `chat-claim.js` take the database `id`, not the `seq` number.
