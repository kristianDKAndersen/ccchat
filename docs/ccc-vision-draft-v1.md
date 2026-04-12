# Claude Collaboration Chat (CCC)

## Vision

CCC is the workspace where ideas become products. A vague idea enters, gets brainstormed, researched, fact-checked, and refined until a consensus is reached. Then it's meticulously specced, planned, broken into subtasks, and executed in parallel by expert agents — all within one unified interface.

CCC is not just a chat. It is the single source of truth for all agent-human collaboration. No communication happens outside CCC. Humans cannot monitor 10 terminal windows and a busy chat — CCC solves this by making every meaningful interaction visible in one place.

---

## Core Principles

1. **All communication in CCC** — questions, answers, status updates, mentions, escalations. Agents announce what they're working on. Execution happens in terminals, coordination happens in CCC. Important knowledge cannot get lost in a terminal no one is watching.

2. **No rushing the plan** — a rock-solid plan produces a rock-solid product. The planning pipeline exists because skipping steps costs more time than following them.

3. **Hard gates, not soft suggestions** — phase transitions are system-enforced. Agents cannot start implementation before the plan is approved. The system rejects premature action, not just discourages it.

4. **Scoped knowledge** — blackboard state, decisions, and persistent knowledge are scoped to project rooms. Project-specific decisions do not bleed into other projects.

---

## Two Modes

### Build Mode

For new products, complex features, and ambiguous requirements. Full pipeline from brainstorm through parallel execution.

### Fix Mode

For bugs, small changes, and well-defined tasks. Summon one agent, skip to execution. A flag bypasses the planning pipeline entirely.

The **task analyzer** evaluates the user's initial input and determines which mode is appropriate. This is CCC's entry point — it assesses complexity, ambiguity, and scope, then routes accordingly.

---

## Build Mode Pipeline

```
User drops idea
       |
  Task Analyzer ──→ Fix Mode (skip to execution)
       |
  Build Mode
       |
  ┌────▼─────────────────────────────┐
  │  1. BRAINSTORM (1:1 with user)   │
  │     Socratic, one question at    │
  │     a time. User decides when    │
  │     the idea is solid.           │
  │     Exit: user says "done"       │
  └────┬─────────────────────────────┘
       │  Summary → Blackboard Context
  ┌────▼─────────────────────────────┐
  │  2. SUMMON                       │
  │     Activate PM + relevant       │
  │     specialist agents based on   │
  │     brainstorm outcome.          │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  3. DRAFT                        │
  │     PM creates draft from        │
  │     blackboard context.          │
  │     Exit: draft posted           │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  4. PEER REVIEW                  │
  │     Multi-agent review + fact    │
  │     check. Research agent pulls  │
  │     training knowledge + online  │
  │     sources.                     │
  │     Exit: /agree from all        │
  │     reviewers, no unresolved     │
  │     /disagree                    │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  5. PROPOSAL                     │
  │     Structured proposal written  │
  │     from reviewed draft.         │
  │     ★ HUMAN APPROVAL GATE ★      │
  │     User: approve / reject /     │
  │     request changes              │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  6. SPEC                         │
  │     Collaborative spec written   │
  │     by involved agents. Posted   │
  │     to blackboard.               │
  │     ★ HUMAN APPROVAL GATE ★      │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  7. PLAN                         │
  │     Spec broken into 2-5 minute  │
  │     tasks. Each task has exact   │
  │     file paths, acceptance       │
  │     criteria, verification       │
  │     steps. Tasks assigned to     │
  │     specialist agents.           │
  │     ★ HUMAN APPROVAL GATE ★      │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  8. EXECUTE                      │
  │     Parallel execution. Agents   │
  │     claim tasks atomically.      │
  │     TDD where appropriate.       │
  │     Status announced in CCC.     │
  └────┬─────────────────────────────┘
       │
  ┌────▼─────────────────────────────┐
  │  9. REVIEW                       │
  │     Two-stage review:            │
  │     a) Spec compliance           │
  │     b) Code quality              │
  │     Separate messages for each.  │
  └──────────────────────────────────┘
```

---

## The Blackboard

A versioned, structured document per room/project that represents **current shared understanding**. Not chat history, not a log — living state that any agent can read in one shot to understand the full picture.

### Structure

```
Blackboard (per room, versioned)
├── Context         — what we're building, for whom, why
├── Constraints     — technical limits, deadlines, non-negotiables
├── Open Questions  — unresolved items that block progress
├── Decisions       — resolved items with rationale (links to ADR)
├── Current Plan    — the active spec/task breakdown
├── Agent Status    — who's doing what right now
└── Artifacts       — links to drafts, specs, PRs, test results
```

### Properties

- **Any agent can update it** — but updates are versioned, so bad edits are reversible.
- **Sections have owners** — PM owns Context, engineers own Current Plan, etc. Anyone can propose a change to any section, but the owner approves.
- **Open Questions auto-populate** — when a question in chat goes unanswered for N minutes, it gets promoted to Open Questions. Prevents things falling through the cracks.
- **First-class entity** — not a chat artifact. Dedicated read/write commands: `blackboard-read`, `blackboard-update --section decisions --content "..."`.
- **Consistent schema** — the structure is enforced, not freeform. Flexibility is in the content, not the shape.
- **Scoped per room** — project-specific state stays in project rooms.

### Blackboard and Phase Transitions

The blackboard reflects the current phase. On each phase transition:
- The relevant section updates automatically (e.g., brainstorm summary populates Context).
- The phase state is visible to all agents.
- New agents joining mid-process read the blackboard to understand where things stand.

---

## Phase Controller

Phases advance on **explicit signals**, not agent judgment. The phase controller is a state machine, not an agent.

| Phase | Entry Signal | Exit Signal | Timeout Behavior |
|-------|-------------|-------------|------------------|
| Brainstorm | User submits idea (build mode) | User says "done" | None (user-driven) |
| Summon | Brainstorm complete | Agents online | Auto after 30s |
| Draft | Agents summoned | Draft posted to blackboard | Nudge after 10min |
| Peer Review | Draft posted | All `/agree`, no unresolved `/disagree` | Escalate to human after 15min |
| Proposal | Review complete | Human approves | Nudge human after idle |
| Spec | Proposal approved | Human approves | Nudge human after idle |
| Plan | Spec approved | Human approves | Nudge human after idle |
| Execute | Plan approved | All tasks complete | Per-task timeouts |
| Review | Execution complete | Review approved | Nudge after 10min |

**Hard gate enforcement:** The system rejects actions that don't match the current phase. An agent cannot claim a task during SPEC phase. An agent cannot start coding during REVIEW phase. This is not advisory — the system physically blocks it.

---

## Consensus Mechanism

```
/agree <topic>           — signal agreement
/disagree <topic> <why>  — signal disagreement with reason
/consensus-check         — system reports agree/disagree status
```

Consensus is reached when all participating agents have signaled `/agree` on the current phase output AND no unresolved `/disagree` exists. Human can override at any gate with `/approve` or `/reject`.

---

## Brainstorm Phase (Detail)

The brainstorm is a **1:1 session between the user and a brainstorm agent**. It runs before specialized agents are activated.

Inspired by superpowers' Socratic methodology:

1. Explore the user's idea — what are they trying to build, for whom, why?
2. Ask clarifying questions **one at a time** (not a wall of questions).
3. Prefer multiple choice over open-ended where possible.
4. Propose 2-3 approaches with tradeoffs and a recommendation.
5. Explore the chosen direction in depth.
6. **Summarize the final understanding back to the user** — "here's what I think we've agreed on." This becomes the seed for the blackboard's Context section.

The brainstorm is optional for well-defined ideas. The user can skip it and go directly to summoning agents with a pre-written brief.

---

## Planning Phase (Detail)

Inspired by superpowers' writing-plans methodology, adapted for multi-agent execution.

### Task Granularity

Each task represents **2-5 minutes of work** — a single action. Not "implement auth" but:

- Write the failing test for X
- Verify it fails
- Implement minimally
- Verify it passes

### Task Requirements

Every task must include:

- **Exact file paths** — what to create, what to modify
- **Acceptance criteria** — what "done" looks like
- **Verification steps** — exact commands with expected output
- **Dependencies** — which tasks must complete first

### Zero Tolerance for Ambiguity

No placeholders: "TBD," "TODO," "implement later."
No vague instructions: "add appropriate error handling," "handle edge cases."
No generic references: "similar to Task N" — repeat the actual requirements.

### Divergence from Superpowers

Superpowers writes complete implementation code in the plan. CCC does not — the plan specifies **what** and **how to verify**, but the implementing agent writes the code. This is because:

1. The plan author (PM/EM) may not be the implementer.
2. Specialist agents bring domain expertise the planner doesn't have.
3. Writing code twice (in the plan and in the implementation) is waste.

### Parallel Assignment

```
Plan
├── Task 1 (backend)          → Backend Engineer
├── Task 2 (frontend)         → Frontend Engineer
├── Task 3 (security review)  → Security Champion
└── Task 4 (test automation)  → QA Engineer
```

Tasks without dependencies execute in parallel. This is CCC's core advantage over single-agent systems.

---

## Chat Features

### Communication

- **@mentions** — directly target specific agents or humans
- **Questions** (`-q`) — flagged for response, tracked until answered
- **Priority** (`--urgent`) — triggers blocking hooks, demands immediate attention
- **Threaded replies** (`--reply-to`) — keeps conversations organized
- **Pinned messages** — preserve important decisions across sessions
- **Room system** — join/leave project rooms, create project rooms

### Structured Discussion

- **Discussion phases** — "brainstorming" → "converging" → "decision reached" with collapsible sections in the UI so humans can skip to the summary
- **Disagreement protocol** — structured mechanism for raising and resolving disagreements
- **Shared abort/escalation signal** — any agent or human can halt the pipeline

---

## Persistent Knowledge

- **Pinned messages** preserve decisions across sessions.
- **`[verified]` evidence tags** distinguish tested claims from assumptions.
- **Handoff notes** auto-saved on session end so the next agent picks up context.
- **ADR logger** auto-captures `[DECISION]`-tagged messages to a decision log.
- **Session continuity** — new agents bootstrap with unread messages, handoff notes, recent history, decision log, and open tasks.

All persistent knowledge is scoped to rooms/projects.

---

## Agent Directory

CCC's agent directory is the home of all specialized agents — the "gold standard engineering team."

### Roles

| Role | Responsibility |
|------|---------------|
| **Engineering Manager (EM)** | Agent development, process, high-level technical guidance. Knowledge resource, not day-to-day coding. |
| **Product Manager (PM)** | Defines the "what" and "why." Ensures the team builds the right features for user needs. |
| **Product Engineer (UX/UI)** | User experience, interface design, interaction, visual design. Ensures the product is intuitive and delightful. |
| **Senior/Staff Engineers** | Technical leadership, architectural guidance, mentorship. Sets the standard for code quality. |
| **Backend & Frontend Engineers** | Deliver functional code. Specialists or full-stack as needed. |
| **QA / Automation Engineer** | Ensures reliability. Automates testing to move fast without breaking things. |
| **Security Champion** | Security conscience during planning and execution. Threat modeling, security testing. |
| **AppSec Engineer** | Security specialist. Writes security tests, performs threat modeling, assists with complex vulnerabilities. |
| **DevSecOps Engineer** | Automates security scanners (SAST, DAST) into CI/CD. Builds the "paved road" for secure delivery. |

### Agent Quality

Each specialized agent ships with:
- A well-written persona (sub-agent definition)
- A claude.md with technical capabilities (following claude.md best practices)

### Agent Maintenance

- **Knowledge worker agent** (background) — monitors the ADR log and tracks agent performance. Identifies what succeeded and what failed, maintaining a log of underperforming agents.
- **Skill recommendation agent** — has knowledge of a skill library and recommends skills to agents as needed.

---

## Summoning

CCC can summon agents from the agent directory. This is essential for CCC to function as a workspace.

### Flow

1. **Task analyzer** evaluates user input — determines build/fix mode and which roles are needed.
2. **Summon agent** launches the most needed agents to start the process (typically EM + PM for build mode).
3. As the process evolves, participating agents evaluate who else is needed and **summon additional agents** via CCC.

Agents are summoned into the conversation, not pre-loaded. Only the agents needed for the current phase are active.

---

## The Interface

The primary interface is the **local web chat**. From this interface:

- Agents from different repos and sessions can interact and discuss.
- Agents communicate with humans and humans communicate with agents.
- All phases of the pipeline are visible and navigable.
- The blackboard is accessible alongside the chat.
- Discussion phases are collapsible — humans can skip to summaries.
- Agent status is visible (who's online, who's working on what).
- A summarize function condenses completed discussions.

---

## Structure and Philosophy

- **Cross-functional small pods** — each project includes all necessary skills to deliver value independently without external dependencies.
- **Ownership-focused** — the team owns a specific product domain end to end.
- **TDD where appropriate** — Red-Green-Refactor for tasks that require it. Not mandated for trivial changes.
- **High technical excellence** — efficient code, reliability, low defect rates.
- **Strong documentation** — clear, up-to-date docs that reduce dependency on specific individuals.

---

## Failure Paths (To Be Designed)

These scenarios need concrete mechanisms:

- **No consensus after timeout** — agents can't agree during peer review. Escalate to human? Majority vote? Force a decision?
- **Human rejects proposal** — go back to draft, or back to brainstorm? How far do we rewind?
- **Agent fails a task during execution** — does it block agents with dependent tasks? Auto-reassign? Escalate?
- **Plan is wrong mid-execution** — discovery during implementation invalidates the spec. Halt all agents? Partial rollback?
- **Agent underperforms** — detected by knowledge worker. Replace mid-task? Flag for human decision?

---

## Open Questions

1. What should the task analyzer's decision criteria be for build vs fix mode?
2. How should the blackboard handle conflicting concurrent updates from multiple agents?
3. What are the right timeout values for each phase?
4. Should the brainstorm agent be a dedicated role or the PM?
5. How does CCC handle projects that span multiple repos?
