# PIXEL PASS — annotated defect list, 2026-07-07

**Method:** rubric `PIXEL-PASS-RUBRIC-2026-07-06.md` against main @ `34b3af5` (post-#101/#102),
restored corpus via :3020 (integrity gate: OK — jobNames=74, recordJobs=280, frames=13).
Shim harnesses: :4652 corpus / :4651 typed-empty / :4653 dead-upstream (error). Widths
700 · 940 · 1200 · 1440 × empty/full/error; native window states live on the dev app.
Every claim below was DOM-measured or screenshotted, not eyeballed from docs.

Pre-pass native work (same session): **bug 2 CLOSED WITH FIX** — PR #102 (wrong
`Managed` collectionBehavior constant + styleMask race left the workspace window
non-resizable; green-button fullscreen now fills 2880×1800, round-trip verified).
Bug 1 remains closed as external (Notes selection). Name-ask self-clear ⚠ from the
handoff **verified working** (`/api/project-canon/name-asks` → `{"asks":[]}` post-rename).

---

## P1 — release blockers

### D1. Queue cap visually broken — the `[hidden]` landmine, re-hit on shipped code
`#today-queue-list` renders **all 18 cards** (list measures 3442px) even though #95's
cap correctly sets `hidden` on cards 5+: `.record-card { display:flex }` outranks the
`[hidden]` attribute (handoff §6 landmine #2, verbatim). Cascade at every width:
- "Coming up" — **the Brian-flag readiness rows** — starts at y≈3652, ~3.5 screens deep.
  Rubric Row 0: "if any width/state hides it, that's a P1." This hides it at ALL widths.
- Left column is a ~3700px void below the SoP panel (the "dead space at fullscreen"
  sighting is this bug, not a composition flaw).
- Needs-attention board (which DOES ship the mockup-2 compact accent-bar grammar —
  see passes) sits below everything, effectively unreachable.
Evidence: DOM dump — cards 4–17 `hidden=true display=flex`; screenshots at 1440/1200/940/700.
**Fix:** scoped `[hidden] { display:none !important }` guard (repo already carries two
prior instances of this exact fix); re-measure rail height after.

### D2. Overlay titlebar still reverted (bug 3, the known headliner)
Standard titlebar strip on the workspace window; mockup 1 wants inline traffic lights
over glass, content as the frame. Reinstatement checklist (from the 07-06 handoff):
`TitleBarStyle::Overlay` + `body.titlebar-overlay` class + 78px nav left offset + LIVE
verification of drag-by-nav / click-focus / green-button fullscreen / ⌘⇥ / Mission
Control. Note: fullscreen machinery is now healthy (#102), so the overlay's fullscreen
interaction can actually be regression-tested this time.

## P2 — canon violations, visible daily

### D3. Legacy blue accent is still the app-wide primary accent
`--accent: #2f7ae5` lives at `styles.css:68` — the exact hex rubric line 6 forbids on
migrated surfaces — plus a parallel hardcoded `#3884ff` family. Blast radius measured:
`.btn-primary` (Settings Save / Connect Plaud / Install Outlook Add-in / login CTA,
blue-filled gradient), `.record-action-badge` "Draft follow-up" on every queue card
(blue fill `rgba(56,132,255,.16)`), text links (Show more / Open → / Draft follow-up →),
`.frame-badge-project` "PROJECT", `.job-band-pill.band-soon`, frame-type chips, rename
save, checkbox `accent-color`. Violates rubric 6 + 8 (one amber primary, no second
accent; mockup palette contains zero blue).
**Trade to surface (Ross):** wholesale recolor changes the app's feel. Proposal:
`.btn-primary` + `.record-action-badge` → amber-tint ghost (the "Compose update to
team" treatment); links → light-grey glass with hover; frame/status pills → neutral
ghosts. Implement behind one small PR so it's easy to revert on taste.

### D4. Not-a-commitment suppression is silent — fail-closed-VISIBLE law violation
#98 suppresses `recordClass==='not-a-commitment'` at the shared chokepoint, but NO
surface shows the required quiet count/review affordance ("12 filtered as not
commitments — review", per CATEGORIZATION-STATE-FOR-UI.md §1 / house law §2b.3).
Confirmed: zero matches for any filtered/not-commitment string in the full corpus DOM.
**Fix:** quiet one-liner + review affordance where the suppression bites (Today header
area and/or Log); plain language only; reconcile every count on the same screen.

### D5. Raw job-code group titles on the Today board
Needs-attention group titled "MSD Veeva Job HQ-NON-01677" (and the un-renamed key
family behind name-asks). The `job:` prefix join covers renamed keys ("Ep1 Review"
groups correctly ✓) but code-shaped keys with no canon name render raw. Handoff §5.3
item confirmed still open. (Producer-side sibling: the merge-ask WP.)

## P3 — polish / checks / file-don't-fix

- **D6. All-caps filled chip families diverge from mockup card grammar** — queue chips
  "OVERDUE · SILENT · 40D", card eyebrow "WAITING ON", green "COMMITMENT" chips, red
  "ON FIRE"/"ACT NOW", blue "PROJECT". Mockup 2/3 use lowercase quiet metadata + amber/
  soft-red status *words*. Green+red+blue chip fills also collide with the no-second-
  accent reading. One family-level taste decision for Ross; don't piecemeal.
- **D7. "Opine" orphan eyebrow** in the SoP panel — label renders with no content until
  "Show more"; either hide it while collapsed or fold it into the expand affordance.
- **D8. Nav icons are text glyphs** (⌂ / ⚙) not line-SVG (rubric 10).
- **D9. SoP narrative/chip count mismatch** — prose says "29 overdue", chip says
  "34 overdue" (same panel, same paint). Engine-lane (SoP compose staleness vs computed
  chips) — FILE to eval lane, not a UI fix.
- **D10. Cross-view scope labels** — Today "284 tracked" vs Log "264 records · 72
  projects". Likely different scopes; needs a one-line verification, and if scopes
  differ the labels should say so.
- **D11. SoP digest default length** — ~9 prose lines before "Show more" at 1440 vs
  mockup's ~4-line digest. "Do this first" IS visible ✓, chips ✓, expand ✓; calling
  this a density check, not a defect — re-grade after D1 makes the full composition
  visible.

## Passes (measured, for the record)
- Row 0 content grammar: due-in badges ("due in 2 days · Jul 9"), "no draft observed",
  amber "Draft heads-up to client" all render on the 3 seeded readiness rows ✓ (visibility
  gated by D1).
- Empty state (all widths): quiet-report calm lines, no orphan ask-input, no zero-count
  pills ✓. Error state (dead upstream): identical calm rendering, zero console errors,
  no carcass/spinner ✓.
- Canon verbs: 0 "Superseded", 0 "Not now", Dismiss ×18, Snooze ×21, metadata owner·due ✓.
- No `--surface-*`/#2f7ae5 in DOM inline styles; SoP chips are proper ghosts ✓.
- Needs-attention board ships mockup-2 compact accent-bar cards, ≥420px auto-fill
  (3 cols @1440), amber status words, "202 open · 0 resolved · 2 replaced" strip ✓.
- Receipts-v2 blocked-by join: claim chip "6 blocked" → grouped panel, owner · due ·
  summary rows, red "blocked by —" naming the blocker ✓.
- Outbox tray hidden at zero drafts ✓. Question pull answers calmly when empty ✓.
- Canon rename round-trip: "Ep1 Review" groups the board ✓; name-asks self-clear ✓.
- Widget pill: amber count badge top-left, SVG line icons, dim-grey unknown dot,
  zero idle animations ✓.
- Header-CTA law: State of Play / Refresh share one computed size ✓.
- Green-button fullscreen: fills the screen, no black surround, stable (#102) ✓.

## Fix-pass order (proposed)
1. D1 (one-line guard, unblocks re-grading the whole composition)
2. D2 (headliner, native, live-verify per checklist)
3. D4 (visible-count affordance) → 4. D5 (board label join) → 5. D3 (behind its own PR,
   easy revert) → D7/D8 opportunistic; D6/D9/D10 to Ross / eval lane.
