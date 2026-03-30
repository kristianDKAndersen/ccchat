# ADR Logger — Spec v1

**Owner:** Nicola (spec), Emilio (build + ship)  
**Target:** Shipped by Friday  
**Status:** Ready to build

---

## Problem

Decisions made in a session are buried in chat history. Future sessions re-litigate closed decisions because there's no durable record of what was decided, why, or what alternatives were explicitly ruled out. The `[DECISION]` tag pattern is already in use — it's proven and costs nothing to extend.

---

## What It Does

Watches the ccchat message stream for `[DECISION]` tags. When detected, auto-writes a structured record to a per-project ADR file. No manual invocation. No extra steps beyond the `[DECISION]` tag agents are already writing.

---

## Trigger

- **Event:** Any message containing `[DECISION]` in the message body
- **Fires:** Automatically, on message send (or on read, via a ccchat hook)
- **No manual invocation required**

Implementation options:
1. **Hook on `chat-send.js`** — intercept outbound messages, detect tag, write record before send completes
2. **Post-send hook** — watch for `[DECISION]` in `chat-watch.js` output, write record asynchronously

Recommendation: option 2 (post-send). Lower coupling, no risk of blocking message delivery if the write fails.

---

## Output

### File location
```
<project-directory>/docs/decisions.md
```

- One file per project
- Append-only — never overwrite existing entries
- Plain text, readable without ccchat
- Structured enough to parse programmatically (YAML frontmatter per entry)
- DB may index it additively; file is the source of truth

### Entry format

```markdown
---
id: ADR-{n}
date: {ISO timestamp}
session_id: {ccchat session or message ID}
author: {agent name}
---

## Decision

{The [DECISION] message text, stripped of the [DECISION] tag prefix}

## Rejected Alternatives

- {at least one entry required}

## Rationale

{optional — populated inline by the author after auto-write if desired}

---
```

---

## Field Rules

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | Auto-incremented (ADR-1, ADR-2, ...) |
| `date` | Yes | Auto-populated from message timestamp |
| `session_id` | Yes | Message ID from ccchat |
| `author` | Yes | Agent name from message sender |
| Decision text | Yes | Extracted from message body |
| `rejected_alternatives` | **Yes** | Minimum one entry. If blank, the record is invalid. |
| `rationale` | No | Optional, prompted but not enforced |

**Enforcement on `rejected_alternatives`:** The logger should warn (in chat or stderr) if this field is empty after auto-write. It cannot force authors to fill it at write time, but it can flag the gap. A record with a blank `rejected_alternatives` is a first-class failure mode — this is what the success criterion checks.

---

## Success Criteria

Both must pass for v1 to be considered done:

1. **Continuity:** A new session can reconstruct the last 3 key decisions without reading chat history — by reading `decisions.md` alone.
2. **Field population:** At least one `rejected_alternatives` entry is populated per decision — not blank. A log full of empty entries means the spec failed at its most important point.

---

## What This Is Not

- Not a search tool (that's ccchat v2 — semantic search over decisions)
- Not a conflict resolver (doesn't detect when a new decision contradicts an old one)
- Not agent-specific — any agent writing `[DECISION]` gets their decision logged

---

## Skill Extraction Notes

Design for extractability, not premature extraction. Internal components:

- `detect_decision(message)` — returns decision text if `[DECISION]` tag found, null otherwise
- `write_adr(decision_text, metadata, project_path)` — formats and appends to decisions.md
- `next_adr_id(project_path)` — reads existing file to determine next ID

These can be extracted as shared skills if reuse appears. Don't extract upfront. Ship the working tool first.

---

## Out of Scope for v1

- DB indexing (additive later)
- Semantic search over decisions
- Contradiction detection
- Retroactive logging of past `[DECISION]` tags in chat history (v1.1 candidate)

---

*Spec written by Nicola, 2026-03-30*
