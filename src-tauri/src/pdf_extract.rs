// WP-ONENOTE-EXPORT-01 — PDF text extraction for the OneNote export-watch
// fallback path.
//
// Substrate: pdf-extract (pure Rust) for text content; lopdf for accurate
// page count (pdf-extract's form-feed-delimited output is unreliable on
// real-world OneNote-exported PDFs).
//
// The <50-chars/page heuristic flags pages dominated by flattened-to-image
// handwriting / ink content. OneNote's `Publish` export flattens ink to
// raster images; pdf-extract returns ~0 chars in that case. We surface a
// user-visible note rather than silently sending empty content to Apolla.
//
// Cross-platform: this module compiles on Mac, Windows, and Linux. No
// platform-specific shell-outs.

use lopdf::Document;
use pdf_extract::extract_text_from_mem;

/// Pages with fewer than this many extracted characters are treated as
/// likely-handwriting (or image-only / scanned). Tuned empirically against
/// the synthetic OneNote-exported fixtures in
/// `scratch/onenote-fallback-poc/`. Encoded as a constant rather than
/// hard-coded so v2 can expose to the user via Configure.
pub const HANDWRITING_CHARS_PER_PAGE_THRESHOLD: usize = 50;

/// Result of a successful PDF extraction. The `is_likely_handwriting`
/// flag drives the user-visible "skipped — handwriting" path; the caller
/// inspects it before posting to Apolla.
#[derive(Debug, Clone)]
pub struct PdfExtraction {
    /// All extracted text, concatenated. Empty when the PDF is image-only.
    pub text: String,
    /// Page count from lopdf's `get_pages()`. Always ≥ 1 for a valid PDF.
    pub page_count: usize,
    /// `text.len() / page_count`, integer-truncated. Saturates at 0 when
    /// `text` is empty.
    pub chars_per_page: usize,
    /// True iff `chars_per_page < HANDWRITING_CHARS_PER_PAGE_THRESHOLD`.
    /// Caller surfaces this to the user; we do NOT silently send empty
    /// content to Apolla.
    pub is_likely_handwriting: bool,
}

/// Errors surfaced from PDF extraction. Each variant maps to a distinct
/// user-visible toast in the caller; we don't merge them because the
/// recovery actions differ ("file is broken" vs "file needs a password"
/// vs "file is empty").
#[derive(Debug)]
pub enum PdfExtractError {
    /// PDF byte stream couldn't be parsed at all (not a valid PDF; truncated;
    /// header corrupted). Wraps the underlying error string for logging.
    Corrupted(String),
    /// PDF is encrypted. v1 does not attempt to decrypt; user must remove
    /// the password and re-save the PDF before re-dragging it in.
    PasswordProtected,
    /// PDF parsed but contains zero pages. Spec-compliant PDFs always have
    /// at least one page; this is a malformed/empty edge case.
    Empty,
    /// Any other error path (rare; pdf-extract internal panics, OOM, etc.).
    Other(String),
}

impl PdfExtractError {
    /// Short user-visible message for toast titles.
    pub fn user_message(&self) -> &'static str {
        match self {
            PdfExtractError::Corrupted(_) => "Couldn't read PDF (file may be corrupted)",
            PdfExtractError::PasswordProtected => {
                "Couldn't read PDF (password-protected — remove the password and re-save before sending)"
            }
            PdfExtractError::Empty => "PDF is empty (no pages)",
            PdfExtractError::Other(_) => "Couldn't read PDF (unexpected error)",
        }
    }
}

impl std::fmt::Display for PdfExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PdfExtractError::Corrupted(e) => write!(f, "PDF corrupted: {}", e),
            PdfExtractError::PasswordProtected => write!(f, "PDF password-protected"),
            PdfExtractError::Empty => write!(f, "PDF has no pages"),
            PdfExtractError::Other(e) => write!(f, "PDF extraction failed: {}", e),
        }
    }
}

impl std::error::Error for PdfExtractError {}

/// Extract text + page-count from a PDF byte slice.
///
/// Uses lopdf for page-count (authoritative for the handwriting heuristic)
/// and pdf-extract for text content. Both crates parse the byte stream
/// independently; if lopdf rejects the bytes we return early without
/// invoking pdf-extract.
///
/// Returns `PdfExtraction` on success (including the case where text is
/// empty — caller checks `is_likely_handwriting`). Returns
/// `PdfExtractError` for parse failures, encryption, and zero-page edge
/// cases.
pub fn extract_pdf_text(bytes: &[u8]) -> Result<PdfExtraction, PdfExtractError> {
    // Parse with lopdf first — gives us authoritative page count + early
    // exit on corrupted/empty inputs.
    let doc = Document::load_mem(bytes).map_err(|e| {
        let msg = format!("{:?}", e);
        // lopdf signals encryption via specific error shapes; the public
        // enum is broad. We match on the debug-string substring because
        // lopdf's error variants change across versions and a substring
        // match is more durable than coupling to internal variant names.
        if msg.to_lowercase().contains("encrypt") {
            PdfExtractError::PasswordProtected
        } else {
            PdfExtractError::Corrupted(msg)
        }
    })?;

    let page_count = doc.get_pages().len();
    if page_count == 0 {
        return Err(PdfExtractError::Empty);
    }

    // pdf-extract is a separate pure-Rust parser; surfaces its own errors.
    // Treat as `Other` because lopdf already covered the corruption/encryption
    // paths; if we get this far and pdf-extract still fails it's a rare
    // codec edge case (custom fonts, malformed text-object streams, etc.).
    let text = extract_text_from_mem(bytes).map_err(|e| {
        let msg = format!("{:?}", e);
        if msg.to_lowercase().contains("encrypt") {
            PdfExtractError::PasswordProtected
        } else {
            PdfExtractError::Other(msg)
        }
    })?;

    let chars_per_page = text.len() / page_count;
    let is_likely_handwriting = chars_per_page < HANDWRITING_CHARS_PER_PAGE_THRESHOLD;

    Ok(PdfExtraction {
        text,
        page_count,
        chars_per_page,
        is_likely_handwriting,
    })
}

// ───────────────────────────────────────────────────────────────────────────
// Unit tests
// ───────────────────────────────────────────────────────────────────────────
//
// Fixture PDFs live at `src-tauri/tests/fixtures/`:
//   - `onenote_clean_text.pdf`  — 2-page synthetic OneNote export with
//                                 typed meeting notes (multi-page text)
//   - `onenote_handwriting.pdf` — 1-page synthetic OneNote export with
//                                 image-flattened handwriting (zero text)
//
// Both fixtures originated from `scratch/onenote-fallback-poc/`
// (WP-ONENOTE-00 research dispatch); their generation scripts are
// preserved there for reference.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixture_path(name: &str) -> PathBuf {
        // CARGO_MANIFEST_DIR resolves to `src-tauri/` regardless of
        // invocation directory (cargo test from project root or from
        // src-tauri/ both work).
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("tests");
        p.push("fixtures");
        p.push(name);
        p
    }

    fn load_fixture(name: &str) -> Vec<u8> {
        fs::read(fixture_path(name))
            .unwrap_or_else(|e| panic!("Failed to load fixture {}: {}", name, e))
    }

    #[test]
    fn extract_clean_onenote_pdf_succeeds() {
        let bytes = load_fixture("onenote_clean_text.pdf");
        let result = extract_pdf_text(&bytes).expect("clean PDF should extract");

        assert!(
            !result.text.is_empty(),
            "Expected non-empty text from clean-text fixture"
        );
        assert!(!result.is_likely_handwriting);
        assert!(
            result.chars_per_page >= HANDWRITING_CHARS_PER_PAGE_THRESHOLD,
            "Clean-text PDF should be well above handwriting threshold; got {} chars/page",
            result.chars_per_page
        );
    }

    #[test]
    fn extract_clean_onenote_pdf_preserves_meeting_content() {
        let bytes = load_fixture("onenote_clean_text.pdf");
        let result = extract_pdf_text(&bytes).expect("clean PDF should extract");

        // Fixture is a synthetic meeting page; spot-check a few load-bearing
        // strings that the WP-ONENOTE-00 research validation also asserted on.
        assert!(
            result.text.contains("Q2 Engineering Sync"),
            "Expected meeting title in extracted text"
        );
        assert!(
            result.text.contains("Trisha") && result.text.contains("Ross"),
            "Expected attendee names in extracted text"
        );
    }

    #[test]
    fn extract_handwriting_pdf_flags_as_handwriting() {
        let bytes = load_fixture("onenote_handwriting.pdf");
        let result = extract_pdf_text(&bytes).expect("handwriting PDF should still parse");

        assert!(
            result.is_likely_handwriting,
            "Image-only PDF should flag as likely handwriting; got chars_per_page={}",
            result.chars_per_page
        );
        assert!(
            result.chars_per_page < HANDWRITING_CHARS_PER_PAGE_THRESHOLD,
            "Handwriting PDF should be below threshold; got {}",
            result.chars_per_page
        );
    }

    #[test]
    fn multi_page_pdf_reports_correct_page_count() {
        // The clean-text fixture is two pages; lopdf should report exactly 2.
        let bytes = load_fixture("onenote_clean_text.pdf");
        let result = extract_pdf_text(&bytes).expect("clean PDF should extract");

        assert_eq!(
            result.page_count, 2,
            "Clean-text fixture is a 2-page PDF; lopdf should report 2"
        );
    }

    #[test]
    fn corrupted_bytes_return_corrupted_error() {
        let bytes: &[u8] = b"this is not a PDF at all, just garbage bytes!!!";
        let err = extract_pdf_text(bytes).expect_err("garbage bytes should fail to parse");

        match err {
            PdfExtractError::Corrupted(_) => {}
            other => panic!("Expected Corrupted; got {:?}", other),
        }
    }

    #[test]
    fn empty_bytes_return_corrupted_error() {
        let bytes: &[u8] = b"";
        let err = extract_pdf_text(bytes).expect_err("empty bytes should fail to parse");

        // lopdf treats this as InvalidFileHeader, so we surface it as Corrupted.
        // (Distinct from PdfExtractError::Empty, which is the zero-pages case.)
        match err {
            PdfExtractError::Corrupted(_) => {}
            other => panic!("Expected Corrupted for empty bytes; got {:?}", other),
        }
    }

    #[test]
    fn truncated_pdf_returns_error() {
        // Valid-ish PDF header but truncated body — pdf-extract's xref
        // resolution fails. We don't care which variant; we care that we
        // get an Err and don't panic.
        let bytes: &[u8] = b"%PDF-1.4\nblah blah\n";
        let err = extract_pdf_text(bytes).expect_err("truncated PDF should fail");

        // Could be Corrupted (lopdf's call) — either way, must not Ok.
        match err {
            PdfExtractError::Corrupted(_)
            | PdfExtractError::Other(_)
            | PdfExtractError::Empty
            | PdfExtractError::PasswordProtected => {}
        }
    }

    #[test]
    fn handwriting_threshold_is_below_50_chars_per_page() {
        // Regression guard on the constant — caller's UX assumes 50 specifically.
        // Tightens to a hard equality so future tweaks land deliberately.
        assert_eq!(HANDWRITING_CHARS_PER_PAGE_THRESHOLD, 50);
    }

    #[test]
    fn chars_per_page_zero_flags_as_handwriting() {
        // Synthetic case: a hypothetical 1-page PDF with 0 chars should
        // ALWAYS flag (0 < 50).
        let bytes = load_fixture("onenote_handwriting.pdf");
        let result = extract_pdf_text(&bytes).expect("handwriting PDF parses");

        assert_eq!(
            result.text.len(),
            0,
            "Handwriting fixture should have zero extracted chars (image-only)"
        );
        assert!(result.is_likely_handwriting);
    }

    #[test]
    fn error_user_messages_are_non_empty() {
        // Defensive: ensure caller-facing strings aren't accidentally blanked
        // out by a refactor.
        for err in &[
            PdfExtractError::Corrupted("x".into()),
            PdfExtractError::PasswordProtected,
            PdfExtractError::Empty,
            PdfExtractError::Other("y".into()),
        ] {
            assert!(!err.user_message().is_empty());
        }
    }

    #[test]
    fn error_display_implementations_dont_panic() {
        // Each variant's Display impl is called from log lines + toast bodies.
        let _ = format!("{}", PdfExtractError::Corrupted("test".into()));
        let _ = format!("{}", PdfExtractError::PasswordProtected);
        let _ = format!("{}", PdfExtractError::Empty);
        let _ = format!("{}", PdfExtractError::Other("test".into()));
    }
}
