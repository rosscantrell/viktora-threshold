//! Mac platform shim for the Threshold floating widget (WP-Threshold-Compact-UX
//! Phase 2; D-CUX-04 root fix).
//!
//! Empirical finding from Phase 1 S-CUX-03 + Phase 2A first attempt:
//!
//!   - Tauri 2's high-level window config (`decorations: false` + `alwaysOnTop`
//!     + `transparent: true` + `focus: false`) does NOT prevent the widget
//!     from stealing focus on click.
//!   - The first 2A attempt set NSWindowStyleMaskNonactivatingPanel (bit 7,
//!     0x80) on the styleMask, but AppKit logs a clear error and ignores
//!     it: `NSWindow does not support nonactivating panel styleMask 0x80`.
//!     That bit is genuinely panel-class-only.
//!   - sourceApp shipped `""` (filter caught Threshold's bundle ID) instead
//!     of the user's target app — exactly the leak the WP exists to fix.
//!
//! **Canonical fix (this module):** declare a custom `ThresholdPanel`
//! ObjC subclass of NSWindow via objc2's `define_class!` macro, with
//! `canBecomeKeyWindow` + `canBecomeMainWindow` overridden to return NO,
//! then class-swap Tauri's NSWindow to it via `AnyObject::set_class`.
//! This is how NSPanel itself prevents key-window activation — we just
//! borrow the same pattern.
//!
//! After the class swap, clicking the widget no longer makes Threshold's
//! window key/main → NSApp doesn't activate Threshold →
//! `NSWorkspace.frontmostApplication` keeps returning the user's actual
//! target app → `sourceApp` ships the correct bundle ID.
//!
//! Called from `lib.rs::run`'s `.setup()` hook, after the widget window is
//! created.

use objc2::define_class;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, ClassType};
use objc2_app_kit::NSWindow;

/// NSWindowCollectionBehavior flags for the always-on-top-across-spaces
/// posture (AC-CUX-02). Bit definitions pinned to AppKit headers:
///   - canJoinAllSpaces       = 1 << 0
///   - stationary             = 1 << 4
///   - fullScreenAuxiliary    = 1 << 8
const NS_COLLECTION_CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
const NS_COLLECTION_STATIONARY: u64 = 1 << 4;
const NS_COLLECTION_FULL_SCREEN_AUXILIARY: u64 = 1 << 8;

define_class!(
    /// NSWindow subclass overriding `canBecomeKeyWindow` and
    /// `canBecomeMainWindow` to return NO. AppKit calls these to decide
    /// whether a window can become key (receive keyboard) / main (receive
    /// menu commands). Returning NO from both gives us the non-activating
    /// panel posture without using the NSPanel class hierarchy directly
    /// (Tauri 2 creates NSWindow instances; we can't change that, but we
    /// can swap their class to ours after creation).
    #[unsafe(super(NSWindow))]
    #[name = "ThresholdPanel"]
    struct ThresholdPanel;

    impl ThresholdPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> Bool {
            Bool::NO
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> Bool {
            Bool::NO
        }
    }
);

/// Apply the non-activating + always-on-top-across-spaces posture to a
/// Tauri-created NSWindow.
///
/// Returns Ok(()) on success. Returns Err(message) if the pointer is
/// null. Class registration happens at first call via `ThresholdPanel::class()`
/// (objc2's `define_class!` machinery handles lazy registration internally).
///
/// # Safety
/// `ns_window` must be a valid Objective-C NSWindow object pointer that
/// outlives this call. Tauri 2 guarantees this when called from the
/// `.setup()` hook on a window that's already constructed.
pub fn apply_non_activating_widget_style(ns_window: *mut std::ffi::c_void) -> Result<(), String> {
    if ns_window.is_null() {
        return Err("ns_window pointer is null".into());
    }

    // Wrap the entire shim in catch_unwind so any Rust-side panic
    // (class registration assertion, set_class invariant check, msg_send
    // panic) degrades gracefully to "filter catches the focus-leak at
    // capture time" instead of bringing down the whole app process.
    //
    // The objc2 0.6 + AppKit interaction surface is somewhat fragile;
    // we'd rather ship sourceApp = "" via the filter than crash on launch.
    let result = std::panic::catch_unwind(|| {
        let cls: &AnyClass = ThresholdPanel::class();

        // SAFETY: caller guarantees `ns_window` is a valid NSWindow object
        // pointer. AnyObject::set_class is the canonical class-swap
        // operation (wraps libobjc's `object_setClass`); after the call,
        // `ns_window` is a ThresholdPanel instance and its
        // `canBecomeKeyWindow` + `canBecomeMainWindow` selectors return NO.
        unsafe {
            let win = ns_window as *mut AnyObject;
            let _old: &AnyClass = AnyObject::set_class(&*win, cls);

            // Collection behavior: stationary + travels-with-user + tolerates
            // full-screen-app transitions (AC-CUX-02).
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
    });

    match result {
        Ok(()) => Ok(()),
        Err(panic) => {
            let msg = if let Some(s) = panic.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = panic.downcast_ref::<&'static str>() {
                s.to_string()
            } else {
                "non-string panic payload".to_string()
            };
            Err(format!("class-swap panicked (recovered): {msg}"))
        }
    }
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

    /// Sanity-check the collection-behavior magic-number constants pinned
    /// against AppKit's NSWindowCollectionBehavior bit definitions.
    #[test]
    fn collection_behavior_constants_pin_appkit_values() {
        assert_eq!(NS_COLLECTION_CAN_JOIN_ALL_SPACES, 1);
        assert_eq!(NS_COLLECTION_STATIONARY, 16);
        assert_eq!(NS_COLLECTION_FULL_SCREEN_AUXILIARY, 256);
    }
}
