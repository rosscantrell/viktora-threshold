# WP-CHURN-GATE — build dispatch (stable frame identity + churn gate)

**Date:** 2026-07-13 · **Status:** DISPATCH — design already ruled, this is the
build order · **Repo:** AI-Light-Prototype (engine) · **For:** a fresh build
session/agent (senior engineer profile), coordinated through commits.

**Design of record:** `WP-ORG-STATE-STABILITY-BRIEF-2026-07-08.md` (committed
alongside this dispatch — it was previously untracked in a worktree; treat the
committed copy as canonical). Everything in that brief BINDS: the three
deliverables, the parent laws (flags OFF by default, golden byte-equal when
OFF, event-sourced append-only overlays, propose-only, fail-closed-but-VISIBLE,
flag-parity/drift-gate), and its §0 causal corrections. This dispatch adds the
2026-07-13 state, the priority ruling, and phase gates — it does not re-open
the design.

## Why now (what changed since 2026-07-08)

This work graduated from "queued hardening" to **the single remaining hard
blocker** for the per-frame companion architecture, by agreement of all three
coordinating sessions (work-forest categorization, MCP-companion enhancements,
companion-network — 2026-07-13):

1. **Per-frame companions** (Ross's direction): a companion is bound to a frame
   via a `companion:<frameKey>` bearer grant with a frame entitlement slice. A
   companion bound to identity that `populate-frames` reassigns wholesale loses
   its thread — doctrine, staged work, and question provenance all dangle.
2. **oneQuestion receipts** (WP-ONEQUESTION, same date): "since you confirmed
   CR2 = Sora, I filed 2 jobs there" must survive the next forest recompile,
   or receipts become lies. The org-edit overlay already survives by frame-NAME
   matching — a rename or re-key silently orphans it.
3. The slice-honesty prerequisite is DONE (engine PR #404, c5b49cb) — this is
   the only blocker left.

## Verified current state (2026-07-13, origin/main be99596 + today's merges)

Re-verified by a code sweep this session; consistent with the design brief's §0:

- `populate-frames.ts` **replaces `frames.json` wholesale** and reassigns
  numeric `fid`s per compile; writes whenever `result.frames.length > 0`
  (`scripts/populate-frames.ts:157,160-167`). The `stability` field is
  intra-run k-sample agreement — **no prior-vs-new diff exists anywhere**.
- The only skip is `computeFramesFingerprint` (substrate job-key set + names,
  `frame-compiler.ts:371-375`) — which hashes DERIVED job keys, so an upstream
  re-key defeats its own skip (the Trisha 29/34 re-key incident).
- User structure survives only as the read-time org-edit overlay, matched **by
  frame name** (`frame-overlay.ts:160-169`).
- Recompute triggers: operator by hand; E4 `maybeRefreshDerivedCaches` at
  check-in when `frames-dirty.json` pending (2h debounce, detached spawn).
  Ingest never recompiles inline. Single chokepoint = good for gating.
- Records are stable (doc-anchored); jobs/frames have no persistent id. Anchor
  identity to the record layer (the design brief's load-bearing insight).

## Deliverables (from the design brief, phased)

**Phase 1 — stable job identity.** Record-set anchor hash per job + persisted
`job-key-migrations.jsonl` (append-only): when a re-derivation re-keys a job
whose record set (or its dominant subset, per the brief's spec) is unchanged,
emit a migration entry old→new instead of silently orphaning. Read paths
(org-edit overlay, question factKeys, heat, SoP) resolve through the migration
map. Include the backfill map story for existing corpora + adopt gate.

**Phase 2 — the churn gate at the chokepoint.** In `populate-frames`: diff the
candidate forest against the prior `frames.json` (frame-level: dissolved /
renamed / merged / membership-churn beyond a derived band; job-level: re-key
count net of Phase-1 migrations). Under an unchanged-corpus window (no new
docs since prior compile), structural churn above the band ⇒ **HOLD**: write
the candidate to a sidecar (`frames.candidate.json`), keep serving the prior
forest, surface a fail-closed-but-VISIBLE review affordance (diagnostics +
packet intake note + a ratify endpoint). Ratify applies candidate + migrations;
reject discards with a receipt. New docs present ⇒ gate loosens per the brief's
spec (organic growth is not churn).

**Phase 3 — org-state bundle integration.** Migrations + candidate sidecar join
the `org-state-backup.sh` bundle; restore replays cleanly.

## Gates & discipline

- All new behavior behind one flag (suggested: `FRAME_CHURN_GATE_ENABLED`),
  default OFF, enrolled in `pilot-full` **same PR** (drift-gate enforces);
  flag OFF ⇒ byte-identical `populate-frames` output (pin it).
- No LLM anywhere in the gate/identity path — deterministic diffs and hashes
  only. No wall-clock in fold/replay paths (corpus-horizon discipline).
- Thresholds are derived slots (corpus's own churn distribution), never tuned
  constants — learned-not-hardcoded house rule.
- Pre-registered acceptance: replay the Trisha Jul-2→Jul-8 incident corpus
  pair (snapshots exist per the forensics thread): Phase 1 must migrate ≥the
  29 re-keyed jobs' identities or hold them; Phase 2 must HOLD that
  re-derivation under the unchanged-corpus window. A normal compile with new
  docs must pass un-held (negative control). If the derived band fails these
  fixtures, STOP and report — do not refit against them.
- Engine repo has no CI: the bar is the full local suite + tsc baseline; work
  from a fresh worktree off origin/main; `npm install` in the worktree before
  trusting tsc (stale node_modules trap).
- Coordinate: WP-ONEQUESTION (PR-1 in flight) touches the question store and
  packet — no shared files expected beyond flag registries; rebase order is
  whoever lands second. Message the work-forest categorization session at PR
  time.

## What depends on this landing

Per-frame companion pilot (bearer grants, frame-scoped passes, `stage_prework`
frame provenance), durable oneQuestion receipts, and any future increase in
recompile frequency (E4 already fires at check-ins — today every firing is an
unguarded coin-flip).
