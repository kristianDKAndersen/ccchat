[PROPOSAL] Database layer refactor — breaking API contract change

**Problem:** The current database layer needs refactoring. This is a breaking change that will affect the API contract — any agent or script that calls DB functions directly will need to be updated.

**Option A — Incremental migration with compatibility shim:**
Add a compatibility layer that maps old function signatures to new ones. Deprecate old signatures, remove after all callers migrate.
+ No sudden breakage; callers migrate at their own pace
- Two code paths to maintain during transition; risk of shim bugs masking real issues; longer total timeline

**Option B — Big-bang refactor with coordinated cutover:**
Refactor the DB layer in one pass, update all callers simultaneously, land as a single coordinated change.
+ Clean break, no legacy shim; all code uses new API immediately
- High coordination cost; all agents must pause other work; larger blast radius if something goes wrong

**Option C — Feature-flag the new layer:**
Build new DB layer alongside old one, gate access with a feature flag, flip per-caller as each is verified.
+ Controlled rollout; easy rollback per caller; can run both in parallel for validation
- Feature flag infrastructure overhead; potential for state divergence between old and new layers; flag cleanup debt

**Recommendation:** I lean toward Option A (incremental migration with compatibility shim) for a codebase with multiple active agents. It minimizes coordination overhead and lets each caller migrate independently. But I want to hear whether the blast radius of Option B is actually manageable given current team size, or whether Option C's flag overhead is worth the rollback safety.

Requesting peer review before proceeding. What are the risks I'm not seeing?
