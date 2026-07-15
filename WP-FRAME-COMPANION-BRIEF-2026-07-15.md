# WP-FRAME-COMPANION — region-anchored companions, the interpretation contract, earned autonomy, and the corpus groomer

**Date:** 2026-07-15 · **Status:** DESIGN BRIEF (agreed frame, pre-build) · **Owner:** Ross
**Origin:** the work-forest categorization arc (WP-ONEQUESTION, WP-CHURN-GATE) + two
lived incidents this week: the OLYSENSE correction that had nowhere to land, and the
measured 30-hour projection churn that composed summaries would have silently absorbed.
**Repos:** engine (AI-Light-Prototype/schema-browser) for everything; Threshold app
changes are zero in the phases below.

---

## §0 Field-conformance preamble — these BIND every mechanism in this brief

1. **The field is the reality; frames are projections.** Records are immutable,
   doc-anchored substrate. Jobs and frames are derived lenses that re-cut on every
   compile. Nothing in this brief may treat a frame as an object that owns state.
   Anything durable anchors to records/entities (the WP-ORG-STATE-STABILITY insight,
   now shipped as the churn gate's record-set identity).
2. **Entities are managed through Bayesian posteriors** (the D2 evidence-ladder spec,
   engine PR #358 lineage). Identity corrections are evidence entering a posterior and
   fold at read time. Substrate text is NEVER rewritten; verbatim provenance is sacred.
3. **Frames-as-posteriors already have math** (PLAN-Frame-Dynamics §2): per-frame
   Beta(α, β) ratification posteriors, ordered evidence-class weights
   (authored citation > endorse > accepted placement > silent placement), stiffness
   κ = log(1 + α_ratified), and a churn bar that scales θ₀ + θ₁·κ. This brief adds
   evidence classes and consumers to that math — never parallel machinery.
4. **Operators compose; agents conduct.** Intelligence here is composition of existing
   operators (field Laplacian/betweenness/regions, Gamma-Poisson lifecycle, QE
   value-of-information, the license ladder) over a scope. No bespoke cleverness; the
   SELFORG kill stands: taxonomy/purpose boundaries come from human ratification, not
   prompt engineering.
5. **Derived slots, never constants.** Every threshold below is a percentile of the
   corpus's own distribution.
6. **House laws:** plain product language (no operator jargon ever surfaces);
   fail-closed-but-VISIBLE; propose-only with receipts and undo; anti-self-training;
   ask-boundary; ONE question per check-in (the bound WP-ONEQUESTION ladder);
   coordinate through the field, never session choreography; one companion per human
   (amended ruling: per-frame workers are intra-corpus workers under the human's
   companion and NEVER hold peer links).

---

## §1 The region anchor (the math)

**Region.** A companion's scope is a weighted membership over records,
μ_c : R → [0,1] — NOT a frame binding. Initialized at charter ratification (μ = 1 on
the chartered projection's records, weighted by each record's placement evidence
class); evolved only by evidence-ladder events using the existing overlay weights
(user move-in 1.0, accepted preview 0.5, silent placement ε, user move-out → 0).
Hard region A_c = {r : μ_c(r) ≥ τ_μ}. Records are immutable ⇒ the anchor cannot be
churned by a recompile, by construction.

**Projection.** Compile t emits frames {F_i} with record sets R_i (via member jobs).
The region's projection vector: π_i(t) = |A_c ∩ R_i| / |A_c|.

**Observables (each maps to a typed product event):**
- **Concentration** c_t = max_i π_i — fragmentation when low.
- **Dilution** d_t = |R_primary \ A_c| / |R_primary| — absorption when high.
- **Chain identity** — majority rule (c_t > 0.5 at every hop), identical to the churn
  gate's dominant-subset matching. Parameter-free.
- **Composed-artifact freshness** — member-set-hash Jaccard (summaries carry the hash
  they were composed over; drift classifies fresh / drifted-with-delta / recompose).

**Derived cuts:** fragmentation flag below the corpus p10 of c; absorption flag above
the p90 of d; τ_μ from the μ distribution once evidence weights accumulate.

**Baseline fixture (pre-registered — measured 2026-07-15 on the ross corpus, five real
forests across four recompiles in 30h):** 32 regions ≥5 records from t0;
**30/32 (94%) majority-chain trackable t0→t4**; final concentration median 1.00,
24/32 ≥ 0.7, 31/32 ≥ 0.5. The two breaks (CR1 Release c=0.33, Vaccine Projects
c=0.55) coincide with regions where the QE independently holds dedup questions — the
math's misalignments localize exactly where human ruling is needed. Absorption
observable validated on the known case: OlliSense Recovery c=0.52 / **d=0.96** (swallowed
by Sora's projection) vs Sora itself c=0.92 / d=0.24 (a program growing). Any
implementation must reproduce this trace (tolerances: chain ≥ 90%, the two known breaks
break, OlliSense d > p90). Limitations to close in Phase 1: fixed record lens, hard
sets (no historical μ weights), 30h window — the weekly forest-stats snapshot gains
`chainTrackablePct` and median c to watch alignment over weeks.

## §2 The interpretation contract (value → meaning → voice → action)

Raw values NEVER surface. Each band has a canonical business translation, a license
tier, and an action tier:

| Band | Meaning | May say | May do |
|---|---|---|---|
| c ≈ 1 | region and projection agree | speak of "the project" plainly | full duties |
| c ∈ (p10, ~0.7) | projection splitting region — noise OR real bifurcation | hypothesis voice only ("this looks like it's becoming two tracks — track separately?") | investigate (entity/sub-goal separation), file ONE split question; never re-anchor silently |
| c < p10 | fragmentation event | "I've lost confident continuity — here's where the pieces went" | receipt + escalate; artifacts auto-stale; suspend continuity assertions |
| d moderate | new mass since charter | scope-creep detector: "four items joined; three serve the charter, one looks misfiled" | score vs charter; μ-growth for fits, curation for misfits |
| d > p90 | absorbed | "I still track X as its own effort; the Log shows it inside Y — keep it separate?" | hold-worthy ratification question; keep composing for the REGION |
| chain break | identity rupture | stop asserting continuity; name the pieces | tracking posterior takes the failure; one question |
| κ high | user-ratified structure | speak in the user's ratified vocabulary | propose less, protect more (gate bar already rises with κ) |
| κ low | thinly-witnessed guess | hedged working-read voice | explore more; charter-drafting is the priority |
| μ = 1.0 item | user placed it | "you filed this here" | trust fully |
| μ = ε item | machine placed it, unwitnessed | "this landed here automatically" | μ-margin = the curation queue |
| entity posterior unimodal | canon settled | plain name | join freely |
| entity posterior multimodal | contested identity | "assuming X and Y are the same — flag me if not" | one stakes-gated correction question |

**The composition layer is where opinion lives.** Single values ⇒ deterministic
phrasing. Judgment enters only where values conflict, and each such interpretation
carries its values as internal receipts while speaking only the translation:
- c high + d high ⇒ "intact but annexed" (the OlliSense signature).
- heat high + κ low ⇒ ratification debt ⇒ the strongest charter-question trigger.
- d rising + charter-fit high ⇒ healthy growth, silence; + charter-fit low ⇒ scope
  creep, speak. Only the charter disambiguates — it is load-bearing, not decorative.
- deadline near + chain broken ⇒ reduced-confidence workback hedge, honestly stated.

Phrasing strength is throttled by the license ladder fed from the tracking-reliability
posterior (Beta over chain successes): an agent in a churny area says so.

## §3 The charter (the WHY — top evidence rung, stored as a document)

Per qualifying region: objective, success criteria, stakeholders + their stakes,
constraints, phase. **Drafted by the companion from the field; ratified by the user in
one check-in conversation.** Stored AS A DOCUMENT (`FRAME-CHARTER-<slug>`, the envelope/
capture precedent) so it is substrate: versioned, extracted, projected INTO the field;
its claims are entity- and record-anchored. Ratification = an authored-citation α event
(the TOP rung of the Frame-Dynamics evidence ladder) ⇒ stiffness κ rises ⇒ the churn
gate protects chartered regions with zero bespoke code. Amendments are proposals
(charter-vs-observed-decisions drift ⇒ "the work seems to have pivoted — update?"),
riding the one-question budget. An unratified draft renders only in working-read voice
with visible provenance. Charter unlocks: purpose-ranked prioritization, principled
membership curation ("does this serve the charter?" — grounds mega-frame split
proposals in purpose, not topology), instant CoS/voice briefing, and information-
gathering targeted at goal-gaps rather than draft-blanks.

## §4 Briefing artifacts + license inheritance (agent-to-agent context)

Companions explain to OTHER AGENTS through pull-served **briefing artifacts**, never
chat: region brief = charter + current state + live observables with receipts,
member-set-hash-keyed for freshness. The check-in/CoS agent consumes region briefs
instead of re-deriving (the packet precedent, extended to agents); the prework
`stage_prework` frame-provenance field (enhancements-session commitment) is the staging
lane. Inter-companion questions ride the existing typed question lane (P2 verbs
precedent; answers-become-substrate).

**License inheritance (binding):** a consuming agent may repeat a claim NO more
strongly than the source's license, min-of-the-chain, receipts transitive. Confidence
never inflates through retelling.

## §5 Stack registry + earned opine-autonomy

A **stack** = a named, typed composition of operators whose intermediate values are all
receipts (the navigation recipe and the doctrine assembly line are the canonical
examples). Complex questions are answered by longer stacks (e.g., absorption →
charter-fit → entity betweenness → workback impact → who_to_inform).

**Earned autonomy** generalizes the learned-fold authority ladder from placement rules
to agent stacks:
- Each named stack accrues an **outcome posterior** (Beta) over VERIFIED outcomes only
  — human-ratified or objectively resolved. Attribution rides the existing id plumbing
  (proposalId backlinks #466, mcpq factKeys #452): every opinion carries an id future
  events reference.
- Autonomy tiers, ascending with the posterior: observe → opine-hedged →
  opine-assertive → propose → apply-within-preratified-class (receipt + undo, always).
- **Ceilings the posterior can never climb past:** third-party sends = human-gated
  forever; substrate mutation = fold-only + undo forever; the authorization gradient is
  a wall, not a threshold.
- **Demotion is symmetric and faster** (reject-propagation precedent): conflicts decay
  authority immediately.
- **Anti-self-training:** an agent's own unratified acceptances never score.
  **Calibration is measured against ground truth, never inter-agent agreement**
  (the judge-ceiling lesson).

## §6 The corpus groomer (the sibling, corpus-grain)

ONE groomer owns cross-frame hygiene; frame workers escalate to it, never fix
cross-frame themselves. Duties: entity canon, dedup sweeps, jobless residue
(79 records today, visible in diagnostics), summary-freshness sweeps, and the
**capture-normalization lexicon**.

**Correction intake (build FIRST and smallest):** a typed MCP verb
(`propose_correction`: kind entity-alias | spelling | owner-identity | …, from[],
to, scope, evidence) so a spoken correction at any companion surface lands in a
visible queue instead of on the floor. `ratifiedBy: user-spoken` = top-rung evidence
⇒ pre-ratified tier: mechanical application with receipts + undo, no re-ask.

**A correction has three time-scopes, all owned by the groomer:**
1. *Retroactive* — evidence into the entity-identity posterior; applied as a
   read-time CANON FOLD (records never rewritten).
2. *Derived* — re-key job names / frames / entity cards / summaries.
3. *Prospective* — the lexicon entry applied at capture so the transcription error
   stops recurring (also the speaker-N remediation path).

**Fixture (pre-registered):** the OLYSENSE case — one entity under four substrate
spellings (OlliSense 25, OllieSense 14, "Ollie Sense" 10, OLYSENSE 9 = 58 occurrences,
measured 2026-07-15). Acceptance: one spoken-grade correction folds all four variants
to one canonical entity at read (entity card, receipts, who_to_inform join across all
58), zero substrate bytes changed, one receipt line, undo restores byte-identical
reads, and a lexicon entry normalizes a NEW test ingest.

## §7 Phases, gates, coordination

- **P0 (now, smallest):** `propose_correction` intake verb + visible queue. Fixture:
  a filed correction appears in get_proposals + a check-in receipt acknowledges it.
- **P1 (now):** corpus groomer as a runner pass (5th pass kind; whitelist = reads +
  file_question + propose_correction-apply within pre-ratified classes; flag-gated,
  posture-catalogued). Fixture: §6 OLYSENSE end-to-end.
- **P2 (now, engine-side, no identity infra needed):** charter pilot on ONE
  well-bounded region (Hikari/MDA) — charter doc + compose pass + one ratification
  conversation + region-brief artifact consumed by the next check-in. Fixture: the
  standup cites charter context with license inheritance intact.
- **P3 (gated on the churn-gate threshold ruling + arming):** per-frame workers with
  `companion:<region>` bearer grants (slice-filterable email-form identity — the
  speaker-N trap), region anchors per §1, observables per §2, heat/state-derived
  assignment (~6-8 regions + generalist tail).
- **P4 (gated on P3 track record):** stack registry + autonomy posteriors; graded
  sessions (enhancements-session rubric) provide the first verified-outcome stream.

**Coordination map:** enhancements session owns the runner/doctrine/packet surfaces
(new pass kind, protocol text for region briefs, stage_prework frame field);
networking session owns the grant-mint pattern the companion identities reuse and has
already staked question-lane arbitration (peer questions field-answer first); the
churn-gate ruling (Ross) gates P3. The weekly forest-stats snapshot gains
`chainTrackablePct` + median concentration (two-line script change) so §1 alignment is
watched, not assumed.

**Cost posture:** charters are ~one-time per region + slow amendments; groomer pass
rides the runner's caching (~$0.25-0.40/pass precedent); briefs are composed on write
paths and pull-served (no read-path LLM — the #467 law).

---

## §8 Cross-session build-to amendments (2026-07-15 review, enhancements session — BINDING)

Review verdict: three endorsements with terms, one unification requirement. Nothing
else contested. The reviewing session is at compaction; these terms are recorded in
its successor-inherited memory — the contract survives the handoff.

**§8.1 Groomer pass (amends §6/§7 P1):**
- Its own `DEFAULT_MAX_TOOL_CALLS` entry (store-overridable); the differential
  whitelist test pins its EXACT tool set.
- Bank-as-you-go prompt ordering + capNote apply (post-#481 pass-family conventions).
- Transcript persistence (#491) applies — groomer runs must be EXCLUDED from the
  voice backend's same-mind continuation pool (`CONTINUE_PASS_RANK`): a groomer run is
  not a resumable working session. Flag in the PR body; the enhancements
  session/successor takes the backend edit.
- **Tier declaration:** apply-within-preratified-classes is the FIRST unattended APPLY
  in the system. The PR must declare it as a deliberate tier decision (the #472
  pattern); apply-capable classes are pinned CLOSED (enum, not pattern) by the
  differential test; receipts + undo are load-bearing, not optional.

**§8.2 propose_correction (amends §6 P0) — UNIFICATION REQUIREMENT:**
This verb is the intake half of the enhancements session's parked WP
"conversational field corrections as bulk HITL" (same founding incident: OLYSENSE).
One design, two halves: P0 = typed intake + preratified mechanical apply for CLOSED
classes; the parked half = scope-preview + one-approval-many-writes bulk ratify for
fan-out corrections. Build-to so the bulk half bolts on:
- The correction record carries a `scope` field (`single-record | canon-fanout`) from
  day one, even while v1 implements only the closed single-class applies.
- Idempotency from day one (the #492 lesson): findPendingDuplicate-style join — a
  repeated utterance never mints a duplicate correction row.
- Same-PR capability-ledger entry with a host-search-optimized description.
- Voice surface: the verb joins the voice backend's tool allowlist
  (`VOICE_LLM_ALLOWED_TOOLS`, companion-backend.mjs on the droplet) — the enhancements
  session/successor's edit; ping at PR time.
- Doctrine text ("user corrects a name/fact → file via propose_correction, confirm at
  next check-in") is their surface — same-day co-ship per the #473/#479 pattern; ping
  at PR time.

**§8.3 Region briefs + license inheritance (amends §4):**
- Briefs are PULL-served ONLY; the packet carries pointers/counts, never brief bodies
  (v3.2 payload discipline).
- Min-of-chain license phrasing must survive the SPOKEN register in plain product
  language — the words "license" and "posterior" never surface in anything a
  companion says aloud (house law); hedging is expressed as natural speech
  ("my working read", "not fully confirmed yet").

**§8.4 Graded sessions as the outcome stream (amends §5/P4):**
Future session grades emit a machine-readable row per rubric axis (JSONL alongside
the prose report) carrying attribution ids (proposalIds per #466, qids per #452,
run/session ids). The autonomy-posterior machinery consumes that stream and NEVER
parses prose.

---

## §9 Networking-session review (2026-07-15) — no contests + two inherited design rules (BINDING)

Review verdict: §0.6 ruling restatement verified faithful to PR #167; identity +
question-grammar touchpoints confirmed; staked question arbitration unchanged.
**License inheritance ADOPTED for the envelope contract** (v2 amendment logged their
side: license tag on envelope sourceMetadata, min-of-chain on relay for answer/receipt
verbs).

Two live findings from their 2026-07-15 unattended re-run (evidence
`~/scratch/unattended-rerun-2026-07-15/`) are inherited here as design rules — paid
for once, never rediscovered:

**§9.1 Triage data is PRE-INJECTED, never model-elective.** A live compliance failure:
a pass's triage instruction was sequenced before the packet call that feeds it, and
the model never called the tool — it cannot triage a list it structurally never sees.
Rule for ALL passes in this brief (charter compose, groomer, region-brief refresh):
the RUNNER deterministically gathers the pass's input set (once-per-doc dedupe, the
postclose pattern) and injects it into the opening turn. A pass's agenda is runner
plumbing, not a tool call the model may skip.

**§9.2 Staged content is GROUNDED BY CONSTRUCTION — an autonomy-ladder invariant.**
Their live incident: a staged accept card summarized an answer as the exact STALE
value the answer refuted — one tap would have filed the opposite of truth. Linkage
grounding (right ids) is NOT enough. Invariant at every autonomy tier ≥ propose: a
staged artifact's claim text is EXTRACTIVE from, or deterministically
overlap-verified against, its receipts. The Beta posteriors govern WHO may stage
(§5); this governs WHAT a staging may say. This is the staged-content sibling of
anti-self-training and the judge ceiling.

**§9.3 P4 grading ground:** the Tier-1 persona rig (demo droplet) offers cheap
verified-outcome generation (~$0.05-0.08/pass, documented ground-truth seed ledger)
— the autonomy posteriors' first outcome stream need not wait on live-pilot grades.
