// WP-PLAUD-07b — PKCE byte-equivalence tests.
//
// Acceptance criterion from the brief (§6.1): the Rust port of
// `plaud-bootstrap.js` must produce IDENTICAL output to the JS reference
// for fixed RNG seeds. This file pins every load-bearing primitive
// (verifier encoding, challenge hash, state, nonce, authorization URL,
// token POST body, basic auth header) against fixtures computed offline
// from the live JS impl at AI-Light-Prototype commit 9cb6269.
//
// Fixture generation (for future re-pinning):
//   node -e "
//     const c=require('crypto');
//     const zeros = Buffer.alloc(32, 0);
//     const v0 = zeros.toString('base64url');
//     const ch0 = c.createHash('sha256').update(v0).digest('base64url');
//     console.log({v0, ch0});
//   "
//
// These fixtures are stable: SHA-256 + base64url are spec'd, and our
// CLIENT_ID / REDIRECT_URI / AUTH_URL constants are pinned to Plaud's
// hardcoded whitelist. Any test failure here is either (a) a contract
// drift with Plaud (escalate, do NOT "fix" the test), or (b) a real bug
// in the Rust port.

use viktora_threshold_lib::plaud_oauth::{
    basic_auth_token, build_authorization_url, build_token_form_body,
    challenge_from_verifier, encode_base64url, nonce_from_bytes,
    parse_callback_request_line, state_from_bytes, verifier_from_bytes,
    AUTH_URL, CALLBACK_PATH, CLIENT_ID, REDIRECT_URI, TOKEN_URL,
};

// ── Constant pinning (contract with Plaud) ─────────────────────────────

#[test]
fn client_id_pinned_to_plaud_whitelist() {
    // plaud-bootstrap.js:97 — public client ID baked into the CLI bundle.
    // Plaud's redirect_uri allow-list is keyed off this; any change here
    // breaks the OAuth flow end-to-end.
    assert_eq!(CLIENT_ID, "client_f9e0b214-c11f-434b-8b95-c4497d1feb81");
}

#[test]
fn redirect_uri_pinned_to_localhost_8199() {
    // plaud-bootstrap.js:99 — hardcoded on Plaud's side. Champion's
    // laptop must bind THIS exact URL.
    assert_eq!(REDIRECT_URI, "http://localhost:8199/auth/callback");
}

#[test]
fn auth_url_pinned() {
    assert_eq!(AUTH_URL, "https://web.plaud.ai/platform/oauth");
}

#[test]
fn token_url_pinned() {
    assert_eq!(
        TOKEN_URL,
        "https://platform.plaud.ai/developer/api/oauth/third-party/access-token"
    );
}

#[test]
fn callback_path_pinned() {
    assert_eq!(CALLBACK_PATH, "/auth/callback");
}

// ── base64url encoding parity ──────────────────────────────────────────

#[test]
fn base64url_empty() {
    assert_eq!(encode_base64url(&[]), "");
}

#[test]
fn base64url_no_padding_one_byte() {
    // Node: Buffer.from([0xff]).toString('base64url') === "_w"
    assert_eq!(encode_base64url(&[0xff]), "_w");
}

#[test]
fn base64url_url_safe_alphabet() {
    // Bytes chosen so the encoder must emit '-' and '_' (not '+' / '/').
    // Node:
    //   Buffer.from([0xfb, 0xff, 0xbf]).toString('base64url') === "-_-_"
    assert_eq!(encode_base64url(&[0xfb, 0xff, 0xbf]), "-_-_");
}

// ── Verifier + challenge byte-equivalence (brief §6.1 core ACs) ────────

#[test]
fn verifier_all_zeros_matches_js() {
    // FIXTURE 1: 32 zero bytes → 43 char base64url-encoded "A" string.
    // Computed from plaud-bootstrap.js's generateCodeVerifier with the
    // same input buffer.
    let seed = [0u8; 32];
    assert_eq!(
        verifier_from_bytes(&seed),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    assert_eq!(verifier_from_bytes(&seed).len(), 43);
}

#[test]
fn challenge_all_zeros_matches_js() {
    // FIXTURE 1: SHA-256 of the all-A's verifier, base64url'd.
    let verifier = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assert_eq!(
        challenge_from_verifier(verifier),
        "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo"
    );
    assert_eq!(challenge_from_verifier(verifier).len(), 43);
}

#[test]
fn verifier_sequential_bytes_matches_js() {
    // FIXTURE 2: bytes 0..31 — exercises the alphabet boundaries.
    let mut seed = [0u8; 32];
    for (i, b) in seed.iter_mut().enumerate() {
        *b = i as u8;
    }
    assert_eq!(
        verifier_from_bytes(&seed),
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    );
}

#[test]
fn challenge_sequential_bytes_matches_js() {
    // FIXTURE 2: SHA-256 of the sequential-bytes verifier.
    let verifier = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    assert_eq!(
        challenge_from_verifier(verifier),
        "6oZqdX5MOLq_qBJ8vppAnT4fk6AP8UiP9zX8-Rev_9A"
    );
}

#[test]
fn challenge_rfc7636_example() {
    // FIXTURE 3: RFC 7636 §B.2 spec example. Independent reference.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert_eq!(
        challenge_from_verifier(verifier),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

// ── state / nonce ──────────────────────────────────────────────────────

#[test]
fn state_16_bytes_yields_22_char_base64url() {
    // FIXTURE: 16 × 0xAA. Length matches plaud-bootstrap.js:132-134's
    // crypto.randomBytes(16).toString('base64url') output.
    let seed = [0xAAu8; 16];
    let s = state_from_bytes(&seed);
    assert_eq!(s, "qqqqqqqqqqqqqqqqqqqqqg");
    assert_eq!(s.len(), 22);
}

#[test]
fn nonce_32_bytes_yields_exactly_43_chars() {
    // The server-side schema (ConnectBodySchema in WP-PLAUD-07a) enforces
    // /^[A-Za-z0-9_-]{43}$/ — anything outside that pattern → 400. So 43
    // is load-bearing; we test it across multiple seed patterns.
    let cases = [
        [0x00u8; 32],
        [0x42u8; 32],
        [0xffu8; 32],
        {
            let mut a = [0u8; 32];
            for (i, b) in a.iter_mut().enumerate() {
                *b = (i as u8) ^ 0x5a;
            }
            a
        },
    ];
    for seed in &cases {
        let n = nonce_from_bytes(seed);
        assert_eq!(n.len(), 43, "nonce wrong length for seed {:?}", &seed[..4]);
        // Spot-check the all-0x42 fixture against the JS reference.
        if seed == &[0x42u8; 32] {
            assert_eq!(n, "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI");
        }
        // Charset: regex /^[A-Za-z0-9_-]{43}$/
        for c in n.chars() {
            assert!(
                c.is_ascii_alphanumeric() || c == '-' || c == '_',
                "nonce char {:?} not in base64url alphabet",
                c
            );
        }
    }
}

// ── Authorization URL byte-equivalence ─────────────────────────────────

#[test]
fn authorization_url_matches_js_for_fixed_inputs() {
    // Reproduced from the JS reference with:
    //   buildAuthorizationUrl({
    //     codeChallenge: "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
    //     state:         "qqqqqqqqqqqqqqqqqqqqqg",
    //   })
    let actual = build_authorization_url(
        "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
        "qqqqqqqqqqqqqqqqqqqqqg",
    );
    let expected = concat!(
        "https://web.plaud.ai/platform/oauth?",
        "client_id=client_f9e0b214-c11f-434b-8b95-c4497d1feb81",
        "&redirect_uri=http%3A%2F%2Flocalhost%3A8199%2Fauth%2Fcallback",
        "&response_type=code",
        "&code_challenge=DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
        "&code_challenge_method=S256",
        "&state=qqqqqqqqqqqqqqqqqqqqqg",
    );
    assert_eq!(actual, expected);
}

// ── Token-exchange POST body byte-equivalence ──────────────────────────

#[test]
fn token_form_body_matches_js_for_fixed_inputs() {
    // Reproduced from the JS reference:
    //   new URLSearchParams({
    //     code: 'fakecode-123',
    //     redirect_uri: 'http://localhost:8199/auth/callback',
    //     code_verifier: 'AAAA...AAA',
    //     state: 'qqqqqqqqqqqqqqqqqqqqqg',
    //   }).toString()
    let body = build_token_form_body(
        "fakecode-123",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "qqqqqqqqqqqqqqqqqqqqqg",
    );
    let expected = concat!(
        "code=fakecode-123",
        "&redirect_uri=http%3A%2F%2Flocalhost%3A8199%2Fauth%2Fcallback",
        "&code_verifier=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "&state=qqqqqqqqqqqqqqqqqqqqqg",
    );
    assert_eq!(body, expected);
}

#[test]
fn basic_auth_token_matches_js_for_empty_secret() {
    // base64(CLIENT_ID + ":" + "") — plaud-bootstrap.js:151. Tested
    // against Node's:
    //   Buffer.from('client_...:').toString('base64')
    let token = basic_auth_token();
    assert_eq!(
        token,
        "Y2xpZW50X2Y5ZTBiMjE0LWMxMWYtNDM0Yi04Yjk1LWM0NDk3ZDFmZWI4MTo="
    );
}

// ── Callback parser ────────────────────────────────────────────────────

#[test]
fn callback_parser_extracts_code_and_state() {
    let req = "GET /auth/callback?code=abc123&state=xyz789 HTTP/1.1";
    let parsed = parse_callback_request_line(req).expect("should not be err");
    let outcome = parsed.expect("should be Some");
    assert_eq!(outcome.code, "abc123");
    assert_eq!(outcome.state, "xyz789");
}

#[test]
fn callback_parser_handles_url_encoded_values() {
    // Plaud encodes state with base64url chars only, but defensive parse
    // path should decode percent-encoded values cleanly.
    let req = "GET /auth/callback?code=a%2Bb%2Fc&state=q%2Fq HTTP/1.1";
    let parsed = parse_callback_request_line(req).expect("should not be err");
    let outcome = parsed.expect("should be Some");
    assert_eq!(outcome.code, "a+b/c");
    assert_eq!(outcome.state, "q/q");
}

#[test]
fn callback_parser_ignores_non_callback_paths() {
    // /favicon.ico or any stray probe — return Ok(None) so the listener
    // keeps waiting.
    let req = "GET /favicon.ico HTTP/1.1";
    let parsed = parse_callback_request_line(req).expect("should not be err");
    assert!(parsed.is_none());
}

#[test]
fn callback_parser_returns_err_on_oauth_error_param() {
    let req = "GET /auth/callback?error=access_denied&error_description=user%20denied HTTP/1.1";
    let err = parse_callback_request_line(req).expect_err("should be err");
    assert!(
        err.contains("user denied") || err == "access_denied",
        "unexpected error desc: {:?}",
        err
    );
}

#[test]
fn callback_parser_missing_code_returns_none() {
    // ?state= but no ?code= — caller responds neutral + keeps waiting.
    let req = "GET /auth/callback?state=abc HTTP/1.1";
    let parsed = parse_callback_request_line(req).expect("should not be err");
    assert!(parsed.is_none());
}

#[test]
fn callback_parser_missing_state_returns_none() {
    let req = "GET /auth/callback?code=abc HTTP/1.1";
    let parsed = parse_callback_request_line(req).expect("should not be err");
    assert!(parsed.is_none());
}

#[test]
fn callback_parser_extra_unknown_params_ignored() {
    let req = "GET /auth/callback?code=abc&state=xyz&extra=foo HTTP/1.1";
    let parsed = parse_callback_request_line(req).expect("should not be err");
    let outcome = parsed.expect("should be Some");
    assert_eq!(outcome.code, "abc");
    assert_eq!(outcome.state, "xyz");
}
