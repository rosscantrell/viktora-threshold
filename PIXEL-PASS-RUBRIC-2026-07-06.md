# PIXEL-PASS RUBRIC — mockup-comparison pass, 2026-07-06

**Purpose:** the gradeable checklist for the committed step-2 pixel pass (handoff
§"committed next sequence"). The three approved mockups are now a CONCRETE artifact —
`MOCKUPS-THRESHOLD-UI-2026-07-06.html` (binding acceptance bar; open it in a browser and
put each mockup literally beside the real surface). These line items are the gradeable
decomposition of that file + the ruled canon.
**Method:** shim harness (:4651 empty / :4652 corpus, or the live app post-rebuild);
every cell gets ✓ / defect-ID / n/a. Defects accumulate into ONE annotated list; one fix
pass closes it.

## Grid

- **Views** (enumerate from the LIVE nav at pass time — do not trust doc lists): Today,
  Projects (+ project home), Log, Sources, Settings (all panes: Connection, Integrations =
  Plaud/OneNote/auto-import, email capture), the widget pill, Outbox tray (if present),
  compose/preview surfaces, question card, dependency popover.
- **Widths:** 700 · 940 · 1200 · 1440 (700–940 = the sparse problem zone, bug 4).
- **States:** empty · full · error (engine down — kill the shim's upstream to simulate).

## Row 0 — the product bar (Trisha / Brian June-30, every width)

- [ ] A due item ≤14d out appears in "Coming up" with due-in badge; silent/no-activity badge when quiet.
- [ ] Day-before (and week-before for big deliverables) urgency is visually distinct from rear-view overdue.
- [ ] One-tap "Draft heads-up to client" affordance reachable from the due/overdue item.
- [ ] The Brian scenario: an owner+due captured from a thread would have surfaced BEFORE the deadline. If any width/state hides it, that's a P1 defect.

## Global canon (check on EVERY view — Ross's 7 rulings + laws, do not re-litigate)

1. [ ] Lifecycle word is **"Replaced"** — zero "Superseded".
2. [ ] Reject verb is **"Dismiss"** everywhere; `✕` only as card-corner glyph.
3. [ ] Defer verb is **"Snooze"**; duration lives in the menu, never the label.
4. [ ] **"Not now" appears nowhere.**
5. [ ] Metadata order **owner · due** on action cards; date-first only on chronological surfaces (Receipts).
6. [ ] Glass tokens only (`--glass-*`); no legacy `--surface-*` / `#2f7ae5` accents on migrated surfaces; Plaud + OneNote fully glass **and composed with the glow-up coat (#72×#75 collision check)**.
7. [ ] Sentence-case section titles; no ALL-CAPS eyebrows.
8. [ ] **Amber discipline:** `#ffc440` only on needs-attention left border, overdue/silent counts, ONE primary action (amber-tint bg). Chips/pills are tinted ghosts, never filled. No second accent color.
9. [ ] **Header-CTA law:** buttons sharing a header row share one computed size (the 33-vs-24px miss is the cautionary tale).
10. [ ] Line-style SVG icons only; no emoji.
11. [ ] Empty states use the glow-up **calm-line** language (ruled over #72's boxed versions); an error box is never styled/treated as content.

## Mockup 1 — first-class window (the APPROVED look, currently reverted = bug 3)

- [ ] Traffic lights inline over glass; no separate titlebar strip; content is the frame.
- [ ] Nav clears the lights (`body.titlebar-overlay` + 78px left offset restored).
- [ ] Live-verified BY HAND after reinstatement: drag by nav, click-focus, green-button fullscreen, ⌘⇥, Mission Control.
- [ ] Widget pill: no grey halo at fresh boot AND after expand→collapse (bug 1; probe traces in PR #76 identify culprit).
- [ ] Maximize/fullscreen fills the screen — no black surround (bug 2; `[frames]` probe measures the gap).

## Mockup 2 — wide Today (read|act geometry shipped in #77; card grammar is the gap)

- [ ] ≥1200: State-of-play panel + chips top-LEFT; RIGHT rail = "Waiting on you (N)" queue cards then "Coming up (N)" due-soon cards (amber due-in / quiet badges). Rail is ONE flowing sticky column (#77).
- [ ] **SoP digest, not essay** (mockup 2): the wide panel leads with a ~4-line digest + ghost chips + "Do this first"; the full narrative sits behind an expand, never a ~15-line wall by default.
- [ ] **Compact accent-bar group cards** (mockup 2): each needs-attention card = ONE project — 2px amber left bar, title · count, worst-item line ("owner · due · status"), status words colored amber (silent) / soft red (blocked). Full rows on expand, not by default.
- [ ] "Needs attention (N)" placement per Ross's D ruling: full-width board below the read|act row, ≥420px auto-fill columns (supersedes mockup 2's left-column placement — ruled on real corpus data 2026-07-06).
- [ ] Ordering within groups: blocked → oldest-overdue → longest-silent; groups by worst item; >6 rows collapse to top-5 + "Show all N →".
- [ ] Density check vs spec: compact panels, ghost chips, quiet metadata — not airy card sprawl. No ALL-CAPS eyebrows (the SoP "OPINE" label is a known defect).
- [ ] 700–1100 with empty queue/Coming-up: quiet report holds (#77) — calm one-liners for empty strata, no floating ask-input in a void, no empty count pills.
- [ ] Claim chips carry the receipts-v2 blocked-by join → dependency popover (from #72): owner · due · summary rows, top-6 + Show-all.

## Mockup 3 — master-detail fullscreen: **PARKED** (next cycle, Ross's sign-off). Only the receipts-v2 chip join (above) ships now.

## Widget pill (all states)

- [ ] Rest state calm: no idle animation; one soft elevation; hairline borders.
- [ ] Badges: amber count top-left (log) / bottom-left (proxy), ghost spark top-right (tidbit) — hidden at zero; corner reads one thing at a time.
- [ ] Status dot: unknown=dim grey, ok=green, err=soft red — never alarm-red for disconnected.
- [ ] Arrival pulse fires once (~2s) and returns to calm; honors reduced-motion.

## Error / engine-down (every view)

- [ ] Calm-line empty state, not an error carcass; no stale spinner; no sticky error treated as content.
- [ ] Widget stays functional (capture/upload) with engine down; dot goes err.

## Evidence discipline

Every defect: screenshot + width + state + the rubric line it violates. Every fix:
re-screenshot at the same cell before marking closed. Byte-verify the running binary
before ANY visual judgment of a native change (`lsof -p <pid> | grep txt` → grep for the
build-stamp string).
