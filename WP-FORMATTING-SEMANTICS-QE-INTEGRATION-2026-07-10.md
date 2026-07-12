# WP-FORMATTING-SEMANTICS — Question-Engine integration (Stage 4)

Goal (Ross, 2026-07-10): a strikethrough verdict that needs the user should ride the
**existing Question-Engine pull-card** — same surface, same "one good question" — and
**keep the VOI portion**: it earns the user's attention by expected value, competing on
the same scale as the frame questions. Seamless to the user.

## The two systems, and why we reuse the surface but not the frame engine
The QE (`decision-log/question-engine.ts`) is a value-of-information elicitation engine —
`L(q) = H·E_a[Δ]·G/C`, stakes-aware ask-floor (`admit iff H·stakes ≥ P20`). But its v1
generators (alias / axis / outline-diff) and its answer path (`answerEvents → OrgEditEvents
→ frame folds`) are entirely **frame/job identity**. A formatting question is **record-level**
(is this commitment done? is this deadline real?) — a different domain and a different apply.

So: **reuse the ranking scaffold + card + surface; add a new SOURCE; branch the answer.**

## Formatting as a first-class VOI source (`formatting-question-source.ts`)
Each strikethrough verdict that needs the user becomes a `QuestionCandidate` with honest VOI
computed on the **same scale** as the frame generators — so the merge is fair:

| term | frame generators | formatting |
|---|---|---|
| **pYes** | evidence-derived | ambiguous verdict ≈ 0.5 (asks); confident ≈ 0.9 (suggests) |
| **H** | `entropy(pYes)` | same function |
| **stakes** | fixed rungs (alias 2.0 / axis 1.5 / outline 1.25) | **record-aware**: base 1.25 + live-status + due-date (a false *live dated* item is the harm), clamped to the frame range |
| **E_a[Δ]** | simulate answer, re-run frame folds | **record-surface footprint** — a YES removes 1 live commitment / 1 false deadline from Today (formatting answers don't move placements, so no fold sim) |
| **G** | `1 + docShare` | `1 + in-doc recurrence` (a team's formatting grammar recurs → Phase-3 tie) |
| **C** | 1 | 1 (binary + both-futures preview) |
| **L** | `H·EDelta·G/C` | identical formula ⇒ **directly comparable** |

The VOI split falls out for free and matches the house ask-floor philosophy: **ambiguous
verdicts (high H) ask; confident verdicts (low H) fall below the floor and act as suggestions**
(the adjudication proposals from Stage 3b). For an ambiguous verdict the binary is framed as
*"is this item done or dropped — remove it?"* (suppress), NOT the model's specific guessed
effect (which may be wrong — that's why it routed to review).

## Seamless UI = card-DTO conformance (no frontend surgery)
`surfaceTop` + the phrasing judge + the `GET /questions` DTO are generic over
`QuestionCandidate` — they read `factKey/type/subject/object/card{question,why,yesPreview,
noPreview}/scores{H,stakes,EDelta,G,C,L,pYes}`. Formatting candidates populate exactly those,
so the **existing pull-card renders them unchanged**. (Any FE affordance to show the struck-
span evidence is Ross's one-pass; the base card fields already carry the question + both futures.)

## Answer → record effect (not a frame org-edit)
The answer route branches on `cand.type === 'CONFIRM_FORMATTING'`:
- **YES + suppress** → append a **standalone suppression overlay** (`capture-suppressions.json`,
  `reason: 'formatting-review'`) — the SAME fold-at-read chokepoint the double-capture dedup
  uses (`computeSuppressedRecordIds`), so the struck item stops surfacing. Event-sourced,
  undoable; the decision-log is never mutated. (`keptRecordId` made optional for the standalone
  case; the double-capture path is byte-unchanged — its 25/25 suite still passes.)
- **NO** → resolution recorded, the record stands.
- Either answer is a **HITL calibration signal** (the `[[threshold-hitl-capture-intent]]` loop).

## Wiring (all flag-gated `FORMATTING_INTERPRET_ENABLED`, OFF ⇒ byte-equal)
- `loadQuestionContext` (index.ts): after `generateQuestions`, build + ask-floor-admit +
  `mergeRankedByL` the formatting candidates into `ranked`. Frame VOI untouched.
- Answer route (index.ts): the `CONFIRM_FORMATTING` branch above.
- Additive type extensions: `QuestionType += 'CONFIRM_FORMATTING'`, `factType += 'record_status'`,
  optional `QuestionCandidate.formatting` descriptor; `CaptureSuppression.reason += 'formatting-review'`.

## Tests (hermetic) + status
`test-formatting-question-source.ts` **11/11**: VOI on-scale + `L=H·EDelta·G/C`, ambiguous-asks
vs confident-suggests, ambiguous→suppress phrasing, stakes record-awareness, stable factKeys,
non-actionable effects yield no candidate, ask-floor admits the high-value ambiguous, merge
ranks by L, and a `formatting-review` suppression folds (hides the record). Regressions green:
double-capture 25/25, interpret 14/14, adjudicate 11/11, phase-1 17/17, email-parse 11/11,
drift 14/14. Touched files tsc-clean.

## Honest edges (designed, not yet done)
- **Live pull/answer loop** unverified end-to-end here (needs the running engine with frames +
  QE enabled + a corpus); the pieces are unit-proven and DTO-conformant.
- **clear-deadline apply** on YES rides a date overlay (follow-up); today the question surfaces
  and records the answer, but the deadline-clear itself is deferred to that overlay.
- **Unified ask-floor**: formatting candidates are floored on their own distribution then merged
  by L (not a single combined-set floor) — a fair approximation; a combined floor is a refinement.
