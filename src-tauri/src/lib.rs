// Viktora Threshold — Mac desktop capture app for Apolla workspaces.
// WP-OCR-12 v1.2-FINAL Phase B scaffold (increment 4).
//
// Increment 1: AppState + D-12-19 OCR probe + get_ocr_utility_status
// Increment 2: AppConfig persistence (D-12-07) + Configure pane IPC
// Increment 3: Base D-12-02 quit-on-window-close
// Increment 4: File-upload ingestion + drag-drop ingestion + lenient response
//              handling (D-12-17) + D-12-02-AMEND (wait for in-flight before
//              exit) + structured toast emit (D-12-18 paired with frontend)
// Increment 5: Screenshot subprocess via D-12-19 cached path + setup.sh + tests

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

// WP-OCR-13 Phase A — Mac in-process Vision OCR (D-13-02, AC-2).
#[cfg(target_os = "macos")]
mod ocr_mac;

// WP-OCR-13 Phase B — Windows in-process OCR (D-13-03, AC-3).
#[cfg(target_os = "windows")]
mod ocr_windows;

// WP-Threshold-Compact-UX Phase 2 — Mac NSPanel-style shim for the floating
// widget (D-CUX-04 architectural fix; addresses Phase 1 S-CUX-03 PARTIAL
// finding that the Tauri 2 high-level window config doesn't prevent
// focus-steal on click).
#[cfg(target_os = "macos")]
mod widget_platform_mac;

// WP-Threshold-Compact-UX Phase 3 — Windows WS_EX_NOACTIVATE shim for the
// floating widget. By symmetry with the Phase 2 Mac shim; Windows is the
// happier path because WS_EX_NOACTIVATE is a documented HWND extended
// style (not panel-class-restricted like Mac's
// NSWindowStyleMaskNonactivatingPanel).
#[cfg(target_os = "windows")]
mod widget_platform_windows;

// ───────────────────────────────────────────────────────────────────────────
// Globals (D-12-02-AMEND: in-flight ingestion counter)
// ───────────────────────────────────────────────────────────────────────────

/// Atomic counter incremented at the start of every ingestion request and
/// decremented when the response (or error) is processed. D-12-02-AMEND
/// reads this on window-close to decide whether to exit immediately or
/// wait for pending POSTs to resolve.
///
/// Static (not state-managed) because the close handler runs outside the
/// IPC command context where State<T> is normally available, and a global
/// atomic is the simplest path to a process-wide counter.
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Maximum wait for in-flight ingestions to drain before exiting anyway.
const SHUTDOWN_MAX_WAIT: Duration = Duration::from_secs(60);

// ───────────────────────────────────────────────────────────────────────────
// AppState
// ───────────────────────────────────────────────────────────────────────────

pub struct AppState {
    /// Cached config for capture flows; populated on first load_config call.
    pub config: Mutex<Option<AppConfig>>,
}

// ───────────────────────────────────────────────────────────────────────────
// Allowed plain-text extensions (D-12-05)
// ───────────────────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS: &[&str] = &["txt", "md", "vtt", "srt", "html"];

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
}

fn is_allowed_extension(path: &Path) -> bool {
    extension_lower(path)
        .map(|e| ALLOWED_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or(false)
}

// ───────────────────────────────────────────────────────────────────────────
// D-12-07 AppConfig persistence
// ───────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    pub base_url: String,
    pub bearer_token: String,
    pub last_used: Option<String>,
    pub mode: String,
    /// WP-Threshold-Compact-UX D-CUX-16 — widget screen position, persisted
    /// across launches. Both fields optional + #[serde(default)] so v0.2
    /// configs without these fields deserialize cleanly (additive-only
    /// schema delta per v1.1-FINAL audit item 12). Default to None →
    /// Tauri's `center: true` config kicks in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widget_x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widget_y: Option<i32>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:3001".into(),
            bearer_token: String::new(),
            last_used: None,
            mode: "workspace".into(),
            widget_x: None,
            widget_y: None,
        }
    }
}

fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("Viktora Threshold"))
}

fn config_path() -> Option<PathBuf> {
    config_dir().map(|p| p.join("config.json"))
}

#[tauri::command]
fn load_config(state: tauri::State<AppState>) -> Result<Option<AppConfig>, String> {
    let path = config_path().ok_or_else(|| "Could not resolve config directory".to_string())?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
    let config: AppConfig =
        serde_json::from_str(&raw).map_err(|e| format!("Config file corrupt: {}", e))?;
    log::info!("Loaded config from {}", path.display());
    // Cache in AppState so ingestion commands don't need to re-read disk
    *state.config.lock().expect("config mutex poisoned") = Some(config.clone());
    Ok(Some(config))
}

#[tauri::command]
fn save_config(state: tauri::State<AppState>, config: AppConfig) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    let mut to_write = config.clone();
    to_write.last_used = Some(Utc::now().to_rfc3339());
    let json = serde_json::to_string_pretty(&to_write)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    log::info!("Saved config to {}", path.display());
    *state.config.lock().expect("config mutex poisoned") = Some(to_write);
    Ok(())
}

// ───────────────────────────────────────────────────────────────────────────
// D-12-14 Test connection
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
                        "The server is reachable but the health endpoint didn't return 2xx."
                            .into(),
                    ),
                }
            }
        }
        Err(e) => {
            let detail = if e.is_timeout() {
                "Connection timed out (10s).".to_string()
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
// Ingestion pipeline (file picker + drag-drop)
// ───────────────────────────────────────────────────────────────────────────

/// D-12-17 — lenient response shape. Every field optional; unknown fields
/// silently ignored. v2 marker tidbit can land in this struct without
/// breaking older clients.
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct IngestServerResponse {
    pub indexed: Option<bool>,
    #[serde(rename = "alreadyExisted")]
    pub already_existed: Option<bool>,
    #[serde(rename = "termsExtracted")]
    pub terms_extracted: Option<Vec<String>>,
    pub title: Option<String>,
    pub warning: Option<String>,
    pub error: Option<String>,
    // v2: pub marker: Option<MarkerTidbit>,
    // Future fields land here as Option<T> with serde(default) at struct level
}

/// Outcome of a single ingestion. Frontend renders this as a structured toast.
#[derive(Serialize, Clone)]
pub struct IngestionOutcome {
    pub kind: String, // "success" | "idempotent" | "failure"
    pub title: String,
    pub body: Option<String>,
    pub source_path: Option<String>,
}

fn compute_document_id(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let result = hasher.finalize();
    let hex_str = hex::encode(result);
    format!("DESKTOP-{}", &hex_str[..16])
}

/// Build the JSON payload for file-upload ingestion (file picker + drag-drop).
///
/// WP-OCR-12 D-OCR-08 contract: `captureMethod = 'desktop-app-file-upload'`.
/// `sourceApp` is Threshold's own bundle ID — the file came in via the
/// desktop app, not from a third-party app being captured.
fn build_file_payload(path: &Path, content: &str) -> serde_json::Value {
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();
    serde_json::json!({
        "documentId": compute_document_id(content),
        "title": title,
        "content": content,
        "sourceMetadata": {
            "captureMethod": "desktop-app-file-upload",
            "sourceApp": "ai.viktora.threshold",
            "capturedAt": Utc::now().to_rfc3339()
        }
    })
}

/// Build the JSON payload for region-screenshot ingestion (Capture Screen,
/// WP-OCR-13 v0.2).
///
/// AC-19 contract:
/// - `captureMethod: 'screenshot-ocr'`  — canonical taxonomy (D-OCR-08); matches OCR-utility v0.1.1 wire format
/// - `captureMode:   'region'`          — D-REG-04 sub-classifier
/// - `captureTool:   'threshold'`       — P-13-09 (c) NEW v0.2 cross-surface attribution
/// - `sourceApp:     <bundle ID of frontmost app at capture time>` — best-effort; empty string on lookup failure
/// - `capturedAt:    ISO 8601 UTC`
///
/// Title = first non-empty OCR line, capped at 80 chars (parallels WP-OCR-01
/// D-OCR-11 title-derivation convention).
fn build_screenshot_payload(text: &str, source_app: &str) -> serde_json::Value {
    let title = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(80).collect::<String>())
        .unwrap_or_else(|| "(empty capture)".to_string());

    serde_json::json!({
        "documentId": compute_document_id(text),
        "title": title,
        "content": text,
        "sourceMetadata": {
            "captureMethod": "screenshot-ocr",
            "captureMode": "region",
            "captureTool": "threshold",
            "sourceApp": source_app,
            "capturedAt": Utc::now().to_rfc3339()
        }
    })
}

/// POST a built JSON payload to `/api/ingest-document` on the configured
/// Apolla backend. Owns response handling, lenient deserialization (D-12-17),
/// and `IngestionOutcome` construction. Shared by both file-upload
/// (`ingest_one_file`) and screen-capture (`run_screen_capture`) paths.
///
/// `display_name` is the human-readable label used in toast titles when the
/// server doesn't return one (e.g., file basename, or `"screen capture"`).
/// `source_path` lets the frontend disambiguate toasts — file path for
/// file uploads, sentinel `"__screen_capture__"` for region captures.
///
/// reqwest client config is load-bearing for WP-OCR-08 local-HTTPS mode
/// (rustls-tls + `danger_accept_invalid_certs(true)` accepts the
/// mkcert-provisioned local CA); 60s timeout absorbs LLM extraction latency.
async fn post_payload_to_apolla(
    payload: serde_json::Value,
    cfg: &AppConfig,
    display_name: &str,
    source_path: Option<String>,
) -> IngestionOutcome {
    let url = format!(
        "{}/api/ingest-document",
        cfg.base_url.trim_end_matches('/')
    );

    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: "HTTP client init failed".into(),
                body: Some(format!("{}", e)),
                source_path,
            };
        }
    };

    let req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .json(&payload);

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let detail = if e.is_timeout() {
                "Server timed out (60s). LLM extraction may be slow or the server may be unreachable."
                    .to_string()
            } else if e.is_connect() {
                "Connection refused. Is the schema-browser running at the configured base URL?".into()
            } else {
                format!("{}", e)
            };
            return IngestionOutcome {
                kind: "failure".into(),
                title: format!("Couldn't reach Apolla: {}", display_name),
                body: Some(detail),
                source_path,
            };
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let detail = if status.as_u16() == 401 {
            "Server rejected the bearer token. Check your INGESTION_API_KEY in Configure.".into()
        } else if status.as_u16() == 429 {
            "Rate-limited by the server. Wait a moment and retry.".into()
        } else {
            format!("HTTP {} from {}: {}", status.as_u16(), url, body_text)
        };
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Server returned {}", status.as_u16()),
            body: Some(detail),
            source_path,
        };
    }

    // Lenient deserialization (D-12-17)
    let parsed: IngestServerResponse = match response.json().await {
        Ok(p) => p,
        Err(e) => {
            // 2xx but body unparseable — treat as success with warning.
            return IngestionOutcome {
                kind: "success".into(),
                title: format!("Captured: {}", display_name),
                body: Some(format!(
                    "Server returned 2xx but response body couldn't be parsed: {}",
                    e
                )),
                source_path,
            };
        }
    };

    let server_title = parsed
        .title
        .clone()
        .unwrap_or_else(|| display_name.to_string());
    let term_count = parsed
        .terms_extracted
        .as_ref()
        .map(|v| v.len())
        .unwrap_or(0);

    if parsed.already_existed.unwrap_or(false) {
        IngestionOutcome {
            kind: "idempotent".into(),
            title: format!("Already captured: {}", server_title),
            // Surfacing the dedup mechanism: idempotency is content-hash
            // based, so the same bytes from a different filename/directory
            // still match. (Pilot empirical: Ross had two copies in
            // different folders and was confused by the idempotent toast.)
            body: Some(
                "The content matches a previous capture (possibly from a different location)."
                    .into(),
            ),
            source_path,
        }
    } else {
        IngestionOutcome {
            kind: "success".into(),
            title: format!("Captured: {}", server_title),
            body: Some(format!("Extracted {} term(s).", term_count)),
            source_path,
        }
    }
}

/// POST the file content to /api/ingest-document. Returns the IngestionOutcome
/// that the frontend will render as a toast.
async fn ingest_one_file(path: PathBuf, cfg: &AppConfig) -> IngestionOutcome {
    let source_path = Some(path.to_string_lossy().into_owned());
    let display_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    // Extension allow-list (D-12-05)
    if !is_allowed_extension(&path) {
        let ext = extension_lower(&path).unwrap_or_else(|| "(none)".to_string());
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Unsupported file type: .{}", ext),
            body: Some(format!(
                "Threshold v1 ingests plain-text formats only ({}). Skipped: {}",
                ALLOWED_EXTENSIONS.join(", "),
                display_name
            )),
            source_path,
        };
    }

    // Read the file
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: format!("Couldn't read {}", display_name),
                body: Some(format!("{}", e)),
                source_path,
            };
        }
    };

    if content.trim().is_empty() {
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Empty file: {}", display_name),
            body: Some("File contains no text content.".into()),
            source_path,
        };
    }

    // Build payload + POST (D-12-13: from Rust shell, no Origin header).
    // WP-OCR-13: POST mechanics live in `post_payload_to_apolla` so the
    // screen-capture path can reuse them with the same client config.
    let payload = build_file_payload(&path, &content);
    post_payload_to_apolla(payload, cfg, &display_name, source_path).await
}

/// Helper: pull the current config out of AppState; error if not configured.
fn current_config(state: &tauri::State<AppState>) -> Result<AppConfig, String> {
    state
        .config
        .lock()
        .expect("config mutex poisoned")
        .clone()
        .ok_or_else(|| {
            "Threshold is not configured. Visit Configure and enter your Apolla base URL + bearer token first.".to_string()
        })
}

/// Frontend invokes this with the file picker's chosen path(s). Each file
/// is processed sequentially with its own toast.
#[tauri::command]
async fn ingest_files(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let cfg = current_config(&state)?;
    for path_str in paths {
        let path = PathBuf::from(path_str);
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        let outcome = ingest_one_file(path, &cfg).await;
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        // Emit a structured toast event (D-12-18)
        let _ = app_handle.emit("threshold://toast", outcome);
    }
    Ok(())
}

/// Open the native macOS file picker (NSOpenPanel via tauri-plugin-dialog)
/// filtered to the plain-text extensions in ALLOWED_EXTENSIONS.
#[tauri::command]
async fn pick_files(app_handle: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app_handle
        .dialog()
        .file()
        .add_filter("Plain-text formats", &["txt", "md", "vtt", "srt", "html"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });

    let chosen = rx.await.ok().flatten().unwrap_or_default();
    chosen
        .into_iter()
        .filter_map(|fp| fp.into_path().ok())
        .filter_map(|pb| pb.to_str().map(String::from))
        .collect()
}

// ───────────────────────────────────────────────────────────────────────────
// Capture Screen — WP-OCR-13 v0.2 native in-process OCR
// ───────────────────────────────────────────────────────────────────────────
//
// Mac:     `/usr/sbin/screencapture -i` for the region crosshair (D-13-04),
//          then Vision framework in-process for OCR (D-13-02 via objc2-vision).
// Windows: `ms-screenclip:` URI for the snipping crosshair (D-13-05), then
//          Windows.Media.Ocr in-process (D-13-03 via the `windows` crate).
// Other:   file upload + drag-drop still work; Capture Screen returns a
//          structured "not supported on this platform" toast.

/// Start a native window drag for the widget. Phase 1 spike fallback for
/// S-CUX-05 — the JS-side `getCurrentWindow().startDragging()` path was
/// empirically unreliable on the widget config (Mac, focus:false +
/// transparent:true + decorations:false + alwaysOnTop:true). Going through
/// Rust gives us direct access to the window handle.
///
/// Called from widget.js once the JS mousemove heuristic decides the user
/// is dragging (displacement > threshold). Returns Ok(()) on success;
/// returns the error string if start_dragging fails.
#[tauri::command]
fn widget_start_drag(window: tauri::Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|e| format!("start_dragging failed: {}", e))
}

/// Persist the widget's current screen position to AppConfig
/// (WP-Threshold-Compact-UX D-CUX-16). Called from a debounced JS
/// handler tied to the window's `Moved` event so we don't write the
/// config file on every pixel of drag motion.
///
/// Resilient to partial state: if no AppConfig is cached (user hasn't
/// hit Configure yet), we lazy-default + populate widget_{x,y}. Save
/// failures log but don't propagate to the JS layer — the user moving
/// the widget should never see a toast.
#[tauri::command]
fn save_widget_position(state: tauri::State<AppState>, x: i32, y: i32) -> Result<(), String> {
    let mut cfg_guard = state.config.lock().expect("config mutex poisoned");
    let mut cfg = cfg_guard.clone().unwrap_or_default();
    cfg.widget_x = Some(x);
    cfg.widget_y = Some(y);
    // Don't touch last_used — that's tracked on Configure-pane saves.

    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    if let Err(e) = fs::create_dir_all(&dir) {
        return Err(format!("Failed to create config dir: {}", e));
    }
    let path = dir.join("config.json");
    let json = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;

    *cfg_guard = Some(cfg);
    log::debug!("widget position saved: ({x}, {y})");
    Ok(())
}

/// Read back the persisted widget position from cached AppConfig. The
/// widget JS calls this on init and, if a saved position exists,
/// invokes the Tauri window API to move to it. Defaults to None →
/// Tauri's `center: true` config kicks in.
#[tauri::command]
fn get_widget_position(state: tauri::State<AppState>) -> Option<(i32, i32)> {
    let cfg = state.config.lock().expect("config mutex poisoned");
    cfg.as_ref().and_then(|c| match (c.widget_x, c.widget_y) {
        (Some(x), Some(y)) => Some((x, y)),
        _ => None,
    })
}

// ───────────────────────────────────────────────────────────────────────────
// WP-Threshold-Compact-UX Phase 2D + 2E — right-click menu + expand toggle
// ───────────────────────────────────────────────────────────────────────────

/// Menu item IDs (D-CUX-15). String literals shared between the menu
/// builder and the `on_menu_event` handler so the dispatch stays single
/// source of truth.
const MENU_CAPTURE: &str = "menu.capture";
const MENU_PICK_FILE: &str = "menu.pick_file";
const MENU_EXPAND: &str = "menu.expand";
const MENU_SETTINGS: &str = "menu.settings";
const MENU_QUIT: &str = "menu.quit";
/// Debug-only: surfaces a "Open Console" item in the right-click menu
/// that opens Tauri's devtools for diagnosis. Constant + menu builder
/// branch + event handler arm are all #[cfg(debug_assertions)] gated so
/// release builds don't carry the dead-code reference.
#[cfg(debug_assertions)]
const MENU_DEVTOOLS: &str = "menu.devtools";

/// Build the widget's native right-click context menu. Per D-CUX-15:
///   Capture Screen / Pick File… / Expand… / Settings… / Quit Threshold
fn build_widget_menu(
    app: &tauri::AppHandle,
) -> Result<tauri::menu::Menu<tauri::Wry>, tauri::Error> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let capture = MenuItem::with_id(app, MENU_CAPTURE, "Capture Screen", true, None::<&str>)?;
    let pick_file = MenuItem::with_id(app, MENU_PICK_FILE, "Pick File…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let expand = MenuItem::with_id(app, MENU_EXPAND, "Expand…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Threshold", true, None::<&str>)?;

    // Debug-only Open Console item — strip in release builds via the
    // `#[cfg(debug_assertions)]` attribute (NOT the runtime `cfg!()`
    // macro — that one still compiles the body, which would fail to
    // resolve the cfg-gated `MENU_DEVTOOLS` constant in release builds).
    // Lets developers (and Ross during pilot) open the webview's
    // devtools without fighting AppKit/Win32 for the default "Inspect
    // Element" context-menu option (we override it wholesale).
    #[cfg(debug_assertions)]
    {
        let devtools = MenuItem::with_id(app, MENU_DEVTOOLS, "Open Console", true, None::<&str>)?;
        let sep_dev = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(
            app,
            &[
                &capture,
                &pick_file,
                &sep1,
                &expand,
                &settings,
                &sep2,
                &quit,
                &sep_dev,
                &devtools,
            ],
        );
    }

    #[allow(unreachable_code)]
    Menu::with_items(
        app,
        &[
            &capture,
            &pick_file,
            &sep1,
            &expand,
            &settings,
            &sep2,
            &quit,
        ],
    )
}

/// Show the widget's right-click context menu at the cursor. Called from
/// widget.js when the user right-clicks the widget.
#[tauri::command]
fn show_widget_menu(
    app_handle: tauri::AppHandle,
    webview_window: tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri::menu::ContextMenu;
    let menu = build_widget_menu(&app_handle).map_err(|e| e.to_string())?;
    menu.popup(webview_window.as_ref().window().clone())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Expand the widget into the full v0.2 UI (D-CUX-13, AC-CUX-07).
///
/// Operations (in order):
///   1. Save current widget position so collapse can restore it
///   2. Resize window 100x100 → 800x600
///   3. Re-enable decorations + disable always-on-top so it behaves like a
///      regular app window
///   4. Navigate webview to index.html
///   5. Bring to front + focus
///
/// `target_tab` (currently "main" or "configure") gets stashed in a URL
/// fragment so the expanded UI's main.js can route to the right initial
/// view without a separate IPC handshake.
#[tauri::command]
fn widget_expand(
    state: tauri::State<AppState>,
    webview_window: tauri::WebviewWindow,
    target_tab: Option<String>,
) -> Result<(), String> {
    let window = &webview_window;
    // Step 1: save widget position before resizing (so collapse can return).
    if let Ok(pos) = window.outer_position() {
        let mut cfg_guard = state.config.lock().expect("config mutex poisoned");
        let mut cfg = cfg_guard.clone().unwrap_or_default();
        cfg.widget_x = Some(pos.x);
        cfg.widget_y = Some(pos.y);
        let _ = save_config_to_disk(&cfg);
        *cfg_guard = Some(cfg);
    }

    // Step 2: resize.
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 800.0,
            height: 600.0,
        }))
        .map_err(|e| format!("set_size failed: {e}"))?;

    // Step 3: window chrome.
    window
        .set_decorations(true)
        .map_err(|e| format!("set_decorations failed: {e}"))?;
    window
        .set_always_on_top(false)
        .map_err(|e| format!("set_always_on_top failed: {e}"))?;
    window
        .set_resizable(true)
        .map_err(|e| format!("set_resizable failed: {e}"))?;

    // Step 4: navigate to expanded UI. The URL fragment tells main.js
    // which view to land in. window.eval is the cleanest cross-platform
    // navigation; window.navigate exists in Tauri 2 but isn't available
    // on all webview backends.
    let fragment = target_tab.as_deref().unwrap_or("main");
    let nav = format!(
        "window.location.replace('index.html#{}');",
        fragment.replace('\'', "")
    );
    window
        .eval(&nav)
        .map_err(|e| format!("eval(navigate) failed: {e}"))?;

    // Step 5: focus.
    let _ = window.set_focus();

    log::info!("widget expanded → target_tab={}", fragment);
    Ok(())
}

/// Collapse the expanded UI back to the floating widget. Restores
/// widget size, position, chrome, and navigates back to widget.html.
#[tauri::command]
fn widget_collapse(
    state: tauri::State<AppState>,
    webview_window: tauri::WebviewWindow,
) -> Result<(), String> {
    let window = &webview_window;
    // Reverse the expand operations.
    window
        .set_always_on_top(true)
        .map_err(|e| format!("set_always_on_top failed: {e}"))?;
    window
        .set_decorations(false)
        .map_err(|e| format!("set_decorations failed: {e}"))?;
    window
        .set_resizable(false)
        .map_err(|e| format!("set_resizable failed: {e}"))?;
    // Widget shape — keep in lockstep with tauri.conf.json's window config
    // (180x80 horizontal pill).
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 180.0,
            height: 80.0,
        }))
        .map_err(|e| format!("set_size failed: {e}"))?;

    // Restore widget position from cached config (the value we stashed in
    // widget_expand). If absent, Tauri keeps the current position.
    let saved = {
        let cfg = state.config.lock().expect("config mutex poisoned");
        cfg.as_ref().and_then(|c| match (c.widget_x, c.widget_y) {
            (Some(x), Some(y)) => Some((x, y)),
            _ => None,
        })
    };
    if let Some((x, y)) = saved {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }

    window
        .eval("window.location.replace('widget.html');")
        .map_err(|e| format!("eval(navigate) failed: {e}"))?;

    log::info!("widget collapsed");
    Ok(())
}

/// Helper for the expand path: persist `cfg` to disk without the
/// last_used touch. Save failures log but don't propagate.
fn save_config_to_disk(cfg: &AppConfig) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

/// Capture a region from the screen and POST the OCR'd text to the configured
/// Apolla backend. Platform dispatch lives inside; see ocr_mac / ocr_windows
/// for the per-platform implementations.
#[tauri::command]
async fn run_screen_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cfg = current_config(&state)?;

    #[cfg(target_os = "macos")]
    {
        run_screen_capture_mac(app_handle, cfg).await;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        run_screen_capture_windows(app_handle, cfg).await;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app_handle.emit(
            "threshold://toast",
            IngestionOutcome {
                kind: "failure".into(),
                title: "Screen capture not supported on this platform".into(),
                body: Some(
                    "Native in-process OCR is available on macOS + Windows. \
                     File upload + drag-drop work everywhere."
                        .into(),
                ),
                source_path: Some("__screen_capture__".into()),
            },
        );
        // `cfg` is unused on platforms that don't dispatch into a backend.
        let _ = cfg;
        Ok(())
    }
}

/// Mac-side capture pipeline: screencapture -i (region crosshair) + Vision
/// OCR (in-process via objc2-vision). Wraps the synchronous capture in
/// `tokio::task::spawn_blocking` so the runtime thread isn't blocked.
#[cfg(target_os = "macos")]
async fn run_screen_capture_mac(app_handle: tauri::AppHandle, cfg: AppConfig) {
    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);

    // `screencapture` + Vision are both synchronous blocking calls; offload
    // to a blocking worker so the tokio runtime stays responsive.
    let capture_outcome = tokio::task::spawn_blocking(ocr_mac::capture_and_ocr_mac)
        .await
        .unwrap_or_else(|join_err| {
            Err(ocr_mac::CaptureError::OcrFailed(format!(
                "blocking task panicked: {join_err}"
            )))
        });

    let outcome = match capture_outcome {
        Ok(result) if result.text.trim().is_empty() => IngestionOutcome {
            kind: "failure".into(),
            title: "Capture had no text".into(),
            body: Some(
                "Vision OCR returned no recognizable text in the selected region."
                    .into(),
            ),
            source_path: Some("__screen_capture__".into()),
        },
        Ok(result) => {
            // AC-19 payload: captureMethod/captureMode/captureTool/sourceApp.
            // KNOWN LIMITATION: on Mac, sourceApp currently ships "" for
            // widget-triggered captures. NSWorkspace.frontmostApplication
            // returns Threshold's bundle ID at click time (the widget steals
            // focus on click despite Phase 2A's attempts); the
            // is_threshold_own_bundle_id filter catches the self-reference
            // and returns None → "". Honest unknown over misleading data.
            // The proper NSPanel-style fix is deferred (see notes at
            // `widget_platform_mac::apply_non_activating_widget_style`).
            log::debug!("capture sourceApp = {:?}", result.source_app);
            let payload = build_screenshot_payload(&result.text, &result.source_app);
            post_payload_to_apolla(
                payload,
                &cfg,
                "screen capture",
                Some("__screen_capture__".into()),
            )
            .await
        }
        Err(ocr_mac::CaptureError::CancelledByUser) => IngestionOutcome {
            kind: "failure".into(),
            title: "Region capture cancelled".into(),
            body: Some("You pressed Esc during region select. No capture sent.".into()),
            source_path: Some("__screen_capture__".into()),
        },
        Err(e) => IngestionOutcome {
            kind: "failure".into(),
            title: "Capture failed".into(),
            body: Some(format!("{}", e)),
            source_path: Some("__screen_capture__".into()),
        },
    };

    IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    let _ = app_handle.emit("threshold://toast", outcome);
}

/// Windows-side capture pipeline: `ms-screenclip:` URI (D-13-05) + arboard
/// clipboard polling (D-13-06) + Windows.Media.Ocr in-process (D-13-03).
/// Wraps the synchronous capture in `tokio::task::spawn_blocking` so the
/// 60s clipboard poll doesn't stall the tokio runtime.
#[cfg(target_os = "windows")]
async fn run_screen_capture_windows(app_handle: tauri::AppHandle, cfg: AppConfig) {
    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);

    let capture_outcome = tokio::task::spawn_blocking(ocr_windows::capture_and_ocr_windows)
        .await
        .unwrap_or_else(|join_err| {
            Err(ocr_windows::CaptureError::OcrFailed(format!(
                "blocking task panicked: {join_err}"
            )))
        });

    let outcome = match capture_outcome {
        Ok(result) if result.text.trim().is_empty() => IngestionOutcome {
            kind: "failure".into(),
            title: "Capture had no text".into(),
            body: Some(
                "Windows.Media.Ocr returned no recognizable text in the selected region."
                    .into(),
            ),
            source_path: Some("__screen_capture__".into()),
        },
        Ok(result) => {
            // AC-19 payload literals — same shape + values as the Mac path
            // (build_screenshot_payload is platform-agnostic by design).
            let payload = build_screenshot_payload(&result.text, &result.source_app);
            post_payload_to_apolla(
                payload,
                &cfg,
                "screen capture",
                Some("__screen_capture__".into()),
            )
            .await
        }
        Err(ocr_windows::CaptureError::Timeout) => IngestionOutcome {
            kind: "failure".into(),
            // AC-8 Windows wording.
            title: "Capture timed out — did you cancel?".into(),
            body: Some(
                "No image landed on the clipboard within 60 seconds. \
                 If you started a snip but didn't release, try again."
                    .into(),
            ),
            source_path: Some("__screen_capture__".into()),
        },
        Err(ocr_windows::CaptureError::SnipLaunchFailed(code)) => IngestionOutcome {
            kind: "failure".into(),
            title: "Couldn't open the Snipping Tool".into(),
            // D-13-12: ms-screenclip: URI requires Win10 May 2020 update or later.
            body: Some(format!(
                "ShellExecuteW returned {code}. \
                 Capture Screen requires Windows 10 May 2020 update (build 19041) or later \
                 — please update Windows, or use file upload / drag-drop in the meantime."
            )),
            source_path: Some("__screen_capture__".into()),
        },
        Err(ocr_windows::CaptureError::ClipboardError(msg)) => IngestionOutcome {
            kind: "failure".into(),
            title: "Clipboard access failed".into(),
            body: Some(format!("{msg}. Try again, or restart Threshold.")),
            source_path: Some("__screen_capture__".into()),
        },
        Err(ocr_windows::CaptureError::OcrFailed(msg)) => IngestionOutcome {
            kind: "failure".into(),
            title: "Capture failed".into(),
            body: Some(msg),
            source_path: Some("__screen_capture__".into()),
        },
    };

    IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    let _ = app_handle.emit("threshold://toast", outcome);
}

// ───────────────────────────────────────────────────────────────────────────
// D-12-02-AMEND: wait for in-flight ingestions before exit
// ───────────────────────────────────────────────────────────────────────────

fn handle_close_requested(window: &tauri::Window) {
    let in_flight = IN_FLIGHT.load(Ordering::SeqCst);
    if in_flight == 0 {
        // No pending work — exit immediately (base D-12-02)
        window.app_handle().exit(0);
        return;
    }
    // D-12-02-AMEND: wait for pending POSTs to drain (up to SHUTDOWN_MAX_WAIT).
    // The window is already hiding; the user perceives the close as instant.
    log::info!(
        "D-12-02-AMEND: waiting for {} in-flight ingestion(s) to drain",
        in_flight
    );
    let app_handle = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let start = std::time::Instant::now();
        loop {
            let count = IN_FLIGHT.load(Ordering::SeqCst);
            if count == 0 {
                log::info!("D-12-02-AMEND: in-flight drained; exiting");
                break;
            }
            if start.elapsed() > SHUTDOWN_MAX_WAIT {
                log::warn!(
                    "D-12-02-AMEND: SHUTDOWN_MAX_WAIT exceeded; exiting with {} still in-flight",
                    count
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        app_handle.exit(0);
    });
}

// ───────────────────────────────────────────────────────────────────────────
// Tauri builder
// ───────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // WP-OCR-13 v0.2: in-process Vision (Mac) / Windows.Media.Ocr (Windows)
            // replaces the v0.1 D-12-19 startup probe for `~/.local/bin/ocr-capture`.
            // AppState's only remaining field is the cached config — populated on
            // first `load_config` IPC call, not at startup.
            app.manage(AppState {
                config: Mutex::new(None),
            });

            // WP-Threshold-Compact-UX Phase 2 D-CUX-04: apply the
            // non-activating-panel shim to the widget's NSWindow on Mac.
            // Without this, clicking the widget's Capture button steals
            // focus → NSWorkspace returns Threshold's own bundle ID →
            // sourceApp ships empty (filter catches the leak). With it,
            // sourceApp ships the user's actual target app's bundle ID.
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    match window.ns_window() {
                        Ok(ns_window) => {
                            if let Err(e) =
                                widget_platform_mac::apply_non_activating_widget_style(ns_window)
                            {
                                log::warn!(
                                    "widget_platform_mac shim failed: {e} — \
                                     falling back to the is_threshold_own_bundle_id filter \
                                     catching focus-steals; sourceApp may ship empty"
                                );
                            } else {
                                log::info!("widget_platform_mac: non-activating shim applied");
                            }
                        }
                        Err(e) => {
                            log::warn!("could not obtain NSWindow handle: {e}");
                        }
                    }
                } else {
                    log::warn!("could not find 'main' window during setup");
                }
            }

            // WP-Threshold-Compact-UX Phase 3 D-CUX-04 (Windows side):
            // apply WS_EX_NOACTIVATE to the widget HWND so click doesn't
            // make Threshold the foreground window. Symmetric with the
            // Mac branch above; Windows side is expected to actually
            // work (WS_EX_NOACTIVATE is a regular HWND extended style,
            // not panel-class-restricted like Mac's
            // NSWindowStyleMaskNonactivatingPanel).
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    match window.hwnd() {
                        Ok(hwnd) => {
                            if let Err(e) =
                                widget_platform_windows::apply_non_activating_widget_style(hwnd)
                            {
                                log::warn!(
                                    "widget_platform_windows shim failed: {e} — \
                                     falling back to the is_threshold_own_exe filter \
                                     catching focus-steals; sourceApp may ship empty"
                                );
                            } else {
                                log::info!(
                                    "widget_platform_windows: non-activating shim applied"
                                );
                            }
                        }
                        Err(e) => {
                            log::warn!("could not obtain HWND handle: {e}");
                        }
                    }
                } else {
                    log::warn!("could not find 'main' window during setup");
                }
            }

            Ok(())
        })
        // D-12-02 + D-12-02-AMEND: quit-on-window-close, waiting for in-flight
        // ingestions to drain (up to SHUTDOWN_MAX_WAIT) before exiting.
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if IN_FLIGHT.load(Ordering::SeqCst) > 0 {
                        // Prevent the default close; window stays alive while the async
                        // task waits for ingestions to drain, then exits the app entirely.
                        api.prevent_close();
                        let _ = window.hide();
                        handle_close_requested(window);
                    } else {
                        // No pending work — exit immediately
                        window.app_handle().exit(0);
                    }
                }
                // Capture drag-drop events at the window level (D-12-13: paths
                // delivered to Rust shell, not to the webview JS layer).
                // Enter / Leave events surface visual drop-target feedback on
                // the widget's upload button (Phase 2 UI polish).
                tauri::WindowEvent::DragDrop(drag_event) => match drag_event {
                    tauri::DragDropEvent::Enter { .. } => {
                        let _ = window.emit("threshold://drag-enter", ());
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = window.emit("threshold://drag-leave", ());
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let path_strs: Vec<String> = paths
                            .iter()
                            .filter_map(|p| p.to_str().map(String::from))
                            .collect();
                        let _ = window.emit("threshold://drop-paths", path_strs);
                    }
                    _ => {}
                },
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            test_connection,
            ingest_files,
            pick_files,
            run_screen_capture,
            widget_start_drag,
            save_widget_position,
            get_widget_position,
            show_widget_menu,
            widget_expand,
            widget_collapse
        ])
        .on_menu_event(|app, event| {
            // D-CUX-15 dispatch table. Each ID maps to a deferred action.
            // The async ones (capture, pick_file) spawn a task because
            // on_menu_event is sync; window APIs are sync so they can run
            // inline.
            let id = event.id().0.clone();
            log::debug!("menu event: {id}");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let window = match app.get_webview_window("main") {
                    Some(w) => w,
                    None => {
                        log::warn!("menu event {id}: no 'main' window");
                        return;
                    }
                };
                let state = app.state::<AppState>();
                match id.as_str() {
                    MENU_CAPTURE => {
                        if let Err(e) = run_screen_capture(app.clone(), state).await {
                            log::warn!("menu capture failed: {e}");
                        }
                    }
                    MENU_PICK_FILE => match pick_files(app.clone()).await {
                        paths if !paths.is_empty() => {
                            if let Err(e) =
                                ingest_files(app.clone(), app.state::<AppState>(), paths).await
                            {
                                log::warn!("menu pick_file ingest failed: {e}");
                            }
                        }
                        _ => log::debug!("menu pick_file: user cancelled"),
                    },
                    MENU_EXPAND => {
                        if let Err(e) =
                            widget_expand(app.state::<AppState>(), window.clone(), None)
                        {
                            log::warn!("menu expand failed: {e}");
                        }
                    }
                    MENU_SETTINGS => {
                        if let Err(e) = widget_expand(
                            app.state::<AppState>(),
                            window.clone(),
                            Some("configure".into()),
                        ) {
                            log::warn!("menu settings failed: {e}");
                        }
                    }
                    MENU_QUIT => {
                        log::info!("menu quit");
                        // D-12-02-AMEND drains in-flight ingestions before
                        // exiting; the existing close handler covers this.
                        app.exit(0);
                    }
                    #[cfg(debug_assertions)]
                    MENU_DEVTOOLS => {
                        // Debug-only — see build_widget_menu's matching
                        // cfg-gated branch. Opens the webview's devtools
                        // (Web Inspector on Mac / Chromium DevTools on
                        // Windows) for the widget window.
                        window.open_devtools();
                        log::info!("menu open_devtools");
                    }
                    other => log::warn!("menu event unhandled: {other}"),
                }
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ───────────────────────────────────────────────────────────────────────────
// Unit tests (Phase B AC-15)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // ───── documentId generation (D-OCR-06 / D-ADDIN-05 convention) ─────

    #[test]
    fn document_id_is_deterministic() {
        let id1 = compute_document_id("hello world");
        let id2 = compute_document_id("hello world");
        assert_eq!(id1, id2);
    }

    #[test]
    fn document_id_uses_desktop_prefix_and_16_hex_chars() {
        let id = compute_document_id("hello world");
        assert!(id.starts_with("DESKTOP-"));
        assert_eq!(id.len(), "DESKTOP-".len() + 16);
        // After the prefix, only hex chars
        let suffix = &id["DESKTOP-".len()..];
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn document_id_changes_with_content() {
        let id1 = compute_document_id("hello world");
        let id2 = compute_document_id("hello world!");
        assert_ne!(id1, id2);
    }

    // ───── Extension allow-list (D-12-05) ─────

    #[test]
    fn allowed_extensions_accept_lowercase() {
        for ext in &["txt", "md", "vtt", "srt", "html"] {
            let path = format!("test.{}", ext);
            assert!(
                is_allowed_extension(Path::new(&path)),
                "Expected .{} to be allowed",
                ext
            );
        }
    }

    #[test]
    fn allowed_extensions_accept_uppercase() {
        for ext in &["TXT", "MD", "VTT", "SRT", "HTML"] {
            let path = format!("test.{}", ext);
            assert!(
                is_allowed_extension(Path::new(&path)),
                "Expected .{} to be allowed (case-insensitive)",
                ext
            );
        }
    }

    #[test]
    fn allowed_extensions_reject_unsupported() {
        for ext in &["docx", "pdf", "jpg", "png", "xlsx", "pptx"] {
            let path = format!("test.{}", ext);
            assert!(
                !is_allowed_extension(Path::new(&path)),
                "Expected .{} to be rejected",
                ext
            );
        }
    }

    #[test]
    fn allowed_extensions_reject_no_extension() {
        assert!(!is_allowed_extension(Path::new("README")));
        assert!(!is_allowed_extension(Path::new("path/to/file")));
    }

    // ───── D-12-17 lenient response deserialization (AC-14) ─────

    #[test]
    fn lenient_response_accepts_extra_unknown_fields() {
        let json = r#"{
            "indexed": true,
            "alreadyExisted": false,
            "termsExtracted": ["alpha", "beta"],
            "title": "test doc",
            "marker": { "future": "v2 field" },
            "someOtherUnknown": 42
        }"#;
        let parsed: IngestServerResponse =
            serde_json::from_str(json).expect("Lenient deserialization should not error");
        assert_eq!(parsed.indexed, Some(true));
        assert_eq!(parsed.already_existed, Some(false));
        assert_eq!(
            parsed.terms_extracted,
            Some(vec!["alpha".to_string(), "beta".to_string()])
        );
        assert_eq!(parsed.title, Some("test doc".to_string()));
        // Unknown 'marker' and 'someOtherUnknown' fields silently ignored
    }

    #[test]
    fn lenient_response_handles_missing_fields() {
        let json = r#"{"indexed": true}"#;
        let parsed: IngestServerResponse = serde_json::from_str(json).expect("should parse");
        assert_eq!(parsed.indexed, Some(true));
        assert_eq!(parsed.already_existed, None);
        assert_eq!(parsed.terms_extracted, None);
        assert_eq!(parsed.title, None);
    }

    #[test]
    fn lenient_response_handles_empty_object() {
        let parsed: IngestServerResponse =
            serde_json::from_str("{}").expect("empty object should parse");
        assert_eq!(parsed.indexed, None);
        assert_eq!(parsed.already_existed, None);
        assert_eq!(parsed.terms_extracted, None);
    }

    // ───── AppConfig defaults ─────

    #[test]
    fn config_default_uses_localhost_and_workspace_mode() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.base_url, "http://localhost:3001");
        assert_eq!(cfg.mode, "workspace");
        assert!(cfg.bearer_token.is_empty());
        assert!(cfg.last_used.is_none());
    }

    #[test]
    fn config_round_trips_through_json() {
        let cfg = AppConfig {
            base_url: "https://hosted.viktora.ai".to_string(),
            bearer_token: "test-token-123".to_string(),
            last_used: Some("2026-05-21T16:00:00Z".to_string()),
            mode: "workspace".to_string(),
            widget_x: Some(1820),
            widget_y: Some(980),
        };
        let json = serde_json::to_string(&cfg).expect("should serialize");
        let parsed: AppConfig = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed.base_url, cfg.base_url);
        assert_eq!(parsed.bearer_token, cfg.bearer_token);
        assert_eq!(parsed.widget_x, cfg.widget_x);
        assert_eq!(parsed.widget_y, cfg.widget_y);
        assert_eq!(parsed.last_used, cfg.last_used);
        assert_eq!(parsed.mode, cfg.mode);
    }

    // ───── Screenshot payload (WP-OCR-13 AC-19) ─────
    //
    // Round-trip the screenshot payload through `serde_json::Value` and
    // assert the exact field literals required by AC-19:
    //   captureMethod = 'screenshot-ocr'   (D-OCR-08 canonical taxonomy)
    //   captureMode   = 'region'           (D-REG-04 sub-classifier)
    //   captureTool   = 'threshold'        (P-13-09 (c) NEW v0.2)
    //   sourceApp     = <bundle ID>        (best-effort; ^([a-z]+\.)+[a-z]+$)
    //   capturedAt    = <ISO 8601 UTC>
    //
    // The unit test passes a known `source_app` so the assertion can be
    // exact. The `frontmost_app_bundle_id` lookup itself is exercised in
    // the end-to-end empirical capture (Phase D); covering it here would
    // require a live NSWorkspace context the test runner doesn't have.

    fn parse_payload(payload: &serde_json::Value) -> &serde_json::Map<String, serde_json::Value> {
        payload
            .as_object()
            .expect("payload should be a JSON object")
    }

    fn source_metadata(payload: &serde_json::Value) -> &serde_json::Map<String, serde_json::Value> {
        parse_payload(payload)
            .get("sourceMetadata")
            .expect("payload should have sourceMetadata")
            .as_object()
            .expect("sourceMetadata should be a JSON object")
    }

    #[test]
    fn screenshot_payload_sets_ac19_literals() {
        let payload = build_screenshot_payload("Hello world\nSecond line", "com.example.app");

        let top = parse_payload(&payload);
        assert_eq!(top.get("title").and_then(|v| v.as_str()), Some("Hello world"));
        assert_eq!(
            top.get("content").and_then(|v| v.as_str()),
            Some("Hello world\nSecond line")
        );
        let document_id = top
            .get("documentId")
            .and_then(|v| v.as_str())
            .expect("documentId is a string");
        assert!(document_id.starts_with("DESKTOP-"), "got {document_id:?}");
        assert_eq!(document_id.len(), "DESKTOP-".len() + 16);

        let meta = source_metadata(&payload);
        assert_eq!(
            meta.get("captureMethod").and_then(|v| v.as_str()),
            Some("screenshot-ocr")
        );
        assert_eq!(
            meta.get("captureMode").and_then(|v| v.as_str()),
            Some("region")
        );
        assert_eq!(
            meta.get("captureTool").and_then(|v| v.as_str()),
            Some("threshold")
        );
        assert_eq!(
            meta.get("sourceApp").and_then(|v| v.as_str()),
            Some("com.example.app")
        );
        // ISO 8601 shape — chrono's RFC 3339 parser is the canonical check.
        let captured_at = meta
            .get("capturedAt")
            .and_then(|v| v.as_str())
            .expect("capturedAt is a string");
        chrono::DateTime::parse_from_rfc3339(captured_at)
            .unwrap_or_else(|e| panic!("capturedAt {captured_at:?} not RFC 3339: {e}"));
    }

    #[test]
    fn screenshot_payload_title_skips_blank_lines_and_caps_at_80() {
        let long_line = "x".repeat(200);
        let payload = build_screenshot_payload(&format!("\n\n   \n{long_line}\nbody"), "");
        let title = parse_payload(&payload)
            .get("title")
            .and_then(|v| v.as_str())
            .expect("title is a string");
        assert_eq!(title.len(), 80);
        assert!(title.chars().all(|c| c == 'x'));
    }

    #[test]
    fn screenshot_payload_handles_all_blank_text() {
        let payload = build_screenshot_payload("\n\n   \n\t\n", "");
        assert_eq!(
            parse_payload(&payload)
                .get("title")
                .and_then(|v| v.as_str()),
            Some("(empty capture)")
        );
    }

    #[test]
    fn screenshot_payload_sourceapp_shape_matches_brief() {
        // Documents the brief's expectation that `sourceApp` is a bundle ID
        // (`^([a-z]+\.)+[a-z]+$`) when the NSWorkspace lookup succeeds — and
        // an empty string when it fails. Both shapes pass the route handler's
        // coarse-grained validation; the assertion here just pins the values
        // we expect to flow through.
        let bundle_id_examples = [
            "com.microsoft.outlook",
            "com.tinyspeck.slackmacgap",
            "com.apple.safari",
        ];
        for bundle in &bundle_id_examples {
            let payload = build_screenshot_payload("body", bundle);
            assert_eq!(
                source_metadata(&payload)
                    .get("sourceApp")
                    .and_then(|v| v.as_str()),
                Some(*bundle)
            );
        }
        // Degraded path (NSWorkspace returned None) — sourceApp serializes
        // as empty string. Brief §0.2 explicit allowance.
        let degraded = build_screenshot_payload("body", "");
        assert_eq!(
            source_metadata(&degraded)
                .get("sourceApp")
                .and_then(|v| v.as_str()),
            Some("")
        );
    }
}
