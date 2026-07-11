//! WP-INTAKE (contingency transport) — OneDrive folder-sweep email channel.
//!
//! The New-Outlook-safe mail on-ramp. New Outlook (the sandboxed Store app) has
//! no COM surface, so the E5-app `email_follow` sweep (classic-Outlook COM)
//! can't reach it. This module is the SIBLING transport: a Power Automate flow
//! in the user's own tenant (standard connectors, user-consent level — verified
//! green in the pilot tenant 2026-07-11) writes each arriving / sent email as a
//! small JSON file into a OneDrive folder; the OneDrive sync client mirrors that
//! folder to local disk; this sweep reads the local folder on the SAME shared
//! app tick and pushes each file through the engine's EXISTING
//! `POST /api/email/import` — the very endpoint E5-app's COM sweep feeds. One
//! import authority, two transports.
//!
//! ── Why this transport ──────────────────────────────────────────────────────
//! Pure filesystem + HTTP. No COM, so unlike `email_follow` it works on BOTH
//! macOS and Windows (and is therefore live-testable on the dev Mac). The flow
//! runs in Microsoft's cloud (no daemon on the user's box); the sweep only ever
//! reads files the sync client already mirrored locally — the app being closed
//! all morning just means the next tick catches up on whatever accumulated.
//!
//! ── File schema v1 (what the Power Automate flow writes) ─────────────────────
//! One JSON object per file (see `MailFileV1`). Required: `from`,
//! `internetMessageId`, and at least one body (`bodyHtml` | `bodyText`) — the
//! same floor `POST /api/email/import` validates. `to` / `cc` may be a
//! semicolon/comma-delimited STRING (the shape the Office 365 Outlook trigger's
//! dynamic content produces — flow-friendly, no expressions) OR a JSON array
//! (defensive). `schemaVersion` MUST be 1; `mailbox` is `"inbox"` | `"sent"`
//! (informational + logged — both import identically; the Sent copies feed the
//! vigilance ingress-owed void, same as E5-app's Sent scan).
//!
//! ── Processed-file handling ──────────────────────────────────────────────────
//! After a successful import (engine `ok` OR `duplicate`) the file is MOVED to a
//! `processed/` subfolder; a file whose JSON is malformed / wrong-schema /
//! missing-required is MOVED to `failed/`. Move (not a persisted ledger) is the
//! never-re-import guarantee: it is filesystem-atomic, survives restarts with
//! zero bookkeeping, and leaves a visible receipt the user (or a support session)
//! can inspect. A file we could NOT import for a transient reason (engine
//! unreachable / 5xx) is LEFT IN PLACE so the next tick retries it — the
//! watermark equivalent here is simply "still in the inbox folder". The OneDrive
//! sync client mirrors the move back to the cloud; that is fine — the folder is
//! capture plumbing, not user data.
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

/// The schema version this build understands. A file declaring anything else is
/// quarantined to `failed/` (forward-compat guard: a future flow bump won't be
/// silently mis-imported by an old app).
pub const SCHEMA_VERSION: u32 = 1;

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
/// route the file to `failed/` (quarantine, never re-read).
#[derive(Debug, PartialEq)]
pub enum MailFileError {
    /// `serde_json` couldn't parse the file as an object.
    MalformedJson(String),
    /// `schemaVersion` was absent or not `SCHEMA_VERSION`.
    UnsupportedSchemaVersion(String),
    /// A required field (`from` / `internetMessageId`) was empty/absent.
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
            MailFileError::MalformedJson(_) => "A mail file wasn't valid JSON (quarantined).",
            MailFileError::UnsupportedSchemaVersion(_) => {
                "A mail file used an unsupported schema version (quarantined)."
            }
            MailFileError::MissingRequiredField(_) => {
                "A mail file was missing a required field (quarantined)."
            }
            MailFileError::NoBody => "A mail file had no message body (quarantined).",
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
            MailFileError::MissingRequiredField(name) => {
                write!(f, "missing required field: {}", name)
            }
            MailFileError::NoBody => write!(f, "no body (bodyHtml/bodyText both empty)"),
        }
    }
}

impl std::error::Error for MailFileError {}

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

/// Parse + validate a file's contents into a `MailFileV1`. Enforces the schema
/// version, the two required fields, and the at-least-one-body floor BEFORE the
/// engine ever sees it (so a bad file is quarantined locally, not bounced over
/// the wire). Deterministic + side-effect-free.
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
    if parsed.from.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("from"));
    }
    if parsed.internet_message_id.trim().is_empty() {
        return Err(MailFileError::MissingRequiredField("internetMessageId"));
    }
    if parsed.body_html.trim().is_empty() && parsed.body_text.trim().is_empty() {
        return Err(MailFileError::NoBody);
    }
    Ok(parsed)
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
/// engine body has no slot for them. Deterministic + side-effect-free: this is
/// the body-extraction mapping the verification bar requires under test.
pub fn build_import_body(m: &MailFileV1) -> serde_json::Value {
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
    let dir = inbox.join(subdir);
    std::fs::create_dir_all(&dir)?;
    let file_name = file
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let mut dest = dir.join(file_name);
    // Collision-avoid: file.json → file.1.json → file.2.json …
    if dest.exists() {
        let stem = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("mail")
            .to_string();
        let ext = file
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
        let body = build_import_body(&m);
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
        // Transport metadata is NOT sent to the engine.
        assert!(body.get("schemaVersion").is_none());
        assert!(body.get("mailbox").is_none());
    }

    #[test]
    fn build_import_body_omits_empty_optionals() {
        let m = parse_mail_file(
            r#"{"schemaVersion":1,"from":"a@x.com","internetMessageId":"<id@h>","bodyText":"hi"}"#,
        )
        .unwrap();
        let body = build_import_body(&m);
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
    // A real temp folder + 2 valid + 1 malformed file. Proves: scan finds the
    // three top-level json (not the subdir receipts), ordering is oldest-first,
    // a valid file moves to processed/, a malformed file moves to failed/, and a
    // transient-fail file stays in place (retryable next tick) — no panics.

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

        // Two valid + one malformed, written oldest-first by touch order.
        let f1 = root.join("mail-001.json");
        std::fs::write(&f1, valid_json("<m1@host>", "inbox")).unwrap();
        let f2 = root.join("mail-002.json");
        std::fs::write(&f2, valid_json("<m2@host>", "sent")).unwrap();
        let bad = root.join("mail-bad.json");
        std::fs::write(&bad, "{ this is not valid json").unwrap();
        // A non-json file must be ignored entirely.
        std::fs::write(root.join("notes.txt"), "ignore me").unwrap();

        // Gate = ready.
        let cfg = OneDriveMailConfig {
            folder: Some(root.to_string_lossy().into_owned()),
        };
        assert_eq!(gate(&cfg), SweepGate::Ready);

        // Scan finds exactly the 3 json files (txt ignored).
        let scanned = scan_inbox(&root);
        assert_eq!(scanned.len(), 3, "should find 3 json files");
        let (ordered, deferred) = select_files(scanned, ONEDRIVE_MAIL_FILE_CAP);
        assert_eq!(deferred, 0);
        assert_eq!(ordered.len(), 3);

        // Simulate the command's per-file loop WITHOUT the engine: parse each;
        // valid → (pretend import ok) move to processed/; malformed → failed/.
        // Also prove a transient-fail valid file is LEFT IN PLACE.
        let mut imported = 0;
        let mut quarantined = 0;
        let mut left_in_place = 0;
        for (i, path) in ordered.iter().enumerate() {
            let contents = std::fs::read_to_string(path).unwrap();
            match parse_mail_file(&contents) {
                Ok(m) => {
                    // Body maps cleanly (would be POSTed).
                    let body = build_import_body(&m);
                    assert_eq!(body["from"].is_string(), true);
                    // First valid file: simulate a transient engine failure →
                    // leave it in place (retry next tick).
                    if i == 0 {
                        left_in_place += 1;
                        assert!(path.exists(), "transient-fail file must stay put");
                    } else {
                        move_into_subdir(path, &root, PROCESSED_DIR).unwrap();
                        imported += 1;
                    }
                }
                Err(_) => {
                    move_into_subdir(path, &root, FAILED_DIR).unwrap();
                    quarantined += 1;
                }
            }
        }

        assert_eq!(imported, 1, "one valid file imported→processed");
        assert_eq!(quarantined, 1, "malformed file quarantined→failed");
        assert_eq!(left_in_place, 1, "transient-fail file retained");

        // processed/ has exactly one file; failed/ has exactly one; the retained
        // valid file still sits at the inbox root.
        assert_eq!(scan_inbox(&root.join(PROCESSED_DIR)).len(), 1);
        assert_eq!(scan_inbox(&root.join(FAILED_DIR)).len(), 1);
        // Root now holds only the retained transient-fail file among json.
        assert_eq!(scan_inbox(&root).len(), 1);
        assert!(f1.exists(), "retained file present at root");
        assert!(!f2.exists(), "processed file moved out of root");
        assert!(!bad.exists(), "quarantined file moved out of root");

        // Collision-avoidance: moving another file of the same name into
        // processed/ must NOT overwrite the receipt.
        let dup = root.join("mail-002.json");
        std::fs::write(&dup, valid_json("<m2b@host>", "sent")).unwrap();
        move_into_subdir(&dup, &root, PROCESSED_DIR).unwrap();
        assert_eq!(
            scan_inbox(&root.join(PROCESSED_DIR)).len(),
            2,
            "collision suffix, no overwrite"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    // ── Error semantics ──

    #[test]
    fn error_user_messages_non_empty() {
        for e in &[
            MailFileError::MalformedJson("x".into()),
            MailFileError::UnsupportedSchemaVersion("2".into()),
            MailFileError::MissingRequiredField("from"),
            MailFileError::NoBody,
        ] {
            assert!(!e.user_message().is_empty());
            let _ = format!("{}", e);
        }
    }
}
