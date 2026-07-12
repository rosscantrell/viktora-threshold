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

import { ROUTINES, loadRoutines, timeToMinutes } from "./routines.js";

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

// ───────────────────────────────────────────────────────────────────────────
// WP-CHECKIN-BRIEF — gentle morning / mid-day / evening check-in pings.
// ───────────────────────────────────────────────────────────────────────────
//
// The widget is always resident, so a light per-minute clock check fires ONE
// native notification at each check-in time (once per day), pulses the pill, and
// nudges the user to pull down the brief. State is kept in localStorage so a
// relaunch mid-day marks earlier check-ins seen instead of dumping a backlog of
// pings. Trisha's "I get so many pings" → deliberately at most one per check-in.
// (Notification-click → open-brief is best-effort on Tauri 2; the pill pulse +
// the always-works chevron are the reliable path, mirroring the tidbit badge.)
//
// Times and toggles come from the Settings routines card (routines.js store),
// re-read every tick so edits apply without a relaunch. Only attended
// routines ping — prework runs engine-side before anyone's awake.

function checkinSeenKey(d, key) {
  return `checkin-pinged-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${key}`;
}

function pulseWidget() {
  const el = document.getElementById("widget");
  if (!el) return;
  el.classList.remove("tidbit-pulse");
  void el.offsetWidth; // restart the animation
  el.classList.add("tidbit-pulse");
  setTimeout(() => el.classList.remove("tidbit-pulse"), 2200);
}

async function maybeFireCheckins() {
  const now = new Date();
  const cfg = loadRoutines();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const due = ROUTINES.filter((r) => {
    if (!r.attended || !cfg[r.key].enabled) return false;
    const t = timeToMinutes(cfg[r.key].time);
    return t !== null && nowMinutes >= t;
  }).sort((a, b) => timeToMinutes(cfg[a.key].time) - timeToMinutes(cfg[b.key].time));
  if (!due.length) return;
  const current = due[due.length - 1]; // the latest check-in whose time has come
  // Mark earlier due check-ins seen (no backlog ping) so only the current one fires.
  for (const r of due) {
    if (r !== current) localStorage.setItem(checkinSeenKey(now, r.key), "1");
  }
  const ck = checkinSeenKey(now, current.key);
  if (localStorage.getItem(ck)) return; // current check-in already pinged today
  localStorage.setItem(ck, "1");
  try {
    await maybeShowNotification({
      title: current.ping.title,
      body: (await checkinCountBody()) || current.ping.body,
    });
    pulseWidget();
  } catch (err) {
    console.warn("[widget] check-in ping failed:", err);
  }
}

// Ping counts must come from the IDENTICAL data path Today renders, read at
// notification time — never a separate derivation, never a cached number
// (WP-CHECKIN pin). Today's "awaiting send" count is fetch_outbox items;
// the prework-staging count joins when the packet IPC lands. Any failure —
// or zero — degrades to the routine's countless copy: a wrong number burns
// trust faster than no number.
async function checkinCountBody() {
  try {
    const data = await invoke("fetch_outbox");
    const n = Array.isArray(data && data.items) ? data.items.length : 0;
    if (n < 1) return null;
    return (
      (n === 1 ? "1 draft awaits" : n + " drafts await") +
      " your review — open the brief to start."
    );
  } catch (_err) {
    return null; // countless copy; the brief itself is the truthful surface
  }
}

maybeFireCheckins();
setInterval(maybeFireCheckins, 60 * 1000);

// ───────────────────────────────────────────────────────────────────────────
// WP-INTAKE T1 — shared app-side channel tick (30 min + on-launch pass).
// ───────────────────────────────────────────────────────────────────────────
//
// ONE recurring timer serving every passive app-side channel, so we don't grow
// a forest of independent poll loops. The widget is the app's always-resident
// context (the main window is a SINGLE window that navigates between
// widget.html — collapsed, default — and index.html — expanded; main.js only
// runs while expanded). So the tick lives HERE, mirroring the maybeFireCheckins
// precedent above: it runs the whole time the app runs, which is exactly the
// "channels run only while the app runs" contract (WP-INTAKE decision 3).
//
// Each tick pushes a FRESH FULL snapshot per callee, so catch-up is inherent:
// the app being closed all morning simply means the next launch pass (and every
// tick after) sends current state — no per-channel watermark is needed for the
// calendar push. (Watermark-based sweeps, e.g. OneNote, self-heal the same way.)
//
// The registry is a plain array of async callees. The tick awaits each in turn
// (sequential — these are light and we don't want two subprocess-spawning reads
// racing), and every callee is individually try/caught so one dead channel can
// never abort the others or throw to the UI (fail-closed-but-VISIBLE is the
// callee's job via its own logging; the tick just keeps going).

const CHANNEL_TICK_MS = 30 * 60 * 1000; // 30-min cadence (WP-CALENDAR addendum).
// On-launch pass runs after a startup-settle delay so we don't compete with app
// boot (config load, widget shim, badge fetches). 75s sits between the widget's
// 60s checkin tick and the 90s ceiling the brief names.
const CHANNEL_LAUNCH_SETTLE_MS = 75 * 1000;

// The callee registry. Each entry: { name, run }. `run` is async, returns
// nothing meaningful, and MUST NOT throw (the tick guards anyway).
const channelCallees = [];

function registerChannelCallee(name, run) {
  channelCallees.push({ name, run });
}

async function runChannelTick(reason) {
  for (const callee of channelCallees) {
    try {
      await callee.run();
    } catch (err) {
      // A callee should handle its own failures calmly; this is the last-line
      // guard so a throw in one channel can't starve the rest or the timer.
      console.warn(`[channel-tick] callee '${callee.name}' failed (${reason}):`, err);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// WP-CALENDAR piece B — availability push (registered as the first callee).
// ───────────────────────────────────────────────────────────────────────────
//
// Reads the local calendar (14-day window per brief) via the Rust
// `calendar_read_window` command, maps the normalized events to the engine's
// POST /api/availability body, and hands that body to the Rust
// `push_availability` command (which attaches the per-user bearer + base URL —
// the bearer never leaves Rust, matching every other engine call in the app).
//
// Privacy default (WP-CALENDAR rule 2): busy-windows only. `includeTitles` is
// false, so we DON'T put titles/organizers on the wire even though the local
// read returns them. (A future local-detail setting can flip this per-push.)

const AVAILABILITY_WINDOW_DAYS = 14;

/**
 * Pure mapping: normalized calendar events → the POST /api/availability body.
 * Kept side-effect-free (no invoke, no clock beyond the passed `updatedAt`) so
 * it's unit-testable in isolation and the body shape is auditable. Drops rows
 * whose start/end aren't both present (the engine's normalizePushWindows drops
 * them too, but keeping the wire clean is cheaper). `includeTitles` controls
 * whether title/organizer are carried; default false (busy-windows only).
 *
 * Exported on `globalThis.__wpCalendar` for a node --check-able smoke without a
 * bundler; it's a no-op attachment in the browser.
 */
function buildAvailabilityBody(events, { includeTitles = false, updatedAt } = {}) {
  const windows = [];
  for (const ev of events || []) {
    if (!ev || !ev.start || !ev.end) continue;
    const w = { start: ev.start, end: ev.end, busy: ev.busy === true };
    if (includeTitles) {
      if (ev.title != null) w.title = ev.title;
      if (ev.organizer != null) w.organizer = ev.organizer;
    }
    windows.push(w);
  }
  const body = { windows, includeTitles };
  if (updatedAt) body.updatedAt = updatedAt;
  return body;
}

/**
 * The availability push callee. Reads the calendar, maps to the busy-only body,
 * and pushes. Every failure is swallowed with a quiet log (the read command
 * already surfaces a plain-product "calendar unavailable" message via its
 * error; here we just don't let it reach the UI). Never throws.
 */
async function pushAvailability() {
  let result;
  try {
    result = await invoke("calendar_read_window", { days: AVAILABILITY_WINDOW_DAYS });
  } catch (err) {
    // Read failed (permission denied / timeout / platform unsupported). The Rust
    // command returned its plain-product user_message as the error string. Log
    // and skip — the next tick retries a fresh full snapshot.
    console.warn("[availability] calendar read unavailable:", err);
    return;
  }
  const events = (result && result.events) || [];
  // Busy-windows only by default (privacy default). We still push an EMPTY
  // snapshot (0 windows) so the engine's freshness cursor advances — an honest
  // "read succeeded, nothing on the calendar" is different from "never pushed".
  const body = buildAvailabilityBody(events, {
    includeTitles: false,
    updatedAt: new Date().toISOString(),
  });
  try {
    const pushResult = await invoke("push_availability", { body });
    // pushResult: { pushed, enabled, note }. {enabled:false} = lane flag off
    // server-side = a CALM no-op, not an error.
    if (pushResult && pushResult.pushed) {
      console.log(`[availability] ${pushResult.note || "pushed"} (source=${result.source})`);
    } else {
      console.log(`[availability] not stored: ${pushResult && pushResult.note ? pushResult.note : "no-op"}`);
    }
  } catch (err) {
    console.warn("[availability] push failed:", err);
  }
}

// Register the calendar push FIRST (WP-CALENDAR piece B).
registerChannelCallee("availability", pushAvailability);

// ───────────────────────────────────────────────────────────────────────────
// WP-INTAKE T1 — OneNote sweep (registered as the "onenote" callee).
// ───────────────────────────────────────────────────────────────────────────
//
// The whole sweep lives in Rust (`onenote_auto_import_sweep`): it reads the
// persisted auto-import config, enumerates each configured notebook via the
// existing OneNote COM plumbing, diffs pages against the per-source watermark,
// exports + sends new/changed pages through the existing per-page ingest path,
// and advances the watermark ONLY past successful sends. All the proven
// COM/watermark/dedup machinery (WP-AUTO-IMPORT + WP-ONENOTE-EXPORT) is reused
// verbatim — this callee is a thin driver so the sweep runs off the ONE shared
// app-side tick instead of its own Rust timer (one tick, not a forest).
//
// Self-healing catch-up is inherent: the app closed all morning ⇒ the launch
// pass sweeps; a failed send retries next tick (watermark didn't advance past
// it). The command NEVER rejects in a way that matters — every failure class
// (unconfigured, disabled, macOS/Windows COM-absent, per-page failure) is
// folded into the returned summary, and the tick try/catches on top of that.
//
// macOS/Linux: OneNote COM is Windows-only, so the enumerate returns
// PlatformUnsupported and the sweep is a calm no-op (`platformUnsupported`).
// We log that distinctly from a real failure and the tick continues.

async function onenoteSweep() {
  let summary;
  try {
    summary = await invoke("onenote_auto_import_sweep");
  } catch (err) {
    // Should not happen (the command returns a summary, not an error, for
    // every expected case) — but if the IPC itself fails, log calmly and let
    // the next tick retry. Never rethrow into the tick.
    console.warn("[onenote-sweep] command failed:", err);
    return;
  }
  if (!summary || summary.skipped) {
    // Auto-import disabled / no configured notebook / unconfigured — a silent
    // no-op by design (nothing to say at the console for the common off case).
    return;
  }
  if (summary.platformUnsupported) {
    // Windows-only channel; on this Mac dev machine (and any non-Windows box)
    // the sweep is a deliberate no-op. Log once per tick so the platform gate
    // is visible in the dev console, then continue.
    console.log("[onenote-sweep] platform no-op (OneNote COM is Windows-only)");
    return;
  }
  const parts = [`imported=${summary.imported}`, `failed=${summary.failed}`];
  if (summary.baselined) parts.push(`baselined=${summary.baselined}`);
  if (summary.truncated) parts.push(`deferred=${summary.deferred} (page cap)`);
  console.log(`[onenote-sweep] ${parts.join(" · ")} across ${summary.sources} source(s)`);
}

registerChannelCallee("onenote", onenoteSweep);

// ───────────────────────────────────────────────────────────────────────────
// WP-INTAKE E5-app — email thread-following sweep (registered as "email").
// ───────────────────────────────────────────────────────────────────────────
//
// The whole sweep lives in Rust (`email_follow_sweep`): it GETs the followed
// threads from the engine (bearer stays in Rust), locates each Outlook
// conversation by known internet Message-IDs (caching threadKey↔ConversationID),
// scans Inbox + Sent Items for messages newer than the per-thread watermark, and
// pushes each via the engine's POST /api/email/import — advancing the watermark
// only past successful imports. Windows COM only; macOS/Linux is a calm no-op
// (the Rust command short-circuits BEFORE any engine call → zero engine traffic
// on the no-op). The engine flag EMAIL_THREAD_FOLLOW_ENABLED gates it: flag-off
// ⇒ `{enabled:false}` ⇒ a calm no-op here too.
//
// This callee is a thin driver: it invokes the command, logs a concise receipt
// (threads checked / messages imported / deferred), distinguishes a platform
// no-op from a real failure, and NEVER rethrows into the shared tick.

async function emailFollowSweep() {
  let summary;
  try {
    summary = await invoke("email_follow_sweep");
  } catch (err) {
    // The command returns a summary (not an error) for every expected case; a
    // rejection means the IPC itself failed. Log calmly, let the next tick
    // retry, never rethrow into the tick.
    console.warn("[email-follow] command failed:", err);
    return;
  }
  if (!summary || summary.skipped) {
    // Not configured yet (fresh install before Configure) — silent no-op.
    return;
  }
  if (summary.platformUnsupported) {
    // Windows-only channel; on this Mac dev machine (and any non-Windows box)
    // the sweep is a deliberate no-op made WITHOUT any engine traffic.
    console.log("[email-follow] platform no-op (local Outlook is Windows-only)");
    return;
  }
  if (!summary.enabled) {
    // Engine flag EMAIL_THREAD_FOLLOW_ENABLED is OFF — a calm no-op, not an error.
    console.log("[email-follow] disabled server-side (calm no-op)");
    return;
  }
  const parts = [
    `imported=${summary.imported}`,
    `duplicates=${summary.duplicates}`,
    `failed=${summary.failed}`,
  ];
  if (summary.discovered) parts.push(`discovered=${summary.discovered}`);
  if (summary.deferredThreads) parts.push(`threadsDeferred=${summary.deferredThreads}`);
  if (summary.truncated) parts.push(`msgsDeferred=${summary.deferredMessages} (cap)`);
  console.log(
    `[email-follow] ${parts.join(" · ")} across ${summary.threadsChecked}/${summary.threadsTotal} thread(s)`,
  );
}

registerChannelCallee("email", emailFollowSweep);

// ───────────────────────────────────────────────────────────────────────────
// WP-INTAKE — OneDrive folder-sweep import (registered as "email-files").
// ───────────────────────────────────────────────────────────────────────────
//
// The New-Outlook-safe SIBLING of the "email" (Outlook COM) callee. The whole
// sweep lives in Rust (`onedrive_mail_sweep`): a Power Automate flow in the
// user's tenant writes each arriving/sent email — and, as of schema v2, each new
// Teams channel message — as a JSON file into a OneDrive folder; the OneDrive
// sync client mirrors that folder to local disk; the Rust command scans the
// folder, validates + routes each file by kind, and pushes it through the SAME
// engine import endpoints the COM sweeps feed (POST /api/email/import for mail,
// POST /api/teams/import for Teams; bearer stays in Rust). Successful files move
// to processed/; malformed ones to failed/; files whose lane is OFF move to
// skipped/; transient failures stay put for the next tick. Pure filesystem +
// HTTP ⇒ this callee is NOT platform-gated — it runs on macOS AND Windows.
//
// This callee is a thin driver: invoke the command, log a concise receipt
// (imported / duplicates / quarantined / skipped / failed), distinguish the calm
// not-configured / folder-missing states, and NEVER rethrow into the shared tick.

async function oneDriveMailSweep() {
  let summary;
  try {
    summary = await invoke("onedrive_mail_sweep");
  } catch (err) {
    // The command returns a summary (not an error) for every expected case; a
    // rejection means the IPC itself failed. Log calmly, let the next tick
    // retry, never rethrow into the tick.
    console.warn("[email-files] command failed:", err);
    return;
  }
  if (!summary || summary.skipped || summary.folderNotConfigured) {
    // Not configured (no bearer, or no OneDrive mail folder set up) — silent
    // no-op by design (the common off case).
    return;
  }
  if (summary.folderNotFound) {
    // Fail-closed-but-VISIBLE: the configured folder is gone / not yet synced.
    console.warn("[email-files] configured OneDrive mail folder not found (check the path)");
    return;
  }
  const parts = [
    `imported=${summary.imported}`,
    `duplicates=${summary.duplicates}`,
    `quarantined=${summary.quarantined}`,
    `failed=${summary.failed}`,
  ];
  if (summary.skippedLaneOff) {
    // Fail-VISIBLE: a lane (email or Teams) is OFF server-side; those files were
    // set aside in skipped/ (bounded, recoverable) rather than re-scanned forever.
    parts.push(`laneOff=${summary.skippedLaneOff} (disabled → skipped/)`);
  }
  if (summary.truncated) parts.push(`deferred=${summary.deferred} (file cap)`);
  console.log(`[email-files] ${parts.join(" · ")} of ${summary.found} file(s) found`);
}

registerChannelCallee("email-files", oneDriveMailSweep);

// Expose the pure mapper for a bundler-free smoke (node --check target); no-op
// side effect in the browser.
if (typeof globalThis !== "undefined") {
  globalThis.__wpCalendar = { buildAvailabilityBody };
}

// On-launch pass after startup settle, then every 30 min. Both go through the
// shared tick so the calendar push (and future OneNote sweep) share one timer.
setTimeout(() => {
  runChannelTick("launch");
  setInterval(() => runChannelTick("interval"), CHANNEL_TICK_MS);
}, CHANNEL_LAUNCH_SETTLE_MS);

init();
