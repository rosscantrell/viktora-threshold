# WP-ONEQUESTION — the check-in question channel (design of record)

**Date:** 2026-07-13 · **Status:** CONTRACT — converged across three sessions
(work-forest categorization / MCP-companion enhancements / companion-network),
build dispatched · **Owner:** Ross · **Repo:** AI-Light-Prototype (engine only;
zero client changes in v1 — the routine prompts are deliberately thin and the
protocol is server-side).

**Problem, measured (live ross pilot, 2026-07-13):** the Question Engine is
deployed, enabled, and holding 9 questions that are precisely the work-forest
fixes (frame dedups: CR2≡Sora, Tokyo≡Sora, OG-CR1≡CR1/v3.1, EMF≡Initiative-
Rollout; Sora job-family absorptions) — and surfaces zero, because surfacing is
pull-only HTTP (`?pull=1` from a card affordance nobody clicks) and unreachable
from any MCP surface. One YES answer folds `confirm_fact` → alias/axis/boundary,
consumed by the grouping fold, the organizer prompt, and incremental placement —
it rewires the forest everywhere at once. The gap is transport.

**Thesis:** one question per check-in, asked conversationally by the companion,
answered in flow, folded immediately, receipted at the next check-in. The
attention budget is enforced structurally at the packet — not by companion
discipline — which makes this section the single choke point on human attention
for every present and future question source (engine QE, companion-filed, peer
envelopes after field-answer failure). Build it source-agnostic.

---

## §1 Binding conventions (from the enhancements-session contract)

1. **Optional top-level packet field, omitted when absent** — byte-identical
   steady state. Test-pin BOTH ways (present-with-content / absent-at-zero);
   PR #467's negative-controlled pin is the model.
2. **Payload discipline:** `qid` + SPEAKABLE plain-product-language question +
   expected answer shape + a ONE-LINE stake ("one yes rewires 82 jobs"). No
   evidence dumps — drill-down rides `get_record`/`get_receipts`. House law: no
   classifier internals ("CONFIRM_ALIAS" never surfaces; "Are CR2 Project and
   Project Sora the same thing?" does). Speakability is load-bearing: the voice
   chief-of-staff arc consumes this section first.
3. **Budget:** SHARED with the protocol's existing "max ONE up-front question"
   discipline — one question total per check-in across all sources. The
   protocol/doctrine amendment is the enhancements session's surface; ping them
   at PR time for the same-day co-ship.
4. **Answer path:** the exact same fold as `POST /api/decision-log/questions/answer`
   (shared function, not a copy), stamping `answeredVia:'mcp'` + `capturedBy`
   (the MCP-lane identity fallback, #416/#440) and reusing the mcpq factKey
   never-re-ask binding (#452).
5. **Tier declaration:** this is the first MCP write lane that mutates org-state
   (aliases/axis/boundary) without the proposal/ratify shape. That is CORRECT —
   the QE question IS the ratification affordance; the same human is answering
   the same question the app's own affordance poses. The PR must say exactly
   that so the authorization-gradient audit treats it as a deliberate tier
   decision. **`answer_question` is ANSWER-FORBIDDEN on every unattended pass
   whitelist** (prework/delta/closure/postclose may READ and pre-stage around
   it; only an attended session answers). `file_question` stays on the pass
   whitelists. Pin with the differential whitelist test.
6. **Receipt:** `oneQuestion.receipt` in the NEXT packet ("Since you confirmed
   CR2 = Sora, I filed 2 jobs there"), omitted when none. Doubles as the
   calibration proof surface.

## §2 The dequeue ladder (v1 arbitration — BOUND, do not re-litigate)

Strict source-priority ladder, NOT unified scoring. Rationale (paid-for): the
packet is a read surface — #467's stall class forbids admission recompute, LLM
calls, or anything super-linear in store depth at packet-build; and a
filedBy-tier prior × engine VOI are incommensurable scales (mistuned = silently
starves a source, unfalsifiable). Packet-build cost: O(store scan) +
deterministic joins only.

- **Tier 1** — filed questions that are URGENT-GATING by deterministic join:
  the question references record(s) whose **effectiveDue** (workback-overlay
  effective due, per the operator playbook — no heuristic urgency score) is
  overdue or due today.
- **Tier 2** — the engine QE pool in its native VOI order with its native
  ask-floor (via the pre-staged candidate, §3 — never computed at read).
- **Tier 3** — non-urgent filed questions, recency tiebreak (newest `filedAt`
  first; a pinnable choice, revisit against receipts).

Cross-cutting: never-re-ask (mcpq factKey + terminal store states) and snooze
respected across BOTH sources. **Filed staleness bound = 7 days** (matches the
weekly `mode:'review'` horizon): a filed question unasked for 7 days leaves the
ladder and returns to its FILER as a "still true?" (state `stale_check`,
exposed via `get_questions` with `needsRefile:true`) — never goes stale-hot to
the human. NO ask-floor for filed questions: the ladder position is the gate;
if fleet volume ever makes tier 3 a landfill, fix it at `file_question`
(per-companion quota), not at dequeue.

**Arbitration receipt (the earn-your-scoring instrument):** every packet build
that evaluates the ladder appends one compact structured line to
`reference/_metadata/question-arbitration.jsonl`:
`{generatedAt, lens, mode, t1Count, t2Present, t3Count, winner:{qid,source,tier}|null, passedOver:[{qid,tier}…]}`.
Unified scoring is designed later, against weeks of observed misprioritizations
— never against priors.

## §3 Architecture: stage on write, read pure

`generateQuestions` admission can touch LLM channels (evidence-sameness
adjudication; the judged-phrasing vote) — none of that may run at packet-build.
Therefore:

- **Write-path pre-staging.** A debounced, detached async producer computes
  admission (native VOI, ask-floor, judged phrasing — cached verdicts only,
  judge fired async when missing) and persists the top eligible ENGINE
  candidate into the question store as the staged tier-2 offer. Producers
  trigger on write events only: question answer/dismiss/snooze transitions,
  derived-cache refresh (the E4 hook), incremental-ingest post-hook. Same
  "this packet may be stale, the next is fresh" discipline as E4.
- **Packet build = pure store read.** Scan pending filed questions (T1/T3
  deterministic joins against in-memory records), read the staged T2 candidate,
  apply the ladder, emit the section, append the arbitration receipt.
- **Surfaced stamping:** carrying a question in a `mode:'live'` packet with
  `mark_seen:true` stamps its store state `surfaced` (the existing mark_seen
  write-on-read precedent). `prepare`/`prework` modes carry without stamping.
  `prework` mode NEVER carries `oneQuestion` (unattended; answers forbidden).

## §4 Contracts

**Packet section** (optional top-level `oneQuestion`, omitted when absent):

```jsonc
{
  "qid": "<factKey | filedId>",
  "source": "engine" | "filed",
  "question": "Are CR2 Project and Project Sora the same thing?",
  "answerShape": "yes_no" | "yes_no_members",
  "stake": "One yes files 2 jobs under Sora and stops split tracking.",
  "members": [{ "jobKey": "…", "jobName": "…" }],   // yes_no_members only, capped
  "receipt": { "qid": "<answered qid>", "summary": "Filed 2 jobs under Project Sora." } // prior answer's consequence; omitted when none; carried until delivered in a mark_seen live packet
}
```

**MCP tool `answer_question`** (scope: capture): params
`{ qid, answer: boolean, selectedJobKeys?: string[] }`. Validates `qid` is the
currently offered/surfaced question (the one the packet carried); refuses
otherwise with a typed refusal naming the current offer. Engine questions fold
`confirm_fact` + drafted moves via the shared fold; filed questions record the
answer store-side for the filer (unchanged HTTP semantics). Provenance per §1.4.

**Flag:** `CHECKIN_ONE_QUESTION_ENABLED` — default OFF, enrolled in
`pilot-full` as `'true'` in the same PR (drift gate). Produces only when
`ENABLE_QUESTION_ENGINE` is also on. Flag off ⇒ packet byte-identical, no
staging writes, tool returns capability-disabled.

## §5 Phases (small PRs, in order)

- **PR-1 (this dispatch): oneQuestion end-to-end** — staging producer, ladder,
  packet section, arbitration receipt, `answer_question` tool, receipts,
  whitelist pins, tests (both-way packet pins; ladder ordering incl. T1-beats-T2;
  staleness expiry; never-re-ask/snooze across sources; flag-off byte-identity;
  differential whitelist). Full suite + tsc baseline green. **Co-ship:** message
  the enhancements session at PR-open for the protocol amendment.
- **PR-2: jobless backfill** — second-pass prose-jobs over uncovered records
  only (fingerprint gains a coverage component), `PEER-` docs covered,
  "not yet filed" count in diagnostics + packet intake note
  (fail-closed-but-VISIBLE). Live pilot baseline: 115/936.
- **PR-3: split/dedup flow-through** — consume the compiler's `split_candidate`
  verdicts into QE split questions (suggest-only; corroboration required —
  never embedding bimodality alone); confirm the name-twin dedup channel's
  candidates flow (they are today's 9 held).
- **PR-4: capture-doc → authored-structure bridge** — index-extractor consumes
  the session-close capture format ("Action Items — <lens> — <date>", owner+due
  items under PROJECT HEADERS — the enhancements session's versioned stable
  contract) as authored category snapshots for `ENABLE_STRUCTURE_FIRST_ORG`.

**Out of scope here, tracked elsewhere:** per-frame companions (blocked on
WP-ORG-STATE-STABILITY / churn gate — see the dispatch brief of the same date);
`SOP_EDITS_ENABLED` + `LEARNED_FOLD_*` pilot flips (Ross's gate queue); voice
(enhancements arc); unified question scoring (earned via §2 receipts).

## §6 Acceptance (PR-1)

On a corpus copy with QE + flag on: (a) packet in live mode carries the top
held dedup question with speakable text + stake; (b) `answer_question` YES
folds confirm_fact + moves, `answeredVia:'mcp'` stamped; (c) next packet
carries `oneQuestion.receipt` naming the consequence; (d) the answered factKey
never re-offers; (e) a filed question referencing an overdue record outranks
the engine candidate (T1>T2 pin); (f) arbitration receipts appended each build;
(g) flag off ⇒ byte-identical packet (pin); (h) unattended passes cannot answer
(differential whitelist pin).
