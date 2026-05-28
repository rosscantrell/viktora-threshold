//! Windows OneNote COM client (WP-OneNote-Export-02).
//!
//! Substrate: PowerShell shell-out per WP-OneNote-Export-Brief §2.3 +
//! WP-OneNote-Export-Research-Findings §1 (Claim 1). PowerShell handles
//! `IDispatch`/`VARIANT` ceremony natively — avoids ~100-200 LOC of `unsafe`
//! Rust per COM method. We spawn a fresh `powershell.exe` per operation; the
//! per-poll cost (~50-150ms shell startup) is the documented floor for
//! shell-out polling. Fresh shells also avoid RCW accumulation under the
//! dllhost MTA (per OneMore's `OneNote.cs:289-291` cautionary comment).
//!
//! Three core operations, each backed by an inline raw-string PowerShell
//! script:
//!   1. `enumerate_hierarchy()` — `Application.GetHierarchy("", 4, ...)`
//!      returns the full notebook/section/page tree XML.
//!   2. `get_active_page()` — `Application.Windows.CurrentWindow.CurrentPageId`
//!      returns the currently-viewed page id (or `None`).
//!   3. `export_page()` — `Application.Publish(pageId, path, 3, "")` with
//!      numbered-suffix retry (Microsoft docs: target path must not
//!      pre-exist).
//!
//! Mac stub at the bottom of the file via `#[cfg(not(target_os = "windows"))]`
//! returns `PlatformUnsupported` from every public function so the
//! cross-platform build stays clean.

use std::path::{Path, PathBuf};

// ───────────────────────────────────────────────────────────────────────────
// Public types (cross-platform — shape is identical on Mac for serde)
// ───────────────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};

/// A single OneNote page node from `GetHierarchy`. Fields populated from the
/// XML attributes Microsoft emits (`ID`, `name`, `lastModifiedTime`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub page_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_time: Option<String>,
}

/// A OneNote section containing zero or more pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub section_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_time: Option<String>,
    pub pages: Vec<Page>,
}

/// A OneNote notebook containing zero or more sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub notebook_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_time: Option<String>,
    pub sections: Vec<Section>,
}

/// Full hierarchy tree returned by `enumerate_hierarchy`. Serde-friendly so
/// the Tauri command can return it to the frontend directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookTree {
    pub notebooks: Vec<Notebook>,
}

/// Enriched metadata for a single page — used by the full send-flow IPC to
/// stamp `sourceMetadata` on the Apolla payload. Composed by joining a
/// `pageId` (from `get_active_page` or supplied by the frontend) against
/// the full hierarchy tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMetadata {
    pub page_id: String,
    pub title: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub section_id: String,
    pub section_name: String,
    /// "Notebook / Section" — display string for the docs-list pill tooltip
    /// and the Apolla payload's `sourceMetadata.notebookPath`.
    pub notebook_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_time: Option<String>,
}

/// Distinguishable error variants for the COM operations. Each variant has a
/// caller-facing `user_message()` for toast rendering; the upstream IPC
/// commands map these to the `IngestionOutcome` shape `lib.rs` already uses.
///
/// Variants are intentionally narrow — they encode the failure classes the
/// brief calls out (§7 risk #6 = COM-class-not-found on UWP, plus the
/// standard set of script-spawn / parse / file-IO modes).
///
/// `dead_code` is suppressed on non-Windows because the Mac/Linux stubs only
/// ever return `PlatformUnsupported`; the other variants are constructed by
/// the Windows `imp` module (or `parse_hierarchy_xml`) and by the unit tests
/// (which still exercise the variants on Mac to guard the `user_message`
/// + `Display` impls).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug)]
pub enum OneNoteError {
    /// `OneNote.Application` COM class is not registered. The most common
    /// cause is running on the deprecated OneNote-for-Windows-10 (UWP)
    /// variant where the COM surface is sandboxed away (brief §7 risk #1).
    /// Treated as user-actionable: instruct migration to M365 desktop
    /// OneNote, or fall back to the export-watch path (WP-EXPORT-01).
    ComClassNotRegistered,
    /// `Application.Windows.CurrentWindow` returned `null`. OneNote is
    /// running but no notebook is open. Lifted to a distinct variant so the
    /// hotkey UX can render "Open a OneNote notebook first" rather than a
    /// generic error.
    NoNotebookOpen,
    /// `powershell.exe` exited non-zero. Carries stderr for the toast body.
    PowerShellExitNonZero { code: i32, stderr: String },
    /// `powershell.exe` couldn't be spawned at all (most likely cause: PATH
    /// doesn't include `System32`; very rare on real Windows installs).
    PowerShellSpawnFailed(String),
    /// `Application.GetHierarchy(...)` returned text but XML parsing failed
    /// (malformed namespace declaration, truncated stream, etc.). Carries
    /// the underlying error for logging.
    XmlParseFailed(String),
    /// `Application.Publish(...)` returned success but no file appeared at
    /// the expected path. Empirically rare; documented in Not-Chur-Architect
    /// scripts as needing a small post-Publish wait. Distinct variant so
    /// retries land here rather than masquerading as a corrupted-file error.
    FileNotProduced(String),
    /// Catch-all for unexpected failures.
    Other(String),
    /// Non-Windows platform. Returned by all functions on Mac/Linux so the
    /// cross-platform compile is clean and IPC consumers get a consistent
    /// failure shape.
    PlatformUnsupported,
}

impl OneNoteError {
    /// Short user-visible message for toast titles. Keep these terse — the
    /// toast body carries detail (stderr, paths, etc.).
    pub fn user_message(&self) -> &'static str {
        match self {
            OneNoteError::ComClassNotRegistered => {
                "OneNote COM unavailable (try the Microsoft 365 desktop OneNote, or drag a PDF export instead)"
            }
            OneNoteError::NoNotebookOpen => {
                "No OneNote notebook is currently open"
            }
            OneNoteError::PowerShellExitNonZero { .. } => {
                "Couldn't run OneNote COM command (PowerShell error)"
            }
            OneNoteError::PowerShellSpawnFailed(_) => {
                "Couldn't launch PowerShell (is it on PATH?)"
            }
            OneNoteError::XmlParseFailed(_) => {
                "Couldn't parse OneNote hierarchy response"
            }
            OneNoteError::FileNotProduced(_) => {
                "OneNote reported success but the PDF was not written"
            }
            OneNoteError::Other(_) => "OneNote COM call failed",
            OneNoteError::PlatformUnsupported => {
                "OneNote COM capture is Windows-only (drag a PDF export instead)"
            }
        }
    }
}

impl std::fmt::Display for OneNoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OneNoteError::ComClassNotRegistered => {
                write!(f, "OneNote.Application COM class not registered")
            }
            OneNoteError::NoNotebookOpen => write!(f, "No OneNote notebook is open"),
            OneNoteError::PowerShellExitNonZero { code, stderr } => {
                write!(f, "powershell.exe exited with code {}: {}", code, stderr)
            }
            OneNoteError::PowerShellSpawnFailed(e) => {
                write!(f, "powershell.exe spawn failed: {}", e)
            }
            OneNoteError::XmlParseFailed(e) => write!(f, "XML parse failed: {}", e),
            OneNoteError::FileNotProduced(p) => write!(f, "expected PDF not found at {}", p),
            OneNoteError::Other(e) => write!(f, "OneNote COM error: {}", e),
            OneNoteError::PlatformUnsupported => {
                write!(f, "OneNote COM capture is not available on this platform")
            }
        }
    }
}

impl std::error::Error for OneNoteError {}

// ───────────────────────────────────────────────────────────────────────────
// Windows implementation (PowerShell shell-out)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::process::Command;

    /// `Application.GetHierarchy("", hsPages=4, ...)` — returns the full
    /// notebook/section/page tree XML on stdout. Per
    /// WP-OneNote-Export-Research-Findings §1 Claim 3 (Microsoft Learn
    /// canonical sample). The `[xml]$out` cast forces PowerShell to emit
    /// the BSTR contents to stdout instead of the auto-converted
    /// XmlDocument object; we re-parse on the Rust side for explicit error
    /// handling.
    ///
    /// `$ErrorActionPreference = 'Stop'` makes COM-class-not-found a
    /// non-zero exit (lifted to `ComClassNotRegistered` by the caller). The
    /// `Out-Null` on `ReleaseComObject` suppresses the refcount integer
    /// PowerShell would otherwise echo to stdout.
    pub(super) const PS_ENUMERATE_HIERARCHY: &str = r#"
$ErrorActionPreference = 'Stop'
try {
    $onenote = New-Object -ComObject OneNote.Application
} catch {
    Write-Error "ONENOTE_COM_NOT_REGISTERED: $($_.Exception.Message)"
    exit 2
}
try {
    $xml = ''
    $onenote.GetHierarchy('', 4, [ref]$xml)
    Write-Output $xml
} finally {
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($onenote) | Out-Null
}
"#;

    /// Reads `Application.Windows.CurrentWindow.CurrentPageId` — the
    /// "logically active" OneNote page (NOT OS-foreground per
    /// WP-OneNote-Export-Research-Findings §8 Q2). Emits a single line on
    /// stdout: `PAGE:<page-id>` when a page is active, or
    /// `NO_NOTEBOOK_OPEN` when `CurrentWindow` is null (notebook closed /
    /// fresh launch). RCW release in `finally` per OneMore's
    /// `WithCurrentWindow` pattern.
    pub(super) const PS_GET_ACTIVE_PAGE: &str = r#"
$ErrorActionPreference = 'Stop'
try {
    $onenote = New-Object -ComObject OneNote.Application
} catch {
    Write-Error "ONENOTE_COM_NOT_REGISTERED: $($_.Exception.Message)"
    exit 2
}
$windows = $null
$active = $null
try {
    $windows = $onenote.Windows
    $active = $windows.CurrentWindow
    if ($null -eq $active) {
        Write-Output 'NO_NOTEBOOK_OPEN'
    } else {
        $pageId = $active.CurrentPageId
        if ([string]::IsNullOrEmpty($pageId)) {
            Write-Output 'NO_NOTEBOOK_OPEN'
        } else {
            Write-Output ('PAGE:' + $pageId)
        }
    }
} finally {
    if ($null -ne $active) {
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($active) | Out-Null
    }
    if ($null -ne $windows) {
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($windows) | Out-Null
    }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($onenote) | Out-Null
}
"#;

    /// `Application.Publish(pageId, path, pfPDF=3, "")` with numbered-suffix
    /// retry per WP-OneNote-Export-Research-Findings §1 Claim 4 (Microsoft
    /// docs: target path "must be one that does not already exist"). The
    /// retry tries up to 100 suffixed candidates (`name (2).pdf`,
    /// `name (3).pdf`, ...) — collisions in a fresh temp-dir per call are
    /// extraordinarily rare; this is defensive.
    ///
    /// Stdout: the final PDF path. Stderr/non-zero exit on Publish failure.
    /// The page-id and dir/stem are templated into the script by the
    /// caller (per-call substitution); they're treated as trusted inputs
    /// (the page-id comes from a prior COM read; the dir/stem comes from
    /// our own `std::env::temp_dir`).
    pub(super) fn ps_export_page_script(page_id: &str, dir: &str, stem: &str) -> String {
        // PowerShell single-quoted strings escape an embedded single quote
        // by doubling it (`''`). Page IDs from OneNote are GUID-like; stem
        // is our own UUID. Dir is a Rust-side temp path. All three are
        // single-quote-escaped defensively.
        let page_id_esc = page_id.replace('\'', "''");
        let dir_esc = dir.replace('\'', "''");
        let stem_esc = stem.replace('\'', "''");
        format!(
            r#"
$ErrorActionPreference = 'Stop'
$pageId = '{page_id}'
$dir = '{dir}'
$stem = '{stem}'
$ext = '.pdf'
try {{
    $onenote = New-Object -ComObject OneNote.Application
}} catch {{
    Write-Error "ONENOTE_COM_NOT_REGISTERED: $($_.Exception.Message)"
    exit 2
}}
try {{
    # Find a path that doesn't exist. Microsoft docs are explicit: Publish
    # raises if the target file is already present.
    $candidate = Join-Path -Path $dir -ChildPath ($stem + $ext)
    $i = 2
    while (Test-Path -LiteralPath $candidate) {{
        $candidate = Join-Path -Path $dir -ChildPath ($stem + ' (' + $i + ')' + $ext)
        $i++
        if ($i -gt 100) {{
            throw "Could not find unused output path under $dir after 100 attempts"
        }}
    }}
    # pfPDF = 3 (PublishFormat enum)
    $onenote.Publish($pageId, $candidate, 3, '')
    if (-not (Test-Path -LiteralPath $candidate)) {{
        Write-Error "ONENOTE_FILE_NOT_PRODUCED: $candidate"
        exit 3
    }}
    Write-Output $candidate
}} finally {{
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($onenote) | Out-Null
}}
"#,
            page_id = page_id_esc,
            dir = dir_esc,
            stem = stem_esc
        )
    }

    /// Generic PowerShell subprocess wrapper. Invokes `powershell.exe` with
    /// `-NoProfile -ExecutionPolicy Bypass -Command <script>`, captures
    /// stdout + stderr + exit code, and lifts the result into the
    /// `OneNoteError` taxonomy.
    ///
    /// The `-Command` flag (not `-File`) lets us pass the inline
    /// raw-string scripts directly without a temp file round-trip; mirrors
    /// the v1.1 patch §1.1 choice. Caller can read the script via the
    /// `ps_*` constants for unit-test fixtures.
    pub(super) fn spawn_ps_script(script: &str) -> Result<String, OneNoteError> {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
            .output()
            .map_err(|e| OneNoteError::PowerShellSpawnFailed(format!("{}", e)))?;

        let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();

        if !output.status.success() {
            // PS script returned with exit code; check for our sentinel
            // markers in stderr so the caller gets a specific variant.
            if stderr_str.contains("ONENOTE_COM_NOT_REGISTERED") {
                return Err(OneNoteError::ComClassNotRegistered);
            }
            if stderr_str.contains("ONENOTE_FILE_NOT_PRODUCED") {
                // The path tail follows the marker; extract for the error
                // body so the caller can surface it.
                let path = stderr_str
                    .split("ONENOTE_FILE_NOT_PRODUCED:")
                    .nth(1)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                return Err(OneNoteError::FileNotProduced(path));
            }
            return Err(OneNoteError::PowerShellExitNonZero {
                code: output.status.code().unwrap_or(-1),
                stderr: stderr_str,
            });
        }

        Ok(stdout_str)
    }

    pub fn enumerate_hierarchy() -> Result<NotebookTree, OneNoteError> {
        let stdout = spawn_ps_script(PS_ENUMERATE_HIERARCHY)?;
        parse_hierarchy_xml(stdout.trim())
    }

    pub fn get_active_page() -> Result<Option<String>, OneNoteError> {
        let stdout = spawn_ps_script(PS_GET_ACTIVE_PAGE)?;
        Ok(parse_active_page_stdout(&stdout))
    }

    pub fn export_page(page_id: &str, output_dir: &Path) -> Result<PathBuf, OneNoteError> {
        // Use a UUID-shaped stem so concurrent calls (e.g., bulk-send from
        // WP-EXPORT-04) don't collide on the file system before the per-PS
        // suffix retry kicks in.
        let stem = format!("onenote-{}", uuid_v4_like());
        let dir_str = output_dir
            .to_str()
            .ok_or_else(|| OneNoteError::Other(format!("output_dir not UTF-8: {:?}", output_dir)))?;
        let script = ps_export_page_script(page_id, dir_str, &stem);
        let stdout = spawn_ps_script(&script)?;
        let path_str = stdout.trim();
        if path_str.is_empty() {
            return Err(OneNoteError::Other(
                "export_page: powershell returned empty stdout".to_string(),
            ));
        }
        let path = PathBuf::from(path_str);
        if !path.exists() {
            return Err(OneNoteError::FileNotProduced(path_str.to_string()));
        }
        Ok(path)
    }

    /// Minimal stand-in for a UUID — 32 random hex chars. We don't depend
    /// on the `uuid` crate to avoid pulling it in for a single use-site;
    /// per-call randomness comes from a SHA-256 of the current time +
    /// process id (~80 bits of effective entropy; ample for "don't collide
    /// with another temp file in the same tempdir").
    fn uuid_v4_like() -> String {
        use sha2::{Digest, Sha256};
        use std::time::{SystemTime, UNIX_EPOCH};
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let counter =
            super::CALL_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut h = Sha256::new();
        h.update(now_ns.to_le_bytes());
        h.update(pid.to_le_bytes());
        h.update(counter.to_le_bytes());
        let digest = h.finalize();
        hex::encode(&digest[..16])
    }
}

// Cross-platform call counter ensures `uuid_v4_like` (Windows-only) gets a
// monotonic seed component even on rapid back-to-back calls within the
// same nanosecond. Declared at module level so tests on Mac don't fail to
// compile. Mac stubs never read it; allow(dead_code) on non-Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
static CALL_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ───────────────────────────────────────────────────────────────────────────
// Cross-platform XML parsing (pure-function — exercised by unit tests on
// Mac via fixture stdout; also called by the Windows path).
// ───────────────────────────────────────────────────────────────────────────

/// Parse the XML emitted by `Application.GetHierarchy("", 4, ...)` into a
/// typed `NotebookTree`. The schema (per WP-OneNote-Export-Research-Findings
/// §1 Claim 3 sample) is:
///
/// ```xml
/// <one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote">
///   <one:Notebook name="Work" ID="{0B8E7305-...}" lastModifiedTime="...">
///     <one:Section name="Engineering" ID="{5F4E2908-...}" lastModifiedTime="...">
///       <one:Page name="Q2 Sync" ID="{3428B7BB-...}" lastModifiedTime="..." />
///     </one:Section>
///   </one:Notebook>
/// </one:Notebooks>
/// ```
///
/// quick-xml is used because (a) it's already a transitive dep of Tauri
/// (zero binary-size impact per the Cargo.lock check at impl-time) and (b)
/// the local-name matcher handles the `one:` namespace prefix without us
/// hand-rolling a namespace lookup table.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_hierarchy_xml(xml: &str) -> Result<NotebookTree, OneNoteError> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut notebooks: Vec<Notebook> = Vec::new();
    let mut current_notebook: Option<Notebook> = None;
    let mut current_section: Option<Section> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "Notebook" => {
                        let (id, name, lmt) = read_id_name_lmt(&e);
                        current_notebook = Some(Notebook {
                            notebook_id: id,
                            name,
                            last_modified_time: lmt,
                            sections: Vec::new(),
                        });
                    }
                    "Section" => {
                        let (id, name, lmt) = read_id_name_lmt(&e);
                        current_section = Some(Section {
                            section_id: id,
                            name,
                            last_modified_time: lmt,
                            pages: Vec::new(),
                        });
                    }
                    "Page" => {
                        // Page can be either Start or Empty depending on
                        // how OneNote happens to serialize. Same handling.
                        let (id, name, lmt) = read_id_name_lmt(&e);
                        if let Some(section) = current_section.as_mut() {
                            section.pages.push(Page {
                                page_id: id,
                                name,
                                last_modified_time: lmt,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                // Empty / self-closing elements: `<one:Page ... />` is the
                // canonical case (leaf pages have no children); also handle
                // `<one:Section ... />` (empty section — possible per the
                // brief's WP-EXPORT-04 "show empty sections" requirement)
                // and `<one:Notebook ... />` (notebook with no sections;
                // extremely rare but cheap to handle).
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "Page" => {
                        let (id, name, lmt) = read_id_name_lmt(&e);
                        if let Some(section) = current_section.as_mut() {
                            section.pages.push(Page {
                                page_id: id,
                                name,
                                last_modified_time: lmt,
                            });
                        }
                    }
                    "Section" => {
                        let (id, name, lmt) = read_id_name_lmt(&e);
                        if let Some(notebook) = current_notebook.as_mut() {
                            notebook.sections.push(Section {
                                section_id: id,
                                name,
                                last_modified_time: lmt,
                                pages: Vec::new(),
                            });
                        }
                    }
                    "Notebook" => {
                        let (id, name, lmt) = read_id_name_lmt(&e);
                        notebooks.push(Notebook {
                            notebook_id: id,
                            name,
                            last_modified_time: lmt,
                            sections: Vec::new(),
                        });
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "Section" => {
                        if let (Some(notebook), Some(section)) =
                            (current_notebook.as_mut(), current_section.take())
                        {
                            notebook.sections.push(section);
                        }
                    }
                    "Notebook" => {
                        if let Some(notebook) = current_notebook.take() {
                            notebooks.push(notebook);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(OneNoteError::XmlParseFailed(format!(
                    "quick-xml at pos {}: {}",
                    reader.buffer_position(),
                    e
                )));
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(NotebookTree { notebooks })
}

/// Helper — pull `ID` (or `id`), `name`, `lastModifiedTime` attributes off
/// any of the three element types we care about. `ID` is the all-caps form
/// Microsoft's published samples emit; we also accept lowercase as a
/// defensive measure (OneMore source-code reads both).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn read_id_name_lmt(
    e: &quick_xml::events::BytesStart<'_>,
) -> (String, String, Option<String>) {
    let mut id = String::new();
    let mut name = String::new();
    let mut lmt: Option<String> = None;
    for attr in e.attributes().flatten() {
        let key_local = local_name(attr.key.as_ref());
        let value = attr
            .unescape_value()
            .map(|c| c.into_owned())
            .unwrap_or_default();
        match key_local.as_str() {
            "ID" | "id" => id = value,
            "name" => name = value,
            "lastModifiedTime" if !value.is_empty() => lmt = Some(value),
            _ => {}
        }
    }
    (id, name, lmt)
}

/// Strip the namespace prefix (`one:Notebook` → `Notebook`). quick-xml
/// gives us namespace-aware lookups via the `read_resolved_event_into` API
/// but for this small schema a local-name match is simpler + sufficient.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn local_name(raw: &[u8]) -> String {
    let s = std::str::from_utf8(raw).unwrap_or("");
    match s.rfind(':') {
        Some(i) => s[i + 1..].to_string(),
        None => s.to_string(),
    }
}

/// Parse the stdout from the `PS_GET_ACTIVE_PAGE` script into an
/// `Option<page_id>`. The script emits either:
///   - `PAGE:<id>` (notebook open, page selected — `Some(id)`)
///   - `NO_NOTEBOOK_OPEN` (notebook closed or fresh launch — `None`)
///
/// Surfaced as a pure function so it can be exercised in unit tests on Mac
/// without spawning powershell.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_active_page_stdout(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() || trimmed.starts_with("NO_NOTEBOOK_OPEN") {
        return None;
    }
    trimmed
        .strip_prefix("PAGE:")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Look up a page by id within a `NotebookTree`, returning the enriched
/// `PageMetadata` (notebook + section context) on hit. Used by the
/// `onenote_export_and_ingest_page` IPC command after `get_active_page`
/// returns just the page id; mirrors the join the COM API doesn't give us
/// directly. Pure function — exercised on Mac via unit tests.
pub fn enrich_page_metadata(tree: &NotebookTree, page_id: &str) -> Option<PageMetadata> {
    for notebook in &tree.notebooks {
        for section in &notebook.sections {
            for page in &section.pages {
                if page.page_id == page_id {
                    return Some(PageMetadata {
                        page_id: page.page_id.clone(),
                        title: page.name.clone(),
                        notebook_id: notebook.notebook_id.clone(),
                        notebook_name: notebook.name.clone(),
                        section_id: section.section_id.clone(),
                        section_name: section.name.clone(),
                        notebook_path: format!("{} / {}", notebook.name, section.name),
                        last_modified_time: page
                            .last_modified_time
                            .clone()
                            .or_else(|| section.last_modified_time.clone())
                            .or_else(|| notebook.last_modified_time.clone()),
                    });
                }
            }
        }
    }
    None
}

// ───────────────────────────────────────────────────────────────────────────
// Public Windows-only API (delegate to `imp` module)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn enumerate_hierarchy() -> Result<NotebookTree, OneNoteError> {
    imp::enumerate_hierarchy()
}

#[cfg(target_os = "windows")]
pub fn get_active_page() -> Result<Option<String>, OneNoteError> {
    imp::get_active_page()
}

#[cfg(target_os = "windows")]
pub fn export_page(page_id: &str, output_dir: &Path) -> Result<PathBuf, OneNoteError> {
    imp::export_page(page_id, output_dir)
}

// ───────────────────────────────────────────────────────────────────────────
// Mac / Linux stubs — return `PlatformUnsupported` from every call so the
// cross-platform compile stays clean and IPC consumers can dispatch on the
// error variant. Each function still keeps the public signature.
// ───────────────────────────────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
pub fn enumerate_hierarchy() -> Result<NotebookTree, OneNoteError> {
    Err(OneNoteError::PlatformUnsupported)
}

#[cfg(not(target_os = "windows"))]
pub fn get_active_page() -> Result<Option<String>, OneNoteError> {
    Err(OneNoteError::PlatformUnsupported)
}

#[cfg(not(target_os = "windows"))]
pub fn export_page(_page_id: &str, _output_dir: &Path) -> Result<PathBuf, OneNoteError> {
    Err(OneNoteError::PlatformUnsupported)
}

// ───────────────────────────────────────────────────────────────────────────
// WP-ONENOTE-EXPORT-05 — auto-watch tracker (pure data + decision helpers)
// ───────────────────────────────────────────────────────────────────────────
//
// Per brief §3.5: the polling loop calls `get_active_page` every 2s; once
// the same `pageId` has been observed for ≥10s consecutive AND has not
// been sent in this session, the loop fires the send flow. Per-session
// dedup is intra-process (HashSet cleared on app restart). Counter
// resets at midnight local time.
//
// The data + decision logic lives here (pure / synchronous / no Tauri
// dep) so it can be unit-tested cross-platform and so the lib.rs loop
// is a thin "poll → tracker.observe → maybe fire" wrapper.

use std::collections::HashSet;
use std::time::{Duration, Instant};

/// WP-ONENOTE-EXPORT-05 — debounce window. Per brief §3.5: same page
/// must be observed for ≥10s consecutive before auto-send fires.
pub const AUTO_WATCH_STABLE_WINDOW: Duration = Duration::from_secs(10);

/// WP-ONENOTE-EXPORT-05 — polling cadence. Per brief §3.5 + research
/// §8 (2s for active-page check; per-tick cost dominated by
/// powershell.exe startup ~50-150ms).
pub const AUTO_WATCH_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Outcome of a single `observe()` call on the tracker. The polling loop
/// consumes this to decide whether to fire the send flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoWatchAction {
    /// No-op: page hasn't been stable for the debounce window yet (or
    /// is already sent for this session, or no notebook is open).
    Wait,
    /// Fire the send flow for this page. The loop should call
    /// `mark_sent(page_id)` on success.
    FireSend(String),
}

/// WP-ONENOTE-EXPORT-05 — auto-watch state tracker.
///
/// Three responsibilities:
///   1. Track the current observed page id + the time it was first
///      observed (debounce gate).
///   2. Maintain a per-session dedup `HashSet<PageId>` — re-visiting an
///      already-sent page in the same session does NOT re-send (per
///      brief §3.5 AC predicate).
///   3. Track "Sent today: N pages" counter with midnight-local reset.
///
/// `Instant`-based debounce (monotonic; immune to wall-clock skew).
/// `chrono::NaiveDate` for the today-date comparison (calendar-aware;
/// uses local time per brief §3.5 "counter resets midnight local time").
///
/// All methods are synchronous + take `&mut self` — the polling loop
/// holds a single tracker behind a `Mutex` in lib.rs.
#[derive(Debug, Clone)]
pub struct AutoWatchTracker {
    /// Page id last returned by `get_active_page()`. `None` when no
    /// notebook is open (or before the first observation).
    last_observed_page_id: Option<String>,
    /// Monotonic instant the current `last_observed_page_id` was first
    /// observed. Reset on page change. `None` when no page has been
    /// observed yet.
    first_observed_at: Option<Instant>,
    /// Per-session dedup. Cleared on app restart (not persisted to
    /// disk per brief §3.5; "session" = process lifetime).
    sent_this_session: HashSet<String>,
    /// Today's count of successfully auto-sent pages. Resets at
    /// midnight local time via `today_date` comparison.
    sent_today_count: usize,
    /// Local calendar date the `sent_today_count` was last incremented
    /// on. When `observe()` or `mark_sent()` notices a different date,
    /// the counter resets to 0 before incrementing.
    today_date: Option<chrono::NaiveDate>,
    /// Total sent in this session (across midnight rollovers). Reset
    /// only on app restart. Surfaced in the AutoWatchStatus IPC for
    /// the Configure pane diagnostic display.
    sent_total_session: usize,
}

impl Default for AutoWatchTracker {
    fn default() -> Self {
        Self {
            last_observed_page_id: None,
            first_observed_at: None,
            sent_this_session: HashSet::new(),
            sent_today_count: 0,
            today_date: None,
            sent_total_session: 0,
        }
    }
}

impl AutoWatchTracker {
    /// Construct a fresh tracker. Equivalent to `Default::default()`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Per-tick observation. Caller polls `get_active_page()` (or its
    /// equivalent) every `AUTO_WATCH_POLL_INTERVAL` and feeds the
    /// result here.
    ///
    /// `current_page_id`:
    ///   - `Some(id)` — OneNote has a page selected (id may match or
    ///     differ from `last_observed_page_id`).
    ///   - `None` — no notebook open. Resets the debounce tracker so
    ///     we don't accidentally "carry forward" the stale page id
    ///     across notebook-close → notebook-reopen transitions.
    ///
    /// `now` is plumbed in for testability (production code passes
    /// `Instant::now()`; tests pass synthetic instants).
    ///
    /// Returns `AutoWatchAction::FireSend(page_id)` when ALL of:
    ///   - same `current_page_id` has been observed for `>=` the
    ///     debounce window
    ///   - the page id is NOT in `sent_this_session`
    /// Otherwise returns `AutoWatchAction::Wait`.
    pub fn observe(&mut self, current_page_id: Option<&str>, now: Instant) -> AutoWatchAction {
        let id = match current_page_id {
            Some(id) if !id.is_empty() => id,
            _ => {
                // No notebook open (or empty page id) — reset the
                // debounce tracker. Don't clear `sent_this_session`
                // (still the same session; re-opening a previously-
                // sent page should still dedup).
                self.last_observed_page_id = None;
                self.first_observed_at = None;
                return AutoWatchAction::Wait;
            }
        };

        // Did the page change since the last observation?
        match &self.last_observed_page_id {
            Some(prev) if prev == id => {
                // Same page. Don't update first_observed_at.
            }
            _ => {
                // Different page (or first observation). Reset the
                // debounce timer.
                self.last_observed_page_id = Some(id.to_string());
                self.first_observed_at = Some(now);
                return AutoWatchAction::Wait;
            }
        }

        // Debounce window check.
        let elapsed = match self.first_observed_at {
            Some(start) => now.saturating_duration_since(start),
            None => return AutoWatchAction::Wait,
        };
        if elapsed < AUTO_WATCH_STABLE_WINDOW {
            return AutoWatchAction::Wait;
        }

        // Stable for the window. Already sent this session?
        if self.sent_this_session.contains(id) {
            return AutoWatchAction::Wait;
        }

        AutoWatchAction::FireSend(id.to_string())
    }

    /// Record a successful auto-send. Adds the page id to the per-
    /// session dedup set + increments the today counter (with midnight-
    /// reset bookkeeping). Idempotent — re-calling for the same page id
    /// in the same session is a no-op on the counter (won't double-
    /// count) but does re-insert the id (HashSet is set-like).
    ///
    /// `today` is plumbed in for testability (production code passes
    /// `chrono::Local::now().date_naive()`).
    pub fn mark_sent(&mut self, page_id: &str, today: chrono::NaiveDate) {
        // Idempotency guard: if we've already marked this page id sent
        // in this session, don't double-count. (Defensive — the loop
        // checks `contains` before firing, but the per-call guard
        // makes the API safe to call from anywhere.)
        if !self.sent_this_session.insert(page_id.to_string()) {
            return;
        }

        // Midnight reset for sent_today_count.
        match self.today_date {
            Some(prev) if prev == today => {
                self.sent_today_count += 1;
            }
            _ => {
                // New day (or first send) — reset the counter to 1
                // (this very send is the first of the new day).
                self.today_date = Some(today);
                self.sent_today_count = 1;
            }
        }
        self.sent_total_session += 1;
    }

    /// Read-only accessor for the IPC status report.
    pub fn sent_today(&self) -> usize {
        self.sent_today_count
    }

    /// Read-only accessor for the IPC status report.
    pub fn sent_total_session(&self) -> usize {
        self.sent_total_session
    }

    /// Reset the per-session dedup set + counters. Called when auto-
    /// watch is toggled off → on again so the user can re-send a
    /// previously-auto-sent page by toggling the feature.
    /// NOT called by the polling loop itself — the per-session
    /// semantics in the brief are explicit ("resets on next session").
    #[allow(dead_code)] // Exposed for future use; not wired in v1.
    pub fn reset_session(&mut self) {
        self.sent_this_session.clear();
        self.last_observed_page_id = None;
        self.first_observed_at = None;
        // Don't reset sent_today_count or sent_total_session —
        // they're calendar / process-lifetime scoped, not "session"
        // scoped per the brief.
    }

    /// Read-only accessor for the IPC status report (sibling to
    /// `sent_today` / `sent_total_session`). Returns the page id the
    /// tracker is currently debouncing, or `None` when no notebook is
    /// observed. Useful for the Configure pane's diagnostic display.
    pub fn last_observed_page_id(&self) -> Option<&str> {
        self.last_observed_page_id.as_deref()
    }

    /// Read-only accessor for the IPC status report. Returns the number
    /// of distinct pages observed-and-sent in this process lifetime
    /// (sum of `sent_this_session.len()` across the whole loop).
    /// Sibling of `sent_today` (calendar-day-scoped) and
    /// `sent_total_session` (process-lifetime, total-sends).
    pub fn sent_this_session_count(&self) -> usize {
        self.sent_this_session.len()
    }
}

// ───────────────────────────────────────────────────────────────────────────
// WP-ONENOTE-EXPORT-05 — IPC status payload + active-page polling helpers
// ───────────────────────────────────────────────────────────────────────────
//
// `AutoWatchStatus` is the serde-payload returned from
// `onenote_auto_watch_status` IPC (consumed by the Configure pane and
// the right-click menu counter). camelCase rename so the frontend can
// read fields as JS conventions.
//
// `pollActiveOnce` wraps `get_active_page` + `enrich_page_metadata` for
// the loop's per-tick work — the loop calls it once per
// `AUTO_WATCH_POLL_INTERVAL` and feeds the result into the tracker.

/// WP-ONENOTE-EXPORT-05 — payload returned from
/// `onenote_auto_watch_status` IPC. Consumed by Configure-pane status
/// line + right-click menu counter.
///
/// Fields renamed to camelCase via `serde(rename_all = "camelCase")` so
/// the JS side reads `status.sentToday` not `status.sent_today`.
/// Additive-only schema delta — fields can grow but existing fields
/// stay byte-compatible.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoWatchStatus {
    /// Is the polling loop currently running? Mirrors `AppConfig.auto_watch`
    /// at steady state but can drift transiently while a toggle is
    /// being applied. Source of truth is the AtomicBool the lib.rs
    /// loop polls (see `lib.rs::ONENOTE_AUTO_WATCH_ACTIVE`).
    pub enabled: bool,
    /// Number of auto-sends fired today (resets at midnight local time
    /// via `AutoWatchTracker::mark_sent`).
    pub sent_today: usize,
    /// Number of auto-sends fired since the process started (does not
    /// reset on midnight rollover; only on app restart). Useful for
    /// "Sent this session: N" diagnostic.
    pub sent_total_session: usize,
    /// Number of distinct pages auto-sent this session (≤ `sent_total_session`
    /// in v1 because dedup blocks re-sends; the two values are equal in v1
    /// but split for future-feature-flexibility if dedup is relaxed).
    pub distinct_pages_sent: usize,
    /// Page id the tracker is currently debouncing (the page the user
    /// is dwelling on). `None` when no notebook is open. Useful for
    /// diagnosing "why isn't auto-send firing" UX issues.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debouncing_page_id: Option<String>,
}

impl AutoWatchStatus {
    /// Compose a status payload from the tracker + the loop's enable
    /// flag. The `enabled` flag is sourced separately (from the loop's
    /// AtomicBool) because the tracker itself doesn't know whether the
    /// loop is running.
    pub fn from_tracker(tracker: &AutoWatchTracker, enabled: bool) -> Self {
        Self {
            enabled,
            sent_today: tracker.sent_today(),
            sent_total_session: tracker.sent_total_session(),
            distinct_pages_sent: tracker.sent_this_session_count(),
            debouncing_page_id: tracker.last_observed_page_id().map(String::from),
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Unit tests — exercise the pure functions (XML parsing, stdout parsing,
// metadata enrichment, error semantics) on every platform.
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ───── XML parsing (matches Microsoft Learn canonical sample shape) ─────

    /// Canonical sample from WP-OneNote-Export-Research-Findings §1 Claim 3.
    /// Single notebook → single section → single page.
    const SAMPLE_HIERARCHY_XML_MINIMAL: &str = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote">
  <one:Notebook name="Work" ID="{0B8E7305-AAAA-AAAA-AAAA-000000000001}" lastModifiedTime="2026-05-27T12:00:00.000Z">
    <one:Section name="Engineering" ID="{5F4E2908-BBBB-BBBB-BBBB-000000000002}" lastModifiedTime="2026-05-27T12:00:00.000Z">
      <one:Page name="Q2 Sync" ID="{3428B7BB-CCCC-CCCC-CCCC-000000000003}" lastModifiedTime="2026-05-27T12:00:00.000Z" />
    </one:Section>
  </one:Notebook>
</one:Notebooks>"#;

    /// Multi-notebook fixture exercising more than one section + page each.
    const SAMPLE_HIERARCHY_XML_MULTI: &str = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote">
  <one:Notebook name="Work" ID="{NB-001}" lastModifiedTime="2026-05-01T00:00:00.000Z">
    <one:Section name="Engineering" ID="{SEC-001}" lastModifiedTime="2026-05-01T00:00:00.000Z">
      <one:Page name="Q2 Sync" ID="{PG-001}" lastModifiedTime="2026-05-01T00:00:00.000Z" />
      <one:Page name="Q2 Planning" ID="{PG-002}" lastModifiedTime="2026-05-02T00:00:00.000Z" />
    </one:Section>
    <one:Section name="Personnel" ID="{SEC-002}" lastModifiedTime="2026-05-01T00:00:00.000Z">
      <one:Page name="1:1 Notes" ID="{PG-003}" lastModifiedTime="2026-05-03T00:00:00.000Z" />
    </one:Section>
  </one:Notebook>
  <one:Notebook name="Personal" ID="{NB-002}" lastModifiedTime="2026-04-01T00:00:00.000Z">
    <one:Section name="Recipes" ID="{SEC-003}" lastModifiedTime="2026-04-01T00:00:00.000Z">
      <one:Page name="Sourdough" ID="{PG-004}" lastModifiedTime="2026-04-15T00:00:00.000Z" />
    </one:Section>
  </one:Notebook>
</one:Notebooks>"#;

    /// Empty hierarchy — user has no notebooks open. OneNote does still
    /// emit the root element.
    const SAMPLE_HIERARCHY_XML_EMPTY: &str = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote">
</one:Notebooks>"#;

    /// Section with zero pages — possible if OneNote-side metadata returns
    /// before any page is created (or for a section behind sync).
    const SAMPLE_HIERARCHY_XML_EMPTY_SECTION: &str = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote">
  <one:Notebook name="Work" ID="{NB-001}">
    <one:Section name="Empty" ID="{SEC-EMPTY}" />
  </one:Notebook>
</one:Notebooks>"#;

    #[test]
    fn parse_minimal_hierarchy_xml() {
        let tree =
            parse_hierarchy_xml(SAMPLE_HIERARCHY_XML_MINIMAL).expect("minimal XML should parse");
        assert_eq!(tree.notebooks.len(), 1);
        let nb = &tree.notebooks[0];
        assert_eq!(nb.name, "Work");
        assert_eq!(nb.notebook_id, "{0B8E7305-AAAA-AAAA-AAAA-000000000001}");
        assert_eq!(nb.sections.len(), 1);
        let sec = &nb.sections[0];
        assert_eq!(sec.name, "Engineering");
        assert_eq!(sec.section_id, "{5F4E2908-BBBB-BBBB-BBBB-000000000002}");
        assert_eq!(sec.pages.len(), 1);
        let page = &sec.pages[0];
        assert_eq!(page.name, "Q2 Sync");
        assert_eq!(page.page_id, "{3428B7BB-CCCC-CCCC-CCCC-000000000003}");
        assert_eq!(
            page.last_modified_time.as_deref(),
            Some("2026-05-27T12:00:00.000Z")
        );
    }

    #[test]
    fn parse_multi_notebook_hierarchy_xml() {
        let tree =
            parse_hierarchy_xml(SAMPLE_HIERARCHY_XML_MULTI).expect("multi XML should parse");
        assert_eq!(tree.notebooks.len(), 2, "two notebooks expected");
        let work = &tree.notebooks[0];
        assert_eq!(work.name, "Work");
        assert_eq!(work.sections.len(), 2);
        assert_eq!(work.sections[0].pages.len(), 2);
        assert_eq!(work.sections[1].pages.len(), 1);
        let personal = &tree.notebooks[1];
        assert_eq!(personal.name, "Personal");
        assert_eq!(personal.sections.len(), 1);
        assert_eq!(personal.sections[0].pages.len(), 1);
        assert_eq!(personal.sections[0].pages[0].name, "Sourdough");
    }

    #[test]
    fn parse_empty_hierarchy_xml() {
        let tree =
            parse_hierarchy_xml(SAMPLE_HIERARCHY_XML_EMPTY).expect("empty hierarchy parses");
        assert!(tree.notebooks.is_empty());
    }

    #[test]
    fn parse_empty_section_hierarchy_xml() {
        // Section with no pages — pages vec is empty, but the section is
        // still emitted (used by WP-EXPORT-04's "Browse OneNote…" tree to
        // show empty sections rather than hiding them).
        let tree = parse_hierarchy_xml(SAMPLE_HIERARCHY_XML_EMPTY_SECTION)
            .expect("empty section parses");
        assert_eq!(tree.notebooks.len(), 1);
        assert_eq!(tree.notebooks[0].sections.len(), 1);
        assert!(tree.notebooks[0].sections[0].pages.is_empty());
    }

    #[test]
    fn parse_malformed_xml_returns_error() {
        let xml = r#"<one:Notebooks xmlns:one="x"><broken"#;
        match parse_hierarchy_xml(xml) {
            Err(OneNoteError::XmlParseFailed(_)) => {}
            other => panic!("Expected XmlParseFailed; got {:?}", other),
        }
    }

    #[test]
    fn parse_page_self_closing_or_paired() {
        // OneNote serializes leaf pages as self-closing (`<one:Page ... />`)
        // per Microsoft's sample. quick-xml emits these as `Event::Empty`
        // rather than `Event::Start` + `Event::End`. Make sure we handle
        // both — defensive against future XmlSchema variants.
        let paired = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="x">
  <one:Notebook ID="{NB}" name="N">
    <one:Section ID="{SEC}" name="S">
      <one:Page ID="{PG}" name="P"></one:Page>
    </one:Section>
  </one:Notebook>
</one:Notebooks>"#;
        let tree = parse_hierarchy_xml(paired).expect("paired-tag Page parses");
        assert_eq!(tree.notebooks[0].sections[0].pages.len(), 1);
    }

    // ───── parse_active_page_stdout ─────

    #[test]
    fn parse_active_page_returns_some_on_page_marker() {
        assert_eq!(
            parse_active_page_stdout("PAGE:{abc-123}\n"),
            Some("{abc-123}".to_string())
        );
        assert_eq!(
            parse_active_page_stdout("PAGE:plain-id"),
            Some("plain-id".to_string())
        );
    }

    #[test]
    fn parse_active_page_returns_none_on_no_notebook() {
        assert_eq!(parse_active_page_stdout("NO_NOTEBOOK_OPEN"), None);
        assert_eq!(parse_active_page_stdout("NO_NOTEBOOK_OPEN\n"), None);
    }

    #[test]
    fn parse_active_page_returns_none_on_empty_stdout() {
        assert_eq!(parse_active_page_stdout(""), None);
        assert_eq!(parse_active_page_stdout("   \n  "), None);
    }

    #[test]
    fn parse_active_page_returns_none_on_empty_page_id() {
        // Conservative: empty-string page id after the PAGE: prefix means
        // OneNote returned a degenerate state; same handling as null.
        assert_eq!(parse_active_page_stdout("PAGE:"), None);
        assert_eq!(parse_active_page_stdout("PAGE:   "), None);
    }

    // ───── enrich_page_metadata ─────

    #[test]
    fn enrich_page_metadata_finds_page_and_populates_notebook_path() {
        let tree =
            parse_hierarchy_xml(SAMPLE_HIERARCHY_XML_MULTI).expect("fixture parses");
        let meta = enrich_page_metadata(&tree, "{PG-003}").expect("page exists");
        assert_eq!(meta.page_id, "{PG-003}");
        assert_eq!(meta.title, "1:1 Notes");
        assert_eq!(meta.notebook_id, "{NB-001}");
        assert_eq!(meta.notebook_name, "Work");
        assert_eq!(meta.section_id, "{SEC-002}");
        assert_eq!(meta.section_name, "Personnel");
        assert_eq!(meta.notebook_path, "Work / Personnel");
        assert_eq!(
            meta.last_modified_time.as_deref(),
            Some("2026-05-03T00:00:00.000Z")
        );
    }

    #[test]
    fn enrich_page_metadata_returns_none_on_missing_page() {
        let tree =
            parse_hierarchy_xml(SAMPLE_HIERARCHY_XML_MINIMAL).expect("fixture parses");
        assert!(enrich_page_metadata(&tree, "{NOT-PRESENT}").is_none());
    }

    #[test]
    fn enrich_page_metadata_falls_back_to_section_or_notebook_lmt() {
        // Page without its own lastModifiedTime should fall back to the
        // section's or notebook's. Constructed inline (no fixture; this
        // edge case isn't in the canonical sample).
        let xml = r#"<?xml version="1.0"?>
<one:Notebooks xmlns:one="x">
  <one:Notebook ID="{NB}" name="N" lastModifiedTime="2026-01-01T00:00:00.000Z">
    <one:Section ID="{SEC}" name="S">
      <one:Page ID="{PG}" name="P" />
    </one:Section>
  </one:Notebook>
</one:Notebooks>"#;
        let tree = parse_hierarchy_xml(xml).expect("parses");
        let meta = enrich_page_metadata(&tree, "{PG}").expect("page exists");
        assert_eq!(
            meta.last_modified_time.as_deref(),
            Some("2026-01-01T00:00:00.000Z"),
            "expected fallback to notebook lastModifiedTime"
        );
    }

    // ───── OneNoteError ─────

    #[test]
    fn error_user_messages_are_non_empty() {
        // Regression guard: a refactor blanking out a variant's message
        // would surface only at toast time. Cheap one-off check.
        for err in &[
            OneNoteError::ComClassNotRegistered,
            OneNoteError::NoNotebookOpen,
            OneNoteError::PowerShellExitNonZero {
                code: 1,
                stderr: "test".into(),
            },
            OneNoteError::PowerShellSpawnFailed("test".into()),
            OneNoteError::XmlParseFailed("test".into()),
            OneNoteError::FileNotProduced("/tmp/x.pdf".into()),
            OneNoteError::Other("test".into()),
            OneNoteError::PlatformUnsupported,
        ] {
            assert!(!err.user_message().is_empty());
        }
    }

    #[test]
    fn error_display_implementations_dont_panic() {
        let _ = format!("{}", OneNoteError::ComClassNotRegistered);
        let _ = format!("{}", OneNoteError::NoNotebookOpen);
        let _ = format!(
            "{}",
            OneNoteError::PowerShellExitNonZero {
                code: 2,
                stderr: "msg".into()
            }
        );
        let _ = format!("{}", OneNoteError::PowerShellSpawnFailed("e".into()));
        let _ = format!("{}", OneNoteError::XmlParseFailed("e".into()));
        let _ = format!("{}", OneNoteError::FileNotProduced("/p".into()));
        let _ = format!("{}", OneNoteError::Other("e".into()));
        let _ = format!("{}", OneNoteError::PlatformUnsupported);
    }

    // ───── Mac stub returns PlatformUnsupported ─────
    //
    // Compile-time cfg means these can only meaningfully run on non-Windows
    // hosts; coordinator-run CI exercises them on macos-latest. Skipped on
    // the Windows runner (the real implementations cover those code paths
    // via separate manual smoke).

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn mac_stub_returns_platform_unsupported() {
        match enumerate_hierarchy() {
            Err(OneNoteError::PlatformUnsupported) => {}
            other => panic!("Expected PlatformUnsupported; got {:?}", other),
        }
        match get_active_page() {
            Err(OneNoteError::PlatformUnsupported) => {}
            other => panic!("Expected PlatformUnsupported; got {:?}", other),
        }
        match export_page("any", std::path::Path::new("/tmp")) {
            Err(OneNoteError::PlatformUnsupported) => {}
            other => panic!("Expected PlatformUnsupported; got {:?}", other),
        }
    }

    // ───── PowerShell script syntactic anchors ─────
    //
    // We can't run PowerShell here (no Mac PowerShell guarantee; would
    // require a Windows-only test gate). Coordinator's manual Windows
    // smoke covers actual execution. These checks just guard against the
    // raw-string constants being truncated or shadowed by a refactor.

    #[cfg(target_os = "windows")]
    #[test]
    fn ps_enumerate_hierarchy_invokes_getherarchy_and_releases_rcw() {
        let script = imp::PS_ENUMERATE_HIERARCHY;
        assert!(script.contains("New-Object -ComObject OneNote.Application"));
        assert!(script.contains("GetHierarchy('', 4, [ref]$xml)"));
        assert!(script.contains("ReleaseComObject"));
        assert!(script.contains("ONENOTE_COM_NOT_REGISTERED"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ps_get_active_page_uses_currentpageid_and_handles_null_window() {
        let script = imp::PS_GET_ACTIVE_PAGE;
        // Script uses an intermediate `$windows` variable for proper COM
        // RCW release in the `finally` block (can't `ReleaseComObject` an
        // unnamed chained accessor). So the literal `Windows.CurrentWindow`
        // substring won't appear; assert each property access separately.
        assert!(script.contains(".Windows"));
        assert!(script.contains(".CurrentWindow"));
        assert!(script.contains("CurrentPageId"));
        assert!(script.contains("NO_NOTEBOOK_OPEN"));
        assert!(script.contains("ReleaseComObject"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ps_export_page_templates_id_dir_stem_and_uses_pfPDF_3() {
        let script = imp::ps_export_page_script("{PG-001}", r"C:\tmp", "stem-x");
        assert!(script.contains("'{PG-001}'"));
        assert!(script.contains(r"'C:\tmp'"));
        assert!(script.contains("'stem-x'"));
        // pfPDF = 3 per PublishFormat enum
        assert!(script.contains(".Publish($pageId, $candidate, 3, '')"));
        assert!(script.contains("Test-Path -LiteralPath $candidate"));
        assert!(script.contains("ONENOTE_FILE_NOT_PRODUCED"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ps_export_page_escapes_embedded_single_quotes() {
        // Defensive: a page id with an apostrophe (rare; OneNote GUIDs
        // don't have these, but user-supplied data via WP-EXPORT-04 may
        // include arbitrary chars) shouldn't break out of the PS literal.
        let script = imp::ps_export_page_script("a'b", "C:\\d'd", "e'e");
        assert!(script.contains("'a''b'"));
        assert!(script.contains("'C:\\d''d'"));
        assert!(script.contains("'e''e'"));
    }

    // ───── WP-ONENOTE-EXPORT-05 — AutoWatchTracker (pure-fn debounce + dedup) ─────
    //
    // All tests are cross-platform (the tracker has no PowerShell/COM
    // dependency). Run on Mac CI + Windows CI without `#[cfg]` gating.

    use chrono::NaiveDate;
    use std::time::{Duration, Instant};

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
    }

    #[test]
    fn auto_watch_constants_match_brief() {
        // Brief §3.5: 2s poll, 10s debounce. Lock to these values via
        // unit test so a refactor can't silently drift the cadence.
        assert_eq!(AUTO_WATCH_POLL_INTERVAL, Duration::from_secs(2));
        assert_eq!(AUTO_WATCH_STABLE_WINDOW, Duration::from_secs(10));
    }

    #[test]
    fn auto_watch_observe_returns_wait_on_first_observation() {
        let mut t = AutoWatchTracker::new();
        let now = Instant::now();
        assert_eq!(t.observe(Some("{PG-1}"), now), AutoWatchAction::Wait);
    }

    #[test]
    fn auto_watch_observe_fires_after_stable_window() {
        let mut t = AutoWatchTracker::new();
        let t0 = Instant::now();
        // Tick 0: first observation — Wait.
        assert_eq!(t.observe(Some("{PG-1}"), t0), AutoWatchAction::Wait);
        // Tick 1: 2s in — still inside debounce window.
        assert_eq!(
            t.observe(Some("{PG-1}"), t0 + Duration::from_secs(2)),
            AutoWatchAction::Wait
        );
        // Tick 4: 8s in — still inside.
        assert_eq!(
            t.observe(Some("{PG-1}"), t0 + Duration::from_secs(8)),
            AutoWatchAction::Wait
        );
        // Tick 5: 10s in — fire.
        assert_eq!(
            t.observe(Some("{PG-1}"), t0 + Duration::from_secs(10)),
            AutoWatchAction::FireSend("{PG-1}".to_string())
        );
    }

    #[test]
    fn auto_watch_observe_resets_debounce_on_page_change() {
        let mut t = AutoWatchTracker::new();
        let t0 = Instant::now();
        // Observe page A for 8s.
        t.observe(Some("{PG-A}"), t0);
        t.observe(Some("{PG-A}"), t0 + Duration::from_secs(8));
        // Switch to page B at t=9s.
        assert_eq!(
            t.observe(Some("{PG-B}"), t0 + Duration::from_secs(9)),
            AutoWatchAction::Wait
        );
        // 9s later (t=18s total), still not stable on B (only 9s elapsed
        // since first observation of B).
        assert_eq!(
            t.observe(Some("{PG-B}"), t0 + Duration::from_secs(18)),
            AutoWatchAction::Wait
        );
        // 10s after first observation of B (t=19s total) — fire.
        assert_eq!(
            t.observe(Some("{PG-B}"), t0 + Duration::from_secs(19)),
            AutoWatchAction::FireSend("{PG-B}".to_string())
        );
    }

    #[test]
    fn auto_watch_observe_skips_already_sent_in_session() {
        let mut t = AutoWatchTracker::new();
        let t0 = Instant::now();
        // Observe + fire page A.
        t.observe(Some("{PG-A}"), t0);
        assert_eq!(
            t.observe(Some("{PG-A}"), t0 + Duration::from_secs(10)),
            AutoWatchAction::FireSend("{PG-A}".to_string())
        );
        t.mark_sent("{PG-A}", date(2026, 5, 28));
        // Continue observing A — should NOT re-fire.
        assert_eq!(
            t.observe(Some("{PG-A}"), t0 + Duration::from_secs(15)),
            AutoWatchAction::Wait
        );
        assert_eq!(
            t.observe(Some("{PG-A}"), t0 + Duration::from_secs(120)),
            AutoWatchAction::Wait
        );
    }

    #[test]
    fn auto_watch_observe_resets_on_no_notebook_open() {
        let mut t = AutoWatchTracker::new();
        let t0 = Instant::now();
        // Observe page A for 8s.
        t.observe(Some("{PG-A}"), t0);
        t.observe(Some("{PG-A}"), t0 + Duration::from_secs(8));
        // User closes the notebook — None means reset.
        assert_eq!(
            t.observe(None, t0 + Duration::from_secs(9)),
            AutoWatchAction::Wait
        );
        // Re-opening page A at t=12s — debounce restarts; not stable
        // for 10s yet (only just started).
        assert_eq!(
            t.observe(Some("{PG-A}"), t0 + Duration::from_secs(12)),
            AutoWatchAction::Wait
        );
        // 10s after re-open (t=22s total) — fire.
        assert_eq!(
            t.observe(Some("{PG-A}"), t0 + Duration::from_secs(22)),
            AutoWatchAction::FireSend("{PG-A}".to_string())
        );
    }

    #[test]
    fn auto_watch_observe_treats_empty_string_as_no_notebook() {
        // Defensive: parse_active_page_stdout returns None for empty
        // input but a defensive caller might pass Some("") instead of
        // None. Treat both the same.
        let mut t = AutoWatchTracker::new();
        let now = Instant::now();
        assert_eq!(t.observe(Some(""), now), AutoWatchAction::Wait);
        assert_eq!(t.observe(Some(""), now + Duration::from_secs(20)), AutoWatchAction::Wait);
    }

    #[test]
    fn auto_watch_mark_sent_increments_counter_same_day() {
        let mut t = AutoWatchTracker::new();
        let today = date(2026, 5, 28);
        assert_eq!(t.sent_today(), 0);
        t.mark_sent("{PG-1}", today);
        assert_eq!(t.sent_today(), 1);
        t.mark_sent("{PG-2}", today);
        assert_eq!(t.sent_today(), 2);
        t.mark_sent("{PG-3}", today);
        assert_eq!(t.sent_today(), 3);
        assert_eq!(t.sent_total_session(), 3);
    }

    #[test]
    fn auto_watch_mark_sent_resets_counter_at_midnight() {
        let mut t = AutoWatchTracker::new();
        let d1 = date(2026, 5, 28);
        let d2 = date(2026, 5, 29);
        t.mark_sent("{PG-1}", d1);
        t.mark_sent("{PG-2}", d1);
        assert_eq!(t.sent_today(), 2);
        // Date rolls over — counter resets to 1 (this send is the
        // first of the new day).
        t.mark_sent("{PG-3}", d2);
        assert_eq!(t.sent_today(), 1);
        // sent_total_session keeps accumulating across the rollover.
        assert_eq!(t.sent_total_session(), 3);
        // Two more on the new day → counter 3.
        t.mark_sent("{PG-4}", d2);
        t.mark_sent("{PG-5}", d2);
        assert_eq!(t.sent_today(), 3);
        assert_eq!(t.sent_total_session(), 5);
    }

    #[test]
    fn auto_watch_mark_sent_is_idempotent_per_page() {
        let mut t = AutoWatchTracker::new();
        let today = date(2026, 5, 28);
        t.mark_sent("{PG-1}", today);
        t.mark_sent("{PG-1}", today); // idempotent; no double-count
        t.mark_sent("{PG-1}", today);
        assert_eq!(t.sent_today(), 1);
        assert_eq!(t.sent_total_session(), 1);
    }

    #[test]
    fn auto_watch_reset_session_clears_dedup_but_preserves_counter() {
        let mut t = AutoWatchTracker::new();
        let today = date(2026, 5, 28);
        let t0 = Instant::now();
        // Fire + mark sent.
        t.observe(Some("{PG-1}"), t0);
        t.observe(Some("{PG-1}"), t0 + Duration::from_secs(10));
        t.mark_sent("{PG-1}", today);
        assert_eq!(t.sent_today(), 1);

        t.reset_session();
        // Counter preserved (calendar-day scope, not session scope).
        assert_eq!(t.sent_today(), 1);
        assert_eq!(t.sent_total_session(), 1);
        // Dedup set cleared → page becomes re-sendable.
        t.observe(Some("{PG-1}"), t0 + Duration::from_secs(20));
        assert_eq!(
            t.observe(Some("{PG-1}"), t0 + Duration::from_secs(30)),
            AutoWatchAction::FireSend("{PG-1}".to_string())
        );
    }

    // ───── WP-ONENOTE-EXPORT-05 — AutoWatchStatus IPC payload ─────
    //
    // The status payload is what the Configure pane + right-click menu
    // counter read. The serde round-trip is camelCase-renamed (frontend
    // reads `status.sentToday`, not `status.sent_today`); these tests
    // pin the wire shape so a future refactor can't silently break the
    // JS consumers without flipping a test.

    #[test]
    fn auto_watch_status_serializes_with_camel_case_field_names() {
        // Construct a status with every field populated so the serde
        // assertion exercises every rename. Companion to the
        // `BulkSendReport` drift-guard pattern from WP-EXPORT-04.
        let status = AutoWatchStatus {
            enabled: true,
            sent_today: 3,
            sent_total_session: 5,
            distinct_pages_sent: 5,
            debouncing_page_id: Some("{PG-CURRENT}".to_string()),
        };
        let json = serde_json::to_string(&status).expect("should serialize");
        // camelCase-renamed field names must appear verbatim in the
        // serialized JSON. snake_case forms must NOT appear.
        assert!(json.contains("\"enabled\":true"), "got: {}", json);
        assert!(json.contains("\"sentToday\":3"), "got: {}", json);
        assert!(json.contains("\"sentTotalSession\":5"), "got: {}", json);
        assert!(json.contains("\"distinctPagesSent\":5"), "got: {}", json);
        assert!(json.contains("\"debouncingPageId\":\"{PG-CURRENT}\""), "got: {}", json);
        assert!(!json.contains("sent_today"), "snake_case leak: {}", json);
        assert!(!json.contains("debouncing_page_id"), "snake_case leak: {}", json);
    }

    #[test]
    fn auto_watch_status_omits_debouncing_page_when_none() {
        // `debouncing_page_id` uses `#[serde(skip_serializing_if = "Option::is_none")]`
        // so the JS side can `if (status.debouncingPageId) { ... }` without
        // worrying about a literal "null" being present in the payload.
        let status = AutoWatchStatus {
            enabled: false,
            sent_today: 0,
            sent_total_session: 0,
            distinct_pages_sent: 0,
            debouncing_page_id: None,
        };
        let json = serde_json::to_string(&status).expect("should serialize");
        assert!(!json.contains("debouncingPageId"), "got: {}", json);
        assert!(!json.contains("null"), "got: {}", json);
    }

    #[test]
    fn auto_watch_status_round_trips_through_json() {
        let original = AutoWatchStatus {
            enabled: true,
            sent_today: 7,
            sent_total_session: 12,
            distinct_pages_sent: 11,
            debouncing_page_id: Some("{PG-X}".to_string()),
        };
        let json = serde_json::to_string(&original).expect("should serialize");
        let parsed: AutoWatchStatus =
            serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed, original);
    }

    #[test]
    fn auto_watch_status_from_tracker_reads_all_fields() {
        let mut tracker = AutoWatchTracker::new();
        let t0 = Instant::now();
        let today = date(2026, 5, 28);
        // Fire + mark two distinct pages.
        tracker.observe(Some("{PG-1}"), t0);
        tracker.observe(Some("{PG-1}"), t0 + Duration::from_secs(10));
        tracker.mark_sent("{PG-1}", today);
        tracker.observe(Some("{PG-2}"), t0 + Duration::from_secs(15));
        tracker.observe(Some("{PG-2}"), t0 + Duration::from_secs(25));
        tracker.mark_sent("{PG-2}", today);
        // Now observing a third page — it should show up as the
        // debouncing_page_id (currently dwelling on but not yet sent).
        tracker.observe(Some("{PG-3}"), t0 + Duration::from_secs(30));

        let status = AutoWatchStatus::from_tracker(&tracker, true);
        assert!(status.enabled);
        assert_eq!(status.sent_today, 2);
        assert_eq!(status.sent_total_session, 2);
        assert_eq!(status.distinct_pages_sent, 2);
        assert_eq!(status.debouncing_page_id, Some("{PG-3}".to_string()));
    }

    #[test]
    fn auto_watch_status_from_tracker_reports_enabled_false_when_loop_off() {
        // The loop's enable flag is the source of truth for `enabled`;
        // the tracker itself doesn't know whether the loop is running.
        // Even with a populated tracker (e.g., user just toggled off
        // mid-session), `from_tracker(..., false)` should report
        // `enabled: false`.
        let mut tracker = AutoWatchTracker::new();
        tracker.mark_sent("{PG-1}", date(2026, 5, 28));
        let status = AutoWatchStatus::from_tracker(&tracker, false);
        assert!(!status.enabled);
        // Counters preserved across the toggle — UX should still show
        // "Sent today: 1" even after toggling off.
        assert_eq!(status.sent_today, 1);
    }

    #[test]
    fn auto_watch_last_observed_page_id_tracks_observation() {
        // last_observed_page_id is the new IPC-facing accessor (sibling
        // of sent_today / sent_total_session). Test the observable
        // contract: returns Some(id) while debouncing, None when reset.
        let mut t = AutoWatchTracker::new();
        let t0 = Instant::now();
        assert_eq!(t.last_observed_page_id(), None);
        t.observe(Some("{PG-A}"), t0);
        assert_eq!(t.last_observed_page_id(), Some("{PG-A}"));
        // Empty-string observation resets the tracker.
        t.observe(Some(""), t0 + Duration::from_secs(1));
        assert_eq!(t.last_observed_page_id(), None);
        // None observation also resets.
        t.observe(Some("{PG-B}"), t0 + Duration::from_secs(2));
        assert_eq!(t.last_observed_page_id(), Some("{PG-B}"));
        t.observe(None, t0 + Duration::from_secs(3));
        assert_eq!(t.last_observed_page_id(), None);
    }

    #[test]
    fn auto_watch_sent_this_session_count_tracks_distinct_pages() {
        let mut t = AutoWatchTracker::new();
        let today = date(2026, 5, 28);
        assert_eq!(t.sent_this_session_count(), 0);
        t.mark_sent("{PG-1}", today);
        assert_eq!(t.sent_this_session_count(), 1);
        t.mark_sent("{PG-2}", today);
        assert_eq!(t.sent_this_session_count(), 2);
        // Duplicate insertion no-ops (dedup).
        t.mark_sent("{PG-1}", today);
        assert_eq!(t.sent_this_session_count(), 2);
        // Reset session clears the count.
        t.reset_session();
        assert_eq!(t.sent_this_session_count(), 0);
        // But the calendar-day counter is preserved.
        assert_eq!(t.sent_today(), 2);
    }
}
