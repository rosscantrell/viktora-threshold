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
