// Viktora Threshold — frontend router + Configure pane logic.
// WP-OCR-12 v1.2-FINAL Phase B increment 2.
//
// Routing model: simple hash-based view swap. We toggle the `hidden` attribute
// on three sections (#view-loading, #view-configure, #view-main). No framework.
//
// Bootstrap flow:
//   1. Page loads → #view-loading visible
//   2. invoke load_config → None → navigate to #view-configure (first-launch
//      per D-12-15 + AC-11); Some(cfg) → navigate to #view-main
//   3. Configure pane: paste URL + token → Test connection → Save → main
//   4. Main view loads OCR utility status (D-12-19 probe result)
//
// Subsequent increments add: wizard wrapping (3 screens), main capture UI
// (file picker, drag-drop, screenshot subprocess), structured toast.

const tauri = window.__TAURI__;

// ───────── View routing ─────────

const VIEWS = ["view-loading", "view-configure", "view-main"];

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
    // Browser-preview fallback. The actual IPC commands need the Tauri runtime.
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
    // Treat load failure as first-launch (corrupt config → start over).
    cfg = null;
  }

  if (cfg) {
    // Pre-populate Configure pane in case user navigates back via "Configure"
    document.getElementById("config-base-url").value = cfg.base_url || "";
    document.getElementById("config-bearer-token").value = cfg.bearer_token || "";
    enterMainView(cfg);
  } else {
    enterConfigureView();
  }
}

// ───────── Configure pane ─────────

function enterConfigureView() {
  showView("view-configure");
  document.getElementById("config-base-url").focus();
}

function showConnectionResult(resultEl, result) {
  resultEl.removeAttribute("hidden");
  resultEl.className = "result " + (result.ok ? "ok" : "fail");
  let html = "<strong>" + (result.ok ? "✓ " : "✗ ") + escapeHtml(result.message) + "</strong>";
  if (result.detail) {
    html += escapeHtml(result.detail);
  }
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
    enterMainView(config);
  } catch (err) {
    showConnectionResult(resultEl, {
      ok: false,
      message: "Failed to save configuration",
      detail: String(err),
    });
  }
}

// ───────── Main view ─────────

async function enterMainView(cfg) {
  showView("view-main");

  // Update subtitle with current connection
  const subtitleEl = document.getElementById("main-subtitle");
  if (subtitleEl) {
    subtitleEl.textContent = "Connected to " + cfg.base_url;
  }

  // Render OCR utility status (D-12-19 probe result)
  await renderOcrStatusInMain();
}

async function renderOcrStatusInMain() {
  const statusEl = document.getElementById("main-ocr-status");
  const pathEl = document.getElementById("main-ocr-path");
  if (!statusEl || !pathEl) return;

  try {
    const result = await tauri.core.invoke("get_ocr_utility_status");
    if (result.installed) {
      statusEl.innerHTML = '<span class="result ok" style="display:inline-block;padding:3px 10px;margin:0;border-left:none;border-radius:12px;font-size:12px;">Installed</span>';
      pathEl.textContent = result.path;
    } else {
      statusEl.innerHTML = '<span class="result fail" style="display:inline-block;padding:3px 10px;margin:0;border-left:none;border-radius:12px;font-size:12px;">Not installed</span>';
      pathEl.textContent = result.message || "";
    }
  } catch (err) {
    statusEl.textContent = "Failed to query OCR utility status: " + String(err);
  }
}

// ───────── Event wiring ─────────

window.addEventListener("DOMContentLoaded", () => {
  document
    .getElementById("btn-test-connection")
    .addEventListener("click", handleTestConnection);

  document.getElementById("configure-form").addEventListener("submit", handleSave);

  document.getElementById("btn-open-configure").addEventListener("click", () => {
    enterConfigureView();
  });

  bootstrap();
});
