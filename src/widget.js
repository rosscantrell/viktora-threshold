// WP-Threshold-Compact-UX Phase 1 spike — widget interactions.
//
// Goals:
//   1. Single-click on Capture button → invoke run_screen_capture (existing
//      Phase B IPC; no Rust changes needed for spike)
//   2. Click-and-drag anywhere on widget body → native window reposition
//      via the Tauri 2 `startDragging` API (S-CUX-05 fallback —
//      `data-tauri-drag-region` was empirically unreliable on Mac with
//      `focus: false` + `transparent: true`; the JS click-vs-drag heuristic
//      is the brief's documented fallback path)
//   3. Observe toast event payload → flip status dot color (AC-CUX-12 reactive)
//   4. Right-click stubbed for Phase 2 (native Menu API wiring)
//
// What this spike does NOT do:
//   - LSUIElement YES (handled at bundle config, not runtime)
//   - Position persistence (Phase 2 — serialize after drag-end to config.json)
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

// ───────────────────────────────────────────────────────────────────────────
// Click-vs-drag heuristic (S-CUX-05 fallback per brief)
// ───────────────────────────────────────────────────────────────────────────
//
// Tauri 2's `data-tauri-drag-region` attribute didn't reliably register
// mousedown for drag on this widget config (100x100, decorations:false,
// transparent:true, focus:false, alwaysOnTop:true). Empirically verified
// 2026-05-21: drag fired from neither button nor border ring.
//
// Fallback: pure-JS movement-threshold heuristic. Tracks screen coords on
// mousedown; if mouse moves > DRAG_THRESHOLD_PX before mouseup, invoke
// the native `startDragging()` API on the current window. The browser-side
// click event still fires on the button when no drag was initiated, so
// capture-on-click keeps working.
//
// Threshold of 4px is tight enough to feel responsive but loose enough to
// absorb hand jitter on a fast tap. Tuneable in Phase 2 if pilot empirical
// suggests otherwise.

const DRAG_THRESHOLD_PX = 4;
let mouseDownAt = null;
let dragInitiated = false;

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // left button only
  mouseDownAt = { x: e.screenX, y: e.screenY };
  dragInitiated = false;
});

window.addEventListener("mousemove", async (e) => {
  if (!mouseDownAt || dragInitiated) return;
  const dx = e.screenX - mouseDownAt.x;
  const dy = e.screenY - mouseDownAt.y;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
    dragInitiated = true;
    try {
      const win = tauri.window.getCurrentWindow();
      await win.startDragging();
      console.log("[widget-spike] startDragging fired");
    } catch (err) {
      console.error("[widget-spike] startDragging failed:", err);
    }
  }
});

window.addEventListener("mouseup", () => {
  mouseDownAt = null;
  // Defer clearing dragInitiated by one tick so the click handler can
  // check it and bail out. Browsers fire mouseup → click in that order;
  // a 0ms setTimeout puts the reset after the click handler.
  setTimeout(() => {
    dragInitiated = false;
  }, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// Capture-button click
// ───────────────────────────────────────────────────────────────────────────

captureBtn.addEventListener("click", async (e) => {
  if (dragInitiated) {
    // The mousedown→mouseup was actually a drag; suppress the spurious click.
    console.log("[widget-spike] click suppressed — was a drag");
    return;
  }
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
//
// Cancellation (user pressed Esc OR didn't draw a region) currently fires
// kind:'failure' from the existing Phase B Mac path — distinct from a real
// failure. The widget treats both as "err" for now; Phase 2 will distinguish
// (e.g., cancellation → reset dot to unknown, no flash; real failure → red).
listen("threshold://toast", (event) => {
  const outcome = event.payload;
  console.log("[widget-spike] toast event:", outcome);

  // Heuristic: cancellation titles use "cancelled" or "timed out" wording.
  // Don't go red on those — they're user actions, not system failures.
  const title = (outcome.title || "").toLowerCase();
  if (title.includes("cancel") || title.includes("timed out")) {
    setStatus("unknown");
    return;
  }

  setStatus(outcome.kind === "failure" ? "err" : "ok");
});

// Bind to drop-paths event for parity with the existing UI (drag-drop on
// the widget window itself — D-12-04 surface). Phase 1 just logs; full
// ingestion path already exists in main.js for the expand-mode UI.
listen("threshold://drop-paths", (event) => {
  console.log("[widget-spike] drop-paths event:", event.payload);
});

init();
