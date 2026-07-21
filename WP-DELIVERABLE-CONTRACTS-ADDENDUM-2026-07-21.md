# WP-DELIVERABLE-CONTRACTS — addendum to WP-WING-PRODUCTION: quality as substrate

**Date:** 2026-07-21 · **Status:** addendum for Ross's ratification · **Extends:**
WP-WING-PRODUCTION-BRIEF-2026-07-17 (§P2 deliverable brief, §P4 reviewer, §6 grading,
§7 phases) · **Origin:** Ross's ruling today, on receiving the async-built August
CR2 Demo Alignment deck (plain, unbranded, structurally thin) versus his own
desktop rebuild (Olympus-branded, sectioned, decision-focused): *"We need to make
this much more consistent and high quality not just in slides, but across all
work items."*

**Founding incident:** the CR2 deck was one of the WP-WING-PRODUCTION founding-
fixture class. The wing ran without Phase 0/1 built and produced exactly what §1's
audit predicted ("docs, NOT presentable decks"; "a single mind's first draft").
The desktop rebuild was good because everything that made it good — brand tokens,
structure, the quality bar, Ross's judgment — lived in the interactive session.
None of it was substrate the wing could reach. That is the disease; this addendum
is the cure's shape.

---

## A1. PRINCIPLE — quality as substrate, one contract per work-item type

A deliverable's quality bar must not live in whichever session happens to build
it. Per work-item TYPE (deck, pre-read, one-pager, client email, report,
status-update — closed enum, extended by ratification) there is ONE versioned
**deliverable contract** in the corpus. Every producing lane — the wing's
deliverable passes AND interactive/desktop sessions — reads the SAME contract.
Identity of inputs is the consistency mechanism, exactly as
mockups-are-pixel-contracts is for UI: the contract names the exemplar as the
pixel-grade bar and carries the distilled tokens INLINE (a pointer alone is not
a contract).

## A2. THE CONTRACT OBJECT

Stored as corpus documents `CONTRACT-DELIVERABLE-<type>` (the FRAME-CHARTER
pattern: substrate, versioned, indexed, mints NO records — the charter doc-class
precedent), served through the existing production-guide machinery
(get_production_guide becomes contract-aware; the §P1 line "production guides
become the brief the skill executes against" gets its concrete form). Fields:

- `type`, `version`, `ratifiedBy/At` (draft until Ross ratifies; his edits
  REPLACE, never merge silently — charter semantics).
- `audience` + `register` (who reads it, in what voice).
- `sections[]` — required structure, ordered, each with a one-line purpose.
- `brandTokens` — distilled INLINE: palette, wordmark rules, typography,
  spacing grammar (for Olympus-branded artifacts: distilled from the brand
  guidelines, not a pointer to them).
- `densityBounds` — e.g. max bullets/slide, max words/slide, min white space;
  the anti-wall-of-text law made checkable.
- `qualityBar` — prose the reviewer judges against ("non-skeleton" is a field,
  per §P2; this extends it with type-specific teeth).
- `exemplarDocId` — the GOLDEN EXEMPLAR: a real, Ross-accepted artifact of this
  type living in the corpus. The contract is drafted FROM it (extractive), and
  conformance is judged AGAINST it.
- `checklist[]` — CLOSED list of mechanical predicates (sections present, token
  conformance where deterministically checkable, density bounds, provenance
  note present). Machine-gradeable; the reviewer's first gate.

## A3. FOUNDING EXEMPLARS

1. **Deck:** today's desktop-rebuilt August CR2 Demo Alignment deck is ingested
   as the founding deck exemplar; the deck contract is drafted from it and Ross
   ratifies (his shaping = the top-rung HITL, charter pattern).
2. **Pre-read:** the MDA pre-read class (the other founding fixture) seeds the
   second contract once a Ross-accepted instance exists.

New types earn contracts the same way: first Ross-accepted artifact of the type
becomes the exemplar; a contract is drafted from it; Ross ratifies.

## A4. REVIEWER MECHANICS (extends §P4)

The review pass gains teeth, in order:
1. **Mechanical gate first** — the contract's checklist, deterministic, no LLM:
   a failing artifact CANNOT stage as done. It stages FLAGGED with the failing
   predicates named (fail-closed-but-VISIBLE; never silent-ship, never silent-
   drop).
2. **Judgment second** — the adversarial review contract (§P4) now judges
   against the exemplar, not against taste: "where does this fall short of
   `exemplarDocId`, section by section?"
3. **Exemplar-diff receipt** — every staged artifact carries a side-by-side
   conformance note (sections vs contract, deviations named). This generalizes
   the mock-vs-build diff Ross already requires in UI PRs, and it is what his
   accept/revise/reject teaches against.

Grade axes (extends §6, all mechanical): `contract-conformant` (checklist
passed), `exemplar-diffed` (receipt present). Quality itself stays human-judged;
Ross's outbox verdicts (accept / revise_outbox_artifact / dismiss) are the
calibration stream for tightening checklists over time — measured, not assumed.

## A5. BOTH LANES, ONE BAR

- **Wing:** deliverable passes load the contract by type at build time; the §P1
  document skills execute against it (the contract IS the brief the skill
  renders).
- **Interactive:** desktop/Cowork sessions pull the same contract via the
  production-guide surface before building any work item of a contracted type.
  A session that improves on the exemplar proposes a contract version bump
  (Ross ratifies) — improvement flows INTO substrate instead of staying in one
  session's output.

## A6. DIVISION + CO-SHIPS

- **WF/coordinator lane:** contract doc-class + store + drafting-from-exemplar
  composer, checklist evaluation operator, exemplar-diff receipt, grade-axis
  data fields, retro conformance sweep over existing outbox artifacts (dry-run
  table first).
- **Voice/enhancements lane:** runner wiring (§7 Phase 0/1 — skills, review
  pass, worker process call), pass charges, register lines, obligations —
  which enter the REGISTRY, never prose (coherence rule; e.g. a single
  `build-to-contract` obligation for deliverable passes, appliesTo declared).
  *Voice-lane precision (their contest-window ack, folded 2026-07-21, binding):*
  "pass charges" means MISSION references only — the build-to-contract
  obligation rides `compilePassObligations` via the registry, and NO ordering
  or compliance prose enters `cfg.system` (anti-resedimentation posture;
  charges stay obligation-free — their #558 lesson). Registry entries name
  their grade probes per the coherence law.
- Flags: `DELIVERABLE_CONTRACTS_ENABLED` (contract serving + checklist gate),
  enrolled in pilot-full same-PR (drift gate). Spend/enables stay under the
  release-and-pilot gate.

## A7. ACCEPTANCE

- **The fixture is the founding incident itself:** re-run the August CR2 deck
  request through the upgraded wing. Accepted when it comes back conformant to
  the ratified deck contract — Olympus-branded, sectioned, decision-focused —
  WITHOUT a human rebuilding it, carrying its exemplar-diff receipt and a
  passing checklist.
- Ross pixel-gates the two founding exemplars + their drafted contracts.
- Measured trend: outbox artifact accept-rate vs revise/reject, by type, from
  the grades stream (the wing-production §6 axes + the two new ones).

## A8. GOVERNANCE

WP-WING-PRODUCTION §8 governs unchanged. This addendum adds no autonomy: the
contract changes WHAT the drafting lanes must conform to, never WHO ratifies.
House laws bind: fail-closed-but-visible, plain product language in everything
user-facing, glass tokens for Threshold-rendered surfaces, Dismiss/Snooze verb
canon. The coherence architecture governs all teaching-layer additions.
