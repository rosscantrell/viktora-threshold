# Threshold design grammar — distilled tokens (2026-07-20)

The pixel grammar distilled from the ruled mockups
(`MOCKUPS-THRESHOLD-REVIEW-2026-07-20.html`, Concept 1 + L1) and the standing
rubric (`PIXEL-PASS-RUBRIC-2026-07-06.md`). Mockups are CONTRACTS (Ross
2026-07-20): build briefs lift these measurements — nobody re-derives them
from existing CSS. Glass tokens (`src/glass.css`) remain the single source of
truth for color variables; the hex values below name the resolved contract
values for quick diffing against a mock.

## Card

| token | value |
|---|---|
| padding | 11px top/bottom × 14px sides |
| radius | 10px |
| border | 0.5px hairline, `#33363f` (card) / `#23252d` (row) |
| background | `rgba(255,255,255,0.02)` on the glass surface |

## Type

| role | spec |
|---|---|
| claim (card title / summary) | 13px, `#e8eaed` (`--glass-text`), line-height 1.5 |
| meta (who · when · counts) | 11.5px, `#9aa0a6` (`--glass-text-dim`) |
| collapsed row text | 12.5px |
| quiet-line (counted pointer) | 11.5px dim; hairline underline on nav segments; never amber |

## Chips

- Radius 999 (pill), 10.5px, ghost: 0.5px hairline `#3a3d46`, dim text.
- **Amber is urgency ONLY** (`#ffc440` text / `#7a5c14` border, or the badge
  fill on counts). A chip is amber because the item is urgent, never because
  a pipeline wants attention.

## Verbs (action buttons)

| weight | spec |
|---|---|
| primary | FILLED NEUTRAL — `#e8eaed` fill, `#14151a` text, 600 weight, r7, 4×12px pad (`.btn-neutral` / the `.view-needs-you` scoped rules) |
| secondary | 0.5px hairline `#3a3d46`, `#c9ccd1`/glass-text, no fill |
| tertiary | bare link, dim text, no border |

- **NO green actions.** Green (`--glass-success`) is resolved/positive STATE
  only — a ✓ line, a "moved" chip — never a button.
- The legacy blue `.btn-primary` is not a verb color in this grammar; recut
  on sight (the "Mark sent" recut, this WP).
- Verb canon: Dismiss / Snooze (never Delete/Later); 8px gaps in a verb row.

## Rhythm

- 18–20px between sections/strata; 7px head→list; 5px between collapsed
  rows; 8px between cards.
- Every list wears a hard cap + an honest overflow count line — suppression
  stays visible (fail-closed-but-VISIBLE).
- Sentence case everywhere; plain product language (no classifier/pipeline
  internals in shipped chrome).
