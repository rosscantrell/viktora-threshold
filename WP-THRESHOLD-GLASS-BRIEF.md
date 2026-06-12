# WP-THRESHOLD-GLASS — Brief (design-system alignment: the whole app goes glassy)

**Date:** 2026-06-12 · **Repo:** viktora-threshold · **Estimate:** 2–3 ED · **Risk:** Low (CSS-dominant; no logic changes)
**Sequencing:** AFTER (or by the same session as) WP-THRESHOLD-LOG-UX, which creates the shared token file its new views are born with. This WP migrates the EXISTING views onto those tokens.

## Mission (one line)

One visual language for all of Threshold: extend the widget's dark/glassy aesthetic (Ross's stated direction; reference = the receipts-view mockup from the 2026-06-12 design session) across every view in the expanded window, replacing the current light Apple-utility styling.

## Current state

- `src/widget.css` — already the target language: dark translucent pill, `rgba(28,30,38,.92)`, glass-morphism inset border, breathing badge animations.
- `src/styles.css` — light theme (`#f5f5f7` bg, `#1d1d1f` text, Siri-blue `#0071e3` buttons) across 9 views in `src/index.html` (wizard ×3, configure, main, tidbit, plaud-queue, onenote-browse, connections).
- The mismatch: the user expands a dark glassy pill into a bright white utility window.

## The token system (single source of truth — `src/glass.css`)

Created by WP-THRESHOLD-LOG-UX for its new views; this WP completes and freezes it. Derived from widget.css + the receipts mockup:

```css
:root {
  --glass-bg:            rgba(28, 30, 38, 0.97);   /* window surface (see vibrancy below) */
  --glass-surface:       rgba(255, 255, 255, 0.05); /* cards, strips */
  --glass-surface-hover: rgba(255, 255, 255, 0.08);
  --glass-border:        rgba(255, 255, 255, 0.10);
  --glass-border-strong: rgba(255, 255, 255, 0.14);
  --glass-text:          #e8eaed;                   /* primary */
  --glass-text-dim:      #9aa0a6;                   /* secondary */
  --glass-text-faint:    #6b7178;                   /* tertiary/footers */
  --glass-accent:        #ffc440;                   /* amber — tidbit/brand accent */
  --glass-success:       #5dcaa5;  --glass-success-strong: #4ade80;
  --glass-danger:        #f09595;  --glass-danger-strong:  #f87171;
  --glass-link:          #7fb3e8;                   /* evidence links, info */
  --glass-radius-sm: 8px; --glass-radius-md: 9px; --glass-radius-lg: 14px;
}
```

Buttons: secondary = `--glass-surface` bg + `--glass-border-strong` + `--glass-text`; primary = accent-tinted (`rgba(255,196,64,.14)` bg, `.35` border, accent text) — per the mockup's Copy/Share pair. Inputs: dark fields, light borders, accent focus ring. Status colors keep current semantics (green ok / red error) at the glass-palette values.

## The hero move: real vibrancy (not just dark paint)

Use the `window-vibrancy` crate (Tauri ecosystem): **macOS `NSVisualEffectView` (HudWindow/UnderWindowBackground material)** behind the expanded window, **Windows acrylic/mica** equivalent. The window background becomes actual translucent glass over the desktop — the pill's aesthetic at full size. Fallback: solid `--glass-bg` when vibrancy is unavailable (older OS, reduced-transparency accessibility setting — MUST respect `prefers-reduced-transparency`). Widget already uses transparency; this brings the expanded window to parity.

## Scope

**IN:**
1. `src/glass.css` completed + frozen (above); `styles.css` reduced to layout/structure, colors fully tokenized.
2. **View migration, in user-visibility order:** `view-main` + `view-tidbit` → wizard (welcome/configure/done) → `view-plaud-queue`, `view-onenote-browse`, `view-connections`. Pure re-skin: no layout/flow/DOM-logic changes beyond class/var swaps and spacing polish.
3. Vibrancy via `window-vibrancy` (mac + Windows) with solid fallback + reduced-transparency respect.
4. Motion polish: the widget's breathing/pulse vocabulary reused for state changes (badge counts, capture success) — subtle, ≤2 animation patterns, no new ones.
5. Consistency pass: one button system, one input system, sentence-case labels, consistent spacing rhythm.

**OUT:** layout redesigns, new views (that's WP-THRESHOLD-LOG-UX), light-mode support (dark/glassy IS the product identity — revisit only on user demand), icon set changes, widget.css changes beyond token extraction (it's already correct).

## Acceptance gate

- [ ] Every view renders on the glass tokens; zero hardcoded legacy colors remain in view styles (`grep` proof: no `#f5f5f7`, `#0071e3`, `#1d1d1f` outside glass.css).
- [ ] Contrast: all text/background pairs ≥ WCAG AA on the dark surfaces (spot-check the dim/faint text tiers).
- [ ] Vibrancy works on macOS; clean solid fallback verified (and with reduced-transparency enabled); Windows compile-clean with acrylic or fallback.
- [ ] No functional regressions: full manual pass of capture → tidbit, wizard, Plaud queue, OneNote browse, Connections (flows unchanged, only skin).
- [ ] Before/after screenshots of every view in the PR; version triple bumped.

## Operating protocol

1. Recon `styles.css` + every view's markup; inventory hardcoded colors.
2. **Propose, and STOP for approval:** the completed token file, one migrated view as the visual proof (screenshot of `view-main` on glass), and the vibrancy material choice per platform.
3. On go: migrate in the order above, screenshot each, single PR + AAR per repo convention.
