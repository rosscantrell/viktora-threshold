// WP-Threshold-Compact-UX Phase 1 spike — widget interactions.
//
// Goals:
//   1. Single-click on Capture button → invoke run_screen_capture (existing
//      Phase B IPC; no Rust changes needed for spike)
//   2. Observe toast event payload → flip status dot color (AC-CUX-12 reactive)
//   3. Surface S-CUX-03 empirical: did sourceApp come back as the target app?
//      Logged to devtools console so we can read it during the spike smoke.
//   4. Right-click stubbed for Phase 2 (native Menu API wiring).
//
// What this spike does NOT do:
//   - LSUIElement YES (handled at bundle config, not runtime)
//   - Position persistence (Phase 2)
//   - Expand-mode toggle (Phase 2)
//   - Native context menu (Phase 2)
//   - Native OS notifications (Phase 2 — relies on tauri-plugin-notification)

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const listen = tauri.event.listen;

const captureBtn = document.getElementById("capture-btn");
const statusDot = document.getElementById("status-dot");

function setStatus(state) {
  statusDot.classList.remove("status-unknown", "status-ok", "status-err");
  statusDot.classList.add(`status-${state}`);
}

async function init() {
  console.log("[widget-spike] init");
  // Per AC-CUX-12 reactive-only cadence: don't auto-ping /api/health.
  // Status dot starts gray (unknown) until first POST or user-triggered test.
  try {
    const cfg = await invoke("load_config");
    console.log("[widget-spike] config loaded:", cfg ? "yes" : "(none)");
  } catch (err) {
    console.warn("[widget-spike] load_config failed:", err);
  }
}

captureBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  console.log("[widget-spike] capture click — invoking run_screen_capture");
  try {
    await invoke("run_screen_capture");
  } catch (err) {
    console.error("[widget-spike] capture failed:", err);
    setStatus("err");
  }
});

// Right-click context menu — stub for spike. Phase 2 wires the native
// Menu API: Capture Screen / Pick File… / Expand… / Settings… / Quit.
captureBtn.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  console.log("[widget-spike] right-click (menu stub — Phase 2)");
});

// Observe toast events from the existing run_screen_capture path.
// The toast payload includes title, body, kind ('success'|'idempotent'|'failure');
// the widget surfaces success/failure as the connectivity-dot flip
// (AC-CUX-12 reactive). Full native OS notifications come in Phase 2.
listen("threshold://toast", (event) => {
  const outcome = event.payload;
  console.log("[widget-spike] toast event:", outcome);
  setStatus(outcome.kind === "failure" ? "err" : "ok");
});

// Bind to drop-paths event for parity with the existing UI (drag-drop on
// the widget window itself — D-12-04 surface). Phase 1 just logs; full
// ingestion path already exists in main.js for the expand-mode UI.
listen("threshold://drop-paths", (event) => {
  console.log("[widget-spike] drop-paths event:", event.payload);
});

init();
