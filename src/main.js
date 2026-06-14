// Viktora Threshold — frontend router + wizard + Configure + capture flows.
// WP-OCR-12 v1.2-FINAL Phase B increment 4.
//
// Increment 1: D-12-19 probe rendering
// Increment 2: Configure pane + Test connection
// Increment 3: 3-screen wizard wrap + base D-12-02 quit-on-close
// Increment 4: capture flows (file picker + drag-drop) + structured toast
//              (D-12-18) + lenient response handling (D-12-17, Rust side) +
//              D-12-02-AMEND wait-for-in-flight (Rust side)
//
// Capture UX:
//   • "Upload File" → invoke pick_files → invoke ingest_files
//   • Drag any file onto the window → Rust WindowEvent::DragDrop fires →
//     emits "threshold://drop-paths" → JS receives → invoke ingest_files
//   • Each ingestion result fires a "threshold://toast" event → frontend
//     renders a structured toast (D-12-18 schema: kind/title/body/cta)
//   • "Capture Screen" → stub until increment 5 (screenshot subprocess)

const tauri = window.__TAURI__;

// WP-ONENOTE-EXPORT-03 — default global hotkey for "send current OneNote
// page" when AppConfig has no override. Must stay in sync with
// `DEFAULT_ONENOTE_HOTKEY` in lib.rs (the Rust side is the
// source-of-truth at registration time; this constant only governs the
// initial Configure pane display before load_config completes).
const DEFAULT_ONENOTE_HOTKEY = "Ctrl+Shift+O";

// ───────── State ─────────

const state = {
  inWizard: false,
  lastConfig: null,
  // WP-ONENOTE-EXPORT-03 — capture-mode tracker for the hotkey configurator.
  // When user clicks "Change…", we listen for the next keydown and accept
  // any modifier+key combo as the new hotkey. ESC cancels.
  onenoteHotkeyCapture: {
    active: false,
    keydownListener: null,
    keyupListener: null,
    blurListener: null,
  },
  // WP-ONENOTE-EXPORT-04 — cached notebook hierarchy for the browse view.
  // `tree` is the NotebookTree returned by onenote_enumerate_hierarchy
  // (camelCase serde from the Rust side: { notebooks: [{ notebookId, name,
  // sections: [{ sectionId, name, pages: [{ pageId, name }] }] }] }).
  // `fetchedAt` is the ms timestamp of the last successful fetch; we
  // refresh after ONENOTE_HIERARCHY_CACHE_TTL_MS or on manual click.
  onenoteHierarchy: {
    tree: null,
    fetchedAt: 0,
  },
  // WP-ONENOTE-EXPORT-04 — in-flight bulk-send tracker. `sectionId` is set
  // while a bulk-send is running so the cancel button knows which section
  // was targeted (and so we can guard against starting a second one while
  // the Rust single-flight mutex would reject it anyway).
  onenoteBulkSend: {
    sectionId: null,
    sectionName: null,
  },
  // WP-ONENOTE-EXPORT-05 — periodic refresh handle for the auto-watch
  // status line in the Configure pane. Set when the Configure view is
  // shown; cleared when it's hidden (avoid background polling when the
  // status display isn't visible to the user).
  onenoteAutoWatchStatusInterval: null,
  // WP-AUTO-IMPORT — Auto-import pane working state. `config` is the
  // persisted AutoImportConfig (camelCase from Rust:
  // { enabled, onenoteNotebooks: [{notebookId, name, enabled, watermark?}],
  //   plaudDevices: [{serialNumber, name, enabled, since?}] }). `available`
  // is the last auto_import_available_sources result (notebooks + plaud
  // devices that can be designated, plus onenoteSupported / plaudConnected
  // flags). `mode` toggles the body between the source list and the
  // add-a-source picker.
  autoImport: {
    config: { enabled: false, onenoteNotebooks: [], plaudDevices: [] },
    available: null,
    mode: "list",
    busy: false,
  },
};

// WP-ONENOTE-EXPORT-05 — refresh cadence for the Configure-pane status
// line. The Rust polling loop ticks every 2s but the status display
// doesn't need sub-second freshness; 30s strikes a balance between
// staleness and per-tick IPC cost (a tracker mutex lock + struct clone).
const ONENOTE_AUTO_WATCH_STATUS_REFRESH_MS = 30 * 1000;

// Maps source_path → pending toast ID so we can dismiss the pre-flight toast
// when the response toast arrives. Screen captures use the special key
// "__screen_capture__" which the Rust shell also stamps onto the outcome.
const pendingToasts = new Map();

// ───────── View routing ─────────

const VIEWS = [
  "view-loading",
  "view-welcome",
  "view-configure",
  "view-done",
  "view-main",
  "view-tidbit",
  // WP-PLAUD-04a — Plaud Sync Queue
  "view-plaud-queue",
  // WP-ONENOTE-EXPORT-04 — OneNote Browse
  "view-onenote-browse",
  // WP-PLAUD-07b — Settings → Connections (Connect Plaud)
  "view-connections",
  // WP-AUTO-IMPORT — designated-source auto-import
  "view-auto-import",
  // WP-THRESHOLD-LOG-UX — "Today" decision/commitment-log view
  "view-log",
  // WP-THRESHOLD-LOG-UX — Receipts (the evidence dossier)
  "view-receipts",
  // WP-THRESHOLD-LOG-UX — Connections (grounded cross-record edges)
  "view-edges",
  // WP-THRESHOLD-LOG-UX — per-entity Definition card
  "view-entity-card",
];

// ───────── WP-ONENOTE-EXPORT-04 constants ─────────

// 15-min cache TTL on the notebook hierarchy (per brief §3.4). Refresh
// triggers: first open of the view, manual click of the Refresh button,
// or this many ms elapsed since the last successful fetch.
const ONENOTE_HIERARCHY_CACHE_TTL_MS = 15 * 60 * 1000;

// Confirm-dialog cost estimate from brief §3.4. Per-page LLM cost; surfaces
// in the bulk-send confirm copy so the user has the right mental model
// before clicking through.
const ONENOTE_BULK_SEND_COST_PER_PAGE_USD = 0.005;

function showView(id) {
  for (const v of VIEWS) {
    const el = document.getElementById(v);
    if (!el) continue;
    if (v === id) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  }
  // WP-ONENOTE-EXPORT-05 — tear down the auto-watch status refresh loop
  // when navigating away from the Configure pane. The enterWizard/Standalone
  // Configure handlers re-start it on view-enter; this single chokepoint
  // covers every navigation path away (Save, Cancel, widget_collapse,
  // hash-driven routing to Plaud/OneNote-browse/tidbit, etc.).
  if (id !== "view-configure") {
    stopAutoWatchStatusRefresh();
  }
}

// ───────── Bootstrap ─────────

async function bootstrap() {
  if (!tauri) {
    document.getElementById("view-loading").innerHTML =
      '<div class="spinner-shell"><p class="loading-text">' +
      "No Tauri runtime — this view is only meaningful inside the bundled .app." +
      "</p></div>";
    return;
  }

  // Subscribe to backend events early so we don't miss any
  await wireBackendEvents();

  let cfg = null;
  try {
    cfg = await tauri.core.invoke("load_config");
  } catch (err) {
    console.error("load_config failed:", err);
    cfg = null;
  }

  if (cfg) {
    document.getElementById("config-base-url").value = cfg.base_url || "";
    document.getElementById("config-bearer-token").value = cfg.bearer_token || "";
    // WP-ONENOTE-EXPORT-03 — hydrate the hotkey field from the persisted
    // AppConfig. `onenote_hotkey` is Option<String> on the Rust side
    // (additive-only schema delta); reader falls back to the same
    // DEFAULT_ONENOTE_HOTKEY constant the Rust side ships.
    const hotkeyEl = document.getElementById("config-onenote-hotkey");
    if (hotkeyEl) {
      hotkeyEl.value = (cfg.onenote_hotkey && cfg.onenote_hotkey.trim())
        ? cfg.onenote_hotkey
        : DEFAULT_ONENOTE_HOTKEY;
    }

    // WP-ONENOTE-EXPORT-05 — hydrate the auto-watch toggle from the
    // persisted AppConfig. `auto_watch` is `bool` on the Rust side
    // (#[serde(default)] so legacy configs without the field deserialize
    // as `false`). The Rust startup hook in setup() already starts the
    // polling loop when this is true; the toggle UI just mirrors the
    // current state.
    const autoWatchEl = document.getElementById("config-onenote-auto-watch");
    if (autoWatchEl) {
      autoWatchEl.checked = !!cfg.auto_watch;
    }

    // WP-Threshold-Tidbit-Return Phase B — `widget_expand("tidbit")`
    // navigates here with #tidbit in the URL hash. Bootstrap detects it,
    // fetches the cached tidbit from AppState via IPC, and renders the
    // tidbit panel view. Falls through to the main view if no tidbit is
    // available (covers: user opened #tidbit manually with no pending,
    // pending was cleared by a previous view, IPC failure).
    if (window.location.hash === "#tidbit") {
      // WP-THRESHOLD-LOG-UX — the post-capture panel is records-primary now.
      // Fetch BOTH the pending records (the always-present body) and the
      // pending tidbit (the amber insight card, when a marker fired). Each
      // fetch is independent — one failing/absent doesn't block the other.
      let records = null;
      let tidbit = null;
      try {
        records = await tauri.core.invoke("get_pending_records");
      } catch (err) {
        console.warn("[main] get_pending_records failed:", err);
      }
      try {
        tidbit = await tauri.core.invoke("get_pending_tidbit");
      } catch (err) {
        console.warn("[main] get_pending_tidbit failed:", err);
      }
      enterPostCaptureView(tidbit, records);
      return;
    }

    // WP-THRESHOLD-LOG-UX — widget_expand("log") (the "Today" menu item or the
    // ambient badge) navigates here with #log. Render the live decision log.
    if (window.location.hash === "#log") {
      enterLogView();
      return;
    }

    // WP-THRESHOLD-LOG-UX — widget_expand("edges") / the "Connections" entry
    // navigates here with #edges. Render the full cross-record edge graph.
    if (window.location.hash === "#edges") {
      enterEdgesView();
      return;
    }

    // WP-PLAUD-04a — when widget_expand was invoked with
    // target_tab="plaud-queue" (from the right-click menu's "Plaud Sync
    // Queue" item), land in the queue view.
    if (window.location.hash === "#plaud-queue") {
      enterPlaudQueueView();
      return;
    }

    // WP-ONENOTE-EXPORT-04 — when widget_expand was invoked with
    // target_tab="onenote-browse" (from the right-click menu's "Browse
    // OneNote…" item), land in the browse view.
    if (window.location.hash === "#onenote-browse") {
      enterOneNoteBrowseView();
      return;
    }

    // WP-PLAUD-07b — when widget_expand was invoked with
    // target_tab="connections" (from the right-click menu's
    // "Connections…" item), land in the Settings → Connections pane.
    if (window.location.hash === "#connections") {
      enterConnectionsView();
      return;
    }

    // WP-AUTO-IMPORT — when widget_expand was invoked with
    // target_tab="auto-import" (from the right-click menu's "Auto-import…"
    // item), land in the Auto-import pane.
    if (window.location.hash === "#auto-import") {
      enterAutoImportView();
      return;
    }

    enterMainView(cfg);
  } else {
    enterWizardWelcome();
  }
}

// ───────── Backend event subscriptions ─────────

async function wireBackendEvents() {
  // D-12-18 toast events from any ingestion outcome.
  // Pre-flight "Uploading…" toasts (registered in pendingToasts by source_path)
  // are dismissed when the matching response toast arrives.
  await tauri.event.listen("threshold://toast", (event) => {
    const payload = event.payload || {};
    if (payload.source_path && pendingToasts.has(payload.source_path)) {
      const pendingId = pendingToasts.get(payload.source_path);
      pendingToasts.delete(payload.source_path);
      dismissToast(pendingId);
    }
    showToast(payload);
  });

  // WP-OCR-09 Phase D — one-click Configure pre-fill from the Apolla
  // Onboarding nav surface. The user clicks an
  // `apolla-threshold://configure?tenant=...&token=...` link in the
  // browser; the Rust shell parses the URL + emits this event with
  // {tenant, baseUrl, token}. Populate the Configure pane fields,
  // navigate to it if we're elsewhere, and pre-select Save.
  await tauri.event.listen("threshold://configure-prefill", async (event) => {
    const { baseUrl, token, tenant } = event.payload || {};
    if (!baseUrl || !token) {
      console.warn("[configure-prefill] payload missing baseUrl or token", event.payload);
      return;
    }
    // Populate fields. Inputs auto-resolve even if the Configure view
    // isn't currently visible — DOM elements exist independent of
    // showView state.
    const baseEl = document.getElementById("config-base-url");
    const tokenEl = document.getElementById("config-bearer-token");
    if (baseEl) baseEl.value = baseUrl;
    if (tokenEl) tokenEl.value = token;
    // Navigate to the Standalone Configure surface so the user sees the
    // pre-filled fields immediately. enterStandaloneConfigure() handles
    // the case where we're currently on widget / main / tidbit.
    try {
      // Coming from widget (the 180x80 floating shell)? Expand first
      // so the Configure UI has room to render.
      await tauri.core.invoke("widget_expand", { targetTab: "configure" }).catch(() => {});
    } catch (_e) {
      // Non-widget contexts don't have widget_expand; ignore.
    }
    enterStandaloneConfigure();
    // Toast the user so the source of the pre-fill is unambiguous.
    showToast({
      kind: "success",
      title: tenant ? `Apolla: ${tenant}` : "Apolla onboarding",
      body: "Pre-filled from your onboarding link. Click Save to connect.",
    });
  });

  // Drag-drop paths from WindowEvent::DragDrop in the Rust shell.
  // Emit a pre-flight toast per dropped path, then kick off ingestion.
  await tauri.event.listen("threshold://drop-paths", async (event) => {
    const paths = event.payload || [];
    hideDropOverlay();
    if (paths.length === 0) return;
    for (const path of paths) {
      emitPreflightToast(path);
    }
    try {
      await tauri.core.invoke("ingest_files", { paths });
    } catch (err) {
      // The IPC itself failed (rare — usually means current_config errored).
      // Dismiss all pending and show one failure toast.
      for (const path of paths) {
        if (pendingToasts.has(path)) {
          dismissToast(pendingToasts.get(path));
          pendingToasts.delete(path);
        }
      }
      showToast({
        kind: "failure",
        title: "Drag-drop ingestion failed",
        body: String(err),
      });
    }
  });

  // WP-ONENOTE-EXPORT-04 — per-page progress events from the Rust bulk-send
  // loop. Payload (camelCase serde): { sectionId, pageId, pageTitle,
  // status: "started" | "succeeded" | "failed" | "cancelled",
  // completed, total }. The handler is a no-op when the browse view's
  // progress UI is not visible (e.g., user navigated away mid-batch); the
  // final report still fires and surfaces via toast.
  await tauri.event.listen("onenote-bulk-send-progress", (event) => {
    handleOneNoteBulkSendProgress(event.payload || {});
  });

  // WP-ONENOTE-EXPORT-04 — final report at end of bulk-send. Payload:
  // { sectionId, sectionName, total, succeeded, failed, cancelled,
  //   errors: [pageId, msg][] }. Hides the progress UI, shows a
  // success/failure toast summarizing the run.
  await tauri.event.listen("onenote-bulk-send-complete", (event) => {
    handleOneNoteBulkSendComplete(event.payload || {});
  });
}

// ───────── Wizard chrome ─────────

function enterWizardWelcome() {
  state.inWizard = true;
  showView("view-welcome");
}

function enterWizardConfigure() {
  state.inWizard = true;
  document.getElementById("configure-step").removeAttribute("hidden");
  document.getElementById("configure-title").textContent = "Connect to your workspace";
  document.getElementById("configure-subtitle").textContent =
    "Paste your Apolla base URL and the bearer token your server was started with.";
  document.getElementById("btn-back-to-main").setAttribute("hidden", "");
  document.getElementById("btn-save").textContent = "Next";
  showView("view-configure");
  // WP-ONENOTE-EXPORT-05 — kick off the periodic auto-watch status
  // refresh so the counter line below the toggle stays current while
  // the Configure pane is visible. Safe in the wizard path too (the
  // status line just reads "Auto-watch off" pre-first-toggle).
  startAutoWatchStatusRefresh();
  document.getElementById("config-base-url").focus();
}

function enterWizardDone(cfg) {
  state.lastConfig = cfg;
  showView("view-done");
}

function finishWizard() {
  state.inWizard = false;
  enterMainView(state.lastConfig);
}

// ───────── Standalone Configure ─────────

function enterStandaloneConfigure() {
  state.inWizard = false;
  document.getElementById("configure-step").setAttribute("hidden", "");
  document.getElementById("configure-title").textContent = "Viktora Threshold";
  document.getElementById("configure-subtitle").textContent =
    "Update your Apolla workspace connection.";
  document.getElementById("btn-back-to-main").removeAttribute("hidden");
  document.getElementById("btn-save").textContent = "Save";
  showView("view-configure");
  // WP-ONENOTE-EXPORT-05 — kick off the periodic auto-watch status
  // refresh so the counter line below the toggle stays current while
  // the Configure pane is visible.
  startAutoWatchStatusRefresh();
  document.getElementById("config-base-url").focus();
}

// ───────── Configure form logic ─────────

function showConnectionResult(resultEl, result) {
  resultEl.removeAttribute("hidden");
  resultEl.className = "result " + (result.ok ? "ok" : "fail");
  let html = "<strong>" + (result.ok ? "✓ " : "✗ ") + escapeHtml(result.message) + "</strong>";
  if (result.detail) html += escapeHtml(result.detail);
  resultEl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleTestConnection() {
  const baseUrl = document.getElementById("config-base-url").value.trim();
  const resultEl = document.getElementById("connection-result");
  const btn = document.getElementById("btn-test-connection");

  if (!baseUrl) {
    showConnectionResult(resultEl, { ok: false, message: "Enter a base URL first.", detail: null });
    return;
  }

  btn.disabled = true;
  btn.textContent = "Testing…";
  try {
    const result = await tauri.core.invoke("test_connection", { baseUrl });
    showConnectionResult(resultEl, result);
  } catch (err) {
    showConnectionResult(resultEl, {
      ok: false,
      message: "IPC error invoking test_connection",
      detail: String(err),
    });
  } finally {
    btn.disabled = false;
    btn.textContent = "Test connection";
  }
}

async function handleSave(e) {
  e.preventDefault();
  const baseUrl = document.getElementById("config-base-url").value.trim();
  const bearerToken = document.getElementById("config-bearer-token").value.trim();
  const resultEl = document.getElementById("connection-result");

  if (!baseUrl || !bearerToken) {
    showConnectionResult(resultEl, {
      ok: false,
      message: "Both fields are required.",
      detail: "Paste your Apolla base URL and bearer token before saving.",
    });
    return;
  }

  // WP-ONENOTE-EXPORT-03 — include the OneNote hotkey in the save
  // payload. Empty input → null so the Rust-side reader falls back to
  // DEFAULT_ONENOTE_HOTKEY. The save_config IPC handles
  // re-registration of the global shortcut when the value changes.
  const hotkeyEl = document.getElementById("config-onenote-hotkey");
  const onenoteHotkey = hotkeyEl ? hotkeyEl.value.trim() : "";
  // WP-ONENOTE-EXPORT-05 — include the auto-watch flag in the save
  // payload. Defaults to false (toggle off) when the element is missing
  // (defensive against older index.html builds, same pattern as the
  // optional hotkey block). The toggle's change listener already drove
  // `onenote_set_auto_watch` for instant feedback; this round-trip just
  // keeps the full-config save_config IPC's view of disk consistent.
  const autoWatchEl = document.getElementById("config-onenote-auto-watch");
  const autoWatch = autoWatchEl ? autoWatchEl.checked : false;
  const config = {
    base_url: baseUrl,
    bearer_token: bearerToken,
    last_used: null,
    mode: "workspace",
    onenote_hotkey: onenoteHotkey || null,
    auto_watch: autoWatch,
  };

  try {
    await tauri.core.invoke("save_config", { config });
  } catch (err) {
    showConnectionResult(resultEl, {
      ok: false,
      message: "Failed to save configuration",
      detail: String(err),
    });
    return;
  }

  if (state.inWizard) {
    enterWizardDone(config);
  } else {
    enterMainView(config);
  }
}

// ───────── WP-ONENOTE-EXPORT-05 — auto-watch toggle + status refresh ─────────

/**
 * Refresh the auto-watch status display in the Configure pane.
 *
 * Invokes `onenote_auto_watch_status` and rewrites the inline status
 * text below the toggle. Called: (a) on Configure-pane open, (b) right
 * after a toggle change for instant feedback, (c) on a 30s interval
 * while the Configure pane is visible.
 *
 * Wire shape (camelCase per AutoWatchStatus serde rename):
 *   { enabled, sentToday, sentTotalSession, distinctPagesSent,
 *     debouncingPageId? }
 *
 * Failure-safe: if the IPC errors (e.g., tracker mutex poisoned), the
 * status line stays at whatever it was last; no toast spam.
 */
async function refreshAutoWatchStatus() {
  const statusEl = document.getElementById("config-onenote-auto-watch-status");
  if (!statusEl) return;
  try {
    const status = await tauri.core.invoke("onenote_auto_watch_status");
    if (!status || !status.enabled) {
      statusEl.textContent = "Auto-watch off";
      return;
    }
    const n = status.sentToday || 0;
    statusEl.textContent = n === 1
      ? "Sent today: 1 page"
      : `Sent today: ${n} pages`;
  } catch (err) {
    console.warn("[main] onenote_auto_watch_status failed:", err);
    // Leave the status line at its prior value; don't blank it on error.
  }
}

/**
 * Begin the periodic status-refresh loop. Idempotent: clears any prior
 * interval before starting a new one. Called when the Configure view is
 * shown.
 */
function startAutoWatchStatusRefresh() {
  stopAutoWatchStatusRefresh();
  // Immediate refresh so the user sees a current value on view-enter,
  // not a 30s-stale one from the previous mount.
  refreshAutoWatchStatus();
  state.onenoteAutoWatchStatusInterval = setInterval(
    refreshAutoWatchStatus,
    ONENOTE_AUTO_WATCH_STATUS_REFRESH_MS,
  );
}

/**
 * Stop the periodic status-refresh loop. Idempotent. Called when the
 * Configure view is hidden (any other view enter).
 */
function stopAutoWatchStatusRefresh() {
  if (state.onenoteAutoWatchStatusInterval) {
    clearInterval(state.onenoteAutoWatchStatusInterval);
    state.onenoteAutoWatchStatusInterval = null;
  }
}

/**
 * Change-handler for the auto-watch toggle. Drives the Rust polling
 * loop immediately (don't wait for Save) for instant UX feedback.
 * Reverts the toggle state if the IPC fails so the UI doesn't drift
 * from disk.
 *
 * The IPC also persists `auto_watch` to AppConfig on disk, so the
 * Save button isn't required to keep the toggle state — it's
 * equivalent to clicking Save with only this field changed. The full
 * `handleSave` payload still includes `auto_watch` (so a Save click
 * after a toggle is byte-equal to the on-disk state and doesn't drift).
 */
async function handleAutoWatchToggle(e) {
  const checked = e.target.checked;
  try {
    await tauri.core.invoke("onenote_set_auto_watch", { enabled: checked });
    // Refresh status display immediately so the line updates from
    // "Auto-watch off" → "Sent today: 0 pages" (or vice versa).
    refreshAutoWatchStatus();
  } catch (err) {
    console.error("[main] onenote_set_auto_watch failed:", err);
    // Revert the toggle so the UI doesn't drift from on-disk state.
    e.target.checked = !checked;
    showToast({
      kind: "failure",
      title: "Could not toggle OneNote auto-watch",
      body: String(err),
    });
  }
}

// ───────── Main view ─────────

async function enterMainView(cfg) {
  state.inWizard = false;
  showView("view-main");

  const subtitleEl = document.getElementById("main-subtitle");
  if (subtitleEl && cfg) {
    subtitleEl.textContent = "Connected to " + cfg.base_url;
  }

  // WP-OCR-13 v0.2: in-process OCR is always available on supported platforms
  // (Mac via Apple Vision / Phase A; Windows via Windows.Media.Ocr / Phase B).
  // No legacy `get_ocr_utility_status` probe, no greyed-out gate — the Capture
  // Screen button is unconditionally clickable here; per-platform "not
  // supported" toast (Linux, etc.) is emitted by run_screen_capture itself.
}

// ───────── Post-capture panel (WP-THRESHOLD-LOG-UX, records-primary) ─────────

/**
 * Prettify a kebab-case person/entity slug for display:
 * "dev-patel" → "Dev Patel", "q3-roadmap" → "Q3 Roadmap". Defensive against
 * empty/odd input (returns the input unchanged).
 */
function prettySlug(slug) {
  if (!slug || typeof slug !== "string") return "";
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Format an ISO date (YYYY-MM-DD) as a short, friendly label. Falls back to
 *  the raw string if it doesn't parse. */
function formatDueDate(iso) {
  if (!iso || typeof iso !== "string") return "";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ───────── WP-N1 (S1 sharing) — viewer identity helpers ─────────
//
// The viewer's authenticated email drives capture attribution + the Today
// "Mine / Everyone" filter. Fetched once per expanded-window load (each
// widget_expand is a fresh page) via get_whoami and cached. EVERY sharing
// surface is invisible-by-absence: a null email (shared key / auth off / a
// server too old for /api/whoami) means no attribution "you", no toggle — the
// app looks identical to today.

// undefined = not yet fetched · null = no identity · string = the viewer email.
let _viewerEmail = undefined;

async function getViewerEmail() {
  if (_viewerEmail !== undefined) return _viewerEmail;
  try {
    const r = await tauri.core.invoke("get_whoami");
    _viewerEmail = r && typeof r.email === "string" && r.email ? r.email : null;
  } catch (err) {
    console.warn("[main] get_whoami failed:", err);
    _viewerEmail = null;
  }
  return _viewerEmail;
}

/** The local-part of an email ("dev.patel@x" → "dev.patel"); "" if absent. */
function emailLocalPart(email) {
  return email && typeof email === "string" ? email.split("@")[0] : "";
}

/** Normalize an email's local-part to a person-slug ("dev.patel" → "dev-patel")
 *  for owner comparison in the Mine filter. */
function emailToOwnerSlug(email) {
  return emailLocalPart(email).toLowerCase().replace(/[._]+/g, "-");
}

/**
 * Capture-attribution label for a document, from the documentId → submitter map:
 *   - submitter == viewer            → "captured by you"
 *   - submitter present, someone else → "captured by <local-part>"
 *   - no submitter on the doc         → "" (omit — pre-flag / shared-key capture)
 * Never renders an email or "unknown". `viewerEmail` may be null (no identity);
 * then a present submitter always reads as the other person.
 */
function captureAttribution(documentId, submitterByDoc, viewerEmail) {
  if (!documentId || !submitterByDoc) return "";
  const submitter = submitterByDoc.get(documentId);
  if (!submitter) return "";
  if (viewerEmail && submitter.toLowerCase() === viewerEmail.toLowerCase()) {
    return "captured by you";
  }
  return "captured by " + emailLocalPart(submitter);
}

/**
 * Render the post-capture panel — records-primary.
 *
 * The records list is the body (it populates on ~every capture once the
 * decision log is enabled server-side). When a tidbit also exists (a marker
 * fired), it renders as a single amber insight card at the top. When a capture
 * produced neither, a quiet "captured & filed" line shows — never an apology.
 *
 * @param {object|null} tidbit         get_pending_tidbit payload (or null)
 * @param {object|null} recordsResp    get_pending_records envelope (or null):
 *                                     { records: [{record, lifecycle, state}], edges: [...] }
 */
async function enterPostCaptureView(tidbit, recordsResp) {
  state.inWizard = false;
  showView("view-tidbit");

  const items =
    recordsResp && Array.isArray(recordsResp.records) ? recordsResp.records : [];
  const edges =
    recordsResp && Array.isArray(recordsResp.edges) ? recordsResp.edges : [];

  const hasTidbit = !!(tidbit && typeof tidbit === "object" && tidbit.title);
  renderTidbitCard(hasTidbit ? tidbit : null);
  // WP-N1 #6 — this client made the capture, so attribution is "captured by
  // you" when we have a viewer identity (whoami non-null); omitted otherwise.
  const viewer = await getViewerEmail();
  renderRecords(items, edges, viewer ? "captured by you" : null);

  const subEl = document.getElementById("postcapture-sub");
  const filedEl = document.getElementById("postcapture-filed");

  if (items.length > 0) {
    const decisions = items.filter((it) => recordType(it) === "decision").length;
    const commitments = items.length - decisions;
    if (subEl) {
      subEl.textContent = postCaptureSummaryLine(decisions, commitments);
      subEl.hidden = false;
    }
    if (filedEl) filedEl.hidden = true;
  } else if (hasTidbit) {
    if (subEl) {
      subEl.textContent = "A preview from this capture";
      subEl.hidden = false;
    }
    if (filedEl) filedEl.hidden = true;
  } else {
    if (subEl) subEl.hidden = true;
    if (filedEl) filedEl.hidden = false;
  }
}

/** "2 decisions · 3 commitments", grammatically pluralized; either side
 *  omitted when zero. */
function postCaptureSummaryLine(decisions, commitments) {
  const parts = [];
  if (decisions > 0) parts.push(decisions + (decisions === 1 ? " decision" : " decisions"));
  if (commitments > 0)
    parts.push(commitments + (commitments === 1 ? " commitment" : " commitments"));
  return parts.join(" · ");
}

/** Pull the record `type` from a {record, lifecycle, state} item OR a bare
 *  record (tolerates both shapes). */
function recordType(item) {
  const rec = item && item.record ? item.record : item;
  return rec && rec.type ? rec.type : "";
}

/**
 * Render the tidbit amber insight card. Pass null to hide it. Reuses the
 * existing tidbit-* element ids + chip markup (the tidbit content contract is
 * unchanged); only its placement — a card atop the records — is new.
 */
function renderTidbitCard(tidbit) {
  const cardEl = document.getElementById("tidbit-card");
  const titleEl = document.getElementById("tidbit-title");
  const bodyEl = document.getElementById("tidbit-body");
  const metaEl = document.getElementById("tidbit-meta");
  const highlightsEl = document.getElementById("tidbit-highlights");
  const deeplinkEl = document.getElementById("btn-tidbit-deeplink");

  if (!tidbit || typeof tidbit !== "object") {
    if (cardEl) cardEl.hidden = true;
    return;
  }
  if (cardEl) cardEl.hidden = false;

  // textContent throughout — no innerHTML injection path even though the
  // content is from our own server.
  if (titleEl) titleEl.textContent = tidbit.title || "";
  if (bodyEl) bodyEl.textContent = tidbit.whyThisMatters || "";

  if (metaEl) {
    if (tidbit.capturedFromHint) {
      metaEl.textContent = tidbit.capturedFromHint;
      metaEl.hidden = false;
    } else {
      metaEl.hidden = true;
      metaEl.textContent = "";
    }
  }

  if (highlightsEl) {
    highlightsEl.innerHTML = "";
    const highlights = Array.isArray(tidbit.highlights) ? tidbit.highlights : [];
    for (const h of highlights) {
      const chip = document.createElement("span");
      chip.className = "tidbit-chip";
      chip.dataset.overlap = h.isCorpusOverlap ? "true" : "false";
      const slugSpan = document.createElement("span");
      slugSpan.className = "tidbit-chip-slug";
      slugSpan.textContent = h.slug || "";
      chip.appendChild(slugSpan);
      if (h.isCorpusOverlap && typeof h.priorCaptureCount === "number") {
        const countSpan = document.createElement("span");
        countSpan.className = "tidbit-chip-count";
        countSpan.textContent = "seen " + h.priorCaptureCount + "×";
        chip.appendChild(countSpan);
      } else if (!h.isCorpusOverlap) {
        const newSpan = document.createElement("span");
        newSpan.className = "tidbit-chip-count tidbit-chip-count-new";
        newSpan.textContent = "new";
        chip.appendChild(newSpan);
      }
      highlightsEl.appendChild(chip);
    }
  }

  if (deeplinkEl) {
    if (tidbit.deepLink) {
      deeplinkEl.href = tidbit.deepLink;
      deeplinkEl.style.visibility = "";
    } else {
      deeplinkEl.style.visibility = "hidden";
    }
  }
}

/**
 * Render the records list into #records-list. `items` are {record, lifecycle,
 * state} envelopes; `edges` are the cross-record relationships touching them,
 * keyed onto each record for the conflict/supersession callouts.
 */
function renderRecords(items, edges, attribution) {
  const listEl = document.getElementById("records-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const edgesByRecord = new Map();
  for (const e of Array.isArray(edges) ? edges : []) {
    for (const rid of [e.recordA, e.recordB]) {
      if (!rid) continue;
      if (!edgesByRecord.has(rid)) edgesByRecord.set(rid, []);
      edgesByRecord.get(rid).push(e);
    }
  }

  for (const item of items) {
    const rec = item && item.record ? item.record : item;
    if (!rec) continue;
    listEl.appendChild(
      renderRecordCard(
        rec,
        item.state,
        item.lifecycle,
        edgesByRecord.get(rec.recordId) || [],
        attribution,
      ),
    );
  }
}

/** Build one record card element. Verbatim is rendered as a quotation ONLY
 *  when verbatimVerified is true (an unverified quote is a hypothesis, never
 *  shown as a quotation — the hard constraint). */
function renderRecordCard(rec, recState, lifecycle, recEdges, attribution) {
  const card = document.createElement("div");
  card.className = "record-card";
  card.dataset.type = rec.type || "";
  if (recState) card.dataset.state = recState;

  // Header: type chip + (state pill when not open).
  const header = document.createElement("div");
  header.className = "record-header";

  const chip = document.createElement("span");
  chip.className = "record-chip";
  chip.dataset.type = rec.type || "";
  chip.textContent = rec.type === "decision" ? "Decision" : "Commitment";
  header.appendChild(chip);

  if (recState && recState !== "open") {
    const statePill = document.createElement("span");
    statePill.className = "record-state-pill";
    statePill.dataset.state = recState;
    statePill.textContent = recState === "superseded" ? "Superseded" : "Resolved";
    header.appendChild(statePill);
  }
  card.appendChild(header);

  // Summary.
  const summary = document.createElement("p");
  summary.className = "record-summary";
  summary.textContent = rec.summary || "";
  card.appendChild(summary);

  // Meta: owner · due dim; the overdue/silent count amber (when overdue+silent).
  const dimMeta = [];
  if (rec.owner) dimMeta.push(prettySlug(rec.owner));
  if (rec.due) dimMeta.push("due " + formatDueDate(rec.due));
  const cardOverdue =
    lifecycle && lifecycle.overdueSilent && typeof lifecycle.silentDays === "number";
  if (dimMeta.length || cardOverdue || attribution) {
    const meta = document.createElement("p");
    meta.className = "record-meta";
    meta.textContent = dimMeta.join(" · ");
    if (cardOverdue) {
      if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
      const overdue = document.createElement("span");
      overdue.className = "record-meta-overdue";
      overdue.textContent = lifecycle.silentDays + "d silent";
      meta.appendChild(overdue);
    }
    // WP-N1 #6 — capture attribution (e.g. "captured by you"), muted, in the
    // meta line. Omitted entirely when absent (no identity → never shown).
    if (attribution) {
      if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
      const attr = document.createElement("span");
      attr.className = "record-meta-attr";
      attr.textContent = attribution;
      meta.appendChild(attr);
    }
    card.appendChild(meta);
  }

  // Verbatim — quotation ONLY when verified.
  if (rec.verbatimVerified === true && rec.verbatim) {
    const quote = document.createElement("blockquote");
    quote.className = "record-quote";
    quote.textContent = rec.verbatim;
    card.appendChild(quote);
  }

  // Edge callouts (conflict / supersession / resolution / dependency).
  for (const e of recEdges) {
    const phrasing = edgePhrasing(e, rec.recordId);
    if (!phrasing) continue;
    const callout = document.createElement("p");
    callout.className = "record-edge";
    callout.dataset.kind = e.kind || "";
    callout.dataset.severity = e.severity || "";
    const icon = document.createElement("span");
    icon.className = "record-edge-icon";
    icon.textContent = phrasing.icon;
    callout.appendChild(icon);
    const label = document.createElement("span");
    label.className = "record-edge-label";
    label.textContent = phrasing.label;
    callout.appendChild(label);
    card.appendChild(callout);
  }

  // "Show receipts" — the subject's full evidence chain.
  if (rec.primaryEntity) {
    const actions = document.createElement("div");
    actions.className = "record-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-link receipts-entry-btn";
    btn.textContent = "Show receipts →";
    btn.addEventListener("click", () => enterReceiptsView(rec.primaryEntity));
    actions.appendChild(btn);
    card.appendChild(actions);
  }

  return card;
}

/**
 * Direction-aware phrasing for an edge relative to one record. Returns
 * {icon, label} or null for an unknown kind. For supersedes/resolves/depends_on
 * the direction matters (recordA is the later/acting record); contradicts and
 * duplicates are symmetric.
 */
function edgePhrasing(edge, recId) {
  const isA = edge.recordA === recId;
  const otherSummary = (isA ? edge.recordBSummary : edge.recordASummary) || "another record";
  switch (edge.kind) {
    case "contradicts":
      return { icon: "⚠️", label: "Conflicts with: " + otherSummary };
    case "supersedes":
      return isA
        ? { icon: "⤳", label: "Supersedes: " + otherSummary }
        : { icon: "⤳", label: "Superseded by: " + otherSummary };
    case "resolves":
      return isA
        ? { icon: "✓", label: "Resolves: " + otherSummary }
        : { icon: "✓", label: "Resolved by: " + otherSummary };
    case "duplicates":
      return { icon: "⧉", label: "Duplicate of: " + otherSummary };
    case "depends_on":
      return isA
        ? { icon: "↳", label: "Depends on: " + otherSummary }
        : { icon: "↰", label: "Blocks: " + otherSummary };
    default:
      return null;
  }
}

// Back-to-widget button — collapses the expanded UI back to the floating
// pill. Also clears the pending tidbit AND the pending records so a stale
// post-capture panel doesn't re-fire the next time the user expands for an
// unrelated reason (e.g. Settings).
const tidbitBackBtn = document.getElementById("btn-tidbit-back");
if (tidbitBackBtn) {
  tidbitBackBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("clear_pending_tidbit");
    } catch (err) {
      console.warn("[main] clear_pending_tidbit failed:", err);
    }
    try {
      await tauri.core.invoke("clear_pending_records");
    } catch (err) {
      console.warn("[main] clear_pending_records failed:", err);
    }
    try {
      await tauri.core.invoke("widget_collapse");
    } catch (err) {
      console.warn("[main] widget_collapse failed:", err);
    }
  });
}

// "Open Today →" button in the post-capture panel footer — jump straight from
// the just-captured records into the full decision log.
const postcaptureLogBtn = document.getElementById("btn-postcapture-log");
if (postcaptureLogBtn) {
  postcaptureLogBtn.addEventListener("click", () => {
    enterLogView();
  });
}

// ───────── Today view — the decision/commitment log (WP-THRESHOLD-LOG-UX) ─────────

/**
 * Render the "Today" view from the live /api/decision-log (via the
 * fetch_decision_log IPC). Sections, in attention order: needs-attention,
 * contradictions, state counts, owner load. Handles the empty log and a
 * server-unreachable error without leaving a blank screen.
 */
async function enterLogView() {
  state.inWizard = false;
  showView("view-log");

  const statusEl = document.getElementById("log-status");
  const attentionList = document.getElementById("log-attention-list");
  const attentionEmpty = document.getElementById("log-attention-empty");
  const contradictionsSection = document.getElementById("log-contradictions-section");
  const contradictionsList = document.getElementById("log-contradictions-list");
  const ownersSection = document.getElementById("log-owners-section");
  const ownersStrip = document.getElementById("log-owners-strip");
  const statesStrip = document.getElementById("log-states-strip");
  const subEl = document.getElementById("log-sub");

  // Loading state.
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Loading the log…";
  }

  let data;
  try {
    data = await tauri.core.invoke("fetch_decision_log");
  } catch (err) {
    console.warn("[main] fetch_decision_log failed:", err);
    if (attentionList) attentionList.innerHTML = "";
    if (attentionEmpty) attentionEmpty.hidden = true;
    if (contradictionsSection) contradictionsSection.hidden = true;
    if (ownersSection) ownersSection.hidden = true;
    if (statesStrip) statesStrip.hidden = true;
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        "Couldn't reach Apolla. Check your connection in Configure, then Refresh.";
    }
    return;
  }

  if (statusEl) statusEl.hidden = true;

  const summary = data && data.summary ? data.summary : {};
  const states = summary.states || {};
  const needsAttention = Array.isArray(data && data.needsAttention) ? data.needsAttention : [];
  const relationships = (data && data.relationships) || {};
  const contradictions = Array.isArray(relationships.contradictions)
    ? relationships.contradictions
    : [];
  const ownerLoad = Array.isArray(summary.ownerLoad) ? summary.ownerLoad : [];

  // Subtitle reflects the live total.
  if (subEl) {
    const total = typeof summary.total === "number" ? summary.total : 0;
    subEl.textContent =
      total > 0
        ? `${needsAttention.length} need attention · ${total} tracked`
        : "What needs your attention";
  }

  // States strip (open / resolved / superseded).
  if (statesStrip) {
    statesStrip.innerHTML = "";
    const order = [
      { key: "open", label: "Open" },
      { key: "resolved", label: "Resolved" },
      { key: "superseded", label: "Superseded" },
    ];
    let any = false;
    for (const s of order) {
      const n = typeof states[s.key] === "number" ? states[s.key] : 0;
      const pill = document.createElement("span");
      pill.className = "log-state-pill";
      pill.dataset.state = s.key;
      pill.textContent = `${n} ${s.label.toLowerCase()}`;
      statesStrip.appendChild(pill);
      if (n > 0) any = true;
    }
    statesStrip.hidden = !any;
  }

  // WP-N1 #6/#8 — viewer identity (for attribution + the Mine filter) and the
  // documentId → submitter map (for the Today attribution join). Both best-
  // effort: a null identity hides the toggle + the "you" distinction; a failed
  // /api/data join simply omits attribution. The documents array is already
  // disclosure-sliced server-side, so the join never sees a hidden doc.
  const viewerEmail = await getViewerEmail();
  const submitterByDoc = new Map();
  try {
    const docsResp = await tauri.core.invoke("fetch_documents");
    const docs = docsResp && Array.isArray(docsResp.documents) ? docsResp.documents : [];
    for (const d of docs) {
      if (d && d.id && typeof d.submittedByEmail === "string" && d.submittedByEmail) {
        submitterByDoc.set(d.id, d.submittedByEmail);
      }
    }
  } catch (err) {
    console.warn("[main] fetch_documents failed (attribution omitted):", err);
  }

  _todayCtx = {
    needsAttention,
    submitterByDoc,
    viewerEmail,
    viewerSlug: viewerEmail ? emailToOwnerSlug(viewerEmail) : null,
  };

  // The Mine / Everyone toggle exists only for an identified viewer.
  const filterEl = document.getElementById("log-filter");
  if (filterEl) filterEl.hidden = !viewerEmail;
  setTodayFilter("everyone"); // default Everyone on each view load
  renderTodayAttention();

  // Contradictions.
  if (contradictionsSection && contradictionsList) {
    contradictionsList.innerHTML = "";
    if (contradictions.length > 0) {
      for (const edge of contradictions) {
        contradictionsList.appendChild(renderContradictionRow(edge));
      }
      contradictionsSection.hidden = false;
    } else {
      contradictionsSection.hidden = true;
    }
  }

  // Owner load.
  if (ownersSection && ownersStrip) {
    ownersStrip.innerHTML = "";
    if (ownerLoad.length > 0) {
      for (const o of ownerLoad.slice(0, 8)) {
        ownersStrip.appendChild(renderOwnerChip(o));
      }
      ownersSection.hidden = false;
    } else {
      ownersSection.hidden = true;
    }
  }
}

// WP-N1 #8 — Today "Mine / Everyone" filter. Client-side only; default Everyone.
// `_todayCtx` holds the last-fetched needs-attention list + the join maps so the
// toggle re-renders without re-fetching.
let _todayFilter = "everyone"; // "everyone" | "mine"
let _todayCtx = null;

/** Set the active filter + reflect it on the segmented control's buttons. */
function setTodayFilter(filter) {
  _todayFilter = filter === "mine" ? "mine" : "everyone";
  for (const b of document.querySelectorAll(".log-filter-btn")) {
    b.setAttribute("aria-pressed", b.dataset.filter === _todayFilter ? "true" : "false");
  }
}

/** Render the needs-attention list under the current filter. "Mine" keeps only
 *  rows whose owner slug matches the viewer's (email local-part → slug). */
function renderTodayAttention() {
  const ctx = _todayCtx;
  const listEl = document.getElementById("log-attention-list");
  const emptyEl = document.getElementById("log-attention-empty");
  if (!ctx || !listEl) return;

  let rows = ctx.needsAttention;
  if (_todayFilter === "mine" && ctx.viewerSlug) {
    rows = rows.filter((e) => {
      const owner = ((e.record && e.record.owner) || "").toLowerCase();
      return owner && owner === ctx.viewerSlug;
    });
  }

  listEl.innerHTML = "";
  for (const entry of rows) {
    listEl.appendChild(renderAttentionRow(entry, ctx.submitterByDoc, ctx.viewerEmail));
  }
  if (emptyEl) {
    emptyEl.hidden = rows.length > 0;
    if (rows.length === 0) {
      emptyEl.textContent =
        _todayFilter === "mine"
          ? "Nothing of yours is overdue and silent."
          : "Nothing overdue and silent. You're on top of it.";
    }
  }
}

/** One needs-attention row: summary, subject, owner, due, silent-days, and
 *  (WP-N1 #6) capture attribution joined from the documentId → submitter map. */
function renderAttentionRow(entry, submitterByDoc, viewerEmail) {
  const rec = (entry && entry.record) || {};
  const lc = (entry && entry.lifecycle) || {};
  const row = document.createElement("div");
  row.className = "log-attention-row";
  row.dataset.type = rec.type || "";

  const head = document.createElement("div");
  head.className = "log-row-head";
  const chip = document.createElement("span");
  chip.className = "record-chip";
  chip.dataset.type = rec.type || "";
  chip.textContent = rec.type === "decision" ? "Decision" : "Commitment";
  head.appendChild(chip);
  if (rec.primaryEntity) {
    const subj = document.createElement("span");
    subj.className = "log-row-subject";
    subj.textContent = prettySlug(rec.primaryEntity);
    head.appendChild(subj);
  }
  row.appendChild(head);

  const summary = document.createElement("p");
  summary.className = "log-row-summary";
  summary.textContent = rec.summary || "";
  row.appendChild(summary);

  // Metadata: owner + due are dim; only the overdue/silent count is amber.
  const dimParts = [];
  if (rec.owner) dimParts.push(prettySlug(rec.owner));
  if (rec.due) dimParts.push("due " + formatDueDate(rec.due));
  const hasSilent = typeof lc.silentDays === "number";
  // WP-N1 #6 — attribution from the join: "captured by you" (submitter == me),
  // "captured by <local-part>" (someone else), or omitted (no submitter on the
  // doc — pre-flag or shared-key capture). Never "unknown".
  const attribution = captureAttribution(rec.documentId, submitterByDoc, viewerEmail);
  if (dimParts.length || hasSilent || attribution) {
    const meta = document.createElement("p");
    meta.className = "log-row-meta";
    meta.textContent = dimParts.join(" · ");
    if (hasSilent) {
      if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
      const overdue = document.createElement("span");
      overdue.className = "log-meta-overdue";
      overdue.textContent = lc.silentDays + "d silent";
      meta.appendChild(overdue);
    }
    if (attribution) {
      if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
      const attr = document.createElement("span");
      attr.className = "log-meta-attr";
      attr.textContent = attribution;
      meta.appendChild(attr);
    }
    row.appendChild(meta);
  }

  // "Show receipts" — open the subject's evidence dossier.
  if (rec.primaryEntity) {
    const footer = document.createElement("div");
    footer.className = "log-row-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-link receipts-entry-btn";
    btn.textContent = "Show receipts →";
    btn.addEventListener("click", () => enterReceiptsView(rec.primaryEntity));
    footer.appendChild(btn);
    row.appendChild(footer);
  }
  return row;
}

/** One contradiction — a compact inline warning chip (severity tag + the two
 *  record summaries). The full explanation lives in Receipts, not here. */
function renderContradictionRow(edge) {
  const row = document.createElement("div");
  row.className = "log-contradiction-row";
  row.dataset.severity = edge.severity || "";

  if (edge.severity) {
    const sev = document.createElement("span");
    sev.className = "log-contradiction-sev";
    sev.textContent = edge.severity.toUpperCase();
    row.appendChild(sev);
  }

  const text = document.createElement("span");
  text.className = "log-contradiction-text";
  text.textContent = `${edge.recordASummary || "—"} ⟷ ${edge.recordBSummary || "—"}`;
  row.appendChild(text);
  return row;
}

/** One owner-load chip: a small ghost card — owner + open count (dim), with the
 *  overdue count in amber when present. */
function renderOwnerChip(o) {
  const chip = document.createElement("div");
  chip.className = "log-owner-chip";
  const name = document.createElement("span");
  name.className = "log-owner-name";
  name.textContent = prettySlug(o.owner);
  chip.appendChild(name);

  const count = document.createElement("span");
  count.className = "log-owner-count";
  count.textContent = `${o.commitments} open`;
  if (o.overdueSilent > 0) {
    count.appendChild(document.createTextNode(" · "));
    const overdue = document.createElement("span");
    overdue.className = "log-owner-overdue";
    overdue.textContent = `${o.overdueSilent} overdue`;
    count.appendChild(overdue);
  }
  chip.appendChild(count);
  return chip;
}

// Today-view buttons: back-to-widget, refresh, and the view-main / post-capture
// entry points.
const logBackBtn = document.getElementById("btn-log-back");
if (logBackBtn) {
  logBackBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("widget_collapse");
    } catch (err) {
      console.warn("[main] widget_collapse (log-back) failed:", err);
    }
  });
}

const logRefreshBtn = document.getElementById("btn-log-refresh");
if (logRefreshBtn) {
  logRefreshBtn.addEventListener("click", () => {
    enterLogView();
  });
}

// "Links" — jump from Today to the cross-record edge graph (Connections view).
const logEdgesBtn = document.getElementById("btn-log-edges");
if (logEdgesBtn) {
  logEdgesBtn.addEventListener("click", () => {
    enterEdgesView();
  });
}

const openLogBtn = document.getElementById("btn-open-log");
if (openLogBtn) {
  openLogBtn.addEventListener("click", () => {
    enterLogView();
  });
}

// WP-N1 #8 — Mine / Everyone segmented control. Wired once; re-renders the
// needs-attention list under the chosen filter (no re-fetch). The control is
// only visible when the viewer has an identity (set in enterLogView).
for (const btn of document.querySelectorAll(".log-filter-btn")) {
  btn.addEventListener("click", () => {
    setTodayFilter(btn.dataset.filter);
    renderTodayAttention();
  });
}

// ───────── Connections — grounded cross-record edges (WP-THRESHOLD-LOG-UX) ─────────

// Display order for the kind groups: conflicts first (highest signal), then the
// dependency graph (the most-requested surface), then the lifecycle edges.
const EDGE_KIND_ORDER = ["contradicts", "depends_on", "supersedes", "resolves", "duplicates"];

// Per-kind presentation. `verb` reads top-to-bottom as "A {verb} B"; for the
// directional kinds (depends_on/supersedes/resolves) the engine guarantees A is
// the acting/later/dependent record, so the order renders correctly as-is.
const EDGE_KIND_META = {
  contradicts: { label: "Conflict", plural: "Conflicts", verb: "conflicts with", icon: "⚠" },
  depends_on: { label: "Dependency", plural: "Dependencies", verb: "depends on", icon: "↳" },
  supersedes: { label: "Supersession", plural: "Supersessions", verb: "supersedes", icon: "⤳" },
  resolves: { label: "Resolution", plural: "Resolutions", verb: "resolves", icon: "✓" },
  duplicates: { label: "Duplicate", plural: "Duplicates", verb: "duplicate of", icon: "⧉" },
};

// Distinct record count for the current Connections render — used to keep the
// subtitle accurate after a dismiss removes a card (records don't change, the
// connection count does).
let _edgesRecordCount = 0;

/**
 * Open the Connections view: the full cross-record edge graph, each edge shown
 * with BOTH of its records inline. Pure display join — fetch_decision_log_full
 * proxies GET /api/decision-log?full=1, which returns every active edge plus the
 * full records; we index records by recordId and render each edge's two
 * endpoints. No recompute, no LLM. (Answers the most-asked question on the log:
 * "what are these dependencies referring to?")
 */
async function enterEdgesView() {
  state.inWizard = false;
  showView("view-edges");

  const listEl = document.getElementById("edges-list");
  const statusEl = document.getElementById("edges-status");
  const kindsStrip = document.getElementById("edges-kinds-strip");
  const subEl = document.getElementById("edges-sub");

  if (listEl) listEl.innerHTML = "";
  if (kindsStrip) kindsStrip.hidden = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Loading the connections…";
  }

  // Base URL for source-doc deep links (best-effort; insider-only, omitted if absent).
  let baseUrl = "";
  try {
    const cfg = await tauri.core.invoke("load_config");
    baseUrl = (cfg && cfg.base_url) || "";
  } catch (_e) {
    /* source links simply omitted if config is unavailable */
  }

  let data;
  try {
    data = await tauri.core.invoke("fetch_decision_log_full");
  } catch (err) {
    console.warn("[main] fetch_decision_log_full failed:", err);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        "Couldn't reach Apolla. Check your connection in Configure, then Refresh.";
    }
    return;
  }

  // Index records by recordId — the join key. Each entry is { record, lifecycle, state }.
  const items = Array.isArray(data && data.records) ? data.records : [];
  const byId = new Map();
  for (const item of items) {
    const rec = item && item.record ? item.record : item;
    if (rec && rec.recordId) byId.set(rec.recordId, rec);
  }
  const edges = Array.isArray(data && data.edges) ? data.edges : [];

  if (edges.length === 0) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent =
        "No cross-record connections yet. They appear once the editor pass links related decisions and commitments.";
    }
    if (subEl) subEl.textContent = "How your decisions & commitments relate";
    return;
  }
  if (statusEl) statusEl.hidden = true;

  // Group by kind; tally for the strip.
  const byKind = new Map();
  for (const e of edges) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }

  // Subtitle: live totals.
  _edgesRecordCount = byId.size;
  if (subEl) {
    subEl.textContent =
      `${edges.length} ${edges.length === 1 ? "link" : "links"} across ${byId.size} records`;
  }

  // Kinds strip — one count pill per present kind, in display order.
  if (kindsStrip) {
    kindsStrip.innerHTML = "";
    let any = false;
    for (const kind of EDGE_KIND_ORDER) {
      const group = byKind.get(kind);
      if (!group || group.length === 0) continue;
      const meta = EDGE_KIND_META[kind];
      const pill = document.createElement("span");
      pill.className = "edges-kind-pill";
      pill.dataset.kind = kind;
      const kindWord = (group.length === 1 ? meta.label : meta.plural).toLowerCase();
      pill.textContent = `${meta.icon} ${group.length} ${kindWord}`;
      kindsStrip.appendChild(pill);
      any = true;
    }
    kindsStrip.hidden = !any;
  }

  // Render groups in display order; severity-high edges first within a group.
  if (listEl) {
    const severityRank = (s) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
    for (const kind of EDGE_KIND_ORDER) {
      const group = byKind.get(kind);
      if (!group || group.length === 0) continue;
      const meta = EDGE_KIND_META[kind];

      const groupTitle = document.createElement("h2");
      groupTitle.className = "edges-group-title";
      groupTitle.dataset.kind = kind;
      groupTitle.textContent = group.length === 1 ? meta.label : meta.plural;
      listEl.appendChild(groupTitle);

      group
        .slice()
        .sort((a, b) => severityRank(a.severity) - severityRank(b.severity)
          || (a.edgeId || "").localeCompare(b.edgeId || ""))
        .forEach((edge) => listEl.appendChild(renderEdgeCard(edge, byId, baseUrl)));
    }
  }
}

/**
 * One connection card: the relationship kind + severity, then BOTH records
 * inline (A above, B below — A is the acting/dependent record for directional
 * kinds), and the engine's grounded (citation-checked) explanation.
 */
function renderEdgeCard(edge, byId, baseUrl) {
  const meta = EDGE_KIND_META[edge.kind] || { label: edge.kind || "Related", verb: "relates to", icon: "•" };
  const card = document.createElement("div");
  card.className = "edge-card";
  card.dataset.kind = edge.kind || "";
  card.dataset.severity = edge.severity || "";
  card.dataset.edgeId = edge.edgeId || "";
  card.dataset.status = edge.status || "proposed";

  // Header: kind label + severity pill (only when high/medium — low is the
  // default, unmarked) + a Confirmed pill once a human has confirmed the edge.
  const header = document.createElement("div");
  header.className = "edge-card-header";
  const kindChip = document.createElement("span");
  kindChip.className = "edge-kind-chip";
  kindChip.dataset.kind = edge.kind || "";
  kindChip.textContent = `${meta.icon} ${meta.label}`;
  header.appendChild(kindChip);
  if (edge.severity === "high" || edge.severity === "medium") {
    const sev = document.createElement("span");
    sev.className = "edge-sev-pill";
    sev.dataset.severity = edge.severity;
    sev.textContent = edge.severity.toUpperCase();
    header.appendChild(sev);
  }
  const confirmedPill = document.createElement("span");
  confirmedPill.className = "edge-confirmed-pill";
  confirmedPill.textContent = "✓ Confirmed";
  confirmedPill.hidden = edge.status !== "confirmed";
  header.appendChild(confirmedPill);
  card.appendChild(header);

  // The two endpoints, joined by a connector that names the relationship.
  card.appendChild(renderEdgeEndpoint(byId.get(edge.recordA), baseUrl));

  const connector = document.createElement("div");
  connector.className = "edge-connector";
  connector.dataset.kind = edge.kind || "";
  connector.textContent = `↓ ${meta.verb}`;
  card.appendChild(connector);

  card.appendChild(renderEdgeEndpoint(byId.get(edge.recordB), baseUrl));

  // Grounded explanation — the editor's citation-checked rationale for the edge.
  if (edge.explanation) {
    const why = document.createElement("p");
    why.className = "edge-explanation";
    why.textContent = edge.explanation;
    card.appendChild(why);
  }

  // HITL actions — confirm/dismiss (the calibration loop). Rebuilt in place on
  // each status change so the controls reflect the current state.
  const actions = document.createElement("div");
  actions.className = "edge-actions";
  card.appendChild(actions);
  renderEdgeActions(edge, card, confirmedPill, actions);

  return card;
}

/**
 * (Re)render the confirm/dismiss controls for one edge card, in place. Proposed
 * edges get Confirm + Dismiss; a confirmed edge shows Undo (revert to proposed).
 * A dismiss removes the card and re-tallies — the edge won't return on re-fetch.
 */
function renderEdgeActions(edge, card, confirmedPill, actions) {
  actions.innerHTML = "";
  const status = edge.status || "proposed";

  const mkBtn = (label, cls, newStatus) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn edge-action-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", () => patchEdge(edge, newStatus, card, confirmedPill, actions));
    return b;
  };

  if (status === "confirmed") {
    const note = document.createElement("span");
    note.className = "edge-action-note";
    note.textContent = "Confirmed — counts toward the cards.";
    actions.appendChild(note);
    actions.appendChild(mkBtn("Undo", "edge-action-undo", "proposed"));
  } else {
    actions.appendChild(mkBtn("Confirm", "edge-action-confirm", "confirmed"));
    actions.appendChild(mkBtn("Dismiss", "edge-action-dismiss", "dismissed"));
  }
}

/**
 * Drive one confirm/dismiss/undo through the engine (patch_edge_status IPC) and
 * reflect it. Optimistic-with-rollback: buttons disable during the call; on
 * success the card updates in place (confirm/undo) or animates out (dismiss); on
 * failure the prior controls return with an inline message.
 */
async function patchEdge(edge, newStatus, card, confirmedPill, actions) {
  const prevStatus = edge.status || "proposed";
  actions.querySelectorAll("button").forEach((b) => (b.disabled = true));

  let result;
  try {
    result = await tauri.core.invoke("patch_edge_status", { edgeId: edge.edgeId, status: newStatus });
  } catch (err) {
    console.warn("[main] patch_edge_status failed:", err);
    renderEdgeActions(edge, card, confirmedPill, actions); // restore controls
    const msg = document.createElement("span");
    msg.className = "edge-action-note edge-action-error";
    msg.textContent = "Couldn't save — check your connection and try again.";
    actions.appendChild(msg);
    return;
  }

  // Trust the server's echoed status when present.
  edge.status = (result && result.edge && result.edge.status) || newStatus;
  card.dataset.status = edge.status;

  if (edge.status === "dismissed") {
    card.classList.add("edge-card-leaving");
    setTimeout(() => {
      card.remove();
      refreshEdgeTallies();
    }, 180);
    return;
  }

  // confirmed or reverted-to-proposed — update in place.
  confirmedPill.hidden = edge.status !== "confirmed";
  card.classList.toggle("edge-card-confirmed", edge.status === "confirmed");
  renderEdgeActions(edge, card, confirmedPill, actions);
}

/**
 * Recompute the kind pills, group titles, and subtitle from the cards currently
 * in the DOM. Stateless — called after a dismiss removes a card so every count
 * stays truthful; an emptied group drops its title (and its pill).
 */
function refreshEdgeTallies() {
  const listEl = document.getElementById("edges-list");
  const kindsStrip = document.getElementById("edges-kinds-strip");
  const subEl = document.getElementById("edges-sub");
  const statusEl = document.getElementById("edges-status");
  if (!listEl) return;

  const cards = [...listEl.querySelectorAll(".edge-card")];
  const counts = {};
  for (const c of cards) counts[c.dataset.kind] = (counts[c.dataset.kind] || 0) + 1;

  // Group titles: update or remove.
  for (const title of [...listEl.querySelectorAll(".edges-group-title")]) {
    const kind = title.dataset.kind;
    const n = counts[kind] || 0;
    const meta = EDGE_KIND_META[kind];
    if (n === 0) title.remove();
    else if (meta) title.textContent = n === 1 ? meta.label : meta.plural;
  }

  // Kind pills: update or remove.
  if (kindsStrip) {
    for (const pill of [...kindsStrip.querySelectorAll(".edges-kind-pill")]) {
      const kind = pill.dataset.kind;
      const n = counts[kind] || 0;
      const meta = EDGE_KIND_META[kind];
      if (n === 0) pill.remove();
      else if (meta) pill.textContent = `${meta.icon} ${n} ${(n === 1 ? meta.label : meta.plural).toLowerCase()}`;
    }
    kindsStrip.hidden = kindsStrip.querySelectorAll(".edges-kind-pill").length === 0;
  }

  // Subtitle + empty state.
  if (subEl) {
    subEl.textContent = cards.length === 0
      ? "How your decisions & commitments relate"
      : `${cards.length} ${cards.length === 1 ? "connection" : "connections"} across ${_edgesRecordCount} records`;
  }
  if (statusEl && cards.length === 0) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "empty";
    statusEl.textContent = "All connections reviewed. Nothing left to confirm or dismiss.";
  }
}

/** One endpoint inside a connection card: type chip + summary + owner·due·source. */
function renderEdgeEndpoint(rec, baseUrl) {
  const ep = document.createElement("div");
  ep.className = "edge-endpoint";
  if (!rec) {
    // Defensive — the join is sound on real data (0 unresolved), but never throw.
    ep.classList.add("edge-endpoint-missing");
    ep.textContent = "(record unavailable in your view)";
    return ep;
  }

  const head = document.createElement("div");
  head.className = "edge-endpoint-head";
  const chip = document.createElement("span");
  chip.className = "record-chip";
  chip.dataset.type = rec.type || "";
  chip.textContent = rec.type === "decision" ? "Decision" : "Commitment";
  head.appendChild(chip);
  ep.appendChild(head);

  const summary = document.createElement("p");
  summary.className = "edge-endpoint-summary";
  summary.textContent = rec.summary || "";
  ep.appendChild(summary);

  // Meta: owner · due · source link (each part omitted when absent).
  const meta = document.createElement("p");
  meta.className = "edge-endpoint-meta";
  const dim = [];
  if (rec.owner) dim.push(prettySlug(rec.owner));
  if (rec.due) dim.push("due " + formatDueDate(rec.due));
  meta.textContent = dim.join(" · ");
  const link = receiptsDeepLink(baseUrl, rec.documentId);
  if (link) {
    if (meta.textContent) meta.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.className = "edge-endpoint-source";
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "source ↗";
    meta.appendChild(a);
  }
  if (meta.textContent || link) ep.appendChild(meta);

  return ep;
}

// Connections-view buttons: back-to-widget, refresh, and the view-main entry.
const edgesBackBtn = document.getElementById("btn-edges-back");
if (edgesBackBtn) {
  edgesBackBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("widget_collapse");
    } catch (err) {
      console.warn("[main] widget_collapse (edges-back) failed:", err);
    }
  });
}

const edgesRefreshBtn = document.getElementById("btn-edges-refresh");
if (edgesRefreshBtn) {
  edgesRefreshBtn.addEventListener("click", () => {
    enterEdgesView();
  });
}

const openEdgesBtn = document.getElementById("btn-open-edges");
if (openEdgesBtn) {
  openEdgesBtn.addEventListener("click", () => {
    enterEdgesView();
  });
}

// ───────── Definition card — per-entity "what is this, here, now" (WP-THRESHOLD-LOG-UX) ─────────

// The subject we navigated into the card from, so Back returns to its Receipts.
let _entityCardReturn = null;

/**
 * Open the Definition card for a subject entity. Fetches GET /api/entity/:slug/card
 * via fetch_entity_card and renders ONLY the register-bounded prose — never the
 * internal license/violations/layers. Handles the soft not-ready states the IPC
 * surfaces (flag off / unknown entity / no API key) with calm copy, and a hard
 * unreachable error distinctly.
 */
async function enterEntityCardView(entity) {
  state.inWizard = false;
  _entityCardReturn = entity;
  showView("view-entity-card");

  const titleEl = document.getElementById("entity-card-title");
  const proseEl = document.getElementById("entity-card-prose");
  const statusEl = document.getElementById("entity-card-status");
  const footerEl = document.querySelector("#view-entity-card .entity-card-footer");

  if (titleEl) titleEl.textContent = prettySlug(entity);
  if (proseEl) proseEl.innerHTML = "";
  if (footerEl) footerEl.hidden = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Compiling the definition…";
  }

  let data;
  try {
    data = await tauri.core.invoke("fetch_entity_card", { entity });
  } catch (err) {
    console.warn("[main] fetch_entity_card failed:", err);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        "Couldn't reach Apolla. Check your connection in Configure, then try again.";
    }
    return;
  }

  // Soft not-ready states (returned as Ok by the IPC, never thrown).
  if (data && data.available === false) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent = data.reason === "unavailable"
        ? "Definitions aren't available on this server yet."
        : "No definition for this subject yet.";
    }
    return;
  }

  const prose = data && typeof data.prose === "string" ? data.prose.trim() : "";
  if (!prose) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent = "No definition for this subject yet.";
    }
    return;
  }

  if (statusEl) statusEl.hidden = true;
  // Render prose as paragraphs (split on blank lines); textContent keeps it XSS-safe.
  if (proseEl) {
    proseEl.innerHTML = "";
    for (const para of prose.split(/\n{2,}/)) {
      const p = document.createElement("p");
      p.className = "entity-card-paragraph";
      p.textContent = para.trim();
      if (p.textContent) proseEl.appendChild(p);
    }
  }
  if (footerEl) footerEl.hidden = false;
}

// Definition entry — from the Receipts header (both are entity-scoped).
const receiptsCardBtn = document.getElementById("btn-receipts-card");
if (receiptsCardBtn) {
  receiptsCardBtn.addEventListener("click", () => {
    const entity = currentReceipts && currentReceipts.entity;
    if (entity) enterEntityCardView(entity);
  });
}

// Back — return to the subject's Receipts when we came from there, else collapse.
const entityCardBackBtn = document.getElementById("btn-entity-card-back");
if (entityCardBackBtn) {
  entityCardBackBtn.addEventListener("click", async () => {
    if (_entityCardReturn) {
      enterReceiptsView(_entityCardReturn);
      return;
    }
    try {
      await tauri.core.invoke("widget_collapse");
    } catch (err) {
      console.warn("[main] widget_collapse (entity-card-back) failed:", err);
    }
  });
}

// ───────── Receipts — the evidence dossier (WP-THRESHOLD-LOG-UX) ─────────

// The receipts payload currently rendered, stashed so the Copy button can
// rebuild the Markdown + HTML deterministically from the same data.
let currentReceipts = null;

/**
 * Open the Receipts view for a subject entity. Fetches
 * /api/decision-log/receipts?entity=X via the fetch_receipts IPC and renders
 * the deterministic chain. Also resolves the configured base URL so per-record
 * source links reuse the tidbit deepLink scheme ({base}/document/{documentId}).
 */
async function enterReceiptsView(entity) {
  state.inWizard = false;
  showView("view-receipts");

  const titleEl = document.getElementById("receipts-title");
  const subEl = document.getElementById("receipts-sub");
  const currentEl = document.getElementById("receipts-current");
  const chainEl = document.getElementById("receipts-chain");
  const statusEl = document.getElementById("receipts-status");

  if (titleEl) titleEl.textContent = prettySlug(entity);
  if (subEl) subEl.hidden = true;
  if (currentEl) currentEl.hidden = true;
  if (chainEl) chainEl.innerHTML = "";
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Compiling the receipts…";
  }
  currentReceipts = null;

  // Base URL for source-doc deep links (best-effort; links are insider-only).
  let baseUrl = "";
  try {
    const cfg = await tauri.core.invoke("load_config");
    baseUrl = (cfg && cfg.base_url) || "";
  } catch (_e) {
    /* links simply omitted if config is unavailable */
  }

  let data;
  try {
    data = await tauri.core.invoke("fetch_receipts", { entity });
  } catch (err) {
    console.warn("[main] fetch_receipts failed:", err);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        "Couldn't reach Apolla. Check your connection in Configure, then try again.";
    }
    return;
  }

  const items = Array.isArray(data && data.records) ? data.records : [];
  const edges = Array.isArray(data && data.edges) ? data.edges : [];

  if (statusEl) {
    if (items.length === 0) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent = "No records reference this subject yet.";
    } else {
      statusEl.hidden = true;
    }
  }

  if (subEl) {
    subEl.textContent =
      items.length === 1 ? "1 record" : `${items.length} records, oldest first`;
    subEl.hidden = items.length === 0;
  }

  currentReceipts = { entity, items, edges, baseUrl };
  renderReceiptsCurrentState(items, edges);
  renderReceiptsChain(items, edges, baseUrl);
}

/** Build the source-doc deep link for a record, reusing the tidbit scheme.
 *  Returns "" when no base URL is configured. */
function receiptsDeepLink(baseUrl, documentId) {
  if (!baseUrl || !documentId) return "";
  return `${baseUrl.replace(/\/+$/, "")}/document/${encodeURIComponent(documentId)}`;
}

/**
 * Derive the current-state line deterministically from the record states: the
 * most recent record still 'open' is the standing position; if none are open,
 * the most recent record and its terminal state. No LLM, pure data.
 */
function deriveReceiptsCurrentState(items) {
  if (!items.length) return null;
  // items arrive chronological asc; scan from newest backwards for an open one.
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].state === "open") return { item: items[i], standing: true };
  }
  return { item: items[items.length - 1], standing: false };
}

function renderReceiptsCurrentState(items, _edges) {
  const el = document.getElementById("receipts-current");
  if (!el) return;
  el.innerHTML = "";
  const derived = deriveReceiptsCurrentState(items);
  if (!derived) {
    el.hidden = true;
    return;
  }
  const rec = derived.item.record || {};
  // "Current state:" label (dim) + the standing summary, one line, lighter than
  // the records below.
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = (derived.standing ? "Current state: " : "Last record: ");
  el.appendChild(label);
  el.appendChild(document.createTextNode(rec.summary || ""));
  el.hidden = false;
}

/** Render the chronological chain — a single absolute rail + one .rec per
 *  record (date in the meta line, no left date column). */
function renderReceiptsChain(items, edges, baseUrl) {
  const chainEl = document.getElementById("receipts-chain");
  if (!chainEl) return;
  chainEl.innerHTML = "";

  const edgesByRecord = new Map();
  for (const e of Array.isArray(edges) ? edges : []) {
    for (const rid of [e.recordA, e.recordB]) {
      if (!rid) continue;
      if (!edgesByRecord.has(rid)) edgesByRecord.set(rid, []);
      edgesByRecord.get(rid).push(e);
    }
  }

  // One continuous rail behind the icons (only meaningful with ≥2 records).
  if (items.length > 1) {
    const rail = document.createElement("div");
    rail.className = "chain-rail";
    chainEl.appendChild(rail);
  }

  for (const item of items) {
    const rec = item.record || item;
    chainEl.appendChild(
      renderReceiptNode(
        rec,
        item.state,
        edgesByRecord.get(rec.recordId) || [],
        baseUrl,
        item.coSign,
      ),
    );
  }
}

function renderReceiptNode(rec, recState, recEdges, baseUrl, coSign) {
  const node = document.createElement("div");
  node.className = "rec";
  if (recState) node.dataset.state = recState;

  // Icon — the type node on the rail (decision blue / commitment green).
  const icon = document.createElement("div");
  icon.className = "rec-icon";
  icon.dataset.type = rec.type || "";
  icon.textContent = rec.type === "decision" ? "D" : "C";
  node.appendChild(icon);

  const body = document.createElement("div");
  body.className = "rec-body";

  // Meta — date · type · owner (the date lives HERE, not a left column).
  const metaBits = [];
  if (rec.date) metaBits.push(formatDueDate(rec.date));
  if (rec.type) metaBits.push(rec.type);
  if (rec.owner) metaBits.push(prettySlug(rec.owner));
  const meta = document.createElement("p");
  meta.className = "rec-meta";
  meta.textContent = metaBits.join(" · ");
  body.appendChild(meta);

  // Title (the summary).
  const title = document.createElement("p");
  title.className = "rec-title";
  title.textContent = rec.summary || "";
  body.appendChild(title);

  // Verbatim quote — ONLY when verified (the trust property). Border-left only,
  // no box.
  if (rec.verbatimVerified === true && rec.verbatim) {
    const quote = document.createElement("blockquote");
    quote.className = "rec-quote";
    quote.textContent = rec.verbatim;
    body.appendChild(quote);
  }

  // Edge chips — supersession/conflict (red family), resolution (green).
  for (const e of recEdges) {
    const phrasing = edgePhrasing(e, rec.recordId);
    if (!phrasing) continue;
    const chipEl = document.createElement("span");
    chipEl.className = "rec-edge";
    chipEl.dataset.kind = e.kind || "";
    chipEl.textContent = `${phrasing.icon} ${phrasing.label}`;
    body.appendChild(chipEl);
  }

  // WP-N1 #7 — count-only co-sign ("N captures corroborate"): independent
  // capture corroboration, green-family chip. confirmed = solid, proposed =
  // dimmer. Server emits it only at captureCount ≥ 2; absent ⇒ no chip. NEVER
  // the corroborating emails — count only.
  if (coSign && typeof coSign.captureCount === "number" && coSign.captureCount >= 2) {
    const cs = document.createElement("span");
    cs.className = "rec-cosign";
    cs.dataset.status = coSign.status === "confirmed" ? "confirmed" : "proposed";
    cs.textContent = `✓ ${coSign.captureCount} captures corroborate`;
    body.appendChild(cs);
  }

  // Source-doc link (insider verification path).
  const link = receiptsDeepLink(baseUrl, rec.documentId);
  if (link) {
    const a = document.createElement("a");
    a.className = "rec-source";
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "source ↗";
    body.appendChild(a);
  }

  node.appendChild(body);
  return node;
}

// ── Deterministic Markdown + HTML builders (no LLM; byte-identical per input) ──
// HTML escaping reuses the existing escapeHtml() helper (escapes & < >); the
// only attribute interpolation is href, whose value is URL-encoded upstream.

/** Direction-aware plain-text edge phrasing for export (no emoji icon). */
function edgeExportLabel(edge, recId) {
  const p = edgePhrasing(edge, recId);
  return p ? p.label : "";
}

function buildReceiptsMarkdown(entity, items, edges, baseUrl) {
  const edgesByRecord = new Map();
  for (const e of edges) {
    for (const rid of [e.recordA, e.recordB]) {
      if (!rid) continue;
      if (!edgesByRecord.has(rid)) edgesByRecord.set(rid, []);
      edgesByRecord.get(rid).push(e);
    }
  }
  const lines = [];
  lines.push(`# Receipts — ${prettySlug(entity)}`);
  lines.push("> compiled by Threshold from meeting captures · every quote verbatim from source");
  lines.push("");

  for (const item of items) {
    const rec = item.record || item;
    const typeLabel = rec.type === "decision" ? "Decision" : "Commitment";
    const dateLabel = rec.date ? formatDueDate(rec.date) : "";
    const header = [dateLabel, typeLabel, rec.owner ? prettySlug(rec.owner) : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(`## ${header}`);
    if (rec.summary) lines.push(rec.summary);
    if (rec.verbatimVerified === true && rec.verbatim) {
      lines.push(`> "${rec.verbatim}"`);
    }
    for (const e of edgesByRecord.get(rec.recordId) || []) {
      const label = edgeExportLabel(e, rec.recordId);
      if (label) lines.push(`- ${label}`);
    }
    const state = item.state || "open";
    if (state !== "open") lines.push(`_(${state})_`);
    const link = receiptsDeepLink(baseUrl, rec.documentId);
    if (link) lines.push(`[source](${link})`);
    lines.push("");
  }

  const derived = deriveReceiptsCurrentState(items);
  if (derived) {
    const rec = derived.item.record || {};
    lines.push("---");
    const tag = derived.standing ? "Current state" : "Last record";
    lines.push(`**${tag}:** ${rec.summary || ""}`);
  }
  return lines.join("\n");
}

function buildReceiptsHtml(entity, items, edges, baseUrl) {
  const edgesByRecord = new Map();
  for (const e of edges) {
    for (const rid of [e.recordA, e.recordB]) {
      if (!rid) continue;
      if (!edgesByRecord.has(rid)) edgesByRecord.set(rid, []);
      edgesByRecord.get(rid).push(e);
    }
  }
  const out = [];
  out.push(
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1e26;max-width:640px">`,
  );
  out.push(`<h1 style="font-size:20px;margin:0 0 4px">Receipts — ${escapeHtml(prettySlug(entity))}</h1>`);
  out.push(
    `<p style="font-size:12px;color:#6b7280;margin:0 0 16px">compiled by Threshold from meeting captures · every quote verbatim from source</p>`,
  );

  for (const item of items) {
    const rec = item.record || item;
    const typeLabel = rec.type === "decision" ? "Decision" : "Commitment";
    const dateLabel = rec.date ? formatDueDate(rec.date) : "";
    const header = [dateLabel, typeLabel, rec.owner ? prettySlug(rec.owner) : ""]
      .filter(Boolean)
      .join(" · ");
    out.push(`<div style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #d0d3da">`);
    out.push(`<div style="font-size:12px;font-weight:600;color:#6b7280">${escapeHtml(header)}</div>`);
    if (rec.summary)
      out.push(`<div style="font-size:15px;margin:2px 0 6px">${escapeHtml(rec.summary)}</div>`);
    if (rec.verbatimVerified === true && rec.verbatim) {
      out.push(
        `<blockquote style="margin:6px 0;padding:6px 12px;border-left:2px solid #c0c4cc;color:#444;font-style:italic">${escapeHtml(
          rec.verbatim,
        )}</blockquote>`,
      );
    }
    for (const e of edgesByRecord.get(rec.recordId) || []) {
      const label = edgeExportLabel(e, rec.recordId);
      if (label) out.push(`<div style="font-size:13px;color:#9a3412">• ${escapeHtml(label)}</div>`);
    }
    const state = item.state || "open";
    if (state !== "open")
      out.push(`<div style="font-size:12px;color:#6b7280">(${escapeHtml(state)})</div>`);
    const link = receiptsDeepLink(baseUrl, rec.documentId);
    if (link)
      out.push(
        `<div style="font-size:12px;margin-top:4px"><a href="${escapeHtml(link)}" style="color:#2f7ae5">source ↗</a></div>`,
      );
    out.push(`</div>`);
  }

  const derived = deriveReceiptsCurrentState(items);
  if (derived) {
    const rec = derived.item.record || {};
    const tag = derived.standing ? "Current state" : "Last record";
    out.push(
      `<p style="font-size:14px;margin:12px 0 0;padding-top:12px;border-top:1px solid #e5e7eb"><strong>${tag}:</strong> ${escapeHtml(
        rec.summary || "",
      )}</p>`,
    );
  }
  out.push(`</div>`);
  return out.join("");
}

// Receipts view buttons: Copy (dual-format) + back-to-Today.
const receiptsCopyBtn = document.getElementById("btn-receipts-copy");
if (receiptsCopyBtn) {
  receiptsCopyBtn.addEventListener("click", async () => {
    if (!currentReceipts || !currentReceipts.items.length) return;
    const { entity, items, edges, baseUrl } = currentReceipts;
    const markdown = buildReceiptsMarkdown(entity, items, edges, baseUrl);
    const html = buildReceiptsHtml(entity, items, edges, baseUrl);
    try {
      await tauri.core.invoke("copy_receipts", { html, markdown });
      const original = receiptsCopyBtn.textContent;
      receiptsCopyBtn.textContent = "Copied ✓";
      receiptsCopyBtn.disabled = true;
      setTimeout(() => {
        receiptsCopyBtn.textContent = original;
        receiptsCopyBtn.disabled = false;
      }, 1600);
    } catch (err) {
      console.warn("[main] copy_receipts failed:", err);
      const original = receiptsCopyBtn.textContent;
      receiptsCopyBtn.textContent = "Copy failed";
      setTimeout(() => {
        receiptsCopyBtn.textContent = original;
      }, 1600);
    }
  });
}

const receiptsBackBtn = document.getElementById("btn-receipts-back");
if (receiptsBackBtn) {
  receiptsBackBtn.addEventListener("click", () => {
    enterLogView();
  });
}

// ───────── Plaud Sync Queue (WP-PLAUD-04a) ─────────

/**
 * Render the Plaud Sync Queue view. Loads pending items via the
 * `plaud_get_inbox` IPC and renders one card per item.
 *
 * Per WP-PLAUD-04a:
 *   - Item card shows: name, date+time, duration, speaker count + named-count,
 *     summary preview (truncated server-side to ~500 chars; we render verbatim)
 *   - Action buttons per card: Import / Skip / Always sync from this device /
 *     Always skip from this device
 *   - "Sync now" button → plaud_discover IPC → re-fetch + re-render
 *   - "Back" button → widget_collapse
 *
 * Failure-safe: if the IPC errors (e.g., server unreachable, PLAUD_ENABLED
 * unset and server returned 503), surface via showToast + leave the empty
 * state visible.
 */
async function enterPlaudQueueView() {
  state.inWizard = false;
  showView("view-plaud-queue");
  await refreshPlaudQueue();
}

/**
 * Re-fetch the inbox + re-render. Called on view-enter and after every
 * action that mutates inbox state (decide, ingest, sync-now).
 */
async function refreshPlaudQueue() {
  const listEl = document.getElementById("plaud-queue-list");
  const emptyEl = document.getElementById("plaud-queue-empty");
  const metaEl = document.getElementById("plaud-queue-meta");
  if (!listEl || !emptyEl || !metaEl) return;

  // Clear prior cards
  listEl.innerHTML = "";

  let items;
  try {
    items = await tauri.core.invoke("plaud_get_inbox");
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Couldn't load Plaud queue",
      body: String(err),
    });
    emptyEl.hidden = false;
    metaEl.textContent = "";
    return;
  }

  // Only pending items belong on the queue. 'ingested' and 'skipped' items
  // are terminal (per WP-PLAUD-01) and don't re-surface.
  const pending = Array.isArray(items)
    ? items.filter((it) => it && it.state === "pending")
    : [];

  if (pending.length === 0) {
    emptyEl.hidden = false;
    metaEl.textContent = "";
    return;
  }

  emptyEl.hidden = true;
  metaEl.textContent = pending.length === 1 ? "1 new" : `${pending.length} new`;

  for (const item of pending) {
    listEl.appendChild(renderPlaudCard(item));
  }
}

/**
 * Build a single inbox-item card. Uses createElement + textContent throughout
 * (matches enterTidbitView's pattern — no innerHTML for user-supplied
 * strings).
 */
function renderPlaudCard(item) {
  const card = document.createElement("div");
  card.className = "plaud-queue-card";
  card.dataset.id = item.id;
  card.dataset.serial = item.serialNumber || "";

  const title = document.createElement("div");
  title.className = "plaud-queue-card-title";
  title.textContent = item.name || "Untitled recording";
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "plaud-queue-card-meta";
  meta.textContent = formatPlaudMeta(item);
  card.appendChild(meta);

  if (item.summaryPreview) {
    const summary = document.createElement("div");
    summary.className = "plaud-queue-card-summary";
    summary.textContent = item.summaryPreview;
    card.appendChild(summary);
  }

  const actions = document.createElement("div");
  actions.className = "plaud-queue-card-actions";

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "btn btn-primary plaud-queue-action";
  importBtn.textContent = "Import";
  importBtn.addEventListener("click", () => handlePlaudImport(item, card));
  actions.appendChild(importBtn);

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "btn btn-secondary plaud-queue-action";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => handlePlaudSkip(item, card));
  actions.appendChild(skipBtn);

  const alwaysSyncBtn = document.createElement("button");
  alwaysSyncBtn.type = "button";
  alwaysSyncBtn.className = "btn btn-secondary plaud-queue-action";
  alwaysSyncBtn.textContent = "Always sync from this device";
  alwaysSyncBtn.addEventListener("click", () =>
    handlePlaudAlwaysFromDevice(item, card, "import"),
  );
  actions.appendChild(alwaysSyncBtn);

  const alwaysSkipBtn = document.createElement("button");
  alwaysSkipBtn.type = "button";
  alwaysSkipBtn.className = "btn btn-secondary plaud-queue-action";
  alwaysSkipBtn.textContent = "Always skip from this device";
  alwaysSkipBtn.addEventListener("click", () =>
    handlePlaudAlwaysFromDevice(item, card, "skip"),
  );
  actions.appendChild(alwaysSkipBtn);

  card.appendChild(actions);
  return card;
}

/**
 * Compose the meta line: "Tue 2:14 PM · 53min · 7 speakers (3 named)"
 * The brief's UI mockup uses the short weekday name; we use the system
 * locale for both date and time so the user sees what their OS would
 * naturally render. Speaker count + named is only appended when present.
 */
function formatPlaudMeta(item) {
  const parts = [];

  const startAt = item.startAt ? new Date(item.startAt) : null;
  if (startAt && !isNaN(startAt.getTime())) {
    const dt = startAt.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    parts.push(dt);
  }

  if (typeof item.durationMs === "number" && item.durationMs > 0) {
    parts.push(formatPlaudDuration(item.durationMs));
  }

  if (typeof item.speakerCount === "number" && item.speakerCount > 0) {
    const named = item.speakerNamedCount || 0;
    const noun = item.speakerCount === 1 ? "speaker" : "speakers";
    parts.push(
      named > 0
        ? `${item.speakerCount} ${noun} (${named} named)`
        : `${item.speakerCount} ${noun}`,
    );
  }

  return parts.join(" · ");
}

/**
 * Render a duration in human-friendly form.
 *   < 1 min  → "Ns"
 *   < 1 hour → "Mm" (drops trailing seconds for readability)
 *   ≥ 1 hour → "Hh Mm"
 */
function formatPlaudDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}min`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Import: persist the decision, then run the ingest. On success, remove the
 * card from view (optimistically). On any failure, leave the card and toast.
 */
async function handlePlaudImport(item, cardEl) {
  setCardBusy(cardEl, true);
  try {
    await tauri.core.invoke("plaud_decide", { id: item.id, action: "import" });
    const result = await tauri.core.invoke("plaud_ingest", { id: item.id });
    removePlaudCard(cardEl);
    showToast({
      kind: "success",
      title: `Imported: ${item.name || "recording"}`,
      body: result?.apollaDocumentId
        ? `Apolla document: ${result.apollaDocumentId}`
        : undefined,
    });
    refreshPlaudQueueMeta();
  } catch (err) {
    setCardBusy(cardEl, false);
    showToast({
      kind: "failure",
      title: "Import failed",
      body: String(err),
    });
  }
}

/**
 * Skip: persist the decision; card removed.
 */
async function handlePlaudSkip(item, cardEl) {
  setCardBusy(cardEl, true);
  try {
    await tauri.core.invoke("plaud_decide", { id: item.id, action: "skip" });
    removePlaudCard(cardEl);
    showToast({
      kind: "success",
      title: `Skipped: ${item.name || "recording"}`,
    });
    refreshPlaudQueueMeta();
  } catch (err) {
    setCardBusy(cardEl, false);
    showToast({
      kind: "failure",
      title: "Skip failed",
      body: String(err),
    });
  }
}

/**
 * "Always sync/skip from this device" — handle this specific card, then
 * optimistically remove other pending cards from the same device.
 *
 * For v1, this does NOT post a rule to a rules-engine endpoint — that's
 * WP-PLAUD-03 (Sprint 2). When that lands, this function will also POST to
 * `/api/plaud/rules` with a new device rule.
 */
async function handlePlaudAlwaysFromDevice(item, cardEl, action) {
  setCardBusy(cardEl, true);
  try {
    await tauri.core.invoke("plaud_decide", { id: item.id, action });
    if (action === "import") {
      await tauri.core.invoke("plaud_ingest", { id: item.id });
    }

    // TODO(WP-PLAUD-03): also POST /api/plaud/rules with a new device rule
    // { kind: 'device', serialNumber: item.serialNumber, action } so future
    // recordings from this device auto-route without surfacing in the queue.

    removePlaudCard(cardEl);

    // Optimistically remove other pending cards from the same device.
    // Server-side, those cards stay in 'pending' for now; once the rules
    // engine ships (WP-PLAUD-03), the next sync pass will re-evaluate them
    // against the rule and either auto-ingest or auto-skip on the server.
    if (item.serialNumber) {
      const listEl = document.getElementById("plaud-queue-list");
      if (listEl) {
        const siblings = listEl.querySelectorAll(
          `.plaud-queue-card[data-serial="${cssEscape(item.serialNumber)}"]`,
        );
        siblings.forEach((sib) => removePlaudCard(sib));
      }
    }

    showToast({
      kind: "success",
      title:
        action === "import"
          ? `Always syncing recordings from this device`
          : `Always skipping recordings from this device`,
      body: "Other pending recordings from this device cleared from queue.",
    });
    refreshPlaudQueueMeta();
  } catch (err) {
    setCardBusy(cardEl, false);
    showToast({
      kind: "failure",
      title: action === "import" ? "Always-sync failed" : "Always-skip failed",
      body: String(err),
    });
  }
}

/**
 * Minimal CSS.escape polyfill — Threshold has no bundled CSSEscape lib and
 * Plaud serial numbers don't usually contain special chars, but be safe.
 */
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) =>
    "\\" + c.charCodeAt(0).toString(16) + " ",
  );
}

function setCardBusy(cardEl, busy) {
  if (!cardEl) return;
  cardEl.classList.toggle("plaud-queue-card-busy", !!busy);
  cardEl
    .querySelectorAll(".plaud-queue-action")
    .forEach((btn) => (btn.disabled = !!busy));
}

function removePlaudCard(cardEl) {
  if (!cardEl) return;
  cardEl.remove();
  // If we just removed the last card, show the empty state.
  const listEl = document.getElementById("plaud-queue-list");
  const emptyEl = document.getElementById("plaud-queue-empty");
  if (listEl && emptyEl && listEl.children.length === 0) {
    emptyEl.hidden = false;
  }
}

/**
 * Update the header "N new" count to reflect the current rendered list.
 * Called after card removal/render so the meta line stays in sync.
 */
function refreshPlaudQueueMeta() {
  const listEl = document.getElementById("plaud-queue-list");
  const metaEl = document.getElementById("plaud-queue-meta");
  if (!listEl || !metaEl) return;
  const n = listEl.children.length;
  metaEl.textContent = n === 0 ? "" : n === 1 ? "1 new" : `${n} new`;
}

/**
 * "Sync now" button handler — manually trigger a discover pass, then refresh.
 */
async function handlePlaudSyncNow() {
  const btn = document.getElementById("btn-plaud-sync-now");
  if (btn) btn.disabled = true;
  try {
    const result = await tauri.core.invoke("plaud_discover");
    await refreshPlaudQueue();
    const summary =
      result && typeof result.newItems === "number"
        ? result.newItems === 0
          ? "No new recordings found."
          : `Found ${result.newItems} new recording${result.newItems === 1 ? "" : "s"}.`
        : "Sync complete.";
    showToast({
      kind: "success",
      title: "Plaud sync complete",
      body: summary,
    });
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Plaud sync failed",
      body: String(err),
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ───────── WP-ONENOTE-EXPORT-04 — OneNote browse view ─────────

/**
 * Enter the OneNote browse view. Loads the notebook hierarchy via the
 * onenote_enumerate_hierarchy IPC (or reuses the cached tree if it's
 * less than 15min old) and renders collapsible notebook → section rows.
 *
 * Per-section "Send all N pages" button dispatches
 * onenote_send_section(sectionId). Progress + final-report UI is wired
 * via the onenote-bulk-send-progress / onenote-bulk-send-complete events
 * (see wireBackendEvents).
 *
 * Failure-safe: if the IPC errors (e.g., COM not available on Mac, no
 * OneNote installed), the empty state shows and a toast surfaces the
 * error. View still renders so the user can navigate back.
 */
async function enterOneNoteBrowseView() {
  state.inWizard = false;
  showView("view-onenote-browse");
  // Hide any leftover progress UI from a previous bulk-send session.
  hideOneNoteBulkSendProgress();
  await refreshOneNoteBrowse(/* force */ false);
}

/**
 * Re-fetch the hierarchy if cache is empty or stale; otherwise render
 * from cache. `force=true` always re-fetches (Refresh button).
 */
async function refreshOneNoteBrowse(force) {
  const treeEl = document.getElementById("onenote-browse-tree");
  const emptyEl = document.getElementById("onenote-browse-empty");
  const metaEl = document.getElementById("onenote-browse-meta");
  if (!treeEl || !emptyEl || !metaEl) return;

  const cached = state.onenoteHierarchy;
  const ageMs = Date.now() - (cached.fetchedAt || 0);
  const needFetch =
    force || !cached.tree || ageMs > ONENOTE_HIERARCHY_CACHE_TTL_MS;

  if (needFetch) {
    metaEl.textContent = "Loading…";
    const refreshBtn = document.getElementById("btn-onenote-browse-refresh");
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const tree = await tauri.core.invoke("onenote_enumerate_hierarchy");
      state.onenoteHierarchy = { tree, fetchedAt: Date.now() };
    } catch (err) {
      // Most likely paths:
      //   - PlatformUnsupported on Mac/Linux (OneNote COM is Windows-only)
      //   - ComClassNotRegistered (OneNote not installed or UWP variant)
      //   - NoNotebookOpen (OneNote running but no notebook loaded)
      // All map to the same UX: empty state visible, toast surfaces detail.
      treeEl.innerHTML = "";
      emptyEl.hidden = false;
      metaEl.textContent = "";
      showToast({
        kind: "failure",
        title: "Couldn't load OneNote notebooks",
        body: String(err),
      });
      if (refreshBtn) refreshBtn.disabled = false;
      return;
    }
    if (refreshBtn) refreshBtn.disabled = false;
  }

  renderOneNoteBrowse(state.onenoteHierarchy.tree);
}

/**
 * Render the notebook tree. Vanilla createElement + textContent throughout
 * (matches enterPlaudQueueView's pattern — no innerHTML for OneNote-supplied
 * strings, which can contain anything the user typed).
 */
function renderOneNoteBrowse(tree) {
  const treeEl = document.getElementById("onenote-browse-tree");
  const emptyEl = document.getElementById("onenote-browse-empty");
  const metaEl = document.getElementById("onenote-browse-meta");
  if (!treeEl || !emptyEl || !metaEl) return;

  treeEl.innerHTML = "";

  const notebooks = Array.isArray(tree?.notebooks) ? tree.notebooks : [];
  if (notebooks.length === 0) {
    emptyEl.hidden = false;
    metaEl.textContent = "";
    return;
  }
  emptyEl.hidden = true;

  // Header meta: total notebook + page counts.
  let totalSections = 0;
  let totalPages = 0;
  for (const nb of notebooks) {
    const sections = Array.isArray(nb.sections) ? nb.sections : [];
    totalSections += sections.length;
    for (const sec of sections) {
      totalPages += Array.isArray(sec.pages) ? sec.pages.length : 0;
    }
  }
  metaEl.textContent =
    `${notebooks.length} notebook${notebooks.length === 1 ? "" : "s"}` +
    ` · ${totalSections} section${totalSections === 1 ? "" : "s"}` +
    ` · ${totalPages} page${totalPages === 1 ? "" : "s"}`;

  for (const notebook of notebooks) {
    treeEl.appendChild(renderOneNoteNotebook(notebook));
  }
}

function renderOneNoteNotebook(notebook) {
  const nb = document.createElement("div");
  nb.className = "onenote-browse-notebook";
  nb.dataset.notebookId = notebook.notebookId || "";
  // First notebook collapsed by default? No — expand all so a small
  // demo notebook reads at a glance. User can collapse if dense.
  nb.dataset.expanded = "true";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "onenote-browse-notebook-header";

  const chevron = document.createElement("span");
  chevron.className = "onenote-browse-notebook-chevron";
  chevron.textContent = "▶";
  header.appendChild(chevron);

  const name = document.createElement("span");
  name.className = "onenote-browse-notebook-name";
  name.textContent = notebook.name || "Untitled notebook";
  header.appendChild(name);

  const sections = Array.isArray(notebook.sections) ? notebook.sections : [];
  const totalPages = sections.reduce(
    (sum, s) => sum + (Array.isArray(s.pages) ? s.pages.length : 0),
    0,
  );

  const count = document.createElement("span");
  count.className = "onenote-browse-notebook-count";
  count.textContent =
    `${sections.length} section${sections.length === 1 ? "" : "s"}` +
    ` · ${totalPages} page${totalPages === 1 ? "" : "s"}`;
  header.appendChild(count);

  header.addEventListener("click", () => {
    nb.dataset.expanded = nb.dataset.expanded === "true" ? "false" : "true";
  });
  nb.appendChild(header);

  const sectionsEl = document.createElement("div");
  sectionsEl.className = "onenote-browse-sections";
  for (const section of sections) {
    sectionsEl.appendChild(renderOneNoteSection(section));
  }
  nb.appendChild(sectionsEl);

  return nb;
}

function renderOneNoteSection(section) {
  const row = document.createElement("div");
  row.className = "onenote-browse-section";
  row.dataset.sectionId = section.sectionId || "";

  const nameEl = document.createElement("span");
  nameEl.className = "onenote-browse-section-name";
  nameEl.textContent = section.name || "Untitled section";
  row.appendChild(nameEl);

  const pageCount = Array.isArray(section.pages) ? section.pages.length : 0;
  const countEl = document.createElement("span");
  countEl.className = "onenote-browse-section-count";
  countEl.textContent = `${pageCount} page${pageCount === 1 ? "" : "s"}`;
  row.appendChild(countEl);

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "btn btn-secondary btn-compact onenote-browse-section-send";
  sendBtn.textContent =
    pageCount === 0 ? "No pages" : `Send all ${pageCount} page${pageCount === 1 ? "" : "s"}`;
  sendBtn.disabled = pageCount === 0;
  if (pageCount > 0) {
    sendBtn.addEventListener("click", () =>
      handleOneNoteSendSection(section, pageCount),
    );
  }
  row.appendChild(sendBtn);

  return row;
}

/**
 * Per-section "Send all N pages" handler. Confirms the LLM cost with the
 * user (brief §3.4 AC: "Confirm dialog shows estimated LLM cost"), then
 * dispatches onenote_send_section(sectionId). Progress UI + final report
 * are driven by the onenote-bulk-send-progress / onenote-bulk-send-complete
 * events wired in wireBackendEvents.
 */
async function handleOneNoteSendSection(section, pageCount) {
  // Guard against concurrent bulk-sends. The Rust single-flight mutex
  // would short-circuit with a structured failure report, but we may as
  // well not paper-over the UX.
  if (state.onenoteBulkSend.sectionId) {
    showToast({
      kind: "failure",
      title: "Another bulk send is already running",
      body: "Wait for it to finish or cancel it first.",
    });
    return;
  }

  const sectionName = section.name || "this section";
  const estCostUsd = (pageCount * ONENOTE_BULK_SEND_COST_PER_PAGE_USD).toFixed(2);
  const confirmMsg =
    `Send all ${pageCount} page${pageCount === 1 ? "" : "s"} in "${sectionName}"?\n\n` +
    `Estimated cost ~$${ONENOTE_BULK_SEND_COST_PER_PAGE_USD.toFixed(3)} per page ` +
    `(~$${estCostUsd} total).\n\n` +
    `Continue?`;
  if (!window.confirm(confirmMsg)) return;

  // Track the in-flight section so the progress handler can drive the UI
  // and the cancel button has the right context.
  state.onenoteBulkSend = {
    sectionId: section.sectionId,
    sectionName: sectionName,
  };
  showOneNoteBulkSendProgress(sectionName, pageCount);

  try {
    // Returns the same BulkSendReport that gets emitted on the
    // onenote-bulk-send-complete event; we rely on the event handler to
    // drive the UI (so the active-section dispatch path from the widget
    // menu — which doesn't await this IPC — gets the same handling). The
    // try here is just for the IPC-level error (config missing, etc.) —
    // per-page errors get aggregated in the BulkSendReport.
    await tauri.core.invoke("onenote_send_section", {
      sectionId: section.sectionId,
    });
    // Final UI cleanup happens in handleOneNoteBulkSendComplete.
  } catch (err) {
    // IPC-level error (e.g., config missing, hierarchy enum failed).
    // Clear the in-flight tracker + UI; surface via toast.
    state.onenoteBulkSend = { sectionId: null, sectionName: null };
    hideOneNoteBulkSendProgress();
    showToast({
      kind: "failure",
      title: `Couldn't send section: ${sectionName}`,
      body: String(err),
    });
  }
}

/**
 * Cancel button handler — invokes the Rust cancel flag. The bulk-send
 * loop checks the flag between pages; in-flight Publish + POST on the
 * current page completes (per brief §3.4 AC).
 */
async function handleOneNoteCancelBulkSend() {
  try {
    await tauri.core.invoke("onenote_cancel_bulk_send");
    // Update the progress text to reflect the pending cancel; the
    // final-report event will fire when the loop exits.
    const statusEl = document.getElementById("onenote-browse-progress-status");
    if (statusEl) statusEl.textContent = "Cancelling…";
    const cancelBtn = document.getElementById("btn-onenote-cancel-bulk");
    if (cancelBtn) cancelBtn.disabled = true;
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Cancel failed",
      body: String(err),
    });
  }
}

/**
 * Refresh button — drop the cache + re-fetch.
 */
async function handleOneNoteBrowseRefresh() {
  state.onenoteHierarchy = { tree: null, fetchedAt: 0 };
  await refreshOneNoteBrowse(/* force */ true);
}

/**
 * Show the progress UI band with initial 0/N state. Called when a
 * bulk-send starts (handleOneNoteSendSection); the per-page event
 * handler updates the bar + detail line.
 */
function showOneNoteBulkSendProgress(sectionName, total) {
  const progressEl = document.getElementById("onenote-browse-progress");
  const statusEl = document.getElementById("onenote-browse-progress-status");
  const fillEl = document.getElementById("onenote-browse-progress-fill");
  const detailEl = document.getElementById("onenote-browse-progress-detail");
  const cancelBtn = document.getElementById("btn-onenote-cancel-bulk");
  if (!progressEl) return;
  progressEl.hidden = false;
  if (statusEl) statusEl.textContent = `Sending pages from "${sectionName}"…`;
  if (fillEl) fillEl.style.width = "0%";
  if (detailEl) detailEl.textContent = `0 / ${total}`;
  if (cancelBtn) cancelBtn.disabled = false;
}

function hideOneNoteBulkSendProgress() {
  const progressEl = document.getElementById("onenote-browse-progress");
  if (progressEl) progressEl.hidden = true;
}

/**
 * Per-page progress event handler. Updates the progress bar + detail line.
 * No-op when the browse view isn't visible (user navigated away mid-batch).
 */
function handleOneNoteBulkSendProgress(payload) {
  const { sectionId, pageTitle, status, completed, total } = payload;
  // Only render when the event is for the section we're tracking. The
  // active-section dispatch (from the widget menu) may fire while a
  // different section's progress is on screen — extremely unlikely but
  // worth guarding.
  if (!state.onenoteBulkSend.sectionId) return;
  if (state.onenoteBulkSend.sectionId !== sectionId) return;

  const fillEl = document.getElementById("onenote-browse-progress-fill");
  const detailEl = document.getElementById("onenote-browse-progress-detail");
  if (total > 0 && fillEl) {
    const pct = Math.min(100, Math.round((completed / total) * 100));
    fillEl.style.width = `${pct}%`;
  }
  if (detailEl) {
    const label =
      status === "started"
        ? "Sending"
        : status === "succeeded"
          ? "Sent"
          : status === "failed"
            ? "Failed"
            : status === "cancelled"
              ? "Cancelled"
              : status;
    detailEl.textContent = `${completed} / ${total} · ${label}: ${pageTitle || ""}`;
  }
}

/**
 * Final-report event handler. Hides the progress UI, shows a toast
 * summarizing the run (success / partial-failure / cancelled).
 */
function handleOneNoteBulkSendComplete(payload) {
  const { sectionId, sectionName, total, succeeded, failed, cancelled, errors } = payload;
  // Only handle events for the section we're tracking (or — defensively
  // — any event when our tracker is unset, in case a menu-dispatched
  // active-section run lands while the view is open). Always clear the
  // tracker on any complete event we receive.
  const isOurs =
    !state.onenoteBulkSend.sectionId ||
    state.onenoteBulkSend.sectionId === sectionId;

  if (isOurs) {
    state.onenoteBulkSend = { sectionId: null, sectionName: null };
    hideOneNoteBulkSendProgress();
  }

  // Build a summary toast. Brief §3.4 AC: "Cancel button stops further
  // sends mid-batch (in-flight POST completes)." Idempotency: re-running
  // bulk-send on the same section produces identical documentIds → Apolla
  // treats as update; we render that as success here.
  const name = sectionName || "section";
  if (cancelled > 0 && succeeded === 0 && failed === 0) {
    showToast({
      kind: "idempotent",
      title: `Cancelled: ${name}`,
      body: `${cancelled} page${cancelled === 1 ? "" : "s"} not sent.`,
    });
  } else if (failed > 0 && succeeded === 0) {
    showToast({
      kind: "failure",
      title: `Bulk send failed: ${name}`,
      body: errorSummary(errors) || `${failed} of ${total} failed.`,
    });
  } else if (failed > 0 || cancelled > 0) {
    showToast({
      kind: "idempotent",
      title: `Partial: ${name}`,
      body:
        `${succeeded} succeeded` +
        (failed > 0 ? `, ${failed} failed` : "") +
        (cancelled > 0 ? `, ${cancelled} cancelled` : "") +
        ` out of ${total}.`,
    });
  } else {
    showToast({
      kind: "success",
      title: `Sent: ${name}`,
      body: `${succeeded} page${succeeded === 1 ? "" : "s"} ingested.`,
    });
  }
}

function errorSummary(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  // errors is Array<[pageId, message]> from the Rust Vec<(String,String)>.
  // Show the first error message; remainder hidden in the structured
  // toast body (could surface in a "Show details" follow-up in v2).
  const first = errors[0];
  const msg = Array.isArray(first) ? first[1] : String(first);
  return errors.length === 1
    ? msg
    : `${msg} (+${errors.length - 1} more)`;
}

// ───────── Capture flows ─────────

async function handleUploadFile() {
  try {
    const paths = await tauri.core.invoke("pick_files");
    if (!paths || paths.length === 0) return; // user cancelled

    // Emit a pre-flight toast for each chosen file
    for (const path of paths) {
      emitPreflightToast(path);
    }

    await tauri.core.invoke("ingest_files", { paths });
  } catch (err) {
    // Dismiss any pending pre-flight toasts before showing the error
    for (const [path, id] of pendingToasts.entries()) {
      dismissToast(id);
      pendingToasts.delete(path);
    }
    showToast({
      kind: "failure",
      title: "File upload failed",
      body: String(err),
    });
  }
}

async function handleCaptureScreen() {
  // Pre-flight toast — visible after region select while OCR + POST run
  emitPreflightToast("__screen_capture__", {
    title: "Capturing screen…",
    body: "Drag a region; OCR + ingest will follow.",
  });
  try {
    await tauri.core.invoke("run_screen_capture");
  } catch (err) {
    // Dismiss the pre-flight toast and show the failure
    if (pendingToasts.has("__screen_capture__")) {
      dismissToast(pendingToasts.get("__screen_capture__"));
      pendingToasts.delete("__screen_capture__");
    }
    showToast({
      kind: "failure",
      title: "Couldn't start screen capture",
      body: String(err),
    });
  }
}

/**
 * Emit a pre-flight "pending" toast. Registers its ID in pendingToasts keyed
 * by source_path so the response toast can dismiss it when ingestion completes.
 *
 * @param {string} key - source_path or "__screen_capture__"
 * @param {object} [override] - optional {title, body} override
 */
function emitPreflightToast(key, override) {
  const filename = key === "__screen_capture__" ? null : basename(key);
  const id = showToast({
    kind: "pending",
    title: override?.title ?? "Uploading " + filename,
    body: override?.body ?? "Sending to Apolla. Extraction usually takes 10-15s.",
    sticky: true,
  });
  pendingToasts.set(key, id);
}

function basename(path) {
  const parts = String(path).split("/");
  return parts[parts.length - 1] || path;
}

// ───────── Drag-drop visual overlay ─────────

function showDropOverlay() {
  document.getElementById("drop-overlay").removeAttribute("hidden");
}

function hideDropOverlay() {
  document.getElementById("drop-overlay").setAttribute("hidden", "");
}

// Track dragenter/dragleave to show/hide the overlay. Tauri's WindowEvent::DragDrop
// handles the actual paths server-side; these listeners just drive the visual hint.
function wireDragVisuals() {
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) showDropOverlay();
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDropOverlay();
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
    // The actual ingestion is triggered by the Rust-side WindowEvent::DragDrop
    // → "threshold://drop-paths" event listener wired in wireBackendEvents().
  });
}

// ───────── D-12-18 structured toast component ─────────

const TOAST_AUTO_DISMISS_MS = 5000;
let toastIdCounter = 0;

/**
 * Render a structured toast (D-12-18). Returns the toast's DOM id so callers
 * (e.g. pre-flight pending toasts) can dismiss it later.
 *
 * Payload shape:
 *   { kind, title, body?, cta?, sticky? }
 *
 * kind ∈ {"success", "idempotent", "failure", "pending"}
 * sticky=true → no auto-dismiss (must be dismissed by caller or close button)
 */
function showToast(payload) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return null;

  const kind = payload.kind || "success";
  const title = payload.title || "";
  const body = payload.body || "";
  const cta = payload.cta || null; // {label, action} — reserved for v2 marker tidbit
  const sticky = !!payload.sticky;

  const id = "toast-" + ++toastIdCounter;
  const toast = document.createElement("div");
  toast.className = "toast toast-" + kind;
  toast.id = id;

  const iconChar =
    kind === "success"
      ? "✓"
      : kind === "idempotent"
        ? "↺"
        : kind === "pending"
          ? "⟳"
          : "✗";

  toast.innerHTML = `
    <span class="toast-icon">${iconChar}</span>
    <div class="toast-text">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ""}
      ${
        cta
          ? `<button type="button" class="toast-cta" data-action="${escapeHtml(
              cta.action
            )}">${escapeHtml(cta.label)}</button>`
          : ""
      }
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss">✕</button>
  `;

  toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(id));
  if (cta) {
    toast.querySelector(".toast-cta").addEventListener("click", () => {
      console.log("toast CTA clicked:", cta);
      dismissToast(id);
    });
  }

  stack.appendChild(toast);

  if (!sticky) {
    setTimeout(() => dismissToast(id), TOAST_AUTO_DISMISS_MS);
  }

  return id;
}

function dismissToast(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("toast-leaving");
  setTimeout(() => el.remove(), 200);
}

// ───────── WP-PLAUD-07b — Settings → Connections (Connect Plaud) ─────────

/**
 * Render the Plaud connection card from the cached local status (which is
 * a UX hint only; the droplet's tokens.json is authoritative).
 */
async function enterConnectionsView() {
  state.inWizard = false;
  showView("view-connections");

  let cached = null;
  try {
    cached = await tauri.core.invoke("plaud_connect_status");
  } catch (err) {
    console.warn("[connections] plaud_connect_status failed:", err);
  }
  renderPlaudConnectionCard(cached, { busy: false });
}

function formatConnectedTimestamp(iso) {
  if (!iso) return "";
  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (_e) {
    return iso;
  }
}

function formatExpiresAt(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const remainingMin = Math.round((ms - Date.now()) / 60000);
  if (remainingMin <= 0) return "expired (server-side will refresh on next call)";
  if (remainingMin < 60) return `expires in ~${remainingMin} min (auto-refreshes server-side)`;
  const h = Math.floor(remainingMin / 60);
  const m = remainingMin % 60;
  return m > 0
    ? `expires in ~${h}h ${m}m (auto-refreshes server-side)`
    : `expires in ~${h}h (auto-refreshes server-side)`;
}

/**
 * Update the Plaud card chrome based on the connection status + the busy
 * flag (true while a Connect attempt is in-flight). When busy, Connect is
 * disabled and Cancel becomes visible; the progress line shows phase
 * updates emitted by the Rust orchestrator.
 */
function renderPlaudConnectionCard(status, { busy = false } = {}) {
  const statusEl = document.getElementById("plaud-status");
  const connectBtn = document.getElementById("btn-plaud-connect");
  const cancelBtn = document.getElementById("btn-plaud-cancel");
  const disconnectBtn = document.getElementById("btn-plaud-disconnect");
  const progressEl = document.getElementById("plaud-progress");
  const bannerEl = document.getElementById("plaud-disconnect-banner");
  if (!statusEl || !connectBtn || !cancelBtn || !disconnectBtn) return;

  // Banner is sticky once shown until the user reconnects.
  if (status) {
    bannerEl.hidden = true;
  }

  if (busy) {
    statusEl.textContent = "Status: Connecting…";
    statusEl.dataset.state = "connecting";
    connectBtn.disabled = true;
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    return;
  }

  // Not busy: either show "Connected" (with Reconnect + Disconnect) or
  // "Not connected" (Connect only).
  connectBtn.disabled = false;
  cancelBtn.hidden = true;
  progressEl.hidden = true;
  progressEl.textContent = "";

  if (status && status.connectedAt) {
    const when = formatConnectedTimestamp(status.connectedAt);
    const exp = formatExpiresAt(status.expiresAt);
    const parts = ["Status: Connected"];
    if (when) parts.push("·");
    if (when) parts.push(`last connected ${when}`);
    if (exp) parts.push(`· ${exp}`);
    statusEl.textContent = parts.join(" ");
    statusEl.dataset.state = "connected";
    connectBtn.textContent = "Reconnect";
    disconnectBtn.hidden = false;
  } else {
    statusEl.textContent = "Status: Not connected";
    statusEl.dataset.state = "disconnected";
    connectBtn.textContent = "Connect Plaud";
    disconnectBtn.hidden = true;
  }
}

async function handlePlaudConnectClick() {
  const progressEl = document.getElementById("plaud-progress");
  const statusEl = document.getElementById("plaud-status");
  if (progressEl) {
    progressEl.hidden = false;
    progressEl.textContent = "Starting…";
  }
  renderPlaudConnectionCard(null, { busy: true });

  try {
    const result = await tauri.core.invoke("plaud_connect_start");
    renderPlaudConnectionCard(result && result.status ? result.status : null, {
      busy: false,
    });
    showToast({
      kind: "success",
      title: "Plaud connected",
      body: "Recordings will appear in your Apolla inbox within ~30 min.",
    });
  } catch (err) {
    const msg = String(err);
    if (statusEl) {
      statusEl.textContent = `Status: ${msg}`;
      statusEl.dataset.state = "error";
    }
    if (progressEl) {
      progressEl.hidden = true;
    }
    // Re-fetch cached status so the buttons reflect whatever happened
    // (e.g., a prior Connect still on record).
    let cached = null;
    try {
      cached = await tauri.core.invoke("plaud_connect_status");
    } catch (_e) {
      cached = null;
    }
    // Don't overwrite the error line — render with busy=false but skip
    // the status-line update by restoring the error text after.
    renderPlaudConnectionCard(cached, { busy: false });
    if (statusEl) {
      statusEl.textContent = `Status: ${msg}`;
      statusEl.dataset.state = "error";
    }
    showToast({
      kind: "failure",
      title: "Connect Plaud failed",
      body: msg,
    });
  }
}

async function handlePlaudCancelClick() {
  try {
    await tauri.core.invoke("plaud_connect_cancel");
  } catch (err) {
    console.warn("[connections] plaud_connect_cancel failed:", err);
  }
}

async function handlePlaudDisconnectClick() {
  const confirmed = window.confirm(
    "Disconnect Plaud locally?\n\n" +
      "This clears Threshold's cached connection status. " +
      "Plaud tokens remain on the droplet — SSH in and delete " +
      "/home/deploy/.plaud/tokens.json to fully revoke."
  );
  if (!confirmed) return;
  try {
    await tauri.core.invoke("plaud_disconnect_soft_clear");
    renderPlaudConnectionCard(null, { busy: false });
    const bannerEl = document.getElementById("plaud-disconnect-banner");
    if (bannerEl) bannerEl.hidden = false;
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Disconnect failed",
      body: String(err),
    });
  }
}

/**
 * Wire the `plaud-connect://status` event listener once, at bootstrap.
 * Updates the progress line for every phase the Rust orchestrator emits.
 */
async function wirePlaudConnectStatusListener() {
  if (!tauri || !tauri.event) return;
  await tauri.event.listen("plaud-connect://status", (event) => {
    const payload = event.payload || {};
    const progressEl = document.getElementById("plaud-progress");
    if (!progressEl) return;
    progressEl.hidden = false;
    progressEl.textContent = payload.message || payload.phase || "Working…";
  });
}

// ───────── WP-AUTO-IMPORT — Auto-import pane ─────────

// Inline SVGs (stroke = currentColor; inherit the icon-chip color) so the
// pane matches the widget's line-icon aesthetic rather than emoji.
const AI_ICON_SYNC = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 4 21 9 16 9"></polyline></svg>`;
const AI_ICON_MIC = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><line x1="12" y1="18" x2="12" y2="21"></line><line x1="8" y1="21" x2="16" y2="21"></line></svg>`;
const AI_ICON_NOTEBOOK = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"></path><line x1="9" y1="4" x2="9" y2="20"></line><line x1="13" y1="9" x2="16" y2="9"></line></svg>`;
const AI_ICON_PLUS = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

function normalizeAutoImportConfig(cfg) {
  return {
    enabled: !!(cfg && cfg.enabled),
    onenoteNotebooks: (cfg && cfg.onenoteNotebooks) || [],
    plaudDevices: (cfg && cfg.plaudDevices) || [],
  };
}

async function enterAutoImportView() {
  state.inWizard = false;
  showView("view-auto-import");
  state.autoImport.mode = "list";

  // Persisted config first (fast), render, then enrich with the available
  // sources (slower — may hit OneNote COM + the Plaud inbox).
  try {
    const cfg = await tauri.core.invoke("get_auto_import_config");
    state.autoImport.config = normalizeAutoImportConfig(cfg);
  } catch (err) {
    console.warn("[auto-import] get_auto_import_config failed:", err);
    state.autoImport.config = { enabled: false, onenoteNotebooks: [], plaudDevices: [] };
  }
  renderAutoImport();
  refreshAutoImportAvailable();
}

async function refreshAutoImportAvailable() {
  try {
    state.autoImport.available = await tauri.core.invoke("auto_import_available_sources");
  } catch (err) {
    console.warn("[auto-import] auto_import_available_sources failed:", err);
    state.autoImport.available = null;
  }
  // Re-render so the Windows-only treatment / picker contents reflect the
  // fresh data — but only if the user is still on this pane.
  const view = document.getElementById("view-auto-import");
  if (view && !view.hidden) renderAutoImport();
}

async function persistAutoImport() {
  if (state.autoImport.busy) return;
  state.autoImport.busy = true;
  try {
    const stored = await tauri.core.invoke("set_auto_import_config", {
      config: state.autoImport.config,
    });
    if (stored) state.autoImport.config = normalizeAutoImportConfig(stored);
  } catch (err) {
    console.warn("[auto-import] set_auto_import_config failed:", err);
    showToast({
      kind: "failure",
      title: "Couldn't save auto-import settings",
      body: String(err),
    });
  } finally {
    state.autoImport.busy = false;
  }
}

function renderAutoImport() {
  const body = document.getElementById("auto-import-body");
  if (!body) return;
  body.innerHTML = "";

  if (state.autoImport.mode === "picker") {
    renderAutoImportPicker(body);
    return;
  }

  const cfg = state.autoImport.config;
  const avail = state.autoImport.available;
  const onenoteSupported = avail ? !!avail.onenoteSupported : true;

  const enabledCount =
    (cfg.onenoteNotebooks || []).filter((s) => s.enabled).length +
    (cfg.plaudDevices || []).filter((s) => s.enabled).length;

  // Master toggle row.
  const master = buildAutoImportRow({
    kind: "master",
    iconSvg: AI_ICON_SYNC,
    name: "Auto-import",
    meta: cfg.enabled
      ? enabledCount === 1
        ? "On · 1 source"
        : `On · ${enabledCount} sources`
      : "Off — nothing imports automatically",
    checked: !!cfg.enabled,
  });
  master
    .querySelector(".auto-import-toggle")
    .addEventListener("click", handleAutoImportMasterToggle);
  body.appendChild(master);

  const sources = [
    ...(cfg.plaudDevices || []).map((s) => ({
      kind: "plaud",
      id: s.serialNumber,
      name: s.name,
      enabled: s.enabled,
      meta: "Recorder",
    })),
    ...(cfg.onenoteNotebooks || []).map((s) => ({
      kind: "onenote",
      id: s.notebookId,
      name: s.name,
      enabled: s.enabled,
      meta: onenoteSupported ? "Notebook" : "Notebook · Windows-only, paused on this Mac",
    })),
  ];

  if (sources.length === 0) {
    const empty = document.createElement("p");
    empty.className = "auto-import-empty";
    empty.textContent =
      "No sources yet. Add a OneNote notebook or Plaud device and Threshold will pull in anything new automatically.";
    body.appendChild(empty);
  } else {
    for (const s of sources) {
      const disabled = s.kind === "onenote" && !onenoteSupported;
      const row = buildAutoImportRow({
        kind: s.kind,
        iconSvg: s.kind === "plaud" ? AI_ICON_MIC : AI_ICON_NOTEBOOK,
        name: s.name,
        meta: s.meta,
        checked: !!s.enabled && !disabled,
        disabled,
        removable: true,
      });
      const toggle = row.querySelector(".auto-import-toggle");
      if (!disabled) {
        toggle.addEventListener("click", () => handleAutoImportToggleSource(s.kind, s.id));
      }
      row
        .querySelector(".auto-import-remove")
        .addEventListener("click", () => handleAutoImportRemoveSource(s.kind, s.id));
      body.appendChild(row);
    }
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "auto-import-add";
  addBtn.innerHTML = `${AI_ICON_PLUS}<span>Add a source</span>`;
  addBtn.addEventListener("click", handleAutoImportAddClick);
  body.appendChild(addBtn);
}

function buildAutoImportRow({
  kind,
  iconSvg,
  name,
  meta,
  checked,
  disabled = false,
  removable = false,
}) {
  const row = document.createElement("div");
  row.className = "auto-import-source";
  row.dataset.kind = kind;
  if (disabled) row.dataset.disabled = "true";

  const icon = document.createElement("div");
  icon.className = "auto-import-source-icon";
  icon.innerHTML = iconSvg;

  const bodyEl = document.createElement("div");
  bodyEl.className = "auto-import-source-body";
  const nameEl = document.createElement("div");
  nameEl.className = "auto-import-source-name";
  nameEl.textContent = name;
  const metaEl = document.createElement("div");
  metaEl.className = "auto-import-source-meta";
  metaEl.textContent = meta;
  bodyEl.appendChild(nameEl);
  bodyEl.appendChild(metaEl);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "auto-import-toggle";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", checked ? "true" : "false");
  toggle.setAttribute("aria-label", `Toggle ${name}`);
  if (disabled) toggle.disabled = true;

  row.appendChild(icon);
  row.appendChild(bodyEl);

  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-inline-link auto-import-remove";
    remove.textContent = "Remove";
    row.appendChild(remove);
  }
  row.appendChild(toggle);
  return row;
}

async function handleAutoImportMasterToggle() {
  state.autoImport.config.enabled = !state.autoImport.config.enabled;
  await persistAutoImport();
  renderAutoImport();
}

async function handleAutoImportToggleSource(kind, id) {
  const cfg = state.autoImport.config;
  const list = kind === "plaud" ? cfg.plaudDevices : cfg.onenoteNotebooks;
  const idField = kind === "plaud" ? "serialNumber" : "notebookId";
  const src = (list || []).find((s) => s[idField] === id);
  if (!src) return;
  src.enabled = !src.enabled;
  await persistAutoImport();
  renderAutoImport();
}

async function handleAutoImportRemoveSource(kind, id) {
  const cfg = state.autoImport.config;
  if (kind === "plaud") {
    cfg.plaudDevices = (cfg.plaudDevices || []).filter((s) => s.serialNumber !== id);
  } else {
    cfg.onenoteNotebooks = (cfg.onenoteNotebooks || []).filter((s) => s.notebookId !== id);
  }
  await persistAutoImport();
  renderAutoImport();
}

async function handleAutoImportAddClick() {
  state.autoImport.mode = "picker";
  renderAutoImport();
  if (!state.autoImport.available) {
    await refreshAutoImportAvailable();
    if (state.autoImport.mode === "picker") renderAutoImport();
  }
}

function renderAutoImportPicker(body) {
  const avail = state.autoImport.available;
  const cfg = state.autoImport.config;

  const intro = document.createElement("p");
  intro.className = "auto-import-subtitle";
  intro.textContent = "Choose a source to import from automatically.";
  body.appendChild(intro);

  if (!avail) {
    const loading = document.createElement("p");
    loading.className = "auto-import-empty";
    loading.textContent = "Looking for available sources…";
    body.appendChild(loading);
    appendAutoImportPickerDone(body);
    return;
  }

  const havePlaud = new Set((cfg.plaudDevices || []).map((s) => s.serialNumber));
  const haveOnenote = new Set((cfg.onenoteNotebooks || []).map((s) => s.notebookId));

  // Plaud group.
  const plaudLabel = document.createElement("p");
  plaudLabel.className = "auto-import-section-label";
  plaudLabel.textContent = "Plaud devices";
  body.appendChild(plaudLabel);

  if (!avail.plaudConnected) {
    body.appendChild(
      autoImportPickerHint("Connect Plaud first in Connections to designate a device.")
    );
  } else {
    const plaudOptions = (avail.plaud || []).filter((o) => !havePlaud.has(o.id));
    if (plaudOptions.length === 0) {
      body.appendChild(
        autoImportPickerHint(
          "No new Plaud devices — they appear here once they've synced a recording."
        )
      );
    } else {
      const wrap = document.createElement("div");
      wrap.className = "auto-import-picker";
      for (const o of plaudOptions) wrap.appendChild(buildAutoImportPickerRow("plaud", o, "Recorder"));
      body.appendChild(wrap);
    }
  }

  // OneNote group.
  const onLabel = document.createElement("p");
  onLabel.className = "auto-import-section-label";
  onLabel.textContent = "OneNote notebooks";
  body.appendChild(onLabel);

  if (!avail.onenoteSupported) {
    body.appendChild(
      autoImportPickerHint(
        "OneNote auto-import is Windows-only — notebooks can't be listed on this Mac."
      )
    );
  } else {
    const onOptions = (avail.onenote || []).filter((o) => !haveOnenote.has(o.id));
    if (onOptions.length === 0) {
      body.appendChild(
        autoImportPickerHint(
          "No notebooks to add. Open OneNote (and Refresh) — already-designated ones are hidden."
        )
      );
    } else {
      const wrap = document.createElement("div");
      wrap.className = "auto-import-picker";
      for (const o of onOptions) wrap.appendChild(buildAutoImportPickerRow("onenote", o, "Notebook"));
      body.appendChild(wrap);
    }
  }

  appendAutoImportPickerDone(body);
}

function autoImportPickerHint(text) {
  const p = document.createElement("p");
  p.className = "auto-import-empty";
  p.textContent = text;
  return p;
}

function buildAutoImportPickerRow(kind, option, metaLabel) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "auto-import-picker-row";
  const name = document.createElement("span");
  name.className = "auto-import-picker-name";
  name.textContent = option.name;
  const meta = document.createElement("span");
  meta.className = "auto-import-picker-meta";
  meta.textContent = metaLabel;
  btn.appendChild(name);
  btn.appendChild(meta);
  btn.addEventListener("click", () => handleAutoImportPick(kind, option));
  return btn;
}

function appendAutoImportPickerDone(body) {
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn btn-secondary";
  done.textContent = "← Done";
  done.style.marginTop = "8px";
  done.style.alignSelf = "flex-start";
  done.addEventListener("click", () => {
    state.autoImport.mode = "list";
    renderAutoImport();
  });
  body.appendChild(done);
}

async function handleAutoImportPick(kind, option) {
  const cfg = state.autoImport.config;
  if (kind === "plaud") {
    cfg.plaudDevices = cfg.plaudDevices || [];
    if (!cfg.plaudDevices.some((s) => s.serialNumber === option.id)) {
      cfg.plaudDevices.push({ serialNumber: option.id, name: option.name, enabled: true });
    }
  } else {
    cfg.onenoteNotebooks = cfg.onenoteNotebooks || [];
    if (!cfg.onenoteNotebooks.some((s) => s.notebookId === option.id)) {
      cfg.onenoteNotebooks.push({ notebookId: option.id, name: option.name, enabled: true });
    }
  }
  // Adding a source implies the user wants auto-import on.
  if (!cfg.enabled) cfg.enabled = true;
  await persistAutoImport();
  showToast({
    kind: "success",
    title: "Source added",
    body: `${option.name} will auto-import new items.`,
  });
  state.autoImport.mode = "list";
  renderAutoImport();
}

// ───────── Event wiring ─────────

window.addEventListener("DOMContentLoaded", () => {
  // Wizard
  document.getElementById("btn-wizard-start").addEventListener("click", enterWizardConfigure);
  document
    .querySelectorAll(".wizard-prompt")
    .forEach((btn) => btn.addEventListener("click", finishWizard));
  document.getElementById("btn-wizard-finish").addEventListener("click", finishWizard);

  // Configure
  document
    .getElementById("btn-test-connection")
    .addEventListener("click", handleTestConnection);
  document.getElementById("configure-form").addEventListener("submit", handleSave);
  document.getElementById("btn-open-configure").addEventListener("click", enterStandaloneConfigure);
  document
    .getElementById("btn-back-to-main")
    .addEventListener("click", () => enterMainView(state.lastConfig));

  // WP-ONENOTE-EXPORT-05 — auto-watch toggle drives the Rust polling
  // loop immediately on change (don't wait for Save). Defensive optional
  // chaining for older index.html builds that lack the element.
  const autoWatchEl = document.getElementById("config-onenote-auto-watch");
  if (autoWatchEl) {
    autoWatchEl.addEventListener("change", handleAutoWatchToggle);
  }

  // Capture flows
  document.getElementById("btn-upload-file").addEventListener("click", handleUploadFile);
  document.getElementById("btn-capture-screen").addEventListener("click", handleCaptureScreen);

  // WP-PLAUD-04a — Plaud Sync Queue buttons. Use optional chaining since
  // older index.html builds (pre-PLAUD-04a) won't have these elements; this
  // keeps the rest of bootstrap functional even if the queue section is
  // somehow missing (defensive — same posture as the tidbit button block).
  const plaudSyncBtn = document.getElementById("btn-plaud-sync-now");
  if (plaudSyncBtn) {
    plaudSyncBtn.addEventListener("click", handlePlaudSyncNow);
  }
  const plaudBackBtn = document.getElementById("btn-plaud-back");
  if (plaudBackBtn) {
    plaudBackBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("widget_collapse");
      } catch (err) {
        console.warn("[main] widget_collapse (plaud-back) failed:", err);
      }
    });
  }

  // WP-ONENOTE-EXPORT-04 — OneNote Browse view buttons. Defensive optional
  // chaining (same posture as the Plaud block) so older index.html builds
  // that lack these elements don't break bootstrap.
  const onenoteRefreshBtn = document.getElementById("btn-onenote-browse-refresh");
  if (onenoteRefreshBtn) {
    onenoteRefreshBtn.addEventListener("click", handleOneNoteBrowseRefresh);
  }
  const onenoteCancelBtn = document.getElementById("btn-onenote-cancel-bulk");
  if (onenoteCancelBtn) {
    onenoteCancelBtn.addEventListener("click", handleOneNoteCancelBulkSend);
  }
  const onenoteBackBtn = document.getElementById("btn-onenote-browse-back");
  if (onenoteBackBtn) {
    onenoteBackBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("widget_collapse");
      } catch (err) {
        console.warn("[main] widget_collapse (onenote-back) failed:", err);
      }
    });
  }

  // WP-PLAUD-07b — Settings → Connections buttons + status event
  // subscription. Defensive optional chaining mirrors the Plaud-queue /
  // OneNote-browse blocks above.
  const plaudConnectBtn = document.getElementById("btn-plaud-connect");
  if (plaudConnectBtn) {
    plaudConnectBtn.addEventListener("click", handlePlaudConnectClick);
  }
  const plaudConnectCancelBtn = document.getElementById("btn-plaud-cancel");
  if (plaudConnectCancelBtn) {
    plaudConnectCancelBtn.addEventListener("click", handlePlaudCancelClick);
  }
  const plaudDisconnectBtn = document.getElementById("btn-plaud-disconnect");
  if (plaudDisconnectBtn) {
    plaudDisconnectBtn.addEventListener("click", handlePlaudDisconnectClick);
  }
  const connectionsBackBtn = document.getElementById("btn-connections-back");
  if (connectionsBackBtn) {
    connectionsBackBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("widget_collapse");
      } catch (err) {
        console.warn("[main] widget_collapse (connections-back) failed:", err);
      }
    });
  }

  // WP-AUTO-IMPORT — Auto-import pane back button (same widget_collapse path
  // as the other list views). Defensive optional chaining for older builds.
  const autoImportBackBtn = document.getElementById("btn-auto-import-back");
  if (autoImportBackBtn) {
    autoImportBackBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("widget_collapse");
      } catch (err) {
        console.warn("[main] widget_collapse (auto-import-back) failed:", err);
      }
    });
  }
  // Phase-progress events fire from the Rust orchestrator; listener is
  // process-wide (no view-bound teardown needed — the progress element is
  // hidden by enterConnectionsView when status updates land while the
  // user is on a different view).
  wirePlaudConnectStatusListener().catch((err) => {
    console.warn("[main] wirePlaudConnectStatusListener failed:", err);
  });

  // Drag-drop visuals (the actual ingestion is wired in wireBackendEvents)
  wireDragVisuals();

  bootstrap();
});
