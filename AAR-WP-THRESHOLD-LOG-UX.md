# AAR — WP-THRESHOLD-LOG-UX (the decision/commitment log comes to the desktop)

**Date:** 2026-06-12
**Branches:** `claude/awesome-wozniak-ed62c3` (client PR 1), `claude/wp-threshold-log-ux-receipts` (client PR 2, stacked), `claude/wp-threshold-log-ux-server` (server, AI-Light-Prototype)
**Base:** viktora-threshold `main` @ `889201d` (post dark-glass redesign #20)
**Brief tracked:** `WP-THRESHOLD-LOG-UX-BRIEF.md` (on PR #21, branch `claude/vibrant-allen-dec6bb`)
**Backend counterpart:** decision-log engine merged in AI-Light-Prototype (#265/#266); this WP added two read endpoints (#270)
**Estimated envelope:** 3–4 ED (+1–1.5 for Receipts). **Actual:** ~1 session.

---

## What shipped

Three PRs, in dependency order:

| PR | Repo | What |
|---|---|---|
| [AI-Light-Prototype#270](https://github.com/rosscantrell/AI-Light-Prototype/pull/270) | server | `GET /api/documents/:id/decision-records` + `GET /api/decision-log/receipts?entity=X` — additive, read-only, beside `/api/decision-log` |
| [viktora-threshold#22](https://github.com/rosscantrell/viktora-threshold/pull/22) | client | records-primary post-capture panel + Today view + ambient amber badge (v0.7.0) |
| [viktora-threshold#23](https://github.com/rosscantrell/viktora-threshold/pull/23) | client | Receipts evidence dossier + dual-format clipboard (v0.7.1, stacked on #22) |

### Server (one file: `server/index.ts`, +146)
Both endpoints reuse the existing `/api/decision-log` load + lifecycle + `deriveRecordStates` pattern. Flag-independent (empty when the cache is missing). Receipts does a **one-hop edge expansion** off the entity's seed records so conflict/supersession chains render whole, and emits deterministically-ordered output (records by date→recordId, edges by edgeId).

### Client Rust (`src-tauri/src/lib.rs`)
- `poll_for_records` cloned from `poll_for_tidbit` (a **parallel** path); `pending_records` in `AppState`; `get_pending_records` / `clear_pending_records`; `threshold://records-arrived`; dispatched at the same 3 ingest points.
- `get_decision_log_summary` (badge count), `fetch_decision_log` (Today), `fetch_receipts` (dossier), `copy_receipts` (dual-format clipboard).
- `MENU_LOG` ("Today") widget menu item → `widget_expand("log")`.

### Client frontend
- Post-capture panel (records-primary; tidbit folds in as an amber card), Today view (`#log`), ambient badge (widget), Receipts view (`#receipts`) with the deterministic Markdown/HTML builders. All new CSS scoped to the new views; existing views untouched.

---

## Test / verification summary

No populated Apolla instance was available locally (the backfill is the rollout step — see below), so verification was: live HTTP smoke for the server, and a **mock-IPC harness** for the client that stubs `window.__TAURI__` with the *live-verified* server shapes and drives the real `main.js`.

| Gate | Result |
|---|---|
| Server golden master (`test-current-model.ts`) | ✓ byte-exact, exit 0 |
| Server `test-decision-log.ts` | ✓ 26/26 |
| Server `tsc` | ✓ clean except the 2 pre-existing `plan-themes.ts` errors |
| Server live smoke (synthetic cache) | ✓ per-doc filter, **cross-doc supersession→state**, one-hop chain, edge annotation, **byte-determinism**, 400/empty cases |
| `cargo check` (macOS) | ✓ clean, v0.7.1 |
| Frontend build | ✓ `frontendDist` is static `src/` (no bundler); `node --check` clean on `main.js`/`widget.js` |
| Records panel render | ✓ harness: 3 cards, edge direction, amber overdue meta |
| **Verbatim gate** | ✓ unverified verbatim renders in **neither** the panel/receipts view **nor** either export flavor |
| Today view render | ✓ harness: needs-attention, contradiction (HIGH), states strip, owner load |
| Receipts render | ✓ harness: chain order, edge-direction phrasing, current-state derivation, source links |
| Receipts export | ✓ **byte-deterministic** across repeated builds; MD pastes clean (verified quotes only + footer) |

### Regression checks
- **Tidbit path:** `poll_for_tidbit`, `handle_tidbit_ready`, the `Tidbit`/`TidbitStatus`/`TidbitPollResponse` types, and `get/clear_pending_tidbit` are **byte-unchanged** (diff-verified — the only diff matches are new *comments* naming those symbols). The 3 dispatch sites changed `document_id` → `document_id.clone()` to feed the new records dispatch alongside — behaviorally identical for the tidbit call.
- Records polling stops silently when `enabled == false` server-side, so on today's **flag-off production** the new path is a no-op identical to current behavior.

---

## Brief vs reality — surprises + deviations

### 1. The brief's "styles.css is light Apple-utility" was stale
PR #20's dark-glass redesign had already shipped a full glassy `:root` token system (`--surface-*`, `--border-*`, `--text-*`, `--warn` amber, `--success`, `--danger`, `--blur`, radii, shadows). That **is** the "glassy token set" the brief asked me to propose — so I reused it wholesale rather than inventing new tokens. Decision→accent, commitment→success, attention/overdue→warn, conflict→danger, superseded→tertiary. Net effect: the "design tokens" deliverable collapsed to "compose the existing palette + scoped layout rules."

### 2. Brief line numbers had drifted (recon-generated against an earlier tree)
`poll_for_tidbit` was at 1212 (brief said ~1132), `VIEWS` at 94 (~80), bootstrap hash-check at 193 (~161). Every architecture *fact* held; only the coordinates moved. Spot-checking before relying on them (per the operating protocol) paid off.

### 3. The decision-records endpoint has no "pending" status (unlike tidbit)
Tidbit polling waits on a `status` enum. Records just *appear* once enrichment writes them. So `poll_for_records` terminates on **records-present** OR **`enabled == false`** (nothing will ever come) OR timeout — rather than on a status transition. This also means the post-capture badge reuses the existing gold tidbit indicator (fired by *either* records or tidbit); the **new** amber badge is the *ambient* `overdueSilent` count (top-left), matching the brief's "second badge, distinct."

### 4. `arboard` was already in the tree
The dual-format clipboard needs `set_html(html, Some(alt_text))` (the Tauri clipboard plugin's `write_html` sets HTML only — no plain-text fallback, which would break the Slack/terminal path). `arboard` provides exactly that, and was **already a transitive dependency** (via rfd/tao) — so declaring it direct added nothing to `Cargo.lock` and zero bundle weight.

### 5. The server repo doesn't bump `package.json` per-PR
AI-Light-Prototype's decision-log feature PRs (#265/#266) left `version` at `0.1.0`. So the server PR carries **no** version bump — the "version triple" is a viktora-threshold (client) convention only. Client bumped 0.6.1 → 0.7.0 (PR1) → 0.7.1 (PR2).

### 6. Receipts deep links are constructed client-side
The receipts endpoint returns `documentId` but not a `deepLink` (the tidbit's `deepLink` is composed server-side from `PUBLIC_BASE_URL`, unavailable here). The client reconstructs `{base_url}/document/{documentId}` from config — reusing the tidbit scheme as specified.

---

## Acceptance gate (from the brief)

- [x] Capture → records panel ≤60s; unverified verbatims never quoted; empty-record docs show "captured & filed" (no apology copy).
- [x] `view-log` renders live `/api/decision-log` (needs-attention, contradictions, states); handles empty + unreachable.
- [x] Widget amber badge == `summary.overdueSilent`; click → `#log`; tidbit badge unchanged.
- [x] **Tidbit regression proof:** `poll_for_tidbit` untouched; statuses handled as today (diff-verified).
- [x] Receipts: chain chronological with edge annotations; copy-as-Markdown pastes cleanly; unverified verbatims excluded; output deterministic (byte-identical for identical inputs).
- [x] Server endpoint: golden master byte-unchanged; additive only.
- [x] `cargo check` + frontend build clean on macOS; version triple bumped.
- [ ] **Demo: live capture → records → Today → badge, recorded against Ross's instance** — blocked on the rollout prerequisite (below); coordinate with Ross.

---

## Rollout prerequisite (operator — do before the demo)

On the target Apolla instance, the log must be populated for any of this UX to show data:
`npx tsx scripts/backfill-decision-log.ts` → `npx tsx scripts/editor-pass-decision-log.ts` → set `ENABLE_DECISION_LOG=true` + `ENABLE_DECISION_LOG_EDITOR=true` → verify `GET /api/decision-log` returns records → deploy via `scripts/deploy.sh` (drift-gated). **Receipts' supersession chains only light up after the editor pass runs.** Until then the desktop behaves exactly as today (records poll is a silent no-op on flag-off).

---

## Named-not-specced follow-ups (FN bucket)

- **FN-1 — Contradiction → Receipts entry.** `/api/decision-log`'s `contradictions` edge view doesn't carry a subject entity, so "Show receipts" is wired on needs-attention rows + record cards (which have `primaryEntity`), not contradiction rows. Small server follow-up: add `primaryEntity` to the edge view.
- **FN-2 — In-app live refresh of the panel.** Like the existing tidbit path, the expanded app doesn't react to `records-arrived` while already open (the badge/panel flow is widget-driven). A `records-arrived` listener in `main.js` could live-update the panel if captured-while-expanded becomes common.
- **FN-3 — Receipts P2:** export-as-PNG card (Slack-beautiful, branded) + PDF, per the brief.
- **FN-4 — Windows clipboard verification.** `arboard` dual-format is cross-platform but was only exercised on macOS here; confirm rich+plain paste on Windows during the demo pass.

---

## Cross-references
- Server endpoints + safety: [AI-Light-Prototype#270](https://github.com/rosscantrell/AI-Light-Prototype/pull/270)
- Engine + data semantics: `schema-browser/experiments/field-projection/DECISION-LOG-FINDINGS.md`, `server/ai/decision-log/types.ts`
- Design language: `src/styles.css` `:root` (shipped #20), `src/widget.css`
- Tidbit path this parallels: `poll_for_tidbit` @ `src-tauri/src/lib.rs`

## Stage closure
Server PR + both client PRs open and green on static gates. The model proposed; the math disposed — every render path is deterministic and the verbatim net held end-to-end. Only the live demo remains, gated on the operator rollout.
