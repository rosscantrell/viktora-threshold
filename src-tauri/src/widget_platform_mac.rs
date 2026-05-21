//! Mac platform shim for the Threshold floating widget (WP-Threshold-Compact-UX
//! Phase 2; D-CUX-04 root fix).
//!
//! Empirical finding from Phase 1 S-CUX-03: Tauri 2's high-level window
//! config (`decorations: false` + `alwaysOnTop: true` + `transparent: true`
//! + `focus: false`) does NOT prevent the widget from stealing focus on
//! click. When the user clicks the Capture button, NSWindow briefly
//! becomes key + main, NSApp activates Threshold, and
//! `NSWorkspace.frontmostApplication.bundleIdentifier` returns
//! `"ai.viktora.threshold"`. The Mac filter in `ocr_mac::is_threshold_own_bundle_id`
//! catches this (PR #3) and ships `""` rather than misleading data — but
//! `sourceApp` shipping empty defeats the cross-surface analytics premise.
//!
//! This module is the architectural fix. After Tauri creates the widget's
//! NSWindow, we:
//!
//!   1. Set the `NSWindowStyleMaskNonactivatingPanel` bit (bit 7) on the
//!      window's styleMask. Documented as panel-only, but NSWindow respects
//!      it in practice when combined with `.borderless` (already set via
//!      `decorations: false`). Prevents the window from becoming key on
//!      click → prevents NSApp from activating Threshold.
//!
//!   2. Set the collectionBehavior to include `.canJoinAllSpaces` +
//!      `.stationary` + `.fullScreenAuxiliary` so the widget travels across
//!      spaces with the user (AC-CUX-02 "always-on-top across spaces").
//!
//! After the shim fires, `NSWorkspace.frontmostApplication` keeps returning
//! the user's actual target app at capture time. The Mac filter still ships
//! as defense-in-depth for any edge case the shim doesn't catch (e.g.,
//! brief transition windows during first-launch wizard → widget collapse).
//!
//! Called from `lib.rs::run`'s `.setup()` hook, after the main window is
//! created but before any user interaction.

use objc2::msg_send;
use objc2::runtime::AnyObject;

/// NSWindowStyleMaskNonactivatingPanel = 1 << 7.
/// AppKit documents this as panel-only, but NSWindow respects it for
/// non-activation in practice. Constant value pinned to the AppKit header
/// definition so future objc2-app-kit version bumps don't drift the
/// magic-number.
const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;

/// NSWindowCollectionBehavior flags for the always-on-top-across-spaces
/// posture. Bit definitions from AppKit headers:
///   - canJoinAllSpaces       = 1 << 0
///   - stationary             = 1 << 4
///   - fullScreenAuxiliary    = 1 << 8
const NS_COLLECTION_CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
const NS_COLLECTION_STATIONARY: u64 = 1 << 4;
const NS_COLLECTION_FULL_SCREEN_AUXILIARY: u64 = 1 << 8;

/// Apply the non-activating + always-on-top-across-spaces posture to a
/// Tauri-created NSWindow. The window pointer is whatever
/// `tauri::Window::ns_window()` returns (a raw `*mut c_void` we treat as
/// an Objective-C object).
///
/// Returns Ok(()) on success. Returns Err(message) if the pointer is
/// null. Does NOT panic — the worst case (shim no-ops) is that we fall
/// back to the Mac filter catching the focus-steal at capture time and
/// shipping `sourceApp: ""`. That's degraded but not broken.
///
/// # Safety
/// `ns_window` must be a valid Objective-C NSWindow object pointer that
/// outlives this call. Tauri 2 guarantees this when called from the
/// `.setup()` hook on a window that's already constructed.
pub fn apply_non_activating_widget_style(ns_window: *mut std::ffi::c_void) -> Result<(), String> {
    if ns_window.is_null() {
        return Err("ns_window pointer is null".into());
    }

    // SAFETY: caller guarantees `ns_window` is a valid NSWindow pointer.
    // All msg_send! calls below operate on well-known AppKit selectors
    // (`styleMask` / `setStyleMask:` / `collectionBehavior` /
    // `setCollectionBehavior:`) that exist on NSWindow since Mac OS X 10.5.
    unsafe {
        let win = ns_window as *mut AnyObject;

        // Add nonactivating-panel bit to styleMask. Preserves any other
        // bits Tauri already set (e.g., borderless from decorations:false).
        let current_style: u64 = msg_send![win, styleMask];
        let new_style = current_style | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL;
        let _: () = msg_send![win, setStyleMask: new_style];

        // Collection behavior: stationary + travels-with-user + tolerates
        // full-screen-app transitions. AC-CUX-02.
        let current_behavior: u64 = msg_send![win, collectionBehavior];
        let new_behavior = current_behavior
            | NS_COLLECTION_CAN_JOIN_ALL_SPACES
            | NS_COLLECTION_STATIONARY
            | NS_COLLECTION_FULL_SCREEN_AUXILIARY;
        let _: () = msg_send![win, setCollectionBehavior: new_behavior];

        // setMovableByWindowBackground: NO — our JS click-vs-drag heuristic
        // owns dragging; let it not fight a native AppKit drag too.
        let _: () = msg_send![win, setMovableByWindowBackground: false];
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure null-pointer-rejection test. Real shim behavior requires a live
    /// NSWindow which isn't available in `cargo test --lib`.
    #[test]
    fn apply_non_activating_widget_style_rejects_null() {
        let result = apply_non_activating_widget_style(std::ptr::null_mut());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("null"));
    }

    /// Sanity-check the magic-number constants didn't drift. AppKit's
    /// NSWindowStyleMaskNonactivatingPanel = 128. Pinned here so any
    /// accidental edit to the constant gets caught by the test suite.
    #[test]
    fn nspanel_constants_pin_appkit_values() {
        assert_eq!(NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL, 128);
        assert_eq!(NS_COLLECTION_CAN_JOIN_ALL_SPACES, 1);
        assert_eq!(NS_COLLECTION_STATIONARY, 16);
        assert_eq!(NS_COLLECTION_FULL_SCREEN_AUXILIARY, 256);
    }
}
