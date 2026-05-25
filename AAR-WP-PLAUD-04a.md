# AAR — WP-PLAUD-04a: Threshold Plaud Sync Queue UI (Sprint 1 MVP)

**Status**: SHIPPED — manual smoke pending Ross's pilot droplet run
**Branch**: `claude/plaud-04a-threshold-queue`
**Workstream**: WP-PLAUD-04a (Threshold sync queue UI, Sprint 1 — manual per-item approval)
**Brief**: `AI-Light-Prototype/WP-Plaud-Ingest-Brief-v1_3.md` §4.4a
**Out-of-scope**: §4.4b (rules management UI — Sprint 2)

---

## 1. What shipped

Four artifacts touched, ~936 LOC delta total.

### 1.1 `src-tauri/src/lib.rs` (+360 LOC)

- **One menu item** added between Pick File and Expand (per brief §4.4a menu-order spec):
  `MENU_PLAUD_QUEUE = "menu.plaud_queue"` constant + builder insertion + `on_menu_event` handler that invokes `widget_expand(..., target_tab: Some("plaud-queue"))`.
- **Four IPC commands** registered in `invoke_handler`:
  - `plaud_discover() -> PlaudDiscoverResult` — POST `/api/plaud/discover`
  - `plaud_get_inbox() -> Vec<PlaudInboxItem>` — GET `/api/plaud/inbox`
  - `plaud_decide(id, action) -> ()` — POST `/api/plaud/inbox/{id}/decide`
  - `plaud_ingest(id) -> PlaudIngestResult` — POST `/api/plaud/ingest`
- **Three serde-camelCase response structs** mirror server shapes from `schema-browser/server/ingest/plaud-state.ts` (PlaudInboxItem) and `plaud-sync-loop.ts` / `plaud-adapter.ts` (PlaudDiscoverResult, PlaudIngestResult).
- **Bearer-auth + reqwest pattern reused** from `post_payload_to_apolla`: `current_config(&state)?` for the token, `danger_accept_invalid_certs(true)` for WP-OCR-08 local-HTTPS, 30s default timeout (120s for `plaud_ingest` since LLM extraction is slow).
- **Defense-in-depth**: `plaud_decide` validates `action ∈ {import, skip, clear}` client-side before the round-trip (server is authoritative; this just produces clearer error messages on typos). 503 responses get a friendly "Plaud sync is disabled" message in addition to the standard 401/429/5xx mapping.
- **Six new unit tests** (43 total, up from 37): URL-encoding safe/unsafe-char round-trip, PlaudInboxItem minimum-required + full-shape deserialization, PlaudDiscoverResult + PlaudIngestResult parse fixtures.

### 1.2 `src/main.js` (+409 LOC)

- `VIEWS` array extended with `"view-plaud-queue"`.
- Hash-routing clause for `#plaud-queue` added next to the existing `#tidbit` clause in `bootstrap()`. On match, calls `enterPlaudQueueView()` and short-circuits the default `enterMainView(cfg)`.
- `enterPlaudQueueView()` + `refreshPlaudQueue()` — load pending items via IPC, filter `state === "pending"`, render via `createElement` + `textContent` (no innerHTML for user content — mirrors `enterTidbitView` precedent).
- `renderPlaudCard(item)` builds one card with title / meta line / summary preview / 4 action buttons.
- `formatPlaudMeta(item)` and `formatPlaudDuration(ms)` produce the meta line: `"Tue 2:14 PM · 53min · 7 speakers (3 named)"`. Locale-aware via `toLocaleString`; speaker-count omitted when absent.
- Per-action handlers:
  - `handlePlaudImport` — `plaud_decide(import)` then `plaud_ingest`. Optimistic card removal on success.
  - `handlePlaudSkip` — `plaud_decide(skip)`. Optimistic card removal on success.
  - `handlePlaudAlwaysFromDevice(item, card, action)` — `plaud_decide` (+ `plaud_ingest` on import) then optimistically remove **all sibling cards with the same `serialNumber`** from the DOM. Includes the brief-mandated `TODO(WP-PLAUD-03)` comment for the future rule-engine POST.
- `handlePlaudSyncNow` — invokes `plaud_discover`, refreshes the list, toasts the result (new-items count). Button disabled during the call.
- All failures surface via `showToast({kind: "failure", ...})`. Loading states managed via `.plaud-queue-card-busy` class + `btn.disabled`.
- Back-button wired in `DOMContentLoaded` invokes `widget_collapse` (matches `view-tidbit` precedent).
- Defensive helpers: `cssEscape` polyfill (CSS.escape is widely available but Threshold has no bundling), `setCardBusy`, `removePlaudCard`, `refreshPlaudQueueMeta`.

### 1.3 `src/index.html` (+38 LOC)

- New `<section id="view-plaud-queue">` inserted after `view-tidbit` and before the drag-drop overlay.
- Structure: `.plaud-queue-header` (title + meta + sync button) / `.plaud-queue-list` (cards rendered by JS) / `.plaud-queue-empty` / `.plaud-queue-footer` (back button).
- Per brief: no "Manage Rules…" button in the v1 footer (that's §4.4b Sprint 2). Brief's HTML stub included it; I omitted it to avoid shipping a dead button.

### 1.4 `src/styles.css` (+129 LOC)

- `.plaud-queue-*` class hierarchy parallels `.tidbit-*`:
  - `.view-plaud-queue` 720px max-width container, 56px top padding for the floating collapse button.
  - `.plaud-queue-header` uses CSS grid (`title sync` / `meta sync`) so the sync button vertically centers next to the title + meta stack.
  - `.plaud-queue-list` capped at `max-height: 380px` with `overflow-y: auto` — prevents the queue from blowing past the 600px expand-window height when ≥6 pending items pile up.
  - `.plaud-queue-card` uses white background + soft border (matches Apple-flavored visual rhythm of the tidbit cards) with 14px gap between cards.
  - `.plaud-queue-card-busy` opacity + pointer-events for the per-action loading state.
- No emojis (per `feedback_no_emojis_in_ui_mockups` memory + Threshold's existing aesthetic).

---

## 2. Test/smoke plan

### 2.1 Automated (CI gates)

- **Rust unit tests**: 43 tests pass (`cargo test --lib`). 6 new tests added for WP-PLAUD-04a helpers + response-shape round-trip.
- **Rust type check**: `cargo check` green (37s warm).
- **JS syntax check**: `node --check src/main.js` green.

No Tauri UI integration tests exist in this repo (per brief §4.4a "no Tauri unit-test infrastructure in v0.4"); CI runs `cargo check` + `cargo test --lib` per `.github/workflows/ci.yml`.

### 2.2 Manual smoke (Ross-driven; pre-ship gate)

Below is the smoke checklist for the PR description.

**Prereq**: `PLAUD_ENABLED=true` on the configured Apolla droplet; `plaud login` already completed via SSH tunnel per WP-PLAUD-05 runbook.

1. `cd /Users/rosscantrell/Projects/viktora-threshold-plaud-04a && cargo tauri dev`
2. **Menu surface**: right-click the floating widget → confirm "Plaud Sync Queue" appears between "Pick File…" and "Expand…".
3. **Menu invocation**: click "Plaud Sync Queue" → widget expands to 800×600 → queue view renders → confirm pending items load (or "All caught up" empty state if none).
4. **Sync now**: click "Sync now" → button disables briefly → toast shows "Plaud sync complete (found N new recording(s))" or "(No new recordings found)".
5. **Import action**: click "Import" on one pending card → card greys out briefly → on success disappears + success toast names the recording.
6. **Skip action**: click "Skip" on another → card disappears + skip toast.
7. **Always sync from this device**: click on a card whose `serialNumber` matches another pending card → both cards disappear from view + toast mentions "Other pending recordings from this device cleared from queue."
8. **Always skip from this device**: mirror of step 7 with the skip action.
9. **Empty state**: clear queue down to zero → confirm "All caught up — no new recordings from Plaud." message renders.
10. **Back button**: click "← Back to widget" → widget collapses to 180×80 floating pill.
11. **Verify imported recording in Apolla**: open the configured Apolla web UI → documents list → the recording imported in step 5 appears within ~60s of the toast (post WP-PLAUD-02 LLM extraction). The `apollaDocumentId` from the toast body matches.
12. **Error path** (optional but recommended): on the droplet, `pm2 stop apolla` → click "Sync now" → toast says "Plaud sync failed: Couldn't reach Apolla". Re-start the server and recover.

---

## 3. Discoveries

### 3.1 Brief was accurate on the stack — minor deviations

- **`view-tidbit` precedent**: brief called it correctly. `enterTidbitView`'s `createElement + textContent` pattern transferred directly to `renderPlaudCard`. Saved an architectural decision.
- **`current_config(&state)?` pattern**: drop-in for bearer-auth + base-URL. No surprises.
- **`#plaud-queue` hash-routing**: brief said to add the clause next to the `#tidbit` clause at `main.js:78`. Correct.

### 3.2 Brief stub omitted from HTML

The brief's HTML stub included a `<button id="btn-plaud-rules">Manage Rules…</button>` in the footer. That's Sprint 2 (§4.4b). I **omitted** it from the v1 ship so we don't surface a dead button. When WP-PLAUD-04b lands, it adds the button + wires it to `enterPlaudRulesView()`. No risk to v1 — the queue is fully functional without a rules-management entry point.

### 3.3 New IPC patterns I had to invent

- **`urlencoding_minimal`**: Plaud recording IDs are 32-char hex on the happy path, but to be defensive against future API changes (and to satisfy the OWASP "encode path segments" reflex), I rolled a 20-LOC URL-segment encoder rather than depending on a `url` crate add (which is already a transitive dep but not in the direct `Cargo.toml`). 3 unit tests cover happy + unsafe paths.
- **`build_plaud_http_client` + `plaud_status_error`**: small DRY helpers that consolidate the reqwest builder + HTTP-status-to-friendly-message mapping across the four commands. Mirrors `post_payload_to_apolla`'s pattern (which embeds them inline). Lifted out because four call sites is over the `inline-once-extract-twice` threshold and the 401/503/429 mapping had subtle Plaud-specific wording (the 503 case maps to "PLAUD_ENABLED is not set on the server").
- **120s timeout on `plaud_ingest`**: the default 30s reqwest timeout used by the other Plaud commands is too aggressive for the ingest path (Plaud `getFile` + LLM extraction can take 30-60s on the Apolla side per WP-PLAUD-02 §3.3). Bumped to 120s.
- **Optimistic card removal across same-device siblings**: the brief said "optimistically remove other pending cards from same device" but didn't specify the selector mechanic. I attach `data-serial="..."` to each card and use a `querySelectorAll` + `cssEscape` polyfill to remove siblings. Could have used a JS-side filter against the live list — chose DOM-attribute lookup for resilience to future renders.

### 3.4 Server-side fields I trusted blindly

The Rust `PlaudInboxItem` struct deserializes the server's `state: 'pending'|'ingested'|'skipped'` as `String` rather than a Rust enum. Rationale: defensive against future server-side state additions (e.g., a `'ingesting'` intermediate state, an `'errored'` terminal state). The JS-side filter (`it.state === "pending"`) is the canonical filter; Rust just passes through.

---

## 4. Known follow-ups

### 4.1 WP-PLAUD-03 device-rule POST (embedded TODO)

`handlePlaudAlwaysFromDevice` includes a TODO comment for the future rules-engine POST:

```js
// TODO(WP-PLAUD-03): also POST /api/plaud/rules with a new device rule
// { kind: 'device', serialNumber: item.serialNumber, action } so future
// recordings from this device auto-route without surfacing in the queue.
```

When WP-PLAUD-03 ships, this WP's queue UI also needs a paired update: the "Always sync/skip from this device" buttons must call the rules endpoint, and the optimistic-card-removal heuristic can be tightened (cards will fall out of the inbox naturally on the next server-side discover-pass + rule evaluation, so the optimistic removal becomes a pure UX nicety rather than a load-bearing UX feature).

### 4.2 No background indicator badge (deferred per brief)

Brief §4.4a optional v1.5+ scope is a `threshold://plaud-arrived` event emitter (mirrors `threshold://tidbit-arrived`) that pulses the widget when discovery finds new items. Not in v1. The user has to manually right-click → "Plaud Sync Queue" to discover new items, or click "Sync now" in the open queue view. Future enhancement once we have pilot feedback on engagement frequency.

### 4.3 v0.4 → v0.5 release-cut considerations

The version triple in `src-tauri/Cargo.toml` + `src-tauri/tauri.conf.json` + `package.json` is currently `0.4.1`. Once WP-PLAUD-04a + WP-PLAUD-04b ship together, the natural release name is `v0.5.0` ("Plaud sync" the feature). This WP does NOT bump the triple — leaving that to the release-cut session (per the v0.3.0 lesson noted in `viktora-threshold/AAR-WP-Threshold-Compact-UX.md`).

### 4.4 Mac focus-leak on action click (asymmetric with Windows per FN-CUX-12)

The Plaud queue view runs in the expanded 800×600 window (not the floating widget), so the Mac NSPanel-vs-NSWindow focus-leak that the floating widget has doesn't apply here. Action buttons activate the expanded window normally on both platforms. No new asymmetry.

---

## 5. Cross-references

- **Brief**: `AI-Light-Prototype/WP-Plaud-Ingest-Brief-v1_3.md` §4.4a (Sprint 1 MVP — manual per-item approval)
- **Backend endpoints called**:
  - `POST /api/plaud/discover` (WP-PLAUD-01, PR #240)
  - `GET /api/plaud/inbox` (WP-PLAUD-01)
  - `POST /api/plaud/inbox/:id/decide` (WP-PLAUD-01)
  - `POST /api/plaud/ingest` (WP-PLAUD-02, PR #242)
- **Server shape source-of-truth**: `schema-browser/server/ingest/plaud-state.ts::PlaudInboxItem`, `plaud-sync-loop.ts::DiscoverResult`, `plaud-adapter.ts::IngestPlaudRecordingResult`
- **UI precedent**: `view-tidbit` (WP-Threshold-Tidbit-Return Phase B) — structural template for the queue panel
- **Tier asymmetry context**: `AAR-WP-Threshold-Compact-UX.md` §5 FN-CUX-12 (Mac focus-leak — n/a for the expanded window where this WP runs)
- **Next workstream in chain**: WP-PLAUD-03 (rules engine — Sprint 2 backend) → WP-PLAUD-04b (rules management UI — Sprint 2 frontend; uses the rules engine WP-PLAUD-03 exposes)

---

## 6. Files changed

| File | Delta LOC | Description |
|---|---|---|
| `src-tauri/src/lib.rs` | +360 | 4 IPC commands, 4 response structs, 6 unit tests, menu item + handler |
| `src/main.js` | +409 | `enterPlaudQueueView` + 4 action handlers + helpers + button wiring |
| `src/index.html` | +38 | `view-plaud-queue` section structure |
| `src/styles.css` | +129 | `.plaud-queue-*` class hierarchy |
| `AAR-WP-PLAUD-04a.md` | +new | This document |

**Total**: ~936 LOC + AAR.

---

## 7. Verification commands

```bash
# 1. Rust type check
cd /Users/rosscantrell/Projects/viktora-threshold-plaud-04a/src-tauri
cargo check

# 2. Rust unit tests (43 total; 6 new)
cargo test --lib

# 3. JS syntax check
cd /Users/rosscantrell/Projects/viktora-threshold-plaud-04a
node --check src/main.js

# 4. Manual smoke (Ross-driven; pilot droplet required)
cargo tauri dev
# Then follow §2.2 manual smoke plan above
```
