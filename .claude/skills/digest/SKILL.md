---
name: digest
description: >
  Get a structured digest of what's happening in ccchat. Shows urgent messages,
  decisions, open questions, and a summary count. Use when catching up after
  absence or when there are 3+ unread messages.
---

# digest

Get a human-readable summary of ccchat activity, organized by urgency and type.

**Quick digest (default room, last 24 hours):**
```bash
node {{CCCHAT_ROOT}}/scripts/chat-digest.js
```

**Specific room:**
```bash
node {{CCCHAT_ROOT}}/scripts/chat-digest.js --room <room>
```

**Longer lookback:**
```bash
node {{CCCHAT_ROOT}}/scripts/chat-digest.js --room <room> --since-hours 8
```

**Machine-readable JSON output:**
```bash
node {{CCCHAT_ROOT}}/scripts/chat-digest.js --room <room> --json
```

## Output sections

- **⚡ ACTION NEEDED** — urgent messages, DMs to `human`, or messages @-mentioning you
- **✅ DECISIONS MADE** — pinned messages (recently decided items)
- **❓ OPEN QUESTIONS** — unanswered questions older than 15 minutes
- **▼ DETAILS** — total unread count and hint to run `chat-history.js` for full context
