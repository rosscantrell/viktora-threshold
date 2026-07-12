# Changelog

All notable changes to Viktora Threshold are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows the version already recorded in `src-tauri/tauri.conf.json`
(kept in sync with `src-tauri/Cargo.toml`). See `RELEASE-CHECKLIST.md` for the
mechanics of cutting a release.

## [Unreleased]

## [0.11.1] — 2026-07-12

### Added
- **Your plan on Today** — the daily brief now opens with your plan of record:
  what moved, what stalled, what became newly possible, and what's still open —
  yours and your companion's. Overnight-prepared drafts appear here for review.
- Per-routine door choice — each check-in reminder opens your companion or
  Today, your pick per routine.

## [0.11.0] — 2026-07-12

### Added
- **Today is now a daily brief** — reorganized into focused strata: *Don't
  miss* (curated at-risk items), *Due this week*, *Prepared for you* (drafts
  awaiting your review), and *One question for you* (a single ask at a time,
  with the items to review before deciding).
- **Companion drafts in Awaiting send** — drafts your AI companion prepares
  now show the full message body (with Show full draft), who they're addressed
  to, and a ✦ "Drafted by your companion" marker. New actions: **Copy draft**
  (paste into your mail app), **Mark sent**, and per-attachment **Download**
  and **Replace** — replacing keeps the previous version for the record.
- **Routines in Settings** — set your daily rhythm (pre-work, morning
  standup, midday check-in, evening debrief) in Settings → Integrations →
  AI companion. Threshold reminds you at your chosen times; the ✦ chip opens
  your companion with the right session ready to go.

### Changed
- Notification reminders pulse the widget; opening the brief is the reliable
  path to your session (notification click handling varies by platform).

## [0.10.2] — 2026-07-09

Follow-on fixes from Trisha's live pilot use — the frontend half of the
2026-07-08 UAT report (the engine half shipped to her droplet separately).

### Added
- **Review before you decide** — every question card (name-ask, merge-ask)
  now shows a collapsed "Show N items →" list of the actual items it grouped,
  each openable in the source panel. A "Combine?" you can't inspect is a
  rubber-stamp; the merge-ask card lists both sides so you compare before
  combining.
- **Deadline-aware overview** — the state-of-play overview carries a plain,
  quiet line on what's due ("22 due in the next two weeks, 21 this week, 4 at
  risk. Next: … — due Jul 9."), so the summary reflects real deadlines even
  though the forest narrative is commitment-blind by construction.

### Fixed
- **"Tag a doc" did nothing / mangled deadline rail** — the tag-a-doc picker
  was permanently visible (its toggle a no-op) and its width squeezed the step
  text into a one-word-per-line strip. One `[hidden]` guard restores the toggle
  and the layout; the acts row now wraps below the text instead of crushing it.
- **Text overflow in the source panel** — arbitrary tokens (capture ids, long
  subjects) now break instead of overflowing at narrow panel widths.

## [0.10.1] — 2026-07-08

The focus release — same-day fixes from live pilot use.

### Added
- **"This week"** — short-fuse items (due within a week of being promised)
  leave the swimlanes and cards for a dense burn-down list beside the
  Deadline outlook: one row per item, grouped by owner with a single
  group-level follow-up that chases a person's whole pile; rows click-expand
  to the full item with its verbatim promise, source, and draft actions.
- **Seen steps are inspectable** — a matched workback step opens the source
  panel on the document the matcher saw, with "that's the one" (a positive
  confirm) beside "not this."
- **Save as contact** — one click downloads the capture address as a vCard
  ("Viktora Threshold"), so forwarding is a name in the To: field, never a
  40-character token.

### Changed
- **Deadline outlook is plans-only** — swimlanes render only for items with
  a worked-back plan; expansions are one-at-a-time.
- **"Mine" includes what you captured** — items you forwarded in count as
  yours, not just items you own.

### Fixed
- **OneNote "isn't open" while it visibly was** — the COM probe could attach
  to a ghost instance; it now retries and reports three truthful states with
  a next step in each.

## [0.10.0] — 2026-07-07

The deadline release — Today learns to look ahead. A two-week Deadline
outlook, workback plans you can correct by hand, and the "no draft observed"
warning Trisha asked for after the June 30 miss.

### Added
- **Deadline outlook** (Today, wide layout) — a two-week runway panel under
  the State of Play: one bar per due-soon commitment, a tick at the latest
  start that still makes the due date, amber when that point passed with
  nothing seen. Click a swimlane for the reasoning: who promised it
  (verbatim + source), the step-by-step plan with per-step dates, and an
  honest absence claim scoped to connected sources.
- **Workback corrections (HITL)** — every part of the plan is editable in
  place: mark a step done, rule it not-applicable, tag the document that
  shows it happened, reject a wrong match, add a missing step, **move the
  due date** (propagates to bars, tags, ordering, and scope — with a
  "moved from …" marker), and undo. Every correction lands in the learning
  stream and recomputes the dates deterministically.
- **Readiness warnings** — the amber "no draft observed" badge on Coming-up
  rows (the Brian flag), a one-tap **"Draft heads-up to client"** staged to
  the outbox (no-blame copy, nothing auto-sends), and an honest
  "unobservable" reading that keeps the badge quiet when the corpus can't
  support an absence claim.
- **Project home** — inline relationships + per-project state of play
  (the Trisha-session flagship), with SoP claim-level receipts (expandable
  claim pills) and the SoP digest card grammar.
- **Naming and merging asks** — the engine asks what unnamed workstreams
  should be called (queue cards, honest code labels like US-NON-22189) and
  proposes combining near-duplicate project keys; answers propagate
  everywhere via canon aliases (Today groups like the Log).
- **Email capture card** (Settings) — self-service capture address +
  approved senders, with an inline owner-email prompt.
- **Junk suppression, reviewable** — not-a-commitment records are suppressed
  from queues but visible + reversible behind a review affordance.
- **Bulk nested category create** in the Log's frame-correction tools.
- **End-to-end user guide** with live screenshots, covering the heads-up
  action.

### Changed
- **Wide Today: read | act** — State of Play + Deadline outlook on the
  left, the action rail (Waiting on you → Coming up → Awaiting send) on the
  right, the full-width board below; board and queue render together at
  wide widths; overlay titlebar reinstated; first-class Mac window.
- **Both Today columns are now layout-wrapped and nothing spans grid rows**
  — fixes the inflated left-column dead space and the rail-paints-over-the-
  board overlap for good.
- **Taste canon + receipts v2** — one verb language, glass everywhere,
  calmer widget pill, queue primary actions amber, question-card grammar
  unified across card types, queue cap that actually caps.

### Fixed
- Shell: the grey halo behind the window, green-button fullscreen not
  filling the screen, collapse-while-fullscreen crash (deferred until
  AppKit's exit settles), expand crash (AppKit off main thread), opaque
  workspace window restore.
- Today: duplicated State-of-Play narrative, SoP auto-load on entry,
  dismiss-as rows hiding correctly.
- Privacy panel: embeddings channel rendered with an honest unconfigured
  state.

## [0.9.0] — 2026-07-03

The biggest feature release yet — the app collapses from one-view-per-engine-concept
to **one-view-per-user-question**: Today and Projects, plus Settings.

### Added
- **Today, rebuilt** — a State-of-Play header (person-lens SoP prose, closing with
  the "calls only you can make"), a "Needs you" ratification queue (proxy-fleet
  cards + question pull + vigilance chases), a collapsed "Filed confidently" pile,
  and an approve-and-send tray. First paint <1s cold; all enrichment streams in off
  the critical path.
- **Proxy-fleet inbox** (WP-T1) — the cascade's morning ratification queue as a
  first-class Today surface.
- **One receipt component, everywhere** — verbatim quote, source doc, date, co-sign
  count ("N captures corroborate"), tap-to-expand, jump-to-source, and a "compiled
  from N captures" share action on any receipted card.
- **Email magic-link sign-in** — onboarding + a Settings identity / switch-account
  block; deep-link completion; the signed-in email unlocks viewer-scoped features.
- **Frame-correction tools** — nested category create, reparent ("make this a
  sub-category of…" / promote to top-level), and sibling-sub-frame merge.

### Changed
- **View consolidation** — Watching, Outbox, and Relationships demoted from
  destinations into Today context (recoverable behind a debug flag); the global
  Connections view retired.
- **Proxy cards de-jargoned** — a plain ask + dated quotes + plain confidence up
  front; fleet mechanics (verdict / routes / cosine) behind a Details affordance,
  with a jump-to-source to the underlying record like the Log.
- **Evidence made consistent** — every evidence surface renders through the single
  receipt component; zero bespoke evidence layouts remain.

### Notes
- Manual install only (no auto-update this release); see PILOT-INSTALL.md for the
  0.8.1 → 0.9.0 upgrade path.

### Also in this release — Work-Forest wave (PRs #46–#61 since v0.8.1)
97 commits dominated by the Work-Forest UI build-out (job/frame grouping,
State-of-Play digests, the Question Engine, felt/pattern learning), a Today-surface
priority/vigilance overhaul (Focus rail, Watching ledger, Outbox), and an Outlook
write-back surface — plus one perf fix and various UX polish/bugfixes.

### Added

- **Work-Forest — grouping & priority (WP-Rollup / P2–P4-Tauri):** Focus list
  rolled up by entity/job into collapsed groups; section → job → action
  hierarchy; job-grain quadrant chips and job-row badges; job-first
  consolidation (one row per job across emails); canonical job names surfaced
  in Today rows, Receipts headers, Definition-card titles, and By-project
  group labels; Rename + Split-back and Combine actions on project-lens group
  headers (#48, #52, #53)
- **Work-Forest — frame layer & felt-learning (#52, #53):** priority
  bands/heat and frame-level HITL in the Log; "apply to similar" offer,
  inspect, and suggestion surfaces for felt-learning
- **Work-Forest — State-of-Play (SoP) UI (#58, #59):** `fetch_sop` Rust
  command for Work-Forest-native SoP; person-lens SoP narrative + lens toggle
  on Today; Frame SoP digest on Decisions frame headers; Job SoP digest on
  Focus-rail job rows and Decisions job groups; SoP Team Update compose UI;
  consolidated SoP to workstream/frame headers (dropped per-job auto-fire)
- **Work-Forest — Question Engine / MVP-Librarian (#60, #61):** "Patterns
  I've noticed" rule-card with disjunction surface (consumes the
  learning-engine API); Question Engine card + pull mode + nursery shelf;
  job-split and bulk-move actions; member disclosure with inspect + curate;
  question-card SOURCE opens the authored hot-list in the source pane
- **Today — priority & vigilance (#46, #48):** "Focus" rail (importance ×
  urgency) with pin/dismiss calibration; collapsible Focus / Watch /
  Everything-else sections; clickable Focus quadrant-chip filters; dismiss
  reason chooser with context snapshot; Snooze (Schedule) and Hand-off
  (Delegate) card actions with an inline-editable hand-off note; Focus
  chase-list (Stalled / Chasing) (#57)
- **Watching tab → passive vigilance ledger (#46, #57):** "Watching for…"
  surface for vigilance voids, arrived receipts, and HITL
  (dismiss/snooze/clear); Watching cards show work-forest hierarchy, link
  back to the original captured item, and gained a Draft-follow-up action
  using the Share-decision inline editor
- **Outbox / Outlook write-back (#49, #50):** Outbox surface, Draft-follow-up
  action, and Install-Add-in flow for Outlook write-back
- **Decision Log / Share (#56):** "Share decision" verb with inline
  dependency popover (Jump-to-item links per linked record); decision Share
  draft stages into the Outbox queue (Copy + Send); Log card redesign
  prototype — single action badge that carries its object; share-draft edits
  captured as an overlay learning signal
- **Settings / Privacy (#46, #48):** Privacy settings panel — "where does my
  data go" indicator; OneNote auto-import overhaul + master-detail Settings
- **State-of-play inform rail (#46):** "Worth looping in" / "Catch up on"
  inform rail; inline editing + digest decomposition UI

### Changed

- Today/Log card redesign removed the per-record project chips from decision
  cards in favor of the single action-badge treatment (#55, #56)
- Toast stack now renders below the sticky nav so titles aren't clipped (#48)
- Dev builds isolated from the installed release build (#51)
- Install-Add-in copy aligned with the real Mac Outlook flow (#50)

### Fixed

- Outbox: Dismiss button position (was off-card via legacy absolute
  `.btn-link`), `view-outbox` missing from `VIEWS` (view failed to render),
  and a guard so one malformed Outbox item can't blank the whole list (#56)
- Share draft: now includes full decision content, restores Relates-to
  links, autosizes reliably without clipping, and the action pill (not the
  popover chrome) is the real click target (#56)
- Watching cards: dropped the red raw-float "silent score," and the
  follow-up trigger was repositioned to the top-right to mirror Log Share
  (#57)
- Work-Forest SoP: numeric frame IDs no longer silently drop Frame SoP
  (id coerced to string); dead per-job SoP and the dead job-card
  State-of-play link removed (#58)
- Work-Forest Question Engine: duplicate verb prefix stripped from
  question-card futures (#61)
- Project grouping: merge now sends both slugs in `sources` (backend
  requires >= 2) (#48)
- Focus/priority: long job/section titles truncate correctly; Veeva ID chip
  fixed (#48)

### Performance

- Decisions view no longer blocks its initial paint on ambient enrichment
  (#61)

## [0.8.1]

Prior baseline release. See git tag `v0.8.1` (768e60b) for its state; not
backfilled in this changelog.
