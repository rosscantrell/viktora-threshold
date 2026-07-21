# HANDOFF — companion-coherence / session-grading lane — 2026-07-21 morning

**The durable state lives in memory** — `companion-coherence-ruling` (read its
TUE 07-21 MORNING EVAL block first; it is current as of this handoff),
`mcp-agent-endgame-arc` (incident ledger), `wing-production-arc` (neighbor
lane). This doc is the operational snapshot only.

## Deployed state
- Engine: `2ef2ccc` (release 20260720-174601) on ross.viktora.ai — all five
  coherence phases (L0 map v1.1.0 / registry 15 obligations / gates /
  mechanical grades 10 axes / doctrine at 5 judgment invariants), cursor,
  reconciliation, intake signal/noise split, walk fixes, bulk dispositions.
- Voice backend: turn budget 75s, buffer cooldown, system-map block, and — new
  this morning, **b268fa4 md5-verified** — postcall capture is FALLBACK-ONLY
  (skips when an in-call capture landed in the 45-min window; fails open).
  **WATCH ITEM: today's first healthy call close must produce ONE capture.**
- ElevenLabs agent max_duration_seconds=3600 (was 600 — the 10-min cut class).
- `VOICE_CONTINUATION=brief` still pinned — transcript-ladder day-filter +
  cache-cap bugs remain UNFIXED (queued build; restoring Grade-1 same-mind is
  a real UX win waiting).

## The work order (successor's queue)
1. **RATIFY SURFACE** (lead build; Threshold UI = one-pair-of-eyes with Ross).
   Ratification debt (~30 taps) now causes live misinformation (the KPI
   false-negative). Banked design findings: collapse per (record,verb),
   auto-expire proposals on superseded records, a DECLINE verb, batch-tap,
   typed contracts threading proposalId (the #466 follow-up), reason
   projection. `pendingProposal` row data is already served (#558).
2. **Grade the day** from the stream (`get_session_grades`; probes use
   `probe:true` or `mode:prepare` — NEVER bare live serves). 7-day
   directive-adoption measurement runs to 07-24 night: denominator = serves
   carrying a dayGraph directive, numerator = coordination-view met, bar ≥80%;
   under the bar = design finding → voice-side mustSpeak mechanic, never a
   window extension.
3. **Small queued builds**: empty-stub class (174-byte Plaud transcripts →
   "transcription failed" health signal, never arrivals); self-report-accuracy
   axis (join spoken failure claims vs the tool ledger — 3 instances banked);
   overnight-division-minted axis (with WING).
4. **Obligations to neighbors**: register line for WF's name-asks build when
   they ping (keyed on their `unnamedOwners` packet field, one-home, derived
   registers); corrections-refusal text already delivered to them; Phase-1
   grade-axes co-design with WING (plan-written/review-passed/
   evidence-ledger-closed/provenance-receipted; review-passed joins
   OutboxItem.review).

## Ross's own pending taps (surface these, don't nag)
- Dismiss the **4 misuse corrections** (record-consolidations filed as
  entity-alias) BEFORE the groomer ever arms; the 5th (Ailea Richter
  spelling) is legitimate.
- The ratify queue (~30) — the lead build exists to shrink this.
- 12:30 demo deck was ready in outbox `aadec832` (built Mon 17:16).

## Paid-for gotchas (beyond what memory carries)
- Decision-log records key their doc as `documentId` NOT `sourceDocumentId` —
  wrong-field forensics look exactly like silent extraction loss.
- Integrity gate: export INGESTION_API_KEY into the shell AND warm
  `/api/decision-log?full=1` (cold >30s vs 10s gate budget).
- Engine env = `/opt/apolla/.env` (not app/.env); profile flags expand
  in-process (never visible in pm2 env — verify behaviorally).
- Harness scripts on the droplet: invoke via `bash` (shebang fix #551 merged
  but only reaches the droplet on the next deploy).

## Coordination map (message these sessions, boundary contracts standing)
- **Work-forest lane** = "Work-forest coordinator operator handoff"
  (local_122db152-64b0-4b1d-a6aa-8b7b8be27b83): identity/canon, QE,
  day-graph operators, doctrine co-ship. In flight: name-asks filed-questions
  build, propose_correction payload validation, entity-assignment policy
  note, capture-mint dedup design (fixtures: Keith×5 + the Rob double-mint
  pair).
- **WP-WING lane** = "WP-WING-PRODUCTION setup"
  (local_9fb046b3-c3ce-45d5-8602-3cdae81efcbc): Phase 1 = worker process
  (arch B) + droplet resize + the four grade axes + blocked-retry backoff +
  plan-item mint dedup.
- Voice click-to-talk V1 = its own lane (threshold PR #197, Ross-at-mic
  acceptance pending).
