// Viktora Threshold — frontend router + wizard + Configure pane logic.
// WP-OCR-12 v1.2-FINAL Phase B increment 3.
//
// Routing model: vanilla DOM view-swapping. Five sections:
//   #view-loading      → bootstrap
//   #view-welcome      → wizard step 1 (first-launch only, P-12-05)
//   #view-configure    → wizard step 2 OR standalone Configure pane
//   #view-done         → wizard step 3 (first-launch only)
//   #view-main         → main capture UI
//
// Bootstrap flow:
//   1. invoke load_config
//   2. None → wizard (Welcome → Configure-in-wizard → Done → Main)
//   3. Some(cfg) → Main directly (skips wizard per AC-11)
//
// Standalone Configure (from Main's "Configure" button) skips wizard chrome
// and offers a Back button.

const tauri = window.__TAURI__;

// ───────── State ─────────

const state = {
  // True while we're walking the 3-screen wizard. Determines:
  //   • Save button label ("Next" vs "Save")
  //   • Configure form's step-indicator visibility
  //   • Where Save navigates next (Done vs Main)
  inWizard: false,
  // Cached after Save so the Done screen can transition to Main with the right cfg.
  lastConfig: null,
};

// ───────── View routing ─────────

const VIEWS = ["view-loading", "view-welcome", "view-configure", "view-done", "view-main"];

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

  let cfg = null;
  try {
    cfg = await tauri.core.invoke("load_config");
  } catch (err) {
    console.error("load_config failed:", err);
    cfg = null;
  }

  if (cfg) {
    // Returning user — pre-populate fields in case they hit Configure later
    document.getElementById("config-base-url").value = cfg.base_url || "";
    document.getElementById("config-bearer-token").value = cfg.bearer_token || "";
    enterMainView(cfg);
  } else {
    // First launch — start the wizard
    enterWizardWelcome();
  }
}

// ───────── Wizard chrome ─────────

function enterWizardWelcome() {
  state.inWizard = true;
  showView("view-welcome");
}

function enterWizardConfigure() {
  state.inWizard = true;
  // Show step indicator, hide back button, change Save → Next
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

// ───────── Standalone Configure (post-onboarding) ─────────

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

// ───────── Configure form logic (shared between wizard step 2 + standalone) ─────────

function showConnectionResult(resultEl, result) {
  resultEl.removeAttribute("hidden");
  resultEl.className = "result " + (result.ok ? "ok" : "fail");
  let html = "<strong>" + (result.ok ? "✓ " : "✗ ") + escapeHtml(result.message) + "</strong>";
  if (result.detail) html += escapeHtml(result.detail);
  resultEl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function handleTestConnection() {
  const baseUrl = document.getElementById("config-base-url").value.trim();
  const resultEl = document.getElementById("connection-result");
  const btn = document.getElementById("btn-test-connection");

  if (!baseUrl) {
    showConnectionResult(resultEl, {
      ok: false,
      message: "Enter a base URL first.",
      detail: null,
    });
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

  const config = {
    base_url: baseUrl,
    bearer_token: bearerToken,
    last_used: null,
    mode: "workspace",
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

  // Navigate based on wizard vs standalone mode
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

  await renderOcrStatusInMain();
}

async function renderOcrStatusInMain() {
  const statusEl = document.getElementById("main-ocr-status");
  const pathEl = document.getElementById("main-ocr-path");
  if (!statusEl || !pathEl) return;

  try {
    const result = await tauri.core.invoke("get_ocr_utility_status");
    if (result.installed) {
      statusEl.innerHTML =
        '<span class="status-pill ok">Installed</span>';
      pathEl.textContent = result.path;
    } else {
      statusEl.innerHTML =
        '<span class="status-pill fail">Not installed</span>';
      pathEl.textContent = result.message || "";
    }
  } catch (err) {
    statusEl.textContent = "Failed to query OCR utility status: " + String(err);
  }
}

// ───────── Event wiring ─────────

window.addEventListener("DOMContentLoaded", () => {
  // Wizard step 1 → step 2
  document
    .getElementById("btn-wizard-start")
    .addEventListener("click", enterWizardConfigure);

  // Wizard step 3 prompts — for v1, all three nav to Main (capture flows wire up in increment 4)
  document.querySelectorAll(".wizard-prompt").forEach((btn) => {
    btn.addEventListener("click", finishWizard);
  });
  document
    .getElementById("btn-wizard-finish")
    .addEventListener("click", finishWizard);

  // Configure form
  document
    .getElementById("btn-test-connection")
    .addEventListener("click", handleTestConnection);
  document.getElementById("configure-form").addEventListener("submit", handleSave);

  // Standalone Configure entry/exit
  document.getElementById("btn-open-configure").addEventListener("click", () => {
    enterStandaloneConfigure();
  });
  document.getElementById("btn-back-to-main").addEventListener("click", () => {
    enterMainView(state.lastConfig);
  });

  bootstrap();
});
