# WP-Threshold-Compact-UX Phase 1 — Spike Findings

**Status:** Spike branch open (`claude/wp-threshold-compact-ux-phase-1-spikes`); empirical observations pending Ross's local smoke + GHA Windows compile.
**Brief:** `WP-Threshold-Compact-UX-Brief-v1_1-FINAL.md` (floating-widget UX direction)
**Date:** 2026-05-21

---

## What the spike contains

Minimal floating-widget scratch on top of v0.2.0 main:

- **`src/widget.html`** — 100x100 widget shell with centered Capture button (crosshair SVG) + connectivity dot. `data-tauri-drag-region` on outer shell; inner button opts out via `data-tauri-drag-region="false"` so its clicks don't get hijacked by the drag handler.
- **`src/widget.css`** — Dark-translucent rounded-rect surface (`rgba(28, 30, 38, 0.92)`, 22px border-radius); 56x56 inner Capture button with hover + active states; 8x8 status dot bottom-right (gray cold-start, green ok, red err per AC-CUX-12 reactive-only).
- **`src/widget.js`** — Single-click on Capture → `invoke("run_screen_capture")`; right-click stubbed (logs only; full native Menu API in Phase 2); listens to `threshold://toast` events to flip status dot; listens to `threshold://drop-paths` for D-12-04 drag-drop parity. AC-CUX-12 reactive-only: no auto-ping at init.
- **`src-tauri/tauri.conf.json`** — `app.windows[0]` changed to `url: "widget.html"` + widget shape: 100x100, `decorations: false`, `transparent: true`, `alwaysOnTop: true`, `focus: false`, `skipTaskbar: true`, `resizable: false`, `shadow: false`, `center: true`.

**Not touched:** existing `src/index.html` / `src/main.js` / `src/styles.css` — these are preserved for Phase 2's expand-mode wiring. Phase 1 spike just swaps which HTML loads at startup.

**Rust side untouched:** no changes to `lib.rs`, `ocr_mac.rs`, `ocr_windows.rs`. The widget uses the existing `run_screen_capture` IPC verbatim. If S-CUX-03/04 fail, the fallback is platform-specific window-shim code in Rust — that's Phase 2 territory.

---

## Spike checklist — Ross's empirical observations

Run locally on Mac:

```bash
cd ~/Projects/viktora-threshold
git checkout claude/wp-threshold-compact-ux-phase-1-spikes
npm run tauri -- dev
```

Then observe:

### S-CUX-01 — Mac widget renders correctly

- [ ] Window appears as a ~100x100 rounded-rect floating widget (NOT a full 800x600 windowed app)
- [ ] Window has no title bar / no traffic-light buttons (decorations: false)
- [ ] Window has transparent background showing wallpaper around the rounded rect
- [ ] Window stays on top of other apps when those apps gain focus (alwaysOnTop)
- [ ] **Notifications still fire** — open the macOS Notification Center; widget can emit OS notifications

### S-CUX-03 — Click does not steal focus (THE WP'S ARCHITECTURAL PREMISE)

**THIS IS THE LOAD-BEARING TEST.** If this fails, the WP needs a hand-rolled `NSPanel + acceptsFirstResponder=NO` shim (Phase 2 fallback).

Procedure:
1. Open TextEdit, type some text, KEEP IT FOREGROUND
2. With TextEdit still foreground, click the widget's Capture button
3. Observe: did TextEdit lose focus the moment you clicked the widget?
4. Drag a region over TextEdit's content
5. Wait for the toast + corpus ingest
6. Open the schema-browser corpus view OR `cat` the latest ingested doc's `sourceMetadata.sourceApp`

**Pass:** TextEdit kept focus during widget click + `sourceApp: "com.apple.TextEdit"` lands in corpus
**Partial:** TextEdit lost focus but `sourceApp` filled with another non-Threshold bundle (the Mac `is_threshold_own_bundle_id` filter caught the leak)
**Fail:** TextEdit lost focus AND `sourceApp` either empty or `"ai.viktora.threshold"` — Tauri 2 high-level API insufficient → escalate, recommend Phase 2 fallback to platform-specific shim

Repeat with at least one more app (Safari with a Wikipedia page is a good second target — different bundle ID).

### S-CUX-05 — Click vs. drag distinguishability

Procedure:
1. **Click the Capture button (center of widget) without holding** — should fire Capture (crosshair appears)
2. **Click the widget OUTSIDE the Capture button + drag** — widget should reposition to where you released
3. Try **fast tap** on the Capture button — should fire Capture, not be misread as drag-start

**Pass:** Click on button = capture; click anywhere else + move = drag; no misfires either way
**Partial:** Mostly works but flaky (occasional misfire) — note frequency
**Fail:** Either gesture frequently consumes the other — fallback to explicit drag-handle area (top edge of widget) + click-to-capture in body

### Bonus — observations to record for AAR

- [ ] Widget position on launch (Tauri 2's `center: true` should center on primary screen; note actual position)
- [ ] Performance: does the widget load instantly vs. the previous full window?
- [ ] Connectivity dot: starts gray (correct per AC-CUX-12); flips to green/red as expected after first toast event?
- [ ] Any visible rendering bugs (transparent shows weirdly? border-radius clipped?)

### Notes & verbatim quotes

(Ross fills in)

---

## Live findings — 2026-05-21 (in flight)

### Pre-flight: Tauri 2 transparent + macos-private-api

First `tauri dev` boot surfaced a warning: `The window is set to be transparent but the macos-private-api is not enabled.` Both fixes required for Mac transparent windows in Tauri 2:
- `Cargo.toml`: `tauri = { version = "2", features = ["macos-private-api"] }`
- `tauri.conf.json`: `app.macOSPrivateApi: true`

Applied; warning cleared on re-boot.

### S-CUX-01 — PASS (visual)

Widget rendered as a 100x100 dark-translucent rounded-rect with the centered crosshair button, sitting on top of the editor (alwaysOnTop ✓). Transparency at 92% opacity (`rgba(28, 30, 38, 0.92)`) renders with subtle edge softening; no Tauri rendering bugs.

### S-CUX-05 — FAIL with `data-tauri-drag-region`, PASS pending re-smoke with JS heuristic

Empirical: with `data-tauri-drag-region` on the outer widget div + `data-tauri-drag-region="false"` on the inner Capture button, Ross could NOT drag the widget from any region (button or border ring). Single-click on button → capture fires correctly, so Tauri WAS receiving click events; but mousedown for drag wasn't triggering window relocation.

Hypothesis (untested): Tauri 2's `data-tauri-drag-region` may be incompatible with the combo of `focus: false` + `transparent: true` + `decorations: false` + `alwaysOnTop: true` on Mac. The high-level API silently no-ops.

**Fallback applied (brief's documented S-CUX-05 fallback path — "Custom mouse-event handling in widget HTML"):** Pure-JS movement-threshold heuristic in `widget.js`. Mousedown tracks `screenX`/`screenY`; if mouse moves > 4px before mouseup, invoke `getCurrentWindow().startDragging()` (native Tauri 2 window API). Click handler bails out if drag was initiated. Removed the `data-tauri-drag-region` attributes from `widget.html` to avoid any interference. Pending re-smoke.

### S-CUX-03 — PARTIAL (Tauri 2 high-level API insufficient; filter catches the leak)

**Empirical (2026-05-21):** Rust-side `eprintln!` immediately before POST shipped: `[SPIKE S-CUX-03] sourceApp = ""`. The Mac `is_threshold_own_bundle_id` filter (PR #3 commit 00ec1e7) caught a focus-leak — NSWorkspace.frontmostApplication() returned `"ai.viktora.threshold"` at the moment of capture (the widget's Capture-button click activated Threshold despite `focus: false` in tauri.conf.json). Filter rejected the self-reference → unwrap_or_default → empty string. Honest unknown ships rather than misleading self-attribution.

**Verdict:**
- The Tauri 2 high-level API (`decorations: false + alwaysOnTop: true + transparent: true + focus: false + skipTaskbar: true`) does **NOT** prevent focus-steal on click. The brief's risk table called this Medium-likelihood / Very-high-impact; empirical now confirms.
- The Mac filter is doing exactly the defense-in-depth job it was shipped for. Filter is permanent for v0.3; treat it as belt + suspenders to the NSPanel shim.
- Phase 2 **must** include the NSPanel + `acceptsFirstResponder = NO` shim on Mac to actually preserve the target app's frontmost-application state across the widget click. Per brief §12 risk mitigation language.

**Phase 2 envelope shift:** +1–2 days for the NSPanel shim. Total ~7–9 days impl-agent work (was 6–7).

**Windows S-CUX-04 still pending** Ross's wife's Win11 smoke. By symmetry expect WS_EX_NOACTIVATE shim to be needed on Windows too; the Windows filter shipped in PR #2 will catch the leak similarly in the meantime.

### S-CUX-05 — PASS via Rust IPC fallback

`data-tauri-drag-region` empirically failed (mousedown not registered for drag from any region of the widget). JS-side `getCurrentWindow().startDragging()` ALSO failed (likely API path not exposed via `withGlobalTauri: true` or blocked by `focus: false`). Final fallback that worked: pure-JS movement-threshold heuristic invoking a custom Rust IPC `widget_start_drag` that calls `tauri::Window::start_dragging()` from the Rust side. Widget moves on click-and-drag; single-click on the button still fires capture cleanly.

This is the Phase 2 pattern — the JS heuristic + Rust IPC stays. The `data-tauri-drag-region` attribute is treated as broken on this widget config.

---

## Phase 2 directive

**All three critical spikes have empirical verdicts. Greenlight Phase 2 with the +1–2 day NSPanel shim included.** The shim approach is well-documented (objc2-app-kit pattern; can swap NSWindow for NSPanel post-creation + override `canBecomeKey` / `canBecomeMain`). Filter stays as defense-in-depth for the cold-start / animation-transition edge cases.

### Toast-on-cancel UX adjustment

Phase B's Mac path emits `kind: "failure"` for both real failures AND user cancellation ("Region capture cancelled" toast title). The widget was flipping the status dot red on cancellation. Adjusted heuristic: if toast title contains "cancel" or "timed out", reset dot to gray (unknown) — cancellation is a user action, not a system error.

---

## What CI is validating (S-CUX-02 / S-CUX-08)

Push of this branch fires the existing CI matrix:
- **macos-latest** — `cargo build --release --lib` + `cargo test --lib` must stay green (17 Mac tests; widget config changes shouldn't break Rust code since the widget is pure frontend)
- **windows-latest** — same. The Windows widget rendering can't be validated by CI (no GUI runner observation); S-CUX-04 + S-CUX-02 Windows-side empirical require Ross's wife's Win11 box

If CI green: spike infrastructure is sound; Mac empirical from Ross above is the gating signal.
If CI red: surface immediately — likely a `tauri.conf.json` schema mismatch.

---

## If spikes pass → Phase 2 plan

1. Add `bundle.macOS.LSUIElement = true` to `tauri.conf.json` (or create `src-tauri/macos/Info.plist` for the override) — Mac Dock-icon removal (D-CUX-01)
2. Wire native Menu API for right-click (D-CUX-15: Capture / Pick File / Expand / Settings / Quit)
3. Implement Expand mode: right-click "Expand…" → `set_size(800, 600)` + `set_url("/")` to load existing `index.html` UI; close button → collapse back
4. Position persistence: serialize on `Moved` event (debounced); restore on init from `AppConfig::widget_x/widget_y`
5. Phase 3 Windows: skipTaskbar already set; verify GHA Windows compile + Win11 smoke

## If S-CUX-03 fails → fallback escalation

Tauri 2's high-level API doesn't expose `NSPanel`-class behavior for focus-no-steal. Fallback: platform-specific Rust shim that, after Tauri creates the window, replaces the underlying NSWindow with NSPanel (or sets `_NSWindow_setAcceptsMouseMovedEvents`-style overrides via objc2). Estimated +1-2 days on Phase 2.

For Windows: analogous fallback adds `WS_EX_NOACTIVATE` via Win32 `SetWindowLongPtrW` after window creation (windows crate `Win32_UI_WindowsAndMessaging` already in deps from Phase B).

---

## If S-CUX-05 fails → fallback escalation

`data-tauri-drag-region` unreliable for click-vs-drag distinguishability. Fallback: explicit drag handle area — e.g., top 16px strip is drag, bottom 84px is button hit area. Slightly less Plaud-comparable UX but functional. ~0.5 day adjustment.

---

*WP-Threshold-Compact-UX Phase 1 spike — empirical-gated next steps. Ross fills in observations; Phase 2 dispatch contingent on S-CUX-01/03/05 pass.*
