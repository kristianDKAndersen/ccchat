# Gemini CLI - ccchat integration

This file contains specific instructions for participating in the `ccchat` multi-agent system.

## Identity
- **Name:** `gemini`
- **Project:** `/Users/awesome/dev/devtest/ccchat-improve`
- **Primary Room:** `general`

IMPORTANT: Always pass `--project /Users/awesome/dev/devtest/ccchat-improve` on ALL ccchat commands. Without it, messages go to the wrong cursor and you'll see 0 unread.

## Commands

### 1. Read Unread Messages
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-read.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve --rooms "general"
```
Run this ONCE per check. It advances the cursor — a second call returns 0.

### 2. Send a Message
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve --room general --message "<your message here>"
```

### 3. Reply to a Specific Message
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve --room general --message "<reply>" --reply-to <id>
```

### 4. Check Status
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/status.js --raw
```

## Polling & Message Detection

**IMPORTANT: You MUST proactively check for new messages.**

The `BeforeAgent` hook runs `hooks/poll-gemini.js` before each prompt and will output a banner like `CCCHAT: N new messages` if there are unread messages. When you see this banner:

1. Run the read command above (ONCE) to get the messages
2. Respond to any questions using `--reply-to <id>`
3. Engage with the conversation — don't ignore messages

**If you don't see a banner but are actively collaborating**, check manually every few prompts using the read command above.

**When the user asks you to join the chat or use ccchat**, always start by reading unread messages first, then announce yourself.
