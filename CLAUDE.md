# viktora-threshold — session rules (auto-loaded)

Threshold: the Tauri desktop app over the Apolla engine (AI-Light-Prototype).
These rules are BINDING for every session; they encode incidents already paid
for. Details live in the linked docs — read them before the work they govern.

## Frontend posture (Ross-ruled)
- ONE pair of eyes, tight render-look loop. No agent fan-out for anything
  user-visible; agents build well-specced plumbing only.
- Native (AppKit/Tauri) changes: probe state before changing it; byte-verify
  the RUNNING binary after (`lsof -p <pid> | grep txt` → grep for a compiled
  string — comments don't compile); live-test transitions yourself.
- After ANY native change: `cargo test --lib` locally (cargo check is not
  enough — a constants-pin test exists and CI failure emails go to Ross).
- Watch CI to green after every merge (`gh run list`). Small PRs; merges are
  delegated; `git pull` the primary checkout after each merge.
- Never write a styleMask that clears NSWindowStyleMaskFullScreen (1<<14) —
  AppKit throws and raw objc2 msg_send aborts the app. Exit fullscreen first
  (deferred-collapse pattern in widget_collapse).

## Harness / engine discipline (see ORG-STATE-PRESERVATION.md — binding)
- Relaunch the :3020 harness engine ONLY via the versioned launcher:
  `AI-Light-Prototype/schema-browser/scripts/harness/launch-harness-engine.sh`
  (thin wrapper at `~/scratch/launch-engine-3020.sh`). NEVER hand-assemble the
  env — the engine's features come from `ENGINE_PROFILE=pilot-full`; the boot
  feature-posture report + `/api/diagnostics` featurePosture must show ZERO
  warnings before any review.
- No review/UAT against a harness whose integrity gate doesn't print OK:
  `verify-corpus-integrity.sh <corpus> <engine-url>`.
- Back up the organization bundle (`org-state-backup.sh`) before any version
  swap, corpus reset, or substrate mutation.
- Adding a feature flag? The same PR must add it to `pilot-full`
  (engine-profile.ts) — a drift-gate test enforces launcher/profile parity.

## Standing references
- `ORG-STATE-PRESERVATION.md` — the no-more-regressions discipline + tooling.
- `PIXEL-PASS-RUBRIC-2026-07-06.md` + `MOCKUPS-THRESHOLD-UI-2026-07-06.html` —
  the binding visual acceptance bar.
- Current handoff doc (HANDOFF-THRESHOLD-*.md, newest date) — session state.
- House laws: fail-closed-but-VISIBLE (suppressed items get a quiet count +
  review affordance, never silent disappearance); plain product language (no
  classifier internals); glass tokens only; Dismiss/Snooze verb canon.
