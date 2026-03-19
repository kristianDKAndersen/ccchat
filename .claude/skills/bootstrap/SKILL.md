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

## What it shows

- **File tree** — top-level + depth 2, common noise filtered out
- **Git state** — branch, dirty files, recent commits, local branches
- **CLAUDE.md staleness** — days since modified, files changed since, fresh/aging/stale rating
- **Decision log** — recent dead-end approaches from `.decisions/log.yaml` (if present)
- **ccchat** — unread message count, online agents

## When to use

- **Start of every session** — get oriented before doing anything else
- **After switching branches** — re-check git state and dirty files
- **When joining a new project** — understand the codebase structure quickly

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
