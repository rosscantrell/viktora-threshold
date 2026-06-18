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
  // WP-THRESHOLD-APP-AUTH — check-your-inbox state for email magic-link login
  "view-check-inbox",
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
  // WP-THRESHOLD-DECISION-ORG — Decisions browser (by project, filterable)
  "view-decisions",
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

// ───────── WP-THRESHOLD-NAV — persistent navigation shell ─────────
//
// One bar (#app-nav, in index.html, OUTSIDE the view sections) carries back +
// breadcrumb + primary destinations across every review view, so wayfinding is
// always at the TOP (feedback: back buttons were buried in footers and users
// couldn't get back). Each enter* function calls setNav(); hideNav() blanks it
// on the loading + wizard screens. Back is breadcrumb-driven: an explicit
// `back` fn wins, else it re-enters the second-to-last crumb.

// Destination → enter* fn. Declarations below are hoisted, so this map is safe
// to build at module-eval time (main.js is deferred → DOM + decls both ready).
const NAV_DEST_FNS = {
  main: () => goHome(),
  today: () => enterLogView(),
  log: () => enterDecisionsView(undefined, { from: "home" }),
  edges: () => enterEdgesView(),
  settings: () => enterStandaloneConfigure(),
};

let _navBackFn = null;

function hideNav() {
  const nav = document.getElementById("app-nav");
  if (nav) nav.setAttribute("hidden", "");
}

/**
 * Populate + show the nav bar.
 * @param {Array<{label:string, go?:Function}>} crumbs — last entry is the
 *        current page (its `go` is ignored).
 * @param {{active?:'main'|'today'|'log'|'edges', back?:Function|null}} opts
 */
function setNav(crumbs, opts = {}) {
  const nav = document.getElementById("app-nav");
  if (!nav) return;
  nav.removeAttribute("hidden");

  // Breadcrumb trail — rebuilt each call (fresh listeners, no leak).
  const ol = document.getElementById("app-nav-crumbs");
  ol.textContent = "";
  crumbs.forEach((c, i) => {
    const li = document.createElement("li");
    const isLast = i === crumbs.length - 1;
    if (!isLast && typeof c.go === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "app-nav-crumb-link";
      btn.textContent = c.label;
      btn.addEventListener("click", c.go);
      li.appendChild(btn);
    } else {
      const span = document.createElement("span");
      span.className = isLast ? "app-nav-crumb-current" : "app-nav-crumb-link";
      span.textContent = c.label;
      li.appendChild(span);
    }
    ol.appendChild(li);
  });

  // Back button — explicit `back` wins; else second-to-last crumb; else hide.
  let backFn = null;
  if (opts.back === null) backFn = null;
  else if (typeof opts.back === "function") backFn = opts.back;
  else if (crumbs.length > 1 && typeof crumbs[crumbs.length - 2].go === "function") {
    backFn = crumbs[crumbs.length - 2].go;
  }
  _navBackFn = backFn;
  const backBtn = document.getElementById("app-nav-back");
  if (backBtn) {
    if (backFn) backBtn.removeAttribute("hidden");
    else backBtn.setAttribute("hidden", "");
  }

  // Active destination highlight.
  for (const b of nav.querySelectorAll(".app-nav-dest")) {
    if (opts.active && b.dataset.dest === opts.active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}

// Wire the nav bar once (back button + destination buttons).
{
  const backBtn = document.getElementById("app-nav-back");
  if (backBtn) backBtn.addEventListener("click", () => { if (_navBackFn) _navBackFn(); });
  for (const b of document.querySelectorAll(".app-nav-dest")) {
    const fn = NAV_DEST_FNS[b.dataset.dest];
    if (fn) b.addEventListener("click", fn);
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

    // WP-THRESHOLD-APP-AUTH — a config with a workspace URL but no bearer is a
    // half-finished sign-in (e.g. auth_request_link persisted base_url, then
    // the app was restarted before the magic link was clicked). Send the user
    // back to the email-entry screen rather than into a main view that would
    // 401 on every request. enterWizardWelcome() prefills the known base URL.
    if (!cfg.bearer_token || !cfg.bearer_token.trim()) {
      enterWizardWelcome(cfg);
      return;
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

    // WP-THRESHOLD-DECISION-ORG — the Decisions browser (#decisions).
    if (window.location.hash === "#decisions") {
      enterDecisionsView(undefined, { from: "home" });
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

  // WP-THRESHOLD-APP-AUTH (email-login) — magic-link callback. The user clicks
  // the `apolla-threshold://auth?token=...` link in their email; the Rust shell
  // parses it + emits this event with { token }. handleAuthCallback redeems the
  // token for a per-user bearer and signs the app in (no token pasted).
  await tauri.event.listen("threshold://auth-callback", async (event) => {
    const token = (event.payload || {}).token;
    await handleAuthCallback(token);
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

function enterWizardWelcome(cfg) {
  state.inWizard = true;
  // WP-THRESHOLD-APP-AUTH — prefill the workspace URL when we already know it
  // (returning to the email screen after a half-finished sign-in, or after the
  // user clicks "use a different workspace"). Don't clobber a value the user is
  // mid-typing if the field already has one.
  const baseEl = document.getElementById("login-base-url");
  if (baseEl && !baseEl.value && cfg && cfg.base_url) {
    baseEl.value = cfg.base_url;
  }
  showView("view-welcome");
  hideNav();
  const emailEl = document.getElementById("login-email");
  if (emailEl) emailEl.focus();
}

// ───────── WP-THRESHOLD-APP-AUTH — email magic-link sign-in ─────────

function showLoginResult(elId, ok, message) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.removeAttribute("hidden");
  el.className = "result " + (ok ? "ok" : "fail");
  el.innerHTML = "<strong>" + (ok ? "✓ " : "✗ ") + escapeHtml(message) + "</strong>";
}

function hideLoginResult(elId) {
  const el = document.getElementById(elId);
  if (el) el.setAttribute("hidden", "");
}

/**
 * Show the "check your inbox" state for the given email. The deep-link
 * callback (threshold://auth-callback) completes sign-in; this view just
 * keeps the window open and offers Resend / change-email.
 */
function enterCheckInbox(email) {
  state.inWizard = true;
  const emailEl = document.getElementById("check-inbox-email");
  if (emailEl) emailEl.textContent = email;
  hideLoginResult("check-inbox-result");
  showView("view-check-inbox");
  hideNav();
}

/**
 * First-run sign-in step 1: ask the server to email a magic-link deep link.
 * Persists the workspace URL (Rust side) so the deep-link callback can verify
 * against the right server. Always advances to the check-inbox state on a 2xx
 * (the server returns ok regardless of whether the email is invited — an
 * enumeration guard), so we never reveal whether an address is on the list.
 */
async function handleLoginRequest(e) {
  if (e) e.preventDefault();
  const baseUrl = document.getElementById("login-base-url").value.trim();
  const email = document.getElementById("login-email").value.trim();
  if (!baseUrl) {
    showLoginResult("login-result", false, "Enter your workspace URL first.");
    return;
  }
  if (!email || !email.includes("@")) {
    showLoginResult("login-result", false, "Enter a valid email address.");
    return;
  }
  const btn = document.getElementById("btn-login-request");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }
  try {
    await tauri.core.invoke("auth_request_link", { baseUrl, email });
    state.loginEmail = email;
    state.loginBaseUrl = baseUrl;
    enterCheckInbox(email);
  } catch (err) {
    showLoginResult("login-result", false, String(err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Email me a sign-in link";
    }
  }
}

/** Resend the magic link from the check-inbox state. */
async function handleLoginResend() {
  const baseUrl = state.loginBaseUrl;
  const email = state.loginEmail;
  if (!baseUrl || !email) {
    handleLoginChangeEmail();
    return;
  }
  const btn = document.getElementById("btn-login-resend");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Resending…";
  }
  try {
    await tauri.core.invoke("auth_request_link", { baseUrl, email });
    showLoginResult("check-inbox-result", true, "Sent again. Check your inbox.");
  } catch (err) {
    showLoginResult("check-inbox-result", false, String(err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Resend link";
    }
  }
}

/** Return to the email-entry screen to change email/workspace. */
function handleLoginChangeEmail() {
  hideLoginResult("login-result");
  enterWizardWelcome();
}

/**
 * Fired by the threshold://auth-callback event when the user clicks the magic
 * link. Redeems the single-use token for this user's per-user bearer (Rust
 * auth_verify persists it to config.json) and drops straight into the app.
 * Works from any view — if verify fails, surfaces the reason (in the
 * check-inbox result when visible, plus a toast).
 */
async function handleAuthCallback(token) {
  if (!token) {
    console.warn("[auth-callback] missing token in payload");
    return;
  }
  try {
    const cfg = await tauri.core.invoke("auth_verify", { token });
    // Reset the cached viewer identity so the Mine filter + "captured by you"
    // attribution re-resolve against the new per-user token.
    _viewerEmail = undefined;
    state.inWizard = false;
    state.lastConfig = cfg;
    // Hydrate the Configure fields so a later visit shows the live values.
    const baseEl = document.getElementById("config-base-url");
    const tokenEl = document.getElementById("config-bearer-token");
    if (baseEl) baseEl.value = cfg.base_url || "";
    if (tokenEl) tokenEl.value = cfg.bearer_token || "";
    showToast({
      kind: "success",
      title: "You're signed in",
      body: "Threshold is connected to " + (cfg.base_url || "your workspace") + ".",
    });
    enterMainView(cfg);
  } catch (err) {
    showLoginResult("check-inbox-result", false, String(err));
    showToast({ kind: "failure", title: "Sign-in failed", body: String(err) });
  }
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
  hideNav();
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
  hideNav();
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
  setNav([{ label: "Settings" }], { back: () => goHome() });
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
  setNav([{ label: "Home" }], { active: "main", back: null });

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
// ───────── WP-THRESHOLD-DISMISS (first cut) — client-only suppression ─────────
//
// "Just suppress for now": the user can dismiss a decision/commitment from any
// record view. The recordId is persisted (config.json, via the dismiss_record
// IPC) and filtered out of every projection on render. Reversible inline via the
// Undo toast. No engine round-trip yet — the "not relevant vs. close-out" reason
// split + calibration feedback land in the later server-side pass.

/** RecordIds the user has dismissed. Mirrors the persisted config list; kept in
 *  sync locally so a dismiss/undo reflects without a round-trip. */
const _dismissedIds = new Set();

/** Pull the recordId from a {record, lifecycle, state} envelope OR a bare record. */
function recordIdOf(item) {
  const rec = item && item.record ? item.record : item;
  return (rec && rec.recordId) || "";
}

/** Is this item currently dismissed? */
function isDismissed(item) {
  const id = recordIdOf(item);
  return !!id && _dismissedIds.has(id);
}

/** Drop dismissed items from an array (tolerates envelopes and bare records). */
function withoutDismissed(items) {
  return (Array.isArray(items) ? items : []).filter((it) => !isDismissed(it));
}

/** Reload the persisted dismissed-id set from the backend. Best-effort: a failed
 *  read leaves the existing in-memory set intact (never throws into a view). */
async function refreshDismissedIds() {
  try {
    const ids = await tauri.core.invoke("get_dismissed_record_ids");
    _dismissedIds.clear();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (id) _dismissedIds.add(id);
    }
  } catch (err) {
    console.warn("[main] get_dismissed_record_ids failed:", err);
  }
}

// WP-THRESHOLD-RECORD-HITL — the closed set of dismiss reasons the SERVER
// accepts on PATCH /api/decision-log/records/:id when state === "dismissed".
// These four slugs are contract-fixed server-side; corrections (e.g. wrong-owner)
// are NOT valid dismiss reasons and are deliberately absent. Labels are plain
// text — no emoji — to match the glassy widget aesthetic.
const DISMISS_REASONS = [
  { slug: "not-relevant", label: "Not relevant" },
  { slug: "not-salient", label: "Not salient" },
  { slug: "already-known", label: "Already knew this" },
  { slug: "closing-out", label: "Closing out" },
];

/** Append a subtle "Dismiss" (✕) control to an actions row. Clicking opens a
 *  small inline reason menu (the closed 4-reason set the server accepts); picking
 *  a reason suppresses the record optimistically AND records the disposition
 *  server-side, then offers Undo. `summary` is used for the toast. */
function appendDismissControl(actionsEl, recordId, cardEl, summary) {
  if (!recordId) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "record-dismiss-btn";
  btn.title = "Dismiss — hide this from your views";
  btn.setAttribute("aria-label", "Dismiss");
  btn.textContent = "✕";
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't toggle a group header / open receipts
    openDismissReasonMenu(btn, recordId, cardEl, summary);
  });
  actionsEl.appendChild(btn);
}

/** Tracks the currently-open reason menu so a second click / outside click /
 *  Escape closes it (only one menu open at a time). */
let _openReasonMenu = null;

function closeDismissReasonMenu() {
  if (_openReasonMenu) {
    _openReasonMenu.remove();
    _openReasonMenu = null;
    document.removeEventListener("click", _onOutsideReasonClick, true);
    document.removeEventListener("keydown", _onReasonMenuKeydown, true);
  }
}

function _onOutsideReasonClick(e) {
  if (_openReasonMenu && !_openReasonMenu.contains(e.target)) {
    closeDismissReasonMenu();
  }
}

function _onReasonMenuKeydown(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeDismissReasonMenu();
  }
}

/** Open the inline reason picker anchored under the ✕ button. The menu is a
 *  small glass popover with one button per closed-set reason. */
function openDismissReasonMenu(anchorBtn, recordId, cardEl, summary) {
  // Toggle: a second click on the same trigger closes it.
  const wasOpen = !!_openReasonMenu;
  closeDismissReasonMenu();
  if (wasOpen) return;

  const menu = document.createElement("div");
  menu.className = "record-reason-menu";
  menu.setAttribute("role", "menu");

  const heading = document.createElement("div");
  heading.className = "record-reason-heading";
  heading.textContent = "Dismiss because…";
  menu.appendChild(heading);

  for (const { slug, label } of DISMISS_REASONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "record-reason-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDismissReasonMenu();
      dismissRecord(recordId, cardEl, summary, slug);
    });
    menu.appendChild(item);
  }

  // Anchor under the ✕ button. The actions footer isn't positioned, so we use a
  // fixed-position popover placed against the button's viewport rect.
  document.body.appendChild(menu);
  const r = anchorBtn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  // Right-align the menu to the button so it doesn't overflow the narrow widget.
  menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;

  _openReasonMenu = menu;
  // Defer outside-click wiring so THIS click (which opened the menu) doesn't
  // immediately close it.
  setTimeout(() => {
    document.addEventListener("click", _onOutsideReasonClick, true);
    document.addEventListener("keydown", _onReasonMenuKeydown, true);
  }, 0);
}

/** Snooze duration presets. Labels are plain text (no emoji); the chosen ms is
 *  added to "now" to produce the ISO snoozeUntil the server reactivates after. */
const SNOOZE_OPTIONS = [
  { label: "1 day", ms: 1 * 86400000 },
  { label: "3 days", ms: 3 * 86400000 },
  { label: "1 week", ms: 7 * 86400000 },
  { label: "2 weeks", ms: 14 * 86400000 },
];

/** Append the Resolve + Snooze disposition controls to a record's actions
 *  footer, alongside the dismiss ✕. Resolve marks a commitment done; Snooze
 *  hides it until a chosen duration elapses. Both reuse the already-wired
 *  helpers (resolveRecord / snoozeRecord) which persist locally AND PATCH the
 *  server. `margin-left:auto` on Resolve groups the disposition actions to the
 *  right, next to ✕. */
function appendResolveSnoozeControls(actionsEl, recordId, cardEl, summary) {
  if (!recordId) return;

  const resolveBtn = document.createElement("button");
  resolveBtn.type = "button";
  resolveBtn.className = "record-action-btn record-resolve-btn";
  resolveBtn.title = "Resolve — mark this done";
  resolveBtn.textContent = "Resolve";
  resolveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    resolveRecord(recordId, cardEl, summary);
  });
  actionsEl.appendChild(resolveBtn);

  const snoozeBtn = document.createElement("button");
  snoozeBtn.type = "button";
  snoozeBtn.className = "record-action-btn record-snooze-btn";
  snoozeBtn.title = "Snooze — hide until later";
  snoozeBtn.textContent = "Snooze";
  snoozeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSnoozeMenu(snoozeBtn, recordId, cardEl, summary);
  });
  actionsEl.appendChild(snoozeBtn);
}

/** Snooze-duration popover. Same glass menu + single-open-at-a-time infra as the
 *  dismiss-reason picker (reuses _openReasonMenu / closeDismissReasonMenu so
 *  opening one closes the other). Picking a duration snoozes the record until
 *  now + duration. */
function openSnoozeMenu(anchorBtn, recordId, cardEl, summary) {
  const wasOpen = !!_openReasonMenu;
  closeDismissReasonMenu();
  if (wasOpen) return;

  const menu = document.createElement("div");
  menu.className = "record-reason-menu";
  menu.setAttribute("role", "menu");

  const heading = document.createElement("div");
  heading.className = "record-reason-heading";
  heading.textContent = "Snooze for…";
  menu.appendChild(heading);

  for (const { label, ms } of SNOOZE_OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "record-reason-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDismissReasonMenu();
      const until = new Date(Date.now() + ms).toISOString();
      snoozeRecord(recordId, cardEl, summary, until);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  const r = anchorBtn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;

  _openReasonMenu = menu;
  setTimeout(() => {
    document.addEventListener("click", _onOutsideReasonClick, true);
    document.addEventListener("keydown", _onReasonMenuKeydown, true);
  }, 0);
}

/** Optimistically remove `cardEl`, record the disposition server-side AND keep
 *  the local suppression cache, then show an Undo toast.
 *
 *  Order of operations (offline-tolerant):
 *   1. Optimistically hide the card + add to the local `_dismissedIds` set.
 *   2. Persist the local suppression (`dismiss_record`) — this is the OFFLINE
 *      FALLBACK so the item stays hidden across restarts even if the server is
 *      unreachable. A local-write failure restores the card + errors out.
 *   3. Best-effort server PATCH (`set_record_disposition`, state=dismissed +
 *      reason). On success the dismissal is durable server-side (calibration
 *      signal). On failure we KEEP the local hide and just log — the item is
 *      still suppressed locally; the server simply didn't hear about it.
 */
async function dismissRecord(recordId, cardEl, summary, reason) {
  if (!recordId || !cardEl) return;
  const parent = cardEl.parentNode;
  const next = cardEl.nextSibling;

  _dismissedIds.add(recordId);
  cardEl.remove();

  // (2) Local optimistic-cache write — the offline fallback.
  try {
    await tauri.core.invoke("dismiss_record", { recordId });
  } catch (err) {
    console.warn("[main] dismiss_record (local) failed:", err);
    _dismissedIds.delete(recordId);
    if (parent) parent.insertBefore(cardEl, next || null);
    showToast({
      kind: "failure",
      title: "Couldn't dismiss",
      body: "The change wasn't saved. Try again.",
    });
    return;
  }

  // (3) Server-side disposition — best-effort. The local hide already stands.
  let serverOk = true;
  if (reason) {
    try {
      await tauri.core.invoke("set_record_disposition", {
        recordId,
        disposition: "dismissed",
        reason,
      });
    } catch (err) {
      serverOk = false;
      console.warn("[main] set_record_disposition (dismissed) failed:", err);
    }
  }

  showToast({
    kind: "idempotent",
    title: "Dismissed",
    body: serverOk
      ? summary
        ? clampText(summary, 80)
        : ""
      : "Hidden locally — couldn't reach Apolla to record it.",
    cta: { label: "Undo", onClick: () => undoDismiss(recordId, cardEl, parent, next) },
  });
}

/** Reverse a dismissal: un-persist locally, re-activate server-side (best-effort),
 *  and re-insert the card where it was. */
async function undoDismiss(recordId, cardEl, parent, next) {
  try {
    await tauri.core.invoke("undismiss_record", { recordId });
  } catch (err) {
    console.warn("[main] undismiss_record failed:", err);
    // Fall through — still restore the view; the set is the source of truth for
    // this session and a re-fetch will reconcile.
  }
  // Best-effort: tell the server the record is active again (mirrors the local
  // un-suppress). Failure is non-fatal — the local restore below still happens.
  try {
    await tauri.core.invoke("set_record_disposition", {
      recordId,
      disposition: "active",
    });
  } catch (err) {
    console.warn("[main] set_record_disposition (active/undo) failed:", err);
  }
  _dismissedIds.delete(recordId);
  if (parent && !cardEl.isConnected) parent.insertBefore(cardEl, next || null);
}

// WP-THRESHOLD-RECORD-HITL — Resolve / Snooze.
//
// TODO(resolve/snooze UI): the Rust `set_record_disposition` command + server
// endpoint fully support `state: "resolved"` and `state: "snoozed"` (with an
// optional ISO `snoozeUntil`). The records panel does NOT yet host dedicated
// Resolve / Snooze affordances (adding two more inline controls + a snooze
// date-picker to every card is out of proportion for this cut). The helpers
// below are wired end-to-end so the panel can call them once those affordances
// land; Dismiss is the only gesture surfaced in the UI today.

/** Mark a record resolved server-side (state=resolved) and locally suppress it.
 *  Symmetric with dismissRecord but with no reason (resolve takes none). */
async function resolveRecord(recordId, cardEl, summary) {
  if (!recordId || !cardEl) return;
  const parent = cardEl.parentNode;
  const next = cardEl.nextSibling;
  _dismissedIds.add(recordId);
  cardEl.remove();
  try {
    await tauri.core.invoke("dismiss_record", { recordId });
  } catch (err) {
    console.warn("[main] dismiss_record (local, resolve) failed:", err);
    _dismissedIds.delete(recordId);
    if (parent) parent.insertBefore(cardEl, next || null);
    showToast({ kind: "failure", title: "Couldn't resolve", body: "The change wasn't saved. Try again." });
    return;
  }
  let serverOk = true;
  try {
    await tauri.core.invoke("set_record_disposition", { recordId, disposition: "resolved" });
  } catch (err) {
    serverOk = false;
    console.warn("[main] set_record_disposition (resolved) failed:", err);
  }
  showToast({
    kind: "success",
    title: "Resolved",
    body: serverOk ? (summary ? clampText(summary, 80) : "") : "Hidden locally — couldn't reach Apolla to record it.",
    cta: { label: "Undo", onClick: () => undoDismiss(recordId, cardEl, parent, next) },
  });
}

/** Snooze a record until `snoozeUntilIso` (ISO 8601) server-side and locally
 *  suppress it for now. */
async function snoozeRecord(recordId, cardEl, summary, snoozeUntilIso) {
  if (!recordId || !cardEl) return;
  const parent = cardEl.parentNode;
  const next = cardEl.nextSibling;
  _dismissedIds.add(recordId);
  cardEl.remove();
  try {
    await tauri.core.invoke("dismiss_record", { recordId });
  } catch (err) {
    console.warn("[main] dismiss_record (local, snooze) failed:", err);
    _dismissedIds.delete(recordId);
    if (parent) parent.insertBefore(cardEl, next || null);
    showToast({ kind: "failure", title: "Couldn't snooze", body: "The change wasn't saved. Try again." });
    return;
  }
  let serverOk = true;
  try {
    await tauri.core.invoke("set_record_disposition", {
      recordId,
      disposition: "snoozed",
      snoozeUntil: snoozeUntilIso || undefined,
    });
  } catch (err) {
    serverOk = false;
    console.warn("[main] set_record_disposition (snoozed) failed:", err);
  }
  showToast({
    kind: "idempotent",
    title: "Snoozed",
    body: serverOk ? (summary ? clampText(summary, 80) : "") : "Hidden locally — couldn't reach Apolla to record it.",
    cta: { label: "Undo", onClick: () => undoDismiss(recordId, cardEl, parent, next) },
  });
}

/** Truncate to `max` chars on a word boundary, with an ellipsis. */
function clampText(s, max) {
  const str = String(s || "");
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

// ───────── WP-THRESHOLD-SOURCE — in-app source reader (split view) ─────────
//
// Click a source badge (or a Receipts "source ↗") and the captured source —
// email / Plaud transcript / OneNote text — opens in a panel BESIDE the current
// view, with the record's verbatim quote highlighted. No browser round-trip, and
// it sidesteps the /document/:id → /login redirect on auth-gated pilots.

/** documentId → document (from /api/data), carrying sourceMetadata for the
 *  source-type badge. Lazily loaded + cached for the session. */
let _docsById = null;
let _docsByIdPromise = null;

/** Load (once) the documentId → doc map from /api/data. Best-effort: a failure
 *  leaves badges/source unavailable rather than throwing into a view. Concurrent
 *  callers share one in-flight fetch (no duplicate /api/data round-trips). */
async function loadDocsMap() {
  if (_docsById) return _docsById;
  if (_docsByIdPromise) return _docsByIdPromise;
  _docsByIdPromise = (async () => {
    const map = new Map();
    try {
      const resp = await tauri.core.invoke("fetch_documents");
      const docs = resp && Array.isArray(resp.documents) ? resp.documents : [];
      for (const d of docs) if (d && d.id) map.set(d.id, d);
    } catch (err) {
      console.warn("[main] loadDocsMap failed:", err);
    }
    _docsById = map;
    return map;
  })();
  return _docsByIdPromise;
}

// Design-system line icons (feather-style: 24-viewBox, fill:none,
// stroke:currentColor, 1.75 — matches the Collapse / prompt icons). Monochrome,
// inherit the badge's text color — no multicolor emoji.
const SOURCE_ICONS = {
  email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  plaud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  onenote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
  teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8 8 0 0 1-11.6 7.1L4 20l1.4-5.4A8 8 0 1 1 21 11.5z"/></svg>',
  screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
};

/** Parse a display name out of an email "From" header ("Name <addr>" → "Name"). */
function senderName(from) {
  const s = String(from || "").trim();
  if (!s) return "";
  const m = s.match(/^"?([^"<]+?)"?\s*</);
  return (m ? m[1] : s.split("<")[0]).trim();
}

/** Map a document's sourceMetadata to a display {iconKey, label, detail}.
 *  captureTool is the primary signal; captureMethod + the id prefix are
 *  fallbacks (e.g. outlook-addin emails carry the method, not the tool). */
function sourceFromDoc(doc) {
  const sm = (doc && doc.sourceMetadata) || {};
  const tool = (sm.captureTool || "").toLowerCase();
  const method = (sm.captureMethod || "").toLowerCase();
  const app = (sm.sourceApp || "").toLowerCase();
  const id = (doc && doc.id ? String(doc.id) : "").toLowerCase();

  if (tool === "plaud" || method === "recording-import" || id.startsWith("plaud")) {
    const mins = sm.durationMs ? Math.round(sm.durationMs / 60000) : null;
    const speakers = sm.originalSpeakerMapping
      ? Object.values(sm.originalSpeakerMapping).filter((s) => s && !/^Speaker \d+$/i.test(s))
      : [];
    const parts = [];
    if (mins) parts.push(mins + " min");
    if (speakers.length) {
      parts.push(speakers[0] + (speakers.length > 1 ? ` +${speakers.length - 1}` : ""));
    }
    return { iconKey: "plaud", label: "Plaud", detail: parts.join(" · ") };
  }
  if (tool === "onenote" || method === "com-capture" || id.startsWith("onenote")) {
    return { iconKey: "onenote", label: "OneNote", detail: [sm.notebookName, sm.sectionName].filter(Boolean).join(" / ") };
  }
  // Email: tool OR method "outlook-addin", or the EMAIL- id prefix.
  if (tool.includes("outlook") || method.includes("outlook") || id.startsWith("email")) {
    return { iconKey: "email", label: "Email", detail: senderName(sm.from) };
  }
  // Teams — including a screen-capture OF Teams (sourceApp hints the app).
  if (tool.includes("teams") || app.includes("teams")) {
    return { iconKey: "teams", label: "Teams", detail: "" };
  }
  if (tool === "threshold" || method === "screenshot-ocr" || id.startsWith("desktop")) {
    const niceApp = app.includes("outlook") ? "Outlook" : app ? prettySlug(app.replace(/^(com|ms)[.-]/, "")) : "";
    return { iconKey: "screen", label: "Screen capture", detail: niceApp };
  }
  return { iconKey: "doc", label: "Source", detail: "" };
}

/** Build a clickable source-type chip for a record, or null when we have no
 *  documentId / no doc metadata (invisible-by-absence). `verbatim` (when present)
 *  is highlighted in the source once the panel opens. */
function renderSourceBadge(documentId, verbatim) {
  if (!documentId || !_docsById) return null;
  const doc = _docsById.get(documentId);
  if (!doc) return null;
  const src = sourceFromDoc(doc);
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "source-badge";
  chip.title = "Open the source beside this — " + src.label + (src.detail ? " · " + src.detail : "");
  const icon = document.createElement("span");
  icon.className = "source-badge-icon";
  icon.innerHTML = SOURCE_ICONS[src.iconKey] || SOURCE_ICONS.doc; // constant SVG, not user data
  chip.appendChild(icon);
  const label = document.createElement("span");
  label.className = "source-badge-label";
  label.textContent = src.label;
  chip.appendChild(label);
  if (src.detail) {
    const det = document.createElement("span");
    det.className = "source-badge-detail";
    det.textContent = "· " + src.detail;
    chip.appendChild(det);
  }
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    openSourcePanel(documentId, verbatim);
  });
  return chip;
}

/** Append a source badge to an actions/footer row (no-op when unavailable). */
function appendSourceBadge(rowEl, documentId, verbatim) {
  const chip = renderSourceBadge(documentId, verbatim);
  if (chip) rowEl.appendChild(chip);
}

/** The documentId currently shown, so a slow fetch that's been superseded by a
 *  newer open doesn't clobber the panel. */
let _sourceOpenDoc = null;
/** The currently-rendered source {title, body, documentId} — for Copy/Download. */
let _sourceCurrent = null;

/** Open the source reader beside the current view: fetch the document (detail +
 *  body) and render it, highlighting `verbatim`. */
async function openSourcePanel(documentId, verbatim) {
  if (!documentId) return;
  const panel = document.getElementById("source-panel");
  const titleEl = document.getElementById("source-panel-title");
  const metaEl = document.getElementById("source-panel-meta");
  const badgeEl = document.getElementById("source-panel-badge");
  const statusEl = document.getElementById("source-panel-status");
  const bodyEl = document.getElementById("source-panel-body");
  if (!panel) return;

  _sourceOpenDoc = documentId;
  panel.hidden = false;
  document.body.classList.add("source-open");

  await loadDocsMap();
  const doc = _docsById ? _docsById.get(documentId) : null;
  if (badgeEl) {
    badgeEl.textContent = "";
    if (doc) {
      const src = sourceFromDoc(doc);
      const ic = document.createElement("span");
      ic.className = "source-badge-icon";
      ic.innerHTML = SOURCE_ICONS[src.iconKey] || SOURCE_ICONS.doc; // constant SVG
      badgeEl.appendChild(ic);
      badgeEl.appendChild(
        document.createTextNode(" " + src.label + (src.detail ? " · " + src.detail : "")),
      );
    }
  }

  if (titleEl) titleEl.textContent = "Loading source…";
  if (metaEl) metaEl.textContent = "";
  if (bodyEl) bodyEl.textContent = "";
  if (statusEl) statusEl.hidden = true;

  let detail;
  try {
    detail = await tauri.core.invoke("fetch_document", { documentId });
  } catch (err) {
    console.warn("[main] fetch_document failed:", err);
    if (_sourceOpenDoc !== documentId) return;
    if (titleEl) titleEl.textContent = "Source unavailable";
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = "Couldn't load this source. Check the connection in Configure, then try again.";
    }
    return;
  }
  if (_sourceOpenDoc !== documentId) return; // superseded by a newer open

  if (titleEl) titleEl.textContent = detail.title || documentId;
  if (metaEl) {
    const bits = [];
    if (detail.date) bits.push(formatDueDate(detail.date));
    const people = Array.isArray(detail.participants) ? detail.participants : [];
    if (people.length) {
      bits.push(people.slice(0, 3).map(prettySlug).join(", ") + (people.length > 3 ? ` +${people.length - 3}` : ""));
    }
    metaEl.textContent = bits.join(" · ");
  }
  const displayBody = reflowSourceBody(detail.body || "");
  _sourceCurrent = { title: detail.title || documentId, body: displayBody, documentId };

  // Gather EVERY verified verbatim extracted from this source so they all get
  // highlighted (the clicked one stays primary). Best-effort: on failure we fall
  // back to highlighting just the clicked record.
  let others = [];
  try {
    const dr = await tauri.core.invoke("fetch_document_records", { documentId });
    if (_sourceOpenDoc !== documentId) return;
    const recs = dr && Array.isArray(dr.records) ? dr.records : [];
    const clicked = (verbatim || "").trim().toLowerCase();
    for (const it of recs) {
      const r = it && it.record ? it.record : it;
      if (!r || r.verbatimVerified !== true || !r.verbatim) continue;
      if (r.verbatim.trim().toLowerCase() === clicked) continue;
      others.push(r.verbatim);
    }
  } catch (err) {
    console.warn("[main] fetch_document_records failed (highlighting clicked record only):", err);
  }

  const nMarks = renderSourceBody(bodyEl, displayBody, verbatim, others);
  if (metaEl && nMarks > 1) {
    metaEl.textContent = (metaEl.textContent ? metaEl.textContent + " · " : "") + nMarks + " highlighted";
  }
}

/** Clean a captured source body for display: non-breaking spaces → normal
 *  spaces (Outlook/OneNote capture is full of them), and stack run-together
 *  email header fields (From:/Sent:/To:/…) onto their own lines so a quoted
 *  reply thread reads as a header block instead of one wrapped blob. */
function reflowSourceBody(text) {
  let s = String(text || "").replace(/\u00a0/g, " ");
  // Break before each capitalised email-header field so a run-together quoted
  // thread stacks (e.g. "\u20264:49 PMTo: \u2026" \u2192 newline before "To:"). Case-sensitive
  // + no \b, so it catches "PMTo:"/"AMTo:" while lowercase prose ("\u2026to:") is
  // left alone.
  s = s.replace(/ *(From|Sent|To|Cc|Bcc|Subject|Importance): */g, "\n$1: ");
  return s.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** Find a verbatim in the (reflowed) body, whitespace-insensitively (the capture
 *  collapses/varies whitespace), returning {start,end} in the body or null. */
function findVerbatimRange(haystack, needle) {
  const cleaned = String(needle || "").replace(/\u00a0/g, " ").trim();
  if (!cleaned) return null;
  const pattern = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  let m;
  try {
    m = new RegExp(pattern, "i").exec(haystack);
  } catch {
    return null;
  }
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Render the body text, highlighting EVERY extracted verbatim: `primary` (the
 *  clicked record) brightly + scrolled-to, the `others` (its siblings from the
 *  same source) dimmed — so the source shows all its decisions/commitments in
 *  context. `text` is assumed already reflowed. textContent + DOM nodes (no
 *  innerHTML). Returns the count of highlights actually placed. */
function renderSourceBody(bodyEl, text, primary, others) {
  if (!bodyEl) return 0;
  bodyEl.textContent = "";
  if (!text) {
    bodyEl.textContent = "(no source text available)";
    return 0;
  }
  const seen = new Set();
  const ranges = [];
  const add = (q, isPrimary) => {
    const key = String(q || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const range = findVerbatimRange(text, q);
    if (!range) return; // not found in the body — skip
    ranges.push({ start: range.start, end: range.end, primary: isPrimary });
  };
  add(primary, true);
  for (const q of Array.isArray(others) ? others : []) add(q, false);

  if (!ranges.length) {
    bodyEl.textContent = text;
    return 0;
  }
  // Earliest first; at a tie the primary wins. Then drop any overlaps greedily.
  ranges.sort((a, b) => a.start - b.start || (b.primary === true) - (a.primary === true));
  const placed = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    placed.push(r);
    lastEnd = r.end;
  }
  let cursor = 0;
  let primaryMark = null;
  for (const r of placed) {
    if (r.start > cursor) bodyEl.appendChild(document.createTextNode(text.slice(cursor, r.start)));
    const mark = document.createElement("mark");
    mark.className = r.primary ? "source-hl source-hl-primary" : "source-hl source-hl-dim";
    mark.textContent = text.slice(r.start, r.end);
    bodyEl.appendChild(mark);
    if (r.primary) primaryMark = mark;
    cursor = r.end;
  }
  if (cursor < text.length) bodyEl.appendChild(document.createTextNode(text.slice(cursor)));
  const target = primaryMark || bodyEl.querySelector("mark");
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "center", behavior: "smooth" }));
  return placed.length;
}

/** Close the source reader and restore the full-width view. */
function closeSourcePanel() {
  _sourceOpenDoc = null;
  _sourceCurrent = null;
  document.body.classList.remove("source-open");
  const panel = document.getElementById("source-panel");
  if (panel) panel.hidden = true;
}

// Close button + Escape key.
const _srcCloseBtn = document.getElementById("source-panel-close");
if (_srcCloseBtn) _srcCloseBtn.addEventListener("click", () => closeSourcePanel());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("source-open")) closeSourcePanel();
});

// Copy the full source text to the clipboard (plain text via the copy_text IPC).
const _srcCopyBtn = document.getElementById("source-panel-copy");
if (_srcCopyBtn) {
  _srcCopyBtn.addEventListener("click", async () => {
    if (!_sourceCurrent || !_sourceCurrent.body) return;
    try {
      await tauri.core.invoke("copy_text", { text: _sourceCurrent.body });
      showToast({ kind: "success", title: "Source copied", body: "The full source text is on your clipboard." });
    } catch (err) {
      console.warn("[main] copy_text failed:", err);
      showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." });
    }
  });
}

// Download the source text to a file (native save dialog via save_text_file).
const _srcDownloadBtn = document.getElementById("source-panel-download");
if (_srcDownloadBtn) {
  _srcDownloadBtn.addEventListener("click", async () => {
    if (!_sourceCurrent || !_sourceCurrent.body) return;
    const base =
      (_sourceCurrent.title || _sourceCurrent.documentId || "source")
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "source";
    try {
      const saved = await tauri.core.invoke("save_text_file", {
        defaultName: base + ".txt",
        content: _sourceCurrent.body,
      });
      if (saved) showToast({ kind: "success", title: "Source saved", body: saved });
    } catch (err) {
      console.warn("[main] save_text_file failed:", err);
      showToast({ kind: "failure", title: "Couldn't save", body: "Try again." });
    }
  });
}

/**
 * @param {object|null} tidbit         get_pending_tidbit payload (or null)
 * @param {object|null} recordsResp    get_pending_records envelope (or null):
 *                                     { records: [{record, lifecycle, state}], edges: [...] }
 */
async function enterPostCaptureView(tidbit, recordsResp) {
  state.inWizard = false;
  showView("view-tidbit");
  setNav([{ label: "Just captured" }], { back: () => goHome() });

  await refreshDismissedIds();
  await loadDocsMap();
  const items = withoutDismissed(
    recordsResp && Array.isArray(recordsResp.records) ? recordsResp.records : [],
  );
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
    if (isDismissed(item)) continue; // suppressed — never render
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

  // Actions row: "Show receipts" (when the record has a subject) + Dismiss.
  // Always present so the dismiss affordance is on every card.
  const actions = document.createElement("div");
  actions.className = "record-actions";
  if (rec.primaryEntity) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-link receipts-entry-btn";
    btn.textContent = "Show receipts →";
    btn.addEventListener("click", () => enterReceiptsView(rec.primaryEntity));
    actions.appendChild(btn);
  }
  appendSourceBadge(actions, rec.documentId, rec.verbatim);
  appendResolveSnoozeControls(actions, rec.recordId, card, rec.summary);
  appendDismissControl(actions, rec.recordId, card, rec.summary);
  card.appendChild(actions);

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
  setNav([{ label: "Today" }], { active: "today", back: () => goHome() });

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

  await refreshDismissedIds();
  await loadDocsMap();

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
  const needsAttention = withoutDismissed(
    Array.isArray(data && data.needsAttention) ? data.needsAttention : [],
  );
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
      { key: "superseded", label: "Replaced" },
    ];
    let any = false;
    for (const s of order) {
      const n = typeof states[s.key] === "number" ? states[s.key] : 0;
      // Clickable — opens the Decisions browser filtered to this status.
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "log-state-pill";
      pill.dataset.state = s.key;
      pill.textContent = `${n} ${s.label.toLowerCase()}`;
      pill.addEventListener("click", () => enterDecisionsView(s.key, { from: "today" }));
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

  // Actions: "Show receipts" (when the row has a subject) + Dismiss. Always
  // present so the dismiss affordance is on every row.
  const footer = document.createElement("div");
  footer.className = "log-row-actions";
  if (rec.primaryEntity) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-link receipts-entry-btn";
    btn.textContent = "Show receipts →";
    btn.addEventListener("click", () => enterReceiptsView(rec.primaryEntity));
    footer.appendChild(btn);
  }
  appendSourceBadge(footer, rec.documentId, rec.verbatim);
  appendResolveSnoozeControls(footer, rec.recordId, row, rec.summary);
  appendDismissControl(footer, rec.recordId, row, rec.summary);
  row.appendChild(footer);
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

// WP-THRESHOLD-STATE-OF-PLAY — corpus altitude on Today: the Monday overview
// across all projects, on demand. Same engine as the per-person digest.
let _corpusPolish = false;
const logSopBtn = document.getElementById("btn-log-sop");
if (logSopBtn) {
  logSopBtn.addEventListener("click", () => {
    const panel = document.getElementById("log-sop-panel");
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; logSopBtn.setAttribute("aria-expanded", "false"); return; }
    panel.hidden = false;
    logSopBtn.setAttribute("aria-expanded", "true");
    loadCorpusStateOfPlay(panel);
  });
}
async function loadCorpusStateOfPlay(panel) {
  panel.innerHTML = '<div class="sop-status">Composing the overview…</div>';
  try {
    const res = await tauri.core.invoke("fetch_corpus_state_of_play", { polish: _corpusPolish });
    if (!res || res.available === false) {
      panel.innerHTML = '<div class="sop-status">' +
        (res && res.reason === "unavailable" ? "Overview isn't available on this server yet." : "No open items.") + "</div>";
      return;
    }
    renderCorpusPanel(panel, res);
  } catch (err) {
    console.warn("[main] fetch_corpus_state_of_play failed:", err);
    panel.innerHTML = '<div class="sop-status">Couldn\'t reach Apolla.</div>';
  }
}
function renderCorpusPanel(panel, data) {
  panel.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "sop-toolbar";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sop-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("copy_text", { text: data.message || "" });
      copyBtn.textContent = "Copied ✓";
      copyBtn.disabled = true;
      setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.disabled = false; }, 1600);
    } catch (e) { showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." }); }
  });
  bar.appendChild(copyBtn);
  const polishBtn = document.createElement("button");
  polishBtn.type = "button";
  polishBtn.className = "sop-polish";
  polishBtn.textContent = data.polished ? "Plain text" : "Polish with AI";
  polishBtn.addEventListener("click", async () => {
    _corpusPolish = !data.polished;
    await loadCorpusStateOfPlay(panel);
  });
  bar.appendChild(polishBtn);
  if (data.polished) {
    const t = document.createElement("span");
    t.className = "sop-polished-tag";
    t.textContent = "AI-polished";
    bar.appendChild(t);
  }
  panel.appendChild(bar);
  const msg = document.createElement("pre");
  msg.className = "sop-message";
  msg.textContent = data.message || "";
  panel.appendChild(msg);
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
  supersedes: { label: "Replacement", plural: "Replacements", verb: "replaces", icon: "⤳" },
  resolves: { label: "Resolution", plural: "Resolutions", verb: "resolves", icon: "✓" },
  duplicates: { label: "Duplicate", plural: "Duplicates", verb: "duplicate of", icon: "⧉" },
};

// Distinct record count for the current Connections render — used to keep the
// subtitle accurate after a dismiss removes a card (records don't change, the
// connection count does).
let _edgesRecordCount = 0;
// WP-THRESHOLD-NAV — active kind filter for the Relationships view (null = all).
let _edgesKindFilter = null;
// WP-THRESHOLD-NAV — Relationships grouping lens ("kind" | "project") + cached
// fetch result so a lens toggle re-renders without re-fetching.
let _edgesLens = "kind";
let _edgesData = null;
// WP-THRESHOLD-NAV — documentId → projects[] so each relationship endpoint is
// traceable to its project. Populated on Relationships/Log entry.
let _edgesDocProjects = new Map();

/**
 * Open the Connections view: the full cross-record edge graph, each edge shown
 * with BOTH of its records inline. Pure display join — fetch_decision_log_full
 * proxies GET /api/decision-log?full=1, which returns every active edge plus the
 * full records; we index records by recordId and render each edge's two
 * endpoints. No recompute, no LLM. (Answers the most-asked question on the log:
 * "what are these dependencies referring to?")
 */
// WP-THRESHOLD-NAV — clicking a kind pill filters the Relationships list to that
// kind (toggle; clicking the active pill clears it). Hides non-matching group
// titles + cards via a class so refreshEdgeTallies' counts stay truthful (it
// counts every .edge-card in the DOM, hidden or not).
function applyEdgesFilters() {
  const kindsStrip = document.getElementById("edges-kinds-strip");
  const listEl = document.getElementById("edges-list");
  const kf = _edgesKindFilter;
  if (kindsStrip) {
    for (const pill of kindsStrip.querySelectorAll(".edges-kind-pill")) {
      pill.setAttribute("aria-pressed", kf !== null && pill.dataset.kind === kf ? "true" : "false");
    }
  }
  if (!listEl) return;
  // Hide a card unless it matches the active kind filter.
  for (const card of listEl.querySelectorAll(".edge-card")) {
    card.classList.toggle("edges-filtered-out", !(kf === null || card.dataset.kind === kf));
  }
  // A group shows only if it still has at least one visible card.
  for (const grp of listEl.querySelectorAll(".edges-group")) {
    grp.classList.toggle("edges-filtered-out", !grp.querySelector(".edge-card:not(.edges-filtered-out)"));
  }
}

// WP-THRESHOLD-NAV — render the Relationships list grouped by the active lens
// (By kind: conflicts/dependencies/… sections; By project: project-name sections,
// each edge filed under the first project of either endpoint). Uses the cached
// _edgesData so a lens toggle re-renders without re-fetching. Mirrors the Log
// view's lens model; the kind pills remain an orthogonal filter.
function renderEdgesList() {
  const listEl = document.getElementById("edges-list");
  if (!listEl || !_edgesData) return;
  const { edges, byId, baseUrl } = _edgesData;
  listEl.innerHTML = "";
  const severityRank = (s) => (s === "high" ? 0 : s === "medium" ? 1 : 2);
  const sortEdges = (arr) => arr.slice().sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) || (a.edgeId || "").localeCompare(b.edgeId || ""));

  const groups = [];
  if (_edgesLens === "project") {
    // Same project derivation + "Other" catch-all + largest-first ordering as
    // the Log view (groupRecords), so the two read consistently. A relationship
    // is filed under the first project of either endpoint's record.
    const OTHER = "__other__";
    const firstProjectOf = (r) => {
      const ps = r ? (_edgesDocProjects.get(r.documentId) || []) : [];
      return ps.length ? ps[0] : OTHER;
    };
    // Record count per project across ALL records (byId holds the full set),
    // so we can order the project groups the SAME way the Log view does — by
    // record count, descending — and the two views line up for comparison.
    const recCount = new Map();
    for (const r of byId.values()) {
      const p = firstProjectOf(r);
      recCount.set(p, (recCount.get(p) || 0) + 1);
    }
    const m = new Map();
    const primaryProject = (edge) => {
      for (const rid of [edge.recordA, edge.recordB]) {
        const r = byId.get(rid);
        const ps = r ? (_edgesDocProjects.get(r.documentId) || []) : [];
        if (ps.length) return ps[0];
      }
      return OTHER;
    };
    for (const e of edges) {
      const k = primaryProject(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    [...m.keys()].filter((k) => k !== OTHER)
      .sort((a, b) => (recCount.get(b) || 0) - (recCount.get(a) || 0))
      .forEach((k) => groups.push({ label: prettySlug(k), edges: m.get(k) }));
    if (m.has(OTHER)) groups.push({ label: "Other", edges: m.get(OTHER), muted: true });
  } else {
    for (const kind of EDGE_KIND_ORDER) {
      const g = edges.filter((e) => e.kind === kind);
      if (!g.length) continue;
      const meta = EDGE_KIND_META[kind];
      groups.push({ label: g.length === 1 ? meta.label : meta.plural, edges: g });
    }
  }

  for (const g of groups) {
    const wrap = document.createElement("div");
    wrap.className = "edges-group";

    // Collapsible header — mirrors the Log view's groups (chevron + name +
    // count). Default expanded so the relationships stay visible; click to fold.
    const head = document.createElement("button");
    head.type = "button";
    head.className = "decisions-group-title";
    head.setAttribute("aria-expanded", "true");
    if (g.muted) head.dataset.other = "true"; // muted styling for the "Other" group, like the Log

    const chev = document.createElement("span");
    chev.className = "decisions-group-chevron";
    chev.textContent = "▾";
    chev.setAttribute("aria-hidden", "true");
    head.appendChild(chev);

    const name = document.createElement("span");
    name.className = "decisions-group-name";
    name.textContent = g.label;
    head.appendChild(name);

    const count = document.createElement("span");
    count.className = "decisions-group-count";
    count.textContent = `${g.edges.length} ${g.edges.length === 1 ? "link" : "links"}`;
    head.appendChild(count);

    const body = document.createElement("div");
    body.className = "decisions-group-body";
    for (const edge of sortEdges(g.edges)) body.appendChild(renderEdgeCard(edge, byId, baseUrl));

    head.addEventListener("click", () => {
      const willExpand = body.hidden;
      body.hidden = !willExpand;
      head.setAttribute("aria-expanded", willExpand ? "true" : "false");
      chev.textContent = willExpand ? "▾" : "▸";
    });

    wrap.appendChild(head);
    wrap.appendChild(body);
    listEl.appendChild(wrap);
  }
  applyEdgesFilters();
}

async function enterEdgesView() {
  state.inWizard = false;
  showView("view-edges");
  setNav([{ label: "Relationships" }], { active: "edges", back: () => goHome() });
  _edgesKindFilter = null;
  _edgesLens = "kind";

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

  try {
  // Index records by recordId — the join key. Each entry is { record, lifecycle, state }.
  const items = Array.isArray(data && data.records) ? data.records : [];
  const byId = new Map();
  for (const item of items) {
    const rec = item && item.record ? item.record : item;
    if (rec && rec.recordId) byId.set(rec.recordId, rec);
  }

  // documentId → projects[] so each relationship endpoint is traceable to its
  // project (best-effort; chips omitted if /api/data fails).
  _edgesDocProjects = new Map();
  try {
    const docsResp = await tauri.core.invoke("fetch_documents");
    const docs = docsResp && Array.isArray(docsResp.documents) ? docsResp.documents : [];
    for (const d of docs) {
      if (d && d.id) _edgesDocProjects.set(d.id, Array.isArray(d.projects) ? d.projects : []);
    }
  } catch (err) {
    console.warn("[main] fetch_documents failed (edge projects omitted):", err);
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
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "edges-kind-pill";
      pill.dataset.kind = kind;
      pill.setAttribute("aria-pressed", "false");
      const kindWord = (group.length === 1 ? meta.label : meta.plural).toLowerCase();
      pill.textContent = `${meta.icon} ${group.length} ${kindWord}`;
      pill.addEventListener("click", () => {
        _edgesKindFilter = _edgesKindFilter === kind ? null : kind;
        applyEdgesFilters();
      });
      kindsStrip.appendChild(pill);
      any = true;
    }
    kindsStrip.hidden = !any;
  }

  // Cache the fetched result so a lens toggle re-renders without re-fetching,
  // then render the list grouped by the active lens. Reflect the lens row.
  _edgesData = { edges, byId, baseUrl };
  const lensRow = document.getElementById("edges-lenses");
  if (lensRow) {
    lensRow.hidden = false;
    for (const b of lensRow.querySelectorAll(".decisions-lens-btn")) {
      b.setAttribute("aria-pressed", b.dataset.lens === _edgesLens ? "true" : "false");
    }
  }
  renderEdgesList();

  applyEdgesFilters();
  } catch (e) {
    console.error("[edges] render failed:", e);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent = "Relationships failed to render: " + (e && e.message ? e.message : String(e));
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
  // Union of both endpoints' projects — drives the project filter + traceability.
  {
    const pu = new Set();
    for (const rid of [edge.recordA, edge.recordB]) {
      const r = byId.get(rid);
      if (r) for (const p of (_edgesDocProjects.get(r.documentId) || [])) pu.add(p);
    }
    card.dataset.projects = [...pu].join("|");
  }

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

  // Drop any group whose cards were all dismissed.
  for (const grp of [...listEl.querySelectorAll(".edges-group")]) {
    if (!grp.querySelector(".edge-card")) grp.remove();
  }

  const cards = [...listEl.querySelectorAll(".edge-card")];
  const counts = {};
  for (const c of cards) counts[c.dataset.kind] = (counts[c.dataset.kind] || 0) + 1;

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
  applyEdgesFilters();
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
  // Project chip(s) — trace this record back to its project (WP-THRESHOLD-NAV).
  for (const p of (_edgesDocProjects.get(rec.documentId) || []).slice(0, 2)) {
    const pc = document.createElement("span");
    pc.className = "decision-project-chip";
    pc.textContent = prettySlug(p);
    head.appendChild(pc);
  }
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

// Lens toggle on the Relationships view — By kind / By project (mirrors the Log
// view's lenses). Re-renders the grouped list from cached data; no re-fetch.
for (const b of document.querySelectorAll("#edges-lenses .decisions-lens-btn")) {
  b.addEventListener("click", () => {
    _edgesLens = b.dataset.lens || "kind";
    for (const x of document.querySelectorAll("#edges-lenses .decisions-lens-btn")) {
      x.setAttribute("aria-pressed", x === b ? "true" : "false");
    }
    renderEdgesList();
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
  setNav(
    [
      { label: "Today", go: () => enterLogView() },
      { label: "Receipts · " + prettySlug(entity), go: () => enterReceiptsView(entity) },
      { label: "Definition" },
    ],
    { back: () => enterReceiptsView(_entityCardReturn || entity) },
  );

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
    // Expanded card — where this subject stands (open items + focus).
    if (data && data.execution) appendCardExecution(proseEl, data.execution);
  }
  if (footerEl) footerEl.hidden = false;
}

// Render the "where it stands" execution block beneath the definition prose:
// open decision/commitment counts, the past-due items, and the one focus.
function appendCardExecution(container, e) {
  if (!container || !e) return;
  const open = (e.openDecisions || 0) + (e.openCommitments || 0) + (e.undated || 0);
  if (!open) return;

  const wrap = document.createElement("div");
  wrap.className = "entity-exec";

  const head = document.createElement("div");
  head.className = "entity-exec-head";
  head.textContent = "Where it stands";
  wrap.appendChild(head);

  const counts = document.createElement("div");
  counts.className = "entity-exec-counts";
  const parts = [];
  if (e.openDecisions) parts.push(`${e.openDecisions} open decision${e.openDecisions === 1 ? "" : "s"}`);
  if (e.openCommitments) parts.push(`${e.openCommitments} open commitment${e.openCommitments === 1 ? "" : "s"}`);
  if (e.undated) parts.push(`${e.undated} undated`);
  counts.textContent = parts.join(" · ");
  wrap.appendChild(counts);

  if (Array.isArray(e.pastDue) && e.pastDue.length) {
    const label = document.createElement("div");
    label.className = "entity-exec-sublabel";
    label.textContent = `Past due (${e.pastDue.length})`;
    wrap.appendChild(label);
    for (const i of e.pastDue.slice(0, 5)) {
      const row = document.createElement("div");
      row.className = "entity-exec-item";
      row.textContent = `${i.summary}${i.owner ? " — " + i.owner : ""}${i.daysOverdue != null ? ` (${i.daysOverdue}d ago)` : ""}`;
      wrap.appendChild(row);
    }
  }

  if (e.focus && e.focus.text) {
    const focus = document.createElement("div");
    focus.className = "entity-exec-focus";
    const fl = document.createElement("span");
    fl.className = "entity-exec-focus-label";
    fl.textContent = "Focus: ";
    focus.appendChild(fl);
    focus.appendChild(document.createTextNode(e.focus.text));
    wrap.appendChild(focus);
  }

  container.appendChild(wrap);
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

// ───────── Decisions browser — by project, status-filterable (WP-THRESHOLD-DECISION-ORG) ─────────

// Records + the documentId→projects map for the current browse, kept so the
// status filter re-renders without re-fetching.
let _decisionsCtx = null;
let _decisionsFilter = "all"; // all | open | resolved | superseded
let _decisionsLens = "project"; // project | deadline | people
let _decisionsExpanded = new Set(); // group keys the user has expanded (default: collapsed)
// WP-THRESHOLD-NAV — arrival context for the Log view. When Log is reached as a
// drill-down from a Today state pill, this holds the return thunk (→ Today) so
// the breadcrumb reads "Today › Log" and Back returns to Today, not Home. Null
// when Log was opened as a top-level destination. Only (re)set on navigation —
// Refresh re-enters with no navCtx and must preserve whatever's here.
let _decisionsReturn = null;
const PROJECT_OTHER = "__other__";

/** Bucket a record's due date into a deadline group (muted = the catch-all). */
function deadlineBucket(due) {
  if (!due) return { key: "z-none", label: "No due date", order: 9, muted: true };
  const days = Math.floor((new Date(due + "T00:00:00") - new Date()) / 86400000);
  if (days < 0) return { key: "a-overdue", label: "Overdue", order: 0 };
  if (days <= 7) return { key: "b-week", label: "Due this week", order: 1 };
  if (days <= 31) return { key: "c-month", label: "Due this month", order: 2 };
  return { key: "d-later", label: "Later", order: 3 };
}

/**
 * Group the records under the active lens. Project is the SOFT spine (first
 * project, "Other" catch-all); deadline buckets by due date (Overdue first, no-
 * date last); people groups by owner. Returns ordered [{key,label,muted,items}]
 * — catch-all groups (Other / Unassigned / No due date) sort last and render
 * muted so the real organization leads.
 */
function groupRecords(items, lens, docProjects, aliases) {
  const g = new Map();
  // Resolve a slug to its canonical form so duplicate subjects collapse into one
  // group (sora → project-sora). Identity when no alias is known.
  const canon = (s) => (aliases && aliases[s]) || s;
  const ensure = (key, label, order, muted) => {
    if (!g.has(key)) g.set(key, { key, label, order, muted: !!muted, items: [] });
    return g.get(key);
  };
  for (const it of items) {
    const rec = it && it.record ? it.record : it;
    if (!rec) continue;
    if (lens === "deadline") {
      const b = deadlineBucket(rec.due);
      ensure(b.key, b.label, b.order, b.muted).items.push(it);
    } else if (lens === "people") {
      const key = rec.owner ? canon(rec.owner) : "z-unassigned";
      ensure(key, rec.owner ? prettySlug(key) : "Unassigned", rec.owner ? 0 : 9, !rec.owner).items.push(it);
    } else {
      const projs = docProjects.get(rec.documentId) || [];
      const key = projs.length ? canon(projs[0]) : PROJECT_OTHER;
      ensure(key, key === PROJECT_OTHER ? "Other" : prettySlug(key), key === PROJECT_OTHER ? 9 : 0, key === PROJECT_OTHER).items.push(it);
    }
  }
  return [...g.values()].sort((a, b) => {
    if (lens === "deadline") return a.order - b.order;
    if (a.order !== b.order) return a.order - b.order; // catch-all last
    return b.items.length - a.items.length; // else largest first
  });
}

/**
 * Open the Decisions browser. Pulls every record (fetch_decision_log_full) and
 * the documents (fetch_documents → /api/data) so each record joins to its
 * project(s) via documentId. Project is a SOFT lens: records group under their
 * first project, an "Other" bucket holds the unattached, every card shows its
 * project chip(s), and the Open/Resolved/Replaced pills filter across projects.
 */
async function enterDecisionsView(initialFilter, navCtx) {
  state.inWizard = false;
  showView("view-decisions");
  // Arrival-aware breadcrumb. Update the return target only when navigated to
  // (navCtx present); Refresh re-enters with no navCtx and preserves context.
  if (navCtx?.from === "today") _decisionsReturn = () => enterLogView();
  else if (navCtx?.from === "home") _decisionsReturn = null;
  if (_decisionsReturn) {
    setNav([{ label: "Today", go: _decisionsReturn }, { label: "Log" }], { active: "log", back: _decisionsReturn });
  } else {
    setNav([{ label: "Log" }], { active: "log", back: () => goHome() });
  }
  if (initialFilter) _decisionsFilter = initialFilter;

  const listEl = document.getElementById("decisions-list");
  const statusEl = document.getElementById("decisions-status");
  if (listEl) listEl.innerHTML = "";
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Loading decisions…";
  }

  await refreshDismissedIds();
  await loadDocsMap();

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

  // documentId → projects[] (best-effort; chips/grouping omitted if /api/data fails).
  const docProjects = new Map();
  try {
    const docsResp = await tauri.core.invoke("fetch_documents");
    const docs = docsResp && Array.isArray(docsResp.documents) ? docsResp.documents : [];
    for (const d of docs) {
      if (d && d.id) docProjects.set(d.id, Array.isArray(d.projects) ? d.projects : []);
    }
  } catch (err) {
    console.warn("[main] fetch_documents failed (projects omitted):", err);
  }
  // Share the map so the conflicts-lens edge cards (renderEdgeEndpoint) can
  // trace each record to its project too.
  _edgesDocProjects = docProjects;

  const items = withoutDismissed(Array.isArray(data && data.records) ? data.records : []);
  // For the Conflicts lens: index records by id (to ground each edge) + base URL (source links).
  const byId = new Map();
  for (const it of items) {
    const rec = it && it.record ? it.record : it;
    if (rec && rec.recordId) byId.set(rec.recordId, rec);
  }
  let baseUrl = "";
  try {
    const cfg = await tauri.core.invoke("load_config");
    baseUrl = (cfg && cfg.base_url) || "";
  } catch (_e) { /* source links omitted if config unavailable */ }

  _decisionsCtx = {
    items,
    docProjects,
    edges: Array.isArray(data && data.edges) ? data.edges : [],
    byId,
    baseUrl,
    // Canonical alias map (slug → canonical) from the engine — consolidates
    // duplicate subjects in the By-project lens (sora → project-sora).
    aliases: data && data.aliases ? data.aliases : {},
  };
  renderDecisions();
}

/** Conflicts lens — promotes the contradiction edges with inline confirm/dismiss
 *  (reuses the edge card + HITL). The status filter doesn't apply here. */
function renderConflictsLens(edges, byId, baseUrl) {
  const listEl = document.getElementById("decisions-list");
  const statusEl = document.getElementById("decisions-status");
  const subEl = document.getElementById("decisions-sub");
  const conflicts = (edges || []).filter((e) => e.kind === "contradicts" && e.status !== "dismissed");

  listEl.innerHTML = "";
  if (subEl) {
    subEl.textContent = conflicts.length
      ? `${conflicts.length} ${conflicts.length === 1 ? "conflict" : "conflicts"} to review`
      : "No conflicts";
  }
  if (conflicts.length === 0) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent = "No conflicts detected — decisions and commitments are consistent so far.";
    }
    return;
  }
  if (statusEl) statusEl.hidden = true;
  for (const e of conflicts) listEl.appendChild(renderEdgeCard(e, byId, baseUrl));
}

/** Re-render the grouped list under the active status filter (no re-fetch). */
// ───────── WP-THRESHOLD-STATE-OF-PLAY — per-person send-ready digest ─────────
// Consolidated ONTO the By-Person lens (no new view): the person is already the
// organizing unit here, so the digest is just the "send update" action on them.
// The message itself comes from the engine (/api/person/:slug/state-of-play) —
// single source of truth, identical to the web surface; this layer only places
// the action and copies the result. Default is the instant deterministic
// template; "Polish with AI" opts into the engine LLM reword.
let _sopPolish = false;

function buildSopCopyAllBar(count) {
  const bar = document.createElement("div");
  bar.className = "sop-copyall-bar";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sop-action sop-copyall";
  btn.textContent = `Copy all (${count})`;
  btn.title = "Copy a send-ready update for every person";
  btn.addEventListener("click", () => copyAllStateOfPlay(btn));
  bar.appendChild(btn);
  return bar;
}

function buildSopBar(slug, label) {
  const wrap = document.createElement("div");
  wrap.className = "sop-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sop-action";
  btn.textContent = "State of Play";
  btn.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "sop-panel";
  panel.hidden = true;
  btn.addEventListener("click", () => togglePersonStateOfPlay(slug, label, panel, btn));
  wrap.appendChild(btn);
  wrap.appendChild(panel);
  return wrap;
}

async function togglePersonStateOfPlay(slug, label, panel, btn) {
  if (!panel.hidden) {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  panel.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  await loadPersonStateOfPlay(slug, label, panel);
}

async function loadPersonStateOfPlay(slug, label, panel) {
  panel.innerHTML = '<div class="sop-status">Composing the update…</div>';
  try {
    const res = await tauri.core.invoke("fetch_person_state_of_play", { slug, polish: _sopPolish });
    if (!res || res.available === false) {
      const reason = res && res.reason === "unavailable"
        ? "Summaries aren't available on this server yet."
        : "No open items for " + label + " right now.";
      panel.innerHTML = '<div class="sop-status">' + escapeHtml(reason) + "</div>";
      return;
    }
    renderSopPanel(panel, res, slug, label);
  } catch (err) {
    console.warn("[main] fetch_person_state_of_play failed:", err);
    panel.innerHTML = '<div class="sop-status">Couldn\'t reach Apolla.</div>';
  }
}

function renderSopPanel(panel, data, slug, label) {
  panel.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "sop-toolbar";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sop-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("copy_text", { text: data.message || "" });
      copyBtn.textContent = "Copied ✓";
      copyBtn.disabled = true;
      setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.disabled = false; }, 1600);
    } catch (e) {
      showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." });
    }
  });
  bar.appendChild(copyBtn);

  const polishBtn = document.createElement("button");
  polishBtn.type = "button";
  polishBtn.className = "sop-polish";
  polishBtn.textContent = data.polished ? "Plain text" : "Polish with AI";
  polishBtn.addEventListener("click", async () => {
    _sopPolish = !data.polished;
    await loadPersonStateOfPlay(slug, label, panel);
  });
  bar.appendChild(polishBtn);

  if (data.polished) {
    const tag = document.createElement("span");
    tag.className = "sop-polished-tag";
    tag.textContent = "AI-polished";
    bar.appendChild(tag);
  }
  panel.appendChild(bar);

  const msg = document.createElement("pre");
  msg.className = "sop-message";
  msg.textContent = data.message || "";
  panel.appendChild(msg);
}

async function copyAllStateOfPlay(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Composing…";
  try {
    const res = await tauri.core.invoke("fetch_team_state_of_play");
    const people = res && Array.isArray(res.people) ? res.people : [];
    if (!res || res.available === false || people.length === 0) {
      showToast({ kind: "failure", title: "Nothing to copy", body: "No open items across the team." });
      btn.textContent = orig;
      btn.disabled = false;
      return;
    }
    const text = people.map((p) => p.message).join("\n\n────────\n\n");
    await tauri.core.invoke("copy_text", { text });
    btn.textContent = `Copied ${people.length} ✓`;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1600);
  } catch (e) {
    console.warn("[main] copyAllStateOfPlay failed:", e);
    showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." });
    btn.textContent = orig;
    btn.disabled = false;
  }
}

// WP-THRESHOLD-STATE-OF-PLAY — PROJECT altitude on the By-project lens: the
// team-addressed email PLUS per-teammate "copy individually" chips, on demand.
const _projectPolish = {};

function buildProjectSopBar(slug, label) {
  const wrap = document.createElement("div");
  wrap.className = "sop-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sop-action";
  btn.textContent = "State of Play";
  btn.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "sop-panel";
  panel.hidden = true;
  btn.addEventListener("click", () => {
    if (!panel.hidden) { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); return; }
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    loadProjectStateOfPlay(slug, label, panel);
  });
  wrap.appendChild(btn);
  wrap.appendChild(panel);
  return wrap;
}

async function loadProjectStateOfPlay(slug, label, panel) {
  panel.innerHTML = '<div class="sop-status">Composing the team update…</div>';
  try {
    const res = await tauri.core.invoke("fetch_project_state_of_play", { slug, polish: !!_projectPolish[slug] });
    if (!res || res.available === false) {
      panel.innerHTML = '<div class="sop-status">No open items for ' + label + '.</div>';
      return;
    }
    renderProjectPanel(panel, res, slug, label);
  } catch (err) {
    console.warn("[main] fetch_project_state_of_play failed:", err);
    panel.innerHTML = '<div class="sop-status">Couldn\'t reach Apolla.</div>';
  }
}

function renderProjectPanel(panel, data, slug, label) {
  panel.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "sop-toolbar";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sop-copy";
  copyBtn.textContent = "Copy team email";
  copyBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("copy_text", { text: data.teamMessage || "" });
      copyBtn.textContent = "Copied ✓";
      copyBtn.disabled = true;
      setTimeout(() => { copyBtn.textContent = "Copy team email"; copyBtn.disabled = false; }, 1600);
    } catch (e) { showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." }); }
  });
  bar.appendChild(copyBtn);
  const polishBtn = document.createElement("button");
  polishBtn.type = "button";
  polishBtn.className = "sop-polish";
  polishBtn.textContent = data.teamPolished ? "Plain text" : "Polish with AI";
  polishBtn.addEventListener("click", async () => {
    _projectPolish[slug] = !data.teamPolished;
    await loadProjectStateOfPlay(slug, label, panel);
  });
  bar.appendChild(polishBtn);
  if (data.teamPolished) {
    const t = document.createElement("span");
    t.className = "sop-polished-tag";
    t.textContent = "AI-polished";
    bar.appendChild(t);
  }
  panel.appendChild(bar);

  const msg = document.createElement("pre");
  msg.className = "sop-message";
  msg.textContent = data.teamMessage || "";
  panel.appendChild(msg);

  const people = Array.isArray(data.people) ? data.people : [];
  if (people.length) {
    const sub = document.createElement("div");
    sub.className = "sop-status";
    sub.style.marginTop = "12px";
    sub.textContent = "Or send individually:";
    panel.appendChild(sub);
    const chips = document.createElement("div");
    chips.className = "sop-people-chips";
    for (const p of people) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "sop-people-chip";
      chip.textContent = `Copy ${p.displayName} (${p.openCount})`;
      chip.addEventListener("click", async () => {
        try {
          await tauri.core.invoke("copy_text", { text: p.message || "" });
          const o = chip.textContent;
          chip.textContent = "Copied ✓";
          setTimeout(() => { chip.textContent = o; }, 1400);
        } catch (e) { showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." }); }
      });
      chips.appendChild(chip);
    }
    panel.appendChild(chips);
  }
}

function renderDecisions() {
  const listEl = document.getElementById("decisions-list");
  const statusEl = document.getElementById("decisions-status");
  const subEl = document.getElementById("decisions-sub");
  if (!_decisionsCtx || !listEl) return;
  const { items, docProjects, edges, byId, baseUrl, aliases } = _decisionsCtx;

  // sync the lens selector's pressed state
  for (const btn of document.querySelectorAll(".decisions-lens-btn")) {
    btn.setAttribute("aria-pressed", btn.dataset.lens === _decisionsLens ? "true" : "false");
  }

  // The status filter applies to record lenses only — hide it for Conflicts (edges).
  const filterEl = document.getElementById("decisions-filter");
  if (filterEl) filterEl.hidden = _decisionsLens === "conflicts";

  if (_decisionsLens === "conflicts") {
    renderConflictsLens(edges, byId, baseUrl);
    return;
  }

  for (const btn of document.querySelectorAll(".decisions-filter-btn")) {
    btn.setAttribute("aria-pressed", btn.dataset.state === _decisionsFilter ? "true" : "false");
  }

  const filtered = items.filter((it) =>
    _decisionsFilter === "all" ? true : (it.state || "open") === _decisionsFilter);

  const ordered = groupRecords(filtered, _decisionsLens, docProjects, aliases);

  listEl.innerHTML = "";
  // WP-THRESHOLD-STATE-OF-PLAY — batch "Copy all" lives at the top of the
  // By-Person lens (the one lens where per-person digests make sense).
  if (_decisionsLens === "people") {
    const realCount = ordered.filter((g) => !g.muted).length;
    if (realCount) listEl.appendChild(buildSopCopyAllBar(realCount));
  }
  if (statusEl) {
    if (filtered.length === 0) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent = "No decisions or commitments match this filter.";
    } else {
      statusEl.hidden = true;
    }
  }

  if (subEl) {
    const n = filtered.length;
    const recs = `${n} ${n === 1 ? "record" : "records"}`;
    if (_decisionsLens === "deadline") {
      const overdue = filtered.filter((it) => {
        const r = it.record || it;
        return r.due && new Date(r.due + "T00:00:00") < new Date();
      }).length;
      subEl.textContent = `${recs} · ${overdue} overdue`;
    } else {
      const real = ordered.filter((g) => !g.muted).length;
      const noun = _decisionsLens === "people" ? (real === 1 ? "person" : "people") : (real === 1 ? "project" : "projects");
      subEl.textContent = `${recs} · ${real} ${noun}`;
    }
  }

  for (const grp of ordered) {
    const decisions = grp.items.filter((it) => (it.record ? it.record.type : it.type) === "decision").length;
    const commitments = grp.items.length - decisions;
    const expanded = _decisionsExpanded.has(grp.key);

    const groupEl = document.createElement("div");
    groupEl.className = "decisions-group";

    // Clickable header — collapses/expands the group so the list reads as a
    // scannable overview of groups rather than one long scroll. Default collapsed.
    const head = document.createElement("button");
    head.type = "button";
    head.className = "decisions-group-title";
    head.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (grp.muted) head.dataset.other = "true";

    const chev = document.createElement("span");
    chev.className = "decisions-group-chevron";
    chev.textContent = expanded ? "▾" : "▸";
    chev.setAttribute("aria-hidden", "true");
    head.appendChild(chev);

    const name = document.createElement("span");
    name.className = "decisions-group-name";
    name.textContent = grp.label;
    head.appendChild(name);

    const count = document.createElement("span");
    count.className = "decisions-group-count";
    const parts = [];
    if (decisions) parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`);
    if (commitments) parts.push(`${commitments} commitment${commitments === 1 ? "" : "s"}`);
    count.textContent = parts.join(" · ");
    head.appendChild(count);

    const body = document.createElement("div");
    body.className = "decisions-group-body";
    body.hidden = !expanded;
    // WP-THRESHOLD-STATE-OF-PLAY — the send-ready digest for this person sits at
    // the top of their group (By-Person lens only; never on Unassigned).
    if (_decisionsLens === "people" && !grp.muted) {
      body.appendChild(buildSopBar(grp.key, grp.label));
    } else if (_decisionsLens === "project" && !grp.muted) {
      // Project altitude — the team email + per-teammate digests for this project.
      body.appendChild(buildProjectSopBar(grp.key, grp.label));
    }
    for (const it of grp.items) {
      const rec = it && it.record ? it.record : it;
      if (rec) body.appendChild(renderDecisionCard(rec, it.state, docProjects.get(rec.documentId) || []));
    }

    head.addEventListener("click", () => {
      const willExpand = body.hidden;
      body.hidden = !willExpand;
      head.setAttribute("aria-expanded", willExpand ? "true" : "false");
      chev.textContent = willExpand ? "▾" : "▸";
      if (willExpand) _decisionsExpanded.add(grp.key);
      else _decisionsExpanded.delete(grp.key);
    });

    groupEl.appendChild(head);
    groupEl.appendChild(body);
    listEl.appendChild(groupEl);
  }
}

/** One compact card for the browser: type chip + state, summary, owner · due,
 *  and project chip(s) — the soft facet, always shown for context. */
function renderDecisionCard(rec, recState, projects) {
  const card = document.createElement("div");
  card.className = "record-card decision-card";
  card.dataset.type = rec.type || "";
  if (recState) card.dataset.state = recState;

  const header = document.createElement("div");
  header.className = "record-header";
  const chip = document.createElement("span");
  chip.className = "record-chip";
  chip.dataset.type = rec.type || "";
  chip.textContent = rec.type === "decision" ? "Decision" : "Commitment";
  header.appendChild(chip);
  if (recState && recState !== "open") {
    const pill = document.createElement("span");
    pill.className = "record-state-pill";
    pill.dataset.state = recState;
    pill.textContent = recState === "superseded" ? "Replaced" : "Resolved";
    header.appendChild(pill);
  }
  card.appendChild(header);

  const summary = document.createElement("p");
  summary.className = "record-summary";
  summary.textContent = rec.summary || "";
  card.appendChild(summary);

  const dim = [];
  if (rec.owner) dim.push(prettySlug(rec.owner));
  if (rec.due) dim.push("due " + formatDueDate(rec.due));
  if (dim.length) {
    const meta = document.createElement("p");
    meta.className = "record-meta";
    meta.textContent = dim.join(" · ");
    card.appendChild(meta);
  }

  if (projects && projects.length) {
    const chips = document.createElement("div");
    chips.className = "decision-projects";
    for (const p of projects.slice(0, 3)) {
      const pc = document.createElement("span");
      pc.className = "decision-project-chip";
      pc.textContent = prettySlug(p);
      chips.appendChild(pc);
    }
    card.appendChild(chips);
  }

  // Actions: drill-down to Receipts (when the record has a subject) + Dismiss.
  const actions = document.createElement("div");
  actions.className = "record-actions";
  if (rec.primaryEntity) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-link receipts-entry-btn";
    btn.textContent = "Show receipts →";
    btn.addEventListener("click", () => enterReceiptsView(rec.primaryEntity));
    actions.appendChild(btn);
  }
  appendSourceBadge(actions, rec.documentId, rec.verbatim);
  appendResolveSnoozeControls(actions, rec.recordId, card, rec.summary);
  appendDismissControl(actions, rec.recordId, card, rec.summary);
  card.appendChild(actions);

  return card;
}

// Shared "back to main" — the ⌂ Main buttons across views (WP-DECISION-ORG nav).
function goHome() {
  state.inWizard = false;
  enterMainView(state.lastConfig);
}

// Decisions-view wiring: entry, filter pills, Home / Back / Refresh.
const openDecisionsBtn = document.getElementById("btn-open-decisions");
if (openDecisionsBtn) openDecisionsBtn.addEventListener("click", () => enterDecisionsView(undefined, { from: "home" }));

for (const btn of document.querySelectorAll(".decisions-filter-btn")) {
  btn.addEventListener("click", () => {
    _decisionsFilter = btn.dataset.state || "all";
    renderDecisions();
  });
}

for (const btn of document.querySelectorAll(".decisions-lens-btn")) {
  btn.addEventListener("click", () => {
    _decisionsLens = btn.dataset.lens || "project";
    renderDecisions();
  });
}

const decisionsHomeBtn = document.getElementById("btn-decisions-home");
if (decisionsHomeBtn) decisionsHomeBtn.addEventListener("click", () => goHome());

const decisionsBackBtn = document.getElementById("btn-decisions-back");
if (decisionsBackBtn) decisionsBackBtn.addEventListener("click", () => enterLogView());

const decisionsRefreshBtn = document.getElementById("btn-decisions-refresh");
if (decisionsRefreshBtn) decisionsRefreshBtn.addEventListener("click", () => enterDecisionsView(_decisionsFilter));

// ⌂ Main — shared back-to-home on every sub-view footer (WP-DECISION-ORG nav).
for (const id of ["btn-log-home", "btn-edges-home", "btn-receipts-home", "btn-entity-card-home"]) {
  const b = document.getElementById(id);
  if (b) b.addEventListener("click", () => goHome());
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
  await loadDocsMap(); // docId→source map for badges (cached after first load)
  setNav(
    [
      { label: "Today", go: () => enterLogView() },
      { label: "Receipts · " + prettySlug(entity) },
    ],
    { back: () => enterLogView() },
  );

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

  // Source — opens the captured document in the in-app reader, BESIDE the chain
  // (no browser round-trip). The source-type badge is the affordance when doc
  // metadata is loaded; otherwise a plain "source ↗" button that still opens it.
  if (rec.documentId) {
    const chip = renderSourceBadge(rec.documentId, rec.verbatim);
    if (chip) {
      body.appendChild(chip);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rec-source";
      btn.textContent = "source ↗";
      btn.addEventListener("click", () => openSourcePanel(rec.documentId, rec.verbatim));
      body.appendChild(btn);
    }
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
  setNav([{ label: "Plaud Sync Queue" }], { back: () => goHome() });
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
  setNav([{ label: "OneNote" }], { back: () => goHome() });
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
              cta.action || ""
            )}">${escapeHtml(cta.label)}</button>`
          : ""
      }
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss">✕</button>
  `;

  toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(id));
  if (cta) {
    toast.querySelector(".toast-cta").addEventListener("click", () => {
      if (typeof cta.onClick === "function") {
        try {
          cta.onClick();
        } catch (e) {
          console.warn("toast CTA onClick failed:", e);
        }
      } else {
        console.log("toast CTA clicked:", cta);
      }
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
  setNav([{ label: "Sources" }], { back: () => goHome() });

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
  setNav([{ label: "Auto-import" }], { back: () => goHome() });
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
  // WP-THRESHOLD-APP-AUTH — email magic-link sign-in (the first-run welcome).
  // Submitting the form requests a link; "Advanced" drops to the manual
  // base-URL + bearer Configure path (local dev + Ross's shared-key setup).
  const loginForm = document.getElementById("login-form");
  if (loginForm) loginForm.addEventListener("submit", handleLoginRequest);
  const loginUseTokenBtn = document.getElementById("btn-login-use-token");
  if (loginUseTokenBtn) loginUseTokenBtn.addEventListener("click", enterWizardConfigure);
  const loginResendBtn = document.getElementById("btn-login-resend");
  if (loginResendBtn) loginResendBtn.addEventListener("click", handleLoginResend);
  const loginChangeEmailBtn = document.getElementById("btn-login-change-email");
  if (loginChangeEmailBtn) loginChangeEmailBtn.addEventListener("click", handleLoginChangeEmail);

  // Wizard
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
