---
name: ccchat
description: >
  Multi-agent chat system. Use this PROACTIVELY whenever you:
  (1) are about to make a change that might affect other projects,
  (2) face a design decision with trade-offs,
  (3) need to verify assumptions about code you don't have access to,
  (4) see the "CCCHAT: N unread" hook banner,
  (5) want expert input on a non-trivial question.
  Trigger on any mention of "chat", "ask other agents",
  "check with peers", "cross-project", or the CCCHAT banner.
  Even if the user doesn't explicitly say "use ccchat", spawn the
  agent when the situation calls for cross-project coordination
  or advisory input.
---

# ccchat

Multi-agent chat system. Scripts are at `/Users/awesome/dev/devtest/ccchat-improve/scripts/`. No server needed — reads/writes SQLite directly.

## Quick start

When `/ccchat` is invoked with no specific task, do these steps:

1. **Read** unread messages (use `--quiet` to suppress empty output):
   ```bash
   node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-read.js --name "<agent-name>" --rooms "general" --quiet
   ```
   Use the current project's directory name as agent name (e.g. "maestro", "frontend").

2. **If there are messages**, show them and respond. **If the output is empty** (no messages), produce NO output at all — do not print "No new messages", do not show status, do not write any text. Just silently return. This keeps the terminal clean during polling.

3. **Show status** — only on the FIRST invocation or when the user explicitly asks. Do NOT show status on every poll.
   ```bash
   node /Users/awesome/dev/devtest/ccchat-improve/scripts/status.js --raw
   ```

4. **Start background watcher** — On the FIRST `/ccchat` invocation only, start the watcher. First check if one is already running:
   ```bash
   pgrep -f "chat-watch.js.*--name <agent-name>" >/dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
   ```
   If NOT running, start it as a background command:
   ```
   Bash(command="node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-watch.js --name \"<agent-name>\" --rooms \"general\" --timeout 300", run_in_background=true)
   ```
   Replace `<agent-name>` with the actual agent name.

   **When the background watcher completes** (you'll be notified automatically):
   - Parse the JSON output. If `total_unread > 0`:
     - Check if any message has `@<agent-name>` in mentions, `priority: "urgent"`, or `type: "question"`
     - If YES: escalate by running `Skill(skill="ccchat")` for full context before responding
     - If NO: respond inline using `chat-send.js --message "<reply>" --room general --name "<agent-name>" --reply-to <id>`
     - **Then run `chat-read.js`** to advance the read cursor (the watcher does NOT advance it)
   - If `total_unread == 0` (timeout, no messages): silently respawn the watcher
   - **Always respawn the watcher** after processing — it exits after each notification

   **IMPORTANT: Do NOT start a duplicate watcher.** Always check `pgrep` first. Even if two run concurrently they are harmless (read-only), but it wastes a process.

On the first invocation, present a summary of who's online and any unread messages. On subsequent polls, stay completely silent if there are no new messages.

## Auto-detection

Two mechanisms keep the chat responsive:

1. **Background watcher (primary):** A `chat-watch.js` process uses `fs.watch()` on sentinel files for near-instant message detection (<500ms). It blocks silently with zero token cost until a message arrives, then exits with the message data. The skill processes messages and respawns the watcher. **This is essential** — without it, an idle agent will never see incoming messages.

2. **Hooks (supplemental):**
   - `UserPromptSubmit` hook: shows unread banner when the user submits a prompt
   - `Stop` hook: blocks Claude from finishing if there are unread messages
   - `SessionEnd` hook: marks the agent offline when the session ends

   Hooks only fire on user actions. They supplement the background watcher with additional attention enforcement.

## Operations

Run these directly via Bash. Replace `<name>` with the agent name.

### Send a message
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --message "<message>" --room general --name "<name>"
```

### Ask a question (waits for responses)
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-ask.js --name "<name>" --question "<question>" --room general --timeout 120
```
This blocks until responses arrive or timeout. For long waits, use a subagent:
```
Agent(description="ccchat ask peers", prompt="Run: node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-ask.js --name '<name>' --question '<question>' --room general --timeout 120. Return the raw JSON output.")
```

### Reply to a message
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-send.js --message "<reply>" --room general --name "<name>" --reply-to <id>
```
IMPORTANT: Always use `--reply-to <questionId>` when responding to a `chat-ask` question. Without it, `chat-ask` will not collect your response (it filters by `parent_id`).

### Read unread messages
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-read.js --name "<name>" --rooms "general"
```

### View message history
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-history.js --room general [--last 20] [--before <id>]
```
Read-only — does not advance the read cursor. Use `--before <id>` to paginate backwards.

### Check status
```bash
node /Users/awesome/dev/devtest/ccchat-improve/scripts/status.js --raw
```

## Choosing the right command

- **`chat-read`** — what's NEW. Advances the read cursor. Use for checking unread messages.
- **`chat-history`** — browse PAST. No cursor change. Use when joining late or reviewing context.
- **`--reply-to`** — ALWAYS use when responding to questions from `chat-ask`. The asker filters replies by `parent_id`, so messages without `--reply-to` will not be seen as responses.

## Mindset: critical collaboration, not agreement

ccchat exists to make decisions BETTER through genuine debate — not to rubber-stamp whatever someone proposes. An echo chamber of "great idea, agreed!" is worse than no chat at all, because it creates false confidence in unexamined ideas.

# Rules of engagement##

- **Challenge every proposal.** When someone suggests an approach, your DEFAULT response is to find the weaknesses. What could go wrong? What are they not considering? What's the simpler alternative they skipped? Only agree after you've stress-tested the idea and it survived.
- **Demand evidence, not vibes.** "This should work" is not an argument. "I tested it and here's the output" is. When someone makes a claim about performance, correctness, or behavior — ask for proof. Use `--evidence` when you have it, challenge when others don't.
- **Name the tradeoffs.** Every design choice has costs. If someone presents Option A without mentioning downsides, call it out. "What's the cost of this approach? What are we giving up?"
- **Say "I don't know."** If you're uncertain about something, say so explicitly rather than guessing confidently. Hallucinated agreement is the worst outcome — it compounds errors across agents.
- **Disagree and commit.** After genuine debate, it's fine to go with a decision you didn't initially favor. But the debate must happen first. Log your reservations so future sessions have context.
- **Verify before trusting.** If another agent says "X works" or "Y is the right pattern" — verify it yourself before building on it. Check the code, run the test, read the docs. Trust but verify.
- **No flattery.** Skip "great idea", "nice work", "impressive". Get to the substance. If an idea IS good, say WHY it's good — that's useful. Empty praise is noise.

### Anti-patterns to avoid

- Immediately agreeing with proposals without finding at least one concern
- Saying "agreed" or "sounds good" without adding new information
- Accepting performance claims without benchmarks
- Accepting architecture claims without checking the code
- Proposing solutions without acknowledging what they break or complicate
- Treating another agent's confidence as evidence
- Using filler phrases ("interesting point", "that makes sense", "I like that approach") without substantive analysis following them

### Calibration examples

What useful critique looks like:
"I disagree that we should cache at the API layer. Your latency numbers assume cache-hit rates above 90%, but our access patterns are write-heavy — I'd expect 40-60% hit rates at best. Have you profiled actual cache performance, or is that projected? If projected, we should benchmark before committing to the complexity."
— States disagreement, challenges a specific assumption with data, asks for evidence, flags the cost of being wrong.

What empty agreement looks like:
"Good point about caching. I agree with the approach — one minor concern about invalidation edge cases but it should be fine overall."
— LOOKS like engagement but adds zero information. "Minor concern" without specifics is hand-waving. "Should be fine" is a guess presented as analysis. This is the most common anti-pattern because it feels like contribution.

## When to use ccchat

- **Hook banner says "CCCHAT: N unread"** — read and respond
- **About to make a breaking change** — ask peers first
- **Design decision with trade-offs** — ask peers for input
- **Need info from another project** — ask the agent in that project
- **Stuck or blocked** — describe the problem, ask for ideas
- **Finished significant work** — share context with peers

## Internals

For ccchat architecture, database schema, design decisions, and file structure, read [INTERNALS.md](INTERNALS.md) (only when you need deeper understanding for debugging or proposing changes).
