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

        // A policy change on a RUNNING app does not activate it by itself —
        // without an explicit activate, the app stays behind and window clicks
        // de-focus it (the exact .accessory symptom). Kick activation + key.
        let app = NSApplication::sharedApplication(objc2::MainThreadMarker::new().ok_or("not on main thread")?);
        let applied: i64 = msg_send![&*app, activationPolicy];
        eprintln!("[persona] activationPolicy now = {applied} (0=regular, 1=accessory)");
        let _: () = msg_send![&*app, activateIgnoringOtherApps: true];
        let _: () = msg_send![win, makeKeyAndOrderFront: std::ptr::null::<AnyObject>()];
        let key: bool = msg_send![win, isKeyWindow];
        eprintln!("[persona] window isKeyWindow = {key}");
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


/// UTF8 description of any ObjC object (autoreleased; copy out immediately).
/// Dev-diagnostic helper for the probes below.
unsafe fn objc_description(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return "nil".into();
    }
    let desc: *mut AnyObject = msg_send![obj, description];
    if desc.is_null() {
        return "nil-desc".into();
    }
    let utf8: *const std::os::raw::c_char = msg_send![desc, UTF8String];
    if utf8.is_null() {
        return "nil-utf8".into();
    }
    std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
}

/// Deep chrome probe — the layers the NSWindow-level probe can't see.
/// The grey-halo evidence pattern is "window values clean, halo anyway",
/// which means the paint lives either in ANOTHER window or in the webview
/// background stack. This prints both:
///   1. every NSWindow in the app (class, frame, visible, alpha, opaque,
///      hasShadow) — catches a second-window carcass;
///   2. the WKWebView found under the probed window's contentView:
///      drawsBackground (KVC), underPageBackgroundColor, view isOpaque, and
///      the backing CALayer backgroundColor — catches a webview-layer paint
///      behind the transparent page.
/// Reads, never writes. Call on the main thread.
pub fn debug_window_deep(ns_window: *mut std::ffi::c_void, tag: &str) {
    unsafe {
        // ── 1. All windows ──
        let app_class = objc2::class!(NSApplication);
        let app: *mut AnyObject = msg_send![app_class, sharedApplication];
        if !app.is_null() {
            let windows: *mut AnyObject = msg_send![app, windows];
            let count: usize = if windows.is_null() { 0 } else { msg_send![windows, count] };
            eprintln!("[chrome-deep:{tag}] app window count = {count}");
            for i in 0..count {
                let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                if w.is_null() {
                    continue;
                }
                let cls = (*w).class().name();
                let frame: objc2_foundation::NSRect = msg_send![w, frame];
                let visible: bool = msg_send![w, isVisible];
                let alpha: f64 = msg_send![w, alphaValue];
                let opaque: bool = msg_send![w, isOpaque];
                let shadow: bool = msg_send![w, hasShadow];
                let is_probed = std::ptr::eq(w as *const _, ns_window as *const _);
                eprintln!(
                    "[chrome-deep:{tag}]   win[{i}]{} class={cls:?} frame=({:.0},{:.0} {:.0}x{:.0}) visible={visible} alpha={alpha:.2} opaque={opaque} hasShadow={shadow}",
                    if is_probed { "*" } else { "" },
                    frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
                );
            }
        }

        // ── 2. The webview background stack under the probed window ──
        if ns_window.is_null() {
            eprintln!("[chrome-deep:{tag}] ns_window NULL — skipping webview walk");
            return;
        }
        let win = ns_window as *mut AnyObject;
        let content: *mut AnyObject = msg_send![win, contentView];
        if content.is_null() {
            eprintln!("[chrome-deep:{tag}] contentView NULL");
            return;
        }
        // contentView's own layer background first.
        let c_layer: *mut AnyObject = msg_send![content, layer];
        if !c_layer.is_null() {
            let cg: *mut AnyObject = msg_send![c_layer, backgroundColor];
            let desc = if cg.is_null() {
                "nil".into()
            } else {
                let ns: *mut AnyObject =
                    msg_send![objc2::class!(NSColor), colorWithCGColor: cg as *mut std::ffi::c_void];
                objc_description(ns)
            };
            let c_opaque: bool = msg_send![c_layer, isOpaque];
            eprintln!("[chrome-deep:{tag}] contentView.layer bg={desc} layerOpaque={c_opaque}");
        } else {
            eprintln!("[chrome-deep:{tag}] contentView has no layer");
        }
        // Breadth-first walk for the WKWebView.
        let mut queue: Vec<*mut AnyObject> = vec![content];
        let mut found = false;
        while let Some(view) = queue.pop() {
            let cls = (*view).class().name();
            // wry subclasses WKWebView as "WryWebView" — match the suffix, not
            // the WK name (live trace 2026-07-06: the WK needle found nothing).
            // Do NOT stop at the first hit: WebKit nests several *WebView*-named
            // views and the first match was an inner one (both property reads
            // came back n/a while the halo was on screen) — print them ALL,
            // with class names, so the trace identifies the real WKWebView.
            if cls.to_string_lossy().contains("WebView") {
                found = true;
                let cls_name = cls.to_string_lossy().into_owned();
                let v_opaque: bool = msg_send![view, isOpaque];
                let v_frame: objc2_foundation::NSRect = msg_send![view, frame];
                // drawsBackground is a private WKWebView property. NEVER read it
                // via KVC — valueForKey: on an unexposed key raises
                // NSUnknownKeyException, which objc2 turns into an abort (this
                // exact crash took the app down on 2026-07-06 the moment the
                // walk first reached the WryWebView). respondsToSelector-guard a
                // direct read of the private getter instead; "n/a" when absent.
                let draws_bg_val: String = {
                    let responds_private: bool =
                        msg_send![view, respondsToSelector: objc2::sel!(_drawsBackground)];
                    let responds_public: bool =
                        msg_send![view, respondsToSelector: objc2::sel!(drawsBackground)];
                    if responds_private {
                        let b: bool = msg_send![view, _drawsBackground];
                        format!("{b}")
                    } else if responds_public {
                        let b: bool = msg_send![view, drawsBackground];
                        format!("{b}")
                    } else {
                        "n/a".into()
                    }
                };
                // underPageBackgroundColor (macOS 12+): grey in dark mode by
                // default; a live suspect for the halo. Guarded the same way.
                let upbc_desc = {
                    let responds: bool = msg_send![
                        view,
                        respondsToSelector: objc2::sel!(underPageBackgroundColor)
                    ];
                    if responds {
                        let upbc: *mut AnyObject = msg_send![view, underPageBackgroundColor];
                        objc_description(upbc)
                    } else {
                        "n/a".into()
                    }
                };
                let v_layer: *mut AnyObject = msg_send![view, layer];
                let layer_desc = if v_layer.is_null() {
                    "no-layer".into()
                } else {
                    let cg: *mut AnyObject = msg_send![v_layer, backgroundColor];
                    if cg.is_null() {
                        "nil".into()
                    } else {
                        let ns: *mut AnyObject = msg_send![
                            objc2::class!(NSColor),
                            colorWithCGColor: cg as *mut std::ffi::c_void
                        ];
                        objc_description(ns)
                    }
                };
                eprintln!(
                    "[chrome-deep:{tag}] webview[{cls_name}] frame=({:.0},{:.0} {:.0}x{:.0}) viewOpaque={v_opaque} drawsBackground={draws_bg_val} underPageBackgroundColor={upbc_desc} layer.bg={layer_desc}",
                    v_frame.origin.x, v_frame.origin.y, v_frame.size.width, v_frame.size.height,
                );
            }
            let subviews: *mut AnyObject = msg_send![view, subviews];
            let n: usize = if subviews.is_null() { 0 } else { msg_send![subviews, count] };
            for i in 0..n {
                let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                if !sv.is_null() {
                    queue.push(sv);
                }
            }
        }
        if !found {
            eprintln!("[chrome-deep:{tag}] no WKWebView found under contentView");
        }
    }
}

/// THE HALO FIX (bug 1) — clear the WKWebView's underPageBackgroundColor.
///
/// Evidence chain (2026-07-07): the halo is a full-window-rect grey wash,
/// visible over light desktop content, while EVERY probed layer is clean
/// (window bgAlpha=0, hasShadow=false, contentView + webview layers nil,
/// page paints transparent in a plain browser). The one unprobed layer was
/// WKWebView's `underPageBackgroundColor`, whose macOS dark-mode DEFAULT is
/// exactly a grey wash painted under transparent page content — invisible
/// over dark wallpapers, a grey rectangle over light ones (matches every
/// sighting, including the intermittency).
///
/// Walks the contentView tree and sets underPageBackgroundColor = clearColor
/// on every view that responds (respondsToSelector-guarded — probes must
/// never crash the app; the KVC abort of 2026-07-06 is the cautionary tale).
/// Idempotent; call on the main thread at boot and after collapse.
pub fn clear_webview_underpage(ns_window: *mut std::ffi::c_void, tag: &str) {
    if ns_window.is_null() {
        return;
    }
    unsafe {
        let win = ns_window as *mut AnyObject;
        let content: *mut AnyObject = msg_send![win, contentView];
        if content.is_null() {
            return;
        }
        let clear: *mut AnyObject = msg_send![objc2::class!(NSColor), clearColor];
        let mut queue: Vec<*mut AnyObject> = vec![content];
        let mut cleared = 0usize;
        while let Some(view) = queue.pop() {
            let responds: bool = msg_send![
                view,
                respondsToSelector: objc2::sel!(setUnderPageBackgroundColor:)
            ];
            if responds {
                let _: () = msg_send![view, setUnderPageBackgroundColor: clear];
                cleared += 1;
            }
            let subviews: *mut AnyObject = msg_send![view, subviews];
            let n: usize = if subviews.is_null() { 0 } else { msg_send![subviews, count] };
            for i in 0..n {
                let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                if !sv.is_null() {
                    queue.push(sv);
                }
            }
        }
        eprintln!("[halo-fix:{tag}] underPageBackgroundColor → clear on {cleared} view(s)");
    }
}

/// FULL view-tree dump (probe v4) — every subview, not just *WebView* ones.
/// The halo persists with every previously-probed layer clean; if ANY view in
/// the window paints grey, this prints it: class, frame, alpha, hidden,
/// wantsLayer, layer background + opacity. Depth- and count-capped. Reads only.
pub fn debug_view_tree(ns_window: *mut std::ffi::c_void, tag: &str) {
    if ns_window.is_null() {
        return;
    }
    unsafe {
        let win = ns_window as *mut AnyObject;
        // Window-level color description — alpha alone can hide colorspace surprises.
        let bg: *mut AnyObject = msg_send![win, backgroundColor];
        eprintln!("[tree:{tag}] window.backgroundColor = {}", objc_description(bg));
        let content: *mut AnyObject = msg_send![win, contentView];
        if content.is_null() {
            eprintln!("[tree:{tag}] contentView NULL");
            return;
        }
        let mut printed = 0usize;
        fn walk(
            view: *mut AnyObject,
            depth: usize,
            printed: &mut usize,
            tag: &str,
        ) {
            if depth > 5 || *printed > 40 {
                return;
            }
            unsafe {
                let cls = (*view).class().name().to_string_lossy().into_owned();
                let frame: objc2_foundation::NSRect = msg_send![view, frame];
                let alpha: f64 = msg_send![view, alphaValue];
                let hidden: bool = msg_send![view, isHidden];
                let wants_layer: bool = msg_send![view, wantsLayer];
                let layer: *mut AnyObject = msg_send![view, layer];
                let layer_desc = if layer.is_null() {
                    "no-layer".to_string()
                } else {
                    let cg: *mut AnyObject = msg_send![layer, backgroundColor];
                    let l_opaque: bool = msg_send![layer, isOpaque];
                    let bg_desc = if cg.is_null() {
                        "nil".to_string()
                    } else {
                        let ns: *mut AnyObject = msg_send![
                            objc2::class!(NSColor),
                            colorWithCGColor: cg as *mut std::ffi::c_void
                        ];
                        objc_description(ns)
                    };
                    format!("bg={bg_desc} opaque={l_opaque}")
                };
                let indent = "  ".repeat(depth);
                eprintln!(
                    "[tree:{tag}] {indent}{cls} ({:.0},{:.0} {:.0}x{:.0}) alpha={alpha:.2}{} wantsLayer={wants_layer} {layer_desc}",
                    frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
                    if hidden { " HIDDEN" } else { "" },
                );
                *printed += 1;
                let subviews: *mut AnyObject = msg_send![view, subviews];
                let n: usize = if subviews.is_null() { 0 } else { msg_send![subviews, count] };
                for i in 0..n {
                    let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                    if !sv.is_null() {
                        walk(sv, depth + 1, printed, tag);
                    }
                }
            }
        }
        walk(content, 0, &mut printed, tag);
    }
}

/// Print the live NSWindow chrome state — the grey-halo investigation probe.
/// Reads, never writes. Call on the main thread.
pub fn debug_window_chrome(ns_window: *mut std::ffi::c_void, tag: &str) {
    if ns_window.is_null() {
        eprintln!("[chrome:{tag}] ns_window NULL");
        return;
    }
    unsafe {
        let win = ns_window as *mut AnyObject;
        let has_shadow: bool = msg_send![win, hasShadow];
        let is_opaque: bool = msg_send![win, isOpaque];
        let style_mask: u64 = msg_send![win, styleMask];
        let bg: *mut AnyObject = msg_send![win, backgroundColor];
        let bg_alpha: f64 = if bg.is_null() { -1.0 } else { msg_send![bg, alphaComponent] };
        eprintln!("[chrome:{tag}] hasShadow={has_shadow} isOpaque={is_opaque} styleMask={style_mask:#x} bgAlpha={bg_alpha}");
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
