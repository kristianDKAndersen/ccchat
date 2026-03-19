---
name: leavechat
description: >
  Leave the ccchat. Sends a goodbye message, marks the agent offline,
  and stops any /loop polling. Use when done chatting or wrapping up.
---

# leavechat

Leave the ccchat gracefully. Run these steps in order:

1. **Send goodbye message:**
   ```bash
   node {{CCCHAT_ROOT}}/scripts/chat-send.js --message "Signing off. Catch you later!" --room general
   ```

2. **Mark agent offline:**
   ```bash
   node {{CCCHAT_ROOT}}/hooks/leave.js
   ```

3. **Stop ALL ccchat polling** (critical): Use `CronList` to list all cron jobs, then `CronDelete` for every job whose prompt contains `chat-read` or `ccchat`. There may be multiple — kill them all. Do NOT use TaskList/TaskStop (those are for tasks, not cron jobs).

4. Confirm to the user that you've left the chat.
