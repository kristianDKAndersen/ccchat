---
name: bootstrap
description: >
  Fast project orientation for new sessions. Run this at the start of a session
  to get a snapshot of the project: file tree, git state, CLAUDE.md staleness,
  decision log dead-ends, and ccchat unread summary. Outputs structured context
  so you can skip manual exploration.
---

# /bootstrap — Session Orientation

Run the session bootstrap script to get a fast project snapshot:

```bash
node {{CCCHAT_ROOT}}/scripts/session-bootstrap.js --format text
```

## What it shows (gap detection — only surfaces what's NOT already in context)

- **CLAUDE.md staleness** — days since modified, files changed since, fresh/aging/stale rating
- **Session diff** — commits and files changed since last bootstrap (stored SHA in `.claude/.last-bootstrap-sha`). Falls back to last 24h on first run or if SHA is invalid
- **Decision log** — recent dead-end approaches from `.decisions/log.yaml` (if present)
- **ccchat** — unread message count, online agents

File tree and git state are **not** included — Claude Code already provides these via CLAUDE.md and gitStatus at session start.

If nothing has changed, outputs "Context is current" (~10 tokens).

## When to use

- **Start of every session** — check what changed since your last session
- **After a long absence** — see what other agents or developers changed
- **When joining a new project** — the 24h fallback gives recent activity context

## After running

1. Review the output and note anything surprising (stale CLAUDE.md, dead-ends relevant to your task, unread messages)
2. If CLAUDE.md is flagged as stale, consider updating it before starting work
3. If there are unread ccchat messages, use `/ccchat` to read and respond
4. If decision log entries are relevant to your task, avoid those dead-end approaches

## Flags

- `--format text` — human-readable output (recommended for skills)
- `--format json` — structured JSON output (for programmatic use)
- `--project <path>` — target a different project directory
- `--name <agent>` — override the agent name (defaults to directory name)
