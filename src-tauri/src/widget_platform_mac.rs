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

/// NSApplicationActivationPolicy::Regular = 0. The normal app posture:
/// appears in the Dock, owns a menu bar, participates in Cmd-Tab and
/// Mission Control. This is the WORKSPACE persona — the opposite of the
/// widget's `.accessory` panel posture.
const NS_APPLICATION_ACTIVATION_POLICY_REGULAR: i64 = 0;

/// NSWindowCollectionBehavior::Managed = 1 << 1. The window participates
/// in Spaces + Exposé/Mission Control as a first-class window, as opposed
/// to the `canJoinAllSpaces | stationary` overlay-panel posture.
const NS_COLLECTION_MANAGED: u64 = 1 << 1;

/// NSWindowCollectionBehavior::FullScreenPrimary = 1 << 7. The window can
/// enter its OWN native full-screen Space (green-button / ⌃⌘F path).
/// Mutually exclusive with `fullScreenAuxiliary` (1 << 8), which only lets
/// a window ride along on another window's full-screen Space — the
/// widget-panel posture. Toggling primary↔auxiliary is the full-screen
/// half of the persona switch.
const NS_COLLECTION_FULL_SCREEN_PRIMARY: u64 = 1 << 7;

/// The panel-persona collectionBehavior bits (widget mode): joins all
/// Spaces, stays stationary, rides other windows' full-screen. Cleared
/// when switching to the workspace persona.
const PANEL_BEHAVIOR_BITS: u64 =
    NS_COLLECTION_CAN_JOIN_ALL_SPACES | NS_COLLECTION_STATIONARY | NS_COLLECTION_FULL_SCREEN_AUXILIARY;

/// Set the process-wide NSApp activation policy. `.setup()` and the
/// expand/collapse commands all run on the main thread (Tauri contract),
/// so the selector is safe to send without a MainThreadMarker.
///
/// # Safety
/// Must be called on the main thread.
unsafe fn set_activation_policy(policy: i64) {
    let app_class = objc2::class!(NSApplication);
    let app: *mut AnyObject = msg_send![app_class, sharedApplication];
    if !app.is_null() {
        let _: () = msg_send![app, setActivationPolicy: policy];
    }
}

/// Switch the app + its window to the WORKSPACE persona: a first-class,
/// Dock-visible, Cmd-Tab-able, natively-full-screenable window. Called on
/// EXPAND. Inverse of [`apply_non_activating_widget_style`].
///
/// Two operations:
///   1. NSApp.activationPolicy = .regular — restores the Dock icon, menu
///      bar, Cmd-Tab and Mission Control participation the `.accessory`
///      widget posture suppressed.
///   2. window.collectionBehavior — clear the panel bits (canJoinAllSpaces
///      / stationary / fullScreenAuxiliary), set `managed | fullScreenPrimary`
///      so the window lives on one Space and owns the green-button / ⌃⌘F
///      native full-screen. Native drag stays disabled (the workspace uses
///      the standard titlebar for moves, and the JS click-vs-drag heuristic
///      is a widget-only concern — but re-enabling background drag here is a
///      no-op for the titlebar path, so we leave it off for symmetry).
///
/// # Safety
/// `ns_window` must be a valid NSWindow pointer; call on the main thread.
pub fn apply_workspace_window_style(ns_window: *mut std::ffi::c_void) -> Result<(), String> {
    if ns_window.is_null() {
        return Err("ns_window pointer is null".into());
    }
    unsafe {
        set_activation_policy(NS_APPLICATION_ACTIVATION_POLICY_REGULAR);

        let win = ns_window as *mut AnyObject;
        let current_behavior: u64 = msg_send![win, collectionBehavior];
        let new_behavior =
            (current_behavior & !PANEL_BEHAVIOR_BITS) | NS_COLLECTION_MANAGED | NS_COLLECTION_FULL_SCREEN_PRIMARY;
        let _: () = msg_send![win, setCollectionBehavior: new_behavior];
    }
    Ok(())
}

/// Restore the WIDGET (panel) persona: `.accessory` app + across-Spaces
/// overlay window that cannot own native full-screen. Called on COLLAPSE.
/// Symmetric to [`apply_workspace_window_style`]; delegates to
/// [`apply_non_activating_widget_style`] so the panel posture is defined in
/// exactly one place (also re-disables native background drag).
///
/// # Safety
/// `ns_window` must be a valid NSWindow pointer; call on the main thread.
pub fn restore_widget_window_style(ns_window: *mut std::ffi::c_void) -> Result<(), String> {
    if ns_window.is_null() {
        return Err("ns_window pointer is null".into());
    }
    unsafe {
        let win = ns_window as *mut AnyObject;
        // Clear the workspace bits first so the OR in the widget-style path
        // lands on a clean base (managed/fullScreenPrimary must not linger).
        let current_behavior: u64 = msg_send![win, collectionBehavior];
        let cleared = current_behavior & !(NS_COLLECTION_MANAGED | NS_COLLECTION_FULL_SCREEN_PRIMARY);
        let _: () = msg_send![win, setCollectionBehavior: cleared];
    }
    // Re-apply the full panel posture (activation policy → accessory,
    // collectionBehavior → panel bits, native drag off).
    apply_non_activating_widget_style(ns_window)
}

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
    // Info.plist LSUIElement=YES behavior. We're on the main thread (Tauri
    // .setup() / IPC-command contract) so the selector is marker-free.
    unsafe {
        set_activation_policy(NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY);
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

    /// Both persona-switch entry points reject a null NSWindow the same way.
    #[test]
    fn persona_switch_rejects_null() {
        assert!(apply_workspace_window_style(std::ptr::null_mut())
            .unwrap_err()
            .contains("null"));
        assert!(restore_widget_window_style(std::ptr::null_mut())
            .unwrap_err()
            .contains("null"));
    }

    /// Sanity-check the magic-number constants pinned against AppKit
    /// headers. Drift gate for accidental edits.
    #[test]
    fn appkit_constants_pin() {
        assert_eq!(NS_COLLECTION_CAN_JOIN_ALL_SPACES, 1);
        assert_eq!(NS_COLLECTION_STATIONARY, 16);
        assert_eq!(NS_COLLECTION_FULL_SCREEN_AUXILIARY, 256);
        assert_eq!(NS_APPLICATION_ACTIVATION_POLICY_ACCESSORY, 1);
        // Workspace-persona additions (WP-WINDOW).
        assert_eq!(NS_APPLICATION_ACTIVATION_POLICY_REGULAR, 0);
        assert_eq!(NS_COLLECTION_MANAGED, 2);
        assert_eq!(NS_COLLECTION_FULL_SCREEN_PRIMARY, 128);
        // Panel bits = the three overlay flags OR'd together.
        assert_eq!(PANEL_BEHAVIOR_BITS, 1 | 16 | 256);
    }
}
