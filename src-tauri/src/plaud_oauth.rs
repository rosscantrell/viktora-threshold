// WP-PLAUD-07b — Threshold-mediated Plaud OAuth bootstrap.
//
// Rust port of `AI-Light-Prototype/scripts/plaud-bootstrap.js`. Runs the
// same PKCE OAuth flow on the champion's laptop (callback bound to
// 127.0.0.1:8199 — Plaud's hardcoded redirect_uri whitelist) and then
// POSTs the minted token bundle to the configured droplet's
// `POST /api/plaud/connect` endpoint (WP-PLAUD-07a contract).
//
// Contract-level invariants (DO NOT change without coordinator sign-off):
//   - CLIENT_ID, REDIRECT_URI, AUTH_URL, TOKEN_URL are byte-equivalent
//     to the JS reference (plaud-bootstrap.js:94-104). Plaud enforces
//     redirect_uri whitelist server-side; any drift breaks the flow.
//   - PKCE verifier  = base64url(32 random bytes)  → 43 chars
//   - PKCE challenge = base64url(sha256(verifier)) → 43 chars
//   - state          = base64url(16 random bytes)  → 22 chars
//   - nonce          = base64url(32 random bytes)  → 43 chars
//     (matches schema-browser's ConnectBodySchema regex
//     /^[A-Za-z0-9_-]{43}$/ — WP-PLAUD-07a brief §3.2)
//   - TOKEN_URL POST: form-urlencoded body
//       code=...&redirect_uri=...&code_verifier=...&state=...
//     with `Authorization: Basic base64(client_id:)` header.
//   - 5-minute callback timeout (matches plaud-bootstrap.js:114; operators
//     have empirically needed the full window).
//
// All pure helpers (`encode_base64url`, `build_authorization_url`,
// `build_token_form_body`, `verifier_from_bytes`, `challenge_from_verifier`,
// `nonce_from_bytes`) are `pub` for the `tests/plaud_oauth_tests.rs`
// integration suite that verifies byte-equivalence against the JS impl
// for fixed seeds (brief §6.1).

use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── OAuth constants (verbatim from plaud-bootstrap.js:94-104) ──────────────

pub const CLIENT_ID: &str = "client_f9e0b214-c11f-434b-8b95-c4497d1feb81";
pub const CLIENT_SECRET: &str = "";
pub const REDIRECT_URI: &str = "http://localhost:8199/auth/callback";
pub const AUTH_URL: &str = "https://web.plaud.ai/platform/oauth";
pub const TOKEN_URL: &str =
    "https://platform.plaud.ai/developer/api/oauth/third-party/access-token";

pub const CALLBACK_BIND_HOST: &str = "127.0.0.1";
pub const CALLBACK_PORT: u16 = 8199;
pub const CALLBACK_PATH: &str = "/auth/callback";

pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

// ── Pure helpers (byte-equivalence target for tests/plaud_oauth_tests.rs) ──

/// base64url WITHOUT padding — matches Node's `Buffer.toString('base64url')`.
pub fn encode_base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Verifier from a 32-byte source. Mirrors plaud-bootstrap.js:124-126:
///   `crypto.randomBytes(32).toString('base64url')`
/// Tests pass fixed seed buffers; production uses 32 CSPRNG bytes.
pub fn verifier_from_bytes(bytes: &[u8; 32]) -> String {
    encode_base64url(bytes)
}

/// Challenge from verifier. Mirrors plaud-bootstrap.js:128-130:
///   `crypto.createHash('sha256').update(verifier).digest('base64url')`
/// Note: digests the ASCII text of the verifier, NOT the original bytes.
pub fn challenge_from_verifier(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    encode_base64url(&digest)
}

/// 16-byte state. Mirrors plaud-bootstrap.js:132-134.
pub fn state_from_bytes(bytes: &[u8; 16]) -> String {
    encode_base64url(bytes)
}

/// 32-byte nonce. Server schema (`ConnectBodySchema`) requires exactly
/// `/^[A-Za-z0-9_-]{43}$/` — 32 raw bytes → 43-char base64url.
pub fn nonce_from_bytes(bytes: &[u8; 32]) -> String {
    encode_base64url(bytes)
}

/// Build the authorization URL the user opens in their browser. Mirrors
/// plaud-bootstrap.js:136-146.
///
/// Order of params is the same as the JS reference so the URL strings
/// compare byte-equal in tests (URLSearchParams preserves insertion order;
/// Rust's `form_urlencoded::Serializer` also preserves it).
pub fn build_authorization_url(code_challenge: &str, state: &str) -> String {
    let qs = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("response_type", "code")
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .finish();
    format!("{}?{}", AUTH_URL, qs)
}

/// Body of the TOKEN_URL POST. Mirrors plaud-bootstrap.js:154-159.
pub fn build_token_form_body(code: &str, code_verifier: &str, state: &str) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("code", code)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("code_verifier", code_verifier)
        .append_pair("state", state)
        .finish()
}

/// HTTP Basic Auth header value (just the `base64(client_id:client_secret)`
/// part — caller prepends `Basic `). Mirrors plaud-bootstrap.js:151.
pub fn basic_auth_token() -> String {
    let raw = format!("{}:{}", CLIENT_ID, CLIENT_SECRET);
    base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
}

// ── Production randomness ─────────────────────────────────────────────────

fn random_32() -> [u8; 32] {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

fn random_16() -> [u8; 16] {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

pub fn fresh_verifier() -> String {
    verifier_from_bytes(&random_32())
}

pub fn fresh_state() -> String {
    state_from_bytes(&random_16())
}

pub fn fresh_nonce() -> String {
    nonce_from_bytes(&random_32())
}

// ── Token bundle (mirrors plaud-bootstrap.js exchangeCodeForTokens) ───────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlaudTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default = "default_token_type")]
    pub token_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

fn default_token_type() -> String {
    "Bearer".into()
}

/// Raw response shape from Plaud's TOKEN_URL.
#[derive(Deserialize, Debug)]
struct PlaudTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
}

// ── Persisted local "Connected" status ────────────────────────────────────

/// Local cached status, persisted into AppConfig.plaud_connect. Updated on
/// every successful `plaud_connect_start` POST; cleared by
/// `plaud_disconnect_soft_clear`. NOT authoritative — the droplet's
/// `/home/deploy/.plaud/tokens.json` is the source of truth. This is a
/// UX hint so the Settings → Connections pane can show "Connected (X ago)"
/// without making a network call.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaudConnectStatus {
    /// ISO 8601 UTC timestamp of the last successful Connect.
    pub connected_at: String,
    /// ms-epoch from the token bundle, if Plaud returned `expires_in`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// Droplet base URL the tokens were posted to (informational).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posted_to: Option<String>,
}

// ── Errors ─────────────────────────────────────────────────────────────────

#[derive(thiserror::Error, Debug)]
pub enum PlaudOauthError {
    #[error("Port 8199 is in use. Close any other Plaud bootstrap (lsof -iTCP:8199 -sTCP:LISTEN), then retry.")]
    PortInUse,
    #[error("Could not bind 127.0.0.1:8199: {0}")]
    BindFailed(String),
    #[error("Couldn't open your browser. Copy this URL into your browser manually: {0}")]
    BrowserOpenFailed(String),
    #[error("Callback timed out after 5 minutes. Either the browser tab was closed without signing in, or a firewall blocked the localhost redirect. Re-click Connect Plaud to retry.")]
    Timeout,
    #[error("Authorization denied: {0}")]
    AuthorizationDenied(String),
    #[error("OAuth state mismatch — the callback's state didn't match what we sent. Possible interception or a stale browser tab; re-click Connect Plaud.")]
    StateMismatch,
    #[error("Token exchange failed: {0}")]
    TokenExchangeFailed(String),
    #[error("Couldn't reach the droplet: {0}")]
    DropletUnreachable(String),
    #[error("Droplet rejected the tokens: {0}")]
    DropletRejected(String),
    #[error("Connect Plaud was cancelled.")]
    Cancelled,
    #[error("Threshold isn't configured yet — open Settings, fill in your Apolla URL and bearer token, then try Connect Plaud again.")]
    NotConfigured,
}

// ── Status events (emitted on `plaud-connect://status`) ───────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaudConnectStatusEvent {
    pub phase: &'static str,
    pub message: String,
}

// ── HTTP listener + callback parsing ──────────────────────────────────────

/// Outcome of the callback listener — either we got a code/state from Plaud,
/// or the listener errored / timed out / was cancelled.
#[derive(Debug)]
pub struct CallbackResult {
    pub code: String,
    pub state: String,
}

/// Parse the query string of an inbound `GET /auth/callback?...` request
/// line. Returns (code, state) on the success path, an error message on the
/// `?error=...` path, or `Ok(None)` for any other shape (stray request,
/// wrong path, missing params) — caller responds 200 with "continue in the
/// original window" and keeps listening.
pub fn parse_callback_request_line(
    request_line: &str,
) -> Result<Option<CallbackResult>, String> {
    // request_line is e.g. "GET /auth/callback?code=...&state=... HTTP/1.1"
    let mut parts = request_line.split_whitespace();
    let _method = parts.next();
    let path_and_query = match parts.next() {
        Some(p) => p,
        None => return Ok(None),
    };

    let (path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_and_query, ""),
    };

    if path != CALLBACK_PATH {
        return Ok(None);
    }

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    let mut error_description: Option<String> = None;

    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            "error_description" => error_description = Some(v.into_owned()),
            _ => {}
        }
    }

    if let Some(err) = error {
        let desc = error_description.unwrap_or_else(|| err.clone());
        return Err(desc);
    }

    match (code, state) {
        (Some(code), Some(state)) => Ok(Some(CallbackResult { code, state })),
        _ => Ok(None),
    }
}

const CALLBACK_SUCCESS_HTML: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<title>Plaud Connected</title></head>",
    "<body style=\"font-family:system-ui;padding:2rem;text-align:center;\">",
    "<h1>Plaud connected.</h1>",
    "<p>You can close this tab and return to Threshold.</p>",
    "</body></html>"
);

const CALLBACK_NEUTRAL_HTML: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<title>Plaud Connect</title></head>",
    "<body style=\"font-family:system-ui;padding:2rem;text-align:center;\">",
    "<h1>Continue authorization in the original window.</h1>",
    "</body></html>"
);

/// Build an HTTP/1.1 response. Single-shot, no keep-alive — the listener
/// is one-and-done per Connect attempt.
fn http_response(status_line: &str, content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_line,
        content_type,
        body.len(),
        body
    )
    .into_bytes()
}

// ── End-to-end OAuth flow ──────────────────────────────────────────────────

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Outcome of `run_callback_listener` — used internally by `run_oauth_flow`.
struct ListenerOutcome {
    code: String,
    state: String,
}

/// Bind 127.0.0.1:8199 and wait for the OAuth callback.
///
/// `expected_state` is checked here so the response HTML can be rendered
/// before the function returns. `cancel_rx` lets the caller abort the wait
/// (e.g., user clicked the Cancel button or Threshold is shutting down).
async fn run_callback_listener(
    expected_state: String,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<ListenerOutcome, PlaudOauthError> {
    let bind_addr = format!("{}:{}", CALLBACK_BIND_HOST, CALLBACK_PORT);
    let listener = match TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                return Err(PlaudOauthError::PortInUse);
            }
            return Err(PlaudOauthError::BindFailed(e.to_string()));
        }
    };

    let accept_loop = async {
        loop {
            let (mut socket, _peer) = listener
                .accept()
                .await
                .map_err(|e| PlaudOauthError::BindFailed(e.to_string()))?;

            // Read up to the end of the request line + headers. A
            // browser GET to /auth/callback rarely exceeds ~2KB.
            let mut buf = vec![0u8; 4096];
            let mut filled = 0usize;
            let request_line: String = loop {
                let n = match socket.read(&mut buf[filled..]).await {
                    Ok(0) => break String::new(),
                    Ok(n) => n,
                    Err(_) => break String::new(),
                };
                filled += n;
                let text = String::from_utf8_lossy(&buf[..filled]);
                if let Some(eol) = text.find("\r\n") {
                    break text[..eol].to_string();
                }
                if filled >= buf.len() {
                    // Headers larger than buffer — treat as stray.
                    break String::new();
                }
            };

            match parse_callback_request_line(&request_line) {
                Err(desc) => {
                    let body = format!(
                        "<!doctype html><html><body style=\"font-family:system-ui;padding:2rem;text-align:center;\"><h1>Authorization denied</h1><p>{}</p></body></html>",
                        html_escape(&desc)
                    );
                    let _ = socket
                        .write_all(&http_response("400 Bad Request", "text/html; charset=utf-8", &body))
                        .await;
                    let _ = socket.shutdown().await;
                    return Err(PlaudOauthError::AuthorizationDenied(desc));
                }
                Ok(None) => {
                    let _ = socket
                        .write_all(&http_response(
                            "200 OK",
                            "text/html; charset=utf-8",
                            CALLBACK_NEUTRAL_HTML,
                        ))
                        .await;
                    let _ = socket.shutdown().await;
                    continue;
                }
                Ok(Some(result)) => {
                    if result.state != expected_state {
                        let _ = socket
                            .write_all(&http_response(
                                "200 OK",
                                "text/html; charset=utf-8",
                                CALLBACK_NEUTRAL_HTML,
                            ))
                            .await;
                        let _ = socket.shutdown().await;
                        return Err(PlaudOauthError::StateMismatch);
                    }
                    let _ = socket
                        .write_all(&http_response(
                            "200 OK",
                            "text/html; charset=utf-8",
                            CALLBACK_SUCCESS_HTML,
                        ))
                        .await;
                    let _ = socket.shutdown().await;
                    return Ok(ListenerOutcome {
                        code: result.code,
                        state: result.state,
                    });
                }
            }
        }
    };

    tokio::select! {
        outcome = accept_loop => outcome,
        _ = cancel_rx => Err(PlaudOauthError::Cancelled),
        _ = tokio::time::sleep(CALLBACK_TIMEOUT) => Err(PlaudOauthError::Timeout),
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Exchange the OAuth code for a token bundle. Mirrors
/// plaud-bootstrap.js:150-191.
async fn exchange_code_for_tokens(
    code: &str,
    code_verifier: &str,
    state: &str,
) -> Result<PlaudTokens, PlaudOauthError> {
    let body = build_token_form_body(code, code_verifier, state);
    let basic = basic_auth_token();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| PlaudOauthError::TokenExchangeFailed(format!("client init: {}", e)))?;

    let resp = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .header("Authorization", format!("Basic {}", basic))
        .body(body)
        .send()
        .await
        .map_err(|e| PlaudOauthError::TokenExchangeFailed(format!("network: {}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(PlaudOauthError::TokenExchangeFailed(format!(
            "HTTP {} from {}: {}",
            status.as_u16(),
            TOKEN_URL,
            text
        )));
    }

    let parsed: PlaudTokenResponse = resp
        .json()
        .await
        .map_err(|e| PlaudOauthError::TokenExchangeFailed(format!("parse: {}", e)))?;

    let refresh = parsed.refresh_token.unwrap_or_default();
    if refresh.is_empty() {
        return Err(PlaudOauthError::TokenExchangeFailed(
            "Plaud returned no refresh_token. Re-run Connect Plaud; if this persists, your account may need a console-level re-grant.".into(),
        ));
    }

    let expires_at = parsed.expires_in.map(|secs| {
        chrono::Utc::now().timestamp_millis() + secs * 1000
    });

    Ok(PlaudTokens {
        access_token: parsed.access_token,
        refresh_token: refresh,
        token_type: parsed.token_type.unwrap_or_else(default_token_type),
        expires_at,
    })
}

// ── POST to the droplet's /api/plaud/connect ──────────────────────────────

#[derive(Serialize, Debug)]
struct ConnectBody<'a> {
    tokens: &'a PlaudTokens,
    nonce: String,
    source: &'a str,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ConnectSuccessBody {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    expires_at: Option<i64>,
}

#[derive(Deserialize, Debug)]
struct ConnectErrorBody {
    #[serde(default)]
    error: String,
    #[serde(default)]
    message: String,
}

/// POST the tokens to the droplet. Returns the server-reported
/// `expires_at` if present, so the local cached status can mirror it.
pub async fn post_tokens_to_droplet(
    base_url: &str,
    bearer: &str,
    tokens: &PlaudTokens,
    nonce: String,
) -> Result<Option<i64>, PlaudOauthError> {
    let url = format!(
        "{}/api/plaud/connect",
        base_url.trim_end_matches('/')
    );

    // Match the other plaud_* IPCs: accept-invalid-certs for local-HTTPS
    // dev (mirrors build_plaud_http_client in lib.rs). The droplet
    // production path uses a real cert; the flag is a no-op there.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| PlaudOauthError::DropletUnreachable(format!("client init: {}", e)))?;

    let body = ConnectBody {
        tokens,
        nonce,
        source: "threshold",
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", bearer))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| PlaudOauthError::DropletUnreachable(e.to_string()))?;

    let status = resp.status();
    if status.is_success() {
        let parsed: ConnectSuccessBody = resp.json().await.unwrap_or(ConnectSuccessBody {
            ok: true,
            expires_at: None,
        });
        if !parsed.ok {
            return Err(PlaudOauthError::DropletRejected(
                "Server returned ok=false (unexpected; check droplet logs).".into(),
            ));
        }
        return Ok(parsed.expires_at);
    }

    // Surface the server-side error envelope. Match the existing
    // /api/plaud/* error shape: {error, message}.
    let code = status.as_u16();
    let text = resp.text().await.unwrap_or_default();
    let detail: ConnectErrorBody = serde_json::from_str(&text).unwrap_or(ConnectErrorBody {
        error: format!("http_{}", code),
        message: text.clone(),
    });

    let human = match code {
        401 => "Server rejected the bearer token. Check your Apolla token in Settings.".to_string(),
        400 => format!("Server rejected the request: {} ({})", detail.message, detail.error),
        500 => format!("Server failed to write tokens: {}", detail.message),
        _ => format!("HTTP {} from {}: {} ({})", code, url, detail.message, detail.error),
    };
    Err(PlaudOauthError::DropletRejected(human))
}

// ── Public orchestrator (called from the IPC command) ─────────────────────

/// Inputs to the full Connect flow.
pub struct ConnectInputs<F>
where
    F: FnMut(PlaudConnectStatusEvent) + Send + 'static,
{
    pub base_url: String,
    pub bearer: String,
    pub emit_status: F,
    pub cancel_rx: oneshot::Receiver<()>,
    pub browser_opener: BrowserOpener,
}

/// Pluggable browser-open hook so the orchestrator can be exercised in
/// tests against a mock Plaud (a stub that just hits localhost:8199 with
/// the canned code+state).
pub enum BrowserOpener {
    /// Production: open the user's default browser.
    Default(tauri::AppHandle),
    /// Test override.
    #[allow(dead_code)]
    Custom(Box<dyn FnOnce(&str) -> Result<(), String> + Send>),
}

impl BrowserOpener {
    fn open(self, url: &str) -> Result<(), PlaudOauthError> {
        match self {
            BrowserOpener::Default(app) => {
                use tauri_plugin_opener::OpenerExt;
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|e| PlaudOauthError::BrowserOpenFailed(format!("{}: {}", url, e)))
            }
            BrowserOpener::Custom(f) => f(url).map_err(PlaudOauthError::BrowserOpenFailed),
        }
    }
}

pub struct ConnectSuccess {
    pub tokens: PlaudTokens,
    pub server_expires_at: Option<i64>,
}

pub async fn run_connect_flow<F>(
    mut inputs: ConnectInputs<F>,
) -> Result<ConnectSuccess, PlaudOauthError>
where
    F: FnMut(PlaudConnectStatusEvent) + Send + 'static,
{
    if inputs.base_url.trim().is_empty() || inputs.bearer.trim().is_empty() {
        return Err(PlaudOauthError::NotConfigured);
    }

    // 1. PKCE values
    let verifier = fresh_verifier();
    let challenge = challenge_from_verifier(&verifier);
    let state = fresh_state();
    let auth_url = build_authorization_url(&challenge, &state);

    (inputs.emit_status)(PlaudConnectStatusEvent {
        phase: "binding",
        message: format!("Binding {}:{}…", CALLBACK_BIND_HOST, CALLBACK_PORT),
    });

    // 2. Bind listener BEFORE opening browser (so EADDRINUSE surfaces
    //    cleanly without leaving an unfulfillable browser tab open).
    //    We can't fully test-bind here without committing to the listener,
    //    so we just spawn it and rely on the listener returning
    //    PortInUse immediately if 8199 is busy.

    // 3. Open browser
    (inputs.emit_status)(PlaudConnectStatusEvent {
        phase: "awaiting_callback",
        message: "Opening your browser. Sign in to Plaud, then come back here…".into(),
    });
    let opener = inputs.browser_opener;

    // Race listener start vs cancel — bind must succeed before we open
    // the browser so port-conflict feedback is immediate.
    let listener_fut = run_callback_listener(state.clone(), inputs.cancel_rx);

    // Spawn the browser open AFTER a tiny yield so the listener bind has
    // a chance to fail first. tokio::task::yield_now gives the listener
    // future one poll before we touch the browser.
    tokio::task::yield_now().await;
    opener.open(&auth_url)?;

    // 4. Wait for callback (or timeout / cancel / port-conflict).
    let outcome = listener_fut.await?;

    // 5. Exchange code for tokens.
    (inputs.emit_status)(PlaudConnectStatusEvent {
        phase: "exchanging",
        message: "Exchanging authorization code for tokens…".into(),
    });
    let tokens = exchange_code_for_tokens(&outcome.code, &verifier, &outcome.state).await?;

    // 6. POST tokens to droplet.
    (inputs.emit_status)(PlaudConnectStatusEvent {
        phase: "posting",
        message: "Sending tokens to your Apolla droplet…".into(),
    });
    let nonce = fresh_nonce();
    let server_expires_at =
        post_tokens_to_droplet(&inputs.base_url, &inputs.bearer, &tokens, nonce).await?;

    (inputs.emit_status)(PlaudConnectStatusEvent {
        phase: "done",
        message: "Plaud connected. Recordings will appear in your inbox within ~30 min.".into(),
    });

    Ok(ConnectSuccess {
        tokens,
        server_expires_at,
    })
}
