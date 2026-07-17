# WP-WING-PRODUCTION — full-capability async work: tools, plans, and crews

**Date:** 2026-07-17 · **Status:** brief for Ross's ratification · **Origin:** Ross's
ruling, this afternoon: *"when these agents are working async, they should have
enough instructions and enough tools to produce high-quality outputs that leverage
all the field, the operators, and what the current LLM provider provides — their
own skills and integrations. They should also be making plans themselves and, if
needed, working together as a group."*

**Founding fixtures (live, due Monday 07-20):** the two weekend deliverables the
midday call routed to the wing — the full MDA pre-read + deck summary, and the
Keith Griffiths Sora/Catalyst prep ("don't give me a skeleton — I want to know
exactly what's in there"). Whatever this WP builds is accepted when THAT class of
deliverable comes out of the wing at reviewable quality without a human building it.

---

## 1. THE AUDIT — what the wing is today

The async surface is the scheduled runner (prework / delta / closure / postclose /
groomer): a single Claude conversation loop per pass, a 25-tool MCP whitelist, a
compiled system prompt (map + charge + pass obligations), prompt-cached, in-process
on the 1-vCPU engine droplet. It stages, proposes, and drafts into the outbox.

What it demonstrably CAN do (this week's evidence): work the plan, traverse the
field with the operators, stage honest skeletons with named gaps, respect the
gates, file closures. What it demonstrably CANNOT do:

| Gap | Evidence |
|---|---|
| **No provider tools** — no web search, no code execution, no file rendering | The Olympus deck + tonight-quality slides were built by the coordinator BECAUSE "the wing lacks web+deck tooling — a gap it named honestly." WP-DECK-QUALITY has been queued since. |
| **No provider skills** — the docx/pptx/xlsx/pdf skills that produce real Office artifacts | The renderer v1 makes "docs, NOT presentable decks" (Ross's night-cap ruling after the bullets-as-slide incident) |
| **No external integrations** — the wing sees the field only; no MCP connectors beyond our own engine | A "current status of Maze UXR" section can only echo what the field holds |
| **Shallow planning** — one pass = one linear conversation; no decomposition, no persisted work plan per deliverable | Today's MDA pre-read: a skeleton because "the specifics weren't clean in the record" — no plan to close the gaps, no second pass |
| **No group work** — no builder/reviewer split, no verifier, no fan-out | Every deliverable is a single mind's first draft; the guide-gate checks that a guide was READ, not that the output is GOOD |
| **In-process execution** — heavy runs starve the engine event loop | The documented death-spiral class; 1 vCPU under everything |

## 2. THE FOUR PILLARS

### P1 — PROVIDER CAPABILITIES (tools, skills, integrations)
Attach what the Anthropic API already offers to the runner's calls:
- **Web search** (server-side tool): status sections stop being field-echoes;
  competitive/vendor/product facts get sourced. License ladder applies — web facts
  are SUGGESTED, cited, never substrate.
- **Code execution + skills**: the provider's document skills (docx/pptx/xlsx/pdf)
  ARE the missing render lane — this largely absorbs WP-DECK-QUALITY. The
  production guides become the brief the skill executes against, not a substitute
  for rendering.
- **External MCP connectors** (Messages API `mcp_servers`): a per-deployment,
  Ross-gated list (start empty; candidates: the Aha/Figma class the wing flagged
  as unknown capabilities). Sovereignty rule: connectors are read-only sources for
  drafting; nothing external writes to the field.
- Guardrails: all provider capabilities are UNATTENDED-LANE ONLY additions, flag-
  gated per capability, spend-capped per pass (see §5), and every web/skill use is
  receipted in the deliverable's provenance note (fail-closed-but-visible).

### P2 — FIELD + OPERATOR DEPTH (instructions)
The wing has the tools; the misses are depth-of-use. Structural fixes, not prose:
- **The deliverable brief**: a typed work order the plan item carries — audience,
  purpose, sections, the KNOWN/UNKNOWN ledger, quality bar ("non-skeleton" is now
  a field, not a hope), due, register. Compiled from the capture + task brief;
  the model fills it, the reviewer checks against it.
- **Evidence-ledger gate**: a deliverable may not stage while its UNKNOWN ledger
  has entries that the field (or P1 tools) could close — the traverse-until-two-
  dry-pulls doctrine made checkable.

### P3 — SELF-PLANNING
- Before building, the wing WRITES THE PLAN for each deliverable: sections, what
  each needs from the field/web/skills, open questions, effort estimate — persisted
  beside the companion plan item (plan-of-work, distinct from plan-of-record),
  visible in Threshold, and gradeable (did the build follow its plan?).
- Plans are cheap to re-derive and HITL-inert; Ross sees them in the Prepared-
  for-you band's peek. A vetoed plan item never builds (existing veto lane).

### P4 — GROUP WORK
- **Builder/Reviewer as first-class pass kinds**: a `deliverable` pass builds from
  the work plan; a `review` pass (fresh mind, adversarial contract: "find what's
  thin, wrong, or unsupported — check every claim against the field") gates
  staging. Review verdicts are graded artifacts. This reuses ALL existing pass
  plumbing (whitelists, transcripts, grades, single-flight) — no new framework.
- **Fan-out where decomposition is real**: a deliverable brief with independent
  sections may spawn parallel section-builds joined by the builder. Cap: N≤3
  concurrent, spend-capped, and NEVER in-process with the engine (see §4).
- The coordinator patterns (adversarial verify, judge, completeness critic) are
  the design vocabulary — applied selectively, not cargo-culted: a weekly report
  needs a reviewer; it does not need a tournament.

## 3. WHAT THIS IS NOT
- Not autonomy expansion: every output still lands in the gated lanes (outbox/
  staging/proposals). Group work changes WHO drafts, never WHO ratifies.
- Not a new teaching surface: instructions ride the existing layers (deliverable
  briefs are L2 data; the review contract is a pass charge; obligations go in the
  registry). The coherence architecture governs this WP.
- Not an in-engine agent framework: orchestration stays deterministic and thin.

## 4. ARCHITECTURE DECISION (the one big call for Ross)
Two viable shapes for P4/P1 execution:
- **(A) Extend the runner in-place**: add provider tools to messages.create, add
  the two pass kinds, single-flight orchestration in the scheduler. Cheapest,
  fastest; keeps the 1-vCPU in-process risk (mitigated by pass serialization) and
  hand-rolls container/skill wiring.
- **(B) A worker process on the droplet** (recommended): the deliverable/review
  passes run in a separate PM2 process (same codebase, own entry) consuming a
  work queue the postclose writes. Engine event loop protected by construction
  (the death-spiral class ends); provider skills/containers isolated; fan-out
  can't starve /mcp/v2. Cost: a queue table + a second process to operate.
  Pairs naturally with the droplet resize decision (2 vCPU makes B comfortable).

## 5. COST + GATING
- Per-pass token/spend budget in config (existing llm-usage telemetry enforces
  visibility; hard cap aborts to an honest partial + staged note).
- Web/skill/connector use: per-capability flags, pilot-full enrolled, OFF for any
  pilot-facing deployment until Ross's named go (release-and-pilot gate applies).
- Fan-out multiplies spend — the deliverable brief carries a size class (S/M/L)
  that sets the crew: S = builder only; M = builder+reviewer; L = fan-out+review.

## 6. GRADING (L4 from day one)
New axes: plan-written (deliverable had a work plan before build — mechanical),
review-passed (a review pass verdicted before staging — mechanical),
evidence-ledger-closed (UNKNOWNs at staging = named in the artifact — mechanical),
provenance-receipted (web/skill uses receipted — mechanical). Quality itself stays
human-judged (Ross's review of the Monday fixtures IS the acceptance).

## 7. PHASES
- **Phase 0 (this weekend, if ratified today):** web search + the document skills
  attached to the postclose/prework deliverable path, flag-gated; the deliverable
  brief in its minimal form (sections + quality bar + KNOWN/UNKNOWN); a single
  review pass gating the two Monday fixtures. Architecture A (in-place) for
  speed, serialized. Acceptance: Monday's two artifacts are non-skeleton,
  reviewed, provenance-receipted.
- **Phase 1:** the worker process (architecture B), plan-of-work persistence +
  Threshold visibility, the grade axes.
- **Phase 2:** fan-out for L-class deliverables; external connector list (Ross-
  gated, per-deployment); WP-DECK-QUALITY formally absorbed (skills become the
  render lane; renderer v1 = fallback).
- **Phase 3:** group patterns maturing against grade evidence (reviewer
  calibration, judge-on-disagreement), auto-scaling crew by size class.

## 8. GOVERNANCE
Co-ship boundaries: pass kinds + whitelists ride the existing registry/drift-gate
discipline; anything touching the WF lane's operators or doctrine co-ships as
usual; scheduled-spend changes and pilot-facing enables are Ross-named-go items.
The coherence rule stands: new obligations enter the registry, never prose.
