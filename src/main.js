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

import {
  ROUTINES,
  loadRoutines,
  saveRoutines,
  composeRoutineSetupMessage,
  derivePrepTime,
  tzOffsetMinutes,
} from "./routines.js";

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
  // WP-CASCADE-PRODUCTION WP-T1 — Proxy-fleet inbox queue
  "view-proxy-queue",
  // WP-ONENOTE-EXPORT-04 — OneNote Browse
  "view-onenote-browse",
  // WP-THRESHOLD-LOG-UX — "Today" decision/commitment-log view
  "view-log",
  // WP-VIGILANCE-VOID — "Watching for…" vigilance-void surface
  "view-watching",
  // WP-THRESHOLD-LOG-UX — Receipts (the evidence dossier)
  "view-receipts",
  // WP-THRESHOLD-LOG-UX — Connections (grounded cross-record edges)
  "view-edges",
  // WP-THRESHOLD-LOG-UX — per-entity Definition card
  "view-entity-card",
  // WP-THRESHOLD-DECISION-ORG — Decisions browser (by project, filterable)
  "view-decisions",
  // WP-THRESHOLD-NAV Increment 2 — per-project landing surface (aggregates one
  // project's SoP + records + relationships). Registered so showView() can un-hide it.
  "view-project-home",
  // WP-Outlook-Writeback — staged Outbox surface (registered here so showView()
  // can actually un-hide it; without this the view stays hidden = blank screen).
  "view-outbox",
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
  watching: () => enterWatchingView(),
  log: () => enterDecisionsView(undefined, { from: "home" }),
  outbox: () => enterOutboxView(),
  edges: () => enterEdgesView(),
  settings: () => enterStandaloneConfigure(),
};

// WP-R0 — nav visibility gate. Retired destinations are HIDDEN from nav +
// all entry points, but their views/routes remain fully intact and return
// the moment a flag flips (or debug re-entry is enabled). Absent key = visible.
const VIEW_VISIBILITY = { watching: false, outbox: false, edges: false };

// Debug re-entry: append #debug-views (or #debugviews) to the window's URL
// hash, or run `localStorage.setItem("threshold.debugViews", "1")` in the
// devtools console, then reload. Either makes every gated view visible again
// without touching VIEW_VISIBILITY. Checked once at module eval — reload to
// pick up a change.
const VIEW_DEBUG =
  /(^|[?&#])debug-?views(=1)?([&#]|$)/i.test(window.location.hash) ||
  (() => {
    try {
      return localStorage.getItem("threshold.debugViews") === "1";
    } catch {
      return false;
    }
  })();

/** Is nav destination `dest` visible right now (flag map + debug override)? */
function isDestVisible(dest) {
  return VIEW_DEBUG || VIEW_VISIBILITY[dest] !== false;
}

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
    // WP-R0 — retired destinations are hidden from the bar entirely and never
    // wired, so there's no dead/clickable button left behind.
    if (!isDestVisible(b.dataset.dest)) {
      b.setAttribute("hidden", "");
      continue;
    }
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

  // WP-WINDOW — overlay-titlebar affordance. On macOS the expanded window
  // uses the Overlay titlebar style (transparent titlebar, inline traffic
  // lights over our own glass). Tag <body> so the sticky #app-nav gains extra
  // top-left padding and its content clears the traffic-light cluster (see
  // .titlebar-overlay .app-nav in styles.css). WKWebView's UA reliably carries
  // "Macintosh"; other platforms keep standard decorations and no offset.
  // (Reinstated 2026-07-07 with the D2 fix — the 07-06 "confused chrome" was
  // the styleMask race, fixed in #102; the Rust side re-asserts Overlay after
  // the async mask writes settle.)
  if (/Macintosh|Mac OS X/.test(navigator.userAgent || "")) {
    document.body.classList.add("titlebar-overlay");
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
    if (window.location.hash.startsWith("#log")) {
      enterLogView();
      // Deep-link from the check-in brief: #log?doc=<id> opens the record's source
      // in the right pane, so Today lands on the item WITH its source alongside
      // (Ross UAT 2026-07-10). openSourcePanel fetches the doc itself; fired after
      // the view begins painting.
      const _qi = window.location.hash.indexOf("?");
      if (_qi >= 0) {
        const _doc = new URLSearchParams(window.location.hash.slice(_qi + 1)).get("doc");
        if (_doc) setTimeout(() => { try { openSourcePanel(_doc, null); } catch (_e) { console.warn("[main] deep-link source:", _e); } }, 0);
      }
      return;
    }

    // WP-THRESHOLD-LOG-UX — #edges once rendered the full cross-record edge graph.
    // WP-R0 — retired: with the flag off (and no debug override) this hash falls
    // through to the main view instead of entering a nav-orphaned view. WP-R3
    // item 4 — the tray has no "Connections…" item either (hide-by-omission in
    // build_widget_menu, lib.rs), so nothing fires widget_expand("edges") now;
    // this is the JS-side half of keeping that retired destination unreachable.
    if (window.location.hash === "#edges" && isDestVisible("edges")) {
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

    // WP-CASCADE-PRODUCTION WP-T1 — widget_expand("proxy-queue") (the ambient
    // amber proxy badge or the right-click menu) navigates here with
    // #proxy-queue. Render the proxy-fleet inbox.
    if (window.location.hash === "#proxy-queue") {
      enterProxyQueueView();
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
    // Expired / invalid / already-used token, or an offline verify. Never leave
    // the user in a dead state: if the check-inbox view is up, surface the
    // reason inline there; otherwise send them back to a clean email-entry
    // screen (the magic link can arrive while the user is anywhere in the app)
    // and show the error there so they can request a fresh link.
    const inboxView = document.getElementById("view-check-inbox");
    const onInbox = inboxView && !inboxView.hasAttribute("hidden");
    if (onInbox) {
      showLoginResult("check-inbox-result", false, String(err));
    } else {
      enterWizardWelcome(state.lastConfig || undefined);
      showLoginResult("login-result", false, "That sign-in link didn't work — it may have expired or already been used. Enter your email to get a new one.");
    }
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
  // Wizard = linear single-column form (no group rail); only the Connection
  // panel is relevant during onboarding.
  setSettingsMode("wizard");
  switchSettingsPanel("connection");
  showView("view-configure");
  hideNav();
  document.getElementById("config-base-url").focus();
}

// Toggle the Configure view between the linear wizard form and the
// standalone two-pane Settings layout via a class on the form.
function setSettingsMode(mode) {
  const form = document.getElementById("configure-form");
  if (!form) return;
  form.classList.toggle("is-wizard", mode === "wizard");
  form.classList.toggle("is-settings", mode === "settings");
}

// Master-detail: activate the named settings group (left rail) and show its
// detail panel on the right.
function switchSettingsPanel(name) {
  for (const item of document.querySelectorAll(".settings-nav-item")) {
    item.classList.toggle("is-active", item.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll(".settings-panel")) {
    panel.classList.toggle("is-active", panel.dataset.panel === name);
  }
  // Privacy panel is lazy — fetch the live posture from the engine on open.
  if (name === "privacy") renderSovereignty();
  // Email-capture panel is lazy too — GET /api/email/capture on open (WP-EM1b).
  if (name === "email-capture") renderEmailCapture();
  // The Integrations panel's AI-platforms section is lazy too — GET
  // /api/mcp/grants on open (WP-MCP-V2 Phase C).
  if (name === "integrations") {
    renderAiConnections();
    renderIntegrationDoctor();
    // Routines: re-read the engine's unattended-pass schedule on open so the
    // card's captions always show verified workspace state.
    refreshRoutineEngineState();
  }
}

// ── Connections doctor (WP-ONBOARD) ──
// One card per channel at the top of Settings → Integrations, driven by the
// integration_doctor IPC probes. States: ready (flowing) / action (one step,
// button on the card) / blocked (org or platform says no — say so and name
// the fallback, never hide). Every action ends by re-rendering, so the cards
// always reflect probed truth rather than optimistic UI state.
let doctorRenderInFlight = false;

// Session + cross-restart memory of the local calendar probe. TCC only
// prompts the FIRST time — once the grant flag is set, re-running the live
// probe at render time is silent (granted ⇒ quiet success; later revoked ⇒
// quiet typed error), so the card stays truthful without ever ambushing.
const CAL_GRANT_KEY = "thresholdCalendarProbeGranted";
let lastCalendarProbe = null;
let doctorRenderQueued = false;

async function renderIntegrationDoctor() {
  const body = document.getElementById("integration-doctor-body");
  if (!body) return;
  // Never DROP a render: if one is mid-flight, queue exactly one trailing
  // re-run (a dropped render is how the cards silently go stale).
  if (doctorRenderInFlight) {
    doctorRenderQueued = true;
    return;
  }
  doctorRenderInFlight = true;
  let step = "probes";
  try {
    const report = await tauri.core.invoke("integration_doctor");
    // ICS status only matters when the engine is reachable with the lane on.
    let ics = null;
    if (report?.engine?.state === "reachable" && report?.engine?.availabilityLaneEnabled) {
      step = "calendar-link status";
      try { ics = await tauri.core.invoke("ics_source_status"); } catch { /* card falls back to local-only */ }
    }
    // Previously-granted local calendar: refresh the live state silently.
    if (!lastCalendarProbe && report?.calendarLocal?.readerPresent && localStorage.getItem(CAL_GRANT_KEY)) {
      step = "calendar refresh";
      try { lastCalendarProbe = await tauri.core.invoke("probe_calendar_live"); } catch { /* keep silent-unknown */ }
    }
    step = "render";
    const stamp = document.createElement("p");
    stamp.className = "doctor-card-detail";
    stamp.textContent = `Checked ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    body.replaceChildren(...buildDoctorCards(report, ics), stamp);
  } catch (err) {
    console.error("[doctor] render failed at", step, err);
    body.replaceChildren(doctorNote("err", `Couldn't check connections (${step}): ${err}`));
  } finally {
    doctorRenderInFlight = false;
    if (doctorRenderQueued) {
      doctorRenderQueued = false;
      renderIntegrationDoctor();
    }
  }
}

function doctorRelTime(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr}h ago` : `${Math.round(hr / 24)}d ago`;
}

function doctorCard({ name, detail, pill, pillState, actions = [] }) {
  const card = document.createElement("div");
  card.className = "doctor-card";
  card.dataset.state = pillState;

  const row = document.createElement("div");
  row.className = "doctor-card-row";

  const main = document.createElement("div");
  main.className = "doctor-card-main";
  const nameEl = document.createElement("p");
  nameEl.className = "doctor-card-name";
  nameEl.textContent = name;
  const detailEl = document.createElement("p");
  detailEl.className = "doctor-card-detail";
  detailEl.textContent = detail;
  main.append(nameEl, detailEl);

  const pillEl = document.createElement("span");
  pillEl.className = "doctor-pill";
  pillEl.dataset.state = pillState;
  pillEl.textContent = pill;

  const actionsEl = document.createElement("div");
  actionsEl.className = "doctor-card-actions";
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = a.link ? "btn-inline-link" : `btn ${a.primary ? "btn-primary" : "btn-secondary"} btn-compact`;
    btn.textContent = a.label;
    btn.addEventListener("click", () => a.onClick(card, btn));
    actionsEl.appendChild(btn);
  }

  row.append(main, actionsEl, pillEl);
  card.appendChild(row);
  return card;
}

function doctorNote(kind, text) {
  const p = document.createElement("p");
  p.className = "doctor-note";
  p.dataset.kind = kind;
  p.textContent = text;
  return p;
}

function buildDoctorCards(report, ics) {
  const cards = [];
  if (report?.engine?.state !== "reachable") {
    cards.push(doctorNote(
      "warn",
      "Not connected to your workspace yet — set the connection first. Below is only what this computer can do on its own.",
    ));
  }
  cards.push(buildCalendarCard(report, ics));
  cards.push(buildEmailFilesCard(report));
  cards.push(buildTeamsCard(report));
  cards.push(buildPlaudCard(report));
  cards.push(buildOneNoteCard(report));
  cards.push(buildJumpstartCard(report));
  return cards;
}

// Teams channel messages ride the same OneDrive file pipeline as email —
// one flow per channel, built from the generated recipe. Presence signal is
// the doctor's teams receipt count (first message lands ⇒ green); no Teams
// API is ever probed.
function buildTeamsCard(report) {
  const mail = report?.onedriveMail ?? {};
  const teamsCount = mail.teamsProcessedCount ?? 0;

  if (teamsCount > 0) {
    return doctorCard({
      name: "Teams channels",
      detail: `Flowing from your Teams flows · ${teamsCount} ${teamsCount === 1 ? "message" : "messages"} imported so far`,
      pill: "Ready",
      pillState: "ready",
      actions: [{ label: "Add a channel", link: true, onClick: (card) => openTeamsSetup(card, mail) }],
    });
  }

  if (mail.state !== "ready") {
    const noOneDrive = !(report?.oneDriveRoot?.found);
    return doctorCard({
      name: "Teams channels",
      detail: noOneDrive
        ? "Needs OneDrive on this computer (same as Email). Channel messages can still be captured on your work PC."
        : "Set up Email first — Teams messages ride the same capture folder.",
      pill: noOneDrive ? "Unavailable" : "After email",
      pillState: "blocked",
    });
  }

  return doctorCard({
    name: "Teams channels",
    detail: "Pick a channel and build its flow from the recipe — a minute each. Turns green when the first message lands.",
    pill: "1 min each",
    pillState: "action",
    actions: [{ label: "Set up", primary: true, onClick: (card) => openTeamsSetup(card, mail) }],
  });
}

async function openTeamsSetup(card, mail) {
  try {
    const parent = (mail?.folder || "").replace(/[\\/]mail[\\/]?$/, "");
    if (!parent) return;
    const pkg = await tauri.core.invoke("generate_flow_package", { destDir: parent });
    const links = await tauri.core.invoke("integration_doctor_links");
    try { await tauri.core.invoke("plugin:opener|open_url", { url: links.powerAutomateImport }); } catch { /* note carries it */ }
    card.querySelector(".doctor-expand")?.remove();
    const expand = document.createElement("div");
    expand.className = "doctor-expand";
    expand.appendChild(doctorNote("ok",
      "Recipe refreshed in your OneDrive (Apps/Threshold — see TEAMS-RECIPE). In Power Automate: build the channel's flow from the recipe, turn it on, then post something in the channel. This card turns green when the message arrives."));
    const row = document.createElement("div");
    row.className = "doctor-expand-row";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-secondary btn-compact";
    copyBtn.textContent = "Copy recipe location";
    copyBtn.addEventListener("click", async () => {
      try { await tauri.core.invoke("copy_text", { text: pkg?.recipePath || parent }); copyBtn.textContent = "Copied"; } catch { /* non-fatal */ }
    });
    row.appendChild(copyBtn);
    expand.appendChild(row);
    card.appendChild(expand);
  } catch (err) {
    showToast({ kind: "error", title: "Couldn't prepare the Teams recipe", body: String(err) });
  }
}

// One-time cold-start booster. Completion is user-declared ("Mark done") —
// there is no reliable machine signal for "the backfill flow ran", and the
// receipts surface in check-ins either way. Older items file as background
// context (engine recency gate), never as overdue to-dos.
const JUMPSTART_DONE_KEY = "thresholdJumpstartDone";

function buildJumpstartCard(report) {
  const mail = report?.onedriveMail ?? {};

  if (localStorage.getItem(JUMPSTART_DONE_KEY)) {
    return doctorCard({
      name: "Jump-start",
      detail: "Backfill imported — older items are filed as background context, and everything is searchable.",
      pill: "Done",
      pillState: "ready",
    });
  }

  if (mail.state !== "ready") {
    const noOneDrive = !(report?.oneDriveRoot?.found);
    return doctorCard({
      name: "Jump-start",
      detail: noOneDrive
        ? "Warm up your field with your last 30 days — runs from the machine where Email is set up."
        : "Warm up your field with your last 30 days. Available after Email is set up.",
      pill: noOneDrive ? "Unavailable" : "After email",
      pillState: "blocked",
    });
  }

  return doctorCard({
    name: "Jump-start",
    detail: "Import your last 30 days (Sent mail recommended) so Threshold is useful on day one. Runs once in the background — older items file as context, not to-dos.",
    pill: "10 min · once",
    pillState: "action",
    actions: [{ label: "Jump-start", primary: true, onClick: (card) => openJumpstartSetup(card, mail) }],
  });
}

async function openJumpstartSetup(card, mail) {
  try {
    const parent = (mail?.folder || "").replace(/[\\/]mail[\\/]?$/, "");
    if (!parent) return;
    const pkg = await tauri.core.invoke("generate_flow_package", { destDir: parent });
    const links = await tauri.core.invoke("integration_doctor_links");
    try { await tauri.core.invoke("plugin:opener|open_url", { url: links.powerAutomateImport }); } catch { /* note carries it */ }
    card.querySelector(".doctor-expand")?.remove();
    const expand = document.createElement("div");
    expand.className = "doctor-expand";
    expand.appendChild(doctorNote("ok",
      "Recipe refreshed in your OneDrive (Apps/Threshold — see BACKFILL-RECIPE). In Power Automate: build \"Threshold backfill — Sent mail 30d\", run it once, then delete it. Optional: the all-mail and Teams-history variants. Receipts show up in your check-ins as items land."));
    const row = document.createElement("div");
    row.className = "doctor-expand-row";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-secondary btn-compact";
    copyBtn.textContent = "Copy recipe location";
    copyBtn.addEventListener("click", async () => {
      try { await tauri.core.invoke("copy_text", { text: pkg?.recipePath || parent }); copyBtn.textContent = "Copied"; } catch { /* non-fatal */ }
    });
    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "btn btn-primary btn-compact";
    doneBtn.textContent = "Mark done";
    doneBtn.addEventListener("click", () => {
      localStorage.setItem(JUMPSTART_DONE_KEY, "1");
      renderIntegrationDoctor();
    });
    row.append(copyBtn, doneBtn);
    expand.appendChild(row);
    card.appendChild(expand);
  } catch (err) {
    showToast({ kind: "error", title: "Couldn't prepare the backfill recipe", body: String(err) });
  }
}

function buildCalendarCard(report, ics) {
  const cal = report?.calendarLocal ?? {};
  const icsConfigured = !!ics?.configured;

  // Best working transport wins the headline.
  if (icsConfigured && !ics?.lastError) {
    return doctorCard({
      name: "Calendar",
      detail: ics?.lastPolledAt
        ? `Flowing via your shared calendar link · last checked ${doctorRelTime(ics.lastPolledAt)}`
        : "Shared calendar link saved — first check runs within 30 minutes.",
      pill: "Ready",
      pillState: "ready",
      actions: [{ label: "Change link", link: true, onClick: (card) => toggleIcsExpand(card) }],
    });
  }

  // Local probe already succeeded (this session, or a remembered grant).
  if (lastCalendarProbe?.state === "works") {
    const n = lastCalendarProbe.eventCount ?? 0;
    return doctorCard({
      name: "Calendar",
      detail: `Reads this computer's calendar · ${n} upcoming ${n === 1 ? "event" : "events"} found`,
      pill: "Ready",
      pillState: "ready",
    });
  }

  const probeFailed = lastCalendarProbe && lastCalendarProbe.state !== "works";
  const actions = [];
  let detail;
  let pill = "1 step";

  const runLiveProbe = async (card, btn) => {
    btn.disabled = true;
    btn.textContent = "Asking…";
    try {
      lastCalendarProbe = await tauri.core.invoke("probe_calendar_live");
      if (lastCalendarProbe?.state === "works") {
        localStorage.setItem(CAL_GRANT_KEY, "1");
        showToast({ kind: "success", title: "Calendar connected", body: `Found ${lastCalendarProbe.eventCount ?? 0} upcoming events.` });
      }
    } catch (err) {
      lastCalendarProbe = { state: "error", note: String(err) };
    }
    renderIntegrationDoctor();
  };

  if (cal.readerPresent && !probeFailed) {
    detail = "Threshold can read the calendar on this computer. It will ask for access once.";
    actions.push({ label: "Allow access", primary: true, onClick: runLiveProbe });
  } else if (cal.readerPresent && probeFailed) {
    detail = lastCalendarProbe.state === "permissionNeeded"
      ? "Access was declined. Enable Threshold under System Settings → Privacy & Security → Automation, then try again — or use a shared calendar link."
      : "The calendar couldn't be read on this computer. Try again — or use a shared calendar link instead.";
    actions.push({ label: "Try again", primary: true, onClick: runLiveProbe });
    actions.push({ label: "Use a shared link", link: true, onClick: (card) => toggleIcsExpand(card) });
  } else {
    pill = "1 min";
    detail = icsConfigured && ics?.lastError
      ? "Your shared calendar link stopped working — publish a fresh one and paste it here."
      : "No local calendar on this computer. Publish a busy-times link from Outlook on the web and paste it here.";
    actions.push({ label: "Add calendar link", primary: true, onClick: (card) => toggleIcsExpand(card) });
  }

  return doctorCard({ name: "Calendar", detail, pill, pillState: "action", actions });
}

function toggleIcsExpand(card) {
  const existing = card.querySelector(".doctor-expand");
  if (existing) { existing.remove(); return; }
  const expand = document.createElement("div");
  expand.className = "doctor-expand";
  const row = document.createElement("div");
  row.className = "doctor-expand-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://outlook.office365.com/owa/calendar/…/calendar.ics";
  input.setAttribute("aria-label", "Published calendar ICS link");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn btn-primary btn-compact";
  add.textContent = "Save link";
  add.addEventListener("click", async () => {
    const url = input.value.trim();
    if (!url) return;
    add.disabled = true;
    add.textContent = "Checking…";
    try {
      await tauri.core.invoke("ics_source_set", { icsUrl: url });
      showToast({ kind: "success", title: "Calendar link saved", body: "Busy times sync every 30 minutes — laptop open or closed." });
      renderIntegrationDoctor();
    } catch (err) {
      add.disabled = false;
      add.textContent = "Save link";
      expand.querySelector(".doctor-note")?.remove();
      expand.appendChild(doctorNote("err", `That link didn't validate: ${err}`));
    }
  });
  row.append(input, add);
  const help = document.createElement("p");
  help.className = "doctor-card-detail";
  help.textContent = "Outlook on the web → Settings → Calendar → Shared calendars → publish \"Can view when I'm busy\", then paste the ICS link. Only busy times are shared — never titles.";
  expand.append(row, help);
  card.appendChild(expand);
  input.focus();
}

function buildEmailFilesCard(report) {
  const mail = report?.onedriveMail ?? {};
  const root = report?.oneDriveRoot ?? {};

  if (mail.state === "ready") {
    const imported = mail.processedCount ?? 0;
    const failed = mail.failedCount ?? 0;
    return doctorCard({
      name: "Email",
      detail: failed > 0
        ? `Flowing from your mail flows · ${imported} imported · ${failed} set aside for review`
        : `Flowing from your mail flows · ${imported} imported so far`,
      pill: "Ready",
      pillState: "ready",
      actions: [{ label: "Setup guide", link: true, onClick: (card, btn) => regenerateFlowRecipe(mail) }],
    });
  }

  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  if (!root.found || candidates.length === 0) {
    return doctorCard({
      name: "Email",
      detail: "OneDrive isn't set up on this computer. Email still arrives via your capture address (see Email capture).",
      pill: "Unavailable",
      pillState: "blocked",
    });
  }

  const business = candidates.find((c) => c.kind === "business") ?? candidates[0];
  return doctorCard({
    name: "Email",
    detail: "One-minute setup: Threshold prepares a folder in your OneDrive and hands you the two mail flows. Turns green on its own when the first email lands.",
    pill: "1 min",
    pillState: "action",
    actions: [{
      label: "Set up",
      primary: true,
      onClick: async (card, btn) => {
        btn.disabled = true;
        btn.textContent = "Preparing…";
        try {
          const prepared = await tauri.core.invoke("onedrive_prepare_mail_folder", { root: business.path });
          const parent = (prepared?.folder || "").replace(/[\\/]mail[\\/]?$/, "");
          const pkg = await tauri.core.invoke("generate_flow_package", { destDir: parent || business.path });
          const links = await tauri.core.invoke("integration_doctor_links");
          try { await tauri.core.invoke("plugin:opener|open_url", { url: links.powerAutomateImport }); } catch { /* note carries the pointer */ }
          card.querySelector(".doctor-expand")?.remove();
          const expand = document.createElement("div");
          expand.className = "doctor-expand";
          expand.appendChild(doctorNote("ok",
            "Folder ready. The flow recipe is saved in your OneDrive (Apps/Threshold) — right there in the browser too. Build the two flows per the recipe, turn them on, then send yourself an email. This card turns green when it arrives."));
          const copyRow = document.createElement("div");
          copyRow.className = "doctor-expand-row";
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "btn btn-secondary btn-compact";
          copyBtn.textContent = "Copy recipe location";
          copyBtn.addEventListener("click", async () => {
            try {
              await tauri.core.invoke("copy_text", { text: pkg?.recipePath || parent });
              copyBtn.textContent = "Copied";
            } catch { /* non-fatal */ }
          });
          copyRow.appendChild(copyBtn);
          expand.append(copyRow);
          card.appendChild(expand);
          btn.remove();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Set up";
          showToast({ kind: "error", title: "Couldn't prepare the folder", body: String(err) });
        }
      },
    }],
  });
}

async function regenerateFlowRecipe(mail) {
  try {
    const parent = (mail?.folder || "").replace(/[\\/]mail[\\/]?$/, "");
    if (!parent) return;
    const pkg = await tauri.core.invoke("generate_flow_package", { destDir: parent });
    await tauri.core.invoke("copy_text", { text: pkg?.recipePath || parent });
    showToast({ kind: "success", title: "Setup guide refreshed", body: "Recipe regenerated in OneDrive (Apps/Threshold); its location is on your clipboard." });
  } catch (err) {
    showToast({ kind: "error", title: "Couldn't regenerate the guide", body: String(err) });
  }
}

function buildPlaudCard(report) {
  const plaud = report?.plaud ?? {};
  if (plaud.state === "connected") {
    return doctorCard({
      name: "Plaud recordings",
      detail: "Connected — new recordings enter your field within about 30 minutes.",
      pill: "Ready",
      pillState: "ready",
    });
  }
  return doctorCard({
    name: "Plaud recordings",
    detail: "Connect your recorder and new recordings flow in on their own.",
    pill: "1 step",
    pillState: "action",
    actions: [{
      label: "Connect",
      primary: true,
      onClick: () => {
        document.getElementById("connection-plaud")?.scrollIntoView({ behavior: "smooth", block: "center" });
        document.getElementById("btn-plaud-connect")?.focus();
      },
    }],
  });
}

function buildOneNoteCard(report) {
  const on = report?.oneNoteCom ?? {};
  if (on.state === "available") {
    return doctorCard({
      name: "OneNote",
      detail: "Ready — designated notebooks sweep in automatically; the hotkey sends the page you're on.",
      pill: "Ready",
      pillState: "ready",
    });
  }
  if (on.state === "notApplicable") {
    return doctorCard({
      name: "OneNote",
      detail: "Windows only. On this computer, notes still arrive via email capture.",
      pill: "Unavailable",
      pillState: "blocked",
    });
  }
  return doctorCard({
    name: "OneNote",
    detail: "OneNote desktop wasn't found on this computer. Notes still arrive via email capture.",
    pill: "Unavailable",
    pillState: "blocked",
  });
}

// Renders the read-only "where does my data go" posture into #privacy-body,
// fetched live from the engine's GET /api/sovereignty (via the get_sovereignty
// IPC command). Deployment-level today; the .privacy-future block is the home
// for a future per-user selector.
async function renderSovereignty() {
  const body = document.getElementById("privacy-body");
  if (!body) return;
  const baseUrl = document.getElementById("config-base-url").value.trim();
  const bearerToken = document.getElementById("config-bearer-token").value.trim();
  if (!baseUrl) {
    body.innerHTML =
      '<p class="field-help">Enter your Apolla base URL on the Connection tab to see where your data is processed.</p>';
    return;
  }
  body.innerHTML = '<p class="field-help">Checking where your data is processed…</p>';

  let s;
  try {
    s = await tauri.core.invoke("get_sovereignty", { baseUrl, bearerToken: bearerToken || null });
  } catch (err) {
    body.innerHTML =
      '<p class="field-help privacy-error">Couldn\'t read sovereignty status: ' +
      escapeHtml(String(err)) +
      "</p>";
    return;
  }

  const POSTURE_CLASS = { "on-prem": "is-sovereign", hybrid: "is-hybrid", cloud: "is-cloud", mixed: "is-hybrid", unconfigured: "is-unconfigured" };
  const cls = POSTURE_CLASS[s.posture] || "is-cloud";
  const lockIcon = s.posture === "on-prem"
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1V7a5 5 0 0 0-9.6-2"></path><rect x="3" y="10" width="18" height="11" rx="2"></rect></svg>';

  const surfaceRow = (label, surf) => {
    const where = surf.dataLeavesOrg
      ? '<span class="privacy-chip is-cloud">Cloud</span>'
      : '<span class="privacy-chip is-sovereign">Your infrastructure</span>';
    return (
      '<div class="privacy-surface">' +
      '<div class="privacy-surface-main"><span class="privacy-surface-label">' +
      escapeHtml(label) +
      '</span><span class="privacy-surface-model">' +
      escapeHtml(surf.model) +
      "</span></div>" +
      where +
      "</div>"
    );
  };

  let html =
    '<div class="privacy-banner ' + cls + '">' +
    '<span class="privacy-banner-icon">' + lockIcon + "</span>" +
    '<div><p class="privacy-banner-headline">' + escapeHtml(s.headline) + "</p>" +
    (s.tier ? '<p class="privacy-banner-sub">Tier: ' + escapeHtml(s.tier) + "</p>" : "") +
    "</div></div>";

  // A deployment with no AI provider configured isn't a cloud posture — it
  // isn't processing anything. Say that plainly instead of listing default
  // models that aren't running.
  if (s.posture === "unconfigured") {
    html +=
      '<p class="privacy-caveat">⚠ No AI provider is configured on this workspace yet, ' +
      "so your documents aren't being processed. Ask your administrator to finish setup.</p>";
    body.innerHTML = html;
    return;
  }

  html +=
    '<div class="privacy-surfaces">' +
    surfaceRow("Generation (synthesis, cards, insights)", s.surfaces.generation) +
    surfaceRow("Extraction / ingestion (your documents)", s.surfaces.extraction) +
    surfaceRow("Query understanding", s.surfaces.query) +
    // The semantic index is a fourth data channel: record summaries are
    // embedded, and with a cloud provider (Voyage) those vectors leave the
    // org — this row is what explains a missing "fully sovereign" checkmark.
    // Older engines don't report it; disabled/inert embeddings move no data.
    (s.embeddings && s.embeddings.enabled
      ? surfaceRow("Semantic index (embeddings)", {
          model: s.embeddings.modelId || s.embeddings.provider || "embeddings",
          dataLeavesOrg: s.embeddings.dataLeavesOrg,
        })
      : "") +
    "</div>";

  if (s.localEndpoint) {
    html +=
      '<p class="field-help">On-prem server: <code>' + escapeHtml(s.localEndpoint) + "</code></p>";
  }

  if (Array.isArray(s.pinnedToCloud) && s.pinnedToCloud.length) {
    html +=
      '<p class="privacy-caveat">⚠ ' +
      s.pinnedToCloud.length +
      " advanced surface(s) still use the cloud (live-streaming features that can't run on-prem yet): <code>" +
      s.pinnedToCloud.map((v) => escapeHtml(v)).join("</code>, <code>") +
      "</code>.</p>";
  } else if (s.fullySovereign) {
    html += '<p class="privacy-caveat is-good">✓ Every surface runs on your own infrastructure.</p>';
  }

  body.innerHTML = html;
}

// ───────── Email capture (WP-EM1b) ─────────
// Self-service configuration for the email on-ramp. Renders into
// #email-capture-body, lazily on panel open. Three calm states, never blank:
//   • not enabled (404 / older engine)   → explainer only
//   • enabled, no address                → "Create my capture address"
//   • enabled + address                  → the main card (copy / rotate / senders)
// Every mutation refreshes via a re-GET (no optimistic state). Product copy is
// plain: no "bearer", "local-part", or "webhook" on the card face.

const CAPTURE_DOMAIN_FALLBACK = "in.viktora.ai";

async function renderEmailCapture() {
  const body = document.getElementById("email-capture-body");
  if (!body) return;
  body.innerHTML = '<p class="field-help">Loading…</p>';

  let data;
  try {
    data = await tauri.core.invoke("fetch_email_capture");
  } catch (err) {
    // A hard transport/auth failure — still calm, still actionable (retry).
    body.innerHTML =
      '<p class="field-help ec-error">Couldn\'t reach your workspace: ' +
      escapeHtml(String(err)) +
      '</p><div class="ec-actions"><button type="button" class="btn btn-secondary" id="ec-retry">Try again</button></div>';
    const retry = document.getElementById("ec-retry");
    if (retry) retry.addEventListener("click", () => renderEmailCapture());
    return;
  }

  // Not enabled on this workspace (flag off / older engine): calm explainer.
  if (!data || data.available === false || data.enabled !== true) {
    body.innerHTML =
      '<p class="field-help">Email capture isn\'t enabled for this workspace yet.</p>';
    return;
  }

  const domain = data.domain || CAPTURE_DOMAIN_FALLBACK;
  const addresses = Array.isArray(data.addresses) ? data.addresses : [];
  const active = addresses.find((a) => a && a.active);
  const senders = Array.isArray(data.senders) ? data.senders : [];

  // Enabled, but no address minted yet: explainer + create button. The server
  // resolves the owner from the signed-in identity when present; the bearer
  // lane has none (whoami → null), so there we ask for the owner email inline —
  // specifically the address the user will forward FROM, since that is what the
  // sender allowlist matches against.
  if (!active) {
    let viewerEmail = null;
    try { viewerEmail = await getViewerEmail(); } catch (_e) { /* optional */ }

    body.innerHTML =
      '<p class="field-help">Create a private capture address for this workspace. ' +
      "BCC or forward any email to it and Threshold files what it finds, then replies " +
      "with a receipt.</p>" +
      (viewerEmail
        ? ""
        : '<div class="ec-add-sender">' +
          '<input type="email" class="ec-sender-input" id="ec-owner-email" ' +
          'placeholder="you@company.com" autocomplete="email" spellcheck="false" />' +
          "</div>" +
          '<p class="field-help">The address you’ll forward email from — it becomes the ' +
          "owner of your capture address.</p>") +
      '<div class="ec-actions"><button type="button" class="btn btn-primary" id="ec-create">' +
      "Create my capture address</button></div>" +
      '<p class="field-help ec-sender-error" id="ec-owner-error" hidden></p>';

    const create = document.getElementById("ec-create");
    const ownerInput = document.getElementById("ec-owner-email");
    const ownerErr = document.getElementById("ec-owner-error");
    const doCreate = async () => {
      let ownerEmail = viewerEmail;
      if (!ownerEmail) {
        // Owner must be a bare email — the @domain wildcard form senders allow
        // has no meaning as an owner.
        const value = normalizeCaptureSender(ownerInput ? ownerInput.value : "");
        if (!value || value.startsWith("@")) {
          if (ownerErr) {
            ownerErr.textContent = "Enter the email address you’ll forward from (name@company.com).";
            ownerErr.removeAttribute("hidden");
          }
          return;
        }
        ownerEmail = value;
      }
      if (ownerErr) ownerErr.setAttribute("hidden", "");
      create.disabled = true;
      create.textContent = "Creating…";
      try {
        await tauri.core.invoke("email_capture_mint_address", { ownerEmail });
        await renderEmailCapture(); // re-GET, no optimistic state
      } catch (err) {
        create.disabled = false;
        create.textContent = "Create my capture address";
        showToast({ kind: "failure", title: "Couldn't create address", body: String(err) });
      }
    };
    if (create) {
      create.addEventListener("click", doCreate);
      if (ownerInput) {
        ownerInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); doCreate(); }
        });
      }
    }
    return;
  }

  // Main card: the active address + copy/rotate + approved senders.
  const activeAddr = active.address || "";
  const retired = addresses.filter((a) => a && !a.active);

  let html = "";
  html +=
    '<div class="ec-address-row">' +
    '<code class="ec-address" id="ec-address">' + escapeHtml(activeAddr) + "</code>" +
    '<button type="button" class="btn btn-secondary ec-copy" id="ec-copy">Copy</button>' +
    '<button type="button" class="btn btn-secondary ec-vcard" id="ec-vcard">Save as contact</button>' +
    "</div>";
  // The address is a machine token by design (it routes + gates inbound mail) —
  // the intended UX is save-it-once-as-a-contact, never read it again (Ross,
  // 2026-07-08: "not very intuitive at all as an address").
  html +=
    '<p class="field-help">This address isn’t meant to be memorized — save it as a ' +
    "contact once (name it “Threshold”) and just type that when you forward. " +
    "Threshold files what it finds and replies with a receipt. Only senders you " +
    "approve below are accepted.</p>";

  // Rotate (behind a confirm).
  html +=
    '<div class="ec-actions"><button type="button" class="btn btn-secondary" id="ec-rotate">' +
    "Rotate address</button></div>";

  if (retired.length) {
    html +=
      '<p class="field-help ec-history">Retired: ' +
      retired.map((a) => "<code>" + escapeHtml(a.address || "") + "</code>").join(", ") +
      "</p>";
  }

  // Approved senders.
  html += '<h3 class="settings-subhead ec-senders-head">Approved senders</h3>';
  if (senders.length) {
    html += '<ul class="ec-senders">';
    for (const s of senders) {
      html +=
        '<li class="ec-sender-row"><code class="ec-sender">' + escapeHtml(s) +
        '</code><button type="button" class="ec-sender-remove" data-sender="' + escapeHtml(s) +
        '" aria-label="Remove ' + escapeHtml(s) + '">Remove</button></li>';
    }
    html += "</ul>";
  } else {
    html +=
      '<p class="field-help">No approved senders yet. Add one below — email from anyone ' +
      "else is ignored.</p>";
  }
  html +=
    '<div class="ec-add-sender">' +
    '<input type="text" class="ec-sender-input" id="ec-sender-input" ' +
    'placeholder="name@company.com or @company.com" autocomplete="off" spellcheck="false" />' +
    '<button type="button" class="btn btn-secondary" id="ec-sender-add">Add</button>' +
    "</div>";
  html += '<p class="field-help ec-sender-error" id="ec-sender-error" hidden></p>';

  body.innerHTML = html;

  // ── Wire the main card ──
  const copyBtn = document.getElementById("ec-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("copy_text", { text: activeAddr });
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1600);
      } catch (err) {
        showToast({ kind: "failure", title: "Couldn't copy", body: String(err) });
      }
    });
  }

  // "Save as contact" — a vCard via the native save dialog, so the token
  // address lives in her address book as "Viktora Threshold" and she types
  // that in the To: field instead of ever reading the token.
  const vcardBtn = document.getElementById("ec-vcard");
  if (vcardBtn) {
    vcardBtn.addEventListener("click", async () => {
      const vcf = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Viktora Threshold",
        "ORG:Viktora",
        "EMAIL;TYPE=INTERNET:" + activeAddr,
        "NOTE:Forward or BCC email here — Threshold files what it finds and replies with a receipt.",
        "END:VCARD",
        "",
      ].join("\r\n");
      try {
        const saved = await tauri.core.invoke("save_text_file", {
          defaultName: "Viktora Threshold.vcf",
          content: vcf,
        });
        if (saved) {
          showToast({
            kind: "success",
            title: "Contact saved",
            body: "Import it into your mail app, then just type “Threshold” when forwarding.",
          });
        }
      } catch (err) {
        console.warn("[main] capture vcard save failed:", err);
        showToast({ kind: "failure", title: "Couldn't save contact", body: "Try again." });
      }
    });
  }

  const rotateBtn = document.getElementById("ec-rotate");
  if (rotateBtn) {
    rotateBtn.addEventListener("click", () => confirmRotateCapture(activeAddr));
  }

  for (const rm of document.querySelectorAll(".ec-sender-remove")) {
    rm.addEventListener("click", () => confirmRemoveSender(rm.dataset.sender));
  }

  const addInput = document.getElementById("ec-sender-input");
  const addBtn = document.getElementById("ec-sender-add");
  if (addBtn && addInput) {
    const doAdd = () => addCaptureSender(addInput.value);
    addBtn.addEventListener("click", doAdd);
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
  }
}

// Client-side sender validation — mirrors the engine's §1.4 rule (bare email OR
// @domain wildcard, trimmed + lowercased). Returns the canonical form or null.
function normalizeCaptureSender(raw) {
  const s = (raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("@")) {
    const domain = s.slice(1);
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? s : null;
  }
  return /^[^\s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}

async function addCaptureSender(raw) {
  const errEl = document.getElementById("ec-sender-error");
  const value = normalizeCaptureSender(raw);
  if (!value) {
    if (errEl) {
      errEl.textContent = "Enter an email (name@company.com) or a domain (@company.com).";
      errEl.removeAttribute("hidden");
    }
    return;
  }
  if (errEl) errEl.setAttribute("hidden", "");
  try {
    await tauri.core.invoke("email_capture_add_sender", { sender: value });
    await renderEmailCapture(); // re-GET
  } catch (err) {
    // Server-side validation / duplicate — surface in the existing toast pattern.
    showToast({ kind: "failure", title: "Couldn't add sender", body: String(err) });
  }
}

function confirmRemoveSender(sender) {
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";
  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = "Remove this sender?";
  pane.appendChild(title);
  const bodyEl = document.createElement("div");
  bodyEl.className = "pg-confirm-body";
  bodyEl.textContent = `Email from “${sender}” will no longer be captured.`;
  pane.appendChild(bodyEl);
  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = "Remove";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Removing…";
    try {
      await tauri.core.invoke("email_capture_remove_sender", { sender });
      pgClose(overlay);
      await renderEmailCapture(); // re-GET
    } catch (err) {
      pgClose(overlay);
      showToast({ kind: "failure", title: "Couldn't remove sender", body: String(err) });
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);
  overlay.appendChild(pane);
  document.body.appendChild(overlay);
}

function confirmRotateCapture(currentAddr) {
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";
  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = "Rotate your capture address?";
  pane.appendChild(title);
  const bodyEl = document.createElement("div");
  bodyEl.className = "pg-confirm-body";
  bodyEl.textContent =
    "Rotating retires the old address immediately — update anything that BCCs it. " +
    "You'll get a fresh address to use instead.";
  pane.appendChild(bodyEl);
  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = "Rotate";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Rotating…";
    try {
      await tauri.core.invoke("email_capture_rotate_address", { address: currentAddr });
      pgClose(overlay);
      await renderEmailCapture(); // re-GET
      showToast({ kind: "success", title: "Address rotated", body: "The old address no longer accepts mail." });
    } catch (err) {
      pgClose(overlay);
      showToast({ kind: "failure", title: "Couldn't rotate", body: String(err) });
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);
  overlay.appendChild(pane);
  document.body.appendChild(overlay);
}

// ───────── Connected AI platforms (WP-MCP-V2 Phase C) ─────────
// Renders into #ai-connections-body, lazily on panel open. Every AI platform
// or CLI tool holding access is a GRANT row (scoped token server-side); this
// card lists them, mints new access keys, and revokes — the one place all
// connections are visible and severable. Token values appear exactly once, at
// mint. Calm states mirror the email-capture card: not-available explainer on
// older engines, re-GET after every mutation, no optimistic state.

// ── AI companion (WP-CHECKIN-STANDUP) ──────────────────────────────────────
// Where the check-in brief's Standup button opens the AI surface. A client
// preference (localStorage, like the debug-views toggle) — the brief runs in
// this same window, so the store is shared. Empty ⇒ brief.js falls back to
// claude.ai. Persists on change; no global-Save dependency.
const COMPANION_URL_KEY = "threshold.companionUrl";
(function initCompanionUrlField() {
  const input = document.getElementById("config-companion-url");
  if (!input) return;
  input.value = localStorage.getItem(COMPANION_URL_KEY) || "";
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (v) localStorage.setItem(COMPANION_URL_KEY, v);
    else localStorage.removeItem(COMPANION_URL_KEY);
  });
})();

// ── Daily routines (WP-CHECKIN-ROUTINES) ────────────────────────────────────
// The Settings face of the routines architecture (definitions + rationale in
// routines.js). Attended check-ins are native: the always-resident widget
// pings at the times set here (persist-on-change, like the companion URL —
// no global-Save dependency), and the brief's chip opens the routine's door.
//
// The unattended side is ENGINE state: the runner executes THREE passes —
// prework (morning staging), delta (pre-midday), closure (pre-evening) — and
// serves GET/POST /api/prework/config over the bearer lane. ONE prominent
// "Unattended preparation" toggle gates all three passes (the pilot's no-ssh
// off switch; per-pass control can come later): OFF posts all three
// enabled:false immediately, ON restores them. The prework row edits its
// pass's time; delta/closure are DERIVED (each runs 15 min before its
// attended check-in — a caption, not a third time picker). Every render of
// engine state comes from a server response (verified), never a local echo:
// the toggle stays HIDDEN until a GET succeeds (an older engine simply never
// shows it), and the env master switch (`enabled:false` from the operator)
// renders it disabled — the client cannot override the kill switch, by
// design. The claude.ai one-message setup remains below as the optional
// cloud tier.
let refreshRoutineEngineState = () => {};

(function initRoutineSetup() {
  const list = document.getElementById("routine-list");
  const btn = document.getElementById("routine-setup");
  if (!list || !btn) return;

  const cfg = loadRoutines();

  list.innerHTML = ROUTINES.map((r) => {
    const c = cfg[r.key];
    // Attended rows: the toggle gates the LOCAL check-in ping. Prework has no
    // local surface — its enablement is the master unattended toggle — so it
    // holds the column with a spacer.
    const toggle = r.attended
      ? '<input type="checkbox" class="routine-toggle" data-routine="' + r.key + '"' +
        (c.enabled ? " checked" : "") +
        ' aria-label="Remind me for ' + r.name + '" />'
      : '<span class="routine-toggle-slot" aria-hidden="true"></span>';
    // The routine's door — where engaging it lands (WP-CHECKIN pin: per-routine,
    // user-overridable). Prework is unattended, engine-side: no door.
    const door = r.attended
      ? '<select class="auto-import-interval-select routine-door" data-routine="' + r.key +
        '" aria-label="Where ' + r.name + ' opens">' +
        '<option value="companion"' + (c.door === "companion" ? " selected" : "") +
        ">opens your companion</option>" +
        '<option value="today"' + (c.door === "today" ? " selected" : "") +
        ">opens Today</option>" +
        "</select>"
      : "";
    // Engine captions: prework carries the workspace-schedule status; the two
    // derived passes annotate their attended rows.
    const caption =
      r.enginePass || r.prepPass
        ? '<p class="routine-caption" id="routine-caption-' + r.key + '"></p>'
        : "";
    return (
      '<div class="routine-item">' +
      '<div class="routine-row">' +
      toggle +
      '<input type="time" class="routine-time" data-routine="' + r.key + '" value="' +
      c.time + '" aria-label="' + r.name + ' time" />' +
      '<span class="routine-name">' + r.name + "</span>" +
      '<span class="routine-desc">' + r.desc + "</span>" +
      door +
      "</div>" +
      caption +
      "</div>"
    );
  }).join("");

  const readConfig = () => {
    const out = loadRoutines();
    for (const input of list.querySelectorAll(".routine-time")) {
      if (input.value) out[input.dataset.routine].time = input.value;
    }
    for (const box of list.querySelectorAll(".routine-toggle")) {
      out[box.dataset.routine].enabled = box.checked;
    }
    for (const sel of list.querySelectorAll(".routine-door")) {
      out[sel.dataset.routine].door = sel.value;
    }
    return out;
  };

  // ── Engine sync ──
  const cap = (key) => document.getElementById("routine-caption-" + key);
  const masterBlock = document.getElementById("routine-master");
  const masterToggle = document.getElementById("routine-unattended-toggle");
  const masterNote = document.getElementById("routine-master-note");

  // The verified master state: null = never confirmed by a GET (toggle stays
  // hidden AND we never write blind — an edit before first contact must not
  // silently disable the passes).
  let unattendedOn = null;

  // eff = the server's effective config (the only thing we ever render);
  // err ⇒ fail-visible captions, and the master toggle hides (an older
  // engine without the endpoint simply never shows an unverifiable switch).
  function renderEngineState(eff, err) {
    const c = readConfig();
    if (!eff) {
      unattendedOn = null;
      if (masterBlock) masterBlock.setAttribute("hidden", "");
      cap("prework").textContent =
        "Couldn't read your workspace schedule — " + String(err || "engine unreachable");
      cap("midday").textContent =
        "prepared 15 min before (" + derivePrepTime(c.midday.time) + ") — not confirmed";
      cap("evening").textContent =
        "prepared 15 min before (" + derivePrepTime(c.evening.time) + ") — not confirmed";
      return;
    }
    const passes = eff.passes || {};
    const p = passes.prework || {};
    // The engine is the authority for the prework pass — reflect it into the row.
    const preworkTime = list.querySelector('.routine-time[data-routine="prework"]');
    if (preworkTime && /^\d{2}:\d{2}$/.test(p.time || "")) preworkTime.value = p.time;
    // Master toggle: ON when any pass runs (so OFF — the panic direction —
    // always silences everything). The env master switch is the operator's
    // kill switch: the client renders it, never overrides it.
    const anyOn = ["prework", "delta", "closure"].some(
      (k) => (passes[k] || {}).enabled !== false
    );
    const operatorOff = eff.enabled === false;
    unattendedOn = anyOn;
    if (masterBlock && masterToggle && masterNote) {
      masterBlock.removeAttribute("hidden");
      masterToggle.checked = anyOn;
      masterToggle.disabled = operatorOff;
      masterNote.textContent = operatorOff
        ? "Turned off by your operator — schedule edits still save, nothing runs until they re-enable it."
        : anyOn
          ? "Your workspace prepares each check-in before you arrive. Off pauses all three passes within a minute."
          : "Paused — nothing runs until you turn it back on.";
    }
    cap("prework").textContent =
      "on your workspace" +
      (operatorOff ? " — saved; runs once the runner is armed" : "") +
      " · changes apply within a minute";
    const line = (pass, fallbackTime) =>
      "prepared 15 min before — " +
      ((passes[pass] || {}).time || fallbackTime) +
      " on your workspace" +
      ((passes[pass] || {}).enabled === false ? " (off)" : "");
    cap("midday").textContent = line("delta", derivePrepTime(c.midday.time));
    cap("evening").textContent = line("closure", derivePrepTime(c.evening.time));
  }

  async function syncEngine(write) {
    try {
      let eff;
      if (write) {
        const c = readConfig();
        const on = unattendedOn === true;
        eff = await tauri.core.invoke("save_prework_config", {
          payload: {
            passes: {
              prework: { time: c.prework.time, enabled: on },
              delta: { time: derivePrepTime(c.midday.time), enabled: on },
              closure: { time: derivePrepTime(c.evening.time), enabled: on },
            },
            tz_offset_minutes: tzOffsetMinutes(),
          },
        });
      } else {
        eff = await tauri.core.invoke("fetch_prework_config");
      }
      renderEngineState(eff, null);
    } catch (err) {
      renderEngineState(null, err);
    }
  }
  refreshRoutineEngineState = () => syncEngine(false);

  if (masterToggle) {
    masterToggle.addEventListener("change", () => {
      // The panic switch writes immediately — no debounce on an off switch.
      unattendedOn = masterToggle.checked;
      syncEngine(true);
    });
  }

  let engineSyncTimer = null;
  list.addEventListener("change", (ev) => {
    saveRoutines(readConfig());
    // Engine-relevant time edits sync debounced — but only once a GET has
    // confirmed engine state (unattendedOn non-null); writing blind could
    // silently flip passes on an engine we've never heard from.
    const key = ev.target && ev.target.dataset ? ev.target.dataset.routine : null;
    if (unattendedOn !== null && (key === "prework" || key === "midday" || key === "evening")) {
      clearTimeout(engineSyncTimer);
      engineSyncTimer = setTimeout(() => syncEngine(true), 700);
    }
  });

  btn.addEventListener("click", async () => {
    const status = document.getElementById("routine-setup-status");
    const msg = composeRoutineSetupMessage(readConfig());
    let url = (localStorage.getItem(COMPANION_URL_KEY) || "https://claude.ai/new").trim();
    // Same prefill rule as the Standup chip: ?q= is a claude.ai nicety; other
    // companions get the message on the clipboard instead.
    const canPrefill = /^https:\/\/(www\.)?claude\.ai\/new\/?$/.test(url);
    if (canPrefill) url += "?q=" + encodeURIComponent(msg);
    try {
      if (!canPrefill) await tauri.core.invoke("copy_text", { text: msg });
      await tauri.core.invoke("plugin:opener|open_url", { url });
      status.textContent = canPrefill
        ? "Opened in Claude — review the message, send it, and confirm the four routines " +
          "there. Threshold can't see your Claude schedule."
        : "Opened your companion — the setup message is on your clipboard: paste it, send " +
          "it, and confirm the routines there.";
    } catch (err) {
      showToast({ kind: "failure", title: "Couldn't open your companion", body: String(err) });
    }
  });
})();

/** "3d ago" / "just now" for a grant's lastUsedAt; "" when absent. */
function grantLastUsed(iso) {
  if (!iso) return "never used";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

async function renderAiConnections() {
  const body = document.getElementById("ai-connections-body");
  if (!body) return;
  body.innerHTML = '<p class="field-help">Loading…</p>';

  let data;
  try {
    data = await tauri.core.invoke("fetch_mcp_grants");
  } catch (err) {
    body.innerHTML =
      '<p class="field-help ec-error">Couldn\'t reach your workspace: ' +
      escapeHtml(String(err)) +
      '</p><div class="ec-actions"><button type="button" class="btn btn-secondary" id="ai-retry">Try again</button></div>';
    const retry = document.getElementById("ai-retry");
    if (retry) retry.addEventListener("click", () => renderAiConnections());
    return;
  }

  if (!data || data.available === false || data.enabled !== true) {
    body.innerHTML =
      '<p class="field-help">AI platform connections aren\'t available on this workspace yet.</p>';
    return;
  }

  const grants = Array.isArray(data.grants) ? data.grants : [];
  const active = grants.filter((g) => g && !g.revokedAt);
  const revoked = grants.filter((g) => g && g.revokedAt);

  // The connector URL any MCP-compliant platform can be pointed at.
  const baseUrl = (document.getElementById("config-base-url").value || "").trim();
  const mcpUrl = baseUrl ? baseUrl.replace(/\/+$/, "") + "/mcp" : "";

  let html = "";
  if (mcpUrl) {
    // claude.ai supports a prefill deep-link: it opens the add-connector dialog
    // with the name + URL filled in; the user still reviews and consents (it
    // grants nothing on its own). ChatGPT has no such link — it's a guided
    // paste. Gemini's consumer app doesn't do custom remote MCP connectors;
    // that path is Gemini Enterprise / the Gemini CLI, noted but not buttoned.
    const claudeDeepLink =
      "https://claude.ai/customize/connectors?modal=add-custom-connector" +
      "&connectorName=" + encodeURIComponent("Viktora Threshold") +
      "&connectorUrl=" + encodeURIComponent(mcpUrl);

    html +=
      '<div class="ec-address-row">' +
      '<code class="ec-address" id="ai-mcp-url">' + escapeHtml(mcpUrl) + "</code>" +
      '<button type="button" class="btn btn-secondary ec-copy" id="ai-copy-url">Copy</button>' +
      "</div>" +
      '<p class="field-help">Your workspace connector. Approve access once, on this ' +
      "workspace's consent screen — then the AI can read your field and file captures, " +
      "nothing more.</p>";

    // One-click Claude + guided ChatGPT, sharing the URL above.
    html +=
      '<div class="ec-actions ai-connect-row">' +
      '<button type="button" class="btn btn-primary" id="ai-connect-claude" ' +
      'data-deeplink="' + escapeHtml(claudeDeepLink) + '">Connect to Claude</button>' +
      '<button type="button" class="btn btn-secondary" id="ai-connect-chatgpt">Set up in ChatGPT</button>' +
      "</div>";
    html += '<div id="ai-connect-chatgpt-steps" class="ai-connect-steps" hidden></div>';
    html +=
      '<p class="field-help ai-connect-gemini">Gemini: connect the URL above via ' +
      "<strong>Gemini Enterprise</strong> (Google Cloud console) or the <strong>Gemini CLI</strong> — " +
      "the consumer Gemini app doesn't take custom connectors yet.</p>";
  }

  if (active.length) {
    html += '<h3 class="settings-subhead ec-senders-head">Active connections</h3>';
    html += '<ul class="ec-senders">';
    for (const g of active) {
      const kind = g.kind === "oauth" ? "Connector" : "Access key";
      const label = g.label && g.label.startsWith("oauth:") ? g.label.slice(6) : g.label || "(unlabeled)";
      html +=
        '<li class="ec-sender-row"><div class="ai-grant-main">' +
        '<span class="ec-sender">' + escapeHtml(label) + "</span>" +
        '<span class="ai-grant-meta">' + kind +
        " · " + escapeHtml((g.scopes || []).join(" + ")) +
        " · " + escapeHtml(grantLastUsed(g.lastUsedAt)) + "</span>" +
        "</div>" +
        '<button type="button" class="ec-sender-remove" data-grant-id="' + escapeHtml(g.id) +
        '" data-grant-label="' + escapeHtml(label) + '" aria-label="Revoke ' + escapeHtml(label) + '">Revoke</button></li>';
    }
    html += "</ul>";
  } else {
    html +=
      '<p class="field-help">No AI platforms connected yet. Add the connector URL above in the ' +
      "platform's settings, or create an access key below for command-line tools.</p>";
  }

  if (revoked.length) {
    const revokedName = (g) => {
      const l = g.label || g.id;
      return l.startsWith("oauth:") ? l.slice(6) : l;
    };
    html +=
      '<p class="field-help ec-history">Revoked: ' +
      revoked.map((g) => "<code>" + escapeHtml(revokedName(g)) + "</code>").join(", ") +
      "</p>";
  }

  // Mint an access key (bearer lane, for CLI clients like Claude Code). Owner
  // resolves from the signed-in identity; the identity-less bearer lane gets an
  // inline email field — same convention as the capture-address card.
  let viewerEmail = null;
  try { viewerEmail = await getViewerEmail(); } catch (_e) { /* optional */ }

  html += '<h3 class="settings-subhead ec-senders-head">Create an access key</h3>';
  if (!viewerEmail) {
    html +=
      '<div class="ec-add-sender">' +
      '<input type="email" class="ec-sender-input" id="ai-mint-owner" ' +
      'placeholder="you@company.com — the key\'s owner" autocomplete="email" spellcheck="false" />' +
      "</div>";
  }
  html +=
    '<div class="ec-add-sender">' +
    '<input type="text" class="ec-sender-input" id="ai-mint-label" ' +
    'placeholder="What will use this key? e.g. Claude Code — laptop" autocomplete="off" spellcheck="false" />' +
    '<button type="button" class="btn btn-secondary" id="ai-mint">Create</button>' +
    "</div>";
  html += '<p class="field-help ec-sender-error" id="ai-mint-error" hidden></p>';
  html += '<div id="ai-mint-result"></div>';

  body.innerHTML = html;

  const copyBtn = document.getElementById("ai-copy-url");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("copy_text", { text: mcpUrl });
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1600);
      } catch (err) {
        showToast({ kind: "failure", title: "Couldn't copy", body: String(err) });
      }
    });
  }

  // One-click Claude: open the prefilled add-connector dialog in the browser.
  const claudeBtn = document.getElementById("ai-connect-claude");
  if (claudeBtn) {
    claudeBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("plugin:opener|open_url", { url: claudeBtn.dataset.deeplink });
      } catch (err) {
        showToast({ kind: "failure", title: "Couldn't open Claude", body: String(err) });
      }
    });
  }

  // ChatGPT has no prefill link — reveal the guided steps + open its connector
  // settings, and copy the URL so the paste is one keystroke. Consumer accounts
  // get read-only custom connectors (reconciliation works; capture needs a
  // Business/Enterprise workspace) — say so, it's a real limit.
  const gptBtn = document.getElementById("ai-connect-chatgpt");
  const gptSteps = document.getElementById("ai-connect-chatgpt-steps");
  if (gptBtn && gptSteps) {
    gptBtn.addEventListener("click", async () => {
      if (!gptSteps.hasAttribute("hidden")) { gptSteps.setAttribute("hidden", ""); return; }
      gptSteps.innerHTML =
        "<ol class=\"ai-steps-list\">" +
        "<li>In ChatGPT: <strong>Settings → Connectors → Advanced → turn on Developer mode</strong>.</li>" +
        "<li><strong>Connectors → Create</strong>. Name it <em>Viktora Threshold</em>; paste the connector URL above (already copied).</li>" +
        "<li>Approve access on this workspace's consent screen.</li>" +
        "</ol>" +
        '<p class="field-help">Note: on ChatGPT Plus/Pro, custom connectors are ' +
        "read-only — checking a draft against your field works; filing captures back " +
        "needs a Business/Enterprise workspace.</p>" +
        '<div class="ec-actions"><button type="button" class="btn btn-secondary" id="ai-open-chatgpt">' +
        "Open ChatGPT connectors</button></div>";
      gptSteps.removeAttribute("hidden");
      try { await tauri.core.invoke("copy_text", { text: mcpUrl }); } catch (_e) { /* non-fatal */ }
      const openGpt = document.getElementById("ai-open-chatgpt");
      if (openGpt) {
        openGpt.addEventListener("click", async () => {
          try {
            await tauri.core.invoke("plugin:opener|open_url", { url: "https://chatgpt.com/#settings/Connectors" });
          } catch (err) {
            showToast({ kind: "failure", title: "Couldn't open ChatGPT", body: String(err) });
          }
        });
      }
    });
  }

  for (const rm of document.querySelectorAll("#ai-connections-body .ec-sender-remove")) {
    rm.addEventListener("click", () => confirmRevokeGrant(rm.dataset.grantId, rm.dataset.grantLabel));
  }

  const mintBtn = document.getElementById("ai-mint");
  const mintLabel = document.getElementById("ai-mint-label");
  if (mintBtn && mintLabel) {
    const doMint = () => mintAiGrant(mintLabel.value, viewerEmail);
    mintBtn.addEventListener("click", doMint);
    mintLabel.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doMint(); } });
  }
}

async function mintAiGrant(rawLabel, viewerEmail) {
  const errEl = document.getElementById("ai-mint-error");
  const label = (rawLabel || "").trim();
  if (!label) {
    if (errEl) {
      errEl.textContent = "Give the key a label so you can recognize it later.";
      errEl.removeAttribute("hidden");
    }
    return;
  }
  // Owner: the signed-in identity when present; on the identity-less bearer
  // lane, the inline #ai-mint-owner field (must be a bare email — captures made
  // with this key are attributed to it).
  let ownerEmail = viewerEmail || null;
  if (!ownerEmail) {
    const ownerInput = document.getElementById("ai-mint-owner");
    const value = normalizeCaptureSender(ownerInput ? ownerInput.value : "");
    if (!value || value.startsWith("@")) {
      if (errEl) {
        errEl.textContent = "Enter the owner's email address (name@company.com).";
        errEl.removeAttribute("hidden");
      }
      return;
    }
    ownerEmail = value;
  }
  if (errEl) errEl.setAttribute("hidden", "");
  try {
    const result = await tauri.core.invoke("mcp_mint_grant", { ownerEmail, label });
    const token = result && result.token ? String(result.token) : "";
    const holder = document.getElementById("ai-mint-result");
    if (holder && token) {
      // The one and only surfacing of the token value. Not persisted client-side.
      holder.innerHTML =
        '<div class="ec-address-row">' +
        '<code class="ec-address">' + escapeHtml(token) + "</code>" +
        '<button type="button" class="btn btn-secondary ec-copy" id="ai-token-copy">Copy</button>' +
        "</div>" +
        '<p class="privacy-caveat">⚠ Copy this key now — it won\'t be shown again.</p>';
      const tc = document.getElementById("ai-token-copy");
      if (tc) {
        tc.addEventListener("click", async () => {
          try {
            await tauri.core.invoke("copy_text", { text: token });
            tc.textContent = "Copied ✓";
            setTimeout(() => { tc.textContent = "Copy"; }, 1600);
          } catch (err) {
            showToast({ kind: "failure", title: "Couldn't copy", body: String(err) });
          }
        });
      }
    }
  } catch (err) {
    showToast({ kind: "failure", title: "Couldn't create key", body: String(err) });
  }
}

function confirmRevokeGrant(id, label) {
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";
  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = "Revoke this connection?";
  pane.appendChild(title);
  const bodyEl = document.createElement("div");
  bodyEl.className = "pg-confirm-body";
  bodyEl.textContent = `“${label}” loses access immediately. This can't be undone — reconnecting means approving it again.`;
  pane.appendChild(bodyEl);
  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = "Revoke";
  go.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("mcp_revoke_grant", { id });
      pgClose(overlay);
      await renderAiConnections(); // re-GET
      showToast({ kind: "success", title: "Connection revoked", body: `“${label}” no longer has access.` });
    } catch (err) {
      pgClose(overlay);
      showToast({ kind: "failure", title: "Couldn't revoke", body: String(err) });
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);
  overlay.appendChild(pane);
  document.body.appendChild(overlay);
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
  // Standalone Settings = two-pane master-detail; default to the Connection
  // group.
  setSettingsMode("settings");
  switchSettingsPanel("connection");
  showView("view-configure");
  setNav([{ label: "Settings" }], { back: () => goHome() });
  document.getElementById("config-base-url").focus();
  // WP-T2b — show the signed-in identity + switch-account affordance. Fire-and-
  // forget: whoami is a network round-trip and must not block the settings paint
  // (§2.6). The block stays hidden until whoami resolves to an email.
  renderSettingsIdentity();
  // Populate the Integrations panel: auto-import block + Plaud connection card.
  initConfigAutoImport();
  refreshPlaudConnectionCard();
}

// ───────── WP-T2b — signed-in identity in Settings ─────────
//
// Shows the viewer's authenticated email (from /api/whoami) in the Settings
// Connection panel, plus a "sign in with a different account" button that
// returns to the email screen. Invisible-by-absence: if whoami is null (shared
// key / auth off / server too old) the Account block stays hidden and Settings
// looks exactly as it did before this WP.
async function renderSettingsIdentity() {
  const block = document.getElementById("settings-account");
  const emailEl = document.getElementById("settings-account-email");
  if (!block || !emailEl) return;
  // Force a fresh whoami — a returning user may have switched accounts since the
  // cached value was resolved on the first widget_expand of this window.
  let email = null;
  try {
    email = await getViewerEmail(true);
  } catch (_e) {
    email = null;
  }
  if (email) {
    emailEl.textContent = "Signed in as " + email;
    block.removeAttribute("hidden");
  } else {
    // No per-user identity (shared-key / auth-off deployment). Keep the block
    // hidden so nothing implies a sign-in that didn't happen.
    block.setAttribute("hidden", "");
  }
}

// Return to the email sign-in screen to switch accounts. The new magic-link
// verify (auth_verify) overwrites the persisted bearer + resets the cached
// viewer identity, so this is a clean re-login, not a second session.
function handleSettingsSignIn() {
  enterWizardWelcome(state.lastConfig || undefined);
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
  // Returning to the capture home must restore the full-width view: the source
  // reader is a Log/detail affordance, and back-nav (goHome) previously left it
  // open with stale document data (the right pane wouldn't re-collapse — Trisha
  // UAT 2026-07-09). closeSourcePanel is a pure state reset; safe if already closed.
  closeSourcePanel();
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

async function getViewerEmail(force) {
  if (!force && _viewerEmail !== undefined) return _viewerEmail;
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
  // WP-RECORD-CLASS (app half): the engine's binary junk gate marks vague
  // aspirations / questions / chitchat as recordClass='not-a-commitment'
  // (RECORD_CLASS_ENABLED, additive field; Ross's v2.0 ruling — a
  // not-a-commitment verdict SUPPRESSES the record). This is the shared
  // record chokepoint, so the suppression applies everywhere dismissals do.
  // Flag-off servers ship no recordClass ⇒ byte-identical behavior.
  return (Array.isArray(items) ? items : []).filter((it) => {
    if (isDismissed(it)) return false;
    const rec = (it && it.record) || it || {};
    return rec.recordClass !== "not-a-commitment";
  });
}

/**
 * Quiet count + review affordance for records the engine's junk gate marked
 * not-a-commitment (suppressed by withoutDismissed). House law §2b.3:
 * fail-closed-but-VISIBLE — the user can always see how many were filtered
 * and read them; nothing disappears silently. Idempotent per render.
 */
function renderNacReviewAffordance(items) {
  const header = document.querySelector("#view-log .log-header");
  if (!header) return;
  let line = document.getElementById("nac-review-line");
  let panel = document.getElementById("nac-review-panel");
  if (!items.length) {
    if (line) line.remove();
    if (panel) panel.remove();
    return;
  }
  if (!line) {
    line = document.createElement("button");
    line.type = "button";
    line.id = "nac-review-line";
    line.className = "btn btn-link nac-review-line";
    const text = header.querySelector(".log-header-text");
    (text || header).appendChild(line);
    line.addEventListener("click", () => {
      const p = document.getElementById("nac-review-panel");
      if (p) p.hidden = !p.hidden;
      line.setAttribute("aria-expanded", p && !p.hidden ? "true" : "false");
    });
  }
  line.textContent = `${items.length} filtered as not commitments — review`;
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "nac-review-panel";
    panel.className = "nac-review-panel";
    panel.hidden = true;
    header.insertAdjacentElement("afterend", panel);
  }
  panel.innerHTML = "";
  for (const { rec } of items) {
    const row = document.createElement("div");
    row.className = "nac-review-row";
    const text = document.createElement("div");
    text.className = "nac-review-text";
    text.textContent = rec.summary || rec.text || rec.verbatim || "(no summary)";
    const meta = document.createElement("div");
    meta.className = "nac-review-meta";
    const owner = rec.owner || (rec.commitment && rec.commitment.owner) || "";
    meta.textContent = owner ? `${owner} · not a commitment` : "not a commitment";
    row.append(text, meta);
    panel.appendChild(row);
  }
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
  // Deprioritized (Ross UAT 2026-07-10) — the overdue-cleanup motive: it didn't get
  // done because priorities moved, not because it was wrong. Server-side contract
  // must accept this slug too (VALID_REASONS in the engine's index.ts + RecordHitlReason).
  { slug: "deprioritized", label: "Deprioritized" },
];

/** Append a subtle "Dismiss" (✕) control to an actions row. Clicking opens a
 *  small inline reason menu (the closed 4-reason set the server accepts); picking
 *  a reason suppresses the record optimistically AND records the disposition
 *  server-side, then offers Undo. `summary` is used for the toast. */
// WP-Outlook-Writeback — "Draft follow-up" affordance on a commitment/decision
// card. Stages an outbound draft (owner → recipient) into the outbox, surfaced
// in the desktop Outbox + the Outlook add-in. Shown only for records that have
// an owner (no recipient → nothing to draft).
function appendDraftFollowUpControl(actionsEl, rec) {
  if (!rec || !rec.owner) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-link";
  btn.textContent = "Draft follow-up →";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    draftFollowUpFromRecord(rec);
  });
  actionsEl.appendChild(btn);
}

function appendDismissControl(actionsEl, recordId, cardEl, summary, onDismissed) {
  if (!recordId) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "record-dismiss-btn";
  btn.title = "Dismiss — hide this from your views";
  btn.setAttribute("aria-label", "Dismiss");
  btn.textContent = "✕";
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't toggle a group header / open receipts
    openDismissReasonMenu(btn, recordId, cardEl, summary, onDismissed);
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
function openDismissReasonMenu(anchorBtn, recordId, cardEl, summary, onDismissed) {
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
      dismissRecord(recordId, cardEl, summary, slug, onDismissed);
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
async function dismissRecord(recordId, cardEl, summary, reason, onDismissed) {
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

  // Local hide is durable now — let callers react (e.g. the day digest decrements
  // its band count live). Fired here, not on the optimistic remove above, so a
  // failed local write (which re-inserts the card) never leaves a stale count.
  if (typeof onDismissed === "function") onDismissed(recordId);

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

/** WP-R3 item 5 — recordId → documentId, from the decision log (the records
 *  carry `documentId`). Lets a surface that only knows a recordId (e.g. a proxy
 *  card's evidence.recordIds) resolve the underlying document, so R1's existing
 *  jump (renderReceipt opts.jump / appendSourceBadge → openSourcePanel) can open
 *  the source pane — full reuse, no new pane, no new endpoint. Lazily loaded +
 *  cached; concurrent callers share one in-flight fetch. */
let _recordDocById = null;
let _recordDocByIdPromise = null;
async function loadRecordDocMap() {
  if (_recordDocById) return _recordDocById;
  if (_recordDocByIdPromise) return _recordDocByIdPromise;
  _recordDocByIdPromise = (async () => {
    const map = new Map();
    try {
      // The FULL log carries every record with its documentId (same source the
      // Decisions browser joins on). Best-effort — a failure leaves the map empty
      // so callers render no source affordance (never a broken/dead link).
      const data = await tauri.core.invoke("fetch_decision_log_full");
      const records = data && Array.isArray(data.records) ? data.records : [];
      for (const it of records) {
        const rec = it && it.record ? it.record : it;
        if (rec && rec.recordId && rec.documentId) map.set(rec.recordId, rec.documentId);
      }
    } catch (err) {
      console.warn("[main] loadRecordDocMap failed:", err);
    }
    _recordDocById = map;
    return map;
  })();
  return _recordDocByIdPromise;
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
 *  body) and render it, highlighting `verbatim`.
 *  `extraVerbatims` (optional) is an additional set of authored strings to
 *  highlight as siblings alongside the document's own extracted records — used
 *  by the question card to light up every authored hot-list item at once.
 *  Existing callers omit it; behavior is unchanged when absent. */
async function openSourcePanel(documentId, verbatim, extraVerbatims, opts) {
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
  // AUTHORED mode (question-card hot-list source): skip the doc's OTHER records —
  // the point is to show THIS category's items, not light up every action-item in
  // the doc (which drowns the ones the question is about). Only the caller-supplied
  // item verbatims are highlighted then.
  let others = [];
  if (!(opts && opts.authoredOnly)) {
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
  }

  // Fold in any caller-supplied extra highlights (question-card hot-list items).
  // Best-effort substring; renderSourceBody silently skips any that don't match.
  if (Array.isArray(extraVerbatims)) {
    for (const t of extraVerbatims) {
      const s = typeof t === "string" ? t.trim() : "";
      if (s) others.push(s);
    }
  }

  const nMarks = renderSourceBody(bodyEl, displayBody, verbatim, others, detail.formatSpans);
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
function lightenSourceColor(hex) {
  // Lighten a captured `#rrggbb` author color for the dark glass background:
  // keeps the hue identity (Trisha's blue stays blue) while staying readable.
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const rf = ((n >> 16) & 255) / 255, gf = ((n >> 8) & 255) / 255, bf = (n & 255) / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
    else if (max === gf) h = ((bf - rf) / d + 2) / 6;
    else h = ((rf - gf) / d + 4) / 6;
  }
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(Math.max(l, 0.7) * 100)}%)`;
}

/** Content-anchor the doc's preserved formatting spans (strike/insert/color/
 *  highlight; offsets are into the STORED content) onto the REFLOWED display
 *  text. The reflow inserts newlines so stored offsets shift; instead each span
 *  is re-located by its verbatim `text`, whitespace-insensitively, with a
 *  monotonic cursor (the reflow preserves document order). Unlocatable spans
 *  are dropped: a missing strike beats a misplaced one. */
function anchorFormatSpans(text, formatSpans) {
  const out = [];
  if (!Array.isArray(formatSpans)) return out;
  let cursor = 0;
  for (const s of formatSpans) {
    const raw = s && typeof s.text === "string" ? s.text.replace(/ /g, " ").trim() : "";
    if (!raw || !s.kind) continue;
    const pattern = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    let m = null;
    try {
      const re = new RegExp(pattern, "gi");
      re.lastIndex = Math.max(0, Math.min(cursor, text.length));
      m = re.exec(text);
    } catch {
      continue;
    }
    if (!m) continue;
    out.push({ start: m.index, end: m.index + m[0].length, kind: s.kind, color: s.color || "" });
    cursor = m.index; // monotonic-ish: same-line sibling spans may share a start
  }
  return out;
}

function renderSourceBody(bodyEl, text, primary, others, formatSpans) {
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

  // Earliest first; at a tie the primary wins. Then drop any overlaps greedily.
  ranges.sort((a, b) => a.start - b.start || (b.primary === true) - (a.primary === true));
  const placed = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    placed.push(r);
    lastEnd = r.end;
  }

  // The doc's preserved formatting (WP-FORMATTING-SEMANTICS), content-anchored.
  const fmts = anchorFormatSpans(text, formatSpans);
  const hlAt = (i) => placed.find((r) => r.start <= i && i < r.end) || null;
  const fmtsAt = (i) => fmts.filter((f) => f.start <= i && i < f.end);

  // Line-structured emit: each line is a .source-line whose leading spaces
  // become a hanging indent (wrapped bullet lines keep their hierarchy), and
  // each line is walked in segments so highlights + formatting compose.
  let primaryMark = null;
  const lines = text.split("\n");
  let offset = 0;
  for (const lineText of lines) {
    const lineStart = offset;
    const lineEnd = offset + lineText.length;
    offset = lineEnd + 1; // + '\n'
    const line = document.createElement("div");
    line.className = "source-line";
    const indent = (lineText.match(/^ */) || [""])[0].length;
    if (indent > 0) line.style.paddingLeft = `${indent}ch`;
    const contentStart = lineStart + indent; // leading spaces render as padding

    const bounds = new Set([contentStart, lineEnd]);
    for (const arr of [placed, fmts]) {
      for (const r of arr) {
        if (r.end > contentStart && r.start < lineEnd) {
          bounds.add(Math.max(r.start, contentStart));
          bounds.add(Math.min(r.end, lineEnd));
        }
      }
    }
    const cuts = [...bounds].sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k], b = cuts[k + 1];
      if (b <= a) continue;
      const seg = text.slice(a, b);
      const hl = hlAt(a);
      const active = fmtsAt(a);
      let el;
      if (hl) {
        el = document.createElement("mark");
        el.className = hl.primary ? "source-hl source-hl-primary" : "source-hl source-hl-dim";
        if (hl.primary && !primaryMark) primaryMark = el;
      } else if (active.length) {
        el = document.createElement("span");
      } else {
        line.appendChild(document.createTextNode(seg));
        continue;
      }
      for (const f of active) {
        if (f.kind === "strike") el.classList.add("source-fmt-strike");
        else if (f.kind === "insert") el.classList.add("source-fmt-insert");
        else if (f.kind === "color") {
          const c = lightenSourceColor(f.color);
          if (c) { el.classList.add("source-fmt-color"); el.style.color = c; }
        } else if (f.kind === "highlight") {
          const c = lightenSourceColor(f.color);
          el.classList.add("source-fmt-mark");
          if (c) el.style.textDecorationColor = c;
        }
      }
      el.appendChild(document.createTextNode(seg));
      line.appendChild(el);
    }
    if (!line.childNodes.length) line.appendChild(document.createTextNode(" ")); // keep blank lines
    bodyEl.appendChild(line);
  }

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
// ── TYPED-DIFF-CAPTURE Phase A — record-level inline editing ─────────────────
// Edits live at the DECISION/COMMITMENT level (a record property), not on the
// State-of-Play synthesis. A correction here propagates to every projection via
// the server's shared overlay. Gated on `_recordEditsEnabled` (the engine's
// editsEnabled capability); `_reloadRecordView` re-fetches the current surface
// after a save so the effect (e.g. an item moving owners) shows immediately.
let _recordEditsEnabled = false;
let _reloadRecordView = null;

/** Commit one field correction via the edit_record IPC, then reload the view. */
async function commitRecordEdit(rec, field, to, editType, classify) {
  if (!rec || !rec.recordId) return;
  try {
    await tauri.core.invoke("edit_record", {
      recordId: rec.recordId,
      editType,
      ...(classify ? { classifyProse: true } : {}),
      edits: [{ field, from: rec[field] == null ? null : String(rec[field]), to, type: editType }],
    });
    if (typeof _reloadRecordView === "function") _reloadRecordView();
  } catch (e) {
    showToast({ kind: "failure", title: "Couldn't save edit", body: String(e) });
  }
}

/** Small glass popover (design-system dropdown — replaces native <select>). */
function openRecordEditMenu(anchorEl, options, current, onPick) {
  const existing = document.querySelector(".record-edit-menu");
  if (existing) existing.remove();
  const menu = document.createElement("div");
  menu.className = "record-edit-menu";
  for (const o of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "record-edit-menu-item";
    if (o.value === current) item.dataset.current = "true";
    item.textContent = o.label;
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.remove();
      if (o.value !== current) onPick(o.value);
    });
    menu.appendChild(item);
  }
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  document.body.appendChild(menu);
  const close = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/** Make the summary click-to-edit: swaps to an inline textarea; Save classifies
 *  substance-vs-voice server-side. */
function makeEditableSummary(el, rec) {
  el.classList.add("record-editable");
  el.title = "Click to edit";
  el.addEventListener("click", () => {
    if (el.dataset.editing === "true") return;
    el.dataset.editing = "true";
    const orig = rec.summary || "";
    el.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "record-edit-textarea";
    ta.rows = 2;
    ta.value = orig;
    const row = document.createElement("div");
    row.className = "record-edit-row";
    const save = document.createElement("button");
    save.type = "button"; save.className = "record-edit-btn record-edit-save"; save.textContent = "Save";
    save.addEventListener("click", (ev) => {
      ev.stopPropagation(); // don't bubble to el's click-to-edit (would re-open the editor)
      if (ta.value.trim() !== orig.trim()) commitRecordEdit(rec, "summary", ta.value, "substance", true);
      else { el.dataset.editing = ""; el.textContent = orig; }
    });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "record-edit-btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", (ev) => { ev.stopPropagation(); el.dataset.editing = ""; el.textContent = orig; });
    row.appendChild(save); row.appendChild(cancel);
    // The textarea/editor live INSIDE the clickable element; stop their clicks
    // from bubbling back into the click-to-edit handler.
    ta.addEventListener("click", (ev) => ev.stopPropagation());
    el.appendChild(ta); el.appendChild(row);
    ta.focus();
  });
}

/** Make an owner span click-to-edit via the themed dropdown (team roster). */
function makeEditableOwner(el, rec) {
  el.classList.add("record-editable");
  el.title = "Click to reassign";
  el.addEventListener("click", async () => {
    const roster = await getSopRoster();
    const opts = (roster.length ? roster : [{ owner: rec.owner || "", displayName: prettySlug(rec.owner || "—") }])
      .map((o) => ({ value: o.owner, label: o.displayName }));
    openRecordEditMenu(el, opts, rec.owner || "", (val) => commitRecordEdit(rec, "owner", val, "owner", false));
  });
}

/** Make a due span click-to-edit via an inline date input. */
function makeEditableDue(el, rec) {
  el.classList.add("record-editable");
  el.title = "Click to set the date";
  el.addEventListener("click", () => {
    if (el.dataset.editing === "true") return;
    el.dataset.editing = "true";
    const orig = rec.due || "";
    const input = document.createElement("input");
    input.type = "date"; input.className = "record-edit-date";
    if (/^\d{4}-\d{2}-\d{2}/.test(orig)) input.value = orig.slice(0, 10);
    el.textContent = ""; el.appendChild(input);
    input.focus();
    const commit = () => {
      const v = input.value;
      if (v && v !== orig.slice(0, 10)) commitRecordEdit(rec, "due", v, "substance", false);
      else { el.dataset.editing = ""; el.textContent = orig ? "due " + formatDueDate(orig) : "add date"; }
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", () => setTimeout(commit, 120));
  });
}

/** Make the type chip click-to-edit (Decision ↔ Commitment) via the dropdown. */
function makeEditableType(chip, rec) {
  chip.classList.add("record-editable");
  chip.title = "Click to change type";
  chip.addEventListener("click", () => {
    openRecordEditMenu(chip, [
      { value: "decision", label: "Decision" },
      { value: "commitment", label: "Commitment" },
    ], rec.type || "", (val) => commitRecordEdit(rec, "type", val, "scope", false));
  });
}

/** Wire inline click-to-edit on an already-built record card (type chip, summary,
 *  owner, due). Shared by renderRecordCard + renderDecisionCard. No-op unless the
 *  engine advertised editsEnabled and the record has an id. */
function applyRecordCardEditing(card, rec) {
  if (!_recordEditsEnabled || !rec || !rec.recordId) return;
  const chip = card.querySelector(".record-chip");
  if (chip) makeEditableType(chip, rec);
  // `.record-summary` on cards, `.log-row-summary` on the Today attention row.
  const sum = card.querySelector(".record-summary, .log-row-summary");
  if (sum) makeEditableSummary(sum, rec);
  const owner = card.querySelector(".record-meta-owner");
  if (owner) makeEditableOwner(owner, rec);
  const due = card.querySelector(".record-meta-due");
  if (due) makeEditableDue(due, rec);
}

/** Build the meta line as discrete owner/due spans (editable-targetable). When
 *  editing is off, renders exactly the prior owner · due text; when on, also
 *  shows "add owner"/"add date" affordances so empty fields can be set.
 *  Returns the number of segments appended. */
function buildRecordMetaSegments(meta, rec) {
  const segs = [];
  if (rec.owner || _recordEditsEnabled) {
    const o = document.createElement("span");
    o.className = "record-meta-owner";
    if (!rec.owner) o.classList.add("record-meta-empty");
    o.textContent = rec.owner ? prettySlug(rec.owner) : "add owner";
    segs.push(o);
  }
  if (rec.due || _recordEditsEnabled) {
    const d = document.createElement("span");
    d.className = "record-meta-due";
    if (!rec.due) d.classList.add("record-meta-empty");
    d.textContent = rec.due ? "due " + formatDueDate(rec.due) : "add date";
    segs.push(d);
  }
  segs.forEach((s, i) => {
    if (i) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(s);
  });
  return segs.length;
}

/**
 * Type-chip label for a record. Categorization tolerance (WP-C fold): a
 * commitment upgraded to recordClass 'objective' wears its own quiet label —
 * milestone semantics — the day the objective overlay lights up. Absent or
 * unknown classes keep today's labels exactly (fail-open; never classify
 * client-side).
 */
function recordTypeLabel(rec) {
  if (rec && rec.type !== "decision" && rec.recordClass === "objective") return "Objective";
  return rec && rec.type === "decision" ? "Decision" : "Commitment";
}

function renderRecordCard(rec, recState, lifecycle, recEdges, attribution) {
  const card = document.createElement("div");
  card.className = "record-card";
  card.dataset.type = rec.type || "";
  if (recState) card.dataset.state = recState;

  // Header: type chip + (state pill when not open).
  // (Type-chip labels flow through recordTypeLabel so the WP-C 'objective'
  // upgrade renders its own quiet variant the day the overlay lights up.)
  const header = document.createElement("div");
  header.className = "record-header";

  const chip = document.createElement("span");
  chip.className = "record-chip";
  chip.dataset.type = rec.type || "";
  chip.textContent = recordTypeLabel(rec);
  header.appendChild(chip);

  if (recState && recState !== "open") {
    const statePill = document.createElement("span");
    statePill.className = "record-state-pill";
    statePill.dataset.state = recState;
    statePill.textContent = recState === "superseded" ? "Replaced" : "Resolved";
    header.appendChild(statePill);
  }
  card.appendChild(header);

  // Summary.
  const summary = document.createElement("p");
  summary.className = "record-summary";
  summary.textContent = rec.summary || "";
  card.appendChild(summary);

  // Meta: owner · due dim (editable spans); the overdue/silent count amber.
  const cardOverdue =
    lifecycle && lifecycle.overdueSilent && typeof lifecycle.silentDays === "number";
  {
    const meta = document.createElement("p");
    meta.className = "record-meta";
    const segCount = buildRecordMetaSegments(meta, rec);
    if (cardOverdue) {
      if (segCount) meta.appendChild(document.createTextNode(" · "));
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
    if (meta.childNodes.length) card.appendChild(meta);
  }

  // Verbatim — via the ONE receipt component (quote-only here; the source badge
  // rides in the actions row below, so jump is off on this instance).
  if (rec.verbatimVerified === true && rec.verbatim) {
    card.appendChild(
      renderReceipt(
        { verbatim: rec.verbatim, verbatimVerified: rec.verbatimVerified },
        { jump: false, variant: "receipt-record" },
      ),
    );
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
    // WP-Grouping-Operator P4 — open the JOB's receipts (its full action set +
    // canonical name) when the record is job-grouped; else the entity's. Hot-
    // list records' primaryEntity is the section (e.g. "rsv"), so preferring
    // parentJob is what reaches a job's receipts instead of section-receipts.
    btn.addEventListener("click", () =>
      enterReceiptsView((rec.parentJob || "").replace(/^job:/, "") || rec.primaryEntity));
    actions.appendChild(btn);
  }
  appendSourceBadge(actions, rec.documentId, rec.verbatim);
  appendResolveSnoozeControls(actions, rec.recordId, card, rec.summary);
  appendDraftFollowUpControl(actions, rec);
  appendDismissControl(actions, rec.recordId, card, rec.summary);
  card.appendChild(actions);

  applyRecordCardEditing(card, rec);
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
        ? { icon: "⤳", label: "Replaces: " + otherSummary }
        : { icon: "⤳", label: "Replaced by: " + otherSummary };
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
// ───────── WP-VIGILANCE-VOID — "Watching for…" surface ─────────
//
// Read-only list of OPEN voids (GET /api/vigilance/voids via fetch_vigilance_voids):
// records we're expecting back — an enabling record for a blocked dependency, a
// reconciliation of a conflict, closing evidence on an overdue commitment, or a
// reply to something sent. Server-rendered `render` string is the source of truth
// for the card line; we add a trigger pill, a ~Nd cadence, and (when known) the
// named senders. A void with no attributable sender (license INTERPRET) is shown
// honestly unnamed. Fills are detected server-side at ingestion; a filled void
// simply drops off this list, so Refresh is the "did it arrive?" gesture in v1.

const VOID_TRIGGER_LABEL = {
  egress: "Awaiting reply",
  "contradicts-unresolved": "Needs reconciliation",
  "depends-on-incomplete": "Blocked dependency",
  "overdue-silent": "Overdue · silent",
};

function vvIsNamedSlug(s) {
  return !!s && !/^speaker-\d+$/i.test(s) && !/^<?unknown>?$/i.test(s);
}

function vvActionBtn(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "watching-action-btn";
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// Dismiss / snooze a void, then re-fetch so it drops off (or re-surfaces if a
// re-surface condition holds). Reasons drive server-side calibration.
async function vvVoidAction(cmd, args) {
  try {
    await tauri.core.invoke(cmd, args);
  } catch (err) {
    console.warn(`[main] ${cmd} failed:`, err);
  }
  // Re-render whichever surface hosts these void cards. On Today (WP-R2) the
  // voids live in the Needs-you queue, so re-run the queue's void source (a full
  // enterLogView would needlessly re-fetch every section); on the (retired)
  // Watching view, re-enter it. Detect by which view is currently shown.
  const logView = document.getElementById("view-log");
  if (logView && !logView.hidden) {
    // Clear only the void cards from the queue, then re-fetch them. Proxy cards
    // and the question card in the queue are left in place (different sources).
    const list = document.getElementById("today-queue-list");
    if (list) {
      for (const el of Array.from(list.querySelectorAll(".watching-card"))) el.remove();
    }
    loadTodayQueueVoids(() => {}).catch((e) => console.warn("[main] void re-render:", e));
    return;
  }
  enterWatchingView();
}
function vvHumanizeSlug(s) {
  return (s || "").split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// WP-Job-Vigilance-Wave2 UI — resolve a void to its anchor RECORD id. The backend
// carries the record either as the void's anchor (anchorType "record") or via the
// blocked-record context; prefer the explicit anchor, fall back to the blocked id.
function vvVoidRecordId(v) {
  if (v && v.anchorType === "record" && v.anchorId) return v.anchorId;
  const blocked = v && v.context && v.context.blocked;
  return (blocked && blocked.recordId) || (v && v.anchorId) || "";
}

// The full record for a void (from the decision-log join), or null when absent.
function vvVoidRecord(v) {
  const rid = vvVoidRecordId(v);
  return rid ? _vigilanceRecordsById.get(rid) || null : null;
}

// Build the work-forest breadcrumb (frame › workstream › job) for a void, mirroring
// the hierarchy the Log groups by: recordId → recordJobs[jobKey] → jobNames (job),
// then the frame whose jobKeys contains it (workstream = a frame with a parent;
// top frame = its root). Returns a breadcrumb element, or null when the record
// doesn't resolve to a job (degrade silently — same as the Log's "Unframed").
function vvBuildHierarchy(v) {
  const rid = vvVoidRecordId(v);
  if (!rid) return null;
  const jobKey = _vigilanceRecordJobs[rid];
  if (!jobKey) return null;

  // Job name (canonical, jobNames join; falls back to prettified slug).
  const jobName = stalledName(jobKey);

  // Frame chain: find the frame owning this job, then walk parentFid to the root.
  const byFid = new Map(_vigilanceFrames.map((f) => [f.fid, f]));
  let owning = null;
  for (const f of _vigilanceFrames) {
    if (Array.isArray(f.jobKeys) && f.jobKeys.includes(jobKey)) { owning = f; break; }
  }
  let topFrame = owning, wsName = null;
  if (owning && owning.parentFid != null) {
    wsName = owning.name; // the owning frame is a workstream under a top frame
    let c = owning, n = 0;
    while (c && c.parentFid != null && n++ < 50) c = byFid.get(c.parentFid) || null;
    topFrame = c || owning;
  }

  // Render as the same breadcrumb wayfinding the Log uses: Frame › Workstream › Job.
  const crumb = document.createElement("p");
  crumb.className = "watching-hierarchy";
  const parts = [];
  if (topFrame && topFrame.name) parts.push(topFrame.name);
  if (wsName && wsName !== (topFrame && topFrame.name)) parts.push(wsName);
  parts.push(jobName);
  crumb.textContent = parts.join(" › ");
  return crumb;
}

function renderVoidCard(v, opts) {
  const card = document.createElement("div");
  card.className = "record-card watching-card";
  card.dataset.license = v.license || "";
  const ctx = v.context || { waitingOn: [] };
  const waitingOn = Array.isArray(ctx.waitingOn) ? ctx.waitingOn : [];
  // WP-Job-Vigilance-Wave2 — silent-days joined from grouped.scoredVoids (the
  // flat void carries forward-looking whenDays, not the stalled "N days silent").
  const ageDays = opts && typeof opts.ageDays === "number" ? opts.ageDays : null;

  // WP-Job-Vigilance-Wave2 UI — two-zone header (mirrors the Log decision card's
  // `record-header record-header-split`): the trigger/motif meta sits LEFT, and an
  // optional top-right ACTION badge ("Draft follow-up") sits RIGHT. Placing the
  // trigger at top-right (not the mid-card action row) makes positionPopover anchor
  // its inline editor cleanly, exactly like the Log's "Share decision ›".
  const header = document.createElement("div");
  header.className = "record-header record-header-split watching-header";

  // Compact meta zone (LEFT): trigger pill + motif + cadence + silent-Nd.
  const meta = document.createElement("div");
  meta.className = "watching-meta";
  // WP-Job-Vigilance-Wave2 UI (change 1) — fold a ROUNDED whole-day silent count
  // into the trigger pill's existing neutral styling ("Overdue · silent · 25d")
  // rather than a standalone red raw-float span. Keeps the duration signal; kills
  // the red score Ross flagged.
  let label = VOID_TRIGGER_LABEL[v.trigger] || v.trigger || "Watching";
  if (ageDays != null) {
    label += ` · ${Math.round(ageDays)}d`;
  }
  let metaHtml = `<span class="watching-pill">${escapeHtml(label)}</span>`;
  // Motif (additive, server-side) — the graph-shape that detected this void.
  if (v.motif) {
    metaHtml += `<span class="watching-motif">${escapeHtml(stalledMotifLabel(v.motif))}</span>`;
  }
  if (ageDays == null && typeof v.whenDays === "number") {
    metaHtml += `<span class="watching-when">expected within ~${v.whenDays}d</span>`;
  }
  meta.innerHTML = metaHtml;
  header.appendChild(meta);

  // Resolve the void's anchor record once — used by the top-right follow-up badge
  // and (below) the source badge in the action row.
  const anchorRec = vvVoidRecord(v);

  // WP-Job-Vigilance-Wave2 UI (change 4) — top-right "Draft follow-up" ACTION badge,
  // mirroring the Log's "Share decision ›" placement + treatment exactly: a
  // makeBadge("is-decision", …, { onClick }) so it gets the blue is-decision style +
  // is-clickable hover + the CSS `›` caret (no bordered pill). Clicking opens the
  // SAME inline editable-draft editor (openShareMenu + buildFollowUpDraft) from
  // b224956 — only the trigger's DOM position/treatment changed. Shown only when the
  // record resolves AND has an owner (mirror the Log guard: no owner → nothing to draft).
  if (anchorRec && anchorRec.owner) {
    header.appendChild(
      makeBadge("is-decision", "Draft follow-up", {
        title: "Draft a note following up on this outstanding promise",
        onClick: (el) =>
          openShareMenu(
            el,
            anchorRec,
            // Minimal ctx: byId for tie-back lookups; no edges/relationship cached on
            // the vigilance surface, so related-items + counterparty resolve empty
            // (a clean nudge to the owner, no decision tie-backs).
            { byId: _vigilanceRecordsById, edges: [], recordRelationship: {} },
            {
              draftBuilder: buildFollowUpDraft,
              heading: (w) => "Follow up with " + (w ? w : prettySlug(anchorRec.owner)),
              title: (r) => (r.summary ? "Follow up: " + r.summary : "Follow up"),
              sourceKind: anchorRec.type === "decision" ? "decision" : "commitment",
              idPrefix: "followup:",
            },
          ),
      }),
    );
  }
  card.appendChild(header);

  // WP-Job-Vigilance-Wave2 UI (change 2) — work-forest breadcrumb (frame › job),
  // the same hierarchy the Log shows, so a card reads in org context. Null (and
  // omitted) when the void's record doesn't resolve to a job — degrade silently.
  const hierarchy = vvBuildHierarchy(v);
  if (hierarchy) card.appendChild(hierarchy);

  // Headline: what this is actually about (the present/blocked record), or the
  // server's one-line render when there's no record context (e.g. a sent digest).
  const headline = document.createElement("p");
  headline.className = "watching-headline";
  headline.textContent = ctx.blocked ? ctx.blocked.summary : (v.render || "Watching for a record.");
  card.appendChild(headline);

  // Waiting on: the concrete enabling records (or the contradicting counterpart).
  if (waitingOn.length) {
    const wrap = document.createElement("div");
    wrap.className = "watching-waiting";
    const lab = document.createElement("p");
    lab.className = "watching-waiting-label";
    lab.textContent = v.trigger === "contradicts-unresolved" ? "Conflicts with" : "Waiting on";
    wrap.appendChild(lab);
    const ul = document.createElement("ul");
    ul.className = "watching-waiting-list";
    for (const w of waitingOn) {
      const li = document.createElement("li");
      li.className = "watching-waiting-item";
      // Name the owner only when attributable (not an unresolved speaker-N); the
      // summary text itself usually names the person anyway.
      const owner = vvIsNamedSlug(w.owner)
        ? `<span class="watching-waiting-owner">${escapeHtml(vvHumanizeSlug(w.owner))}</span> — `
        : "";
      const due = w.due ? `<span class="watching-waiting-due"> · due ${escapeHtml(w.due)}</span>` : "";
      li.innerHTML = `${owner}<span class="watching-waiting-text">${escapeHtml(w.summary)}</span>${due}`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    card.appendChild(wrap);
  }

  // Unnamed void (no attributable sender): surface topical neighbours dimmed and
  // clearly labelled — never as "from" (mirrors the server's structural/topical split).
  if (Array.isArray(v.whoTopical) && v.whoTopical.length && (!v.who || !v.who.length)) {
    const t = document.createElement("p");
    t.className = "watching-topical";
    t.textContent = `possibly related: ${v.whoTopical.join(", ")}`;
    card.appendChild(t);
  }

  // HITL controls: snooze, or dismiss with a reason. A dismiss re-surfaces later
  // if the snooze elapses, it breaches its cadence, or it materially strengthens.
  const actions = document.createElement("div");
  actions.className = "watching-actions";
  const reasons = document.createElement("div");
  reasons.className = "watching-reasons";
  reasons.hidden = true;

  const snooze = vvActionBtn("Snooze", () => vvVoidAction("snooze_void", { voidId: v.voidId, days: 7 }));
  snooze.title = "Snooze — hide for 7 days";
  const dismiss = vvActionBtn("Dismiss", () => { actions.hidden = true; reasons.hidden = false; });
  actions.append(snooze, dismiss);

  // WP-Job-Vigilance-Wave2 UI (change 3) — link to the original captured item.
  // Reuse renderSourceBadge: anchor record → documentId → the source-reader panel
  // the Log opens. No badge when the doc/metadata isn't loaded (invisible-by-absence).
  if (anchorRec && anchorRec.documentId) {
    appendSourceBadge(actions, anchorRec.documentId, anchorRec.verbatim);
  }

  for (const [reason, label] of [["handling-it", "Handling it"], ["not-watching", "Not watching"], ["not-real", "Not real"]]) {
    reasons.appendChild(vvActionBtn(label, () => vvVoidAction("dismiss_void", { voidId: v.voidId, reason })));
  }
  const cancel = vvActionBtn("Cancel", () => { reasons.hidden = true; actions.hidden = false; });
  cancel.classList.add("watching-action-cancel");
  reasons.appendChild(cancel);

  card.append(actions, reasons);

  return card;
}

// A receipt: a void the ingress magnet confirmed has arrived. Shows what we were
// watching for + the citation-checked quote from the document that fulfilled it.
function renderArrivedCard(v) {
  const card = document.createElement("div");
  card.className = "record-card watching-card arrived-card";
  const ctx = v.context || { waitingOn: [] };
  const fb = v.filledBy || {};

  const meta = document.createElement("div");
  meta.className = "watching-meta";
  let when = "";
  if (fb.filledAt) {
    const d = new Date(fb.filledAt);
    if (!Number.isNaN(d.getTime())) when = `<span class="watching-when">${d.toLocaleDateString()}</span>`;
  }
  meta.innerHTML = `<span class="watching-pill arrived-pill">ARRIVED</span>${when}`;
  card.appendChild(meta);

  // What we were watching for.
  const headline = document.createElement("p");
  headline.className = "watching-headline";
  headline.textContent = ctx.blocked ? ctx.blocked.summary : (v.render || "An expected record arrived.");
  card.appendChild(headline);

  // The evidence — the citation-checked quote from the filling document, plus its
  // provenance line, via the ONE receipt component. Verbatim here is checked by
  // arrival (no separate verbatimVerified flag), so we mark it verified; jump is
  // off (the void flow doesn't wire the source pane) so the source shows as text.
  if (fb.verbatim || fb.documentId) {
    card.appendChild(
      renderReceipt(
        {
          verbatim: fb.verbatim,
          verbatimVerified: !!fb.verbatim,
          sourceFallback: fb.documentId ? `from ${fb.documentId}` : "",
        },
        { jump: false, quoteWrap: true, variant: "receipt-arrived" },
      ),
    );
  }

  // Clear the receipt once seen (acknowledge). A filled void can't re-surface, so
  // a cleared receipt stays cleared for this viewer.
  const actions = document.createElement("div");
  actions.className = "watching-actions";
  actions.appendChild(vvActionBtn("Dismiss", () => vvVoidAction("dismiss_void", { voidId: v.voidId, reason: "acknowledged" })));
  card.appendChild(actions);

  return card;
}

async function enterWatchingView() {
  state.inWizard = false;
  showView("view-watching");
  setNav([{ label: "Watching" }], { active: "watching", back: () => goHome() });

  const statusEl = document.getElementById("watching-status");
  const listEl = document.getElementById("watching-list");
  const emptyEl = document.getElementById("watching-empty");
  const subEl = document.getElementById("watching-sub");
  const arrivedSection = document.getElementById("watching-arrived-section");
  const arrivedList = document.getElementById("watching-arrived-list");

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Loading what you're watching for…";
  }
  if (listEl) listEl.innerHTML = "";
  if (arrivedList) arrivedList.innerHTML = "";
  if (arrivedSection) arrivedSection.hidden = true;
  if (emptyEl) emptyEl.hidden = true;

  // WP-Job-Vigilance-Wave2 — the Watching tab is now the passive LEDGER. Fetch
  // ?grouped=1 so we can (a) join silent-Nd onto the flat void cards and (b)
  // split off the "Low-impact waiting" drawer (monitor/quiet-band + singleton
  // voids the Focus chase-list suppresses). Feature-detects: when `grouped` is
  // absent the ledger renders exactly today's flat behavior (ship gate G4).
  // WP-Job-Vigilance-Wave2 UI — load the documentId→doc map so void cards can
  // render the source badge (open/link to the original captured item). Best-effort;
  // a failure just leaves badges absent (renderSourceBadge no-ops without _docsById).
  await loadDocsMap();

  let data, grouped;
  try {
    const result = await fetchVigilanceGrouped();
    if (!result) throw new Error("vigilance fetch failed");
    data = result.voidData;
    grouped = result.grouped; // null when flag off / old backend
  } catch (err) {
    console.warn("[main] fetch_vigilance_voids failed:", err);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        "Couldn't reach Apolla. Check your connection in Configure, then Refresh.";
    }
    return;
  }

  if (statusEl) statusEl.hidden = true;

  const voids = Array.isArray(data && data.voids) ? data.voids : [];
  const arrived = Array.isArray(data && data.arrived) ? data.arrived : [];

  // Build the silent-Nd join (voidId -> ageDays) and the low-impact voidId set
  // from grouped. Low-impact = voids on stalled jobs that DON'T make the primary
  // chase-list (monitor/quiet band & low surfaceScore) OR singleton jobs.
  const ageByVoid = new Map();
  const lowImpactVoidIds = new Set();
  if (grouped && Array.isArray(grouped.stalledJobs)) {
    for (const job of grouped.stalledJobs) {
      const isPrimary = stalledIsPrimary(job, stalledBand(job.jobKey));
      const isSingleton = (job.voidCount || 0) <= 1 && !(job.blockerCount || 0);
      for (const sv of job.scoredVoids || []) {
        if (typeof sv.ageDays === "number") ageByVoid.set(sv.voidId, sv.ageDays);
        if (!isPrimary || isSingleton) lowImpactVoidIds.add(sv.voidId);
      }
    }
  }

  // Partition the flat voids into the primary ledger vs the low-impact drawer.
  const primaryVoids = voids.filter((v) => !lowImpactVoidIds.has(v.voidId));
  const lowImpactVoids = voids.filter((v) => lowImpactVoidIds.has(v.voidId));

  if (subEl) {
    subEl.textContent =
      voids.length > 0
        ? `${voids.length} ${voids.length === 1 ? "thing" : "things"} you're expecting back`
        : "What you're expecting back";
  }

  // Receipts first — what recently came back.
  if (arrived.length && arrivedList && arrivedSection) {
    for (const v of arrived) arrivedList.appendChild(renderArrivedCard(v));
    arrivedSection.hidden = false;
  }

  // Still-open voids — primary list (each with motif + silent-Nd join).
  if (listEl) {
    for (const v of primaryVoids) {
      listEl.appendChild(renderVoidCard(v, { ageDays: ageByVoid.get(v.voidId) }));
    }

    // "Low-impact waiting" drawer — the monitor/quiet + singleton voids the Focus
    // chase-list suppresses. Present for completeness/audit, collapsed by default.
    if (lowImpactVoids.length) {
      const drawer = makeCollapsible("Low-impact waiting", lowImpactVoids.length, false);
      const note = document.createElement("p");
      note.className = "watching-drawer-note";
      note.textContent = "Lower-priority promises still being watched — not crowding the Focus chase-list.";
      drawer.body.appendChild(note);
      for (const v of lowImpactVoids) {
        drawer.body.appendChild(renderVoidCard(v, { ageDays: ageByVoid.get(v.voidId) }));
      }
      listEl.appendChild(drawer.section);
    }
  }
  // Empty state only when there's nothing open AND nothing recently arrived.
  if (emptyEl) emptyEl.hidden = !(voids.length === 0 && arrived.length === 0);
}

// ══════════════════════════════════════════════════════════════════════════
// WP-R2 Today rebuild — paint-first Today.
//
// enterLogView paints the skeleton (index.html's three sections + tray) and any
// synchronous state IMMEDIATELY, then fires each data source fire-and-forget OFF
// the critical path. Each source re-renders ONLY its own section when it lands,
// guarded so a slow/failed/absent one can't blank Today or abort the others.
// This preserves the < 1s cold first-paint gate (§2.6) — the exact async-
// enrichment pattern from commit 7a1475f (decisions view), applied to Today.
//
// Paint order (WP-TODAY-BRIEF, Ross 2026-07-12 — four strata, one per intention):
//   ① Don't miss    — vigilance voids + readiness no-precursor (curated, capped)
//   ② Your week     — fetch_decision_log_full → this-week runway rows,
//                     fortnight collapsed
//   ③ Your plan     — plan slot (future packet) + fetch_outbox draft rows
//   ④ One question  — fetch_question + name/merge asks + proxy wants-your-eye,
//                     ONE at a time
// The narrative composes only on the header button; the board/conflicts/
// workload live in the Log (Ross 2026-07-12).
//
// NOTHING LLM-backed or network-backed is awaited before the first paint below.
// ══════════════════════════════════════════════════════════════════════════
async function enterLogView() {
  state.inWizard = false;
  showView("view-log");
  setNav([{ label: "Today" }], { active: "today", back: () => goHome() });

  // Record-level inline editing reload hook (Phase A). Capability flag is set
  // when the decision-log source lands (renderTodayDecisionLog).
  _reloadRecordView = enterLogView;

  // ── FIRST PAINT (synchronous) ──────────────────────────────────────────────
  // Reset each stratum to its skeleton/empty resting state and wire the
  // idempotent toggles. No await, no network — this returns to the event loop
  // before any data source resolves, so the paint is immediate.
  renderTodaySkeleton();
  wireTodayFiledToggle();

  // ── FIRE-AND-FORGET ENRICHMENT (off the critical path) ──────────────────────
  // Each source patches its own section when it lands; each is independently
  // guarded so a slow/failed/absent one can't blank Today or abort the others.

  // The context join resolves the viewer identity (Mine filter) before the
  // strata that use it fire. The narrative does NOT auto-compose — the brief's
  // four intentions don't include a standing report (Ross 2026-07-12); the
  // header State-of-Play button composes it on demand.
  loadTodayContext()
    .then(() => {
      renderTodayDecisionLog().catch((e) => console.warn("[main] decision-log summary:", e));
      // ② Your week (also contributes ①'s no-precursor rows + the Log line count).
      loadTodayComingUp().catch((e) => console.warn("[main] Your week:", e));
    })
    .catch((e) => {
      console.warn("[main] Today context:", e);
      renderTodayDecisionLog().catch(() => {});
      loadTodayComingUp().catch(() => {});
    });

  // The State-of-Play narrative is Today's FIRST stratum — it must load itself.
  // Historically the panel was click-to-open, and the (since-fixed) identity-less
  // lens-panel fallback happened to render the forest narrative on entry — the
  // duplication bug was accidentally the auto-loader. Now the main panel opens
  // and composes on entry; the header button remains the collapse/expand toggle,
  // and re-entering Today keeps already-composed prose instead of re-paying the
  // synthesis.
  // ① Don't miss — the vigilance half of the curated list (② adds the
  //    readiness half when the full records land).
  loadTodayMissVoids().catch((e) => console.warn("[main] Don't miss (voids):", e));

  // ③ Your plan + ④'s staged half — ONE packet fetch feeds both (the same
  //    packet the companion's check-ins read; the drift rule, 2026-07-12).
  loadTodayPlan().catch((e) => console.warn("[main] Your plan:", e));

  // ④ Prepared for you — the outbox half (approved, awaiting send).
  loadTodayPlanDrafts().catch((e) => console.warn("[main] Prepared for you:", e));

  // ④ One question — the organizing-question queue, one at a time.
  loadTodayQuestions().catch((e) => console.warn("[main] Questions:", e));
}

// Reset every Today section to its resting skeleton/empty state (synchronous —
// no network). Called at the top of every enterLogView so a re-entry starts
// clean before the async sources repopulate.
function renderTodaySkeleton() {
  // Header sub — the brief leads with the date; counts append when the
  // decision-log summary lands.
  const sub = document.getElementById("log-sub");
  if (sub) {
    const now = new Date();
    sub.textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  // ① Don't miss — clear rows, show the skeleton, hide empty + the Log line.
  const missList = document.getElementById("today-miss-list");
  if (missList) missList.innerHTML = "";
  const missSkel = document.getElementById("today-miss-skeleton");
  if (missSkel) missSkel.hidden = false;
  const missEmpty = document.getElementById("today-miss-empty");
  if (missEmpty) missEmpty.hidden = true;
  const missMore = document.getElementById("today-miss-more");
  if (missMore) missMore.hidden = true;
  const missCount = document.getElementById("today-miss-count");
  if (missCount) missCount.textContent = "";
  _missPool = [];
  _missSettled = { voids: false, week: false };

  // ② Your week — hidden until the full-records source lands.
  const nextWeeks = document.getElementById("today-nextweeks-section");
  if (nextWeeks) nextWeeks.hidden = true;
  for (const id of ["today-outlook-rows", "today-outlook-rest"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }
  const restWrap = document.getElementById("today-outlook-rest");
  if (restWrap) restWrap.hidden = true;
  const restToggle = document.getElementById("today-week-rest-toggle");
  if (restToggle) { restToggle.hidden = true; restToggle.setAttribute("aria-expanded", "false"); }
  const nextWeeksCount = document.getElementById("today-nextweeks-count");
  if (nextWeeksCount) nextWeeksCount.textContent = "";

  // ③ Your plan — hidden until the packet lands with present:true.
  const planSection = document.getElementById("today-planrec-section");
  if (planSection) planSection.hidden = true;
  const planList = document.getElementById("today-planrec-list");
  if (planList) planList.innerHTML = "";
  const planOpen = document.getElementById("today-planrec-open");
  if (planOpen) { planOpen.hidden = true; planOpen.setAttribute("aria-expanded", "false"); }
  const planOpenList = document.getElementById("today-planrec-open-list");
  if (planOpenList) { planOpenList.innerHTML = ""; planOpenList.hidden = true; }
  const planCount = document.getElementById("today-planrec-count");
  if (planCount) planCount.textContent = "";
  const planWhen = document.getElementById("today-planrec-when");
  if (planWhen) planWhen.textContent = "";

  // ④ Prepared for you — both lists clear; the Log line waits for the summary.
  for (const id of ["today-prework-list", "today-outbox-list"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }
  const preparedEmpty = document.getElementById("today-prepared-empty");
  if (preparedEmpty) preparedEmpty.hidden = true;
  const planLine = document.getElementById("today-plan-log-line");
  if (planLine) planLine.hidden = true;
  const preparedCount = document.getElementById("today-prepared-count");
  if (preparedCount) preparedCount.textContent = "";
  _preparedSettled = { prework: false, outbox: false };

  // ④ One question — clear both slots; the filed line hides until data.
  const qSlot = document.getElementById("today-question-slot");
  if (qSlot) qSlot.innerHTML = "";
  const qRest = document.getElementById("today-question-rest");
  if (qRest) { qRest.innerHTML = ""; qRest.hidden = true; }
  const qMore = document.getElementById("today-question-more");
  if (qMore) { qMore.hidden = true; qMore.setAttribute("aria-expanded", "false"); }
  const qCount = document.getElementById("today-question-count");
  if (qCount) qCount.textContent = "";
  const qEmpty = document.getElementById("today-question-empty");
  if (qEmpty) qEmpty.hidden = true;
  const filedSection = document.getElementById("today-filed-section");
  if (filedSection) filedSection.hidden = true;
  const filedList = document.getElementById("today-filed-list");
  if (filedList) filedList.innerHTML = "";

  // Runway rows start COLLAPSED on every entry (Ross 2026-07-12: an expanded
  // step plan made "Due this week" read as the plan stratum) — the set still
  // preserves expansion across a gesture's re-render within the view.
  _outlookExpanded.clear();

  // Debug containers + status reset.
  for (const id of ["log-priority-sections", "log-stalled-sections"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  }
  const statusEl = document.getElementById("log-status");
  if (statusEl) statusEl.hidden = true;
}

// Toggle the demoted "Filed automatically" line inside "Waiting on you"
// (collapsed by default). Idempotent — binds the click handler once across
// re-renders.
function wireTodayFiledToggle() {
  const toggle = document.getElementById("today-filed-toggle");
  const list = document.getElementById("today-filed-list");
  if (!toggle || !list || toggle.dataset.wired) return;
  toggle.dataset.wired = "1";
  const chevron = toggle.querySelector(".proxy-pile-chevron");
  toggle.addEventListener("click", () => {
    const open = list.hidden; // about to open if currently hidden
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (chevron) chevron.textContent = open ? "▾" : "▸";
  });
}

// ── Today context: viewer identity + capture-attribution join ───────────────
// Resolves the viewer email/slug (for the Mine filter + person-lens SoP) and the
// documentId → submitter map (for the attribution join on the decision-log
// rollup). Best-effort: a null identity hides the toggle + the person lens (the
// forest fallback is used); a failed /api/data join simply omits attribution.
// Stored on _todayCtx so the SoP + rollup can read it without re-fetching.
async function loadTodayContext() {
  await refreshDismissedIds();
  await loadDocsMap();
  const viewerEmail = await getViewerEmail();
  const submitterByDoc = new Map();
  // documentId → projects[] — the same map the Decisions By-project lens groups on
  // (built in enterDecisionsView from fetch_documents). Reused here so the Today
  // "Needs attention" rows group by project. Best-effort: empty ⇒ ungrouped.
  const docProjects = new Map();
  try {
    const docsResp = await tauri.core.invoke("fetch_documents");
    const docs = docsResp && Array.isArray(docsResp.documents) ? docsResp.documents : [];
    for (const d of docs) {
      if (d && d.id && typeof d.submittedByEmail === "string" && d.submittedByEmail) {
        submitterByDoc.set(d.id, d.submittedByEmail);
      }
      if (d && d.id) docProjects.set(d.id, Array.isArray(d.projects) ? d.projects : []);
    }
  } catch (err) {
    console.warn("[main] fetch_documents failed (attribution/projects omitted):", err);
  }
  _todayCtx = {
    needsAttention: (_todayCtx && _todayCtx.needsAttention) || [],
    submitterByDoc,
    docProjects,
    viewerEmail,
    viewerSlug: viewerEmail ? emailToOwnerSlug(viewerEmail) : null,
  };
  // The Mine / Everyone toggle exists only for an identified viewer.
  const filterEl = document.getElementById("log-filter");
  if (filterEl) filterEl.hidden = !viewerEmail;
  setTodayFilter("everyone"); // default Everyone on each view load
}

// ══════════════════════════════════════════════════════════════════════════
// WP-TODAY-BRIEF ① — "Don't miss": the curated might-slip list. Two async
// sources contribute to one shared pool (vigilance voids here; the readiness
// no-precursor join arrives with ② from the full records), each replacing only
// its own entries. Rows render compact — one line, expand in place for the
// full card/actions — ranked people-waiting-on-you first, then due-with-no-
// movement, then the rest, capped at TODAY_MISS_CAP. Everything past the cap
// and the overdue tail live behind ONE quiet line into the Log (fail-closed-
// but-VISIBLE — counted, never hidden).
// ══════════════════════════════════════════════════════════════════════════
const TODAY_MISS_CAP = 4;
let _missPool = [];
let _missSettled = { voids: false, week: false };
let _todayOverdueCount = null; // set by loadTodayComingUp (open, due < today)

function missContribute(source, entries) {
  _missPool = _missPool
    .filter((e) => e.source !== source)
    .concat(entries.map((e) => ({ ...e, source })));
  renderTodayMiss();
}
function missSettle(source) {
  _missSettled[source] = true;
  renderTodayMiss();
}

function renderTodayMiss() {
  const list = document.getElementById("today-miss-list");
  if (!list) return;
  const skel = document.getElementById("today-miss-skeleton");
  const emptyEl = document.getElementById("today-miss-empty");
  const countEl = document.getElementById("today-miss-count");
  const moreBtn = document.getElementById("today-miss-more");

  const ranked = _missPool
    .slice()
    .sort((a, b) => (a.rank - b.rank) || ((a.order || 0) - (b.order || 0)));
  const show = ranked.slice(0, TODAY_MISS_CAP);

  list.innerHTML = "";
  for (const e of show) list.appendChild(renderMissRow(e));

  const allSettled = _missSettled.voids && _missSettled.week;
  if (skel) skel.hidden = show.length > 0 || allSettled;
  if (emptyEl) emptyEl.hidden = !(allSettled && show.length === 0);
  if (countEl) countEl.textContent = show.length ? String(show.length) : "";

  // The one quiet line into the Log: pool overflow + the overdue tail.
  if (moreBtn) {
    const overflow = ranked.length - show.length;
    const overdue = typeof _todayOverdueCount === "number" ? _todayOverdueCount : 0;
    const parts = [];
    if (overdue > 0) parts.push(`${overdue} older overdue`);
    if (overflow > 0) parts.push(`${overflow} more watched`);
    if (allSettled && parts.length) {
      moreBtn.textContent = parts.join(" · ") + " — all in the Log →";
      moreBtn.hidden = false;
      if (!moreBtn.dataset.wired) {
        moreBtn.dataset.wired = "1";
        moreBtn.addEventListener("click", () => enterDecisionsView("open", { from: "today" }));
      }
    } else {
      moreBtn.hidden = true;
    }
  }
}

// One compact might-slip row: quiet tag + one-line text; click expands the
// full existing card (void card / workback reasoning) in place, lazily.
function renderMissRow(e) {
  const wrap = document.createElement("div");
  wrap.className = "today-miss-item";
  const row = document.createElement("button");
  row.type = "button";
  row.className = "today-miss-row";
  row.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.className = "today-miss-text";
  text.textContent = e.line;
  text.title = e.line;
  row.appendChild(text);
  if (e.tag) {
    const tag = document.createElement("span");
    tag.className = "today-miss-tag";
    tag.textContent = e.tag;
    row.appendChild(tag);
  }
  const detail = document.createElement("div");
  detail.className = "today-miss-detail";
  detail.hidden = true;
  row.addEventListener("click", () => {
    const open = detail.hidden;
    if (open && !detail.childNodes.length && typeof e.detail === "function") {
      try { detail.appendChild(e.detail()); } catch (err) { console.warn("[main] miss detail:", err); }
    }
    detail.hidden = !open;
    row.setAttribute("aria-expanded", open ? "true" : "false");
  });
  wrap.appendChild(row);
  wrap.appendChild(detail);
  return wrap;
}

// ══════════════════════════════════════════════════════════════════════════
// WP-TODAY-BRIEF ④ — "One question for you". Every organizing question the
// engine has (Question-Engine card, name asks, merge asks, proxy wants-your-
// eye reviews) collects into ONE queue; the first renders, the rest wait
// behind an honest count. Each source degrades to [] on failure/flag-off.
// ══════════════════════════════════════════════════════════════════════════
async function loadTodayQuestions() {
  const slot = document.getElementById("today-question-slot");
  const rest = document.getElementById("today-question-rest");
  const moreBtn = document.getElementById("today-question-more");
  const countEl = document.getElementById("today-question-count");
  const emptyEl = document.getElementById("today-question-empty");
  if (!slot) return;

  const [qe, nameAsks, mergeAsks, proxy] = await Promise.all([
    collectQuestionEngineCard().catch((e) => { console.warn("[main] QE card:", e); return []; }),
    collectNameAskCards().catch((e) => { console.warn("[main] name asks:", e); return []; }),
    collectMergeAskCards().catch((e) => { console.warn("[main] merge asks:", e); return []; }),
    collectProxyCards().catch((e) => { console.warn("[main] proxy queue:", e); return []; }),
  ]);
  const cards = [...qe, ...mergeAsks, ...nameAsks, ...proxy];

  slot.innerHTML = "";
  if (rest) { rest.innerHTML = ""; rest.hidden = true; }
  if (moreBtn) { moreBtn.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }

  if (!cards.length) {
    if (countEl) countEl.textContent = "";
    // The calm pull affordance still renders solo when the engine is on.
    const pull = buildQuestionSection();
    if (pull) {
      slot.appendChild(pull);
      if (emptyEl) emptyEl.hidden = true;
    } else if (emptyEl) {
      emptyEl.hidden = false;
    }
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  slot.appendChild(cards[0]);
  const waiting = cards.length - 1;
  if (countEl) countEl.textContent = waiting > 0 ? `${waiting} more waiting` : "";
  if (waiting > 0 && rest && moreBtn) {
    for (const c of cards.slice(1)) rest.appendChild(c);
    const closed = `▸ show the ${waiting} waiting`;
    moreBtn.textContent = closed;
    moreBtn.hidden = false;
    if (!moreBtn.dataset.wired) {
      moreBtn.dataset.wired = "1";
      moreBtn.addEventListener("click", () => {
        const open = rest.hidden;
        rest.hidden = !open;
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        moreBtn.textContent = open ? "▾ later questions" : (moreBtn.dataset.closedLabel || closed);
      });
    }
    moreBtn.dataset.closedLabel = closed;
  }
}

// The Question-Engine card (only a REAL surfaced card counts — the bare pull
// affordance renders via the empty branch above instead).
async function collectQuestionEngineCard() {
  await loadDocsMap(); // the card's "View in your notes" row resolves via _docsById
  await refreshQuestionCard(); // sets _questionCard / _questionEngineOff (fail-safe)
  const section = buildQuestionSection(); // null when the engine is off
  return section && _questionCard ? [section] : [];
}

// Proxy source — "wants your eye" reviews are questions ("did I file this
// right?"); the high-confidence pile renders as the quiet filed line (ids in
// stratum ④, unchanged behavior).
async function collectProxyCards() {
  const filedSection = document.getElementById("today-filed-section");
  const filedList = document.getElementById("today-filed-list");
  const payload = await tauri.core.invoke("fetch_proxy_queue");
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const live = items.filter((it) => it && it.status !== "dismissed" && it.status !== "undone");
  const filed = live.filter(
    (it) =>
      it.status === "confirmed" ||
      (typeof it.confidence === "number" && it.confidence >= PROXY_FILED_CONFIDENCE),
  );
  const wantsEye = live.filter((it) => !filed.includes(it));
  if (filed.length && filedList && filedSection) {
    for (const item of filed) {
      try { filedList.appendChild(renderProxyFiledRow(item)); } catch (e) { console.warn("[main] renderProxyFiledRow:", e); }
    }
    filedSection.hidden = false;
    const headText = document.getElementById("today-filed-heading-text");
    if (headText) headText.textContent = `${filed.length} filed automatically — review`;
  }
  const cards = [];
  for (const item of wantsEye) {
    try { cards.push(renderProxyCard(item)); } catch (e) { console.warn("[main] renderProxyCard:", e); }
  }
  return cards;
}

// ── WP-NAME-ASKS — the corpus asks for the one fact only the user has ──// ── WP-NAME-ASKS — the corpus asks for the one fact only the user has ──
// Deterministic engine producer (/api/project-canon/name-asks, flag-gated):
// unnamed code-shaped workstreams carrying open items become a queue card with
// an inline answer. Saving writes through the existing project-canon rename
// (read-time application ⇒ every surface picks the name up on next render).
async function collectNameAskCards() {
  let data = null;
  try {
    data = await tauri.core.invoke("fetch_name_asks");
  } catch (_err) {
    return []; // older servers have no route — degrade silently (flag-off posture)
  }
  const asks = data && data.enabled !== false && Array.isArray(data.asks) ? data.asks : [];
  // Cap: housekeeping never floods the question queue. Suppressed keys skipped.
  const cards = [];
  for (const ask of asks) {
    if (!ask || !ask.key || _nameAskSuppressed(ask.key)) continue;
    if (cards.length >= 3) break;
    cards.push(renderNameAskCard(ask));
  }
  return cards;
}

// WP-QCARD-REVIEW — the shared reviewable-items affordance for every engine→user
// question card: a collapsed "Show N items →" toggle that reveals a clickable
// list of {item summary + source badge}, each badge opening the item's source
// document in the source pane. This is the load-bearing HITL affordance (a
// decision the user can't inspect is a rubber-stamp) — the name-ask card proved
// it, and the merge-ask card reuses it once per side so the user compares before
// combining.
//
// `records` is the capped member list the engine ships ({recordId, documentId,
// summary}[]). Returns a wrap element, or null when there's nothing to review.
// Options:
//   showLabel   — the collapsed toggle text (e.g. "Show 5 items →" or a per-side
//                 "Show LAA's 5 items →"). Defaults to "Show N items →".
//   totalCount  — the TRUE open count (may exceed records.length because the
//                 engine caps the carried sample); drives the "+K more" row so a
//                 truncated list still tells the user how many items exist.
//   cap         — max rows rendered from `records` (default 6, matching the
//                 name-ask card's original inline cap).
//
// Landmines respected (documented, already bitten): the toggle is `.btn-link`,
// which is `position:absolute` globally — `.nameask-items-toggle` resets it to
// `position:static`. The list is a `[hidden]` collapsible whose `display:flex`
// would out-rank `[hidden]`, so `.nameask-items[hidden]{display:none}` guards it.
function buildQcardReviewList(records, opts) {
  const recs = Array.isArray(records) ? records : [];
  if (!recs.length) return null;
  const options = opts || {};
  const CAP = typeof options.cap === "number" ? options.cap : 6;
  const shown = recs.length; // records is already the capped sample from the engine
  const total = typeof options.totalCount === "number" && options.totalCount > shown
    ? options.totalCount : shown;
  const showLabel = options.showLabel ||
    ("Show " + shown + " item" + (shown === 1 ? "" : "s") + " →");

  const wrap = document.createElement("div");
  wrap.className = "nameask-items-wrap";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn btn-link nameask-items-toggle";
  toggle.textContent = showLabel;
  const list = document.createElement("div");
  list.className = "nameask-items";
  list.hidden = true;

  const buildRows = () => {
    list.textContent = "";
    for (const r of recs.slice(0, CAP)) {
      const row = document.createElement("div");
      row.className = "nameask-item";
      const t = document.createElement("span");
      t.className = "nameask-item-label";
      t.textContent = (r && r.summary) || prettySlug(String((r && r.recordId) || "")) || "(item)";
      row.appendChild(t);
      const badge = renderSourceBadge(r && r.documentId, (r && r.summary) || null);
      if (badge) row.appendChild(badge);
      list.appendChild(row);
    }
    // "+K more" = every item beyond what's rendered — the rows past the render
    // cap PLUS any records the engine capped out of the payload (total > shown).
    const more = total - Math.min(CAP, shown);
    if (more > 0) {
      const moreEl = document.createElement("div");
      moreEl.className = "nameask-item-more";
      moreEl.textContent = "+ " + more + " more";
      list.appendChild(moreEl);
    }
  };

  let open = false;
  toggle.addEventListener("click", () => {
    open = !open;
    toggle.textContent = open ? "Hide items ↑" : showLabel;
    if (open) {
      loadDocsMap().then(() => { buildRows(); list.hidden = false; })
        .catch(() => { buildRows(); list.hidden = false; });
    } else {
      list.hidden = true;
    }
  });
  wrap.appendChild(toggle);
  wrap.appendChild(list);
  return wrap;
}

function renderNameAskCard(ask) {
  // Presented in the ONE question-card grammar (rule-card question-card) —
  // the same shape every engine→user question wears: the QUESTION is the
  // statement, "Question" tag top-right, a "Why I'm asking" line, context,
  // then the answer affordance. Canon verbs (Snooze / Dismiss) in the footer.
  const el = document.createElement("div");
  el.className = "rule-card question-card nameask-card";

  const top = document.createElement("div");
  top.className = "rule-card-top";
  const stmt = document.createElement("div");
  stmt.className = "rule-card-statement";
  stmt.textContent = "What should this workstream be called?";
  top.appendChild(stmt);
  const tag = document.createElement("span");
  tag.className = "rule-auth question-tag";
  tag.textContent = "Question";
  top.appendChild(tag);
  el.appendChild(top);

  const n = typeof ask.openCount === "number" ? ask.openCount : 0;
  const why = document.createElement("div");
  why.className = "question-why";
  why.textContent =
    "Why I\u2019m asking: " +
    n + " open item" + (n === 1 ? "" : "s") +
    " are grouped under " + (ask.code || ask.key) +
    " \u2014 a code with no name \u2014 so this work is hard to find and read.";
  el.appendChild(why);

  if (Array.isArray(ask.topEntities) && ask.topEntities.length) {
    const hints = document.createElement("div");
    hints.className = "nameask-hints";
    const lead = document.createElement("span");
    lead.className = "nameask-hints-label";
    lead.textContent = "It covers:";
    hints.appendChild(lead);
    for (const e of ask.topEntities.slice(0, 3)) {
      const chip = document.createElement("span");
      chip.className = "record-chip";
      chip.textContent = prettySlug(String(e));
      hints.appendChild(chip);
    }
    el.appendChild(hints);
  }

  // Covered items — clickable source list. Align the question-family cards with
  // the commitment cards' receipts: show WHAT was grouped (each openable), not a
  // bare count. The shared helper renders the proven "Show N items →" idiom.
  const nameItems = buildQcardReviewList(ask.records, {
    showLabel: "Show " + (Array.isArray(ask.records) ? ask.records.length : 0) +
      " item" + ((Array.isArray(ask.records) ? ask.records.length : 0) === 1 ? "" : "s") + " →",
    totalCount: typeof ask.openCount === "number" ? ask.openCount : undefined,
  });
  if (nameItems) el.appendChild(nameItems);

  const rowEl = document.createElement("div");
  rowEl.className = "nameask-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nameask-input";
  input.placeholder = "Name it\u2026";
  if (ask.suggestedName) input.value = String(ask.suggestedName);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn nameask-save";
  save.textContent = "Save name";
  const submit = () => submitNameAsk(ask, input.value, el, save);
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  rowEl.appendChild(input);
  rowEl.appendChild(save);
  el.appendChild(rowEl);

  // Footer — the queue's canon verbs. Snooze = quiet for 7 days; Dismiss =
  // stop asking about this key. Both are local display preferences (the
  // engine ask self-clears the moment the workstream is actually named).
  const actions = document.createElement("div");
  actions.className = "watching-actions";
  const snooze = vvActionBtn("Snooze", () => {
    _nameAskSuppress(ask.key, Date.now() + 7 * 86400000);
    el.remove();
  });
  snooze.title = "Snooze \u2014 ask again in 7 days";
  const dismiss = vvActionBtn("Dismiss", () => {
    _nameAskSuppress(ask.key, Number.MAX_SAFE_INTEGER);
    el.remove();
  });
  dismiss.title = "Dismiss \u2014 stop asking about this workstream";
  actions.append(snooze, dismiss);
  el.appendChild(actions);

  return el;
}

/** Local suppress store for name asks (key → not-before epoch ms). Display
 *  preference only — renames clear asks server-side. */
function _nameAskSuppress(key, untilMs) {
  try {
    const raw = JSON.parse(localStorage.getItem("nameask-suppress") || "{}");
    raw[key] = untilMs;
    localStorage.setItem("nameask-suppress", JSON.stringify(raw));
  } catch (_e) { /* best effort */ }
}
function _nameAskSuppressed(key) {
  try {
    const raw = JSON.parse(localStorage.getItem("nameask-suppress") || "{}");
    return typeof raw[key] === "number" && raw[key] > Date.now();
  } catch (_e) {
    return false;
  }
}

async function submitNameAsk(ask, newLabel, card, saveBtn) {
  const label = (newLabel || "").trim();
  if (!label) return;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const fp = await projectCanonFingerprint();
    if (!fp) {
      showToast({ kind: "failure", title: "Naming isn't available on this server yet." });
      return;
    }
    let actor = "threshold-user";
    try { actor = (await getViewerEmail()) || actor; } catch (_e) { /* keep default */ }
    await tauri.core.invoke("project_canon_rename", {
      canonicalId: String(ask.key).replace(/^job:/, ""),
      newLabel: label,
      expectedSubstrateFingerprint: fp,
      actor,
    });
    card.remove();
    showToast({
      kind: "success",
      title: `Named: ${label}`,
      body: "Today, the Log, and the overview pick the name up on their next refresh.",
    });
    enterLogView(); // re-derive Today — the served project keys now carry the name
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Couldn't save the name",
      body: String(err && err.message ? err.message : err),
    });
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ── WP-MERGE-ASKS — the corpus asks whether two keys are the same project ──
// Deterministic engine producer (/api/project-canon/merge-asks, flag-gated):
// near-duplicate project keys (initialism / plural / separator variants) that
// both carry open items become a combine-ask card. Combining writes through
// the EXISTING project-canon merge (read-time application ⇒ every surface
// regroups on next render, and the ask self-clears server-side).
async function collectMergeAskCards() {
  let data = null;
  try {
    data = await tauri.core.invoke("fetch_merge_asks");
  } catch (_err) {
    return []; // older servers have no route — degrade silently (flag-off posture)
  }
  const asks = data && data.enabled !== false && Array.isArray(data.asks) ? data.asks : [];
  // Cap: housekeeping never floods the question queue (shared budget with name asks).
  const cards = [];
  for (const ask of asks) {
    if (!ask || !ask.keyA || !ask.keyB || _mergeAskSuppressed(_mergeAskPairKey(ask))) continue;
    if (cards.length >= 2) break;
    cards.push(renderMergeAskCard(ask));
  }
  return cards;
}

function renderMergeAskCard(ask) {
  // The ONE question-card grammar (rule-card question-card), same as name
  // asks: statement + Question tag + "Why I'm asking" + answer affordance +
  // canon Snooze/Dismiss verbs.
  const el = document.createElement("div");
  el.className = "rule-card question-card mergeask-card";

  const top = document.createElement("div");
  top.className = "rule-card-top";
  const stmt = document.createElement("div");
  stmt.className = "rule-card-statement";
  stmt.textContent = "Are these the same workstream?";
  top.appendChild(stmt);
  const tag = document.createElement("span");
  tag.className = "rule-auth question-tag";
  tag.textContent = "Question";
  top.appendChild(tag);
  el.appendChild(top);

  const a = ask.displayA || ask.keyA;
  const b = ask.displayB || ask.keyB;
  const nA = typeof ask.openCountA === "number" ? ask.openCountA : 0;
  const nB = typeof ask.openCountB === "number" ? ask.openCountB : 0;
  const why = document.createElement("div");
  why.className = "question-why";
  why.textContent =
    "Why I’m asking: " +
    (nA + nB) + " open items are split between " + a + " (" + nA + ") and " +
    b + " (" + nB + ") — they look like the same project filed two ways.";
  el.appendChild(why);

  // WP-QCARD-REVIEW — TWO reviewable lists, one per side, so the user inspects
  // each group's actual items (each openable in the source pane) before deciding
  // to combine them. A wrong "Combine" corrupts the forest, so this review is the
  // load-bearing HITL affordance. Same "Show N items →" idiom as the name-ask
  // card, labelled per side with the real display name. Invisible-by-absence when
  // an older engine sends no recordsA/recordsB (flag-off / pre-WP posture).
  const sideA = buildQcardReviewList(ask.recordsA, {
    showLabel: "Show " + a + "’s " + nA + " item" + (nA === 1 ? "" : "s") + " →",
    totalCount: nA,
  });
  if (sideA) el.appendChild(sideA);
  const sideB = buildQcardReviewList(ask.recordsB, {
    showLabel: "Show " + b + "’s " + nB + " item" + (nB === 1 ? "" : "s") + " →",
    totalCount: nB,
  });
  if (sideB) el.appendChild(sideB);

  // Answer affordance: the surviving name (prefilled with the engine's
  // suggestion — the busier key's label) + one Combine action.
  const rowEl = document.createElement("div");
  rowEl.className = "nameask-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nameask-input";
  input.placeholder = "Name for the combined workstream…";
  if (ask.suggestedTarget) input.value = String(ask.suggestedTarget);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn nameask-save";
  save.textContent = "Combine";
  const submit = () => submitMergeAsk(ask, input.value, el, save);
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  rowEl.appendChild(input);
  rowEl.appendChild(save);
  el.appendChild(rowEl);

  // Footer — canon verbs. Dismiss here means "keep them separate".
  const actions = document.createElement("div");
  actions.className = "watching-actions";
  const pairKey = _mergeAskPairKey(ask);
  const snooze = vvActionBtn("Snooze", () => {
    _mergeAskSuppress(pairKey, Date.now() + 7 * 86400000);
    el.remove();
  });
  snooze.title = "Snooze — ask again in 7 days";
  const dismiss = vvActionBtn("Dismiss", () => {
    _mergeAskSuppress(pairKey, Number.MAX_SAFE_INTEGER);
    el.remove();
  });
  dismiss.title = "Dismiss — keep these workstreams separate";
  actions.append(snooze, dismiss);
  el.appendChild(actions);

  return el;
}

/** Canonical pair key for the local suppress store (order-independent). */
function _mergeAskPairKey(ask) {
  const ks = [String(ask.keyA), String(ask.keyB)].sort();
  return ks[0] + "|" + ks[1];
}

/** Local suppress store for merge asks (pairKey → not-before epoch ms).
 *  Display preference only — an applied merge clears the ask server-side. */
function _mergeAskSuppress(pairKey, untilMs) {
  try {
    const raw = JSON.parse(localStorage.getItem("mergeask-suppress") || "{}");
    raw[pairKey] = untilMs;
    localStorage.setItem("mergeask-suppress", JSON.stringify(raw));
  } catch (_e) { /* best effort */ }
}
function _mergeAskSuppressed(pairKey) {
  try {
    const raw = JSON.parse(localStorage.getItem("mergeask-suppress") || "{}");
    return typeof raw[pairKey] === "number" && raw[pairKey] > Date.now();
  } catch (_e) {
    return false;
  }
}

async function submitMergeAsk(ask, targetLabel, card, saveBtn) {
  const label = (targetLabel || "").trim();
  if (!label) return;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const fp = await projectCanonFingerprint();
    if (!fp) {
      showToast({ kind: "failure", title: "Combining isn't available on this server yet." });
      return;
    }
    let actor = "threshold-user";
    try { actor = (await getViewerEmail()) || actor; } catch (_e) { /* keep default */ }
    // The existing canon merge: both keys unify under the TYPED label as the
    // surviving canonical, in ONE proposal (backend contract: sources ≥2 +
    // targetCanonical). Never merge-then-rename — a contested merge records
    // without applying, and the follow-up rename then half-lands (measured
    // live 2026-07-07).
    const res = await tauri.core.invoke("project_canon_merge", {
      sources: [ask.keyA, ask.keyB].map((k) => String(k).replace(/^job:/, "")),
      targetCanonical: label,
      expectedSubstrateFingerprint: fp,
      actor,
      overrideVeto: !!card.dataset.overrideVeto,
    });
    // The topology sibling-veto can CONTEST the merge (recorded, not applied)
    // — same contract the Log's combine flow handles. Surface it in-card:
    // second click overrides, same as the Log's confirm.
    if (res && res.disposition === "contested" && !card.dataset.overrideVeto) {
      card.dataset.overrideVeto = "1";
      if (saveBtn) saveBtn.textContent = "Combine anyway";
      let note = card.querySelector(".mergeask-contested-note");
      if (!note) {
        note = document.createElement("div");
        note.className = "question-why mergeask-contested-note";
        note.textContent =
          "These two keep separate company in the corpus (they appear side by side as distinct projects), so I want to be sure — combine anyway?";
        card.insertBefore(note, saveBtn.closest(".nameask-input-row"));
      }
      return;
    }
    card.remove();
    showToast({
      kind: "success",
      title: `Combined into ${label}`,
      body: "Today, the Log, and the overview regroup on their next refresh.",
    });
    enterLogView(); // re-derive Today — the served project keys now regroup
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Couldn't combine the workstreams",
      body: String(err && err.message ? err.message : err),
    });
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// WP-TODAY-BRIEF ① (vigilance half) — primary voids feed the might-slip pool.
// Grouped so the silent-Nd join + low-impact suppression match the old ledger;
// only primary (non-low-impact) voids qualify. People waiting on YOU rank
// first (ingress); longest-silent first within a rank. Degrades silently.
// ══════════════════════════════════════════════════════════════════════════
async function loadTodayMissVoids() {
  await loadDocsMap(); // void cards' source badges read _docsById (best-effort)
  let data, grouped;
  try {
    const result = await fetchVigilanceGrouped();
    if (!result) throw new Error("vigilance fetch failed");
    data = result.voidData;
    grouped = result.grouped; // null when flag off / old backend
  } catch (err) {
    console.warn("[main] fetch_vigilance_voids failed (Don't miss):", err);
    missSettle("voids");
    return;
  }
  const voids = Array.isArray(data && data.voids) ? data.voids : [];
  const ageByVoid = new Map();
  const lowImpactVoidIds = new Set();
  if (grouped && Array.isArray(grouped.stalledJobs)) {
    for (const job of grouped.stalledJobs) {
      const isPrimary = stalledIsPrimary(job, stalledBand(job.jobKey));
      const isSingleton = (job.voidCount || 0) <= 1 && !(job.blockerCount || 0);
      for (const sv of job.scoredVoids || []) {
        if (typeof sv.ageDays === "number") ageByVoid.set(sv.voidId, sv.ageDays);
        if (!isPrimary || isSingleton) lowImpactVoidIds.add(sv.voidId);
      }
    }
  }
  const primaryVoids = voids.filter((v) => !lowImpactVoidIds.has(v.voidId));
  const entries = primaryVoids.map((v) => {
    const ctx = v.context || {};
    const headline = (ctx.blocked && ctx.blocked.summary) || v.render || "Waiting on something to come back";
    const age = ageByVoid.get(v.voidId);
    const ingress = String(v.trigger || "").toLowerCase().includes("ingress");
    return {
      key: "void:" + v.voidId,
      rank: ingress ? 0 : 2,
      order: -(typeof age === "number" ? age : 0),
      line: headline,
      tag: (VOID_TRIGGER_LABEL[v.trigger] || "watching") + (typeof age === "number" ? ` · ${Math.round(age)}d` : ""),
      detail: () => renderVoidCard(v, { ageDays: age }),
    };
  });
  missContribute("voids", entries);
  missSettle("voids");
}

// ══════════════════════════════════════════════════════════════════════════
// WP-TODAY-BRIEF ③ "Your plan" — the morning plan-of-record reconciliation,
// read from the check-in packet (fetch_checkin_brief — the SAME computation
// the companion's check-ins and the notifier read; drift rule 2026-07-12).
// present:false ⇒ the stratum stays hidden (honest no-morning-plan cue,
// never fabricated). The packet's prework staging also renders here-adjacent:
// stratum ④ rows tagged "awaiting your review" (the authorization gradient —
// the scheduled pass may write ONLY staging + questions).
// ══════════════════════════════════════════════════════════════════════════
let _preparedSettled = { prework: false, outbox: false };

async function loadTodayPlan() {
  let data;
  try {
    data = await tauri.core.invoke("fetch_checkin_brief", {
      lens: null,
      // Minutes EAST of UTC (JS reports west-positive) — the server computes
      // the viewer-local plan/prework day from this.
      tzOffsetMinutes: -new Date().getTimezoneOffset(),
    });
  } catch (err) {
    // Old server / unreachable — the stratum stays hidden, staging settles
    // empty so ④'s empty-state math still resolves.
    console.warn("[main] fetch_checkin_brief failed:", err);
    renderPreworkStaging(null);
    return;
  }
  try { renderTodayPlanSection(data && data.todaysPlan); }
  catch (e) { console.warn("[main] Your plan render:", e); }
  try { renderPreworkStaging(data && data.prework); }
  catch (e) { console.warn("[main] prework render:", e); renderPreworkStaging(null); }
}

// The reconciliation stratum. Buckets render in the mockup-D grammar: moved
// (✓, quiet), stalled + newly-possible (tags), still-open behind one quiet
// yours/companion's line. ✦ marks companion-side items everywhere.
function renderTodayPlanSection(tp) {
  const section = document.getElementById("today-planrec-section");
  const list = document.getElementById("today-planrec-list");
  const countEl = document.getElementById("today-planrec-count");
  const openLine = document.getElementById("today-planrec-open");
  const openList = document.getElementById("today-planrec-open-list");
  if (!section || !list) return;
  if (!tp || tp.present !== true) {
    section.hidden = true; // honest: no plan captured today
    return;
  }

  const when = (() => {
    const iso = tp.anchors && tp.anchors[0] && tp.anchors[0].capturedAt;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(ms)
      ? "from today's capture"
      : "captured " + new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  })();
  if (countEl) {
    countEl.textContent =
      `${tp.moved.count} moved · ${tp.stalled.count} stalled` +
      (tp.newlyActionable.count ? ` · ${tp.newlyActionable.count} newly possible` : "");
  }
  const whenEl = document.getElementById("today-planrec-when");
  if (whenEl) whenEl.textContent = when;

  const planRow = (ref, opts) => {
    const row = document.createElement("div");
    row.className = "today-planrec-row";
    if (ref.recordId) {
      // No title attr — the native tooltip reads as a stray chip (Ross);
      // the pointer cursor + hover brightening carry the affordance.
      row.classList.add("is-openable");
      row.addEventListener("click", () => {
        const rec = _todayCtx && _todayCtx.recordsById && _todayCtx.recordsById.get(ref.recordId);
        if (rec && rec.documentId) {
          openSourcePanel(rec.documentId, rec.verbatim || ref.summary || null);
        } else {
          // Honest: the record isn't in view (still loading, or not entitled).
          showToast({ kind: "failure", title: "No source to open", body: "This item's source isn't in view — find it in the Log." });
        }
      });
    }
    const mark = document.createElement("span");
    mark.className = "today-planrec-mark" + (opts.done ? " is-done" : "");
    mark.textContent = opts.done ? "✓" : "·";
    row.appendChild(mark);
    const text = document.createElement("span");
    text.className = "today-planrec-text";
    text.textContent = (ref.side === "companion" ? "✦ " : "") + (ref.summary || ref.recordId);
    // Tooltip only where ellipsis is plausible — on short rows the native
    // tooltip reads as a stray chip (Ross render pass, 2026-07-12).
    if (text.textContent.length > 64) text.title = text.textContent;
    row.appendChild(text);
    if (opts.tag) {
      const tag = document.createElement("span");
      tag.className = "today-planrec-tag";
      tag.textContent = opts.tag;
      row.appendChild(tag);
    }
    return row;
  };
  const omittedLine = (bucket, label) => {
    if (!bucket.omitted) return null;
    const p = document.createElement("p");
    p.className = "today-planrec-omitted";
    p.textContent = `+${bucket.omitted} more ${label}`;
    return p;
  };

  list.innerHTML = "";
  for (const ref of tp.moved.items) list.appendChild(planRow(ref, { done: true }));
  const mo = omittedLine(tp.moved, "moved"); if (mo) list.appendChild(mo);
  for (const ref of tp.stalled.items) list.appendChild(planRow(ref, { tag: "stalled" }));
  const so = omittedLine(tp.stalled, "stalled"); if (so) list.appendChild(so);
  for (const ref of tp.newlyActionable.items) list.appendChild(planRow(ref, { tag: "newly possible" }));
  const no = omittedLine(tp.newlyActionable, "newly possible"); if (no) list.appendChild(no);

  // Still-open behind one quiet line (the division of labor).
  if (openLine && openList) {
    openList.innerHTML = "";
    if (tp.stillOpen.count > 0) {
      const by = tp.byOwner || { user: 0, companion: 0 };
      const closed = `▸ still open: yours ${by.user} · companion's ${by.companion}`;
      openLine.textContent = closed;
      openLine.dataset.closedLabel = closed;
      openLine.hidden = false;
      openLine.setAttribute("aria-expanded", "false");
      openList.hidden = true; // collapsed on every fresh render
      for (const ref of tp.stillOpen.items) openList.appendChild(planRow(ref, {}));
      const oo = omittedLine(tp.stillOpen, "open"); if (oo) openList.appendChild(oo);
      if (!openLine.dataset.wired) {
        openLine.dataset.wired = "1";
        openLine.addEventListener("click", () => {
          const open = openList.hidden;
          openList.hidden = !open;
          openLine.setAttribute("aria-expanded", open ? "true" : "false");
          openLine.textContent = open ? "▾ still open" : (openLine.dataset.closedLabel || "▸ still open");
        });
      }
    } else {
      openLine.hidden = true;
      openList.hidden = true;
    }
  }
  section.hidden = false;
}

// ④'s staged half — prework items from the scheduled pass. Rows expand to the
// full prework detail: what's known (receipted), what's missing, the targeted
// questions, and the draft (bracketed blanks where unknowns survived).
function renderPreworkStaging(prework) {
  const list = document.getElementById("today-prework-list");
  if (list) {
    list.innerHTML = "";
    const items = prework && Array.isArray(prework.items) ? prework.items : [];
    for (const item of items) {
      try { list.appendChild(renderPreworkRow(item)); }
      catch (e) { console.warn("[main] renderPreworkRow:", e); }
    }
  }
  _preparedSettled.prework = true;
  reconcilePreparedState();
}

function renderPreworkRow(item) {
  const wrap = document.createElement("div");
  wrap.className = "today-draft-item";
  const row = document.createElement("button");
  row.type = "button";
  row.className = "today-draft-row";
  row.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.className = "today-draft-text";
  text.textContent = (item.stagedBy === "mcp-agent" ? "✦ " : "") + (item.title || "(untitled)");
  text.title = item.title || "";
  row.appendChild(text);
  const tag = document.createElement("span");
  tag.className = "today-draft-tag";
  tag.textContent = "awaiting your review";
  row.appendChild(tag);
  const detail = document.createElement("div");
  detail.className = "today-draft-detail";
  detail.hidden = true;
  row.addEventListener("click", () => {
    const open = detail.hidden;
    if (open && !detail.childNodes.length) {
      const block = (label, lines) => {
        if (!lines || !lines.length) return;
        const h = document.createElement("p");
        h.className = "today-prework-label";
        h.textContent = label;
        detail.appendChild(h);
        for (const line of lines) {
          const li = document.createElement("p");
          li.className = "today-prework-line";
          li.textContent = line;
          detail.appendChild(li);
        }
      };
      block("What the field already establishes", item.known);
      block("Still missing", item.unknown);
      block("Questions that would close the gaps", item.questions);
      if (item.draft) {
        const h = document.createElement("p");
        h.className = "today-prework-label";
        h.textContent = item.draftComplete ? "Draft — complete" : "Draft — blanks remain";
        detail.appendChild(h);
        const d = document.createElement("p");
        d.className = "today-prework-draft";
        d.textContent = item.draft;
        detail.appendChild(d);
      }
    }
    detail.hidden = !open;
    row.setAttribute("aria-expanded", open ? "true" : "false");
  });
  wrap.appendChild(row);
  wrap.appendChild(detail);
  return wrap;
}

// ④'s shared count/empty math — both halves (staged + outbox) settle here.
function reconcilePreparedState() {
  const countEl = document.getElementById("today-prepared-count");
  const emptyEl = document.getElementById("today-prepared-empty");
  const staged = document.querySelectorAll("#today-prework-list .today-draft-item").length;
  const drafts = document.querySelectorAll("#today-outbox-list .today-draft-item").length;
  const n = staged + drafts;
  if (countEl) {
    const parts = [];
    if (staged) parts.push(`${staged} awaiting review`);
    if (drafts) parts.push(`${drafts} to send`);
    countEl.textContent = parts.join(" · ");
  }
  if (emptyEl) emptyEl.hidden = !(n === 0 && _preparedSettled.prework && _preparedSettled.outbox);
}

// WP-TODAY-BRIEF ④ (outbox half) — drafts from the AUTHORIZED lanes (attended
// sessions + post-close wings). Compact rows; the full companion card (body,
// artifacts, verbs — PR #150 anatomy unchanged) expands in place.
// ══════════════════════════════════════════════════════════════════════════
async function loadTodayPlanDrafts() {
  const list = document.getElementById("today-outbox-list");
  if (!list) return;
  let data;
  try {
    data = await tauri.core.invoke("fetch_outbox");
  } catch (err) {
    console.warn("[main] fetch_outbox failed (Prepared for you):", err);
    _preparedSettled.outbox = true;
    reconcilePreparedState(); // calm — never an error surface
    return;
  }
  const items = Array.isArray(data && data.items) ? data.items : [];
  list.innerHTML = "";
  for (const item of items) {
    try { list.appendChild(renderDraftRow(item)); }
    catch (e) { console.warn("[main] renderDraftRow (Prepared for you):", e); }
  }
  _preparedSettled.outbox = true;
  reconcilePreparedState();
}

// One compact draft row: ✦ when companion-drafted, the subject, a quiet
// "ready to send"; click expands the full outbox card in place (lazily).
function renderDraftRow(item) {
  const wrap = document.createElement("div");
  wrap.className = "today-draft-item";
  const row = document.createElement("button");
  row.type = "button";
  row.className = "today-draft-row";
  row.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.className = "today-draft-text";
  text.textContent =
    (item.proposedBy === "mcp-agent" ? "✦ " : "") + (item.subject || "(no subject)");
  text.title = item.subject || "";
  row.appendChild(text);
  const tag = document.createElement("span");
  tag.className = "today-draft-tag";
  tag.textContent = "approved, awaiting send";
  row.appendChild(tag);
  const detail = document.createElement("div");
  detail.className = "today-draft-detail";
  detail.hidden = true;
  row.addEventListener("click", () => {
    const open = detail.hidden;
    if (open && !detail.childNodes.length) {
      try { detail.appendChild(renderOutboxCard(item)); }
      catch (e) { console.warn("[main] renderOutboxCard (draft row):", e); }
    }
    detail.hidden = !open;
    row.setAttribute("aria-expanded", open ? "true" : "false");
  });
  wrap.appendChild(row);
  wrap.appendChild(detail);
  return wrap;
}

// ══════════════════════════════════════════════════════════════════════════
// Decision-log SUMMARY — the brief needs only the counts: the header subtitle
// ("N open · M tracked"), ③'s honest open-counts line into the Log, and the
// record-edit capability flag. The board / conflicts / workload the old rollup
// rendered here LEFT Today (Ross 2026-07-12): the Log is the archive
// (Relationships lists conflicts; Workload rides the Log header).
// ══════════════════════════════════════════════════════════════════════════
async function renderTodayDecisionLog() {
  let data;
  try {
    data = await tauri.core.invoke("fetch_decision_log");
  } catch (err) {
    console.warn("[main] fetch_decision_log failed:", err);
    _recordEditsEnabled = false;
    // Degrade quietly — the strata carry Today on their own; a decision-log
    // outage must not blank Today or surface a hard error banner.
    return;
  }

  // Record-level inline editing capability.
  _recordEditsEnabled = !!(data && data.editsEnabled);

  const summary = data && data.summary ? data.summary : {};
  const states = summary.states || {};
  const total = typeof summary.total === "number" ? summary.total : 0;
  const open = typeof states.open === "number" ? states.open : 0;

  // Header subtitle: date + honest scale ("Sunday, Jul 12 · 282 open · 284 tracked").
  const sub = document.getElementById("log-sub");
  if (sub && total > 0) {
    const now = new Date();
    const date = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    sub.textContent = `${date} · ${open} open · ${total} tracked`;
  }

  // ③'s quiet line into the Log — every plan, decision & commitment lives there.
  const planLine = document.getElementById("today-plan-log-line");
  if (planLine) {
    if (open > 0) {
      planLine.textContent = `${open} open in all — every plan & decision is in the Log →`;
      planLine.hidden = false;
      if (!planLine.dataset.wired) {
        planLine.dataset.wired = "1";
        planLine.addEventListener("click", () => enterDecisionsView("open", { from: "today" }));
      }
    } else {
      planLine.hidden = true;
    }
  }

  // The cut priority + stalled rails return under the debug flag only.
  if (VIEW_DEBUG) {
    loadTodayPriority();
    loadStalledChaseList();
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


// ══════════════════════════════════════════════════════════════════════════
// "Coming up" — the forward-looking window (the windshield). OPEN commitments due
// within the next 14 days, soonest first, so a client is told BEFORE a deadline
// (Trisha: "I'd have wanted to know the day before, not the day of").
//
// Sourced from the FULL decision-log records (fetch_decision_log_full — the same
// records the Decisions view groups; Today's plain /api/decision-log carries only
// the backward-looking needsAttention list, so this is the forward source). No new
// IPC, no engine change. Empty ⇒ absent (never fabricates demo content).
// ══════════════════════════════════════════════════════════════════════════
const COMINGUP_WINDOW_DAYS = 14;
// Any silence ≥ this many days on a due-soon item earns the "quiet" badge — the
// point is due-soon AND nobody-touching-it (looser than the 40d overdue-silent
// badge, per the amendment).
const COMINGUP_QUIET_SILENT_DAYS = 7;

// Parse a YYYY-MM-DD (house gotcha: only the first 10 chars are the date) to a
// local midnight Date. Returns null when absent/unparseable.
function parseDueDate(due) {
  if (!due || typeof due !== "string") return null;
  const d = new Date(due.slice(0, 10) + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

async function loadTodayComingUp() {
  const section = document.getElementById("today-nextweeks-section");
  const rowsEl = document.getElementById("today-outlook-rows");
  const countEl = document.getElementById("today-nextweeks-count");
  if (!section || !rowsEl) return;

  let data;
  try {
    data = await tauri.core.invoke("fetch_decision_log_full");
  } catch (_err) {
    // One quiet retry — the full payload is the heaviest read on Today and a
    // large corpus can graze the transport timeout while its sibling invokes
    // land (observed live 2026-07-12: digest rendered, band vanished).
    try {
      await new Promise((r) => setTimeout(r, 2000));
      data = await tauri.core.invoke("fetch_decision_log_full");
    } catch (err2) {
      console.warn("[main] fetch_decision_log_full failed (Next two weeks):", err2);
      // Fail-closed-but-VISIBLE: an errored band shows a calm line, never an
      // empty column that reads as broken layout (and never a hard error box).
      const rowsErr = document.getElementById("today-outlook-rows");
      if (rowsErr) rowsErr.innerHTML = "";
      const legendErr = document.getElementById("today-outlook-legend");
      if (legendErr) legendErr.hidden = true;
      const quietErr = document.getElementById("today-comingup-empty");
      if (quietErr) {
        quietErr.textContent = "Couldn't load the two-week window — Refresh to retry.";
        quietErr.hidden = false;
      }
      if (countEl) countEl.textContent = "";
      section.hidden = false;
      missSettle("week"); // never leave ① waiting on a failed source
      return;
    }
  }

  const records = withoutDismissed(Array.isArray(data && data.records) ? data.records : []);
  // recordId → record join for click-through (the plan stratum's rows open
  // their source in the right pane through this, same pattern as everything).
  if (_todayCtx) {
    _todayCtx.recordsById = new Map(
      records.map((it) => [((it && it.record) || {}).recordId, (it && it.record) || {}]).filter(([k]) => k),
    );
  }
  // Fail-closed-but-VISIBLE (house law §2b.3): whatever the junk gate
  // suppressed from this full payload stays countable and reviewable in the
  // header — never a silent disappearance. Plain language only.
  renderNacReviewAffordance(
    (Array.isArray(data && data.records) ? data.records : [])
      .map((it) => ({ rec: (it && it.record) || it || {} }))
      .filter(({ rec }) => rec.recordClass === "not-a-commitment" && !isDismissed(rec)),
  );
  // WP-NAME-ASKS plumb-through: the full payload carries the engine's naming
  // layer; stash it so Today's grouping consults the SAME names the Log uses
  // (a name fixed anywhere then propagates here on the next render).
  if (_todayCtx) {
    _todayCtx.jobNames = (data && data.jobNames) || {};
    _todayCtx.recordJobs = (data && data.recordJobs) || {};
    // Canon alias map (slug → canonical label) — THE channel a project-canon
    // rename travels through (verified live: rename lands here immediately).
    _todayCtx.aliases = (data && data.aliases) || {};
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = today.getTime() + COMINGUP_WINDOW_DAYS * 86400000;

  // OPEN commitments due within [today, today+14d]. State lives on the wrapper
  // (it.state); type on the record. Decisions aren't "coming due" — commitments
  // are the promises with a deadline someone is waiting on.
  // WP-R-c2 — a human due-reset (workback overlay) moves the EFFECTIVE due;
  // filter/sort/display all follow it so the reset propagates everywhere.
  const effDueOf = (it) => (it && it.effectiveDue) || ((it && it.record) || {}).due;
  const upcoming = [];
  let overdueCount = 0;
  for (const it of records) {
    const rec = (it && it.record) || {};
    if ((it.state || "open") !== "open") continue;
    if (rec.type && rec.type !== "commitment") continue;
    const d = parseDueDate(effDueOf(it));
    if (!d) continue;
    const t = d.getTime();
    if (t < today.getTime()) { overdueCount++; continue; } // the tail counts into ①'s Log line
    if (t > horizon) continue;
    upcoming.push(it);
  }
  _todayOverdueCount = overdueCount;
  // Soonest first (by effective due).
  upcoming.sort((a, b) => {
    const da = parseDueDate(effDueOf(a));
    const db = parseDueDate(effDueOf(b));
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  });

  // "Mine" filter parity with the needs-attention list.
  let rows = upcoming;
  if (_todayFilter === "mine" && _todayCtx && _todayCtx.viewerSlug) {
    rows = rows.filter((e) =>
      entryIsMine(e, _todayCtx.viewerSlug, _todayCtx.viewerEmail, _todayCtx.submitterByDoc));
  }

  // WP-TODAY-BRIEF ② — the WEEK leads; the rest of the fortnight sits behind
  // one collapsed line (Ross 2026-07-12: "weekly needs" is the intention, the
  // fortnight is context). Week = through Friday; on Sat/Sun the upcoming week
  // (same convention as the check-in brief).
  const dow = today.getDay(); // 0 Sun … 6 Sat
  const addToFri = dow === 0 ? 5 : dow === 6 ? 6 : 5 - dow;
  const weekEnd = today.getTime() + addToFri * 86400000 + (86400000 - 1);
  const weekRows = rows.filter((it) => {
    const d = parseDueDate(effDueOf(it));
    return d && d.getTime() <= weekEnd;
  });
  const restRows = rows.filter((it) => !weekRows.includes(it));

  if (countEl) countEl.textContent = weekRows.length ? `${weekRows.length} due` : "";

  try { renderTodayOutlook(weekRows, today); } catch (e) { console.warn("[main] your week:", e); }
  const restEl = document.getElementById("today-outlook-rest");
  if (restEl) {
    restEl.innerHTML = "";
    if (restRows.length) {
      try { renderTodayOutlook(restRows, today, restEl); } catch (e) { console.warn("[main] fortnight rest:", e); }
    }
  }
  const restToggle = document.getElementById("today-week-rest-toggle");
  if (restToggle) {
    if (restRows.length && restEl) {
      const closed = `▸ rest of the fortnight — ${restRows.length} more`;
      restToggle.textContent = restEl.hidden ? closed : `▾ rest of the fortnight`;
      restToggle.dataset.closedLabel = closed;
      restToggle.hidden = false;
      if (!restToggle.dataset.wired) {
        restToggle.dataset.wired = "1";
        restToggle.addEventListener("click", () => {
          const open = restEl.hidden;
          restEl.hidden = !open;
          restToggle.setAttribute("aria-expanded", open ? "true" : "false");
          restToggle.textContent = open ? "▾ rest of the fortnight" : (restToggle.dataset.closedLabel || "▸ rest of the fortnight");
        });
      }
    } else {
      restToggle.hidden = true;
    }
  }

  // ① Don't miss — the readiness half: due-soon with NOTHING moving behind it
  // (the Brian flag). Expanding shows the workback reasoning + actions.
  const missEntries = [];
  for (const it of rows) {
    const rec = (it && it.record) || {};
    const readiness = it.readiness || rec.readiness || null;
    if (readiness !== "no-precursor") continue;
    const d = parseDueDate(effDueOf(it));
    const days = d ? Math.round((d.getTime() - today.getTime()) / 86400000) : null;
    const when = days == null ? "" : days <= 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`;
    const wb = it.workbackShadow || rec.workbackShadow || null;
    const proj = wb && (wb.projection || wb);
    missEntries.push({
      key: "np:" + (rec.recordId || rec.summary),
      rank: 1,
      order: days == null ? 99 : days,
      line: (rec.summary || "(no summary)") + (when ? " — " + when + ", nothing has moved" : " — nothing has moved"),
      tag: "no draft observed",
      detail: () => {
        const box = document.createElement("div");
        try { renderOutlookDetails(box, it, rec, wb, proj); } catch (e) { console.warn("[main] miss detail:", e); }
        return box;
      },
    });
  }
  missContribute("week", missEntries);
  missSettle("week");

  // Rank, don't list (operator-inventory lever): quiet focus chips from the
  // priority operator land on matching rows when the service answers.
  loadNextWeeksFocusChips().catch(() => {});

  // Empty ⇒ quiet line: "nothing due this week" is affirmative information —
  // the section stays present so the brief reads complete.
  const quietEl = document.getElementById("today-comingup-empty");
  section.hidden = false;
  if (quietEl) {
    quietEl.textContent = "Nothing due this week."; // reset any prior error line
    quietEl.hidden = weekRows.length > 0;
  }
}

// Quiet focus chips on Next-two-weeks rows (WP-TODAY-3BANDS — the priority
// operator surfaces as RANK EMPHASIS on the one list, not as its own Focus
// stratum; operator-inventory "rank, don't list"). Additive + silent: flag-off
// / old server / no overlap ⇒ no chips. Never re-orders the deterministic
// soonest-first sort — emphasis only.
async function loadNextWeeksFocusChips() {
  let res;
  try {
    res = await tauri.core.invoke("fetch_priority");
  } catch (_err) {
    return; // silent — additive
  }
  if (!res || res.available === false) return;
  const focusIds = new Set(
    (Array.isArray(res.items) ? res.items : [])
      .filter((i) => i && (i.tracked || FOCUS_QUADRANTS.has(i.quadrant)))
      .map((i) => i.recordId)
      .filter(Boolean),
  );
  if (!focusIds.size) return;
  for (const row of document.querySelectorAll("#today-outlook-rows .today-outlook-item[data-record-id], #today-outlook-rest .today-outlook-item[data-record-id]")) {
    if (!focusIds.has(row.dataset.recordId)) continue;
    const label = row.querySelector(".today-outlook-label");
    if (!label || label.querySelector(".today-focus-chip")) continue;
    const chip = document.createElement("span");
    chip.className = "today-focus-chip";
    chip.textContent = "focus";
    chip.title = "Ranked worth your attention first, right now";
    const state = label.querySelector(".today-outlook-state");
    label.insertBefore(chip, state || null);
  }
}

/** WP-R-c2 — Deadline outlook (the READ half of workback; Ross's vacant-space
 *  ruling 2026-07-07). One runway bar per due-soon commitment on a 14-day
 *  axis: bar = today → due; tick = where work usually needs to start (the
 *  workback latest-safe-start, when the engine serves workbackShadow —
 *  shape-tolerant, absent on flag-off servers ⇒ bars only, no ticks); amber
 *  = the engine's claim this isn't moving ('not on track' when the workback
 *  projection fired, else tier-1's 'no draft observed'). Tap a row → the
 *  matching Coming-up row scrolls into view in the rail. Same §2.11 copy
 *  rules as the badges: plain words, no machinery vocabulary. */
/** "Mine" = items I OWN or items I CAPTURED (Ross ruling 2026-07-08: for the
 *  accountable-but-not-responsible user, what she forwards IS her watchlist —
 *  ownership alone hid every item from her own forward). */
function entryIsMine(e, viewerSlug, viewerEmail, submitterByDoc) {
  const rec = (e && e.record) || {};
  const owner = (rec.owner || "").toLowerCase();
  if (viewerSlug && owner === viewerSlug) return true;
  const sub =
    submitterByDoc && submitterByDoc.get && submitterByDoc.get(rec.documentId);
  return !!(
    viewerEmail && sub && String(sub).toLowerCase() === String(viewerEmail).toLowerCase()
  );
}

/** Expanded swimlanes survive the full re-render a gesture triggers (the
 *  refetch is what makes propagation visible everywhere at once). */
const _outlookExpanded = new Set();

/** POST one workback gesture, then refetch so the reset/verdict propagates
 *  through every surface (outlook bars, Coming-up tags, scope). Buttons stay
 *  disabled for the flight; errors land inline, never thrown. */
async function sendWorkbackGesture(box, recordId, body) {
  const buttons = box.querySelectorAll("button, input, select");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await tauri.core.invoke("workback_gesture", { recordId, body });
    await loadTodayComingUp();
  } catch (e) {
    buttons.forEach((b) => (b.disabled = false));
    let err = box.querySelector(".today-outlook-error");
    if (!err) {
      err = document.createElement("p");
      err.className = "today-outlook-error";
      box.appendChild(err);
    }
    err.textContent = "That didn't save — is the server reachable?";
    console.warn("[main] workback gesture:", e);
  }
}

/** WP-TODAY-3BANDS — the Next-two-weeks runway list (formerly the wide-only
 *  Deadline outlook; now THE one forward surface at every width, fed all
 *  due-soon rows — the separate "This week" pick list and Coming-up rail were
 *  re-renderings of the same records and are gone). The caller owns section
 *  visibility/count; this renders rows only. */
function renderTodayOutlook(rows, today, targetEl) {
  const rowsEl = targetEl || document.getElementById("today-outlook-rows");
  const legendEl = document.getElementById("today-outlook-legend");
  if (!rowsEl) return;
  rowsEl.innerHTML = "";
  if (!rows || !rows.length) {
    if (!targetEl && legendEl) legendEl.hidden = true;
    return;
  }

  const t0 = today.getTime();
  const span = COMINGUP_WINDOW_DAYS * 86400000;
  const pctOf = (ms) => Math.max(0, Math.min(100, ((ms - t0) / span) * 100));
  const shortDate = (d) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // Axis: today · +7d · +14d over a hairline.
  const axis = document.createElement("div");
  axis.className = "today-outlook-axis";
  for (const [label] of [["today"], [shortDate(new Date(t0 + span / 2))], [shortDate(new Date(t0 + span))]]) {
    const s = document.createElement("span");
    s.textContent = label;
    axis.appendChild(s);
  }
  rowsEl.appendChild(axis);

  let anyTick = false;
  for (const entry of rows) {
    const rec = (entry && entry.record) || {};
    const due = parseDueDate((entry && entry.effectiveDue) || rec.due);
    if (!due) continue;
    const duePct = pctOf(due.getTime());
    const days = Math.round((due.getTime() - t0) / 86400000);
    const rel = days <= 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`;

    // Workback shadow — shape-tolerant (wrapper or record; projection nested
    // or flat), absent entirely until the engine flag is on and §5b admits it.
    const wb = entry.workbackShadow || rec.workbackShadow || null;
    const proj = wb && (wb.projection || wb);
    const fired = !!(proj && proj.fire);
    const safeStart = proj && proj.latestSafeStart ? parseDueDate(String(proj.latestSafeStart)) : null;

    const readiness = entry.readiness || rec.readiness || null;
    const lc = entry.lifecycle || {};
    let state = "on track";
    let tone = "";
    if (fired) {
      state = `not on track · ${rel}`;
      tone = "warn";
    } else if (readiness === "no-precursor") {
      state = "no draft observed";
      tone = "warn";
    } else if (typeof lc.silentDays === "number" && lc.silentDays >= COMINGUP_QUIET_SILENT_DAYS) {
      state = `quiet ${lc.silentDays}d`;
    }

    // "on track" alone is empty calories — say when the first unstarted step
    // needs to begin, when the plan knows it.
    if (state === "on track" && proj && proj.fireDate) {
      const fs = parseDueDate(String(proj.fireDate));
      if (fs && fs.getTime() >= t0) state = `on track · start by ${shortDate(fs)}`;
    }

    const item = document.createElement("div");
    item.className = "today-outlook-item";
    if (rec.recordId) item.dataset.recordId = rec.recordId;

    const row = document.createElement("button");
    row.type = "button";
    row.className = "today-outlook-row";
    row.title = rec.summary || "";
    row.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "today-outlook-label";
    const name = document.createElement("span");
    name.className = "today-outlook-name";
    // The summary is the informative line (the entity slug reads as noise —
    // Ross, live session 2026-07-07); ellipsis handles length, title has it all.
    name.textContent = rec.summary || (rec.primaryEntity ? prettySlug(rec.primaryEntity) : "");
    const st = document.createElement("span");
    st.className = "today-outlook-state";
    if (tone) st.dataset.tone = tone;
    st.textContent = state;
    label.appendChild(name);
    label.appendChild(st);
    row.appendChild(label);

    const track = document.createElement("span");
    track.className = "today-outlook-track";
    const bar = document.createElement("span");
    bar.className = "today-outlook-bar";
    bar.style.width = `${Math.max(duePct, 2)}%`;
    if (tone === "warn") bar.dataset.tone = "warn";
    track.appendChild(bar);

    if (safeStart && safeStart.getTime() <= due.getTime()) {
      const tick = document.createElement("span");
      tick.className = "today-outlook-tick";
      tick.style.left = `${pctOf(safeStart.getTime())}%`;
      if (safeStart.getTime() < t0) tick.dataset.tone = "warn";
      tick.title = `Work needs to start by ${shortDate(safeStart)} to make the due date`;
      track.appendChild(tick);
      anyTick = true;
    }

    const dueTag = document.createElement("span");
    dueTag.className = "today-outlook-due";
    dueTag.style.left = `${Math.min(duePct, 84)}%`;
    dueTag.textContent = shortDate(due);
    track.appendChild(dueTag);
    row.appendChild(track);

    // Click = open the reasoning inline (the swimlane IS the entry point —
    // Ross's live report: scroll-to-rail read as "nothing happened"). The
    // details block renders lazily from the shadow payload; "Show in Coming
    // up" lives inside it as the secondary hop.
    const details = document.createElement("div");
    details.className = "today-outlook-details";
    details.hidden = true;
    const openDetails = () => {
      // Accordion (Ross, 2026-07-08): one open at a time — a dozen stuck-open
      // expansions turned the panel into a wall.
      for (const d of rowsEl.querySelectorAll(".today-outlook-details")) d.hidden = true;
      for (const r of rowsEl.querySelectorAll(".today-outlook-row")) r.setAttribute("aria-expanded", "false");
      _outlookExpanded.clear();
      if (!details.childNodes.length) renderOutlookDetails(details, entry, rec, wb, proj);
      details.hidden = false;
      row.setAttribute("aria-expanded", "true");
      _outlookExpanded.add(rec.recordId);
    };
    row.addEventListener("click", () => {
      if (details.hidden) return openDetails();
      details.hidden = true;
      row.setAttribute("aria-expanded", "false");
      _outlookExpanded.delete(rec.recordId);
    });
    // Survive the post-gesture re-render.
    if (_outlookExpanded.has(rec.recordId)) openDetails();

    item.appendChild(row);
    item.appendChild(details);
    rowsEl.appendChild(item);
  }
  if (legendEl && (anyTick || !targetEl)) legendEl.hidden = !anyTick;
}

/** The inline reasoning block under a Deadline-outlook swimlane. Reads only
 *  what the engine served (workbackShadow: steps/verdicts/projection +
 *  record verbatim) — §2.11 plain copy, no machinery vocabulary, absence
 *  claims scoped to connected sources. */
function renderOutlookDetails(box, entry, rec, wb, proj) {
  const shortDate = (d) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const gesture = (body) => sendWorkbackGesture(box, rec.recordId, body);
  const miniBtn = (label, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "today-outlook-mini";
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  // Where this came from — the traceback (who promised, verbatim, when).
  if (rec.verbatim || rec.owner) {
    const src = document.createElement("p");
    src.className = "today-outlook-quote";
    const who = rec.owner ? prettySlug(rec.owner) : "";
    src.textContent = (who ? who + " — " : "") + (rec.verbatim ? `“${rec.verbatim}”` : "");
    box.appendChild(src);
  }

  const steps = (wb && wb.steps) || [];
  const verdicts = (wb && wb.verdicts) || [];
  const safeStarts = (proj && proj.latestSafeStart) || [];
  if (steps.length) {
    const list = document.createElement("div");
    list.className = "today-outlook-steps";
    steps.forEach((s, i) => {
      const v = verdicts.find((x) => x && x.index === i);
      const seen = v && v.status === "observed";
      const line = document.createElement("p");
      line.className = "today-outlook-step";
      line.dataset.seen = seen ? "yes" : "no";
      const mark = document.createElement("span");
      mark.className = "today-outlook-step-mark";
      mark.textContent = seen ? "✓" : "○";
      line.appendChild(mark);
      const text = document.createElement("span");
      let when = "";
      const byd = safeStarts[i] ? parseDueDate(String(safeStarts[i])) : null;
      if (!seen && byd) when = ` — not seen yet · needs to start by ${shortDate(byd)} to make the date`;
      else if (seen) when = " — seen";
      text.className = "today-outlook-step-text";
      text.textContent = (s.label || s.kind || "step") + when;
      line.appendChild(text);
      // The HITL gestures live behind ONE compact dropdown per step (Ross,
      // 2026-07-09) — a single "⋯" trigger opens the themed menu
      // (openRecordEditMenu / .record-edit-menu) listing the step's actions,
      // instead of a row of pills. Every pick lands in the correction stream AND
      // recomputes the dates in place (the refetch re-renders all surfaces).
      const acts = document.createElement("span");
      acts.className = "today-outlook-step-acts";
      const actOptions = [];
      if (!seen) {
        actOptions.push({ label: "Mark as done", run: () =>
          gesture({ gesture: "step-done", stepIndex: i, stepKind: s.kind }) });
        actOptions.push({ label: "Doesn't apply here", run: () =>
          gesture({ gesture: "step-not-applicable", stepIndex: i, stepKind: s.kind }) });
        // Tag the doc that IS this step's artifact — the human override for the
        // matcher: each candidate document is its own menu item (no inline
        // picker to widen the row).
        for (const c of (wb && wb.candidates) || []) {
          actOptions.push({
            label: `Tag: ${c.title || c.docId}${c.date ? " · " + c.date : ""}`,
            run: () => gesture({ gesture: "evidence-attach", stepIndex: i, docId: c.docId }),
          });
        }
      } else if (v && v.evidenceDocId) {
        // WP-FOCUS task #5 (Ross, 2026-07-08): a "seen" verdict is the matcher's
        // CLAIM — make it inspectable. The step text opens the source panel on
        // the matched doc; the menu carries the confirm / reject calibration.
        text.classList.add("today-outlook-seen-link");
        text.title = "See the document this was matched to";
        text.addEventListener("click", (e) => {
          e.stopPropagation();
          openSourcePanel(v.evidenceDocId, s.label || null);
        });
        actOptions.push({ label: "That's the one", run: () =>
          gesture({ gesture: "evidence-confirm", stepIndex: i, docId: v.evidenceDocId }) });
        actOptions.push({ label: "Not the right doc", run: () =>
          gesture({ gesture: "evidence-deselect", stepIndex: i, docId: v.evidenceDocId }) });
      } else if (seen && rec.documentId) {
        // Seen, but the matcher recorded NO evidenceDocId — it observed a precursor
        // without pinning the document. WP-FOCUS #5 only linkified evidence-backed
        // seen steps, which left THIS case a dead, unclickable line — Trisha/Ross
        // couldn't open the item to inspect it (UAT 2026-07-10). Keep the claim
        // inspectable (fail-closed-but-VISIBLE): open the item's OWN source, and the
        // title names the gap so it doesn't read as a confirmed match. (The matcher
        // failing to record which doc it saw is a separate engine-side gap.)
        text.classList.add("today-outlook-seen-link");
        text.title = "Seen, but no source document was recorded — open this item's source to inspect";
        text.addEventListener("click", (e) => {
          e.stopPropagation();
          openSourcePanel(rec.documentId, s.label || null);
        });
      }
      if (actOptions.length) {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "today-outlook-mini today-outlook-step-menu";
        trigger.textContent = "⋯";
        trigger.setAttribute("aria-label", "Update this step");
        trigger.title = "Update this step";
        trigger.addEventListener("click", (e) => {
          e.stopPropagation();
          openRecordEditMenu(
            trigger,
            actOptions.map((o, idx) => ({ value: String(idx), label: o.label })),
            null,
            (val) => { const o = actOptions[Number(val)]; if (o) o.run(); },
          );
        });
        acts.appendChild(trigger);
      }
      line.appendChild(acts);
      list.appendChild(line);
    });
    box.appendChild(list);

    const closing = document.createElement("p");
    closing.className = "today-outlook-closing";
    const fireD = proj && proj.fireDate ? parseDueDate(String(proj.fireDate)) : null;
    if (proj && proj.fire) {
      closing.textContent =
        "At this pace this likely lands late — worth a heads-up while there's still time.";
    } else if (fireD) {
      closing.textContent = `Still time — the first step needs to start by ${shortDate(fireD)}. I haven't seen it in the connected sources yet.`;
    }
    if (closing.textContent) box.appendChild(closing);
  } else {
    // No chain served. Two honest reasons: short runway (deliberately out of
    // workback scope — the due-soon warning owns items promised <7d before
    // due; §SW1 finding) vs. in-scope but nothing computed/admitted yet.
    const none = document.createElement("p");
    none.className = "today-outlook-closing";
    const dueD = parseDueDate(rec.due);
    const capD = rec.date ? parseDueDate(String(rec.date).slice(0, 10)) : null;
    const runway = dueD && capD ? Math.round((dueD - capD) / 86400000) : null;
    if (runway !== null && runway < 7) {
      const days = Math.max(runway, 0);
      none.textContent = `Promised ${days === 0 ? "the day it was due" : days === 1 ? "a day before it's due" : days + " days before it's due"} — too tight for a step-by-step plan, so watch this one directly.`;
    } else {
      none.textContent = "No step-by-step plan for this one yet.";
    }
    box.appendChild(none);
  }

  // Footer gestures: reset the date (event-sourced overlay — the source
  // document's date stays; undo restores it), add a missed step, undo.
  const actions = document.createElement("div");
  actions.className = "today-outlook-actions";

  const dateWrap = document.createElement("span");
  dateWrap.className = "today-outlook-datewrap";
  const dateBtn = miniBtn("move the date", "Reset the due date — everything recomputes from it", () => {
    dateForm.hidden = !dateForm.hidden;
  });
  const dateForm = document.createElement("span");
  dateForm.hidden = true;
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "today-outlook-dateinput";
  dateInput.value = String((entry && entry.effectiveDue) || rec.due || "").slice(0, 10);
  const dateGo = miniBtn("apply", "", () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) return;
    gesture({ gesture: "due-reset", due: dateInput.value });
  });
  dateForm.appendChild(dateInput);
  dateForm.appendChild(dateGo);
  dateWrap.appendChild(dateBtn);
  dateWrap.appendChild(dateForm);
  actions.appendChild(dateWrap);

  const addWrap = document.createElement("span");
  addWrap.className = "today-outlook-datewrap";
  const addBtn = miniBtn("add a step", "A step this plan is missing", () => {
    addForm.hidden = !addForm.hidden;
  });
  const addForm = document.createElement("span");
  addForm.hidden = true;
  const addLabel = document.createElement("input");
  addLabel.type = "text";
  addLabel.placeholder = "What has to happen";
  addLabel.className = "today-outlook-addlabel";
  const addDays = document.createElement("input");
  addDays.type = "number";
  addDays.min = "0";
  addDays.max = "60";
  addDays.value = "1";
  addDays.title = "Working days this step needs";
  addDays.className = "today-outlook-adddays";
  const addGo = miniBtn("add", "", () => {
    const label = addLabel.value.trim();
    const leadDays = Math.max(0, Math.min(60, parseInt(addDays.value, 10) || 0));
    if (!label) return;
    gesture({ gesture: "add-step", step: { label, kind: "other", leadDays } });
  });
  addForm.appendChild(addLabel);
  addForm.appendChild(addDays);
  addForm.appendChild(addGo);
  addWrap.appendChild(addBtn);
  addWrap.appendChild(addForm);
  actions.appendChild(addWrap);

  actions.appendChild(
    miniBtn("undo last change", "Revert the most recent correction on this item", () =>
      gesture({ gesture: "undo" })),
  );
  box.appendChild(actions);

  // Per-item actions (WP-TODAY-3BANDS — the Coming-up rail these used to hop to
  // is gone; its row verbs live HERE now): the source, the heads-up draft when
  // prep looks absent, the follow-up draft, and Resolve / Snooze / Dismiss
  // (verb canon). Resolve/dismiss remove the whole runway item.
  const rowActs = document.createElement("div");
  rowActs.className = "today-outlook-rowacts";
  rowActs.addEventListener("click", (e) => e.stopPropagation());
  const itemEl = box.closest(".today-outlook-item") || box;
  if (rec.primaryEntity) {
    const receiptsBtn = miniBtn("show receipts →", "Every claim this item rests on", () =>
      enterReceiptsView((rec.parentJob || "").replace(/^job:/, "") || rec.primaryEntity));
    rowActs.appendChild(receiptsBtn);
  }
  appendSourceBadge(rowActs, rec.documentId, rec.verbatim);
  const readiness = entry.readiness || rec.readiness || null;
  if (readiness === "no-precursor" || readiness === "quiet") {
    appendHeadsUpControl(rowActs, rec);
  }
  appendDraftFollowUpControl(rowActs, rec);
  appendResolveSnoozeControls(rowActs, rec.recordId, itemEl, rec.summary);
  appendDismissControl(rowActs, rec.recordId, itemEl, rec.summary);
  box.appendChild(rowActs);
}

/** WP-READINESS Tier 2 — "Draft heads-up to client": stages the server-composed
 *  no-blame heads-up for a due-soon commitment into the Outbox (staging only).
 *  Amber — this is the row's needs-you action. */
function appendHeadsUpControl(actionsEl, rec) {
  if (!rec || !rec.recordId) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn today-headsup-btn";
  btn.textContent = "Draft heads-up to client";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    try {
      const res = await tauri.core.invoke("outbox_heads_up", { recordId: rec.recordId });
      const deduped = !!(res && res.deduped);
      showToast(
        deduped
          ? { kind: "success", title: "Already staged", body: "This heads-up is already in your Outbox." }
          : {
              kind: "success",
              title: "Heads-up drafted",
              body: "Find it in Outbox, or bring it forward from the Threshold add-in in Outlook.",
            },
      );
    } catch (err) {
      showToast({
        kind: "failure",
        title: "Couldn't draft the heads-up",
        body: String(err && err.message ? err.message : err),
      });
    } finally {
      btn.disabled = false;
    }
  });
  actionsEl.appendChild(btn);
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

// WP-TODAY-BRIEF — Workload in the Log (moved from Today, Ross 2026-07-12).
// Collapsed line above the list; the owner chips render lazily on first open.
// Additive + silent: fetch failure or empty ownerLoad keeps the line hidden.
async function loadLogWorkload() {
  const section = document.getElementById("log-workload-section");
  const toggle = document.getElementById("log-workload-toggle");
  const strip = document.getElementById("log-owners-strip");
  if (!section || !toggle || !strip) return;
  let data;
  try {
    data = await tauri.core.invoke("fetch_decision_log");
  } catch (_err) {
    section.hidden = true;
    return;
  }
  const ownerLoad = Array.isArray(data && data.summary && data.summary.ownerLoad)
    ? data.summary.ownerLoad
    : [];
  if (!ownerLoad.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (!toggle.dataset.wired) {
    toggle.dataset.wired = "1";
    toggle.addEventListener("click", () => {
      const open = strip.hidden;
      if (open && !strip.childElementCount) {
        for (const o of ownerLoad.slice(0, 12)) strip.appendChild(renderOwnerChip(o));
      }
      strip.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      const chev = toggle.querySelector(".proxy-pile-chevron");
      if (chev) chev.textContent = open ? "▾" : "▸";
    });
  }
}

// Today-view buttons: refresh, and the view-main / post-capture entry points.
const logRefreshBtn = document.getElementById("btn-log-refresh");
if (logRefreshBtn) {
  logRefreshBtn.addEventListener("click", () => {
    enterLogView();
  });
}

// WP-VIGILANCE-VOID — Refresh on the Watching surface re-fetches open voids.
const watchingRefreshBtn = document.getElementById("btn-watching-refresh");
if (watchingRefreshBtn) {
  watchingRefreshBtn.addEventListener("click", () => {
    enterWatchingView();
  });
}

// WP-WorkForest-Native-SoP (UI-2) — the "State of Play" panel on Today now shows
// the FOREST altitude (rollup across frames), re-pointed from the old flat corpus
// altitude. Same panel slot + toggle.
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
// ───────── WP-WorkForest-Native-SoP — Work-Forest-native State of Play ─────────
//
// A prose layer over the already-existing job/frame/forest scaffolding. The new
// /api/state-of-play endpoint (proxied by the fetch_sop Rust command) returns a
// register-bounded, already-voiced digest at any altitude (job/frame/forest) with
// an optional person/facet lens. Contract: { level, id, prose, license, sections,
// maturity? }. Jargon stays internal — prose arrives plain-language from the
// backend, so the UI never re-translates "do-now"/"stallProb"/"jobQuadrant".
//
// Every fetch degrades to {available:false} → the component renders nothing (or a
// calm empty state on the explicit corpus panel), exactly like the existing rails.

// Shared loader. Returns the SoP payload, or null when unavailable / unreachable
// (additive + silent — never an error surface). `id`/`lens` are optional.
async function loadSoP(level, id, lens) {
  let res;
  try {
    // id may arrive as a number (frame.fid) — the Rust command takes Option<String>,
    // so coerce or the invoke fails deserialization (and the surface silently vanishes).
    res = await tauri.core.invoke("fetch_sop", { level, id: id == null ? null : String(id), lens: lens || null });
  } catch (err) {
    console.warn("[main] fetch_sop(" + level + ") failed:", err);
    return null; // silent — degrade to hidden
  }
  if (!res || res.available === false) return null; // flag off / server too old / no altitude
  const prose = typeof res.prose === "string" ? res.prose.trim() : "";
  if (!prose) return null;
  // WP-RECEIPTS-V2 — warm the claim-expansion join context so a claim opens to
  // joined rows immediately (fire-and-forget; renders fall back to quotes until ready).
  if (sopClaimsShaped(res.receipts)) ensureSopJoinCtx().catch(() => {});
  return res;
}

// Compose the person-lens selector from a viewer email/slug, or null when there's
// no identity (the unscoped forest view is then used).
function personLens(viewerSlug) {
  return viewerSlug ? "person:" + viewerSlug : null;
}

// WP-R3 item 1 — render any receipt-shaped evidence a SoP section/digest carries
// through the ONE receipt component (§2.4). `raw` may be a single receipt object
// or an array; each entry is shape-tolerant ({record} envelope OR bare). Silent
// when there's nothing citeable — renderReceipt itself shows a quote only when
// verbatimVerified, so nothing is invented and the license framing stays honest.
function appendSoPReceipts(container, raw) {
  if (!raw) return;
  const list = Array.isArray(raw) ? raw : [raw];
  let wrap = null;
  for (const entry of list) {
    const rec = entry && entry.record ? entry.record : entry;
    if (!rec || typeof rec !== "object") continue;
    if (!((rec.verbatimVerified === true && rec.verbatim) || rec.documentId)) continue;
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "sop-receipts";
    }
    wrap.appendChild(
      renderReceipt(
        { verbatim: rec.verbatim, verbatimVerified: rec.verbatimVerified, documentId: rec.documentId },
        { variant: "receipt-sop", compact: true },
      ),
    );
  }
  if (wrap) container.appendChild(wrap);
}

// WP-SR1 — claim-level receipts. When SOP_CLAIM_RECEIPTS_ENABLED is on, the
// /api/state-of-play and /state-of-play/compose payloads carry, beside the
// prose, `receipts: { claims: [{key, claim, count, refs: [{recordId, verbatim,
// documentId}]}], receiptlessClaims }` — the records each quantitative claim
// ("3 overdue", "oldest due 2026-06-12") was mechanically computed FROM. This
// object shape is distinct from the array/record shape appendSoPReceipts
// consumes; sopClaimsShaped tells them apart so either payload renders on the
// path built for it.
function sopClaimsShaped(raw) {
  return !!(raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.claims));
}

// ══════════════════════════════════════════════════════════════════════════
// WP-RECEIPTS-V2 — the claim-expansion join context. The SoP claim refs carry
// only {recordId, verbatim, documentId}; to render each ref as a state · owner ·
// due · summary ROW (not a raw quote box) we join recordId → the full record,
// its lifecycle state, its project, and the edges it participates in — all from
// the decision-log the app already fetches (fetch_decision_log_full), mirroring
// the lazy fetch loadTodayComingUp uses. Built once, cached, shared by a single
// in-flight promise; documents give recordId→project via documentId.
// ══════════════════════════════════════════════════════════════════════════
let _sopJoinCtx = null;      // { byId, stateById, edges, docProjects } once loaded
let _sopJoinPromise = null;  // in-flight de-dupe

async function ensureSopJoinCtx() {
  if (_sopJoinCtx) return _sopJoinCtx;
  if (_sopJoinPromise) return _sopJoinPromise;
  _sopJoinPromise = (async () => {
    let data;
    try {
      data = await tauri.core.invoke("fetch_decision_log_full");
    } catch (err) {
      console.warn("[main] fetch_decision_log_full failed (SoP join):", err);
      _sopJoinPromise = null;
      return null; // rows fall back to the verbatim-quote render
    }
    const items = withoutDismissed(Array.isArray(data && data.records) ? data.records : []);
    const byId = new Map();
    const stateById = new Map();
    for (const it of items) {
      const rec = it && it.record ? it.record : it;
      if (rec && rec.recordId) {
        byId.set(rec.recordId, rec);
        stateById.set(rec.recordId, (it && it.state) || "open");
      }
    }
    const edges = Array.isArray(data && data.edges) ? data.edges : [];
    // documentId → projects[] for project grouping (best-effort; absent ⇒ ungrouped).
    const docProjects = new Map();
    try {
      const docsResp = await tauri.core.invoke("fetch_documents");
      const docs = docsResp && Array.isArray(docsResp.documents) ? docsResp.documents : [];
      for (const d of docs) {
        if (d && d.id) docProjects.set(d.id, Array.isArray(d.projects) ? d.projects : []);
      }
    } catch (err) {
      console.warn("[main] fetch_documents failed (SoP join projects omitted):", err);
    }
    _sopJoinCtx = { byId, stateById, edges, docProjects };
    _sopJoinPromise = null;
    return _sopJoinCtx;
  })();
  return _sopJoinPromise;
}

// Relative-due phrasing ("overdue 3d" / "due today" / "in 5d") — compact, paired
// with the absolute date. Mirrors the loadTodayComingUp due-line idiom.
function formatDueRelative(iso) {
  const d = parseDueDate(iso);
  if (!d) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days < 0) return `overdue ${Math.abs(days)}d`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `in ${days}d`;
}

// The blocking (this ← blockedBy) edge for a record: recordA depends_on recordB
// means A is blocked BY B. Returns the blocker record or null.
function sopBlockerFor(ctx, recordId) {
  if (!ctx || !recordId) return null;
  for (const e of ctx.edges) {
    if (e.kind === "depends_on" && e.status !== "dismissed" && e.recordA === recordId) {
      return ctx.byId.get(e.recordB) || null;
    }
  }
  return null;
}

// The records waiting ON this one (recordB is the unblocker; each recordA waits).
function sopWaitersFor(ctx, recordId) {
  if (!ctx || !recordId) return [];
  const out = [];
  for (const e of ctx.edges) {
    if (e.kind === "depends_on" && e.status !== "dismissed" && e.recordB === recordId) {
      const r = ctx.byId.get(e.recordA);
      if (r) out.push(r);
    }
  }
  return out;
}

// Render the claims block (WP-RECEIPTS-V2). Each quantitative claim is a
// disclosure pill (the .sop-frame-toggle idiom) whose panel now lists its
// supporting records as JOINED ROWS — state accent · owner · due (relative +
// absolute) · one-line summary — grouped by project, oldest-due first, top-6 +
// "Show all N". BLOCKED/WAITING rows carry the blocking/waiting record inline and
// open the existing dependency popover in place. The verbatim quote moves BEHIND
// the row (a per-row "quote" toggle) — evidence on demand, never the headline.
// The recordId→record join comes from _sopJoinCtx (the decision-log the app
// already fetches); a ref that doesn't resolve falls back to the verbatim-quote
// row so nothing is lost. Defensive: returns null unless claims-shaped with at
// least one renderable ref, so an absent/empty field leaves the surface as before.
function renderSopClaims(receipts) {
  if (!sopClaimsShaped(receipts)) return null;
  const rows = [];
  for (const c of receipts.claims) {
    if (!c || typeof c !== "object") continue;
    const label = typeof c.claim === "string" ? c.claim.trim() : "";
    const refs = (Array.isArray(c.refs) ? c.refs : []).filter(
      (r) => r && typeof r === "object" && (r.recordId || r.verbatim || r.documentId),
    );
    if (!label || !refs.length) continue;
    rows.push({ label, refs });
  }
  const receiptless = typeof receipts.receiptlessClaims === "number" && receipts.receiptlessClaims > 0
    ? receipts.receiptlessClaims
    : 0;
  if (!rows.length && !receiptless) return null;

  const wrap = document.createElement("div");
  wrap.className = "sop-claims";
  // Kick off the join fetch; when it lands, re-fill any already-open panel in
  // place (the collapsed ones fill on first open, reading the now-ready ctx).
  const openPanels = [];
  if (!_sopJoinCtx) {
    ensureSopJoinCtx().then((ctx) => {
      if (!ctx) return;
      for (const { row, panel } of openPanels) {
        if (panel.isConnected && !panel.hidden) {
          panel.innerHTML = "";
          fillSopClaimPanel(panel, row.refs);
        }
      }
    });
  }

  for (const row of rows) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "sop-frame-toggle sop-claim-toggle";
    toggle.textContent = row.label;
    toggle.title = row.refs.length === 1
      ? "Show the record behind this"
      : "Show the " + row.refs.length + " records behind this";
    toggle.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "sop-claim-panel";
    panel.hidden = true;
    openPanels.push({ row, panel });
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      if (open) {
        toggle.setAttribute("aria-expanded", "false");
        panel.hidden = true;
        return;
      }
      if (!panel.childElementCount) fillSopClaimPanel(panel, row.refs);
      toggle.setAttribute("aria-expanded", "true");
      panel.hidden = false;
    });
    wrap.appendChild(toggle);
    wrap.appendChild(panel);
  }
  if (receiptless) {
    const note = document.createElement("div");
    note.className = "sop-claims-note";
    note.textContent = receiptless === 1
      ? "1 more claim couldn't be traced to records."
      : receiptless + " more claims couldn't be traced to records.";
    wrap.appendChild(note);
  }
  return wrap.childElementCount ? wrap : null;
}

const SOP_CLAIM_ROWS_SHOWN = 6; // top-N rows per claim before the "Show all" expander

// Fill one claim panel with joined rows grouped by project. Reads the live
// _sopJoinCtx (may be null → every ref renders the verbatim-quote fallback).
function fillSopClaimPanel(panel, refs) {
  const ctx = _sopJoinCtx;
  // Split refs into resolvable (join to a record) vs unresolved (fallback quote).
  const resolved = [];
  const unresolved = [];
  for (const ref of refs) {
    const rec = ctx && ref.recordId ? ctx.byId.get(ref.recordId) : null;
    if (rec) resolved.push({ ref, rec });
    else unresolved.push(ref);
  }

  // Group resolved rows by project (same keys as Needs attention / project home),
  // oldest-due first within a group; groups with any overdue float up.
  if (resolved.length) {
    const wrappers = resolved.map(({ ref, rec }) => ({ record: rec, _ref: ref }));
    const dp = (ctx && ctx.docProjects) || new Map();
    let groups;
    if (dp.size) {
      groups = groupRecords(wrappers, "project", dp, {}, {}, {});
    } else {
      groups = [{ key: "__all__", label: "", items: wrappers }];
    }
    // Oldest-due first within each group.
    const dueMs = (w) => {
      const d = parseDueDate(w.record && w.record.due);
      return d ? d.getTime() : Infinity; // undated sinks to the bottom
    };
    for (const g of groups) g.items.sort((a, b) => dueMs(a) - dueMs(b));
    // Groups carrying the oldest overdue come first (Ross: oldest-due first overall).
    groups.sort((a, b) => dueMs(a.items[0]) - dueMs(b.items[0]));

    for (const g of groups) {
      if (g.label) {
        const gh = document.createElement("div");
        gh.className = "sop-claim-group-head";
        gh.textContent = g.label;
        panel.appendChild(gh);
      }
      const shown = g.items.slice(0, SOP_CLAIM_ROWS_SHOWN);
      const rest = g.items.slice(SOP_CLAIM_ROWS_SHOWN);
      for (const w of shown) panel.appendChild(renderSopClaimRow(w.record, w._ref, ctx));
      if (rest.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "sop-claim-showall";
        more.textContent = `Show all ${g.items.length} →`;
        more.addEventListener("click", () => {
          for (const w of rest) panel.insertBefore(renderSopClaimRow(w.record, w._ref, ctx), more);
          more.remove();
        });
        panel.appendChild(more);
      }
    }
  }

  // Unresolved refs (recordId absent or not in client data) — the verbatim-quote
  // fallback (today's row), so evidence is never dropped.
  for (const ref of unresolved) {
    panel.appendChild(
      renderReceipt(
        {
          verbatim: ref.verbatim,
          // sopReceipts.ts emits ref.verbatim as extractor-grounded source text,
          // never invented; the ref triple omits the verified flag, so trust the
          // contract while honoring an explicit false a later payload might add.
          verbatimVerified: ref.verbatimVerified !== false && !!ref.verbatim,
          documentId: ref.documentId || undefined,
        },
        { variant: "receipt-sop-claim", compact: true },
      ),
    );
  }
}

// One joined claim row: state accent · owner · due (relative+absolute) · summary,
// with a blocked-by / waiting line when the edges say so, and the verbatim quote
// tucked behind a per-row "quote" toggle (evidence on demand).
function renderSopClaimRow(rec, ref, ctx) {
  const state = (ctx && ctx.stateById.get(rec.recordId)) || "open";
  const row = document.createElement("div");
  row.className = "sop-claim-row";
  row.dataset.state = state;

  const main = document.createElement("div");
  main.className = "sop-claim-row-main";

  const dot = document.createElement("span");
  dot.className = "sop-claim-row-accent";
  main.appendChild(dot);

  const meta = document.createElement("span");
  meta.className = "sop-claim-row-meta";
  const bits = [];
  if (rec.owner) bits.push(prettySlug(rec.owner));
  if (rec.due) {
    const rel = formatDueRelative(rec.due);
    const abs = formatDueDate(rec.due);
    bits.push(rel ? `${rel} · ${abs}` : abs);
  }
  meta.textContent = bits.join(" · ");
  if (bits.length) main.appendChild(meta);

  const sum = document.createElement("span");
  sum.className = "sop-claim-row-summary";
  sum.textContent = rec.summary || "(no summary)";
  main.appendChild(sum);

  // Verbatim quote behind a per-row toggle — evidence on demand, never the
  // headline. Only when there's a verified quote or a source to reach.
  const hasEvidence = (ref && (ref.verbatim || ref.documentId));
  if (hasEvidence) {
    const q = document.createElement("button");
    q.type = "button";
    q.className = "sop-claim-row-quote-toggle";
    q.textContent = "quote";
    q.title = "Show the source quote";
    q.setAttribute("aria-expanded", "false");
    const quoteWrap = document.createElement("div");
    quoteWrap.className = "sop-claim-row-quote";
    quoteWrap.hidden = true;
    q.addEventListener("click", () => {
      const open = q.getAttribute("aria-expanded") === "true";
      if (open) { q.setAttribute("aria-expanded", "false"); quoteWrap.hidden = true; return; }
      if (!quoteWrap.childElementCount) {
        quoteWrap.appendChild(
          renderReceipt(
            {
              verbatim: ref.verbatim,
              verbatimVerified: ref.verbatimVerified !== false && !!ref.verbatim,
              documentId: ref.documentId || undefined,
            },
            { variant: "receipt-sop-claim", compact: true },
          ),
        );
      }
      q.setAttribute("aria-expanded", "true");
      quoteWrap.hidden = false;
    });
    main.appendChild(q);
    row.appendChild(main);
    row.appendChild(quoteWrap);
  } else {
    row.appendChild(main);
  }

  // Blocked-by / waiting line, joined from the same edges — clicking opens the
  // existing dependency popover in place (openLinkedMenu pattern).
  const blocker = sopBlockerFor(ctx, rec.recordId);
  if (blocker) {
    row.appendChild(sopClaimEdgeLine("blocked by", blocker.summary, (el) =>
      openLinkedMenu(el, "This is blocked by", [blocker]),
    ));
  } else {
    const waiters = sopWaitersFor(ctx, rec.recordId);
    if (waiters.length) {
      const label = waiters.length === 1 ? "1 waiting" : `${waiters.length} waiting`;
      const lead = waiters[0].summary || "";
      row.appendChild(sopClaimEdgeLine(label, lead, (el) =>
        openLinkedMenu(el, `Waiting on this (${waiters.length})`, waiters),
      ));
    }
  }
  return row;
}

// A "blocked by — <summary>" / "N waiting — <summary>" line that opens the
// dependency popover on click (reuses openLinkedMenu, same as the Log badges).
function sopClaimEdgeLine(lead, summary, onClick) {
  const line = document.createElement("button");
  line.type = "button";
  line.className = "sop-claim-row-edge";
  const l = document.createElement("span");
  l.className = "sop-claim-row-edge-lead";
  l.textContent = lead;
  line.appendChild(l);
  if (summary) {
    line.appendChild(document.createTextNode(" — "));
    const s = document.createElement("span");
    s.className = "sop-claim-row-edge-sum";
    s.textContent = summary;
    line.appendChild(s);
  }
  line.addEventListener("click", (e) => { e.stopPropagation(); onClick(line, e); });
  return line;
}

// Render the SoP prose into a container. `sections`, when present, render as
// labelled sub-blocks beneath the lead prose; otherwise the prose alone shows.
// No jargon translation here — the backend already voiced it. `opts.compact`
// drops the licence footnote (used for inline lazy expansions like Job SoP).
function renderSoPProse(container, data, opts) {
  opts = opts || {};
  container.innerHTML = "";

  // WP-SOP-DIGEST (mockup 2): in digest mode the panel LEADS with a clamped
  // digest — the "Do this first" action line is pulled out of the prose and
  // stays fully visible, the rest of the narrative clamps to ~4 lines behind a
  // Show-more toggle, and labelled sections collapse with it. Chips/claims and
  // the licence line render as always. Non-digest surfaces are unchanged.
  let leadText = data.prose || "";
  let actionText = "";
  if (opts.digest) {
    const paras = leadText.split(/\n\s*\n/);
    const ai = paras.findIndex((p) => /^do this first\b/i.test(p.trim()));
    if (ai >= 0) {
      actionText = paras.splice(ai, 1)[0].trim();
      leadText = paras.join("\n\n").trim();
    }
    container.classList.add("sop-digest", "sop-digest-collapsed");
  }

  const lead = document.createElement("p");
  lead.className = "sop-prose";
  lead.textContent = leadText;
  container.appendChild(lead);

  if (actionText) {
    const act = document.createElement("p");
    act.className = "sop-prose sop-dothis";
    act.textContent = actionText;
    container.appendChild(act);
  }

  const sections = Array.isArray(data.sections) ? data.sections : [];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    const body = typeof sec.prose === "string" ? sec.prose.trim() : (typeof sec.body === "string" ? sec.body.trim() : "");
    if (!body && !sec.title) continue;
    const block = document.createElement("div");
    block.className = "sop-section";
    if (sec.title) {
      const h = document.createElement("div");
      h.className = "sop-section-title";
      h.textContent = String(sec.title);
      block.appendChild(h);
    }
    if (body) {
      const p = document.createElement("p");
      p.className = "sop-section-body";
      p.textContent = body;
      block.appendChild(p);
    }
    // WP-R3 item 1 — receipted claims. When a section (or the digest itself)
    // carries evidence, it renders through the ONE receipt component (§2.4):
    // verbatim quote (verified-only) + jump-to-source. Shape-tolerant + silent —
    // absent evidence adds nothing, so the license framing stays intact (no
    // invented specifics; renderReceipt only shows a quote when verbatimVerified).
    appendSoPReceipts(block, sec.receipts || sec.evidence);
    container.appendChild(block);
  }

  // Digest-level receipts (evidence attached to the lead prose, not a section).
  // WP-SR1 claim-level payloads ({claims, receiptlessClaims}) render as
  // expandable claim pills; the WP-R3 array/record shape keeps the flat receipt
  // stack. Either way, absent ⇒ nothing.
  if (sopClaimsShaped(data.receipts)) {
    const claims = renderSopClaims(data.receipts);
    if (claims) container.appendChild(claims);
  } else {
    appendSoPReceipts(container, data.receipts || data.evidence);
  }

  // Licence footnote — RECOMMEND (measured) vs IMPLICATE (inferred). Plain text,
  // dim, single line; omitted in compact mode and when absent. Sentence-cased
  // for display (ruling 7 — the server ships it uppercase).
  if (!opts.compact && data.license && typeof data.license === "string") {
    const lic = document.createElement("div");
    lic.className = "sop-license";
    const raw = data.license.trim();
    lic.textContent = raw ? raw[0].toUpperCase() + raw.slice(1).toLowerCase() : raw;
    container.appendChild(lic);
  }

  // Digest mode: append the Show more / Show less toggle — only when there is
  // actually more to show (the clamped lead overflows, or sections are hidden).
  // Overflow is a layout fact, so measure on a macrotask after insertion —
  // NOT requestAnimationFrame, which never fires while the window is hidden
  // (the widget's Today can render before the window is frontmost).
  if (opts.digest) {
    const hasSections = !!container.querySelector(".sop-section");
    setTimeout(() => {
      const overflows = lead.scrollHeight > lead.clientHeight + 1;
      if (!overflows && !hasSections) {
        container.classList.remove("sop-digest-collapsed");
        return;
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn btn-link sop-showmore";
      toggle.textContent = "Show more";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const collapsed = container.classList.toggle("sop-digest-collapsed");
        toggle.textContent = collapsed ? "Show more" : "Show less";
        toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      });
      container.appendChild(toggle);
    }, 0);
  }
}

// UI-2 — Forest SoP, re-pointed corpus panel. The explicit "State of Play" panel
// on Today now shows the FOREST altitude (rollup across frames: hottest jobs,
// stalled frames, cross-frame conflicts), scoped to the viewer via the person
// lens when an identity is known. Same panel slot + copy/edit affordances as the
// old corpus altitude; maturity-aware now that the backend gates by frame.
// WP-SOP-DEADLINE (light-touch, Ross 2026-07-09). The forest SoP narrative is
// blind to commitments/deadlines by construction (the engine assembles it from
// the work-forest only). Rather than rewire the substrate, the overview carries
// a deterministic, plain-language deadline line computed from the SAME
// decision-log Coming-up uses — so the state of play reflects what's actually
// due and at risk. Pure + deterministic; returns null when nothing is due.
function computeDeadlineDigest(records, nowMs) {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const horizon = t0 + 14 * 86400000;
  const weekEnd = t0 + 7 * 86400000;
  const up = [];
  for (const it of Array.isArray(records) ? records : []) {
    const rec = (it && it.record) || {};
    if ((it.state || "open") !== "open") continue;
    if (rec.type && rec.type !== "commitment") continue;
    // effectiveDue (workback overlay) wins over the raw due — same precedence
    // as loadTodayComingUp; inlined here since effDueOf is local to that fn.
    const d = parseDueDate((it && it.effectiveDue) || rec.due);
    if (!d) continue;
    const t = d.getTime();
    if (t < t0 || t > horizon) continue;
    const readiness = it.readiness || rec.readiness || null;
    const wb = it.workbackShadow || rec.workbackShadow || null;
    const proj = wb && (wb.projection || wb);
    const atRisk = readiness === "no-precursor" || !!(proj && proj.fire === true) || it.noDraft === true;
    up.push({ rec, t, d, atRisk });
  }
  if (!up.length) return null;
  up.sort((a, b) => a.t - b.t);
  const thisWeek = up.filter((u) => u.t <= weekEnd).length;
  const atRiskN = up.filter((u) => u.atRisk).length;
  const next = up[0];
  const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const parts = [`${up.length} due in the next two weeks`];
  if (thisWeek) parts.push(`${thisWeek} this week`);
  if (atRiskN) parts.push(`${atRiskN} at risk`);
  const summary = (next.rec.summary || "").trim();
  const nextClause = summary
    ? ` Next: ${summary.length > 64 ? summary.slice(0, 61) + "…" : summary} — due ${shortDate(next.d)}.`
    : "";
  return `On deadlines: ${parts.join(", ")}.${nextClause}`;
}

// WP-DAY-DIGEST (Ross UAT 2026-07-10): "19 due this week" is a dead number — it
// hid the 93 overdue (forward-only) and swept next week's Mon items into "this
// week" (rolling-7). This replaces that one-liner with a deterministic, scannable
// day digest built from the SAME decision-log: fires first (overdue + at-risk),
// then what's due today, then the rest of the WORK week, then coming up. Pure +
// deterministic; no dependency on the (often-absent) forest narrative. "Done
// yesterday" is intentionally omitted — the log carries no per-item completion
// timestamp yet (that needs the deferred completion-capture), so we don't fake it.
function computeDayDigest(records, nowMs) {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const dayMs = 86400000;
  // Friday of the current work-week; on Sat/Sun roll to the UPCOMING Friday
  // (Ross ruling 2026-07-10: "this week" = the work week, default upcoming).
  const dow = today.getDay(); // 0 Sun … 6 Sat
  const addToFri = dow === 0 ? 5 : dow === 6 ? 6 : 5 - dow;
  const weekEnd = new Date(t0);
  weekEnd.setDate(weekEnd.getDate() + addToFri);
  weekEnd.setHours(23, 59, 59, 999);
  const weekEndMs = weekEnd.getTime();
  const horizonMs = t0 + 14 * dayMs;

  const overdue = [], dueToday = [], thisWeek = [], comingUp = [];
  let atRiskN = 0;
  for (const it of Array.isArray(records) ? records : []) {
    const rec = (it && it.record) || {};
    if ((it.state || "open") !== "open") continue;
    if (rec.type && rec.type !== "commitment") continue;
    const d = parseDueDate((it && it.effectiveDue) || rec.due);
    if (!d) continue;
    const t = d.getTime();
    const readiness = it.readiness || rec.readiness || null;
    const wb = it.workbackShadow || rec.workbackShadow || null;
    const proj = wb && (wb.projection || wb);
    const atRisk = readiness === "no-precursor" || !!(proj && proj.fire === true) || it.noDraft === true;
    if (atRisk) atRiskN++;
    const entry = { rec, d, t, atRisk, owner: rec.owner || "", summary: (rec.summary || "").trim() };
    if (t < t0) overdue.push(entry);
    else if (t < t0 + dayMs) dueToday.push(entry);
    else if (t <= weekEndMs) thisWeek.push(entry);
    else if (t <= horizonMs) comingUp.push(entry);
  }
  if (!(overdue.length + dueToday.length + thisWeek.length + comingUp.length)) return null;
  const byDue = (a, b) => a.t - b.t;
  overdue.sort(byDue); dueToday.sort(byDue); thisWeek.sort(byDue); comingUp.sort(byDue);
  return {
    today, overdue, dueToday, thisWeek, comingUp, atRiskN,
    oldestOverdue: overdue.length ? overdue[0].d : null,
  };
}

function renderDayDigest(panel, dg) {
  const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const wrap = document.createElement("div");
  wrap.className = "day-digest";

  const head = document.createElement("div");
  head.className = "day-digest-head";
  head.textContent = "Today · " + dg.today.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  wrap.appendChild(head);

  // One band: a summary line (label + count/summary), optionally expandable to a
  // capped item list. tone="fire" spends the ONE amber accent (canon 8) on the
  // overdue/at-risk band only.
  const band = (label, items, opts) => {
    opts = opts || {};
    let total = opts.count != null ? opts.count : (items ? items.length : 0);
    const countFn = opts.countFn || ((n) => String(n));
    const b = document.createElement("div");
    b.className = "day-digest-band" + (opts.tone ? " tone-" + opts.tone : "");
    const line = document.createElement("button");
    line.type = "button";
    line.className = "day-digest-line";
    const lbl = document.createElement("span");
    lbl.className = "day-digest-label";
    lbl.textContent = label;
    const cnt = document.createElement("span");
    cnt.className = "day-digest-count";
    cnt.textContent = countFn(total);
    line.appendChild(lbl);
    line.appendChild(cnt);
    b.appendChild(line);
    const expandable = items && items.length;
    if (expandable) {
      const list = document.createElement("div");
      list.className = "day-digest-items";
      list.hidden = !opts.open;
      const cap = opts.cap || 6;
      // Live count: clearing a VISIBLE row drops total AND the shown rows by one, so
      // "+N more" stays correct — only the band count needs re-rendering (Ross 2026-07-10).
      const onCleared = () => { total = Math.max(0, total - 1); cnt.textContent = countFn(total); };
      items.slice(0, cap).forEach((e) => {
        const r = document.createElement("div");
        r.className = "day-digest-item";
        // Single-line headline (collapsed; full text on hover). Click opens the
        // source doc to inspect (Ross UAT 2026-07-10).
        const txt = document.createElement("span");
        txt.className = "day-digest-item-text";
        const full = (e.owner ? prettySlug(e.owner) + " · " : "") + (e.summary || "(no summary)") + " · due " + shortDate(e.d);
        txt.textContent = full;
        txt.title = full;
        const docId = e.rec && e.rec.documentId;
        if (docId) {
          txt.classList.add("day-digest-item-link");
          txt.title = full + "  —  open source";
          txt.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openSourcePanel(docId, e.summary || null);
          });
        }
        r.appendChild(txt);
        // Clear (Dismiss verb canon): prune overdue items that went stale / slipped
        // when priorities moved. Global client-side suppression — the digest recomputes
        // via withoutDismissed, and the item stays reviewable elsewhere (fail-closed-VISIBLE).
        const acts = document.createElement("span");
        acts.className = "day-digest-item-acts";
        if (e.rec && e.rec.recordId) appendDismissControl(acts, e.rec.recordId, r, e.summary, onCleared);
        r.appendChild(acts);
        list.appendChild(r);
      });
      if (items.length > cap) {
        const more = document.createElement("div");
        more.className = "day-digest-more";
        more.textContent = "+" + (items.length - cap) + " more";
        list.appendChild(more);
      }
      b.appendChild(list);
      line.setAttribute("aria-expanded", opts.open ? "true" : "false");
      line.addEventListener("click", () => {
        list.hidden = !list.hidden;
        line.setAttribute("aria-expanded", list.hidden ? "false" : "true");
      });
    } else {
      line.disabled = true;
    }
    wrap.appendChild(b);
  };

  // WP-TODAY-3BANDS — the digest carries ONLY the overdue/at-risk tail here.
  // Its former Due-today / Rest-of-week / Coming-up bands were a third render
  // of the records the Next-two-weeks band now owns (one appearance per item);
  // the overdue tail stays because no other Today surface lists it in full
  // (the needs-attention board is the engine's curated subset). Collapsed by
  // default — the count line is the report, the list is one click away.
  if (dg.overdue.length) {
    const suffix = (dg.oldestOverdue ? " · oldest " + shortDate(dg.oldestOverdue) : "")
      + (dg.atRiskN ? " · " + dg.atRiskN + " at risk" : "");
    band("Overdue", dg.overdue, { tone: "fire", cap: 8, countFn: (n) => (n > 0 ? n + suffix : "cleared") });
  } else if (dg.atRiskN) {
    band("At risk", [], { tone: "fire", count: dg.atRiskN, countFn: (n) => n + " at risk" });
  } else {
    return; // nothing overdue, nothing at risk — no digest, the bands carry Today
  }

  panel.appendChild(wrap);
}

async function loadCorpusStateOfPlay(panel) {
  panel.classList.remove("sop-quiet");
  panel.innerHTML = '<div class="sop-status">Composing the overview…</div>';
  const data = await loadSoP("forest", null, personLens(_todayCtx && _todayCtx.viewerSlug));
  // WP-DAY-DIGEST — compute the deterministic day digest from the decision-log
  // (best effort; never blocks or fails the overview).
  let digest = null;
  try {
    const dl = await tauri.core.invoke("fetch_decision_log_full");
    const recs = withoutDismissed(Array.isArray(dl && dl.records) ? dl.records : []);
    digest = computeDayDigest(recs, Date.now());
  } catch (_e) { /* best effort — the overview still renders */ }
  if (!data) {
    // Forest narrative absent on this server (common on eval corpora). Rather than
    // a bare "unavailable" line as the top-of-Today content, the deterministic day
    // digest carries the slot — it's derived from the log we DO have (Ross UAT
    // 2026-07-10). Only when there's nothing at all to say do we fall to the quiet line.
    panel.classList.add("sop-quiet");
    panel.innerHTML = "";
    if (!digest) {
      panel.innerHTML = '<div class="sop-status">Overview isn\'t available on this server yet.</div>';
    }
  } else {
    renderCorpusPanel(panel, data);
  }
  // The day digest leads (narrative absent) or rides below the narrative (present),
  // so the state of play always reflects what's overdue / due / coming — even when
  // the forest overview is absent on this server.
  if (digest) renderDayDigest(panel, digest);
}
function renderCorpusPanel(panel, data) {
  panel.classList.remove("sop-quiet");
  panel.innerHTML = "";
  // Flatten the SoP payload to a copy-ready plain-text block (lead prose + any
  // labelled sections), for the Copy button + the inline digest editor.
  const sectionText = (Array.isArray(data.sections) ? data.sections : [])
    .map((s) => {
      const t = s && s.title ? String(s.title) : "";
      const b = s && (typeof s.prose === "string" ? s.prose : s.body) || "";
      return (t ? t + "\n" : "") + (b || "").trim();
    })
    .filter(Boolean)
    .join("\n\n");
  const copyText = [data.prose || "", sectionText].filter(Boolean).join("\n\n");

  const bar = document.createElement("div");
  bar.className = "sop-toolbar";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sop-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("copy_text", { text: copyText });
      copyBtn.textContent = "Copied ✓";
      copyBtn.disabled = true;
      setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.disabled = false; }, 1600);
    } catch (e) { showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." }); }
  });
  bar.appendChild(copyBtn);
  if (data.maturity) {
    const t = document.createElement("span");
    t.className = "sop-maturity-tag";
    t.textContent = String(data.maturity);
    bar.appendChild(t);
  }
  panel.appendChild(bar);

  const proseWrap = document.createElement("div");
  proseWrap.className = "sop-prose-wrap";
  // Today's panel renders the DIGEST (mockup 2): action line out front, lead
  // clamped behind Show more. Other SoP surfaces keep the full prose.
  renderSoPProse(proseWrap, data, { digest: true });
  panel.appendChild(proseWrap);

  // Phase B — inline digest edit (forest altitude). Editor edits the flattened
  // copy text; lead element is the prose wrapper.
  attachDigestEditor({ panel, bar, msg: proseWrap, scope: "forest", subject: "forest", label: "the org", message: copyText, editsEnabled: data.editsEnabled });
  // WP-SoP-Team-Update-Compose — the outward team-update affordance (forest scope).
  attachComposeAffordance(panel, { level: "forest", id: null, data, label: "all work" });
}

// ───────── WP-WorkForest-Native-SoP (UI-1 + UI-6) — top-of-Today narrative ─────────
//
// The Work-Forest-native State of Play sits above the Focus rail. A small lens
// toggle ("Your jobs" / "All work") picks the altitude:
//   person — forest level + person lens: "your jobs today" partitioned own vs touch
//   forest — unscoped forest rollup: the whole org's hot/stalled/conflicting work
// Both are the FOREST altitude; the lens is the only difference (Person × Forest).
// Additive + silent: the bar + panel stay hidden when the endpoint is unavailable.


// ───────── WP-WorkForest-Native-SoP (UI-3) — Frame SoP, on Decisions frame headers ─────────
//
// A "state of play" affordance on Project/Suggested frame headers (maturity-gated —
// Facet/Needs-evidence frames are too thin to digest). Clicking toggles an inline
// expansion that lazy-loads the Frame SoP digest via fetch_sop(level='frame', id=fid).
// Mirrors the Job SoP / entity-Definition lazy-load shape: fetch once, cache on the
// panel element, toggle visibility thereafter. Additive + silent — when the endpoint
// returns {available:false} or no prose, the affordance quietly removes itself.

// Maturity gate — only Project/Suggested frames get a Frame SoP affordance.
function frameSoPEligible(frame) {
  return !!frame && !frame.__unframed && (frame.state === "Project" || frame.state === "Suggested");
}

// Render a Frame SoP digest into an inline panel. Compact (no licence footnote) so
// the expansion stays light beneath the frame header. Lazy: fetches on first open,
// caches its result on the panel's dataset, reuses the cached DOM on later toggles.
// Returns true when the panel now holds prose, false when there was nothing to show
// (the caller then quietly retires the trigger).
async function renderFrameSoP(panel, fid) {
  if (panel.dataset.loaded === "1") return true; // already populated — toggle only
  panel.innerHTML = '<div class="sop-status">Composing this frame’s state of play…</div>';
  const data = await loadSoP("frame", fid, null);
  if (!data) {
    panel.dataset.loaded = "empty";
    panel.innerHTML = "";
    return false;
  }
  panel.dataset.loaded = "1";
  panel.innerHTML = "";
  if (data.maturity) {
    const tag = document.createElement("div");
    tag.className = "sop-maturity-tag";
    tag.textContent = String(data.maturity);
    panel.appendChild(tag);
  }
  const body = document.createElement("div");
  body.className = "sop-frame-body";
  renderSoPProse(body, data, { compact: true });
  panel.appendChild(body);
  // WP-SoP-Team-Update-Compose — the outward team-update affordance (frame +
  // workstream headers both route here). Additive; renders only when composeEnabled.
  attachComposeAffordance(panel, { level: "frame", id: fid, data });
  return true;
}

// ───────── WP-WorkForest-Native-SoP (UI-4) — per-job SoP REMOVED ─────────
//
// The job-level "State of play" digest (lazyJobSoP/appendJobSoP + the .sop-job-panel
// block) was retired in the consistency pass: the consolidated state of play now
// lives one level up, on the workstream/frame header (makeSoPToggle → renderFrameSoP),
// on demand. Individual job rows no longer carry their own digest, so the dead
// fetch/cache/append helpers and the level='job' loadSoP call site are gone. The
// only remaining SoP rendering path for forest/frame/workstream is renderSoPProse.

// WP-Cohesion-Operators — "worth looping in" rail (deterministic INFORM operator),
// rendered on the PER-PERSON digest and scoped to the viewer (`viewerSlug`):
//   owner-side  — decisions the viewer made that touch someone who wasn't there → "consider looping in X"
//   target-side — decisions made without the viewer that touch their work → "worth knowing"
// Backed by GET /api/decision-log/inform via fetch_inform_edges. Additive + silent.
async function loadInformRail(el, viewerSlug) {
  let res;
  try {
    res = await tauri.core.invoke("fetch_inform_edges");
  } catch (err) {
    console.warn("[main] fetch_inform_edges failed:", err);
    return; // silent — the rail is additive, never an error surface
  }
  if (!res || res.available === false) return; // flag off / server too old
  const edges = Array.isArray(res.edges) ? res.edges : [];
  const asOwner = edges.filter((e) => e.decision && e.decision.owner === viewerSlug);
  const asTarget = edges.filter((e) => e.person === viewerSlug);
  if (asOwner.length === 0 && asTarget.length === 0) return;
  renderInformRail(el, asOwner, asTarget);
}

function informName(slug) {
  return String(slug || "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function renderInformRail(el, asOwner, asTarget) {
  el.innerHTML = "";
  // Two distinct actions get two distinct headers — never one shared umbrella,
  // which reads backwards on the recipient side.
  if (asOwner.length) {
    const head = document.createElement("div");
    head.className = "inform-head";
    head.textContent = "Loop them in"; // YOU act — you decided it, they weren't there
    el.appendChild(head);
    const sub = document.createElement("div");
    sub.className = "inform-sub";
    sub.textContent = "Decisions you made that touch someone who wasn't in the room:";
    el.appendChild(sub);
    for (const edge of asOwner) el.appendChild(renderInformCard(edge, "owner"));
  }
  if (asTarget.length) {
    const head = document.createElement("div");
    head.className = "inform-head";
    if (asOwner.length) head.style.marginTop = "20px";
    head.textContent = "Catch up on"; // YOU receive — decided without you
    el.appendChild(head);
    const sub = document.createElement("div");
    sub.className = "inform-sub";
    sub.textContent = "Decided without you, but it touches your work — worth getting up to speed:";
    el.appendChild(sub);
    for (const edge of asTarget) el.appendChild(renderInformCard(edge, "target"));
  }
}

function renderInformCard(edge, mode) {
  const card = document.createElement("div");
  card.className = "inform-card";
  const targetName = informName(edge.person);
  const ownerName = informName(edge.decision && edge.decision.owner);
  const decision = (edge.decision && edge.decision.summary) || "(decision)";

  const top = document.createElement("div");
  top.className = "inform-card-top";
  const who = document.createElement("div");
  who.className = "inform-who";
  if (mode === "owner") {
    who.appendChild(document.createTextNode("Consider looping in "));
    const strong = document.createElement("strong");
    strong.textContent = targetName;
    who.appendChild(strong);
  } else {
    who.appendChild(document.createTextNode("Worth knowing"));
  }
  top.appendChild(who);
  const tag = document.createElement("span");
  tag.className = "inform-tag";
  tag.textContent = mode === "owner" ? "not in the room" : "decided by " + ownerName;
  top.appendChild(tag);
  card.appendChild(top);

  const dec = document.createElement("div");
  dec.className = "inform-decision";
  dec.textContent = decision;
  card.appendChild(dec);

  if (edge.why) {
    const why = document.createElement("div");
    why.className = "inform-why";
    why.textContent = edge.why;
    card.appendChild(why);
  }

  const actions = document.createElement("div");
  actions.className = "inform-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "inform-copy";
  copyBtn.textContent = "Copy";
  const sendReady = mode === "owner"
    ? "Looping you in on: " + decision + (edge.why ? "\n\nWhy: " + edge.why : "")
    : "Catching up on: " + decision + (edge.why ? "\n\nWhy it touches my work: " + edge.why : "");
  copyBtn.addEventListener("click", async () => {
    try {
      await tauri.core.invoke("copy_text", { text: sendReady });
      copyBtn.textContent = "Copied ✓";
      copyBtn.disabled = true;
      setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.disabled = false; }, 1600);
    } catch (e) {
      showToast({ kind: "failure", title: "Couldn't copy", body: "Try again." });
    }
  });
  actions.appendChild(copyBtn);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "inform-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => card.remove());
  actions.appendChild(dismiss);
  card.appendChild(actions);
  return card;
}

// WP-Priority-Operator — the "Focus" surface (deterministic importance × urgency),
// the top of the Today view. Splits the viewer's ranked items into collapsible
// Focus (do-now / schedule / delegate — the act-on quadrants) and Watch (the
// watch quadrant) sections, each card carrying a business-language `why` (packets,
// no slugs) + pin/dismiss gestures that calibrate the per-user weight vector
// (passive — never a rating task). Backed by GET /api/decision-log/priority via
// fetch_priority. Additive + silent: never an error surface; loads on Today
// independently of the State-of-Play digest.
const QUADRANT_LABEL = { "do-now": "Do now", schedule: "Schedule", delegate: "Delegate", watch: "Watch" };
const QUADRANT_ORDER = ["do-now", "schedule", "delegate", "watch"];
const FOCUS_QUADRANTS = new Set(["do-now", "schedule", "delegate"]);
const FOCUS_CAP = 15;
const WATCH_CAP = 25;

// WP-Rollup P1 — roll the flat Focus list up by entity/job. Flippable: set to
// false to fall back to the pre-rollup flat card list (A/B against the pilot).
// Degrades automatically when the server doesn't send primaryEntity yet (P1a).
const ROLLUP_ENABLED = true;
const FOCUS_GROUP_CAP = 12;
// Lazy entity-definition cache (entity slug → Promise<string|null>). One
// fetch_entity_card per entity, ever; reused across expands + reloads.
const _entityDefCache = new Map();

function quadrantRank(q) {
  const i = QUADRANT_ORDER.indexOf(q);
  return i < 0 ? QUADRANT_ORDER.length : i;
}

// Lazily fetch the LLM "Definition" prose for an entity (the receipts/entity
// card). Returns a short one-paragraph string, or null when unavailable (flag
// off / no card / unreachable) — the group still renders, just without a blurb.
function lazyEntityDefinition(entity) {
  if (_entityDefCache.has(entity)) return _entityDefCache.get(entity);
  const p = (async () => {
    try {
      const data = await tauri.core.invoke("fetch_entity_card", { entity });
      if (!data || data.available === false) return null;
      const prose = typeof data.prose === "string" ? data.prose.trim() : "";
      if (!prose) return null;
      const first = prose.split(/\n{2,}/)[0].trim();
      return first.length > 180 ? first.slice(0, 177).trimEnd() + "…" : first;
    } catch (_e) {
      return null;
    }
  })();
  _entityDefCache.set(entity, p);
  return p;
}

// Reusable collapsible section (header with caret + count, toggles its body).
function makeCollapsible(title, count, defaultOpen) {
  const section = document.createElement("section");
  section.className = "log-collapse" + (defaultOpen ? "" : " log-collapsed");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "log-collapse-head";
  head.setAttribute("aria-expanded", defaultOpen ? "true" : "false");
  const caret = document.createElement("span");
  caret.className = "log-collapse-caret";
  caret.textContent = defaultOpen ? "▾" : "▸";
  head.appendChild(caret);
  const t = document.createElement("span");
  t.className = "log-collapse-title";
  t.textContent = title;
  head.appendChild(t);
  const c = document.createElement("span");
  c.className = "log-collapse-count";
  if (count != null) c.textContent = String(count);
  head.appendChild(c);
  const body = document.createElement("div");
  body.className = "log-collapse-body";
  if (!defaultOpen) body.hidden = true;
  head.addEventListener("click", () => {
    const open = body.hidden; // about to open
    body.hidden = !open;
    caret.textContent = open ? "▾" : "▸";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    section.classList.toggle("log-collapsed", !open);
  });
  section.appendChild(head);
  section.appendChild(body);
  return { section, body };
}

async function loadTodayPriority() {
  const container = document.getElementById("log-priority-sections");
  if (container) container.innerHTML = "";
  let res;
  try {
    res = await tauri.core.invoke("fetch_priority");
  } catch (err) {
    console.warn("[main] fetch_priority failed:", err);
    return; // silent — additive
  }
  if (!res || res.available === false) return; // flag off / server too old
  const items = Array.isArray(res.items) ? res.items : [];
  if (items.length === 0 || !container) return;
  renderTodayPriority(container, res);
}

// ───────── WP-Job-Vigilance-Wave2 — Focus chase-list (Stalled / Chasing) ─────────
//
// The headline vigilance surface. Stalled jobs render as ranked cards on Today,
// alongside the Focus priority rail — where the user looks for "what now," NOT in
// a separate tab. The view is PURE RENDER: detection / rollup / ranking / gating /
// receipts are all server-side and derived-at-read (GET /api/vigilance/voids?
// grouped=1). We only display the payload + join the heat band from jobHeat
// (GET /api/decision-log?full=1).
//
// Two-axis discipline (brief §4, load-bearing): heat band AND stalled-ness are
// DISTINCT chips, never collapsed to one number. A pure surfaceScore sort buries a
// silent-but-low-priority promise (Angelica's 35d hotlist = jobHeat 0.23 quiet);
// the "silent Nd / N waiting" chips keep stalled-ness visible independently. Jobs
// whose heat band is monitor/quiet (and not high-surfaceScore) drop to the
// Watching-tab "Low-impact waiting" drawer rather than crowding the Focus top.

// Band-gate: which bands count as "primary chase" (vs the low-impact drawer).
const STALLED_PRIMARY_BANDS = new Set(["act_now", "verify", "soon"]);
// surfaceScore floor that promotes a low-band job into the primary chase-list
// anyway (so a high-stall low-heat job isn't silently dropped from Focus). Tunable
// in-app per the G4b ~8-primary finding on Trisha's corpus.
const STALLED_SURFACE_FLOOR = 0.5;

// Namespaced to avoid the existing top-level BAND_LABEL (which lacks `quiet`).
const STALLED_BAND_LABEL = {
  act_now: "Act now",
  verify: "Verify",
  soon: "Soon",
  monitor: "Monitor",
  quiet: "Quiet",
};

// True when a stalled job belongs in the primary Focus chase-list (vs the
// Watching-tab low-impact drawer). Band-gate OR high surfaceScore.
function stalledIsPrimary(job, band) {
  if (band && STALLED_PRIMARY_BANDS.has(band)) return true;
  return (job.surfaceScore || 0) >= STALLED_SURFACE_FLOOR;
}

// Max ageDays across a stalled job's scoredVoids — the "oldest Nd silent" figure.
function stalledMaxAge(job) {
  const ages = (job.scoredVoids || []).map((v) => v.ageDays).filter((n) => typeof n === "number");
  return ages.length ? Math.max(...ages) : null;
}

// The cached grouped vigilance payload + the jobHeat/jobNames join, so the
// Watching ledger can reuse the same grouped data without a second fetch.
let _vigilanceGrouped = null; // { stalledJobs, receipts, jobCount, rawVoidCount } | null
let _vigilanceJobHeat = {};   // jobKey -> { band, heat, ... }
let _vigilanceJobNames = {};  // jobKey -> canonical name
// WP-Job-Vigilance-Wave2 UI — the same work-forest substrate the Log uses, so a
// Watching card can render the frame › workstream › job breadcrumb + resolve its
// anchor record (→ documentId for the source badge, → owner for "Draft follow-up").
let _vigilanceFrames = [];        // CoordinationFrame[] (fid, name, parentFid, jobKeys, state)
let _vigilanceRecordJobs = {};    // recordId -> "job:..." key
let _vigilanceRecordsById = new Map(); // recordId -> record

// Fetch the grouped vigilance payload + the full decision-log (for jobHeat/jobNames).
// Returns null when grouped data is absent (flag off / old backend) so callers can
// degrade cleanly. Caches into the _vigilance* module state for ledger reuse.
async function fetchVigilanceGrouped() {
  let voidData;
  try {
    voidData = await tauri.core.invoke("fetch_vigilance_voids", { grouped: true });
  } catch (err) {
    console.warn("[main] fetch_vigilance_voids(grouped) failed:", err);
    return null;
  }
  const grouped = voidData && voidData.grouped;
  if (!grouped || !Array.isArray(grouped.stalledJobs)) {
    // Feature-detect: no grouped object → flag off / old backend. Degrade silently.
    _vigilanceGrouped = null;
    return { voidData, grouped: null };
  }
  _vigilanceGrouped = grouped;

  // Join the heat band from the full decision-log (free — jobHeat + jobNames).
  try {
    const full = await tauri.core.invoke("fetch_decision_log_full");
    _vigilanceJobHeat = (full && full.jobHeat) || {};
    _vigilanceJobNames = (full && full.jobNames) || {};
    // WP-Job-Vigilance-Wave2 UI — also keep the work-forest hierarchy + the
    // record join so each Watching card can show its frame › job breadcrumb,
    // link to the source document, and draft a follow-up to the owner.
    _vigilanceFrames = Array.isArray(full && full.frames) ? full.frames : [];
    _vigilanceRecordJobs = (full && full.recordJobs) || {};
    _vigilanceRecordsById = new Map();
    for (const it of Array.isArray(full && full.records) ? full.records : []) {
      const rec = it && it.record ? it.record : it;
      if (rec && rec.recordId) _vigilanceRecordsById.set(rec.recordId, rec);
    }
  } catch (err) {
    console.warn("[main] fetch_decision_log_full (vigilance join) failed:", err);
    _vigilanceJobHeat = {};
    _vigilanceJobNames = {};
    _vigilanceFrames = [];
    _vigilanceRecordJobs = {};
    _vigilanceRecordsById = new Map();
  }
  return { voidData, grouped };
}

// Band for a stalled job, joined client-side from jobHeat (StalledJob carries no
// band field — only jobP0). Tries the bare key and the job:-prefixed key.
function stalledBand(jobKey) {
  const jh = _vigilanceJobHeat[jobKey] || _vigilanceJobHeat["job:" + jobKey] || _vigilanceJobHeat[String(jobKey).replace(/^job:/, "")];
  return jh && jh.band ? jh.band : null;
}

// Canonical display name for a stalled job (jobNames join; falls back to slug).
function stalledName(jobKey) {
  return (
    _vigilanceJobNames[jobKey] ||
    _vigilanceJobNames["job:" + jobKey] ||
    _vigilanceJobNames[String(jobKey).replace(/^job:/, "")] ||
    prettySlug(String(jobKey).replace(/^job:/, ""))
  );
}

// Load + render the Stalled / Chasing chase-list on Today. Additive + silent:
// renders nothing (and no error) when grouped data is absent.
async function loadStalledChaseList() {
  const container = document.getElementById("log-stalled-sections");
  if (container) container.innerHTML = "";
  if (!container) return;
  const result = await fetchVigilanceGrouped();
  if (!result || !result.grouped) return; // feature-detect: nothing to render
  const grouped = result.grouped;
  const jobs = Array.isArray(grouped.stalledJobs) ? grouped.stalledJobs.slice() : [];
  if (!jobs.length) return;

  // Receipt lookup by jobKey for the "Why stalled" drawer.
  const receiptByJob = new Map();
  for (const r of grouped.receipts || []) receiptByJob.set(r.jobKey, r);

  // Sort by surfaceScore desc (the chase-list rank), then partition into primary
  // chase vs low-impact (the latter is surfaced in the Watching ledger, not here).
  jobs.sort((a, b) => (b.surfaceScore || 0) - (a.surfaceScore || 0));
  const primary = jobs.filter((j) => stalledIsPrimary(j, stalledBand(j.jobKey)));
  if (!primary.length) return;

  const section = makeCollapsible("Stalled / Chasing", primary.length, true);
  const sub = document.createElement("div");
  sub.className = "priority-sub";
  sub.textContent = "Promises stalled on someone else — what's waiting, who's on the hook, how long it's been silent.";
  section.body.appendChild(sub);

  for (const job of primary) {
    section.body.appendChild(renderStalledJobCard(job, receiptByJob.get(job.jobKey) || null));
  }
  container.appendChild(section.section);
}

// One stalled-job card: name + two-axis chips + "{voidCount} open / oldest Nd
// silent" + the top void's render string + a "Why stalled" drawer (the receipt).
function renderStalledJobCard(job, receipt) {
  const card = document.createElement("div");
  card.className = "priority-card stalled-card";

  const band = stalledBand(job.jobKey);
  const maxAge = stalledMaxAge(job);

  // Top row: job name + two-axis chips (heat band AND stalled-ness — distinct).
  const top = document.createElement("div");
  top.className = "priority-card-top stalled-top";
  const name = document.createElement("span");
  name.className = "stalled-jobname";
  name.textContent = stalledName(job.jobKey);
  top.appendChild(name);

  // Axis 1 — priority/heat band (joined from jobHeat).
  if (band) {
    const heatChip = document.createElement("span");
    heatChip.className = "stalled-chip stalled-chip-band stalled-band-" + band;
    heatChip.textContent = STALLED_BAND_LABEL[band] || band;
    top.appendChild(heatChip);
  }
  // Axis 2 — stalled-ness (silent Nd), ALWAYS shown, independent of heat. This is
  // the augmented-urgency signal: a chronically-silent promise stays visible even
  // when base priority (heat) is low. Brief §4.1/§4.2 — do not collapse to one number.
  if (typeof maxAge === "number") {
    const silentChip = document.createElement("span");
    silentChip.className = "stalled-chip stalled-chip-silent";
    silentChip.textContent = `Silent ${maxAge}d`;
    top.appendChild(silentChip);
  }
  card.appendChild(top);

  // Count line: "{voidCount} open / oldest Nd silent".
  const countLine = document.createElement("div");
  countLine.className = "stalled-count";
  const parts = [`${job.voidCount} open`];
  if (typeof maxAge === "number") parts.push(`oldest ${maxAge}d silent`);
  if (job.blockerCount) parts.push(`${job.blockerCount} downstream blocked`);
  countLine.textContent = parts.join(" · ");
  card.appendChild(countLine);

  // The top void's verify-framed render string ("Waiting on …") — prefer the
  // server-authored copy. Drawn from the receipt's first void, falling back to
  // scoredVoids order.
  const topVoid = receipt && Array.isArray(receipt.voids) && receipt.voids.length ? receipt.voids[0] : null;
  if (topVoid && topVoid.render) {
    const headline = document.createElement("p");
    headline.className = "stalled-headline";
    headline.textContent = topVoid.render;
    card.appendChild(headline);
  }

  // "Why stalled" drawer — the typed JobVigilanceReceipt graph, no LLM prose.
  if (receipt) {
    card.appendChild(renderWhyStalledDrawer(receipt));
  }

  return card;
}

// The "Why stalled" drawer: a server-grounded typed graph — the waiting-on
// records per void, the per-void score breakdown, and the typed blockageEdges.
// NO LLM-generated prose (brief §3.1 / ship gate G2).
function renderWhyStalledDrawer(receipt) {
  const wrap = document.createElement("div");
  wrap.className = "stalled-drawer";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "stalled-drawer-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Why stalled";

  const body = document.createElement("div");
  body.className = "stalled-drawer-body";
  body.hidden = true;

  toggle.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.textContent = open ? "Hide why stalled" : "Why stalled";
  });

  // Per-void breakdown: motif + owner + age + waiting-on records + score.
  const voids = Array.isArray(receipt.voids) ? receipt.voids : [];
  if (voids.length) {
    const vList = document.createElement("ul");
    vList.className = "stalled-void-list";
    for (const v of voids) {
      const li = document.createElement("li");
      li.className = "stalled-void";

      const head = document.createElement("div");
      head.className = "stalled-void-head";
      const motif = v.motif ? `<span class="stalled-motif">${escapeHtml(stalledMotifLabel(v.motif))}</span>` : "";
      const owner = vvIsNamedSlug(v.owner) ? ` · ${escapeHtml(vvHumanizeSlug(v.owner))}` : "";
      const age = typeof v.ageDays === "number" ? ` · ${v.ageDays}d silent` : "";
      head.innerHTML = `${motif}${owner}${age}`;
      li.appendChild(head);

      // Verify-framed render line (server-authored) or the summary.
      const line = document.createElement("p");
      line.className = "stalled-void-summary";
      line.textContent = v.render || v.summary || "";
      li.appendChild(line);

      // Citation-checked verbatim, ONLY when verified (trust property) — via the
      // ONE receipt component (quote-only; the drawer doesn't wire the source pane).
      if (v.verbatim && v.verbatimVerified) {
        li.appendChild(
          renderReceipt(
            { verbatim: v.verbatim, verbatimVerified: v.verbatimVerified },
            { jump: false, quoteWrap: true, variant: "receipt-stalled" },
          ),
        );
      }

      // Waiting-on records (the enabling records this void is blocked behind).
      const waitingOn = Array.isArray(v.waitingOn) ? v.waitingOn : [];
      if (waitingOn.length) {
        const wo = document.createElement("div");
        wo.className = "stalled-waiting";
        const lab = document.createElement("span");
        lab.className = "stalled-waiting-label";
        lab.textContent = "Waiting on";
        wo.appendChild(lab);
        const ul = document.createElement("ul");
        ul.className = "stalled-waiting-list";
        for (const w of waitingOn) {
          const wli = document.createElement("li");
          wli.textContent = w.summary || w.recordId || "";
          ul.appendChild(wli);
        }
        wo.appendChild(ul);
        li.appendChild(wo);
      }

      // Per-void score breakdown (residual / blockage / severity / total) — the
      // typed numbers, shown plainly for the audit trail (not narrated).
      const sc = v.score || {};
      if (sc && (sc.total != null || sc.residual != null)) {
        const score = document.createElement("div");
        score.className = "stalled-score";
        const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "—");
        score.textContent = `score ${fmt(sc.total)} (residual ${fmt(sc.residual)} · blockage ${fmt(sc.blockage)} · severity ${fmt(sc.severity)})`;
        li.appendChild(score);
      }

      vList.appendChild(li);
    }
    body.appendChild(vList);
  }

  // Typed blockage edges: dependent → blocker, with status.
  const edges = Array.isArray(receipt.blockageEdges) ? receipt.blockageEdges : [];
  if (edges.length) {
    const eHead = document.createElement("div");
    eHead.className = "stalled-edges-head";
    eHead.textContent = "Blocking dependencies";
    body.appendChild(eHead);
    const eList = document.createElement("ul");
    eList.className = "stalled-edges-list";
    for (const e of edges) {
      const eli = document.createElement("li");
      eli.className = "stalled-edge";
      const status = e.status ? ` <span class="stalled-edge-status">(${escapeHtml(e.status)})</span>` : "";
      eli.innerHTML =
        `<span class="stalled-edge-dep">${escapeHtml(e.dependentSummary || e.dependentRecordId || "")}</span>` +
        ` <span class="stalled-edge-arrow">needs</span> ` +
        `<span class="stalled-edge-blk">${escapeHtml(e.blockerSummary || e.blockerRecordId || "")}</span>${status}`;
      eList.appendChild(eli);
    }
    body.appendChild(eList);
  }

  wrap.append(toggle, body);
  return wrap;
}

// Human-readable motif label. Motif keys come from the server (M1/M2 family);
// fall back to a prettified slug for any future motif.
const STALLED_MOTIF_LABEL = {
  "m1-promise": "Promise outstanding",
  "m2-blocked": "Blocked dependency",
  "m3-contradiction": "Unresolved conflict",
  egress: "Awaiting reply",
  "contradicts-unresolved": "Needs reconciliation",
  "depends-on-incomplete": "Blocked dependency",
  "overdue-silent": "Overdue · silent",
};
function stalledMotifLabel(motif) {
  return STALLED_MOTIF_LABEL[motif] || prettySlug(String(motif || ""));
}

async function sendPriorityGesture(item, gestureType, reason, snoozeUntil, handoffNote) {
  try {
    await tauri.core.invoke("post_priority_gesture", {
      gestureType,
      recordId: item.recordId,
      relationship: item.relationship || null,
      owner: item.owner || null,
      reason: reason || null,
      snoozeUntil: snoozeUntil || null,
      handoffNote: handoffNote || null,
      // Denormalized context SNAPSHOT — the at-the-moment values, so the offline
      // training join needs no re-derive against an aging corpus.
      context: {
        quadrant: item.quadrant || null,
        seniorityTier: item.seniorityTier || null,
        importanceSource: item.importanceSource || null,
        counterparty: item.counterparty || null,
        priority: typeof item.priority === "number" ? item.priority : null,
        importance: typeof item.importance === "number" ? item.importance : null,
        urgency: typeof item.urgency === "number" ? item.urgency : null,
      },
    });
    return true;
  } catch (err) {
    console.warn("[main] post_priority_gesture failed:", err);
    showToast({ kind: "failure", title: "Couldn't save", body: "Try again." });
    return false;
  }
}

// Priority dismiss reasons — the class decides calibration direction (false-positive
// vs correct-but-cleared). Mirrors the decision-log RecordHitlReason set. (Named
// distinctly from the decision-log's own DISMISS_REASONS.)
const PRIORITY_DISMISS_REASONS = [
  { reason: "not-relevant", label: "Not relevant" },
  { reason: "already-known", label: "Already knew" },
  { reason: "closing-out", label: "Handled" },
];

// Snooze presets (wall-clock; the item resurfaces in Focus on that date).
function isoDatePlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
const SNOOZE_PRESETS = [
  { label: "Tomorrow", days: 1 },
  { label: "Next week", days: 7 },
  { label: "In a month", days: 30 },
];

// A copy-ready hand-off note for the Delegate action — drafts the ask; you send it.
function buildHandoffNote(item) {
  const bits = [];
  if (item.relationship === "client") bits.push("client-facing");
  else if (item.relationship === "partner") bits.push("external-facing");
  const why = (item.why || "").replace(/^This needs attention now — /i, "").replace(/\.$/, "");
  if (why) bits.push(why);
  const tail = bits.length ? ` (${bits.join("; ")})` : "";
  const owner = item.owner ? ` — currently with ${prettySlug(item.owner)}` : "";
  return `Can you take point on this: "${item.summary || "this item"}"${tail}.${owner}`;
}

// WP-Rollup P1 — one collapsible job/entity group inside Focus. Collapsed by
// default (the density win: a scannable list of jobs, not a wall of cards). The
// do-now count is badged on the header so urgency is visible without expanding;
// the LLM definition + the nested action cards load lazily on first expand.
function renderEntityGroup(entity, groupItems) {
  const section = document.createElement("section");
  section.className = "priority-group log-collapse log-collapsed";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "priority-group-head log-collapse-head";
  head.setAttribute("aria-expanded", "false");

  const caret = document.createElement("span");
  caret.className = "log-collapse-caret";
  caret.textContent = "▸";
  head.appendChild(caret);

  const title = document.createElement("span");
  title.className = "log-collapse-title priority-group-title";
  title.textContent = entity === "__ungrouped__" ? "Other" : prettySlug(entity);
  head.appendChild(title);

  const doNow = groupItems.filter((i) => i.quadrant === "do-now").length;
  if (doNow) {
    const badge = document.createElement("span");
    badge.className = "priority-group-urgent";
    badge.textContent = `Do now ${doNow}`;
    head.appendChild(badge);
  }

  const count = document.createElement("span");
  count.className = "log-collapse-count";
  count.textContent = String(groupItems.length);
  head.appendChild(count);

  const body = document.createElement("div");
  body.className = "log-collapse-body priority-group-body";
  body.hidden = true;

  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    if (entity !== "__ungrouped__") {
      const def = document.createElement("div");
      def.className = "priority-group-def";
      def.hidden = true;
      body.appendChild(def);
      lazyEntityDefinition(entity).then((text) => {
        if (text) { def.textContent = text; def.hidden = false; }
      });
    }
    for (const it of groupItems) body.appendChild(renderPriorityCard(it, false));
  };

  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open) fill();
    body.hidden = !open;
    caret.textContent = open ? "▾" : "▸";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    section.classList.toggle("log-collapsed", !open);
  });

  section.appendChild(head);
  section.appendChild(body);
  return section;
}

// WP-Rollup P2 — generic collapsible group row (used for section + job bands).
// opts: { defaultOpen, extraClass, fill(body) }. `fill` runs once, lazily on
// first open (or immediately when defaultOpen).
function makeGroupRow(label, count, doNow, opts) {
  const sec = document.createElement("section");
  sec.className = "priority-group log-collapse" + (opts.defaultOpen ? "" : " log-collapsed") + (opts.extraClass ? " " + opts.extraClass : "");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "priority-group-head log-collapse-head";
  head.setAttribute("aria-expanded", opts.defaultOpen ? "true" : "false");
  const caret = document.createElement("span");
  caret.className = "log-collapse-caret";
  caret.textContent = opts.defaultOpen ? "▾" : "▸";
  head.appendChild(caret);
  const title = document.createElement("span");
  title.className = "log-collapse-title priority-group-title";
  title.textContent = label;
  title.title = label;                       // full text on hover (it truncates)
  head.appendChild(title);
  if (opts.tag) {                            // e.g. the Veeva job ID — never truncated
    const tag = document.createElement("span");
    tag.className = "priority-job-tag";
    tag.textContent = opts.tag;
    head.appendChild(tag);
  }
  if (opts.quadrant) {                       // job-grain quadrant (do-now/schedule/…)
    const qb = document.createElement("span");
    qb.className = "priority-qbadge priority-qbadge-" + opts.quadrant;
    qb.textContent = QUADRANT_LABEL[opts.quadrant] || opts.quadrant;
    head.appendChild(qb);
  }
  if (doNow) {
    const b = document.createElement("span");
    b.className = "priority-group-urgent";
    b.textContent = `Do now ${doNow}`;
    head.appendChild(b);
  }
  const c = document.createElement("span");
  c.className = "log-collapse-count";
  c.textContent = String(count);
  head.appendChild(c);
  const body = document.createElement("div");
  body.className = "log-collapse-body priority-group-body";
  let filled = false;
  const fill = () => { if (filled) return; filled = true; opts.fill(body); };
  if (opts.defaultOpen) fill(); else body.hidden = true;
  head.addEventListener("click", () => {
    const open = body.hidden;
    if (open) fill();
    body.hidden = !open;
    caret.textContent = open ? "▾" : "▸";
    head.setAttribute("aria-expanded", open ? "true" : "false");
    sec.classList.toggle("log-collapsed", !open);
  });
  head.appendChild(document.createElement("span"));
  sec.appendChild(head);
  sec.appendChild(body);
  return sec;
}

const doNowOf = (items) => items.filter((i) => i.quadrant === "do-now").length;

// WP-Grouping-Operator P4 — the canonical P2 job names from the priority
// response (parentJob → subject-anchored name). Set per render in
// renderTodayPriority; jobName() prefers it over the raw segmenter header.
let currentJobNames = {};

// Display name for a job row (the Veeva ID rides in a separate chip, not here).
function jobName(parentJob, jobHeader) {
  const canonical = currentJobNames[parentJob];
  if (canonical) return canonical;
  const name = (jobHeader || "").replace(/\s+/g, " ").trim();
  if (name) return name;
  const veeva = /^job:((?:us|hq)-non-\d+)$/i.exec(parentJob || "");
  return veeva ? veeva[1].toUpperCase() : prettySlug((parentJob || "").replace(/^job:/, ""));
}
// The Veeva job ID (the project key), or null — rendered as a non-truncated chip.
function veevaTag(parentJob) {
  const m = /^job:((?:us|hq)-non-\d+)$/i.exec(parentJob || "");
  return m ? m[1].toUpperCase() : null;
}

function cleanSection(s) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > 44 ? t.slice(0, 43).trimEnd() + "…" : t || "Other";
}

// A job row (collapsed) → its action cards on expand.
function renderJobGroup(parentJob, jobHeader, items) {
  return makeGroupRow(jobName(parentJob, jobHeader), items.length, 0, {
    extraClass: "priority-job",
    tag: veevaTag(parentJob),
    quadrant: items[0] && items[0].jobQuadrant,     // job-grain quadrant badge
    fill: (body) => {
      for (const it of items) {
        const card = renderPriorityCard(it, false);
        if (it.section) {                            // provenance: which hot-list this came from
          const prov = document.createElement("div");
          prov.className = "priority-prov";
          prov.textContent = cleanSection(it.section);
          card.insertBefore(prov, card.firstChild);
        }
        body.appendChild(card);
      }
      // (Per-job SoP removed — the state of play now lives on the workstream/frame
      // header above, on demand. A single job is too granular to "digest".)
    },
  });
}

const jobRank = { "do-now": 0, schedule: 1, delegate: 2, watch: 3 };

// A section band (open by default) → its job rows, hottest job first.
function renderSectionGroup(section, items) {
  // Group the section's items by parentJob.
  const jobs = new Map();
  for (const it of items) {
    const jk = it.parentJob;
    if (!jobs.has(jk)) jobs.set(jk, { header: it.jobHeader, items: [] });
    jobs.get(jk).items.push(it);
  }
  // Sort jobs by job-grain quadrant (do-now first), then job priority, then size.
  const ordered = [...jobs.entries()].sort((a, b) => {
    const qa = jobRank[a[1].items[0]?.jobQuadrant] ?? 2, qb = jobRank[b[1].items[0]?.jobQuadrant] ?? 2;
    const pa = a[1].items[0]?.jobPriority ?? 0, pb = b[1].items[0]?.jobPriority ?? 0;
    return qa - qb || pb - pa || b[1].items.length - a[1].items.length;
  });
  return makeGroupRow(cleanSection(section), items.length, doNowOf(items), {
    defaultOpen: true,
    extraClass: "priority-section",
    fill: (body) => {
      for (const [jk, j] of ordered) body.appendChild(renderJobGroup(jk, j.header, j.items));
    },
  });
}

function renderTodayPriority(container, data) {
  container.innerHTML = "";
  currentJobNames = data.jobNames || {};   // P4 — canonical names for job rows
  const items = data.items || [];
  const counts = data.quadrantCounts || {};
  const tracked = items.filter((i) => i.tracked);
  const trackedIds = new Set(tracked.map((i) => i.recordId));

  // ── Focus: the act-on quadrants (do-now / schedule / delegate). The quadrant
  //    chips are toggle FILTERS over this list (click "Schedule" → only schedule
  //    items; click again → all focus quadrants). ──
  const focusCount = (counts["do-now"] || 0) + (counts["schedule"] || 0) + (counts["delegate"] || 0);
  const focus = makeCollapsible("Focus", focusCount, true);

  const sub = document.createElement("div");
  sub.className = "priority-sub";
  sub.textContent = data.horizon
    ? `What matters most — for you, right now (as of ${data.horizon}). Tap a chip to filter.`
    : "What matters most — for you, right now. Tap a chip to filter.";
  focus.body.appendChild(sub);

  const chips = document.createElement("div");
  chips.className = "priority-quadrants";
  focus.body.appendChild(chips);

  const cardArea = document.createElement("div");
  focus.body.appendChild(cardArea);

  let activeFilter = null; // null = all; else a JOB quadrant (do-now/schedule/delegate/watch)

  const renderCards = () => {
    cardArea.innerHTML = "";
    const inScope = (i) => FOCUS_QUADRANTS.has(i.quadrant);   // base pool = focus actions
    const trk = tracked.filter(inScope);
    if (trk.length) {
      const th = document.createElement("div");
      th.className = "priority-tracking-head";
      th.textContent = `Tracking · ${trk.length}`;
      cardArea.appendChild(th);
      for (const it of trk) cardArea.appendChild(renderPriorityCard(it, true));
    }
    // Hot-list items are shown by their JOB quadrant (not the action quadrant),
    // so Schedule/Watch jobs aren't hidden just because their actions read as
    // low-urgency. Non-hot-list items keep the action-quadrant focus scope.
    const hotlistAll = items.filter((i) => i.parentJob && !trackedIds.has(i.recordId));
    const restPool = items.filter((i) => !i.parentJob && inScope(i) && !trackedIds.has(i.recordId));
    const pool = items.filter((i) => inScope(i) && !trackedIds.has(i.recordId)); // flat fallback only

    // WP-Rollup P1/P2 — roll up by section → job → action (hot-list) + entity
    // groups (rest). Falls back to a flat list when rollup is off / no keys.
    const canGroup = ROLLUP_ENABLED && (hotlistAll.length > 0 || restPool.some((i) => i.primaryEntity));
    if (canGroup) {
      // A job-quadrant filter narrows to jobs of that quadrant (and hides the
      // non-hot-list entity groups, which aren't job-classified).
      const hotlist = activeFilter ? hotlistAll.filter((i) => i.jobQuadrant === activeFilter) : hotlistAll;
      const rest = activeFilter ? [] : restPool;
      let rendered = 0;

      if (hotlist.length) {
        // WP-Rollup job-first — group by JOB across the whole corpus so a job
        // mentioned in two emails is ONE row with all its actions (the chip
        // count then equals the row count). Section travels as a per-action
        // provenance tag, not a splitting band.
        const jobs = new Map();
        for (const it of hotlist) {
          if (!jobs.has(it.parentJob)) jobs.set(it.parentJob, { header: it.jobHeader, items: [] });
          const j = jobs.get(it.parentJob);
          j.items.push(it);
          if (!j.header && it.jobHeader) j.header = it.jobHeader;
        }
        const jobOrdered = [...jobs.entries()].sort((a, b) => {
          const qa = jobRank[a[1].items[0]?.jobQuadrant] ?? 2, qb = jobRank[b[1].items[0]?.jobQuadrant] ?? 2;
          const pa = a[1].items[0]?.jobPriority ?? 0, pb = b[1].items[0]?.jobPriority ?? 0;
          return qa - qb || pb - pa || b[1].items.length - a[1].items.length;
        });
        for (const [pj, j] of jobOrdered) { cardArea.appendChild(renderJobGroup(pj, j.header, j.items)); rendered++; }
      }

      // Non-hot-list remainder → P1 entity groups, capped.
      const groups = new Map();
      for (const it of rest) {
        const key = it.primaryEntity || "__ungrouped__";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      const ordered = [...groups.entries()].sort((a, b) => {
        const aUng = a[0] === "__ungrouped__", bUng = b[0] === "__ungrouped__";
        if (aUng !== bUng) return aUng ? 1 : -1;
        const ra = Math.min(...a[1].map((i) => quadrantRank(i.quadrant)));
        const rb = Math.min(...b[1].map((i) => quadrantRank(i.quadrant)));
        return ra - rb || b[1].length - a[1].length || a[0].localeCompare(b[0]);
      });
      const cap = FOCUS_GROUP_CAP;          // entity groups capped independently of job rows
      const shownGroups = ordered.slice(0, cap);
      for (const [entity, gItems] of shownGroups) cardArea.appendChild(renderEntityGroup(entity, gItems));
      if (ordered.length > shownGroups.length) {
        const more = document.createElement("div");
        more.className = "priority-more";
        more.textContent = `+ ${ordered.length - shownGroups.length} more`;
        cardArea.appendChild(more);
      }
      if (!trk.length && !rendered && !shownGroups.length) {
        const empty = document.createElement("div");
        empty.className = "priority-more";
        empty.textContent = "Nothing here right now.";
        cardArea.appendChild(empty);
      }
      return;
    }

    const shown = pool.slice(0, FOCUS_CAP);
    for (const it of shown) cardArea.appendChild(renderPriorityCard(it, false));
    if (pool.length > shown.length) {
      const more = document.createElement("div");
      more.className = "priority-more";
      more.textContent = `+ ${pool.length - shown.length} more`;
      cardArea.appendChild(more);
    }
    if (!trk.length && !shown.length) {
      const empty = document.createElement("div");
      empty.className = "priority-more";
      empty.textContent = "Nothing here right now.";
      cardArea.appendChild(empty);
    }
  };

  // WP-Rollup job-priority — chips are JOB quadrants (one tally per job, not per
  // action), so Do-now / Schedule / Delegate / Watch populate at the job altitude
  // the user thinks in. Computed from the visible hot-list jobs; falls back to
  // the action counts when no job-grain data is present.
  const jobQC = {};
  {
    const seen = new Set();
    for (const i of items) {
      if (!i.parentJob || trackedIds.has(i.recordId)) continue;
      if (seen.has(i.parentJob)) continue;
      seen.add(i.parentJob);
      const q = i.jobQuadrant || "delegate";
      jobQC[q] = (jobQC[q] || 0) + 1;
    }
  }
  const haveJobChips = Object.keys(jobQC).length > 0;
  const chipQuadrants = haveJobChips ? ["do-now", "schedule", "delegate", "watch"] : ["do-now", "schedule", "delegate"];
  for (const q of chipQuadrants) {
    const n = haveJobChips ? (jobQC[q] || 0) : (counts[q] || 0);
    if (!n) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.q = q;
    chip.className = "priority-chip priority-chip-" + q + (q === "do-now" ? " priority-chip-now" : "");
    chip.textContent = `${QUADRANT_LABEL[q]} · ${n}`;
    chip.addEventListener("click", () => {
      activeFilter = activeFilter === q ? null : q;
      for (const c of chips.children) {
        c.classList.toggle("priority-chip-active", c.dataset.q === activeFilter);
      }
      renderCards();
    });
    chips.appendChild(chip);
  }

  renderCards();
  container.appendChild(focus.section);

  // ── Watch: the watch quadrant, its own collapsed section (usually large). ──
  const watchAll = items.filter((i) => i.quadrant === "watch" && !trackedIds.has(i.recordId));
  if (watchAll.length) {
    const watch = makeCollapsible("Watch", counts["watch"] || watchAll.length, false);
    for (const it of watchAll.slice(0, WATCH_CAP)) watch.body.appendChild(renderPriorityCard(it, false));
    if (watchAll.length > WATCH_CAP) {
      const more = document.createElement("div");
      more.className = "priority-more";
      more.textContent = `+ ${watchAll.length - WATCH_CAP} more in Watch`;
      watch.body.appendChild(more);
    }
    container.appendChild(watch.section);
  }
}

function renderPriorityCard(item, isTracked) {
  const card = document.createElement("div");
  card.className = "priority-card" + (isTracked ? " priority-card-tracked" : "");

  const top = document.createElement("div");
  top.className = "priority-card-top";
  const quad = document.createElement("span");
  quad.className = "priority-quad-tag" + (item.quadrant === "do-now" ? " priority-quad-now" : "");
  quad.textContent = QUADRANT_LABEL[item.quadrant] || item.quadrant;
  top.appendChild(quad);
  const rel = document.createElement("span");
  rel.className = "priority-rel";
  const relWord = item.relationship === "client" ? "Client"
    : item.relationship === "partner" ? "Partner" : "Internal";
  rel.textContent = item.seniorityTier ? `${relWord} · ${item.seniorityTier}` : relWord;
  top.appendChild(rel);
  card.appendChild(top);

  const summary = document.createElement("div");
  summary.className = "priority-item";
  summary.textContent = item.summary || "(item)";
  card.appendChild(summary);

  // Business-language why — the packet interpretation, never raw slugs/scores.
  const whyText = [item.why, item.relationshipWhy].filter(Boolean).join(" ");
  if (whyText) {
    const why = document.createElement("div");
    why.className = "priority-why";
    why.textContent = whyText;
    card.appendChild(why);
  }

  const actions = document.createElement("div");
  actions.className = "priority-actions";

  // Default actions: Track (pin) · Snooze (schedule for later) · Hand off
  // (delegate) · Dismiss (opens the reason chooser).
  const buildDefaultActions = () => {
    actions.innerHTML = "";
    actions.classList.remove("priority-actions-col");
    const track = document.createElement("button");
    track.type = "button";
    track.className = "priority-track";
    track.textContent = isTracked ? "Tracking" : "Track";
    track.disabled = isTracked;
    track.addEventListener("click", async () => {
      track.disabled = true;
      const ok = await sendPriorityGesture(item, "pin");
      if (ok) track.textContent = "Tracking";
      else track.disabled = false;
    });
    actions.appendChild(track);

    // Snooze (snooze gesture) — schedule the item for later: opens the date chooser.
    const snooze = document.createElement("button");
    snooze.type = "button";
    snooze.className = "priority-reason";
    snooze.textContent = "Snooze";
    snooze.addEventListener("click", buildSnoozeChooser);
    actions.appendChild(snooze);

    // Delegate (handoff gesture) — opens the inline editor (draft the note, edit it, then copy).
    const handoff = document.createElement("button");
    handoff.type = "button";
    handoff.className = "priority-reason";
    handoff.textContent = "Delegate";
    handoff.addEventListener("click", buildHandoffEditor);
    actions.appendChild(handoff);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "priority-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", buildReasonChooser);
    actions.appendChild(dismiss);
  };

  // Snooze chooser — presets + a custom date input. Sends a snooze gesture with
  // the resurface date; the card leaves Focus until then.
  const buildSnoozeChooser = () => {
    actions.innerHTML = "";
    const q = document.createElement("span");
    q.className = "priority-dismiss-q";
    q.textContent = "Until?";
    actions.appendChild(q);
    const doSnooze = async (iso) => {
      for (const c of actions.querySelectorAll("button, input")) c.disabled = true;
      const ok = await sendPriorityGesture(item, "snooze", null, iso);
      if (ok) { showToast({ kind: "success", title: "Snoozed", body: `Back in Focus on ${iso}.` }); card.remove(); }
      else buildDefaultActions();
    };
    for (const p of SNOOZE_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "priority-reason";
      b.textContent = p.label;
      b.addEventListener("click", () => doSnooze(isoDatePlusDays(p.days)));
      actions.appendChild(b);
    }
    const picker = document.createElement("input");
    picker.type = "date";
    picker.className = "priority-date";
    picker.min = isoDatePlusDays(1);
    picker.addEventListener("change", () => { if (picker.value) doSnooze(picker.value); });
    actions.appendChild(picker);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "priority-dismiss";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", buildDefaultActions);
    actions.appendChild(cancel);
  };

  // "Why?" — one extra tap that captures the dismiss REASON (the class decides
  // calibration direction). Without it a dismiss is ambiguous and can't be routed.
  const buildReasonChooser = () => {
    actions.innerHTML = "";
    const q = document.createElement("span");
    q.className = "priority-dismiss-q";
    q.textContent = "Why?";
    actions.appendChild(q);
    for (const r of PRIORITY_DISMISS_REASONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "priority-reason";
      b.textContent = r.label;
      b.addEventListener("click", async () => {
        for (const c of actions.querySelectorAll("button")) c.disabled = true;
        const ok = await sendPriorityGesture(item, "dismiss", r.reason);
        if (ok) card.remove();
        else buildDefaultActions();
      });
      actions.appendChild(b);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "priority-dismiss";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", buildDefaultActions);
    actions.appendChild(cancel);
  };

  // Hand-off editor — pre-fills the drafted note, lets the user edit it inline,
  // THEN copies the edited text + records the handoff (the card leaves Focus).
  const buildHandoffEditor = () => {
    actions.innerHTML = "";
    actions.classList.add("priority-actions-col");
    const ta = document.createElement("textarea");
    ta.className = "priority-handoff-edit";
    ta.rows = 3;
    ta.value = buildHandoffNote(item);
    actions.appendChild(ta);

    const row = document.createElement("div");
    row.className = "priority-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "priority-track";
    copyBtn.textContent = "Copy & delegate";
    copyBtn.addEventListener("click", async () => {
      copyBtn.disabled = true;
      try { await tauri.core.invoke("copy_text", { text: ta.value }); }
      catch (e) { /* clipboard best-effort */ }
      // Capture the EDITED text (incl. any delegatee name the user typed in) verbatim.
      const ok = await sendPriorityGesture(item, "handoff", null, null, ta.value);
      if (ok) { showToast({ kind: "success", title: "Copied to delegate", body: "Paste into email or chat." }); card.remove(); }
      else copyBtn.disabled = false;
    });
    row.appendChild(copyBtn);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "priority-dismiss";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", buildDefaultActions);
    row.appendChild(cancel);
    actions.appendChild(row);

    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };

  buildDefaultActions();
  card.appendChild(actions);
  return card;
}

// "Links" — jump from Today to the cross-record edge graph (Connections view).
// WP-R0 — retired: hide the button and skip wiring when edges is gated off,
// so there's no dead click path left on the Today header.
const logEdgesBtn = document.getElementById("btn-log-edges");
if (logEdgesBtn) {
  if (!isDestVisible("edges")) {
    logEdgesBtn.setAttribute("hidden", "");
  } else {
    logEdgesBtn.addEventListener("click", () => {
      enterEdgesView();
    });
  }
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
    // Your week honours the Mine/Everyone filter.
    loadTodayComingUp().catch((e) => console.warn("[main] Your week (filter):", e));
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
    // Sentence-case ("High"/"Medium"), not raw caps — display formatting only.
    sev.textContent = edge.severity.charAt(0).toUpperCase() + edge.severity.slice(1);
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
  chip.textContent = recordTypeLabel(rec);
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

// Connections-view buttons: refresh, and the view-main entry.
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

// WP-R0 — retired: hide the button and skip wiring when edges is gated off,
// so there's no dead click path left on the Home header.
const openEdgesBtn = document.getElementById("btn-open-edges");
if (openEdgesBtn) {
  if (!isDestVisible("edges")) {
    openEdgesBtn.setAttribute("hidden", "");
  } else {
    openEdgesBtn.addEventListener("click", () => {
      enterEdgesView();
    });
  }
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

  // WP-Grouping-Operator P4 — a job's Definition reuses the operator's name as
  // the title (one naming path) instead of the raw entity slug ("us-non-16619"
  // → "Merck Vaccines Landing Page Updates"). Non-job entities keep their slug.
  if (titleEl && data && data.jobName) titleEl.textContent = data.jobName;

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

// ───────── Decisions browser — by project, status-filterable (WP-THRESHOLD-DECISION-ORG) ─────────

// Records + the documentId→projects map for the current browse, kept so the
// status filter re-renders without re-fetching.
let _decisionsCtx = null;
let _decisionsFilter = "all"; // all | open | resolved | superseded
let _decisionsLens = "project"; // project | deadline | people
let _decisionsExpanded = new Set(); // group keys the user has expanded (default: collapsed)
// WP-Work-Forest — frame/workstream SECTION collapse (distinct from per-job group
// expand above). Keyed by name (fids aren't stable across recompiles): "top:<name>"
// collapses a whole project incl. its sub-frames; "ws:<top>|<name>" collapses one
// sub-category. Empty = everything expanded (the prior behaviour).
let _framesCollapsed = new Set();
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
/* ───── WP-Threshold-Grouping-Canonicalization — Combine UI ─────
 * Hangs off the project-lens group headers in the Decisions view. Calls the
 * project_canon_* Tauri commands; on success re-enters enterDecisionsView so
 * the backend-canonicalized /api/data re-renders the merged groups. Product
 * language only (no "canonical/alias/substrate" leakage). */

function pgOverlay() {
  const o = document.createElement("div");
  o.className = "pg-overlay";
  o.addEventListener("click", (e) => { if (e.target === o) pgClose(o); });
  return o;
}
function pgClose(o) { if (o && o.parentNode) o.parentNode.removeChild(o); }

// Per-view snapshot of which project groups are user-merged — drives the Split
// affordance + supplies the unmerge restore set. Refreshed on each Decisions enter.
let _pgCanonState = { mergedByKey: new Map() };
async function refreshProjectCanonState() {
  const m = new Map();
  try {
    const pc = await tauri.core.invoke("fetch_project_canon");
    if (pc && pc.available !== false && Array.isArray(pc.canonicals)) {
      for (const c of pc.canonicals) {
        const restore = (c.aliases || []).filter((a) => a !== c.label);
        if (restore.length) m.set(c.label, { canonicalId: c.canonicalId, restore });
      }
    }
  } catch (err) {
    console.warn("[main] fetch_project_canon (state) failed:", err);
  }
  _pgCanonState = { mergedByKey: m };
}

/** The stale-guard the mutations must echo. null when grouping is unavailable. */
async function projectCanonFingerprint() {
  try {
    const res = await tauri.core.invoke("fetch_project_canon");
    if (!res || res.available === false) return null;
    return typeof res.substrateFingerprint === "string" ? res.substrateFingerprint : null;
  } catch (err) {
    console.warn("[main] fetch_project_canon failed:", err);
    return null;
  }
}

/** "Combine with…" affordance for a project-lens group header. */
function buildProjectGroupActions(grp, allGroups) {
  const wrap = document.createElement("div");
  wrap.className = "pg-actions";
  const mkBtn = (label, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pg-action-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  wrap.appendChild(mkBtn("Combine with…", `Combine “${grp.label}” into another project`, () => openCombinePane(grp, allGroups)));
  wrap.appendChild(mkBtn("Rename", `Rename “${grp.label}”`, () => openRenameDialog(grp)));
  // Split-back appears only on groups the user previously combined.
  const merged = _pgCanonState.mergedByKey.get(grp.key);
  if (merged) {
    wrap.appendChild(mkBtn("Split", `Separate “${grp.label}” back into its original projects`, () => confirmSplit(grp, merged)));
  }
  return wrap;
}

function projectGroupOthers(grp, allGroups) {
  return allGroups.filter((g) => g.key !== grp.key && !g.muted && g.key !== PROJECT_OTHER);
}

/** Pane listing the other projects to combine the source group into. */
function openCombinePane(grp, allGroups) {
  const others = projectGroupOthers(grp, allGroups);
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane";

  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = `Combine “${grp.label}” with…`;
  pane.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "pg-pane-sub";
  sub.textContent = "Pick the project it should join. They'll show as one group everywhere.";
  pane.appendChild(sub);

  const list = document.createElement("div");
  list.className = "pg-pane-list";
  if (!others.length) {
    const empty = document.createElement("div");
    empty.className = "pg-pane-empty";
    empty.textContent = "No other projects to combine with yet.";
    list.appendChild(empty);
  }
  for (const o of others) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pg-pane-row";
    const nm = document.createElement("span");
    nm.className = "pg-pane-row-name";
    nm.textContent = o.label;
    const ct = document.createElement("span");
    ct.className = "pg-pane-row-count";
    ct.textContent = `${o.items.length}`;
    row.appendChild(nm);
    row.appendChild(ct);
    row.addEventListener("click", () => { pgClose(overlay); confirmCombine(grp, o, {}); });
    list.appendChild(row);
  }
  pane.appendChild(list);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost pg-pane-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  pane.appendChild(cancel);

  overlay.appendChild(pane);
  document.body.appendChild(overlay);
}

/** §7a confirm-with-explainer. opts.contested → "combine anyway?" + override. */
function confirmCombine(sourceGrp, targetGrp, opts) {
  const contested = !!(opts && opts.contested);
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";

  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = contested ? "These look like separate efforts" : "Combine these projects?";
  pane.appendChild(title);

  const body = document.createElement("div");
  body.className = "pg-confirm-body";
  body.textContent = contested
    ? `“${sourceGrp.label}” and “${targetGrp.label}” come up together a lot, which usually means related but separate efforts. Combine anyway?`
    : `Documents in “${sourceGrp.label}” and “${targetGrp.label}” will show as one project — “${targetGrp.label}” — everywhere. Nothing is deleted; you can split them back anytime.`;
  pane.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = contested ? "Keep separate" : "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = contested ? "Combine anyway" : "Combine";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Combining…";
    await runCombine(sourceGrp, targetGrp, contested, overlay);
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);

  overlay.appendChild(pane);
  document.body.appendChild(overlay);
}

async function runCombine(sourceGrp, targetGrp, override, overlay) {
  const fp = await projectCanonFingerprint();
  if (!fp) { pgClose(overlay); showToast({ kind: "failure", title: "Project grouping isn't available on this server." }); return; }
  let actor = "threshold-user";
  try { actor = (await getViewerEmail()) || actor; } catch (_e) { /* keep default */ }
  let res;
  try {
    res = await tauri.core.invoke("project_canon_merge", {
      // Backend requires >=2 slugs in `sources` — ALL the projects being unified.
      // targetCanonical is which name survives.
      // P4 (c) — a job chip's key is "job:<slug>"; project_canon operates on the
      // project slug, so strip the prefix. No-op for plain project chips.
      sources: [sourceGrp.key, targetGrp.key].map((k) => k.replace(/^job:/, "")),
      targetCanonical: targetGrp.key.replace(/^job:/, ""),
      expectedSubstrateFingerprint: fp,
      actor,
      overrideVeto: override,
    });
  } catch (err) {
    console.warn("[main] project_canon_merge failed:", err);
    pgClose(overlay);
    showToast({ kind: "idempotent", title: "Groupings changed since you opened this — refreshing." });
    enterDecisionsView();
    return;
  }
  if (res && res.disposition === "contested" && !override) {
    pgClose(overlay);
    confirmCombine(sourceGrp, targetGrp, { contested: true });
    return;
  }
  pgClose(overlay);
  showToast({ kind: "success", title: `Combined into “${targetGrp.label}”.` });
  enterDecisionsView();
}

/** Rename a project group — relabels the canonical; documents & grouping unchanged. */
function openRenameDialog(grp) {
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";

  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = "Rename project";
  pane.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "pg-pane-sub";
  sub.textContent = "Just a label change — the documents and grouping don't move.";
  pane.appendChild(sub);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "pg-input";
  input.value = grp.label;
  input.setAttribute("aria-label", "New project name");
  pane.appendChild(input);

  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "pg-btn pg-btn-primary";
  save.textContent = "Rename";
  save.addEventListener("click", async () => {
    const newLabel = input.value.trim();
    if (!newLabel || newLabel === grp.label) { pgClose(overlay); return; }
    save.disabled = true;
    save.textContent = "Renaming…";
    await runRename(grp, newLabel, overlay);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); });
  actions.appendChild(cancel);
  actions.appendChild(save);
  pane.appendChild(actions);

  overlay.appendChild(pane);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 0);
}

async function runRename(grp, newLabel, overlay) {
  const fp = await projectCanonFingerprint();
  if (!fp) { pgClose(overlay); showToast({ kind: "failure", title: "Project grouping isn't available on this server." }); return; }
  let actor = "threshold-user";
  try { actor = (await getViewerEmail()) || actor; } catch (_e) { /* keep default */ }
  try {
    await tauri.core.invoke("project_canon_rename", {
      canonicalId: grp.key.replace(/^job:/, ""), // P4 (c) job:<slug> → project slug; backend mints if fresh
      newLabel,
      expectedSubstrateFingerprint: fp,
      actor,
    });
  } catch (err) {
    console.warn("[main] project_canon_rename failed:", err);
    pgClose(overlay);
    showToast({ kind: "idempotent", title: "Groupings changed since you opened this — refreshing." });
    enterDecisionsView();
    return;
  }
  pgClose(overlay);
  showToast({ kind: "success", title: `Renamed to “${newLabel}”.` });
  enterDecisionsView();
}

/** Split-back — reverse a prior Combine, restoring the merged-in projects. */
function confirmSplit(grp, merged) {
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";

  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = "Split this project apart?";
  pane.appendChild(title);

  const body = document.createElement("div");
  body.className = "pg-confirm-body";
  const names = merged.restore.map((s) => `“${prettySlug(s)}”`).join(", ");
  body.textContent = `“${grp.label}” will separate back into ${names}. Those documents return to their original tags.`;
  pane.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = "Split";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Splitting…";
    await runSplit(grp, merged, overlay);
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);

  overlay.appendChild(pane);
  document.body.appendChild(overlay);
}

async function runSplit(grp, merged, overlay) {
  const fp = await projectCanonFingerprint();
  if (!fp) { pgClose(overlay); showToast({ kind: "failure", title: "Project grouping isn't available on this server." }); return; }
  let actor = "threshold-user";
  try { actor = (await getViewerEmail()) || actor; } catch (_e) { /* keep default */ }
  try {
    await tauri.core.invoke("project_canon_unmerge", {
      canonicalId: merged.canonicalId,
      restore: merged.restore,
      expectedSubstrateFingerprint: fp,
      actor,
    });
  } catch (err) {
    console.warn("[main] project_canon_unmerge failed:", err);
    pgClose(overlay);
    showToast({ kind: "idempotent", title: "Groupings changed since you opened this — refreshing." });
    enterDecisionsView();
    return;
  }
  pgClose(overlay);
  showToast({ kind: "success", title: `Split “${grp.label}” apart.` });
  enterDecisionsView();
}

function groupRecords(items, lens, docProjects, aliases, jobNames, recordJobs) {
  const g = new Map();
  // Resolve a slug to its canonical form so duplicate subjects collapse into one
  // group (sora → project-sora). Identity when no alias is known.
  const canon = (s) => (aliases && aliases[s]) || s;
  // WP-Grouping-Operator P4 — label a project group with its canonical P2 job
  // name when one exists ("us-non-16619" → "Merck Vaccines Landing Page
  // Updates"), so By-project reads consistently with Focus/Receipts. Falls back
  // to the prettified slug.
  const projLabel = (key) => (jobNames && jobNames[key]) || prettySlug(key);
  const jobLabel = (jk) =>
    (jobNames && (jobNames[jk] || jobNames[jk.replace(/^job:/, "")])) ||
    prettySlug(jk.replace(/^job:/, ""));
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
      // (c) — a hot-list record (carries a canonical job) groups by its JOB chip,
      // so US-NON-16619 reads as its own group matching Today. Broad-corpus records
      // (no job) keep their document-project grouping, untouched. Bounded re-point
      // of the ~53 hot-list records; the ~226 broad-corpus records don't move.
      const jobKey = recordJobs && recordJobs[rec.recordId];
      if (jobKey) {
        ensure(jobKey, jobLabel(jobKey), 0, false).items.push(it);
      } else {
        const projs = docProjects.get(rec.documentId) || [];
        const key = projs.length ? canon(projs[0]) : PROJECT_OTHER;
        ensure(key, key === PROJECT_OTHER ? "Other" : projLabel(key), key === PROJECT_OTHER ? 9 : 0, key === PROJECT_OTHER).items.push(it);
      }
    }
  }
  return [...g.values()].sort((a, b) => {
    if (lens === "deadline") return a.order - b.order;
    if (a.order !== b.order) return a.order - b.order; // catch-all last
    return b.items.length - a.items.length; // else largest first
  });
}

// WP-Work-Forest top altitude — reorder + annotate project-lens groups under
// their CoordinationFrameCompiler top frame (state Project/Suggested/Facet/
// Needs-evidence) and workstream. Returns the reordered groups; each group is
// tagged with `_frameHeader` (the top frame, on the first group of that frame)
// and `_wsHeader` (workstream name, on the first group of that workstream).
// Groups whose job isn't in any frame fall to a trailing "Unframed" bucket.
const FRAME_STATE_ORDER = { Project: 0, Suggested: 1, Facet: 2, "Needs-evidence": 3 };
// Attention rank — surfaces the jobs that need action to the top of each
// section: deadline urgency (overdue > due-soon > future) dominates, then open
// items, then size. Works across all jobs (hot-list + prose), unlike the
// parentJob-scoped Eisenhower priority operator.
function groupAttention(grp) {
  let urg = 0, open = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const it of grp.items) {
    const r = it.record || it;
    if ((it.state || "open") === "open") open++;
    if (r && r.due) {
      const days = (new Date(r.due + "T00:00:00") - today) / 86400000;
      const u = days < 0 ? 3 : days <= 7 ? 2 : 1;
      if (u > urg) urg = u;
    }
  }
  return urg * 1000 + open * 20 + grp.items.length;
}
// Per-group rank — the real PRIORITY heat when the job is "scored", else the
// attention fallback. Tiers are kept separated by band so a scored job never
// loses to a fallback job (scored ∈ [0.40,1.0], fallback ∈ [0.10,0.40), quiet
// ∈ [0,0.10)); within a tier, order by heat/attention.
function rankGroups(ordered, jobHeat) {
  const maxAtt = Math.max(1, ...ordered.map((g) => groupAttention(g)));
  for (const grp of ordered) {
    const jh = jobHeat && jobHeat[grp.key];
    const attN = groupAttention(grp) / maxAtt;
    if (jh) {
      grp._rank = 0.40 + 0.60 * jh.heat; grp._tier = "scored"; grp._band = jh.band; grp._why = jh.why;
    } else if (groupAttention(grp) > 2) {
      grp._rank = 0.10 + 0.30 * attN; grp._tier = "fallback";
    } else {
      grp._rank = 0.10 * attN; grp._tier = "quiet";
    }
  }
}
function applyFrameLayout(ordered, frames, jobHeat) {
  if (!frames || !frames.length) return ordered;
  rankGroups(ordered, jobHeat);
  const byFid = new Map(frames.map((f) => [f.fid, f]));
  const topOf = (f) => { let c = f, n = 0; while (c && c.parentFid != null && n++ < 50) c = byFid.get(c.parentFid) || null; return c || f; };
  const homeOf = new Map();
  for (const f of frames) {
    const top = topOf(f);
    const ws = f.parentFid != null ? f : null;
    const wsName = ws ? ws.name : null;
    for (const jk of f.jobKeys || []) homeOf.set(jk, { top, wsName, ws });
  }
  const topOrder = (f) => (FRAME_STATE_ORDER[f.state] ?? 4) * 1000 - (f.maturity || 0) * 100;
  for (const grp of ordered) {
    const h = homeOf.get(grp.key);
    grp._top = h ? h.top : null;
    grp._wsName = h ? h.wsName : null;
    grp._ws = h ? h.ws : null;
  }
  // Build the list explicitly: frames in state/maturity order; within a frame the
  // DIRECT jobs first (attention desc), then each workstream (ranked by its total
  // attention), jobs inside by attention desc. Unframed groups trail at the end.
  const topFrames = [...new Set(ordered.map((g) => g._top).filter(Boolean))].sort((a, b) => topOrder(a) - topOrder(b) || a.fid - b.fid);
  const out = [];
  for (const top of topFrames) {
    const mine = ordered.filter((g) => g._top === top);
    // Frame HEAT — roll job heat up (max+topK+share), an axis ORTHOGONAL to the
    // frame's maturity (how-urgent vs how-sure). Rendered as its own chip.
    const heats = mine.map((g) => (jobHeat && jobHeat[g.key] ? jobHeat[g.key].heat : 0)).sort((a, b) => b - a);
    const fhTopK = heats.slice(0, 3);
    const fh = 0.55 * (heats[0] || 0) + 0.30 * (fhTopK.reduce((s, x) => s + x, 0) / Math.max(1, fhTopK.length))
      + 0.15 * (heats.length ? heats.filter((h) => h >= 0.5).length / heats.length : 0);
    top._heat = fh;
    top._heatBand = fh >= 0.65 ? "fire" : fh >= 0.4 ? "active" : "quiet";
    const direct = mine.filter((g) => !g._wsName).sort((a, b) => b._rank - a._rank);
    const wsNames = [...new Set(mine.filter((g) => g._wsName).map((g) => g._wsName))];
    const wsBuckets = wsNames.map((name) => {
      const groups = mine.filter((g) => g._wsName === name).sort((a, b) => b._rank - a._rank);
      return { name, ws: groups[0] ? groups[0]._ws : null, groups, total: groups.reduce((s, g) => s + g._rank, 0) };
    }).sort((a, b) => b.total - a.total);
    let first = true;
    for (const g of direct) { g._frameHeader = first ? top : null; g._wsHeader = null; first = false; out.push(g); }
    for (const bucket of wsBuckets) {
      let wsFirst = true;
      for (const g of bucket.groups) { g._frameHeader = first ? top : null; first = false; g._wsHeader = wsFirst ? (bucket.ws || bucket.name) : null; wsFirst = false; out.push(g); }
    }
    // a frame with only workstream jobs still needs its header on the first row
    if (first && mine.length) mine[0]._frameHeader = top;
  }
  const unframed = ordered.filter((g) => !g._top).sort((a, b) => b._rank - a._rank);
  unframed.forEach((g, i) => { g._frameHeader = i === 0 ? { __unframed: true } : null; g._wsHeader = null; out.push(g); });
  return out;
}

const FRAME_BADGE = {
  Project: { label: "Project", cls: "frame-badge-project" },
  Suggested: { label: "Suggested area", cls: "frame-badge-suggested" },
  Facet: { label: "Topic / area", cls: "frame-badge-facet" },
  "Needs-evidence": { label: "Needs evidence", cls: "frame-badge-needs" },
};
// Shared on-demand "State of play" affordance for a grouping header (top frame or
// workstream — the level ABOVE individual jobs, which is where a digest belongs).
// Returns { toggle, panel }; the caller places the toggle inline and the full-width
// panel last. Nothing fetches until the user clicks. The empty state stays visible
// (the trigger never silently vanishes).
function makeSoPToggle(fid, titleText) {
  const toggle = document.createElement("span");
  toggle.className = "sop-frame-toggle";
  toggle.setAttribute("role", "button");
  toggle.tabIndex = 0;
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = titleText || "State of play for this area";
  toggle.textContent = "State of play";
  const panel = document.createElement("div");
  panel.className = "sop-frame-panel";
  panel.hidden = true;
  let loaded = false;
  const doToggle = async () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    if (open) { toggle.setAttribute("aria-expanded", "false"); panel.hidden = true; return; }
    toggle.setAttribute("aria-expanded", "true"); panel.hidden = false;
    if (loaded) return;            // already rendered (or shown empty) — just reveal
    loaded = true;
    const ok = await renderFrameSoP(panel, fid);
    if (!ok) panel.innerHTML = '<div class="sop-status">No state of play to show for this area right now.</div>';
  };
  toggle.addEventListener("click", (ev) => { ev.stopPropagation(); doToggle(); });
  toggle.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); doToggle(); } });
  return { toggle, panel };
}
function buildFrameHeader(frame) {
  const el = document.createElement("div");
  el.className = "frame-header";
  if (frame.__unframed) {
    el.classList.add("frame-header-unframed");
    const n = document.createElement("span"); n.className = "frame-header-name"; n.textContent = "Unframed";
    el.appendChild(n);
    return el;
  }
  const badge = FRAME_BADGE[frame.state] || FRAME_BADGE.Suggested;
  const b = document.createElement("span"); b.className = "frame-badge " + badge.cls; b.textContent = badge.label;
  const n = document.createElement("span"); n.className = "frame-header-name"; n.textContent = frame.name;
  // MVP-Librarian 2.1 — direct rename entry point on the name itself (the ⋯ glyph
  // alone was undiscoverable live). Double-click opens the edit menu focused on
  // the rename field, ready to type.
  n.title = "Double-click to rename";
  n.addEventListener("dblclick", (ev) => { ev.stopPropagation(); openFrameEditMenu(n, frame, { focusRename: true }); });
  el.appendChild(b); el.appendChild(n);
  // Heat chip — the orthogonal axis. "On fire" / "Active" carry an accent; "quiet"
  // is omitted so a calm project doesn't shout.
  if (frame._heatBand && frame._heatBand !== "quiet") {
    const heat = document.createElement("span");
    heat.className = "frame-heat frame-heat-" + frame._heatBand;
    heat.textContent = frame._heatBand === "fire" ? "On fire" : "Active";
    el.appendChild(heat);
  }
  if (frame.state !== "Project") el.classList.add("frame-header-soft");
  // UI-3 — Frame SoP affordance. Maturity-gated to Project/Suggested frames (the
  // ones mature enough to digest). Built below; the trigger sits inline in the
  // header row, the panel is a full-width child that stacks beneath when expanded.
  // UI-3 — Frame SoP affordance (on-demand, maturity-gated to Project/Suggested top
  // frames). Trigger sits inline; the panel stacks full-width below (appended last).
  let sopPanel = null;
  if (frameSoPEligible(frame) && frame.fid != null) {
    const sop = makeSoPToggle(frame.fid, "State of play for this frame");
    el.appendChild(sop.toggle);
    sopPanel = sop.panel;
  }
  // WP-THRESHOLD-NAV Increment 2 — "Open →" into this frame's Project home. A top
  // frame IS the project in a framed corpus, so the aggregate landing page is
  // reachable straight from its header (as well as from each job group below).
  // enterProjectHomeView aggregates every job under this top frame by name.
  if (frame.fid != null && frame.name) {
    const home = document.createElement("span");
    home.className = "frame-open-home-btn";
    home.textContent = "Open →";
    home.setAttribute("role", "button");
    home.tabIndex = 0;
    home.title = "Open the project home — everything about " + frame.name;
    const goHomeFrame = (ev) => { ev.stopPropagation(); enterProjectHomeView("frame:" + frame.name, { label: frame.name, lens: "project", top: frame }); };
    home.addEventListener("click", goHomeFrame);
    home.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") goHomeFrame(ev); });
    el.appendChild(home);
  }
  // WP-Frame-HITL — the frame gesture menu (rename / mark-type / merge).
  const edit = document.createElement("span");
  edit.className = "frame-edit-btn";
  edit.textContent = "⋯";
  edit.setAttribute("role", "button");
  edit.tabIndex = 0;
  edit.title = "Rename, change type, or merge";
  edit.addEventListener("click", (ev) => { ev.stopPropagation(); openFrameEditMenu(edit, frame); });
  el.appendChild(edit);
  // Full-width inline SoP panel stacks last, beneath the header row (flex-basis:100%).
  if (sopPanel) el.appendChild(sopPanel);
  return el;
}
// Workstream header (the level ABOVE jobs, BELOW the top frame) — the consolidated
// altitude a state-of-play digest is actually for. Gets the SAME on-demand toggle
// as a top frame. `ws` is the workstream frame object (carries fid + name); a bare
// string is tolerated for back-compat (renders the name with no toggle).
function buildWsHeader(ws) {
  const el = document.createElement("div");
  el.className = "frame-ws-header";
  const name = ws && typeof ws === "object" ? ws.name : ws;
  const n = document.createElement("span");
  n.className = "frame-ws-name";
  n.textContent = name || "";
  el.appendChild(n);
  // MVP-Librarian 2.1 — the gesture menu (and so rename) must exist for EVERY
  // rendered frame. The bare-string back-compat path used to drop the ⋯ entirely;
  // resolve the frame object from the live context so even that path keeps its
  // rename / re-home / merge affordance. The SoP toggle alone stays fid-gated.
  const frameObj = ws && typeof ws === "object"
    ? ws
    : (name ? (((_decisionsCtx && _decisionsCtx.frames) || []).find((f) => f && f.name === name) || { name }) : null);
  if (frameObj) {
    n.title = "Double-click to rename";
    n.addEventListener("dblclick", (ev) => { ev.stopPropagation(); openFrameEditMenu(n, frameObj, { focusRename: true }); });
  }
  const fid = frameObj && frameObj.fid != null ? frameObj.fid : null;
  let sopPanel = null;
  if (fid != null) {
    const sop = makeSoPToggle(fid, "State of play for this area");
    el.appendChild(sop.toggle);
    sopPanel = sop.panel;
  }
  if (frameObj) {
    // WP-Frame-HITL — sub-frames get the SAME gesture menu as top frames (Issue 4).
    // Without it a nested area had no rename / merge / re-home affordance, so
    // redundant sub-frames couldn't be combined. Appended after the SoP panel so the
    // full-width panel still stacks last.
    const edit = document.createElement("span");
    edit.className = "frame-edit-btn";
    edit.textContent = "⋯";
    edit.setAttribute("role", "button");
    edit.tabIndex = 0;
    edit.title = "Rename, re-home, or merge";
    edit.addEventListener("click", (ev) => { ev.stopPropagation(); openFrameEditMenu(edit, frameObj); });
    el.appendChild(edit);
  }
  if (sopPanel) el.appendChild(sopPanel);
  return el;
}
// Prepend a collapse chevron to a frame/workstream section header. `key` is the
// collapse key in _framesCollapsed; toggling it re-applies visibility over the flat
// row list WITHOUT a full re-render (mirrors the per-job group chevron). Collapse is
// remembered by name, so it survives the re-render every frame edit triggers.
function makeSectionCollapsible(headerEl, key, listEl) {
  const chev = document.createElement("span");
  chev.className = "frame-collapse-chev";
  chev.setAttribute("aria-hidden", "true");
  chev.textContent = _framesCollapsed.has(key) ? "▸" : "▾";
  headerEl.insertBefore(chev, headerEl.firstChild);
  // The WHOLE header is the collapse target (matches the per-job group headers, and
  // gives a big obvious hit area). Clicks on the header's own controls — State of
  // play, the ⋯ menu and its popovers/panel — are excluded so they still work.
  headerEl.classList.add("frame-section-collapsible");
  headerEl.setAttribute("role", "button");
  headerEl.tabIndex = 0;
  headerEl.setAttribute("aria-expanded", _framesCollapsed.has(key) ? "false" : "true");
  const toggle = () => {
    if (_framesCollapsed.has(key)) _framesCollapsed.delete(key); else _framesCollapsed.add(key);
    applyFrameCollapse(listEl);
  };
  headerEl.addEventListener("click", (ev) => {
    if (ev.target.closest(".sop-frame-toggle, .sop-frame-panel, .frame-edit-btn, .frame-move-menu")) return;
    toggle();
  });
  headerEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === headerEl) { e.preventDefault(); toggle(); }
  });
}
// Apply the current collapse state across the flat list: a collapsed top frame hides
// its sub-frame headers and all its rows (header stays); a collapsed sub-frame hides
// only its own rows (its header stays). Also refreshes each header's chevron glyph.
function applyFrameCollapse(listEl) {
  for (const el of Array.from(listEl.children)) {
    const fn = el.dataset ? el.dataset.frameName : undefined;
    const wn = el.dataset ? el.dataset.wsName : undefined;
    const kind = el.dataset ? el.dataset.sectionHeader : undefined;
    const topCollapsed = fn ? _framesCollapsed.has("top:" + fn) : false;
    const wsCollapsed = fn && wn ? _framesCollapsed.has("ws:" + fn + "|" + wn) : false;
    if (kind === "top" || kind === "ws") {
      const self = kind === "top" ? topCollapsed : wsCollapsed;
      const c = el.querySelector(".frame-collapse-chev");
      if (c) c.textContent = self ? "▸" : "▾";
      el.setAttribute("aria-expanded", self ? "false" : "true");
      el.classList.toggle("frame-section-collapsed", !!self);
    }
    if (kind === "top") { el.hidden = false; continue; }      // a top-frame header is always visible
    if (kind === "ws") { el.hidden = topCollapsed; continue; } // sub-frame header hides only if its project is collapsed
    if (fn) el.hidden = topCollapsed || wsCollapsed;           // a job-group row
  }
}
function buildFacetBar(facets) {
  if (!facets || !facets.length) return null;
  const bar = document.createElement("div");
  bar.className = "frame-facet-bar";
  const lbl = document.createElement("span"); lbl.className = "frame-facet-label"; lbl.textContent = "Also tagged";
  bar.appendChild(lbl);
  for (const fc of facets) {
    const chip = document.createElement("span");
    chip.className = "frame-facet-chip";
    chip.textContent = `${fc.name} · ${fc.jobKeys.length}`;
    bar.appendChild(chip);
  }
  return bar;
}

// WP-Frame-HITL — append one org-edit, then reload so the correction shows (it is
// reapplied over the generated frames on read, so it sticks across regeneration).
async function frameEdit(edit) {
  try {
    await tauri.core.invoke("frame_edit", { edit });
    await enterDecisionsView();
    // Phase 0 — structural-edit learning. A successful merge or reparent teaches the
    // engine a containment/placement prior; confirm it as LEARNING (not just "done")
    // so the felt outcome matches what the backend recorded. Understated, no CTA.
    if (edit && edit.eventType === "reparent") {
      const parent = (edit.newParentFrameName || "").trim();
      if (parent) {
        showToast({ kind: "success", title: "Learned", body: `I'll keep new items grouped under ${parent}.` });
      } else {
        showToast({ kind: "success", title: "Learned", body: "Promoted to its own top-level category." });
      }
    } else if (edit && edit.eventType === "merge") {
      showToast({ kind: "success", title: "Combined", body: "I'll treat these as one going forward." });
    } else if (edit && edit.eventType === "rename" && edit.newFrameName) {
      // MVP-Librarian 2.1 — visible confirmation. The silent rename was half the
      // bug; the felt outcome must match the recorded event.
      showToast({ kind: "success", title: "Renamed", body: `“${edit.oldFrameName}” is now “${edit.newFrameName}”.` });
    }
    // WP-Frame-HITL "adapts" tier — felt learning. After a MOVE, ask the learner
    // whether the same explicit feature explains other jobs, and surface a visible
    // "move them too?" offer. The user still confirms; nothing auto-moves.
    if (edit && edit.eventType === "move" && edit.jobKey && edit.toFrameName) {
      maybeOfferApplyToSimilar(edit.jobKey, edit.toFrameName);
    }
  } catch (e) {
    console.warn("[main] frame_edit failed:", e);
  }
}

// MVP-Librarian 2.2/2.3 — batch org-edit emitter. POSTs each edit sequentially
// (order matters: a create_frame must land before the moves into it), then reloads
// the view ONCE. Individual events, individually reversible — never a compound
// event. Returns the count that failed so callers can toast honestly (e.g. the
// move_record gesture 400s until its backend companion lands).
async function frameEditBatch(edits) {
  let failed = 0;
  for (const edit of edits) {
    try {
      await tauri.core.invoke("frame_edit", { edit });
    } catch (e) {
      failed++;
      console.warn("[main] frame_edit (batch) failed:", e);
    }
  }
  await enterDecisionsView();
  return failed;
}

// After a move, fetch the apply-to-similar offer and (if anything generalizes)
// toast it. Failure-safe: any error degrades to silence — the move still stuck.
async function maybeOfferApplyToSimilar(jobKey, toFrameName) {
  try {
    const res = await tauri.core.invoke("apply_to_similar", { action: "offer", body: { jobKey, toFrameName } });
    const offer = res && res.offer;
    if (!offer || !offer.candidates || !offer.candidates.length) return;
    const n = offer.candidates.length;
    showToast({
      kind: "success",
      sticky: true,
      title: "Pattern noticed",
      body: `${n} other ${n === 1 ? "job" : "jobs"} ${offer.predicateLabel}. Move ${n === 1 ? "it" : "them"} too?`,
      cta: { label: "Review similar", onClick: () => openLearnedReview(offer, toFrameName) },
    });
  } catch (e) {
    console.warn("[main] apply_to_similar offer failed:", e);
  }
}

// The apply-to-similar review: the candidate jobs (all pre-selected), a plain
// "why", and the three honest choices — move the selected, decline the rest (which
// become counterexamples), or stop learning this pattern entirely (suppress).
function openLearnedReview(offer, toFrameName) {
  document.querySelectorAll(".learned-review").forEach((m) => m.remove());
  const modal = document.createElement("div");
  modal.className = "frame-move-menu learned-review";

  const header = document.createElement("div");
  header.className = "frame-move-header";
  const title = document.createElement("div");
  title.className = "frame-move-title";
  title.textContent = `Move similar to ${toFrameName}?`;
  header.appendChild(title);
  const why = document.createElement("div");
  why.className = "learned-review-why";
  why.textContent = offer.predicateLabel;
  header.appendChild(why);
  modal.appendChild(header);

  const list = document.createElement("div");
  list.className = "frame-move-list";
  const checks = new Map();
  for (const c of offer.candidates) {
    const wrap = document.createElement("div");
    wrap.className = "learned-review-cand";

    const row = document.createElement("div");
    row.className = "learned-review-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    checks.set(c.jobKey, cb);
    const name = document.createElement("span");
    name.className = "learned-review-name";
    name.textContent = c.jobName || c.jobKey;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "learned-review-inspect";
    toggle.textContent = "Details";

    // inspect panel — current location + the records this job contains
    const detail = document.createElement("div");
    detail.className = "learned-review-detail";
    detail.style.display = "none";
    const loc = document.createElement("div");
    loc.className = "learned-review-loc";
    loc.textContent = c.currentFrame ? `Currently in: ${c.currentFrame}` : "Not yet filed";
    detail.appendChild(loc);
    if (Array.isArray(c.records) && c.records.length) {
      const ul = document.createElement("ul");
      ul.className = "learned-review-records";
      for (const r of c.records) {
        const li = document.createElement("li");
        li.textContent = `${r.type === "commitment" ? "commitment" : "decision"}: ${r.summary}`;
        ul.appendChild(li);
      }
      if (c.recordCount > c.records.length) {
        const more = document.createElement("li");
        more.className = "learned-review-more";
        more.textContent = `…and ${c.recordCount - c.records.length} more`;
        ul.appendChild(more);
      }
      detail.appendChild(ul);
    } else {
      const none = document.createElement("div");
      none.className = "learned-review-loc";
      none.textContent = "No records on this job.";
      detail.appendChild(none);
    }

    const toggleFn = (ev) => {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      const open = detail.style.display !== "none";
      detail.style.display = open ? "none" : "block";
      toggle.textContent = open ? "Details" : "Hide";
    };
    toggle.addEventListener("click", toggleFn);
    name.addEventListener("click", toggleFn);   // click the name to inspect (NOT toggle the checkbox)

    row.appendChild(cb);
    row.appendChild(name);
    row.appendChild(toggle);
    wrap.appendChild(row);
    wrap.appendChild(detail);
    list.appendChild(wrap);
  }
  modal.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "learned-review-footer";
  const moveBtn = document.createElement("button");
  moveBtn.type = "button";
  moveBtn.className = "learned-review-primary";
  moveBtn.textContent = "Move selected";
  moveBtn.addEventListener("click", async () => {
    const selected = [], rejected = [];
    for (const [k, cb] of checks) (cb.checked ? selected : rejected).push(k);
    modal.remove();
    try {
      const r = await tauri.core.invoke("apply_to_similar", {
        action: "resolve",
        body: { selectedJobKeys: selected, rejectedJobKeys: rejected, toFrameName, predicate: offer.predicate },
      });
      await enterDecisionsView();
      const applied = (r && r.applied) || selected.length;
      showToast({
        kind: "success",
        title: `Applied to ${applied} ${applied === 1 ? "job" : "jobs"}`,
        body: `Learned for your view: ${offer.predicateLabel} → ${toFrameName}. I'll suggest this next time.`,
      });
    } catch (e) {
      console.warn("[main] apply_to_similar resolve failed:", e);
    }
  });
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "learned-review-ghost";
  stopBtn.textContent = "Don't learn this";
  stopBtn.addEventListener("click", async () => {
    modal.remove();
    try {
      await tauri.core.invoke("apply_to_similar", { action: "reject", body: { predicate: offer.predicate, suppressRule: true } });
      await enterDecisionsView();
      showToast({ kind: "idempotent", title: "Won't suggest that", body: `Stopped learning: ${offer.predicateLabel}.` });
    } catch (e) {
      console.warn("[main] apply_to_similar suppress failed:", e);
    }
  });
  footer.appendChild(moveBtn);
  footer.appendChild(stopBtn);
  modal.appendChild(footer);

  document.body.appendChild(modal);
  // centre it
  modal.style.left = `${Math.max(8, (window.innerWidth - modal.offsetWidth) / 2)}px`;
  modal.style.top = `${Math.max(8, (window.innerHeight - modal.offsetHeight) / 2)}px`;
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (!modal.contains(ev.target)) { modal.remove(); document.removeEventListener("click", close); }
    });
  }, 0);
}

// Stage 3 — ambient learned suggestions. Fetched per Log render; keyed by jobKey
// so the row renderer can show "Suggested: X · Move / Not this" inline. Failure or
// none → empty map (byte-equal to no-suggestion render).
let _learnedSuggestions = new Map();
async function refreshLearnedSuggestions() {
  try {
    const res = await tauri.core.invoke("fetch_learned_suggestions");
    const m = new Map();
    for (const s of (res && res.suggestions) || []) m.set(s.jobKey, s);
    _learnedSuggestions = m;
  } catch (e) {
    _learnedSuggestions = new Map();
  }
}

// Phase 0 — structural-edit learning. Containment signals the engine picked up from
// merge/reparent gestures (child frame ⊂ parent). Keyed by lowercased child-frame
// name so buildFrameHeader can match the proper-cased rendered name against it.
// Failure-safe: any error degrades to no chips (the frames still render).
let _containmentSignals = new Map();
async function refreshContainmentSignals() {
  try {
    const res = await tauri.core.invoke("fetch_learning_state");
    const m = new Map();
    for (const s of (res && res.containmentSignals) || []) {
      if (s && typeof s.frame === "string") m.set(s.frame.toLowerCase(), s);
    }
    _containmentSignals = m;
  } catch (e) {
    _containmentSignals = new Map();
  }
}

// WP-Rule-Cards — "Patterns I've noticed". The LLM rule-development engine's output:
// `developed` = cited rules (predicate + per-job "why"), `disjunctionSuggestions` =
// "these two groups look like one category — combine?" proposals (always suggest-only).
// Fetched once per Log render, in lockstep with the decision-log data. Failure or an
// empty corpus (settled data → no fresh patterns) degrades to an empty state that the
// renderer omits entirely — no broken shell. State is held so renderDecisions can draw
// the surface at the top of the project lens without re-fetching.
let _developedRules = [];
let _disjunctionSuggestions = [];
async function refreshDevelopedRules() {
  try {
    const res = await tauri.core.invoke("develop_rules");
    _developedRules = Array.isArray(res && res.developed) ? res.developed : [];
    _disjunctionSuggestions = Array.isArray(res && res.disjunctionSuggestions)
      ? res.disjunctionSuggestions : [];
  } catch (e) {
    console.warn("[main] develop_rules failed:", e);
    _developedRules = [];
    _disjunctionSuggestions = [];
  }
}

// ───────── MVP-Librarian Phase 3 — the Question Engine card ─────────────────
//
// "One good question": the server surfaces at most ONE judged question at a time
// (fact-keyed suppression means an answered/dismissed question NEVER returns, so
// this state is never a cache — every Log entry re-fetches). `fetch_question`
// without pull reports the currently-surfaced question if any; the pull gesture
// ("Anything you need from me?") asks the server to surface the top-ranked one.
// A 503 (ENABLE_QUESTION_ENGINE off) arrives as `{disabled:true}` and hides the
// whole surface silently — no affordance, no card, no error.
let _questionCard = null;        // the ONE surfaced question payload, or null
let _questionEngineOff = false;  // server flag off → omit the surface entirely
async function refreshQuestionCard() {
  try {
    const res = await tauri.core.invoke("fetch_question", { pull: false });
    _questionEngineOff = !!(res && res.disabled);
    _questionCard = !_questionEngineOff && res && res.question ? res.question : null;
  } catch (e) {
    console.warn("[main] fetch_question failed:", e);
    _questionEngineOff = true;   // fail-safe: hide the surface, never a broken shell
    _questionCard = null;
  }
}

// The question surface for the project lens: the card when one is surfaced,
// otherwise the understated pull affordance. Null when the engine is off.
function buildQuestionSection() {
  if (_questionEngineOff) return null;
  if (_questionCard) {
    const section = document.createElement("section");
    section.className = "question-section";
    section.appendChild(buildQuestionCard(_questionCard));
    return section;
  }
  const row = document.createElement("div");
  row.className = "question-pull-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "question-pull-btn";
  btn.textContent = "Anything you need from me?";
  const note = document.createElement("span");
  note.className = "question-pull-note";
  btn.addEventListener("click", () => pullQuestion(btn, note));
  row.appendChild(btn);
  row.appendChild(note);
  return row;
}

// Pull mode: surface the top judged question on demand. Zero interruption cost —
// flag-off, empty queue, and failure all degrade to a quiet "Nothing right now."
async function pullQuestion(btn, noteEl) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const res = await tauri.core.invoke("fetch_question", { pull: true });
    if (res && !res.disabled && res.question) {
      _questionCard = res.question;
      // Redraw the surface that hosts this affordance — the card replaces it.
      // On Today (WP-R2) the pull lives in #today-question-slot; on Decisions it
      // lives in the decisions render. Detect by the button's DOM ancestry so the
      // right surface repaints (and the queue count re-reconciles on Today).
      if (btn.closest && btn.closest("#today-question-slot")) {
        const slot = document.getElementById("today-question-slot");
        const section = buildQuestionSection();
        if (slot) { slot.innerHTML = ""; if (section) slot.appendChild(section); }
        const countEl = document.getElementById("today-queue-count");
        if (countEl) {
          const list = document.getElementById("today-queue-list");
          const qCards = document.querySelectorAll("#today-question-slot .rule-card").length;
          const n = (list ? list.children.length : 0) + qCards;
          countEl.textContent = n > 0 ? String(n) : "";
        }
      } else {
        renderDecisions();        // Decisions view — the card replaces the affordance
      }
      return;
    }
  } catch (e) {
    console.warn("[main] fetch_question (pull) failed:", e);
  }
  btn.disabled = false;
  btn.textContent = original;
  if (noteEl) noteEl.textContent = "Nothing right now.";
}

// The authored hot-list source, when the card carries one AND we have the doc in
// hand (invisible-by-absence otherwise). Returns { docId, items:[{text,jobKey}] }
// with each item's text normalized to a non-empty string, or null.
function questionSource(card) {
  const src = card && card.source;
  const docId = src && typeof src.docId === "string" ? src.docId : "";
  if (!docId) return null;
  // Only drop the row when the docs map is LOADED and the doc is definitively
  // absent. A not-yet-loaded map must not hide the row (fresh-launch race:
  // Today can render the card before fetch_documents resolves); the source
  // panel resolves the doc itself on open and fails visibly if truly missing.
  if (_docsById && !_docsById.get(docId)) return null;
  const rawItems = Array.isArray(src.items) ? src.items : [];
  const items = rawItems
    .map((it) => {
      if (!it) return null;
      const text = typeof it === "string" ? it : (typeof it.text === "string" ? it.text : "");
      const t = text.trim();
      if (!t) return null;
      const jobKey = it && typeof it.jobKey === "string" ? it.jobKey : "";
      return { text: t, jobKey };
    })
    .filter(Boolean);
  return { docId, docTitle: src.docTitle, items };
}

// Extract a CODE-like structured identifier (e.g. "US-NON-19757") from a string,
// for the highlight fallback when an item's LLM prose isn't an exact substring of
// the source. Matches an uppercase/alnum token with at least one hyphen and a
// digit run (so it catches job codes, not ordinary ALL-CAPS words). Null if none.
function extractCodeToken(text) {
  const m = String(text || "").match(/\b[A-Z0-9]+(?:-[A-Z0-9]+)+\b/);
  if (!m) return null;
  return /\d/.test(m[0]) && /-/.test(m[0]) ? m[0] : null;
}

// The set of best-effort highlight strings for one source item: its authored text
// first, then its structured code token (if any) as a fallback anchor. Both are
// passed to the highlighter, which places whichever it can find (substring match)
// and silently skips the rest.
function itemHighlightStrings(item) {
  const out = [];
  if (item && item.text) out.push(item.text);
  const code = extractCodeToken(item && item.text);
  if (code) out.push(code);
  return out;
}

// One surfaced question → a card in the rule-card visual language. Shows the
// judged phrasing, the "why" receipt, BOTH futures from the simulation
// (Yes → … / No → …), and Yes / No / Not now.
function buildQuestionCard(card) {
  const el = document.createElement("div");
  el.className = "rule-card question-card";

  const top = document.createElement("div");
  top.className = "rule-card-top";
  const stmt = document.createElement("div");
  stmt.className = "rule-card-statement";
  stmt.textContent = card.question || "";
  top.appendChild(stmt);
  const tag = document.createElement("span");
  tag.className = "rule-auth question-tag";
  tag.textContent = "Question";
  top.appendChild(tag);
  el.appendChild(top);

  if (card.why) {
    const why = document.createElement("div");
    why.className = "question-why";
    why.textContent = "Why I'm asking: " + card.why;
    el.appendChild(why);
  }

  // The authored hot-list source, when present + resolvable. A clickable badge
  // (reusing the source-badge chrome) opens the authored document in the source
  // pane, highlighting EVERY authored item at once. Invisible-by-absence when the
  // card carries no source, or its doc isn't in _docsById.
  const qsrc = questionSource(card);
  if (qsrc) {
    const doc = _docsById ? _docsById.get(qsrc.docId) : null;
    const label = qsrc.docTitle || (doc ? sourceFromDoc(doc).label : "your notes");
    const allTexts = qsrc.items.flatMap(itemHighlightStrings);
    // The authored hot-list source, via the ONE receipt component's authored-
    // source jump variant: opens the authored doc highlighting every item at once.
    const row = document.createElement("div");
    row.className = "question-source-row";
    row.appendChild(
      renderReceipt(
        {},
        {
          variant: "receipt-question",
          authoredSource: {
            docId: qsrc.docId,
            primaryText: allTexts[0],
            extraTexts: allTexts.slice(1),
            label: "View in your notes",
            detail: qsrc.docTitle || "",
            iconKey: doc ? sourceFromDoc(doc).iconKey : "doc",
          },
        },
      ),
    );
    el.appendChild(row);
  }

  // Both futures — the consequence previews the simulator computed. The answer
  // path replays the SAME events, so what the card promises is what happens.
  const futures = document.createElement("div");
  futures.className = "question-futures";
  for (const [verb, preview] of [["Yes", card.yesPreview], ["No", card.noPreview]]) {
    if (!preview) continue;
    // The verb is rendered as its own styled chip below, so strip any leading
    // "Yes →" / "No →" the payload already carries — otherwise it reads "Yes → Yes → …".
    const body = String(preview).replace(/^\s*(?:yes|no)\s*(?:→|->)\s*/i, "");
    const f = document.createElement("div");
    f.className = "question-future";
    const v = document.createElement("span");
    v.className = "question-future-verb";
    v.textContent = verb + " →";
    f.appendChild(v);
    f.appendChild(document.createTextNode(" " + body));
    futures.appendChild(f);
  }
  if (futures.childNodes.length) el.appendChild(futures);

  // The affected items — Trisha's #1 ask ("I need to see the jobs" before
  // answering). Prefer the payload's `members` [{jobKey, jobName}]; fall back to
  // the older `draft` [{jobKey, jobName, toFrameName}]; omit entirely if neither.
  // UAT (Ross 2026-07-02): each row now INSPECTS (inline record content) and
  // CURATES (a checkbox; Yes acts on the checked subset). The disclosure exposes
  // `_getSelectedJobKeys()` / `_allSelected()` and drives the Yes enabled state
  // through the `onSelectionChange` callback wired below (after `yes` exists).
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "rule-card-primary";
  yes.textContent = "Yes";

  // Sync the Yes button to the current selection: disable (with a hint) when the
  // set is empty — can't confirm nothing. Left enabled when there's no curatable
  // disclosure at all (nothing to gate on).
  const syncYes = (selectedCount, totalCount) => {
    const empty = totalCount > 0 && selectedCount === 0;
    yes.disabled = empty;
    if (empty) {
      yes.title = "Select at least one item.";
      yes.setAttribute("aria-disabled", "true");
    } else {
      yes.removeAttribute("title");
      yes.removeAttribute("aria-disabled");
    }
  };

  const disclosure = buildQuestionMembers(card, syncYes, qsrc);
  if (disclosure) el.appendChild(disclosure);

  // Yes acts on the curated subset. When the disclosure supports curation, pass
  // the checked jobKeys; when everything is selected (the default) send the full
  // list — the backend treats absent/all-selected as today's full action, so the
  // UI is correct today and becomes subset-capable the moment the backend lands.
  yes.addEventListener("click", () => {
    const selected = disclosure && typeof disclosure._getSelectedJobKeys === "function"
      ? disclosure._getSelectedJobKeys()
      : null;
    answerQuestion(card, true, el, selected);
  });

  const actions = document.createElement("div");
  actions.className = "rule-card-actions";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "question-no-btn";
  no.textContent = "No";
  no.addEventListener("click", () => answerQuestion(card, false, el));
  const later = document.createElement("button");
  later.type = "button";
  later.className = "rule-card-ghost";
  later.textContent = "Snooze";
  later.addEventListener("click", () => snoozeQuestion(card, el));
  actions.appendChild(yes);
  actions.appendChild(no);
  actions.appendChild(later);
  el.appendChild(actions);
  return el;
}

// The expandable "which items this touches" disclosure — collapsed by default so
// the card stays scannable, one click to reveal the affected work. Reads
// `members` [{jobKey, jobName}] first, then falls back to `draft`
// [{jobKey, jobName, toFrameName}]. Returns null when there's nothing to show
// (no empty shell). `membersTruncated` (a count) appends a "+K more" row.
//
// UAT (Ross 2026-07-02) — each row now supports:
//   INSPECT: a "view" toggle expands the job's records INLINE (Trisha prefers
//     embedded, no navigating away), reusing renderLinkedRecord over the records
//     already in _decisionsCtx (recordJobs[recordId] === jobKey). No fetch.
//   CURATE: a checkbox (default checked). A live "N of M selected" header count.
//     The wrap exposes `_getSelectedJobKeys()` / `_allSelected()`; `onSyncYes`
//     (a callback into the Yes button) fires on every toggle so an empty set
//     disables Yes. The "+K more" truncated rows aren't curatable (no jobKey),
//     so they're excluded from M and always ride along with the full action.
function buildQuestionMembers(card, onSyncYes, qsrc) {
  const raw = Array.isArray(card.members) && card.members.length ? card.members
    : (Array.isArray(card.draft) ? card.draft : []);
  // Index the resolved source items by jobKey so a member row can jump to THAT
  // item's authored line in the source pane (additive to inspect + curate).
  const srcItemByJobKey = new Map();
  if (qsrc && Array.isArray(qsrc.items)) {
    for (const it of qsrc.items) if (it.jobKey) srcItemByJobKey.set(it.jobKey, it);
  }
  // Resolve {name, jobKey} for each item: prefer the payload's own name, then a
  // jobKey label, then the key itself — never render a bare object. Keep the
  // jobKey so curation + inspect can key off it (string members carry the key).
  const members = raw
    .map((m) => {
      if (!m) return null;
      if (typeof m === "string") return { name: jobKeyLabel(m), jobKey: m };
      const jobKey = typeof m.jobKey === "string" ? m.jobKey : "";
      const name = (m.jobName || m.name || (jobKey ? jobKeyLabel(jobKey) : "")).trim();
      return name ? { name, jobKey } : null;
    })
    .filter(Boolean);
  if (!members.length) return null;

  const extra = Number.isFinite(card.membersTruncated) && card.membersTruncated > 0
    ? Math.floor(card.membersTruncated) : 0;
  // Curatable count M = the named rows we can key by jobKey (truncated +K rows
  // have no key and stay out of the curation math). Display total includes extra.
  const curatable = members.filter((m) => m.jobKey);
  const total = members.length + extra;

  const wrap = document.createElement("div");
  wrap.className = "question-members";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "question-members-toggle";
  toggle.setAttribute("aria-expanded", "false");
  const noun = total === 1 ? "item" : "items";
  // The header carries the "N of M selected" count once opened; collapsed it just
  // invites the reveal. `count` is a dedicated span so we can update it live.
  toggle.innerHTML =
    `<span class="question-members-chevron" aria-hidden="true">▸</span>` +
    `<span class="question-members-label">Show the ${total} ${noun}</span>` +
    `<span class="question-members-count" aria-hidden="true"></span>`;
  wrap.appendChild(toggle);

  const list = document.createElement("ul");
  list.className = "question-members-list";
  list.style.display = "none";

  // checkbox registry: jobKey → checkbox. Only curatable rows enroll.
  const boxes = new Map();
  const getSelectedJobKeys = () =>
    curatable.filter((m) => { const cb = boxes.get(m.jobKey); return cb && cb.checked; })
      .map((m) => m.jobKey);
  const allSelected = () => getSelectedJobKeys().length === curatable.length;

  const updateCount = () => {
    const sel = getSelectedJobKeys().length;
    const m = curatable.length;
    const countEl = toggle.querySelector(".question-members-count");
    if (countEl) countEl.textContent = m > 0 ? `${sel} of ${m} selected` : "";
    if (typeof onSyncYes === "function") onSyncYes(sel, m);
  };

  for (const member of members) {
    const li = document.createElement("li");
    li.className = "question-members-item";

    const row = document.createElement("div");
    row.className = "question-member-row";

    // CURATE — the checkbox (default checked), styling matched to the Log's
    // .job-select-box. Only curatable rows (with a jobKey) get one.
    if (member.jobKey) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "job-select-box question-member-check";
      cb.checked = true;
      cb.setAttribute("aria-label", `Include ${member.name}`);
      cb.addEventListener("change", updateCount);
      boxes.set(member.jobKey, cb);
      row.appendChild(cb);
    }

    const name = document.createElement("span");
    name.className = "question-member-name";
    name.textContent = member.name;
    row.appendChild(name);

    // INSPECT — a "view" toggle that inline-expands the job's records. Only rows
    // with a jobKey can be inspected (need the key to find their records).
    let detail = null;
    if (member.jobKey) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "question-member-view";
      view.setAttribute("aria-expanded", "false");
      view.innerHTML =
        `<span class="question-member-view-chevron" aria-hidden="true">▸</span>` +
        `<span>View</span>`;
      row.appendChild(view);

      detail = document.createElement("div");
      detail.className = "question-member-detail";
      detail.style.display = "none";
      // lazy-populate on first open (records are in memory; no fetch either way).
      let built = false;
      view.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const showing = detail.style.display !== "none";
        detail.style.display = showing ? "none" : "block";
        view.setAttribute("aria-expanded", showing ? "false" : "true");
        const chev = view.querySelector(".question-member-view-chevron");
        if (chev) chev.textContent = showing ? "▸" : "▾";
        if (!built && !showing) {
          built = true;
          buildMemberContent(detail, member.jobKey);
        }
      });
    }

    // IN NOTES — when this member's job maps to an authored source item, a small
    // icon opens the source pane highlighted to THAT item's line (its code token
    // as fallback anchor). Additive: inspect (records) + curate (checkbox) stay.
    const srcItem = member.jobKey ? srcItemByJobKey.get(member.jobKey) : null;
    if (srcItem && qsrc) {
      const inNotes = document.createElement("button");
      inNotes.type = "button";
      inNotes.className = "question-member-in-notes";
      inNotes.setAttribute("aria-label", `See ${member.name} in your notes`);
      inNotes.title = "See this in your notes";
      inNotes.innerHTML =
        `<span class="source-badge-icon" aria-hidden="true">${SOURCE_ICONS.doc}</span>` +
        `<span>In notes</span>`;
      const strings = itemHighlightStrings(srcItem);
      inNotes.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openSourcePanel(qsrc.docId, strings[0], strings.slice(1), { authoredOnly: true });
      });
      row.appendChild(inNotes);
    }

    li.appendChild(row);
    if (detail) li.appendChild(detail);
    list.appendChild(li);
  }
  if (extra > 0) {
    const li = document.createElement("li");
    li.className = "question-members-more";
    li.textContent = `+${extra} more`;
    list.appendChild(li);
  }
  wrap.appendChild(list);

  let open = false;
  toggle.addEventListener("click", () => {
    open = !open;
    list.style.display = open ? "block" : "none";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    const chev = toggle.querySelector(".question-members-chevron");
    if (chev) chev.textContent = open ? "▾" : "▸";
    const label = toggle.querySelector(".question-members-label");
    if (label) label.textContent = (open ? "Hide the " : "Show the ") + `${total} ${noun}`;
  });

  // Expose the selection API + prime the header/Yes state once at build.
  wrap._getSelectedJobKeys = getSelectedJobKeys;
  wrap._allSelected = allSelected;
  updateCount();
  return wrap;
}

// INSPECT helper — fill `container` with a job's record content, reusing the
// compact renderLinkedRecord over the records already loaded in _decisionsCtx.
// A job's records = the loaded records whose recordJobs[recordId] === jobKey.
// Graceful empty state when nothing is loaded for the job.
function buildMemberContent(container, jobKey) {
  const ctx = _decisionsCtx || {};
  const recordJobs = ctx.recordJobs || {};
  const byId = ctx.byId; // Map recordId → record
  const recs = [];
  if (byId && typeof byId.get === "function") {
    for (const recId of Object.keys(recordJobs)) {
      if (recordJobs[recId] === jobKey) {
        const rec = byId.get(recId);
        if (rec) recs.push(rec);
      }
    }
  }
  if (!recs.length) {
    const none = document.createElement("div");
    none.className = "question-member-empty";
    none.textContent = "No content loaded for this item.";
    container.appendChild(none);
    return;
  }
  for (const rec of recs) container.appendChild(renderLinkedRecord(rec));
}

// Answer: the server folds the confirm_fact (+ the previewed bulk events) and
// marks the question answered — terminal. Re-enter the view so the fold's
// effects (and the next question state) come from the server, never a cache.
async function answerQuestion(card, answer, cardEl, selectedJobKeys) {
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    // UAT-curate — forward the curated subset for a "Yes" only. The Tauri command
    // includes selectedJobKeys in the POST body only when present; an absent (or
    // all-selected) set is the full action — today's backend behavior. Omit it
    // for No, and when curation isn't in play (null/undefined), so the wire shape
    // is unchanged until a real subset is chosen.
    const args = { factKey: card.factKey, answer };
    if (answer && Array.isArray(selectedJobKeys)) args.selectedJobKeys = selectedJobKeys;
    const r = await tauri.core.invoke("answer_question", args);
    _questionCard = null;
    const applied = r && typeof r.appended === "number" ? r.appended : 0;
    showToast({
      kind: "success",
      title: answer ? "Got it — yes" : "Got it — no",
      body: applied > 1
        ? `Recorded, and applied ${applied} changes it unlocked.`
        : "Recorded — I'll organize with that in mind.",
    });
    await enterDecisionsView();
  } catch (e) {
    console.warn("[main] answer_question failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
    showToast({ kind: "failure", title: "Couldn't record that", body: "Try again in a moment." });
  }
}

// "Not now": a SNOOZE, not a permanent block (Trisha: "if you say not now,
// shouldn't it ask again later?"). The server records a snooze so the question
// comes back later instead of being suppressed forever. Same re-enter discipline
// as answer.
async function snoozeQuestion(card, cardEl) {
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    await tauri.core.invoke("snooze_question", { factKey: card.factKey });
    _questionCard = null;
    showToast({ kind: "idempotent", title: "Snoozed", body: "Okay — I'll bring this back later." });
    await enterDecisionsView();
  } catch (e) {
    console.warn("[main] snooze_question failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
    showToast({ kind: "failure", title: "Couldn't set that aside", body: "Try again in a moment." });
  }
}

// Permanent fact-keyed suppression server-side — the question never re-surfaces.
// Retained for a future explicit "Don't ask again" affordance; "Not now" now
// snoozes (see snoozeQuestion) rather than dismisses. Same re-enter discipline.
async function dismissQuestion(card, cardEl) {
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    await tauri.core.invoke("dismiss_question", { factKey: card.factKey });
    _questionCard = null;
    showToast({ kind: "idempotent", title: "Got it", body: "I won't ask that again." });
    await enterDecisionsView();
  } catch (e) {
    console.warn("[main] dismiss_question failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
    showToast({ kind: "failure", title: "Couldn't dismiss", body: "Try again in a moment." });
  }
}

// The authority tag on a rule's `effect`. A soft prior can auto-apply (it only nudges
// ranking); a viewer overlay is a placement the engine will suggest but not enact.
function ruleAuthorityLabel(effect) {
  if (effect === "soft_prior") return { text: "Can auto-apply", cls: "rule-auth-auto" };
  return { text: "Suggesting", cls: "rule-auth-suggest" };
}

// Build the "Patterns I've noticed" surface: a collapsible section holding one card per
// developed rule + one "combine these?" card per disjunction suggestion. Returns null
// when there is nothing to show (so the caller omits it entirely — no empty shell).
function buildPatternsSection() {
  const rules = _developedRules || [];
  const disj = _disjunctionSuggestions || [];
  if (!rules.length && !disj.length) return null;

  const section = document.createElement("section");
  section.className = "patterns-section";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "patterns-header";
  const total = rules.length + disj.length;
  const expanded = _patternsExpanded;
  header.setAttribute("aria-expanded", expanded ? "true" : "false");
  header.innerHTML =
    `<span class="patterns-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>` +
    `<span class="patterns-title">Patterns I've noticed</span>` +
    `<span class="patterns-count">${total}</span>`;
  section.appendChild(header);

  const body = document.createElement("div");
  body.className = "patterns-body";
  body.style.display = expanded ? "block" : "none";
  for (const rule of rules) body.appendChild(buildRuleCard(rule));
  for (const s of disj) body.appendChild(buildDisjunctionCard(s));
  section.appendChild(body);

  header.addEventListener("click", () => {
    _patternsExpanded = !_patternsExpanded;
    body.style.display = _patternsExpanded ? "block" : "none";
    header.setAttribute("aria-expanded", _patternsExpanded ? "true" : "false");
    const chev = header.querySelector(".patterns-chevron");
    if (chev) chev.textContent = _patternsExpanded ? "▾" : "▸";
  });
  return section;
}
let _patternsExpanded = true;

// One developed rule → a card. Shows the rule statement, an authority tag, the member
// jobs each with their cited "why", a compact evidence line, and Endorse / Dismiss.
function buildRuleCard(rule) {
  const card = document.createElement("div");
  card.className = "rule-card";

  const top = document.createElement("div");
  top.className = "rule-card-top";
  const stmt = document.createElement("div");
  stmt.className = "rule-card-statement";
  stmt.textContent = rule.predicateLabel || "Unlabeled pattern";
  top.appendChild(stmt);
  const auth = ruleAuthorityLabel(rule.cappedEffect || rule.developedEffect || rule.effect);
  const tag = document.createElement("span");
  tag.className = "rule-auth " + auth.cls;
  tag.textContent = auth.text;
  top.appendChild(tag);
  card.appendChild(top);

  const preferred = (rule.preferredFrame || "").trim();
  if (preferred) {
    const sub = document.createElement("div");
    sub.className = "rule-card-sub";
    sub.textContent = "Groups under: " + preferred;
    card.appendChild(sub);
  }

  // Member jobs, each with the cited "why". Live endpoint keys: `verified` (the
  // re-grounded member jobKeys) + `citations` ({jobKey → {feature,value}}).
  const cites = rule.citations && typeof rule.citations === "object" ? rule.citations : {};
  const members = Array.isArray(rule.verified) ? rule.verified
    : (Array.isArray(rule.members) ? rule.members : Object.keys(cites));
  if (members.length) {
    const ul = document.createElement("ul");
    ul.className = "rule-card-members";
    for (const m of members) {
      const li = document.createElement("li");
      li.className = "rule-card-member";
      const name = document.createElement("span");
      name.className = "rule-card-member-name";
      name.textContent = jobKeyLabel(m);
      li.appendChild(name);
      const why = citeText(cites[m]);
      if (why) {
        const w = document.createElement("span");
        w.className = "rule-card-member-why";
        w.textContent = why;
        li.appendChild(w);
      }
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  // Compact evidence line — the cited artifacts, i.e. "why this reads as one group".
  const evidence = [...new Set(Object.values(cites).map(citeText).filter(Boolean))];
  if (evidence.length) {
    const ev = document.createElement("div");
    ev.className = "rule-card-evidence";
    ev.textContent = "Why this reads as one group: " + evidence.slice(0, 3).join(" · ") +
      (evidence.length > 3 ? ` · +${evidence.length - 3} more` : "");
    card.appendChild(ev);
  }

  const actions = document.createElement("div");
  actions.className = "rule-card-actions";
  const endorse = document.createElement("button");
  endorse.type = "button";
  endorse.className = "rule-card-primary";
  endorse.textContent = "Endorse";
  endorse.addEventListener("click", () => endorseRule(rule, card));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "rule-card-ghost";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => dismissRule(rule, card));
  actions.appendChild(endorse);
  actions.appendChild(dismiss);
  card.appendChild(actions);
  return card;
}

// Endorse a rule: apply its member placements to the preferred frame, reusing the
// apply-to-similar "resolve" machinery (the same path openLearnedReview commits with).
// The members become explicit placements; the engine credits the rule for next time.
// Render a citation {feature, value} (or a plain string) as a human "why".
function citeText(c) {
  if (!c) return "";
  if (typeof c === "string") return c;
  const f = c.feature, v = c.value;
  if (f === "job_name_ngram") return `name mentions "${v}"`;
  if (f === "semantic_concept") return "semantically similar";
  if (f === "identifier_class") return `carries ${v}`;
  if (f === "doc_project_tag") return `tagged ${v}`;
  if (f === "people") return `involves ${v}`;
  if (f === "section") return `in "${v}"`;
  return v ? `${f}: ${v}` : String(f || "");
}
async function endorseRule(rule, cardEl) {
  const toFrameName = (rule.preferredFrame || "").trim();
  const members = Array.isArray(rule.verified) ? rule.verified
    : (Array.isArray(rule.members) ? rule.members : Object.keys(rule.citations || {}));
  if (!toFrameName || !members.length) {
    showToast({ kind: "error", title: "Can't endorse", body: "This pattern has no target category yet." });
    return;
  }
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    const r = await tauri.core.invoke("apply_to_similar", {
      action: "resolve",
      body: {
        selectedJobKeys: members,
        rejectedJobKeys: [],
        toFrameName,
        predicate: rule.predicate || rule.predicateLabel,
        // Record a non-destructive endorse_rule event so this actioned card stops
        // re-surfacing until the pattern grows (the endorse-recurrence fix). The
        // placements/credit above are unchanged; this only quiets the ambient card.
        endorseRule: true,
      },
    });
    const applied = (r && r.applied) || members.length;
    showToast({
      kind: "success",
      title: `Endorsed — applied to ${applied} ${applied === 1 ? "job" : "jobs"}`,
      body: `${rule.predicateLabel} → ${toFrameName}. I'll suggest this next time.`,
    });
    await enterDecisionsView();
  } catch (e) {
    console.warn("[main] endorseRule failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
  }
}

// Dismiss a rule: reject + suppress so the engine stops proposing it (the same
// "Don't learn this" path openLearnedReview uses). No placement changes.
async function dismissRule(rule, cardEl) {
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    await tauri.core.invoke("apply_to_similar", {
      action: "reject",
      body: { predicate: rule.predicate || rule.predicateLabel, suppressRule: true },
    });
    if (cardEl) cardEl.remove();
    // Drop from state so a re-render doesn't resurrect it.
    _developedRules = _developedRules.filter((r) => r !== rule);
    showToast({ kind: "idempotent", title: "Won't suggest that", body: `Stopped learning: ${rule.predicateLabel}.` });
  } catch (e) {
    console.warn("[main] dismissRule failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
  }
}

// One disjunction suggestion → a "combine these?" card. ALWAYS a proposal (suggestOnly);
// shows both arms' members + the LLM's confirm state, a Combine action, and Dismiss.
function buildDisjunctionCard(s) {
  const card = document.createElement("div");
  card.className = "rule-card disjunction-card";

  const top = document.createElement("div");
  top.className = "rule-card-top";
  const stmt = document.createElement("div");
  stmt.className = "rule-card-statement";
  stmt.textContent = "These two groups look like one category — combine?";
  top.appendChild(stmt);
  card.appendChild(top);

  const arms = Array.isArray(s.arms) ? s.arms : [];
  const label = s.predicateLabel ||
    (arms.length >= 2 ? `${arms[0].predicateLabel} or ${arms[1].predicateLabel}` : "");
  if (label) {
    const sub = document.createElement("div");
    sub.className = "rule-card-sub disjunction-label";
    sub.textContent = label;
    card.appendChild(sub);
  }

  // Both arms, each with its members. The "or" between them is the whole point.
  const armsWrap = document.createElement("div");
  armsWrap.className = "disjunction-arms";
  arms.forEach((arm, i) => {
    if (i > 0) {
      const orEl = document.createElement("div");
      orEl.className = "disjunction-or";
      orEl.textContent = "or";
      armsWrap.appendChild(orEl);
    }
    const armEl = document.createElement("div");
    armEl.className = "disjunction-arm";
    const armLbl = document.createElement("div");
    armLbl.className = "disjunction-arm-label";
    armLbl.textContent = arm.predicateLabel || `Group ${i + 1}`;
    armEl.appendChild(armLbl);
    const armMembers = Array.isArray(arm.members) ? arm.members : [];
    if (armMembers.length) {
      const ul = document.createElement("ul");
      ul.className = "rule-card-members";
      for (const m of armMembers) {
        const li = document.createElement("li");
        li.className = "rule-card-member";
        const name = document.createElement("span");
        name.className = "rule-card-member-name";
        name.textContent = jobKeyLabel(m);
        li.appendChild(name);
        ul.appendChild(li);
      }
      armEl.appendChild(ul);
    }
    armsWrap.appendChild(armEl);
  });
  card.appendChild(armsWrap);

  // The LLM's confirm state, surfaced honestly (confirmed / not_applicable / etc.).
  if (s.llmConfirmState) {
    const state = document.createElement("div");
    state.className = "rule-card-evidence disjunction-confirm";
    state.textContent = "Engine check: " + humanizeConfirmState(s.llmConfirmState);
    card.appendChild(state);
  }

  const actions = document.createElement("div");
  actions.className = "rule-card-actions";
  const combine = document.createElement("button");
  combine.type = "button";
  combine.className = "rule-card-primary";
  combine.textContent = "Combine";
  combine.addEventListener("click", () => combineDisjunction(s, card));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "rule-card-ghost";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => dismissDisjunction(s, card));
  actions.appendChild(combine);
  actions.appendChild(dismiss);
  card.appendChild(actions);
  return card;
}

function humanizeConfirmState(st) {
  switch (st) {
    case "confirmed": return "confirmed these belong together";
    case "not_applicable": return "not applicable";
    case "unavailable": return "couldn't check (LLM unavailable)";
    case "declined": return "declined — kept separate";
    default: return String(st);
  }
}

// Combine a disjunction: merge the union under the preferred frame. Reuses the
// frameEdit "merge" machinery — each non-preferred arm's members are reparented into
// the preferred frame so the two groups become one. suggestOnly means we only act
// on explicit Combine; nothing here auto-applies.
async function combineDisjunction(s, cardEl) {
  const toFrameName = (s.preferredFrame || "").trim();
  const members = Array.isArray(s.unionMembers) ? s.unionMembers
    : (Array.isArray(s.arms) ? s.arms.flatMap((a) => a.members || []) : []);
  if (!toFrameName || !members.length) {
    showToast({ kind: "error", title: "Can't combine", body: "This suggestion has no target category yet." });
    return;
  }
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    const r = await tauri.core.invoke("apply_to_similar", {
      action: "resolve",
      body: {
        selectedJobKeys: members,
        rejectedJobKeys: [],
        toFrameName,
        predicate: s.predicate || s.predicateLabel,
      },
    });
    const applied = (r && r.applied) || members.length;
    showToast({
      kind: "success",
      title: "Combined",
      body: `Merged ${applied} ${applied === 1 ? "job" : "jobs"} under ${toFrameName}. I'll treat these as one going forward.`,
    });
    await enterDecisionsView();
  } catch (e) {
    console.warn("[main] combineDisjunction failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
  }
}

async function dismissDisjunction(s, cardEl) {
  if (cardEl) cardEl.classList.add("rule-card-busy");
  try {
    await tauri.core.invoke("apply_to_similar", {
      action: "reject",
      body: { predicate: s.predicate || s.predicateLabel, suppressRule: true },
    });
    if (cardEl) cardEl.remove();
    _disjunctionSuggestions = _disjunctionSuggestions.filter((x) => x !== s);
    showToast({ kind: "idempotent", title: "Kept separate", body: "Won't suggest combining these again." });
  } catch (e) {
    console.warn("[main] dismissDisjunction failed:", e);
    if (cardEl) cardEl.classList.remove("rule-card-busy");
  }
}

// job:<slug> → a human label. Reuses the existing jobNames map from the decision-log
// context when present; otherwise prettifies the slug tail.
function jobKeyLabel(jobKey) {
  const key = String(jobKey || "");
  const names = (_decisionsCtx && _decisionsCtx.jobNames) || {};
  if (names[key]) return names[key];
  const tail = key.replace(/^job:/, "");
  if (names[tail]) return names[tail];
  return prettySlug(tail) || key;
}

// Accept one ambient suggestion: move the job + credit the rule (a preview-weighted
// move via resolve, so it stays bounded). "Not this" → a per-job counterexample.
async function acceptLearnedSuggestion(s) {
  try {
    await tauri.core.invoke("apply_to_similar", {
      action: "resolve",
      body: { selectedJobKeys: [s.jobKey], rejectedJobKeys: [], toFrameName: s.suggestedFrame, predicate: s.predicate },
    });
    await enterDecisionsView();
  } catch (e) { console.warn("[main] accept suggestion failed:", e); }
}
async function dismissLearnedSuggestion(s) {
  try {
    await tauri.core.invoke("apply_to_similar", { action: "reject", body: { predicate: s.predicate, jobKey: s.jobKey } });
    await enterDecisionsView();
  } catch (e) { console.warn("[main] dismiss suggestion failed:", e); }
}

// The "Move to…" picker: existing frames + an inline "New category" field. One
// click reassigns the job; the move sticks and becomes evidence for the learner.
// WP-Frame-HITL — the frame-header gesture menu: Rename / Mark-as-type / Merge,
// all overlay-backed (replaces the legacy project-canon Combine/Rename).
// Plain-language definitions surfaced as tooltips on each type chip. Grounded in
// the Work-Forest frame model (frame-compiler.ts): project/client/initiative are
// top-level homes that hold jobs; workstream is a sub-body nested inside one of
// those; topic/geography are lenses that TAG jobs across homes without owning them.
const FRAME_TYPE_HELP = {
  project: "A main line of work — a top-level category that holds jobs (directly or via workstreams).",
  client: "A top-level category for a specific client's work.",
  initiative: "A top-level category for a cross-cutting initiative.",
  workstream: "A sub-area of work that lives INSIDE a top-level category — not on its own.",
  topic: "A recurring subject that tags jobs across categories — a lens, not a home. Jobs stay under their category.",
  geography: "A place (country/region) that tags jobs across categories — a lens, not a home. Jobs stay under their category.",
};
const FRAME_TYPE_LABEL = {
  project: "Project", client: "Client", initiative: "Initiative",
  workstream: "Workstream", topic: "Topic", geography: "Geography",
};
// The three tiers the flat chip row hid. "Tracker" is dropped — the backend never
// honored it (it silently became "misc"), so offering it just misled.
const FRAME_TYPE_TIERS = [
  { label: "Top-level home", hint: "holds jobs; a top frame in the report", types: ["project", "client", "initiative"] },
  { label: "Nested", hint: "lives inside a top-level home", types: ["workstream"] },
  { label: "Lens", hint: "tags jobs across homes without owning them", types: ["topic", "geography"] },
];
function positionMenu(menu, anchorEl, opts) {
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const vh = window.innerHeight, vw = window.innerWidth;
  const margin = 8;
  // Provisional cap so offsetHeight is measured bounded, not unbounded-tall.
  menu.style.maxHeight = `${vh - margin * 2}px`;
  const mh = Math.min(menu.offsetHeight, vh - margin * 2);
  // Prefer opening below the anchor; lift it up if that would overflow the bottom.
  let top = r.bottom + 4;
  if (top + mh > vh - margin) top = Math.max(margin, vh - mh - margin);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(margin, Math.min(r.left, vw - 260))}px`;
  // FINAL: bound the menu to the space from its top to the viewport bottom, so the
  // .frame-move-list (overflow-y:auto) is always fully scrollable and its last item
  // (e.g. the bottom of a long "Merge into" list) is never clipped off-screen.
  menu.style.maxHeight = `${vh - top - margin}px`;
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (!menu.contains(ev.target) && ev.target !== anchorEl) {
        // onDismiss fires only when THIS click is what closed the menu (isConnected
        // guard) — an item click that already removed the menu must not re-trigger
        // it on the next unrelated click. Used by the rename commit-on-dismiss.
        const wasOpen = menu.isConnected;
        menu.remove();
        document.removeEventListener("click", close);
        if (wasOpen && opts && typeof opts.onDismiss === "function") opts.onDismiss();
      }
    });
  }, 0);
}
function openFrameEditMenu(anchorEl, frame, opts) {
  document.querySelectorAll(".frame-move-menu").forEach((m) => m.remove());
  const frames = (_decisionsCtx && _decisionsCtx.frames) || [];
  const menu = document.createElement("div");
  menu.className = "frame-move-menu";

  const header = document.createElement("div");
  header.className = "frame-move-header";
  const title = document.createElement("div");
  title.className = "frame-move-title";
  title.textContent = "Edit category";
  header.appendChild(title);
  // MVP-Librarian 2.1 (the rename bug) — the old rename was an UNLABELED prefilled
  // input that committed ONLY on Enter; every other exit (outside click, another
  // menu item, Escape) silently discarded the typed name, so live rename attempts
  // produced zero events. Now: a labeled row with an explicit Rename button, and
  // a changed name also commits when the menu is dismissed by clicking away
  // (positionMenu onDismiss). Escape restores the name and closes without saving.
  const renameLbl = document.createElement("div");
  renameLbl.className = "frame-move-section";
  renameLbl.textContent = "Rename";
  header.appendChild(renameLbl);
  const renameRow = document.createElement("div");
  renameRow.className = "frame-rename-row";
  const input = document.createElement("input");          // rename, prefilled
  input.type = "text";
  input.className = "frame-move-new-input";
  input.value = frame.name;
  let renameCommitted = false;
  const commitRename = () => {
    const nn = input.value.trim();
    if (renameCommitted || !nn || nn === frame.name) return false;
    renameCommitted = true;
    menu.remove();
    frameEdit({ eventType: "rename", oldFrameName: frame.name, newFrameName: nn });
    return true;
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    else if (e.key === "Escape") { e.stopPropagation(); input.value = frame.name; menu.remove(); }
  });
  const renameSave = document.createElement("button");
  renameSave.type = "button";
  renameSave.className = "frame-rename-save";
  renameSave.textContent = "Rename";
  renameSave.title = "Save the new name";
  renameSave.addEventListener("click", () => commitRename());
  renameRow.appendChild(input);
  renameRow.appendChild(renameSave);
  header.appendChild(renameRow);
  menu.appendChild(header);

  const list = document.createElement("div");
  list.className = "frame-move-list";
  const typeLbl = document.createElement("div");
  typeLbl.className = "frame-move-section";
  typeLbl.textContent = "Mark as type";
  list.appendChild(typeLbl);
  // Grouped by the three tiers the model actually has (homes / nested / lenses) so
  // the very different behaviors are legible — a flat chip row hid that marking a
  // top frame as "Workstream" or "Geography" re-homes or de-homes it.
  for (const tier of FRAME_TYPE_TIERS) {
    const tierLbl = document.createElement("div");
    tierLbl.className = "frame-type-tier-label";
    tierLbl.textContent = tier.label;
    tierLbl.title = tier.hint;
    const hint = document.createElement("span");
    hint.className = "frame-type-tier-hint";
    hint.textContent = " — " + tier.hint;
    tierLbl.appendChild(hint);
    list.appendChild(tierLbl);
    const typeRow = document.createElement("div");
    typeRow.className = "frame-type-row";
    for (const t of tier.types) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "frame-type-chip" + (frame.frameType === t ? " active" : "");
      b.textContent = FRAME_TYPE_LABEL[t] || t;
      if (FRAME_TYPE_HELP[t]) b.title = FRAME_TYPE_HELP[t];
      b.addEventListener("click", () => { menu.remove(); frameEdit({ eventType: "mark_type", frameName: frame.name, frameType: t }); });
      typeRow.appendChild(b);
    }
    list.appendChild(typeRow);
  }

  const isTop = frame.parentFid == null;
  const topFrames = frames.filter((f) => f.parentFid == null && f.name !== frame.name);

  // Re-home (Issue 3) — the `reparent` overlay event. Demote a top frame UNDER
  // another ("everything Merck falls under Merck Above Brand"), move a sub-frame to a
  // different parent, or promote one back to top-level. Unlike merge, the frame and
  // its own jobs/children stay intact. Substrate-preserving (overlay only).
  const rItems = [];
  if (!isTop) rItems.push({ label: "↑ Promote to top-level", newParent: "" });
  for (const t of topFrames) {
    if (!isTop && frame.parentFid === t.fid) continue; // already under this parent
    rItems.push({ label: t.name, newParent: t.name });
  }
  if (rItems.length) {
    const rLbl = document.createElement("div");
    rLbl.className = "frame-move-section";
    rLbl.textContent = isTop ? "Make sub-category of…" : "Re-home under…";
    list.appendChild(rLbl);
    for (const ri of rItems) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "frame-move-item";
      b.textContent = ri.label;
      b.addEventListener("click", () => { menu.remove(); frameEdit({ eventType: "reparent", frameName: frame.name, newParentFrameName: ri.newParent }); });
      list.appendChild(b);
    }
  }

  // Merge into (Issue 4) — fold a redundant frame's jobs into a PEER, then drop it.
  // Peers are same-tier: other top frames for a top frame; sibling sub-frames (same
  // parent) for a nested one — so redundant sub-frames like "Vaccine Story Refresh" ≡
  // "Vaccine Confidence & Narrative Refresh" can finally be combined.
  const mergeTargets = isTop
    ? topFrames
    : frames.filter((f) => f.parentFid === frame.parentFid && f.name !== frame.name);
  if (mergeTargets.length) {
    const mLbl = document.createElement("div");
    mLbl.className = "frame-move-section";
    mLbl.textContent = "Merge into";
    list.appendChild(mLbl);
    for (const t of mergeTargets) {
      const it = document.createElement("button");
      it.type = "button";
      it.className = "frame-move-item";
      it.textContent = t.name;
      it.addEventListener("click", () => { menu.remove(); frameEdit({ eventType: "merge", mergeFromName: frame.name, mergeIntoName: t.name }); });
      list.appendChild(it);
    }
  }
  menu.appendChild(list);
  // Dismissing the menu with a changed name commits the rename (lossless — the
  // user's typed intent is never silently thrown away again).
  positionMenu(menu, anchorEl, { onDismiss: () => commitRename() });
  // Double-click-to-rename entry point lands focused on the name, ready to type.
  if (opts && opts.focusRename) { input.focus(); input.select(); }
}

function openMovePicker(anchorEl, grp) {
  document.querySelectorAll(".frame-move-menu").forEach((m) => m.remove());
  const frames = (_decisionsCtx && _decisionsCtx.frames) || [];
  const menu = document.createElement("div");
  menu.className = "frame-move-menu";

  // Pinned header: title + the "New category" field (always visible).
  const header = document.createElement("div");
  header.className = "frame-move-header";
  const title = document.createElement("div");
  title.className = "frame-move-title";
  title.textContent = "Move to…";
  header.appendChild(title);
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "+ New category…";
  input.className = "frame-move-new-input";
  header.appendChild(input);

  // Nesting scope (Issue 2). When the job already lives under a top frame, a new
  // category shouldn't blindly land at the top level — Trisha's model is "everything
  // Merck falls under Merck Above Brand." Offer "create UNDER <top>" (a workstream
  // sub-frame, parentFrameName set) vs. "new top-level category," defaulting to
  // nesting when a home exists. Backend honors parentFrameName (frame-overlay.ts).
  const homeTop = grp._top;
  let nestUnderTop = !!homeTop;
  if (homeTop) {
    const scope = document.createElement("div");
    scope.className = "frame-move-scope";
    const underChip = document.createElement("button");
    underChip.type = "button";
    underChip.className = "frame-type-chip active";
    underChip.textContent = `Under ${homeTop.name}`;
    underChip.title = `Create as a sub-category inside ${homeTop.name}`;
    const topChip = document.createElement("button");
    topChip.type = "button";
    topChip.className = "frame-type-chip";
    topChip.textContent = "New top-level";
    topChip.title = "Create as a new top-level category";
    const setScope = (nest) => {
      nestUnderTop = nest;
      underChip.classList.toggle("active", nest);
      topChip.classList.toggle("active", !nest);
      input.focus();
    };
    underChip.addEventListener("click", () => setScope(true));
    topChip.addEventListener("click", () => setScope(false));
    scope.appendChild(underChip);
    scope.appendChild(topChip);
    header.appendChild(scope);
  }
  const go = async () => {
    const name = input.value.trim();
    if (!name) return;
    menu.remove();
    const createEdit = nestUnderTop && homeTop
      ? { eventType: "create_frame", frameName: name, frameType: "workstream", parentFrameName: homeTop.name }
      : { eventType: "create_frame", frameName: name, frameType: "initiative" };
    await tauri.core.invoke("frame_edit", { edit: createEdit });
    await frameEdit({ eventType: "move", jobKey: grp.key, toFrameName: name, sourceContext: { jobName: grp.label } });
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  menu.appendChild(header);

  // Scrollable list of existing destinations.
  const list = document.createElement("div");
  list.className = "frame-move-list";
  const addItem = (name, nested) => {
    if (name === grp._top?.name && !nested) return; // skip its own top frame
    const it = document.createElement("button");
    it.type = "button";
    it.className = "frame-move-item" + (nested ? " nested" : "");
    it.textContent = name;
    it.addEventListener("click", () => {
      menu.remove();
      frameEdit({ eventType: "move", jobKey: grp.key, toFrameName: name, sourceContext: { jobName: grp.label } });
    });
    list.appendChild(it);
  };
  for (const t of frames.filter((f) => f.parentFid == null)) {
    addItem(t.name, false);
    for (const w of frames.filter((f) => f.parentFid === t.fid)) addItem(w.name, true);
  }
  menu.appendChild(list);

  // Position INSIDE the viewport; clamp height so the list scrolls internally
  // (the window isn't expandable, so the menu must self-contain).
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const vh = window.innerHeight, vw = window.innerWidth;
  menu.style.maxHeight = `${vh - 16}px`;
  const mh = Math.min(menu.offsetHeight, vh - 16);
  let top = r.bottom + 4;
  if (top + mh > vh - 8) top = Math.max(8, vh - mh - 8);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, vw - 260))}px`;
  setTimeout(() => {
    document.addEventListener("click", function close(ev) {
      if (!menu.contains(ev.target) && ev.target !== anchorEl) { menu.remove(); document.removeEventListener("click", close); }
    });
  }, 0);
}

// ───────── MVP-Librarian 2.2 + 2.3 — bulk multi-select + Move to… ─────────
//
// Two selection lanes over the framed Work-Forest view, both mode-less (a subtle
// checkbox per row; ticking any shows one action bar at the bottom of the Log):
//   • jobs (2.3, Trisha C5): N ticked job groups → one "Move to…" → N individual
//     `move` org-edit events (the existing event type — nothing compound).
//   • records (2.2, job-split): ticked record cards inside a job → "Move to…" a
//     DIFFERENT job (or a brand-new job name) → one `move_record` org-edit per
//     record: { eventType: "move_record", recordId, toJobKey? | newJobName?,
//     sourceContext: { jobName } }. The server adds the envelope (id/ts/enriched
//     sourceContext) exactly as for every other org-edit. NOTE: the backend
//     companion isn't live yet — until it lands the POST 400s and the bar toasts
//     the failure honestly; nothing is silently pretended.
// Selection state is cleared on every re-render (each landed edit reloads the
// view, so a stale recordId/jobKey can never be replayed).
const _bulkJobSel = new Map();     // jobKey → job label
const _bulkRecordSel = new Map();  // recordId → source job label

function clearBulkSelection() {
  _bulkJobSel.clear();
  _bulkRecordSel.clear();
  updateBulkMoveBar();
}

// The one action bar. Lives inside #view-decisions so it can never leak into
// another view; rebuilt on every selection change; removed when nothing is ticked.
function updateBulkMoveBar() {
  const host = document.getElementById("view-decisions");
  if (!host) return;
  let bar = host.querySelector(".bulk-move-bar");
  const jobs = _bulkJobSel.size, recs = _bulkRecordSel.size;
  if (!jobs && !recs) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "bulk-move-bar";
    host.appendChild(bar);
  }
  bar.innerHTML = "";
  const label = document.createElement("span");
  label.className = "bulk-move-count";
  const parts = [];
  if (jobs) parts.push(`${jobs} ${jobs === 1 ? "job" : "jobs"}`);
  if (recs) parts.push(`${recs} ${recs === 1 ? "record" : "records"}`);
  label.textContent = `${parts.join(" · ")} selected`;
  bar.appendChild(label);
  if (jobs) {
    const mv = document.createElement("button");
    mv.type = "button";
    mv.className = "bulk-move-action";
    mv.textContent = "Move jobs to…";
    mv.addEventListener("click", (ev) => { ev.stopPropagation(); openBulkJobMovePicker(mv); });
    bar.appendChild(mv);
  }
  if (recs) {
    const mv = document.createElement("button");
    mv.type = "button";
    mv.className = "bulk-move-action";
    mv.textContent = "Move records to…";
    mv.addEventListener("click", (ev) => { ev.stopPropagation(); openRecordMovePicker(mv); });
    bar.appendChild(mv);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "bulk-move-clear";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    clearBulkSelection();
    // untick without a re-render
    document.querySelectorAll(".job-select-box:checked, .record-select-box:checked").forEach((cb) => { cb.checked = false; });
  });
  bar.appendChild(clear);
}

// 2.3 — destination picker for the ticked JOBS. Same destinations as the per-job
// Move picker (top frames + nested workstreams + an inline new category), but one
// choice emits N individual `move` events through frameEditBatch (one reload, no
// per-move apply-to-similar storm).
function openBulkJobMovePicker(anchorEl) {
  document.querySelectorAll(".frame-move-menu").forEach((m) => m.remove());
  const frames = (_decisionsCtx && _decisionsCtx.frames) || [];
  const selected = [..._bulkJobSel.entries()]; // [jobKey, label]
  const n = selected.length;
  const menu = document.createElement("div");
  menu.className = "frame-move-menu";

  const header = document.createElement("div");
  header.className = "frame-move-header";
  const title = document.createElement("div");
  title.className = "frame-move-title";
  title.textContent = `Move ${n} ${n === 1 ? "job" : "jobs"} to…`;
  header.appendChild(title);
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "+ New category…";
  input.className = "frame-move-new-input";
  header.appendChild(input);

  // Trisha UAT Issue 2 (bulk half): when every ticked job lives under the same
  // top frame, a new category defaults to NESTING there (her model: everything
  // Merck stays under Merck Above Brand). Mixed selections keep top-level.
  const topOf = (jobKey) => {
    for (const f of frames) {
      if (Array.isArray(f.jobKeys) && f.jobKeys.includes(jobKey)) {
        if (f.parentFid == null) return f;
        return frames.find((p) => p.fid === f.parentFid) || f;
      }
    }
    return null;
  };
  const tops = new Set(selected.map(([jk]) => topOf(jk)).filter(Boolean));
  const homeTop = tops.size === 1 ? [...tops][0] : null;
  let nestUnderTop = !!homeTop;
  if (homeTop) {
    const scope = document.createElement("div");
    scope.className = "frame-move-scope";
    const underChip = document.createElement("button");
    underChip.type = "button";
    underChip.className = "frame-type-chip active";
    underChip.textContent = `Under ${homeTop.name}`;
    underChip.title = `Create as a sub-category inside ${homeTop.name}`;
    const topChip = document.createElement("button");
    topChip.type = "button";
    topChip.className = "frame-type-chip";
    topChip.textContent = "New top-level";
    topChip.title = "Create as a new top-level category";
    const setScope = (nest) => {
      nestUnderTop = nest;
      underChip.classList.toggle("active", nest);
      topChip.classList.toggle("active", !nest);
      input.focus();
    };
    underChip.addEventListener("click", () => setScope(true));
    topChip.addEventListener("click", () => setScope(false));
    scope.appendChild(underChip);
    scope.appendChild(topChip);
    header.appendChild(scope);
  }
  menu.appendChild(header);

  const emit = async (toFrameName, createEdit) => {
    menu.remove();
    const edits = [];
    if (createEdit) edits.push(createEdit);
    for (const [jobKey, jobName] of selected) {
      edits.push({ eventType: "move", jobKey, toFrameName, sourceContext: { jobName } });
    }
    clearBulkSelection();
    const failed = await frameEditBatch(edits);
    if (failed) {
      showToast({ kind: "failure", title: "Some moves didn't stick", body: `${failed} of ${edits.length} edits were rejected — check the connection and retry.` });
    } else {
      showToast({ kind: "success", title: `Moved ${n} ${n === 1 ? "job" : "jobs"}`, body: `Now under ${toFrameName}.` });
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return;
    emit(
      name,
      nestUnderTop && homeTop
        ? { eventType: "create_frame", frameName: name, frameType: "workstream", parentFrameName: homeTop.name }
        : { eventType: "create_frame", frameName: name, frameType: "initiative" },
    );
  });

  const list = document.createElement("div");
  list.className = "frame-move-list";
  const addItem = (name, nested) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "frame-move-item" + (nested ? " nested" : "");
    it.textContent = name;
    it.addEventListener("click", () => emit(name));
    list.appendChild(it);
  };
  for (const t of frames.filter((f) => f.parentFid == null)) {
    addItem(t.name, false);
    for (const w of frames.filter((f) => f.parentFid === t.fid)) addItem(w.name, true);
  }
  menu.appendChild(list);
  positionMenu(menu, anchorEl);
}

// 2.2 — destination picker for the ticked RECORDS (the job-split gesture).
// Destinations are JOBS (grouped under their frame for wayfinding) or a typed
// new job name; one choice emits N individual `move_record` events. Payload per
// record (envelope added server-side, matching every other org-edit POST):
//   existing job → { eventType: "move_record", recordId, toJobKey, sourceContext: { jobName } }
//   new job      → { eventType: "move_record", recordId, newJobName, sourceContext: { jobName } }
// where sourceContext.jobName is the record's CURRENT job label (the learner's
// evidence), mirroring what the per-job Move sends for whole-job moves.
function openRecordMovePicker(anchorEl) {
  document.querySelectorAll(".frame-move-menu").forEach((m) => m.remove());
  const ctx = _decisionsCtx || {};
  const frames = ctx.frames || [];
  const jobNames = ctx.jobNames || {};
  const selected = [..._bulkRecordSel.entries()]; // [recordId, source job label]
  const n = selected.length;
  const jobLabel = (jk) =>
    jobNames[jk] || jobNames[String(jk).replace(/^job:/, "")] || prettySlug(String(jk).replace(/^job:/, ""));
  const menu = document.createElement("div");
  menu.className = "frame-move-menu";

  const header = document.createElement("div");
  header.className = "frame-move-header";
  const title = document.createElement("div");
  title.className = "frame-move-title";
  title.textContent = `Move ${n} ${n === 1 ? "record" : "records"} to…`;
  header.appendChild(title);
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "+ New job…";
  input.className = "frame-move-new-input";
  header.appendChild(input);
  menu.appendChild(header);

  const emit = async (dest) => {   // dest: { toJobKey } | { newJobName }
    menu.remove();
    const edits = selected.map(([recordId, jobName]) => ({
      eventType: "move_record",
      recordId,
      ...dest,
      sourceContext: { jobName },
    }));
    clearBulkSelection();
    const failed = await frameEditBatch(edits);
    if (failed) {
      // Expected until the move_record backend companion lands: the server 400s
      // the eventType. Honest failure — never pretend the split stuck.
      showToast({ kind: "failure", title: "Couldn't move the records", body: `The server rejected ${failed} of ${edits.length} record moves.` });
    } else {
      const destLabel = dest.toJobKey ? jobLabel(dest.toJobKey) : dest.newJobName;
      showToast({ kind: "success", title: `Moved ${n} ${n === 1 ? "record" : "records"}`, body: `Now under ${destLabel}.` });
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const name = input.value.trim();
    if (!name) return;
    emit({ newJobName: name });
  });

  // Jobs grouped under their frame (section label = frame, items = its jobs).
  const list = document.createElement("div");
  list.className = "frame-move-list";
  const addJob = (jk) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "frame-move-item nested";
    it.textContent = jobLabel(jk);
    it.addEventListener("click", () => emit({ toJobKey: jk }));
    list.appendChild(it);
  };
  const seen = new Set();
  for (const t of frames.filter((f) => f.parentFid == null)) {
    const nested = frames.filter((f) => f.parentFid === t.fid);
    const keys = [...(t.jobKeys || []), ...nested.flatMap((w) => w.jobKeys || [])];
    if (!keys.length) continue;
    const lbl = document.createElement("div");
    lbl.className = "frame-move-section";
    lbl.textContent = t.name;
    list.appendChild(lbl);
    for (const jk of keys) { if (!seen.has(jk)) { seen.add(jk); addJob(jk); } }
  }
  // Jobs known to the mapping but not in any rendered frame (unframed).
  const unframed = [...new Set(Object.values(ctx.recordJobs || {}))].filter((jk) => jk && !seen.has(jk));
  if (unframed.length) {
    const lbl = document.createElement("div");
    lbl.className = "frame-move-section";
    lbl.textContent = "Unframed";
    list.appendChild(lbl);
    for (const jk of unframed) { seen.add(jk); addJob(jk); }
  }
  menu.appendChild(list);
  positionMenu(menu, anchorEl);
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
    // PERF: the ambient enrichment (learned-suggestion chips, the "Patterns I've
    // noticed" rules, and the Question-Engine card) USED to be awaited here, BEFORE the
    // first paint. But the Question-Engine generation alone can take ~30s (doc-type +
    // index extraction + membership embeddings + simulation + judge), so the decisions
    // — ready in ~50ms — sat blocked behind it. It now fires fire-and-forget AFTER the
    // paint (below `renderDecisions()`), each patching itself in when it lands.
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
  // Snapshot which groups are user-merged so the Split-back affordance can show.
  await refreshProjectCanonState();

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

  // Record-level inline editing capability + reload hook (Phase A).
  _recordEditsEnabled = !!(data && data.editsEnabled);
  _reloadRecordView = () => enterDecisionsView();

  _decisionsCtx = {
    items,
    docProjects,
    edges: Array.isArray(data && data.edges) ? data.edges : [],
    byId,
    baseUrl,
    // Canonical alias map (slug → canonical) from the engine — consolidates
    // duplicate subjects in the By-project lens (sora → project-sora).
    aliases: data && data.aliases ? data.aliases : {},
    // P4 — canonical P2 job names (parentJob/slug → name) for By-project labels.
    jobNames: data && data.jobNames ? data.jobNames : {},
    // P4 (c) — recordId → job: key for hot-list records only; By-project re-points
    // these to job chips, leaving broad-corpus records on document-project grouping.
    recordJobs: data && data.recordJobs ? data.recordJobs : {},
    // WP-Work-Forest top altitude — the CoordinationFrameCompiler forest (top
    // frames → workstreams) + geography/topic facets. Present only when
    // COORDINATION_FRAMES_ENABLED on the server; absent → flat job grouping.
    frames: Array.isArray(data && data.frames) ? data.frames : [],
    facets: Array.isArray(data && data.facets) ? data.facets : [],
    // WP-Priority-Frame-Integration step 1 — per-job heat from the real PRIORITY
    // operator (importance × urgency, max+topK rollup). Present only when
    // ENABLE_PRIORITY_OPERATOR; absent → jobs rank by the attention fallback.
    jobHeat: data && data.jobHeat ? data.jobHeat : {},
    // step 5 — ActionCandidateView mode per record; step 6 — per-record "who".
    actionKinds: data && data.actionKinds ? data.actionKinds : {},
    recordRelationship: data && data.recordRelationship ? data.recordRelationship : {},
    // MVP-Librarian Phase 4 — the nursery shelf: new/uncategorized jobs the
    // incremental-ingest path abstained on ({jobKey, jobName, firstSeenTd,
    // docIds}). Backend companion may not be live yet — absent/empty ⇒ hidden.
    nursery: Array.isArray(data && data.nursery) ? data.nursery : [],
  };
  renderDecisions();

  // Ambient enrichment — fetched OFF the critical path so nothing blocks the paint
  // above (the Question-Engine card can take ~30s). Fired in parallel; each re-renders
  // when it lands. Guarded so one slow/failed enrichment can't abort the view or the
  // others. (Order-independent: each sets its own module state that renderDecisions reads.)
  const _reDecisions = () => { try { renderDecisions(); } catch (_e) { /* redraw best-effort */ } };
  refreshLearnedSuggestions().then(_reDecisions).catch((e) => console.warn("[main] learned suggestions:", e));
  refreshContainmentSignals().catch((e) => console.warn("[main] containment signals:", e));
  refreshDevelopedRules().then(_reDecisions).catch((e) => console.warn("[main] developed rules:", e));
  refreshQuestionCard().then(_reDecisions).catch((e) => console.warn("[main] question card:", e));
  // Workload (moved from Today) — collapsed line above the list.
  loadLogWorkload().catch((e) => console.warn("[main] workload strip:", e));
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

  const msg = document.createElement("pre");
  msg.className = "sop-message";
  msg.textContent = data.message || "";

  panel.appendChild(bar);
  panel.appendChild(msg);
  // WP-SR1 — claim-level receipts, when the payload carries them. The person
  // digest doesn't emit the field yet, so this renders nothing today (additive)
  // and lights up the moment the engine attaches receipts to this altitude.
  const claimsEl = renderSopClaims(data.receipts);
  if (claimsEl) panel.appendChild(claimsEl);
  // Phase B — inline digest edit (person altitude).
  attachDigestEditor({ panel, bar, msg, scope: "person", subject: slug, label, message: data.message || "", editsEnabled: data.editsEnabled });
  // WP-Cohesion-Operators — "worth looping in" rail, scoped to this person
  // (owner-side: loop others in; target-side: worth knowing).
  const informRail = document.createElement("div");
  informRail.className = "inform-rail";
  panel.appendChild(informRail);
  loadInformRail(informRail, slug);
}

/**
 * Shared inline-digest editor (Phase B), used by the person / project / corpus
 * digests. Adds an "Edit message" button to `bar`; on Save it POSTs the
 * before/after to /state-of-play/edit at the given altitude `scope` and renders
 * the returned proposals (candidate records / inform / priority / fieldChanges)
 * below `msg`. Proposal-only — nothing is applied until the user approves.
 */
function attachDigestEditor({ panel, bar, msg, scope, subject, label, message, editsEnabled }) {
  const proposals = document.createElement("div");
  proposals.className = "sop-proposals";
  panel.appendChild(proposals);
  if (!editsEnabled) return;
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "sop-polish";
  editBtn.textContent = "Edit message";
  editBtn.addEventListener("click", () => {
    if (msg.dataset.editing === "true") return;
    msg.dataset.editing = "true";
    const orig = message || "";
    msg.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "sop-edit-textarea";
    ta.rows = Math.min(16, Math.max(6, orig.split("\n").length + 1));
    ta.value = orig;
    const row = document.createElement("div");
    row.className = "sop-edit-editor-row";
    const save = document.createElement("button");
    save.type = "button"; save.className = "sop-edit-btn record-edit-save"; save.textContent = "Analyze edits";
    save.addEventListener("click", async () => {
      const human = ta.value;
      msg.dataset.editing = ""; msg.textContent = human;
      if (human.trim() === orig.trim()) return;
      proposals.innerHTML = '<div class="sop-status">Analyzing your edits…</div>';
      try {
        const r = await tauri.core.invoke("edit_digest", { scope, subject, systemDigest: orig, humanDigest: human });
        renderDigestProposals(proposals, r && r.decomposition, subject, label, panel);
      } catch (e) {
        proposals.innerHTML = "";
        showToast({ kind: "failure", title: "Couldn't analyze edits", body: String(e) });
      }
    });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "sop-edit-btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { msg.dataset.editing = ""; msg.textContent = orig; });
    row.appendChild(save); row.appendChild(cancel);
    msg.appendChild(ta); msg.appendChild(row);
    ta.focus();
  });
  bar.appendChild(editBtn);
}

/** Render the digest-edit decomposition as inline proposals (proposal-only —
 *  candidate records can be Approved into the corpus; the rest are informational
 *  signals the human can dismiss). */
function renderDigestProposals(container, decomp, slug, label, panel) {
  container.innerHTML = "";
  if (!decomp) return;
  const p = decomp.proposals || {};
  const section = (title) => {
    const h = document.createElement("div");
    h.className = "sop-edit-heading";
    h.textContent = title;
    container.appendChild(h);
  };
  const card = () => {
    const c = document.createElement("div");
    c.className = "sop-edit-card";
    container.appendChild(c);
    return c;
  };

  const cands = Array.isArray(p.candidateRecords) ? p.candidateRecords : [];
  if (cands.length) {
    section("New decisions / commitments to capture");
    for (const cand of cands) {
      const c = card();
      const txt = document.createElement("div");
      txt.className = "sop-edit-text";
      txt.textContent = `${recordTypeLabel(cand)}: ${cand.summary}`;
      c.appendChild(txt);
      const row = document.createElement("div");
      row.className = "sop-edit-controls";
      const approve = document.createElement("button");
      approve.type = "button"; approve.className = "sop-edit-btn record-edit-save"; approve.textContent = "Add to log";
      approve.addEventListener("click", async () => {
        c.style.opacity = "0.5";
        try {
          await tauri.core.invoke("create_record_from_proposal", { candidate: cand, sourceText: cand.sourceText || "" });
          c.innerHTML = '<div class="sop-edit-text">Added to the log ✓</div>';
        } catch (e) { c.style.opacity = "1"; showToast({ kind: "failure", title: "Couldn't add", body: String(e) }); }
      });
      const dismiss = document.createElement("button");
      dismiss.type = "button"; dismiss.className = "sop-edit-btn"; dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => c.remove());
      row.appendChild(approve); row.appendChild(dismiss);
      c.appendChild(row);
    }
  }

  const inform = Array.isArray(p.informSet) ? p.informSet : [];
  if (inform.length) {
    section("People to loop in");
    const c = card();
    c.appendChild(Object.assign(document.createElement("div"), {
      className: "sop-edit-text",
      textContent: inform.map((i) => i.displayName).join(", "),
    }));
  }

  const shs = Array.isArray(p.shouldHaveSurfaced) ? p.shouldHaveSurfaced : [];
  if (shs.length) {
    section("Already tracked — surfaced because you added them");
    for (const s of shs) {
      const c = card();
      c.appendChild(Object.assign(document.createElement("div"), { className: "sop-edit-text", textContent: s.text }));
    }
  }

  const pri = Array.isArray(p.priority) ? p.priority : [];
  if (pri.length) {
    section("Priority you flagged");
    for (const s of pri) {
      const c = card();
      c.appendChild(Object.assign(document.createElement("div"), { className: "sop-edit-text", textContent: s.text }));
    }
  }

  const fc = Array.isArray(p.fieldChanges) ? p.fieldChanges : [];
  if (fc.length) {
    section("Facts you changed on tracked items");
    for (const f of fc) {
      const c = card();
      c.appendChild(Object.assign(document.createElement("div"), { className: "sop-edit-text", textContent: f.to }));
    }
  }

  if (!cands.length && !inform.length && !shs.length && !pri.length && !fc.length) {
    container.appendChild(Object.assign(document.createElement("div"), {
      className: "sop-status",
      textContent: decomp.llmUsed ? "Edits captured — no new items detected." : "Edits captured.",
    }));
  }
}

// ── WP-SoP-Team-Update-Compose — "Compose update to team" on the SoP digest ──
//
// A SEPARATE, OUTWARD artifact derived off the (read-only) personal SoP digest:
// derive → edit inline → send to Outbox (email/Teams) → capture the edits as diff
// signal for the learning model. Reuses the existing compose/edit machinery — the
// inline textarea + Save & analyze + renderDigestProposals from attachDigestEditor,
// the outbox producer via stageOutboxDraft, and the forest-scope digest-edit
// capture via edit_digest. Gated by the SoP payload's `composeEnabled` capability
// flag (absent when SOP_COMPOSE_ENABLED is off ⇒ the affordance never renders, so
// the personal SoP panels stay byte-equal). `subject` = the id (frame fid / job
// key), or "forest" for the whole-forest scope.

// Best-effort capture of the compose→final delta as a forest-scope digest edit
// (editType 'digest' → the auto-compose voice channel + inform-set). Never blocks
// the send. Skips an unchanged draft (an unchanged draft says our compose was good).
async function captureComposeEdit(level, subject, generated, finalText) {
  const from = (generated || "").trim();
  const to = (finalText || "").trim();
  if (!to || from === to) return null;
  try {
    return await tauri.core.invoke("edit_digest", { scope: level, subject: String(subject), systemDigest: generated, humanDigest: finalText });
  } catch (e) {
    console.warn("[main] compose edit capture failed (non-blocking):", e);
    return null;
  }
}

function teamUpdateTitle(level, subjectLabel) {
  if (level === "forest") return "Update to the team: across all work";
  return "Update to the team: " + (subjectLabel || "this area");
}

// Attach the "Compose update to team" affordance to a SoP panel. Additive: renders
// nothing unless the SoP payload says composeEnabled (the capability gate).
function attachComposeAffordance(panel, opts) {
  opts = opts || {};
  const { level, id, data, label } = opts;
  if (!data || data.composeEnabled !== true) return; // capability gate — flag off ⇒ nothing
  const ctx = {
    level,
    subject: id == null ? "forest" : String(id),
    subjectLabel: label || (level === "forest" ? "all work" : "this area"),
  };
  const wrap = document.createElement("div");
  wrap.className = "sop-compose";
  panel.appendChild(wrap);
  mountComposeStart(wrap, ctx);
}

// Seed (or re-seed, after Cancel) the collapsed "Compose update to team" button +
// its click handler. On click: fetch the derived draft, then open the editor.
function mountComposeStart(wrap, ctx) {
  wrap.dataset.open = "";
  wrap.innerHTML = "";
  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "sop-action sop-compose-start";
  startBtn.textContent = "Compose update to team";
  wrap.appendChild(startBtn);
  startBtn.addEventListener("click", async () => {
    if (wrap.dataset.open === "1") return;
    wrap.dataset.open = "1";
    startBtn.disabled = true;
    startBtn.textContent = "Composing update…";
    let res;
    try {
      res = await tauri.core.invoke("compose_team_update", { level: ctx.level, id: ctx.subject === "forest" ? null : String(ctx.subject) });
    } catch (e) {
      mountComposeStart(wrap, ctx);
      showToast({ kind: "failure", title: "Couldn't compose update", body: String(e) });
      return;
    }
    if (!res || res.available === false || res.composeEnabled === false) {
      wrap.innerHTML = '<div class="sop-status">No team update to compose for this area right now.</div>';
      return;
    }
    renderComposeEditor(wrap, { ...ctx, draft: res.draft || "", recipients: res.recipients || {}, items: Array.isArray(res.items) ? res.items : [], receipts: res.receipts });
  });
}

// Render the inline compose editor: resolved recipients, an editable draft, and
// the send/analyze actions. Mirrors attachDigestEditor's textarea + the share
// popover's two-button send row.
function renderComposeEditor(wrap, ctx) {
  wrap.dataset.open = "1";
  wrap.innerHTML = "";
  const generated = ctx.draft || "";

  // Resolved recipients (server-side owners→To/Cc). Unresolved names surfaced,
  // never dropped — the same affordance the outbox drafts use.
  const rec = ctx.recipients || {};
  const recEl = document.createElement("div");
  recEl.className = "sop-compose-recipients";
  const recLine = (label, arr, cls) => {
    if (!arr || !arr.length) return;
    const d = document.createElement("div");
    d.className = "sop-compose-recipient-line" + (cls ? " " + cls : "");
    d.textContent = label + ": " + arr.join(", ");
    recEl.appendChild(d);
  };
  recLine("To", rec.to);
  recLine("Cc", rec.cc);
  recLine("Recipients to confirm (no address on file)", rec.unresolved, "sop-compose-unresolved");
  if (!recEl.childElementCount) {
    recEl.appendChild(Object.assign(document.createElement("div"), { className: "sop-compose-recipient-line sop-compose-unresolved", textContent: "Recipients to confirm" }));
  }
  wrap.appendChild(recEl);

  const ta = document.createElement("textarea");
  ta.className = "sop-edit-textarea sop-compose-textarea";
  ta.rows = Math.min(22, Math.max(8, generated.split("\n").length + 1));
  ta.value = generated;
  wrap.appendChild(ta);

  // WP-SR1 — the quantitative claims behind the draft ("3 overdue", "oldest due
  // <date>" …), each expandable to the records it was computed from. Sits above
  // the flat Sources list so the draft's numbers are checkable before sending.
  // Absent field ⇒ nothing (renderSopClaims guards the shape).
  const claimsEl = renderSopClaims(ctx.receipts);
  if (claimsEl) wrap.appendChild(claimsEl);

  // WP-R3 item 2 — the citations behind the draft, through the ONE receipt
  // component (§2.4), so the compose preview is consistent with every other
  // receipted surface. The compose payload carries the underlying SoP `items`;
  // each renders as its verbatim quote (verified-only) + jump-to-source. Shape-
  // tolerant ({record} envelope OR a bare record) and defensive: renderReceipt
  // renders nothing without a verified verbatim or documentId, and the block is
  // omitted entirely when no item yields evidence (no empty "Sources" header).
  const citeItems = Array.isArray(ctx.items) ? ctx.items : [];
  if (citeItems.length) {
    const cites = document.createElement("div");
    cites.className = "sop-compose-cites";
    let any = 0;
    for (const it of citeItems) {
      const rec = it && it.record ? it.record : it;
      if (!rec || typeof rec !== "object") continue;
      if (!((rec.verbatimVerified === true && rec.verbatim) || rec.documentId)) continue;
      cites.appendChild(
        renderReceipt(
          { verbatim: rec.verbatim, verbatimVerified: rec.verbatimVerified, documentId: rec.documentId },
          { variant: "receipt-compose", compact: true },
        ),
      );
      any++;
    }
    if (any) {
      const head = document.createElement("div");
      head.className = "sop-compose-cites-head";
      head.textContent = any === 1 ? "Source" : "Sources";
      cites.insertBefore(head, cites.firstChild);
      wrap.appendChild(cites);
    }
  }

  const proposals = document.createElement("div");
  proposals.className = "sop-proposals";

  const row = document.createElement("div");
  // Match the record "Share this decision" popover: primary filled Send +
  // bordered secondary actions (same classes → same look/color/feel).
  row.className = "record-share-actions sop-compose-actions";
  const mkBtn = (text, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    return b;
  };

  const analyze = mkBtn("Analyze edits", "record-share-copy");
  analyze.addEventListener("click", async () => {
    const human = ta.value;
    if (human.trim() === generated.trim()) { proposals.innerHTML = '<div class="sop-status">No changes yet — edit the draft, then analyze.</div>'; return; }
    proposals.innerHTML = '<div class="sop-status">Analyzing your edits…</div>';
    try {
      const r = await tauri.core.invoke("edit_digest", { scope: ctx.level, subject: String(ctx.subject), systemDigest: generated, humanDigest: human });
      wrap.dataset.captured = human; // this exact value is now captured — don't double-capture on send
      renderDigestProposals(proposals, r && r.decomposition, ctx.subject, ctx.subjectLabel, wrap);
    } catch (e) {
      proposals.innerHTML = "";
      showToast({ kind: "failure", title: "Couldn't analyze edits", body: String(e) });
    }
  });

  const send = async () => {
    const finalText = ta.value;
    if (!finalText.trim()) { showToast({ kind: "failure", title: "Nothing to send", body: "The update is empty." }); return; }
    // Capture the compose→final delta once (skip if Save & analyze already logged this exact value).
    if (wrap.dataset.captured !== finalText) {
      await captureComposeEdit(ctx.level, ctx.subject, generated, finalText);
      wrap.dataset.captured = finalText;
    }
    // Single send → the shared Outbox queue. stageOutboxDraft owns the toast.
    await stageOutboxDraft({
      id: "team-update:" + ctx.level + ":" + ctx.subject,
      title: teamUpdateTitle(ctx.level, ctx.subjectLabel),
      detail: finalText,
      detailGenerated: generated,
      intent: "email",
      toRecipients: Array.isArray(rec.to) ? rec.to : undefined,
      ccRecipients: Array.isArray(rec.cc) ? rec.cc : undefined,
      sourceKind: "team-update",
      sourceLabel: ctx.level + ":" + ctx.subject,
    });
  };

  const sendBtn = mkBtn("Send to Outbox", "record-share-send");
  sendBtn.addEventListener("click", () => send());
  const cancel = mkBtn("Cancel", "record-share-copy");
  cancel.addEventListener("click", () => mountComposeStart(wrap, ctx));

  row.appendChild(sendBtn);
  row.appendChild(analyze);
  row.appendChild(cancel);
  wrap.appendChild(row);
  // Verb-truth: "Analyze edits" captures the edit delta for learning — it does
  // NOT keep the draft. Say where drafts actually live so nobody loses prose.
  const keepHint = document.createElement("div");
  keepHint.className = "sop-status compose-keep-hint";
  keepHint.textContent = "Drafts are kept when sent to Outbox";
  wrap.appendChild(keepHint);
  wrap.appendChild(proposals);
  ta.focus();
}

// Team roster (slug → displayName) for the owner-reassign dropdown. Fetched once
// from the batch digest and cached; refreshed lazily if empty.
let _sopRoster = null;
async function getSopRoster() {
  if (_sopRoster) return _sopRoster;
  try {
    const res = await tauri.core.invoke("fetch_team_state_of_play");
    const people = res && Array.isArray(res.people) ? res.people : [];
    _sopRoster = people.map((p) => ({ owner: p.owner, displayName: p.displayName || prettySlug(p.owner) }));
  } catch {
    _sopRoster = [];
  }
  return _sopRoster;
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

// WP-R3 item 1 — per-project State-of-Play header. Sits at the top of a project
// group and auto-loads the PROJECT-altitude SoP prose (via the shared fetch_sop
// path, level='project', keyed on the project slug), rendered through the
// receipted prose renderer (renderSoPProse → renderReceipt for any citeable
// claims + the license footnote). Defensive per the #61 pattern: loadSoP returns
// null on empty / flag-off / server-too-old / unreachable, and the header then
// removes itself — never a blank block or an error surface. No new endpoint, no
// blocking work before paint (it fires after the group is in the DOM).
function buildProjectSopHeader(slug, label) {
  const header = document.createElement("div");
  header.className = "sop-project-header";
  header.hidden = true; // stays hidden until prose lands (invisible-by-absence)
  // Fire-and-forget; the group is already painted. A failure/absence just leaves
  // the header hidden — the team-email bar below carries the project on its own.
  loadSoP("project", slug, null)
    .then((data) => {
      if (!data) { header.remove(); return; }
      renderSoPProse(header, data, {});
      header.hidden = false;
    })
    .catch((e) => { console.warn("[main] project SoP header (" + slug + "):", e); header.remove(); });
  return header;
}

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
  // Phase B — inline digest edit (project altitude).
  attachDigestEditor({ panel, bar, msg, scope: "project", subject: data.project || slug, label: data.projectLabel || label, message: data.teamMessage || "", editsEnabled: data.editsEnabled });

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
  const { items, docProjects, edges, byId, baseUrl, aliases, jobNames, recordJobs, frames, facets, jobHeat, nursery } = _decisionsCtx;

  // MVP-Librarian 2.2/2.3 — a re-render rebuilds every checkbox unticked, so the
  // selection state must reset with it (stale jobKeys/recordIds never replay).
  clearBulkSelection();

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

  let ordered = groupRecords(filtered, _decisionsLens, docProjects, aliases, jobNames, recordJobs);
  // WP-Work-Forest — under the project lens, arrange the job groups beneath their
  // CoordinationFrameCompiler top frame (Projects → Suggested → Topics) with
  // workstream sub-headers. No frames (flag off / empty) → unchanged flat order.
  const framed = _decisionsLens === "project" && frames && frames.length;
  if (framed) ordered = applyFrameLayout(ordered, frames, jobHeat);

  listEl.innerHTML = "";
  // WP-Rule-Cards — "Patterns I've noticed" belongs where ambient learning lives: the
  // project lens, above the frame list. buildPatternsSection returns null when there's
  // nothing to review (empty corpus), so nothing intrusive renders on settled data.
  if (_decisionsLens === "project") {
    // MVP-Librarian Phase 3 — the ONE question (or its pull affordance) sits at
    // the very top of the forest, above the ambient patterns. Null when the
    // question engine is off server-side (503) — nothing renders at all.
    const questionSection = buildQuestionSection();
    if (questionSection) listEl.appendChild(questionSection);
    const patterns = buildPatternsSection();
    if (patterns) listEl.appendChild(patterns);
  }
  if (framed) {
    const fb = buildFacetBar(facets);
    if (fb) listEl.appendChild(fb);
  }
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
    // WP-THRESHOLD-NAV Increment 2 — active-state summary SENTENCE. The two control
    // systems (status filter + lens) confused Trisha ("I pressed Open. By project?
    // I don't know what happened."). Render the active combination in plain words
    // ahead of the counts, so the current view is legible at a glance.
    const stateWord = { all: "All", open: "Open", resolved: "Resolved", superseded: "Replaced" }[_decisionsFilter] || "All";
    const lensPhrase = { project: "by project", deadline: "by deadline", people: "by person", conflicts: "conflicts" }[_decisionsLens] || "by project";
    const active = _decisionsLens === "conflicts"
      ? `${stateWord} — conflicts`
      : `${stateWord}, ${lensPhrase}`;
    if (_decisionsLens === "deadline") {
      const overdue = filtered.filter((it) => {
        const r = it.record || it;
        return r.due && new Date(r.due + "T00:00:00") < new Date();
      }).length;
      subEl.textContent = `${active} · ${recs} · ${overdue} overdue`;
    } else {
      const real = ordered.filter((g) => !g.muted).length;
      const noun = _decisionsLens === "people" ? (real === 1 ? "person" : "people") : (real === 1 ? "project" : "projects");
      subEl.textContent = `${active} · ${recs} · ${real} ${noun}`;
    }
  }

  for (const grp of ordered) {
    // WP-Work-Forest — top-frame + workstream section headers (project lens only).
    // Real frames (not the "Unframed" bucket) get a collapse chevron so a whole
    // project — or a single sub-category under it — can be folded away.
    if (grp._frameHeader) {
      const fh = buildFrameHeader(grp._frameHeader);
      if (!grp._frameHeader.__unframed) {
        fh.dataset.frameName = grp._frameHeader.name;
        fh.dataset.sectionHeader = "top";
        makeSectionCollapsible(fh, "top:" + grp._frameHeader.name, listEl);
      }
      listEl.appendChild(fh);
    }
    if (grp._wsHeader) {
      const wh = buildWsHeader(grp._wsHeader);
      const wsName = typeof grp._wsHeader === "object" ? grp._wsHeader.name : grp._wsHeader;
      const topName = grp._top ? grp._top.name : "";
      wh.dataset.frameName = topName;
      wh.dataset.wsName = wsName;
      wh.dataset.sectionHeader = "ws";
      makeSectionCollapsible(wh, "ws:" + topName + "|" + wsName, listEl);
      listEl.appendChild(wh);
    }

    const decisions = grp.items.filter((it) => (it.record ? it.record.type : it.type) === "decision").length;
    const commitments = grp.items.length - decisions;
    const expanded = _decisionsExpanded.has(grp.key);

    const groupEl = document.createElement("div");
    groupEl.className = "decisions-group";
    if (grp._top) groupEl.dataset.frameName = grp._top.name;   // for section collapse
    if (grp._wsName) { groupEl.classList.add("decisions-group-nested"); groupEl.dataset.wsName = grp._wsName; }

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

    // WP-Priority-Frame-Integration — the urgency tier as a discrete pill on the
    // job row (Act now / Soon / Monitor), so urgency is shown by a control, not by
    // recolouring the prose. Omitted for the quiet tier.
    if (framed && grp._band && BAND_LABEL[grp._band]) {
      const bp = document.createElement("span");
      bp.className = "job-band-pill band-" + grp._band;
      bp.textContent = BAND_LABEL[grp._band];
      head.appendChild(bp);
    }

    const count = document.createElement("span");
    count.className = "decisions-group-count";
    const parts = [];
    if (decisions) parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`);
    if (commitments) parts.push(`${commitments} commitment${commitments === 1 ? "" : "s"}`);
    count.textContent = parts.join(" · ");
    head.appendChild(count);

    // WP-THRESHOLD-NAV Increment 2 — "Open →" into this group's Project home,
    // the aggregate landing page (SoP + every record at every state + inline
    // relationships). Trisha's "where does LAA live?" A span, since the header is
    // a <button>. Shown on the genuine-subject lenses (project + people), never on
    // the "Other"/"Unassigned" catch-all (grp.muted). The whole group — including
    // its workstream siblings under the same top frame — is aggregated by
    // enterProjectHomeView from grp.key.
    if (!grp.muted && (_decisionsLens === "project" || _decisionsLens === "people")) {
      const open = document.createElement("span");
      open.className = "job-open-home-btn";
      open.textContent = "Open →";
      open.setAttribute("role", "button");
      open.tabIndex = 0;
      open.title = "Open the project home — everything about " + grp.label;
      const go = (ev) => { ev.stopPropagation(); enterProjectHomeView(grp.key, { label: grp.label, lens: _decisionsLens, top: grp._top || null }); };
      open.addEventListener("click", go);
      open.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") go(ev); });
      head.appendChild(open);
    }

    // WP-Frame-HITL — the Move control (a span, since the header is a <button>).
    // One click → pick a destination (or a new category); the move sticks.
    if (framed && grp._top) {
      const mv = document.createElement("span");
      mv.className = "job-move-btn";
      mv.textContent = "Move";
      mv.setAttribute("role", "button");
      mv.tabIndex = 0;
      mv.addEventListener("click", (ev) => { ev.stopPropagation(); openMovePicker(mv, grp); });
      head.appendChild(mv);
    }

    // WP-Frame-HITL "adapts" tier — Stage 3 ambient learned suggestion. When an
    // EARNED rule thinks this job belongs elsewhere, show a visible, confirmable
    // chip inline. The user still decides; nothing auto-moves.
    if (framed && grp._top && _learnedSuggestions.has(grp.key)) {
      const s = _learnedSuggestions.get(grp.key);
      const chip = document.createElement("span");
      chip.className = "job-suggestion-chip";
      const lbl = document.createElement("span");
      lbl.className = "job-suggestion-label";
      lbl.textContent = `Suggested: ${s.suggestedFrame}`;
      lbl.title = s.predicateLabel;
      chip.appendChild(lbl);
      const yes = document.createElement("span");
      yes.className = "job-suggestion-yes";
      yes.textContent = "Move";
      yes.setAttribute("role", "button");
      yes.tabIndex = 0;
      yes.addEventListener("click", (ev) => { ev.stopPropagation(); acceptLearnedSuggestion(s); });
      const no = document.createElement("span");
      no.className = "job-suggestion-no";
      no.textContent = "Not this";
      no.setAttribute("role", "button");
      no.tabIndex = 0;
      no.addEventListener("click", (ev) => { ev.stopPropagation(); dismissLearnedSuggestion(s); });
      chip.appendChild(yes);
      chip.appendChild(no);
      head.appendChild(chip);
    }

    // WP-Priority-Frame-Integration — the operator's business-language "why" (no
    // slugs). Uniform colour — the band pill carries urgency, the prose explains.
    if (framed && grp._why) {
      const why = document.createElement("span");
      why.className = "decisions-group-why";
      why.textContent = grp._why;
      head.appendChild(why);
    }

    const body = document.createElement("div");
    body.className = "decisions-group-body";
    body.hidden = !expanded;
    // WP-THRESHOLD-STATE-OF-PLAY — the send-ready digest for this person sits at
    // the top of their group (By-Person lens only; never on Unassigned).
    //
    // WP-WorkForest-Native-SoP consistency pass — under the Work-Forest (framed)
    // project view, individual JOB groups must NOT carry a per-job "State of Play"
    // affordance: the consolidated state of play now lives one level up, on the
    // workstream/frame header (makeSoPToggle), on demand. The per-job button
    // dead-ended with "No open items for {label}" — that's the dead link removed
    // here. The project-altitude email digest is kept only on the PLAIN
    // (un-framed) By-project view, where a group is a genuine project, not a job.
    if (_decisionsLens === "people" && !grp.muted) {
      body.appendChild(buildSopBar(grp.key, grp.label));
    } else if (_decisionsLens === "project" && !grp.muted && !framed) {
      // WP-R3 item 1 — per-project State-of-Play header, at the top of the group.
      // Receipted prose (project altitude) via the shared fetch_sop path; hides
      // itself when unavailable. Sits ABOVE the team-email compose bar.
      body.appendChild(buildProjectSopHeader(grp.key, grp.label));
      // Project altitude — the team email + per-teammate digests for this project.
      body.appendChild(buildProjectSopBar(grp.key, grp.label));
    }
    for (const it of grp.items) {
      const rec = it && it.record ? it.record : it;
      if (!rec) continue;
      const card = renderDecisionCard(rec, it.state, docProjects.get(rec.documentId) || []);
      // MVP-Librarian 2.2 (job-split) — record-level multi-select inside the job
      // detail. A subtle checkbox beside each card; ticking any shows the bulk
      // "Move records to…" bar. Only JOB-grouped records qualify (the move_record
      // override remaps recordId → job, which is meaningless on document-project
      // buckets); unframed job groups qualify too — splitting is how they get filed.
      if (framed && rec.recordId && recordJobs && recordJobs[rec.recordId]) {
        const row = document.createElement("div");
        row.className = "record-select-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "record-select-box";
        cb.title = "Select this record to move it to another job";
        cb.addEventListener("click", (ev) => ev.stopPropagation());
        cb.addEventListener("change", () => {
          if (cb.checked) _bulkRecordSel.set(rec.recordId, grp.label);
          else _bulkRecordSel.delete(rec.recordId);
          updateBulkMoveBar();
        });
        row.appendChild(cb);
        row.appendChild(card);
        body.appendChild(row);
      } else {
        body.appendChild(card);
      }
    }

    // (Per-job SoP removed — the consolidated state of play now lives one level up,
    // on the workstream/frame header, on demand. Jobs no longer carry their own digest.)

    head.addEventListener("click", () => {
      const willExpand = body.hidden;
      body.hidden = !willExpand;
      head.setAttribute("aria-expanded", willExpand ? "true" : "false");
      chev.textContent = willExpand ? "▾" : "▸";
      if (willExpand) { _decisionsExpanded.add(grp.key); }
      else _decisionsExpanded.delete(grp.key);
    });

    // WP-Threshold-Grouping-Canonicalization — project-lens groups get a
    // "Combine with…" affordance beside the header (sibling, never nested in the
    // header <button>). Tap-to-filter on chips is untouched.
    const headRow = document.createElement("div");
    headRow.className = "decisions-group-head-row";
    // MVP-Librarian 2.3 (Trisha C5) — job-level multi-select. A subtle checkbox
    // beside each job row (same gating as the single Move control); ticking any
    // shows the bulk "Move jobs to…" bar, and one destination choice emits N
    // individual `move` events. Sits OUTSIDE the <button> header (inputs can't
    // legally nest inside a button).
    if (framed && grp._top) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "job-select-box";
      cb.title = "Select this job to move it with others";
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) _bulkJobSel.set(grp.key, grp.label);
        else _bulkJobSel.delete(grp.key);
        updateBulkMoveBar();
      });
      headRow.appendChild(cb);
    }
    headRow.appendChild(head);
    // In the framed (Work-Forest) view the legacy per-group project-canon
    // Combine/Rename is replaced by the overlay-backed frame-header menu (Move on
    // jobs; Rename/Merge/Mark-type on the frame). Keep the legacy controls only
    // when frames aren't present (plain By-project).
    if (_decisionsLens === "project" && !grp.muted && !framed) {
      headRow.appendChild(buildProjectGroupActions(grp, ordered));
    }
    groupEl.appendChild(headRow);
    groupEl.appendChild(body);
    listEl.appendChild(groupEl);
  }
  // MVP-Librarian Phase 4 — the nursery shelf: honest abstention made visible.
  // New/uncategorized jobs sit at the BOTTOM of the By-project view, on a shelf
  // (not a frame), each with the Move affordance so the user files them manually.
  if (_decisionsLens === "project" && nursery && nursery.length) {
    listEl.appendChild(buildNurseryShelf(nursery));
  }
  // Fold away any sections the user had collapsed (persists across frame-edit re-renders).
  if (framed) applyFrameCollapse(listEl);
}

// MVP-Librarian Phase 4 — render the nursery shelf. Each entry is a job the
// incremental-ingest path declined to place ({jobKey, jobName, firstSeenTd,
// docIds}); all fields defensive since the backend companion may lag this UI.
// The Move affordance reuses openMovePicker — a nursery job has no home top
// frame, so a new category lands top-level and the move emits the same
// overlay-backed `move` event every filed job gets.
function buildNurseryShelf(nursery) {
  const section = document.createElement("section");
  section.className = "nursery-shelf";

  const header = document.createElement("div");
  header.className = "nursery-header";
  const title = document.createElement("span");
  title.className = "nursery-title";
  title.textContent = "New / uncategorized";
  header.appendChild(title);
  const count = document.createElement("span");
  count.className = "nursery-count";
  count.textContent = String(nursery.length);
  header.appendChild(count);
  section.appendChild(header);

  const hint = document.createElement("div");
  hint.className = "nursery-hint";
  hint.textContent = "New work I haven't filed yet — move each one where it belongs.";
  section.appendChild(hint);

  const rows = document.createElement("div");
  rows.className = "nursery-rows";
  for (const entry of nursery) {
    if (!entry || !entry.jobKey) continue;
    const label = (entry.jobName || "").trim() || jobKeyLabel(entry.jobKey);
    const row = document.createElement("div");
    row.className = "nursery-row";

    const name = document.createElement("span");
    name.className = "nursery-job-name";
    name.textContent = label;
    row.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "nursery-job-meta";
    const docCount = Array.isArray(entry.docIds) ? entry.docIds.length : 0;
    const parts = [`${docCount} ${docCount === 1 ? "doc" : "docs"}`];
    const seen = formatNurseryDate(entry.firstSeenTd);
    if (seen) parts.push(`first seen ${seen}`);
    meta.textContent = parts.join(" · ");
    row.appendChild(meta);

    const mv = document.createElement("span");
    mv.className = "job-move-btn";
    mv.textContent = "Move";
    mv.setAttribute("role", "button");
    mv.tabIndex = 0;
    mv.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openMovePicker(mv, { key: entry.jobKey, label });
    });
    row.appendChild(mv);
    rows.appendChild(row);
  }
  section.appendChild(rows);
  return section;
}

// firstSeenTd arrives in learned-fold-io conventions — usually an ISO-ish date
// string. Format when parseable; otherwise show it verbatim; empty ⇒ omit.
function formatNurseryDate(td) {
  if (td == null) return "";
  const s = String(td).trim();
  if (!s) return "";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return s;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** One compact card for the browser: type chip + state, summary, owner · due,
 *  and project chip(s) — the soft facet, always shown for context. */
// WP-Priority-Frame-Integration — priority band labels (the urgency tier).
const BAND_LABEL = { act_now: "Act now", verify: "Verify", soon: "Soon", monitor: "Monitor" };

// WP-Priority-Frame-Integration step 5 — ActionCandidateView mode labels.
// ───────── WP-Log-Card-Redesign ─────────────────────────────────────────────
// One ACTION badge per card, color-coded by urgency, that carries its object —
// what it's blocked on, how many wait, when it was due — plus a "handle" line
// that jumps to the related record, and a Share draft for decisions-to-share.
// All derived from data already in _decisionsCtx (actionKinds, edges, byId).
// commitment_due / follow_up get no badge (they'd echo the type label + due).
const ACTION_BADGE_CLASS = {
  blocked_work: "is-blocked",
  stale_commitment: "is-overdue",
  contradiction_to_resolve: "is-conflict",
  dependency_to_unblock: "is-waiting",
  decision_needed: "is-decision",
  decision_to_broadcast: "is-neutral",
};

function shortenSummary(s, max) {
  s = (s || "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

function recordById(ctx, id) {
  return id && ctx.byId ? ctx.byId.get(id) : null;
}

// WP-R3 item 3 — resolve a record's lifecycle state (open/superseded/resolved)
// from the live context. byId holds bare records (no state); the {record,state}
// envelopes live on ctx.items, so scan those. Defaults to "open" when unknown so
// the dependency popover's status pill only shows for genuinely-closed ends.
function recordStateById(ctx, id) {
  if (!id || !ctx || !Array.isArray(ctx.items)) return "open";
  for (const it of ctx.items) {
    const rec = it && it.record ? it.record : it;
    if (rec && rec.recordId === id) return (it && it.state) || "open";
  }
  return "open";
}

// depends_on edges (recordA depends on recordB — A blocked, B the unblocker).
function dependencyEdges(ctx) {
  return (ctx.edges || []).filter((e) => e.kind === "depends_on" && e.status !== "dismissed");
}

// Reveal a record's card: expand its group if collapsed, scroll to it, flash.
function jumpToRecord(recordId) {
  if (!recordId) return;
  const sel = window.CSS && CSS.escape ? CSS.escape(recordId) : recordId;
  const target = document.querySelector(`.decision-card[data-record-id="${sel}"]`);
  if (!target) return;
  const body = target.closest(".decisions-group-body");
  if (body && body.hidden) {
    body.hidden = false;
    const head = body.parentElement && body.parentElement.querySelector("[aria-expanded]");
    if (head) {
      head.setAttribute("aria-expanded", "true");
      const chev = head.querySelector(".decisions-group-chevron");
      if (chev) chev.textContent = "▾";
    }
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.remove("record-card-flash");
  void target.offsetWidth;
  target.classList.add("record-card-flash");
  setTimeout(() => target.classList.remove("record-card-flash"), 1600);
}

// Prior corpus items this record links to (for the Share context). recordA is
// the acting/later/dependent end of the directional edge kinds.
function relatedItemsFor(rec, ctx) {
  const out = [];
  for (const e of ctx.edges || []) {
    if (e.status === "dismissed") continue;
    const isA = e.recordA === rec.recordId;
    const isB = e.recordB === rec.recordId;
    if (!isA && !isB) continue;
    const other = recordById(ctx, isA ? e.recordB : e.recordA);
    if (!other) continue;
    let phrase;
    switch (e.kind) {
      case "resolves": phrase = isA ? "Resolves" : "Resolved by"; break;
      case "supersedes": phrase = isA ? "Replaces" : "Replaced by"; break;
      case "depends_on": phrase = isA ? "Depends on" : "Unblocks"; break;
      case "duplicates": phrase = "Duplicate of"; break;
      case "contradicts": phrase = "Conflicts with"; break;
      default: phrase = "Relates to";
    }
    out.push({ phrase, otherId: other.recordId, summary: other.summary || "" });
  }
  return out;
}

// The action pill itself is the affordance — clickable when it has an object:
// blocked/waiting/conflict jump to the related record, decision-to-share opens
// the draft. The object detail lives in the pill's tooltip (title), so there is
// no separate line. A pill with no action is a plain span.
function makeBadge(cls, text, opts) {
  opts = opts || {};
  const el = document.createElement(opts.onClick ? "button" : "span");
  el.className = "record-action-badge " + cls + (opts.onClick ? " is-clickable" : "");
  el.textContent = text;
  if (opts.title) el.title = opts.title;
  if (opts.onClick) {
    el.type = "button";
    el.addEventListener("click", (e) => { e.stopPropagation(); opts.onClick(el, e); });
  }
  return el;
}

function buildActionBadge(rec, ctx) {
  const ak = ctx.actionKinds && ctx.actionKinds[rec.recordId];
  if (!ak || !ak.kind) return null;
  const cls = ACTION_BADGE_CLASS[ak.kind];
  if (!cls) return null; // commitment_due / follow_up — no badge
  const deps = dependencyEdges(ctx);

  if (ak.kind === "blocked_work") {
    const e = deps.find((d) => d.recordA === rec.recordId);
    const blocker = e && recordById(ctx, e.recordB);
    if (blocker) {
      return makeBadge("is-blocked", "Blocked", {
        title: "Blocked by: " + (blocker.summary || "") + " — click to see it",
        onClick: (el) => openLinkedMenu(el, "This is blocked by", [blocker]),
      });
    }
    return makeBadge("is-blocked", "Blocked");
  }
  if (ak.kind === "dependency_to_unblock") {
    const waiters = deps.filter((d) => d.recordB === rec.recordId);
    const recs = waiters.map((d) => recordById(ctx, d.recordA)).filter(Boolean);
    const label = recs.length ? `${recs.length} waiting` : "Others waiting";
    if (recs.length) {
      const noun = recs.length === 1 ? "item is" : "items are";
      return makeBadge("is-waiting", label, {
        title: `${recs.length} ${noun} waiting on this — click to see ${recs.length === 1 ? "it" : "them"}`,
        onClick: (el) => openLinkedMenu(el, `Waiting on this (${recs.length})`, recs),
      });
    }
    return makeBadge("is-waiting", label);
  }
  if (ak.kind === "stale_commitment") {
    return makeBadge("is-overdue", rec.due ? "Overdue · due " + formatDueDate(rec.due) : "Overdue");
  }
  if (ak.kind === "contradiction_to_resolve") {
    const e = (ctx.edges || []).find(
      (d) => d.kind === "contradicts" && d.status !== "dismissed" &&
        (d.recordA === rec.recordId || d.recordB === rec.recordId),
    );
    const other = e && recordById(ctx, e.recordA === rec.recordId ? e.recordB : e.recordA);
    if (other) {
      return makeBadge("is-conflict", "Conflict", {
        title: "Conflicts with: " + (other.summary || "") + " — click to see it",
        onClick: (el) => openLinkedMenu(el, "Conflicts with", [other]),
      });
    }
    return makeBadge("is-conflict", "Conflict");
  }
  if (ak.kind === "decision_needed") {
    return makeBadge("is-decision", "Decision needed");
  }
  if (ak.kind === "decision_to_broadcast") {
    // Action verb, not a noun label (Trisha 2026-06-29: "decision to share" read
    // like a label; needs to look like a button that does something).
    return makeBadge("is-decision", "Share decision", {
      title: "Click to draft a note sharing this decision",
      onClick: (el) => openShareMenu(el, rec, ctx),
    });
  }
  return null;
}

// Share-draft popover: what the decision is, how it ties back to prior corpus
// items, and a ready-to-send note with Copy. Deterministic (no LLM). Reuses the
// dismiss-menu single-open infra (_openReasonMenu / closeDismissReasonMenu).
function buildShareDraft(rec, related, who) {
  const firstName = who ? who.split(/[ ,]/)[0] : "";
  const summary = (rec.summary || "").trim();
  const verbatim = (rec.verbatim || "").trim();
  const lines = [];
  if (firstName) lines.push(`Hi ${firstName},`, "");
  lines.push("Sharing a decision from our recent work:");
  lines.push("");
  lines.push("• " + summary);
  // The decision in its own words (the source line), so the note carries WHAT
  // was decided, not just the one-line label. Skipped when it just echoes it.
  if (verbatim && verbatim.toLowerCase() !== summary.toLowerCase()) {
    lines.push("");
    lines.push("What was decided: “" + verbatim + "”");
  }
  // The single most useful tie-back to prior work, if any. Full text — this is an
  // email draft, not a chip; nothing here should be truncated with an ellipsis.
  const VERB = { Resolves: "This resolves", Replaces: "This replaces", Unblocks: "This unblocks", "Depends on": "This depends on", "Relates to": "Related to" };
  const ctxItem = related.find((r) => VERB[r.phrase]);
  if (ctxItem) {
    lines.push("");
    lines.push(`${VERB[ctxItem.phrase]}: ${ctxItem.summary}`);
  }
  lines.push("", "Happy to talk it through.");
  return lines.join("\n");
}

// WP-Job-Vigilance-Wave2 UI — the follow-up flavour of the share draft: a nudge to
// the person we're waiting on about the outstanding promise, rather than a
// decision broadcast. Same deterministic shape as buildShareDraft; consumed by
// openShareMenu via the draftBuilder opt so the editor UI is reused unchanged.
function buildFollowUpDraft(rec, _related, who) {
  // Prefer the record owner (the person who made the promise) for the greeting.
  const target = who || rec.owner || "";
  const firstName = target ? prettySlug(target).split(/[ ,]/)[0] : "";
  const summary = (rec.summary || "").trim();
  const verbatim = (rec.verbatim || "").trim();
  const lines = [];
  if (firstName) lines.push(`Hi ${firstName},`, "");
  lines.push("Following up on this — wanted to check where it stands:");
  lines.push("");
  if (summary) lines.push("• " + summary);
  // The promise in its own words (the source line), when it adds beyond the label.
  if (verbatim && verbatim.toLowerCase() !== summary.toLowerCase()) {
    lines.push("");
    lines.push("Original note: “" + verbatim + "”");
  }
  lines.push("", "No rush if it's in hand — just let me know the status when you get a chance.");
  return lines.join("\n");
}

// WP-Edit-Capture — record how the user changed our generated share draft, as a
// retained event on the decision-log overlay (same /edit event log as the inline
// field edits). Best-effort: a capture failure must never block the share. Only
// the delta is a signal — an unchanged draft says our generation was good enough.
async function captureShareDraftEdit(rec, generated, finalText, action) {
  if (!rec || !rec.recordId) return;
  const from = (generated || "").trim();
  const to = (finalText || "").trim();
  if (!to || from === to) return;
  try {
    await tauri.core.invoke("edit_record", {
      recordId: rec.recordId,
      editType: "share_draft",
      edits: [{ field: "share_draft", from: generated, to: finalText, type: "share_draft", action }],
    });
  } catch (e) {
    console.warn("[main] share-draft edit capture failed (non-blocking):", e);
  }
}

// Shared viewport-fit positioning for the card popovers: open below the anchor
// if there's room, flip above when not, else cap height + scroll on the larger
// side. Keeps the content reachable on a small window.
function positionPopover(menu, anchorBtn) {
  const r = anchorBtn.getBoundingClientRect();
  const margin = 8;
  menu.style.position = "fixed";
  menu.style.left = `${Math.round(Math.min(Math.max(margin, r.left), window.innerWidth - menu.offsetWidth - margin))}px`;
  const spaceBelow = window.innerHeight - r.bottom - margin;
  const spaceAbove = r.top - margin;
  const needed = menu.offsetHeight;
  if (needed <= spaceBelow) {
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
  } else if (needed <= spaceAbove) {
    menu.style.top = `${Math.round(r.top - needed - 4)}px`;
  } else if (spaceBelow >= spaceAbove) {
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.maxHeight = `${Math.round(spaceBelow)}px`;
  } else {
    menu.style.top = `${margin}px`;
    menu.style.maxHeight = `${Math.round(spaceAbove)}px`;
  }
}

// A compact read-only view of a linked record, shown inline in the dependency
// popover so the relationship is visible in place — no jumping away (Trisha
// 2026-06-29: the jump is disorienting with no way back).
//
// WP-R3 item 3 (relationships fold-in) — the popover now shows the OTHER end's
// full context inline: owner, a status pill (open / resolved / replaced), and —
// per §2.4 — its evidence (verbatim quote + jump-to-source) through the ONE
// renderReceipt component, exactly like every other receipted surface. Trisha's
// explicit ask was the edge context IN PLACE on the record, not a navigation to
// the retired global edges view. `recState` is the linked record's lifecycle
// state (optional; the caller resolves it from the live context's state map).
function renderLinkedRecord(rec, recState) {
  const row = document.createElement("div");
  row.className = "linked-rec";
  row.dataset.type = rec.type || "";
  if (recState) row.dataset.state = recState;
  const head = document.createElement("div");
  head.className = "linked-rec-head";
  const t = document.createElement("span");
  t.className = "linked-rec-type";
  t.dataset.type = rec.type || "";
  t.textContent = recordTypeLabel(rec);
  head.appendChild(t);
  // Status pill — mirrors the record card's lifecycle pill so the popover shows
  // whether the other end is still standing (open) or already closed. Only when
  // the state is known and non-open (an open item needs no pill — that's the norm).
  if (recState && recState !== "open") {
    const pill = document.createElement("span");
    pill.className = "linked-rec-state";
    pill.dataset.state = recState;
    pill.textContent = recState === "superseded" ? "Replaced" : "Resolved";
    head.appendChild(pill);
  }
  const bits = [];
  if (rec.owner) bits.push(prettySlug(rec.owner));
  if (rec.due) bits.push("due " + formatDueDate(rec.due));
  if (bits.length) {
    const meta = document.createElement("span");
    meta.className = "linked-rec-meta";
    meta.textContent = bits.join(" · ");
    head.appendChild(meta);
  }
  row.appendChild(head);
  const sum = document.createElement("div");
  sum.className = "linked-rec-summary";
  sum.textContent = rec.summary || "";
  row.appendChild(sum);
  // Evidence — the linked record's verbatim quote + jump-to-source, via the ONE
  // receipt component (§2.4). renderReceipt renders nothing when there's no
  // verified verbatim and no documentId, so a bare record adds no empty block;
  // when the source pane is reachable (doc in _docsById) the badge opens it.
  if ((rec.verbatimVerified === true && rec.verbatim) || rec.documentId) {
    row.appendChild(
      renderReceipt(
        {
          verbatim: rec.verbatim,
          verbatimVerified: rec.verbatimVerified,
          documentId: rec.documentId,
        },
        { variant: "receipt-linked", compact: true },
      ),
    );
  }
  // Optional: jump to the item in the list (closes the popover first).
  if (rec.recordId) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "linked-rec-jump";
    jump.textContent = "Jump to item →";
    jump.addEventListener("click", (e) => {
      e.stopPropagation();
      closeDismissReasonMenu();
      jumpToRecord(rec.recordId);
    });
    row.appendChild(jump);
  }
  return row;
}

// Dependency popover — shows the blocker / waiting / conflicting record(s) inline
// under the pill, anchored + viewport-fit. Reuses the single-open menu infra.
function openLinkedMenu(anchorBtn, heading, recs) {
  const wasOpen = !!_openReasonMenu;
  closeDismissReasonMenu();
  if (wasOpen) return;
  recs = (recs || []).filter(Boolean);
  if (!recs.length) return;

  const menu = document.createElement("div");
  menu.className = "record-reason-menu record-linked-menu";
  menu.setAttribute("role", "dialog");

  const h = document.createElement("div");
  h.className = "record-reason-heading";
  h.textContent = heading;
  menu.appendChild(h);

  // WP-R3 item 3 — thread each linked record's lifecycle state through so the
  // popover shows its status pill + receipted evidence in place.
  const ctx = _decisionsCtx || {};
  for (const rec of recs) menu.appendChild(renderLinkedRecord(rec, recordStateById(ctx, rec.recordId)));

  document.body.appendChild(menu);
  positionPopover(menu, anchorBtn);
  _openReasonMenu = menu;
  setTimeout(() => {
    document.addEventListener("click", _onOutsideReasonClick, true);
    document.addEventListener("keydown", _onReasonMenuKeydown, true);
  }, 0);
}

// The inline editable-draft popover. Default mode is the Log's "Share decision"
// flow; `opts` GENERALIZES it so other surfaces (e.g. the Watching follow-up)
// reuse the SAME editor UI with their own draft text + titling instead of forking
// it. opts: { draftBuilder(rec, related, who)->string, heading(who)->string,
// title(rec)->string, sourceKind, idPrefix }. Omitted fields fall back to the
// decision-share defaults, so the existing Log call site is unchanged in behavior.
function openShareMenu(anchorBtn, rec, ctx, opts) {
  opts = opts || {};
  const draftBuilder = opts.draftBuilder || buildShareDraft;
  const headingFor = opts.heading || ((w) => (w ? "Share with " + w : "Share this decision"));
  const titleFor = opts.title || ((r) => (r.summary ? "Share decision: " + r.summary : "Share decision"));
  const sourceKind = opts.sourceKind || "decision";
  const idPrefix = opts.idPrefix || "share:";

  const wasOpen = !!_openReasonMenu;
  closeDismissReasonMenu();
  if (wasOpen) return;

  const rel = ctx.recordRelationship && ctx.recordRelationship[rec.recordId];
  const who = rel && rel.counterparty ? rel.counterparty : null;
  const related = relatedItemsFor(rec, ctx);

  const menu = document.createElement("div");
  menu.className = "record-reason-menu record-share-menu";
  menu.setAttribute("role", "dialog");

  const heading = document.createElement("div");
  heading.className = "record-reason-heading";
  heading.textContent = headingFor(who);
  menu.appendChild(heading);

  const what = document.createElement("div");
  what.className = "record-share-what";
  what.textContent = rec.summary || "";
  menu.appendChild(what);

  if (related.length) {
    const ctxLbl = document.createElement("div");
    ctxLbl.className = "record-share-ctxlabel";
    ctxLbl.textContent = "Relates to";
    menu.appendChild(ctxLbl);
    for (const r of related.slice(0, 3)) {
      const other = recordById(ctx, r.otherId);
      const line = document.createElement("button");
      line.type = "button";
      line.className = "record-share-ctxitem";
      line.textContent = r.phrase + ": " + shortenSummary(r.summary, 56);
      if (other) {
        line.addEventListener("click", (e) => {
          e.stopPropagation();
          openLinkedMenu(line, r.phrase, [other]);
        });
      }
      menu.appendChild(line);
    }
  }

  const draft = document.createElement("textarea");
  draft.className = "record-share-draft";
  draft.value = draftBuilder(rec, related, who);
  // Snapshot what WE generated, so a send/copy can record how the user changed it
  // — the learning signal for how the engine's drafting is off (WP-Edit-Capture).
  const generatedDraft = draft.value;
  // Grow to fit the whole draft so nothing is clipped; the popover itself scrolls
  // if the result is very tall. Re-runs as the user edits.
  const autosizeDraft = () => {
    draft.style.height = "auto";
    draft.style.height = Math.min(draft.scrollHeight + 2, 700) + "px";
  };
  draft.addEventListener("input", autosizeDraft);
  menu.appendChild(draft);

  // Same two affordances as every other drafted email: stage it into the Outlook
  // threshold queue (Outbox + add-in) via the shared producer path, or copy it.
  const btnRow = document.createElement("div");
  btnRow.className = "record-share-actions";

  const send = document.createElement("button");
  send.type = "button";
  send.className = "record-reason-item record-share-send";
  send.textContent = "Send to Outbox";
  send.addEventListener("click", (e) => {
    e.stopPropagation();
    captureShareDraftEdit(rec, generatedDraft, draft.value, "outbox");
    stageOutboxDraft({
      id: idPrefix + (rec.recordId || rec.summary || ""),
      title: titleFor(rec),
      detail: draft.value,
      detailGenerated: generatedDraft, // what we drafted, so the server can keep the delta
      intent: "email",
      executor: who || rec.owner || undefined,
      sourceKind,
      sourceLabel: rec.summary || rec.recordId || "",
    });
    closeDismissReasonMenu();
  });
  btnRow.appendChild(send);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "record-reason-item record-share-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    try { navigator.clipboard.writeText(draft.value); } catch (_) { draft.select(); document.execCommand("copy"); }
    captureShareDraftEdit(rec, generatedDraft, draft.value, "copy");
    copy.textContent = "Copied ✓";
    setTimeout(() => { copy.textContent = "Copy"; }, 1200);
  });
  btnRow.appendChild(copy);

  menu.appendChild(btnRow);

  document.body.appendChild(menu);
  autosizeDraft(); // size to content now that it's in the DOM, before positioning
  positionPopover(menu, anchorBtn);
  // Re-measure after layout settles (first pass can under-measure scrollHeight),
  // then re-fit the popover to the viewport.
  requestAnimationFrame(() => { autosizeDraft(); positionPopover(menu, anchorBtn); });
  _openReasonMenu = menu;
  setTimeout(() => {
    document.addEventListener("click", _onOutsideReasonClick, true);
    document.addEventListener("keydown", _onReasonMenuKeydown, true);
  }, 0);
}

function renderDecisionCard(rec, recState, projects) {
  const card = document.createElement("div");
  card.className = "record-card decision-card";
  card.dataset.type = rec.type || "";
  if (recState) card.dataset.state = recState;

  // WP-Log-Card-Redesign — two-zone header: muted TYPE label (left) + one
  // colored ACTION badge (right). A non-open record shows its lifecycle pill in
  // the action slot instead.
  const ctx = _decisionsCtx || {};
  card.dataset.recordId = rec.recordId || "";

  const header = document.createElement("div");
  header.className = "record-header record-header-split";

  const typeLabel = document.createElement("span");
  typeLabel.className = "record-type-label";
  typeLabel.dataset.type = rec.type || "";
  typeLabel.textContent = recordTypeLabel(rec);
  header.appendChild(typeLabel);

  const isOpen = !recState || recState === "open";
  if (!isOpen) {
    const pill = document.createElement("span");
    pill.className = "record-state-pill";
    pill.dataset.state = recState;
    pill.textContent = recState === "superseded" ? "Replaced" : "Resolved";
    header.appendChild(pill);
  } else {
    const badge = buildActionBadge(rec, ctx);
    if (badge) header.appendChild(badge);
  }
  card.appendChild(header);

  const summary = document.createElement("p");
  summary.className = "record-summary";
  summary.textContent = rec.summary || "";
  card.appendChild(summary);

  // Relationship ("who") + owner·due on one line.
  {
    const metaRow = document.createElement("div");
    metaRow.className = "record-rel-meta";
    const rel = ctx.recordRelationship && ctx.recordRelationship[rec.recordId];
    if (rel && rel.relationship) {
      const rc = document.createElement("span");
      rc.className = "record-rel-chip";
      const word = rel.relationship.charAt(0).toUpperCase() + rel.relationship.slice(1);
      rc.textContent = rel.counterparty ? `${word} · ${rel.counterparty}` : word;
      if (rel.relationshipWhy || rel.why) rc.title = rel.relationshipWhy || rel.why;
      metaRow.appendChild(rc);
    }
    const meta = document.createElement("p");
    meta.className = "record-meta";
    const segCount = buildRecordMetaSegments(meta, rec);
    if (segCount) metaRow.appendChild(meta);
    if (metaRow.childNodes.length) card.appendChild(metaRow);
  }

  // Per-record project chips removed: they showed the source document's flat tag
  // list, which collided with the top-level "projects" (frames) hierarchy and was
  // misleading. A record is already shown under its project (frame) + job, so the
  // chip row was redundant. (`projects` param kept for call-site compatibility.)

  // Actions: drill-down to Receipts (when the record has a subject) + Dismiss.
  const actions = document.createElement("div");
  actions.className = "record-actions";
  if (rec.primaryEntity) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-link receipts-entry-btn";
    btn.textContent = "Show receipts →";
    // WP-Grouping-Operator P4 — open the JOB's receipts (its full action set +
    // canonical name) when the record is job-grouped; else the entity's. Hot-
    // list records' primaryEntity is the section (e.g. "rsv"), so preferring
    // parentJob is what reaches a job's receipts instead of section-receipts.
    btn.addEventListener("click", () =>
      enterReceiptsView((rec.parentJob || "").replace(/^job:/, "") || rec.primaryEntity));
    actions.appendChild(btn);
  }
  appendSourceBadge(actions, rec.documentId, rec.verbatim);
  appendResolveSnoozeControls(actions, rec.recordId, card, rec.summary);
  appendDraftFollowUpControl(actions, rec);
  appendDismissControl(actions, rec.recordId, card, rec.summary);
  card.appendChild(actions);

  applyRecordCardEditing(card, rec);
  return card;
}

// ───────── WP-THRESHOLD-NAV Increment 2 — Project home ─────────
//
// The single most-requested missing surface (Trisha 2026-06-17: "where does LAA
// live?"). A group-scoped landing page that aggregates EVERYTHING about one
// project / job / subject in one place — its State-of-Play narrative, typed
// counts, a project-scoped relationships summary, and every record at every
// lifecycle state (not just open) as the SAME renderDecisionCard cards the Log
// uses (so each carries its inline relationships via the dependency popover).
// Generalizes the entity-scoped Receipts view to any grouping key.
//
// Pure client-side aggregation over the already-fetched _decisionsCtx — no new
// IPC. Degrades gracefully: if _decisionsCtx isn't loaded yet (project home was
// somehow reached cold) it fetches the Log first; single-project / frameless
// corpora resolve to the one matching group and render sensibly (never blank).

let _projectHomeCtx = null; // { key, label, top } — for the Refresh button.

// Resolve the aggregate item set + a SoP slug for a project-home request.
// `key` is either "frame:<name>" (aggregate every job under that top frame) or a
// group key (a single job / document-project group). `opts.top` (a top frame),
// when present, widens the aggregation to the WHOLE project (all its job groups).
// Returns { items, label, sopSlug, top }.
function resolveProjectAggregate(ctx, key, opts) {
  opts = opts || {};
  const items = Array.isArray(ctx.items) ? ctx.items : [];
  // Rebuild the groups over ALL states (the home shows resolved + replaced too),
  // in the SAME lens the entry came from — project (default) or people — so the
  // key resolves against the matching grouping. Then, for the project lens with
  // frames, annotate with the top frame exactly like the Log.
  const lens = opts.lens === "people" ? "people" : "project";
  let groups = groupRecords(items, lens, ctx.docProjects, ctx.aliases, ctx.jobNames, ctx.recordJobs);
  const frames = Array.isArray(ctx.frames) ? ctx.frames : [];
  if (lens === "project" && frames.length) {
    // applyFrameLayout tags each group with _top; reuse it so "the whole project"
    // = every group under the same top frame (matching the Log's grouping).
    groups = applyFrameLayout(groups, frames, ctx.jobHeat || {});
  }

  const topName = lens === "project"
    ? (opts.top && opts.top.name ? opts.top.name : (key.startsWith("frame:") ? key.slice("frame:".length) : null))
    : null;
  let selected;
  let label;
  let sopSlug;
  if (topName) {
    // Whole-project aggregation: every job group whose top frame matches by name.
    selected = groups.filter((g) => g._top && g._top.name === topName);
    // Fallback: if frame layout produced no _top match (flag drift), fall back to
    // the exact-key group so the surface still renders something coherent.
    if (!selected.length) selected = groups.filter((g) => g.key === key);
    label = (opts.label && String(opts.label)) || topName;
    // Frame-altitude SoP keys off the frame name; the per-project SoP header
    // reuses loadSoP("project", slug) — pass the top frame's name as the subject.
    sopSlug = topName;
  } else {
    selected = groups.filter((g) => g.key === key);
    label = (opts.label && String(opts.label)) || (selected[0] && selected[0].label) || prettySlug(key);
    sopSlug = key;
  }

  const agg = [];
  for (const g of selected) for (const it of g.items) agg.push(it);
  return { items: agg, label, sopSlug, top: opts.top || null };
}

// Typed tally chips — decisions vs commitments, and open / resolved / replaced.
// Addresses the spec's "260 open → typed" nit: the counts are labelled by TYPE
// and lifecycle state, not a bare number.
function renderProjectHomeTallies(container, items) {
  container.innerHTML = "";
  let decisions = 0, commitments = 0, open = 0, resolved = 0, replaced = 0;
  for (const it of items) {
    const rec = it && it.record ? it.record : it;
    if (!rec) continue;
    if (rec.type === "decision") decisions++; else commitments++;
    const st = (it && it.state) || "open";
    if (st === "superseded") replaced++;
    else if (st === "resolved") resolved++;
    else open++;
  }
  const chips = [
    ["decisions", decisions, decisions === 1 ? "decision" : "decisions"],
    ["commitments", commitments, commitments === 1 ? "commitment" : "commitments"],
    ["open", open, "open"],
    ["resolved", resolved, "resolved"],
    ["replaced", replaced, "replaced"],
  ];
  for (const [cls, n, label] of chips) {
    if (!n) continue; // omit empty buckets — a settled project shouldn't shout "0 open"
    const chip = document.createElement("span");
    chip.className = "project-home-tally project-home-tally-" + cls;
    const num = document.createElement("strong");
    num.className = "project-home-tally-num";
    num.textContent = String(n);
    chip.appendChild(num);
    chip.appendChild(document.createTextNode(" " + label));
    container.appendChild(chip);
  }
  container.hidden = container.childNodes.length === 0;
}

// Project-scoped relationships summary — the item-first "what depends on what"
// for this project, surfaced IN PLACE (finding G). Reuses the SAME dependency
// popover the Log cards use (openLinkedMenu → renderLinkedRecord): each line is a
// clickable pill that reveals the other end inline, no jump. Renders only the
// edges whose BOTH ends live in this project's record set, so it stays scoped.
function renderProjectHomeRelationships(container, ctx, items) {
  container.innerHTML = "";
  const ids = new Set();
  for (const it of items) {
    const rec = it && it.record ? it.record : it;
    if (rec && rec.recordId) ids.add(rec.recordId);
  }
  // Edges internal to this project (both ends present) — the ones worth summarizing.
  const edges = (ctx.edges || []).filter(
    (e) => e.status !== "dismissed" && ids.has(e.recordA) && ids.has(e.recordB),
  );
  if (!edges.length) { container.hidden = true; return; }
  container.hidden = false;

  const head = document.createElement("div");
  head.className = "project-home-rels-head";
  head.textContent = "Relationships in this project";
  container.appendChild(head);

  // One clickable line per edge, grouped by kind (dependencies first — the most-
  // requested), reusing the Log's phrasing + inline dependency popover.
  const ordered = [...edges].sort(
    (a, b) => EDGE_KIND_ORDER.indexOf(a.kind) - EDGE_KIND_ORDER.indexOf(b.kind),
  );
  const list = document.createElement("div");
  list.className = "project-home-rels-list";
  for (const e of ordered) {
    const a = recordById(ctx, e.recordA);
    const b = recordById(ctx, e.recordB);
    if (!a || !b) continue;
    const meta = EDGE_KIND_META[e.kind] || { verb: "relates to", icon: "↔" };
    const line = document.createElement("button");
    line.type = "button";
    line.className = "project-home-rel-line";
    const icon = document.createElement("span");
    icon.className = "project-home-rel-icon";
    icon.textContent = meta.icon || "↔";
    line.appendChild(icon);
    const txt = document.createElement("span");
    txt.className = "project-home-rel-text";
    txt.textContent = shortenSummary(a.summary, 46) + " · " + meta.verb + " · " + shortenSummary(b.summary, 46);
    line.appendChild(txt);
    // Click reveals both ends inline via the shared dependency popover (no jump).
    line.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openLinkedMenu(line, meta.plural || meta.label || "Related", [a, b]);
    });
    list.appendChild(line);
  }
  container.appendChild(list);
}

// Open the Project home for a grouping key. `opts`: { label, lens, top }.
async function enterProjectHomeView(key, opts) {
  opts = opts || {};
  state.inWizard = false;
  showView("view-project-home");
  _projectHomeCtx = { key, label: opts.label, top: opts.top || null, lens: opts.lens || "project" };

  const titleEl = document.getElementById("project-home-title");
  const eyebrowEl = document.getElementById("project-home-eyebrow");
  const subEl = document.getElementById("project-home-sub");
  const talliesEl = document.getElementById("project-home-tallies");
  const sopEl = document.getElementById("project-home-sop");
  const relsEl = document.getElementById("project-home-rels");
  const listEl = document.getElementById("project-home-list");
  const statusEl = document.getElementById("project-home-status");

  // Breadcrumb: Today › Log › <Project>. Back returns to the Log (its context is
  // preserved — the Log's own state vars are untouched by this view).
  const backToLog = () => enterDecisionsView(undefined, { from: "home" });
  setNav(
    [
      { label: "Log", go: backToLog },
      { label: opts.label ? String(opts.label) : prettySlug(key) },
    ],
    { active: "log", back: backToLog },
  );

  if (eyebrowEl) eyebrowEl.textContent = opts.lens === "people" ? "Person" : "Project";
  if (titleEl) titleEl.textContent = opts.label ? String(opts.label) : prettySlug(key);
  if (subEl) subEl.textContent = "";
  if (talliesEl) { talliesEl.innerHTML = ""; talliesEl.hidden = true; }
  if (sopEl) sopEl.innerHTML = "";
  if (relsEl) { relsEl.innerHTML = ""; relsEl.hidden = true; }
  if (listEl) listEl.innerHTML = "";
  if (statusEl) { statusEl.hidden = false; statusEl.dataset.kind = "loading"; statusEl.textContent = "Gathering everything for this project…"; }

  // Ensure the Log context is loaded (aggregation reads it). Normal entry is from
  // within the Log, so it's already populated; this covers a cold/edge entry.
  let ctx = _decisionsCtx;
  if (!ctx || !Array.isArray(ctx.items) || !ctx.items.length) {
    try {
      await loadDocsMap();
      const data = await tauri.core.invoke("fetch_decision_log_full");
      const raw = withoutDismissed(Array.isArray(data && data.records) ? data.records : []);
      const byId = new Map();
      for (const it of raw) { const r = it && it.record ? it.record : it; if (r && r.recordId) byId.set(r.recordId, r); }
      const docProjects = new Map();
      try {
        const docsResp = await tauri.core.invoke("fetch_documents");
        const docs = docsResp && Array.isArray(docsResp.documents) ? docsResp.documents : [];
        for (const d of docs) if (d && d.id) docProjects.set(d.id, Array.isArray(d.projects) ? d.projects : []);
      } catch (_e) { /* projects omitted */ }
      ctx = {
        items: raw, docProjects, byId,
        edges: Array.isArray(data && data.edges) ? data.edges : [],
        aliases: (data && data.aliases) || {}, jobNames: (data && data.jobNames) || {},
        recordJobs: (data && data.recordJobs) || {}, frames: Array.isArray(data && data.frames) ? data.frames : [],
        jobHeat: (data && data.jobHeat) || {}, actionKinds: (data && data.actionKinds) || {},
        recordRelationship: (data && data.recordRelationship) || {},
      };
      _decisionsCtx = ctx; // share it so cards' badges/popovers resolve normally
    } catch (err) {
      console.warn("[main] project home cold fetch failed:", err);
      if (statusEl) { statusEl.hidden = false; statusEl.dataset.kind = "error"; statusEl.textContent = "Couldn't reach Apolla. Check your connection, then Refresh."; }
      return;
    }
  }

  const agg = resolveProjectAggregate(ctx, key, opts);
  if (titleEl) titleEl.textContent = agg.label;

  if (!agg.items.length) {
    // Graceful empty state — never blank/error.
    if (statusEl) { statusEl.hidden = false; statusEl.dataset.kind = "empty"; statusEl.textContent = "Nothing has landed under " + agg.label + " yet."; }
    return;
  }
  if (statusEl) statusEl.hidden = true;

  // Sub-line: a plain sentence of what this page is.
  if (subEl) {
    const n = agg.items.length;
    subEl.textContent = `Everything about ${agg.label} — ${n} ${n === 1 ? "record" : "records"} across every state.`;
  }

  // ① Typed tallies.
  if (talliesEl) renderProjectHomeTallies(talliesEl, agg.items);

  // ② State-of-Play — reuse the Log's per-project SoP header (narrative, receipted,
  //    self-hides when unavailable) + the team-email compose bar. Keyed by the
  //    resolved slug. Degrades silently on frameless / SoP-less corpora.
  if (sopEl) {
    sopEl.appendChild(buildProjectSopHeader(agg.sopSlug, agg.label));
    sopEl.appendChild(buildProjectSopBar(agg.sopSlug, agg.label));
  }

  // ③ Project-scoped relationships summary (inline popover, no jump).
  if (relsEl) renderProjectHomeRelationships(relsEl, ctx, agg.items);

  // ④ Every record — same cards as the Log, so inline relationships (Blocked by /
  //    Replaces / Conflicts with) come free via buildActionBadge + the popover.
  //    Ordered open-first, then by due date, so the actionable items lead.
  if (listEl) {
    const ordered = [...agg.items].sort((x, y) => {
      const sx = (x && x.state) || "open", sy = (y && y.state) || "open";
      const rank = (s) => (s === "open" ? 0 : s === "resolved" ? 1 : 2);
      if (rank(sx) !== rank(sy)) return rank(sx) - rank(sy);
      const rx = x.record || x, ry = y.record || y;
      const dx = rx && rx.due ? rx.due : "9999-99-99";
      const dy = ry && ry.due ? ry.due : "9999-99-99";
      return dx < dy ? -1 : dx > dy ? 1 : 0;
    });
    for (const it of ordered) {
      const rec = it && it.record ? it.record : it;
      if (!rec) continue;
      listEl.appendChild(renderDecisionCard(rec, it.state, (ctx.docProjects && ctx.docProjects.get(rec.documentId)) || []));
    }
  }
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

const decisionsRefreshBtn = document.getElementById("btn-decisions-refresh");
if (decisionsRefreshBtn) decisionsRefreshBtn.addEventListener("click", () => enterDecisionsView(_decisionsFilter));

// WP-THRESHOLD-NAV Increment 2 — Project home Refresh re-fetches the Log context
// then re-aggregates (re-enters with the same key/opts from _projectHomeCtx).
const projectHomeRefreshBtn = document.getElementById("btn-project-home-refresh");
if (projectHomeRefreshBtn) projectHomeRefreshBtn.addEventListener("click", () => {
  if (!_projectHomeCtx) return;
  _decisionsCtx = null; // force a fresh fetch inside enterProjectHomeView
  enterProjectHomeView(_projectHomeCtx.key, { label: _projectHomeCtx.label, top: _projectHomeCtx.top, lens: _projectHomeCtx.lens });
});

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

  // WP-Grouping-Operator P4 — when this entity resolves to a single canonical
  // job, title the view with the job's NAME ("Merck Vaccines Landing Page
  // Updates") instead of the raw entity slug. A section (spans many jobs) →
  // resolvedJob is null → keep the entity slug. Consistent: the header always
  // names exactly what the set is.
  const resolvedJob = data && data.resolvedJob;
  const headerName = resolvedJob && resolvedJob.name ? resolvedJob.name : prettySlug(entity);
  if (titleEl) titleEl.textContent = headerName;
  setNav(
    [
      { label: "Today", go: () => enterLogView() },
      { label: "Receipts · " + headerName },
    ],
    { back: () => enterLogView() },
  );

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

/* ─────────────────────────────────────────────────────────────────────────
 * WP-R1 — the ONE receipt component.
 *
 * Every surface that shows "evidence" (a verbatim quote, the source it came
 * from, the co-sign corroboration count, and the jump-to-source affordance)
 * renders it through renderReceipt(). The DOM tree it emits is IDENTICAL at
 * every call site — surface variation is class/attr toggles via `opts`, never
 * a forked element tree. This reconciles the two prior renderers (the #61
 * source-pane/question-card treatment and renderReceiptNode's co-sign-bearing
 * receipt) into a single component.
 *
 * `receipt` (normalized; every field optional — absent ⇒ that piece is omitted):
 *   verbatim         string  the captured text
 *   verbatimVerified bool    quote is ONLY rendered when this is true (trust gate)
 *   documentId       string  the source doc → drives the source badge + jump
 *   sourceFallback   string  plain text shown when documentId has no doc metadata
 *                            AND opts.jump is false (e.g. "from EMAIL-123")
 *   coSign           {captureCount, status}  "N captures corroborate" (≥2 only)
 *   copy             {markdown, html}  when present, a copy-to-clipboard action
 *                            (the share artifact) is added; reuses copy_receipts
 *
 * `opts`:
 *   compact       bool    dense variant (data-compact="true")
 *   jump          bool    default true; false ⇒ no clickable source (fallback text)
 *   quoteWrap     bool    render the quote wrapped in curly quotes (legacy look)
 *   variant       string  surface class hook appended to the root (parity only)
 *   authoredSource {docId, primaryText, extraTexts, label, iconKey}  the
 *                          question-card "View in your notes" jump variant:
 *                          opens the authored doc highlighting every item at once
 *   onCopyToast   fn      optional callback after a successful copy (toast)
 *
 * Returns a single <div class="receipt …"> element — the SAME tree everywhere.
 * Renders only from data already in hand (no blocking work on the paint path).
 * ───────────────────────────────────────────────────────────────────────── */
function renderReceipt(receipt, opts) {
  const r = receipt || {};
  const o = opts || {};
  const jump = o.jump !== false;

  const root = document.createElement("div");
  root.className = "receipt";
  if (o.variant) root.classList.add(o.variant);
  if (o.compact) root.dataset.compact = "true";

  // 1. Verbatim quote — ONLY when verified (the trust property). Border-left
  //    inset, italic. quoteWrap adds the curly quotes some surfaces show.
  if (r.verbatimVerified === true && r.verbatim) {
    const quote = document.createElement("blockquote");
    quote.className = "receipt-quote";
    quote.textContent = o.quoteWrap ? `“${r.verbatim}”` : r.verbatim;
    root.appendChild(quote);
  }

  // 2. Co-sign — count-only corroboration ("N captures corroborate"), rendered
  //    ONLY at captureCount ≥ 2, honoring confirmed/proposed. Never the emails —
  //    count only.
  const cs = r.coSign;
  if (cs && typeof cs.captureCount === "number" && cs.captureCount >= 2) {
    const chip = document.createElement("span");
    chip.className = "receipt-cosign";
    chip.dataset.status = cs.status === "confirmed" ? "confirmed" : "proposed";
    chip.textContent = `✓ ${cs.captureCount} captures corroborate`;
    root.appendChild(chip);
  }

  // 3. Source + jump-to-source. The authored-source variant (question card) opens
  //    the authored doc highlighting every item at once; the standard variant
  //    reuses renderSourceBadge (source-type chip) → opens the source pane beside
  //    the view. When jump is off, or no doc metadata is available, we fall back
  //    to a plain non-clickable source line.
  const footer = document.createElement("div");
  footer.className = "receipt-source";
  let sourced = false;
  if (jump && o.authoredSource && o.authoredSource.docId) {
    const a = o.authoredSource;
    const doc = _docsById ? _docsById.get(a.docId) : null;
    const iconKey = a.iconKey || (doc ? sourceFromDoc(doc).iconKey : "doc");
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "source-badge";
    chip.title = "Open your authored list beside this" + (a.detail ? " — " + a.detail : a.label ? " — " + a.label : "");
    const icon = document.createElement("span");
    icon.className = "source-badge-icon";
    icon.innerHTML = SOURCE_ICONS[iconKey] || SOURCE_ICONS.doc; // constant SVG
    chip.appendChild(icon);
    const lab = document.createElement("span");
    lab.className = "source-badge-label";
    lab.textContent = a.label || "View in your notes";
    chip.appendChild(lab);
    if (a.detail) {
      const det = document.createElement("span");
      det.className = "source-badge-detail";
      det.textContent = "· " + a.detail;
      chip.appendChild(det);
    }
    const extras = Array.isArray(a.extraTexts) ? a.extraTexts : [];
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openSourcePanel(a.docId, a.primaryText, extras, { authoredOnly: true });
    });
    footer.appendChild(chip);
    sourced = true;
  } else if (jump && r.documentId) {
    const chip = renderSourceBadge(r.documentId, r.verbatim);
    if (chip) {
      footer.appendChild(chip);
      sourced = true;
    } else {
      // No doc metadata loaded yet: a plain "source ↗" button that still opens it.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "receipt-source-link";
      btn.textContent = "source ↗";
      btn.addEventListener("click", () => openSourcePanel(r.documentId, r.verbatim));
      footer.appendChild(btn);
      sourced = true;
    }
  } else if (r.sourceFallback) {
    // Non-clickable provenance line (used where the source pane isn't wired).
    const p = document.createElement("span");
    p.className = "receipt-source-text";
    p.textContent = r.sourceFallback;
    footer.appendChild(p);
    sourced = true;
  }

  // 4. The share artifact — copy the "compiled from N captures" block. Reuses the
  //    existing deterministic serializers (buildReceiptsMarkdown/Html) via the
  //    caller-supplied {markdown, html}; we do NOT re-serialize here.
  if (r.copy && (r.copy.markdown || r.copy.html)) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "receipt-copy";
    copyBtn.textContent = "Copy receipt";
    copyBtn.title = "Copy this as a paste-able, source-cited block";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await tauri.core.invoke("copy_receipts", {
          html: r.copy.html || "",
          markdown: r.copy.markdown || "",
        });
        const original = copyBtn.textContent;
        copyBtn.textContent = "Copied ✓";
        copyBtn.disabled = true;
        setTimeout(() => {
          copyBtn.textContent = original;
          copyBtn.disabled = false;
        }, 1600);
        if (typeof o.onCopyToast === "function") o.onCopyToast();
      } catch (err) {
        console.warn("[main] copy_receipts failed:", err);
        const original = copyBtn.textContent;
        copyBtn.textContent = "Copy failed";
        setTimeout(() => { copyBtn.textContent = original; }, 1600);
      }
    });
    footer.appendChild(copyBtn);
    sourced = true;
  }

  if (sourced) root.appendChild(footer);
  return root;
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

  // Share artifact — the "compiled from N captures" copy action, on the ONE
  // receipt component. Reuses the deterministic buildReceiptsMarkdown/Html
  // serializers (NOT a second serializer); the same copy_receipts IPC the
  // view's toolbar button uses. Rendered once at the head of the chain so any
  // receipted set is one click from a paste-able, source-cited block.
  if (currentReceipts && Array.isArray(currentReceipts.items) && currentReceipts.items.length) {
    const { entity, items: cItems, edges: cEdges, baseUrl: cUrl } = currentReceipts;
    chainEl.appendChild(
      renderReceipt(
        {
          copy: {
            markdown: buildReceiptsMarkdown(entity, cItems, cEdges, cUrl),
            html: buildReceiptsHtml(entity, cItems, cEdges, cUrl),
          },
        },
        {
          variant: "receipt-share",
          onCopyToast: () =>
            showToast({
              kind: "success",
              title: "Receipt copied",
              body: `Compiled from ${cItems.length} capture${cItems.length === 1 ? "" : "s"}.`,
            }),
        },
      ),
    );
  }

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

  // Edge chips — supersession/conflict (red family), resolution (green). These
  // are relationship annotations, NOT evidence, so they stay bespoke here.
  for (const e of recEdges) {
    const phrasing = edgePhrasing(e, rec.recordId);
    if (!phrasing) continue;
    const chipEl = document.createElement("span");
    chipEl.className = "rec-edge";
    chipEl.dataset.kind = e.kind || "";
    chipEl.textContent = `${phrasing.icon} ${phrasing.label}`;
    body.appendChild(chipEl);
  }

  // Evidence — verbatim quote (verified-only), the count-only co-sign, and the
  // jump-to-source, all via the ONE receipt component. This is the richest call
  // site (it carries the co-sign) and the reference the component was distilled
  // from; it now renders through it like every other surface.
  body.appendChild(
    renderReceipt(
      {
        verbatim: rec.verbatim,
        verbatimVerified: rec.verbatimVerified,
        documentId: rec.documentId,
        coSign,
      },
      { variant: "receipt-chain" },
    ),
  );

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

// ───────── WP-CASCADE-PRODUCTION WP-T1 — Proxy-fleet inbox ─────────
//
// The consumer surface for the nominate→filter→adjudicate→ratify pipeline: the
// proxy fleet nominates typed proposals (merge / close / combine / chase /
// escalate), each carrying an axes-agreement confidence. This view splits them
// into two piles by that confidence and lets the user ratify one-tap.
//
// ONE card family (brief §2b.4): the "Wants your eye" cards are built on the
// SAME `.record-card` chrome the decision-log uses (renderRecordCard's classes)
// and reuse the gesture affordances — appendDismissControl / undoDismiss and the
// toast+Undo pattern — rather than a second card framework.

// The one-line question shown at the top of every proxy card, by kind. Matches
// the brief's card-anatomy copy.
const PROXY_KIND_QUESTIONS = {
  merge: "These look like the same thing — merge them?",
  close: "A commitment looks done — close it?",
  combine: "These look like the same initiative — combine them?",
  chase: "This has gone quiet — send a nudge?",
  escalate: "This keeps getting re-promised — escalate it?",
};

// Verdict → plain ask, consulted when `kind` doesn't map (dual-schema robustness).
// The fleet's verdict is the more reliable signal for a couple of legacy items.
const PROXY_VERDICT_QUESTIONS = {
  DUPLICATE: "These look like the same thing — merge them?",
  RESOLVED_EVIDENCE: "A commitment looks done — close it?",
  RESTATEMENT: "This keeps getting re-promised — nudge it?",
  RECURRING: "This keeps recurring — is it handled?",
};

/**
 * Derive the plain, human-facing card content from a proxy-queue item, tolerating
 * BOTH schemas (§ WP-R2 amendment item 6):
 *   · NEW shape (post-E5 cascade §2.11): the item carries a clean `ask` + `why`
 *     and a separate `debugTrace`. Detect by presence of `ask` OR `debugTrace`;
 *     when present, display them directly and route `debugTrace` into details.
 *   · LEGACY shape (today's fleet output / the fixture): jargon lives in
 *     `evidence.why`, plus `evidence.verdict` / `evidence.routes` / `evidence.cosine`
 *     and a bare `kind`. We DERIVE the plain ask from kind (falling back to verdict),
 *     surface the quotes + plain-language confidence, and tuck why/verdict/routes/cos
 *     into the collapsed "details" affordance.
 * Returns { ask, isNewShape, debugTrace } — the caller reads why/verdict/etc off the
 * item for the details panel.
 */
function deriveProxyAsk(item) {
  const ev = (item && item.evidence) || {};
  const isNewShape =
    typeof item.ask === "string" && item.ask.trim() !== "" ||
    item.debugTrace != null;
  if (isNewShape && typeof item.ask === "string" && item.ask.trim()) {
    return { ask: item.ask.trim(), isNewShape: true, debugTrace: item.debugTrace };
  }
  // Legacy derivation: kind first, verdict as a fallback, generic last resort.
  const ask =
    PROXY_KIND_QUESTIONS[item.kind] ||
    PROXY_VERDICT_QUESTIONS[ev.verdict] ||
    "Take a look at this?";
  return { ask, isNewShape: false, debugTrace: item.debugTrace };
}

// Human labels for the routing-verdict chip.
const PROXY_VERDICT_LABELS = {
  DUPLICATE: "duplicate",
  RECURRING: "recurring",
  DISTINCT: "distinct",
  RESOLVED_EVIDENCE: "resolved (evidence)",
  RESTATEMENT: "restatement",
  RELATED_ONLY: "related only",
};

// The confidence floor that sends an item to the "Filed confidently" pile when
// the item didn't already carry a terminal status. High-band per the brief
// (auto-band ≥0.90); adjudicate-band items land in "Wants your eye".
const PROXY_FILED_CONFIDENCE = 0.9;

/**
 * Enter the proxy inbox. Loads the queue via fetch_proxy_queue (fixture-first;
 * WP-E5 endpoint later) and renders the two piles. Failure-safe: an IPC error
 * surfaces via showToast and leaves the empty state visible, like the Plaud
 * queue.
 */
async function enterProxyQueueView() {
  state.inWizard = false;
  showView("view-proxy-queue");
  setNav([{ label: "Proxy inbox" }], { back: () => goHome() });
  await refreshProxyQueue();
}

/** Re-fetch + re-render both piles. Called on view-enter and on Refresh. */
async function refreshProxyQueue() {
  const attentionList = document.getElementById("proxy-attention-list");
  const filedList = document.getElementById("proxy-filed-list");
  const attentionPile = document.getElementById("proxy-pile-attention");
  const filedPile = document.getElementById("proxy-pile-filed");
  const emptyEl = document.getElementById("proxy-queue-empty");
  const metaEl = document.getElementById("proxy-queue-meta");
  if (!attentionList || !filedList || !emptyEl || !metaEl) return;

  attentionList.innerHTML = "";
  filedList.innerHTML = "";

  let payload;
  try {
    payload = await tauri.core.invoke("fetch_proxy_queue");
  } catch (err) {
    showToast({
      kind: "failure",
      title: "Couldn't load the proxy inbox",
      body: String(err),
    });
    if (attentionPile) attentionPile.hidden = true;
    if (filedPile) filedPile.hidden = true;
    emptyEl.hidden = false;
    metaEl.textContent = "";
    return;
  }

  const items = payload && Array.isArray(payload.items) ? payload.items : [];

  // Terminal items (dismissed/undone) never surface. Split the rest by pile:
  // "Filed confidently" = already-confirmed OR high-band pending; everything
  // else ("Wants your eye") = pending in the adjudicate band.
  const live = items.filter(
    (it) => it && it.status !== "dismissed" && it.status !== "undone",
  );
  const filed = live.filter(
    (it) =>
      it.status === "confirmed" ||
      (typeof it.confidence === "number" && it.confidence >= PROXY_FILED_CONFIDENCE),
  );
  const wantsEye = live.filter((it) => !filed.includes(it));

  // "Wants your eye" — full cards.
  if (wantsEye.length) {
    for (const item of wantsEye) {
      attentionList.appendChild(renderProxyCard(item));
    }
    if (attentionPile) attentionPile.hidden = false;
  } else if (attentionPile) {
    attentionPile.hidden = true;
  }

  // "Filed confidently" — collapsed rows, undo per row.
  if (filed.length) {
    for (const item of filed) {
      filedList.appendChild(renderProxyFiledRow(item));
    }
    if (filedPile) filedPile.hidden = false;
    const headText = document.getElementById("proxy-filed-heading-text");
    if (headText) {
      headText.textContent = `Filed confidently · ${filed.length}`;
    }
  } else if (filedPile) {
    filedPile.hidden = true;
  }

  // Empty state only when BOTH piles are empty.
  const anything = wantsEye.length + filed.length;
  emptyEl.hidden = anything > 0;

  // Meta line: pending-count (what the amber badge counts).
  const pending = live.filter((it) => it.status === "pending").length;
  metaEl.textContent =
    pending === 0
      ? "Nothing waiting on you"
      : pending === 1
        ? "1 waiting on you"
        : `${pending} waiting on you`;
}

/** Toggle the "Filed confidently" pile open/closed (collapsed by default). */
function toggleProxyFiledPile() {
  const toggle = document.getElementById("proxy-filed-toggle");
  const list = document.getElementById("proxy-filed-list");
  const chevron = toggle && toggle.querySelector(".proxy-pile-chevron");
  if (!toggle || !list) return;
  const open = list.hidden; // about to open if currently hidden
  list.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (chevron) chevron.textContent = open ? "▾" : "▸";
}

/**
 * Build one "Wants your eye" card. Reuses the record-card family:
 *   - `.record-card` base chrome (same class renderRecordCard builds on)
 *   - the `.record-actions` footer + appendDismissControl gesture affordance
 *   - the confirm/undo toast pattern (mirrors dismissRecord → undoDismiss)
 * On TOP of that shared chrome it adds the proxy-specific anatomy: a one-line
 * question header and an evidence panel (verbatims, dates, owners, cosine band,
 * routing verdicts). No innerHTML for server strings — createElement/textContent
 * throughout (same discipline as the rest of the card family).
 */
function renderProxyCard(item) {
  const ev = (item && item.evidence) || {};
  const card = document.createElement("div");
  card.className = "record-card proxy-card"; // reuse the record-card family class
  card.dataset.kind = item.kind || "";
  card.dataset.id = item.id || "";

  // Card anatomy (§ WP-R2 amendment item 6), in this order:
  //   1. The ask first — a plain question (derived; dual-schema tolerant).
  //   2. The two dated quotes — the primary content a human judges (receipts).
  //   3. Plain-language confidence — "78% confident" (not "agreement/adjudicate-band").
  //   4. Everything mechanical behind a collapsed "Details" affordance.
  const derived = deriveProxyAsk(item);

  // ── 1. The ask, first ──────────────────────────────────────────────────────
  const question = document.createElement("p");
  question.className = "proxy-question";
  question.textContent = derived.ask;
  card.appendChild(question);

  // ── 2. The dated quotes — the decision content, via the ONE receipt component.
  //    Proxy verbatims are fleet-surfaced evidence (already citation-scoped), so
  //    they render as quotes (verified); the source pane isn't wired in the proxy
  //    queue, so jump is off. Each quote is paired with its date when available.
  const evidence = document.createElement("div");
  evidence.className = "proxy-evidence";
  const verbatims = Array.isArray(ev.verbatims) ? ev.verbatims : [];
  const evDates = Array.isArray(ev.dates) ? ev.dates : [];
  for (let i = 0; i < verbatims.length; i++) {
    const v = verbatims[i];
    if (!v) continue;
    const receipt = renderReceipt(
      { verbatim: v, verbatimVerified: true },
      { jump: false, variant: "receipt-proxy" },
    );
    const d = evDates[i];
    if (d) {
      const dateEl = document.createElement("span");
      dateEl.className = "proxy-quote-date";
      dateEl.textContent = String(d).slice(0, 10);
      receipt.appendChild(dateEl);
    }
    evidence.appendChild(receipt);
  }
  card.appendChild(evidence);

  // ── 3. Plain-language confidence ───────────────────────────────────────────
  if (typeof item.confidence === "number") {
    const conf = document.createElement("p");
    conf.className = "proxy-confidence";
    conf.textContent = Math.round(item.confidence * 100) + "% confident";
    card.appendChild(conf);
  }

  // ── 4. Details — everything mechanical, collapsed by default. Legacy jargon
  //    (why / verdict / routes / cosine / owners) OR the new-shape debugTrace all
  //    live here so the card face stays plain. Only rendered when there's content.
  const detailBits = [];
  // New-shape debugTrace routes here verbatim (string or JSON-stringified object).
  if (derived.debugTrace != null) {
    const traceText =
      typeof derived.debugTrace === "string"
        ? derived.debugTrace
        : JSON.stringify(derived.debugTrace, null, 2);
    if (traceText && traceText.trim()) detailBits.push({ type: "trace", text: traceText });
  }
  // Legacy mechanical fields. On the new shape these are typically absent.
  if (ev.why) detailBits.push({ type: "why", text: ev.why });
  const metaSegs = [];
  const owners = Array.isArray(ev.owners) ? ev.owners.filter(Boolean) : [];
  if (owners.length) metaSegs.push(owners.map(prettySlug).join(", "));
  if (typeof ev.cosine === "number") metaSegs.push("cos " + ev.cosine.toFixed(2));
  if (metaSegs.length) detailBits.push({ type: "meta", text: metaSegs.join(" · ") });
  const routes = Array.isArray(ev.routes) ? ev.routes.filter(Boolean) : [];
  const hasChips = routes.length || ev.verdict;

  if (detailBits.length || hasChips) {
    const details = document.createElement("details");
    details.className = "proxy-details";
    const summary = document.createElement("summary");
    summary.className = "proxy-details-summary";
    summary.textContent = "Details";
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "proxy-details-body";
    for (const bit of detailBits) {
      const el = document.createElement(bit.type === "trace" ? "pre" : "p");
      el.className =
        bit.type === "why"
          ? "proxy-why"
          : bit.type === "trace"
            ? "proxy-debug-trace"
            : "proxy-evidence-meta";
      el.textContent = bit.text;
      body.appendChild(el);
    }
    // Routing verdict + routes as chips (mechanical vocabulary).
    if (hasChips) {
      const chips = document.createElement("div");
      chips.className = "proxy-route-chips";
      if (ev.verdict) {
        const vChip = document.createElement("span");
        vChip.className = "proxy-route-chip proxy-verdict-chip";
        vChip.textContent = PROXY_VERDICT_LABELS[ev.verdict] || String(ev.verdict);
        chips.appendChild(vChip);
      }
      for (const r of routes) {
        const rChip = document.createElement("span");
        rChip.className = "proxy-route-chip";
        rChip.textContent = r;
        chips.appendChild(rChip);
      }
      body.appendChild(chips);
    }

    // WP-R3 item 5 — open the underlying record's SOURCE in the right-hand pane,
    // exactly like the Log. Resolve each evidence.recordId → documentId (the
    // record→doc map, from the decision log), then let R1's existing jump
    // (renderSourceBadge → openSourcePanel) open the pane. FULL reuse — no new
    // pane, no new endpoint. Graceful: the FIXTURE's synthetic recordIds won't be
    // in the corpus log, so they resolve to nothing and NO affordance renders (no
    // dead link). Async-fills when the maps land; if already cached, fills now.
    mountProxySourceAffordance(body, ev);

    details.appendChild(body);
    card.appendChild(details);
  }

  // Actions footer — the SAME `.record-actions` row + gesture affordances the
  // record cards use. Confirm (proxy-specific ratify) + Dismiss (reuses the
  // dismiss-with-undo pattern; here the undo re-inserts the card and there's no
  // record-level suppression, so a local proxy-scoped confirm/dismiss handler
  // provides the toast + Undo mirror of undoDismiss).
  const actions = document.createElement("div");
  actions.className = "record-actions proxy-card-actions";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "record-action-btn proxy-confirm-btn";
  confirmBtn.textContent = "Confirm";
  confirmBtn.title = "Confirm — apply this proposal";
  confirmBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    proxyRatify(item, card, "confirm");
  });
  actions.appendChild(confirmBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "record-dismiss-btn proxy-dismiss-btn";
  dismissBtn.title = "Dismiss — the fleet got this one wrong";
  dismissBtn.setAttribute("aria-label", "Dismiss");
  dismissBtn.textContent = "✕";
  dismissBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    proxyRatify(item, card, "dismiss");
  });
  actions.appendChild(dismissBtn);

  card.appendChild(actions);
  return card;
}

// WP-R3 item 5 — resolve a proxy item's evidence.recordIds to their source docs
// and append a "source" affordance (reusing renderSourceBadge → openSourcePanel,
// the Log's mechanism) into `container`. Async: both the record→doc and doc maps
// must be loaded so the badge can name the source type + open the pane. Renders
// NOTHING when nothing resolves — the fixture's synthetic recordIds (rec-4821 …)
// aren't in the corpus log, so they yield no badge (no broken/dead link). One
// badge per distinct resolvable document (deduped).
async function mountProxySourceAffordance(container, ev) {
  const recordIds = ev && Array.isArray(ev.recordIds) ? ev.recordIds.filter(Boolean) : [];
  if (!recordIds.length) return;
  // Both maps are needed: recordId→documentId to resolve, and _docsById (via
  // loadDocsMap) so renderSourceBadge can render + open. Best-effort; either
  // failing just leaves the map empty → no affordance.
  const [recDoc] = await Promise.all([loadRecordDocMap(), loadDocsMap()]);
  const seen = new Set();
  const badges = [];
  for (const rid of recordIds) {
    const docId = recDoc.get(rid);
    if (!docId || seen.has(docId)) continue;
    // renderSourceBadge returns null when the doc isn't in _docsById (no metadata) —
    // so an unresolvable/orphan doc adds nothing. This is the graceful path.
    const chip = renderSourceBadge(docId, null);
    if (chip) { seen.add(docId); badges.push(chip); }
  }
  if (!badges.length) return; // nothing resolved — no dead link
  const row = document.createElement("div");
  row.className = "proxy-source-row";
  const lbl = document.createElement("span");
  lbl.className = "proxy-source-label";
  lbl.textContent = badges.length === 1 ? "Source" : "Sources";
  row.appendChild(lbl);
  for (const b of badges) row.appendChild(b);
  container.appendChild(row);
}

/**
 * Build one "Filed confidently" collapsed row: the question + a one-line gist,
 * plus an Undo affordance. Undo mirrors undoDismiss (re-insert where it was);
 * here it moves the item back into "Wants your eye" so the user can re-examine.
 */
function renderProxyFiledRow(item) {
  const ev = (item && item.evidence) || {};
  const row = document.createElement("div");
  row.className = "proxy-filed-row";
  row.dataset.id = item.id || "";

  const kind = document.createElement("span");
  kind.className = "proxy-filed-kind proxy-kind-chip";
  kind.dataset.kind = item.kind || "";
  kind.textContent = prettySlug(item.kind || "");
  row.appendChild(kind);

  const gist = document.createElement("span");
  gist.className = "proxy-filed-gist";
  const firstVerbatim =
    Array.isArray(ev.verbatims) && ev.verbatims.length ? ev.verbatims[0] : "";
  gist.textContent = clampText(ev.why || firstVerbatim || item.id || "", 90);
  gist.title = ev.why || firstVerbatim || "";
  row.appendChild(gist);

  if (typeof item.confidence === "number") {
    const conf = document.createElement("span");
    conf.className = "proxy-filed-conf";
    conf.textContent = Math.round(item.confidence * 100) + "%";
    row.appendChild(conf);
  }

  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "btn btn-link proxy-filed-undo";
  undo.textContent = "Undo";
  undo.title = "Undo — move back to Wants your eye";
  undo.addEventListener("click", (e) => {
    e.stopPropagation();
    proxyUndoFiled(item, row);
  });
  row.appendChild(undo);

  return row;
}

/**
 * Ratify a "Wants your eye" card: optimistically remove it, best-effort POST the
 * decision to the WP-E5 endpoint (via a future proxy_queue_decide IPC — absent
 * for now, so this stays local), and show an Undo toast that re-inserts the card
 * (mirrors dismissRecord → undoDismiss). `action` is "confirm" | "dismiss".
 */
function proxyRatify(item, cardEl, action) {
  if (!cardEl) return;
  const parent = cardEl.parentNode;
  const next = cardEl.nextSibling;
  cardEl.remove();

  // Best-effort server decision. The IPC is a WP-E5 dependency; until it exists
  // the invoke throws and we keep the optimistic local state (offline-tolerant,
  // same posture as dismissRecord's server best-effort).
  tauri.core
    .invoke("proxy_queue_decide", { id: item.id, decision: action })
    .catch((err) => console.warn("[main] proxy_queue_decide failed:", err));

  const label =
    action === "confirm"
      ? PROXY_KIND_QUESTIONS[item.kind]
        ? "Applied: " + prettySlug(item.kind)
        : "Confirmed"
      : "Dismissed";
  showToast({
    kind: action === "confirm" ? "success" : "idempotent",
    title: label,
    body: clampText(((item.evidence || {}).why) || "", 80),
    cta: {
      label: "Undo",
      onClick: () => {
        if (parent && !cardEl.isConnected) parent.insertBefore(cardEl, next || null);
        tauri.core
          .invoke("proxy_queue_decide", { id: item.id, decision: "undo" })
          .catch((err) => console.warn("[main] proxy_queue_decide (undo) failed:", err));
      },
    },
  });
}

/** Undo a filed item: remove the collapsed row and re-fetch so it re-surfaces
 *  in "Wants your eye" (server-side status flips to pending). Best-effort. */
function proxyUndoFiled(item, rowEl) {
  if (rowEl) rowEl.remove();
  tauri.core
    .invoke("proxy_queue_decide", { id: item.id, decision: "undo" })
    .catch((err) => console.warn("[main] proxy_queue_decide (undo-filed) failed:", err));
  showToast({
    kind: "idempotent",
    title: "Moved back",
    body: "Now waiting on you again.",
  });
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

  // Styled in-DOM confirm (brief §3.4 AC: "Confirm dialog shows estimated LLM
  // cost"). The actual send runs in the confirm button's click handler.
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";
  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = `Send all ${pageCount} page${pageCount === 1 ? "" : "s"} in “${sectionName}”?`;
  pane.appendChild(title);
  const bodyEl = document.createElement("div");
  bodyEl.className = "pg-confirm-body";
  bodyEl.textContent =
    `Estimated cost ~$${ONENOTE_BULK_SEND_COST_PER_PAGE_USD.toFixed(3)} per page ` +
    `(~$${estCostUsd} total).`;
  pane.appendChild(bodyEl);
  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = "Send";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Sending…";
    pgClose(overlay);

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
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);
  overlay.appendChild(pane);
  document.body.appendChild(overlay);
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
// Refresh the Plaud connect/disconnect card. The card now lives inside the
// Settings → Integrations panel; called when standalone Settings opens.
async function refreshPlaudConnectionCard() {
  if (!document.getElementById("connection-plaud")) return;
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

// WP-Outlook-Writeback — Install Outlook Add-in.
//
// Builds a manifest URL pre-baked with this app's saved connection (base URL +
// bearer token). The engine's GET /outlook-manifest.xml validates the token
// (per-user apolla_ addinToken OR shared INGESTION_API_KEY — both are what this
// app already stores as bearer_token) and rewrites the configure-pane URL with
// tenant + token, so the add-in installs already configured. No new Rust IPC:
// reuses the existing copy_text command + the tauri-plugin-opener channel.
async function handleOutlookAddinInstallClick() {
  const baseUrl = (document.getElementById("config-base-url")?.value || "").trim().replace(/\/+$/, "");
  const token = (document.getElementById("config-bearer-token")?.value || "").trim();
  if (!baseUrl || !token) {
    showToast({
      kind: "error",
      title: "Connect first",
      body: "Set your Apolla URL and token (and Save) before installing the add-in.",
    });
    return;
  }
  const manifestUrl =
    `${baseUrl}/outlook-manifest.xml?token=${encodeURIComponent(token)}&download=1`;

  // Copy the manifest link so the user can paste it into Outlook's "Add custom
  // add-in → Add from URL" dialog. Clipboard is the load-bearing path.
  try {
    await tauri.core.invoke("copy_text", { text: manifestUrl });
  } catch (err) {
    console.warn("[main] copy manifest URL failed:", err);
  }
  // Best-effort: also open the URL so the browser downloads the manifest XML
  // (the &download=1 param sets Content-Disposition: attachment). Optional —
  // failure here is non-fatal; the clipboard copy above is what matters.
  try {
    await tauri.core.invoke("plugin:opener|open_url", { url: manifestUrl });
  } catch (err) {
    console.warn("[main] open manifest URL failed (non-fatal):", err);
  }

  const steps = document.getElementById("outlook-addin-steps");
  if (steps) steps.hidden = false;
  showToast({
    kind: "success",
    title: "Add-in manifest downloaded",
    body: "In Outlook: Add a custom add-in → Add from File → pick it from your Downloads.",
  });
}

// ── WP-Outlook-Writeback — staged outbox surface ──
//
// Lists the drafts Threshold composed (GET /api/outbox via the fetch_outbox
// IPC). The desktop can't SEND (no Graph path) — sending happens in Outlook via
// the add-in — so this surface is review + dismiss only.

function outboxTypeLabel(t) {
  return t === "new-email" ? "New email" : t === "meeting-invite" ? "Meeting invite" : "Reply";
}

/** Plain text from a bodyHtml payload (agent drafts are usually plain text or
 *  trivial HTML; render as TEXT always — never inject markup into the card). */
function outboxBodyText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").trim();
}

function renderOutboxCard(item) {
  const card = document.createElement("div");
  card.className = "record-card";
  card.dataset.type = item.type || "";

  const header = document.createElement("div");
  header.className = "record-header";
  const chip = document.createElement("span");
  chip.className = "record-chip";
  chip.dataset.type = item.type || "";
  chip.textContent = outboxTypeLabel(item.type);
  header.appendChild(chip);
  // WP-OUTBOX-COMPANION-CARD — provenance: agent-drafted items say so (the
  // ✦ glyph is the companion's mark everywhere else in the app).
  if (item.proposedBy === "mcp-agent") {
    const prov = document.createElement("span");
    prov.className = "record-chip outbox-companion-chip";
    prov.textContent = "✦ Drafted by your companion";
    header.appendChild(prov);
  }
  card.appendChild(header);

  const summary = document.createElement("p");
  summary.className = "record-summary";
  summary.textContent = item.subject || "(no subject)";
  card.appendChild(summary);

  const who =
    item.type === "meeting-invite"
      ? [].concat(item.requiredAttendees || [], item.optionalAttendees || [])
      : [].concat(item.toRecipients || [], item.ccRecipients || []);
  const metaBits = [];
  if (who.length) metaBits.push("To: " + who.join(", "));
  if (item.start) metaBits.push(item.start);
  if (metaBits.length) {
    const meta = document.createElement("p");
    meta.className = "record-meta";
    meta.textContent = metaBits.join(" · ");
    card.appendChild(meta);
  }

  // Source attribution — suppressed when it just repeats the subject (agent-
  // proposed items stamp source.label = subject; follow-up drafts stamp the
  // commitment summary the subject already carries — exact match missed those,
  // so the card said the same sentence twice. Containment either way = noise).
  const srcLabel = item.source && item.source.label ? String(item.source.label).trim() : "";
  const subj = String(item.subject || "").trim();
  if (srcLabel && !(subj.includes(srcLabel) || srcLabel.includes(subj))) {
    const src = document.createElement("p");
    src.className = "record-meta";
    src.textContent = "From: " + srcLabel;
    card.appendChild(src);
  }

  // Body preview + expand. The draft IS the payload — hiding it made the card
  // undecidable without leaving the app.
  const bodyText = outboxBodyText(item.bodyHtml);
  if (bodyText) {
    const PREVIEW_CHARS = 220;
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "outbox-body";
    const bodyP = document.createElement("p");
    bodyP.className = "outbox-body-text";
    const needsToggle = bodyText.length > PREVIEW_CHARS;
    let expanded = false;
    const preview = needsToggle ? bodyText.slice(0, PREVIEW_CHARS).trimEnd() + "…" : bodyText;
    bodyP.textContent = preview;
    bodyWrap.appendChild(bodyP);
    if (needsToggle) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn-inline-link";
      toggle.textContent = "Show full draft";
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        bodyP.textContent = expanded ? bodyText : preview;
        toggle.textContent = expanded ? "Hide full draft" : "Show full draft";
      });
      bodyWrap.appendChild(toggle);
    }
    card.appendChild(bodyWrap);
  }

  // Held artifacts — download (edit in your own tool) + replace (attach the
  // edited version back; the server mints a NEW version, never in-place).
  // `artifacts` metadata comes from the engine; fall back to bare ids so the
  // card degrades honestly against an older server.
  const artifacts = Array.isArray(item.artifacts)
    ? item.artifacts
    : (item.artifactIds || []).map((id) => ({ id, filename: "attachment" }));
  if (artifacts.length) {
    const row = document.createElement("div");
    row.className = "outbox-artifacts";
    for (const art of artifacts) {
      const pill = document.createElement("span");
      pill.className = "outbox-artifact-pill";
      const name = document.createElement("span");
      name.className = "outbox-artifact-name";
      name.textContent =
        (art.filename || "attachment") + (art.version > 1 ? ` (v${art.version})` : "");
      pill.appendChild(name);

      const dl = document.createElement("button");
      dl.type = "button";
      dl.className = "btn-inline-link outbox-artifact-act";
      dl.title = "Download to edit in your own tool";
      dl.textContent = "Download";
      dl.addEventListener("click", async () => {
        try {
          const saved = await tauri.core.invoke("outbox_artifact_save", {
            itemId: item.id,
            artifactId: art.id,
            defaultName: art.filename || "attachment",
          });
          if (saved) showToast({ kind: "success", title: "Saved", body: saved });
        } catch (err) {
          showToast({ kind: "error", title: "Download failed", body: String(err) });
        }
      });
      pill.appendChild(dl);

      const rep = document.createElement("button");
      rep.type = "button";
      rep.className = "btn-inline-link outbox-artifact-act";
      rep.title = "Attach your edited version (kept as a new version)";
      rep.textContent = "Replace";
      rep.addEventListener("click", async () => {
        try {
          const res = await tauri.core.invoke("outbox_artifact_replace", {
            itemId: item.id,
            artifactId: art.id,
          });
          if (!res) return; // picker cancelled
          const v = res.artifact && res.artifact.version;
          name.textContent =
            ((res.artifact && res.artifact.filename) || art.filename || "attachment") +
            (v > 1 ? ` (v${v})` : "");
          if (res.artifact && res.artifact.id) art.id = res.artifact.id;
          showToast({
            kind: "success",
            title: "New version attached",
            body: "The previous version is kept for the audit trail.",
          });
        } catch (err) {
          showToast({ kind: "error", title: "Replace failed", body: String(err) });
        }
      });
      pill.appendChild(rep);
      row.appendChild(pill);
    }
    card.appendChild(row);
  }

  if (Array.isArray(item.linkedRecordIds) && item.linkedRecordIds.length) {
    const link = document.createElement("p");
    link.className = "record-meta outbox-linked";
    const n = item.linkedRecordIds.length;
    link.textContent = `Discharges ${n} linked commitment${n === 1 ? "" : "s"} — resolve on send`;
    card.appendChild(link);
  }

  const actions = document.createElement("div");
  actions.className = "record-actions";
  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "btn btn-link";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", () => outboxDecide(item.id, "dismiss", card));
  actions.appendChild(dismissBtn);

  if (bodyText || who.length) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn btn-secondary btn-compact";
    copyBtn.textContent = "Copy draft";
    copyBtn.addEventListener("click", async () => {
      const parts = [];
      if (who.length) parts.push("To: " + who.join(", "));
      if (item.subject) parts.push("Subject: " + item.subject);
      if (bodyText) parts.push("", bodyText);
      try {
        await tauri.core.invoke("copy_text", { text: parts.join("\n") });
        showToast({ kind: "success", title: "Draft copied", body: "Paste into Mail or Outlook." });
      } catch (err) {
        showToast({ kind: "error", title: "Copy failed", body: String(err) });
      }
    });
    actions.appendChild(copyBtn);
  }

  const sentBtn = document.createElement("button");
  sentBtn.type = "button";
  sentBtn.className = "btn btn-primary btn-compact";
  sentBtn.textContent = "Mark sent";
  sentBtn.addEventListener("click", () => outboxDecide(item.id, "sent", card));
  actions.appendChild(sentBtn);

  card.appendChild(actions);

  return card;
}

async function outboxDecide(itemId, action, card) {
  try {
    await tauri.core.invoke("outbox_decide", { itemId, action });
    if (card && card.parentNode) card.parentNode.removeChild(card);
    const remaining = document.querySelectorAll("#outbox-list .record-card").length;
    const statusEl = document.getElementById("outbox-status");
    if (remaining === 0 && statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent = "No staged items.";
    }
  } catch (err) {
    showToast({ kind: "error", title: "Couldn't update", body: String(err) });
  }
}

async function enterOutboxView() {
  state.inWizard = false;
  showView("view-outbox");
  setNav([{ label: "Outbox" }], { active: "outbox", back: () => goHome() });

  const listEl = document.getElementById("outbox-list");
  const statusEl = document.getElementById("outbox-status");
  if (listEl) listEl.innerHTML = "";
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.dataset.kind = "loading";
    statusEl.textContent = "Loading staged outbox…";
  }

  let data;
  try {
    data = await tauri.core.invoke("fetch_outbox");
  } catch (err) {
    console.warn("[main] fetch_outbox failed:", err);
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "error";
      statusEl.textContent =
        "Couldn't reach Apolla. Check your connection in Settings, then Refresh.";
    }
    return;
  }

  const items = Array.isArray(data && data.items) ? data.items : [];
  if (listEl) {
    // Guard each card so one malformed item can't silently blank the whole list.
    for (const item of items) {
      try {
        listEl.appendChild(renderOutboxCard(item));
      } catch (e) {
        console.warn("[main] renderOutboxCard failed for", item && item.id, e);
      }
    }
  }
  if (statusEl) {
    if (items.length === 0) {
      statusEl.hidden = false;
      statusEl.dataset.kind = "empty";
      statusEl.textContent =
        'No staged items. Use "Draft follow-up" on a commitment to stage one.';
    } else {
      statusEl.hidden = true;
    }
  }
}

// Wire the Outbox header buttons once (idempotent onclick assignment).
(function wireOutboxHeaderButtons() {
  const wire = () => {
    const home = document.getElementById("btn-outbox-home");
    if (home) home.onclick = () => goHome();
    const refresh = document.getElementById("btn-outbox-refresh");
    if (refresh) refresh.onclick = () => enterOutboxView();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();

// ── "Draft follow-up" — feed the producer from a decision-log commitment ──
//
// Maps a record (decision/commitment with a single `owner`) onto the producer's
// ProducerActionItem (owner → executor) and POSTs via the outbox_propose IPC.
// The staged draft then appears in the Outbox surface + the Outlook add-in.
async function draftFollowUpFromRecord(rec) {
  await stageOutboxDraft({
    id: "rec:" + (rec.recordId || rec.summary || ""),
    title: rec.summary ? "Follow up: " + rec.summary : "Follow up",
    detail: rec.summary || "",
    intent: "email",
    executor: rec.owner || undefined,
    dueDate: rec.due || undefined,
    sourceKind: rec.type === "decision" ? "decision" : "commitment",
    sourceLabel: rec.summary || rec.recordId || "",
  });
}

// Shared producer-staging path: POST one ProducerActionItem via outbox_propose
// so it lands in the Outbox surface + the Outlook add-in. Used by the follow-up
// control AND the decision Share draft — one path, identical toast feedback.
async function stageOutboxDraft(item) {
  try {
    const res = await tauri.core.invoke("outbox_propose", { items: [item] });
    const created = (res && Array.isArray(res.created) && res.created.length) || 0;
    showToast(
      created > 0
        ? {
            kind: "success",
            title: "Draft staged",
            body: "Find it in Outbox, or bring it forward from the Threshold add-in in Outlook.",
          }
        : { kind: "success", title: "Already staged", body: "This draft is already in your Outbox." },
    );
    return true;
  } catch (err) {
    showToast({ kind: "error", title: "Couldn't stage draft", body: String(err) });
    return false;
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

function handlePlaudDisconnectClick() {
  const overlay = pgOverlay();
  const pane = document.createElement("div");
  pane.className = "pg-pane pg-confirm";
  const title = document.createElement("div");
  title.className = "pg-pane-title";
  title.textContent = "Disconnect Plaud locally?";
  pane.appendChild(title);
  const bodyEl = document.createElement("div");
  bodyEl.className = "pg-confirm-body";
  bodyEl.textContent =
    "This clears Threshold's cached connection status. " +
    "Plaud tokens remain on the droplet — SSH in and delete " +
    "/home/deploy/.plaud/tokens.json to fully revoke.";
  pane.appendChild(bodyEl);
  const actions = document.createElement("div");
  actions.className = "pg-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pg-btn pg-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => pgClose(overlay));
  const go = document.createElement("button");
  go.type = "button";
  go.className = "pg-btn pg-btn-primary";
  go.textContent = "Disconnect";
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "Disconnecting…";
    try {
      await tauri.core.invoke("plaud_disconnect_soft_clear");
      pgClose(overlay);
      renderPlaudConnectionCard(null, { busy: false });
      const bannerEl = document.getElementById("plaud-disconnect-banner");
      if (bannerEl) bannerEl.hidden = false;
    } catch (err) {
      pgClose(overlay);
      showToast({
        kind: "failure",
        title: "Disconnect failed",
        body: String(err),
      });
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  pane.appendChild(actions);
  overlay.appendChild(pane);
  document.body.appendChild(overlay);
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

// Selectable sweep cadences (minutes) for the Auto-import view dropdown.
const AUTO_IMPORT_INTERVAL_CHOICES = [1, 5, 15, 30, 60];
const AUTO_IMPORT_INTERVAL_DEFAULT = 15;

function normalizeAutoImportConfig(cfg) {
  const rawInterval = cfg && Number(cfg.intervalMinutes);
  const intervalMinutes =
    Number.isFinite(rawInterval) && rawInterval >= 1
      ? Math.round(rawInterval)
      : AUTO_IMPORT_INTERVAL_DEFAULT;
  return {
    enabled: !!(cfg && cfg.enabled),
    onenoteNotebooks: (cfg && cfg.onenoteNotebooks) || [],
    plaudDevices: (cfg && cfg.plaudDevices) || [],
    intervalMinutes,
  };
}

// Initialise the auto-import block that lives inside the Configure pane's
// OneNote section. Called whenever the Configure pane is opened.
async function initConfigAutoImport() {
  if (!document.getElementById("config-auto-import-body")) return;
  state.autoImport.mode = "list";

  // Persisted config first (fast), render, then enrich with the available
  // sources (slower — may hit OneNote COM + the Plaud inbox).
  try {
    const cfg = await tauri.core.invoke("get_auto_import_config");
    state.autoImport.config = normalizeAutoImportConfig(cfg);
  } catch (err) {
    console.warn("[auto-import] get_auto_import_config failed:", err);
    state.autoImport.config = {
      enabled: false,
      onenoteNotebooks: [],
      plaudDevices: [],
      intervalMinutes: AUTO_IMPORT_INTERVAL_DEFAULT,
    };
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
  // fresh data — but only if the Configure pane (and its container) is present.
  const view = document.getElementById("view-configure");
  if (view && !view.hidden && document.getElementById("config-auto-import-body")) {
    renderAutoImport();
  }
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
  const body = document.getElementById("config-auto-import-body");
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

  // Master toggle row — the sweep-interval selector sits inline on this row
  // (between the label and the toggle) so there's no separate interval card.
  const master = buildAutoImportRow({
    kind: "master",
    iconSvg: AI_ICON_SYNC,
    name: "Auto-import",
    meta: cfg.enabled
      ? enabledCount === 1
        ? "On · 1 source · checks every " + autoImportIntervalLabel(cfg.intervalMinutes)
        : `On · ${enabledCount} sources · checks every ` + autoImportIntervalLabel(cfg.intervalMinutes)
      : "Off — nothing imports automatically",
    checked: !!cfg.enabled,
  });
  const intervalSelect = buildAutoImportIntervalSelect(cfg.intervalMinutes);
  master
    .querySelector(".auto-import-toggle")
    .addEventListener("click", handleAutoImportMasterToggle);
  // Insert the interval selector just before the toggle switch.
  master.insertBefore(intervalSelect, master.querySelector(".auto-import-toggle"));
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
      id: onenoteSourceKey(s),
      name: s.sectionId ? `${s.name} · ${s.sectionName || "section"}` : s.name,
      enabled: s.enabled,
      meta: !onenoteSupported
        ? (s.sectionId ? "Section" : "Notebook") + " · Windows-only, paused on this Mac"
        : s.sectionId
          ? "Section"
          : "Whole notebook",
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

function autoImportIntervalLabel(mins) {
  if (mins === 60) return "1 hour";
  if (mins === 1) return "1 minute";
  return `${mins} minutes`;
}

// The sweep-interval <select>, rendered inline on the master Auto-import row
// (no standalone card). Returns just the element so the caller can place it.
function buildAutoImportIntervalSelect(current) {
  const select = document.createElement("select");
  select.className = "auto-import-interval-select";
  select.setAttribute("aria-label", "Auto-import frequency");
  // Include the persisted value even if it isn't one of the presets (e.g. a
  // hand-edited config), so the dropdown always reflects reality.
  const choices = AUTO_IMPORT_INTERVAL_CHOICES.includes(current)
    ? AUTO_IMPORT_INTERVAL_CHOICES
    : [...AUTO_IMPORT_INTERVAL_CHOICES, current].sort((a, b) => a - b);
  for (const m of choices) {
    const opt = document.createElement("option");
    opt.value = String(m);
    opt.textContent = `Every ${autoImportIntervalLabel(m)}`;
    if (m === current) opt.selected = true;
    select.appendChild(opt);
  }
  // Don't let a click on the select bubble to the row (avoids odd focus jumps).
  select.addEventListener("click", (e) => e.stopPropagation());
  select.addEventListener("change", handleAutoImportIntervalChange);
  return select;
}

async function handleAutoImportIntervalChange(e) {
  const mins = Number(e.target.value);
  if (!Number.isFinite(mins) || mins < 1) return;
  state.autoImport.config.intervalMinutes = mins;
  await persistAutoImport();
  // Re-render so the master row's "checks every …" summary reflects the change.
  renderAutoImport();
}

async function handleAutoImportMasterToggle() {
  state.autoImport.config.enabled = !state.autoImport.config.enabled;
  await persistAutoImport();
  renderAutoImport();
}

// A OneNote auto-import source is identified by the (notebook, section) pair:
// `notebookId::` is a whole-notebook watch; `notebookId::sectionId` scopes it
// to one section. Plaud sources stay keyed by serialNumber.
function onenoteSourceKey(s) {
  return `${s.notebookId}::${s.sectionId || ""}`;
}

async function handleAutoImportToggleSource(kind, id) {
  const cfg = state.autoImport.config;
  const src =
    kind === "plaud"
      ? (cfg.plaudDevices || []).find((s) => s.serialNumber === id)
      : (cfg.onenoteNotebooks || []).find((s) => onenoteSourceKey(s) === id);
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
    cfg.onenoteNotebooks = (cfg.onenoteNotebooks || []).filter((s) => onenoteSourceKey(s) !== id);
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

  // OneNote group — a notebook → section tree. Each notebook offers a
  // "Whole notebook" row plus one row per section; already-designated entries
  // (matched on the composite key) are hidden.
  const onLabel = document.createElement("p");
  onLabel.className = "auto-import-section-label";
  onLabel.textContent = "OneNote";
  body.appendChild(onLabel);

  if (!avail.onenoteSupported) {
    body.appendChild(
      autoImportPickerHint(
        "OneNote auto-import is Windows-only — notebooks can't be listed on this Mac."
      )
    );
  } else {
    const haveKeys = new Set((cfg.onenoteNotebooks || []).map(onenoteSourceKey));
    let addedAny = false;
    for (const nb of avail.onenote || []) {
      // Rows available for this notebook (whole + each not-yet-added section).
      const rows = [];
      const wholeKey = `${nb.id}::`;
      if (!haveKeys.has(wholeKey)) {
        rows.push(
          buildAutoImportPickerRow("onenote", { id: nb.id, name: nb.name }, "Whole notebook")
        );
      }
      for (const sec of nb.sections || []) {
        const secKey = `${nb.id}::${sec.id}`;
        if (haveKeys.has(secKey)) continue;
        rows.push(
          buildAutoImportPickerRow(
            "onenote",
            { id: nb.id, name: nb.name, sectionId: sec.id, sectionName: sec.name },
            sec.name,
            { section: true }
          )
        );
      }
      if (rows.length === 0) continue;
      addedAny = true;
      const nbLabel = document.createElement("p");
      nbLabel.className = "auto-import-picker-group";
      nbLabel.textContent = nb.name;
      body.appendChild(nbLabel);
      const wrap = document.createElement("div");
      wrap.className = "auto-import-picker";
      for (const r of rows) wrap.appendChild(r);
      body.appendChild(wrap);
    }
    if (!addedAny) {
      body.appendChild(
        autoImportPickerHint(
          "Nothing to add. Open OneNote (and Refresh) — already-designated notebooks and sections are hidden."
        )
      );
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

function buildAutoImportPickerRow(kind, option, metaLabel, { section = false } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = section ? "auto-import-picker-row auto-import-picker-row--section" : "auto-import-picker-row";
  const name = document.createElement("span");
  name.className = "auto-import-picker-name";
  // For OneNote section rows the visible name is the section; the notebook is
  // already shown as the group header above.
  name.textContent = section ? option.sectionName : option.name;
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
    const newSrc = {
      notebookId: option.id,
      name: option.name,
      enabled: true,
      ...(option.sectionId
        ? { sectionId: option.sectionId, sectionName: option.sectionName }
        : {}),
    };
    const key = onenoteSourceKey(newSrc);
    if (!cfg.onenoteNotebooks.some((s) => onenoteSourceKey(s) === key)) {
      cfg.onenoteNotebooks.push(newSrc);
    }
  }
  // Adding a source implies the user wants auto-import on.
  if (!cfg.enabled) cfg.enabled = true;
  await persistAutoImport();
  const addedLabel =
    kind === "onenote" && option.sectionId
      ? `${option.name} · ${option.sectionName}`
      : option.name;
  showToast({
    kind: "success",
    title: "Source added",
    body: `${addedLabel} will auto-import new items.`,
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
  // WP-T2b — "sign in with a different account" from the Settings Account block.
  const settingsSignInBtn = document.getElementById("btn-settings-signin");
  if (settingsSignInBtn) settingsSignInBtn.addEventListener("click", handleSettingsSignIn);

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
  // Settings master-detail — left-rail group switching.
  for (const item of document.querySelectorAll(".settings-nav-item")) {
    item.addEventListener("click", () => switchSettingsPanel(item.dataset.panel));
  }
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

  // WP-CASCADE-PRODUCTION WP-T1 — Proxy inbox buttons. Same defensive posture
  // as the Plaud block above.
  const proxyRefreshBtn = document.getElementById("btn-proxy-refresh");
  if (proxyRefreshBtn) {
    proxyRefreshBtn.addEventListener("click", () => refreshProxyQueue());
  }
  const proxyBackBtn = document.getElementById("btn-proxy-back");
  if (proxyBackBtn) {
    proxyBackBtn.addEventListener("click", async () => {
      try {
        await tauri.core.invoke("widget_collapse");
      } catch (err) {
        console.warn("[main] widget_collapse (proxy-back) failed:", err);
      }
    });
  }
  const proxyFiledToggle = document.getElementById("proxy-filed-toggle");
  if (proxyFiledToggle) {
    proxyFiledToggle.addEventListener("click", toggleProxyFiledPile);
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
  // WP-Outlook-Writeback — Install Outlook Add-in (generates a pre-configured
  // manifest URL from the saved connection). Defensive optional chaining
  // mirrors the Plaud buttons above.
  const outlookAddinBtn = document.getElementById("btn-outlook-addin-install");
  if (outlookAddinBtn) {
    outlookAddinBtn.addEventListener("click", handleOutlookAddinInstallClick);
  }

  // Connections doctor re-check (WP-ONBOARD)
  document.getElementById("btn-doctor-refresh")?.addEventListener("click", () => {
    renderIntegrationDoctor();
  });
  // Phase-progress events fire from the Rust orchestrator; listener is
  // process-wide (no view-bound teardown needed — the Plaud card lives in
  // Settings → Integrations and reads status on Settings open).
  wirePlaudConnectStatusListener().catch((err) => {
    console.warn("[main] wirePlaudConnectStatusListener failed:", err);
  });

  // Drag-drop visuals (the actual ingestion is wired in wireBackendEvents)
  wireDragVisuals();

  bootstrap();
});
