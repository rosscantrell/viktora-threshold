# WP-DATA-LIFECYCLE — purge, export, and the "Your data" section

**Date:** 2026-07-20 · **Status:** brief for Ross's redline — build does NOT start until approved (first destructive capability in the engine) · **Origin:** the verified gap behind "control over my data" (2026-07-17): zero purge, zero user-facing export, zero encryption-at-rest. · **Owner lanes:** engine (Phase E1), Threshold app (E2, one-pair-of-eyes), ops-doc (E3).

## 0. The one-paragraph version

Deletion is the most primal data control there is, and today we cannot do it: the only "removal" in the engine is doc-supersession, which is a read-time *hide* — a superseded document's embeddings, extractions, entity counts, and frames all remain on disk. This WP ships (1) a real cascade **purge** endpoint whose receipt is honest about every layer it touched, (2) a **full-corpus export** a user can take with them, and (3) the Privacy panel's **"Your data"** section that fronts both. House law applies with teeth: a purge that misses a layer is not privacy — it is a false receipt.

## 1. Ground truth (recon 2026-07-20, file-level evidence in the recon log — do not re-derive)

- **Record identity is deterministic**: `recordId = sha256(documentId+type+verbatim+owner+promptVersion)` — doc→records is a scan; records→everything-else is transitive through the recordId set.
- **The cascade has four provenance classes**: (a) documentId-keyed stores (extractions/{id}.json, quote-citations, degraded ledger, index.json, plaud back-refs) — surgically findable; (b) recordId-keyed (edges, embeddings/*.jsonl, frames-substrate) — findable via the resolved record set; (c) aggregate caches with **no per-doc provenance** (entity-index counts, entity cards, marker caches keyed by fingerprint+model, renderings, ontology, drift, job-names/prose-jobs) — cannot be decremented, only rebuilt; (d) **append-only human overlays** (hitl-events, org-edits/, canons, churn rulings, job-key-migrations) — must never be hard-deleted.
- **THE TRAP: HITL dispositions live only in `decision-log.json` rows** (`record.hitl`, written by the PATCH route; *not* replayed from hitl-events.jsonl by any read-fold). A wholesale decision-log delete/rebuild silently drops every other document's dismiss/snooze/resolve state. Purge must filter rows surgically, never regenerate the whole log.
- **Supersession ≠ purge**: `doc-supersessions.json` is append-only read-hiding (records + index only). Reusable as the *reversible* tier, not as deletion.
- **Churn gate**: a purge legitimately changes the corpus fingerprint → `populate-frames` commits (no hold), and the job-key migration map still bridges name-anchored org-edits. But `frames-substrate.json` must be refreshed and `frames.candidate.json` cleared, or the next gate run diffs against stale record sets.
- **Raw-content copies outside `ingested/`**: `email-held.json` holds verbatim mail bodies pre-ingest; plaud-inbox holds only previews but carries `apollaDocumentId` back-refs that must reset on purge (else the recording reads "already ingested" forever).
- **Reusable machinery**: `diff-export.ts` (prune-tolerant HITL-triple export — the export template), `extraction-degraded-store` (per-doc ledger + surfaced count — the tombstone/receipt pattern), `org-state-backup.sh` (org-state bundle — the mandatory pre-purge snapshot; NOT a full export), the MODEL_ROUTING/MODEL_PROFILE dedicated-auth-pattern + bearer-audit-pin discipline.
- **Nothing exists**: no delete/retire function for docs or records anywhere; the only `app.delete` is an MCP method guard.

## 2. Design

### Phase E1 — engine: purge + export

**`DELETE /api/documents/:id` (the purge), layered exactly as the cascade demands:**

1. **Snapshot first**: refuse to run unless an org-state backup bundle newer than N minutes exists, or take one inline (`org-state-backup.sh` semantics in-process). Non-negotiable.
2. **Surgical** — decision-log rows filtered by `documentId` (preserving all other rows byte-for-byte, `hitl` included); documentId-keyed files hard-deleted (`ingested/{id}.txt`, `extractions/{id}.json`, index entry, quote-citations rows, degraded-ledger entry); plaud back-ref reset; `email-held` copies for the doc's thread purged.
3. **Record-set stores** — edges + embeddings rows removed by the resolved recordId set (embeddings per model file).
4. **Rebuild** — aggregate caches with no provenance are deleted and re-derived via their existing sole-writer scripts (entity-index, cards, markers, renderings, job-names, prose-jobs, ontology, drift), then `populate-frames` re-runs through the churn gate (substrate refreshed, candidate cleared). Rebuilds run async post-response; the receipt lists them as `queued`.
5. **Tombstone, never delete, the human layers** — append a purge event to `hitl-events.jsonl` and a tombstone row (`purge-tombstones.json`: docId, requestedBy, at, layers) so the audit trail says *what* was removed without retaining content. Append-only overlays are left intact (they reference names/ids, not content).
6. **The receipt is the product**: response = per-layer outcome `{layer, action: deleted|filtered|queued-rebuild|tombstoned, count}`. Partial failure → the receipt says exactly which layer failed and the endpoint is safely re-runnable (idempotent by design: every step keys off documentId/recordId presence).
7. **Auth**: dedicated `DOCUMENT_PURGE_PATH_PATTERN` → `decisionLogAppAuth`, pinned in `test-threshold-bearer-audit.ts` (the #414 discipline). Flag-gated `DATA_LIFECYCLE_ENABLED` (profile-parity rule: same PR adds it to `pilot-full`).

**`GET /api/export` (take-my-data):** one zip/tar stream assembled from the per-store readers — raw docs, index, decision log (with HITL state), extractions, edges, receipts projection, human overlays, org bundle, HITL triples (via `diff-export`), certificates/baselines. Manifest with per-file counts + schema version. Excludes: secrets (none live in the corpus — verified in 3b), other-tenant data (single-tenant today; slice-honesty note for the N1 future).

**Explicitly NOT in E1**: record-level purge (doc granularity only, v1); retention policies/TTL; GDPR workflow tooling (the endpoint is the mechanism; process is paperwork); encryption-at-rest (E3 ops-doc: DO volume/LUKS guidance — infra, not app code).

### Phase E2 — "Your data" section (Privacy panel, one-pair-of-eyes)

Below the posture rows: **Export my data** (streams the bundle, shows manifest counts), **Delete a document** (picker → the purge receipt rendered layer-by-layer — the receipt IS the UI), and the quiet standing line: what's stored, where, and the supersession tier ("hide from views — reversible") as the soft alternative next to the hard one. Verb canon respected: *Delete permanently* vs *Hide* — never ambiguous.

### Phase E3 — ops doc

`DATA-AT-REST.md`: volume encryption recipe per deployment shape (DO volume, LUKS, FileVault for the appliance), what the app does/doesn't do, and the honest statement that app-layer encryption is not v1.

## 3. Acceptance

- Purge a golden-corpus doc → every class-(a)/(b) trace gone (grep-verifiable), rebuilds converge, **other docs' HITL dispositions byte-identical** (the trap test), tombstone + hitl event present, receipt matches reality layer-for-layer.
- Re-run same purge → idempotent no-op receipt.
- Kill the process mid-purge → re-run completes; no layer stranded silently.
- Export → bundle re-ingests into a fresh corpus with record count parity (round-trip test).
- Negative control: purge a nonexistent id → 404, zero writes.

## 4. Risks

1. **False receipt** (the cardinal sin): a layer missed silently. Mitigation: the cascade map is the checklist; the acceptance greps every store; the receipt is generated from what was *done*, never from what was *planned*.
2. **Rebuild cost**: aggregate re-derives are LLM-free except marker/rendering caches (which lazily rebuild on demand anyway) — purge itself stays cheap; state this in the UI ("some summaries regenerate over the next hour").
3. **Concurrent ingest during purge**: v1 rule — purge takes the ingest lock (same serialization the ingest pipeline already uses).
4. **Scope seduction**: this WP is deletion + export, NOT retention automation, NOT legal-hold, NOT multi-tenant slicing.
