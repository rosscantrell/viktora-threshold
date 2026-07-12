# WP-FORMATTING-SEMANTICS — Span-aware Interpretation (Stage 3) design

Follows the Phase-1 preserve/represent build (`formatting.ts` + spans on the record).
Stage 3 = turn the preserved formatting spans into a *meaning* the pipeline can act
on — without ever confidently minting the wrong card. Grounded in a live LLM
experiment on Trisha's real fixture (2026-07-10).

## What the experiment settled (6 real cases × 3 context levels, sonnet-tier)

| | L0 fragment only | L1 full line + strike | L2 + color + breadcrumb |
|---|---|---|---|
| **Correct** | 0/6 | **5/6** | **5/6** |
| **Confident-wrong** | **0** | **0** | **0** |

Three load-bearing findings:

1. **Zero confident-wrong at every level.** When the model lacked context it said
   *"unsure"* (5/6 at L0) and named what it needed — it degrades to honesty, not
   hallucination. This is the property the whole feature depends on and it *held*.
2. **The whole LINE is the context that matters (L0→L1 = 0/6→5/6).** The
   disambiguators are plain text sitting next to the strikethrough — the word
   "done", "as able", the note "I combined this bullet", the alternate date "7/10".
   A struck *fragment* alone is useless; the *line* is almost sufficient.
3. **Color + breadcrumb barely moved the EFFECT call (L1=L2=5/6).** Color's real
   value is **authorship** (Phase 3) and the breadcrumb's is **job-anchoring** — the
   effect (done/cancelled/removed/changed/edit) is carried by the line text. So the
   classifier must NOT depend on color.

The one case that stayed *"unsure"* even at L2 — a whole line struck through with **no
adjacent explanation** (genuinely ambiguous: done vs. cancelled vs. moved) — is the
**designed review-affordance trigger**: surface it to the human, never guess.

## Architecture — propose-then-verify, never silently mutate

Mirrors the house `model-proposes / math-disposes` discipline (ingress-magnet) and
the fail-closed-but-VISIBLE law.

```
formatSpans (Stage 2)                      content (cleanText)
        └──────────────┬───────────────────────┘
        buildInterpretationUnits()   ← PURE, deterministic
        (group strike spans by LINE; attach indent-derived breadcrumb + the
         referenced sibling-above; carry same-line color/notes)
                       │  one unit per line that carries a strikethrough
        renderUnitForClassifier()    ← the L2 representation the experiment validated
                       │  "Under: A › B › C\n<line with ~~strike~~ and [color] tags>"
        classify()  (LLM, injected)  ← proposes: effect + confidence + evidence quote
                       │
        VERIFY (deterministic):
          • evidence quote must be a REAL struck span in the record (else review)
          • whole-line-struck + no note/replacement ⇒ FORCE review (case-2 guard)
          • unsure / low-confidence / needsMoreContext ⇒ review
                       │
        LineInterpretation[]  → persisted additively (sourceMetadata), NOT applied
```

Key decisions:
- **Context unit = the full line**, plus the parent breadcrumb (for anchoring) and,
  when a note references "the one above" (the merge case), the sibling line — because
  *acting* on a merge needs the target, not just the label. Fragments are never sent.
- **Scope Stage-3 to strikethrough effects.** Color = authorship = Phase 3; do not
  interpret it here (matches finding 3). Color is passed to the model only as
  confirmatory context, never as the basis of a decision.
- **Additive, no record mutation (yet).** The layer emits per-line verdicts +
  evidence + a `routeToReview` flag; it does NOT delete/rewrite extraction records.
  Applying a verdict to a record (suppress a cancelled task, drop a struck deadline)
  is the *next* step and MUST be human-ratified — an interpretation must never become
  calibration ground-truth without confirm (brief guardrail).
- **Off the fast-ack path.** Runs in enrichment (async, fire-and-forget), never on the
  synchronous capture path — the LLM call must not reintroduce the 27s WebView timeout.
- **Flag-gated** `FORMATTING_INTERPRET_ENABLED`, default OFF ⇒ byte-equal, zero LLM.
  Added to `pilot-full` + the drift-gate allowlist for parity. HOLD flipping it live
  until the review surface exists — a verdict with no review affordance is a silent
  reinterpretation, exactly what the governing risk forbids.

## EffectLabel (from the experiment's enum)
`done · cancelled · merged-removed · active-deadline-removed · active-deadline-changed
· active-edit · active-unchanged · unsure`. Each verdict carries `deadlineStatus`
(none / a date / unclear), `confidence`, `evidenceSpans`, `routeToReview`, `reasoning`.

## Live validation (2026-07-10, real Claude, real fixture) — earned three fixes
Running `classifyWithClaude` for real (not the stub) changed the design:
1. **Representation:** wrapping colored text in a generic `[edit]…[/edit]` tag HURT —
   it hid that a colored word is often the replacement *content* ("done", the new date
   "7/10"), dragging those to "deadline-removed". Fix: render colored text as PLAIN
   text, keep only `~~strike~~` (matches the experiment's best representation, and
   finding #3 — color is confirmatory for the effect, not load-bearing).
2. **Prompt:** the terse module prompt underperformed the experiment's framing. Fix:
   the system prompt now enumerates what each effect *means* (general definitions, not
   case hints). After both fixes: the real misfire (`done`) classifies correctly; the
   residual disagreements are ground-truth quibbles (unchanged-vs-changed, same
   outcome) and multi-strike lines (a valid alternate effect).
3. **Confirmed the guard end-to-end:** on the whole-line-struck cancelled line the LLM
   actually guessed WRONG — and the deterministic `routeToReview` guard caught it and
   surfaced review instead of acting. The safety property is real, not theoretical.
Known limitation (noted, not fixed): a line with MULTIPLE strikes of different effects
(word-edit + deadline-removed) gets ONE verdict — per-strike verdicts are a future step.

## What ships in this increment (report, do not merge)
- `server/ai/formatting-interpretation.ts` — pure unit builder + validated (plain-text)
  renderer + propose-then-verify orchestrator (LLM `classify` injected) + the live
  `classifyWithClaude` via `getClient`, **now live-verified**.
- `server/ai/decision-log/formatting-adjudicate.ts` (Stage 3b, **BUILT**) — pure
  `adjudicateRecords`: joins verdicts to records by `verbatim`↔line overlap and emits
  typed PROPOSALS (`suppress` for done/cancelled/merged · `clear-deadline` for removed ·
  `review-deadline` for changed · `review-ambiguous` for routed verdicts). `previewAdjustment`
  shows what a confirm WOULD change. Mirrors `collapseDoubleCapturesAtIngest`: never
  mutates the event-sourced log; status is always `'proposed'` (human-ratified apply).
- Flag-gated (`FORMATTING_INTERPRET_ENABLED`) calls: interpretation in `enrichDocument`
  (off the fast-ack path) + adjudication after `upsertRecords` in `runEnrichmentPipeline`.
  OFF (default) ⇒ byte-equal, zero LLM. Verdicts + proposals persist to two sidecars.
- Hermetic tests: interpretation 14/14 (units/routing/case-2 guard/fail-closed/roundtrip),
  adjudication 11/11 (join + no-cross-match + typed proposals + preview + roundtrip).
  Live end-to-end verified: struck "done" → suppress proposal; ambiguous → review.

## Explicitly NOT in this increment (the honest edges)
- **APPLYING a confirmed proposal** to the live record (the confirm handler that calls
  the existing dismiss/deadline machinery + a review UI to drive it) — proposals are
  produced and previewable; the human-confirm→apply wiring is the next step.
- **Per-strike verdicts** for multi-effect lines (above).
- **Color/authorship interpretation** — Phase 3.
