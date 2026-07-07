# WP-R-c — Tier 3 workback reasoning ("traceback + reasoning")

**Parent:** `WP-READINESS-BRIEF-2026-07-06.md` §Tier 3. Tiers 1–2 are DONE
(engine #385 `readiness.ts` + #386 `/api/outbox/heads-up`; app #83 badge + #85
draft action). This brief designs the capability Trisha actually described —
the tripwire is shipped; the reasoning is not.
**Parent law:** cascade §2 + §2b all binds (flags OFF, golden byte-equal,
event-sourced overlays, propose-only, §2.11 plain copy, fail-closed-but-visible,
§5b queue-admission quarantine). §5b has NO code mechanism yet — WP-R-c is its
first consumer and ships the minimal holding-pen (§4 below).

## §0 — The spec, from her transcript (2026-07-06 session)

Five requirements, each with a verbatim anchor:

1. **CHAIN** — "if you have something due to the client, what has to happen
   before that is you all have to review it internally." Infer precursor steps
   for a due deliverable: draft shared → internal review → revision → client
   send (plus deliverable-kind variants).
2. **DURATIONS** — "a large document... you likely need more than twenty-four
   hours to turn around... this is actually just version one internally, and
   you all are going to have version two." Step lead-times sized by kind.
3. **PROJECTION + PRESCRIPTION** — "I've noticed from all of your emails and
   texts and documents, you all are not ready to send this to the client...
   Either get on it now, at the very least follow up with everybody. Tell the
   client you're going to need a few days." Fire ~10 days out ("Wednesday,
   Monday last week... a clear ten days before"), not day-before.
4. **TRACEBACK** — her worst half-hour: "I am searching desperately for this
   June thirtieth date... I finally had to search by this guy's name." The
   commitment was Brian's, unilateral ("he didn't talk to our team first"),
   buried at the bottom of a side thread. The card must answer *who promised,
   when, where, verbatim* — zero search. Every field needed already exists on
   `DecisionRecord` (actor, owner, verbatim+verbatimVerified, documentId, date).
5. **SCOPED ABSENCE** — the root cause was evidence on a thread only she+Gabby
   saw. "No one has shared a draft" must be a bounded observation over
   connected sources ("in the mail I can see"), never omniscience. A
   confident-wrong "you'll miss this" is the QE-UAT rubber-stamp trust-killer;
   this is WHY §5b binds here.

Honesty note on tier 1: the shipped badge copy "no draft observed" is a
chain-level claim made by a detector that only knows "zero neighborhood
activity." Tier 3 is what makes that sentence true.

## §1 — Shape (house architecture, same as INFORM)

Deterministic candidates → LLM inference (forced-tool) → deterministic
validation/projection → quarantined cards. Signal-locality PASSES: the deciding
evidence (commitment text + neighborhood doc list) is entirely in the input.

**Per due-soon commitment** (tier-1's `isDueSoon` set — open, typed
`commitment`, parseable due within `READINESS_HORIZON_DAYS`; run on ALL
readiness states, since 'active' only means *some* activity, not the *right*
activity):

- **Stage A — evidence packet (pure).** `{summary, verbatim, actor, owner,
  due, date, primaryEntity, subjectEntities, sourceExcerpt (paragraph around
  the verbatim in documentId), neighborhood: docs mentioning primaryEntity in
  [record.date, now] as {docId, date, kind, title, 1-line snippet}}`. Reuses
  the `lifecycle.ts` mention index — no new scan.
- **Stage B — workback chain (LLM call 1).** Forced-tool schema:
  `{deliverableKind, steps: [{label, kind ∈ {draft-shared, internal-review,
  revision, approval, data-ready, meeting, client-send, other}, leadDays,
  rationale}], confidence}`. Deterministic post-validation: steps ordered,
  `sum(leadDays) ≤ daysBetween(record.date, due)`, `client-send` terminal —
  else INVALID, counted, discarded (fail-closed-but-visible).
- **Stage C — evidence match (LLM call 2, blind to projection).** Given chain
  + neighborhood list only: per step `{status: observed | not-observed,
  evidenceDocId?}`. Deterministic receipt check: a cited evidenceDocId MUST be
  in the provided list — fabricated citation ⇒ step downgraded to
  not-observed + counted.
- **Stage D — projection (pure, no LLM).** `latestSafeStart(step) = due −
  sum(leadDays of that step onward)`. FIRE when `now > latestSafeStart` of the
  earliest unobserved step. This derives Trisha's "~10 days out" from the
  chain instead of hard-coding an offset; tier-1 day-before tripwire remains
  the floor.
- **Stage E — card.** Three receipts-first sections (§2).

**Placement:** `server/ai/decision-log/workback.ts` = Stages A/D/E, pure, in
the no-LLM grep gate. `workback-judge.ts` = Stages B/C transport only
(mirrors `inform.ts` / `inform-judge.ts` split; §2.8 determinism law).
**Caching/persistence:** chains are stable → computed once, persisted as an
append-only overlay keyed `(recordId, promptVersion)` (sop-edits posture);
evidence match re-runs only when the neighborhood digest changes. Cost:
due-soon sets are small (≤ dozens); 2 calls/commitment, cached — batch-llm
optional, not required.
**Flag:** `WORKBACK_ENABLED`, default OFF ⇒ payload byte-equal (same
conditional-spread + golden test pattern as `test-readiness.ts`).

## §2 — The card (traceback contract)

Answers three questions, receipts before claims, §2.11 copy throughout:

1. **Who promised, when, where.** "Brian — 'I should have something to share
   by June 30th' — email, Jun 12" + open-source-doc link. Verbatim shown only
   when `verbatimVerified`. This alone deletes her search-by-Brian's-name
   half-hour.
2. **Why you're not ready.** The chain rendered as a checklist: observed steps
   with their evidence doc (linked), missing steps with the date they were
   last safely startable. Absence copy is SCOPED: "I haven't seen a draft in
   the connected mail" — never "no draft exists."
3. **What to do.** "Get on it now" framing + the two EXISTING actions side by
   side: tier-2 client heads-up draft (`/api/outbox/heads-up`) and the
   follow-up/chase-the-owner draft. Tier 3 adds NO new send machinery.

App surface: the tier-1 amber badge becomes the entry point — click → reasoning
popover (Trisha's log-card ruling: embedded popover, not a jump). Card-copy
lint (`cascadeMachineryHits`) on every string; fixture test that internals
(readiness/precursor/neighborhood/chain vocab) never render.

**HITL affordances are FIRST-CLASS, not follow-up (Ross ruling 2026-07-07):**
"there is likely always going to need some human involvement." The card is an
editable model, not a read-only claim:
- Per STEP: mark not-applicable / reasonable; add a missing step (label +
  kind + leadDays).
- Per EVIDENCE: confirm or deselect a matched doc; attach a doc the matcher
  missed, picked from the window candidates (content-level list, dims
  ignored — §7.2).
- After ANY human edit the projection recomputes DETERMINISTICALLY (pure
  latest-safe-start math, no LLM re-run). The LLM proposes once; the human
  owns the model thereafter. LLM re-planning on edit stays OUT (v2).
- Persistence: append-only overlay events keyed to recordId (sop-edits
  posture), folded at read.
- Every confirm/deselect doubles as a graded sample: the §5b per-corpus
  precision gate becomes a CONTINUOUS stream, not a one-time adjudication
  (threshold-hitl-capture-intent). Known gap: the bearer lane is
  identity-less, so WHO corrected isn't captured yet — record events
  without attribution rather than blocking on auth.

**Learning-engine feedback (Ross ruling 2026-07-07): all workback HITL
gestures emit into the EXISTING `hitl-events.jsonl` store** (`hitl-events.ts`
— already "the source of truth for the offline (context → outcome) training
set"), NOT a workback-private log. Additive surface value `'workback'`;
gestures map onto the existing action vocabulary (no new verbs):
- step reasonable/not-applicable → `confirm`/`dismiss` with target
  `{recordId, stepIndex, stepKind}`;
- evidence confirm/deselect/attach → `confirm`/`dismiss`/`edit`
  (editType `'evidence'`) with `{recordId, stepIndex, docId}`;
- add-step → `edit` (editType `'reasoning'`) carrying the step in `edits[]`;
- all reversible via `undo`, per the catalog.
Three consumers, cleanly separated: (1) the sop-edits-style read overlay
folds them into the served model + deterministic recompute; (2) §4's
stage-precision gate derives its tallies from this stream (one substrate, two
projections); (3) the offline training join — chain proposal (capture-time
context) + human verdicts (label) + later lifecycle outcome (did the step's
evidence appear; did the deliverable resolve on time) — which is exactly the
training substrate for the v2 learned duration priors and matcher
calibration. Disposition consumers must stay inert to workback events the
same way they are to `edit` rows (a step-dismiss must never hide the RECORD).

## §3 — Pre-registered scratch §SW1 (S3b pattern — GATES EVERYTHING)

No production wiring until this passes. Run ONCE, report straight.

- **Sample:** Trisha corpus COPY decision-log — all commitments with parseable
  due + resolvable source doc. The live corpus has ZERO open commitments due
  within 14d (all dues past — known gotcha), so the scratch replays history:
  per commitment, pin `now = due − 10d` and build the Stage-A packet as of
  that instant. Report N (expect ~10–30). If N < 8, add Ross-corpus
  commitments and say so.
- **Calls:** Stage B + Stage C per item, exactly as specced above (same
  schemas — the scratch validates the production contract, not a toy).
  Sonnet-tier default, env-overridable (INFORM_JUDGE_MODEL convention).
  **Cost stop:** estimate N × 2 calls BEFORE running; hard stop at $5 — report
  the count instead of sampling past the stop.
- **Pre-registered expectations:**
  - **ESW-1 (THE gate):** Ross/Trisha grade each chain sensible-y/n
    (steps + durations a competent PM would write) — bar ≥90%.
  - **ESW-2:** fabricated evidence citations = 0 (receipt check catches all).
  - **ESW-3:** PARSE_FAIL + INVALID < 10% of calls.
  - **ESW-4:** the Brian June-30 deliverable, if present in the corpus copy,
    FIRES with a draft/review-shaped step as the earliest missing one.
  - **Descriptive (no bar):** distribution of fire-dates vs due (does ~10d
    fall out of the chain math naturally?); per-item fired/not-fired for
    Ross's eyeball — his precision read is the §5b seed datum.
- **Hygiene:** copies only, no `server/` edits, keys from env, single run;
  spec + results in `scratch/wp-rc-workback/` (SPEC.md pre-registered in the
  PR BEFORE the run commit; results appended).

## §4 — §5b holding-pen (first code mechanism)

Minimal, generic enough for later stages: flag ON does NOT put workback cards
in any queue/board. They serve under `workbackShadow` (additive payload field);
the app renders them ONLY behind a graded-sample surface (~20–50 cards, the
existing HITL confirm/dismiss affordances double as grading capture). A
per-corpus gate file (`_metadata/stage-precision.json`, append-only events:
`{stage:'workback', corpus, graded, correct, ruledBy, date}`) flips queue
visibility when sample precision clears the bar Ross sets at grading time.
No gate file entry ⇒ shadow forever. This is deliberately the smallest thing
that satisfies §5b; the regime-card corollary is out of scope here.

## §5 — Explicitly out (v1)

- Cross-entity/job neighborhood widening (tier-1's primaryEntity neighborhood
  is the v1 evidence universe; widening is its own WP with its own FP surface).
- Learned duration priors from corpus history (LLM priors + Ross grading first;
  calibration-from-outcomes is v2 once HITL capture accumulates).
- Auto-send anything; Teams delivery (EM3); capture-side fixes (EM1/EM2 own
  "get the Brian email in at all" — workback assumes the commitment was
  captured).
- LLM chain RE-PLANNING on user edit — later. (Human edits themselves +
  deterministic recompute moved IN as core v1 per the §2 HITL ruling; only
  the LLM reacting to those edits is deferred.)

## §6 — Sequencing + acceptance

§SW1 scratch → Ross grades (ESW-1 ≥90% or STOP and report) → WP-R-c1 engine
(workback.ts + judge + overlay + golden/fixture/no-LLM/receipt gates, flag OFF)
→ WP-R-c2 app popover (one-pair-of-eyes frontend posture: screenshot loop, no
agent fan-out) → shadow sample on the Trisha corpus (:3020 harness,
`WORKBACK_ENABLED=true`) → per-corpus gate ruling.

## §7 — SCRATCH FINDINGS ADDENDUM (2026-07-07, after §SW1/§SW1-r/§SW1-e ran)

Program: 3 pre-registered runs, $0.72 total, specs+results frozen in
`AI-Light-Prototype/scratch/wp-rc-workback/`. Design amendments that BIND
WP-R-c1:

1. **Scope rule (from §SW1 FAIL):** workback engages only at runway ≥ 7d
   (capture→due). Below that the model fits 4–6d chains into 0–3d windows;
   tier-1's tripwire owns the short regime. §SW1-r with a runway-aware prompt
   at ≥7d: 0% INVALID, 0% PARSE_FAIL (was 30%).
2. **Stage C candidates are content-level, dims IGNORED (from §SW1-e):** the
   dims-based neighborhood is BLIND on this corpus — zero matched docs even in
   full capture→due windows, while the actual precursor evidence exists (the
   06-09 "Merck Vaccines Narrative Approach Deck" email carries 0 dims). The
   LLM doc↔step matcher is therefore load-bearing v1 machinery (5b-quarantined
   as designed), not a v2 deferral. With dims ignored (22–31 candidates/item)
   it discriminated: 8 observed / 43 not-observed, 0 fabricated citations
   across all 51 verdicts, and it hit the pre-registered directional check
   (the deck email → review/revision steps of the vaccines items).
3. **STANDING TIER-1 FINDING (beyond this WP):** on OCR-dominated corpora the
   shipped `no-precursor` badge would fire nearly everywhere (dims sparsity ⇒
   empty neighborhoods ⇒ false "no draft observed" — the trust-killing
   direction). Tier-1 needs a substrate-density guard or the same
   content-level candidates before its badge is trustworthy on such corpora.
4. **Receipts:** verbatim→source matching must be whitespace-normalized (OCR
   text broke exact match 20/30; normalized: 2/10 fallbacks).
5. **Corpus ceiling, stated honestly:** max in-corpus runway is 14d and the
   Brian June-30 email was never ingested (side thread — EM1's territory), so
   the ~10d early-warning expressed only up to 14d (fires at 7/11/12/14d
   before due) and ESW-4 stayed N/A. The two-month flagship case has no
   in-corpus exemplar yet.

Human gates still open: ESW-1r (≥90% chain sensibility, GRADING-SHEET-SW1R.md)
and ESW-6 (observed-verdict correctness, GRADING-SHEET-SW1E.md). Both must
pass before WP-R-c1 dispatches.

**Acceptance demo = the Brian replay, pinned clock:** commitment made Jun 10,
due Jun 30, now = Jun 20 (the existing test-readiness fixture): chain infers
draft → internal review → revision → client send; no draft observed; earliest
missing step's latest-safe-start crossed ⇒ card fires with Brian's verbatim +
source, "haven't seen a draft in the connected mail," and both draft actions.
That card, shown to Trisha, is the win condition — it is literally the
10:56 quote rendered: "I've noticed from all of your emails... you are not
ready... get on it now... tell the client you're going to need a few days."
