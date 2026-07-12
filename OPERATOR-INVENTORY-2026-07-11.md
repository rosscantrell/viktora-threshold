# Apolla operator & substrate inventory — 2026-07-11

The full leverage audit run during the MCP-companion session (two read-only
sweeps: engine exposure + design/scratch corpus), updated same-night for the
seven capability PRs that shipped (#447–#452, #454). This is the reference map
for ANY session deciding what a surface (Today, the packet, a new capability)
should consume: what the engine computes, where it surfaces, and what's still
dark.

Exposure key: **packet** = rides `get_checkin_packet` (⇒ MCP-reachable) ·
**MCP** = a registry capability reaches it · **app** = Threshold HTTP routes
only · **unserved** = computed, nothing serves it.

## The MCP surface (27 capabilities, ross.viktora.ai @ 34cbdfd)

Reads: get_state_of_play (levels summary|frame|forest), search_records,
get_record, get_receipts, get_commitments, get_entity_card, ask_question,
get_checkin_packet, pull_pending_intake, get_workback_plan, get_availability,
**get_priority**, **who_to_inform**, **get_proposals**, **get_task_brief**,
**get_questions**, get_outbox_item, **get_doctrine**, list_capabilities,
run_capability. Writes (all HITL-gated): ingest_doc, stage_prework,
propose_workback_gesture, propose_to_outbox, propose_record_edit,
revise_outbox_artifact, **file_question**. (Bold = shipped 2026-07-11 evening.)

Knowledge layers, all server-side: recipe (procedure) → playbook
(interpretation) → ledger (selection: purpose/whenToUse/unlocks/composesWith +
optional `license` floor interpret|opine|extrapolate) → **doctrine**
(orchestration-in-time: RANK→EQUIP→TRAVERSE→DRAFT→INFORM→PHRASE→ASK→
CALIBRATE→ROUTE, per-item-state + per-moment sequences).

## Subsystem exposure table

| Subsystem — what it computes | Exposure | Flag (pilot-full?) |
|---|---|---|
| Priority operator (Focus/Watch, job-priority, reassignment signals, prose) | **MCP (get_priority) + packet `focus` digest** + app `/api/decision-log/priority*` | ENABLE_PRIORITY_OPERATOR ✅ |
| Vigilance voids (egress, ingress-owed, depends-on-incomplete, overdue-silent, contradiction; suppression, calibration) | packet `watching` + app `/api/vigilance/*`. No standalone void capability | VIGILANCE_VOID ✅, INGRESS_OWED ✅, JOB_VIGILANCE ✅; **INGRESS_MAGNET explicitly OFF** (auto-close-on-ingest dark pending precision validation) |
| Readiness (active/quiet/no-precursor/unobservable, density guard) | packet + MCP rows + app | READINESS_ENABLED ✅ |
| Workback (shadow, refold, effectiveDue, critical path) | MCP (get_workback_plan / propose_workback_gesture) + packet + app | WORKBACK_ENABLED ✅ |
| Lifecycle/staleness (silentDays, mentionsAfter, overdueSilent) | everywhere (embedded in every read) | core ✅ |
| Work Forest frames (anchors, job identity, fold learner, SoP, heat) | **MCP get_state_of_play level=frame\|forest (prose)** + app frame editor/learning routes (`edit`, `learning-state`, `develop-rules`, `apply-to-similar`, `suggestions` = app-only) | all frame flags ✅ |
| todaysPlan reconciliation (plan-anchor join: moved/stalled/newlyActionable/byOwner) | packet (MCP) — anchor = day's session-close capture docs | no flag |
| Markers / tidbits / SYN2-DEF synthesis prose | **app-only** (`/api/markers*`, `/api/synthesis/*`, tidbits); MCP get_marker is legacy-dark | ENABLE_SYNTHESIS ✅; MCP_LEGACY_TOOLS ❌ |
| Claims ledger + quote citations + research story + claim-drift | **app-only** (`/api/claims*`, `/api/research/*`); absent file ⇒ graceful empty. Backfill scripts: populate-quote-citations.ts + populate-claims-ledger.ts (run on ross corpus 2026-07-11) | no single flag |
| HITL machinery (events incl. `propose`, aggregator, signals, exemplars, calibration) | write via MCP proposals + app lanes; **read-back via get_proposals** (dispositions JOIN-INFERRED — no ratify→proposalId backlink exists; deterministic for `link` via edgeId, inferred by record+time for resolve/re_date; `dispositionBasis` names the evidence). Aggregation/signals/exemplars = internal training data, no read surface | — |
| Question Engine (frame-questions store; answer/dismiss/snooze) | **MCP (get_questions / file_question)** + app card. Filed questions: `mcp-gap:` subjects, `mcpq:` factKeys (idempotent ⇒ never-re-ask binds agents), CANNOT mint org-edits on answer | ENABLE_QUESTION_ENGINE ✅ |
| Proxy queue (cascade edge/canon proposals; confirm/dismiss/undo) | app-only read `/api/proxy-queue`; SEPARATE system from MCP closure proposals | routes always on; FLEET_ENABLED ❌ (nightly auto-fill dark) |
| Restatement/dedup (reforward supersession, near-dupes, chronic restatement) | internal (ingest-time; manifests as supersedes edges) | EMAIL_REFORWARD_SUPERSEDE ✅ |
| Evidence axis (WP-EV2 emission → salience Beta) | internal; get_recent_evidence legacy-dark | MCP_LEGACY_TOOLS ❌ |
| Edges (depends_on/resolves/supersedes/contradicts + editor) | MCP (rows) + app editor | editor ✅ |
| Entity canon / person cards / ownerLoad / cohesion INFORM+STAKEHOLDER | MCP (get_entity_card, **who_to_inform** — live sliced compute, never the unsliced verdict cache) + app | ENTITY_CARDS ✅, ENABLE_COHESION_OPERATORS ✅ |
| Intake (channels, health, Plaud/email) | MCP (pull_pending_intake) + packet + app | intake/Plaud/email flags ✅ |
| Availability lane (ICS poller) | MCP (get_availability) + app | both flags ✅ |
| Outbox + artifact round-trip (versioned supersession, revisedBy lanes) | MCP (propose_to_outbox, get_outbox_item, revise_outbox_artifact) + app routes + artifact GET/PUT; SHARED_OWNER = operator lane sees all | no flag |
| Corpus-altitude analytics: SPOF, bridge-people, drift/ensemble, cross/meta-patterns, community/term-graph/ontology, strategic tendencies (T4) + win-path (T5), OKR proposals, home/plans/narrative/conversations aggregators, team-summary | **all app-only** — candidate feeds for a weekly `mode:'review'` horizon | various |
| Knowledge Field M0 (graph-calculus operators, field-vector, regions/license classifier, relational salience) | **unserved** (experimental; `server/ai/field/*`) | relational-salience default-OFF |

**Still agent-invisible after tonight:** markers/synthesis prose · claims/
research story · frame LEARNING routes · evidence axis · proxy-queue read ·
HITL calibration internals · the corpus-altitude analytics family · Knowledge
Field M0. **Known future fix:** proposalId backlink on the two ratify PATCH
routes (turns get_proposals inference into exact joins).

## Design/scratch corpus themes (validated machinery not yet productized)

Canonical home: `AI-Light-Prototype/schema-browser/experiments/field-projection/`.

1. **Knowledge-field model** — KNOWLEDGE-FIELD-FINDINGS.md; FIELD-PROGRAM-DOSSIER.md (PROVEN/MARGINAL/FAILED tags + the program's own supersedes/burned ledger); **BI-LICENSE-MAP.md** (the license ladder — now partially productized via doctrine).
2. **Decision operators** — DECISION-OPERATORS-DESIGN.md: SUPPORT, DRIFT, VELOCITY/FLOW, BLINDSPOT, the INVESTIGATE loop (anomaly → evidence → certainty climb).
3. **Cohesion / INFORM / STAKEHOLDER / PRIORITY** — COHESION-OPERATORS-FINDINGS.md (83–100% validated); `~/scratch/hitl-loop/LEDGER.md` = the run-by-run empirical ledger.
4. **Vigilance void loop** — WP-VIGILANCE-VOID-BRIEF.md (pre-registered falsifiable expect-back predictions, self-scoring).
5. **Identity/evidence/cards** — EV/ID AARs, WP-IDENTITY-REGIME-HANDOFF-BRIEF.md; marker engine internals in docs/outcome-g-*.md (salience×rarity×affinity; why silence is a feature).
6. **Federation E1–E10** — n1-federation/ (bridge-entity fidelity ladder, routing, chain confirm); NETWORKED-CORPORA-DESIGN-NOTE.md (share projections, not corpora); two_corpus_recall (networking as error-correction).
7. **Cascade** — WP-CASCADE-PRODUCTION-COORDINATOR-BRIEF.md; embedding_cascade/adjudication scratch (**chronic-restatement detection** — the stuck-work signal; = the planned carry-forward counter).
8. **SoP as field projection** — sop_field_projection_scratch.py (operator-grounded per-project story).
9. **Personal field** — conversation_loops (PROMISE as unit), routine_operator (recurrence + automation gating), **task_assembly (productized 2026-07-11 as get_task_brief)**.
10. **Companion briefs** — WP-MCP-AGENT-ENDGAME-BRIEF (Part C = field-as-coordination-plane, the locked design), WP-INTAKE/CALENDAR/QCARD/MCP-V2/BYOM briefs, READINESS-TIER3 workback reasoning.
11. **Query/eval** — DD-11 query-resolution spec (confidence envelope → response band); GT-EVAL harness.

## Business mappings — what each operator ANSWERS, and what it may claim

The mechanics table above says where signals live; this section says what they
MEAN in business terms and how strongly they may be voiced. License rungs (the
BI-LICENSE-MAP ladder, now served on the ledger): **assert** = state as fact
with a receipt (interpret) · **opine** = offer as a suggestion/judgment with
hedges · **never** = the claim the operator must not make. Composition rule:
a combined answer inherits the WEAKEST license of its inputs.

| Operator | The business question it answers | May assert | May opine | Must never claim |
|---|---|---|---|---|
| Priority (Focus/Watch) | "What should I act on first, and what can wait?" | the ranked sets + the reasoning the service computed | "do this first"; a hand-off suggestion (needsConfirmation) | that an unranked item doesn't matter |
| Reassignment signals | "Should someone else own this?" | the signal behind the suggestion | the new owner, as a question | an ownership change (HITL only) |
| Vigilance voids | "What did we send/promise that nothing came back for? Who's waiting on us?" | the void exists (receipt-backed); days waiting | egress = nudge candidate; ingress-owed = reputational risk, rank high | that the other party actually failed to respond (maybe off-corpus) |
| Readiness | "Is prep actually happening for this due date?" | active/quiet with receipts | risk, for quiet items with runway | ANYTHING for 'unobservable'/'no-precursor' — never alarm on what it can't see |
| Workback / effectiveDue | "What has to happen, by when, for this to land?" | the chain, the effectiveDue, a missed step date | slippage risk; a re-date proposal | a new date as fact (proposal only) |
| Lifecycle / silence | "Has this gone quiet?" | silentDays, mentionsAfter | — | a CONCLUSION from silence — silence licenses a QUESTION, never a verdict |
| Frames / Work Forest | "How is this project, as a whole, doing?" | membership, per-project SoP facts | project-level narrative (the SoP prose is calibrated for this) | cross-project priority (that's the priority operator's job) |
| todaysPlan reconciliation | "Against what we agreed this morning — what moved, stalled, opened up?" | moved/stalled/newlyActionable with record refs | renegotiation suggestions | that an un-anchored item was 'planned' |
| INFORM / STAKEHOLDER | "Who needs to know? Who are the stakeholders?" | the shared-subject basis (receipts) | the To/Cc suggestion, hedged by corpus-dependence | an auto-send; that absence of signal = not a stakeholder (tight corpora under-report) |
| Entity cards / ownerLoad | "What's on this person's plate? What do we know about X?" | open items, receipts | 'check in on the PERSON' when load spikes | private-slice content to a non-entitled viewer |
| Claims ledger / research story | "What's the exact evidence? How did this claim evolve?" | verbatim quotes (verbatimVerified only), the chronology | drift interpretation | an unverified quote AS a quotation |
| Markers / synthesis | "What's worth surfacing at all?" | — (internal scoring) | the surfaced item (the whole engine is a calibrated opinion) | why something WASN'T surfaced (silence is a feature) |
| Restatement / chronic-restatement | "Is this stuck? Have we said this N times?" | the repetition chain | 'something unstated is blocking this' | WHAT blocks it (that's an ask, not a read) |
| get_proposals read-back | "What happened to what I proposed?" | disposition where the join is deterministic (link/edgeId) | inferred dispositions (dispositionBasis says so) | an inferred disposition as certain |
| Questions lane | "What is only the human able to tell us?" | prior answers (idempotent — never re-ask) | the two prepared options offered | an answer on the human's behalf |
| Task brief (equip) | "What does the executor need in hand to DO this?" | the assembled context + honest gaps | which gap matters most | content it didn't find ('no receipts newer than X' is the assertion) |
| Availability | "When is there actually time?" | free/busy windows from the lane | a proposed slot | calendar content beyond windows |
| SPOF / bridge-people (app-only) | "Where does one person's absence break us? Who connects groups?" | the structural read | a resilience concern | a personnel judgment |
| Strategic T4/T5, OKR (app-only) | "What direction does the corpus imply? What would win?" | — | everything — this family is opine-or-lower by construction | any of it as established fact |

## Composition recipes — answering complex questions

The doctrine's assembly line covers the per-item flow. These are the
CROSS-OPERATOR joins for the questions a chief of staff actually gets asked.
Each names its inputs and the license of the ANSWER (weakest link).

- **"Is this deliverable going to slip?"** = workback (chain + effectiveDue +
  missed steps, assert) × readiness (quiet/active, assert) × lifecycle
  (silence, question-only) × vigilance (who we're waiting on, assert) →
  **opine** on risk, assert the components: "Step 2 hasn't been observed
  (fact); prep has been quiet 9 days (fact); the pre-read depends on Muecher
  who hasn't replied in 12 (fact) — I think this slips unless X (opinion)."
- **"Is this project in trouble?"** = frame SoP (narrative) × chronic-
  restatement (stuck items) × todaysPlan carry-forward × voids on its records
  × decision follow-through (decisions whose implied commitments never moved)
  → **opine**, receipts per component.
- **"Who should I loop in / who's affected before I act?"** = who_to_inform
  (suggestion) × edges depends_on (whose work this touches, assert) ×
  bridge-people (app-only, structural) → **opine** the list, assert the bases.
- **"Did we already decide this? Is this contradicting something?"** =
  search_records × claims story (evolution, assert) × supersedes chain (newest
  is truth, assert) × contradiction edges → **assert** with receipts; the
  RESOLUTION of a contradiction is human-only.
- **"What am I missing right now?"** = vigilance ingress-owed × intake
  arrivals × newSince watermark × todaysPlan.newlyActionable → **assert** the
  list; the interrupt-vs-hold call composes priority + effectiveDue vs the
  check-in schedule (C2 gate).
- **"Who's overloaded — should work move?"** = ownerLoad (assert) ×
  reassignment signals (opine) × SPOF (structural) → **opine**; any move is a
  proposal.
- **"Can I say this in the deck / to the client?"** = license floor of every
  input claim (ledger) × verbatimVerified for quotes × MIN-composition →
  phrase each sentence at its own rung; the doctrine's PHRASE step.
- **"What should the user do FIRST today?"** = priority Focus (opine) ×
  due/effectiveDue (assert) × todaysPlan stalled (assert) × doctrine RANK →
  **opine** an ordering, assert each item's facts.
- **"Prepare this item completely" (the exceed-expectation move)** =
  get_task_brief (equip, assert+gaps) → draft FROM it → who_to_inform for
  recipients → license-check every claim → file_question for each honest gap
  with two options → propose_to_outbox with artifacts → propose_record_edit
  resolve when discharged. This is the assembly line instantiated; every hop
  already exists as a capability.

Rule of thumb for NEW complex questions: decompose to operators, take each
component at its own license, compose the answer at the weakest rung present,
and convert every gap the decomposition exposes into a filed question with
prepared options — gaps are the highest-value corpus-patching channel.

## Notes for the Today-view redesign specifically

Today currently stacks: read/SoP → Waiting-on-you (+Filed) → Coming up →
Awaiting-send tray → Focus/Watch → Stalled/Chasing → decision-log rollup.
Server-side data that could REORGANIZE rather than ADD: the packet's
todaysPlan reconciliation (moved/stalled/newlyActionable/byOwner — Today could
anchor on the PLAN, demoting the raw stacks), the focus digest (rank, don't
list), and the doctrine's per-moment framing (morning Today ≠ evening Today).
The crowding is additive-sections debt; the reconciliation frame is the
already-locked alternative (brief Part C §C1).
