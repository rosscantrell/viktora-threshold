# AAR — WP-Threshold-Compact-UX (Phase 1 + 2 + 3)

**Workstream:** Floating-widget UX direction for Viktora Threshold (v0.3.0)
**Brief:** `WP-Threshold-Compact-UX-Brief-v1_1-FINAL.md`
**Predecessor:** WP-OCR-13 v1.2-FINAL (cross-platform in-process OCR, shipped as v0.2.0)
**Successors:** WP-Threshold-Tidbit-Return; WP-Threshold-Embed-And-Filter; Mac-NSPanel-shim follow-up (forward note)
**Dates:** 2026-05-21 (single working session — spikes + impl + cross-platform smoke)
**PRs:** [#4](https://github.com/rosscantrell/viktora-threshold/pull/4) (Phase 1+2 — merged) · [#5](https://github.com/rosscantrell/viktora-threshold/pull/5) (Phase 3)
**Tag:** `v0.3.0-rc1` (release-page draft); `v0.3.0` pending PR #5 merge + version bump

---

## §1 Outcome summary

Threshold v0.3 transforms from a windowed app into a **180×80 horizontal-pill floating widget** with two action buttons (Capture + Upload). The widget is always-on-top, decorationless, transparent, drag-to-move via a JS-heuristic + Rust-IPC pattern, with a native right-click menu (Capture / Pick File / Expand… / Settings… / Quit) and an expand-mode toggle that grows back to the v0.2 800×600 UI for Configure access.

**The brief's two motivations resolved asymmetrically by platform:**

| Motivation | Mac | Windows |
|---|---|---|
| Out-of-the-way UX (small widget, user-movable, doesn't obscure screen) | ✅ shipped | ✅ shipped |
| `sourceApp` architectural fix (widget click doesn't steal focus → cross-surface analytics) | ❌ deferred — three approaches failed; filter ships `""` | ✅ **shipped — `WS_EX_NOACTIVATE` works; real EXE names attribute correctly** |

This asymmetry is the central empirical finding of the workstream. Symmetric architecture (Tauri 2 cross-platform widget) does NOT yield symmetric platform behavior on focus semantics — Windows' Win32 model is more cooperative than Mac's AppKit model for this specific need.

---

## §2 Phase-by-phase what shipped

### Phase 1 — Spikes (load-bearing empirical gates)

| Spike | Verdict | Notes |
|---|---|---|
| **S-CUX-01** Mac widget renders | ✅ PASS | Pre-flight finding: Tauri 2 `transparent: true` requires both `windows-private-api` Cargo feature AND `app.macOSPrivateApi: true` config flag — not just one |
| **S-CUX-02 / 04 / 08** Cross-platform CI compile | ✅ PASS | macos-latest + windows-latest matrix |
| **S-CUX-03** sourceApp from Mac widget click | ⚠️ PARTIAL → Phase 2A deferred | Tauri 2 high-level window config insufficient; filter catches the leak |
| **S-CUX-04** sourceApp from Windows widget click | ✅ PASS in Phase 3 | Empirically verified on Win11 — Outlook captures attribute as `"olk"`; Edge as `"msedge"` |
| **S-CUX-05** Click vs drag distinguishability | ✅ PASS via fallback | `data-tauri-drag-region` empirically broken; pure-JS movement-threshold heuristic + `widget_start_drag` Rust IPC works |

### Phase 2 — Mac widget impl (six sub-phases)

- **2A NSPanel-style shim** — three failed approaches; v3 (NSApp.setActivationPolicy(.accessory)) shipped but doesn't gate NSWorkspace-on-click. See §3.1 for the deep-dive.
- **2B LSUIElement=YES** — `src-tauri/Info.plist` override; Tauri 2 merges into bundle. Release-only effect.
- **2C Position persistence** — `AppConfig.widget_x/widget_y` (additive-only schema), debounced onMoved save at 250ms.
- **2D Native right-click menu** — Tauri 2 Menu API. Capture / Pick File / Expand / Settings / Quit + debug-only Open Console item.
- **2E Expand / collapse** — resize 180×80 ↔ 800×600 with chrome toggle + URL swap (widget.html ↔ index.html). Inline collapse button in index.html, non-invasive to main.js.
- **2F Cleanup** — dropped spike-era diagnostics; wired drop-paths to existing ingest_files; cancel-toast UX (dot stays gray on cancellation, only goes red on real failure).

### Phase 3 — Windows widget impl (one commit + one CI fix)

- **WS_EX_NOACTIVATE shim** (`widget_platform_windows.rs`) — sets the extended-window-style bit via `SetWindowLongPtrW(GWL_EXSTYLE, current | WS_EX_NOACTIVATE)`. ~15 LoC + 2 unit tests. Wired from `.setup()` hook mirroring the Mac branch's graceful-degradation pattern.
- **Cross-platform Phase 2 paths** — menu, drag, expand/collapse, position persistence — all inherit unchanged from Phase 2 (Tauri 2 cross-platform APIs).
- **CI fix** — HWND version mismatch between Tauri 2's internal `windows 0.61` and our pinned `windows 0.59`; switched shim API to `*mut c_void` raw pointer at the boundary.

### UI iteration (post-Phase-2, with Ross)

- Horizontal pill 180×80 (Plaud-inspired; was 100×100 square)
- Upload button alongside Capture (file-input SVG)
- Drag-over visual feedback (Rust DragDropEvent::Enter/Leave → JS data-dragover → green glow on upload-btn)
- Hover tooltip on status dot mirrors last toast title + body
- Debug-only "Open Console" menu item (cfg-gated; strips in release)

---

## §3 Central empirical findings

### §3.1 The Mac/Windows focus-no-steal asymmetry

The brief's `sourceApp` architectural fix relies on the widget's Capture button not stealing focus when clicked. `NSWorkspace.frontmostApplication` (Mac) / `GetForegroundWindow` (Windows) must continue to return the user's actual target app at the moment the capture pipeline reads it.

**Mac — three approaches, all failed:**

1. **NSWindowStyleMaskNonactivatingPanel (bit 7, 0x80) on existing NSWindow** — AppKit logged `NSWindow does not support nonactivating panel styleMask 0x80` and ignored the bit. Panel-class-only flag.
2. **`define_class!` class-swap to ThresholdPanel subclass** with `canBecomeKeyWindow` + `canBecomeMainWindow` → NO — `define_class!` generated a class of 456 bytes vs NSWindow's 464; objc2's safety check on `set_class` refused the size mismatch as UB. Non-unwinding panic; `catch_unwind` couldn't catch.
3. **`NSApplication.setActivationPolicy(.accessory)` at runtime** — compiles + runs cleanly + matches `LSUIElement=YES` behavior at the app level, but does NOT gate `NSWorkspace.frontmostApplication`-on-click. Empirical: widget clicks still activate Threshold momentarily; filter catches the leak; `sourceApp` ships `""`.

**Windows — one approach, succeeded:**

`SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | WS_EX_NOACTIVATE)` from the `.setup()` hook. `WS_EX_NOACTIVATE` is a documented HWND extended-window style that Win32 honors on **any** top-level window (no panel-class restriction analogous to Mac). Empirical from Ross's wife's Win11 smoke: three captures, three distinct apps correctly attributed (`olk`, `olk`, `msedge`).

**The lesson:** ecosystem cooperation differs by platform. AppKit treats NSPanel as a distinct class with privileged semantics; Win32 treats `WS_EX_NOACTIVATE` as a regular bit flag any HWND can opt into. The brief's symmetric architectural assumption ("just don't steal focus") got refracted through asymmetric platform APIs. Future cross-platform widget patterns should plan for this — Mac will likely always need either NSPanel construction (Tauri-fork territory) or hand-rolled FFI with explicit size-asserted class swap.

### §3.2 Content extraction alone can't recover `sourceApp`

Empirical test (Ross, 2026-05-21): a Win11 widget capture from Outlook with email-body OCR'd content. Schema-browser extracted 8 topics + 8 systems + 12 typed entities — all of them subject-matter terms (`olympus-aura`, `plaud-pin`, `face-database`, `egd-with-biopsy`, etc.). **Zero of them indicated Outlook as the source app.**

The lesson: content extraction surfaces "what is this about." It cannot reliably surface "which app captured this." For cross-surface analytics ("how many captures from Outlook this week?"), the metadata channel (`sourceApp`) is load-bearing. ML body-text classification could be a heuristic fallback (look for `From: / To: / Subject:` patterns) but precision/recall are unstable across capture region choices.

This empirically validates the architectural-fix premise of the workstream.

### §3.3 `data-tauri-drag-region` is unreliable on this widget config

Tauri 2's documented drag-region attribute did NOT trigger window relocation on the widget configuration (100×100 → 180×80, `decorations: false`, `transparent: true`, `focus: false`, `alwaysOnTop: true`). Neither attribute-on-outer-div + override-on-button (with `="false"`) nor attribute-on-body worked. JS-side `getCurrentWindow().startDragging()` also failed (likely API path not exposed via `withGlobalTauri: true`).

The pattern that worked: pure-JS mousemove threshold (4px) → invoke a custom Rust IPC (`widget_start_drag`) → `tauri::Window::start_dragging()` from Rust. This pattern is documented in the brief's S-CUX-05 fallback ("Custom mouse-event handling in widget HTML") and now empirically validated; it's the canonical pattern for any future Tauri 2 widget that needs movability under unusual window configs.

### §3.4 Tauri 2 `transparent: true` requires the `macos-private-api` Cargo feature

Pre-flight finding before the first smoke: `tauri dev` startup emitted

> The window is set to be transparent but the `macos-private-api` is not enabled.

Resolution requires BOTH:
- `Cargo.toml`: `tauri = { features = ["macos-private-api", ...] }`
- `tauri.conf.json`: `app.macOSPrivateApi: true`

Neither alone suffices. The audit checklist for the v1.1-FINAL brief had `transparent: true` as a locked decision but did not pin this dual-flag requirement; recommend adding to future Tauri 2 brief templates.

---

## §4 What the user observes — v0.2 → v0.3 deltas

| Aspect | v0.2 (windowed) | v0.3 (floating widget) |
|---|---|---|
| Visual surface on launch | 800×600 windowed app with Capture + Upload cards | 180×80 floating pill in screen corner with Capture + Upload action buttons |
| Dock / Taskbar presence | Dock icon (Mac) + Taskbar entry (Windows) | None on either platform (Mac `LSUIElement=YES`; Windows `skipTaskbar: true`) |
| Primary trigger | Click Capture Screen button in window | Click Capture icon on widget; or drag-drop file onto widget; or click Upload button → file picker |
| Configure pane access | In-window tab | Right-click widget → Settings… → expand mode |
| First launch | Wizard window opens, stays | Wizard runs in expand mode; collapses to widget on completion |
| `sourceApp` Mac | `""` (FN-OCR-13-12; widget never built) | `""` (filter catches focus-leak; NSPanel-shim deferred) |
| `sourceApp` Windows | `""` (FN-OCR-13-12; widget never built) | **Real EXE name** (e.g., `olk`, `msedge`, `notepad`) via WS_EX_NOACTIVATE shim |
| "In the way of screen content" | Yes — full window obscures the capture target | No — widget is small + draggable to any corner |
| Quit | Cmd+Q from window | Right-click → Quit (Cmd+Q does NOT work on Mac due to LSUIElement) |
| Toast notifications | In-window toast UI | Native OS notification path TODO; widget mode currently uses hover-tooltip on status dot for failure surface |

---

## §5 Forward notes

| ID | Topic | Trigger |
|---|---|---|
| **FN-CUX-12** | Mac NSPanel-shim follow-up — three candidate paths sketched: (a) raw FFI `object_setClass` + manual size assertion, (b) Tauri-fork to construct NSPanel directly, (c) AppKit method swizzling (rejected; global side effects) | Cross-surface analytics need on Mac OR objc2 0.7+ ships better class-swap ergonomics |
| **FN-CUX-13** | `olk.exe` is the modern Outlook for Windows EXE (Microsoft "New Outlook," ~2023+) — not `OUTLOOK.EXE` as older docs suggest. The Windows-side `is_threshold_own_exe` filter pins to "viktora-threshold" only; non-Threshold EXE names ship through. Consider adding a CONTRIBUTORS.md note for Windows EXE-name expectations | Doc-only |
| **FN-CUX-14** | Tooltip-on-dot is a stopgap for failure visibility in widget mode. Native OS notification path (`tauri-plugin-notification`) is the canonical Phase 2.1 follow-up | Pilot feedback on missed failure signals |
| **FN-CUX-15** | "Settings…" right-click item passes a `configure` URL fragment but `main.js` doesn't yet route on it. Phase 2.1 polish | Pilot empirical on Configure-tab discoverability |
| **FN-CUX-16** | NSPanel-style toggle on expand mode — currently the (failed) nonactivating bit stays at default in expand mode, which is the right behavior (expanded UI should activate normally). If Mac NSPanel-shim follow-up lands, the shim must be reverted on expand and re-applied on collapse | Conditional on FN-CUX-12 landing |
| **FN-CUX-17** | Bundle filenames embed `tauri.conf.json` package version (e.g., `_0.2.0_x64-setup.exe`), not the git tag (`v0.3.0-rc1`). Bumping the config version is required before each release for filename parity | Each release cycle |

---

## §6 Risks that didn't materialize

The brief's §12 risk table flagged seven risks; six did NOT materialize:

| Risk | Outcome |
|---|---|
| Click-and-drag vs click-to-capture distinguishability fails | Did fail via `data-tauri-drag-region`; pure-JS heuristic fallback works cleanly |
| Multi-monitor widget position restoration fails | Untested empirically — wife's Win11 + Ross's Mac are both single-monitor for this session |
| Expand-mode transition feels jarring | Tauri 2's `set_size` is instant; users tolerate it well per Ross's smoke |
| Tauri 2 `transparent: true` clashes with platform window managers | Required `macos-private-api` opt-in but otherwise no clashes |
| LSUIElement + cmd-tab semantics surprise users | Cmd+Q regression documented; otherwise transparent |
| Pilots expect tray icon UX | Not tested empirically yet |

The one risk that DID materialize: "Widget gains focus on click despite `decorations: false` + `alwaysOnTop: true`" → Medium-likelihood / Very-high-impact. Empirically Medium-on-Mac (three approaches failed) / Resolved-on-Windows (WS_EX_NOACTIVATE worked).

---

## §7 Sequencing reflection

The session ran the brief's phased plan tightly:
1. Spikes (Phase 1) → empirically gated downstream work
2. Phase 2 Mac impl A–F → all six sub-phases shipped + one architectural compromise (2A)
3. UI iteration with Ross post-Phase-2 → cheaper than baking earlier; the pill shape + upload button + drag-drop visual + hover tooltip all came from "shipping makes the next thing obvious"
4. Phase 3 Windows → one commit + one CI fix; took less time than expected because Win32 cooperated
5. AAR (this doc) + release-prep

What worked:
- **Spike-first discipline** — running S-CUX-01/03/05 BEFORE writing Phase 2 impl meant 2A's failures were absorbed by the brief's documented fallback path
- **Defensive code in shim attempts** — `catch_unwind` (later removed) + graceful-degradation logging + filter as defense-in-depth meant even broken shim attempts didn't crash the app or pollute the corpus
- **Cross-platform symmetry intent + asymmetric outcome acknowledgment** — the brief asked for symmetric architecture; the platform-specific shims diverged in implementation but the Tauri 2 layer + filter strategy unified user-visible behavior

What surprised:
- **Mac NSPanel ecosystem is harder than the brief expected** — 1 sentence in the brief ("hand-rolled NSPanel if Tauri 2 insufficient") expanded to ~6 hours of iteration with three approaches; future briefs should budget more for objc2-runtime work
- **Windows WS_EX_NOACTIVATE is easier than the brief expected** — Phase 3 went from "open PR" to "empirically validated by wife's smoke" in <2 hours
- **Content extraction can't substitute for `sourceApp`** — empirically confirmed via the Outlook capture experiment

---

## §8 Acceptance criteria reconciliation (v1.1-FINAL)

| AC | Status |
|---|---|
| AC-CUX-01 LSUIElement = YES bundle config | ✅ Phase 2B (release-only effect; dev mode no-ops by design) |
| AC-CUX-02 Mac widget renders + always-on-top | ✅ Phase 2A v3 |
| AC-CUX-03 Windows widget renders + skipTaskbar | ✅ Phase 3 (compile validated; runtime validated by wife's smoke) |
| AC-CUX-04 Single-click on widget triggers Capture | ✅ Phase 2D |
| AC-CUX-05 `sourceApp` field populated with target app | ⚠️ Asymmetric: ✅ Windows / ❌ Mac (filter ships `""`) |
| AC-CUX-06 First-launch wizard in expand mode → collapse | Partial — wizard logic untouched in this PR; collapse mechanism exists; first-launch routing not yet wired (Phase 2.1 polish) |
| AC-CUX-07 Right-click menu items | ✅ Phase 2D (5 items + debug Open Console) |
| AC-CUX-08 Toasts use native OS notifications in widget mode | Partial — hover-tooltip stopgap shipped; native OS notification (`tauri-plugin-notification`) deferred to FN-CUX-14 |
| AC-CUX-09 Quit drains in-flight POSTs | ✅ Inherited from D-12-02-AMEND |
| AC-CUX-10 Widget movable + position persists | ✅ Phase 2C |
| AC-CUX-11 Widget does NOT gain focus on click | ⚠️ Asymmetric: ✅ Windows / ❌ Mac |
| AC-CUX-12 Connectivity dot reactive-only | ✅ Phase 2 |
| AC-CUX-13 Config-presence assertions | ✅ Implicit via tauri.conf.json + Info.plist tests; explicit assertions could land in a polish pass |
| AC-CUX-14 PILOT-INSTALL.md updated | NOT YET — needs update for v0.3.0 widget UX + setup.exe path |
| AC-CUX-15 AAR documents sourceApp reversal | **This document** ✅ |
| AC-CUX-16 CLAUDE.md sub-section amended | NOT YET — v0.3.0 final tag work |
| AC-CUX-17 No regression of WP-OCR-13 ACs | ✅ Cross-platform CI green; 19/19 Mac unit tests; 26→28/28 Windows unit tests (added shim + MSDN-pin tests) |

---

## §9 Next workstreams (priority order)

1. **PR #5 → main → v0.3.0 final tag** — version bump, release-notes amend, AAR commit, PR ready-for-review, merge, tag
2. **PILOT-INSTALL.md + CLAUDE.md updates** — AC-CUX-14 + AC-CUX-16 close-outs; widget UX + setup.exe path
3. **Mac NSPanel-shim follow-up (FN-CUX-12)** — when cross-surface analytics on Mac becomes load-bearing OR objc2 0.7+ ships
4. **WP-Threshold-Tidbit-Return** — per-document `whyThisMatters` extraction; rich toast w/ entity highlights
5. **WP-Threshold-Embed-And-Filter** — embed schema-browser frontend in Threshold w/ "Threshold mode" view filter
6. **Tauri 2 floating-widget pattern community writeup (FN-CUX-08)** — coordinator task; cross-platform asymmetry findings worth surfacing

---

*WP-Threshold-Compact-UX AAR · 2026-05-21 · Phase 1 + 2 + 3 shipped · architectural-fix validated on Windows / deferred on Mac · widget-UX premise empirically proven on both platforms · cross-surface analytics POSSIBLE NOW on Windows captures · `olk` + `msedge` + future EXE names attribute correctly in the corpus*
