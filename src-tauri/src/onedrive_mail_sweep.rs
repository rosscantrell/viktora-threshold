//! WP-INTAKE (contingency transport) — OneDrive folder-sweep channel.
//!
//! The New-Outlook-safe on-ramp. New Outlook (the sandboxed Store app) has no
//! COM surface, so the E5-app `email_follow` sweep (classic-Outlook COM) can't
//! reach it. This module is the SIBLING transport: a Power Automate flow in the
//! user's own tenant (standard connectors, user-consent level — verified green
//! in the pilot tenant 2026-07-11) writes each arriving/sent email — AND, as of
//! schema v2, each new Teams CHANNEL message — as a small JSON file into a
//! OneDrive folder; the OneDrive sync client mirrors that folder to local disk;
//! this sweep reads the local folder on the SAME shared app tick and routes each
//! file to the engine's EXISTING import endpoint for its kind
//! (`POST /api/email/import` for mail, `POST /api/teams/import` for Teams). One
//! import authority per channel, one file-drop transport.
//!
//! ── Why this transport ──────────────────────────────────────────────────────
//! Pure filesystem + HTTP. No COM, so unlike `email_follow` it works on BOTH
//! macOS and Windows (and is therefore live-testable on the dev Mac). The flow
//! runs in Microsoft's cloud (no daemon on the user's box); the sweep only ever
//! reads files the sync client already mirrored locally — the app being closed
//! all morning just means the next tick catches up on whatever accumulated.
//!
//! ── File schema (what the Power Automate flow writes) ────────────────────────
//! One JSON object per file. The schema is VERSIONED and KIND-tagged:
//!   * v1 (`{"schemaVersion":1, ...}`, NO `kind`) — a live email, EXACTLY the
//!     original shape (see `MailFileV1`). Parsed byte-for-byte as it always was
//!     (backward-compat is a locked regression): required `from`,
//!     `internetMessageId`, ≥1 body; `to`/`cc` a delimited string or JSON array;
//!     `mailbox` `"inbox"`|`"sent"` informational. Capture is implicitly `live`.
//!   * v2 (`{"schemaVersion":2, "kind":"email"|"teams-channel", "capture"?, ...}`)
//!     — a discriminated file. `kind:"email"` carries the SAME email fields as v1
//!     (`MailFileV1`); `kind:"teams-channel"` carries the Teams fields
//!     (`TeamsFileV2`, mirroring the engine's `POST /api/teams/import` contract).
//!     `capture` is `"live"` (default when absent) or `"backfill"` (COLDSTART
//!     30-day history) — a durable provenance stamp, passed through to the engine
//!     unchanged; a present-but-invalid value quarantines the file (never coerced).
//!
//! `parse_swept_file` is the single dispatcher: it reads `schemaVersion`+`kind`,
//! then validates + normalizes into a `SweptRecord` (Email or Teams). The engine
//! stays the sole thread-key / dedupe authority for BOTH kinds — the sweep never
//! computes a thread key.
//!
//! ── Processed-file handling ──────────────────────────────────────────────────
//! After a successful import (engine `ok` OR `duplicate`) the file is MOVED to a
//! `processed/` subfolder; a file whose JSON is malformed / wrong-schema /
//! wrong-kind / missing-required / invalid-capture is MOVED to `failed/`. When an
//! endpoint reports its lane is OFF (`{enabled:false}`) the file is MOVED to a
//! `skipped/` subfolder — see the enabled:false rationale below. Move (not a
//! persisted ledger) is the never-re-import guarantee: filesystem-atomic,
//! survives restarts with zero bookkeeping, and leaves a visible receipt the user
//! (or a support session) can inspect. A file we could NOT import for a TRANSIENT
//! reason (engine unreachable / 5xx / a locked file mid-sync) is LEFT IN PLACE so
//! the next tick retries it — the watermark equivalent here is "still in the
//! inbox folder". Teams receipts carry a `teams-` filename prefix on move so the
//! integration doctor can classify receipts by kind at zero I/O cost (email
//! receipts keep their original guid filename, unchanged).
//!
//! ── enabled:false ⇒ `skipped/` (NOT left in place) ───────────────────────────
//! `{enabled:false}` means the server lane is OFF — a durable CONFIGURATION state,
//! not a transient error. Leaving the file in place would re-scan (and re-probe)
//! it every tick forever. So a lane-off file is MOVED to `skipped/` (per-kind,
//! Teams prefixed) with a fail-VISIBLE log and a doctor-visible count: the files
//! don't vanish (fail-closed-but-VISIBLE), the drain is bounded (one sweep clears
//! them), and a disabled email lane never blocks the Teams lane (each file is
//! routed independently — no whole-sweep abort). The lanes are `pilot-full` ON,
//! so this is an edge/policy state; if a lane is later enabled, a Settings-repair
//! re-sweep of `skipped/` recovers the set (future; the receipts are retained for
//! exactly that).
//!
//! NO LLM anywhere — the sweep is deterministic substrate transport. Extraction,
//! threading and markers happen engine-side, fire-and-forget, exactly like the
//! webhook and the E5-app COM sweep.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ─────────────────────────────────────────────────────────────────────────────
// Persisted config (lives inside AppConfig via `OneDriveMailConfig`, same
// additive-serde-default pattern as `auto_import` / `email_follow`).
// ─────────────────────────────────────────────────────────────────────────────

/// OneDrive mail-sweep settings persisted in `config.json`. `#[serde(default)]`
/// (struct-level) ⇒ legacy configs without the field deserialize to an empty
/// config (folder unset ⇒ the sweep is a calm no-op) — additive-only schema
/// delta, same guarantee as `auto_import` / `email_follow`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct OneDriveMailConfig {
    /// Absolute path to the LOCAL folder the OneDrive sync client mirrors the
    /// flow's JSON files into. Varies per machine (e.g.
    /// `C:\Users\Trisha\OneDrive - Contoso\Apps\Threshold\mail` on Windows, or
    /// `~/OneDrive/Apps/Threshold/mail` on a Mac with OneDrive installed) — so
    /// it is user-configured, not auto-guessed. `None` ⇒ the channel is not set
    /// up yet ⇒ the sweep skips calmly (never an error).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

impl OneDriveMailConfig {
    /// The configured folder as a `Path`, if set + non-empty. `None` ⇒ not
    /// configured (calm skip).
    pub fn folder_path(&self) -> Option<PathBuf> {
        self.folder
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Caps (documented; truncation is LOGGED by the caller, never silent).
// ─────────────────────────────────────────────────────────────────────────────

/// Max files imported (POSTed) in one sweep. A hit leaves the remainder for the
/// next tick — files stay in the inbox folder, so nothing is lost (mirrors the
/// E5-app message cap). Trisha-scale volume sits well under this.
pub const ONEDRIVE_MAIL_FILE_CAP: usize = 100;

/// Subfolder a successfully-imported file is moved to (visible receipt).
pub const PROCESSED_DIR: &str = "processed";

/// Subfolder a malformed / wrong-schema / missing-required file is quarantined
/// to (visible, out of the sweep path, never re-read).
pub const FAILED_DIR: &str = "failed";

/// Subfolder a file is moved to when its engine lane is OFF (`{enabled:false}`).
/// A durable config state, not a transient error: retained (fail-VISIBLE) +
/// counted by the doctor, but never re-scanned/re-probed each tick. See the
/// module header's enabled:false rationale.
pub const SKIPPED_DIR: &str = "skipped";

/// Filename prefix applied to a Teams receipt when it is moved into
/// `processed/` / `failed/` / `skipped/`. Lets the integration doctor classify
/// receipts by kind from the directory listing alone (zero extra I/O). Email
/// receipts keep their original filename. A guid.json never starts with this
/// prefix, so the discriminator is unambiguous.
pub const TEAMS_RECEIPT_PREFIX: &str = "teams-";

/// The schema versions this build understands. v1 = legacy live email (no
/// `kind`); v2 = discriminated (`kind` + optional `capture`). A file declaring
/// anything else is quarantined to `failed/` (forward-compat guard: a future
/// flow bump won't be silently mis-imported by an old app).
pub const SCHEMA_VERSION: u32 = 1;
/// The current (kind-discriminated) schema version the v2 flows write.
pub const SCHEMA_VERSION_V2: u32 = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Errors — distinguishable variants with a plain-product `user_message()`
// (mirrors the OneNote / calendar / email-follow error style). These only ever
// reach the log (a background channel), but stay honest.
// ─────────────────────────────────────────────────────────────────────────────

/// Sweep-level state / errors (folder gate).
#[derive(Debug, PartialEq)]
pub enum SweepGate {
    /// No folder configured — the channel isn't set up. Calm skip.
    NotConfigured,
    /// A folder is configured but does not exist / isn't a directory (OneDrive
    /// not installed, wrong path, or not yet synced). Calm skip, fail-VISIBLE
    /// via the log + a typed summary flag.
    FolderNotFound,
    /// The folder exists and is a directory — proceed.
    Ready,
}

/// Per-file parse / validation failure. Each carries enough for a log body; all
/// route the file to `failed/` (quarantine, never re-read). Named `MailFileError`
/// for history; it now covers both file kinds (email + Teams).
#[derive(Debug, PartialEq)]
pub enum MailFileError {
    /// `serde_json` couldn't parse the file as an object of the expected kind.
    MalformedJson(String),
    /// `schemaVersion` was absent or not a version this build understands.
    UnsupportedSchemaVersion(String),
    /// A v2 file's `kind` was absent or not `email` / `teams-channel`.
    UnsupportedKind(String),
    /// A present `capture` was neither `live` nor `backfill` (provenance is a
    /// durable stamp — never silently coerced).
    InvalidCapture(String),
    /// A required field (email: `from`/`internetMessageId`; teams:
    /// `author`/`messageId`/`channelId`) was empty/absent.
    MissingRequiredField(&'static str),
    /// Neither `bodyHtml` nor `bodyText` had content (import needs a body).
    NoBody,
}

impl MailFileError {
    /// Short, plain-product message (no JSON/serde jargon). The sweep is a
    /// background channel, so these only ever reach the log today (which uses
    /// `Display`) — kept + unit-tested for parity with the sibling error types
    /// and for a future surface. Hence the `dead_code` allow in non-test builds.
    #[allow(dead_code)]
    pub fn user_message(&self) -> &'static str {
        match self {
            MailFileError::MalformedJson(_) => "A capture file wasn't valid JSON (quarantined).",
            MailFileError::UnsupportedSchemaVersion(_) => {
                "A capture file used an unsupported schema version (quarantined)."
            }
            MailFileError::UnsupportedKind(_) => {
                "A capture file used an unknown message kind (quarantined)."
            }
            MailFileError::InvalidCapture(_) => {
                "A capture file used an invalid capture mode (quarantined)."
            }
            MailFileError::MissingRequiredField(_) => {
                "A capture file was missing a required field (quarantined)."
            }
            MailFileError::NoBody => "A capture file had no message body (quarantined).",
        }
    }
}

impl std::fmt::Display for MailFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailFileError::MalformedJson(e) => write!(f, "malformed JSON: {}", e),
            MailFileError::UnsupportedSchemaVersion(v) => {
                write!(f, "unsupported schemaVersion: {}", v)
            }
            MailFileError::UnsupportedKind(k) => write!(f, "unsupported kind: {}", k),
            MailFileError::InvalidCapture(c) => write!(f, "invalid capture: {}", c),
            MailFileError::MissingRequiredField(name) => {
                write!(f, "missing required field: {}", name)
            }
            MailFileError::NoBody => write!(f, "no body (bodyHtml/bodyText both empty)"),
        }
    }
}

impl std::error::Error for MailFileError {}

// ─────────────────────────────────────────────────────────────────────────────
// Capture provenance + file kind — shared by both email and Teams v2 files.
// ─────────────────────────────────────────────────────────────────────────────

/// Provenance selector, passed through to the engine unchanged. `Live` (default
/// when absent) ⇒ a live capture; `Backfill` ⇒ a one-time COLDSTART 30-day
/// historical import (the engine stamps `backfill-*` captureMethod forever).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capture {
    Live,
    Backfill,
}

impl Capture {
    /// The wire value the engine's `capture` field expects.
    pub fn as_str(self) -> &'static str {
        match self {
            Capture::Live => "live",
            Capture::Backfill => "backfill",
        }
    }

    /// Normalize an optional `capture` field. Absent ⇒ `Live`. A present value
    /// must be exactly `"live"` or `"backfill"` — anything else is a hard error
    /// (mirrors the engine's validation: provenance is never silently coerced).
    pub fn parse(raw: Option<&str>) -> Result<Capture, MailFileError> {
        match raw.map(str::trim) {
            None | Some("") | Some("live") => Ok(Capture::Live),
            Some("backfill") => Ok(Capture::Backfill),
            Some(other) => Err(MailFileError::InvalidCapture(other.to_string())),
        }
    }
}

/// Which import lane a swept file routes to. Also drives the receipt filename
/// prefix so the doctor can classify receipts cheaply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweptKind {
    Email,
    Teams,
}

impl SweptKind {
    /// The receipt filename prefix for this kind (`""` for email, `teams-` for
    /// Teams). Applied when a file is moved into a receipt subfolder.
    pub fn receipt_prefix(self) -> &'static str {
        match self {
            SweptKind::Email => "",
            SweptKind::Teams => TEAMS_RECEIPT_PREFIX,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema v1 value type.
// ─────────────────────────────────────────────────────────────────────────────

/// One arriving / sent email as the Power Automate flow serializes it. Field
/// names are camelCase so the flow composes them directly with dynamic-content
/// tokens. `to` / `cc` deserialize from EITHER a delimited string (the trigger's
/// native shape) or a JSON array (`string_or_vec`). Optional fields default to
/// empty and are omitted from the engine body when blank.
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailFileV1 {
    /// MUST be `1`. `None`/other ⇒ `UnsupportedSchemaVersion` (quarantine).
    #[serde(default)]
    pub schema_version: Option<u32>,
    /// `"inbox"` | `"sent"` — informational + logged; both import identically.
    /// Defaults to `"inbox"` when absent.
    #[serde(default)]
    pub mailbox: Option<String>,
    #[serde(default)]
    pub subject: String,
    /// REQUIRED. Sender address (display-name form is fine — the engine parses).
    #[serde(default)]
    pub from: String,
    /// Recipients. Delimited string or JSON array; split Rust-side.
    #[serde(default, deserialize_with = "string_or_vec")]
    pub to: Vec<String>,
    #[serde(default, deserialize_with = "string_or_vec")]
    pub cc: Vec<String>,
    /// ISO-8601 timestamp (the trigger's Received Time). Optional per the engine.
    #[serde(default)]
    pub date_time_created: String,
    #[serde(default)]
    pub body_html: String,
    #[serde(default)]
    pub body_text: String,
    /// REQUIRED. RFC-2822 Internet Message Id (the trigger's "Internet Message
    /// Id", NOT the Graph "Message Id"). Dedup key engine-side.
    #[serde(default)]
    pub internet_message_id: String,
    /// Optional threading headers (the trigger does NOT expose these — a future
    /// enriched flow may). Absent ⇒ the engine derives threading from
    /// references/subject as it does for webhook mail.
    #[serde(default)]
    pub in_reply_to: String,
    #[serde(default)]
    pub references: String,
}

/// One Teams CHANNEL message as the Power Automate flow serializes it (schema v2,
/// `kind:"teams-channel"`). Field names are camelCase so the flow composes them
/// directly with dynamic-content tokens. Mirrors the engine's
/// `POST /api/teams/import` contract EXACTLY: required `author`, `messageId`,
/// `channelId`, and ≥1 body (`bodyHtml`|`bodyText`); the rest default calmly. The
/// engine derives the thread key from `channelId` + reply chain — the sweep never
/// computes it. `bodyHtml` carries the message's HTML `body.content` (formatting
/// is semantics in this product — never flattened at capture).
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamsFileV2 {
    /// MUST be `2`. Read by the dispatcher, not here.
    #[serde(default)]
    pub schema_version: Option<u32>,
    /// MUST be `"teams-channel"`. Read by the dispatcher, not here.
    #[serde(default)]
    pub kind: Option<String>,
    /// `"live"` | `"backfill"` (absent ⇒ live). Read by the dispatcher.
    #[serde(default)]
    pub capture: Option<String>,
    /// Human channel name (cosmetic — title only; engine keys on channelId).
    #[serde(default)]
    pub channel_name: String,
    /// Human team name (cosmetic).
    #[serde(default)]
    pub team_name: String,
    /// REQUIRED. Message author's display name.
    #[serde(default)]
    pub author: String,
    /// ISO-8601 message creation time. Optional per the engine.
    #[serde(default)]
    pub date_time_created: String,
    /// The message body as HTML (`body.content`). At least one of html/text.
    #[serde(default)]
    pub body_html: String,
    /// Optional plain-text body (auxiliary — never a substitute for bodyHtml).
    #[serde(default)]
    pub body_text: String,
    /// REQUIRED. The Teams message id. Engine dedup key.
    #[serde(default)]
    pub message_id: String,
    /// The reply-chain root id when this message is a reply (engine derives the
    /// thread key from it). Absent/empty for a root post.
    #[serde(default)]
    pub reply_to_id: String,
    /// REQUIRED. The channel id (part of the engine's thread key).
    #[serde(default)]
    pub channel_id: String,
}

/// Deserialize a field that may be a single delimited string (`"a@x;b@y"`) OR a
/// JSON array (`["a@x","b@y"]`) into a clean `Vec<String>`. Delimiters `;` and
/// `,` (Outlook joins recipients with `;`); entries trimmed, empties dropped.
fn string_or_vec<'de, D>(de: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrVec {
        S(String),
        V(Vec<String>),
        Null,
    }
    Ok(match StringOrVec::deserialize(de)? {
        StringOrVec::S(s) => split_addr_string(&s),
        StringOrVec::V(v) => v
            .into_iter()
            .flat_map(|s| split_addr_string(&s))
            .collect(),
        StringOrVec::Null => Vec::new(),
    })
}

/// Split a recipient string on `;` / `,`, trim, drop empties. Pure + tested.
fn split_addr_string(s: &str) -> Vec<String> {
    s.split([';', ','])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions — unit-tested on every platform (no HTTP, no clock; the fs
// helpers below are tested against a real temp dir, which IS the Mac live-smoke).
// ─────────────────────────────────────────────────────────────────────────────

/// Parse + validate a **schema-v1** email file into a `MailFileV1`. Enforces
/// `schemaVersion == 1`, the two required fields, and the at-least-one-body floor
/// BEFORE the engine ever sees it (so a bad file is quarantined locally, not
/// bounced over the wire). Deterministic + side-effect-free. Behavior for a v1
/// file is a LOCKED regression — the v2 dispatcher (`parse_swept_file`) routes
/// v1 files through here unchanged.
pub fn parse_mail_file(contents: &str) -> Result<MailFileV1, MailFileError> {
    let parsed: MailFileV1 = serde_json::from_str(contents)
        .map_err(|e| MailFileError::MalformedJson(e.to_string()))?;
    match parsed.schema_version {
        Some(v) if v == SCHEMA_VERSION => {}
        other => {
            return Err(MailFileError::UnsupportedSchemaVersion(
                other.map(|v| v.to_string()).unwrap_or_else(|| "absent".into()),
            ));
        }
    }
    validate_mail_fields(&parsed)?;
    Ok(parsed)
}

/// The email field floor (required fields + at-least-one-body), shared by the v1
/// path (`parse_mail_file`) and the v2 `kind:"email"` path so both enforce the
/// identical contract. Schema-version-agnostic (the caller has already checked
/// the version).
fn validate_mail_fields(parsed: &MailFileV1) -> Result<(), MailFileError> {
    if parsed.from.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("from"));
    }
    if parsed.internet_message_id.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("internetMessageId"));
    }
    if parsed.body_html.trim().is_empty() && parsed.body_text.trim().is_empty() {
        return Err(MailFileError::NoBody);
    }
    Ok(())
}

/// The Teams field floor, mirroring the engine's `validateTeamsImportBody`:
/// required `author`, `messageId`, `channelId`, and ≥1 body.
fn validate_teams_fields(msg: &TeamsFileV2) -> Result<(), MailFileError> {
    if msg.author.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("author"));
    }
    if msg.message_id.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("messageId"));
    }
    if msg.channel_id.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("channelId"));
    }
    if msg.body_html.trim().is_empty() && msg.body_text.trim().is_empty() {
        return Err(MailFileError::NoBody);
    }
    Ok(())
}

/// A parsed + validated swept file, ready to route to its import lane. Each
/// carries the normalized `Capture` provenance (passed through to the engine).
#[derive(Debug, Clone, PartialEq)]
pub enum SweptRecord {
    Email { mail: MailFileV1, capture: Capture },
    Teams { msg: TeamsFileV2, capture: Capture },
}

impl SweptRecord {
    /// The lane/kind this record routes to (drives the receipt prefix).
    pub fn kind(&self) -> SweptKind {
        match self {
            SweptRecord::Email { .. } => SweptKind::Email,
            SweptRecord::Teams { .. } => SweptKind::Teams,
        }
    }

    /// The normalized capture provenance. Production code folds capture into the
    /// import body per-arm (each arm needs the typed struct anyway), so this
    /// accessor is exercised by the unit tests only — kept for symmetry with
    /// `kind()` and for future callers. Hence the non-test `dead_code` allow
    /// (same precedent as `MailFileError::user_message`).
    #[allow(dead_code)]
    pub fn capture(&self) -> Capture {
        match self {
            SweptRecord::Email { capture, .. } | SweptRecord::Teams { capture, .. } => *capture,
        }
    }
}

/// A tiny envelope read FIRST to route the file: `schemaVersion` decides v1 vs
/// v2; `kind` (v2 only) selects email vs teams; `capture` (v2 only) is the
/// provenance stamp. Unknown extra fields are ignored (no `deny_unknown_fields`),
/// so the same JSON re-deserializes cleanly into the kind-specific struct.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SweptEnvelope {
    #[serde(default)]
    schema_version: Option<u32>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    capture: Option<String>,
}

/// The single dispatcher over a swept file's contents. Reads the version + kind
/// envelope, then validates + normalizes into a `SweptRecord`:
///   * `schemaVersion:1` (any/no `kind`) ⇒ legacy live email — routed through
///     `parse_mail_file` UNCHANGED (v1-compat regression lock), `Capture::Live`.
///   * `schemaVersion:2` + `kind:"email"` ⇒ email fields (`MailFileV1`) +
///     `capture`.
///   * `schemaVersion:2` + `kind:"teams-channel"` ⇒ Teams fields (`TeamsFileV2`)
///     + `capture`.
///   * anything else ⇒ `UnsupportedSchemaVersion` / `UnsupportedKind`.
/// Deterministic + side-effect-free. The engine remains the sole thread-key /
/// dedupe authority for every kind.
pub fn parse_swept_file(contents: &str) -> Result<SweptRecord, MailFileError> {
    let env: SweptEnvelope = serde_json::from_str(contents)
        .map_err(|e| MailFileError::MalformedJson(e.to_string()))?;
    match env.schema_version {
        // v1 (or absent) ⇒ legacy live email, parsed EXACTLY as before.
        Some(v) if v == SCHEMA_VERSION => {
            let mail = parse_mail_file(contents)?;
            Ok(SweptRecord::Email {
                mail,
                capture: Capture::Live,
            })
        }
        Some(v) if v == SCHEMA_VERSION_V2 => {
            let capture = Capture::parse(env.capture.as_deref())?;
            match env.kind.as_deref().map(str::trim) {
                Some("email") => {
                    let mail: MailFileV1 = serde_json::from_str(contents)
                        .map_err(|e| MailFileError::MalformedJson(e.to_string()))?;
                    validate_mail_fields(&mail)?;
                    Ok(SweptRecord::Email { mail, capture })
                }
                Some("teams-channel") => {
                    let msg: TeamsFileV2 = serde_json::from_str(contents)
                        .map_err(|e| MailFileError::MalformedJson(e.to_string()))?;
                    validate_teams_fields(&msg)?;
                    Ok(SweptRecord::Teams { msg, capture })
                }
                other => Err(MailFileError::UnsupportedKind(
                    other.unwrap_or("absent").to_string(),
                )),
            }
        }
        other => Err(MailFileError::UnsupportedSchemaVersion(
            other.map(|v| v.to_string()).unwrap_or_else(|| "absent".into()),
        )),
    }
}

/// The normalized `mailbox` label for logging (`"inbox"` default; unknown values
/// pass through so an odd label is visible rather than swallowed).
pub fn mailbox_label(m: &MailFileV1) -> String {
    m.mailbox
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("inbox")
        .to_string()
}

/// Map a validated `MailFileV1` to the engine's `POST /api/email/import` body.
/// `to` / `cc` are already `Vec<String>`; `internetMessageId` / `inReplyTo` are
/// normalized to `<...>` (byte-for-byte matching the engine, via the shared
/// `email_follow::normalize_message_id` authority) so app-side and engine-side
/// dedup agree; `references` splits on whitespace; empty optionals are omitted.
/// `schemaVersion` / `mailbox` are transport metadata and are NOT sent — the
/// engine body has no slot for them. `capture` is stamped ONLY for `Backfill`
/// (the engine defaults an absent `capture` to `live`), so a live/v1 body is
/// byte-identical to what this build always produced — the v1-compat lock.
/// Deterministic + side-effect-free: this is the body-extraction mapping the
/// verification bar requires under test.
pub fn build_import_body(m: &MailFileV1, capture: Capture) -> serde_json::Value {
    use crate::email_follow::normalize_message_id;
    let mut obj = serde_json::Map::new();
    if !m.subject.trim().is_empty() {
        obj.insert("subject".into(), m.subject.clone().into());
    }
    obj.insert("from".into(), m.from.trim().into());
    obj.insert("to".into(), serde_json::Value::from(clean_list(&m.to)));
    obj.insert("cc".into(), serde_json::Value::from(clean_list(&m.cc)));
    if !m.date_time_created.trim().is_empty() {
        obj.insert("dateTimeCreated".into(), m.date_time_created.trim().into());
    }
    if !m.body_html.trim().is_empty() {
        obj.insert("bodyHtml".into(), m.body_html.clone().into());
    }
    if !m.body_text.trim().is_empty() {
        obj.insert("bodyText".into(), m.body_text.clone().into());
    }
    obj.insert(
        "internetMessageId".into(),
        normalize_message_id(&m.internet_message_id).into(),
    );
    let in_reply_to = normalize_message_id(&m.in_reply_to);
    if !in_reply_to.is_empty() {
        obj.insert("inReplyTo".into(), in_reply_to.into());
    }
    let refs: Vec<String> = m
        .references
        .split_whitespace()
        .map(normalize_message_id)
        .filter(|r| !r.is_empty())
        .collect();
    if !refs.is_empty() {
        obj.insert("references".into(), serde_json::Value::from(refs));
    }
    // Provenance: only backfill is stamped (live == engine default == omitted).
    if capture == Capture::Backfill {
        obj.insert("capture".into(), capture.as_str().into());
    }
    serde_json::Value::Object(obj)
}

/// Map a validated `TeamsFileV2` to the engine's `POST /api/teams/import` body.
/// Mirrors the engine contract field-for-field: required `author`, `messageId`,
/// `channelId`; optional `channelName`, `teamName`, `dateTimeCreated`,
/// `replyToId`, and ≥1 of `bodyHtml`/`bodyText`; empty optionals omitted. The
/// engine derives `threadKey` from `channelId` + `replyToId` — the sweep never
/// supplies it. `capture` is stamped ALWAYS (a new, explicitly-provenance path).
/// Deterministic + side-effect-free.
pub fn build_teams_import_body(m: &TeamsFileV2, capture: Capture) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("author".into(), m.author.trim().into());
    obj.insert("messageId".into(), m.message_id.trim().into());
    obj.insert("channelId".into(), m.channel_id.trim().into());
    if !m.channel_name.trim().is_empty() {
        obj.insert("channelName".into(), m.channel_name.trim().into());
    }
    if !m.team_name.trim().is_empty() {
        obj.insert("teamName".into(), m.team_name.trim().into());
    }
    if !m.reply_to_id.trim().is_empty() {
        obj.insert("replyToId".into(), m.reply_to_id.trim().into());
    }
    if !m.date_time_created.trim().is_empty() {
        obj.insert("dateTimeCreated".into(), m.date_time_created.trim().into());
    }
    if !m.body_html.trim().is_empty() {
        obj.insert("bodyHtml".into(), m.body_html.clone().into());
    }
    if !m.body_text.trim().is_empty() {
        obj.insert("bodyText".into(), m.body_text.clone().into());
    }
    obj.insert("capture".into(), capture.as_str().into());
    serde_json::Value::Object(obj)
}

/// Trim + drop-empties over an already-split address vec (defensive: an array
/// element could carry surrounding whitespace).
fn clean_list(v: &[String]) -> Vec<String> {
    v.iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// A candidate file discovered in the inbox folder + its modified time.
#[derive(Debug, Clone, PartialEq)]
pub struct ScannedFile {
    pub path: PathBuf,
    pub mtime: std::time::SystemTime,
}

/// Order the scanned files oldest-first (by mtime; ties broken by path so the
/// order is deterministic) and apply the per-sweep cap. Oldest-first so a
/// truncated sweep always drains the longest-waiting mail first and the tail
/// rotates in on later ticks. Returns `(selected, deferred_count)`. Pure.
pub fn select_files(mut files: Vec<ScannedFile>, cap: usize) -> (Vec<PathBuf>, usize) {
    files.sort_by(|a, b| a.mtime.cmp(&b.mtime).then_with(|| a.path.cmp(&b.path)));
    let total = files.len();
    let deferred = total.saturating_sub(cap);
    if deferred > 0 {
        files.truncate(cap);
    }
    (files.into_iter().map(|f| f.path).collect(), deferred)
}

// ── Filesystem helpers (real I/O; the temp-dir tests exercise these — that IS
//    the cross-platform Mac live smoke the verification bar asks for). ─────────

/// Determine the folder gate: not-configured, folder-missing, or ready. Kept
/// separate from the scan so the command can log/skip each state distinctly.
pub fn gate(cfg: &OneDriveMailConfig) -> SweepGate {
    match cfg.folder_path() {
        None => SweepGate::NotConfigured,
        Some(p) => {
            if p.is_dir() {
                SweepGate::Ready
            } else {
                SweepGate::FolderNotFound
            }
        }
    }
}

/// Scan the inbox folder for candidate `*.json` files: top-level regular files
/// with a `.json` extension only. The `processed/` and `failed/` subfolders (and
/// any other subdir) are skipped implicitly — we never recurse. Returns each
/// file with its mtime (for oldest-first ordering). A read error on the dir
/// yields an empty list (the caller treats it as "nothing to do this tick").
pub fn scan_inbox(dir: &Path) -> Vec<ScannedFile> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Top-level regular files only — subdirs (processed/, failed/) skipped.
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        if !has_json_ext(&path) {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        out.push(ScannedFile { path, mtime });
    }
    out
}

/// Count receipts in a directory (non-recursive `*.json`), optionally only those
/// carrying the Teams receipt prefix. `teams_only=false` ⇒ total; `true` ⇒ just
/// Teams receipts. Cheap: one directory read + a filename check per entry (no
/// file contents read, no ledger). Used by the integration doctor to classify
/// receipts by kind. A missing/unreadable dir ⇒ 0.
pub fn count_receipts(dir: &Path, teams_only: bool) -> usize {
    scan_inbox(dir)
        .into_iter()
        .filter(|f| {
            if !teams_only {
                return true;
            }
            f.path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.starts_with(TEAMS_RECEIPT_PREFIX))
                .unwrap_or(false)
        })
        .count()
}

/// True iff the path has a `.json` extension (case-insensitive).
fn has_json_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

/// Move `file` into `<inbox>/<subdir>/`, creating the subdir if needed. On a
/// name collision (a re-run producing the same filename) a numeric suffix is
/// appended so a receipt is never overwritten. Falls back to copy+remove if
/// `rename` fails (e.g. a cross-device move — unlikely inside one OneDrive
/// folder, but robust). Returns the final destination path on success.
pub fn move_into_subdir(file: &Path, inbox: &Path, subdir: &str) -> std::io::Result<PathBuf> {
    move_receipt(file, inbox, subdir, SweptKind::Email)
}

/// Move `file` into `<inbox>/<subdir>/`, applying the kind's receipt filename
/// prefix (Teams receipts become `teams-<name>` so the doctor can classify them
/// from the listing alone; email keeps its name). Same create-dir + collision-
/// suffix + cross-device-fallback semantics as `move_into_subdir`.
pub fn move_receipt(
    file: &Path,
    inbox: &Path,
    subdir: &str,
    kind: SweptKind,
) -> std::io::Result<PathBuf> {
    let dir = inbox.join(subdir);
    std::fs::create_dir_all(&dir)?;
    let file_name = file
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let prefixed = format!("{}{}", kind.receipt_prefix(), file_name);
    let mut dest = dir.join(&prefixed);
    // Collision-avoid: file.json → file.1.json → file.2.json …
    if dest.exists() {
        let base = Path::new(&prefixed);
        let stem = base
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("mail")
            .to_string();
        let ext = base
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("json")
            .to_string();
        let mut n = 1u32;
        loop {
            let candidate = dir.join(format!("{stem}.{n}.{ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            n += 1;
        }
    }
    match std::fs::rename(file, &dest) {
        Ok(()) => Ok(dest),
        Err(_) => {
            // Cross-device or other rename failure: copy then remove the source.
            std::fs::copy(file, &dest)?;
            std::fs::remove_file(file)?;
            Ok(dest)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — pure functions + real-temp-dir fs smoke (the cross-platform Mac
// live verification the bar requires: valid files import→processed, malformed
// →failed, transient-fail files stay put, no panics).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn valid_json(id: &str, mailbox: &str) -> String {
        format!(
            r#"{{
              "schemaVersion": 1,
              "mailbox": "{mailbox}",
              "subject": "Re: Q3 planning",
              "from": "Trisha <trisha@example.com>",
              "to": "brian@client.com; ops@example.com",
              "cc": "",
              "dateTimeCreated": "2026-07-11T14:03:22Z",
              "bodyHtml": "<p>hi</p>",
              "bodyText": "hi",
              "internetMessageId": "{id}",
              "inReplyTo": "",
              "references": ""
            }}"#
        )
    }

    // ── parse_mail_file: schema + required-field enforcement ──

    #[test]
    fn parse_accepts_valid_v1() {
        let m = parse_mail_file(&valid_json("<abc@host>", "inbox")).expect("valid");
        assert_eq!(m.schema_version, Some(1));
        assert_eq!(m.from, "Trisha <trisha@example.com>");
        assert_eq!(m.to, vec!["brian@client.com", "ops@example.com"]);
        assert_eq!(mailbox_label(&m), "inbox");
    }

    #[test]
    fn parse_rejects_malformed_json() {
        let e = parse_mail_file("{not json").unwrap_err();
        assert!(matches!(e, MailFileError::MalformedJson(_)));
    }

    #[test]
    fn parse_rejects_wrong_schema_version() {
        let s = r#"{"schemaVersion":2,"from":"a@x","internetMessageId":"<i@h>","bodyText":"hi"}"#;
        assert!(matches!(
            parse_mail_file(s).unwrap_err(),
            MailFileError::UnsupportedSchemaVersion(_)
        ));
        // Absent schemaVersion is also rejected (forward-compat guard).
        let s2 = r#"{"from":"a@x","internetMessageId":"<i@h>","bodyText":"hi"}"#;
        assert!(matches!(
            parse_mail_file(s2).unwrap_err(),
            MailFileError::UnsupportedSchemaVersion(_)
        ));
    }

    #[test]
    fn parse_rejects_missing_required_and_bodyless() {
        let no_from = r#"{"schemaVersion":1,"internetMessageId":"<i@h>","bodyText":"hi"}"#;
        assert_eq!(
            parse_mail_file(no_from).unwrap_err(),
            MailFileError::MissingRequiredField("from")
        );
        let no_id = r#"{"schemaVersion":1,"from":"a@x","bodyText":"hi"}"#;
        assert_eq!(
            parse_mail_file(no_id).unwrap_err(),
            MailFileError::MissingRequiredField("internetMessageId")
        );
        let no_body = r#"{"schemaVersion":1,"from":"a@x","internetMessageId":"<i@h>"}"#;
        assert_eq!(parse_mail_file(no_body).unwrap_err(), MailFileError::NoBody);
    }

    // ── to/cc: string OR array; delimiter handling ──

    #[test]
    fn recipients_accept_string_or_array() {
        let as_string =
            r#"{"schemaVersion":1,"from":"a@x","internetMessageId":"<i@h>","bodyText":"hi","to":"a@x.com; b@y.com","cc":"c@z.com"}"#;
        let m = parse_mail_file(as_string).unwrap();
        assert_eq!(m.to, vec!["a@x.com", "b@y.com"]);
        assert_eq!(m.cc, vec!["c@z.com"]);

        let as_array =
            r#"{"schemaVersion":1,"from":"a@x","internetMessageId":"<i@h>","bodyText":"hi","to":["a@x.com","b@y.com"],"cc":[]}"#;
        let m2 = parse_mail_file(as_array).unwrap();
        assert_eq!(m2.to, vec!["a@x.com", "b@y.com"]);
        assert!(m2.cc.is_empty());
    }

    #[test]
    fn split_addr_string_handles_both_delimiters() {
        assert_eq!(
            split_addr_string("a@x.com; b@y.com , c@z.com"),
            vec!["a@x.com", "b@y.com", "c@z.com"]
        );
        assert!(split_addr_string("   ").is_empty());
    }

    // ── build_import_body: the body-extraction mapping ──

    #[test]
    fn build_import_body_maps_and_normalizes() {
        let m = parse_mail_file(
            r#"{"schemaVersion":1,"mailbox":"sent","subject":"Re: Q3","from":"Trisha <t@x.com>",
                "to":"a@x.com;b@y.com","cc":"c@z.com","dateTimeCreated":"2026-07-11T14:00:00-04:00",
                "bodyHtml":"<p>hi</p>","bodyText":"hi","internetMessageId":"reply@host",
                "inReplyTo":"<root@host>","references":"<root@host> <mid2@host>"}"#,
        )
        .unwrap();
        // v1/live body is byte-identical to what this build always produced —
        // capture is NOT stamped for Live (engine defaults absent ⇒ live).
        let body = build_import_body(&m, Capture::Live);
        assert_eq!(body["subject"], "Re: Q3");
        assert_eq!(body["from"], "Trisha <t@x.com>");
        assert_eq!(body["to"], serde_json::json!(["a@x.com", "b@y.com"]));
        assert_eq!(body["cc"], serde_json::json!(["c@z.com"]));
        assert_eq!(body["dateTimeCreated"], "2026-07-11T14:00:00-04:00");
        assert_eq!(body["bodyHtml"], "<p>hi</p>");
        assert_eq!(body["bodyText"], "hi");
        // internetMessageId normalized to <...>.
        assert_eq!(body["internetMessageId"], "<reply@host>");
        assert_eq!(body["inReplyTo"], "<root@host>");
        assert_eq!(body["references"], serde_json::json!(["<root@host>", "<mid2@host>"]));
        // Transport metadata is NOT sent to the engine; live ⇒ no capture stamp.
        assert!(body.get("schemaVersion").is_none());
        assert!(body.get("mailbox").is_none());
        assert!(body.get("capture").is_none());
    }

    #[test]
    fn build_import_body_omits_empty_optionals() {
        let m = parse_mail_file(
            r#"{"schemaVersion":1,"from":"a@x.com","internetMessageId":"<id@h>","bodyText":"hi"}"#,
        )
        .unwrap();
        let body = build_import_body(&m, Capture::Live);
        assert!(body.get("subject").is_none());
        assert!(body.get("bodyHtml").is_none());
        assert!(body.get("inReplyTo").is_none());
        assert!(body.get("references").is_none());
        // to / cc always arrays (engine's asStringArray needs an array).
        assert_eq!(body["to"], serde_json::json!([]));
        assert_eq!(body["cc"], serde_json::json!([]));
        assert_eq!(body["from"], "a@x.com");
        assert_eq!(body["internetMessageId"], "<id@h>");
    }

    // ── v2 dispatch: kind routing + capture passthrough + v1 back-compat ──

    fn v2_email_json(id: &str, capture: &str) -> String {
        format!(
            r#"{{"schemaVersion":2,"kind":"email","capture":"{capture}","mailbox":"sent",
                "from":"Trisha <t@x.com>","to":"a@x.com","cc":"","subject":"Backfilled",
                "dateTimeCreated":"2026-06-20T09:00:00Z","bodyHtml":"<p>old</p>",
                "internetMessageId":"{id}"}}"#
        )
    }

    fn v2_teams_json(mid: &str, reply_to: &str, capture: &str) -> String {
        let reply = if reply_to.is_empty() {
            String::new()
        } else {
            format!(r#""replyToId":"{reply_to}","#)
        };
        format!(
            r#"{{"schemaVersion":2,"kind":"teams-channel","capture":"{capture}",
                "channelName":"Renewals","teamName":"Client Ops","author":"Brian Ng",
                "dateTimeCreated":"2026-07-11T15:00:00Z","bodyHtml":"<p>ping</p>",
                {reply}"messageId":"{mid}","channelId":"19:abcCHANNEL@thread.tacv2"}}"#
        )
    }

    #[test]
    fn dispatch_v1_routes_to_live_email() {
        // A v1 file (no kind) parses via the UNCHANGED v1 path ⇒ Email/Live.
        let rec = parse_swept_file(&valid_json("<v1@host>", "inbox")).expect("v1 ok");
        match &rec {
            SweptRecord::Email { mail, capture } => {
                assert_eq!(*capture, Capture::Live);
                assert_eq!(mail.from, "Trisha <trisha@example.com>");
                // Byte-identical body to the legacy build.
                let body = build_import_body(mail, *capture);
                assert!(body.get("capture").is_none());
            }
            other => panic!("expected Email, got {other:?}"),
        }
        assert_eq!(rec.kind(), SweptKind::Email);
    }

    #[test]
    fn dispatch_v2_email_backfill_stamps_capture() {
        let rec = parse_swept_file(&v2_email_json("backfill@host", "backfill")).unwrap();
        match &rec {
            SweptRecord::Email { mail, capture } => {
                assert_eq!(*capture, Capture::Backfill);
                let body = build_import_body(mail, *capture);
                assert_eq!(body["capture"], "backfill");
                assert_eq!(body["bodyHtml"], "<p>old</p>");
                assert_eq!(body["internetMessageId"], "<backfill@host>");
            }
            other => panic!("expected Email, got {other:?}"),
        }
        // v2 email with capture:live ⇒ no stamp (byte-identical to live).
        let live = parse_swept_file(&v2_email_json("live@host", "live")).unwrap();
        assert_eq!(live.capture(), Capture::Live);
        if let SweptRecord::Email { mail, capture } = &live {
            assert!(build_import_body(mail, *capture).get("capture").is_none());
        }
    }

    #[test]
    fn dispatch_v2_teams_live_and_backfill() {
        // Live root message ⇒ Teams/Live, body carries capture + required fields.
        let rec = parse_swept_file(&v2_teams_json("msg-1", "", "live")).unwrap();
        match &rec {
            SweptRecord::Teams { msg, capture } => {
                assert_eq!(*capture, Capture::Live);
                assert_eq!(msg.channel_id, "19:abcCHANNEL@thread.tacv2");
                let body = build_teams_import_body(msg, *capture);
                assert_eq!(body["author"], "Brian Ng");
                assert_eq!(body["messageId"], "msg-1");
                assert_eq!(body["channelId"], "19:abcCHANNEL@thread.tacv2");
                assert_eq!(body["bodyHtml"], "<p>ping</p>");
                assert_eq!(body["capture"], "live");
                // A root post carries no replyToId.
                assert!(body.get("replyToId").is_none());
                // Sweep NEVER supplies a thread key (engine authority).
                assert!(body.get("threadKey").is_none());
            }
            other => panic!("expected Teams, got {other:?}"),
        }
        assert_eq!(rec.kind(), SweptKind::Teams);

        // Backfill reply ⇒ replyToId carried, capture stamped backfill.
        let reply = parse_swept_file(&v2_teams_json("msg-2", "msg-1", "backfill")).unwrap();
        if let SweptRecord::Teams { msg, capture } = &reply {
            assert_eq!(*capture, Capture::Backfill);
            let body = build_teams_import_body(msg, *capture);
            assert_eq!(body["replyToId"], "msg-1");
            assert_eq!(body["capture"], "backfill");
        } else {
            panic!("expected Teams reply");
        }
    }

    #[test]
    fn dispatch_rejects_bad_kind_capture_and_missing_teams_fields() {
        // Unknown kind ⇒ UnsupportedKind (quarantine).
        let bad_kind = r#"{"schemaVersion":2,"kind":"chat","author":"x","messageId":"m","channelId":"c","bodyText":"hi"}"#;
        assert!(matches!(
            parse_swept_file(bad_kind).unwrap_err(),
            MailFileError::UnsupportedKind(_)
        ));
        // v2 with absent kind ⇒ UnsupportedKind.
        let no_kind = r#"{"schemaVersion":2,"author":"x","messageId":"m","channelId":"c","bodyText":"hi"}"#;
        assert!(matches!(
            parse_swept_file(no_kind).unwrap_err(),
            MailFileError::UnsupportedKind(_)
        ));
        // Present-but-invalid capture ⇒ InvalidCapture (never coerced).
        let bad_cap = r#"{"schemaVersion":2,"kind":"teams-channel","capture":"archive","author":"x","messageId":"m","channelId":"c","bodyText":"hi"}"#;
        assert!(matches!(
            parse_swept_file(bad_cap).unwrap_err(),
            MailFileError::InvalidCapture(_)
        ));
        // Teams missing channelId ⇒ MissingRequiredField.
        let no_channel = r#"{"schemaVersion":2,"kind":"teams-channel","author":"x","messageId":"m","bodyText":"hi"}"#;
        assert_eq!(
            parse_swept_file(no_channel).unwrap_err(),
            MailFileError::MissingRequiredField("channelId")
        );
        // Teams missing author ⇒ MissingRequiredField.
        let no_author = r#"{"schemaVersion":2,"kind":"teams-channel","messageId":"m","channelId":"c","bodyText":"hi"}"#;
        assert_eq!(
            parse_swept_file(no_author).unwrap_err(),
            MailFileError::MissingRequiredField("author")
        );
        // Teams no body ⇒ NoBody.
        let no_body = r#"{"schemaVersion":2,"kind":"teams-channel","author":"x","messageId":"m","channelId":"c"}"#;
        assert_eq!(parse_swept_file(no_body).unwrap_err(), MailFileError::NoBody);
        // Unknown schemaVersion ⇒ UnsupportedSchemaVersion.
        let v3 = r#"{"schemaVersion":3,"kind":"email"}"#;
        assert!(matches!(
            parse_swept_file(v3).unwrap_err(),
            MailFileError::UnsupportedSchemaVersion(_)
        ));
    }

    #[test]
    fn capture_parse_rules() {
        assert_eq!(Capture::parse(None).unwrap(), Capture::Live);
        assert_eq!(Capture::parse(Some("")).unwrap(), Capture::Live);
        assert_eq!(Capture::parse(Some("live")).unwrap(), Capture::Live);
        assert_eq!(Capture::parse(Some("backfill")).unwrap(), Capture::Backfill);
        assert!(Capture::parse(Some("bogus")).is_err());
        assert_eq!(Capture::Live.as_str(), "live");
        assert_eq!(Capture::Backfill.as_str(), "backfill");
    }

    // ── select_files: oldest-first ordering + cap ──

    fn sf(name: &str, secs: u64) -> ScannedFile {
        ScannedFile {
            path: PathBuf::from(name),
            mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
        }
    }

    #[test]
    fn select_files_orders_oldest_first_and_caps() {
        let files = vec![sf("c.json", 300), sf("a.json", 100), sf("b.json", 200)];
        let (sel, deferred) = select_files(files, 2);
        assert_eq!(deferred, 1);
        assert_eq!(sel, vec![PathBuf::from("a.json"), PathBuf::from("b.json")]);
    }

    #[test]
    fn select_files_no_cap_returns_all() {
        let files = vec![sf("a.json", 100), sf("b.json", 200)];
        let (sel, deferred) = select_files(files, 100);
        assert_eq!(deferred, 0);
        assert_eq!(sel.len(), 2);
    }

    #[test]
    fn select_files_ties_break_on_path() {
        let files = vec![sf("z.json", 100), sf("a.json", 100)];
        let (sel, _) = select_files(files, 100);
        assert_eq!(sel, vec![PathBuf::from("a.json"), PathBuf::from("z.json")]);
    }

    // ── config gate + folder_path ──

    #[test]
    fn config_gate_states() {
        assert_eq!(gate(&OneDriveMailConfig::default()), SweepGate::NotConfigured);
        let missing = OneDriveMailConfig {
            folder: Some("/no/such/threshold/mail/dir/zzz".into()),
        };
        assert_eq!(gate(&missing), SweepGate::FolderNotFound);
        // Ready is exercised by the temp-dir smoke below.
    }

    #[test]
    fn config_serde_is_additive_default() {
        // Legacy config with no oneDriveMail field ⇒ default (folder None).
        let c: OneDriveMailConfig = serde_json::from_str("{}").unwrap();
        assert!(c.folder.is_none());
        assert!(c.folder_path().is_none());
        // Blank string ⇒ treated as unset.
        let blank = OneDriveMailConfig { folder: Some("   ".into()) };
        assert!(blank.folder_path().is_none());
    }

    // ── FS SMOKE (the cross-platform Mac live verification) ──────────────────
    // A real temp folder + a v1 email + a v2 email backfill + a v2 Teams msg + a
    // v2 Teams lane-off + a malformed file. Proves, WITHOUT a live engine (the
    // engine outcome is simulated via a typed branch): scan finds only top-level
    // json; the v2 dispatcher routes each kind; a valid file moves to processed/
    // (Teams receipts carry the teams- prefix); a lane-off Teams file moves to
    // skipped/ (prefixed); a malformed file moves to failed/; a transient-fail
    // file stays in place (retryable) — no panics.

    #[test]
    fn fs_smoke_scan_parse_and_move() {
        let root = std::env::temp_dir().join(format!(
            "threshold-odrive-smoke-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        // Files, written oldest-first by touch order.
        let f_v1 = root.join("mail-001.json"); // v1 email → transient-leave
        std::fs::write(&f_v1, valid_json("<m1@host>", "inbox")).unwrap();
        let f_v2mail = root.join("mail-002.json"); // v2 email backfill → processed
        std::fs::write(&f_v2mail, v2_email_json("v2mail@host", "backfill")).unwrap();
        let f_teams = root.join("teams-003.json"); // v2 teams → processed (prefixed)
        std::fs::write(&f_teams, v2_teams_json("tmsg-1", "", "live")).unwrap();
        let f_teamsoff = root.join("teams-004.json"); // v2 teams → lane off → skipped/
        std::fs::write(&f_teamsoff, v2_teams_json("tmsg-2", "", "backfill")).unwrap();
        let bad = root.join("mail-bad.json"); // malformed → failed
        std::fs::write(&bad, "{ this is not valid json").unwrap();
        // A non-json file must be ignored entirely.
        std::fs::write(root.join("notes.txt"), "ignore me").unwrap();

        // Gate = ready.
        let cfg = OneDriveMailConfig {
            folder: Some(root.to_string_lossy().into_owned()),
        };
        assert_eq!(gate(&cfg), SweepGate::Ready);

        // Scan finds exactly the 5 json files (txt ignored).
        let scanned = scan_inbox(&root);
        assert_eq!(scanned.len(), 5, "should find 5 json files");
        let (ordered, deferred) = select_files(scanned, ONEDRIVE_MAIL_FILE_CAP);
        assert_eq!(deferred, 0);
        assert_eq!(ordered.len(), 5);

        // Simulate the command's per-file loop WITHOUT the engine. The engine
        // outcome is chosen by a typed branch keyed off the file name:
        //   *-001  ⇒ transient failure (leave in place)
        //   teams-004 ⇒ lane disabled (skipped/)
        //   everything else valid ⇒ imported (processed/)
        let mut imported = 0;
        let mut quarantined = 0;
        let mut left_in_place = 0;
        let mut skipped = 0;
        for path in ordered.iter() {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let contents = std::fs::read_to_string(path).unwrap();
            match parse_swept_file(&contents) {
                Ok(rec) => {
                    // Body maps cleanly for whichever kind (would be POSTed).
                    match &rec {
                        SweptRecord::Email { mail, capture } => {
                            assert!(build_import_body(mail, *capture)["from"].is_string());
                        }
                        SweptRecord::Teams { msg, capture } => {
                            assert!(build_teams_import_body(msg, *capture)["author"].is_string());
                        }
                    }
                    if name == "mail-001.json" {
                        // Transient engine failure → leave in place, retry next tick.
                        left_in_place += 1;
                        assert!(path.exists(), "transient-fail file must stay put");
                    } else if name == "teams-004.json" {
                        // Lane disabled ⇒ skipped/ (kind-prefixed), never re-scanned.
                        move_receipt(path, &root, SKIPPED_DIR, rec.kind()).unwrap();
                        skipped += 1;
                    } else {
                        move_receipt(path, &root, PROCESSED_DIR, rec.kind()).unwrap();
                        imported += 1;
                    }
                }
                Err(_) => {
                    // Malformed ⇒ quarantine (email kind = no prefix).
                    move_receipt(path, &root, FAILED_DIR, SweptKind::Email).unwrap();
                    quarantined += 1;
                }
            }
        }

        assert_eq!(imported, 2, "v2 email + v2 teams imported→processed");
        assert_eq!(quarantined, 1, "malformed file quarantined→failed");
        assert_eq!(left_in_place, 1, "transient-fail file retained");
        assert_eq!(skipped, 1, "lane-off teams file → skipped/");

        // processed/ has 2 (one of them a Teams receipt); failed/ 1; skipped/ 1.
        assert_eq!(scan_inbox(&root.join(PROCESSED_DIR)).len(), 2);
        assert_eq!(scan_inbox(&root.join(FAILED_DIR)).len(), 1);
        assert_eq!(scan_inbox(&root.join(SKIPPED_DIR)).len(), 1);

        // The doctor's cheap classification: exactly one Teams receipt in
        // processed/ (prefixed), one Teams receipt in skipped/, zero in failed/.
        assert_eq!(count_receipts(&root.join(PROCESSED_DIR), true), 1);
        assert_eq!(count_receipts(&root.join(PROCESSED_DIR), false), 2);
        assert_eq!(count_receipts(&root.join(SKIPPED_DIR), true), 1);
        assert_eq!(count_receipts(&root.join(FAILED_DIR), true), 0);

        // The Teams receipt actually carries the teams- prefix on disk.
        let processed = scan_inbox(&root.join(PROCESSED_DIR));
        assert!(
            processed
                .iter()
                .any(|f| f.path.file_name().unwrap().to_string_lossy().starts_with("teams-")),
            "a processed Teams receipt must be teams-prefixed"
        );

        // Root now holds only the retained transient-fail v1 file among json.
        assert_eq!(scan_inbox(&root).len(), 1);
        assert!(f_v1.exists(), "retained file present at root");
        assert!(!f_v2mail.exists(), "processed file moved out of root");
        assert!(!f_teams.exists(), "processed teams file moved out of root");
        assert!(!f_teamsoff.exists(), "skipped teams file moved out of root");
        assert!(!bad.exists(), "quarantined file moved out of root");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ── Error semantics ──

    #[test]
    fn error_user_messages_non_empty() {
        for e in &[
            MailFileError::MalformedJson("x".into()),
            MailFileError::UnsupportedSchemaVersion("3".into()),
            MailFileError::UnsupportedKind("chat".into()),
            MailFileError::InvalidCapture("archive".into()),
            MailFileError::MissingRequiredField("from"),
            MailFileError::NoBody,
        ] {
            assert!(!e.user_message().is_empty());
            let _ = format!("{}", e);
        }
    }
}
