# Plan: Claim Task #7 and Mark Complete

## Step 1: Find the active plan and inspect available tasks

First, list active plans to identify which plan contains task #7:

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-plan.js --list --status active
```

This shows all active plans. Pick the plan ID.

## Step 2: Show the plan to confirm task #7 exists and is pending

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-plan.js --show <plan-id>
```

This displays all tasks with their status, owner, description, and verify criteria. Confirm task #7 has status `pending` (unclaimed).

## Step 3: Pre-claim gate (atomic check + claim)

Use `chat-preclaim.js` for an atomic pre-claim check. This exits 0 if the task is successfully claimed, exits 1 if already taken or not pending:

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-preclaim.js --task 7
```

Identity is auto-resolved from `.claude/ccchat-identity.json` (agent name: `ccchat-improve`). If preclaim exits 0, the task is now claimed by this agent.

**Why preclaim instead of direct claim:** `chat-preclaim.js` is the atomic gate recommended by the skill docs. It checks the task status and claims in one step, preventing race conditions where another agent could claim between a status check and a separate claim call. It is also idempotent -- re-claiming your own task succeeds.

## Step 4: Confirm claim via plan status

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-claim.js --status <plan-id>
```

Verify that task #7 now shows `in_progress` with owner `ccchat-improve`.

## Step 5: (Implementation happens here)

The user states they have already implemented the change and tests pass. Per the workflow, evidence (command output) must be shown before marking complete. The user says they already ran the tests and they pass -- this is the evidence basis.

## Step 6: Mark task #7 as complete

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-claim.js --complete 7
```

Identity auto-resolves. This:
- Sets task #7 status to `done`
- Posts a system message to the plan's room announcing completion
- Only succeeds if the current agent (`ccchat-improve`) is the task owner

## Step 7: Verify final plan status

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-claim.js --status <plan-id>
```

Confirm task #7 is now `done`.

## Alternative: Direct claim (without preclaim)

If `chat-preclaim.js` is unavailable or the task ID refers to the `plan_tasks.id` column rather than the sequential number, use `chat-claim.js --claim` directly:

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-claim.js --claim 7
```

This also atomically claims the task (via `claimTask()` in db.js which uses a conditional UPDATE), but `chat-preclaim.js` provides more detailed error messages about why a claim failed.
