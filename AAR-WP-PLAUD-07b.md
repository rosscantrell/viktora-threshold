# AAR — WP-PLAUD-07b (Threshold-mediated Plaud OAuth — client side)

**Date:** 2026-05-28
**Branch:** `claude/wp-plaud-07b-threshold-connect`
**Base:** `main` @ `cc3f16b` (post WP-EXPORT-05 auto-watch)
**Brief tracked:** `WP-PLAUD-07-Threshold-Bootstrap-Brief-v1_0.md` §4.2 at
[AI-Light-Prototype @ 9cb6269](https://github.com/rosscantrell/AI-Light-Prototype/commit/9cb6269)
**Endpoint counterpart:** WP-PLAUD-07a — `POST /api/plaud/connect`
(73/73 tests green; AAR at AI-Light-Prototype repo root)
**Estimated envelope:** 0.75 day. **Actual:** ~2.0 hr including grounding
+ test fixture generation.

---

## What shipped

| File | Status | LOC | Notes |
|---|---|---|---|
| `src-tauri/src/plaud_oauth.rs` | **NEW** | ~520 | Rust port of `plaud-bootstrap.js`. Pure PKCE helpers + tokio TCP listener + token exchange + droplet POST + orchestrator. Pure helpers `pub` for the byte-equiv test suite. |
| `src-tauri/tests/plaud_oauth_tests.rs` | **NEW** | ~285 | 25 tests across 7 sections, all passing. Pins every contract constant + verifies byte-equivalence with JS for fixed seeds. |
| `src-tauri/src/lib.rs` | modified | +175 / 0 | 4 new IPC commands (`plaud_connect_start` / `_cancel` / `_status`, `plaud_disconnect_soft_clear`), 1 new menu item (`MENU_CONNECTIONS`), 1 new AppConfig field (`plaud_connect: Option<PlaudConnectStatus>`), `pub mod plaud_oauth`. |
| `src-tauri/Cargo.toml` | modified | +9 / 0 | `base64 = "0.22"` + `rand = "0.8"` added as direct deps (already transitive; declaring directly so the OAuth module's CSPRNG/encoding paths are grep-able). |
| `src/index.html` | modified | +55 / 0 | New `view-connections` section with Plaud card. |
| `src/main.js` | modified | +210 / 0 | New `enterConnectionsView` + `renderPlaudConnectionCard` + click handlers + phase-event subscription + hash-router arm for `#connections`. |
| `src/styles.css` | modified | +110 / 0 | `.view-connections` / `.connections-card-*` styles, harmonized with the WP-PLAUD-04a queue rhythm. |
| `src-tauri/Cargo.toml`, `tauri.conf.json`, `package.json` | modified | version | v0.5.0 → **v0.6.0** (see §"Brief vs reality" point 1). |

---

## Test summary

**25/25 tests passing in `cargo test --test plaud_oauth_tests`.**

| Section | Tests | Coverage |
|---|---|---|
| Constant pinning (contract with Plaud) | 5 | CLIENT_ID, REDIRECT_URI, AUTH_URL, TOKEN_URL, CALLBACK_PATH — any drift here breaks the OAuth flow end-to-end, so they're hard-pinned |
| base64url encoding parity | 3 | empty, single-byte (no padding), URL-safe alphabet boundary (`-` / `_` not `+` / `/`) |
| Verifier + challenge byte-equivalence | 5 | all-zeros 32B fixture, sequential 0..31 fixture, RFC 7636 §B.2 spec example — verifies the SHA-256-of-base64url-text path matches JS exactly |
| state / nonce | 2 | 16B → 22-char base64url; 32B → exactly 43-char base64url (server schema regex `/^[A-Za-z0-9_-]{43}$/` is load-bearing) |
| Authorization URL | 1 | Byte-equal to JS `URLSearchParams` output for fixed inputs; param order pinned |
| Token POST body + Basic Auth | 2 | form body byte-equal to JS; basic-auth header equals `base64(client_id:)` for empty secret |
| Callback parser | 7 | code+state extraction, percent-decoding, non-callback paths return None, OAuth `?error=` returns Err, missing-param paths return None, extra params ignored |

Brief required: byte-equivalence on verifier+challenge generation,
buildAuthorizationUrl shape, TOKEN_URL POST body, nonce charset+length.
**All four required pins shipped + 5 additional defensive cases.**

### Regression checks

- `cargo build --lib` clean on `aarch64-apple-darwin` (1 prior warning unrelated to this WP).
- No existing tests touched; this WP is additive (new module, new IPC commands, new view, new menu item, new AppConfig field with `#[serde(default)]`).

---

## Brief vs reality — surprises + deviations

### 1. Version bump landed at v0.6.0, not v0.4.0 (brief stale)

**Brief §7 + §5.1:** "Threshold v0.4 release boundary." Brief was authored
assuming v0.3.0 was current.

**Live repo state at branch start:** already at **v0.5.0** — WP-PLAUD-04a
(Plaud Sync Queue UI) shipped after v0.4.1's deep-link work, and the
post-04a chore commit `f6ecf26 chore: bump version to v0.5.0` is on main.
WP-ONENOTE-EXPORT-01..05 then shipped on top of v0.5.0 without further
version bumps.

**Decision:** per the dispatch's "live repo wins on layout/naming" rule,
bumped to **v0.6.0** across the triple (`src-tauri/Cargo.toml` +
`src-tauri/tauri.conf.json` + `package.json`). No coordinator
round-trip required — this is the named-not-contract divergence path.

### 2. Menu naming: "Connections…" not "Connect Plaud" at the top level

**Brief §4.2 UI mockup:** the in-pane button reads "Connect Plaud" / "Reconnect"
/ "Disconnect". Brief does NOT prescribe a menu surface explicitly.

**Live repo precedent:** menu items follow the `<thing>…` ellipsis
convention for items that open a workspace pane (Settings…, Browse OneNote…,
Plaud Sync Queue). I added "Connections…" between Settings and the
separator + Quit, which reads as a workspace-control sibling of Settings.

This leaves headroom for future Connected Recorder cards (Limitless /
Otter / Granola — brief §1.4 v2 deferral) to land on the same pane
without re-rooting the menu.

### 3. AppConfig schema extended with `plaud_connect: Option<...>`

**Brief §4.2 status:** "UI updates local cached status" on Disconnect. The
status field has to live somewhere. The brief doesn't name a storage
location.

**Decision:** added `AppConfig.plaud_connect: Option<PlaudConnectStatus>`,
following the existing additive-only schema-delta pattern (same as
`widget_x` / `widget_y` from WP-Threshold-Compact-UX D-CUX-16,
`onenote_hotkey` from WP-EXPORT-03, `auto_watch` from WP-EXPORT-05). The
field is `#[serde(default, skip_serializing_if = "Option::is_none")]` so
old configs deserialize cleanly and new configs only emit the field when
populated.

`PlaudConnectStatus` itself is intentionally minimal:
- `connected_at: String` (ISO 8601 UTC) — when we last successfully POSTed
- `expires_at: Option<i64>` (ms-epoch) — what the server / token bundle reported
- `posted_to: Option<String>` — droplet base URL, informational

The droplet's `/home/deploy/.plaud/tokens.json` remains authoritative.
This is purely a UX hint so the Settings → Connections pane can render
"Connected" on next open without a network round-trip.

### 4. IPC command names follow live snake_case convention (matches brief)

Brief §4.2 suggested `plaud_connect_start` / `_cancel` / `_status` — these
match the live `plaud_discover` / `plaud_get_inbox` / `plaud_decide` /
`plaud_ingest` convention exactly. Used them verbatim. Added one extra:
`plaud_disconnect_soft_clear` — explicit naming makes the v1.0 scope-cut
visible from the IPC surface (full `/api/plaud/disconnect` is WP-PLAUD-07d).

### 5. base64 + rand declared as direct Cargo deps

Both were already in `Cargo.lock` as transitive deps (through reqwest /
rustls / getrandom). I declared them directly in `Cargo.toml` so the
OAuth module's CSPRNG and base64url-encoding paths are grep-able from
the dep manifest. Zero bundle-size impact (already-pulled-in crates).

---

## Empirical findings (brief §2.5 + §10.1 block-on-answer items)

### Cross-platform TCP listener binding (brief §2.5 unknown #1)

**Status: PARTIALLY VERIFIED.** Build succeeds cleanly on
`aarch64-apple-darwin` (Mac). The `tokio::net::TcpListener::bind` call
on `127.0.0.1:8199` is identical to the well-trodden path the existing
Threshold ingest paths use; we already bind loopback successfully for
local-HTTPS dev. Mac smoke confirms binding works without a firewall
prompt (loopback is allowed by default under macOS application
firewall settings).

**Windows smoke: PENDING operator gate.** The brief §5.2 acceptance smoke
requires both Mac AND Windows to be exercised end-to-end against a
live pilot droplet. Windows-specific findings to capture in the
operator-driven smoke:
- **Windows Defender Firewall prompt on first bind.** Expected on Windows
  10+ for any new app binding a TCP port for the first time, even on
  loopback. UI copy should be extended with "If Windows asks for firewall
  permission, click Allow" once the prompt is empirically observed.
- **Port 8199 conflict UX.** If the champion previously ran
  `plaud-bootstrap.js` locally and left the listener up, our orchestrator
  returns `PlaudOauthError::PortInUse` with an `lsof` hint. Windows
  equivalent (`netstat -ano | findstr :8199`) should be added to the
  error message after the first Windows smoke confirms the failure path.

### Browser-redirect compatibility (brief §10.1 block-on-answer #2)

**Status: NOT EXERCISED.** No live Plaud account was driven through the
flow during this WP — that's the §5.2 operator smoke gate.

Known-risk browsers per brief §8:
- Safari Private Browsing — blocks `localhost` redirects from public origins
- Hardened Firefox — same
- Chrome / Edge — expected to work

The orchestrator's 5-minute callback timeout (matching JS:114) is
preserved exactly so operators have the full window to switch browsers
if their default blocks the redirect.

---

## Acceptance criteria (brief §5.1)

| AC | Status | Evidence |
|---|---|---|
| Settings → Connections pane visible in Threshold | ✅ shipped | `view-connections` in index.html; reachable via right-click menu → Connections…; preview verified in worktree |
| Connect Plaud button works end-to-end on Mac | 🟡 PENDING smoke | Rust path compiles + tests green; live droplet smoke gates ship. See §"Empirical findings" |
| Connect Plaud button works end-to-end on Windows | 🟡 PENDING smoke | Same as Mac; Windows-specific firewall/UX captures still owed |
| Failure UX surfaces clear errors (port, timeout, droplet 4xx/5xx) | ✅ shipped | `PlaudOauthError` variants each carry a human-readable `Display` impl; `handlePlaudConnectClick` surfaces them via both status line + toast |
| Re-click overwrites tokens silently (matches `--force` semantics) | ✅ shipped | Connect button reads "Reconnect" when status is connected; clicking either runs the same flow |
| POST to droplet uses configured `INGESTION_API_KEY` | ✅ shipped | `plaud_connect_start` reads `cfg.bearer_token` (same field the existing `plaud_*` IPCs use) |
| PKCE Rust port byte-equivalent to plaud-bootstrap.js on fixed seed | ✅ shipped | 25/25 tests pass |
| v0.4 release candidate produced; version triple consistent | ✅ shipped at v0.6.0 | All three files match (see §"Brief vs reality" point 1) |

**Ship gates 7 + 9 of brief §5.2 (the manual end-to-end smoke):
NOT YET RUN.** Those require a live pilot droplet + a Plaud account +
SSH access to verify `tokens.json` landed. Coordinator-driven from
here — this WP cannot self-attest those gates without operator
infra. The PR description names this explicitly.

---

## What is NOT in this WP (deliberate scope-cuts per brief)

- **No `/api/plaud/disconnect` calls.** Disconnect is soft-clear per brief
  §4.2 v1.0 scope-cut. The Rust IPC `plaud_disconnect_soft_clear` clears
  the local cached `AppConfig.plaud_connect` field and the UI shows the
  SSH-revoke banner. Real server-side disconnect is WP-PLAUD-07d.
- **No `/onboarding` SPA tile** (brief §1.4 — v2).
- **No refresh-TTL instrumentation** (WP-PLAUD-08).
- **No npx fallback** (WP-PLAUD-07.1).
- **No mock-Plaud integration test harness** in this PR. Brief §6.2 marks
  it as "recommended if you can stand it up without yak-shaving"; tokio
  HTTP-mock infra inside a Tauri test harness would have been ~1hr+ of
  yak-shaving for marginal value over the byte-equivalence + manual
  smoke combination. Skipped per the brief's own guidance.

---

## Named-not-specced follow-ups (FN bucket)

- **FN-PLAUD-07b-01** — Windows firewall prompt UX. After the first
  Windows smoke run, extend the Connect-button-click flow to detect
  "no callback received after ~10s while the bind succeeded" and surface
  a "Did you click Allow on the Windows firewall prompt?" hint. ~30 LOC.
- **FN-PLAUD-07b-02** — Browser-redirect fallback ("Copy URL to clipboard").
  If the default browser blocks the localhost redirect (Safari Private,
  hardened Firefox per brief §8 risk row 2), the user currently sees
  only the 5-min timeout. A "Copy authorization URL" affordance on the
  Connecting… surface would mirror the plaud-bootstrap.js banner UX.
  ~50 LOC.
- **FN-PLAUD-07b-03** — Status line auto-refresh while pane is visible.
  Currently the connected/disconnected status renders once on view-enter
  and stays static. If the server cron rotates tokens (which it will),
  the `expires_at` display drifts. A 60s tick on the visible pane would
  bring the displayed time-until-expiry back into sync. Not load-bearing —
  the droplet is authoritative; this is purely a polish item.
- **FN-PLAUD-07b-04** — Move the OAuth constants into a shared
  `apolla-protocol-constants` crate referenced from both
  AI-Light-Prototype's TS code + viktora-threshold's Rust. Today the
  CLIENT_ID lives twice (once in plaud-bootstrap.js, once in
  plaud_oauth.rs). Diff-on-merge is the current safeguard; a shared
  source-of-truth would prevent silent drift. Out of scope here; named
  in the bucket.

---

## Cross-references

- **Brief:** `WP-PLAUD-07-Threshold-Bootstrap-Brief-v1_0.md` at AI-Light-Prototype repo root @ commit `9cb6269`
- **Server-side AAR (07a):** `AAR-WP-PLAUD-07a.md` at AI-Light-Prototype repo root — 73/73 tests, endpoint contract
- **Reference implementation:** `scripts/plaud-bootstrap.js` in AI-Light-Prototype — verified PKCE OAuth flow against Plaud's prod endpoints; my Rust is byte-equivalent on the four primitives the brief §6.1 names
- **Live OAuth contract:** WP-Plaud-Ingest-Brief-v1_3.md §3.6 (same Plaud public client_id; same redirect_uri whitelist)
- **Threshold release pattern:** CLAUDE.md §6 (build/release version-bump triple footgun)

---

## Stage closure

WP-PLAUD-07b ships the client side of the three-WP arc:
- ✅ WP-PLAUD-07a — server endpoint (shipped 2026-05-28, AI-Light-Prototype#251)
- ✅ **WP-PLAUD-07b** — this PR
- 🟡 WP-PLAUD-07c — runbook patch (depends on 07b shipping; ~0.25 day)

The §5.2 acceptance smoke (operator provisions a fresh pilot + connects
from a real Threshold + verifies tokens.json + waits for recordings) is
now unblocked. Coordinator-driven from here.

WP-PLAUD-07d (real `/api/plaud/disconnect`) and WP-PLAUD-08 (refresh-TTL
instrumentation) remain named-not-specced per brief §1.3 + §1.4 — both
dispatchable independently when demand materializes.
