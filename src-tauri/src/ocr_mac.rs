//! Mac native in-process OCR (WP-OCR-13 Phase A; AC-2; D-13-02).
//!
//! Replaces the v0.1.x subprocess-to-`ocr-capture` path with an in-process
//! call to Apple's Vision framework. Region selection still uses the system's
//! own crosshair tool (`/usr/sbin/screencapture -i`) per D-13-04 — it's the
//! Mac UX users know from Cmd+Shift+4.
//!
//! Public API:
//!   capture_and_ocr_mac() -> Result<CaptureResult, CaptureError>
//!
//! `CaptureResult` carries both the extracted text and the bundle ID of the
//! frontmost app at capture time (`sourceApp`; P-13-09 (c) orthogonal axis
//! to `captureTool: 'threshold'`).

use std::path::Path;
use std::process::Command;

use objc2::AnyThread;
use objc2::rc::Retained;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

/// Result of a successful Mac region capture + OCR pass.
#[derive(Debug, Clone)]
pub struct CaptureResult {
    /// Extracted text, lines joined with newlines.
    pub text: String,
    /// Best-effort bundle ID of the frontmost app at the moment Threshold
    /// invoked the capture (e.g., `"com.tinyspeck.slackmacgap"`). Empty
    /// string on lookup failure per brief §0.2's explicit degradation
    /// allowance.
    pub source_app: String,
}

/// Distinguishable error variants from `capture_and_ocr_mac`. The caller
/// dispatches on these to emit the right toast variant (cancellation vs.
/// generic failure).
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    /// User pressed Esc during the region-selection crosshair.
    #[error("region capture cancelled (Esc pressed during selection)")]
    CancelledByUser,
    /// `/usr/sbin/screencapture -i` failed to spawn or returned non-zero.
    #[error("screencapture subprocess failed: {0}")]
    SubprocessFailed(String),
    /// Vision OCR pipeline failed somewhere (image load, request perform, etc.).
    #[error("OCR failed: {0}")]
    OcrFailed(String),
}

/// Run region capture + native Vision OCR. Returns extracted text + frontmost
/// app bundle ID, OR a typed error the caller can dispatch on.
///
/// Workflow:
///   1. Snapshot the frontmost app's bundle ID BEFORE invoking
///      `screencapture` — the user's focus is about to shift to the
///      crosshair overlay; we want the app they were on a moment ago.
///   2. Subprocess `/usr/sbin/screencapture -i <tmpfile>`.
///   3. P-13-06 cancellation: `screencapture -i` returns exit code 0
///      whether the user committed a region OR pressed Esc — the only
///      signal is whether the file got written. Check size > 0.
///   4. Hand the file path to `VNImageRequestHandler::initWithURL:options:`.
///   5. Run `VNRecognizeTextRequest` with `accurate` recognition level
///      (slower but better quality; ~500ms on a typical 1024x768 region).
///   6. Iterate observations; for each, take the top candidate's `.string()`.
///   7. Join non-empty lines with newlines; return.
pub fn capture_and_ocr_mac() -> Result<CaptureResult, CaptureError> {
    // Step 1: snapshot sourceApp BEFORE we steal focus.
    let source_app = frontmost_app_bundle_id().unwrap_or_default();

    // Step 2: temp file for the PNG. We take a NamedTempFile then convert
    // to TempPath so `screencapture` can write through the path — the file
    // handle would block the write otherwise on some macOS versions.
    let tmpfile = tempfile::Builder::new()
        .prefix("threshold-capture-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| CaptureError::SubprocessFailed(format!("tempfile: {e}")))?;
    let tmp_path = tmpfile.into_temp_path();

    // Step 3: invoke screencapture -i. The `-t png` is the default for `-i`
    // but stated explicitly so we know what extension to expect.
    let status = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-t", "png"])
        .arg(&*tmp_path)
        .status()
        .map_err(|e| CaptureError::SubprocessFailed(format!("spawn: {e}")))?;

    if !status.success() {
        return Err(CaptureError::SubprocessFailed(format!(
            "exit code: {:?}",
            status.code()
        )));
    }

    // Step 4: P-13-06 cancellation detection.
    let written_bytes = std::fs::metadata(&*tmp_path).map(|m| m.len()).unwrap_or(0);
    if written_bytes == 0 {
        return Err(CaptureError::CancelledByUser);
    }

    // Step 5-7: Vision OCR. TempPath auto-deletes on drop.
    let text = run_vision_ocr_on_file(&tmp_path)?;
    Ok(CaptureResult { text, source_app })
}

/// Run Vision OCR on a file at `path`. Returns extracted text (lines joined
/// with newlines), or `CaptureError::OcrFailed` on Vision-side failure.
fn run_vision_ocr_on_file(path: &Path) -> Result<String, CaptureError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| CaptureError::OcrFailed("temp file path is not valid UTF-8".into()))?;

    // objc2 0.6+ exposes most Vision methods as safe (the binding handles
    // memory + nullability invariants). We rely on the autogenerated
    // signatures; any future `unsafe` requirements will surface as compile
    // errors. Memory is managed by objc2's `Retained<T>` wrapper.
    let ns_path = NSString::from_str(path_str);
    let url: Retained<NSURL> = NSURL::fileURLWithPath(&ns_path);

    // VNImageRequestHandler wraps the image source for Vision requests.
    // `initWithURL:options:` reads the image directly from disk; we don't
    // need to decode the PNG into a CGImage ourselves. `options` is
    // non-nullable in the binding — pass an empty dictionary.
    let empty_opts: Retained<NSDictionary<NSString, _>> = NSDictionary::new();
    // SAFETY: `initWithURL_options` is marked unsafe because the Vision
    // binding can't statically verify the URL points to a readable image —
    // we've just confirmed the file exists and is non-empty above, and
    // `screencapture` only writes PNGs to the path it was handed.
    let handler = unsafe {
        VNImageRequestHandler::initWithURL_options(
            VNImageRequestHandler::alloc(),
            &url,
            &empty_opts,
        )
    };

    // VNRecognizeTextRequest — OCR request type. Recognition level
    // `accurate` (slow + good) per brief D-13-02 vs `fast` (cheap + noisier).
    let request: Retained<VNRecognizeTextRequest> = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

    // Wrap the request in an NSArray<VNRequest> (subclass instances upcast
    // via Deref to the parent VNRequest type) for the perform_requests call.
    // The perform call writes its observations back into `request.results()`.
    let request_super: &VNRequest = &request;
    let requests: Retained<NSArray<VNRequest>> = NSArray::from_slice(&[request_super]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| CaptureError::OcrFailed(format!("performRequests: {e:?}")))?;

    // Iterate observations. `request.results()` returns
    // `Option<Retained<NSArray<VNRecognizedTextObservation>>>` — None means
    // the request didn't run (shouldn't happen post-perform, but defensive).
    // Each VNRecognizedTextObservation carries a ranked list of candidate
    // transcriptions; we take the top.
    let mut lines = Vec::<String>::new();
    if let Some(observations) = request.results() {
        for obs in observations.iter() {
            let candidates = obs.topCandidates(1);
            if let Some(candidate) = candidates.iter().next() {
                let s = candidate.string().to_string();
                if !s.trim().is_empty() {
                    lines.push(s);
                }
            }
        }
    }

    Ok(lines.join("\n"))
}

/// NSWorkspace.sharedWorkspace().frontmostApplication().bundleIdentifier().
///
/// Best-effort: returns `None` on any lookup failure (sandbox edge cases,
/// nil frontmost app on lock-screen wake, missing bundle ID for some
/// command-line-launched processes). The caller treats `None` as empty
/// string per brief §0.2 explicit degradation allowance.
fn frontmost_app_bundle_id() -> Option<String> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let bundle_id = app.bundleIdentifier()?;
    Some(bundle_id.to_string())
}
