//! WP-INTAKE (ONBOARD) — the integration doctor.
//!
//! Onboarding needs to enable the passive-intake channels (classic Outlook COM,
//! local calendar, OneNote COM, the OneDrive mail-sweep folder, Plaud, the
//! engine lanes) with near-zero user effort. This module is the PLUMBING that
//! layer renders: a set of SILENT, FAST, NEVER-THROWING probes that report a
//! typed status per channel, plus the two automatable-setup helpers (create the
//! OneDrive sweep folder; validate + set an ICS availability source) and the
//! canonical deep-links the guided steps open.
//!
//! ── House laws applied here ──────────────────────────────────────────────────
//! * NO UI. Every function returns structured data; the onboarding cards /
//!   Settings repair surface are a separate one-pair-of-eyes pass.
//! * NO LLM. Deterministic reads over the OS + config + one cheap engine ping.
//! * Fail-closed-but-VISIBLE: a probe never throws and never silently reports
//!   "fine" when it couldn't tell — it returns a typed `Unknown` / `notProbed`
//!   state so the doctor stays honest.
//! * The macOS Calendar TCC prompt is NEVER triggered by the silent doctor. The
//!   silent `calendar_local` probe only inspects reader/app PRESENCE (no
//!   osascript). The LIVE classification — which DOES prompt — is a separate,
//!   deliberately-called command (`probe_calendar_live` in lib.rs) so onboarding
//!   prompts "with framing, not ambush".
//!
//! ── Platform split ───────────────────────────────────────────────────────────
//! The COM/registry probes (Outlook, OneNote, OneDrive accounts) are Windows-only
//! and run through the SAME `powershell.exe` + `CREATE_NO_WINDOW` pattern the
//! OneNote / calendar / email-follow modules already use (no new registry crate).
//! On macOS those three return `NotApplicable`. macOS OneDrive-root discovery is a
//! pure filesystem walk (`~/Library/CloudStorage/OneDrive-*` + `~/OneDrive*`) —
//! which IS the cross-platform live-smoke this file can run on the dev Mac. Every
//! `stdout`-parsing classifier is a pure function unit-tested on all platforms
//! with fixture strings, so the Windows classification path is covered even where
//! it can't be spawned.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::onedrive_mail_sweep::{self, OneDriveMailConfig};

// ─────────────────────────────────────────────────────────────────────────────
// Canonical deep-links — ONE place so link-rot is a one-line fix (brief §D).
// Also exposed to the UI via the `integration_doctor_links` command.
// ─────────────────────────────────────────────────────────────────────────────

/// The Power Automate "Import Package (Legacy)" entry point the guided flow-
/// import step opens. The generated flow package (commit 2) is imported here.
pub const POWER_AUTOMATE_IMPORT_URL: &str = "https://make.powerautomate.com/import";

/// The Power Automate "My flows" list — fallback landing if the import page has
/// moved, and where a user re-enables a paused flow during a repair pass.
pub const POWER_AUTOMATE_FLOWS_URL: &str =
    "https://make.powerautomate.com/environments/~default/flows";

/// OWA calendar-sharing settings. The ICS-publish guided step deep-links here:
/// "Publish a calendar → Can view when I'm busy → Publish → copy the ICS link".
pub const OWA_SHARED_CALENDARS_URL: &str =
    "https://outlook.office.com/mail/options/calendar/SharedCalendars";

/// The canonical URL set the onboarding cards open. Kept as data so the UI never
/// hard-codes a URL and a change is one edit here.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinks {
    pub power_automate_import: &'static str,
    pub power_automate_flows: &'static str,
    pub owa_shared_calendars: &'static str,
}

impl DeepLinks {
    pub fn canonical() -> Self {
        DeepLinks {
            power_automate_import: POWER_AUTOMATE_IMPORT_URL,
            power_automate_flows: POWER_AUTOMATE_FLOWS_URL,
            owa_shared_calendars: OWA_SHARED_CALENDARS_URL,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

/// State of a Windows COM channel (Outlook-classic / OneNote). Serialized as a
/// camelCase string so the UI can branch on it directly. The non-`NotApplicable`
/// variants are only constructed on Windows (or in the cross-platform tests), so
/// the dead-code allow is scoped to non-Windows targets.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ComProbeState {
    /// The COM class is registered — the channel can be driven.
    Available,
    /// The app appears installed (an exe path was found) but the COM class is
    /// NOT registered — usually a New-Outlook-only box (no classic COM surface).
    InstalledNoCom,
    /// No COM class and no exe — the app isn't installed.
    NotInstalled,
    /// Not a Windows host — this COM channel doesn't apply here (macOS/Linux).
    NotApplicable,
    /// The probe itself failed (PowerShell error / unparseable output). Honest
    /// unknown — never reported as available.
    Unknown,
}

// ── platform ─────────────────────────────────────────────────────────────────

/// Host platform. `os` is `std::env::consts::OS` ("macos" | "windows" | "linux"
/// | …); `arch` is `std::env::consts::ARCH` ("aarch64" | "x86_64" | …).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

impl PlatformInfo {
    pub fn detect() -> Self {
        PlatformInfo {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
    fn is_windows(&self) -> bool {
        self.os == "windows"
    }
}

// ── outlookClassicCom / oneNoteCom ───────────────────────────────────────────

/// A Windows COM-channel probe result. `exe_path` is populated when an
/// App-Paths / Get-Command lookup found the executable (informational — helps
/// the UI say "installed but New-Outlook only").
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComProbe {
    pub state: ComProbeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_path: Option<String>,
}

impl ComProbe {
    pub fn not_applicable() -> Self {
        ComProbe {
            state: ComProbeState::NotApplicable,
            exe_path: None,
        }
    }
}

// ── calendarLocal (silent) ───────────────────────────────────────────────────

/// The permission read of the silent calendar probe. The silent doctor NEVER
/// prompts, so it can only ever report `Unknown` for the actual grant — the real
/// works/permissionNeeded classification comes from the deliberate live probe.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarPermission {
    /// Not probed to avoid the TCC prompt — call `probe_calendar_live` at the
    /// framed onboarding moment to resolve this.
    Unknown,
}

/// Silent calendar probe. Reports whether a reader is present (osascript +
/// Calendar.app on macOS; Outlook COM on Windows) WITHOUT running it, so no TCC
/// prompt fires. `live_probe_command` names the command onboarding calls to get
/// the real state.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLocalProbe {
    /// True when the machinery to read the calendar exists (does not imply
    /// permission — that's `permission` / the live probe).
    pub reader_present: bool,
    /// Always `Unknown` for the silent probe (never prompts).
    pub permission: CalendarPermission,
    /// The command onboarding invokes to classify for real (and prompt, framed).
    pub live_probe_command: &'static str,
    /// Terse, plain-language note (what reader was seen).
    pub note: String,
}

/// State of the deliberate LIVE calendar probe — the classification of
/// `calendar_read::read_window(1)`'s typed result. Named states map 1:1 to the
/// existing `CalendarError` variants the brief calls out.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarLiveState {
    /// The read succeeded (permission granted).
    Works,
    /// TCC / automation permission denied — onboarding shows the grant hint.
    PermissionNeeded,
    /// The read timed out (large calendar or an unanswered modal prompt).
    Timeout,
    /// No COM / Outlook unavailable (Windows).
    NoCom,
    /// Any other failure (spawn / script / other). `note` carries the reason.
    Error,
}

/// Result of the deliberate live calendar probe (used by `probe_calendar_live`).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLiveProbe {
    pub state: CalendarLiveState,
    /// Event count on success (0 is a valid, calm result), else absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_count: Option<usize>,
    /// Plain-language note for the UI.
    pub note: String,
}

// ── oneDriveRoot ─────────────────────────────────────────────────────────────

/// Kind of a discovered OneDrive account/root. Business accounts are preferred
/// for the sweep folder (org-managed, the pilot's shape).
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum OneDriveKind {
    Business,
    Personal,
    Unknown,
}

/// One discovered OneDrive sync root + whether the mail-sweep folder already
/// exists under it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveCandidate {
    /// Absolute local path of the sync root (the folder OneDrive mirrors into).
    pub path: String,
    pub kind: OneDriveKind,
    /// Display / org name when derivable (CloudStorage suffix, or registry
    /// DisplayName). Informational.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// True iff `<path>/Apps/Threshold/mail` already exists (channel set up).
    pub sweep_folder_exists: bool,
}

/// OneDrive-root discovery result. `candidates` is Business-first ordered.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveRootProbe {
    /// True when at least one candidate was found.
    pub found: bool,
    pub candidates: Vec<OneDriveCandidate>,
    /// Set on Windows when the registry read failed (honest unknown vs "none").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The sweep-folder path segments appended to a OneDrive root:
/// `<root>/Apps/Threshold/mail`. Kept as a constant so the probe and the
/// prepare-folder command agree byte-for-byte.
pub const SWEEP_FOLDER_SEGMENTS: [&str; 3] = ["Apps", "Threshold", "mail"];

/// Join a OneDrive root with the canonical sweep-folder segments.
pub fn sweep_folder_under(root: &Path) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in SWEEP_FOLDER_SEGMENTS {
        p.push(seg);
    }
    p
}

// ── onedriveMail (config state) ──────────────────────────────────────────────

/// The configured OneDrive mail-sweep channel's state — reuses the sweep's own
/// gate logic plus receipt-folder counts.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveMailProbe {
    /// `notConfigured` | `folderNotFound` | `ready` (mirrors `SweepGate`).
    pub state: &'static str,
    /// The configured folder (absolute path), if set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Count of receipts in `processed/` (successful imports, ALL kinds). 0 when
    /// not ready.
    pub processed_count: usize,
    /// Count of quarantined files in `failed/`. 0 when not ready.
    pub failed_count: usize,
    /// Count of files set aside in `skipped/` because their import lane is OFF
    /// server-side (`{enabled:false}`). Fail-VISIBLE: a nonzero here means a lane
    /// (email or Teams) needs enabling and those items are waiting, recoverable.
    pub skipped_count: usize,
    /// Cheap, honest Teams presence: the count of `processed/` receipts that are
    /// Teams-kind (classified by the `teams-` receipt filename prefix at zero
    /// extra I/O — a directory listing + name check, no file contents read, no
    /// ledger). This is the self-detect signal for the Teams channel flipping
    /// green in onboarding. 0 when not ready or no Teams message has arrived. We
    /// do NOT probe Teams itself (no API surface without consent).
    pub teams_processed_count: usize,
}

// ── plaud (config state) ─────────────────────────────────────────────────────

/// Plaud channel state derived from the locally-cached connect status. Authority
/// is the droplet's token store; this is the onboarding hint (same caveat as the
/// Settings Plaud card). Deeper token-rot health is the E2 channel-health ledger.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaudProbe {
    /// `connected` | `notConnected`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<String>,
}

// ── engine ───────────────────────────────────────────────────────────────────

/// Engine reachability + lane posture. Filled by lib.rs's async `probe_engine`
/// (needs config + reqwest); defined here so the whole report is one type.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    /// `notConfigured` | `reachable` | `unauthorized` | `unreachable`.
    pub state: &'static str,
    /// Whether the availability (ICS) lane is enabled server-side (from GET
    /// /api/availability/source `{enabled:false}` vs a status body). `None` when
    /// not determined (unreachable / not configured).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability_lane_enabled: Option<bool>,
    /// Whether the email-thread-follow lane is enabled server-side (from GET
    /// /api/email/followed-threads `{enabled:false}` vs a threads body). This is
    /// the ENGINE lane posture ONLY — it does NOT mean the app-side local-Outlook
    /// COM follower is running. Ross ruling 2026-07-13: that follower is parked
    /// as a config-gated, DEFAULT-OFF break-glass fallback
    /// (`AppConfig.email_com_follower_enabled`), with the OneDrive file sweep as
    /// the primary email transport — so even with this engine lane ON, the COM
    /// sweep stays a calm no-op unless the app flag is explicitly flipped on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_thread_follow_enabled: Option<bool>,
    /// The configured base URL (host only is not stripped — it's the user's own
    /// workspace URL, already visible in Configure). Absent when not configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Terse note for the UI (why unreachable / unauthorized).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl EngineProbe {
    /// The calm "no base URL / bearer yet" state (fresh install pre-sign-in).
    pub fn not_configured() -> Self {
        EngineProbe {
            state: "notConfigured",
            availability_lane_enabled: None,
            email_thread_follow_enabled: None,
            base_url: None,
            note: Some("Sign in on Configure first.".into()),
        }
    }
}

// ── the full report ──────────────────────────────────────────────────────────

/// The complete integration-doctor status. One flat object the onboarding cards
/// (and the Settings repair surface) render field-by-field. Every field is a
/// typed, never-throwing state.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub platform: PlatformInfo,
    pub outlook_classic_com: ComProbe,
    pub calendar_local: CalendarLocalProbe,
    pub one_note_com: ComProbe,
    pub one_drive_root: OneDriveRootProbe,
    pub onedrive_mail: OneDriveMailProbe,
    pub plaud: PlaudProbe,
    pub engine: EngineProbe,
    pub links: DeepLinks,
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL probes (everything except the async engine ping). Assembled by lib.rs's
// `integration_doctor` command on a blocking thread (the Windows PS spawns are
// blocking); the engine probe runs concurrently and is stitched in.
// ─────────────────────────────────────────────────────────────────────────────

/// The non-engine half of the report. `plaud_connect` is the cached status from
/// AppConfig; `onedrive_mail_cfg` is the persisted sweep config.
pub fn run_local_probes(
    onedrive_mail_cfg: &OneDriveMailConfig,
    plaud_connected_at: Option<String>,
) -> LocalProbes {
    let platform = PlatformInfo::detect();
    LocalProbes {
        outlook_classic_com: probe_outlook_classic_com(&platform),
        calendar_local: probe_calendar_local(&platform),
        one_note_com: probe_onenote_com(&platform),
        one_drive_root: probe_onedrive_root(&platform),
        onedrive_mail: probe_onedrive_mail(onedrive_mail_cfg),
        plaud: probe_plaud(plaud_connected_at),
        platform,
    }
}

/// The local probes, sans engine + links (which lib.rs adds).
pub struct LocalProbes {
    pub platform: PlatformInfo,
    pub outlook_classic_com: ComProbe,
    pub calendar_local: CalendarLocalProbe,
    pub one_note_com: ComProbe,
    pub one_drive_root: OneDriveRootProbe,
    pub onedrive_mail: OneDriveMailProbe,
    pub plaud: PlaudProbe,
}

// ── calendar_local (silent) ──────────────────────────────────────────────────

fn probe_calendar_local(platform: &PlatformInfo) -> CalendarLocalProbe {
    #[cfg(target_os = "macos")]
    {
        let _ = platform;
        // Presence only — NEVER run osascript here (that would trip TCC).
        let osascript = Path::new("/usr/bin/osascript").exists();
        let calendar_app = Path::new("/System/Applications/Calendar.app").exists()
            || Path::new("/Applications/Calendar.app").exists();
        let reader_present = osascript && calendar_app;
        let note = if reader_present {
            "Calendar.app + osascript present. Permission not checked yet (won't prompt).".to_string()
        } else if !calendar_app {
            "Calendar.app not found.".to_string()
        } else {
            "osascript not found.".to_string()
        };
        CalendarLocalProbe {
            reader_present,
            permission: CalendarPermission::Unknown,
            live_probe_command: "probe_calendar_live",
            note,
        }
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows the calendar read is Outlook COM; reader-present tracks the
        // classic-COM probe rather than re-spawning.
        let com = probe_outlook_classic_com(platform);
        let reader_present = com.state == ComProbeState::Available;
        CalendarLocalProbe {
            reader_present,
            permission: CalendarPermission::Unknown,
            live_probe_command: "probe_calendar_live",
            note: "Windows calendar read uses Outlook COM.".to_string(),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = platform;
        CalendarLocalProbe {
            reader_present: false,
            permission: CalendarPermission::Unknown,
            live_probe_command: "probe_calendar_live",
            note: "Local calendar read isn't available on this platform.".to_string(),
        }
    }
}

// ── onedrive_mail (config-state) ─────────────────────────────────────────────

/// Public entry to the OneDrive-mail config-state probe — used by
/// `onedrive_prepare_mail_folder` to re-derive state after setting the folder.
pub fn probe_onedrive_mail_public(cfg: &OneDriveMailConfig) -> OneDriveMailProbe {
    probe_onedrive_mail(cfg)
}

fn probe_onedrive_mail(cfg: &OneDriveMailConfig) -> OneDriveMailProbe {
    use onedrive_mail_sweep::{count_receipts, SweepGate, FAILED_DIR, PROCESSED_DIR, SKIPPED_DIR};
    let gate = onedrive_mail_sweep::gate(cfg);
    let folder = cfg.folder_path().map(|p| p.to_string_lossy().into_owned());
    let (state, processed_count, failed_count, skipped_count, teams_processed_count) = match gate {
        SweepGate::NotConfigured => ("notConfigured", 0, 0, 0, 0),
        SweepGate::FolderNotFound => ("folderNotFound", 0, 0, 0, 0),
        SweepGate::Ready => {
            // Ready ⇒ folder_path is Some. All counts are a single directory
            // listing each (+ a filename check for the Teams classification) —
            // cheap + honest, no file contents read, no ledger.
            let base = cfg.folder_path().expect("ready gate ⇒ folder set");
            let processed_dir = base.join(PROCESSED_DIR);
            let processed = count_receipts(&processed_dir, false);
            let teams = count_receipts(&processed_dir, true);
            let failed = count_receipts(&base.join(FAILED_DIR), false);
            let skipped = count_receipts(&base.join(SKIPPED_DIR), false);
            ("ready", processed, failed, skipped, teams)
        }
    };
    OneDriveMailProbe {
        state,
        folder,
        processed_count,
        failed_count,
        skipped_count,
        teams_processed_count,
    }
}

// ── plaud (config-state) ─────────────────────────────────────────────────────

fn probe_plaud(connected_at: Option<String>) -> PlaudProbe {
    match connected_at {
        Some(at) => PlaudProbe {
            state: "connected",
            connected_at: Some(at),
        },
        None => PlaudProbe {
            state: "notConnected",
            connected_at: None,
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// OneDrive-root discovery.
//   macOS: pure filesystem walk (live-testable on this Mac).
//   Windows: HKCU\Software\Microsoft\OneDrive\Accounts\* via PowerShell.
// ─────────────────────────────────────────────────────────────────────────────

fn probe_onedrive_root(platform: &PlatformInfo) -> OneDriveRootProbe {
    #[cfg(target_os = "macos")]
    {
        let _ = platform;
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let candidates = discover_onedrive_roots_macos(&home);
        OneDriveRootProbe {
            found: !candidates.is_empty(),
            candidates,
            note: None,
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = platform;
        match windows_onedrive_accounts_stdout() {
            Ok(stdout) => {
                let candidates = parse_onedrive_accounts_windows(&stdout, &sweep_exists_real);
                OneDriveRootProbe {
                    found: !candidates.is_empty(),
                    candidates,
                    note: None,
                }
            }
            Err(e) => OneDriveRootProbe {
                found: false,
                candidates: Vec::new(),
                note: Some(format!("OneDrive registry read failed: {e}")),
            },
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = platform;
        OneDriveRootProbe {
            found: false,
            candidates: Vec::new(),
            note: Some("OneDrive discovery isn't available on this platform.".into()),
        }
    }
}

/// Pure macOS OneDrive-root discovery over a given HOME. Scans
/// `~/Library/CloudStorage/OneDrive-*` (business, org = suffix) and the legacy
/// `~/OneDrive*` fallback (personal/unknown). Business-first ordering. Each
/// candidate is tested for the existing sweep folder. Pure over the real fs so
/// the temp-dir unit test IS the cross-platform smoke.
pub fn discover_onedrive_roots_macos(home: &Path) -> Vec<OneDriveCandidate> {
    let mut business: Vec<OneDriveCandidate> = Vec::new();
    let mut other: Vec<OneDriveCandidate> = Vec::new();

    // ~/Library/CloudStorage/OneDrive-<Org>  (the modern File Provider location).
    let cloud = home.join("Library").join("CloudStorage");
    if let Ok(entries) = std::fs::read_dir(&cloud) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if let Some(suffix) = name.strip_prefix("OneDrive-") {
                let is_personal = suffix.eq_ignore_ascii_case("Personal");
                let cand = OneDriveCandidate {
                    path: path.to_string_lossy().into_owned(),
                    kind: if is_personal {
                        OneDriveKind::Personal
                    } else {
                        OneDriveKind::Business
                    },
                    display_name: if suffix.is_empty() {
                        None
                    } else {
                        Some(suffix.to_string())
                    },
                    sweep_folder_exists: sweep_folder_under(&path).is_dir(),
                };
                if is_personal {
                    other.push(cand);
                } else {
                    business.push(cand);
                }
            }
        }
    }

    // ~/OneDrive*  (legacy sync-client location; personal or org, ambiguous).
    if let Ok(entries) = std::fs::read_dir(home) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name == "OneDrive" || name.starts_with("OneDrive ") || name.starts_with("OneDrive-")
            {
                // Skip if we already recorded this exact path via CloudStorage.
                let path_str = path.to_string_lossy().into_owned();
                if business.iter().chain(other.iter()).any(|c| c.path == path_str) {
                    continue;
                }
                let kind = if name.to_lowercase().contains("personal") {
                    OneDriveKind::Personal
                } else {
                    OneDriveKind::Unknown
                };
                other.push(OneDriveCandidate {
                    path: path_str,
                    kind,
                    display_name: Some(name.to_string()),
                    sweep_folder_exists: sweep_folder_under(&path).is_dir(),
                });
            }
        }
    }

    business.into_iter().chain(other).collect()
}

/// Pure parser for the Windows OneDrive-accounts PowerShell output. Each line:
/// `ACCT name=<Business1|Personal> folder=<path> display=<name>`. `sweep_exists`
/// is injected so the parser stays pure + unit-testable (the real closure stats
/// the fs; tests pass a stub). Business-first ordering; entries without a folder
/// are dropped. Windows-runtime + test only ⇒ scoped dead-code allow.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_onedrive_accounts_windows(
    stdout: &str,
    sweep_exists: &dyn Fn(&Path) -> bool,
) -> Vec<OneDriveCandidate> {
    let mut business: Vec<OneDriveCandidate> = Vec::new();
    let mut other: Vec<OneDriveCandidate> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        let rest = match line.strip_prefix("ACCT ") {
            Some(r) => r,
            None => continue,
        };
        let name = extract_kv(rest, "name=");
        let folder = extract_kv(rest, "folder=");
        let display = extract_kv(rest, "display=");
        let folder = match folder.filter(|f| !f.trim().is_empty()) {
            Some(f) => f,
            None => continue,
        };
        let name_l = name.as_deref().unwrap_or("").to_lowercase();
        let kind = if name_l.starts_with("business") {
            OneDriveKind::Business
        } else if name_l.starts_with("personal") {
            OneDriveKind::Personal
        } else {
            OneDriveKind::Unknown
        };
        let path = PathBuf::from(&folder);
        let cand = OneDriveCandidate {
            path: folder.clone(),
            kind,
            display_name: display.filter(|d| !d.trim().is_empty()),
            sweep_folder_exists: sweep_exists(&sweep_folder_under(&path)),
        };
        if matches!(kind, OneDriveKind::Business) {
            business.push(cand);
        } else {
            other.push(cand);
        }
    }
    business.into_iter().chain(other).collect()
}

/// Extract the value for `key` (e.g. `"folder="` / `"com="`) from a single
/// space-tokenized probe line (`ACCT …` or `DOCTOR_COM …`). Values may contain
/// spaces (Windows paths do) so we take everything from the key up to the NEXT
/// ` <ident>=` token — a space followed by a run of `[A-Za-z0-9_]` then `=` — or
/// end of line. Key-agnostic, so it works for every probe-line shape. Consumed by
/// the Windows classifiers + the cross-platform tests ⇒ scoped dead-code allow.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn extract_kv(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let tail = &line[start..];
    let end = next_key_boundary(tail).unwrap_or(tail.len());
    Some(tail[..end].trim().to_string())
}

/// Byte offset of the next ` <ident>=` token in `s` (the boundary where the
/// current value ends and the next key begins), or `None` if there isn't one.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn next_key_boundary(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' {
            // Scan an identifier run after the space.
            let mut j = i + 1;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_')
            {
                j += 1;
            }
            // Must be a non-empty ident immediately followed by '='.
            if j > i + 1 && j < bytes.len() && bytes[j] == b'=' {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Real sweep-folder existence check (Windows path). Split out so the parser can
/// be tested with a stub.
#[cfg(target_os = "windows")]
fn sweep_exists_real(p: &Path) -> bool {
    p.is_dir()
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows COM / registry probes (PowerShell, CREATE_NO_WINDOW). The spawn is
// gated to Windows; the classifiers below are pure + tested everywhere.
// ─────────────────────────────────────────────────────────────────────────────

/// PS: is a COM ProgId registered + where's its exe? Emits one line
/// `DOCTOR_COM progid=<id> com=<True|False> exe=<path>`. Used for both Outlook
/// and OneNote (different progid / App-Paths exe).
#[cfg(target_os = "windows")]
fn ps_com_probe_script(progid: &str, app_paths_exe: &str) -> String {
    format!(
        r#"$com = Test-Path ('Registry::HKEY_CLASSES_ROOT\{progid}')
$exe = ''
try {{ $exe = (Get-ItemProperty ('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}') -ErrorAction Stop).'(default)' }} catch {{}}
if ([string]::IsNullOrEmpty($exe)) {{ try {{ $exe = (Get-Command '{exe}' -ErrorAction Stop).Source }} catch {{}} }}
Write-Output ("DOCTOR_COM progid={progid} com=$com exe=$exe")"#,
        progid = progid,
        exe = app_paths_exe,
    )
}

/// PS: enumerate OneDrive accounts from the registry. One `ACCT` line per
/// account key with its UserFolder + DisplayName. Business accounts sort first
/// downstream (parser).
#[cfg(target_os = "windows")]
const PS_ONEDRIVE_ACCOUNTS: &str = r#"$root = 'HKCU:\Software\Microsoft\OneDrive\Accounts'
if (Test-Path $root) {
  Get-ChildItem $root | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    $name = Split-Path $_.Name -Leaf
    $folder = $p.UserFolder
    $display = $p.DisplayName
    Write-Output ("ACCT name=$name folder=$folder display=$display")
  }
}"#;

#[cfg(target_os = "windows")]
fn spawn_ps(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "powershell exit {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "windows")]
fn windows_onedrive_accounts_stdout() -> Result<String, String> {
    spawn_ps(PS_ONEDRIVE_ACCOUNTS)
}

fn probe_outlook_classic_com(platform: &PlatformInfo) -> ComProbe {
    if !platform.is_windows() {
        return ComProbe::not_applicable();
    }
    #[cfg(target_os = "windows")]
    {
        match spawn_ps(&ps_com_probe_script("Outlook.Application", "OUTLOOK.EXE")) {
            Ok(stdout) => classify_com_probe(&stdout),
            Err(_) => ComProbe {
                state: ComProbeState::Unknown,
                exe_path: None,
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ComProbe::not_applicable()
    }
}

fn probe_onenote_com(platform: &PlatformInfo) -> ComProbe {
    if !platform.is_windows() {
        return ComProbe::not_applicable();
    }
    #[cfg(target_os = "windows")]
    {
        match spawn_ps(&ps_com_probe_script("OneNote.Application", "ONENOTE.EXE")) {
            Ok(stdout) => classify_com_probe(&stdout),
            Err(_) => ComProbe {
                state: ComProbeState::Unknown,
                exe_path: None,
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ComProbe::not_applicable()
    }
}

/// Pure classifier for the `DOCTOR_COM progid=… com=… exe=…` line. `com=True` ⇒
/// `Available`; else if an exe path is present ⇒ `InstalledNoCom`; else
/// `NotInstalled`. A missing/garbled line ⇒ `Unknown` (honest). Unit-tested on
/// every platform; only spawned on Windows ⇒ scoped dead-code allow.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn classify_com_probe(stdout: &str) -> ComProbe {
    let line = match stdout.lines().find(|l| l.trim_start().starts_with("DOCTOR_COM")) {
        Some(l) => l.trim(),
        None => {
            return ComProbe {
                state: ComProbeState::Unknown,
                exe_path: None,
            }
        }
    };
    let com = extract_kv(line, "com=")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let exe = extract_kv(line, "exe=").filter(|e| !e.trim().is_empty());
    let state = if com {
        ComProbeState::Available
    } else if exe.is_some() {
        ComProbeState::InstalledNoCom
    } else {
        ComProbeState::NotInstalled
    };
    ComProbe {
        state,
        exe_path: exe,
    }
}

/// Classify the deliberate live calendar read (`calendar_read::read_window`)
/// into the onboarding-facing state. Pure over the typed result so it's tested
/// on every platform (the read itself is what prompts; this is just the mapping).
pub fn classify_calendar_live(
    result: Result<crate::calendar_read::CalendarReadResult, crate::calendar_read::CalendarError>,
) -> CalendarLiveProbe {
    use crate::calendar_read::CalendarError;
    match result {
        Ok(r) => CalendarLiveProbe {
            state: CalendarLiveState::Works,
            event_count: Some(r.events.len()),
            note: "Calendar access is working.".to_string(),
        },
        Err(CalendarError::PermissionDenied) => CalendarLiveProbe {
            state: CalendarLiveState::PermissionNeeded,
            event_count: None,
            note: CalendarError::PermissionDenied.user_message().to_string(),
        },
        Err(CalendarError::Timeout) => CalendarLiveProbe {
            state: CalendarLiveState::Timeout,
            event_count: None,
            note: CalendarError::Timeout.user_message().to_string(),
        },
        Err(CalendarError::OutlookUnavailable) => CalendarLiveProbe {
            state: CalendarLiveState::NoCom,
            event_count: None,
            note: CalendarError::OutlookUnavailable.user_message().to_string(),
        },
        Err(other) => CalendarLiveProbe {
            state: CalendarLiveState::Error,
            event_count: None,
            note: other.user_message().to_string(),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ICS availability-source: local sanity validation (the engine owns parsing).
// The command in lib.rs does the fetch + engine POST; these are the pure bits.
// ─────────────────────────────────────────────────────────────────────────────

/// Byte cap on the ICS fetch (brief: 5MB). A busy-only publish is a few KB; the
/// cap guards against a hostile/huge URL. Enforced by the chunked reader in
/// lib.rs's `ics_source_set`.
pub const ICS_FETCH_BYTE_CAP: usize = 5 * 1024 * 1024;

/// Timeout for the ICS fetch (brief: ~15s).
pub const ICS_FETCH_TIMEOUT_SECS: u64 = 15;

/// Typed ICS-validation failure (local sanity, before the engine ever sees it).
#[derive(Debug, PartialEq)]
pub enum IcsValidationError {
    /// Empty / whitespace-only paste.
    Empty,
    /// Not an https URL (the ICS URL is a free/busy secret — https only).
    NotHttps,
    /// Fetched OK but the body didn't look like an iCalendar document.
    NotCalendar,
    /// Exceeded the byte cap while fetching.
    TooLarge,
}

impl IcsValidationError {
    /// Plain-language message for the immediate red state.
    pub fn user_message(&self) -> &'static str {
        match self {
            IcsValidationError::Empty => "Paste your calendar's ICS link first.",
            IcsValidationError::NotHttps => "That doesn't look like a secure (https) ICS link.",
            IcsValidationError::NotCalendar => {
                "That link didn't return a calendar. Check you copied the Publish → ICS link."
            }
            IcsValidationError::TooLarge => "That calendar file is unexpectedly large — check the link.",
        }
    }
    /// Short stage token for the structured result.
    pub fn stage(&self) -> &'static str {
        match self {
            IcsValidationError::Empty | IcsValidationError::NotHttps => "validation",
            IcsValidationError::NotCalendar | IcsValidationError::TooLarge => "fetch",
        }
    }
}

/// Local shape validation of a pasted ICS URL: non-empty + https. Does NOT
/// fetch. Pure + unit-tested. Returns the trimmed URL on success.
pub fn validate_ics_url_shape(url: &str) -> Result<String, IcsValidationError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(IcsValidationError::Empty);
    }
    if !trimmed.to_lowercase().starts_with("https://") {
        return Err(IcsValidationError::NotHttps);
    }
    Ok(trimmed.to_string())
}

/// Does a fetched body look like an iCalendar document? We do NOT parse (the
/// engine owns that) — just require the `BEGIN:VCALENDAR` sentinel, tolerant of
/// a leading BOM / whitespace and case. Pure + unit-tested.
pub fn ics_body_looks_valid(body: &str) -> bool {
    let head: String = body.chars().take(4096).collect();
    head.to_uppercase().contains("BEGIN:VCALENDAR")
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — pure classifiers + macOS fs discovery smoke.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    // ── deep links are stable + non-empty ──
    #[test]
    fn deep_links_canonical() {
        let l = DeepLinks::canonical();
        assert_eq!(
            l.owa_shared_calendars,
            "https://outlook.office.com/mail/options/calendar/SharedCalendars"
        );
        assert!(l.power_automate_import.starts_with("https://"));
        assert!(l.power_automate_flows.starts_with("https://"));
    }

    // ── platform ──
    #[test]
    fn platform_detect_nonempty() {
        let p = PlatformInfo::detect();
        assert!(!p.os.is_empty());
        assert!(!p.arch.is_empty());
    }

    // ── sweep folder path ──
    #[test]
    fn sweep_folder_segments_join() {
        let root = PathBuf::from("/tmp/OneDrive-Contoso");
        let p = sweep_folder_under(&root);
        assert!(p.ends_with("Apps/Threshold/mail"));
    }

    // ── COM classifier ──
    #[test]
    fn classify_com_available() {
        let s = "DOCTOR_COM progid=Outlook.Application com=True exe=C:\\Program Files\\OUTLOOK.EXE";
        let c = classify_com_probe(s);
        assert_eq!(c.state, ComProbeState::Available);
        assert_eq!(c.exe_path.as_deref(), Some("C:\\Program Files\\OUTLOOK.EXE"));
    }

    #[test]
    fn classify_com_installed_no_com() {
        let s = "DOCTOR_COM progid=Outlook.Application com=False exe=C:\\Program Files\\OUTLOOK.EXE";
        let c = classify_com_probe(s);
        assert_eq!(c.state, ComProbeState::InstalledNoCom);
    }

    #[test]
    fn classify_com_not_installed() {
        let s = "DOCTOR_COM progid=OneNote.Application com=False exe=";
        assert_eq!(classify_com_probe(s).state, ComProbeState::NotInstalled);
    }

    #[test]
    fn classify_com_unknown_when_no_line() {
        assert_eq!(classify_com_probe("garbage\n").state, ComProbeState::Unknown);
        assert_eq!(classify_com_probe("").state, ComProbeState::Unknown);
    }

    // ── extract_kv handles spaces in paths ──
    #[test]
    fn extract_kv_path_with_spaces() {
        let line = "ACCT name=Business1 folder=C:\\Users\\Trisha\\OneDrive - Contoso display=Contoso Ltd";
        assert_eq!(extract_kv(line, "name=").as_deref(), Some("Business1"));
        assert_eq!(
            extract_kv(line, "folder=").as_deref(),
            Some("C:\\Users\\Trisha\\OneDrive - Contoso")
        );
        assert_eq!(extract_kv(line, "display=").as_deref(), Some("Contoso Ltd"));
    }

    // ── Windows OneDrive-accounts parser: business-first + kinds ──
    #[test]
    fn parse_onedrive_accounts_business_first() {
        let stdout = "\
ACCT name=Personal folder=C:\\Users\\T\\OneDrive display=Personal
ACCT name=Business1 folder=C:\\Users\\T\\OneDrive - Contoso display=Contoso
ACCT name=Business2 folder= display=Empty
";
        // sweep exists only under the Contoso business root.
        let exists = |p: &Path| p.to_string_lossy().contains("Contoso");
        let cands = parse_onedrive_accounts_windows(stdout, &exists);
        // Business2 dropped (no folder). Business1 first (business-first), then Personal.
        assert_eq!(cands.len(), 2);
        assert_eq!(cands[0].kind, OneDriveKind::Business);
        assert_eq!(cands[0].path, "C:\\Users\\T\\OneDrive - Contoso");
        assert!(cands[0].sweep_folder_exists);
        assert_eq!(cands[1].kind, OneDriveKind::Personal);
        assert!(!cands[1].sweep_folder_exists);
    }

    #[test]
    fn parse_onedrive_accounts_empty() {
        let cands = parse_onedrive_accounts_windows("", &|_p| false);
        assert!(cands.is_empty());
    }

    // ── macOS OneDrive discovery over a temp HOME (the cross-platform smoke) ──
    #[test]
    fn discover_onedrive_roots_macos_finds_business_and_personal() {
        let root = std::env::temp_dir().join(format!(
            "threshold-doctor-home-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cloud = root.join("Library").join("CloudStorage");
        let business = cloud.join("OneDrive-Contoso");
        let personal = cloud.join("OneDrive-Personal");
        std::fs::create_dir_all(&business).unwrap();
        std::fs::create_dir_all(&personal).unwrap();
        // Pre-create the sweep folder under the business root only.
        std::fs::create_dir_all(sweep_folder_under(&business)).unwrap();
        // A legacy ~/OneDrive dir too.
        std::fs::create_dir_all(root.join("OneDrive")).unwrap();

        let cands = discover_onedrive_roots_macos(&root);
        // Business first.
        assert_eq!(cands[0].kind, OneDriveKind::Business);
        assert_eq!(cands[0].display_name.as_deref(), Some("Contoso"));
        assert!(cands[0].sweep_folder_exists, "sweep folder detected");
        // Personal + legacy present among the rest.
        assert!(cands.iter().any(|c| c.kind == OneDriveKind::Personal));
        assert!(cands.iter().any(|c| c.path.ends_with("OneDrive")));
        // Personal has no sweep folder.
        let personal_c = cands.iter().find(|c| c.kind == OneDriveKind::Personal).unwrap();
        assert!(!personal_c.sweep_folder_exists);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_onedrive_roots_macos_empty_home() {
        let root = std::env::temp_dir().join(format!(
            "threshold-doctor-empty-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert!(discover_onedrive_roots_macos(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── onedrive_mail config-state probe ──
    #[test]
    fn probe_onedrive_mail_states() {
        // Not configured.
        let p = probe_onedrive_mail(&OneDriveMailConfig::default());
        assert_eq!(p.state, "notConfigured");
        assert!(p.folder.is_none());

        // Folder-not-found.
        let missing = OneDriveMailConfig {
            folder: Some("/no/such/threshold/mail/zzz".into()),
        };
        assert_eq!(probe_onedrive_mail(&missing).state, "folderNotFound");

        // Ready, with a processed receipt + a failed receipt.
        let root = std::env::temp_dir().join(format!(
            "threshold-doctor-odm-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join(onedrive_mail_sweep::PROCESSED_DIR)).unwrap();
        std::fs::create_dir_all(root.join(onedrive_mail_sweep::FAILED_DIR)).unwrap();
        std::fs::create_dir_all(root.join(onedrive_mail_sweep::SKIPPED_DIR)).unwrap();
        // One email receipt (guid name) + one Teams receipt (teams- prefix).
        std::fs::write(
            root.join(onedrive_mail_sweep::PROCESSED_DIR).join("a.json"),
            "{}",
        )
        .unwrap();
        std::fs::write(
            root.join(onedrive_mail_sweep::PROCESSED_DIR).join("teams-c.json"),
            "{}",
        )
        .unwrap();
        std::fs::write(root.join(onedrive_mail_sweep::FAILED_DIR).join("b.json"), "{}").unwrap();
        // A lane-off Teams file set aside in skipped/ (prefixed).
        std::fs::write(
            root.join(onedrive_mail_sweep::SKIPPED_DIR).join("teams-d.json"),
            "{}",
        )
        .unwrap();
        let ready = OneDriveMailConfig {
            folder: Some(root.to_string_lossy().into_owned()),
        };
        let p = probe_onedrive_mail(&ready);
        assert_eq!(p.state, "ready");
        assert_eq!(p.processed_count, 2, "email + teams receipts counted");
        assert_eq!(p.teams_processed_count, 1, "only the teams- receipt classified");
        assert_eq!(p.failed_count, 1);
        assert_eq!(p.skipped_count, 1, "lane-off file counted in skipped/");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── plaud config-state probe ──
    #[test]
    fn probe_plaud_states() {
        assert_eq!(probe_plaud(None).state, "notConnected");
        let p = probe_plaud(Some("2026-07-11T00:00:00Z".into()));
        assert_eq!(p.state, "connected");
        assert_eq!(p.connected_at.as_deref(), Some("2026-07-11T00:00:00Z"));
    }

    // ── calendar_local never claims permission (no TCC prompt) ──
    #[test]
    fn calendar_local_permission_is_unknown() {
        let p = probe_calendar_local(&PlatformInfo::detect());
        assert_eq!(p.permission, CalendarPermission::Unknown);
        assert_eq!(p.live_probe_command, "probe_calendar_live");
    }

    // ── ICS shape validation ──
    #[test]
    fn ics_shape_requires_https() {
        assert_eq!(validate_ics_url_shape("  ").unwrap_err(), IcsValidationError::Empty);
        assert_eq!(
            validate_ics_url_shape("http://x/cal.ics").unwrap_err(),
            IcsValidationError::NotHttps
        );
        assert_eq!(
            validate_ics_url_shape("ftp://x").unwrap_err(),
            IcsValidationError::NotHttps
        );
        assert_eq!(
            validate_ics_url_shape("  https://outlook.office.com/owa/calendar/abc/reachcalendar.ics  ").unwrap(),
            "https://outlook.office.com/owa/calendar/abc/reachcalendar.ics"
        );
    }

    // ── ICS body sniff (no parse) ──
    #[test]
    fn ics_body_sniff() {
        assert!(ics_body_looks_valid("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
        // BOM + lowercase tolerated.
        assert!(ics_body_looks_valid("\u{feff}begin:vcalendar\n"));
        assert!(!ics_body_looks_valid("<html>not a calendar</html>"));
        assert!(!ics_body_looks_valid(""));
    }

    // ── live-calendar classifier maps typed errors ──
    #[test]
    fn classify_calendar_live_maps_states() {
        use crate::calendar_read::{CalendarError, CalendarReadResult, CalendarSource};
        let ok = classify_calendar_live(Ok(CalendarReadResult {
            source: CalendarSource::CalendarApp,
            events: vec![],
        }));
        assert_eq!(ok.state, CalendarLiveState::Works);
        assert_eq!(ok.event_count, Some(0));

        assert_eq!(
            classify_calendar_live(Err(CalendarError::PermissionDenied)).state,
            CalendarLiveState::PermissionNeeded
        );
        assert_eq!(
            classify_calendar_live(Err(CalendarError::Timeout)).state,
            CalendarLiveState::Timeout
        );
        assert_eq!(
            classify_calendar_live(Err(CalendarError::OutlookUnavailable)).state,
            CalendarLiveState::NoCom
        );
        assert_eq!(
            classify_calendar_live(Err(CalendarError::Other("x".into()))).state,
            CalendarLiveState::Error
        );
    }

    #[test]
    fn ics_validation_messages_nonempty() {
        for e in [
            IcsValidationError::Empty,
            IcsValidationError::NotHttps,
            IcsValidationError::NotCalendar,
            IcsValidationError::TooLarge,
        ] {
            assert!(!e.user_message().is_empty());
            assert!(!e.stage().is_empty());
        }
    }
}
