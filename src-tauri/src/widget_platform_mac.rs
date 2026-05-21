//! Mac platform shim for the Threshold floating widget (WP-Threshold-Compact-UX
//! Phase 2; D-CUX-04 partial fix; KNOWN LIMITATION on sourceApp).
//!
//! **What this module accomplishes:** Sets the NSApp activation policy to
//! `.accessory` at runtime (mirrors `LSUIElement=YES` from Phase 2B's
//! `Info.plist` override in dev mode), then sets the widget window's
//! `collectionBehavior` for cross-space presence + disables native
//! window-background drag so our JS click-vs-drag heuristic isn't fought
//! by AppKit's own drag implementation.
//!
//! **KNOWN LIMITATION — sourceApp still ships "" via the filter.**
//! Three approaches tried during Phase 2A to make widget clicks
//! non-activating; all failed:
//!
//!   v1 — NSWindowStyleMaskNonactivatingPanel (bit 7) on existing NSWindow.
//!        AppKit rejects: `NSWindow does not support nonactivating panel
//!        styleMask 0x80`. Panel-class-only flag.
//!
//!   v2 — Class-swap NSWindow → ThresholdPanel via objc2 `define_class!`
//!        with `canBecomeKeyWindow`/`canBecomeMainWindow` → NO. Panics at
//!        runtime: `old and new class sizes were not equal; this is UB!
//!        left: 464  right: 456`. `define_class!` generates a class
//!        smaller than NSWindow's actual Cocoa-internal layout; objc2's
//!        `set_class` safety check refuses size mismatches.
//!
//!   v3 (current) — `NSApplication.setActivationPolicy(.accessory)`.
//!        Empirically validated 2026-05-21: app launches cleanly, no
//!        panic, BUT `sourceApp` still ships `""` because `.accessory`
//!        only affects Dock / menu-bar / Cmd-Tab UI surfaces, not the
//!        NSWorkspace.frontmostApplication-on-click activation path.
//!
//! **Deferred follow-up (v0.3.1 or later):** the NSPanel-style shim
//! needs a focused workstream. Likely paths:
//!
//!   a) Raw FFI `object_setClass` + manual size assertion to bypass
//!      objc2's safety check; if NSWindow + raw-ClassBuilder subclass
//!      sizes actually match (the safety check may be more conservative
//!      than required), the swap works correctly.
//!   b) Fork or patch Tauri 2 to construct NSPanel directly instead of
//!      NSWindow for windows with a `panel: true` config flag.
//!   c) Method swizzling at the AppKit level — but global side effects.
//!
//! Until that lands, the Mac `is_threshold_own_bundle_id` filter (shipped
//! in PR #3 / commit 00ec1e7) continues to catch focus-steals and ship
//! `sourceApp: ""` rather than misleading data. Symmetric with the
//! Windows-side `is_threshold_own_exe` filter (PR #2 / commit e5cb31a).
//!
//! Called from `lib.rs::run`'s `.setup()` hook on the main thread.

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSApplication;

/// NSWindowCollectionBehavior flags for the always-on-top-across-spaces
/// posture (AC-CUX-02). Bit definitions pinned to AppKit headers:
///   - canJoinAllSpaces       = 1 << 0
///   - stationary             = 1 << 4
///   - fullScreenAuxiliary    = 1 << 8
const NS_COLLECTION_CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
const NS_COLLECTION_STATIONARY: u64 = 1 << 4;
const NS_COLLECTION_FULL_SCREEN_AUXILIARY: u64 = 1 << 8;

/// NSApplicationActivationPolicy::Accessory = 1.
/// Apple docs: "The application has a user interface but doesn't appear
/// in the Dock and doesn't have a menu bar, but it may be activated
/// programmatically or by clicking on one of its windows." Critically:
/// `.accessory` apps cannot become the active app via window click —
/// which is exactly the `sourceApp = ""` leak we're trying to close.
const NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY: i64 = 1;

/// Apply the non-activating + always-on-top-across-spaces posture.
/// Returns Ok(()) on success; Err on null pointer.
///
/// Two operations:
///   1. Set NSApp.activationPolicy = .accessory (process-wide; matches
///      LSUIElement=YES in dev mode where Info.plist doesn't apply).
///   2. Set the widget window's collectionBehavior for cross-space
///      presence + disable native window-background drag (our JS
///      heuristic owns drag).
///
/// # Safety
/// `ns_window` must be a valid Objective-C NSWindow pointer that
/// outlives this call. Tauri 2 guarantees this from the `.setup()` hook.
pub fn apply_non_activating_widget_style(ns_window: *mut std::ffi::c_void) -> Result<(), String> {
    if ns_window.is_null() {
        return Err("ns_window pointer is null".into());
    }

    // Step 1: NSApp activation policy → Accessory.
    // SAFETY: NSApplication.sharedApplication is process-global; setting
    // activationPolicy is a well-defined Cocoa operation that mirrors
    // Info.plist LSUIElement=YES behavior.
    unsafe {
        // Use raw msg_send rather than the high-level objc2-app-kit
        // method binding to avoid MainThreadMarker complexity — we're
        // already on the main thread (Tauri .setup() contract) and the
        // setActivationPolicy: selector itself doesn't require the marker.
        let app_class = objc2::class!(NSApplication);
        let app: *mut AnyObject = msg_send![app_class, sharedApplication];
        if !app.is_null() {
            let _: () = msg_send![
                app,
                setActivationPolicy: NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY
            ];
        }
    }

    // Step 2: widget window collectionBehavior + disable native drag.
    unsafe {
        let win = ns_window as *mut AnyObject;

        let current_behavior: u64 = msg_send![win, collectionBehavior];
        let new_behavior = current_behavior
            | NS_COLLECTION_CAN_JOIN_ALL_SPACES
            | NS_COLLECTION_STATIONARY
            | NS_COLLECTION_FULL_SCREEN_AUXILIARY;
        let _: () = msg_send![win, setCollectionBehavior: new_behavior];

        let _: () = msg_send![win, setMovableByWindowBackground: false];
    }

    // Reference NSApplication so the import isn't dead-code-eliminated
    // (the type binding is what brings the class into the objc runtime
    // namespace; if we ever do switch to the high-level binding the
    // import is already in place).
    let _: std::marker::PhantomData<NSApplication> = std::marker::PhantomData;

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

    /// Sanity-check the magic-number constants pinned against AppKit
    /// headers. Drift gate for accidental edits.
    #[test]
    fn appkit_constants_pin() {
        assert_eq!(NS_COLLECTION_CAN_JOIN_ALL_SPACES, 1);
        assert_eq!(NS_COLLECTION_STATIONARY, 16);
        assert_eq!(NS_COLLECTION_FULL_SCREEN_AUXILIARY, 256);
        assert_eq!(NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY, 1);
    }
}
