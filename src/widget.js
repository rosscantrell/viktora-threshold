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
const uploadBtn = document.getElementById("upload-btn");
const statusDot = document.getElementById("status-dot");
const expandBtn = document.getElementById("expand-btn");

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

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // left button only
  mouseDownAt = { x: e.screenX, y: e.screenY };
  dragInitiated = false;
});

document.addEventListener("mousemove", async (e) => {
  if (!mouseDownAt || dragInitiated) return;
  const dx = e.screenX - mouseDownAt.x;
  const dy = e.screenY - mouseDownAt.y;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
    dragInitiated = true;
    try {
      await invoke("widget_start_drag");
    } catch (err) {
      console.warn("[widget] widget_start_drag failed:", err);
    }
  }
});

document.addEventListener("mouseup", () => {
  mouseDownAt = null;
  // Defer clearing dragInitiated by one tick so the click handler can
  // check it and bail out (browsers fire mouseup → click in that order).
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
    return;
  }
  e.stopPropagation();
  try {
    await invoke("run_screen_capture");
  } catch (err) {
    console.warn("[widget] capture failed:", err);
    setStatus("err");
  }
});

// Upload button — opens the file picker (native NSOpenPanel via
// tauri-plugin-dialog). Selected files are then routed through the
// existing ingest_files IPC. The button also serves as the visual home
// for the OS-level drag-drop target — `data-dragover` styling reacts to
// the window's DragDrop events surfaced from Rust (`onDragEnter` etc.).
uploadBtn.addEventListener("click", async (e) => {
  if (dragInitiated) return;
  e.stopPropagation();
  try {
    const paths = await invoke("pick_files");
    if (Array.isArray(paths) && paths.length > 0) {
      await invoke("ingest_files", { paths });
    }
  } catch (err) {
    console.warn("[widget] upload failed:", err);
    setStatus("err");
  }
});

// Expand button — opens the full window (main view). Mirrors the right-click
// "Expand…" menu item but as an always-visible affordance. Same drag-vs-click
// guard as the other buttons so a drag that ends over it doesn't expand.
expandBtn.addEventListener("click", async (e) => {
  if (dragInitiated) return;
  e.stopPropagation();
  try {
    await invoke("widget_expand", { targetTab: null });
  } catch (err) {
    console.warn("[widget] expand failed:", err);
  }
});

// WP-CHECKIN-BRIEF — bottom-center chevron pulls down the check-in glance
// (morning / mid-day / evening) instead of the full Today surface. Same
// drag-vs-click guard as the other buttons.
const briefBtn = document.getElementById("brief-btn");
if (briefBtn) {
  briefBtn.addEventListener("click", async (e) => {
    if (dragInitiated) return;
    e.stopPropagation();
    try {
      await invoke("widget_show_brief");
    } catch (err) {
      console.warn("[widget] show brief failed:", err);
    }
  });
}

// Right-click context menu (D-CUX-15, Phase 2D).
// The Rust IPC builds + popups the native menu. menu_event dispatcher in
// the Tauri builder handles the chosen item. Bind on the WHOLE widget,
// not just the Capture button — right-click anywhere on the widget body
// surfaces the menu.
document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  try {
    await invoke("show_widget_menu");
  } catch (err) {
    console.warn("[widget] show_widget_menu failed:", err);
  }
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
listen("threshold://toast", async (event) => {
  const outcome = event.payload;
  // Mirror title + body into the status dot's tooltip so hovering the
  // dot reveals the last toast inline. Surfaces failure reasons without
  // requiring devtools or a separate toast UI.
  const tooltip = [outcome.title, outcome.body].filter(Boolean).join(" — ");
  statusDot.title = tooltip || "Connectivity";
  console.log("[widget] toast:", outcome);

  // Heuristic: cancellation titles use "cancelled" or "timed out" wording.
  // Don't go red on those — they're user actions, not system failures.
  // Also don't push a native notification for cancellations (the user
  // explicitly cancelled; they know).
  const titleLc = (outcome.title || "").toLowerCase();
  if (titleLc.includes("cancel") || titleLc.includes("timed out")) {
    setStatus("unknown");
    return;
  }

  setStatus(outcome.kind === "failure" ? "err" : "ok");

  // FN-CUX-14 — native OS notification alongside the dot-color update.
  // Fires for both successes (so the user sees "Captured: X — extracted
  // N terms" appear in Notification Center) and real failures.
  // Cancellations early-returned above to avoid notification spam.
  await maybeShowNotification(outcome);
});

// Native OS notifications via tauri-plugin-notification. The plugin
// guards behind a one-time permission grant (Notification Center prefs
// on Mac; Windows Action Center settings on Win11). Falls back silently
// if the plugin isn't loaded or permission is denied — the status dot
// + hover tooltip remain as the diagnostic surface.
async function maybeShowNotification(outcome) {
  try {
    const notif = window.__TAURI__?.notification;
    if (!notif || typeof notif.sendNotification !== "function") {
      // Plugin not exposed; abort silently.
      return;
    }
    let granted =
      typeof notif.isPermissionGranted === "function"
        ? await notif.isPermissionGranted()
        : true;
    if (!granted && typeof notif.requestPermission === "function") {
      const result = await notif.requestPermission();
      granted = result === "granted";
    }
    if (!granted) return;
    notif.sendNotification({
      title: outcome.title || "Threshold",
      body: outcome.body || "",
    });
  } catch (err) {
    console.warn("[widget] notification failed:", err);
  }
}

// Drag-drop ingestion on the widget surface (D-12-04 inheritance).
// Rust emits drag-enter / drag-leave / drop-paths events; we surface
// the drag-state on the upload-btn via a `data-dragover` attribute that
// the widget.css responds to with a green highlight, and route dropped
// files through the existing ingest_files pipeline.
listen("threshold://drag-enter", () => {
  uploadBtn.dataset.dragover = "true";
});

listen("threshold://drag-leave", () => {
  uploadBtn.dataset.dragover = "false";
});

listen("threshold://drop-paths", async (event) => {
  uploadBtn.dataset.dragover = "false";
  const paths = event.payload;
  if (!Array.isArray(paths) || paths.length === 0) return;
  try {
    await invoke("ingest_files", { paths });
  } catch (err) {
    console.warn("[widget] ingest_files failed:", err);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// WP-Threshold-Tidbit-Return Phase B — tidbit-arrived event
// ───────────────────────────────────────────────────────────────────────────
//
// Fired by the Rust polling loop (`poll_for_tidbit`) when a capture's marker
// pipeline completes with status='ready'. The Rust side has already stored
// the tidbit in AppState via `handle_tidbit_ready` so the expanded UI can
// retrieve it via `get_pending_tidbit` IPC.
//
// Three responses (PB-2 hybrid (c) + best-effort (a)):
//   1. Show the indicator badge — primary user-facing affordance
//   2. Pulse the widget — extra attention signal (FN-CUX-05)
//   3. Fire a native OS notification — best-effort surface; user might not
//      even be looking at the widget when the tidbit lands

const tidbitIndicator = document.getElementById("tidbit-indicator");

if (tidbitIndicator) {
  tidbitIndicator.addEventListener("click", async (e) => {
    if (dragInitiated) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      await invoke("widget_expand", { targetTab: "tidbit" });
    } catch (err) {
      console.warn("[widget] tidbit expand failed:", err);
    }
    // Hide the badge as soon as the user acts on it. The Rust side's
    // pending_tidbit stays populated until the panel reads it via
    // get_pending_tidbit — that's intentional so the panel actually has
    // data after navigation. The panel itself calls clear_pending_tidbit
    // when the user closes/collapses.
    tidbitIndicator.hidden = true;
  });
}

listen("threshold://tidbit-arrived", async (event) => {
  const tidbit = event.payload || {};
  console.log("[widget] tidbit arrived:", tidbit.title);

  // 1. Show indicator badge
  if (tidbitIndicator) {
    tidbitIndicator.hidden = false;
    tidbitIndicator.title = tidbit.title || "Tap to see the latest preview";
  }

  // 2. Pulse the widget (FN-CUX-05)
  const widgetEl = document.getElementById("widget");
  if (widgetEl) {
    widgetEl.classList.remove("tidbit-pulse"); // restart animation if mid-pulse
    // Force reflow so re-adding the class actually restarts the animation.
    void widgetEl.offsetWidth;
    widgetEl.classList.add("tidbit-pulse");
    setTimeout(() => widgetEl.classList.remove("tidbit-pulse"), 2200);
  }

  // 3. Native OS notification (PB-3: title only; body intentionally empty
  //    so OS surfaces the title prominently and the full preview is reserved
  //    for the widget panel). Reuses the existing maybeShowNotification
  //    permission/availability path so the widget's notification logic stays
  //    single-source-of-truth (matches the capture toast pattern). The
  //    plugin's plain-body notification click handler is unreliable
  //    cross-platform; PB-2 hybrid lean is "widget click is the always-works
  //    path, notification click is best-effort." If a future Tauri plugin
  //    update makes notification clicks reliable, wire `on_action` back
  //    through the plugin builder to invoke `widget_expand("tidbit")`.
  await maybeShowNotification({
    title: tidbit.title || "Apolla has a preview for you",
    body: "",
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WP-THRESHOLD-LOG-UX — records-arrived event + ambient "Today" badge
// ───────────────────────────────────────────────────────────────────────────
//
// records-arrived fires from the Rust `poll_for_records` loop when a capture's
// decision/commitment records land (≈every capture once the log is enabled
// server-side). It reuses the SAME post-capture indicator badge as the tidbit
// path — one click opens the records-primary panel — but fires NO OS
// notification (records land on every capture; a notification each time would
// be spam). It also refreshes the ambient badge, since a new capture can change
// what needs attention.

listen("threshold://records-arrived", async (event) => {
  const payload = event.payload || {};
  const records = Array.isArray(payload.records) ? payload.records : [];
  console.log("[widget] records arrived:", records.length);

  if (tidbitIndicator) {
    tidbitIndicator.hidden = false;
    tidbitIndicator.title =
      records.length === 1
        ? "1 decision/commitment captured — tap to view"
        : `${records.length} decisions/commitments captured — tap to view`;
  }

  // Pulse the widget (same attention signal as the tidbit path).
  const widgetEl = document.getElementById("widget");
  if (widgetEl) {
    widgetEl.classList.remove("tidbit-pulse");
    void widgetEl.offsetWidth;
    widgetEl.classList.add("tidbit-pulse");
    setTimeout(() => widgetEl.classList.remove("tidbit-pulse"), 2200);
  }

  // A fresh capture can shift the needs-attention count — refresh the badge.
  refreshLogBadge();
});

// Ambient "needs attention" badge (top-left, amber-orange, count-bearing).
const logIndicator = document.getElementById("log-indicator");

if (logIndicator) {
  logIndicator.addEventListener("click", async (e) => {
    if (dragInitiated) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      await invoke("widget_expand", { targetTab: "log" });
    } catch (err) {
      console.warn("[widget] log expand failed:", err);
    }
  });
}

/**
 * WP-R2 — the amber "Today" badge now counts what needs you TODAY: the ratify
 * queue's pending proposals (get_proxy_queue_count) PLUS the overdue-silent
 * decision-log items (get_decision_log_summary → summary.overdueSilent). The
 * rebuilt Today view leads with the "Needs you" queue, so the badge points at
 * that pile + the overdue tail. Both counts are summed CLIENT-SIDE from the two
 * existing best-effort IPCs (each returns 0 on any error), so no server change
 * is needed. Hidden at zero; capped display at "99+".
 */
async function refreshLogBadge() {
  if (!logIndicator) return;
  let shown = false;
  try {
    // Fetch both in parallel; each returns 0 on any error (best-effort).
    const [overdueRaw, pendingRaw] = await Promise.all([
      invoke("get_decision_log_summary").catch(() => 0),
      invoke("get_proxy_queue_count").catch(() => 0),
    ]);
    const overdue = typeof overdueRaw === "number" ? overdueRaw : 0;
    const pending = typeof pendingRaw === "number" ? pendingRaw : 0;
    const n = overdue + pending;
    if (n > 0) {
      logIndicator.textContent = n > 99 ? "99+" : String(n);
      logIndicator.title = `${n} need${n === 1 ? "s" : ""} you today — open Today`;
      shown = true;
    }
  } catch (err) {
    console.warn("[widget] Today badge fetch failed:", err);
  }
  logIndicator.hidden = !shown;
  // The expand icon shares the top-left slot with the badge — show it only when
  // the badge isn't there. When the badge IS shown, clicking it expands too
  // (to Today), so the expand affordance is never actually lost.
  if (expandBtn) expandBtn.hidden = shown;
}

// Fetch the badge count now and hourly thereafter (per-capture refresh is wired
// in the records-arrived handler above). 60 min keeps the always-on widget
// quiet while still catching due-date rollovers on a long-running session.
const LOG_BADGE_REFRESH_MS = 60 * 60 * 1000;
refreshLogBadge();
setInterval(refreshLogBadge, LOG_BADGE_REFRESH_MS);

// ───────────────────────────────────────────────────────────────────────────
// WP-CASCADE-PRODUCTION WP-T1 — proxy-inbox pending badge
// ───────────────────────────────────────────────────────────────────────────
//
// Same shape as the ambient log badge (best-effort count, hidden at zero, capped
// at "99+"), but a DISTINCT badge: bottom-right, amber, count of pending
// proxy-fleet proposals (get_proxy_queue_count). Clicking opens the proxy inbox.

const proxyIndicator = document.getElementById("proxy-indicator");

if (proxyIndicator) {
  proxyIndicator.addEventListener("click", async (e) => {
    if (dragInitiated) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      await invoke("widget_expand", { targetTab: "proxy-queue" });
    } catch (err) {
      console.warn("[widget] proxy expand failed:", err);
    }
  });
}

/**
 * Fetch the pending proxy-queue count via get_proxy_queue_count and reflect it
 * on the amber badge. Best-effort: the Rust command returns 0 on any error, so
 * the badge just stays hidden. Hidden at zero; capped display at "99+".
 */
async function refreshProxyBadge() {
  if (!proxyIndicator) return;
  let shown = false;
  try {
    const count = await invoke("get_proxy_queue_count");
    const n = typeof count === "number" ? count : 0;
    if (n > 0) {
      proxyIndicator.textContent = n > 99 ? "99+" : String(n);
      proxyIndicator.title = `${n} proxy proposal${n === 1 ? "" : "s"} waiting — open the inbox`;
      shown = true;
    }
  } catch (err) {
    console.warn("[widget] proxy queue count fetch failed:", err);
  }
  proxyIndicator.hidden = !shown;
}

// Same fetch-on-start + hourly cadence as the log badge.
refreshProxyBadge();
setInterval(refreshProxyBadge, LOG_BADGE_REFRESH_MS);

init();
