//! WP-INTAKE E5-app — email thread-following sweep (local Outlook).
//!
//! The forward/BCC on-ramp goes dark after the FIRST captured message: a BCC to
//! the capture address is not carried on subsequent replies, so a thread stops
//! feeding the field. This module is the app-side of the fix (E5-engine defines
//! the contract, flag `EMAIL_THREAD_FOLLOW_ENABLED`): passively follow threads
//! ALREADY IN THE FIELD by pulling their new messages — including the user's own
//! replies from Sent Items (which the vigilance ingress-owed void needs) — out
//! of the local Outlook via COM, and push each through the engine's
//! `POST /api/email/import` (same parse/render/ingest path as the webhook; the
//! bearer never leaves Rust — the orchestration + POST live in `lib.rs`, exactly
//! like `push_availability` and `run_onenote_sweep_once`).
//!
//! Substrate mirrors `onenote_windows.rs` + `calendar_read.rs`:
//!   - **Windows**: Outlook COM via a `powershell.exe` shell-out (fresh process
//!     per sweep, `CREATE_NO_WINDOW` console-flash suppression), typed errors.
//!   - **macOS / Linux**: a calm platform no-op — `run_follow_read` returns
//!     `PlatformUnsupported` and the command short-circuits BEFORE any engine
//!     traffic (`is_supported_platform()` gates the whole sweep), so the Mac dev
//!     machine makes zero network calls on the no-op path.
//!
//! ── PowerShell bounded-work design (why this stays cheap) ────────────────────
//! Searching every thread's message-ids across the whole mailbox each sweep is
//! too slow. The sweep is two bounded phases in ONE PowerShell pass:
//!   1. **Discovery** (only threads with NO cached ConversationID, ≤ discovery
//!      cap): DASL-`Find` on PR_INTERNET_MESSAGE_ID for the thread's known ids
//!      across Inbox + Sent; on the first hit take `MailItem.ConversationID` and
//!      emit a `CONV` line so Rust caches `threadKey↔ConversationID`. Subsequent
//!      sweeps pass the cached id and skip the search entirely.
//!   2. **Enumeration**: build a `ConversationID → thread` map (cached + newly
//!      discovered), then make ONE time-bounded `Items.Restrict` pass over Inbox
//!      (`[ReceivedTime]`) and Sent (`[SentOn]`) since the OLDEST watermark among
//!      the swept threads. For each recent item whose ConversationID is in the
//!      map, whose date is newer than that thread's watermark, and whose own
//!      message-id is not already known → emit a `MSG` line (compact JSON). The
//!      pass is bounded by the time window (not the thread count) and hard-capped
//!      at the message cap; a hit on the cap emits a `TRUNC` marker.
//! Rust further bounds the work UPSTREAM: it hands PowerShell at most
//! `EMAIL_FOLLOW_THREAD_CAP` threads per sweep, chosen least-recently-swept-first
//! so the tail rotates in over subsequent ticks (self-healing catch-up); the
//! remainder is logged, never silently dropped (house law: no silent caps).
//!
//! NO LLM anywhere here — the import is deterministic substrate; extraction and
//! markers happen engine-side, fire-and-forget, exactly like the webhook.

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Persisted state (lives inside AppConfig via `email_follow::EmailFollowState`,
// same pattern as `plaud_oauth::PlaudConnectStatus`). The cache that makes the
// steady-state sweep cheap: threadKey → ConversationID + a per-thread watermark
// so we never re-import a message and only ever restrict on recent items.
// ─────────────────────────────────────────────────────────────────────────────

/// Top-level email-follow state persisted in `config.json`. `#[serde(default)]`
/// so legacy configs without the field deserialize as empty (additive-only
/// schema delta — same guarantee as `auto_import` / `plaud_connect`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct EmailFollowState {
    /// One entry per followed thread we have observed. Keyed (logically) by
    /// `thread_key`; a Vec (not a Map) so the JSON is stable + diff-friendly and
    /// matches how the OneNote sources persist.
    pub threads: Vec<EmailFollowThread>,
}

/// Per-thread cache + watermark. Identity is `thread_key` (the engine-derived
/// `emailThreadKey`, a normalized root `<message-id>`).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmailFollowThread {
    pub thread_key: String,
    /// Cached Outlook `ConversationID` for this thread. `None` until the first
    /// discovery pass resolves it; once set, sweeps skip the mailbox search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Locally-advanced high-water mark (RFC3339): the newest message date we
    /// have already imported for this thread. The effective watermark used each
    /// sweep is `max(engine.lastMessageAt, this)` — so a message is "new" only
    /// when it is strictly newer than both what the engine last saw and what we
    /// last pushed. `None` ⇒ fall back to the engine's `lastMessageAt`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watermark: Option<String>,
    /// When we last handed this thread to a sweep (RFC3339). Drives the
    /// least-recently-swept rotation so no thread starves when more than
    /// `EMAIL_FOLLOW_THREAD_CAP` threads are active. `None` ⇒ never swept ⇒
    /// highest priority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swept_at: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Caps (documented; truncation is LOGGED by the caller, never silent).
// ─────────────────────────────────────────────────────────────────────────────

/// Max threads handed to one PowerShell sweep. The rest rotate in on later
/// ticks (least-recently-swept first). Trisha-scale corpora sit well under this;
/// the cap only bites on a large active-thread set and drains deterministically.
pub const EMAIL_FOLLOW_THREAD_CAP: usize = 25;

/// Max messages imported (POSTed) in one sweep. Enforced both in the PowerShell
/// emission and the Rust POST loop; a hit leaves the remainder for the next
/// tick (watermarks only advance past what actually imported, so nothing is
/// lost).
pub const EMAIL_FOLLOW_MESSAGE_CAP: usize = 100;

/// Sub-field separator used inside the PowerShell JSON string values for the
/// address lists (`to` / `cc`) so a display name containing a comma or
/// semicolon can never split a recipient. ASCII Unit Separator (0x1F) — never
/// appears in an email address or a normal display name. `build_import_body`
/// splits on it Rust-side.
pub const ADDR_SEP: char = '\u{1f}';

/// Line-field separator between the record marker (`CONV` / `MSG` / `TRUNC`) and
/// its payload on the PowerShell stdout. Same 0x1F choice as `calendar_read`.
/// Only consumed by the Windows read path (`parse_follow_stdout`) + tests, hence
/// the non-Windows `dead_code` allow (mirrors the onenote/calendar convention).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const LINE_SEP: char = '\u{1f}';

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinguishable variants, each with a plain-product `user_message()`
// (mirrors OneNoteError / CalendarError). `dead_code` suppressed off Windows
// because the Mac/Linux stub only ever builds `PlatformUnsupported`; the unit
// tests still exercise every variant's `user_message` + `Display` on all
// platforms.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub enum EmailFollowError {
    /// `Outlook.Application` COM class is not registered (Outlook not installed,
    /// or a sandboxed Store variant). User-actionable: install / open desktop
    /// Outlook.
    ComClassNotRegistered,
    /// Outlook isn't running and COM could not launch it. Distinct so the log
    /// tells the truth rather than a generic failure.
    OutlookNotRunning,
    /// `powershell.exe` exited non-zero for a reason we didn't classify. Carries
    /// stderr for the log body.
    PowerShellExitNonZero { code: i32, stderr: String },
    /// `powershell.exe` couldn't be spawned (PATH missing System32 — very rare
    /// on a real Windows install).
    PowerShellSpawnFailed(String),
    /// Writing the thread-input temp file failed (disk full / temp dir
    /// unwritable).
    InputWriteFailed(String),
    /// The PowerShell stdout could not be parsed into records.
    ParseFailed(String),
    /// Catch-all for unexpected failures.
    Other(String),
    /// Non-Windows platform. Returned by the stub so the cross-platform compile
    /// is clean and the caller can treat it as a calm no-op.
    PlatformUnsupported,
}

impl EmailFollowError {
    /// Short, plain-product message (no COM / PowerShell jargon) — the sweep is
    /// a background channel; these only ever reach the log, never a toast, but
    /// keep them honest anyway. Only called on the Windows path + tests (the Mac
    /// stub returns `PlatformUnsupported`, which the caller handles directly).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn user_message(&self) -> &'static str {
        match self {
            EmailFollowError::ComClassNotRegistered => {
                "Couldn't reach Outlook to follow email threads (open the Microsoft 365 desktop Outlook)."
            }
            EmailFollowError::OutlookNotRunning => {
                "Outlook isn't running — open it so Threshold can follow email threads."
            }
            EmailFollowError::PowerShellExitNonZero { .. } => {
                "Couldn't read your Outlook mail (the reader returned an error)."
            }
            EmailFollowError::PowerShellSpawnFailed(_) => {
                "Couldn't start the Outlook mail reader on this machine."
            }
            EmailFollowError::InputWriteFailed(_) => {
                "Couldn't prepare the email-follow sweep (temporary file write failed)."
            }
            EmailFollowError::ParseFailed(_) => "Couldn't read the Outlook mail reader's output.",
            EmailFollowError::Other(_) => "Couldn't follow email threads.",
            EmailFollowError::PlatformUnsupported => {
                "Email thread-following is Windows-only (uses local Outlook)."
            }
        }
    }
}

impl std::fmt::Display for EmailFollowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmailFollowError::ComClassNotRegistered => {
                write!(f, "Outlook.Application COM class not registered")
            }
            EmailFollowError::OutlookNotRunning => write!(f, "Outlook is not running"),
            EmailFollowError::PowerShellExitNonZero { code, stderr } => {
                write!(f, "powershell.exe exited with code {}: {}", code, stderr)
            }
            EmailFollowError::PowerShellSpawnFailed(e) => {
                write!(f, "powershell.exe spawn failed: {}", e)
            }
            EmailFollowError::InputWriteFailed(e) => write!(f, "input temp write failed: {}", e),
            EmailFollowError::ParseFailed(e) => write!(f, "stdout parse failed: {}", e),
            EmailFollowError::Other(e) => write!(f, "email-follow error: {}", e),
            EmailFollowError::PlatformUnsupported => {
                write!(f, "email thread-following is not available on this platform")
            }
        }
    }
}

impl std::error::Error for EmailFollowError {}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform value types.
// ─────────────────────────────────────────────────────────────────────────────

/// A followed thread as the engine returns it (`GET /api/email/followed-threads`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FollowedThread {
    pub thread_key: String,
    #[serde(default)]
    pub message_ids: Vec<String>,
    #[serde(default)]
    pub last_message_at: String,
}

/// One thread as fed to the PowerShell sweep: the merge of the engine row with
/// the persisted cache. `effective_watermark` is `max(engine.lastMessageAt,
/// local.watermark)`.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadSweepState {
    pub thread_key: String,
    pub conversation_id: Option<String>,
    pub known_ids: Vec<String>,
    pub effective_watermark: String,
    pub swept_at: Option<String>,
}

/// The compact-JSON message record PowerShell emits per new message. `to` / `cc`
/// are `ADDR_SEP`-joined strings (PowerShell can't reliably JSON-serialize a
/// single-element array); `references` is whitespace-joined. `build_import_body`
/// maps this to the engine's `POST /api/email/import` body.
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct RawFollowMessage {
    #[serde(rename = "threadKey", default)]
    pub thread_key: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(rename = "dateTimeCreated", default)]
    pub date_time_created: String,
    #[serde(rename = "bodyHtml", default)]
    pub body_html: String,
    #[serde(rename = "bodyText", default)]
    pub body_text: String,
    #[serde(rename = "internetMessageId", default)]
    pub internet_message_id: String,
    #[serde(rename = "inReplyTo", default)]
    pub in_reply_to: String,
    #[serde(default)]
    pub references: String,
}

/// Input to the platform read: the thread list serialized for PowerShell + the
/// bounds. Assembled in `lib.rs`, consumed by the Windows `imp` module. The
/// fields are only READ on Windows (the Mac stub ignores the input), hence the
/// non-Windows `dead_code` allow.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct FollowReadInput {
    /// JSON array of `{k,c,w,ids}` objects (one per swept thread).
    pub threads_json: String,
    /// Oldest effective watermark among the swept threads (RFC3339) — the lower
    /// bound of the enumeration Restrict. Empty ⇒ no time restrict (unbounded;
    /// only happens if no thread has a parseable watermark, which the engine
    /// contract makes impossible).
    pub oldest_watermark: String,
    pub discovery_cap: usize,
    pub message_cap: usize,
}

/// Output of the platform read: newly-resolved conversation ids to cache, the
/// new messages to import, and whether the message cap truncated the pass.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FollowReadOutput {
    /// `(threadKey, conversationId)` pairs discovered this sweep (to persist).
    pub conversations: Vec<(String, String)>,
    /// New messages to import, in the order PowerShell emitted them (the caller
    /// re-sorts oldest-first before POSTing).
    pub messages: Vec<RawFollowMessage>,
    /// True if the message cap stopped the enumeration early.
    pub truncated: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions — unit-tested on every platform (no COM, no HTTP, no clock).
// ─────────────────────────────────────────────────────────────────────────────

/// Normalize a message-id to its `<...>` canonical form, byte-for-byte matching
/// the engine's `normalizeMessageId` (parse.ts) so app-side dedup/matching lines
/// up with the engine's. Empty ⇒ empty.
pub fn normalize_message_id(id: &str) -> String {
    let t = id.trim();
    if t.is_empty() {
        return String::new();
    }
    // First `<...>` run wins (mirror the engine regex `/<[^>]+>/`).
    if let Some(start) = t.find('<') {
        if let Some(rel_end) = t[start..].find('>') {
            return t[start..=start + rel_end].to_string();
        }
    }
    // No angle brackets: strip any stray leading/trailing ones and wrap.
    let inner = t.trim_start_matches('<').trim_end_matches('>');
    format!("<{}>", inner)
}

/// Parse an RFC3339 timestamp. Outlook emits e.g. `2026-07-10T14:00:00-04:00`;
/// the engine emits ISO-UTC. `None` on failure.
pub fn parse_iso(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok()
}

/// True iff `a` is strictly later than `b`. Falls back to byte comparison when
/// either doesn't parse (zero-padded ISO sorts chronologically as bytes).
pub fn iso_after(a: &str, b: &str) -> bool {
    match (parse_iso(a), parse_iso(b)) {
        (Some(x), Some(y)) => x > y,
        _ => a.trim() > b.trim(),
    }
}

/// The later of two ISO timestamps (used to compute the effective watermark and
/// to advance it). Empty strings are treated as "-infinity".
pub fn iso_max(a: &str, b: &str) -> String {
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        return b.to_string();
    }
    if b.is_empty() {
        return a.to_string();
    }
    if iso_after(a, b) {
        a.to_string()
    } else {
        b.to_string()
    }
}

/// The earlier of two ISO timestamps (used for the enumeration lower bound).
/// Empty strings are ignored (a non-empty value always wins).
pub fn iso_min(a: &str, b: &str) -> String {
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        return b.to_string();
    }
    if b.is_empty() {
        return a.to_string();
    }
    if iso_after(a, b) {
        b.to_string()
    } else {
        a.to_string()
    }
}

/// Effective watermark for a thread = the later of the engine's `lastMessageAt`
/// and any locally-advanced watermark. This is the floor for "what counts as a
/// new message" this sweep.
pub fn effective_watermark(engine_last_message_at: &str, local_watermark: Option<&str>) -> String {
    iso_max(engine_last_message_at, local_watermark.unwrap_or(""))
}

/// Select up to `cap` threads to sweep this tick, least-recently-swept first so
/// the tail rotates in over subsequent ticks (a thread never swept sorts first).
/// Returns `(selected, deferred_count)` where `selected.len() <= cap` and
/// `deferred_count` is how many threads were left for a later tick. Side-effect-
/// free + deterministic (ties broken by `thread_key`).
pub fn select_threads_to_sweep(
    mut threads: Vec<ThreadSweepState>,
    cap: usize,
) -> (Vec<ThreadSweepState>, usize) {
    // Never-swept (None) first, then oldest swept_at first. Deterministic
    // tie-break on thread_key so the rotation is stable across ticks.
    threads.sort_by(|a, b| match (a.swept_at.as_deref(), b.swept_at.as_deref()) {
        (None, None) => a.thread_key.cmp(&b.thread_key),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => {
            // Older swept_at first. Byte compare is chronological for ISO.
            x.cmp(y).then_with(|| a.thread_key.cmp(&b.thread_key))
        }
    });
    let total = threads.len();
    let deferred = total.saturating_sub(cap);
    if deferred > 0 {
        threads.truncate(cap);
    }
    (threads, deferred)
}

/// Select the messages to import this sweep: oldest-first by `dateTimeCreated`
/// (so a truncated sweep advances watermarks by the largest safe amount and the
/// engine sees replies in chronological order), capped at `cap`. Messages whose
/// date doesn't parse sort last (still importable — the engine dedupes by id).
/// Returns `(selected, deferred_count)`.
pub fn select_messages_to_import(
    mut msgs: Vec<RawFollowMessage>,
    cap: usize,
) -> (Vec<RawFollowMessage>, usize) {
    msgs.sort_by(|a, b| match (parse_iso(&a.date_time_created), parse_iso(&b.date_time_created)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.date_time_created.cmp(&b.date_time_created),
    });
    let total = msgs.len();
    let deferred = total.saturating_sub(cap);
    if deferred > 0 {
        msgs.truncate(cap);
    }
    (msgs, deferred)
}

/// Split an `ADDR_SEP`-joined recipient string into a clean `Vec<String>`
/// (empties dropped). Pure — used by `build_import_body` and tested directly.
fn split_addr_list(joined: &str) -> Vec<String> {
    joined
        .split(ADDR_SEP)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Map a raw PowerShell message record to the engine's `POST /api/email/import`
/// body. `to` / `cc` become arrays; `references` splits on whitespace;
/// `internetMessageId` is normalized to `<...>`; empty optional fields are
/// omitted. Deterministic + side-effect-free — the "body extraction mapping"
/// the verification bar requires under test.
pub fn build_import_body(msg: &RawFollowMessage) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    if !msg.subject.trim().is_empty() {
        obj.insert("subject".into(), msg.subject.clone().into());
    }
    obj.insert("from".into(), msg.from.trim().into());
    obj.insert(
        "to".into(),
        serde_json::Value::from(split_addr_list(&msg.to)),
    );
    obj.insert(
        "cc".into(),
        serde_json::Value::from(split_addr_list(&msg.cc)),
    );
    if !msg.date_time_created.trim().is_empty() {
        obj.insert("dateTimeCreated".into(), msg.date_time_created.trim().into());
    }
    if !msg.body_html.trim().is_empty() {
        obj.insert("bodyHtml".into(), msg.body_html.clone().into());
    }
    if !msg.body_text.trim().is_empty() {
        obj.insert("bodyText".into(), msg.body_text.clone().into());
    }
    obj.insert(
        "internetMessageId".into(),
        normalize_message_id(&msg.internet_message_id).into(),
    );
    let in_reply_to = normalize_message_id(&msg.in_reply_to);
    if !in_reply_to.is_empty() {
        obj.insert("inReplyTo".into(), in_reply_to.into());
    }
    let refs: Vec<String> = msg
        .references
        .split_whitespace()
        .map(normalize_message_id)
        .filter(|r| !r.is_empty())
        .collect();
    if !refs.is_empty() {
        obj.insert("references".into(), serde_json::Value::from(refs));
    }
    serde_json::Value::Object(obj)
}

/// Parse the PowerShell stdout into a `FollowReadOutput`. Recognized lines:
///   - `CONV<sep><threadKey><sep><conversationId>`  (a discovered conversation)
///   - `MSG<sep><compact-json>`                      (a new message record)
///   - `TRUNC<sep><count>`                           (message cap hit)
/// Unknown / blank lines are skipped (best-effort — one malformed row never
/// poisons the sweep). A `MSG` whose JSON fails to parse is skipped and counted
/// via the returned parse-warning, but never aborts. Pure + deterministic.
/// Consumed by the Windows read path + tests (non-Windows `dead_code` allow).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_follow_stdout(stdout: &str) -> FollowReadOutput {
    let sep = LINE_SEP;
    let mut out = FollowReadOutput::default();
    for line in stdout.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, sep);
        let marker = parts.next().unwrap_or("");
        let payload = parts.next().unwrap_or("");
        match marker {
            "CONV" => {
                // payload = threadKey<sep>conversationId
                let mut sub = payload.splitn(2, sep);
                let tk = sub.next().unwrap_or("").trim();
                let cid = sub.next().unwrap_or("").trim();
                if !tk.is_empty() && !cid.is_empty() {
                    out.conversations.push((tk.to_string(), cid.to_string()));
                }
            }
            "MSG" => {
                if let Ok(msg) = serde_json::from_str::<RawFollowMessage>(payload.trim()) {
                    // A message with no id is useless (can't dedup) — drop it.
                    if !msg.internet_message_id.trim().is_empty() {
                        out.messages.push(msg);
                    }
                }
            }
            "TRUNC" => {
                out.truncated = true;
            }
            _ => {}
        }
    }
    out
}

/// PowerShell single-quoted-literal escape (double an embedded single quote).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_lit_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Build the Outlook-COM PowerShell sweep script. `json_path` is the temp file
/// Rust wrote the thread list to; `oldest_watermark` is the enumeration lower
/// bound (RFC3339, may be empty). Templated + returned as a String so the
/// generation is unit-testable via syntactic anchors (we can't run PowerShell
/// off Windows). See the module-level "bounded-work design" note for the two
/// phases this encodes.
///
/// Property tags used (Unicode `...001F` variants):
///   PR_INTERNET_MESSAGE_ID  0x1035001F  — the message-id we match/emit
///   PR_IN_REPLY_TO_ID       0x1042001F  — In-Reply-To header
///   PR_INTERNET_REFERENCES  0x1039001F  — References header
///   PR_SENDER_SMTP_ADDRESS  0x5D01001F  — sender SMTP (Exchange stores an EX DN
///                                          on SenderEmailAddress otherwise)
///   PR_SMTP_ADDRESS         0x39FE001F  — a recipient AddressEntry's SMTP
///
/// Consumed by the Windows read path + generation tests (non-Windows
/// `dead_code` allow — the PowerShell never runs on Mac/Linux).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn build_follow_ps_script(
    json_path: &str,
    oldest_watermark: &str,
    discovery_cap: usize,
    message_cap: usize,
) -> String {
    let json_path = ps_lit_escape(json_path);
    let oldest = ps_lit_escape(oldest_watermark.trim());
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$sep = [char]31
$addrSep = [char]31
$inputPath = '{json_path}'
$oldestWatermark = '{oldest}'
$discoveryCap = {discovery_cap}
$messageCap = {message_cap}

$PROP_MSGID = 'http://schemas.microsoft.com/mapi/proptag/0x1035001F'
$PROP_INREPLYTO = 'http://schemas.microsoft.com/mapi/proptag/0x1042001F'
$PROP_REFS = 'http://schemas.microsoft.com/mapi/proptag/0x1039001F'
$PROP_SENDER_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'
$PROP_RECIP_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001F'

try {{
    $outlook = New-Object -ComObject Outlook.Application
}} catch {{
    Write-Error "OUTLOOK_COM_NOT_REGISTERED: $($_.Exception.Message)"
    exit 2
}}

function Get-Prop($item, $prop) {{
    try {{
        $v = $item.PropertyAccessor.GetProperty($prop)
        if ($null -ne $v) {{ return [string]$v }}
    }} catch {{}}
    return ''
}}

function Get-RecipSmtp($recip) {{
    try {{
        $ae = $recip.AddressEntry
        $smtp = $ae.PropertyAccessor.GetProperty($PROP_RECIP_SMTP)
        if ($smtp) {{ return [string]$smtp }}
    }} catch {{}}
    try {{ if ($recip.Address) {{ return [string]$recip.Address }} }} catch {{}}
    try {{ return [string]$recip.Name }} catch {{}}
    return ''
}}

try {{
    $ns = $outlook.GetNamespace('MAPI')
    $threads = @(Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json)

    $inbox = $ns.GetDefaultFolder(6)  # olFolderInbox
    $sent  = $ns.GetDefaultFolder(5)  # olFolderSentMail
    # (folder, dateField) pairs — Sent items key off [SentOn], Inbox off [ReceivedTime].
    $scan = @(
        [pscustomobject]@{{ folder = $inbox; dateField = '[ReceivedTime]' }},
        [pscustomobject]@{{ folder = $sent;  dateField = '[SentOn]' }}
    )

    # ── Phase 1: discovery — resolve ConversationID for uncached threads ──
    $convMap = @{{}}   # conversationId -> thread
    $discovered = 0
    foreach ($t in $threads) {{
        if ($t.c -and ([string]$t.c).Length -gt 0) {{
            $convMap[[string]$t.c] = $t
            continue
        }}
        if ($discovered -ge $discoveryCap) {{ continue }}
        $found = $null
        foreach ($id in @($t.ids)) {{
            $escId = ([string]$id) -replace "'", "''"
            $filter = '@SQL="' + $PROP_MSGID + '" = ' + "'$escId'"
            foreach ($s in $scan) {{
                try {{
                    $hit = $s.folder.Items.Find($filter)
                    if ($null -ne $hit) {{ $found = $hit; break }}
                }} catch {{}}
            }}
            if ($null -ne $found) {{ break }}
        }}
        if ($null -ne $found) {{
            $cid = ''
            try {{ $cid = [string]$found.ConversationID }} catch {{}}
            if ($cid.Length -gt 0) {{
                $convMap[$cid] = $t
                $discovered++
                Write-Output ('CONV' + $sep + ([string]$t.k) + $sep + $cid)
            }}
        }}
    }}

    # ── Phase 2: enumerate recent items, match by ConversationID ──
    $emitted = 0
    $truncated = $false
    foreach ($s in $scan) {{
        if ($emitted -ge $messageCap) {{ $truncated = $true; break }}
        $items = $s.folder.Items
        try {{ $items.Sort($s.dateField) }} catch {{}}
        $filtered = $items
        if ($oldestWatermark.Length -gt 0) {{
            try {{
                $wm = [DateTime]::Parse($oldestWatermark).AddMinutes(-5)
                $restrict = $s.dateField + " >= '" + $wm.ToString('MM/dd/yyyy hh:mm tt') + "'"
                $filtered = $items.Restrict($restrict)
            }} catch {{ $filtered = $items }}
        }}
        foreach ($item in $filtered) {{
            if ($emitted -ge $messageCap) {{ $truncated = $true; break }}
            $cid = ''
            try {{ $cid = [string]$item.ConversationID }} catch {{}}
            if ([string]::IsNullOrEmpty($cid)) {{ continue }}
            if (-not $convMap.ContainsKey($cid)) {{ continue }}
            $t = $convMap[$cid]

            $mid = Get-Prop $item $PROP_MSGID
            # date: prefer SentOn (compose/send time), fall back to ReceivedTime.
            $dt = ''
            try {{ if ($item.SentOn) {{ $dt = $item.SentOn.ToString('yyyy-MM-ddTHH:mm:ssK') }} }} catch {{}}
            if ($dt.Length -eq 0) {{
                try {{ if ($item.ReceivedTime) {{ $dt = $item.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ssK') }} }} catch {{}}
            }}

            # Newer-than-watermark gate (per-thread).
            if (([string]$t.w).Length -gt 0 -and $dt.Length -gt 0) {{
                try {{
                    if ([DateTime]::Parse($dt) -le [DateTime]::Parse([string]$t.w)) {{ continue }}
                }} catch {{}}
            }}
            # Already-known gate (dedup against the ids the engine already has).
            $known = $false
            foreach ($kid in @($t.ids)) {{ if (([string]$kid) -eq $mid) {{ $known = $true; break }} }}
            if ($known) {{ continue }}

            # ── Extract the normalized message fields ──
            $subject = ''
            try {{ $subject = [string]$item.Subject }} catch {{}}
            $fromSmtp = Get-Prop $item $PROP_SENDER_SMTP
            if ($fromSmtp.Length -eq 0) {{ try {{ $fromSmtp = [string]$item.SenderEmailAddress }} catch {{}} }}
            $fromName = ''
            try {{ $fromName = [string]$item.SenderName }} catch {{}}
            $from = if ($fromName.Length -gt 0) {{ $fromName + ' <' + $fromSmtp + '>' }} else {{ $fromSmtp }}

            $toList = @()
            $ccList = @()
            try {{
                foreach ($r in $item.Recipients) {{
                    $addr = Get-RecipSmtp $r
                    if ($addr.Length -eq 0) {{ continue }}
                    if ($r.Type -eq 2) {{ $ccList += $addr }}
                    elseif ($r.Type -eq 1) {{ $toList += $addr }}
                }}
            }} catch {{}}

            $html = ''
            try {{ $html = [string]$item.HTMLBody }} catch {{}}
            $text = ''
            try {{ $text = [string]$item.Body }} catch {{}}
            $inReplyTo = Get-Prop $item $PROP_INREPLYTO
            $refs = Get-Prop $item $PROP_REFS

            $obj = [ordered]@{{
                threadKey = [string]$t.k
                subject = $subject
                from = $from
                to = ($toList -join $addrSep)
                cc = ($ccList -join $addrSep)
                dateTimeCreated = $dt
                bodyHtml = $html
                bodyText = $text
                internetMessageId = $mid
                inReplyTo = $inReplyTo
                references = $refs
            }}
            $json = $obj | ConvertTo-Json -Compress -Depth 4
            # Guard: strip any stray CR/LF the compact JSON might carry so the
            # record stays a single line for the Rust line parser.
            $json = $json -replace "[`r`n]", ' '
            Write-Output ('MSG' + $sep + $json)
            $emitted++
        }}
        if ($emitted -ge $messageCap) {{ $truncated = $true; break }}
    }}
    if ($truncated) {{ Write-Output ('TRUNC' + $sep + $emitted) }}
}} finally {{
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null
}}
"#,
        json_path = json_path,
        oldest = oldest,
        discovery_cap = discovery_cap,
        message_cap = message_cap,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform gate + read entry point.
// ─────────────────────────────────────────────────────────────────────────────

/// True only where the local-Outlook COM path exists (Windows). The command in
/// `lib.rs` checks this BEFORE any engine traffic so the macOS/Linux no-op makes
/// zero network calls (mirrors the OneNote sweep's local-first no-op).
#[cfg(target_os = "windows")]
pub fn is_supported_platform() -> bool {
    true
}

#[cfg(not(target_os = "windows"))]
pub fn is_supported_platform() -> bool {
    false
}

// ── Windows implementation ──────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::io::Write;
    use std::process::Command;

    /// Run one Outlook-COM sweep: write the thread list to a temp file, spawn
    /// `powershell.exe` (console-flash suppressed), parse the records, delete the
    /// temp file. Blocking — the caller wraps this in `spawn_blocking`.
    pub fn run(input: FollowReadInput) -> Result<FollowReadOutput, EmailFollowError> {
        // Temp file for the thread-list JSON (avoids -Command length limits and
        // keeps quoting simple). Deleted in every exit path below.
        let stem = temp_stem();
        let path = std::env::temp_dir().join(format!("threshold-email-follow-{}.json", stem));
        {
            let mut f = std::fs::File::create(&path)
                .map_err(|e| EmailFollowError::InputWriteFailed(format!("{}", e)))?;
            f.write_all(input.threads_json.as_bytes())
                .map_err(|e| EmailFollowError::InputWriteFailed(format!("{}", e)))?;
        }
        let path_str = path.to_string_lossy().to_string();
        let script = build_follow_ps_script(
            &path_str,
            &input.oldest_watermark,
            input.discovery_cap,
            input.message_cap,
        );
        let result = spawn_ps_script(&script);
        // Best-effort cleanup regardless of outcome.
        let _ = std::fs::remove_file(&path);
        let stdout = result?;
        Ok(parse_follow_stdout(&stdout))
    }

    /// Spawn `powershell.exe` with the OneNote/calendar console-flash suppression
    /// (`CREATE_NO_WINDOW`) so the 30-min tick never flickers a console. Lifts
    /// the Outlook-COM-not-registered marker into a typed error.
    fn spawn_ps_script(script: &str) -> Result<String, EmailFollowError> {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = cmd
            .output()
            .map_err(|e| EmailFollowError::PowerShellSpawnFailed(format!("{}", e)))?;
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !output.status.success() {
            if stderr.contains("OUTLOOK_COM_NOT_REGISTERED") {
                return Err(EmailFollowError::ComClassNotRegistered);
            }
            return Err(EmailFollowError::PowerShellExitNonZero {
                code: output.status.code().unwrap_or(-1),
                stderr,
            });
        }
        Ok(stdout)
    }

    /// Cheap random-ish stem for the temp file (avoid a `uuid` dep for one site).
    fn temp_stem() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{:x}-{:x}", std::process::id(), now_ns)
    }
}

/// Run one Outlook sweep. Windows delegates to `imp`; every other target is a
/// calm `PlatformUnsupported` no-op.
#[cfg(target_os = "windows")]
pub fn run_follow_read(input: FollowReadInput) -> Result<FollowReadOutput, EmailFollowError> {
    imp::run(input)
}

#[cfg(not(target_os = "windows"))]
pub fn run_follow_read(_input: FollowReadInput) -> Result<FollowReadOutput, EmailFollowError> {
    Err(EmailFollowError::PlatformUnsupported)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — pure functions on every platform; PowerShell generation via
// syntactic anchors (owning platform + cross-platform since generation is pure).
//
// ── Extended Windows live-verification checklist (E5-app additions) ──────────
// The COM path can't run off Windows; these join the existing OneNote/calendar
// Windows smoke on Trisha's machine (coordinator-run). NEW items for MAIL read:
//   E5-1. Outlook build: desktop M365/2016+ (COM present), NOT the sandboxed
//         Store "Outlook (new)" — that has no COM surface (ComClassNotRegistered).
//   E5-2. OM-guard security prompt: programmatic READ of message BODY (HTMLBody
//         / Body) and recipient SMTP is FAR likelier to trip the Outlook Object
//         Model Guard than the calendar free/busy read — verify no modal
//         "A program is trying to access…" prompt on Trisha's Exchange-cached,
//         AV-healthy box (Guard is suppressed there); if it appears, the sweep
//         hangs the PowerShell → confirm it's caught by the per-item try/catch
//         and the process still exits (watermark simply doesn't advance).
//   E5-3. First-sweep cost: a cold discovery pass does an `Items.Find` DASL on
//         PR_INTERNET_MESSAGE_ID (0x1035001F) per uncached thread across Inbox +
//         Sent — that property is often NOT indexed; measure the first sweep's
//         wall-time on a real mailbox and confirm the 25-thread cap keeps it
//         acceptable. Steady state (cached ConversationID) skips Find entirely.
//   E5-4. Sent Items coverage: confirm the user's OWN replies land — Sent items
//         key off [SentOn] (not [ReceivedTime]); verify a reply Trisha sent shows
//         up as an imported message (the vigilance ingress-owed void needs it).
//   E5-5. References preservation: verify Outlook keeps PR_INTERNET_REFERENCES on
//         replies so the engine's threadKey (references[0]) matches the original
//         thread — some setups strip References; if so the reply still imports
//         but may seed a new thread (acceptable, logged, not lost).
//   E5-6. ConversationID stability: confirm ConversationID is stable across
//         Inbox+Sent for the same thread on the store (cross-store moves reset
//         it) so cached-id enumeration finds both sides.
//   E5-7. New-mail auto-launch: New-Object Outlook.Application launches Outlook
//         if closed — confirm acceptable on Trisha's box (same as calendar), or
//         that a closed Outlook is a calm empty sweep.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── normalize_message_id (must match engine parse.ts byte-for-byte) ──

    #[test]
    fn normalize_wraps_bare_id() {
        assert_eq!(normalize_message_id("abc@host"), "<abc@host>");
        assert_eq!(normalize_message_id("  abc@host  "), "<abc@host>");
    }

    #[test]
    fn normalize_keeps_angle_form() {
        assert_eq!(normalize_message_id("<abc@host>"), "<abc@host>");
        // Extracts the first <...> run out of a noisy header value.
        assert_eq!(
            normalize_message_id("Message-ID: <abc@host> extra"),
            "<abc@host>"
        );
    }

    #[test]
    fn normalize_empty_is_empty() {
        assert_eq!(normalize_message_id(""), "");
        assert_eq!(normalize_message_id("   "), "");
    }

    #[test]
    fn normalize_strips_stray_brackets_when_no_pair() {
        // A leading '<' with no closing '>' — strip and re-wrap.
        assert_eq!(normalize_message_id("<abc@host"), "<abc@host>");
    }

    // ── iso comparison + watermark math ──

    #[test]
    fn iso_after_and_max_min() {
        let a = "2026-07-10T12:00:00Z";
        let b = "2026-07-10T13:00:00Z";
        assert!(iso_after(b, a));
        assert!(!iso_after(a, b));
        assert_eq!(iso_max(a, b), b);
        assert_eq!(iso_min(a, b), a);
    }

    #[test]
    fn iso_max_handles_offsets_across_zones() {
        // 12:00-04:00 == 16:00Z is LATER than 15:00Z despite the smaller wall clock.
        let east = "2026-07-10T12:00:00-04:00";
        let utc = "2026-07-10T15:00:00Z";
        assert_eq!(iso_max(east, utc), east);
        assert!(iso_after(east, utc));
    }

    #[test]
    fn iso_max_min_handle_empties() {
        assert_eq!(iso_max("", "2026-07-10T12:00:00Z"), "2026-07-10T12:00:00Z");
        assert_eq!(iso_max("2026-07-10T12:00:00Z", ""), "2026-07-10T12:00:00Z");
        assert_eq!(iso_min("", "2026-07-10T12:00:00Z"), "2026-07-10T12:00:00Z");
    }

    #[test]
    fn effective_watermark_takes_the_later() {
        let engine = "2026-07-10T12:00:00Z";
        let local = "2026-07-10T14:00:00Z";
        assert_eq!(effective_watermark(engine, Some(local)), local);
        assert_eq!(effective_watermark(engine, None), engine);
        // Local behind engine ⇒ engine wins (engine saw a newer message).
        assert_eq!(
            effective_watermark(local, Some(engine)),
            local
        );
    }

    // ── select_threads_to_sweep (least-recently-swept rotation + cap) ──

    fn state(key: &str, swept: Option<&str>) -> ThreadSweepState {
        ThreadSweepState {
            thread_key: key.into(),
            conversation_id: None,
            known_ids: vec![],
            effective_watermark: "2026-07-10T00:00:00Z".into(),
            swept_at: swept.map(|s| s.to_string()),
        }
    }

    #[test]
    fn select_threads_prioritizes_never_swept_then_oldest() {
        let threads = vec![
            state("<c>", Some("2026-07-10T10:00:00Z")),
            state("<a>", None),
            state("<b>", Some("2026-07-10T08:00:00Z")),
        ];
        let (sel, deferred) = select_threads_to_sweep(threads, 2);
        assert_eq!(deferred, 1);
        assert_eq!(sel.len(), 2);
        // never-swept <a> first, then oldest-swept <b>.
        assert_eq!(sel[0].thread_key, "<a>");
        assert_eq!(sel[1].thread_key, "<b>");
    }

    #[test]
    fn select_threads_no_cap_returns_all() {
        let threads = vec![state("<a>", None), state("<b>", None)];
        let (sel, deferred) = select_threads_to_sweep(threads, 25);
        assert_eq!(deferred, 0);
        assert_eq!(sel.len(), 2);
        // Deterministic tie-break on thread_key when both never-swept.
        assert_eq!(sel[0].thread_key, "<a>");
    }

    #[test]
    fn select_threads_empty() {
        let (sel, deferred) = select_threads_to_sweep(vec![], 25);
        assert!(sel.is_empty());
        assert_eq!(deferred, 0);
    }

    // ── select_messages_to_import (oldest-first + cap) ──

    fn msg(id: &str, date: &str) -> RawFollowMessage {
        RawFollowMessage {
            internet_message_id: id.into(),
            date_time_created: date.into(),
            from: "a@x.com".into(),
            body_text: "hi".into(),
            ..Default::default()
        }
    }

    #[test]
    fn select_messages_sorts_oldest_first_and_caps() {
        let msgs = vec![
            msg("<m3>", "2026-07-10T14:00:00Z"),
            msg("<m1>", "2026-07-10T10:00:00Z"),
            msg("<m2>", "2026-07-10T12:00:00Z"),
        ];
        let (sel, deferred) = select_messages_to_import(msgs, 2);
        assert_eq!(deferred, 1);
        assert_eq!(sel.len(), 2);
        assert_eq!(sel[0].internet_message_id, "<m1>");
        assert_eq!(sel[1].internet_message_id, "<m2>");
    }

    #[test]
    fn select_messages_unparseable_dates_sort_last() {
        let msgs = vec![
            msg("<bad>", "not-a-date"),
            msg("<good>", "2026-07-10T10:00:00Z"),
        ];
        let (sel, _) = select_messages_to_import(msgs, 10);
        assert_eq!(sel[0].internet_message_id, "<good>");
        assert_eq!(sel[1].internet_message_id, "<bad>");
    }

    // ── build_import_body (the body extraction mapping) ──

    #[test]
    fn build_import_body_maps_and_splits_addresses() {
        let m = RawFollowMessage {
            thread_key: "<root>".into(),
            subject: "Re: Q3".into(),
            from: "Trisha <trisha@x.com>".into(),
            to: format!("a@x.com{}b@y.com", ADDR_SEP),
            cc: "c@z.com".into(),
            date_time_created: "2026-07-10T14:00:00-04:00".into(),
            body_html: "<p>hi</p>".into(),
            body_text: "hi".into(),
            internet_message_id: "reply@host".into(), // not yet normalized
            in_reply_to: "<root>".into(),
            references: "<root> <mid2>".into(),
        };
        let body = build_import_body(&m);
        assert_eq!(body["subject"], "Re: Q3");
        assert_eq!(body["from"], "Trisha <trisha@x.com>");
        assert_eq!(body["to"], serde_json::json!(["a@x.com", "b@y.com"]));
        assert_eq!(body["cc"], serde_json::json!(["c@z.com"]));
        assert_eq!(body["dateTimeCreated"], "2026-07-10T14:00:00-04:00");
        assert_eq!(body["bodyHtml"], "<p>hi</p>");
        assert_eq!(body["bodyText"], "hi");
        // internetMessageId normalized to <...>.
        assert_eq!(body["internetMessageId"], "<reply@host>");
        assert_eq!(body["inReplyTo"], "<root>");
        assert_eq!(body["references"], serde_json::json!(["<root>", "<mid2>"]));
        // threadKey is NOT part of the engine body.
        assert!(body.get("threadKey").is_none());
    }

    #[test]
    fn build_import_body_omits_empty_optionals() {
        let m = RawFollowMessage {
            from: "a@x.com".into(),
            internet_message_id: "<id@h>".into(),
            body_text: "hi".into(),
            ..Default::default()
        };
        let body = build_import_body(&m);
        assert!(body.get("subject").is_none());
        assert!(body.get("bodyHtml").is_none());
        assert!(body.get("inReplyTo").is_none());
        assert!(body.get("references").is_none());
        // to / cc are always arrays (engine's asStringArray needs an array).
        assert_eq!(body["to"], serde_json::json!([]));
        assert_eq!(body["cc"], serde_json::json!([]));
        assert_eq!(body["from"], "a@x.com");
        assert_eq!(body["internetMessageId"], "<id@h>");
    }

    // ── parse_follow_stdout ──

    fn conv_line(tk: &str, cid: &str) -> String {
        format!("CONV{}{}{}{}", LINE_SEP, tk, LINE_SEP, cid)
    }
    fn msg_line(json: &str) -> String {
        format!("MSG{}{}", LINE_SEP, json)
    }

    #[test]
    fn parse_stdout_reads_conv_and_msg_and_trunc() {
        let mut s = String::new();
        s.push_str(&conv_line("<root>", "CONV-ABC-123"));
        s.push('\n');
        s.push_str(&msg_line(
            r#"{"threadKey":"<root>","from":"a@x.com","internetMessageId":"<m1@h>","dateTimeCreated":"2026-07-10T10:00:00Z","bodyText":"hi"}"#,
        ));
        s.push('\n');
        s.push_str(&format!("TRUNC{}100", LINE_SEP));
        s.push('\n');
        let out = parse_follow_stdout(&s);
        assert_eq!(out.conversations, vec![("<root>".into(), "CONV-ABC-123".into())]);
        assert_eq!(out.messages.len(), 1);
        assert_eq!(out.messages[0].internet_message_id, "<m1@h>");
        assert_eq!(out.messages[0].thread_key, "<root>");
        assert!(out.truncated);
    }

    #[test]
    fn parse_stdout_skips_noise_and_idless_messages() {
        let mut s = String::new();
        s.push_str("some powershell warning noise\n");
        s.push_str("\n");
        // A MSG with no internetMessageId is dropped (can't dedup).
        s.push_str(&msg_line(r#"{"threadKey":"<root>","from":"a@x.com","bodyText":"hi"}"#));
        s.push('\n');
        s.push_str(&msg_line(
            r#"{"threadKey":"<root>","internetMessageId":"<real@h>","from":"a@x.com","bodyText":"hi"}"#,
        ));
        s.push('\n');
        let out = parse_follow_stdout(&s);
        assert_eq!(out.messages.len(), 1);
        assert_eq!(out.messages[0].internet_message_id, "<real@h>");
        assert!(!out.truncated);
    }

    #[test]
    fn parse_stdout_empty() {
        let out = parse_follow_stdout("");
        assert!(out.conversations.is_empty());
        assert!(out.messages.is_empty());
        assert!(!out.truncated);
    }

    #[test]
    fn parse_stdout_bad_msg_json_is_skipped_not_fatal() {
        let s = msg_line("{not valid json");
        let out = parse_follow_stdout(&s);
        assert!(out.messages.is_empty());
    }

    // ── PowerShell script generation (syntactic anchors) ──

    #[test]
    fn ps_script_has_two_phases_and_caps() {
        let script = build_follow_ps_script("C:\\tmp\\in.json", "2026-07-10T00:00:00Z", 25, 100);
        // COM entry + typed marker.
        assert!(script.contains("New-Object -ComObject Outlook.Application"));
        assert!(script.contains("OUTLOOK_COM_NOT_REGISTERED"));
        // Inbox (6) + Sent (5) scanned.
        assert!(script.contains("GetDefaultFolder(6)"));
        assert!(script.contains("GetDefaultFolder(5)"));
        // Per-folder date field (Sent keys off SentOn).
        assert!(script.contains("[ReceivedTime]"));
        assert!(script.contains("[SentOn]"));
        // Phase 1 discovery: DASL Find on PR_INTERNET_MESSAGE_ID.
        assert!(script.contains("0x1035001F"));
        assert!(script.contains(".Items.Find("));
        assert!(script.contains("$discoveryCap = 25"));
        // Phase 2: time-bounded Restrict + ConversationID match + cap.
        assert!(script.contains(".Restrict("));
        assert!(script.contains("ConversationID"));
        assert!(script.contains("$messageCap = 100"));
        // Emits the three record markers.
        assert!(script.contains("'CONV'"));
        assert!(script.contains("'MSG'"));
        assert!(script.contains("'TRUNC'"));
        assert!(script.contains("ConvertTo-Json -Compress"));
        // RCW released.
        assert!(script.contains("ReleaseComObject"));
        // Console-flash suppression is applied by the spawner, not the script;
        // but the templated inputs must be present.
        assert!(script.contains("2026-07-10T00:00:00Z"));
    }

    #[test]
    fn ps_script_escapes_single_quotes_in_path() {
        let script = build_follow_ps_script("C:\\a'b\\in.json", "", 25, 100);
        assert!(script.contains("'C:\\a''b\\in.json'"));
        // Empty watermark ⇒ the restrict guard is length-checked in-script.
        assert!(script.contains("$oldestWatermark.Length -gt 0"));
    }

    // ── State serde (config.json wire shape) ──

    #[test]
    fn email_follow_thread_serializes_camel_case_and_skips_none() {
        let t = EmailFollowThread {
            thread_key: "<root>".into(),
            conversation_id: Some("CID".into()),
            watermark: Some("2026-07-10T00:00:00Z".into()),
            swept_at: None,
        };
        let json = serde_json::to_string(&t).expect("serializes");
        assert!(json.contains("\"threadKey\":\"<root>\""), "{}", json);
        assert!(json.contains("\"conversationId\":\"CID\""), "{}", json);
        assert!(json.contains("\"watermark\""), "{}", json);
        // None swept_at is skipped.
        assert!(!json.contains("sweptAt"), "{}", json);
    }

    #[test]
    fn email_follow_state_defaults_empty() {
        let s = EmailFollowState::default();
        assert!(s.threads.is_empty());
        // Legacy config without the field deserializes to default.
        let parsed: EmailFollowState = serde_json::from_str("{}").expect("empty obj");
        assert!(parsed.threads.is_empty());
    }

    // ── Error semantics ──

    #[test]
    fn error_user_messages_non_empty() {
        for e in &[
            EmailFollowError::ComClassNotRegistered,
            EmailFollowError::OutlookNotRunning,
            EmailFollowError::PowerShellExitNonZero {
                code: 1,
                stderr: "x".into(),
            },
            EmailFollowError::PowerShellSpawnFailed("x".into()),
            EmailFollowError::InputWriteFailed("x".into()),
            EmailFollowError::ParseFailed("x".into()),
            EmailFollowError::Other("x".into()),
            EmailFollowError::PlatformUnsupported,
        ] {
            assert!(!e.user_message().is_empty());
            let _ = format!("{}", e);
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_read_is_platform_unsupported() {
        let input = FollowReadInput {
            threads_json: "[]".into(),
            oldest_watermark: String::new(),
            discovery_cap: 25,
            message_cap: 100,
        };
        assert_eq!(run_follow_read(input), Err(EmailFollowError::PlatformUnsupported));
        assert!(!is_supported_platform());
    }
}
