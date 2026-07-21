# WP-EARNED-AUTONOMY-DESKS — brief for redline

**Date:** 2026-07-21 · **Status:** DRAFT for Ross redline — build gated on redline
**Provenance:** 2026-07-20/21 session — full survey of (1) accumulated HITL signal, (2) field/operator temporal machinery, (3) agent orchestration runtime, plus live operator runs against ross.viktora.ai. Grounding docs listed in §11.

---

## §0 One paragraph

Threshold's agents are getting good at discrete items and check-ins. The next capability is **proactive agents with earned autonomy**: desk-scoped wing passes that load a large, curated slice of the field's *past* (a "memory of sorts" — aperture, not weights), make predictive and proactive calls bound to the existing operator recipes, land every call as a proposal, and **graduate per-verb from propose-only to auto-with-undo strictly on pre-registered precision track records** — the same mechanism that already exists for one band (`dedupAutoMerge`), generalized. The training target is **the business, not the user**: how information enters, moves, resolves, and how the people in the field behave — with the user's HITL labels as the grading substrate, not the curriculum.

## §1 The ruling this encodes (Ross, 2026-07-20/21)

1. "Instead of learning to be me, **learn the business**" — the relationships, and how others have reacted and moved in similar situations.
2. An agent is really useful when it is **proactive with earned autonomy** — earned from experience and increasing proof points.
3. Agents can't have human-like memory, but they can have **a larger singular aperture for focused tasks** that ingests past events and makes predictive/proactive calls. That aperture is the memory.

## §2 Measured baseline (the "before" — all numbers observed live 2026-07-20/21)

**Resolution starvation.** State-of-play, live: **open 1,403 · resolved 33 · superseded 24** (~2.3% lifetime resolution). MDA thread: 112 records in (May 2 / Jun 88 / Jul 22), **zero resolved**; 31 edges detected on the thread (14 duplicates, 7 supersedes, 2 contradicts, 8 depends_on) — **all still `proposed`**. Corpus-wide: **369 proposed edges, 0 confirmed, 0 dismissed.** Causal chain: record lifecycle states are *derived from confirmed edges* → unconfirmed edges → the lifecycle math cannot fire → records stay open forever → movement is invisible to the operator that reports it. The edge queue is the cork in the resolution bottle.

**HITL signal.** ~100 explicit judgments in 9 days (35 ratified proposals / 62 pending / 0 dismissed; 11 dismissals using only 2 of the 5 schema reasons; 13 answered questions; 10 outbox decisions; 33 plaud-inbox decisions; 3 snoozes; 1 typed edit; corrections; 1 charter ratify). The training pipeline for these already exists (`hitl-events.jsonl` → aggregator / diff-export / calibration evals). `actor` is null on all bearer-lane rows.

**Agent aperture.** Live wing runs: **6–12k tokens, ~15 tool calls each**, all current-state reads. Guards sized to 160k under a 200k window. No pass loads any history.

**Earned autonomy today.** Exactly one band: `dedupAutoMerge` (bar ≥0.95 precision over ≥50 graded; currently 8/16 = 50%; correctly still propose-only). The authorization gradient (attended > postclose > scheduled, structural whitelists) is fixed by context and never widens with experience. Proof-point ledgers already accumulate but feed nothing: proposal fates (get_proposals, exact joins), session-grade axes, review-wing verdicts.

**Agent walls hit live (by an agent, this session).**
- Flow endpoints (`/api/claim-drift`, `/api/conversations-trajectory/:entity`, `/api/zone-freshness`) are **session-auth only** — ingestion bearer rejected. No agent lane exists to ask how information flows.
- **Movement-operator state has never been computed on the live field**: claim-drift-state / claim-events / objective-overlay (restatement chains) / doc-supersessions / identity-ledger all absent. Claims ledger populated once (July), static since.
- `vigilance-voids.json` exists (candidates) but **`void-outcomes.jsonl` is absent** — the designed prediction-scoring loop is generating predictions and never grading them.

**Doc debt (housekeeping, not gating).** Code cites HITL-ACTION-CATALOG, TYPED-DIFF-CAPTURE-DESIGN, FIELD-PROGRAM-DOSSIER §29, DECISION-OPERATORS-DESIGN §9 — none exist as files anywhere. The authoritative HITL-learning spec layer lives only in code comments. Optional reconstruction task; flagged so nobody searches for them again.

## §3 What exists to build on (nothing in this brief invents machinery from scratch)

1. **Capture + training pipeline** — `hitl-events.jsonl` (typed, append-only, source of truth), hitl-aggregator (Tier-1/Tier-2), diff-export ML triples, calibration eval harnesses, `captureSource`/`capturedBy` provenance for (agent proposal → human disposition) joins.
2. **Temporal machinery (mostly dark)** — per-entity conversations-trajectory; claim-drift tracker with `replaySnapshot` (a genuine replay engine); restatement→supersedes chains (objective-overlay); job-vigilance per-motif survival model (`StallProb`); zone drift history; churn-gate job-key migration log; forest-stats weekly snapshot (external cron, no reader); connection-strength-history (write-only, its promised diff engine never built).
3. **Agent runtime** — one LLM loop per pass with structural tool whitelists; the authorization gradient; the **wing worker chassis** (deployed 2026-07-20: one pass = one deliverable, full budget, queue-drain, crash-safe claims); `fleet/autonomy-gates.ts` precision gates (pre-registered bars, promote/demote by the same rule, fail-closed).
4. **Knowledge layers** — recipe → playbook → capability **ledger** (purpose/whenToUse/unlocks/composesWith + license floor) → doctrine. OPERATOR-INVENTORY-2026-07-11 carries the per-operator **assert/opine/never** table and the **composition recipes** ("Is this deliverable going to slip?" = workback × readiness × lifecycle × vigilance → opine risk, assert components).

## §4 Design laws (locked unless redlined; each is paid-for)

1. **The model proposes, the math disposes.** Every desk output is a deterministic-checkable proposal; the LLM renders prose bounded by license.
2. **Pre-registered, never-tuned gate bars.** Promotion and demotion are the same rule evaluated fresh; fail closed. Bars are set in this brief (or its redline), not adjusted to make a band pass.
3. **Per-axis bars for predictions.** Scratch-ledger operating points: void WHO 92% / WHAT ×40.8 / SHAPE fail → SHAPE-type predictions never gate anything; each prediction axis carries its own bar.
4. **Documents to the judge, not labels.** Labels over-accept (measured 69%→62% with all flips toward grounded). Edge-triage judging and gate grading read the underlying records.
5. **Lifecycle transitions before reliability modeling.** Reliability-from-raw-overdue over-fires (measured on Trisha corpus). Owner-behavior features wait for the transition log (Phase A) to accumulate depth.
6. **License composition, weakest link.** Desks assert facts with receipts, opine predictions, and never conclude from silence — silence licenses a question, never a verdict.
7. **Fail-closed-but-VISIBLE.** Nothing auto-applied is silent: a "Done for you: N (review · undo)" ledger line rides the brief; undo is one click and counts against the band's precision.
8. **Per-verb, per-desk graduation.** Autonomy is granted by the user per verb at the moment the bar is met, revocable one click; the app offers, never assumes.
9. **Corpus-silo honesty.** INFORM-class operators ≈ inert on a tight single-team corpus (measured: ross ≈1 genuine edge vs Meridian 196@83%). Desks on Ross's field lean on lifecycle/priority/vigilance/workback; cohesion operators earn their keep on siloed pilot orgs.
10. **Flag discipline.** Every new flag lands in `pilot-full` in the same PR (drift-gate law). Plain product language everywhere; no classifier internals in UI.

## §5 The architecture (one loop)

```
desk pass (wing-worker chassis; one desk = one focused run, full budget)
  → APERTURE: curated past-slice feed (Phase A tools) —
     trajectory, restatement chains, lifecycle transitions, prior grades,
     prior proposal fates for THIS desk's region/thread
  → CALLS: recipe-bound (OPERATOR-INVENTORY compositions), license-floored —
     chase / pre-draft / warn / re-date / confirm-edge / file-question
  → every call lands as a PROPOSAL (existing lanes)
  → human dispositions grade PER-VERB BANDS (existing join machinery)
  → precision gates widen lanes: propose-only → propose-with-default → auto-with-undo
  → decay demotes by the same rule; void self-scoring grades future-predictions
```

Experience → proof points → autonomy, mechanically. The aperture is re-ingested per run — memory as curated context, not persistent weights.

## §6 Phases

### Phase A — Temporal reach (plumbing; no new learning claims)
- **A1** MCP `get_trajectory` (entity | record | job): composes claims timeline, hitl-events, edges, restatement chain, lifecycle transitions for one subject over a window. MCP `get_field_history` (window): forest-stats trend, drift summary, churn/migrations, arrivals-vs-resolutions.
- **A2** Agent auth lane for the flow surfaces (bearer or MCP wrappers for claim-drift / conversations-trajectory / zone-freshness). An agent must be able to ask how information flows.
- **A3** Readers for the write-only series: connection-strength diff (the promised strengthening/weakening engine) + forest-stats trend reader.
- **A4** **Record lifecycle transition log** (new, append-only: recordId, from→to, ts, basis). Required by law 5; the substrate for owner-behavior features and precedent retrieval.
- **A5** Schedule the operator populate scripts on live (claim-drift snapshot, objective-overlay, doc-supersessions, cohesion populate) alongside the forest-stats cron.

### Phase B — Outcome loop ON (flags + capture fixes on the live engine)
- **B1** Priority operator ON (the purpose-built priority-gesture capture lane, currently dormant).
- **B2** Void outcome scoring: fix the absent `void-outcomes.jsonl` accumulation; per-axis scoring per law 3.
- **B3** HITL capture fixes: actor stamping on the bearer lane; surface the full 5-reason dismiss vocabulary; `expired-unratified` disposition for aged pending proposals (62 today — aging out is a label, not silence); join question-arbitration passed-over rows to outcomes as preference pairs.
- **B4** Each flag → `pilot-full` same PR.

### Phase C — Desk v1: **edge-triage desk** (the cork)
- Queue: the 369 proposed edges, duplicates + supersedes first (MDA's 31 as the pilot slice).
- Chassis: wing-worker (one pass = one triage batch, full budget). Judging per law 4 (reads the records, not summaries). Output: confirm/dismiss **proposals** with receipts, surfaced for one-tap grading.
- Grading feeds the existing `dedupAutoMerge` band + a new pre-registered `supersedesConfirm` band (proposed bar: ≥0.95 over ≥50, same as dedup — redline welcome).
- **Why this desk first:** every confirmed edge lets the lifecycle operator derive resolutions → un-starves state-of-play → makes the Phase-A feeds worth reading → which every other desk needs. One grading effort, triple payoff (cleanup + proof points + field self-visibility).
- Acceptance: resolved/superseded counts move off 33/24; MDA shows nonzero resolutions; grading cost ≤ ~5 min/day at the brief.

### Phase D — Desks v2 + generalized earned autonomy
- **D1** Region/thread desks (MDA, Catalyst, Sora first) on the chassis: past-slice aperture (A-tools), composition recipes, license floors; outputs = chase/pre-draft/warn/re-date proposals with precedent lines.
- **D2** Generalized per-verb bands: `re_date`, `resolveProposal`, `snoozeProposal`, `outboxDraftKnownRecipient` — each with a pre-registered bar (defaults: ≥0.95 over ≥50; redline).
- **D3** Ladder: propose-only → propose-with-default → auto-with-undo; user grants per verb; demotion automatic + plainly announced.
- **D4** Owner-behavior features (response latency, follow-through from the A4 transition log) → `wReliability` graduates from its 0.5 stub. Cross-user prior stays parked until a second live actor.

## §7 UX (summary; UI increments get mockups as pixel contracts before build)

- **Brief becomes a staff briefing**: per-desk *done / found / predict*, precedent lines with receipts ("last time X sat this long → the June-30 miss").
- **Proactive chips** mid-day: day-before warnings, heads-up drafts ready (the Trisha deadline-pain asks, powered by desk memory).
- **Ratification becomes grading**: proposal cards carry the verb's track record ("Re-dates: 47/47"); at the bar, the app *offers* autonomy in plain language.
- **Trust panel** in Settings (master-detail): per-verb state (asks you / applies with undo), the count that earned it, one-click demote.
- **Done-for-you ledger line** on the brief (law 7); demotion messaging plain: "I've gone back to asking on re-dates — my last few were off."
- Net effect: the queue shrinks (graduated verbs leave it), the check-in shortens while covering more, voice check-ins become grading conversations.

## §8 Acceptance measures (against §2 baseline)

1. An agent can answer "what happened to X over the last month" via MCP (A) — currently impossible.
2. Resolved/superseded counts move and keep moving (C); MDA 112/0 becomes 112/n>0.
3. `void-outcomes.jsonl` accumulates scored predictions (B).
4. First band graduation is *offered* only when its pre-registered bar is genuinely met — and demotion has been demonstrated in test.
5. Zero silent auto-actions: every auto-applied item appears in the done-for-you ledger with working undo.
6. Label rate: capture fixes lift human-judgment labels from ~11/day toward ~25/day without added user effort (edge grading counts double per law: cleanup + proof).

## §9 Non-goals (honesty section)

- **No forecasting claims.** Track-B field-diffusion stays research (recovery ≠ prediction, n=1, burned). Desks *opine* risk from measured components; they do not predict T→T+1 field states.
- **No fine-tuning yet.** The SFT corpus (session captures + outbox fates) accumulates in parallel; revisit at thousands of pairs (BYOM/local lane).
- **No cross-user prior activation** until a second live actor exists.
- **No new UI sections on Today** (standing law); desk output rides the brief and existing lanes.

## §10 Open questions for redline

1. Desk boundary: region (frame) vs thread (objective-chain) vs owner? Proposed: frame-first (MDA/Catalyst/Sora), threads within.
2. First graduated verbs (D2 list right?) and the default bars (0.95/50 everywhere, or looser for `snoozeProposal`?).
3. Grading budget: what's the acceptable daily one-tap load at the brief (proposed ≤5 min)?
4. Edge-triage surfacing: brief-embedded cards vs Relationships view vs both?
5. Naming: "desks" in product copy, or keep it internal and let the brief speak per-project?
6. Phase A5 scheduling: piggyback the weekly forest-stats cron or nightly?
7. Reconstruct the phantom specs (HITL-ACTION-CATALOG, TYPED-DIFF-CAPTURE-DESIGN) from code comments as a docs task — worth an increment, or leave as archaeology?

## §11 Grounding references

- OPERATOR-INVENTORY-2026-07-11.md (operator ledger: exposure map, license table, composition recipes)
- `~/scratch/hitl-loop/LEDGER.md` (scratch ledger: empirical constraints in §4)
- WP-MCP-AGENT-ENDGAME-BRIEF-2026-07-10.md §C1 (authorization gradient); COMPANION-SYSTEM-MAP-v0-2026-07-16.md
- WP-WING-PRODUCTION-BRIEF-2026-07-17.md (wing worker chassis); `server/fleet/autonomy-gates.ts` (precision gates)
- FIELD-PROGRAM-DOSSIER.md; KNOWLEDGE-FIELD-FINDINGS.md; DECISION-OPERATORS-DESIGN.md; COHESION-OPERATORS-FINDINGS.md; PRIORITY-OPERATOR-FINDINGS.md; WP-VIGILANCE-VOID-BRIEF.md; WP-Learning-Engine-Capability-Brief.md
- Live measurements 2026-07-20/21: ross.viktora.ai `/mnt/ross-corpus/reference/_metadata/*`, state-of-play frame-level read, MDA ledger composition.
