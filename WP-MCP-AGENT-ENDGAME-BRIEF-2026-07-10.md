# WP-MCP-AGENT-ENDGAME — Handoff + Kickoff Brief (2026-07-10)

The "close the loop" arc: turn the check-in brief from a surface a human reads
into an **agenda an agent works**, over the Apolla MCP surface, with voice I/O,
capturing its work back into the knowledge field as HITL-gated substrate.

Sequencing note: this is the **next arc, after the pilot ships** (merge the 4
open PRs → fix the vigilance reply-suppression → deploy + cut the release). It is
scoped here so it can start clean.

---

## PART A — HANDOFF: what we've already looked at

### The vision (Ross, this session)
The morning/mid-day/evening digest is the agenda. An agent, given the tools in an
AI surface (claude.ai or any MCP host), determines **what it can actually take
on**, **what supporting docs to pull from the knowledge field**, starts tackling
items, and **asks the user back specific gap-questions** — e.g. *"I'm following up
with People for a kickoff date but don't see your calendar — what's your
availability?"* — spoken by a **voice model**. Everything it does goes **back into
the knowledge field as another artifact + HITL item**, so the work compounds.

### The loop, mapped to what's ALREADY live (verified this session)
Read `get_state_of_play` live against a real 349-record corpus; the tool
descriptions confirm the plumbing was designed for exactly this.

| Loop stage | Live tool / mechanism | State |
|---|---|---|
| Read the agenda | `get_state_of_play` / `get_commitments` ("machine-actionable… compose a workback plan downstream") | ✅ live |
| Decide + pull supporting docs | `search_records`, `get_entity_card`, `get_receipts`, `ask_question` | ✅ live |
| Compose across other tools | designed for it — docs literally say *"hand the list to an Excel MCP to build the tracker"* | ✅ pattern intended |
| Capture back as artifact + HITL | `ingest_doc` — labeled **"THE CLOSED-LOOP BRIDGE… `reviewedBy` required; Apolla never auto-emits agent drafts"**; provenance round-trips into the marker substrate; a `boardwalk-agent` source already exists | ✅ built, HITL-gated |

**Takeaway:** the knowledge-field side is a connected, HITL-gated, provenance-
carrying API. The human surface (the check-in brief, Tier B) is built. The
vigilance "what am I missing" catch (`ingress-owed`) is verified end-to-end. So
the loop is ~80% scaffolded.

### The refinement Ross added — capture the WORK, not just the output
`ingest_doc` captures the **emitted artifact** (the email that was sent). But the
**work itself** — what the agent referenced, concluded, drafted, and got stuck on
— must also become first-class, referenceable substrate. Otherwise the reasoning
evaporates and every run starts cold. Value:
- **Reference** — future runs see *"already drafted Tuesday, blocked on the
  calendar, awaiting her answer"* via `search_records`/`get_entity_card`. The
  agent's memory IS the knowledge field (no separate memory store).
- **Contribute** — the work feeds markers/synthesis instead of dying with the session.
- **Impact HITL** — the work-summary lands in the ratify inbox; the human reviews
  *what the agent did and why*; their confirm/adjust/answer is the calibration signal.

### The guardrail (non-negotiable)
Agent-authored substrate must be **provenance-marked and weighted as agent-work,
never as human ground-truth.** Otherwise the agent's own summaries feed the very
HITL/calibration signal they're meant to inform — the model learns from its own
output and the loop poisons itself. Same trap as the `deprioritized`-reason
calibration issue: contribution/reference is fine, but it must be gated OUT of the
human-signal calibration path. `ingest_doc` already stamps `source:
boardwalk-agent`; the work-record extends that so downstream weighting can tell
"the agent said this" from "a human decided this."

### What's genuinely NET-NEW (the gaps to build)
1. **Orchestration loop** — agent reads a check-in lens → decides what it can
   action with the tools it has → pulls context → drafts → detects gaps.
2. **Gap-question as a first-class outbound** — an *action-blocked-by-gap*
   question type (distinct from a corpus Q&A). Its answer captures back and
   **unblocks the task**: ask → spoken answer → artifact + HITL → task resumes.
3. **Voice I/O** — a voice model reads the check-in aloud and speaks/hears the
   gap-questions.
4. **Brief → agent trigger** — morning/mid-day/evening kicks off an agent run over
   that lens's items (same gentle-ping cadence Trisha asked for).
5. **Work-record contribution** — a sibling to `ingest_doc` that records the
   agent's trace (goal · referenced records · produced artifacts · open questions
   · disposition), entity-anchored, provenance-marked, landing as a HITL item.

---

## PART B — KICKOFF: the work to start

### North Star for the first milestone
On a check-in, an agent (running in an MCP host) reads the day's agenda, picks one
actionable item, gathers its context from the knowledge field, drafts the next
action, hits a real gap, **asks the user one specific spoken question**, and — on
the answer — completes the action and **writes both the artifact and a work-record
back**, HITL-gated. One item, end-to-end, is the milestone.

### Phased plan (each phase is one runnable slice; stop-and-review between)
- **P0 — Agent-over-MCP, text only (no voice).** A harness that: `get_commitments`
  → picks one → `get_entity_card`/`search_records` for context → drafts the
  follow-up → detects the gap → emits a *text* gap-question. Proves the reasoning
  loop against the live MCP. No new engine code — pure orchestration.
- **P1 — The capture round-trip.** Wire the answer path: the user's answer →
  `ingest_doc` (the artifact) **and** a new **work-record** contribution (the
  trace). Confirm both re-enter the field and are discoverable by a second run
  (continuity / no-duplicate-work). Adds the work-record tool + provenance/weighting.
- **P2 — Gap-question as a typed HITL item.** Promote the gap-question to a
  first-class outbound that lands in the ratify inbox and, on answer, unblocks the
  task. This is where "impact HITL actions" becomes real.
- **P3 — Brief → agent trigger.** The check-in (morning/mid-day/evening) kicks off
  the P0–P2 loop over that lens's items; results surface in the brief/Waiting-on.
- **P4 — Voice I/O.** Layer a voice model over the same loop: read the check-in,
  speak the gap-question, transcribe the answer. Delivery only — sits on top.

### Design decisions to lock before P1
- **Work-record schema** — fields (goal, referenced recordIds/entities, produced
  artifact ids, open questions, disposition ∈ {done, blocked-on-X, pending-review}).
- **Provenance/weighting** — how downstream calibration distinguishes and
  down-weights agent-work vs human decisions (extends `source: boardwalk-agent`).
- **Gate model** — emitted artifact = `reviewedBy`, approve **before** send;
  work-record = agent-authored, **post-hoc** review. Two classes at the bridge.
- **Agent identity** — who the agent acts *as* (the `boardwalk-agent` identity vs.
  the authenticated viewer); tie to email-login when available (the vigilance
  `resolveUserSlug` heuristic has the same open question).

### Guardrails (carry from this session)
- **HITL is the safety.** No outbound send without human approval; `ingest_doc`
  already enforces it. Agent proposes; human ratifies.
- **Never let agent output become ground-truth.** Provenance-mark + weight all
  agent-authored substrate out of the human calibration path.
- **Precision-first on what surfaces.** The gap-questions and agent actions inherit
  Trisha's trust bar — under-fire rather than nag.

### Dependencies / sequencing
- **Blocked-until:** the pilot ships (4 PRs merged, vigilance reply-suppression
  fixed, deploy + release). Don't start P1+ until the substrate this writes into is
  the deployed one.
- **Feeds from:** the check-in brief (Tier B, the agent's agenda) and the vigilance
  `ingress-owed` catch (the "what am I missing" items the agent acts on).
- **Note:** interactively-authenticated MCP hosts (claude.ai) may be absent in
  headless/cron runs — design the trigger (P3) accordingly.

### First concrete step (when we pick this up)
Write P0 as a thin orchestration script against the **live Apolla MCP** (the tools
are already connected): one item, `get_commitments` → `get_entity_card` → draft →
gap-question, text only. It needs **zero** new engine code and immediately shows
where the real gaps are — the fastest way to make the endgame concrete.

---

## P0 DRY-RUN — executed 2026-07-10 (live MCP, Ross corpus, 349 records)

Ran the full P0 loop in-session against the live connector (agent = the session
itself as orchestrator; zero new engine code, read-only). Item picked:
`dd6191131ed029f1` — *"Ross Cantrell to schedule Gotham read-in on IPA4/IPF4
status on or after June 18"* (owner ross-cantrell, 22 days overdue, 25 silent).

**Loop trace:** `get_state_of_play` (349 open; 15 needs-attention) →
`get_commitments due_within_days=14` (59 open, 20 overdue-silent) → picked the
Ross-owned still-actionable item → `get_record` (edges: none) + `get_entity_card
ipa4` (6 open items — GI-focus decision, 8-week concept scope, one-box/OTA
questions, Sora→TPP→FY2028 frame, Hamburg meeting) → `search_records "gotham"`
→ **1 hit: the commitment itself.**

**Draft it could compose (receipts-backed):** a read-in invite with a real agenda —
Sora→TPP/off-cycle-SFBP goal, GI focus (SE under review, Bollinger sponsorship),
8-week user-story + business-story concept, one-box-vs-multi-box + OTA questions,
Muecher×Griffith Hamburg readout. The field genuinely carried enough for a
credible draft.

**Gap-questions it had to emit (3 distinct classes — the finding):**
1. **Identity/field gap** — *"Who is Gotham — a person, team, or codename? The
   field has no other record of them. Who should be on the invite?"*
2. **External-state gap** — *"I don't see your calendar — what's your
   availability?"* (the brief's canonical example, hit for real on item #1).
3. **Staleness gap** — *"This is 22 days overdue and the newest substrate is
   June 17 — did the read-in already happen off-corpus?"* NOT in the brief's
   net-new list; add it. It's the agent-side mirror of vigilance reply-suppression:
   before acting, check `silentDays`/`mentionsAfter` and ASK rather than re-do.

**Substrate findings (feed P1+ design):**
- **Corpus freshness is the #1 practical blocker** — newest docs ~June 17 vs
  today July 10, so nearly every item's first honest question is "already done?".
  Ingest cadence (Plaud sync) buys more than orchestration sophistication.
- **0 of 349 records resolved** — the field records openings but almost never
  closures, so the agenda only grows. The work-record/artifact round-trip (P1) is
  ALSO the closure channel: agent work should be able to `resolves`-edge the
  commitment it discharges (HITL-gated), or the agent's agenda never shrinks.
- **`speaker-N` owner slugs** (unresolved diarization) pollute owner-load and
  make owner-scoped agenda pulls miss items — WP-IDENTITY-REGIME dependency.
- The read tools compose cleanly; nothing in P0 needed a write. P1 (capture
  round-trip) correctly remains the first thing that touches the deployed
  substrate — still blocked on the pilot shipping.

---

## PART C — DESIGN LOCKED 2026-07-11: the field is the coordination plane

Ross's async-after-debrief ruling ("I finish the debrief, then the agent works
async to me"), generalized in-session and locked. This section supersedes any
session-choreography framing: the design is NOT a scripted sequence of check-in
phases — it is **two workers sharing one corpus**, coordinating through the
knowledge field itself. The operators, HITL lanes, and capture machinery ARE the
coordination layer; the check-ins are reconciliation points against shared field
state, not agendas the agent recites.

### C1. The core loop (division of labor through the field)

The heart: user + AI review the work needing to be done and divide-and-conquer
it. The AI arrives having done the prework — what needs doing, options per item,
drafts where preparable, and **targeted questions** needed to finish. The
attended session gets those answers, affirms/amends the approach, and produces
the plan. Then both work async through the day, coordinating via the other
check-ins.

- **The day-plan is a MINT, not a document the agent keeps.** The session-close
  capture mints the agreed division of labor as commitments with
  `owner ∈ {user, apolla-companion}`, `depends_on` edges encoding handoffs, dues
  encoding sequencing. PROVEN end-to-end with zero new engine code (:3030
  mint-lane verification: apolla-companion as owner, auto-minted `depends_on`
  human-review→agent-draft, `supersedes` closing amended items).
  **Commitments between the user and the AI are literal commitments in the
  field** — same substrate, same operators, same lifecycle as every other
  obligation.
- **Async = each party working its OWNED items; the field learns without
  either party reporting.** Agent completions flow back through the human-gated
  lanes (outbox, ratify inbox, prework staging) and captures. USER completions
  flow in passively through the intake channels (Plaud, email sweep, OneDrive,
  calendar) — by midday the field already knows the Maria call happened because
  the recording landed. No status reports in either direction.
- **A check-in is a RECONCILIATION, not a list**: diff the plan-of-record
  against field state now. What moved (`resolves`/`supersedes`), what stalled
  (dependency voids — vigilance already detects them), what became newly
  actionable (cleared edges — inverse of the void trigger), what needs
  renegotiation. Every signal is an existing operator reading; the playbook
  already teaches the interpretations. Renegotiation is free: a midday
  amendment is a capture whose `supersedes` closes the stale version.
- **Async execution safety invariant**: post-close agent runs write ONLY to
  lanes that terminate in a human action — outbox (user sends), ratify inbox
  (user ratifies resolve/re-date/link), `stage_prework` (re-conferred next
  morning), and apolla-companion continuation commitments *already agreed in
  the captured plan*. Never third-party sends, never direct resolves, never
  un-gated substrate. Mechanically: post-close execution is a SEPARATE
  scheduled run that reads the minted plan from substrate (claude.ai sessions
  can't keep working an idle chat; the capture is the only handoff channel —
  the plan IS the substrate, no in-memory handoff).
- **Every check-in gets an async wing, same shape.** Morning's approvals
  finalize → outbox before midday; midday presents morning's results; the
  evening wing additionally stages tomorrow's prework (the cycle's hinge —
  this is the loop that ran live 2026-07-11 and graded A-). Double-execution
  guard: the async wing reads outbox/ratify/staging state as an INPUT and
  skips anything already queued — explicit precondition, not hash-collision
  luck.

### C2. The second organ: incoming-commitment triage (equal or greater weight)

SEPARATE from plan reconciliation: the AI must raise **new and incoming
commitments the user may not have seen**. Different function (sensing, not
coordinating), different failure stakes — missing a plan step costs an
afternoon; missing an incoming commitment is the Brian/June-30 class of
failure. It is a **standing first section of every touchpoint** ("since we
last spoke, these arrived; two create obligations you haven't acknowledged"),
never an agenda item competing with plan work. Inputs all exist: intake
arrivals, `newSince` watermark, vigilance ingress-owed voids, readiness
due-soon on freshly-minted records. The net-new piece is the triage judgment —
"new information" vs "new obligation on you" — presented with the field record
as receipt.

**Interrupt gate (Ross ruling): raise-before-the-next-check-in is an OPERATOR
COMPOSITION evaluated at mint time, not a new classifier.** The check-in
schedule supplies the threshold: raise now iff waiting costs feasibility, or
the item perturbs the active plan.
- `effectiveDue` + readiness: goes at-risk (or born at-risk) before the next
  scheduled touchpoint ⇒ raise.
- workback: prep chain must start before the next touchpoint ⇒ raise.
- PRIORITY/stakes: high-stakes earns the ping even with runway (thinking time,
  not just execution time).
- `depends_on` vs today's plan-anchor: incoming item blocks/re-scopes active
  plan work ⇒ strongest raise-now signal (it invalidates work in flight).
- ingress-owed / named-you: someone is now waiting on the user.
Everything below threshold HOLDS per fail-closed-but-VISIBLE: counted, led in
the next check-in's incoming section; a ping that fires carries the count of
what didn't cross ("this needs you now; 3 more holding for midday").
Mechanically cheap: intake already mints through standard extraction (operators
run anyway), the routine schedule is known, ping/✦ is the designed interrupt
door. One new decision site: a post-mint join.

### C3. Plan memory: the anchor hierarchy + the review horizon

**LOCKED: the morning capture doc is the record-set anchor** defining "today's
plan" membership — the reconciliation (and C2's perturbs-the-plan check) joins
against it. Because anchors are dated capture docs, **plans accumulate as
substrate history automatically** — by Friday the field holds five day-plans
plus their supersession chains. No plan database; the memory is more field.

The hierarchy already exists as layers of the same shape (record-set + anchor),
and the reconciliation primitive — diff a plan's record-set against field state
— applies at every horizon (this is also Trisha's reconciliation wedge:
corpus-diff of a human's plan; the machinery is dual-use):

| Horizon | Structure | Anchor | Served by |
|---|---|---|---|
| Project | Work Forest frames | record-set anchor (stability-brief identity) | `get_state_of_play` |
| Deliverable | Workback plans | the deliverable record | `get_workback_plan` |
| Week | Weekly task lists | the list doc | intake/ingest |
| Day | **Day-plan captures (new)** | the morning capture doc | the C1 loop |
| Atom | Commitments + decisions | themselves | `get_commitments`, log |

**Longitudinal review signals** (reads, not new structures):
- **Carry-forward chains** — an item in N consecutive day-plans without
  resolving = stuck-work detector (the day-plan mirror of the cascade
  chronic-restatement discovery). Computable from anchors + resolution state;
  needs item identity across generations = read the restatement/dedup
  machinery's output as a counter.
- **Workback slippage** — planned step dates vs actual resolution across the
  chain = schedule drift per deliverable, with receipts.
- **Project starvation** — join the week's resolves back to frames; silence at
  project grain licenses a QUESTION ("Hamburg got zero attention — deliberate?"),
  never a conclusion (playbook rule at a new altitude).
- **Decision follow-through** — decisions whose implied commitments never
  materialized/moved; the log holds both ends, nobody has run the join.
- **Plan-vs-plan drift** — Monday's week-plan vs what Friday's day-plans
  actually contained = where reality renegotiated the week silently.

Delivery: a **review horizon of the packet** (`mode:'review'` — weekly retro /
Monday planning open; same compiler pattern, different window + joins). It
probably earns its own touchpoint rather than cramming midday's 3-decision cap.
Sequencing: the daily loop ships FIRST; the review lands a week+ behind it
essentially free — by then real lineage exists, and the first Friday retro over
a real week is the live test.

### C4. THE CAPABILITY LEDGER (Ross requirement, 2026-07-11)

We are giving the agent a massive tool list; effectiveness requires the agent
to know **when to reach for what and which questions each capability can
unlock**. Keep a LEDGER of every capability — including everything in this
section as it ships — and expose it through the MCP itself.

- **Home**: the capability gateway registry (already the single choke point —
  every capability is a registry entry per the standing rule). Extend each
  entry beyond name/description/schema with business-selection metadata:
  - `purpose` — what business need it serves, in plain product language;
  - `whenToUse` — the triggering situations, written for BOTH the host's
    relevance search and the model's judgment (extends the PR #419 lesson:
    descriptions are a deployment surface);
  - `unlocks` — the concrete questions it can answer / states it can change
    ("who is waiting on me?", "is this deliverable's schedule slipping?",
    "queue this draft for the user to send");
  - `composesWith` — the recipes it participates in (anchor→edges→receipts…),
    so selection knowledge chains into procedure.
- **Served by `list_capabilities`** (enriched), and — per the standing
  stale-cache rule — surfaced through RESPONSE payloads of high-traffic tools:
  the check-in packet's protocol section points at the ledger for item-type →
  capability routing, so even a stale-cached client learns the map from the
  packet it already fetches.
- **Three knowledge layers, now complete**: the RECIPE teaches procedure (how
  to traverse), the PLAYBOOK teaches interpretation (what readings mean), the
  LEDGER teaches **selection** (which capability serves which business need).
  The packet protocol references all three.
- **Maintenance rule**: a PR that adds an MCP capability MUST add its ledger
  entry (purpose/whenToUse/unlocks/composesWith) in the same PR — same
  discipline as the pilot-full flag-parity gate; a drift test should enforce
  registry-entry completeness.

### C5. Build queue implied by Part C (ordered; re-ordered 2026-07-11, Ross;
### items 1-4 SHIPPED + DEPLOYED to ross.viktora.ai same day)

1. **Capability ledger (C4) + `propose_to_outbox`, PAIRED in one slice** —
   ✅ **SHIPPED: engine PR #439** (merged + live). `McpCapability` gains
   purpose/whenToUse/unlocks/composesWith, all entries backfilled, drift test
   enforces the same-PR rule, `list_capabilities` serves the ledger, packet
   carries a compact LEDGER_POINTER. `propose_to_outbox` shipped as the first
   capability under the rule — WITH ARTIFACT PAYLOADS (handoff §5 hard
   requirement: outbox-artifacts store lane, 512KB/file + 2MB/call caps,
   the deck+pre-read "hold ready-to-send" live case is a named test).
2. **Agent closure lane** — ✅ **SHIPPED: engine PR #438** (merged + live).
   `propose_record_edit` (resolve / re_date / link); every verb an INERT
   HITL proposal (`action:'propose'`, `proposedBy:'mcp-agent'`) — test-pinned
   that a proposal never silently flips a record resolved; closure applies
   only at human ratification through existing machinery.
3. **Plan-anchor join in the packet** — ✅ **SHIPPED: engine PR #440**
   (merged + live). `todaysPlan` reconciliation section: anchor = today's
   session-close capture doc(s) (adapter provenance + title convention),
   diff = moved/stalled/newlyActionable/stillOpen + byOwner(user/companion),
   payload-capped, honest `present:false` when no plan was captured.
   Live-verified day one: found the real 2026-07-11 debrief capture,
   planCount 11. Also carried the captureSource adapter-fallback fix.
4. **`mark_seen` fix** — ✅ **ALREADY ON MAIN** (v3.2 "honest watermark",
   commit 9d1eaba, predated the brief) — verified, not re-implemented.
5. **Post-mint interrupt evaluation** (C2 gate) + ping delivery through the
   ✦ door, with the held-count per fail-closed-but-visible. NOT built (wants
   a design pass on ping delivery first).
6. **`mode:'review'` horizon** — after a week+ of real day-plan lineage.

Also shipped in the same sweep: engine PR #441 (reenrich endpoint bearer-gate
fix — the #414 bug class, found live re-enriching the 2026-07-10 capture docs;
audit-pinned both directions). Deployed state: ross.viktora.ai runs 8b00356 —
18 MCP tools, full ledger, todaysPlan live, lazy-boot (#437) killing the
deploy-502 class, both 2026-07-10 capture docs re-enriched (Maria status
minted without re-asking).

Not on the list, by design: no new session structure, no orchestration
framework, no plan format, no separate memory store. The collaboration depth
comes from the field doing what it already does, with both parties first-class
in it.
