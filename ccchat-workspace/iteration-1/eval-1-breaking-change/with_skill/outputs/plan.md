# Plan: Post breaking DB layer change proposal to ccchat

## Context

The user wants to refactor the database layer -- a breaking change affecting the API contract. The skill (SKILL.md) explicitly lists "About to make a breaking change -- ask peers first" as a trigger for using ccchat. The 9-step task workflow (references/workflow.md) requires a structured proposal BEFORE any implementation begins.

This is Step 1 (Propose) of the mandatory 9-step workflow. The proposal must include: problem statement, 2-3 options with trade-offs, and a recommendation. A message that just says "I'm going to refactor the DB layer" is NOT a valid proposal -- it must be structured.

## Command sequence

### 1. Read unread messages first (check current state)

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-read.js --rooms general --quiet
```

**Why:** The skill's quick-start flow says to always read unread messages first. We need to know the current conversation state before posting -- there may be relevant context or ongoing discussions that affect our proposal.

### 2. Check who is online

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/status.js --raw
```

**Why:** Know which agents are available to review the proposal. If no one is online, we may need to use `--urgent` or `chat-ask` with a longer timeout.

### 3. Post the structured proposal

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js \
  --message "[PROPOSAL] Database layer refactor — breaking API contract change

**Problem:** The current database layer needs refactoring. This is a breaking change that will affect the API contract — any agent or script that calls DB functions directly will need to be updated.

**Option A — Incremental migration with compatibility shim:**
Add a compatibility layer that maps old function signatures to new ones. Deprecate old signatures, remove after all callers migrate.
+ No sudden breakage; callers migrate at their own pace
- Two code paths to maintain during transition; risk of shim bugs masking real issues; longer total timeline

**Option B — Big-bang refactor with coordinated cutover:**
Refactor the DB layer in one pass, update all callers simultaneously, land as a single coordinated change.
+ Clean break, no legacy shim; all code uses new API immediately
- High coordination cost; all agents must pause other work; larger blast radius if something goes wrong

**Option C — Feature-flag the new layer:**
Build new DB layer alongside old one, gate access with a feature flag, flip per-caller as each is verified.
+ Controlled rollout; easy rollback per caller; can run both in parallel for validation
- Feature flag infrastructure overhead; potential for state divergence between old and new layers; flag cleanup debt

**Recommendation:** I lean toward Option A (incremental migration with compatibility shim) for a codebase with multiple active agents. It minimizes coordination overhead and lets each caller migrate independently. But I want to hear whether the blast radius of Option B is actually manageable given current team size, or whether Option C's flag overhead is worth the rollback safety.

Requesting peer review before proceeding. What are the risks I'm not seeing?" \
  --room general
```

**Why:** This is Step 1 of the 9-step workflow. The message is structured as a valid proposal with problem statement, 3 options with explicit trade-offs, and a recommendation. Posted to `general` room where all agents can see it. Identity is auto-resolved from `.claude/ccchat-identity.json`.

### 4. Use chat-ask to block for peer responses

```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-ask.js \
  --question "I've posted a proposal for a breaking DB layer refactor in general. Please review and challenge it -- what are the risks I'm missing? Which option do you favor and why?" \
  --room general \
  --timeout 120
```

**Why:** `chat-ask` blocks and filters replies by `parent_id`, so we get direct responses to our question. 120-second timeout gives peers time to review and respond. If no response, we can re-post or escalate.

Alternative for longer waits (if agents are slow to respond):
```
Agent(description="ccchat ask peers about DB refactor", prompt="Run: node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-ask.js --question 'Proposal for breaking DB layer refactor posted in general. Need peer review -- challenge the approach, name risks.' --room general --timeout 120. Return the raw JSON output.")
```

### 5. After peer review completes (Step 2 done), report back to user

Present the peer feedback to the user. The next step (Step 3) is human approval of the direction -- the user must explicitly approve before we proceed to planning.

## What we explicitly do NOT do yet

- **Do NOT create a plan** (Step 4) -- that requires human approval of direction first (Step 3)
- **Do NOT start implementing** -- implementation is Step 7, and requires TWO human approvals (Steps 3 and 5)
- **Do NOT claim any tasks** -- no plan exists yet to claim from
- The workflow is blocking: each step must complete before the next begins

## Skill guidance mapped to this task

| Skill instruction | How we follow it |
|---|---|
| "About to make a breaking change -- ask peers first" | We post the proposal before any code changes |
| "Challenge every proposal. Find weaknesses first" | We explicitly ask peers to challenge and find risks |
| "Post a structured proposal... problem + 2-3 options + recommendation" | Message includes all three elements |
| "No approval = no plan" | We stop after posting and wait for peer review + human approval |
| "Name the tradeoffs" | Each option lists explicit + and - trade-offs |
