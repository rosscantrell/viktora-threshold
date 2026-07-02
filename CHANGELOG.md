# Changelog

All notable changes to Viktora Threshold are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows the version already recorded in `src-tauri/tauri.conf.json`
(kept in sync with `src-tauri/Cargo.toml`). See `RELEASE-CHECKLIST.md` for the
mechanics of cutting a release.

## [Unreleased]

97 commits across PRs #46–#61 since v0.8.1. This wave is dominated by the
Work-Forest UI build-out (job/frame grouping, State-of-Play digests, the
Question Engine, and felt/pattern learning surfaces), a Today-surface
priority/vigilance overhaul (Focus rail, Watching ledger, Outbox), and an
Outlook write-back surface — plus one perf fix and various UX polish/bugfixes
gathered along the way.

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
