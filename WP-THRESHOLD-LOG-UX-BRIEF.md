# WP-THRESHOLD-LOG-UX — Brief (Phase 1: the log comes to the desktop)

**Date:** 2026-06-12 · **Repo:** viktora-threshold (this one) + one tiny additive endpoint in AI-Light-Prototype
**Estimate:** 3–4 ED · **Risk:** Low (additive views; existing flows untouched)
**Backend status:** everything P1 needs is MERGED in AI-Light-Prototype (`GET /api/decision-log`, the decision-log caches; PRs #265/#266) except one ~30-line endpoint specified below.

## Mission (one line)

Invert Threshold's worst UX moment — capture → `no-marker` → *"No preview available"* — into its best: every capture immediately shows the decisions/commitments it produced, an always-on **Today** view surfaces what needs attention, and the widget gains an ambient "N items need attention" signal.

## Why this works now (context for a cold session)

The Apolla server now runs a marker-INDEPENDENT decision/commitment log (flag-gated): every ingested doc yields ~5 typed records (decisions/commitments with owners, due dates, verbatim quotes), a lifecycle engine flags overdue+silent items ranked by salience, and a cross-record editor finds contradictions/supersessions. Read
`AI-Light-Prototype/schema-browser/experiments/field-projection/DECISION-LOG-FINDINGS.md` for the full picture and `server/ai/decision-log/` for the types. The tidbit path depends on markers, which fire rarely on young corpora; records fire on EVERY capture.

## Architecture facts (verified by recon — trust but spot-check)

- Frontend is **vanilla JS/TS**, all views in single `src/index.html`, toggled by `showView()`; new view = 5 steps: add `<section id="view-xyz" class="view" hidden>`, add to VIEWS array (`src/main.js` ~line 80), write `enterXyzView()`, wire hash-check in bootstrap (~line 161), call `showView`.
- **Rust owns HTTP** (`src-tauri/src/lib.rs`): base_url + bearer token from persisted config; `poll_for_tidbit()` (~line 1132) polls `/api/documents/{id}/tidbit` 500ms/60s after `post_payload_to_apolla()`; result cached in AppState, event `threshold://tidbit-arrived` → JS badge.
- Widget (`src/widget.html|js|css`): 180×80 dark translucent pill; yellow tidbit badge w/ breathing animation; expanded window is 800×600 via `widget_expand(targetTab)` + hash routing.
- Design: `widget.css` is the dark/glassy language (rgba(28,30,38,.92), glass border); `styles.css` (expanded app) is light Apple-utility. **Ross's stated direction: dark/glassy.**

## Scope

**IN — server (AI-Light-Prototype, inherits PRODUCTION-SAFETY.md):**
1. `GET /api/documents/:id/decision-records` — additive: read the decision-log cache, return records where `documentId` matches (+ each record's lifecycle + any edges touching it). Works regardless of flags (empty array if none). Golden master byte-unchanged. ~30 lines beside `GET /api/decision-log` in `server/index.ts`.

**IN — client (this repo):**
2. **Post-capture records panel.** Rust: `poll_for_records(docId)` cloned from `poll_for_tidbit` (poll the new endpoint; records appear when enrichment completes — reuse the existing dispatch point; tolerate empty), cache + `get_pending_records`/`clear_pending_records` commands, event `threshold://records-arrived`. JS: render records into the post-capture view — record type chip (decision/commitment), summary, owner + due, verbatim as quote *only when `verbatimVerified`*; contradiction/supersession callout when edges present. Tidbit content still renders when it exists; records section makes the empty state obsolete.
3. **`view-log` ("Today").** Renders `GET /api/decision-log`: needs-attention list (record summary, owner, due, silent-days, subject), contradictions section, summary states (open/resolved/superseded counts), owner-load strip. Hash route `#log`; entry from widget menu + a button on `view-main`. Pull-to-refresh = re-fetch.
4. **Ambient widget signal.** Second badge (amber, distinct from the yellow tidbit badge) showing `summary.overdueSilent` count; fetched on widget start + after each capture + hourly; click → `widget_expand("log")`. No notification spam — badge only (P1).
5. **Design tokens for the new surfaces:** extend the widget's dark/glassy language into `view-log` and the records panel (new CSS scoped to these views). Do NOT restyle existing views in P1.

6. **Receipts (the evidence dossier).** `view-receipts`: for a subject entity, the chronological chain of its records — date, type, owner, verbatim quote (ONLY when `verbatimVerified`), source doc title — annotated with edges (⚠️ conflicts-with, ✓ resolved-by, supersession chains) and a derived "current state" line from the record state machine. Entry points: "Show receipts" on log rows/contradictions; scope expansion = records sharing subject entities (one hop). **Copy via dual-format clipboard** (Tauri clipboard API writing `text/html` + `text/plain` Markdown together — rich paste into Gmail/Outlook/Word/Notion, MD fallback in Slack/terminals; one button, no format picker). **Per-line evidence links**: each record links its source doc via the existing tidbit deepLink scheme (auth-gated — verification for insiders; the verbatim quotes carry the evidence for outsiders). Quote = inline evidence, link = full evidence. P2: export-as-PNG receipt card (Slack-beautiful, branded) and PDF. Visual reference: receipts-view mockup in the dark/glassy language (session 2026-06-12 — chain timeline, conflict/resolution chips, current-state strip, Copy/Share header). The receipt render is 100% DETERMINISTIC — no LLM in the chain; that is the trust property and must be preserved. Footer: "compiled by Threshold from meeting captures · every quote verbatim from source." Server: one additive endpoint `GET /api/decision-log/receipts?entity=X` (records-by-subject + edges + states, chronological; ~40 lines beside /api/decision-log); Markdown render client-side. Adds ~1–1.5 ED.

**OUT (later phases):** entity-card popovers (needs WP-DEF1), weekly digest view (needs WP-SYN1), full app restyle, any change to `TidbitStatus` enum or the tidbit polling contract (HARD CONSTRAINT — shipped clients depend on it), edge confirm/dismiss UI, Windows-specific polish beyond compile-clean.

## Rollout prerequisite (operator, ~$2, do FIRST so the UX has data)

On the target Apolla instance: `npx tsx scripts/backfill-decision-log.ts` → `npx tsx scripts/editor-pass-decision-log.ts` → set `ENABLE_DECISION_LOG=true` + `ENABLE_DECISION_LOG_EDITOR=true` → verify `GET /api/decision-log` returns records. Deploy via `scripts/deploy.sh` (drift-gated).

## Acceptance gate

- [ ] Capture a doc → records panel shows the real extracted records ≤60s; unverified verbatims never rendered as quotes; empty-record docs degrade gracefully (no apology copy — show "captured & filed" state).
- [ ] `view-log` renders live `/api/decision-log` (needs-attention, contradictions, states); handles empty log and server-unreachable.
- [ ] Widget amber badge count == `summary.overdueSilent`; click opens `#log`; tidbit badge behavior unchanged.
- [ ] **Tidbit regression proof:** existing tidbit flow byte-identical in behavior (`poll_for_tidbit` untouched; statuses `ready|pending|no-marker|failed` handled as today).
- [ ] Receipts: chain renders chronologically with edge annotations; copy-as-Markdown pastes cleanly into Slack/Notion; unverified verbatims excluded; output is deterministic (byte-identical for identical inputs).
- [ ] Server endpoint: golden master byte-unchanged; additive only.
- [ ] `cargo check` + frontend build clean on mac (Windows compile-clean); version triple bumped per repo convention.
- [ ] Demo: live capture → records panel → Today view → badge, recorded against Ross's instance.

## Operating protocol

1. Recon: read `src/main.js` view wiring, `lib.rs` tidbit poll path, `view-tidbit` markup; confirm the recon facts above.
2. **Propose, and STOP for approval:** the post-capture panel layout (how records + tidbit coexist), `view-log` information hierarchy, badge behavior, the endpoint response shape, and the glassy token set for new views.
3. On go: server endpoint first (separate small PR to AI-Light-Prototype), then client in this repo; one PR each; AAR on completion per repo convention.
