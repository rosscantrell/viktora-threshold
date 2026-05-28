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
};

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

    // WP-Threshold-Tidbit-Return Phase B — `widget_expand("tidbit")`
    // navigates here with #tidbit in the URL hash. Bootstrap detects it,
    // fetches the cached tidbit from AppState via IPC, and renders the
    // tidbit panel view. Falls through to the main view if no tidbit is
    // available (covers: user opened #tidbit manually with no pending,
    // pending was cleared by a previous view, IPC failure).
    if (window.location.hash === "#tidbit") {
      try {
        const tidbit = await tauri.core.invoke("get_pending_tidbit");
        enterTidbitView(tidbit);
        return;
      } catch (err) {
        console.warn("[main] get_pending_tidbit failed:", err);
        // Fall through to main view; better than a blank screen
      }
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
  const config = {
    base_url: baseUrl,
    bearer_token: bearerToken,
    last_used: null,
    mode: "workspace",
    onenote_hotkey: onenoteHotkey || null,
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

// ───────── Tidbit panel view (WP-Threshold-Tidbit-Return Phase B) ─────────

/**
 * Render the tidbit panel view.
 *
 * Q4 empirical range: whyThisMatters runs 100-800 chars in the Apolla pilot
 * corpus. The body container caps its height via CSS (max-height + overflow-y
 * auto) so any prose length scrolls cleanly without overflowing the panel.
 *
 * Highlight chips: 1-3 per tidbit (Phase A ships 1 per FN-TIDB-15; future
 * work increases). Each chip shows the slug; corpus-overlap chips get a
 * "seen Nx" badge when priorCaptureCount is present.
 *
 * Failure-safe: when called with null/undefined (no pending tidbit), shows
 * an empty-state message instead of a blank panel.
 *
 * @param {object|null} tidbit
 */
function enterTidbitView(tidbit) {
  state.inWizard = false;
  showView("view-tidbit");

  const titleEl = document.getElementById("tidbit-title");
  const bodyEl = document.getElementById("tidbit-body");
  const metaEl = document.getElementById("tidbit-meta");
  const highlightsEl = document.getElementById("tidbit-highlights");
  const deeplinkEl = document.getElementById("btn-tidbit-deeplink");
  const emptyEl = document.getElementById("tidbit-empty");

  if (!tidbit || typeof tidbit !== "object") {
    if (emptyEl) emptyEl.hidden = false;
    if (titleEl) titleEl.textContent = "";
    if (bodyEl) bodyEl.textContent = "";
    if (metaEl) metaEl.hidden = true;
    if (highlightsEl) highlightsEl.innerHTML = "";
    if (deeplinkEl) deeplinkEl.style.visibility = "hidden";
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (deeplinkEl) deeplinkEl.style.visibility = "";

  // textContent assignment is intentional — avoids any innerHTML injection
  // path even though tidbit content comes from our own server.
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

  if (deeplinkEl && tidbit.deepLink) {
    deeplinkEl.href = tidbit.deepLink;
  }
}

// Back-to-widget button — collapses the expanded UI back to the floating
// pill. Also clears the pending tidbit so a stale wow-loop doesn't re-fire
// the next time the user expands for an unrelated reason (e.g. Settings).
const tidbitBackBtn = document.getElementById("btn-tidbit-back");
if (tidbitBackBtn) {
  tidbitBackBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("clear_pending_tidbit");
    } catch (err) {
      console.warn("[main] clear_pending_tidbit failed:", err);
    }
    try {
      await tauri.core.invoke("widget_collapse");
    } catch (err) {
      console.warn("[main] widget_collapse failed:", err);
    }
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

  // Drag-drop visuals (the actual ingestion is wired in wireBackendEvents)
  wireDragVisuals();

  bootstrap();
});
