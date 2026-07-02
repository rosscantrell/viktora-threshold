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

// WP-PLAUD-07b — Threshold-mediated Plaud OAuth bootstrap (Settings →
// Connections → Connect Plaud). Rust port of plaud-bootstrap.js — runs the
// PKCE flow on the champion's laptop with a 127.0.0.1:8199 callback listener,
// then POSTs the minted tokens to /api/plaud/connect on the configured
// droplet (WP-PLAUD-07a). Pure helpers are `pub` for the byte-equivalence
// tests in tests/plaud_oauth_tests.rs.
pub mod plaud_oauth;

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

/// WP-AUTO-IMPORT — true while the designated-source auto-import loop is
/// running. The loop self-terminates when this flips to false. Persisted
/// intent lives in `AppConfig.auto_import.enabled`.
static AUTO_IMPORT_ACTIVE: AtomicBool = AtomicBool::new(false);

/// WP-AUTO-IMPORT — process-global set of source-item keys already imported
/// this session (`"onenote:<pageId>"` / `"plaud:<id>"`). Belt-and-suspenders
/// against double-imports between an import succeeding and its watermark /
/// decision persisting. Cleared on restart (the persisted watermark / `since`
/// are the durable dedup; this only covers within-session races).
static AUTO_IMPORT_SESSION_SENT: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

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
    /// WP-THRESHOLD-LOG-UX — most recent decision/commitment records returned
    /// by `poll_for_records` for the just-captured document. Parallel to
    /// `pending_tidbit` (never a modification of it): populated when a capture's
    /// records land, read by the post-capture panel via `get_pending_records`,
    /// cleared by `clear_pending_records`. Single-value, same rationale as the
    /// tidbit slot — the panel shows "what this capture produced," not history.
    pub pending_records: Mutex<Option<DecisionRecordsResponse>>,
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
    /// WP-PLAUD-07b — local cached "Plaud Connected" status, set on every
    /// successful `plaud_connect_start` and cleared by the soft-clear
    /// Disconnect button. UX hint only — the droplet's
    /// `/home/deploy/.plaud/tokens.json` is authoritative. Optional +
    /// skip-serializing-if-none so legacy configs deserialize cleanly
    /// (additive-only schema delta — same pattern as widget_x / widget_y).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaud_connect: Option<plaud_oauth::PlaudConnectStatus>,
    /// WP-AUTO-IMPORT — designated-source background auto-import settings.
    /// Watches user-designated OneNote notebooks + Plaud devices and silently
    /// pulls in anything *new* since the source was designated, on the
    /// user-configured `interval_minutes` cadence. `#[serde(default)]`
    /// (struct-level) means legacy configs
    /// without the field deserialize as `AutoImportConfig::default()`
    /// (everything off / empty) — additive-only schema delta.
    #[serde(default)]
    pub auto_import: AutoImportConfig,
    /// WP-THRESHOLD-DISMISS (first cut) — recordIds the user has dismissed from
    /// the decision/commitment views. Client-only suppression for now: the list
    /// is filtered out of every record projection on render, but the engine is
    /// unaware (no calibration signal yet — that arrives with the server-side
    /// "not relevant vs. close-out" pass). `#[serde(default)]` (struct-level)
    /// means legacy configs without the field deserialize as an empty Vec —
    /// additive-only schema delta, same pattern as `auto_import` / `plaud_connect`.
    #[serde(default)]
    pub dismissed_record_ids: Vec<String>,
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
            plaud_connect: None,
            auto_import: AutoImportConfig::default(),
            dismissed_record_ids: Vec::new(),
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// WP-AUTO-IMPORT — designated-source auto-import config
// ───────────────────────────────────────────────────────────────────────────

/// Top-level auto-import settings persisted inside `AppConfig`. `enabled` is
/// the master switch; individual sources also carry their own `enabled` flag
/// so a user can keep a source designated but temporarily pause it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct AutoImportConfig {
    /// Master on/off. The polling loop runs only when this is true AND at
    /// least one source is enabled.
    pub enabled: bool,
    /// OneNote notebooks to auto-import new/changed pages from (Windows-only
    /// at fire time; the list still persists + renders on Mac so the UI is
    /// uniform).
    pub onenote_notebooks: Vec<AutoImportOneNoteSource>,
    /// Plaud devices (by serial number) to auto-import new recordings from.
    pub plaud_devices: Vec<AutoImportPlaudSource>,
    /// How often the polling loop sweeps designated sources, in minutes.
    /// User-configurable from the Auto-import view. Clamped to
    /// `MIN_AUTO_IMPORT_INTERVAL_MINUTES` at read time. Legacy configs without
    /// the field deserialize to the `Default` (15) via the container-level
    /// `#[serde(default)]`.
    pub interval_minutes: u64,
}

/// Default sweep cadence in minutes. Surfaced as the default selection in the
/// Auto-import view's interval dropdown.
const DEFAULT_AUTO_IMPORT_INTERVAL_MINUTES: u64 = 15;

/// Floor for the user-chosen sweep cadence — guards against a 0 (busy-loop) or
/// missing value. The OneNote enumerate + Plaud inbox fetch are non-trivial, so
/// 1 minute is the tightest we allow.
const MIN_AUTO_IMPORT_INTERVAL_MINUTES: u64 = 1;

impl Default for AutoImportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            onenote_notebooks: Vec::new(),
            plaud_devices: Vec::new(),
            interval_minutes: DEFAULT_AUTO_IMPORT_INTERVAL_MINUTES,
        }
    }
}

/// A single designated OneNote notebook.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoImportOneNoteSource {
    pub notebook_id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// High-water mark: the newest page `lastModifiedTime` (RFC3339) we've
    /// already imported. Pages strictly newer than this are "new". `None`
    /// means "not yet baselined" — the first poll seeds it to the notebook's
    /// current newest page and imports nothing, so designating a notebook
    /// never bulk-imports its back-catalogue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watermark: Option<String>,
    /// When set, scope auto-import to this one section of the notebook rather
    /// than the whole notebook. `None` = whole-notebook (the original
    /// behaviour, so existing configs need no migration). A source's identity
    /// is the (`notebook_id`, `section_id`) pair, so a notebook can have both a
    /// whole-notebook watch and one or more section watches, each with its own
    /// independent `watermark`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    /// Display name of the designated section (for the source-list label).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_name: Option<String>,
}

/// A single designated Plaud device.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoImportPlaudSource {
    pub serial_number: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Designation timestamp (RFC3339). Only inbox items discovered *after*
    /// this import automatically, so designating a device doesn't sweep in
    /// its existing pending backlog. Stamped server-of-record-side in
    /// `set_auto_import_config` when first seen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

fn default_true() -> bool {
    true
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

/// Custom URL scheme this build answers to. DEV builds use a distinct
/// scheme (`apolla-threshold-dev`) so an at-launch deep-link routes to the
/// running `tauri dev` binary instead of the installed release (macOS
/// routes a shared scheme to whichever app is registered — usually the
/// installed one). Compile-time `debug_assertions` is true for `tauri dev`
/// and false in `--release` bundles, so the release binary is unchanged.
/// Paired with the dev-only `tauri.dev.conf.json` override that registers
/// this scheme at the OS level for the dev build (see `npm run tauri:dev`).
#[cfg(debug_assertions)]
pub const DEEP_LINK_SCHEME: &str = "apolla-threshold-dev";
#[cfg(not(debug_assertions))]
pub const DEEP_LINK_SCHEME: &str = "apolla-threshold";

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
    if url.scheme() != DEEP_LINK_SCHEME {
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

// ───────────────────────────────────────────────────────────────────────────
// WP-THRESHOLD-APP-AUTH (email-login) — deep-link auth callback
// ───────────────────────────────────────────────────────────────────────────

/// Payload emitted to the frontend when an `apolla-threshold://auth?token=...`
/// URL is opened (the desktop magic-link carrier). The frontend listens on
/// `threshold://auth-callback` and calls the `auth_verify(token)` IPC, which
/// redeems the single-use magic `token` at `POST /api/auth/desktop/verify` for
/// the user's per-user, revocable bearer and persists it to config.json.
///
/// The base URL is NOT carried here — it was persisted to config.json when the
/// app called `auth_request_link` (moments earlier), so `auth_verify` already
/// knows which server to redeem against. This mirrors how `ConfigurePrefill`
/// reconstructs the base URL, but for auth the app is the one that chose it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthCallback {
    /// Single-use magic token (opaque). Redeemed by `auth_verify`.
    pub token: String,
}

/// Parse an `apolla-threshold://auth?token=...` URL into an `AuthCallback`.
/// Returns `None` for malformed URLs (wrong scheme/host, missing token) so the
/// deep-link handler can log + skip without crashing. Mirrors
/// `parse_configure_deep_link`: accepts `auth` as either host or first path
/// segment to tolerate custom-scheme URL-parser inconsistencies.
pub fn parse_auth_deep_link(url: &url::Url) -> Option<AuthCallback> {
    if url.scheme() != DEEP_LINK_SCHEME {
        return None;
    }
    let host_ok = url.host_str() == Some("auth");
    let path_ok = url.path().trim_start_matches('/').split('/').next() == Some("auth")
        && url.host_str().is_none();
    if !host_ok && !path_ok {
        return None;
    }
    let mut token: Option<String> = None;
    for (k, v) in url.query_pairs() {
        if k.as_ref() == "token" {
            token = Some(v.into_owned());
        }
    }
    let token = token?;
    if token.is_empty() {
        return None;
    }
    Some(AuthCallback { token })
}

/// Per-user config directory. DEV builds use a distinct "Viktora Threshold
/// Dev" directory so `tauri dev` never reads/writes the installed release's
/// `config.json` (and vice-versa). Compile-time `debug_assertions` is true
/// for `tauri dev` and false in `--release` bundles, so the installed
/// release's path is unchanged. This literal is the canonical config-dir
/// name (NOT derived from Tauri's productName), so it must be gated here
/// rather than via the dev `tauri.dev.conf.json` override.
fn config_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let dir_name = "Viktora Threshold Dev";
    #[cfg(not(debug_assertions))]
    let dir_name = "Viktora Threshold";
    dirs::config_dir().map(|p| p.join(dir_name))
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
// WP-THRESHOLD-APP-AUTH (email-login) — per-user magic-link sign-in IPC
// ───────────────────────────────────────────────────────────────────────────
//
// Flow (mirrors the server design):
//   1. First-run screen → `auth_request_link(base_url, email)` persists the
//      base URL and POSTs `{ email, desktop: true }` to
//      `/api/auth/request-link`. The server emails an
//      `apolla-threshold://auth?token=...` deep link.
//   2. User clicks the link → OS launches the app → `on_open_url` parses it +
//      emits `threshold://auth-callback` → frontend calls `auth_verify(token)`.
//   3. `auth_verify` redeems the magic token at `/api/auth/desktop/verify` for
//      the user's per-user, revocable bearer (`apolla_...`) and persists it as
//      `bearer_token` in config.json — replacing the need to paste the shared
//      INGESTION_API_KEY. All subsequent requests use this personal token.

/// Build a reqwest client with the same posture as the ingestion paths:
/// `danger_accept_invalid_certs(true)` for WP-OCR-08 local-HTTPS (mkcert CA).
fn build_auth_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Map a reqwest transport error to a user-facing sign-in message.
fn friendly_auth_net_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The server took too long to respond. Check the workspace URL and your connection.".into()
    } else if e.is_connect() {
        "Couldn't reach that workspace. Double-check the URL.".into()
    } else {
        format!("Network error: {}", e)
    }
}

/// Persist (only) the base URL to config.json + the in-memory cache. Used by
/// `auth_request_link` so that `auth_verify` — which fires later from the
/// deep-link callback, possibly after an app restart — knows which server to
/// redeem the magic token against. Leaves every other field intact (loads the
/// existing config or defaults).
fn persist_base_url(state: &tauri::State<AppState>, base_url: &str) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    let mut cfg = state
        .config
        .lock()
        .expect("config mutex poisoned")
        .clone()
        .unwrap_or_default();
    cfg.base_url = base_url.to_string();
    let json = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    *state.config.lock().expect("config mutex poisoned") = Some(cfg);
    Ok(())
}

/// First-run sign-in step 1: persist the workspace URL and ask the server to
/// email a magic-link deep link. The server always returns `{ ok: true }`
/// (invite-enumeration guard), so a success here means "if that email is
/// invited, a link is on its way" — the UI shows the check-your-inbox state
/// regardless.
#[tauri::command]
async fn auth_request_link(
    state: tauri::State<'_, AppState>,
    base_url: String,
    email: String,
) -> Result<(), String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("Enter your Apolla workspace URL first.".into());
    }
    let email = email.trim().to_string();
    if !email.contains('@') || email.len() < 3 {
        return Err("Enter a valid email address.".into());
    }

    // Persist base URL now (sync, before any await) so the deep-link callback
    // can verify against the right server.
    persist_base_url(&state, &base)?;

    let url = format!("{}/api/auth/request-link", base);
    let client = build_auth_http_client(Duration::from_secs(15))?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "email": email, "desktop": true }))
        .send()
        .await
        .map_err(friendly_auth_net_err)?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        // 400 invalid_email is the only expected non-2xx; surface it plainly.
        if code == 400 {
            return Err("That doesn't look like a valid email address.".into());
        }
        return Err(format!("Server returned {} when requesting a sign-in link: {}", code, body));
    }
    log::info!("[auth] requested magic link for {} via {}", email, base);
    Ok(())
}

/// Response shape from `POST /api/auth/desktop/verify`.
#[derive(Deserialize)]
struct DesktopVerifyResponse {
    token: String,
    #[serde(default)]
    #[allow(dead_code)]
    email: Option<String>,
}

/// First-run sign-in step 2 (fired from the `threshold://auth-callback` event):
/// redeem the single-use magic `token` for this user's per-user bearer and
/// persist it as `bearer_token` in config.json. Returns the updated AppConfig so
/// the frontend can drop straight into the main view. The shared
/// INGESTION_API_KEY is never touched.
#[tauri::command]
async fn auth_verify(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<AppConfig, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Sign-in link was missing its token.".into());
    }
    // base_url was persisted by auth_request_link.
    let base = state
        .config
        .lock()
        .expect("config mutex poisoned")
        .as_ref()
        .map(|c| c.base_url.trim_end_matches('/').to_string())
        .filter(|b| !b.is_empty())
        .ok_or_else(|| {
            "No workspace URL on file. Start sign-in again from the welcome screen.".to_string()
        })?;

    let url = format!("{}/api/auth/desktop/verify", base);
    let client = build_auth_http_client(Duration::from_secs(15))?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "token": token }))
        .send()
        .await
        .map_err(friendly_auth_net_err)?;

    let status = resp.status();
    if !status.is_success() {
        let code = status.as_u16();
        let msg = match code {
            400 => "This sign-in link is invalid, expired, or already used. Request a fresh one.".to_string(),
            403 => "This email isn't on the invite list for this workspace. Ask your workspace champion to invite you.".to_string(),
            _ => {
                let body = resp.text().await.unwrap_or_default();
                format!("Sign-in failed (HTTP {}): {}", code, body)
            }
        };
        return Err(msg);
    }

    let parsed: DesktopVerifyResponse = resp
        .json()
        .await
        .map_err(|e| format!("Couldn't read the server's sign-in response: {}", e))?;
    if parsed.token.trim().is_empty() {
        return Err("The server returned an empty token.".into());
    }

    // Persist the per-user token as the bearer. Load existing config to keep
    // hotkey / widget-position fields intact.
    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    let mut cfg = state
        .config
        .lock()
        .expect("config mutex poisoned")
        .clone()
        .unwrap_or_default();
    cfg.base_url = base;
    cfg.bearer_token = parsed.token;
    cfg.last_used = Some(Utc::now().to_rfc3339());
    let json = serde_json::to_string_pretty(&cfg)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    *state.config.lock().expect("config mutex poisoned") = Some(cfg.clone());
    log::info!(
        "[auth] desktop sign-in complete for {} (per-user token persisted)",
        parsed.email.as_deref().unwrap_or("(unknown)")
    );
    Ok(cfg)
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
// Sovereignty posture — where does the user's data go?
// ───────────────────────────────────────────────────────────────────────────

/// Fetches the engine's GET /api/sovereignty and passes the JSON straight
/// through to the frontend (the Privacy panel renders it). Returned as an
/// opaque serde_json::Value so the engine's posture shape can evolve without a
/// Rust change. Bearer is sent if present (the endpoint is read-only/no-auth on
/// the engine today, but a deployment may sit behind the AUTH_ENABLED gate).
#[tauri::command]
async fn get_sovereignty(
    base_url: String,
    bearer_token: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/sovereignty", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
    let mut req = client.get(&url);
    if let Some(token) = bearer_token {
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {}", url, e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Server returned status {} from {}", status.as_u16(), url));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Bad JSON from {}: {}", url, e))
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

// ───────────────────────────────────────────────────────────────────────────
// WP-THRESHOLD-LOG-UX — decision/commitment records polling (parallel path)
// ───────────────────────────────────────────────────────────────────────────
//
// Mirrors the tidbit polling path (poll_for_tidbit above) but for the
// marker-INDEPENDENT decision/commitment log: polls
// /api/documents/:id/decision-records, which returns the records extracted from
// a capture once enrichment completes (records fire on ~every capture, unlike
// tidbits which need a marker). This is a SEPARATE path — `poll_for_tidbit` and
// the `TidbitStatus` contract are never touched. Both polls run concurrently
// after a successful ingest; whichever produces content lights the post-capture
// badge, and the panel renders both when both exist.

/// Mirror of the GET /api/documents/:id/decision-records envelope. Records and
/// edges are kept as raw JSON values: the Rust layer only needs to know whether
/// records exist (to decide whether to surface the panel) and the `enabled`
/// flag (to stop polling when the log is off server-side); the frontend reads
/// the record/edge fields it renders. Keeping them opaque means a server-side
/// field addition never forces a client struct change.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecordsResponse {
    pub document_id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub editor_enabled: bool,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub records: Vec<serde_json::Value>,
    #[serde(default)]
    pub edges: Vec<serde_json::Value>,
}

const RECORDS_POLL_INTERVAL: Duration = Duration::from_secs(2);
const RECORDS_POLL_MAX_WAIT: Duration = Duration::from_secs(60);

/// Spawn `poll_for_records` as a detached task when an ingestion succeeded.
/// Same gating as `dispatch_tidbit_poll_if_success` (success-only; idempotent
/// captures and failures skip) and called from the SAME dispatch points, so the
/// records poll runs alongside the tidbit poll on every capture.
fn dispatch_records_poll_if_success(
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
        poll_for_records(handle_clone, cfg_clone, document_id).await;
    });
}

/// Poll `/api/documents/:id/decision-records` until records appear (up to 60s).
///
/// Termination:
///   - records non-empty  → cache + emit `threshold://records-arrived` → done.
///   - `enabled == false` → the decision log is off server-side; nothing will
///     ever appear, so stop silently (no badge, no spam — mirrors the tidbit
///     `no-marker` silent omission, so behavior on today's flag-off production
///     is identical to the current no-op).
///   - `enabled == true` but still empty → enrichment in flight; keep polling.
///   - HTTP/parse errors, timeout → silent omission.
///
/// Network blips inside the window log + continue (one transient miss shouldn't
/// kill the panel), exactly like the tidbit loop.
async fn poll_for_records(app_handle: tauri::AppHandle, cfg: AppConfig, document_id: String) {
    let url = format!(
        "{}/api/documents/{}/decision-records",
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
            log::warn!("[records-poll] HTTP client init failed: {e}");
            return;
        }
    };

    let start = std::time::Instant::now();
    log::info!("[records-poll] starting for doc {document_id}");

    loop {
        if start.elapsed() >= RECORDS_POLL_MAX_WAIT {
            log::info!(
                "[records-poll] 60s timeout reached for doc {document_id}; silent omission"
            );
            return;
        }

        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", cfg.bearer_token))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<DecisionRecordsResponse>().await {
                    Ok(parsed) => {
                        if !parsed.records.is_empty() {
                            handle_records_ready(&app_handle, parsed).await;
                            return;
                        }
                        if !parsed.enabled {
                            log::info!(
                                "[records-poll] decision log disabled server-side for doc \
                                 {document_id}; silent omission"
                            );
                            return;
                        }
                        // enabled, still empty → enrichment in progress; keep polling.
                    }
                    Err(e) => {
                        log::warn!(
                            "[records-poll] response parse failed for doc {document_id}: {e}; \
                             silent omission"
                        );
                        return;
                    }
                }
            }
            Ok(resp) => {
                log::warn!(
                    "[records-poll] HTTP {} from {} for doc {document_id}; silent omission",
                    resp.status().as_u16(),
                    url
                );
                return;
            }
            Err(e) => {
                log::debug!(
                    "[records-poll] transient request error for doc {document_id}: {e}; \
                     will retry on next interval"
                );
                // Don't return; retry on the next interval.
            }
        }

        tokio::time::sleep(RECORDS_POLL_INTERVAL).await;
    }
}

/// Cache the records in AppState (so the panel's `get_pending_records` IPC can
/// read them after `widget_expand("tidbit")` reloads the webview) and emit the
/// `threshold://records-arrived` event the widget listens for to light the
/// post-capture badge.
async fn handle_records_ready(app_handle: &tauri::AppHandle, records: DecisionRecordsResponse) {
    log::info!(
        "[records] received — doc={}, records={}, edges={}",
        records.document_id,
        records.records.len(),
        records.edges.len()
    );

    let state = app_handle.state::<AppState>();
    *state
        .pending_records
        .lock()
        .expect("pending_records mutex poisoned") = Some(records.clone());

    if let Err(e) = app_handle.emit("threshold://records-arrived", records) {
        log::warn!("[records] failed to emit records-arrived event: {e}");
    }
}

/// Frontend reads this on `index.html#tidbit` mount to populate the records
/// section of the post-capture panel. Returns None when no records are pending.
#[tauri::command]
fn get_pending_records(state: tauri::State<AppState>) -> Option<DecisionRecordsResponse> {
    state
        .pending_records
        .lock()
        .expect("pending_records mutex poisoned")
        .clone()
}

/// Frontend invokes this when the user collapses the post-capture panel so a
/// stale records set doesn't re-populate on the next unrelated expand. Parallels
/// `clear_pending_tidbit`.
#[tauri::command]
fn clear_pending_records(state: tauri::State<AppState>) {
    *state
        .pending_records
        .lock()
        .expect("pending_records mutex poisoned") = None;
}

/// WP-THRESHOLD-LOG-UX — the ambient widget badge count. Proxies
/// GET /api/decision-log and returns just `summary.overdueSilent` (open items
/// that are overdue AND silent — what needs attention). Best-effort: any error
/// (not configured, unreachable, parse) returns 0 so the badge simply stays
/// hidden rather than surfacing an error on the always-on widget.
#[tauri::command]
async fn get_decision_log_summary(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let cfg = match current_config(&state) {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };
    let url = format!("{}/api/decision-log", cfg.base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };
    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(0),
    };
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(0),
    };
    let count = body
        .get("summary")
        .and_then(|s| s.get("overdueSilent"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    Ok(count)
}

/// WP-THRESHOLD-LOG-UX — full decision-log payload for the Today view
/// (`view-log`). Proxies GET /api/decision-log and returns the raw JSON
/// (summary, needsAttention, relationships, states) for the frontend to render.
/// Unlike the badge command this surfaces errors so the view can show an
/// unreachable state instead of a silent blank.
#[tauri::command]
async fn fetch_decision_log(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!("{}/api/decision-log", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_decision_log: parse response failed: {e}"))
}

// ── WP-Outlook-Writeback — staged-outbox IPCs ──
//
// The desktop SURFACES the staged outbox (drafts Threshold composed) for
// review + management. The actual SEND happens in Outlook via the add-in (the
// desktop has no Graph send path), so these three are list / status / propose
// only. `outbox_propose` feeds the producer from a decision-log commitment so a
// "Draft follow-up" on a commitment stages an outbound draft.

/// GET /api/outbox → { items: [...] }. Mirrors fetch_decision_log.
#[tauri::command]
async fn fetch_outbox(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!("{}/api/outbox", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_outbox: parse response failed: {e}"))
}

/// POST /api/outbox/:id/{sent|dismiss}. itemId is a server UUID (URL-safe).
#[tauri::command]
async fn outbox_decide(
    state: tauri::State<'_, AppState>,
    item_id: String,
    action: String,
) -> Result<serde_json::Value, String> {
    if action != "sent" && action != "dismiss" {
        return Err(format!(
            "outbox_decide: action must be 'sent' or 'dismiss', got '{action}'"
        ));
    }
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/outbox/{}/{}",
        cfg.base_url.trim_end_matches('/'),
        item_id,
        action
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("outbox_decide: parse response failed: {e}"))
}

/// POST /api/outbox/propose with { items }. `items` is the producer input
/// array (ProducerActionItem[]) built frontend-side from a decision-log record.
#[tauri::command]
async fn outbox_propose(
    state: tauri::State<'_, AppState>,
    items: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!("{}/api/outbox/propose", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::json!({ "items": items }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("outbox_propose: parse response failed: {e}"))
}

/// WP-VIGILANCE-VOID — the "Watching for…" surface. GET /api/vigilance/voids
/// returns the OPEN voids (records we're expecting back: who/what/when), already
/// rendered server-side. Same auth + posture as fetch_decision_log. The engine
/// returns an empty list (not an error) when the feature is off, so the view
/// degrades to an empty state rather than an error.
///
/// WP-Job-Vigilance-Wave2 — optional `grouped` param appends `?grouped=1`, which
/// (when JOB_VIGILANCE_ENABLED) augments the response with a `grouped` object
/// (stalledJobs + receipts + jobCount/rawVoidCount). The flat `voids`/`arrived`
/// arrays are unchanged, so existing callers can omit `grouped` (defaults false)
/// for byte-identical behavior. The query string is not part of the
/// THRESHOLD_APP_PATTERN gate regex, so `?grouped=1` is already allowed.
#[tauri::command]
async fn fetch_vigilance_voids(
    state: tauri::State<'_, AppState>,
    grouped: Option<bool>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = if grouped.unwrap_or(false) {
        format!(
            "{}/api/vigilance/voids?grouped=1",
            cfg.base_url.trim_end_matches('/')
        )
    } else {
        format!("{}/api/vigilance/voids", cfg.base_url.trim_end_matches('/'))
    };
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_vigilance_voids: parse response failed: {e}"))
}

/// WP-VIGILANCE-VOID HITL — POST a dismiss/snooze/undo action for one void.
/// Shared helper for the three thin commands below. Same auth + posture as the
/// other vigilance calls; appends a per-(void, viewer) disposition server-side.
async fn post_void_action(
    state: &tauri::State<'_, AppState>,
    void_id: &str,
    action: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if void_id.trim().is_empty() {
        return Err("post_void_action: empty void_id".into());
    }
    let cfg = current_config(state)?;
    let encoded: String = url::form_urlencoded::byte_serialize(void_id.as_bytes()).collect();
    let url = format!(
        "{}/api/vigilance/voids/{}/{}",
        cfg.base_url.trim_end_matches('/'),
        encoded,
        action
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("post_void_action: parse response failed: {e}"))
}

#[tauri::command]
async fn dismiss_void(
    state: tauri::State<'_, AppState>,
    void_id: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    post_void_action(&state, &void_id, "dismiss", serde_json::json!({ "reason": reason })).await
}

#[tauri::command]
async fn snooze_void(
    state: tauri::State<'_, AppState>,
    void_id: String,
    days: f64,
) -> Result<serde_json::Value, String> {
    post_void_action(&state, &void_id, "snooze", serde_json::json!({ "days": days })).await
}

#[tauri::command]
async fn undo_void(
    state: tauri::State<'_, AppState>,
    void_id: String,
) -> Result<serde_json::Value, String> {
    post_void_action(&state, &void_id, "undo", serde_json::json!({})).await
}

/// WP-THRESHOLD-LOG-UX (Connections / back-half) — the FULL decision-log
/// payload. Identical to `fetch_decision_log` but appends `?full=1`, which the
/// engine answers with the complete `records` (record + lifecycle + state) AND
/// all active `edges` (full RecordRelationship objects), in addition to the
/// summary/relationships fields the Today view uses. Powers the grounded
/// cross-record edges view, where each edge is rendered with BOTH of its
/// records inline — a pure client-side display join (edge.recordA/recordB →
/// records by recordId). The Today view keeps using the lighter
/// `fetch_decision_log`; this command is purely additive and leaves that path
/// byte-unchanged.
#[tauri::command]
async fn fetch_decision_log_full(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!("{}/api/decision-log?full=1", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_decision_log_full: parse response failed: {e}"))
}

/// WP-THRESHOLD-LOG-UX (Connections / HITL) — confirm or dismiss a proposed
/// cross-record edge. Proxies PATCH /api/decision-log/edges/:edgeId with a
/// `{ "status": "confirmed" | "dismissed" | "proposed" }` body and the existing
/// bearer-auth pattern. This closes the calibration loop: a dismissed edge drops
/// from every read projection, and a confirmed edge re-tightens the definition
/// cards. Returns the updated edge JSON so the view can reflect the new state
/// without a full re-fetch. `edge_id` is URL-encoded for parity with
/// fetch_receipts (edgeIds are hex today, but reserved chars stay intact).
#[tauri::command]
async fn patch_edge_status(
    state: tauri::State<'_, AppState>,
    edge_id: String,
    status: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(edge_id.as_bytes()).collect();
    let url = format!(
        "{}/api/decision-log/edges/{}",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::json!({ "status": status }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("patch_edge_status: parse response failed: {e}"))
}

/// WP-THRESHOLD-RECORD-HITL — set a record's disposition server-side, closing the
/// calibration loop on the (formerly client-only) dismiss gesture. Proxies
/// PATCH /api/decision-log/records/:id with a
/// `{ state, reason?, comment?, snoozeUntil? }` body and the existing bearer-auth
/// pattern. Mirrors `patch_edge_status` (client builder, bearer header, URL-encode,
/// `plaud_status_error` non-2xx handling).
///
/// `state` ∈ active | dismissed | snoozed | resolved. The server REQUIRES `reason`
/// to be one of `not-relevant | not-salient | already-known | closing-out` when
/// `state == "dismissed"` — the frontend's reason menu only offers those four, but
/// we surface the server's 400 verbatim if an out-of-set reason ever reaches here.
/// Optional fields are omitted from the JSON body when `None` (so the server's
/// own defaults / "field absent" semantics apply) rather than sent as `null`.
/// Returns the updated record JSON so the caller can reflect the new state.
#[tauri::command]
async fn set_record_disposition(
    state: tauri::State<'_, AppState>,
    record_id: String,
    // `state` is the disposition (active|dismissed|snoozed|resolved); named
    // `disposition` here to avoid shadowing the `tauri::State` param above.
    disposition: String,
    reason: Option<String>,
    comment: Option<String>,
    snooze_until: Option<String>,
) -> Result<serde_json::Value, String> {
    if record_id.trim().is_empty() {
        return Err("set_record_disposition: empty record_id".into());
    }
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(record_id.as_bytes()).collect();
    let url = format!(
        "{}/api/decision-log/records/{}",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );

    // Build the body with only the fields that are present — omit `None`s rather
    // than sending `null`, matching the server's optional-field contract.
    let mut body = serde_json::Map::new();
    body.insert("state".into(), serde_json::Value::String(disposition));
    if let Some(r) = reason {
        body.insert("reason".into(), serde_json::Value::String(r));
    }
    if let Some(c) = comment {
        body.insert("comment".into(), serde_json::Value::String(c));
    }
    if let Some(s) = snooze_until {
        body.insert("snoozeUntil".into(), serde_json::Value::String(s));
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("set_record_disposition: parse response failed: {e}"))
}

/// POST /api/decision-log/records/:id/edit — the typed draft-edit capture
/// (TYPED-DIFF-CAPTURE Phase 1). DISTINCT from a disposition: an edit CORRECTS a
/// field (owner / focus / summary), it never hides the record. The two keystone
/// edits are owner-correction and focus-override; a prose summary edit with
/// `classify_prose = true` is auto-classified substance-vs-voice server-side.
///
/// Mirrors `set_record_disposition` (client builder, bearer header, URL-encode,
/// non-2xx → plaud_status_error). `edits` is the typed-diff array passed straight
/// through. Flag-gated server-side (SOP_EDITS_ENABLED) — a 404 means editing is
/// off; the frontend only shows the controls when the person digest advertises
/// `editsEnabled`. Returns the server JSON `{ok, eventId, editType?, classification?}`.
#[tauri::command]
async fn edit_record(
    state: tauri::State<'_, AppState>,
    record_id: String,
    edit_type: String,
    edits: Option<serde_json::Value>,
    action: Option<String>,
    scope: Option<String>,
    subject: Option<String>,
    classify_prose: Option<bool>,
) -> Result<serde_json::Value, String> {
    if record_id.trim().is_empty() {
        return Err("edit_record: empty record_id".into());
    }
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(record_id.as_bytes()).collect();
    let url = format!(
        "{}/api/decision-log/records/{}/edit",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );

    let mut body = serde_json::Map::new();
    body.insert("editType".into(), serde_json::Value::String(edit_type));
    if let Some(e) = edits {
        body.insert("edits".into(), e);
    }
    if let Some(a) = action {
        body.insert("action".into(), serde_json::Value::String(a));
    }
    if let Some(s) = scope {
        body.insert("scope".into(), serde_json::Value::String(s));
    }
    if let Some(s) = subject {
        body.insert("subject".into(), serde_json::Value::String(s));
    }
    if let Some(c) = classify_prose {
        body.insert("classifyProse".into(), serde_json::Value::Bool(c));
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("edit_record: parse response failed: {e}"))
}

/// POST /api/synthesis/state-of-play/edit — the inline DIGEST edit decomposition
/// (TYPED-DIFF-CAPTURE Phase B). Sends the before/after of an edited State-of-Play
/// digest; the server decomposes it (reword/omission/addition/inform-set/priority)
/// and returns PROPOSALS (never auto-applied). Mirrors edit_record's client/auth
/// posture. Returns `{ok, eventId, decomposition}`.
#[tauri::command]
async fn edit_digest(
    state: tauri::State<'_, AppState>,
    scope: String,
    subject: String,
    system_digest: String,
    human_digest: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/synthesis/state-of-play/edit",
        cfg.base_url.trim_end_matches('/')
    );
    let mut body = serde_json::Map::new();
    body.insert("scope".into(), serde_json::Value::String(scope));
    body.insert("subject".into(), serde_json::Value::String(subject));
    body.insert("systemDigest".into(), serde_json::Value::String(system_digest));
    body.insert("humanDigest".into(), serde_json::Value::String(human_digest));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("edit_digest: parse response failed: {e}"))
}

/// POST /api/decision-log/records/create-from-proposal — create a record from a
/// candidate the human APPROVED out of a digest-edit decomposition (Phase B). The
/// ONLY corpus write; fires on explicit approval only. `candidate` is the JSON
/// object from the decomposition's proposals.candidateRecords[]. Returns
/// `{ok, created, recordId, record}`.
#[tauri::command]
async fn create_record_from_proposal(
    state: tauri::State<'_, AppState>,
    candidate: serde_json::Value,
    source_text: Option<String>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/records/create-from-proposal",
        cfg.base_url.trim_end_matches('/')
    );
    let mut body = serde_json::Map::new();
    body.insert("candidate".into(), candidate);
    if let Some(s) = source_text {
        body.insert("sourceText".into(), serde_json::Value::String(s));
    }
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("create_record_from_proposal: parse response failed: {e}"))
}

// ───────────────────────────────────────────────────────────────────────────
// WP-THRESHOLD-DISMISS (first cut) — client-only record suppression
// ───────────────────────────────────────────────────────────────────────────

/// Read-modify-write the cached AppConfig and persist it to disk under the lock.
/// Used by the dismiss/undismiss commands so a single mutation is atomic against
/// the in-memory cache + the on-disk file. Errors if Threshold isn't configured
/// yet (no cached config to mutate).
fn mutate_config<F: FnOnce(&mut AppConfig)>(
    state: &tauri::State<AppState>,
    f: F,
) -> Result<(), String> {
    let mut guard = state.config.lock().expect("config mutex poisoned");
    let cfg = guard.as_mut().ok_or_else(|| {
        "Threshold is not configured. Visit Configure and enter your Apolla base URL + bearer token first.".to_string()
    })?;
    f(cfg);
    save_config_to_disk(cfg)
}

/// WP-THRESHOLD-DISMISS — the recordIds the user has dismissed. Returns an empty
/// list (not an error) when unconfigured, so the frontend can call it freely on
/// every view load without special-casing the first-run state.
#[tauri::command]
fn get_dismissed_record_ids(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    Ok(state
        .config
        .lock()
        .expect("config mutex poisoned")
        .as_ref()
        .map(|c| c.dismissed_record_ids.clone())
        .unwrap_or_default())
}

/// WP-THRESHOLD-DISMISS — suppress one record from the views. Idempotent: a
/// repeat dismiss of the same id is a no-op write. Persists to config.json so the
/// suppression survives restarts. Client-only for now — no engine round-trip.
#[tauri::command]
fn dismiss_record(state: tauri::State<AppState>, record_id: String) -> Result<(), String> {
    if record_id.trim().is_empty() {
        return Err("dismiss_record: empty record_id".into());
    }
    mutate_config(&state, |cfg| {
        if !cfg.dismissed_record_ids.iter().any(|id| id == &record_id) {
            cfg.dismissed_record_ids.push(record_id);
        }
    })
}

/// WP-THRESHOLD-DISMISS — undo a dismissal (the Undo affordance on the toast).
/// Idempotent: removing an id that isn't present is a no-op write.
#[tauri::command]
fn undismiss_record(state: tauri::State<AppState>, record_id: String) -> Result<(), String> {
    if record_id.trim().is_empty() {
        return Err("undismiss_record: empty record_id".into());
    }
    mutate_config(&state, |cfg| {
        cfg.dismissed_record_ids.retain(|id| id != &record_id);
    })
}

/// WP-THRESHOLD-LOG-UX (Definition cards / back-half) — the per-entity
/// definition card. Proxies GET /api/entity/:slug/card and returns the card JSON
/// (`{ entity, prose, license, ok, violations, cached, layers }`). The endpoint
/// is flag-gated server-side (ENABLE_ENTITY_CARDS) and needs an API key, so the
/// two "not ready" cases come back as SOFT results rather than hard errors — the
/// view can then show a calm empty state instead of an alarming connection error:
///   - 404 (flag off OR unknown entity) → `{ available: false, reason: "not_found" }`
///   - 503 (no ANTHROPIC_API_KEY)        → `{ available: false, reason: "unavailable" }`
/// Any other non-2xx is surfaced as an error. Timeout is generous (30s) because a
/// cache miss generates the prose with one model call.
#[tauri::command]
async fn fetch_entity_card(
    state: tauri::State<'_, AppState>,
    entity: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(entity.as_bytes()).collect();
    let url = format!(
        "{}/api/entity/{}/card",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 {
        return Ok(serde_json::json!({ "available": false, "reason": "not_found" }));
    }
    if http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false, "reason": "unavailable" }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_entity_card: parse response failed: {e}"))
}

/// WP-THRESHOLD-STATE-OF-PLAY — one person's send-ready execution digest.
/// Proxies GET /api/person/:slug/state-of-play (flag-gated ENABLE_SYNTHESIS on
/// the engine). `polish=false` requests the instant deterministic template
/// (?format=text); `polish=true` (default in the UI) lets the engine LLM-reword
/// the same items. Mirrors fetch_entity_card's bearer-auth + URL-encode pattern;
/// 404 (no open items) / 503 (synthesis off or no API key) degrade to
/// `{ available:false }` so the panel shows a calm empty state.
#[tauri::command]
async fn fetch_person_state_of_play(
    state: tauri::State<'_, AppState>,
    slug: String,
    polish: bool,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(slug.as_bytes()).collect();
    let url = format!(
        "{}/api/person/{}/state-of-play{}",
        cfg.base_url.trim_end_matches('/'),
        encoded,
        if polish { "" } else { "?format=text" }
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 {
        return Ok(serde_json::json!({ "available": false, "reason": "no_open_items" }));
    }
    if http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false, "reason": "unavailable" }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_person_state_of_play: parse response failed: {e}"))
}

/// WP-THRESHOLD-STATE-OF-PLAY — the whole team's digests in one call, for the
/// "Copy all" batch export. Proxies GET /api/synthesis/state-of-play
/// (deterministic by default — no per-person LLM fan-out). 404 (flag off) →
/// `{ available:false }`.
#[tauri::command]
async fn fetch_team_state_of_play(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/synthesis/state-of-play",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 {
        return Ok(serde_json::json!({ "available": false, "reason": "unavailable" }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_team_state_of_play: parse response failed: {e}"))
}

/// WP-THRESHOLD-STATE-OF-PLAY — corpus altitude: the Monday overview across all
/// projects. Proxies GET /api/corpus/state-of-play (`?format=text` for the
/// instant deterministic overview; default LLM-polished). 404 → {available:false}.
#[tauri::command]
async fn fetch_corpus_state_of_play(
    state: tauri::State<'_, AppState>,
    polish: bool,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/corpus/state-of-play{}",
        cfg.base_url.trim_end_matches('/'),
        if polish { "" } else { "?format=text" }
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 {
        return Ok(serde_json::json!({ "available": false, "reason": "unavailable" }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_corpus_state_of_play: parse response failed: {e}"))
}

/// WP-Cohesion-Operators — INFORM edges ("worth looping in"): decisions whose
/// substance touches someone's work who wasn't in the room. Proxies GET
/// /api/decision-log/inform. 503 (flag off) or 404 → {available:false} so the
/// rail stays silent on servers without the operator enabled.
#[tauri::command]
async fn fetch_inform_edges(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/inform",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 || http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_inform_edges: parse response failed: {e}"))
}

// ── WP-Threshold-Grouping-Canonicalization — project-grouping canon client ──
// Combine / Split / Rename of project groupings as SHARED identity resolution
// (propose → deterministic dispose). Proxies the schema-browser
// /api/project-canon/* endpoints. Mirrors fetch_inform_edges: base_url + bearer
// from current_config; 404/503 → {available:false}.

/// GET /api/project-canon → `{ canonicals, toCanonical, substrateFingerprint }`.
/// The client echoes `substrateFingerprint` on every mutation (stale-guard).
#[tauri::command]
async fn fetch_project_canon(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!("{}/api/project-canon", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 || http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_project_canon: parse response failed: {e}"))
}

/// Shared POST helper for the three mutations. Returns the parsed 2xx JSON body
/// (carrying `disposition: applied|contested|override-applied` + optional
/// `vetoSignal`). Non-2xx → Err via plaud_status_error so the caller can refresh.
async fn project_canon_post(
    cfg: &AppConfig,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/api/project-canon/{}",
        cfg.base_url.trim_end_matches('/'),
        path
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("project_canon_post({path}): parse response failed: {e}"))
}

/// POST /api/project-canon/merge. `override_veto=false` first; if the response
/// `disposition` is `contested`, the UI re-invokes with `override_veto=true`.
#[tauri::command]
async fn project_canon_merge(
    state: tauri::State<'_, AppState>,
    sources: Vec<String>,
    target_canonical: String,
    expected_substrate_fingerprint: String,
    actor: String,
    override_veto: bool,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    project_canon_post(
        &cfg,
        "merge",
        serde_json::json!({
            "sources": sources,
            "targetCanonical": target_canonical,
            "expectedSubstrateFingerprint": expected_substrate_fingerprint,
            "actor": actor,
            "overrideVeto": override_veto,
        }),
    )
    .await
}

/// POST /api/project-canon/rename — relabel a canonical (no veto; display only).
#[tauri::command]
async fn project_canon_rename(
    state: tauri::State<'_, AppState>,
    canonical_id: String,
    new_label: String,
    expected_substrate_fingerprint: String,
    actor: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    project_canon_post(
        &cfg,
        "rename",
        serde_json::json!({
            "canonicalId": canonical_id,
            "newLabel": new_label,
            "expectedSubstrateFingerprint": expected_substrate_fingerprint,
            "actor": actor,
        }),
    )
    .await
}

/// POST /api/project-canon/unmerge — Split-back: reverse a prior Combine.
#[tauri::command]
async fn project_canon_unmerge(
    state: tauri::State<'_, AppState>,
    canonical_id: String,
    restore: Vec<String>,
    expected_substrate_fingerprint: String,
    actor: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    project_canon_post(
        &cfg,
        "unmerge",
        serde_json::json!({
            "canonicalId": canonical_id,
            "restore": restore,
            "expectedSubstrateFingerprint": expected_substrate_fingerprint,
            "actor": actor,
        }),
    )
    .await
}

/// WP-Priority-Operator — the viewer's ranked "Focus" surface (importance ×
/// urgency). Proxies GET /api/decision-log/priority. 503 (flag off) or 404 →
/// {available:false} so the rail stays silent on servers without the operator
/// enabled. The server scopes to the viewer via the per-user bearer.
#[tauri::command]
async fn fetch_priority(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/priority",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 || http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_priority: parse response failed: {e}"))
}

/// WP-WorkForest-Native-SoP — Work-Forest-native State of Play at any altitude.
/// Proxies GET /api/state-of-play?level=job|frame|forest&id=<key>&lens=person:<p>|facet:<f>.
/// `level` is required; `id` is required for job/frame (omit for forest); `lens`
/// is optional (`person:<slug>` or `facet:<slug>`). Mirrors the fetch_priority
/// shape — bearer auth, base_url, 30s timeout — and the fetch_entity_card
/// URL-encoding of caller-supplied path/query values. 404 (flag off / no such
/// altitude) or 503 (synthesis unavailable) → {available:false} so every
/// consuming component degrades to hidden, like the existing rails.
/// Response contract: { level, id, prose, license, sections, maturity? }.
#[tauri::command]
async fn fetch_sop(
    state: tauri::State<'_, AppState>,
    level: String,
    id: Option<String>,
    lens: Option<String>,
) -> Result<serde_json::Value, String> {
    if level.trim().is_empty() {
        return Err("fetch_sop: empty level".into());
    }
    let cfg = current_config(&state)?;
    let enc = |s: &str| -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    };
    let mut query = format!("level={}", enc(level.trim()));
    if let Some(id_val) = id.as_deref() {
        if !id_val.trim().is_empty() {
            query.push_str(&format!("&id={}", enc(id_val.trim())));
        }
    }
    if let Some(lens_val) = lens.as_deref() {
        if !lens_val.trim().is_empty() {
            query.push_str(&format!("&lens={}", enc(lens_val.trim())));
        }
    }
    let url = format!(
        "{}/api/state-of-play?{}",
        cfg.base_url.trim_end_matches('/'),
        query
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 || http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_sop: parse response failed: {e}"))
}

/// WP-CASCADE-PRODUCTION WP-T1 — the proxy-fleet inbox queue. Mirrors `fetch_sop`
/// (bearer auth, base_url, timeout, degrade-to-`{available:false}` on 404/503)
/// EXCEPT it prefers a local fixture while the real queue store is WP-E5 (not yet
/// shipped). Resolution order:
///   1. `<config_dir>/proxy-queue.fixture.json` — a dev/demo fixture the operator
///      drops next to config.json. If present + parseable, it is returned as-is.
///      (This is how T1 is demonstrated fixture-first per the brief, without
///      touching the Ross-owned live backends.)
///   2. Else proxy `GET /api/proxy-queue` — the WP-E5 endpoint. Until E5 lands
///      that 404s → `{available:false}`, so the view degrades to its empty state
///      rather than erroring.
/// Response contract (matches the WP-E5 queue-item shape):
///   { available: bool, items: [{ id, kind: merge|close|combine|chase|escalate,
///     confidence, evidence: { recordIds, cosine, routes, verdict, why,
///     verbatims?, dates?, owners? }, status: pending|confirmed|dismissed|undone,
///     actor, ts }] }
#[tauri::command]
async fn fetch_proxy_queue(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // (1) Fixture first — dev/demo path. A parse failure is surfaced (a
    // malformed fixture the operator placed is worth knowing about); a missing
    // fixture falls through to the live endpoint.
    if let Some(fixture) = config_dir().map(|p| p.join("proxy-queue.fixture.json")) {
        if fixture.exists() {
            let raw = fs::read_to_string(&fixture)
                .map_err(|e| format!("fetch_proxy_queue: read fixture failed: {e}"))?;
            let val: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("fetch_proxy_queue: fixture parse failed: {e}"))?;
            log::info!("proxy-queue served from fixture {}", fixture.display());
            return Ok(val);
        }
    }

    // (2) Live WP-E5 endpoint. Not yet shipped → 404 → {available:false}.
    let cfg = match current_config(&state) {
        Ok(c) => c,
        Err(_) => return Ok(serde_json::json!({ "available": false, "items": [] })),
    };
    let url = format!("{}/api/proxy-queue", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 || http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false, "items": [] }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_proxy_queue: parse response failed: {e}"))
}

/// WP-CASCADE-PRODUCTION WP-T1 — pending-count for the amber widget badge.
/// Counts `status == "pending"` items from the same source `fetch_proxy_queue`
/// draws on (fixture-first, then the WP-E5 endpoint). Best-effort like
/// `get_decision_log_summary`: ANY error (no config, unreachable, parse, missing)
/// returns 0 so the always-on widget badge simply stays hidden.
#[tauri::command]
async fn get_proxy_queue_count(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let payload = match fetch_proxy_queue(state).await {
        Ok(v) => v,
        Err(_) => return Ok(0),
    };
    let count = payload
        .get("items")
        .and_then(|i| i.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|it| {
                    it.get("status").and_then(|s| s.as_str()) == Some("pending")
                })
                .count() as u32
        })
        .unwrap_or(0);
    Ok(count)
}

/// WP-SoP-Team-Update-Compose — derive an OUTWARD team status update FROM a
/// Work-Forest SoP digest. Proxies POST /api/state-of-play/compose with
/// { level, id }. `level` is required; `id` is required for job/frame (omit for
/// forest). Mirrors the edit_digest POST shape — bearer auth, base_url, 60s
/// timeout. 404 (compose flag off) → {available:false} so the affordance stays
/// hidden. Response: { level, id, draft, recipients:{to,cc,unresolved}, items,
/// composeEnabled } (or { composeEnabled:false } on an empty digest).
#[tauri::command]
async fn compose_team_update(
    state: tauri::State<'_, AppState>,
    level: String,
    id: Option<String>,
) -> Result<serde_json::Value, String> {
    if level.trim().is_empty() {
        return Err("compose_team_update: empty level".into());
    }
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/state-of-play/compose",
        cfg.base_url.trim_end_matches('/')
    );
    let mut body = serde_json::Map::new();
    body.insert("level".into(), serde_json::Value::String(level.trim().to_string()));
    if let Some(id_val) = id.as_deref() {
        if !id_val.trim().is_empty() {
            body.insert("id".into(), serde_json::Value::String(id_val.trim().to_string()));
        }
    }
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 || http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "available": false }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("compose_team_update: parse response failed: {e}"))
}

/// WP-Priority-Operator HITL — record a natural calibration gesture (pin / unpin /
/// dismiss / reorder) for one priority item. POSTs /api/decision-log/priority/gesture;
/// the per-user weight vector is derived server-side from the gesture stream — never
/// a labeling task. `relationship` / `owner` denormalize the signal dimensions so the
/// server can re-weight without a re-lookup. Additive; failure-safe at the call site.
#[tauri::command]
async fn post_priority_gesture(
    state: tauri::State<'_, AppState>,
    gesture_type: String,
    record_id: String,
    relationship: Option<String>,
    owner: Option<String>,
    reason: Option<String>,
    snooze_until: Option<String>,
    handoff_note: Option<String>,
    context: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if record_id.trim().is_empty() {
        return Err("post_priority_gesture: empty record_id".into());
    }
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/priority/gesture",
        cfg.base_url.trim_end_matches('/')
    );
    let mut body = serde_json::json!({ "type": gesture_type, "recordId": record_id });
    if let Some(r) = relationship {
        body["relationship"] = serde_json::Value::String(r);
    }
    if let Some(o) = owner {
        body["owner"] = serde_json::Value::String(o);
    }
    // Dismiss reason (calibration direction) + denormalized context snapshot
    // (at-the-moment values, persisted so the future training join needs no re-derive).
    if let Some(r) = reason {
        body["reason"] = serde_json::Value::String(r);
    }
    if let Some(s) = snooze_until {
        body["snoozeUntil"] = serde_json::Value::String(s);
    }
    if let Some(n) = handoff_note {
        body["handoffNote"] = serde_json::Value::String(n);
    }
    if let Some(c) = context {
        body["context"] = c;
    }
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("post_priority_gesture: parse response failed: {e}"))
}

/// WP-Frame-HITL — append one org-edit (move / create / rename / merge / mark-type
/// / undo) to the viewer's overlay. The whole edit body is forwarded as-is to
/// `POST /api/decision-log/frames/edit`; the server validates + enriches it. The
/// edit is reapplied over the generated frames on the next decision-log read, so
/// the correction sticks.
#[tauri::command]
async fn frame_edit(
    state: tauri::State<'_, AppState>,
    edit: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/frames/edit",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&edit)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("frame_edit: parse response failed: {e}"))
}

/// Phase 0 — structural-edit learning read. Surfaces what the engine learned from
/// merge/reparent gestures (containment signals + placement priors). Mirrors
/// frame_edit's auth + client posture exactly; a GET with no body.
#[tauri::command]
async fn fetch_learning_state(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/frames/learning-state",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_learning_state: parse response failed: {e}"))
}

/// WP-Rule-Cards — "Patterns I've noticed" surface. Asks the LLM rule-development
/// engine to (re)develop cited rules + disjunction ("combine these?") suggestions
/// from the current semantic signals. A POST with an empty body; the server does
/// the work and returns the developed rules + suggestions. Mirrors frame_edit's
/// auth + client posture; the developer LLM step can be slow, so a longer timeout.
#[tauri::command]
async fn develop_rules(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/frames/develop-rules",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("develop_rules: parse response failed: {e}"))
}

/// WP-Frame-HITL "adapts" tier — the felt-learning POST actions. `action` is a
/// BOUNDED enum (offer / resolve / reject), never an arbitrary path. Mirrors
/// frame_edit's auth + client posture. `offer` returns the apply-to-similar offer
/// after a move; `resolve` applies selected + records rejected counterexamples;
/// `reject` records negative evidence / suppresses a rule ("Stop suggesting").
#[tauri::command]
async fn apply_to_similar(
    state: tauri::State<'_, AppState>,
    action: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let suffix = match action.as_str() {
        "offer" => "apply-to-similar",
        "resolve" => "apply-to-similar/resolve",
        "reject" => "apply-to-similar/reject",
        other => return Err(format!("apply_to_similar: unknown action '{other}'")),
    };
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/frames/{}",
        cfg.base_url.trim_end_matches('/'),
        suffix
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("apply_to_similar: parse response failed: {e}"))
}

/// WP-Frame-HITL "adapts" tier — the ambient learned SUGGESTIONS (Stage 3). Returns
/// the unplaced jobs an earned rule thinks belong elsewhere, as visible
/// confirm-or-dismiss annotations. No mutation server-side.
#[tauri::command]
async fn fetch_learned_suggestions(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/frames/suggestions",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_learned_suggestions: parse response failed: {e}"))
}

/// MVP-Librarian Phase 3 — the Question Engine channel ("one good question").
/// GET /api/decision-log/questions reports the currently-surfaced question (zero
/// side effects); with `pull=true` it appends `?pull=1` — the "anything you need
/// from me?" gesture that surfaces the top judged question on demand. The server
/// answers 503 when ENABLE_QUESTION_ENGINE is off; that is a NORMAL state, so it
/// is returned as data (`{disabled:true}`) rather than an error — the UI hides
/// the affordance silently. Mirrors frame_edit's auth + client posture; pull
/// runs the phrasing-judge LLM server-side, so a longer timeout.
#[tauri::command]
async fn fetch_question(
    state: tauri::State<'_, AppState>,
    pull: Option<bool>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/questions{}",
        cfg.base_url.trim_end_matches('/'),
        if pull.unwrap_or(false) { "?pull=1" } else { "" }
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 503 {
        return Ok(serde_json::json!({ "disabled": true, "question": null }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_question: parse response failed: {e}"))
}

/// MVP-Librarian Phase 3 — answer the surfaced question. POSTs
/// `{factKey, answer}` to /api/decision-log/questions/answer; the server folds
/// the confirm_fact org-edit (plus the drafted bulk events the card previewed)
/// and marks the question answered — terminal, never re-asked. Mirrors
/// frame_edit's auth + client posture.
///
/// UAT-curate — an optional `selectedJobKeys` (camelCase → `selected_job_keys`)
/// lets the card act on a SUBSET of the question's member jobs. The UI sends it
/// only when a curation subset exists; when absent (or all-selected), the server
/// treats it as the full action — today's behavior. Forwarded into the POST body
/// only when `Some`, so the wire shape is unchanged until a subset is chosen.
#[tauri::command]
async fn answer_question(
    state: tauri::State<'_, AppState>,
    fact_key: String,
    answer: bool,
    selected_job_keys: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/questions/answer",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let mut body = serde_json::json!({ "factKey": fact_key, "answer": answer });
    if let Some(keys) = selected_job_keys {
        body["selectedJobKeys"] = serde_json::json!(keys);
    }
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 503 {
        return Err("Question engine is disabled on the server.".into());
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("answer_question: parse response failed: {e}"))
}

/// MVP-Librarian card-trust — "Not now" = SNOOZE (not permanent). POSTs
/// `{factKey}` to /api/decision-log/questions/snooze; the server sets the
/// question aside and re-surfaces it later (Trisha: "if you say not now,
/// shouldn't it ask again later?"). Mirrors answer_question's auth + client
/// posture (bearer, invalid-certs, 15s timeout).
#[tauri::command]
async fn snooze_question(
    state: tauri::State<'_, AppState>,
    fact_key: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/questions/snooze",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::json!({ "factKey": fact_key }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 503 {
        return Err("Question engine is disabled on the server.".into());
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("snooze_question: parse response failed: {e}"))
}

/// MVP-Librarian Phase 3 — permanent fact-keyed suppression. POSTs
/// `{factKey}` to /api/decision-log/questions/dismiss; the fact never
/// re-surfaces (server-enforced). Retained for a future explicit "Don't ask
/// again"; "Not now" now snoozes. Mirrors frame_edit's auth + client posture.
#[tauri::command]
async fn dismiss_question(
    state: tauri::State<'_, AppState>,
    fact_key: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!(
        "{}/api/decision-log/questions/dismiss",
        cfg.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .json(&serde_json::json!({ "factKey": fact_key }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 503 {
        return Err("Question engine is disabled on the server.".into());
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("dismiss_question: parse response failed: {e}"))
}

/// WP-THRESHOLD-STATE-OF-PLAY — project altitude: returns the team-addressed
/// digest AND the per-teammate digests scoped to one project. `polish=false`
/// (`?team=text`) yields the instant deterministic team email; default polishes
/// it. Per-person messages are deterministic. 404 → {available:false}.
#[tauri::command]
async fn fetch_project_state_of_play(
    state: tauri::State<'_, AppState>,
    slug: String,
    polish: bool,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String = url::form_urlencoded::byte_serialize(slug.as_bytes()).collect();
    let url = format!(
        "{}/api/project/{}/state-of-play{}",
        cfg.base_url.trim_end_matches('/'),
        encoded,
        if polish { "" } else { "?team=text" }
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if http_status.as_u16() == 404 {
        return Ok(serde_json::json!({ "available": false, "reason": "no_records" }));
    }
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_project_state_of_play: parse response failed: {e}"))
}

/// WP-THRESHOLD-SOURCE — the in-app source reader. Proxies GET /api/document/:id
/// and returns the document detail JSON, which (server-side) now folds in the
/// raw `body` text so the split-view panel renders the source (email / Plaud
/// transcript / OneNote text) beside the decision without a browser round-trip.
/// Mirrors fetch_entity_card's bearer-auth + URL-encode pattern. Surfaces errors
/// so the panel can show an unreachable state. `document_id` is URL-encoded so
/// ids with reserved chars (OneNote GUIDs) transmit intact.
#[tauri::command]
async fn fetch_document(
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(document_id.as_bytes()).collect();
    let url = format!(
        "{}/api/document/{}",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_document: parse response failed: {e}"))
}

/// WP-THRESHOLD-SOURCE — every decision/commitment extracted from ONE document,
/// so the source reader can highlight ALL of them in the body (not just the one
/// the user clicked). Proxies GET /api/documents/:id/decision-records (already on
/// the bearer lane). Returns the raw `{ records, edges, ... }` JSON.
#[tauri::command]
async fn fetch_document_records(
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(document_id.as_bytes()).collect();
    let url = format!(
        "{}/api/documents/{}/decision-records",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let http_status = resp.status();
    if !http_status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(http_status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_document_records: parse response failed: {e}"))
}

/// WP-THRESHOLD-LOG-UX (Receipts) — the evidence dossier for one subject
/// entity. Proxies GET /api/decision-log/receipts?entity=X and returns the raw
/// JSON (records chronological + edges + derived states) for the client to
/// render deterministically. Surfaces errors so the view can show an
/// unreachable state. `entity` is URL-encoded so slugs with reserved chars are
/// transmitted intact.
#[tauri::command]
async fn fetch_receipts(
    state: tauri::State<'_, AppState>,
    entity: String,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let encoded: String =
        url::form_urlencoded::byte_serialize(entity.as_bytes()).collect();
    let url = format!(
        "{}/api/decision-log/receipts?entity={}",
        cfg.base_url.trim_end_matches('/'),
        encoded
    );
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_receipts: parse response failed: {e}"))
}

/// WP-THRESHOLD-LOG-UX (Receipts) — dual-format clipboard write for the one
/// "Copy" button. Writes the HTML rendering AND a Markdown plain-text fallback
/// in a single atomic clipboard operation via `arboard::set_html(html,
/// Some(markdown))`: rich-text targets (Gmail/Outlook/Word/Notion) take the
/// HTML flavor, plain-text targets (Slack/terminals) take the Markdown. One
/// button, no format picker. NSPasteboard (macOS) / clipboard-win (Windows) are
/// thread-safe, so this runs fine off the main thread.
#[tauri::command]
fn copy_receipts(html: String, markdown: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .set_html(html, Some(markdown))
        .map_err(|e| format!("clipboard write failed: {e}"))?;
    Ok(())
}

/// WP-THRESHOLD-SOURCE — copy plain source text to the clipboard (the source
/// reader's Copy button). Plain-text only (`set_text`), unlike copy_receipts'
/// dual HTML+Markdown write.
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("clipboard write failed: {e}"))?;
    Ok(())
}

/// WP-THRESHOLD-SOURCE — the source reader's Download button. Opens a native
/// save dialog seeded with `default_name`, then writes `content` (UTF-8) to the
/// chosen path. Returns the saved path, or `None` if the user cancelled. Mirrors
/// `pick_files`' dialog-plugin pattern (oneshot channel off the dialog callback).
#[tauri::command]
async fn save_text_file(
    app_handle: tauri::AppHandle,
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Text", &["txt", "md"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let chosen = rx.await.ok().flatten();
    let Some(fp) = chosen else {
        return Ok(None);
    };
    let path = fp
        .into_path()
        .map_err(|e| format!("invalid save path: {e}"))?;
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| format!("failed to write file: {e}"))?;
    Ok(Some(path.display().to_string()))
}

/// WP-N1 (S1 sharing) — the viewer's authenticated email, for capture
/// attribution + the Today "Mine / Everyone" filter. Proxies GET /api/whoami and
/// returns `{ email: string | null }`. Best-effort and intentionally never
/// errors to the UI: any failure (not configured, unreachable, parse, or a
/// server too old to have the endpoint → 404) collapses to `{ email: null }`,
/// i.e. "no identity" — and the identity-gated surfaces simply hide themselves.
/// This is what lets the client ship before the /api/whoami deploy lands.
#[tauri::command]
async fn get_whoami(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let null_identity = || serde_json::json!({ "email": serde_json::Value::Null });
    let cfg = match current_config(&state) {
        Ok(c) => c,
        Err(_) => return Ok(null_identity()),
    };
    let url = format!("{}/api/whoami", cfg.base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(null_identity()),
    };
    match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<serde_json::Value>().await {
                Ok(v) => Ok(v),
                Err(_) => Ok(null_identity()),
            }
        }
        _ => Ok(null_identity()),
    }
}

/// WP-N1 (S1 sharing) — full `/api/data` payload, used by the Today view to
/// build a documentId → submittedByEmail map for capture attribution. The
/// documents array is already disclosure-sliced server-side under the flag, so
/// the join never sees a doc the viewer can't. Surfaces errors so the caller can
/// degrade (attribution simply omitted) rather than blocking the view.
#[tauri::command]
async fn fetch_documents(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let cfg = current_config(&state)?;
    let url = format!("{}/api/data", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Apolla: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body_text));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("fetch_documents: parse response failed: {e}"))
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
            dispatch_tidbit_poll_if_success(&app_handle, &outcome, &cfg, document_id.clone());
            dispatch_records_poll_if_success(&app_handle, &outcome, &cfg, document_id);
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

// ───────────────────────────────────────────────────────────────────────────
// WP-PLAUD-07b — Plaud Connect (Settings → Connections)
// ───────────────────────────────────────────────────────────────────────────
//
// IPC surface for the Threshold-mediated Plaud OAuth bootstrap. The full
// PKCE flow + droplet POST lives in `plaud_oauth.rs`; these commands are
// thin wrappers that thread Tauri state (config, app handle for emitting
// status events, cancel sender) into and out of the orchestrator.
//
// Naming follows the brief's suggested commands (`plaud_connect_start` /
// `_cancel` / `_status`) plus an explicit `plaud_disconnect_soft_clear` for
// the v1.0 scope-cut Disconnect path (server-side `/api/plaud/disconnect`
// is WP-PLAUD-07d, named-not-specced).

/// Holds the cancel side of the in-flight Connect flow's oneshot. Single
/// slot — concurrent `plaud_connect_start` calls fail fast rather than
/// stomp each other. Cleared back to `None` when the orchestrator
/// completes (success or failure).
static PLAUD_CONNECT_CANCEL: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);

/// Frontend-visible outcome of `plaud_connect_start`. Echoes the local
/// cached status the IPC just wrote into AppConfig so the UI doesn't need
/// a follow-up `plaud_connect_status` round-trip on the happy path.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaudConnectResult {
    pub status: plaud_oauth::PlaudConnectStatus,
}

#[tauri::command]
async fn plaud_connect_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PlaudConnectResult, String> {
    let cfg = current_config(&state)?;
    if cfg.base_url.trim().is_empty() || cfg.bearer_token.trim().is_empty() {
        return Err(
            "Threshold isn't configured yet — open Settings, fill in your Apolla URL and bearer token, then try Connect Plaud again."
                .into(),
        );
    }

    // Claim the in-flight slot. If a previous Connect is still running,
    // fail fast — the user can click Cancel on the existing flow first.
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut guard = PLAUD_CONNECT_CANCEL
            .lock()
            .map_err(|e| format!("connect-cancel mutex poisoned: {}", e))?;
        if guard.is_some() {
            return Err("Connect Plaud is already in progress — finish or cancel that attempt first.".into());
        }
        *guard = Some(cancel_tx);
    }

    let app_for_emit = app.clone();
    let emit_status = move |evt: plaud_oauth::PlaudConnectStatusEvent| {
        if let Err(e) = app_for_emit.emit("plaud-connect://status", &evt) {
            log::warn!("plaud-connect://status emit failed: {}", e);
        }
    };

    let inputs = plaud_oauth::ConnectInputs {
        base_url: cfg.base_url.clone(),
        bearer: cfg.bearer_token.clone(),
        emit_status,
        cancel_rx,
        browser_opener: plaud_oauth::BrowserOpener::Default(app.clone()),
    };

    let outcome = plaud_oauth::run_connect_flow(inputs).await;

    // Release the in-flight slot regardless of outcome.
    {
        let mut guard = PLAUD_CONNECT_CANCEL
            .lock()
            .map_err(|e| format!("connect-cancel mutex poisoned: {}", e))?;
        *guard = None;
    }

    match outcome {
        Ok(success) => {
            // Persist local cached status (UX hint). The droplet is the
            // source of truth; this just lets the Settings → Connections
            // pane render "Connected" on next open without a round-trip.
            let now = Utc::now().to_rfc3339();
            let new_status = plaud_oauth::PlaudConnectStatus {
                connected_at: now,
                expires_at: success
                    .server_expires_at
                    .or(success.tokens.expires_at),
                posted_to: Some(cfg.base_url.clone()),
            };
            {
                let mut guard = state.config.lock().expect("config mutex poisoned");
                let mut next = guard.clone().unwrap_or_default();
                next.plaud_connect = Some(new_status.clone());
                if let Err(e) = save_config_to_disk(&next) {
                    log::warn!("plaud_connect_start: save_config_to_disk failed: {}", e);
                }
                *guard = Some(next);
            }
            log::info!("plaud_connect_start success");
            Ok(PlaudConnectResult { status: new_status })
        }
        Err(err) => {
            log::warn!("plaud_connect_start failed: {}", err);
            Err(err.to_string())
        }
    }
}

#[tauri::command]
fn plaud_connect_cancel() -> Result<(), String> {
    let mut guard = PLAUD_CONNECT_CANCEL
        .lock()
        .map_err(|e| format!("connect-cancel mutex poisoned: {}", e))?;
    if let Some(tx) = guard.take() {
        // Receiver may have already finished — ignore the SendError that
        // returns; either way the slot is now empty.
        let _ = tx.send(());
        log::info!("plaud_connect_cancel: cancel signal sent");
    } else {
        log::debug!("plaud_connect_cancel: no in-flight flow to cancel");
    }
    Ok(())
}

#[tauri::command]
fn plaud_connect_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<plaud_oauth::PlaudConnectStatus>, String> {
    let guard = state.config.lock().expect("config mutex poisoned");
    Ok(guard.as_ref().and_then(|c| c.plaud_connect.clone()))
}

#[tauri::command]
fn plaud_disconnect_soft_clear(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.config.lock().expect("config mutex poisoned");
    let mut next = guard.clone().unwrap_or_default();
    if next.plaud_connect.is_some() {
        next.plaud_connect = None;
        if let Err(e) = save_config_to_disk(&next) {
            log::warn!("plaud_disconnect_soft_clear: save_config_to_disk failed: {}", e);
        }
        *guard = Some(next);
        log::info!("plaud_disconnect_soft_clear: local cached status cleared");
    }
    Ok(())
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
/// (hotkey) and WP-04 (bulk-send iteration) both reduce to
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
/// 100-line publish-and-post body; the WP-04 bulk-send loop calls this
/// too. The IPC command becomes a 1-line wrapper in a follow-on cleanup
/// pass (left as-is for now to minimize the WP-03 diff).
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
// WP-AUTO-IMPORT — designated-source background auto-import
// ───────────────────────────────────────────────────────────────────────────
//
// A single polling loop (cadence = the user-configured interval_minutes) sweeps the user's
// designated sources and silently pulls in anything new:
//   - Plaud devices (by serial): import pending inbox items discovered after
//     the device's `since` timestamp. Cross-platform — works on Mac.
//   - OneNote notebooks (by id): import pages whose lastModifiedTime is newer
//     than the per-notebook `watermark`. Windows-only at fire time (the COM
//     enumerate returns PlatformUnsupported on Mac/Linux, so the loop no-ops
//     that half).
// Each import emits a `threshold://toast` so the user sees what landed.

/// Resolve the configured sweep cadence (minutes → Duration), clamped to the
/// `MIN_AUTO_IMPORT_INTERVAL_MINUTES` floor. Falls back to the default when no
/// config is loaded yet. Read fresh each loop iteration so a UI change to the
/// interval takes effect on the next tick without restarting the loop.
fn auto_import_poll_interval(app: &tauri::AppHandle) -> Duration {
    let mins = current_config_opt(app)
        .map(|c| c.auto_import.interval_minutes)
        .unwrap_or(DEFAULT_AUTO_IMPORT_INTERVAL_MINUTES)
        .max(MIN_AUTO_IMPORT_INTERVAL_MINUTES);
    Duration::from_secs(mins * 60)
}

/// Parse an RFC3339 / ISO8601 timestamp (OneNote emits e.g.
/// `2026-05-27T12:00:00.000Z`; Plaud emits RFC3339). `None` on failure.
fn parse_ts(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok()
}

/// True iff `a` is strictly later than `b`. Parses both as RFC3339; on parse
/// failure falls back to byte comparison (zero-padded ISO8601 UTC strings
/// sort chronologically as bytes).
fn ts_after(a: &str, b: &str) -> bool {
    match (parse_ts(a), parse_ts(b)) {
        (Some(x), Some(y)) => x > y,
        _ => a.trim() > b.trim(),
    }
}

fn auto_import_seen(key: &str) -> bool {
    AUTO_IMPORT_SESSION_SENT
        .lock()
        .map(|s| s.contains(key))
        .unwrap_or(false)
}

fn auto_import_mark(key: &str) {
    if let Ok(mut s) = AUTO_IMPORT_SESSION_SENT.lock() {
        s.insert(key.to_string());
    }
}

fn auto_import_has_enabled_source(cfg: &AppConfig) -> bool {
    cfg.auto_import.onenote_notebooks.iter().any(|n| n.enabled)
        || cfg.auto_import.plaud_devices.iter().any(|d| d.enabled)
}

/// Read-modify-write the persisted OneNote watermark for a single notebook.
/// Locks AppState, mutates the matching source, writes to disk + refreshes the
/// in-memory cache. Quiet on the no-match / lock-poisoned paths (best-effort).
fn auto_import_persist_onenote_watermark(
    app: &tauri::AppHandle,
    notebook_id: &str,
    section_id: Option<&str>,
    watermark: &str,
) {
    let state = app.state::<AppState>();
    let mut guard = match state.config.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let mut cfg = guard.clone().unwrap_or_default();
    let mut changed = false;
    for src in cfg.auto_import.onenote_notebooks.iter_mut() {
        // Identity is the (notebook, section) pair so a whole-notebook watch
        // and a section watch on the same notebook keep separate watermarks.
        if src.notebook_id == notebook_id && src.section_id.as_deref() == section_id {
            src.watermark = Some(watermark.to_string());
            changed = true;
        }
    }
    if changed {
        if let Err(e) = save_config_to_disk(&cfg) {
            log::warn!("WP-AUTO-IMPORT: persist watermark failed: {}", e);
        }
        *guard = Some(cfg);
    }
}

// ── Plaud HTTP helpers (take &AppConfig so the loop can call them without
//    the Tauri State the #[tauri::command] wrappers require) ────────────────

async fn auto_import_plaud_discover(cfg: &AppConfig) -> Result<(), String> {
    let url = format!("{}/api/plaud/discover", cfg.base_url.trim_end_matches('/'));
    let client = build_plaud_http_client()?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body));
    }
    Ok(())
}

async fn auto_import_plaud_inbox(cfg: &AppConfig) -> Result<Vec<PlaudInboxItem>, String> {
    let url = format!("{}/api/plaud/inbox", cfg.base_url.trim_end_matches('/'));
    let client = build_plaud_http_client()?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .send()
        .await
        .map_err(|e| format!("{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &url, &body));
    }
    let parsed: PlaudInboxResponse = resp
        .json()
        .await
        .map_err(|e| format!("parse inbox: {}", e))?;
    Ok(parsed.items)
}

/// Decide-import + ingest for one recording (mirrors the JS handlePlaudImport
/// two-step). Returns the ingest result on success.
async fn auto_import_plaud_one(cfg: &AppConfig, id: &str) -> Result<PlaudIngestResult, String> {
    let decide_url = format!(
        "{}/api/plaud/inbox/{}/decide",
        cfg.base_url.trim_end_matches('/'),
        urlencoding_minimal(id)
    );
    let client = build_plaud_http_client()?;
    let resp = client
        .post(&decide_url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .body("{\"action\":\"import\"}")
        .send()
        .await
        .map_err(|e| format!("{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &decide_url, &body));
    }

    let ingest_url = format!("{}/api/plaud/ingest", cfg.base_url.trim_end_matches('/'));
    // Ingest is slow (Plaud getFile + LLM extraction); use the same 120s
    // override the plaud_ingest command uses.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;
    let resp = client
        .post(&ingest_url)
        .header("Authorization", format!("Bearer {}", cfg.bearer_token))
        .header("Content-Type", "application/json")
        .body(format!("{{\"id\":\"{}\"}}", id.replace('"', "\\\"")))
        .send()
        .await
        .map_err(|e| format!("{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(plaud_status_error(status, &ingest_url, &body));
    }
    resp.json::<PlaudIngestResult>()
        .await
        .map_err(|e| format!("parse ingest: {}", e))
}

/// WP-AUTO-IMPORT — kick off the polling loop. Idempotent.
fn start_auto_import_loop(app: tauri::AppHandle) {
    if AUTO_IMPORT_ACTIVE.swap(true, Ordering::SeqCst) {
        log::info!("WP-AUTO-IMPORT: loop already running; start is no-op");
        return;
    }
    log::info!("WP-AUTO-IMPORT: starting auto-import loop");
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if !AUTO_IMPORT_ACTIVE.load(Ordering::SeqCst) {
                log::info!("WP-AUTO-IMPORT: loop self-terminating");
                return;
            }
            tick_auto_import(&app_handle).await;
            tokio::time::sleep(auto_import_poll_interval(&app_handle)).await;
        }
    });
}

/// WP-AUTO-IMPORT — request loop stop; next tick self-terminates. Idempotent.
fn stop_auto_import_loop() {
    if AUTO_IMPORT_ACTIVE.swap(false, Ordering::SeqCst) {
        log::info!("WP-AUTO-IMPORT: loop stop requested");
    }
}

/// One polling tick: Plaud then OneNote. Bails early when auto-import is off.
async fn tick_auto_import(app: &tauri::AppHandle) {
    let cfg = match current_config_opt(app) {
        Some(c) => c,
        None => return,
    };
    if !cfg.auto_import.enabled {
        return;
    }
    tick_auto_import_plaud(app, &cfg).await;
    tick_auto_import_onenote(app, &cfg).await;
}

async fn tick_auto_import_plaud(app: &tauri::AppHandle, cfg: &AppConfig) {
    let enabled: Vec<&AutoImportPlaudSource> = cfg
        .auto_import
        .plaud_devices
        .iter()
        .filter(|d| d.enabled)
        .collect();
    if enabled.is_empty() {
        return;
    }
    if cfg.base_url.trim().is_empty() || cfg.bearer_token.trim().is_empty() {
        return;
    }
    // Best-effort discover so brand-new recordings surface in the inbox.
    if let Err(e) = auto_import_plaud_discover(cfg).await {
        log::debug!("WP-AUTO-IMPORT: plaud discover failed (non-fatal): {}", e);
    }
    let inbox = match auto_import_plaud_inbox(cfg).await {
        Ok(items) => items,
        Err(e) => {
            log::warn!("WP-AUTO-IMPORT: plaud inbox failed: {}", e);
            return;
        }
    };
    for item in inbox {
        if item.state != "pending" {
            continue;
        }
        let dev = match enabled.iter().find(|d| d.serial_number == item.serial_number) {
            Some(d) => d,
            None => continue,
        };
        if let Some(since) = dev.since.as_deref() {
            if !ts_after(&item.discovered_at, since) {
                continue;
            }
        }
        let key = format!("plaud:{}", item.id);
        if auto_import_seen(&key) {
            continue;
        }
        match auto_import_plaud_one(cfg, &item.id).await {
            Ok(_) => {
                auto_import_mark(&key);
                log::info!("WP-AUTO-IMPORT: auto-imported Plaud recording {}", item.id);
                let _ = app.emit(
                    "threshold://toast",
                    IngestionOutcome {
                        kind: "success".into(),
                        title: "Auto-imported from Plaud".into(),
                        body: Some(format!("“{}” added to your Apolla workspace.", item.name)),
                        source_path: None,
                    },
                );
            }
            Err(e) => log::warn!("WP-AUTO-IMPORT: plaud import {} failed: {}", item.id, e),
        }
    }
}

async fn tick_auto_import_onenote(app: &tauri::AppHandle, cfg: &AppConfig) {
    let sources: Vec<AutoImportOneNoteSource> = cfg
        .auto_import
        .onenote_notebooks
        .iter()
        .filter(|n| n.enabled)
        .cloned()
        .collect();
    if sources.is_empty() {
        return;
    }
    // Enumerate once per tick; filter to designated notebooks below. On
    // Mac/Linux this returns PlatformUnsupported → we skip silently.
    let tree = match tauri::async_runtime::spawn_blocking(onenote_windows::enumerate_hierarchy).await
    {
        Ok(Ok(t)) => t,
        Ok(Err(_)) => return,
        Err(e) => {
            log::warn!("WP-AUTO-IMPORT: enumerate join error: {}", e);
            return;
        }
    };
    for src in sources {
        let notebook = match tree.notebooks.iter().find(|n| n.notebook_id == src.notebook_id) {
            Some(n) => n,
            None => continue,
        };
        // (page_id, lastModifiedTime) for every timestamped page. When the
        // source is section-scoped, restrict the sweep to that one section.
        let mut pages: Vec<(String, chrono::DateTime<chrono::FixedOffset>)> = Vec::new();
        for section in &notebook.sections {
            if let Some(want) = src.section_id.as_deref() {
                if section.section_id != want {
                    continue;
                }
            }
            for page in &section.pages {
                if let Some(dt) = page.last_modified_time.as_deref().and_then(parse_ts) {
                    pages.push((page.page_id.clone(), dt));
                }
            }
        }
        if pages.is_empty() {
            continue;
        }
        let newest = pages.iter().map(|(_, d)| *d).max().unwrap();
        let watermark = match src.watermark.as_deref().and_then(parse_ts) {
            None => {
                // First sight of this notebook: baseline to the current
                // newest page and import nothing (no back-catalogue sweep).
                auto_import_persist_onenote_watermark(
                    app,
                    &src.notebook_id,
                    src.section_id.as_deref(),
                    &newest.to_rfc3339(),
                );
                log::info!(
                    "WP-AUTO-IMPORT: baselined OneNote source '{}'{} at {}",
                    src.name,
                    src.section_name
                        .as_deref()
                        .map(|s| format!(" · {}", s))
                        .unwrap_or_default(),
                    newest.to_rfc3339()
                );
                continue;
            }
            Some(w) => w,
        };
        let mut fresh: Vec<(String, chrono::DateTime<chrono::FixedOffset>)> = pages
            .into_iter()
            .filter(|(id, d)| *d > watermark && !auto_import_seen(&format!("onenote:{}", id)))
            .collect();
        fresh.sort_by_key(|(_, d)| *d);
        let mut max_seen = watermark;
        for (page_id, d) in fresh {
            let key = format!("onenote:{}", page_id);
            let outcome = run_onenote_send_inline(cfg.clone(), Some(page_id.clone())).await;
            let ok = matches!(outcome.kind.as_str(), "success" | "idempotent");
            let toast = IngestionOutcome {
                kind: outcome.kind.clone(),
                title: if ok {
                    "Auto-imported from OneNote".into()
                } else {
                    outcome.title.clone()
                },
                body: outcome.body.clone(),
                source_path: None,
            };
            let _ = app.emit("threshold://toast", toast);
            // Mark seen regardless of outcome: success/idempotent shouldn't
            // re-fire, and a hard failure (e.g. handwriting-only page)
            // shouldn't retry every 90s. The watermark only advances past
            // successes, so a failed page below the new mark is dropped after
            // its single attempt — matching the silent best-effort contract.
            auto_import_mark(&key);
            if ok && d > max_seen {
                max_seen = d;
            }
            if ok {
                log::info!("WP-AUTO-IMPORT: auto-imported OneNote page {}", page_id);
            } else {
                log::info!(
                    "WP-AUTO-IMPORT: OneNote page {} send failed ({})",
                    page_id,
                    outcome.kind
                );
            }
        }
        if max_seen > watermark {
            auto_import_persist_onenote_watermark(
                app,
                &src.notebook_id,
                src.section_id.as_deref(),
                &max_seen.to_rfc3339(),
            );
        }
    }
}

// ── Auto-import IPC surface ────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AutoImportSourceOption {
    id: String,
    name: String,
    /// For OneNote notebooks: the notebook's sections, so the picker can offer
    /// "whole notebook" plus per-section watches. Empty (and omitted from JSON)
    /// for Plaud devices and for section entries themselves.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sections: Vec<AutoImportSourceOption>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AutoImportAvailable {
    onenote: Vec<AutoImportSourceOption>,
    plaud: Vec<AutoImportSourceOption>,
    /// Whether OneNote auto-import can actually fire on this OS (Windows COM).
    /// The UI shows a "Windows-only" note when false.
    onenote_supported: bool,
    /// Whether Plaud is connected (UX hint — guides the user to Connections).
    plaud_connected: bool,
}

/// WP-AUTO-IMPORT — read the persisted auto-import config for the UI.
#[tauri::command]
fn get_auto_import_config(state: tauri::State<AppState>) -> Result<AutoImportConfig, String> {
    Ok(state
        .config
        .lock()
        .expect("config mutex poisoned")
        .as_ref()
        .map(|c| c.auto_import.clone())
        .unwrap_or_default())
}

/// WP-AUTO-IMPORT — persist the full auto-import config (the JS round-trips
/// the whole object on every add/remove/toggle) and (re)start or stop the
/// loop to match. Stamps `since` on newly-designated Plaud devices and
/// preserves OneNote watermarks across edits. Returns the stored config so
/// the UI can pick up the stamped fields.
#[tauri::command]
async fn set_auto_import_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: AutoImportConfig,
) -> Result<AutoImportConfig, String> {
    let mut full = state
        .config
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();

    let mut incoming = config;
    let now = Utc::now().to_rfc3339();
    for d in incoming.plaud_devices.iter_mut() {
        if d.since.is_none() {
            d.since = Some(now.clone());
        }
    }
    // Carry forward persisted watermarks so a UI edit never resets a baseline.
    for src in incoming.onenote_notebooks.iter_mut() {
        if src.watermark.is_none() {
            if let Some(prev) = full
                .auto_import
                .onenote_notebooks
                .iter()
                .find(|p| p.notebook_id == src.notebook_id && p.section_id == src.section_id)
            {
                src.watermark = prev.watermark.clone();
            }
        }
    }
    full.auto_import = incoming;

    let dir = config_dir().ok_or_else(|| "Could not resolve config directory".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let path = dir.join("config.json");
    full.last_used = Some(Utc::now().to_rfc3339());
    let json =
        serde_json::to_string_pretty(&full).map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    let stored = full.auto_import.clone();
    *state.config.lock().expect("config mutex poisoned") = Some(full);
    log::info!(
        "WP-AUTO-IMPORT: config saved (enabled={}, onenote={}, plaud={})",
        stored.enabled,
        stored.onenote_notebooks.len(),
        stored.plaud_devices.len()
    );

    if stored.enabled && auto_import_has_enabled_source_owned(&stored) {
        start_auto_import_loop(app);
    } else {
        stop_auto_import_loop();
    }
    Ok(stored)
}

/// Same predicate as `auto_import_has_enabled_source` but over an owned
/// `AutoImportConfig` (the command holds the config directly, not a full
/// AppConfig).
fn auto_import_has_enabled_source_owned(c: &AutoImportConfig) -> bool {
    c.onenote_notebooks.iter().any(|n| n.enabled) || c.plaud_devices.iter().any(|d| d.enabled)
}

/// True when `s` looks like a genuine Plaud device serial rather than the
/// start-time epoch-ms the server stamps into `serialNumber` when the real
/// serial is missing (observed on ross.viktora.ai: 38 of 40 distinct
/// "serials" were 13-digit start timestamps, e.g. `1781161206381` ==
/// `startAt` 2026-06-11T07:00:06.381). Real serials are alphanumeric
/// (`8810B30273641222`) or hex UUIDs; the bogus ones are pure long numerics.
/// This is a client-side guard around an upstream data-quality issue — the
/// authoritative fix is to populate `serialNumber` correctly server-side.
fn is_plausible_plaud_serial(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    // Reject pure-numeric values of timestamp length (≥12 digits) — no real
    // Plaud serial in the field is a bare 12+ digit number, but every epoch-ms
    // timestamp is.
    if s.len() >= 12 && s.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    true
}

/// WP-AUTO-IMPORT — enumerate sources the user can designate: OneNote
/// notebooks (via COM, empty on Mac) and Plaud devices (distinct serials seen
/// in the inbox). Drives the "Add a source" picker.
#[tauri::command]
async fn auto_import_available_sources(
    state: tauri::State<'_, AppState>,
) -> Result<AutoImportAvailable, String> {
    let cfg = current_config(&state)?;
    let onenote =
        match tauri::async_runtime::spawn_blocking(onenote_windows::enumerate_hierarchy).await {
            Ok(Ok(tree)) => tree
                .notebooks
                .into_iter()
                .map(|n| AutoImportSourceOption {
                    id: n.notebook_id,
                    name: n.name,
                    sections: n
                        .sections
                        .into_iter()
                        .map(|s| AutoImportSourceOption {
                            id: s.section_id,
                            name: s.name,
                            sections: Vec::new(),
                        })
                        .collect(),
                })
                .collect(),
            _ => Vec::new(),
        };
    let plaud_connected = cfg.plaud_connect.is_some();
    let plaud = match auto_import_plaud_inbox(&cfg).await {
        Ok(items) => {
            let mut seen = std::collections::HashSet::new();
            let mut out = Vec::new();
            for it in items {
                // Skip the timestamp-as-serial noise (see is_plausible_plaud_serial)
                // so the picker lists real recorders, not one row per recording.
                if is_plausible_plaud_serial(&it.serial_number)
                    && seen.insert(it.serial_number.clone())
                {
                    out.push(AutoImportSourceOption {
                        id: it.serial_number.clone(),
                        name: format!("Plaud {}", it.serial_number),
                        sections: Vec::new(),
                    });
                }
            }
            out
        }
        Err(_) => Vec::new(),
    };
    Ok(AutoImportAvailable {
        onenote,
        plaud,
        onenote_supported: cfg!(target_os = "windows"),
        plaud_connected,
    })
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
/// WP-THRESHOLD-LOG-UX — opens the "Today" decision/commitment-log view
/// (`view-log`). Same widget_expand mechanism as the other panes; main.js's
/// hash-router calls enterLogView() on `#log`. Sits at the top of the review
/// group (just below the capture surfaces) since it's the always-on "what needs
/// attention" entry point.
const MENU_LOG: &str = "menu.log";
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
    // WP-THRESHOLD-LOG-UX — "Today" review surface. Sits first in the review
    // group (above Plaud Sync Queue) since it's the always-on "what needs
    // attention" entry point. Routes to enterLogView() via the #log fragment.
    let today = MenuItem::with_id(app, MENU_LOG, "Today", true, None::<&str>)?;
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
                &today,
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
            &today,
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

    // Step 2: resize. Sized to hug the main-view content (golden-ratio tile
    // pair + header + drop hint) rather than leave it swimming in an 800×600
    // frame. The webview layout is responsive, so the other expanded views
    // (Configure, Connections, Auto-import — all max-width 720 and scrollable)
    // adapt cleanly to the smaller frame.
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 720.0,
            height: 560.0,
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
            dispatch_tidbit_poll_if_success(&app_handle, &outcome, &cfg, document_id.clone());
            dispatch_records_poll_if_success(&app_handle, &outcome, &cfg, document_id);
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
            dispatch_tidbit_poll_if_success(&app_handle, &outcome, &cfg, document_id.clone());
            dispatch_records_poll_if_success(&app_handle, &outcome, &cfg, document_id);
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
                        } else if let Some(callback) = parse_auth_deep_link(&url) {
                            // WP-THRESHOLD-APP-AUTH (email-login) — magic-link
                            // carrier. Emit to the frontend, which calls
                            // auth_verify(token) to redeem it for a per-user
                            // bearer. Token is redacted from the log.
                            log::info!("deep-link parsed as auth callback (token redacted)");
                            if let Err(e) = app_handle.emit("threshold://auth-callback", &callback) {
                                log::warn!("emit auth-callback failed: {e}");
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
                pending_records: Mutex::new(None),
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

            // WP-AUTO-IMPORT — if the persisted config has auto-import enabled
            // with at least one enabled source, start the polling loop at
            // launch so designated sources keep syncing across restarts.
            // Cross-platform: the Plaud half works everywhere; the OneNote
            // half no-ops on Mac/Linux (COM enumerate returns
            // PlatformUnsupported).
            if preloaded_cfg
                .as_ref()
                .map(|c| c.auto_import.enabled && auto_import_has_enabled_source(c))
                .unwrap_or(false)
            {
                log::info!(
                    "WP-AUTO-IMPORT: auto-import enabled in persisted config; \
                     starting polling loop at app launch"
                );
                start_auto_import_loop(app.handle().clone());
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
            get_sovereignty,
            // WP-THRESHOLD-APP-AUTH (email-login) — per-user magic-link sign-in
            auth_request_link,
            auth_verify,
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
            // WP-THRESHOLD-LOG-UX — decision/commitment records + Today view
            get_pending_records,
            clear_pending_records,
            get_decision_log_summary,
            fetch_decision_log,
            fetch_outbox,
            outbox_decide,
            outbox_propose,
            fetch_vigilance_voids,
            dismiss_void,
            snooze_void,
            undo_void,
            // WP-THRESHOLD-LOG-UX — Connections (grounded cross-record edges)
            fetch_decision_log_full,
            // WP-THRESHOLD-LOG-UX — Connections HITL (confirm/dismiss edge)
            patch_edge_status,
            // WP-THRESHOLD-RECORD-HITL — server-side record disposition
            set_record_disposition,
            // TYPED-DIFF-CAPTURE Phase 1 — typed draft-edit (owner / focus / prose)
            edit_record,
            // TYPED-DIFF-CAPTURE Phase B — inline digest decomposition + approve
            edit_digest,
            create_record_from_proposal,
            // WP-THRESHOLD-DISMISS — client-only record suppression
            get_dismissed_record_ids,
            dismiss_record,
            undismiss_record,
            // WP-THRESHOLD-LOG-UX — per-entity definition card
            fetch_entity_card,
            // WP-THRESHOLD-STATE-OF-PLAY — per-person + team execution digests
            fetch_person_state_of_play,
            fetch_team_state_of_play,
            fetch_corpus_state_of_play,
            fetch_project_state_of_play,
            // WP-Cohesion-Operators — INFORM ("worth looping in")
            fetch_inform_edges,
            // WP-Threshold-Grouping-Canonicalization — project-grouping canon (Combine/Split/Rename)
            fetch_project_canon,
            project_canon_merge,
            project_canon_rename,
            project_canon_unmerge,
            // WP-Priority-Operator — "Focus" rail + HITL calibration gestures
            fetch_priority,
            post_priority_gesture,
            // WP-WorkForest-Native-SoP — Work-Forest-native State of Play (job/frame/forest + lenses)
            fetch_sop,
            compose_team_update,
            // WP-CASCADE-PRODUCTION WP-T1 — proxy-fleet inbox queue + badge count
            fetch_proxy_queue,
            get_proxy_queue_count,
            frame_edit,
            fetch_learning_state,
            develop_rules,
            apply_to_similar,
            fetch_learned_suggestions,
            // MVP-Librarian Phase 3 — Question Engine card + pull mode
            fetch_question,
            answer_question,
            snooze_question,
            dismiss_question,
            // WP-THRESHOLD-SOURCE — in-app source reader
            fetch_document,
            fetch_document_records,
            // WP-THRESHOLD-LOG-UX — Receipts (client PR 2)
            fetch_receipts,
            copy_receipts,
            // WP-THRESHOLD-SOURCE — source reader copy + download
            copy_text,
            save_text_file,
            // WP-N1 (S1 sharing) — viewer identity + document attribution
            get_whoami,
            fetch_documents,
            // WP-PLAUD-04a — Plaud Sync Queue
            plaud_discover,
            plaud_get_inbox,
            plaud_decide,
            plaud_ingest,
            // WP-PLAUD-07b — Threshold-mediated Plaud Connect
            plaud_connect_start,
            plaud_connect_cancel,
            plaud_connect_status,
            plaud_disconnect_soft_clear,
            // WP-ONENOTE-EXPORT-02 — OneNote COM client
            onenote_enumerate_hierarchy,
            onenote_get_active_page,
            onenote_export_and_ingest_page,
            // WP-ONENOTE-EXPORT-04 — bulk-send-section + browse view
            onenote_send_section,
            onenote_send_active_section,
            onenote_cancel_bulk_send,
            // WP-AUTO-IMPORT — designated-source background auto-import
            get_auto_import_config,
            set_auto_import_config,
            auto_import_available_sources,
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
                    MENU_LOG => {
                        // WP-THRESHOLD-LOG-UX — expand into the "Today" view.
                        // The "log" target_tab flows through to main.js as the
                        // #log URL fragment; main.js's bootstrap hash-router
                        // calls enterLogView() on match.
                        if let Err(e) = widget_expand(
                            app.state::<AppState>(),
                            window.clone(),
                            Some("log".into()),
                        ) {
                            log::warn!("menu log (Today) failed: {e}");
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
            plaud_connect: None,
            auto_import: AutoImportConfig::default(),
            dismissed_record_ids: Vec::new(),
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
            plaud_connect: None,
            auto_import: AutoImportConfig::default(),
            dismissed_record_ids: Vec::new(),
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

    // Build a deep-link URL using THIS build's expected scheme
    // (`DEEP_LINK_SCHEME` — `apolla-threshold-dev` under debug_assertions,
    // `apolla-threshold` in release). `rest` is everything after `://`.
    // Scheme-positive tests use this so they pass under both build profiles.
    fn scheme_url(rest: &str) -> String {
        format!("{}://{}", DEEP_LINK_SCHEME, rest)
    }

    fn parse(s: &str) -> Option<ConfigurePrefill> {
        let url = url::Url::parse(s).expect("test URL parses");
        parse_configure_deep_link(&url)
    }

    #[test]
    fn deep_link_happy_path() {
        let prefill = parse(&scheme_url("configure?tenant=threshold-eval&token=apolla_abc123"))
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
        assert!(parse(&scheme_url("setup?tenant=x&token=apolla_abc")).is_none());
    }

    #[test]
    fn deep_link_rejects_missing_token() {
        assert!(parse(&scheme_url("configure?tenant=acme")).is_none());
        // Empty-string token also rejected (canonical canary)
        assert!(parse(&scheme_url("configure?tenant=acme&token=")).is_none());
    }

    #[test]
    fn deep_link_rejects_missing_tenant() {
        // No tenant slug → can't reconstruct base_url → reject. Brief
        // (WP-OCR-09 D-09-08) requires `?tenant=...`.
        assert!(parse(&scheme_url("configure?token=apolla_abc")).is_none());
        assert!(parse(&scheme_url("configure?tenant=&token=apolla_abc")).is_none());
    }

    #[test]
    fn deep_link_url_encoded_token_decodes() {
        // url::Url performs percent-decoding on query_pairs(), so a token
        // containing % escapes round-trips. Validates we use query_pairs()
        // rather than raw .query().
        let prefill = parse(&scheme_url(
            "configure?tenant=acme&token=apolla_%2B%2Ftoken%3Dvalue",
        ))
        .expect("encoded token parses");
        assert_eq!(prefill.token, "apolla_+/token=value");
    }

    #[test]
    fn deep_link_ignores_extra_query_params() {
        // Brief reserves `?tenant=` and `?token=`; future params should
        // be silently ignored, not reject the URL.
        let prefill = parse(&scheme_url("configure?tenant=acme&token=apolla_abc&future=xyz"))
            .expect("extra params tolerated");
        assert_eq!(prefill.tenant.as_deref(), Some("acme"));
        assert_eq!(prefill.token, "apolla_abc");
    }

    #[test]
    fn deep_link_tenant_with_hyphens_preserved() {
        // Multi-hyphen tenant slug (matches the wife-pilot
        // threshold-eval.viktora.ai pattern). Slug is opaque — no slug
        // validation in v1.
        let prefill = parse(&scheme_url("configure?tenant=acme-corp-staging&token=apolla_xyz"))
            .expect("hyphenated tenant parses");
        assert_eq!(prefill.tenant.as_deref(), Some("acme-corp-staging"));
        assert_eq!(prefill.base_url, "https://acme-corp-staging.viktora.ai");
    }

    // ───── WP-THRESHOLD-APP-AUTH (email-login) — auth deep-link parser ─────

    fn parse_auth(s: &str) -> Option<AuthCallback> {
        let url = url::Url::parse(s).expect("test URL parses");
        parse_auth_deep_link(&url)
    }

    #[test]
    fn auth_deep_link_happy_path() {
        let cb = parse_auth(&scheme_url("auth?token=VnL2UnrwPyN6EXlZ")).expect("parses");
        assert_eq!(cb.token, "VnL2UnrwPyN6EXlZ");
    }

    #[test]
    fn auth_deep_link_rejects_wrong_scheme() {
        assert!(parse_auth("https://auth?token=abc").is_none());
        // A scheme that merely shares a prefix with the expected one must
        // still be rejected (exact-match on scheme).
        assert!(parse_auth(&format!("{}-x://auth?token=abc", DEEP_LINK_SCHEME)).is_none());
    }

    #[test]
    fn auth_deep_link_rejects_wrong_host() {
        // The configure carrier must not be mistaken for an auth callback.
        assert!(parse_auth(&scheme_url("configure?token=abc")).is_none());
    }

    #[test]
    fn auth_deep_link_rejects_missing_or_empty_token() {
        assert!(parse_auth(&scheme_url("auth")).is_none());
        assert!(parse_auth(&scheme_url("auth?token=")).is_none());
        assert!(parse_auth(&scheme_url("auth?other=x")).is_none());
    }

    #[test]
    fn auth_deep_link_url_encoded_token_decodes() {
        // Magic tokens are base64url; if a `+` or `/` ever slips in it arrives
        // percent-encoded and query_pairs() must decode it.
        let cb = parse_auth(&scheme_url("auth?token=ab%2Bcd%2Fef%3D"))
            .expect("encoded token parses");
        assert_eq!(cb.token, "ab+cd/ef=");
    }

    #[test]
    fn auth_deep_link_ignores_extra_query_params() {
        let cb = parse_auth(&scheme_url("auth?token=abc123&future=xyz"))
            .expect("extra params tolerated");
        assert_eq!(cb.token, "abc123");
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
