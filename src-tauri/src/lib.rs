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
    /// D-12-19: absolute path to `ocr-capture` resolved at startup.
    pub ocr_capture_path: Mutex<Option<PathBuf>>,
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
// D-12-19 OCR utility probe
// ───────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OcrUtilityStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub message: Option<String>,
}

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
// D-12-07 AppConfig persistence
// ───────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AppConfig {
    pub base_url: String,
    pub bearer_token: String,
    pub last_used: Option<String>,
    pub mode: String,
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

fn build_payload(path: &Path, content: &str) -> serde_json::Value {
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

    // Build payload + POST (D-12-13: from Rust shell, no Origin header)
    let payload = build_payload(&path, &content);
    let url = format!(
        "{}/api/ingest-document",
        cfg.base_url.trim_end_matches('/')
    );

    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60)) // LLM extraction can take 10-15s
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
        .header(
            "Authorization",
            format!("Bearer {}", cfg.bearer_token),
        )
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
            // Server returned 2xx but the body isn't parseable. Treat as success-with-warning.
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

    let server_title = parsed.title.clone().unwrap_or(display_name.clone());
    let term_count = parsed.terms_extracted.as_ref().map(|v| v.len()).unwrap_or(0);

    if parsed.already_existed.unwrap_or(false) {
        IngestionOutcome {
            kind: "idempotent".into(),
            title: format!("Already captured: {}", server_title),
            // Make the dedup mechanism legible: idempotency is content-hash based,
            // so the same bytes from a different filename/directory still match.
            // Surfaced after a pilot empirical where Ross had two copies of the same
            // file in different folders and was confused by the idempotent response.
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
// Increment 5: Capture Screen via OCR utility subprocess (D-12-19 cached path)
// ───────────────────────────────────────────────────────────────────────────

/// Spawn the OCR utility (`ocr-capture --once --region`) using the absolute
/// path cached at startup via D-12-19. The utility handles capture + OCR + POST
/// itself; we just parse its stdout for the outcome line and emit a toast.
#[tauri::command]
async fn run_screen_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cfg = current_config(&state)?;
    let ocr_path = state
        .ocr_capture_path
        .lock()
        .expect("ocr_capture_path mutex poisoned")
        .clone();

    let ocr_binary = match ocr_path {
        Some(p) => p,
        None => {
            let _ = app_handle.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "OCR utility not installed".into(),
                    body: Some(
                        "Run `bash setup.sh` from the viktora-threshold repo to install it via pipx, \
                         then restart Viktora Threshold."
                            .into(),
                    ),
                    source_path: None,
                },
            );
            return Ok(());
        }
    };

    IN_FLIGHT.fetch_add(1, Ordering::SeqCst);

    // The subprocess can take 10-30s (region select + OCR + POST + extraction).
    // We don't apply a wrapper timeout here — `ocr-capture` has its own 60s
    // POST timeout per WP-OCR-01 internals.
    let result = tokio::process::Command::new(&ocr_binary)
        .args(["--once", "--region"])
        .env("APOLLA_BASE_URL", &cfg.base_url)
        .env("APOLLA_INGEST_TOKEN", &cfg.bearer_token)
        .output()
        .await;

    IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);

    let outcome = parse_screen_capture_outcome(result);
    let _ = app_handle.emit("threshold://toast", outcome);
    Ok(())
}

/// Pure helper that parses the OCR utility's subprocess output into an
/// IngestionOutcome. Extracted for unit testability.
fn parse_screen_capture_outcome(
    result: std::io::Result<std::process::Output>,
) -> IngestionOutcome {
    match result {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // OCR utility stdout formats (per WP-OCR-01 + WP-OCR-03):
            //   "✓ Captured: <title> | terms: <N>"           — new full-window
            //   "✓ Captured [region]: <title> | terms: <N>"  — new region
            //   "↺ Already captured: <title>"                — idempotent
            //   "↺ Already captured [region]: <title>"
            //   "… region capture cancelled: …"              — user pressed Esc
            //   "✗ …"                                        — capture/OCR/POST failed
            // Case-insensitive match so we catch both "Captured" (new) and
            // "Already captured" (idempotent) — the OCR utility uses different
            // capitalization for the two paths per WP-OCR-01 + WP-OCR-03 README.
            let last_status_line = stdout
                .lines()
                .rev()
                .find(|l| {
                    let lower = l.to_lowercase();
                    lower.contains("captured") || lower.contains("cancelled") || l.starts_with("✗")
                })
                .unwrap_or("")
                .trim()
                .to_string();

            if last_status_line.contains("Already captured") {
                IngestionOutcome {
                    kind: "idempotent".into(),
                    title: last_status_line,
                    body: None,
                    source_path: Some("__screen_capture__".into()),
                }
            } else if last_status_line.contains("cancelled") {
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "Region capture cancelled".into(),
                    body: Some("You pressed Esc during region select. No capture sent.".into()),
                    source_path: Some("__screen_capture__".into()),
                }
            } else if last_status_line.starts_with("✗") {
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "Capture failed".into(),
                    body: Some(last_status_line),
                    source_path: Some("__screen_capture__".into()),
                }
            } else if last_status_line.contains("Captured") {
                IngestionOutcome {
                    kind: "success".into(),
                    title: last_status_line,
                    body: None,
                    source_path: Some("__screen_capture__".into()),
                }
            } else {
                // Subprocess returned 0 but emitted nothing parseable
                IngestionOutcome {
                    kind: "success".into(),
                    title: "Screen captured".into(),
                    body: Some(stdout.trim().to_string()),
                    source_path: Some("__screen_capture__".into()),
                }
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            IngestionOutcome {
                kind: "failure".into(),
                title: format!("Capture failed (exit {})", out.status.code().unwrap_or(-1)),
                body: Some(stderr.lines().last().unwrap_or("").trim().to_string()),
                source_path: Some("__screen_capture__".into()),
            }
        }
        Err(e) => IngestionOutcome {
            kind: "failure".into(),
            title: "Couldn't spawn OCR utility".into(),
            body: Some(format!("{}", e)),
            source_path: Some("__screen_capture__".into()),
        },
    }
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
            let ocr_path = probe_ocr_capture();
            app.manage(AppState {
                ocr_capture_path: Mutex::new(ocr_path),
                config: Mutex::new(None),
            });
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
                tauri::WindowEvent::DragDrop(drag_event) => {
                    if let tauri::DragDropEvent::Drop { paths, .. } = drag_event {
                        let path_strs: Vec<String> = paths
                            .iter()
                            .filter_map(|p| p.to_str().map(String::from))
                            .collect();
                        let _ = window.emit("threshold://drop-paths", path_strs);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_ocr_utility_status,
            load_config,
            save_config,
            test_connection,
            ingest_files,
            pick_files,
            run_screen_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ───────────────────────────────────────────────────────────────────────────
// Unit tests (Phase B AC-15)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::path::Path;
    use std::process::{ExitStatus, Output};

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
        };
        let json = serde_json::to_string(&cfg).expect("should serialize");
        let parsed: AppConfig = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed.base_url, cfg.base_url);
        assert_eq!(parsed.bearer_token, cfg.bearer_token);
        assert_eq!(parsed.last_used, cfg.last_used);
        assert_eq!(parsed.mode, cfg.mode);
    }

    // ───── Screen-capture outcome parser ─────

    fn make_output(stdout: &str, stderr: &str, exit_code: i32) -> std::io::Result<Output> {
        Ok(Output {
            status: ExitStatus::from_raw(exit_code << 8), // shifted because the lower 8 bits are signal info
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        })
    }

    #[test]
    fn parse_screen_capture_success_full_window() {
        let result = make_output("✓ Captured: My Document | terms: 42\n", "", 0);
        let outcome = parse_screen_capture_outcome(result);
        assert_eq!(outcome.kind, "success");
        assert!(outcome.title.contains("My Document"));
    }

    #[test]
    fn parse_screen_capture_success_region() {
        let result = make_output("✓ Captured [region]: Slack thread | terms: 18\n", "", 0);
        let outcome = parse_screen_capture_outcome(result);
        assert_eq!(outcome.kind, "success");
        assert!(outcome.title.contains("Slack thread"));
        assert!(outcome.title.contains("[region]"));
    }

    #[test]
    fn parse_screen_capture_idempotent() {
        let result = make_output("↺ Already captured [region]: README\n", "", 0);
        let outcome = parse_screen_capture_outcome(result);
        assert_eq!(outcome.kind, "idempotent");
        assert!(outcome.title.contains("Already captured"));
    }

    #[test]
    fn parse_screen_capture_user_cancelled() {
        let result = make_output(
            "… region capture cancelled: user pressed Esc\n",
            "",
            0,
        );
        let outcome = parse_screen_capture_outcome(result);
        assert_eq!(outcome.kind, "failure");
        assert!(outcome.title.contains("cancelled"));
    }

    #[test]
    fn parse_screen_capture_nonzero_exit_code() {
        let result = make_output("", "Vision OCR returned empty\n", 1);
        let outcome = parse_screen_capture_outcome(result);
        assert_eq!(outcome.kind, "failure");
        assert!(outcome.title.contains("exit 1"));
    }

    #[test]
    fn parse_screen_capture_spawn_error() {
        let result = Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "binary missing",
        ));
        let outcome = parse_screen_capture_outcome(result);
        assert_eq!(outcome.kind, "failure");
        assert!(outcome.title.contains("Couldn't spawn"));
    }
}
