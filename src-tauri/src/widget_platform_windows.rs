//! Windows platform shim for the Threshold floating widget
//! (WP-Threshold-Compact-UX Phase 3; D-CUX-04 Windows-side fix).
//!
//! Mirrors `widget_platform_mac.rs` in shape + intent: keep the widget
//! from stealing focus on click so `GetForegroundWindow` continues to
//! return the user's actual target app at capture time, and `sourceApp`
//! ships the real bundle-EXE rather than `""` (which the Windows
//! `is_threshold_own_exe` filter from PR #2 commit e5cb31a would catch).
//!
//! **Why Windows likely succeeds where Mac failed:** Mac's
//! `NSWindowStyleMaskNonactivatingPanel` is genuinely panel-class-only;
//! AppKit rejects it on a plain NSWindow. Windows' `WS_EX_NOACTIVATE` is
//! a regular HWND extended-window style that Win32 honors on any
//! top-level window — including Tauri-created ones. Per MSDN:
//!
//! > A top-level window created with this style does not become the
//! > foreground window when the user clicks it. The system does not
//! > bring this window to the foreground when the user minimizes or
//! > closes the foreground window.
//!
//! That's exactly the contract we need.
//!
//! Applies the style via `SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
//! current | WS_EX_NOACTIVATE)` at .setup() time, after Tauri creates
//! the window but before any user interaction.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
};

/// Apply the non-activating extended-window style to a Tauri-created
/// widget HWND. The Tauri config already sets `skipTaskbar: true` which
/// adds WS_EX_TOOLWINDOW; this layer adds the activation-prevention bit.
///
/// Returns Ok(()) on success. Returns Err on null HWND. Does NOT panic
/// — the worst case (shim no-ops) is that we fall back to the Windows
/// `is_threshold_own_exe` filter catching focus-steals at capture time
/// and shipping `sourceApp: ""`. Degraded but not broken.
///
/// # Safety
/// `hwnd` must be a valid HWND that outlives this call. Tauri 2
/// guarantees this when called from the `.setup()` hook on the
/// already-constructed widget window.
pub fn apply_non_activating_widget_style(hwnd: HWND) -> Result<(), String> {
    if hwnd.0.is_null() {
        return Err("widget HWND is null".into());
    }

    // SAFETY: caller guarantees `hwnd` is a valid top-level window
    // handle. `GetWindowLongPtrW` + `SetWindowLongPtrW` with `GWL_EXSTYLE`
    // are well-defined Win32 operations since Windows 2000; the value
    // we OR in (`WS_EX_NOACTIVATE`) is a documented bit, not a
    // class-restricted flag like Mac's NonactivatingPanel.
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_style = current | (WS_EX_NOACTIVATE.0 as isize);
        // SetWindowLongPtrW returns the previous value (0 on first call
        // for this index) or an error code; we don't need to distinguish
        // since we own the previous value via the prior Get call.
        let _previous = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Null-HWND rejection. Real shim behavior requires a live HWND
    /// which isn't available in `cargo test --lib`; runtime validation
    /// happens via Ross's wife's Win11 smoke (S-CUX-04 empirical).
    #[test]
    fn apply_non_activating_widget_style_rejects_null() {
        let hwnd = HWND(std::ptr::null_mut());
        let result = apply_non_activating_widget_style(hwnd);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("null"));
    }

    /// Pin the WS_EX_NOACTIVATE constant value against the documented
    /// MSDN bit (0x08000000). Drift gate for accidental edits / windows
    /// crate version bumps.
    #[test]
    fn ws_ex_noactivate_pins_msdn_value() {
        assert_eq!(WS_EX_NOACTIVATE.0, 0x0800_0000);
    }
}
