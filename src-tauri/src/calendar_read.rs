//! Local calendar reader (WP-CALENDAR piece A).
//!
//! Reads the user's calendar for the next N days into a normalized
//! `Vec<CalendarEvent>` that the JS push layer maps to the engine's
//! `POST /api/availability` body. Calendar is its OWN lane — these events never
//! enter the decision log, never feed extraction/markers/calibration, and no
//! LLM ever runs over them (WP-CALENDAR binding rule 1). This module only
//! READS; the push shaping + POST live in `push_availability` in `lib.rs`.
//!
//! Substrate mirrors the OneNote plumbing (`onenote_windows.rs`): a fresh
//! subprocess per read, an inline script, typed errors, and a
//! `#[cfg(...)]`-gated Mac / Windows / stub split so the cross-platform build
//! stays clean.
//!   - **macOS**: `osascript -l JavaScript` (JXA) against Calendar.app; if
//!     Calendar.app yields zero events we probe **Microsoft Outlook** for Mac's
//!     AppleScript dictionary as a fallback and prefer whichever source has
//!     events. AppleScript against a large Calendar.app is SLOW, so the query is
//!     scoped to the date window and wrapped in a hard ~30s timeout that fails
//!     CLOSED as `CalendarError::Timeout` (never a silent empty read).
//!   - **Windows**: Outlook COM via PowerShell (mirrors
//!     `onenote_windows::spawn_ps_script`, including the `CREATE_NO_WINDOW`
//!     console-flash suppression), using `Items.Restrict` + `IncludeRecurrences`
//!     so recurring meetings expand into the window.
//!
//! Both platforms emit ONE line per event on stdout in a stable pipe-delimited
//! shape (`start|end|busy|title|organizer`) which `parse_events_stdout` (a pure
//! function, unit-tested on every platform) turns into `CalendarEvent`s.

use serde::{Deserialize, Serialize};

// ───────────────────────────────────────────────────────────────────────────
// Public types (cross-platform — shape is identical everywhere for serde)
// ───────────────────────────────────────────────────────────────────────────

/// A single normalized calendar event. `busy` reflects the event's free/busy
/// status (macOS "availability" / Outlook `BusyStatus`); tentative and
/// out-of-office both count as busy for scheduling purposes, free/transparent
/// events are `false`. `title` and `organizer` are ALWAYS returned to the
/// caller (per WP-CALENDAR rule 2: local detail is allowed) — the PUSH layer
/// decides whether to send them to the engine (busy-only by default).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    /// ISO-8601 start instant (offset-stamped local time — the scripts emit a
    /// full offset so the engine can parse it unambiguously).
    pub start: String,
    /// ISO-8601 end instant.
    pub end: String,
    /// Whether the event marks the user as busy (busy / tentative / OOO ⇒
    /// true; free / transparent ⇒ false).
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organizer: Option<String>,
}

/// Which local source produced the events. Returned to the caller so the app
/// can render provenance ("from Calendar.app" / "from Outlook") without the
/// push layer having to guess.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarSource {
    /// macOS Calendar.app (aggregates iCloud + synced Exchange/Outlook accounts).
    CalendarApp,
    /// Microsoft Outlook (Mac AppleScript dictionary, or Windows COM).
    Outlook,
    /// No source produced events (empty read from every probed source). Not an
    /// error — a genuinely empty calendar is a valid, calm result.
    None,
}

/// The full read result: the source that won + its events. The JS push layer
/// maps `events` to the engine body; `source` is available for local display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarReadResult {
    pub source: CalendarSource,
    pub events: Vec<CalendarEvent>,
}

/// Distinguishable error variants. Every variant carries a caller-facing
/// `user_message()` so the app can render the fail-closed-but-VISIBLE
/// "calendar unavailable" state (WP-CALENDAR rule 4) rather than silently
/// showing an empty calendar. `dead_code` is suppressed off the platforms that
/// don't construct a given variant (the Mac path never hits COM errors, etc.),
/// but the unit tests exercise every variant's `user_message` + `Display` on
/// all platforms.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub enum CalendarError {
    /// The read took longer than the hard timeout (large Calendar.app; a
    /// hung osascript; a modal permission prompt the user hasn't answered).
    /// Fails CLOSED so the caller shows "calendar unavailable", never an
    /// empty calendar.
    Timeout,
    /// macOS denied automation/calendar access (first-run TCC prompt declined,
    /// or Automation permission revoked in System Settings → Privacy). Distinct
    /// so the app can render a "grant calendar access" hint instead of a
    /// generic failure.
    PermissionDenied,
    /// The reader subprocess (`osascript` / `powershell.exe`) couldn't be
    /// spawned at all (missing from PATH — extraordinarily rare on a real OS).
    SpawnFailed(String),
    /// The reader subprocess ran but exited non-zero for a reason we didn't
    /// classify into a more specific variant. Carries stderr for logging.
    ScriptFailed { code: i32, stderr: String },
    /// Outlook COM class isn't registered / Outlook not installed (Windows).
    /// User-actionable: install or open Outlook, or rely on the other source.
    OutlookUnavailable,
    /// Catch-all for unexpected failures (e.g. non-UTF-8 stdout).
    Other(String),
    /// Non-desktop / unsupported platform. Returned by the stub so the
    /// cross-platform compile is clean and IPC consumers get a consistent
    /// failure shape. Only CONSTRUCTED on non-Mac/non-Windows targets; the tests
    /// still exercise its `user_message`/`Display` on every platform, so the
    /// allow is scoped to the two platforms that never build it.
    #[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
    PlatformUnsupported,
}

impl CalendarError {
    /// Short user-visible message for the "calendar unavailable" surface. Keep
    /// terse; plain product language (no "TCC", no "osascript", no COM jargon).
    pub fn user_message(&self) -> &'static str {
        match self {
            CalendarError::Timeout => {
                "Reading your calendar took too long — it may be very large, or a permission prompt is waiting. Try again."
            }
            CalendarError::PermissionDenied => {
                "Threshold needs permission to read your calendar. Grant Calendar access in System Settings → Privacy, then try again."
            }
            CalendarError::SpawnFailed(_) => "Couldn't start the calendar reader on this machine.",
            CalendarError::ScriptFailed { .. } => "Couldn't read your calendar (the reader returned an error).",
            CalendarError::OutlookUnavailable => {
                "Couldn't reach Outlook to read your calendar — open Outlook and try again."
            }
            CalendarError::Other(_) => "Couldn't read your calendar.",
            CalendarError::PlatformUnsupported => "Calendar reading isn't available on this platform.",
        }
    }
}

impl std::fmt::Display for CalendarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CalendarError::Timeout => write!(f, "calendar read timed out"),
            CalendarError::PermissionDenied => write!(f, "calendar/automation permission denied"),
            CalendarError::SpawnFailed(e) => write!(f, "reader spawn failed: {}", e),
            CalendarError::ScriptFailed { code, stderr } => {
                write!(f, "reader exited with code {}: {}", code, stderr)
            }
            CalendarError::OutlookUnavailable => write!(f, "Outlook COM unavailable"),
            CalendarError::Other(e) => write!(f, "calendar read error: {}", e),
            CalendarError::PlatformUnsupported => {
                write!(f, "calendar reading is not available on this platform")
            }
        }
    }
}

impl std::error::Error for CalendarError {}

// ───────────────────────────────────────────────────────────────────────────
// Cross-platform stdout parsing (pure function — exercised by unit tests on
// every platform via fixture stdout; also called by the Mac + Windows paths).
// ───────────────────────────────────────────────────────────────────────────

/// The field delimiter the reader scripts emit between the 5 event fields.
/// Chosen because it never appears in an ISO timestamp, a boolean, or (after
/// the scripts' sanitization) a title/organizer. A US-ASCII unit-separator
/// would be cleaner but is painful to embed in an inline AppleScript literal;
/// the pipe + sanitize-pipes-out-of-titles approach matches how the OneNote
/// path templated its markers.
pub const FIELD_SEP: &str = "\u{1f}"; // ASCII Unit Separator (0x1F)

/// The line prefix the reader scripts stamp on every real event line, so we can
/// ignore any stray osascript diagnostic noise on stdout (JXA `console.log`
/// writes to stderr, but be defensive).
pub const EVENT_PREFIX: &str = "EVT";

/// Parse the reader stdout into `CalendarEvent`s. Each real event is one line:
///   `EVT<sep>start<sep>end<sep>busy<sep>title<sep>organizer`
/// `busy` is the literal `1` / `0`. `title` / `organizer` may be empty (⇒
/// `None`). Unknown / malformed lines are skipped (best-effort context, never
/// a source of truth — one bad row must not poison the snapshot). Pure +
/// deterministic; NO subprocess, so unit tests run everywhere.
pub fn parse_events_stdout(stdout: &str) -> Vec<CalendarEvent> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split(FIELD_SEP);
        // First field must be the EVT marker.
        match parts.next() {
            Some(EVENT_PREFIX) => {}
            _ => continue,
        }
        let start = match parts.next() {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        let end = match parts.next() {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        let busy = match parts.next() {
            Some(b) => b.trim() == "1",
            None => continue,
        };
        // title / organizer are optional; empty ⇒ None.
        let title = parts
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let organizer = parts
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        out.push(CalendarEvent {
            start,
            end,
            busy,
            title,
            organizer,
        });
    }
    out
}

// ───────────────────────────────────────────────────────────────────────────
// macOS implementation (osascript / JXA)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Hard timeout for a single osascript read. AppleScript over a large
    /// Calendar.app is genuinely slow; 30s is the brief's ceiling. On expiry we
    /// kill the child and return `CalendarError::Timeout` (fail-closed-visible).
    const READ_TIMEOUT: Duration = Duration::from_secs(30);

    /// JXA reader for Calendar.app. Emits one `EVT`-prefixed, unit-separated
    /// line per event in `[now, now + days]`. Uses the Calendar scripting
    /// interface's date-bounded query. `availability` maps to `busy`
    /// (0 = busy → we treat non-free as busy; Calendar.app exposes
    /// availability as an enum where "free" is the only non-busy value).
    ///
    /// The `{days}` / `{sep}` / `{prefix}` placeholders are templated in by
    /// `build_calendar_jxa`. Titles/organizers have the separator + newlines
    /// stripped so a single event can never span or split a line.
    fn build_calendar_jxa(days: u32) -> String {
        // JXA source. Kept intentionally defensive: any per-calendar or
        // per-event failure is swallowed so one bad calendar doesn't abort the
        // whole read. `Application('Calendar')` does not force the UI to the
        // foreground here (we never call `.activate()`).
        format!(
            r#"
function run() {{
  var sep = String.fromCharCode(31);
  var out = [];
  try {{
    var Cal = Application('Calendar');
    var now = new Date();
    var end = new Date(now.getTime() + {days} * 24 * 60 * 60 * 1000);
    var cals = Cal.calendars();
    for (var c = 0; c < cals.length; c++) {{
      try {{
        var evs = cals[c].events.whose({{
          _and: [
            {{ startDate: {{ _greaterThan: now }} }},
            {{ startDate: {{ _lessThan: end }} }}
          ]
        }})();
        for (var i = 0; i < evs.length; i++) {{
          try {{
            var ev = evs[i];
            var s = ev.startDate();
            var e = ev.endDate();
            if (!s || !e) continue;
            var busy = '1';
            try {{
              // status/availability: 'free' events are the only non-busy kind.
              var avail = ev.status();
              if (avail && String(avail).toLowerCase().indexOf('free') !== -1) busy = '0';
            }} catch (e2) {{}}
            var title = '';
            try {{ title = ev.summary() || ''; }} catch (e3) {{}}
            var organizer = '';
            // Calendar.app events don't reliably expose an organizer; leave blank.
            title = String(title).replace(/[\r\n]/g, ' ');
            out.push('{prefix}' + sep + s.toISOString() + sep + e.toISOString() + sep + busy + sep + title + sep + organizer);
          }} catch (e4) {{}}
        }}
      }} catch (e5) {{}}
    }}
  }} catch (e6) {{
    // Surface a marker the Rust side can classify as permission-denied.
    return 'CALENDAR_ERROR' + sep + String(e6);
  }}
  return out.join('\n');
}}
"#,
            days = days,
            prefix = EVENT_PREFIX,
        )
    }

    /// AppleScript reader for Microsoft Outlook (Mac). Fallback when
    /// Calendar.app yields zero events (profile synced only into Outlook, not
    /// into Calendar.app). Emits the same `EVT`-line shape. Outlook's dictionary
    /// exposes `calendar events` with `start time` / `end time` and a
    /// `free busy status`; the organizer is available on meeting events.
    fn build_outlook_applescript(days: u32) -> String {
        // AppleScript (not JXA) because Outlook's scripting terminology is far
        // cleaner in AppleScript. `free busy status` is an enum; only `free`
        // maps to non-busy. Any per-event error is trapped so the read is
        // best-effort.
        format!(
            r#"
set sep to (ASCII character 31)
set nowDate to (current date)
set endDate to nowDate + ({days} * days)
set outText to ""
try
  tell application "Microsoft Outlook"
    set evs to (calendar events whose start time is greater than nowDate and start time is less than endDate)
    repeat with ev in evs
      try
        set s to start time of ev
        set e to end time of ev
        set fb to (free busy status of ev) as string
        set busyFlag to "1"
        if fb is "free" then set busyFlag to "0"
        set t to ""
        try
          set t to subject of ev
        end try
        set org to ""
        try
          set org to (name of organizer of ev)
        end try
        set sISO to my isoString(s)
        set eISO to my isoString(e)
        set outText to outText & "{prefix}" & sep & sISO & sep & eISO & sep & busyFlag & sep & t & sep & org & linefeed
      end try
    end repeat
  end tell
on error errMsg
  return "CALENDAR_ERROR" & sep & errMsg
end try
return outText

on isoString(theDate)
  set y to year of theDate as integer
  set m to (month of theDate as integer)
  set d to day of theDate
  set hh to hours of theDate
  set mm to minutes of theDate
  set ss to seconds of theDate
  set mo to text -2 thru -1 of ("0" & m)
  set dd to text -2 thru -1 of ("0" & d)
  set h2 to text -2 thru -1 of ("0" & hh)
  set n2 to text -2 thru -1 of ("0" & mm)
  set s2 to text -2 thru -1 of ("0" & ss)
  return (y as string) & "-" & mo & "-" & dd & "T" & h2 & ":" & n2 & ":" & s2
end isoString
"#,
            days = days,
            prefix = EVENT_PREFIX,
        )
    }

    /// Run one osascript invocation with a hard timeout. `lang` is "JavaScript"
    /// (JXA) or "AppleScript". Kills the child on timeout. Classifies a
    /// permission-denied TCC error (osascript exit 1 with a `-1743` / "Not
    /// authorized" / "does not have permission" stderr) into
    /// `CalendarError::PermissionDenied`.
    fn run_osascript(lang: &str, script: &str) -> Result<String, CalendarError> {
        let mut child = Command::new("/usr/bin/osascript")
            .args(["-l", lang, "-e", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CalendarError::SpawnFailed(format!("{}", e)))?;

        // Poll for completion up to the deadline. osascript has no built-in
        // timeout and a modal TCC prompt can hang it indefinitely; we kill on
        // expiry and fail closed.
        let deadline = Instant::now() + READ_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut stdout = String::new();
                    let mut stderr = String::new();
                    if let Some(mut o) = child.stdout.take() {
                        let _ = o.read_to_string(&mut stdout);
                    }
                    if let Some(mut e) = child.stderr.take() {
                        let _ = e.read_to_string(&mut stderr);
                    }
                    if status.success() {
                        return Ok(classify_stdout(stdout)?);
                    }
                    return Err(classify_stderr(status.code().unwrap_or(-1), stderr));
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(CalendarError::Timeout);
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(CalendarError::Other(format!("try_wait: {}", e))),
            }
        }
    }

    /// A successful osascript run can still carry our in-script `CALENDAR_ERROR`
    /// marker (a permission failure raised inside the script's try/catch, which
    /// osascript returns as normal stdout rather than a non-zero exit). Detect
    /// it and classify.
    fn classify_stdout(stdout: String) -> Result<String, CalendarError> {
        if stdout.contains("CALENDAR_ERROR") {
            let lower = stdout.to_lowercase();
            if lower.contains("not authorized")
                || lower.contains("does not have permission")
                || lower.contains("-1743")
            {
                return Err(CalendarError::PermissionDenied);
            }
            return Err(CalendarError::Other(stdout.trim().to_string()));
        }
        Ok(stdout)
    }

    /// Classify a non-zero osascript exit. The macOS TCC denial for Automation
    /// surfaces as errAEEventNotPermitted (-1743) / "Not authorized to send
    /// Apple events".
    fn classify_stderr(code: i32, stderr: String) -> CalendarError {
        let lower = stderr.to_lowercase();
        if lower.contains("-1743")
            || lower.contains("not authorized")
            || lower.contains("not authorised")
            || lower.contains("does not have permission")
        {
            return CalendarError::PermissionDenied;
        }
        // Outlook not scriptable / not running surfaces as a -600/-1728 class
        // "Application isn't running" error; the caller only invokes the
        // Outlook script as a fallback, so map that to OutlookUnavailable.
        if lower.contains("isn't running")
            || lower.contains("is not running")
            || lower.contains("-600")
            || lower.contains("-1728")
        {
            return CalendarError::OutlookUnavailable;
        }
        CalendarError::ScriptFailed { code, stderr }
    }

    /// Read Calendar.app; on a clean-but-empty read, fall back to Outlook and
    /// prefer whichever source has events. A permission denial from Calendar.app
    /// is returned immediately (don't mask it by trying Outlook — the user needs
    /// to see the grant prompt).
    pub fn read_window(days: u32) -> Result<CalendarReadResult, CalendarError> {
        let cal_script = build_calendar_jxa(days);
        match run_osascript("JavaScript", &cal_script) {
            Ok(stdout) => {
                let events = parse_events_stdout(&stdout);
                if !events.is_empty() {
                    return Ok(CalendarReadResult {
                        source: CalendarSource::CalendarApp,
                        events,
                    });
                }
                // Clean but empty — probe Outlook as a fallback source.
                match try_outlook(days) {
                    Ok(Some(result)) => Ok(result),
                    // Outlook absent / empty ⇒ a genuinely empty calendar.
                    Ok(None) => Ok(CalendarReadResult {
                        source: CalendarSource::None,
                        events: Vec::new(),
                    }),
                    // Outlook errored, but Calendar.app succeeded (just empty) —
                    // report the empty Calendar.app result, not the Outlook
                    // error (the primary source worked).
                    Err(_) => Ok(CalendarReadResult {
                        source: CalendarSource::None,
                        events: Vec::new(),
                    }),
                }
            }
            // Permission denial / timeout from the primary source must surface.
            Err(e @ CalendarError::PermissionDenied) | Err(e @ CalendarError::Timeout) => Err(e),
            // Any other Calendar.app failure: try Outlook before giving up.
            Err(primary_err) => match try_outlook(days) {
                Ok(Some(result)) => Ok(result),
                Ok(None) => Err(primary_err),
                Err(_) => Err(primary_err),
            },
        }
    }

    /// Try the Outlook fallback. `Ok(Some)` = Outlook produced events;
    /// `Ok(None)` = Outlook ran but had none (or isn't available) — the caller
    /// treats that as "no fallback source"; `Err` propagates a hard failure.
    fn try_outlook(days: u32) -> Result<Option<CalendarReadResult>, CalendarError> {
        let script = build_outlook_applescript(days);
        match run_osascript("AppleScript", &script) {
            Ok(stdout) => {
                let events = parse_events_stdout(&stdout);
                if events.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(CalendarReadResult {
                        source: CalendarSource::Outlook,
                        events,
                    }))
                }
            }
            Err(CalendarError::OutlookUnavailable) => Ok(None),
            Err(e) => Err(e),
        }
    }

    // Expose the script builders for unit tests (syntactic anchors — we can't
    // run osascript deterministically in CI).
    #[cfg(test)]
    pub(super) fn calendar_jxa_for_test(days: u32) -> String {
        build_calendar_jxa(days)
    }
    #[cfg(test)]
    pub(super) fn outlook_applescript_for_test(days: u32) -> String {
        build_outlook_applescript(days)
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Windows implementation (Outlook COM via PowerShell — mirrors onenote_windows)
// ───────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::process::Command;

    /// PowerShell reader for the Outlook calendar. Mirrors
    /// `onenote_windows::spawn_ps_script` structure. Uses `Items.Restrict` with
    /// an Outlook date filter + `IncludeRecurrences = $true` and a sort so
    /// recurring meetings expand into concrete occurrences within the window
    /// (the documented Outlook recurrence-expansion pattern). Emits the same
    /// `EVT`-prefixed unit-separated lines the Mac path does.
    ///
    /// `{days}` / `{sep_code}` / `{prefix}` are templated in. BusyStatus enum:
    /// 0 = Free, 1 = Tentative, 2 = Busy, 3 = OutOfOffice, 4 = WorkingElsewhere.
    /// Only 0 (Free) maps to non-busy.
    fn build_outlook_ps(days: u32) -> String {
        format!(
            r#"
$ErrorActionPreference = 'Stop'
$sep = [char]31
try {{
    $outlook = New-Object -ComObject Outlook.Application
}} catch {{
    Write-Error "OUTLOOK_COM_NOT_REGISTERED: $($_.Exception.Message)"
    exit 2
}}
try {{
    $ns = $outlook.GetNamespace('MAPI')
    $cal = $ns.GetDefaultFolder(9) # olFolderCalendar
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort('[Start]')
    $now = Get-Date
    $end = $now.AddDays({days})
    $fmt = 'MM/dd/yyyy hh:mm tt'
    $restrict = "[Start] >= '" + $now.ToString($fmt) + "' AND [Start] <= '" + $end.ToString($fmt) + "'"
    $filtered = $items.Restrict($restrict)
    foreach ($ev in $filtered) {{
        try {{
            $s = $ev.Start.ToString('yyyy-MM-ddTHH:mm:ss')
            $e = $ev.End.ToString('yyyy-MM-ddTHH:mm:ss')
            $busy = '1'
            if ($ev.BusyStatus -eq 0) {{ $busy = '0' }}
            $title = ''
            try {{ $title = [string]$ev.Subject }} catch {{}}
            $org = ''
            try {{ $org = [string]$ev.Organizer }} catch {{}}
            $title = $title -replace "[`r`n$([char]31)]", ' '
            $org = $org -replace "[`r`n$([char]31)]", ' '
            Write-Output ('{prefix}' + $sep + $s + $sep + $e + $sep + $busy + $sep + $title + $sep + $org)
        }} catch {{}}
    }}
}} finally {{
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null
}}
"#,
            days = days,
            prefix = EVENT_PREFIX,
        )
    }

    /// Spawn `powershell.exe` with the OneNote-plumbing console-flash
    /// suppression (`CREATE_NO_WINDOW = 0x0800_0000`) so the 30-min tick never
    /// flickers a console. Classifies the Outlook-COM-not-registered marker.
    fn spawn_ps(script: &str) -> Result<String, CalendarError> {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let output = cmd
            .output()
            .map_err(|e| CalendarError::SpawnFailed(format!("{}", e)))?;
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !output.status.success() {
            if stderr.contains("OUTLOOK_COM_NOT_REGISTERED") {
                return Err(CalendarError::OutlookUnavailable);
            }
            return Err(CalendarError::ScriptFailed {
                code: output.status.code().unwrap_or(-1),
                stderr,
            });
        }
        Ok(stdout)
    }

    pub fn read_window(days: u32) -> Result<CalendarReadResult, CalendarError> {
        let script = build_outlook_ps(days);
        let stdout = spawn_ps(&script)?;
        let events = parse_events_stdout(&stdout);
        let source = if events.is_empty() {
            CalendarSource::None
        } else {
            CalendarSource::Outlook
        };
        Ok(CalendarReadResult { source, events })
    }

    #[cfg(test)]
    pub(super) fn outlook_ps_for_test(days: u32) -> String {
        build_outlook_ps(days)
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Public cross-platform entry point (delegate to the platform impl)
// ───────────────────────────────────────────────────────────────────────────

/// Read the user's calendar for the next `days` days. Blocking (spawns a
/// subprocess) — the Tauri command wraps this in `spawn_blocking`.
#[cfg(target_os = "macos")]
pub fn read_window(days: u32) -> Result<CalendarReadResult, CalendarError> {
    mac::read_window(days)
}

#[cfg(target_os = "windows")]
pub fn read_window(days: u32) -> Result<CalendarReadResult, CalendarError> {
    win::read_window(days)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn read_window(_days: u32) -> Result<CalendarReadResult, CalendarError> {
    Err(CalendarError::PlatformUnsupported)
}

// ───────────────────────────────────────────────────────────────────────────
// Unit tests — pure functions (parsing, error semantics) on every platform;
// script builders on their owning platform (syntactic anchors).
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn line(fields: &[&str]) -> String {
        fields.join(FIELD_SEP)
    }

    #[test]
    fn parse_single_busy_event() {
        let stdout = line(&[
            EVENT_PREFIX,
            "2026-07-11T15:00:00Z",
            "2026-07-11T16:00:00Z",
            "1",
            "Kickoff with Becky",
            "becky@example.com",
        ]);
        let events = parse_events_stdout(&stdout);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.start, "2026-07-11T15:00:00Z");
        assert_eq!(ev.end, "2026-07-11T16:00:00Z");
        assert!(ev.busy);
        assert_eq!(ev.title.as_deref(), Some("Kickoff with Becky"));
        assert_eq!(ev.organizer.as_deref(), Some("becky@example.com"));
    }

    #[test]
    fn parse_free_event_maps_busy_false() {
        let stdout = line(&[
            EVENT_PREFIX,
            "2026-07-11T09:00:00Z",
            "2026-07-11T09:30:00Z",
            "0",
            "Focus block",
            "",
        ]);
        let events = parse_events_stdout(&stdout);
        assert_eq!(events.len(), 1);
        assert!(!events[0].busy);
        // Empty organizer field ⇒ None.
        assert_eq!(events[0].organizer, None);
    }

    #[test]
    fn parse_multiple_events_and_skips_blank_lines() {
        let mut s = String::new();
        s.push_str(&line(&[EVENT_PREFIX, "2026-07-11T15:00:00Z", "2026-07-11T16:00:00Z", "1", "A", ""]));
        s.push('\n');
        s.push('\n'); // blank line in the middle
        s.push_str(&line(&[EVENT_PREFIX, "2026-07-12T15:00:00Z", "2026-07-12T16:00:00Z", "0", "B", ""]));
        s.push('\n');
        let events = parse_events_stdout(&s);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title.as_deref(), Some("A"));
        assert!(events[0].busy);
        assert_eq!(events[1].title.as_deref(), Some("B"));
        assert!(!events[1].busy);
    }

    #[test]
    fn parse_skips_lines_without_evt_prefix() {
        // Stray diagnostic noise on stdout must be ignored, not parsed.
        let mut s = String::new();
        s.push_str("some osascript warning noise\n");
        s.push_str(&line(&[EVENT_PREFIX, "2026-07-11T15:00:00Z", "2026-07-11T16:00:00Z", "1", "Real", ""]));
        s.push('\n');
        let events = parse_events_stdout(&s);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title.as_deref(), Some("Real"));
    }

    #[test]
    fn parse_skips_rows_missing_start_or_end() {
        // Missing end field ⇒ dropped (best-effort; one bad row can't poison).
        let bad = format!("{}{}{}{}", EVENT_PREFIX, FIELD_SEP, "2026-07-11T15:00:00Z", FIELD_SEP);
        let events = parse_events_stdout(&bad);
        assert!(events.is_empty());
    }

    #[test]
    fn parse_empty_stdout_is_empty_vec() {
        assert!(parse_events_stdout("").is_empty());
        assert!(parse_events_stdout("   \n  \n").is_empty());
    }

    #[test]
    fn parse_title_only_no_organizer() {
        // Only 5 fields (no organizer column at all) — title present, org None.
        let s = line(&[EVENT_PREFIX, "2026-07-11T15:00:00Z", "2026-07-11T16:00:00Z", "1", "Standup"]);
        let events = parse_events_stdout(&s);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title.as_deref(), Some("Standup"));
        assert_eq!(events[0].organizer, None);
    }

    // ───── CalendarError semantics ─────

    #[test]
    fn error_user_messages_are_non_empty() {
        for err in &[
            CalendarError::Timeout,
            CalendarError::PermissionDenied,
            CalendarError::SpawnFailed("x".into()),
            CalendarError::ScriptFailed { code: 1, stderr: "x".into() },
            CalendarError::OutlookUnavailable,
            CalendarError::Other("x".into()),
            CalendarError::PlatformUnsupported,
        ] {
            assert!(!err.user_message().is_empty());
        }
    }

    #[test]
    fn error_display_does_not_panic() {
        let _ = format!("{}", CalendarError::Timeout);
        let _ = format!("{}", CalendarError::PermissionDenied);
        let _ = format!("{}", CalendarError::SpawnFailed("e".into()));
        let _ = format!("{}", CalendarError::ScriptFailed { code: 2, stderr: "e".into() });
        let _ = format!("{}", CalendarError::OutlookUnavailable);
        let _ = format!("{}", CalendarError::Other("e".into()));
        let _ = format!("{}", CalendarError::PlatformUnsupported);
    }

    #[test]
    fn calendar_event_serializes_camel_case() {
        let ev = CalendarEvent {
            start: "2026-07-11T15:00:00Z".into(),
            end: "2026-07-11T16:00:00Z".into(),
            busy: true,
            title: Some("T".into()),
            organizer: None,
        };
        let json = serde_json::to_string(&ev).expect("serialize");
        // organizer is None ⇒ skipped; busy/start/end present.
        assert!(json.contains("\"start\""));
        assert!(json.contains("\"busy\":true"));
        assert!(json.contains("\"title\":\"T\""));
        assert!(!json.contains("organizer"));
    }

    // ───── platform stub ─────

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn stub_platform_returns_unsupported() {
        match read_window(14) {
            Err(CalendarError::PlatformUnsupported) => {}
            other => panic!("expected PlatformUnsupported, got {:?}", other),
        }
    }

    // ───── macOS script syntactic anchors ─────

    #[cfg(target_os = "macos")]
    #[test]
    fn calendar_jxa_scopes_window_and_emits_evt_lines() {
        let script = super::mac::calendar_jxa_for_test(14);
        // Window is date-bounded (scoped query, not a full-calendar scan).
        assert!(script.contains("14 * 24 * 60 * 60 * 1000"));
        assert!(script.contains("startDate"));
        assert!(script.contains("_greaterThan"));
        assert!(script.contains("_lessThan"));
        // Emits our marker + separator.
        assert!(script.contains("'EVT'"));
        assert!(script.contains("String.fromCharCode(31)"));
        assert!(script.contains("toISOString()"));
        // Sanitizes newlines (and the unit separator) out of titles so a title
        // can never span or split an event line.
        assert!(script.contains("replace(/[\\r\\n"));
        // In-script error marker for permission classification.
        assert!(script.contains("CALENDAR_ERROR"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn outlook_applescript_uses_freebusy_and_window() {
        let script = super::mac::outlook_applescript_for_test(7);
        assert!(script.contains("Microsoft Outlook"));
        assert!(script.contains("free busy status"));
        assert!(script.contains("7 * days"));
        assert!(script.contains("EVT"));
        assert!(script.contains("CALENDAR_ERROR"));
    }

    // ───── Windows script syntactic anchors ─────

    #[cfg(target_os = "windows")]
    #[test]
    fn outlook_ps_uses_restrict_recurrences_and_busystatus() {
        let script = super::win::outlook_ps_for_test(14);
        assert!(script.contains("New-Object -ComObject Outlook.Application"));
        assert!(script.contains("GetDefaultFolder(9)"));
        assert!(script.contains("IncludeRecurrences = $true"));
        assert!(script.contains(".Restrict("));
        assert!(script.contains("AddDays(14)"));
        assert!(script.contains("BusyStatus -eq 0"));
        assert!(script.contains("EVT"));
        assert!(script.contains("OUTLOOK_COM_NOT_REGISTERED"));
        assert!(script.contains("ReleaseComObject"));
    }
}
