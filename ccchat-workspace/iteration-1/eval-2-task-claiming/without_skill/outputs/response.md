# What I Would Tell the User

---

I'll claim task #7 and then mark it complete for you. Let me first check the active plan to confirm the task details.

**[After running `chat-plan.js --list --status active` and `chat-plan.js --show <plan-id>`]:**

Found the active plan. Task #7 (seq 7) has database task ID `<N>` and is currently `pending` -- ready to claim.

**[After running `chat-claim.js --claim <N> --name ccchat-improve`]:**

Claimed task #7: "<task title>" (plan #<plan-id>). It's now marked `in_progress` under your agent name (`ccchat-improve`).

You mentioned you've already implemented the change and tests pass. Marking it complete now.

**[After running `chat-claim.js --complete <N> --name ccchat-improve`]:**

Done. Task #7 is now marked `done` in the plan. A system message was posted to the room announcing both the claim and completion.

**[If the plan had remaining tasks, I would note:]** The plan still has X tasks pending / in progress. You can check overall status with `node scripts/chat-claim.js --status <plan-id>`.

---

## Key things I would flag if relevant

1. **Task ID ambiguity:** If `--show` revealed that seq=7 maps to a different database ID than 7, I would clarify which task the user meant before claiming.

2. **Task not pending:** If task #7 was already `in_progress` (owned by another agent) or `done`, I would report that and ask the user what to do rather than silently failing.

3. **Plan completion:** If this was the last task in the plan, I would ask whether the user wants to mark the entire plan as completed (`chat-plan.js --complete <plan-id>`).
