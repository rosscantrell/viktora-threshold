// Viktora Threshold — Mac desktop capture app for Apolla workspaces.
// WP-OCR-12 v1.2-FINAL Phase B scaffold.
//
// Increment 1: AppState + D-12-19 OCR utility probe + get_ocr_utility_status IPC
// Increment 2: AppConfig persistence (D-12-07) + Configure pane IPC (load_config,
//              save_config, test_connection)
//
// Subsequent increments add: 3-screen wizard wrapper, capture flows, structured
// toast component, lenient response deserialization, window-close lifecycle.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// ───────────────────────────────────────────────────────────────────────────
// AppState
// ───────────────────────────────────────────────────────────────────────────

/// App-wide state. Mutex-wrapped because Tauri IPC commands can be invoked
/// concurrently from multiple webview handlers.
pub struct AppState {
    /// D-12-19: absolute path to `ocr-capture` resolved at startup.
    /// `None` → binary not installed; Capture Screen button must be disabled.
    pub ocr_capture_path: Mutex<Option<PathBuf>>,
}

// ───────────────────────────────────────────────────────────────────────────
// D-12-19: OCR utility probe
// ───────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OcrUtilityStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub message: Option<String>,
}

/// D-12-19 — macOS GUI-launched .app bundles inherit launchd PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) which excludes ~/.local/bin,
/// /opt/homebrew/bin, and /usr/local/bin. We probe absolute paths at
/// startup and cache the result; subsequent subprocess invocations
/// bypass PATH resolution entirely.
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

// ───────────────────────────────────────────────────────────────────────────
// D-12-07: AppConfig persistence at ~/Library/Application Support/Viktora Threshold/config.json
// ───────────────────────────────────────────────────────────────────────────

/// AppConfig schema. `mode` is reserved for v2 (FN-OCR-12-14 free-tier mode)
/// but always 'workspace' in v1. `serde(default)` on the struct makes loading
/// forward-compatible: future fields land as defaults rather than errors.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    pub base_url: String,
    pub bearer_token: String,
    pub last_used: Option<String>,
    pub mode: String, // 'workspace' for v1; 'free-tier' reserved for v2
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:3001".into(),
            bearer_token: String::new(),
            last_used: None,
            mode: "workspace".into(),
        }
    }
}

fn config_dir() -> Option<PathBuf> {
    // dirs::config_dir() on macOS returns ~/Library/Application Support
    dirs::config_dir().map(|p| p.join("Viktora Threshold"))
}

fn config_path() -> Option<PathBuf> {
    config_dir().map(|p| p.join("config.json"))
}

/// Load config from disk. Returns Ok(None) if the file doesn't exist (first launch);
/// Ok(Some(_)) if loaded successfully; Err if the file exists but is corrupt.
#[tauri::command]
fn load_config() -> Result<Option<AppConfig>, String> {
    let path = config_path().ok_or_else(|| "Could not resolve config directory".to_string())?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
    let config: AppConfig =
        serde_json::from_str(&raw).map_err(|e| format!("Config file corrupt: {}", e))?;
    log::info!("Loaded config from {}", path.display());
    Ok(Some(config))
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    let mut to_write = config;
    // Stamp last_used on save
    to_write.last_used = Some(chrono_iso_now());
    let json = serde_json::to_string_pretty(&to_write)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    log::info!("Saved config to {}", path.display());
    Ok(())
}

/// Minimal ISO 8601 UTC timestamp without pulling in chrono crate.
fn chrono_iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // ISO 8601 in UTC: gmtime via libc isn't available in std, so emit epoch seconds
    // formatted in a parseable way. This is a v1 simplification — replace with
    // chrono::Utc::now().to_rfc3339() if the timestamp needs to be human-readable
    // in config.json. For now, last_used is informational only.
    format!("{}Z", now)
}

// ───────────────────────────────────────────────────────────────────────────
// D-12-14: Test connection (GET /api/health)
// ───────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub status_code: Option<u16>,
    pub message: String,
    pub detail: Option<String>,
}

#[tauri::command]
async fn test_connection(base_url: String) -> ConnectionTestResult {
    let url = format!("{}/api/health", base_url.trim_end_matches('/'));

    let client = match reqwest::Client::builder()
        // Accept locally-trusted certs (mkcert) for WP-OCR-08 local-HTTPS mode
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ConnectionTestResult {
                ok: false,
                status_code: None,
                message: "Failed to build HTTP client".into(),
                detail: Some(format!("{}", e)),
            }
        }
    };

    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                ConnectionTestResult {
                    ok: true,
                    status_code: Some(status.as_u16()),
                    message: format!("Connected to {} (status {}).", url, status.as_u16()),
                    detail: None,
                }
            } else {
                ConnectionTestResult {
                    ok: false,
                    status_code: Some(status.as_u16()),
                    message: format!("Server returned status {} from {}.", status.as_u16(), url),
                    detail: Some(
                        "The server is reachable but the health endpoint didn't return 2xx. \
                         Verify the schema-browser is running and that the base URL is correct."
                            .into(),
                    ),
                }
            }
        }
        Err(e) => {
            let detail = if e.is_timeout() {
                "Connection timed out (10s). The server may be unreachable, or the URL may be wrong."
                    .to_string()
            } else if e.is_connect() {
                "Connection refused. Is the schema-browser running at this URL?".to_string()
            } else {
                format!("{}", e)
            };
            ConnectionTestResult {
                ok: false,
                status_code: None,
                message: format!("Could not reach {}", url),
                detail: Some(detail),
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Tauri builder
// ───────────────────────────────────────────────────────────────────────────

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
        // D-12-02 — quit-on-window-close (launch-on-demand UX).
        // The Tauri default on macOS is to keep the process alive when all
        // windows close; we override to exit the app instead. This is the
        // base D-12-02 behavior; increment 4 layers D-12-02-AMEND on top
        // (wait for in-flight ingestions before exiting).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_ocr_utility_status,
            load_config,
            save_config,
            test_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
