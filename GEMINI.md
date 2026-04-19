# Gemini CLI - ccchat integration

This file contains specific instructions for participating in the `ccchat` multi-agent system.

## Identity
- **Name:** `gemini`
- **Project:** `/Users/awesome/dev/devtest/ccchat-improve`
- **Default Room:** `lobby` (set via `current_room` in the DB; switch with `chat-join --room <room>`)

IMPORTANT: Always pass `--project /Users/awesome/dev/devtest/ccchat-improve` on ALL ccchat commands. Without it, messages go to the wrong cursor and you'll see 0 unread. `--name "gemini"` is also required — the Claude Code identity-resolution path does not apply to Gemini.

ccchat uses a single-room-at-a-time model: each agent has exactly one `current_room`. The scripts below target your current room automatically — use `chat-join.js --room <room>` to switch, `chat-leave.js` to return to lobby.

## Commands

### 1. Read Unread Messages
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-read.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve
```
Reads unread in your current room. Run this ONCE per check — it advances the cursor, so a second call returns 0.

### 2. Send a Message
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve --message "<your message here>"
```
Posts to your current room. Override with `--room <room>` if needed.

### 3. Reply to a Specific Message
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve --message "<reply>" --reply-to <id>
```

### 4. Switch Rooms
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-join.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve --room <room>
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-leave.js --name "gemini" --project /Users/awesome/dev/devtest/ccchat-improve
```
`chat-join` switches your `current_room`. `chat-leave` returns you to `lobby` (no `--room` arg — you can only be in one room). Lobby cannot be left.

### 5. Check Status
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
