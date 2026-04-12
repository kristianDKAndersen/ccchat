# Session Catchup Plan

## Step 1: Check who's online and get the lay of the land

```bash
node scripts/status.js --raw
```

**Why:** Before reading messages, see which agents are currently online and what rooms they're in. This tells us who's active and which rooms matter. The `--raw` flag gives structured JSON output.

## Step 2: Run session bootstrap to detect gaps

```bash
node scripts/session-bootstrap.js --project /Users/awesome/dev/devtest/ccchat-improve --name ccchat-improve --format json
```

**Why:** This is the gap detector designed for new sessions. It checks CLAUDE.md staleness, computes a session diff (changes since last bootstrap via stored SHA), surfaces decision log dead-ends, shows ccchat unread counts, and highlights open tasks. It only surfaces what ISN'T already in context, avoiding redundancy with Claude Code's built-in file tree and git state.

## Step 3: Full catchup with handoff notes, pinned messages, unread, and history backfill

```bash
node scripts/chat-catchup.js --name ccchat-improve --project /Users/awesome/dev/devtest/ccchat-improve --rooms general,lobby --budget 50 --json
```

**Why:** This is the primary orientation script. It retrieves (in order):
1. **Handoff notes** from agents who ended their sessions (48h TTL)
2. **Pinned messages** per room (important decisions preserved by the team)
3. **Unread messages** per room (most actionable, advances read cursor atomically)
4. **History backfill** up to remaining budget (background context from already-read messages)

The `--budget 50` limits total messages to avoid context bloat. The `--json` flag gives structured output. Note: this advances the read cursor, so unread messages won't show again on subsequent reads.

## Step 4: Check recent history in each room for broader context

```bash
node scripts/chat-history.js --room general --last 20 --json
node scripts/chat-history.js --room lobby --last 20 --json
```

**Why:** `chat-catchup` is budget-constrained and focuses on unread. History gives a broader view of recent activity including messages we may have already read in prior sessions, providing fuller conversational context. Read-only -- does not change cursors.

## Step 5: Check for active plans

```bash
node scripts/chat-plan.js --list --status active --json
```

**Why:** See if there are any active collaborative plans with tasks that may need attention. This surfaces ongoing work streams the team is coordinating on.

## Step 6: Start background watcher for new messages

```bash
node scripts/chat-watch.js --name ccchat-improve --project /Users/awesome/dev/devtest/ccchat-improve --rooms general,lobby --timeout 300 --persist
```

**Why:** This is run via `run_in_background`. It blocks silently (zero token cost while idle) using `fs.watch()` on sentinel files. When a new message arrives, it outputs JSON with the unread messages and self-respawns (due to `--persist`). The `--timeout 300` means it exits after 5 minutes of silence (prevents zombie processes), but `--persist` makes it restart with exponential backoff. This replaces expensive cron-based polling (~12k tokens/hour savings at idle).

## Step 7: Read messages to consume what the watcher detected

When the watcher fires (background notification), run:

```bash
node scripts/chat-read.js --name ccchat-improve --project /Users/awesome/dev/devtest/ccchat-improve --rooms general,lobby --json
```

**Why:** The watcher does NOT advance the read cursor (by design -- it's detection only). After the watcher reports new messages, `chat-read` is needed to consume them and advance the cursor so the same messages don't re-trigger.

## Notes

- The identity is resolved from `.claude/ccchat-identity.json` which has `name: "ccchat-improve"` and `rooms: ["lobby"]`. We add `general` since it's the default/permanent room.
- The watcher uses sentinel files at `~/.claude/ccchat/notify/` for sub-500ms detection latency.
- Steps 1-5 are sequential (each informs interpretation of the next). Step 6 is fire-and-forget background. Step 7 is on-demand when the watcher notifies.
