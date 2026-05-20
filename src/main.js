// Viktora Threshold — Phase B Increment 1 frontend.
// Renders the D-12-19 OCR utility probe result so we can validate the
// startup probe works end-to-end inside the bundled .app.
//
// Subsequent increments replace this minimal placeholder with the
// 3-screen wizard + Configure pane + main capture UI.

const tauri = window.__TAURI__;

async function renderOcrStatus() {
  const statusEl = document.getElementById("ocr-status");
  const pathEl = document.getElementById("ocr-path");

  if (!tauri) {
    // Running in a plain browser preview (no Tauri runtime).
    statusEl.innerHTML =
      '<span class="status fail">No Tauri runtime</span> &nbsp; ' +
      "This page is being previewed outside the bundled .app. The D-12-19 probe runs " +
      "in the Rust shell, not the webview, so the probe result is only visible when the " +
      "Tauri-built .app launches.";
    return;
  }

  try {
    const result = await tauri.core.invoke("get_ocr_utility_status");
    if (result.installed) {
      statusEl.innerHTML = '<span class="status ok">Installed</span>';
      pathEl.textContent = "Resolved absolute path: " + result.path;
    } else {
      statusEl.innerHTML = '<span class="status fail">Not installed</span>';
      pathEl.textContent = result.message || "";
    }
  } catch (err) {
    statusEl.innerHTML =
      '<span class="status fail">IPC error</span> &nbsp; ' +
      "Failed to invoke get_ocr_utility_status command.";
    pathEl.textContent = String(err);
  }
}

window.addEventListener("DOMContentLoaded", renderOcrStatus);
