// Viktora Threshold — Mac desktop capture app for Apolla workspaces.
// WP-OCR-12 v1.2-FINAL Phase B scaffold.
//
// This file provides the Phase B increment 1 foundation:
//   - App state management (cached OCR utility absolute path)
//   - D-12-19 startup probe for the `ocr-capture` binary (bypasses launchd PATH)
//   - get_ocr_utility_status IPC command (for the wizard + main UI to render
//     enabled/disabled Capture Screen button per AC-7)
//
// Subsequent Phase B increments will add: config load/save, test_connection,
// file-upload ingestion, drag-drop ingestion, screencapture subprocess,
// structured-toast emit, lenient response deserialization (D-12-17), and the
// 3-screen onboarding wizard wiring.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

/// App-wide state. Wrapped in a Mutex because Tauri's IPC commands are async-callable
/// from multiple windows / handlers concurrently.
pub struct AppState {
    /// Absolute path to the `ocr-capture` binary, resolved at startup via D-12-19 probe.
    /// `None` means the binary was not found at any of the canonical install locations;
    /// the Capture Screen button must be disabled in the UI (per AC-7).
    pub ocr_capture_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
pub struct OcrUtilityStatus {
    pub installed: bool,
    pub path: Option<String>,
    /// Human-readable explanation if not installed; suitable for the disabled-button tooltip.
    pub message: Option<String>,
}

/// D-12-19 — OCR utility absolute-path probe.
///
/// macOS GUI-launched .app bundles inherit a minimal launchd PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) that does NOT include ~/.local/bin,
/// /opt/homebrew/bin, or /usr/local/bin — confirmed empirically during
/// Phase A primitive (f) on 2026-05-20. So we probe absolute paths at
/// startup and cache the result; all subsequent subprocess invocations
/// use the cached absolute path, bypassing PATH resolution entirely.
fn probe_ocr_capture() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".local").join("bin").join("ocr-capture"),
        PathBuf::from("/opt/homebrew/bin/ocr-capture"),
        PathBuf::from("/usr/local/bin/ocr-capture"),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            log::info!("D-12-19 probe: ocr-capture found at {}", candidate.display());
            return Some(candidate.clone());
        }
    }
    log::warn!("D-12-19 probe: ocr-capture not found at any canonical location");
    None
}

#[tauri::command]
fn get_ocr_utility_status(state: tauri::State<AppState>) -> OcrUtilityStatus {
    let guard = state.ocr_capture_path.lock().expect("AppState mutex poisoned");
    match &*guard {
        Some(p) => OcrUtilityStatus {
            installed: true,
            path: Some(p.to_string_lossy().into_owned()),
            message: None,
        },
        None => OcrUtilityStatus {
            installed: false,
            path: None,
            message: Some(
                "OCR utility not installed. Run `bash setup.sh` from the viktora-threshold repo \
                 to install it via pipx, then restart Viktora Threshold."
                    .into(),
            ),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let ocr_path = probe_ocr_capture();
            app.manage(AppState {
                ocr_capture_path: Mutex::new(ocr_path),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_ocr_utility_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
