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
  console.log("[widget] init");
  // Per AC-CUX-12 reactive-only cadence: don't auto-ping /api/health.
  // Status dot starts gray (unknown) until first POST or user-triggered test.
  try {
    const cfg = await invoke("load_config");
    console.log("[widget] config loaded:", cfg ? "yes" : "(none)");
  } catch (err) {
    console.warn("[widget] load_config failed:", err);
  }

  // D-CUX-16 position persistence: restore last-known widget position.
  // If no saved position, Tauri's `center: true` config kicks in on first
  // launch. After restore, we listen for the window's Moved event and
  // debounce-save the new position on drag-end.
  try {
    const saved = await invoke("get_widget_position");
    if (saved && Array.isArray(saved) && saved.length === 2) {
      const [x, y] = saved;
      const win = tauri.window.getCurrentWindow();
      const { PhysicalPosition } = tauri.window;
      await win.setPosition(new PhysicalPosition(x, y));
      console.log("[widget] restored position:", x, y);
    } else {
      console.log("[widget] no saved position; using Tauri default");
    }
  } catch (err) {
    console.warn("[widget] position restore failed:", err);
  }

  // Listen for window Moved events; debounce-save on drag-end.
  try {
    const win = tauri.window.getCurrentWindow();
    let saveTimer = null;
    await win.onMoved(async ({ payload }) => {
      // payload is { x, y } in PhysicalPosition units
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await invoke("save_widget_position", { x: payload.x, y: payload.y });
        } catch (err) {
          console.warn("[widget] position save failed:", err);
        }
      }, 250); // 250ms after last move → save once
    });
  } catch (err) {
    console.warn("[widget] could not wire onMoved listener:", err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Click-vs-drag heuristic (S-CUX-05 fallback per brief)
// ───────────────────────────────────────────────────────────────────────────
//
// Tauri 2's `data-tauri-drag-region` attribute didn't reliably register
// mousedown for drag on this widget config. Empirically verified
// 2026-05-21: drag fired from neither button nor border ring.
//
// Fallback v1 (JS startDragging API) ALSO failed empirically — possibly
// because `tauri.window.getCurrentWindow()` isn't exposed via
// `withGlobalTauri: true`, or because the Tauri 2 API path differs from
// what we tried.
//
// Fallback v2 (current): pure-JS movement-threshold heuristic that
// invokes a custom Rust IPC command `widget_start_drag`. The Rust side
// has direct access to the `tauri::Window` handle and calls
// `window.start_dragging()` from there. More robust than any JS-side path.
// Diagnostic logging is intentionally loud so console output during
// smoke can tell us which step (if any) is failing.

const DRAG_THRESHOLD_PX = 4;
let mouseDownAt = null;
let dragInitiated = false;

// Diagnostic — surface what's actually on `window.__TAURI__` for this build.
console.log("[widget-spike] __TAURI__ keys:", Object.keys(window.__TAURI__ || {}));
console.log("[widget-spike] __TAURI__.window:", window.__TAURI__?.window);

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // left button only
  mouseDownAt = { x: e.screenX, y: e.screenY };
  dragInitiated = false;
  console.log("[widget-spike] mousedown at", mouseDownAt.x, mouseDownAt.y);
});

document.addEventListener("mousemove", async (e) => {
  if (!mouseDownAt || dragInitiated) return;
  const dx = e.screenX - mouseDownAt.x;
  const dy = e.screenY - mouseDownAt.y;
  const dist = Math.hypot(dx, dy);
  if (dist > DRAG_THRESHOLD_PX) {
    dragInitiated = true;
    console.log("[widget-spike] mousemove crossed threshold (", dist.toFixed(1), "px) — invoking widget_start_drag");
    try {
      await invoke("widget_start_drag");
      console.log("[widget-spike] widget_start_drag returned");
    } catch (err) {
      console.error("[widget-spike] widget_start_drag failed:", err);
      // Also try the JS API path as a last-ditch — log either way.
      try {
        const win = tauri.window?.getCurrentWindow?.();
        if (win) {
          await win.startDragging();
          console.log("[widget-spike] JS startDragging fired (fallback path)");
        } else {
          console.warn("[widget-spike] no tauri.window.getCurrentWindow available");
        }
      } catch (jsErr) {
        console.error("[widget-spike] JS startDragging also failed:", jsErr);
      }
    }
  }
});

document.addEventListener("mouseup", () => {
  if (mouseDownAt) {
    console.log("[widget-spike] mouseup (drag=", dragInitiated, ")");
  }
  mouseDownAt = null;
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
