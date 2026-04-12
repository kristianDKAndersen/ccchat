# Workflow and Process Compliance Notes

## What I found in the codebase

### 1. CLAUDE.md references a 9-step BLOCKING task workflow

The project CLAUDE.md describes a "9-step BLOCKING task workflow" with these gates:

> propose (structured) -> peer review -> approve direction -> plan (no placeholders) -> approve plan -> delegate -> implement & verify -> two-stage implementation review (spec compliance + quality, separate messages) -> escalate if blocked

It also mentions "Two human approval gates" and a "Rationalization prevention red-flag table in skill doc."

### 2. What this means for the current task

The user asked me to claim and complete a task from an already-active plan. The 9-step workflow applies to the full lifecycle of creating and executing plans. Since the plan is already active (meaning steps 1-6 have presumably already been completed by whoever created and approved the plan), claiming and completing a specific task falls within step 7 ("implement & verify").

However, the workflow also specifies a **two-stage implementation review** (step 8): spec compliance review + quality review, as separate messages. The user said "I already ran the tests and they pass" which covers verification, but the workflow appears to require peer review of the implementation in the chat system before marking done.

### 3. Compliance gaps I cannot fully evaluate without the skill document

The CLAUDE.md references a "skill doc" that contains the full rationalization prevention red-flag table and presumably the detailed workflow rules. Without access to that skill document (the task says "execute without skill guidance"), I cannot verify:

- Whether the two-stage review is mandatory before marking a task `done`
- Whether there are additional gates between "implement" and "complete"
- What the red-flag table contains and whether any red flags apply here
- Whether the `[BLOCKED]` convention has specific formatting requirements

### 4. What the code enforces vs. what is convention

**Enforced by code (hard gates):**
- Task must be `pending` to claim (atomic `WHERE status = 'pending'` in SQL)
- Task must be owned by the claiming agent to complete (`WHERE owner = ?`)
- Plan must be `active` for tasks to be meaningful
- `claimTask` is atomic -- first writer wins in concurrent scenarios
- `completeTask` requires ownership match

**Convention only (not enforced by code):**
- The 9-step workflow is a process agreement, not a code constraint
- Two-stage implementation review is a social contract
- Peer review before completion is not gated in the scripts
- The `chat-preclaim.js` script exists as a lighter pre-check but doesn't enforce workflow steps

### 5. Memory/feedback rules that apply

From the memory files referenced in MEMORY.md:
- **feedback_plan_before_implement.md** -- "All ccchat tasks must follow plan/review/approve before implementing." Since this task is already in an active plan and the user says implementation is done, the plan/review/approve steps should have already occurred.
- **feedback_always_reply_chat.md** -- "Always reply to ccchat messages, don't just read silently." If there are unread messages in ccchat related to this task, I should respond.
- **feedback_always_weigh_in.md** -- "Always weigh in on proposals immediately." If claiming this task requires weighing in on a related discussion, I should do that.

### 6. Risk assessment

**Low risk:** Claiming a task and marking it complete are reversible operations. Tasks can be released (`--release`) and their status can be changed. The system messages posted to the room create an audit trail.

**Potential concern:** Marking a task complete without the two-stage review could violate the project's workflow norms. However, the user explicitly asked me to do this and stated tests pass. Per the critical thinking rules: "When the user gives a direct instruction, execute it. If you see a genuine risk, raise it AFTER completing the task."

### 7. What I would flag to the user

After completing the claim+done sequence, I would note:

> The project's 9-step workflow includes a two-stage implementation review (spec compliance + quality) before tasks are considered fully done. If your team is following that process, you may want to post the implementation for peer review in ccchat before considering this task closed. I went ahead and marked it done per your request since you confirmed tests pass.

This follows the "execute, then flag" principle from the critical thinking guidelines.
