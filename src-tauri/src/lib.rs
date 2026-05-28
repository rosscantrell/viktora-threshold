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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

// WP-ONENOTE-EXPORT-01 — PDF text extraction for the OneNote export-watch
// fallback path. Cross-platform (pure-Rust crates: pdf-extract + lopdf).
mod pdf_extract;

// WP-ONENOTE-EXPORT-02 — Windows COM client for OneNote (GetHierarchy +
// CurrentPageId + Publish). Cross-platform compile: the module also
// provides a Mac/Linux stub via `#[cfg(not(target_os = "windows"))]`
// returning `OneNoteError::PlatformUnsupported` from every function.
mod onenote_windows;

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
// WP-ONENOTE-EXPORT-04 — bulk-send-section coordination state
// ───────────────────────────────────────────────────────────────────────────
//
// Two globals coordinate the bulk-send-section lifecycle:
//
//   - `ONENOTE_BULK_SEND_IN_FLIGHT`: a `bool` mutex set to true while a bulk
//     send is running. Used as the single-flight guard (Plaud `ingestionTail`
//     pattern) — concurrent calls fail with a structured `BulkSendError` so
//     the user understands they need to wait or cancel.
//
//   - `ONENOTE_BULK_SEND_CANCEL`: an `AtomicBool` flipped to `true` by the
//     `onenote_cancel_bulk_send` IPC command. The bulk-send loop checks the
//     flag BETWEEN pages (per brief §3.4: "in-flight POST completes"). The
//     loop resets the flag to `false` at the start of every new bulk-send so
//     a prior cancel doesn't poison the next batch.
//
// Brief §3.4 explicitly requires sequential per-page processing (`.await`
// each, NOT `try_join_all` / `tokio::spawn` per page); the mutex enforces
// this across re-entries (e.g., the menu fires while a browse-initiated send
// is still running).

/// Single-flight mutex: held for the duration of the bulk-send loop.
/// `Mutex<bool>` rather than `AtomicBool` so we can hold the guard across
/// `.await` points without races on the start-of-send / end-of-send
/// transitions. Concurrent invocations bail with `Busy` instead of waiting.
static ONENOTE_BULK_SEND_IN_FLIGHT: Mutex<bool> = Mutex::new(false);

/// Cancel signal: set by `onenote_cancel_bulk_send`. The loop checks this
/// flag once per page-boundary; in-flight Publish + POST completes on the
/// current page before the loop short-circuits (matches brief §3.4 AC).
static ONENOTE_BULK_SEND_CANCEL: AtomicBool = AtomicBool::new(false);

// ───────────────────────────────────────────────────────────────────────────
// AppState
// ───────────────────────────────────────────────────────────────────────────

pub struct AppState {
    /// Cached config for capture flows; populated on first load_config call.
    pub config: Mutex<Option<AppConfig>>,
    /// WP-Threshold-Tidbit-Return Phase B — most recent tidbit returned by
    /// the post-capture polling loop. Populated by `poll_for_tidbit` on
    /// `status: 'ready'`; read by the expanded UI via the
    /// `get_pending_tidbit` IPC command when navigating to `#tidbit`. Cleared
    /// on explicit `clear_pending_tidbit` (after the user views it) or
    /// overwritten by a newer capture's tidbit. Single-value (not a queue):
    /// the wow-loop wants "what just happened," not history.
    pub pending_tidbit: Mutex<Option<Tidbit>>,
}

// ───────────────────────────────────────────────────────────────────────────
// Allowed plain-text extensions (D-12-05)
// ───────────────────────────────────────────────────────────────────────────

// WP-ONENOTE-EXPORT-01: "pdf" added for the OneNote export-watch fallback
// path. PDFs are routed through pdf_extract::extract_pdf_text() rather than
// `fs::read_to_string` in `ingest_one_file` because they're binary.
const ALLOWED_EXTENSIONS: &[&str] = &["txt", "md", "vtt", "srt", "html", "pdf"];

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
    /// WP-ONENOTE-EXPORT-03 — user-configurable global hotkey for the
    /// "send current OneNote page" flow. Stored as the
    /// `tauri-plugin-global-shortcut` string form (e.g. `"Ctrl+Shift+O"`,
    /// `"CommandOrControl+Shift+O"`, `"Alt+F12"`). `None` → reader falls
    /// back to `DEFAULT_ONENOTE_HOTKEY` so existing configs without this
    /// field continue to work (additive-only schema delta).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onenote_hotkey: Option<String>,
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
            onenote_hotkey: None,
        }
    }
}

/// WP-ONENOTE-EXPORT-03 — default global hotkey for "send current OneNote
/// page" when AppConfig has no `onenote_hotkey` override (either a fresh
/// install or a config written by an older Threshold build). Per brief
/// §2.3 Path A. Use the literal `"Ctrl+Shift+O"` form rather than
/// `"CommandOrControl+Shift+O"` because (a) OneNote COM is Windows-only —
/// the hotkey is only ever registered on Windows, (b) the JS side renders
/// the string verbatim in the Configure pane, and "Ctrl+Shift+O" is the
/// human-recognizable form Windows users expect.
pub const DEFAULT_ONENOTE_HOTKEY: &str = "Ctrl+Shift+O";

/// WP-ONENOTE-EXPORT-03 — Resolve the configured hotkey or fall back to
/// the default. Centralizes the `Option<String>` → `&str` mapping so the
/// plugin-registration site, the toast wording, and (any future) Configure
/// pre-fill all agree on the canonical string.
pub fn resolved_onenote_hotkey(cfg: &AppConfig) -> String {
    cfg.onenote_hotkey
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_ONENOTE_HOTKEY)
        .to_string()
}

// ───────────────────────────────────────────────────────────────────────────
// WP-OCR-09 Phase D — deep-link Configure pre-fill
// ───────────────────────────────────────────────────────────────────────────

/// Payload emitted to the frontend when an `apolla-threshold://configure`
/// URL is opened. The frontend listens on `threshold://configure-prefill`
/// and populates the Configure pane's base URL + bearer token fields.
///
/// `tenant` is the slug (e.g., "threshold-eval") if present; `base_url` is
/// the full reconstructed URL the pane should use. The brief (WP-OCR-09
/// v1.2-FINAL D-09-08) specifies `?tenant=<slug>&token=...`; we
/// reconstruct `https://<slug>.viktora.ai` as the base URL. Future
/// non-viktora.ai hosting would extend the parser to also accept
/// `?baseUrl=<full-url>` and prefer it over the slug — out of Phase D
/// scope.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurePrefill {
    /// Tenant slug (e.g., "threshold-eval"). May be None for slug-less
    /// future URLs but currently always populated when the deep link
    /// matches the canonical shape.
    pub tenant: Option<String>,
    /// Reconstructed base URL (`https://<tenant>.viktora.ai`).
    pub base_url: String,
    /// Bearer token to populate the Configure pane field. Frontend
    /// passes this straight into `save_config` — no client-side parsing.
    pub token: String,
}

/// Parse an `apolla-threshold://configure?tenant=...&token=...` URL into
/// a `ConfigurePrefill` event payload. Returns `None` for malformed URLs
/// (wrong scheme, missing token, etc.) so the deep-link handler can log
/// + skip without crashing.
///
/// Different URL parsers handle custom schemes inconsistently — `tauri::Url`
/// (via the `url` crate, transitively brought in by tauri-plugin-deep-link)
/// treats `apolla-threshold://configure?...` as scheme=`apolla-threshold`,
/// host=`configure`, path=`/`, query=`tenant=...&token=...`. We accept
/// either `configure` as host OR path to be tolerant of future schema
/// drift.
pub fn parse_configure_deep_link(url: &url::Url) -> Option<ConfigurePrefill> {
    if url.scheme() != "apolla-threshold" {
        return None;
    }
    // Accept "configure" as either host or path's first segment.
    let host_ok = url.host_str() == Some("configure");
    let path_ok = url.path().trim_start_matches('/').split('/').next() == Some("configure")
        && url.host_str().is_none();
    if !host_ok && !path_ok {
        return None;
    }
    let mut tenant: Option<String> = None;
    let mut token: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "tenant" => tenant = Some(v.into_owned()),
            "token" => token = Some(v.into_owned()),
            _ => {}
        }
    }
    let token = token?;
    if token.is_empty() {
        return None;
    }
    let tenant_slug = tenant.as_deref().unwrap_or("").trim();
    let base_url = if tenant_slug.is_empty() {
        // No tenant slug → can't reconstruct a base URL. The brief
        // requires `?tenant=...`; reject rather than guess.
        return None;
    } else {
        format!("https://{}.viktora.ai", tenant_slug)
    };
    Some(ConfigurePrefill {
        tenant: Some(tenant_slug.to_string()),
        base_url,
        token,
    })
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
fn save_config(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    config: AppConfig,
) -> Result<(), String> {
    // WP-ONENOTE-EXPORT-03 — capture the previously-cached hotkey BEFORE
    // we swap it in below, so we can decide whether to re-register the
    // global shortcut. Avoids unnecessary unregister/register churn on
    // unrelated config changes (base_url, bearer_token, widget position).
    let prev_hotkey = state
        .config
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(resolved_onenote_hotkey));

    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    let mut to_write = config.clone();
    to_write.last_used = Some(Utc::now().to_rfc3339());
    let json = serde_json::to_string_pretty(&to_write)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    log::info!("Saved config to {}", path.display());
    let new_hotkey = resolved_onenote_hotkey(&to_write);
    *state.config.lock().expect("config mutex poisoned") = Some(to_write);

    // WP-ONENOTE-EXPORT-03 — re-register the global hotkey if the user
    // changed it via Configure pane. Cross-platform-safe: the
    // `reregister_onenote_hotkey` helper is a no-op on non-Windows
    // (the hotkey is only registered on Windows in the first place).
    if prev_hotkey.as_deref() != Some(new_hotkey.as_str()) {
        log::info!(
            "WP-ONENOTE-EXPORT-03: hotkey changed (prev={:?}, new='{}'); re-registering",
            prev_hotkey,
            new_hotkey
        );
        reregister_onenote_hotkey(&app, prev_hotkey.as_deref(), &new_hotkey);
    }

    Ok(())
}

/// WP-ONENOTE-EXPORT-03 — unregister the old hotkey (if any) and
/// register the new one. Failure on either side is logged + skipped —
/// the user still has the widget right-click menu item as a fallback.
/// No-op on non-Windows (mirrors the registration site in `setup()`).
#[cfg(target_os = "windows")]
fn reregister_onenote_hotkey(
    app: &tauri::AppHandle,
    prev_hotkey: Option<&str>,
    new_hotkey: &str,
) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Some(prev) = prev_hotkey {
        match app.global_shortcut().unregister(prev) {
            Ok(()) => log::info!("WP-ONENOTE-EXPORT-03: unregistered prior hotkey '{}'", prev),
            Err(e) => log::warn!(
                "WP-ONENOTE-EXPORT-03: failed to unregister prior hotkey '{}': {}",
                prev,
                e
            ),
        }
    }
    let app_handle_for_hotkey = app.clone();
    match app.global_shortcut().on_shortcut(
        new_hotkey,
        move |_app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            let handle = app_handle_for_hotkey.clone();
            tauri::async_runtime::spawn(async move {
                fire_onenote_send_flow(handle).await;
            });
        },
    ) {
        Ok(()) => log::info!(
            "WP-ONENOTE-EXPORT-03: re-registered global hotkey '{}'",
            new_hotkey
        ),
        Err(e) => log::warn!(
            "WP-ONENOTE-EXPORT-03: failed to register new hotkey '{}': {} \
             — the widget menu item still works",
            new_hotkey,
            e
        ),
    }
}

#[cfg(not(target_os = "windows"))]
fn reregister_onenote_hotkey(
    _app: &tauri::AppHandle,
    _prev_hotkey: Option<&str>,
    _new_hotkey: &str,
) {
    // No-op: hotkey isn't registered on Mac/Linux (see WP-ONENOTE-EXPORT-03
    // gate in `setup()`). Configure-pane writes still persist the hotkey
    // string in AppConfig so it survives across platforms (e.g., user
    // configures on Mac via shared config, runs on Windows).
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

// ───────────────────────────────────────────────────────────────────────────
// WP-Threshold-Tidbit-Return Phase B — tidbit polling types
// ───────────────────────────────────────────────────────────────────────────
//
// JSON contract matches schema-browser/server/ai/tidbit-reshape.ts (Phase A).
// Field names mirror the camelCase TS types via #[serde(rename = ...)].
// Optional fields use #[serde(default, skip_serializing_if = "...")] so
// graceful degradation works both directions (lenient parse + tidy emit).
//
// `TidbitStatus` uses `rename_all = "kebab-case"` so `NoMarker` ↔ "no-marker".

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Tidbit {
    pub title: String,
    #[serde(rename = "whyThisMatters")]
    pub why_this_matters: String,
    pub highlights: Vec<TidbitHighlight>,
    #[serde(rename = "deepLink")]
    pub deep_link: String,
    #[serde(
        rename = "capturedFromHint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub captured_from_hint: Option<String>,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    #[serde(rename = "markerFingerprint")]
    pub marker_fingerprint: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct TidbitHighlight {
    pub slug: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "isCorpusOverlap")]
    pub is_corpus_overlap: bool,
    #[serde(
        rename = "priorCaptureCount",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub prior_capture_count: Option<u32>,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TidbitStatus {
    Ready,
    Pending,
    NoMarker,
    Failed,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TidbitPollResponse {
    pub tidbit: Option<Tidbit>,
    pub status: TidbitStatus,
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
/// WP-ONENOTE-EXPORT-01: Build the JSON payload for OneNote-exported PDFs
/// ingested through the export-watch fallback path (drag-drop or Pick File).
///
/// Contract (per WP-OneNote-Export brief §2.4 + v1.1 patch §1.2):
/// - `captureTool: 'onenote'` — NEW convention slug for OneNote lane
/// - `captureMethod: 'export-import'` — distinguishes from COM-capture path
///   (which lands in WP-EXPORT-02 as `'com-capture'`)
/// - `sourceApp: 'onenote'` — best-effort; we don't have COM-side metadata
///   in this path
/// - `documentId: 'onenote-pdf-${sha8(pdf_bytes)}'` — content-hashed on the
///   PDF bytes (NOT the extracted text) so re-saves of the same export
///   deduplicate deterministically
///
/// Title = file stem (mirrors `build_file_payload`). OneNote's export
/// preserves the page title in the PDF metadata, but we keep the simpler
/// filename-derived path for v1 — operator can supply a better title by
/// renaming the file before drag.
fn build_onenote_pdf_payload(path: &Path, pdf_bytes: &[u8], text: &str) -> serde_json::Value {
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();

    // Content-hash the PDF bytes (not the extracted text) for documentId
    // stability across pdf-extract version bumps — the user's mental model
    // is "this exact file is one document," and bytes are the canonical
    // identity. sha8 (first 16 hex chars) matches the prefix-+-16-hex
    // convention from `compute_document_id` (DESKTOP-xxxxxxxxxxxxxxxx).
    let mut hasher = Sha256::new();
    hasher.update(pdf_bytes);
    let result = hasher.finalize();
    let hex_str = hex::encode(result);
    let document_id = format!("onenote-pdf-{}", &hex_str[..16]);

    serde_json::json!({
        "documentId": document_id,
        "title": title,
        "content": text,
        "sourceMetadata": {
            "captureTool": "onenote",
            "captureMethod": "export-import",
            "sourceApp": "onenote",
            "capturedAt": Utc::now().to_rfc3339()
        }
    })
}

/// WP-ONENOTE-EXPORT-02: Build the JSON payload for OneNote pages captured
/// via the Windows COM path (`Application.Publish` → PDF → text extraction).
///
/// Sibling of `build_onenote_pdf_payload` (WP-EXPORT-01) — both ship
/// `captureTool: "onenote"` so the docs-list pill renders uniformly, but
/// the two paths use **distinct documentId keyspaces** so the same OneNote
/// page captured both ways doesn't accidentally dedup against itself:
///
/// - COM path (this fn): `documentId: "onenote-${pageId}"` (deterministic
///   per page; the GUID is stable across re-captures of the same page).
/// - PDF path (build_onenote_pdf_payload): `documentId: "onenote-pdf-${sha8 of bytes}"`.
///
/// `captureMethod: "com-capture"` distinguishes from the PDF path's
/// `"export-import"`. Per brief §2.4, the COM path additionally carries
/// `notebookId`, `sectionId`, `pageId`, `notebookPath` so the docs-list
/// tooltip can surface "Work / Engineering Notes" context.
///
/// Title comes from the OneNote page name (returned by `GetHierarchy`),
/// NOT from a PDF file stem — the COM path has the real page title in
/// hand and shouldn't degrade to filename-derived.
fn build_onenote_com_payload(
    page_meta: &onenote_windows::PageMetadata,
    pdf_bytes: &[u8],
    text: &str,
) -> serde_json::Value {
    // `pdf_bytes` is intentionally unused in the payload body itself — we
    // POST the extracted text. The argument is kept for symmetry with
    // `build_onenote_pdf_payload` (same call shape) and so future audit
    // could embed a byte-hash sidecar without rewiring the caller. Marked
    // intentionally to silence clippy without forcing an `_` rename that
    // would obscure the symmetry.
    let _ = pdf_bytes;

    serde_json::json!({
        "documentId": format!("onenote-{}", page_meta.page_id),
        "title": page_meta.title,
        "content": text,
        "sourceMetadata": {
            "captureTool": "onenote",
            "captureMethod": "com-capture",
            "sourceApp": "onenote",
            "capturedAt": Utc::now().to_rfc3339(),
            "notebookId": page_meta.notebook_id,
            "notebookName": page_meta.notebook_name,
            "sectionId": page_meta.section_id,
            "sectionName": page_meta.section_name,
            "pageId": page_meta.page_id,
            "notebookPath": page_meta.notebook_path,
        }
    })
}

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

    // Extension allow-list (D-12-05; WP-ONENOTE-EXPORT-01 added "pdf")
    if !is_allowed_extension(&path) {
        let ext = extension_lower(&path).unwrap_or_else(|| "(none)".to_string());
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Unsupported file type: .{}", ext),
            body: Some(format!(
                "Threshold ingests these formats only ({}). Skipped: {}",
                ALLOWED_EXTENSIONS.join(", "),
                display_name
            )),
            source_path,
        };
    }

    // WP-ONENOTE-EXPORT-01: PDF lane (OneNote export-watch fallback path).
    // Branches BEFORE `fs::read_to_string` because PDFs are binary —
    // `read_to_string` would fail with InvalidData on the byte stream.
    if extension_lower(&path).as_deref() == Some("pdf") {
        return ingest_one_pdf(path, cfg, source_path, display_name).await;
    }

    // Plain-text lane (existing path; .txt/.md/.vtt/.srt/.html).
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
    //
    // WP-Threshold-Tidbit-Return Phase B: caller (`ingest_files`) handles
    // the tidbit polling dispatch after this returns, since it has the
    // AppHandle in scope. `ingest_one_file` stays focused on file-level
    // ingestion shape.
    let payload = build_file_payload(&path, &content);
    post_payload_to_apolla(payload, cfg, &display_name, source_path).await
}

/// WP-ONENOTE-EXPORT-01: PDF ingestion path (OneNote export-watch fallback).
///
/// Reads PDF bytes, extracts text via the pure-Rust `pdf_extract` module,
/// and routes the result based on extraction outcome:
/// - Extraction error → user-visible failure toast (per `PdfExtractError`
///   variant; no Apolla side effect)
/// - Likely handwriting (chars/page < threshold) → user-visible "skipped"
///   toast as `failure` kind so the user knows the file did NOT land in
///   Apolla. v1 explicitly chooses skip-with-note over send-empty-content
///   per brief §1.3 ("do NOT silently send empty content to Apolla").
/// - Clean extraction → POST via `build_onenote_pdf_payload`
///   (`captureTool: 'onenote'`, `captureMethod: 'export-import'`)
async fn ingest_one_pdf(
    path: PathBuf,
    cfg: &AppConfig,
    source_path: Option<String>,
    display_name: String,
) -> IngestionOutcome {
    // Read raw bytes (binary; not UTF-8).
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: format!("Couldn't read {}", display_name),
                body: Some(format!("{}", e)),
                source_path,
            };
        }
    };

    if bytes.is_empty() {
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Empty file: {}", display_name),
            body: Some("File contains no bytes.".into()),
            source_path,
        };
    }

    // Pure-Rust extraction (pdf-extract + lopdf). See pdf_extract.rs for
    // error taxonomy + handwriting heuristic.
    let extraction = match pdf_extract::extract_pdf_text(&bytes) {
        Ok(e) => e,
        Err(err) => {
            log::warn!(
                "[onenote-pdf] extraction failed for {}: {}",
                display_name,
                err
            );
            return IngestionOutcome {
                kind: "failure".into(),
                title: err.user_message().to_string(),
                body: Some(format!("File: {}\n\n{}", display_name, err)),
                source_path,
            };
        }
    };

    // Handwriting / image-only PDFs: surface to user instead of posting
    // empty content. v2 polish (per brief §1.3) is a Vision-OCR override
    // toggle — not in WP-EXPORT-01 scope.
    if extraction.is_likely_handwriting {
        log::info!(
            "[onenote-pdf] flagged as likely handwriting (chars/page={}, pages={}): {}",
            extraction.chars_per_page,
            extraction.page_count,
            display_name
        );
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Skipped: {} contains handwriting/images", display_name),
            body: Some(format!(
                "PDF appears to be mostly handwriting or images ({} chars across {} page(s)). \
                Threshold v1 does not OCR handwriting; the file was not sent to Apolla. \
                For typed pages, re-export from OneNote with text content; for handwriting, \
                Vision-OCR support is planned for a future release.",
                extraction.text.len(),
                extraction.page_count
            )),
            source_path,
        };
    }

    let payload = build_onenote_pdf_payload(&path, &bytes, &extraction.text);
    post_payload_to_apolla(payload, cfg, &display_name, source_path).await
}

/// WP-Threshold-Tidbit-Return Phase B — spawn `poll_for_tidbit` as a
/// detached tokio task when this ingestion was a first-time success.
/// Idempotent captures skip (same tidbit; re-firing the wow-loop
/// notification on accidental re-capture would be noise). Failures skip
/// (no doc in the corpus to attach a tidbit to).
fn dispatch_tidbit_poll_if_success(
    app_handle: &tauri::AppHandle,
    outcome: &IngestionOutcome,
    cfg: &AppConfig,
    document_id: String,
) {
    if outcome.kind != "success" {
        return;
    }
    let cfg_clone = cfg.clone();
    let handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        poll_for_tidbit(handle_clone, cfg_clone, document_id).await;
    });
}

// ───────────────────────────────────────────────────────────────────────────
// WP-Threshold-Tidbit-Return Phase B — polling loop + tidbit-ready handler
// ───────────────────────────────────────────────────────────────────────────

const TIDBIT_POLL_INTERVAL: Duration = Duration::from_secs(2);
const TIDBIT_POLL_MAX_WAIT: Duration = Duration::from_secs(60);

/// Poll `/api/documents/:id/tidbit` for up to 60s until a non-`'pending'`
/// status lands. On `'ready'`, stores the tidbit in AppState, emits the
/// `threshold://tidbit-arrived` event for the widget pulse + indicator
/// badge, and triggers the second OS notification via the frontend's
/// existing `maybeShowNotification` path (consolidated there so the
/// Mac/Windows permission flow stays single-source-of-truth).
///
/// Failure-safe per D-TIDB-06: `'no-marker'`, `'failed'`, HTTP errors,
/// parse errors, and timeout all terminate the loop without firing the
/// second notification. The first capture-success toast remains intact
/// regardless. Network blips inside the 60s window log + continue (single
/// transient miss shouldn't kill the wow-loop).
async fn poll_for_tidbit(app_handle: tauri::AppHandle, cfg: AppConfig, document_id: String) {
    let url = format!(
        "{}/api/documents/{}/tidbit",
        cfg.base_url.trim_end_matches('/'),
        document_id
    );

    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[tidbit-poll] HTTP client init failed: {e}");
            return;
        }
    };

    let start = std::time::Instant::now();
    log::info!("[tidbit-poll] starting for doc {document_id}");

    loop {
        if start.elapsed() >= TIDBIT_POLL_MAX_WAIT {
            log::info!("[tidbit-poll] 60s timeout reached for doc {document_id}; silent omission");
            return;
        }

        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", cfg.bearer_token))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.json::<TidbitPollResponse>().await
            {
                Ok(parsed) => match parsed.status {
                    TidbitStatus::Ready => {
                        match parsed.tidbit {
                            Some(tidbit) => {
                                handle_tidbit_ready(&app_handle, tidbit).await;
                            }
                            None => {
                                log::warn!(
                                    "[tidbit-poll] server returned status=ready but tidbit=null \
                                     for doc {document_id}; treating as silent omission"
                                );
                            }
                        }
                        return;
                    }
                    TidbitStatus::NoMarker => {
                        log::info!(
                            "[tidbit-poll] no marker fired for doc {document_id}; \
                             silent omission per D-TIDB-06"
                        );
                        return;
                    }
                    TidbitStatus::Failed => {
                        log::info!(
                            "[tidbit-poll] server reported 'failed' status for doc \
                             {document_id}; silent omission"
                        );
                        return;
                    }
                    TidbitStatus::Pending => {
                        // Keep polling.
                    }
                },
                Err(e) => {
                    log::warn!(
                        "[tidbit-poll] response parse failed for doc {document_id}: {e}; \
                         silent omission"
                    );
                    return;
                }
            },
            Ok(resp) => {
                log::warn!(
                    "[tidbit-poll] HTTP {} from {} for doc {document_id}; silent omission",
                    resp.status().as_u16(),
                    url
                );
                return;
            }
            Err(e) => {
                log::debug!(
                    "[tidbit-poll] transient request error for doc {document_id}: {e}; \
                     will retry on next interval"
                );
                // Don't return; let the loop retry. One blip in a 60s window
                // shouldn't kill the wow-loop.
            }
        }

        tokio::time::sleep(TIDBIT_POLL_INTERVAL).await;
    }
}

/// Called once per successful poll when the server reports `'ready'`.
/// Stores the tidbit in AppState (so the expanded UI's `get_pending_tidbit`
/// IPC can retrieve it after `widget_expand("tidbit")` reloads the webview)
/// and emits a frontend event the widget listens for. The widget JS layer
/// owns the OS-notification permission dance + the pulse animation +
/// the indicator-badge visibility — keeping that consolidated avoids two
/// codepaths for cross-platform notification handling.
async fn handle_tidbit_ready(app_handle: &tauri::AppHandle, tidbit: Tidbit) {
    log::info!(
        "[tidbit] received — title=\"{}\", highlights={}",
        tidbit.title,
        tidbit.highlights.len()
    );

    let state = app_handle.state::<AppState>();
    *state
        .pending_tidbit
        .lock()
        .expect("pending_tidbit mutex poisoned") = Some(tidbit.clone());

    if let Err(e) = app_handle.emit("threshold://tidbit-arrived", tidbit) {
        log::warn!("[tidbit] failed to emit tidbit-arrived event: {e}");
    }
}

/// Frontend reads this on `index.html#tidbit` mount to populate the panel.
/// Returns None when no tidbit is pending (e.g., user navigated to `#tidbit`
/// manually without one waiting, or the panel was already viewed and cleared).
#[tauri::command]
fn get_pending_tidbit(state: tauri::State<AppState>) -> Option<Tidbit> {
    state
        .pending_tidbit
        .lock()
        .expect("pending_tidbit mutex poisoned")
        .clone()
}

/// Frontend invokes this when the user collapses the tidbit panel or
/// dismisses the indicator badge — prevents stale wow-loops from re-firing
/// when the user expands the widget for an unrelated reason (e.g., to open
/// Settings).
#[tauri::command]
fn clear_pending_tidbit(state: tauri::State<AppState>) {
    *state
        .pending_tidbit
        .lock()
        .expect("pending_tidbit mutex poisoned") = None;
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
        // WP-Threshold-Tidbit-Return Phase B — compute the documentId from
        // file content BEFORE ingest, so the polling dispatch can identify
        // the doc regardless of how the server's response shapes future
        // metadata. compute_document_id is content-hashed; matches what
        // `build_file_payload` (called inside ingest_one_file) puts on the
        // wire as `documentId`. Skip when the file is unreadable or empty —
        // those paths return early in `ingest_one_file` with a failure
        // outcome, and dispatch_tidbit_poll_if_success short-circuits on
        // non-"success" kinds anyway.
        let content_for_id = fs::read_to_string(&path).ok();
        let outcome = ingest_one_file(path, &cfg).await;
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        if let Some(content) = content_for_id.as_deref() {
            let document_id = compute_document_id(content);
            dispatch_tidbit_poll_if_success(&app_handle, &outcome, &cfg, document_id);
        }
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
        // WP-ONENOTE-EXPORT-01: "pdf" appended to allow drag/pick of
        // OneNote-exported PDFs through the file picker. PDFs route through
        // `ingest_one_pdf` for text extraction.
        .add_filter(
            "Supported formats",
            &["txt", "md", "vtt", "srt", "html", "pdf"],
        )
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
// WP-PLAUD-04a — Plaud Sync Queue IPC commands
// ───────────────────────────────────────────────────────────────────────────
//
// Four IPC commands proxy the schema-browser's /api/plaud/* endpoints:
//   - plaud_discover         POST /api/plaud/discover
//   - plaud_get_inbox        GET  /api/plaud/inbox
//   - plaud_decide(id, act)  POST /api/plaud/inbox/{id}/decide
//   - plaud_ingest(id)       POST /api/plaud/ingest
//
// All four reuse the bearer-auth + reqwest pattern from post_payload_to_apolla.
// Per WP-PLAUD-02, server-side handles dedup + sequential ingest mutex; the
// adapter returns idempotent results on already-ingested recordings.

/// WP-PLAUD-01 §3.4 discover-pass result envelope.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaudDiscoverResult {
    new_items: u32,
    pages_scanned: u32,
    #[serde(default)]
    errors: u32,
    completed: bool,
}

/// WP-PLAUD-01 §3.4 inbox item. Mirrors PlaudInboxItem on the server side
/// (schema-browser/server/ingest/plaud-state.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaudInboxItem {
    id: String,
    name: String,
    created_at: String,
    start_at: String,
    duration_ms: i64,
    serial_number: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    speaker_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    speaker_named_count: Option<u32>,
    state: String, // 'pending' | 'ingested' | 'skipped'
    discovered_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decided_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decision_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    apolla_document_id: Option<String>,
}

/// Server response wrapper: `GET /api/plaud/inbox` returns `{items: [...]}`.
#[derive(Debug, Deserialize)]
struct PlaudInboxResponse {
    items: Vec<PlaudInboxItem>,
}

/// WP-PLAUD-02 ingest result envelope.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaudIngestResult {
    apolla_document_id: String,
    ingested_at: String,
}

/// Build a reqwest client with the same TLS posture used by
/// `post_payload_to_apolla` (accepts local mkcert CA per WP-OCR-08). Timeout
/// of 30s — Plaud discover walks pages but the server side single-flights
/// concurrent calls, so even worst-case discovers complete well under 30s.
fn build_plaud_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))
}

/// Map a non-success status code to a human-readable error. Mirrors the
/// shape used by `post_payload_to_apolla`.
fn plaud_status_error(status: reqwest::StatusCode, url: &str, body: &str) -> String {
    if status.as_u16() == 401 {
        "Server rejected the bearer token. Check your Apolla token in Configure.".into()
    } else if status.as_u16() == 503 {
        "Plaud sync is disabled on the Apolla server (PLAUD_ENABLED is not set).".into()
    } else if status.as_u16() == 429 {
        "Rate-limited by the server. Wait a moment and retry.".into()
    } else {
        format!("HTTP {} from {}: {}", status.as_u16(), url, body)
    }
}

#[tauri::command]
async fn plaud_discover(
    state: tauri::State<'_, AppState>,
) -> Result<PlaudDiscoverResult, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/plaud/discover",
        cfg.base_url.trim_end_matches('/')
    );
    let client = build_plaud_http_client()?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        // The server endpoint ignores body content but expects a JSON
        // content-type for symmetry with the other POSTs.
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }

    resp.json::<PlaudDiscoverResult>()
        .await
        .map_err(|e| format!("plaud_discover: parse response failed: {}", e))
}

#[tauri::command]
async fn plaud_get_inbox(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PlaudInboxItem>, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/plaud/inbox",
        cfg.base_url.trim_end_matches('/')
    );
    let client = build_plaud_http_client()?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }

    let parsed: PlaudInboxResponse = resp
        .json()
        .await
        .map_err(|e| format!("plaud_get_inbox: parse response failed: {}", e))?;
    Ok(parsed.items)
}

#[tauri::command]
async fn plaud_decide(
    state: tauri::State<'_, AppState>,
    id: String,
    action: String,
) -> Result<(), String> {
    let cfg = current_config(&state)?;
    // Validate `action` client-side as a defense-in-depth check — the
    // server-side validator does the authoritative check, but a typo here
    // would surface as a 400 with a less obvious message.
    if !matches!(action.as_str(), "import" | "skip" | "clear") {
        return Err(format!(
            "plaud_decide: invalid action {:?}; expected one of import|skip|clear",
            action
        ));
    }
    let url = format!(
        "{}/api/plaud/inbox/{}/decide",
        cfg.base_url.trim_end_matches('/'),
        urlencoding_minimal(&id)
    );
    let client = build_plaud_http_client()?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .body(format!("{{\"action\":\"{}\"}}", action))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    Ok(())
}

#[tauri::command]
async fn plaud_ingest(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<PlaudIngestResult, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/plaud/ingest",
        cfg.base_url.trim_end_matches('/')
    );
    let client = build_plaud_http_client()?;
    // Ingest can take ~10-30s end-to-end (Plaud getFile + LLM extraction).
    // Override the default 30s timeout for this one path.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))
        .unwrap_or(client);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .body(format!("{{\"id\":\"{}\"}}", id.replace('"', "\\\"")))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }

    resp.json::<PlaudIngestResult>()
        .await
        .map_err(|e| format!("plaud_ingest: parse response failed: {}", e))
}

/// Minimal path-segment encoding for Plaud recording IDs (32-char hex on the
/// happy path; defensively encodes anything that's not URL-safe). Reaching
/// for a full `url`-crate dependency just for this would be overkill.
fn urlencoding_minimal(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

// ───────────────────────────────────────────────────────────────────────────
// WP-ONENOTE-EXPORT-02 — OneNote COM IPC commands
// ───────────────────────────────────────────────────────────────────────────
//
// Three Tauri commands exposing the `onenote_windows` COM client to the
// frontend + downstream WPs:
//
//   - `onenote_enumerate_hierarchy()`     — for WP-EXPORT-04 browse UI
//   - `onenote_get_active_page()`         — for WP-EXPORT-03 hotkey
//   - `onenote_export_and_ingest_page()`  — the full send flow
//                                           (composes get_active_page +
//                                           export_page + pdf_extract +
//                                           build_onenote_com_payload +
//                                           post_payload_to_apolla into
//                                           one IPC call so WP-03/04/05
//                                           don't each re-implement it)
//
// Cross-platform: each function falls through to `onenote_windows`'s
// platform stub on Mac/Linux; the resulting `OneNoteError::PlatformUnsupported`
// surfaces to the frontend as a structured failure outcome. Mac compile
// stays clean.

/// `onenote_get_active_page` returns this enriched envelope rather than a
/// bare page id so the hotkey UX (WP-EXPORT-03) can show "Sending: <title>"
/// before the send completes. The COM read for active page id is cheap; the
/// hierarchy enrichment is cached-once-per-call.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePageReport {
    /// `Some` when OneNote has a page selected; `None` when no notebook is
    /// open (caller renders "Open a OneNote notebook first" toast).
    pub metadata: Option<onenote_windows::PageMetadata>,
}

#[tauri::command]
async fn onenote_enumerate_hierarchy() -> Result<onenote_windows::NotebookTree, String> {
    // COM calls are blocking; spawn off the async runtime so we don't stall
    // the IPC executor while powershell.exe is launching.
    tauri::async_runtime::spawn_blocking(onenote_windows::enumerate_hierarchy)
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| format!("{}", e))
}

#[tauri::command]
async fn onenote_get_active_page() -> Result<ActivePageReport, String> {
    let (page_id_opt, tree) = tauri::async_runtime::spawn_blocking(|| {
        // Two sequential COM calls: cheap active-page lookup + the heavier
        // hierarchy enumeration. We do both up-front because the UX wants
        // the page title (which only the hierarchy carries) for the
        // pre-send toast. The hierarchy is small enough that a single
        // call per IPC tick is fine — WP-EXPORT-04 can layer a 15-min
        // cache on top when bulk-browse needs it.
        let page_id_res = onenote_windows::get_active_page();
        let tree_res = onenote_windows::enumerate_hierarchy();
        (page_id_res, tree_res)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?;

    let page_id = match page_id_opt {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(ActivePageReport { metadata: None }),
        Err(e) => return Err(format!("{}", e)),
    };

    let tree = tree.map_err(|e| format!("{}", e))?;
    Ok(ActivePageReport {
        metadata: onenote_windows::enrich_page_metadata(&tree, &page_id),
    })
}

/// Full per-page capture flow: resolve `pageId` (via `get_active_page` if
/// not supplied) → enrich via `enumerate_hierarchy` → `Application.Publish`
/// to a temp PDF → `pdf_extract::extract_pdf_text` → POST to Apolla. WP-03
/// (hotkey), WP-04 (bulk-send iteration), WP-05 (auto-watch) all reduce to
/// "call this command."
///
/// Returns an `IngestionOutcome` so the frontend can render the same
/// structured toast format already wired for file-upload + screen-capture.
#[tauri::command]
async fn onenote_export_and_ingest_page(
    state: tauri::State<'_, AppState>,
    page_id: Option<String>,
) -> Result<IngestionOutcome, String> {
    let cfg = current_config(&state)?;

    // ── 1. Resolve page id + enriched metadata via COM ──────────────────
    //
    // Both the resolve path (no page_id supplied) and the supplied-id path
    // need the hierarchy for `enrich_page_metadata`. Single spawn_blocking
    // batches the COM round-trips.
    let supplied = page_id.clone();
    let (resolved_id, tree) = tauri::async_runtime::spawn_blocking(move || {
        let id_res = match supplied {
            Some(id) => Ok(Some(id)),
            None => onenote_windows::get_active_page(),
        };
        let tree_res = onenote_windows::enumerate_hierarchy();
        (id_res, tree_res)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?;

    let resolved_id = match resolved_id {
        Ok(Some(id)) => id,
        Ok(None) => {
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: onenote_windows::OneNoteError::NoNotebookOpen
                    .user_message()
                    .to_string(),
                body: Some(
                    "Open a OneNote notebook and select the page you want to send, then retry."
                        .into(),
                ),
                source_path: None,
            });
        }
        Err(e) => {
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: e.user_message().to_string(),
                body: Some(format!("{}", e)),
                source_path: None,
            });
        }
    };

    let tree = match tree {
        Ok(t) => t,
        Err(e) => {
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: e.user_message().to_string(),
                body: Some(format!("{}", e)),
                source_path: None,
            });
        }
    };

    let page_meta = match onenote_windows::enrich_page_metadata(&tree, &resolved_id) {
        Some(m) => m,
        None => {
            // Page id wasn't in the hierarchy — most likely the page was
            // just created or just deleted; OneNote needs a sync round-trip
            // before it shows up. Don't fail loudly; emit a structured
            // outcome the toast can render. v2 polish: retry after
            // `SyncHierarchy` per the Not-Chur-Architect pattern (research
            // §1 Claim 6).
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: format!("OneNote page {} not found in hierarchy", resolved_id),
                body: Some(
                    "The page may have just been created or moved. \
                    OneNote may need a sync round-trip before it appears."
                        .into(),
                ),
                source_path: None,
            });
        }
    };

    // ── 2. Publish page → temp PDF on disk ──────────────────────────────
    let tmp_dir = std::env::temp_dir();
    let resolved_id_for_export = resolved_id.clone();
    let tmp_dir_for_export = tmp_dir.clone();
    let pdf_path = match tauri::async_runtime::spawn_blocking(move || {
        onenote_windows::export_page(&resolved_id_for_export, &tmp_dir_for_export)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
    {
        Ok(p) => p,
        Err(e) => {
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: e.user_message().to_string(),
                body: Some(format!("{}\n\nPage: {}", e, page_meta.title)),
                source_path: None,
            });
        }
    };

    // ── 3. Read PDF bytes + extract text (WP-01's pdf_extract module) ────
    //
    // Use a struct-level guard so the temp PDF gets deleted whether
    // extraction succeeds or fails — we've already read the bytes into
    // memory by the time we get past `fs::read`, and the file's only
    // useful for diagnostics from this point on.
    let bytes = match fs::read(&pdf_path) {
        Ok(b) => b,
        Err(e) => {
            let _ = fs::remove_file(&pdf_path);
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: format!("Couldn't read exported PDF for {}", page_meta.title),
                body: Some(format!("{}: {}", pdf_path.display(), e)),
                source_path: None,
            });
        }
    };

    // Best-effort cleanup; if `remove_file` fails the temp file persists
    // until OS-side temp cleanup. Not a correctness issue.
    let _ = fs::remove_file(&pdf_path);

    let extraction = match pdf_extract::extract_pdf_text(&bytes) {
        Ok(e) => e,
        Err(err) => {
            log::warn!(
                "[onenote-com] pdf-extract failed for page {}: {}",
                page_meta.title,
                err
            );
            return Ok(IngestionOutcome {
                kind: "failure".into(),
                title: err.user_message().to_string(),
                body: Some(format!(
                    "Page: {}\nNotebook: {}\n\n{}",
                    page_meta.title, page_meta.notebook_path, err
                )),
                source_path: None,
            });
        }
    };

    // Handwriting / image-only pages: surface to user (same posture as the
    // export-watch path in `ingest_one_pdf`). Vision-OCR override is v2
    // polish per brief §1.3.
    if extraction.is_likely_handwriting {
        log::info!(
            "[onenote-com] flagged as likely handwriting (chars/page={}, pages={}): {}",
            extraction.chars_per_page,
            extraction.page_count,
            page_meta.title
        );
        return Ok(IngestionOutcome {
            kind: "failure".into(),
            title: format!("Skipped: {} contains handwriting/images", page_meta.title),
            body: Some(format!(
                "OneNote page appears to be mostly handwriting or images \
                ({} chars across {} page(s)). Threshold v1 does not OCR \
                handwriting; the page was not sent to Apolla.",
                extraction.text.len(),
                extraction.page_count
            )),
            source_path: None,
        });
    }

    // ── 4. Build COM payload + POST to Apolla ───────────────────────────
    let payload = build_onenote_com_payload(&page_meta, &bytes, &extraction.text);
    let display_name = format!("{} ({})", page_meta.title, page_meta.notebook_path);
    Ok(post_payload_to_apolla(payload, &cfg, &display_name, None).await)
}

// ───────────────────────────────────────────────────────────────────────────
// WP-ONENOTE-EXPORT-03 — internal dispatch helper for hotkey + menu item
// ───────────────────────────────────────────────────────────────────────────
//
// `fire_onenote_send_flow` performs the two-step send (cheap active-page
// lookup → pre-send "Sending: <title>" toast → full publish+post) and
// emits every outcome as a structured `IngestionOutcome` over the same
// `threshold://toast` event the frontend already wires up for every
// other ingestion surface. Used by BOTH the global hotkey handler AND
// the widget right-click "Send current OneNote page" menu item so the
// two surfaces are guaranteed identical (single source of truth).
//
// The function does NOT need `tauri::State<AppState>` because both call
// sites already hold an `AppHandle`; we re-read the cached config from
// AppState ourselves. Returns `()` — the result is reported via toast,
// not via return value.

/// Best-effort lookup of the cached `AppConfig`. Returns `None` if the
/// user hasn't completed Configure yet (no `load_config` has populated
/// the cache). Used by the hotkey + menu dispatch path so we can emit a
/// "Configure Apolla first" toast instead of silently hanging.
fn current_config_opt(app: &tauri::AppHandle) -> Option<AppConfig> {
    let state = app.state::<AppState>();
    state.config.lock().ok().and_then(|guard| guard.clone())
}

/// Fire the "send the OneNote page the user is currently viewing" flow.
/// Two-step: cheap active-page lookup for the pre-send toast, then the
/// full publish + POST in `onenote_export_and_ingest_page`. Every outcome
/// (no notebook open, COM unregistered, PDF extraction failed, success,
/// handwriting-skip, etc.) emits a structured `IngestionOutcome` event.
/// Called from both the global-shortcut handler and the menu_event arm.
#[allow(dead_code)] // Only invoked under cfg(target_os = "windows") on the hotkey path; menu arm invokes unconditionally on all platforms.
async fn fire_onenote_send_flow(app: tauri::AppHandle) {
    // ── 1. Resolve config (or bail with a Configure-first toast) ────────
    let cfg = match current_config_opt(&app) {
        Some(c) => c,
        None => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "Configure Apolla first".into(),
                    body: Some(
                        "Open Settings → connect your Apolla workspace before sending \
                         OneNote pages."
                            .into(),
                    ),
                    source_path: None,
                },
            );
            return;
        }
    };

    // ── 2. Cheap active-page lookup for the pre-send "Sending: …" toast ─
    //
    // We branch on the Result/Option here rather than calling the full
    // `onenote_export_and_ingest_page` IPC so the user gets immediate
    // feedback ("Sending: <title>…") that something is happening BEFORE
    // the multi-second Publish + extract + POST round-trip kicks off.
    // The pre-send toast carries the same `source_path: None` so it
    // shows alongside other captures without the pre/post-dedup
    // matching path that file uploads use.
    let active = tauri::async_runtime::spawn_blocking(|| {
        let page_id_res = onenote_windows::get_active_page();
        let tree_res = onenote_windows::enumerate_hierarchy();
        (page_id_res, tree_res)
    })
    .await;

    let (page_id_res, tree_res) = match active {
        Ok(pair) => pair,
        Err(join_err) => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "OneNote lookup task panicked".into(),
                    body: Some(format!("blocking task join error: {}", join_err)),
                    source_path: None,
                },
            );
            return;
        }
    };

    // Handle the active-page lookup explicitly so we can emit the
    // user-friendly toast for the two most common UX cases:
    //   - PlatformUnsupported → Mac/Linux fallback toast
    //   - ComClassNotRegistered → UWP-variant guidance toast
    //   - NoNotebookOpen → "Open a notebook first" toast
    let page_id = match page_id_res {
        Ok(Some(id)) => id,
        Ok(None) => {
            // Distinct UX from a Result::Err — OneNote is healthy but no
            // notebook is open. Map through `OneNoteError::NoNotebookOpen`
            // so the wording matches the IPC path's outcome.
            let err = onenote_windows::OneNoteError::NoNotebookOpen;
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: err.user_message().to_string(),
                    body: Some(
                        "Open a OneNote notebook in the Microsoft 365 desktop OneNote app, \
                         select the page you want to send, then retry."
                            .into(),
                    ),
                    source_path: None,
                },
            );
            return;
        }
        Err(e) => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: e.user_message().to_string(),
                    body: Some(format!("{}", e)),
                    source_path: None,
                },
            );
            return;
        }
    };

    // Enrich title for the pre-send toast. If the hierarchy enumeration
    // failed we still fire the send — the full IPC will re-attempt the
    // hierarchy and surface the error there. Best-effort here.
    let display_title = tree_res
        .as_ref()
        .ok()
        .and_then(|tree| onenote_windows::enrich_page_metadata(tree, &page_id))
        .map(|m| m.title)
        .unwrap_or_else(|| "current OneNote page".to_string());

    let _ = app.emit(
        "threshold://toast",
        IngestionOutcome {
            kind: "success".into(), // pre-send is treated as info; "success" renders without an error tint
            title: format!("Sending: {}…", display_title),
            body: Some("Publishing the OneNote page and sending to Apolla.".into()),
            source_path: None,
        },
    );

    // ── 3. Full publish + POST. Re-uses the IPC's body so the policy
    //       (handwriting skip, hierarchy miss, PDF extract failure, etc.)
    //       is single-source-of-truth.
    let cfg_for_send = cfg.clone();
    let page_id_for_send = page_id.clone();
    let outcome = run_onenote_send_inline(cfg_for_send, Some(page_id_for_send)).await;
    let _ = app.emit("threshold://toast", outcome);
}

/// WP-ONENOTE-EXPORT-04 — widget right-click menu helper.
///
/// Same role as `fire_onenote_send_flow` but for the "Send all pages in
/// current section…" menu item. Resolves config, emits a "Sending all N
/// pages of <section>…" pre-send toast, then dispatches into
/// `run_bulk_send_section` (the shared engine that the
/// `onenote_send_section` + `onenote_send_active_section` IPCs also use).
/// The progress events + final-report event are emitted by
/// `run_bulk_send_section`; here we also emit a structured `threshold://toast`
/// summary on completion so the menu user gets the same toast UX as every
/// other ingestion surface.
async fn fire_onenote_send_active_section_flow(app: tauri::AppHandle) {
    // ── 1. Resolve config (or bail with a Configure-first toast) ────────
    let cfg = match current_config_opt(&app) {
        Some(c) => c,
        None => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "Configure Apolla first".into(),
                    body: Some(
                        "Open Settings → connect your Apolla workspace before sending \
                         OneNote sections."
                            .into(),
                    ),
                    source_path: None,
                },
            );
            return;
        }
    };

    // ── 2. Resolve active section via COM ───────────────────────────────
    let active = tauri::async_runtime::spawn_blocking(|| {
        let page_id_res = onenote_windows::get_active_page();
        let tree_res = onenote_windows::enumerate_hierarchy();
        (page_id_res, tree_res)
    })
    .await;

    let (page_id_res, tree_res) = match active {
        Ok(pair) => pair,
        Err(join_err) => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: "OneNote section lookup task panicked".into(),
                    body: Some(format!("blocking task join error: {}", join_err)),
                    source_path: None,
                },
            );
            return;
        }
    };

    let page_id = match page_id_res {
        Ok(Some(id)) => id,
        Ok(None) => {
            let err = onenote_windows::OneNoteError::NoNotebookOpen;
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: err.user_message().to_string(),
                    body: Some(
                        "Open a OneNote notebook in the Microsoft 365 desktop OneNote app, \
                         select any page in the section you want to send, then retry."
                            .into(),
                    ),
                    source_path: None,
                },
            );
            return;
        }
        Err(e) => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: e.user_message().to_string(),
                    body: Some(format!("{}", e)),
                    source_path: None,
                },
            );
            return;
        }
    };

    let tree = match tree_res {
        Ok(t) => t,
        Err(e) => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: e.user_message().to_string(),
                    body: Some(format!("{}", e)),
                    source_path: None,
                },
            );
            return;
        }
    };

    let page_meta = match onenote_windows::enrich_page_metadata(&tree, &page_id) {
        Some(m) => m,
        None => {
            let _ = app.emit(
                "threshold://toast",
                IngestionOutcome {
                    kind: "failure".into(),
                    title: format!("Active page {} not found in hierarchy", page_id),
                    body: Some(
                        "The page may have just been created or moved. OneNote may need a \
                         sync round-trip before its section can be enumerated."
                            .into(),
                    ),
                    source_path: None,
                },
            );
            return;
        }
    };

    // Count pages in section for the pre-send toast.
    let section_page_count = find_section_with_notebook(&tree, &page_meta.section_id)
        .map(|(_, section)| section.pages.len())
        .unwrap_or(0);

    // ── 3. Pre-send toast (so user knows the operation kicked off) ──────
    let _ = app.emit(
        "threshold://toast",
        IngestionOutcome {
            kind: "success".into(), // info-style, no error tint
            title: format!(
                "Sending {} page(s) from \"{}\"…",
                section_page_count, page_meta.section_name
            ),
            body: Some(format!(
                "Notebook: {}\nSection: {}\n\nProgress events will fire as each page is processed.",
                page_meta.notebook_name, page_meta.section_name
            )),
            source_path: None,
        },
    );

    // ── 4. Dispatch into the shared bulk-send engine. ──────────────────
    // `run_bulk_send_section` owns single-flight, cancel, per-page emit,
    // and the final-report emit.
    let report = run_bulk_send_section(app.clone(), cfg, tree, page_meta.section_id).await;

    // ── 5. Summary toast — same renderer the rest of Threshold uses. ────
    let (kind, title) = if report.failed == 0 && report.cancelled == 0 {
        (
            "success",
            format!(
                "Sent {}/{} page(s) from \"{}\"",
                report.succeeded, report.total, report.section_name
            ),
        )
    } else if report.cancelled > 0 && report.failed == 0 {
        (
            "idempotent",
            format!(
                "Cancelled: sent {}/{} page(s) from \"{}\" before stop",
                report.succeeded, report.total, report.section_name
            ),
        )
    } else {
        (
            "failure",
            format!(
                "Partial send: {} succeeded, {} failed, {} cancelled (of {} pages from \"{}\")",
                report.succeeded,
                report.failed,
                report.cancelled,
                report.total,
                report.section_name
            ),
        )
    };

    let body = if report.errors.is_empty() {
        None
    } else {
        // Surface the first 3 error messages in the toast body; full list
        // is in the report event.
        let preview = report
            .errors
            .iter()
            .take(3)
            .map(|(_, msg)| format!("• {}", msg))
            .collect::<Vec<_>>()
            .join("\n");
        let suffix = if report.errors.len() > 3 {
            format!("\n…and {} more", report.errors.len() - 3)
        } else {
            String::new()
        };
        Some(format!("{}{}", preview, suffix))
    };

    let _ = app.emit(
        "threshold://toast",
        IngestionOutcome {
            kind: kind.into(),
            title,
            body,
            source_path: None,
        },
    );
}

/// Plain-function version of `onenote_export_and_ingest_page` (the
/// `#[tauri::command]` requires `tauri::State`, which we already deref'd
/// inside `fire_onenote_send_flow`). Code path is byte-equal to the IPC
/// — including: handwriting-skip handling, hierarchy miss handling,
/// temp-PDF cleanup, COM error → `OneNoteError::user_message()` mapping.
///
/// Lives here so the hotkey + menu dispatch path doesn't replicate the
/// 100-line publish-and-post body; future calls (WP-04 bulk-send loop,
/// WP-05 auto-watch tick) can call this too. The IPC command becomes a
/// 1-line wrapper in a follow-on cleanup pass (left as-is for now to
/// minimize the WP-03 diff).
async fn run_onenote_send_inline(
    cfg: AppConfig,
    page_id: Option<String>,
) -> IngestionOutcome {
    // ── 1. Resolve page id + enriched metadata via COM ──────────────────
    let supplied = page_id.clone();
    let active = tauri::async_runtime::spawn_blocking(move || {
        let id_res = match supplied {
            Some(id) => Ok(Some(id)),
            None => onenote_windows::get_active_page(),
        };
        let tree_res = onenote_windows::enumerate_hierarchy();
        (id_res, tree_res)
    })
    .await;

    let (resolved_id, tree) = match active {
        Ok(pair) => pair,
        Err(e) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: "OneNote send task panicked".into(),
                body: Some(format!("blocking task join error: {}", e)),
                source_path: None,
            };
        }
    };

    let resolved_id = match resolved_id {
        Ok(Some(id)) => id,
        Ok(None) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: onenote_windows::OneNoteError::NoNotebookOpen
                    .user_message()
                    .to_string(),
                body: Some(
                    "Open a OneNote notebook and select the page you want to send, then retry."
                        .into(),
                ),
                source_path: None,
            };
        }
        Err(e) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: e.user_message().to_string(),
                body: Some(format!("{}", e)),
                source_path: None,
            };
        }
    };

    let tree = match tree {
        Ok(t) => t,
        Err(e) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: e.user_message().to_string(),
                body: Some(format!("{}", e)),
                source_path: None,
            };
        }
    };

    let page_meta = match onenote_windows::enrich_page_metadata(&tree, &resolved_id) {
        Some(m) => m,
        None => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: format!("OneNote page {} not found in hierarchy", resolved_id),
                body: Some(
                    "The page may have just been created or moved. \
                    OneNote may need a sync round-trip before it appears."
                        .into(),
                ),
                source_path: None,
            };
        }
    };

    // ── 2. Publish page → temp PDF on disk ──────────────────────────────
    let tmp_dir = std::env::temp_dir();
    let resolved_id_for_export = resolved_id.clone();
    let tmp_dir_for_export = tmp_dir.clone();
    let pdf_path = match tauri::async_runtime::spawn_blocking(move || {
        onenote_windows::export_page(&resolved_id_for_export, &tmp_dir_for_export)
    })
    .await
    {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: e.user_message().to_string(),
                body: Some(format!("{}\n\nPage: {}", e, page_meta.title)),
                source_path: None,
            };
        }
        Err(join_err) => {
            return IngestionOutcome {
                kind: "failure".into(),
                title: "OneNote export task panicked".into(),
                body: Some(format!("blocking task join error: {}", join_err)),
                source_path: None,
            };
        }
    };

    // ── 3. Read PDF bytes + extract text ────────────────────────────────
    let bytes = match fs::read(&pdf_path) {
        Ok(b) => b,
        Err(e) => {
            let _ = fs::remove_file(&pdf_path);
            return IngestionOutcome {
                kind: "failure".into(),
                title: format!("Couldn't read exported PDF for {}", page_meta.title),
                body: Some(format!("{}: {}", pdf_path.display(), e)),
                source_path: None,
            };
        }
    };
    let _ = fs::remove_file(&pdf_path);

    let extraction = match pdf_extract::extract_pdf_text(&bytes) {
        Ok(e) => e,
        Err(err) => {
            log::warn!(
                "[onenote-com] pdf-extract failed for page {}: {}",
                page_meta.title,
                err
            );
            return IngestionOutcome {
                kind: "failure".into(),
                title: err.user_message().to_string(),
                body: Some(format!(
                    "Page: {}\nNotebook: {}\n\n{}",
                    page_meta.title, page_meta.notebook_path, err
                )),
                source_path: None,
            };
        }
    };

    if extraction.is_likely_handwriting {
        log::info!(
            "[onenote-com] flagged as likely handwriting (chars/page={}, pages={}): {}",
            extraction.chars_per_page,
            extraction.page_count,
            page_meta.title
        );
        return IngestionOutcome {
            kind: "failure".into(),
            title: format!("Skipped: {} contains handwriting/images", page_meta.title),
            body: Some(format!(
                "OneNote page appears to be mostly handwriting or images \
                ({} chars across {} page(s)). Threshold v1 does not OCR \
                handwriting; the page was not sent to Apolla.",
                extraction.text.len(),
                extraction.page_count
            )),
            source_path: None,
        };
    }

    // ── 4. Build COM payload + POST to Apolla ───────────────────────────
    let payload = build_onenote_com_payload(&page_meta, &bytes, &extraction.text);
    let display_name = format!("{} ({})", page_meta.title, page_meta.notebook_path);
    post_payload_to_apolla(payload, &cfg, &display_name, None).await
}

// ───────────────────────────────────────────────────────────────────────────
// WP-ONENOTE-EXPORT-04 — bulk-send-section IPC + progress / cancel
// ───────────────────────────────────────────────────────────────────────────
//
// Three Tauri commands implement the browse-view's per-section "Send all N
// pages" flow:
//
//   - `onenote_send_section(section_id)`     — main entry point. Used by
//                                              the browse-view per-section
//                                              button. Looks up the section
//                                              in the hierarchy, then runs
//                                              the bulk-send loop.
//   - `onenote_send_active_section()`        — convenience for the widget
//                                              right-click menu item.
//                                              Resolves active section via
//                                              `onenote_get_active_page` +
//                                              dispatches into
//                                              `onenote_send_section`.
//   - `onenote_cancel_bulk_send()`           — flips the cancel flag so the
//                                              bulk-send loop short-circuits
//                                              after the current page
//                                              completes.
//
// Progress events (per WP-04 dispatch prompt):
//   - `onenote-bulk-send-progress` — emitted per-page with
//                                    {page_id, page_title, status,
//                                    completed, total}
//   - `onenote-bulk-send-complete` — emitted once at end of loop with the
//                                    full `BulkSendReport`
//
// Single-flight discipline (brief §3.4 + WP-02 agent's observation #7):
// the loop holds `ONENOTE_BULK_SEND_IN_FLIGHT` for its entire duration and
// `.await`s every page sequentially. Concurrent invocations short-circuit
// with `BulkSendError::Busy`. Per-page Publish / pdf-extract / POST stays
// inside the existing `run_onenote_send_inline` so the policy (handwriting
// skip, hierarchy miss, etc.) is single-source-of-truth.

/// Per-page progress event payload. Emitted on every page-boundary transition
/// inside the bulk-send loop. `status` is one of: `"started"` (about to
/// publish), `"succeeded"` (ingestion success or idempotent), `"failed"`
/// (any error path), `"cancelled"` (skipped because the cancel flag was
/// flipped before the page started).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkSendProgress {
    pub section_id: String,
    pub page_id: String,
    pub page_title: String,
    pub status: String,
    pub completed: usize,
    pub total: usize,
}

/// Final report emitted on `onenote-bulk-send-complete`. `cancelled` is the
/// count of pages that were skipped because of an early cancel; `errors`
/// carries per-failure `(page_id, message)` tuples so the frontend can list
/// the misses if needed (v1 ships just the counts in the success toast).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkSendReport {
    pub section_id: String,
    pub section_name: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub errors: Vec<(String, String)>,
}

/// Tauri command — flip the cancel flag. The bulk-send loop checks the flag
/// between pages; in-flight Publish + POST on the current page completes
/// (per brief §3.4 AC: "Cancel button stops further sends mid-batch
/// (in-flight POST completes)").
#[tauri::command]
fn onenote_cancel_bulk_send() {
    ONENOTE_BULK_SEND_CANCEL.store(true, Ordering::SeqCst);
    log::info!("[onenote-bulk-send] cancel flag set");
}

/// Pure helper — given a hierarchy tree and a section id, return the section
/// + its enriched notebook context (notebook_id / notebook_name) so the loop
/// can stamp the per-page toast titles and the final report.
///
/// Lifted out of the IPC command so it's exercisable on Mac (the tree is a
/// pure serde struct; the join is pure-function). Returns `None` when the
/// section id is not present in the tree (most likely: section was just
/// deleted, or hierarchy is stale and OneNote needs a sync round-trip).
pub fn find_section_with_notebook<'a>(
    tree: &'a onenote_windows::NotebookTree,
    section_id: &str,
) -> Option<(&'a onenote_windows::Notebook, &'a onenote_windows::Section)> {
    for notebook in &tree.notebooks {
        for section in &notebook.sections {
            if section.section_id == section_id {
                return Some((notebook, section));
            }
        }
    }
    None
}

/// Tauri command — convenience wrapper that resolves the active section via
/// `onenote_get_active_page`'s enriched metadata, then dispatches into
/// `onenote_send_section`. Used by the widget right-click menu's "Send all
/// pages in current section…" item; the browse-view's per-section button
/// calls `onenote_send_section` directly with the user-clicked section id.
///
/// Returns the same `BulkSendReport` shape so a single frontend toast
/// renderer handles both entry points.
#[tauri::command]
async fn onenote_send_active_section(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BulkSendReport, String> {
    // Cheap active-page lookup (carries section context) → section_id.
    // No need to call `onenote_send_section` indirectly; just inline the
    // resolve + dispatch so we don't pay a second hierarchy enumeration.
    let active = tauri::async_runtime::spawn_blocking(|| {
        let page_id_res = onenote_windows::get_active_page();
        let tree_res = onenote_windows::enumerate_hierarchy();
        (page_id_res, tree_res)
    })
    .await
    .map_err(|e| format!("join error: {}", e))?;

    let (page_id_res, tree_res) = active;

    let page_id = match page_id_res {
        Ok(Some(id)) => id,
        Ok(None) => {
            return Err(onenote_windows::OneNoteError::NoNotebookOpen
                .user_message()
                .to_string());
        }
        Err(e) => return Err(format!("{}", e)),
    };

    let tree = tree_res.map_err(|e| format!("{}", e))?;
    let page_meta = onenote_windows::enrich_page_metadata(&tree, &page_id).ok_or_else(|| {
        format!(
            "Active OneNote page {} not found in hierarchy (sync may be pending)",
            page_id
        )
    })?;

    // Dispatch through the canonical section-by-id command so the same
    // single-flight + cancel + progress machinery runs.
    let cfg = current_config(&state)?;
    Ok(run_bulk_send_section(
        app_handle,
        cfg,
        tree,
        page_meta.section_id,
    )
    .await)
}

/// Tauri command — bulk-send every page in a section by id. Frontend supplies
/// `section_id` (from the browse-view tree); we re-enumerate the hierarchy
/// to get a fresh snapshot before iterating (a stale browse-view cache may
/// be 15 min old per brief §3.4; if a section was just deleted we want to
/// fail fast).
///
/// Returns the `BulkSendReport` on completion (success / failure / cancelled
/// paths all return Ok with the populated report). Top-level `Err` only
/// for: config missing, single-flight conflict, hierarchy enumeration
/// failure, section not found.
#[tauri::command]
async fn onenote_send_section(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    section_id: String,
) -> Result<BulkSendReport, String> {
    let cfg = current_config(&state)?;

    // Fresh hierarchy enumeration — the frontend's tree may be 15min stale.
    let tree = tauri::async_runtime::spawn_blocking(onenote_windows::enumerate_hierarchy)
        .await
        .map_err(|e| format!("join error: {}", e))?
        .map_err(|e| format!("{}", e))?;

    Ok(run_bulk_send_section(app_handle, cfg, tree, section_id).await)
}

/// Internal: actually iterate over the section's pages and dispatch each
/// through the existing per-page send flow. Holds the single-flight mutex
/// for the entire duration; emits per-page progress + final-report events.
///
/// Why a separate function (and not inlined in both IPC entry points): the
/// `onenote_send_active_section` path needs the tree it already enumerated
/// (don't pay for a second enum); the `onenote_send_section` path needs to
/// enum a fresh tree (frontend tree may be stale). Both paths converge here.
async fn run_bulk_send_section(
    app_handle: tauri::AppHandle,
    cfg: AppConfig,
    tree: onenote_windows::NotebookTree,
    section_id: String,
) -> BulkSendReport {
    // ── 1. Resolve section + notebook in the supplied tree ──────────────
    let (notebook_name, section_name, page_list) = match find_section_with_notebook(
        &tree,
        &section_id,
    ) {
        Some((notebook, section)) => (
            notebook.name.clone(),
            section.name.clone(),
            section.pages.clone(),
        ),
        None => {
            let report = BulkSendReport {
                section_id: section_id.clone(),
                section_name: String::new(),
                total: 0,
                succeeded: 0,
                failed: 0,
                cancelled: 0,
                errors: vec![(
                    String::new(),
                    format!("Section {} not found in OneNote hierarchy", section_id),
                )],
            };
            let _ = app_handle.emit("onenote-bulk-send-complete", &report);
            return report;
        }
    };

    // ── 2. Acquire single-flight guard ──────────────────────────────────
    {
        let mut guard = match ONENOTE_BULK_SEND_IN_FLIGHT.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if *guard {
            let report = BulkSendReport {
                section_id: section_id.clone(),
                section_name,
                total: 0,
                succeeded: 0,
                failed: 0,
                cancelled: 0,
                errors: vec![(
                    String::new(),
                    "Another bulk send is already running — wait for it to finish or cancel it"
                        .to_string(),
                )],
            };
            let _ = app_handle.emit("onenote-bulk-send-complete", &report);
            return report;
        }
        *guard = true;
    }

    // Reset cancel flag at the start of every bulk send (so a prior cancel
    // doesn't poison this batch). The cancel flag is only read between pages
    // so it's safe to reset here.
    ONENOTE_BULK_SEND_CANCEL.store(false, Ordering::SeqCst);

    let total = page_list.len();
    let mut succeeded: usize = 0;
    let mut failed: usize = 0;
    let mut cancelled: usize = 0;
    let mut errors: Vec<(String, String)> = Vec::new();

    log::info!(
        "[onenote-bulk-send] starting section_id={} ({} / {}) total_pages={}",
        section_id,
        notebook_name,
        section_name,
        total
    );

    // ── 3. Iterate pages sequentially, awaiting each. The brief explicitly
    //       requires this (no try_join_all / tokio::spawn-per-page) to avoid
    //       fanning out N concurrent COM calls + N concurrent POSTs. ──────
    for (index, page) in page_list.iter().enumerate() {
        let completed_after = index + 1;

        // Cancel check happens BEFORE the page starts. If a prior page is
        // mid-flight when cancel is set, that page completes; the next
        // iteration short-circuits here.
        if ONENOTE_BULK_SEND_CANCEL.load(Ordering::SeqCst) {
            cancelled = total - index; // every remaining page including this one
            log::info!(
                "[onenote-bulk-send] cancelled at page {}/{} ({})",
                completed_after,
                total,
                page.name
            );
            let _ = app_handle.emit(
                "onenote-bulk-send-progress",
                BulkSendProgress {
                    section_id: section_id.clone(),
                    page_id: page.page_id.clone(),
                    page_title: page.name.clone(),
                    status: "cancelled".into(),
                    completed: index, // we did NOT start this page
                    total,
                },
            );
            break;
        }

        // "Started" event so the frontend can update the active-page row
        // BEFORE the multi-second Publish + POST round-trip.
        let _ = app_handle.emit(
            "onenote-bulk-send-progress",
            BulkSendProgress {
                section_id: section_id.clone(),
                page_id: page.page_id.clone(),
                page_title: page.name.clone(),
                status: "started".into(),
                completed: index,
                total,
            },
        );

        // Per-page send. `run_onenote_send_inline` is the same code path
        // hotkey + menu use — handwriting skip, hierarchy miss, COM error
        // → user_message mapping are all single source of truth.
        let outcome = run_onenote_send_inline(cfg.clone(), Some(page.page_id.clone())).await;

        let (status, body_for_error) = match outcome.kind.as_str() {
            "success" | "idempotent" => {
                succeeded += 1;
                ("succeeded", None)
            }
            _ => {
                failed += 1;
                errors.push((
                    page.page_id.clone(),
                    outcome
                        .body
                        .clone()
                        .unwrap_or_else(|| outcome.title.clone()),
                ));
                ("failed", outcome.body.clone())
            }
        };

        log::debug!(
            "[onenote-bulk-send] page {}/{} status={} title={}",
            completed_after,
            total,
            status,
            page.name
        );

        let _ = app_handle.emit(
            "onenote-bulk-send-progress",
            BulkSendProgress {
                section_id: section_id.clone(),
                page_id: page.page_id.clone(),
                page_title: page.name.clone(),
                status: status.into(),
                completed: completed_after,
                total,
            },
        );

        // Suppress the unused-variable warning for the error body — the
        // detail is already captured in `errors` above and emitted via the
        // progress event's `status` field.
        let _ = body_for_error;
    }

    // ── 4. Release single-flight guard ──────────────────────────────────
    {
        let mut guard = match ONENOTE_BULK_SEND_IN_FLIGHT.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = false;
    }
    // Reset cancel flag so the next bulk-send starts clean even if no one
    // pressed cancel during this run (defensive — `start` also resets it).
    ONENOTE_BULK_SEND_CANCEL.store(false, Ordering::SeqCst);

    let report = BulkSendReport {
        section_id: section_id.clone(),
        section_name,
        total,
        succeeded,
        failed,
        cancelled,
        errors,
    };
    log::info!(
        "[onenote-bulk-send] complete section_id={} total={} succeeded={} failed={} cancelled={}",
        section_id,
        report.total,
        report.succeeded,
        report.failed,
        report.cancelled
    );
    let _ = app_handle.emit("onenote-bulk-send-complete", &report);
    report
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
/// WP-PLAUD-04a — Plaud Sync Queue menu item ID. Right-clicking the widget
/// surfaces this option; selecting it expands the widget into the queue view.
const MENU_PLAUD_QUEUE: &str = "menu.plaud_queue";
/// WP-ONENOTE-EXPORT-03 — "Send current OneNote page" widget right-click
/// menu item. Sits below the Plaud queue entry; same dispatch surface as
/// the global hotkey (default Ctrl+Shift+O). Cross-platform: the menu item
/// renders on Mac too, but selecting it surfaces a structured
/// `OneNoteError::PlatformUnsupported` toast — chosen over hiding the item
/// on Mac so the menu shape is consistent during dev / demo. WP-04 adds
/// "Browse OneNote…" and "Send all pages in current section…"; v1 ships
/// the single item only (refined scope per coordinator).
const MENU_ONENOTE_SEND_CURRENT_PAGE: &str = "menu.onenote_send_current_page";
/// WP-ONENOTE-EXPORT-04 — "Send all pages in current section…" widget
/// right-click menu item. Resolves the active section via
/// `onenote_get_active_page` (whose enriched metadata carries
/// `sectionId` + `sectionName`), then dispatches the bulk-send loop over
/// every page in that section. Same cross-platform discipline as the
/// send-current-page item: menu renders everywhere; selecting on Mac
/// returns a `PlatformUnsupported` toast.
const MENU_ONENOTE_SEND_SECTION: &str = "menu.onenote_send_section";
/// WP-ONENOTE-EXPORT-04 — "Browse OneNote…" widget right-click menu item.
/// Opens the `#view-onenote-browse` section via `widget_expand` (same
/// mechanism the Plaud-queue and Settings items use). Frontend renders
/// the notebook → section → page tree and per-section "Send all N pages"
/// buttons that dispatch to `onenote_send_section`.
const MENU_ONENOTE_BROWSE: &str = "menu.onenote_browse";
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
    // WP-PLAUD-04a — sits between Pick File and Expand so the high-frequency
    // capture surfaces stay at the top of the menu.
    let plaud_queue = MenuItem::with_id(app, MENU_PLAUD_QUEUE, "Plaud Sync Queue", true, None::<&str>)?;
    // WP-ONENOTE-EXPORT-03 — sits directly after Plaud Sync Queue so the
    // per-source ingestion surfaces are grouped above the workspace
    // controls (Expand / Settings / Quit). v1 ships this single item;
    // WP-04 adds "Browse OneNote…" + "Send all pages in current section…"
    // when their backing UX lands.
    let onenote_send_current_page = MenuItem::with_id(
        app,
        MENU_ONENOTE_SEND_CURRENT_PAGE,
        "Send current OneNote page",
        true,
        None::<&str>,
    )?;
    // WP-ONENOTE-EXPORT-04 — bulk-send-section + browse entries grouped with
    // the single-page send item so all OneNote surfaces sit together. Order
    // mirrors increasing scope: single page → whole section → browse.
    let onenote_send_section = MenuItem::with_id(
        app,
        MENU_ONENOTE_SEND_SECTION,
        "Send all pages in current section…",
        true,
        None::<&str>,
    )?;
    let onenote_browse = MenuItem::with_id(
        app,
        MENU_ONENOTE_BROWSE,
        "Browse OneNote…",
        true,
        None::<&str>,
    )?;
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
                &plaud_queue,
                &onenote_send_current_page,
                &onenote_send_section,
                &onenote_browse,
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
            &plaud_queue,
            &onenote_send_current_page,
            &onenote_send_section,
            &onenote_browse,
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
            // WP-Threshold-Tidbit-Return Phase B — content-hash documentId
            // BEFORE the POST so the polling dispatch matches whatever
            // build_screenshot_payload sends as documentId on the wire.
            let document_id = compute_document_id(&result.text);
            let outcome = post_payload_to_apolla(
                payload,
                &cfg,
                "screen capture",
                Some("__screen_capture__".into()),
            )
            .await;
            dispatch_tidbit_poll_if_success(&app_handle, &outcome, &cfg, document_id);
            outcome
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
            // WP-Threshold-Tidbit-Return Phase B — see Mac branch above.
            let document_id = compute_document_id(&result.text);
            let outcome = post_payload_to_apolla(
                payload,
                &cfg,
                "screen capture",
                Some("__screen_capture__".into()),
            )
            .await;
            dispatch_tidbit_poll_if_success(&app_handle, &outcome, &cfg, document_id);
            outcome
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
        // FN-CUX-14 — native OS notifications (Notification Center on
        // Mac, Action Center on Windows). The widget mode lacks an
        // in-window toast surface; this plugin gives us the canonical
        // failure/success surface alongside the status-dot color flip.
        .plugin(tauri_plugin_notification::init())
        // WP-OCR-09 Phase D — custom URL scheme `apolla-threshold://`
        // for one-click Apolla onboarding. Scheme registration is
        // declared in tauri.conf.json (`plugins.deep-link.desktop.schemes`);
        // the plugin bakes the platform-specific config (Info.plist on
        // Mac, HKEY_CLASSES_ROOT on Windows) into the installer at
        // bundle time. The setup-time `register_all()` call below
        // covers dev-mode + Windows-msi-not-yet-installed paths where
        // the installer registration isn't active yet.
        .plugin(tauri_plugin_deep_link::init())
        // WP-ONENOTE-EXPORT-03 — global hotkey for "send current OneNote
        // page" (default Ctrl+Shift+O, user-configurable via Configure pane).
        // Plugin is initialized unconditionally so the Configure pane's
        // hotkey field renders + persists on all platforms; the actual
        // shortcut registration is Windows-only (gated inside `setup()`
        // below) because the OneNote COM dispatch is Windows-only — a
        // hotkey on Mac would just fire `PlatformUnsupported` toasts on
        // every keypress. We do NOT grant `global-shortcut:default` in
        // `capabilities/default.json` because the JS side never invokes
        // the plugin's register/unregister IPC — all registration happens
        // Rust-side via `app.global_shortcut().on_shortcut(...)`.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // WP-OCR-09 Phase D — deep-link handler + dev-mode runtime
            // registration. Wire the URL listener BEFORE any other setup
            // work so an at-launch deep-link (e.g., `open
            // apolla-threshold://configure?...` while Threshold is
            // closed) is delivered to the new window once it boots.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Dev-mode + Windows runtime registration. On macOS the
                // .app's Info.plist (baked from tauri.conf.json) handles
                // it; this call is no-op there but defensive. On Linux
                // (deferred per FN-OCR-13-01) the .desktop file does it.
                #[cfg(any(windows, target_os = "linux"))]
                {
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("deep-link register_all failed: {e}");
                    }
                }
                #[cfg(debug_assertions)]
                #[cfg(not(any(windows, target_os = "linux")))]
                {
                    // Mac dev-mode: register the running executable as
                    // the scheme handler so `open apolla-threshold://...`
                    // routes to the cargo-tauri-dev binary instead of
                    // failing with "no handler". Only in debug_assertions
                    // — release bundles use the Info.plist registration.
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("deep-link dev register_all failed: {e}");
                    }
                }
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        log::info!("deep-link received: scheme={} path={}", url.scheme(), url.path());
                        if let Some(prefill) = parse_configure_deep_link(&url) {
                            log::info!(
                                "deep-link parsed: tenant={} baseUrl={} (token redacted)",
                                prefill.tenant.as_deref().unwrap_or("(none)"),
                                prefill.base_url,
                            );
                            if let Err(e) = app_handle.emit("threshold://configure-prefill", &prefill) {
                                log::warn!("emit configure-prefill failed: {e}");
                            }
                        } else {
                            log::warn!("deep-link unrecognized — host={:?} path={}", url.host_str(), url.path());
                        }
                    }
                });
            }

            // WP-OCR-13 v0.2: in-process Vision (Mac) / Windows.Media.Ocr (Windows)
            // replaces the v0.1 D-12-19 startup probe for `~/.local/bin/ocr-capture`.
            //
            // WP-ONENOTE-EXPORT-03 amendment — pre-load AppConfig from disk
            // here (synchronously) so the global hotkey can be registered
            // with the user's configured key before the first webview frame
            // renders. Previously the cache populated lazily on the first
            // `load_config` IPC; for hotkey UX we need it earlier. Failure
            // to read is non-fatal — we fall back to None (legacy behavior)
            // and use `DEFAULT_ONENOTE_HOTKEY` for hotkey registration.
            let preloaded_cfg = config_path()
                .filter(|p| p.exists())
                .and_then(|p| fs::read_to_string(&p).ok())
                .and_then(|raw| serde_json::from_str::<AppConfig>(&raw).ok());
            if preloaded_cfg.is_some() {
                log::info!("WP-ONENOTE-EXPORT-03: pre-loaded AppConfig from disk");
            } else {
                log::info!(
                    "WP-ONENOTE-EXPORT-03: no AppConfig on disk yet — \
                     hotkey will register with default {}",
                    DEFAULT_ONENOTE_HOTKEY
                );
            }
            app.manage(AppState {
                config: Mutex::new(preloaded_cfg.clone()),
                pending_tidbit: Mutex::new(None),
            });

            // WP-ONENOTE-EXPORT-03 — register the OneNote global hotkey.
            // Windows-only: the OneNote COM dispatch is Windows-only, so
            // registering on Mac/Linux would just fire `PlatformUnsupported`
            // toasts on every keypress. The plugin is initialized on all
            // platforms (so the Configure pane uses a single code path),
            // but the actual `on_shortcut(...)` call is gated here.
            //
            // Resolution order: AppConfig.onenote_hotkey (user override) →
            // DEFAULT_ONENOTE_HOTKEY ("Ctrl+Shift+O"). Parse failure is
            // logged and skipped — the hotkey is unavailable but the menu
            // item still works. Re-registration on user config change is
            // handled inside the `save_config` IPC (see WP-03 amendment
            // below the command body).
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let hotkey_string = preloaded_cfg
                    .as_ref()
                    .map(resolved_onenote_hotkey)
                    .unwrap_or_else(|| DEFAULT_ONENOTE_HOTKEY.to_string());
                let app_handle_for_hotkey = app.handle().clone();
                match app.global_shortcut().on_shortcut(
                    hotkey_string.as_str(),
                    move |_app, _shortcut, event| {
                        // Fire only on key-PRESS (otherwise both Down + Up
                        // trigger the send flow). The plugin emits both
                        // states by default.
                        if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            return;
                        }
                        let handle = app_handle_for_hotkey.clone();
                        tauri::async_runtime::spawn(async move {
                            fire_onenote_send_flow(handle).await;
                        });
                    },
                ) {
                    Ok(()) => log::info!(
                        "WP-ONENOTE-EXPORT-03: registered global hotkey '{}'",
                        hotkey_string
                    ),
                    Err(e) => log::warn!(
                        "WP-ONENOTE-EXPORT-03: failed to register global hotkey '{}': {} \
                         — the widget menu item still works",
                        hotkey_string,
                        e
                    ),
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                // Suppress unused-variable warning on Mac/Linux. The cfg
                // gate above means `preloaded_cfg` is read only on
                // Windows; the binding above this block still needs to
                // exist for AppState population.
                let _ = &preloaded_cfg;
            }

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
                            // Tauri 2 returns `windows 0.61` HWND; our shim
                            // is compiled against `windows 0.59` (Phase B
                            // pin). Two different type identities, same
                            // memory layout — pass the raw pointer through
                            // the API boundary to sidestep the duplicate-
                            // crate-version mismatch.
                            let hwnd_ptr = hwnd.0 as *mut std::ffi::c_void;
                            if let Err(e) = widget_platform_windows::apply_non_activating_widget_style(hwnd_ptr) {
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
            widget_collapse,
            // WP-Threshold-Tidbit-Return Phase B
            get_pending_tidbit,
            clear_pending_tidbit,
            // WP-PLAUD-04a — Plaud Sync Queue
            plaud_discover,
            plaud_get_inbox,
            plaud_decide,
            plaud_ingest,
            // WP-ONENOTE-EXPORT-02 — OneNote COM client
            onenote_enumerate_hierarchy,
            onenote_get_active_page,
            onenote_export_and_ingest_page,
            // WP-ONENOTE-EXPORT-04 — bulk-send-section + browse view
            onenote_send_section,
            onenote_send_active_section,
            onenote_cancel_bulk_send,
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
                    MENU_PLAUD_QUEUE => {
                        // WP-PLAUD-04a — expand into the Plaud Sync Queue view.
                        // The "plaud-queue" target_tab flows through to main.js
                        // as a URL fragment; main.js's bootstrap hash-router
                        // calls enterPlaudQueueView() on match.
                        if let Err(e) = widget_expand(
                            app.state::<AppState>(),
                            window.clone(),
                            Some("plaud-queue".into()),
                        ) {
                            log::warn!("menu plaud_queue failed: {e}");
                        }
                    }
                    MENU_ONENOTE_SEND_CURRENT_PAGE => {
                        // WP-ONENOTE-EXPORT-03 — same dispatch as the global
                        // hotkey (default Ctrl+Shift+O). The helper handles
                        // every error class via structured `IngestionOutcome`
                        // toast, including PlatformUnsupported on Mac/Linux.
                        log::info!("menu onenote_send_current_page fired");
                        fire_onenote_send_flow(app.clone()).await;
                    }
                    MENU_ONENOTE_BROWSE => {
                        // WP-ONENOTE-EXPORT-04 — open the OneNote browse view.
                        // Same widget_expand mechanism used by Plaud Queue and
                        // Settings; URL fragment routes main.js's bootstrap to
                        // enterOneNoteBrowseView() which loads the hierarchy
                        // via the onenote_enumerate_hierarchy IPC.
                        if let Err(e) = widget_expand(
                            app.state::<AppState>(),
                            window.clone(),
                            Some("onenote-browse".into()),
                        ) {
                            log::warn!("menu onenote_browse failed: {e}");
                        }
                    }
                    MENU_ONENOTE_SEND_SECTION => {
                        // WP-ONENOTE-EXPORT-04 — bulk-send every page in the
                        // currently-active OneNote section. Helper resolves
                        // active section via CurrentPageId enrichment, then
                        // dispatches through the canonical
                        // onenote_send_section flow (single-flight + cancel +
                        // progress events). Emits a structured toast on the
                        // resolve-failure paths (no notebook open, COM
                        // unregistered, hierarchy miss).
                        log::info!("menu onenote_send_section fired");
                        fire_onenote_send_active_section_flow(app.clone()).await;
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
        // WP-ONENOTE-EXPORT-01: "pdf" added to support OneNote export-watch.
        for ext in &["txt", "md", "vtt", "srt", "html", "pdf"] {
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
        for ext in &["TXT", "MD", "VTT", "SRT", "HTML", "PDF"] {
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
        // WP-ONENOTE-EXPORT-01: "pdf" removed from rejection list. Other
        // binary formats remain rejected at v1.
        for ext in &["docx", "jpg", "png", "xlsx", "pptx"] {
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

    // ───── WP-ONENOTE-EXPORT-01 — OneNote PDF payload shape ─────

    #[test]
    fn onenote_pdf_payload_has_correct_capture_metadata() {
        let path = PathBuf::from("/tmp/Meeting Notes.pdf");
        let pdf_bytes = b"%PDF-fake-bytes-for-test";
        let text = "extracted page content";
        let payload = build_onenote_pdf_payload(&path, pdf_bytes, text);

        let meta = &payload["sourceMetadata"];
        assert_eq!(meta["captureTool"], "onenote");
        assert_eq!(meta["captureMethod"], "export-import");
        assert_eq!(meta["sourceApp"], "onenote");
        assert!(meta["capturedAt"].is_string());

        assert_eq!(payload["title"], "Meeting Notes");
        assert_eq!(payload["content"], text);
    }

    #[test]
    fn onenote_pdf_payload_document_id_uses_bytes_not_text() {
        // documentId is content-hashed on PDF bytes (not extracted text) so
        // bumping pdf-extract or tweaking the extractor doesn't shift the
        // document identity for the user.
        let path = PathBuf::from("/tmp/page.pdf");
        let bytes_a = b"%PDF-bytes-version-A";
        let bytes_b = b"%PDF-bytes-version-B";
        let same_text = "same extracted text";

        let payload_a = build_onenote_pdf_payload(&path, bytes_a, same_text);
        let payload_b = build_onenote_pdf_payload(&path, bytes_b, same_text);

        assert_ne!(
            payload_a["documentId"], payload_b["documentId"],
            "Different bytes must produce different documentIds even with same extracted text"
        );
    }

    #[test]
    fn onenote_pdf_payload_document_id_is_deterministic() {
        // Same bytes → same documentId across calls (idempotency invariant
        // per brief §2.4 + §6.3).
        let path = PathBuf::from("/tmp/page.pdf");
        let bytes = b"%PDF-deterministic-bytes";
        let p1 = build_onenote_pdf_payload(&path, bytes, "text1");
        let p2 = build_onenote_pdf_payload(&path, bytes, "text2-differs");
        assert_eq!(p1["documentId"], p2["documentId"]);
    }

    #[test]
    fn onenote_pdf_payload_document_id_has_correct_prefix_and_length() {
        let path = PathBuf::from("/tmp/page.pdf");
        let bytes = b"%PDF-bytes";
        let payload = build_onenote_pdf_payload(&path, bytes, "text");
        let id = payload["documentId"].as_str().expect("string id");

        assert!(
            id.starts_with("onenote-pdf-"),
            "expected onenote-pdf- prefix, got: {}",
            id
        );
        assert_eq!(
            id.len(),
            "onenote-pdf-".len() + 16,
            "expected 16 hex chars after prefix"
        );
        let suffix = &id["onenote-pdf-".len()..];
        assert!(
            suffix.chars().all(|c| c.is_ascii_hexdigit()),
            "non-hex chars in id suffix: {}",
            suffix
        );
    }

    #[test]
    fn onenote_pdf_payload_falls_back_to_untitled_for_pathless_input() {
        // Edge case: path with no file stem. Should not panic; should emit
        // "untitled" so the toast renders cleanly.
        let path = PathBuf::from("/");
        let bytes = b"%PDF-tiny";
        let payload = build_onenote_pdf_payload(&path, bytes, "text");
        assert_eq!(payload["title"], "untitled");
    }

    // ───── WP-ONENOTE-EXPORT-02 — OneNote COM payload shape ─────

    fn sample_com_page_metadata() -> onenote_windows::PageMetadata {
        onenote_windows::PageMetadata {
            page_id: "{PG-001}".to_string(),
            title: "Q2 Engineering Sync".to_string(),
            notebook_id: "{NB-001}".to_string(),
            notebook_name: "Work".to_string(),
            section_id: "{SEC-001}".to_string(),
            section_name: "Engineering Notes".to_string(),
            notebook_path: "Work / Engineering Notes".to_string(),
            last_modified_time: Some("2026-05-28T00:00:00.000Z".to_string()),
        }
    }

    #[test]
    fn onenote_com_payload_has_correct_capture_metadata() {
        let meta = sample_com_page_metadata();
        let bytes = b"%PDF-fake-com-bytes";
        let text = "extracted page content";
        let payload = build_onenote_com_payload(&meta, bytes, text);

        let m = &payload["sourceMetadata"];
        assert_eq!(m["captureTool"], "onenote");
        assert_eq!(m["captureMethod"], "com-capture");
        assert_eq!(m["sourceApp"], "onenote");
        assert!(m["capturedAt"].is_string());

        // COM-specific metadata fields (brief §2.4)
        assert_eq!(m["notebookId"], "{NB-001}");
        assert_eq!(m["notebookName"], "Work");
        assert_eq!(m["sectionId"], "{SEC-001}");
        assert_eq!(m["sectionName"], "Engineering Notes");
        assert_eq!(m["pageId"], "{PG-001}");
        assert_eq!(m["notebookPath"], "Work / Engineering Notes");

        assert_eq!(payload["title"], "Q2 Engineering Sync");
        assert_eq!(payload["content"], text);
    }

    #[test]
    fn onenote_com_payload_document_id_uses_page_id_not_byte_hash() {
        // The COM keyspace is `onenote-{pageId}` (deterministic per page),
        // NOT `onenote-pdf-{sha8}` (the export-watch keyspace). Distinct so
        // the same OneNote page captured both ways doesn't accidentally
        // dedup; per coordinator dispatch + WP-01 agent's observation #1.
        let meta = sample_com_page_metadata();
        let payload = build_onenote_com_payload(&meta, b"any-bytes", "any-text");
        assert_eq!(payload["documentId"], "onenote-{PG-001}");
    }

    #[test]
    fn onenote_com_payload_document_id_is_deterministic_across_calls() {
        // Two calls with the same page id produce the same documentId
        // regardless of the (possibly differing) PDF bytes / text — the
        // user re-captures the same OneNote page, Apolla treats it as
        // idempotent.
        let meta = sample_com_page_metadata();
        let p1 = build_onenote_com_payload(&meta, b"bytes-a", "text-a");
        let p2 = build_onenote_com_payload(&meta, b"bytes-b", "text-b-different");
        assert_eq!(p1["documentId"], p2["documentId"]);
    }

    #[test]
    fn onenote_com_payload_document_id_differs_from_pdf_payload_keyspace() {
        // Defensive: the COM-keyspace and PDF-keyspace shouldn't accidentally
        // collide on a deterministic prefix.
        let meta = sample_com_page_metadata();
        let com_payload = build_onenote_com_payload(&meta, b"x", "x");
        let pdf_payload =
            build_onenote_pdf_payload(&PathBuf::from("page.pdf"), b"x", "x");
        let com_id = com_payload["documentId"].as_str().expect("string");
        let pdf_id = pdf_payload["documentId"].as_str().expect("string");
        assert!(com_id.starts_with("onenote-"));
        assert!(pdf_id.starts_with("onenote-pdf-"));
        assert_ne!(com_id, pdf_id);
        // No COM id should ever start with the PDF prefix (catches a
        // future refactor that accidentally merges the keyspaces).
        assert!(!com_id.starts_with("onenote-pdf-"));
    }

    #[test]
    fn onenote_com_payload_notebook_path_is_human_readable() {
        // The notebookPath is what the docs-list tooltip will show
        // (brief §2.4); confirm it's the "Notebook / Section" format
        // rather than a GUID concat or path-separator mishap.
        let meta = sample_com_page_metadata();
        let payload = build_onenote_com_payload(&meta, b"x", "x");
        let path_str = payload["sourceMetadata"]["notebookPath"]
            .as_str()
            .expect("string notebookPath");
        assert!(path_str.contains(" / "));
        assert!(!path_str.contains('{'), "notebookPath should not contain GUIDs");
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
            onenote_hotkey: None,
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

    // ───── WP-ONENOTE-EXPORT-03 — OneNote hotkey persistence ─────
    //
    // 4 tests covering the `onenote_hotkey: Option<String>` field on
    // AppConfig + the `resolved_onenote_hotkey` reader. The reader is the
    // canonical "what hotkey should I register?" source — used both by
    // the plugin-registration site and by Configure-pane pre-fill (when
    // implemented). Tests verify default fallback + custom value pass-
    // through + empty-string-treated-as-unset + round-trip with hotkey set.

    #[test]
    fn resolved_onenote_hotkey_with_none_returns_default() {
        let mut cfg = AppConfig::default();
        cfg.onenote_hotkey = None;
        assert_eq!(resolved_onenote_hotkey(&cfg), DEFAULT_ONENOTE_HOTKEY);
        assert_eq!(resolved_onenote_hotkey(&cfg), "Ctrl+Shift+O");
    }

    #[test]
    fn resolved_onenote_hotkey_with_some_returns_custom_value() {
        let mut cfg = AppConfig::default();
        cfg.onenote_hotkey = Some("Ctrl+Alt+Q".to_string());
        assert_eq!(resolved_onenote_hotkey(&cfg), "Ctrl+Alt+Q");
    }

    #[test]
    fn resolved_onenote_hotkey_with_empty_string_falls_back_to_default() {
        // Empty-string or whitespace-only override is treated as unset —
        // reader returns the default. Belt-and-suspenders for the JS
        // handleSave path, which sends `null` for an empty input but
        // could conceivably send `""` if a future code path forgets.
        let mut cfg = AppConfig::default();
        cfg.onenote_hotkey = Some("".to_string());
        assert_eq!(resolved_onenote_hotkey(&cfg), DEFAULT_ONENOTE_HOTKEY);
        cfg.onenote_hotkey = Some("   ".to_string());
        assert_eq!(resolved_onenote_hotkey(&cfg), DEFAULT_ONENOTE_HOTKEY);
    }

    #[test]
    fn config_round_trips_with_onenote_hotkey_set() {
        // Round-trip an AppConfig with the hotkey explicitly set, to
        // verify serde preserves the value through JSON. Companion to
        // `config_round_trips_through_json` which covers the None case.
        let cfg = AppConfig {
            base_url: "https://hosted.viktora.ai".to_string(),
            bearer_token: "test-token-456".to_string(),
            last_used: None,
            mode: "workspace".to_string(),
            widget_x: None,
            widget_y: None,
            onenote_hotkey: Some("Ctrl+Shift+T".to_string()),
        };
        let json = serde_json::to_string(&cfg).expect("should serialize");
        let parsed: AppConfig = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed.onenote_hotkey, cfg.onenote_hotkey);
        assert_eq!(resolved_onenote_hotkey(&parsed), "Ctrl+Shift+T");
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

    // ───── WP-Threshold-Tidbit-Return Phase B — tidbit parsing ─────
    //
    // Round-trips the 4 status states + tidbit field shape against the
    // Phase A endpoint contract from `tidbit-reshape.ts`. Covers:
    //   - All 4 TidbitStatus variants parse from kebab-case JSON
    //   - 'ready' response with populated tidbit deserializes all fields
    //   - 'no-marker' / 'pending' / 'failed' allow tidbit=null
    //   - Optional capturedFromHint / priorCaptureCount handled
    //   - D-12-17 lenient handling — unknown fields silently ignored
    //
    // Empirical Q4 coverage: whyThisMatters tested at both 280-char and
    // 800-char ends of the live-corpus range.

    #[test]
    fn tidbit_status_parses_all_kebab_case_variants() {
        let cases: &[(&str, TidbitStatus)] = &[
            (r#""ready""#, TidbitStatus::Ready),
            (r#""pending""#, TidbitStatus::Pending),
            (r#""no-marker""#, TidbitStatus::NoMarker),
            (r#""failed""#, TidbitStatus::Failed),
        ];
        for (json, expected) in cases {
            let parsed: TidbitStatus = serde_json::from_str(json)
                .unwrap_or_else(|e| panic!("status {json} should parse: {e}"));
            assert_eq!(&parsed, expected, "status {json} round-trip");
        }
    }

    #[test]
    fn tidbit_status_unknown_value_fails_loud() {
        let result: Result<TidbitStatus, _> = serde_json::from_str(r#""processing""#);
        assert!(
            result.is_err(),
            "unknown status string should fail to parse (don't silently default)"
        );
    }

    #[test]
    fn tidbit_response_pending_with_null_tidbit() {
        let json = r#"{"tidbit": null, "status": "pending"}"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("should parse");
        assert!(parsed.tidbit.is_none());
        assert_eq!(parsed.status, TidbitStatus::Pending);
    }

    #[test]
    fn tidbit_response_no_marker_with_null_tidbit() {
        let json = r#"{"tidbit": null, "status": "no-marker"}"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("should parse");
        assert!(parsed.tidbit.is_none());
        assert_eq!(parsed.status, TidbitStatus::NoMarker);
    }

    #[test]
    fn tidbit_response_failed_with_null_tidbit() {
        let json = r#"{"tidbit": null, "status": "failed"}"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("should parse");
        assert!(parsed.tidbit.is_none());
        assert_eq!(parsed.status, TidbitStatus::Failed);
    }

    #[test]
    fn tidbit_response_ready_full_shape() {
        // Realistic Phase A live response from the dispatch's curl demo —
        // Windows Outlook capture in a mature corpus with 3 highlights
        // (2 overlap, 1 new) and a populated capturedFromHint.
        let json = r#"{
            "tidbit": {
                "title": "You've been tracking pricing-realignment — a new thread connects",
                "whyThisMatters": "This capture connects Q3 launch planning to the pricing-realignment work you've been doing. The thread between these two topics has tightened across recent captures.",
                "highlights": [
                    { "slug": "pricing-realignment", "type": "topic", "isCorpusOverlap": true, "priorCaptureCount": 7 },
                    { "slug": "q3-launch-window", "type": "topic", "isCorpusOverlap": true, "priorCaptureCount": 4 },
                    { "slug": "enterprise-tier-tooling", "type": "topic", "isCorpusOverlap": false }
                ],
                "deepLink": "https://threshold-eval.viktora.ai/document/cap-2026-05-22-abc123",
                "capturedFromHint": "from your Outlook",
                "generatedAt": "2026-05-22T15:30:42.000Z",
                "markerFingerprint": "fp-abc123def4567890"
            },
            "status": "ready"
        }"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("should parse");
        assert_eq!(parsed.status, TidbitStatus::Ready);
        let tidbit = parsed.tidbit.expect("ready response must carry a tidbit");
        assert!(tidbit.title.starts_with("You've been tracking"));
        assert_eq!(tidbit.highlights.len(), 3);
        assert_eq!(tidbit.highlights[0].slug, "pricing-realignment");
        assert!(tidbit.highlights[0].is_corpus_overlap);
        assert_eq!(tidbit.highlights[0].prior_capture_count, Some(7));
        assert!(!tidbit.highlights[2].is_corpus_overlap);
        assert!(tidbit.highlights[2].prior_capture_count.is_none());
        assert_eq!(tidbit.captured_from_hint.as_deref(), Some("from your Outlook"));
        assert_eq!(tidbit.marker_fingerprint, "fp-abc123def4567890");
    }

    #[test]
    fn tidbit_ready_omits_optional_captured_from_hint() {
        // Mac cold-start path per the Phase A handoff §2 — capturedFromHint
        // absent rather than empty-string.
        let json = r#"{
            "tidbit": {
                "title": "revenue-per-rep is new territory in your corpus",
                "whyThisMatters": "Short rationale.",
                "highlights": [
                    { "slug": "revenue-per-rep", "type": "topic", "isCorpusOverlap": false }
                ],
                "deepLink": "https://threshold-eval.viktora.ai/document/cap-2026-05-22-def456",
                "generatedAt": "2026-05-22T15:35:00.000Z",
                "markerFingerprint": "fp-def456789abc0123"
            },
            "status": "ready"
        }"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("should parse");
        let tidbit = parsed.tidbit.unwrap();
        assert!(tidbit.captured_from_hint.is_none());
        assert_eq!(tidbit.highlights.len(), 1);
    }

    #[test]
    fn tidbit_ready_empty_highlights_array() {
        // Edge case: Phase A could theoretically return an empty highlights
        // array if reshape couldn't synthesize any. The widget panel should
        // render gracefully.
        let json = r#"{
            "tidbit": {
                "title": "Headline",
                "whyThisMatters": "Body.",
                "highlights": [],
                "deepLink": "http://localhost:3001/document/x",
                "generatedAt": "2026-05-22T00:00:00.000Z",
                "markerFingerprint": "fp-x"
            },
            "status": "ready"
        }"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("should parse");
        assert_eq!(parsed.tidbit.unwrap().highlights.len(), 0);
    }

    #[test]
    fn tidbit_ready_handles_long_why_this_matters_q4_range() {
        // Q4 empirical range: 100-800 chars. Test at 800-char end to
        // confirm no JSON-string-length limits get triggered.
        let long_prose = "x".repeat(800);
        let json = format!(
            r#"{{
                "tidbit": {{
                    "title": "Headline",
                    "whyThisMatters": "{long_prose}",
                    "highlights": [],
                    "deepLink": "http://localhost:3001/document/x",
                    "generatedAt": "2026-05-22T00:00:00.000Z",
                    "markerFingerprint": "fp-x"
                }},
                "status": "ready"
            }}"#
        );
        let parsed: TidbitPollResponse = serde_json::from_str(&json).expect("800-char body should parse");
        assert_eq!(parsed.tidbit.unwrap().why_this_matters.len(), 800);
    }

    #[test]
    fn tidbit_response_lenient_to_unknown_fields() {
        // D-12-17 lenient handling extends to tidbit responses — a future
        // server release adding fields shouldn't break v0.4.0 clients.
        let json = r#"{
            "tidbit": null,
            "status": "pending",
            "futureField": "ignored",
            "anotherUnknown": 42
        }"#;
        let parsed: TidbitPollResponse = serde_json::from_str(json).expect("lenient parse");
        assert_eq!(parsed.status, TidbitStatus::Pending);
        assert!(parsed.tidbit.is_none());
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

    // ───── WP-OCR-09 Phase D — deep-link Configure pre-fill ─────

    fn parse(s: &str) -> Option<ConfigurePrefill> {
        let url = url::Url::parse(s).expect("test URL parses");
        parse_configure_deep_link(&url)
    }

    #[test]
    fn deep_link_happy_path() {
        let prefill =
            parse("apolla-threshold://configure?tenant=threshold-eval&token=apolla_abc123")
                .expect("happy path parses");
        assert_eq!(prefill.tenant.as_deref(), Some("threshold-eval"));
        assert_eq!(prefill.base_url, "https://threshold-eval.viktora.ai");
        assert_eq!(prefill.token, "apolla_abc123");
    }

    #[test]
    fn deep_link_rejects_wrong_scheme() {
        assert!(parse("apolla-other://configure?tenant=x&token=apolla_abc").is_none());
        assert!(parse("https://configure?tenant=x&token=apolla_abc").is_none());
    }

    #[test]
    fn deep_link_rejects_wrong_host() {
        // host="setup" instead of "configure" — reject
        assert!(parse("apolla-threshold://setup?tenant=x&token=apolla_abc").is_none());
    }

    #[test]
    fn deep_link_rejects_missing_token() {
        assert!(parse("apolla-threshold://configure?tenant=acme").is_none());
        // Empty-string token also rejected (canonical canary)
        assert!(parse("apolla-threshold://configure?tenant=acme&token=").is_none());
    }

    #[test]
    fn deep_link_rejects_missing_tenant() {
        // No tenant slug → can't reconstruct base_url → reject. Brief
        // (WP-OCR-09 D-09-08) requires `?tenant=...`.
        assert!(parse("apolla-threshold://configure?token=apolla_abc").is_none());
        assert!(parse("apolla-threshold://configure?tenant=&token=apolla_abc").is_none());
    }

    #[test]
    fn deep_link_url_encoded_token_decodes() {
        // url::Url performs percent-decoding on query_pairs(), so a token
        // containing % escapes round-trips. Validates we use query_pairs()
        // rather than raw .query().
        let prefill = parse(
            "apolla-threshold://configure?tenant=acme&token=apolla_%2B%2Ftoken%3Dvalue",
        )
        .expect("encoded token parses");
        assert_eq!(prefill.token, "apolla_+/token=value");
    }

    #[test]
    fn deep_link_ignores_extra_query_params() {
        // Brief reserves `?tenant=` and `?token=`; future params should
        // be silently ignored, not reject the URL.
        let prefill =
            parse("apolla-threshold://configure?tenant=acme&token=apolla_abc&future=xyz")
                .expect("extra params tolerated");
        assert_eq!(prefill.tenant.as_deref(), Some("acme"));
        assert_eq!(prefill.token, "apolla_abc");
    }

    #[test]
    fn deep_link_tenant_with_hyphens_preserved() {
        // Multi-hyphen tenant slug (matches the wife-pilot
        // threshold-eval.viktora.ai pattern). Slug is opaque — no slug
        // validation in v1.
        let prefill = parse(
            "apolla-threshold://configure?tenant=acme-corp-staging&token=apolla_xyz",
        )
        .expect("hyphenated tenant parses");
        assert_eq!(prefill.tenant.as_deref(), Some("acme-corp-staging"));
        assert_eq!(prefill.base_url, "https://acme-corp-staging.viktora.ai");
    }

    // ───── WP-PLAUD-04a — Plaud Sync Queue helpers ─────

    #[test]
    fn plaud_urlencoding_minimal_preserves_safe_chars() {
        // Plaud recording IDs are 32-char hex on the happy path. All safe
        // characters must pass through unchanged.
        let hex = "21e4df37eb5bb3d189b95ac7cfff8520";
        assert_eq!(urlencoding_minimal(hex), hex);

        // Tilde, hyphen, underscore, dot are unreserved per RFC 3986.
        assert_eq!(urlencoding_minimal("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn plaud_urlencoding_minimal_encodes_unsafe_chars() {
        // Defense-in-depth: if Plaud ever returns an ID with characters
        // outside the unreserved set, we must not corrupt the URL.
        assert_eq!(urlencoding_minimal("a/b"), "a%2Fb");
        assert_eq!(urlencoding_minimal("a b"), "a%20b");
        assert_eq!(urlencoding_minimal("a?b#c"), "a%3Fb%23c");
    }

    #[test]
    fn plaud_inbox_item_deserializes_minimum_required_fields() {
        // Server may omit optional fields (summaryPreview, speakerCount,
        // etc.) on items that haven't been enriched. Minimum-required shape
        // must round-trip cleanly.
        let json = r#"{
            "id": "abc123",
            "name": "Test recording",
            "createdAt": "2026-05-25T12:00:00Z",
            "startAt": "2026-05-25T11:00:00Z",
            "durationMs": 60000,
            "serialNumber": "PLAUD-001",
            "state": "pending",
            "discoveredAt": "2026-05-25T12:01:00Z"
        }"#;
        let item: PlaudInboxItem = serde_json::from_str(json).expect("minimum item parses");
        assert_eq!(item.id, "abc123");
        assert_eq!(item.state, "pending");
        assert!(item.summary_preview.is_none());
        assert!(item.speaker_count.is_none());
        assert!(item.apolla_document_id.is_none());
    }

    #[test]
    fn plaud_inbox_item_deserializes_full_shape() {
        // Verify optional-field round-trip when all fields are present.
        let json = r#"{
            "id": "abc123",
            "name": "SteerCo Preparation",
            "createdAt": "2026-05-25T12:00:00Z",
            "startAt": "2026-05-25T11:00:00Z",
            "durationMs": 3180000,
            "serialNumber": "PLAUD-1779361230180",
            "summaryPreview": "Discussion of Frontiers strategy.",
            "speakerCount": 7,
            "speakerNamedCount": 3,
            "state": "pending",
            "discoveredAt": "2026-05-25T12:01:00Z"
        }"#;
        let item: PlaudInboxItem = serde_json::from_str(json).expect("full item parses");
        assert_eq!(item.duration_ms, 3_180_000);
        assert_eq!(item.speaker_count, Some(7));
        assert_eq!(item.speaker_named_count, Some(3));
        assert_eq!(item.summary_preview.as_deref(), Some("Discussion of Frontiers strategy."));
    }

    #[test]
    fn plaud_discover_result_deserializes() {
        // Server's DiscoverResult shape per WP-PLAUD-01 §3.4.
        let json = r#"{"newItems": 3, "pagesScanned": 2, "errors": 0, "completed": true}"#;
        let res: PlaudDiscoverResult = serde_json::from_str(json).expect("discover result parses");
        assert_eq!(res.new_items, 3);
        assert_eq!(res.pages_scanned, 2);
        assert!(res.completed);
    }

    #[test]
    fn plaud_ingest_result_deserializes() {
        // Server's ingest result shape per WP-PLAUD-02.
        let json = r#"{"apollaDocumentId": "DOC-abc123", "ingestedAt": "2026-05-25T12:05:00Z"}"#;
        let res: PlaudIngestResult = serde_json::from_str(json).expect("ingest result parses");
        assert_eq!(res.apolla_document_id, "DOC-abc123");
        assert_eq!(res.ingested_at, "2026-05-25T12:05:00Z");
    }

    // ───── WP-ONENOTE-EXPORT-04 — bulk-send helpers ─────

    /// Build a small in-memory `NotebookTree` fixture for the helper +
    /// report tests. Mirrors the shape produced by `parse_hierarchy_xml`
    /// on the multi-notebook fixture but constructed by hand so we don't
    /// share state with onenote_windows::tests.
    fn make_test_tree() -> onenote_windows::NotebookTree {
        onenote_windows::NotebookTree {
            notebooks: vec![
                onenote_windows::Notebook {
                    notebook_id: "{NB-WORK}".into(),
                    name: "Work".into(),
                    last_modified_time: None,
                    sections: vec![
                        onenote_windows::Section {
                            section_id: "{SEC-ENG}".into(),
                            name: "Engineering".into(),
                            last_modified_time: None,
                            pages: vec![
                                onenote_windows::Page {
                                    page_id: "{PG-1}".into(),
                                    name: "Q2 Sync".into(),
                                    last_modified_time: None,
                                },
                                onenote_windows::Page {
                                    page_id: "{PG-2}".into(),
                                    name: "Sprint Planning".into(),
                                    last_modified_time: None,
                                },
                            ],
                        },
                        onenote_windows::Section {
                            section_id: "{SEC-EMPTY}".into(),
                            name: "Empty Section".into(),
                            last_modified_time: None,
                            pages: vec![],
                        },
                    ],
                },
                onenote_windows::Notebook {
                    notebook_id: "{NB-PERSONAL}".into(),
                    name: "Personal".into(),
                    last_modified_time: None,
                    sections: vec![onenote_windows::Section {
                        section_id: "{SEC-RECIPES}".into(),
                        name: "Recipes".into(),
                        last_modified_time: None,
                        pages: vec![onenote_windows::Page {
                            page_id: "{PG-3}".into(),
                            name: "Sourdough".into(),
                            last_modified_time: None,
                        }],
                    }],
                },
            ],
        }
    }

    #[test]
    fn find_section_with_notebook_returns_match() {
        let tree = make_test_tree();
        let (notebook, section) =
            find_section_with_notebook(&tree, "{SEC-ENG}").expect("section exists");
        assert_eq!(notebook.name, "Work");
        assert_eq!(notebook.notebook_id, "{NB-WORK}");
        assert_eq!(section.name, "Engineering");
        assert_eq!(section.pages.len(), 2);
    }

    #[test]
    fn find_section_with_notebook_returns_none_on_missing() {
        let tree = make_test_tree();
        assert!(find_section_with_notebook(&tree, "{NOT-PRESENT}").is_none());
    }

    #[test]
    fn find_section_with_notebook_finds_section_in_second_notebook() {
        // Defensive: make sure the search doesn't bail after the first
        // notebook. Personal/Recipes is the second notebook.
        let tree = make_test_tree();
        let (notebook, section) =
            find_section_with_notebook(&tree, "{SEC-RECIPES}").expect("section in second notebook");
        assert_eq!(notebook.name, "Personal");
        assert_eq!(section.name, "Recipes");
        assert_eq!(section.pages[0].name, "Sourdough");
    }

    #[test]
    fn find_section_with_notebook_finds_empty_section() {
        // Empty sections must still be findable — WP-04 browse view lists
        // them with a 0-page count, so the per-section button can be
        // disabled. The helper itself doesn't filter.
        let tree = make_test_tree();
        let (notebook, section) =
            find_section_with_notebook(&tree, "{SEC-EMPTY}").expect("empty section is findable");
        assert_eq!(notebook.name, "Work");
        assert_eq!(section.pages.len(), 0);
    }

    #[test]
    fn bulk_send_report_serde_round_trips_camel_case() {
        // The browse view's progress-event consumer reads camelCase fields
        // (sectionId / sectionName / pageId / etc.); make sure serde
        // emits them. A drift to snake_case would silently break the
        // frontend.
        let report = BulkSendReport {
            section_id: "{SEC-1}".into(),
            section_name: "Engineering".into(),
            total: 5,
            succeeded: 3,
            failed: 1,
            cancelled: 1,
            errors: vec![("{PG-X}".into(), "publish failed".into())],
        };
        let json = serde_json::to_string(&report).expect("serializes");
        assert!(json.contains("\"sectionId\":\"{SEC-1}\""), "{}", json);
        assert!(json.contains("\"sectionName\":\"Engineering\""), "{}", json);
        assert!(json.contains("\"total\":5"), "{}", json);
        assert!(json.contains("\"succeeded\":3"), "{}", json);
        assert!(json.contains("\"failed\":1"), "{}", json);
        assert!(json.contains("\"cancelled\":1"), "{}", json);
        // Two-tuple serializes as JSON array; frontend reshapes if needed.
        assert!(json.contains("[\"{PG-X}\",\"publish failed\"]"), "{}", json);
    }

    #[test]
    fn bulk_send_progress_serde_round_trips_camel_case() {
        // Progress events drive the per-page UI; camelCase is load-bearing
        // for the frontend consumer. Drift-guard.
        let progress = BulkSendProgress {
            section_id: "{SEC-1}".into(),
            page_id: "{PG-1}".into(),
            page_title: "Q2 Sync".into(),
            status: "succeeded".into(),
            completed: 2,
            total: 5,
        };
        let json = serde_json::to_string(&progress).expect("serializes");
        assert!(json.contains("\"sectionId\":\"{SEC-1}\""), "{}", json);
        assert!(json.contains("\"pageId\":\"{PG-1}\""), "{}", json);
        assert!(json.contains("\"pageTitle\":\"Q2 Sync\""), "{}", json);
        assert!(json.contains("\"completed\":2"), "{}", json);
        assert!(json.contains("\"total\":5"), "{}", json);
        assert!(json.contains("\"status\":\"succeeded\""), "{}", json);
    }

    #[test]
    fn onenote_cancel_bulk_send_sets_flag_idempotently() {
        // Reset to a known state first because the static is process-wide
        // and other tests may have left it set.
        ONENOTE_BULK_SEND_CANCEL.store(false, Ordering::SeqCst);
        assert!(!ONENOTE_BULK_SEND_CANCEL.load(Ordering::SeqCst));

        // First call sets the flag.
        onenote_cancel_bulk_send();
        assert!(ONENOTE_BULK_SEND_CANCEL.load(Ordering::SeqCst));

        // Second call is a no-op (idempotent — flag already true).
        onenote_cancel_bulk_send();
        assert!(ONENOTE_BULK_SEND_CANCEL.load(Ordering::SeqCst));

        // Clean up so subsequent tests start with the flag false.
        ONENOTE_BULK_SEND_CANCEL.store(false, Ordering::SeqCst);
    }

    #[test]
    fn bulk_send_in_flight_mutex_is_initially_free() {
        // The static mutex must start in the unlocked + value=false state.
        // If a prior test left it locked or true, subsequent bulk sends
        // would refuse with Busy. (We can't easily test the contended path
        // without a tokio runtime; the live integration is what catches
        // cross-test interference.)
        let guard = ONENOTE_BULK_SEND_IN_FLIGHT
            .lock()
            .expect("mutex should be available");
        assert!(!*guard, "in-flight flag must be false at test start");
    }
}
