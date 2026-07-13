# WP-ORG-STATE-STABILITY — derived org-state stability (engine design brief)

**For:** AI-Light-Prototype (engine). **Date:** 2026-07-08. **Status:** DESIGN — no
implementation. **Author altitude:** strategy/audit; grounded in a 3-agent code sweep
of the frame/job derivation, keying, and overlay seams (symbols cited by file:line
below are real, mounted code — mostly in the `wp-idr-d0d-double-capture` /
`wp-job-namer-polish` worktrees, which carry the most complete frame code).

**Parent laws (all BIND):** cascade §2 (flags OFF by default, golden byte-equal when
OFF, event-sourced append-only overlays, propose-only / fail-closed-but-VISIBLE) ·
`ORG-STATE-PRESERVATION.md` (the no-more-regressions discipline; backup/restore tooling
already exists — this brief adds **detection + consent + forwarding**, not new backup) ·
CLAUDE.md flag-parity (any new flag ships in `pilot-full`, `server/engine-profile.ts`,
same PR — the drift-gate test enforces it).

**Coordinates with:** the learned-fold improvement thread (its Phase 0–4 locked
decisions). The fold must improve **proposals**, never silently rewrite a pilot's world;
this brief is the mechanism that makes that guarantee real (§5).

---

## §0 — The incident, corrected against the code

Forensics (memory `wp-readiness-thread`, this session): between 2026-07-02 and
2026-07-08, with **essentially zero new documents**, the Trisha threshold-eval forest
re-derived across wave-4b deploys such that the Jul-2 snapshot's frame **pair** —
`fid=2 "Vaccines Story Refresh"` (14 jobs) + `fid=3 "Vaccine Confidence & Narrative
Refresh"` (20 jobs), both under `fid=1 "Merck Above Brand"` — **dissolved**. Today's
single `"Vaccine Story Refresh"` frame holds 2 jobs from **neither** lineage, and
**29 of the pair's 34 job keys exist nowhere in today's forest** (mostly re-keyed, e.g.
`job:ep1-review-june-22` → the `us-non-22189` job). Work retained; identity churned.

Two corrections to the causal story, both load-bearing for the design:

1. **The re-derivation is operator-triggered, not boot/checkpoint-automatic.**
   `frames.json` is written **only** by `scripts/populate-frames.ts` (`saveFramesCache`,
   `frame-compiler.ts:381`). It is NOT rebuilt at boot and NOT part of `performCheckpoint`
   (`index.ts:1744`, which versions the *ontology/zone* partition, not frames). The
   engine's cardinal principle already forbids re-organization on ingest
   (`incremental-place.ts:4-5`: *"new documents NEVER trigger re-organization"*). So the
   churn entered through one of exactly **two vectors**, and a gate need only cover these:
   - `POPULATE_FRAMES_FORCE=1` (bypasses the skip), or
   - the **fingerprint was invalidated** because the upstream derived job-caches
     (`recordJobs`/`jobNames`) re-keyed — which is the same churn, one layer down (§1).
   *This is good news:* the derivation is a single, controllable chokepoint. The gate goes
   there, not scattered across boot paths.

2. **The `stability` field already in `frames.json` does NOT measure this.** `stability`
   (`frame-compiler.ts:309`, `0.912` in the Jul-2 snapshot) is **intra-run k-sample
   agreement** — pairwise co-assignment across the 3 LLM organizer samples *within one
   derivation*. Nothing in the codebase compares a new forest against the prior on-disk
   forest. **No prior-vs-new diff exists** — a clean seam.

---

## §1 — Root cause: three structural facts

**(a) No stable identity at any grain — identity is nominal/derived.**
- **Frames:** `fid` is a per-run sequential integer (`1,2,3…`); `parentFid` references it.
  It is re-assigned every derivation. Org-edits therefore reference frames **by name**
  (`ORG-STATE-PRESERVATION.md`: *"frames.json — the derived forest the org-edits reference
  BY NAME"*). A rename or merge orphans them.
- **Jobs:** keyed by a content-derived slug, two minting paths, both re-slug every run:
  - Veeva-anchored: `canonicalVeevaKey()` → `job:us-non-#####` (`hotlist-segmenter.ts:356`);
    else `job:${normalizeJobSlug(header)}` (`:276`).
  - Prose: first structured ID in the cluster, **else `slug(LLM name)`**
    (`prose-job-producer.ts:149`). The name is model output ("Title Case, ≤7 words"), so any
    wording drift re-keys.
  - The observed `ep1-review-june-22 → us-non-22189` transition is exactly this: a job once
    lexically slugged later acquired a Veeva anchor and jumped from the `job:<slug>` space
    into the ID space. There is even a *namespace* split hazard — `job:us-non-22189` (has
    `parentJob`) vs `entity:us-non-22189` (no `parentJob`, routed via `primaryEntity`,
    `grouping-resolver.ts:138`).

**(b) The fingerprint guard is the wrong shape for this failure.**
`computeFramesFingerprint()` (`frame-compiler.ts:371`) hashes the sorted set of **derived
job keys + names + prompt version**. Two consequences: (i) an upstream re-key *changes* the
fingerprint, so the exact churn we care about reads as "substrate changed" and **defeats the
skip** — recompute proceeds; (ii) when it recomputes, it is all-or-nothing with **no
structural diff and no consent**. The guard detects *substrate identity*, never *structural
stability*.

**(c) All downstream state references the unstable key as a raw string, and forwarding is
ephemeral.** Every subsystem stores `job:…`/`parentJob`/`entity:…` as a bare string:
org-edits moves (`frame-overlay.ts:271` `toJobKey`), canon merge/rename
(`grouping-resolver.ts:92` via `toCanonical`), ingest alias fold (`confirm-fact.ts:279`
`keyRemap`), vigilance receipts (`job-vigilance-receipt.ts:55`), priority grouping, frame
membership (`jobKeys`). **No durable old→new migration table exists** — forwarding is
recomputed each run and never persisted (`contrastive-pairs.ts:15`: *"There is no backfill
path"*). `incremental-place.ts:520-544` is the tell: it is an explicit *churn-avoidance
hack* — additive-never-rewrite, faking the freshness fingerprint (`:540`) — that
acknowledges (`:537-539`) a full re-derivation *"could re-key placed jobs — exactly the
churn the cardinal principle forbids."* Operator re-derivation has no equivalent guard.

**The load-bearing asset:** **records are stable.** Record ids are doc-anchored and survive
re-derivation even when the job/frame that contains them re-keys. Anchor identity to the
record layer and the whole problem becomes tractable (§3).

---

## §2 — Deliverable 1: the CHURN GATE at the derivation checkpoint

**Placement.** One chokepoint: in `populate-frames.ts`, **between `compileFrames()`
(candidate forest) and `saveFramesCache()` (commit).** Nothing else writes frames.

**Posture — copy `ingress-magnet`, not invent.** The engine already ships the
propose-don't-enact discipline: *"The model proposes; the math disposes … acting on the
corpus is a separate human-ratified step surfaced as 'apply?', not here"*
(`ingress-magnet.ts:11-26`). The gate holds the candidate as a **proposal**; committing it
is a separate human step. This is the §5b propose-don't-enact posture with a real code home.

**The two-fingerprint discrimination (the crux).** The fire condition is *structural churn
on an unchanged-corpus window*. "Unchanged corpus" MUST be measured on **source content**,
not the derived-key fingerprint (which the re-key defeats, §1b). So the gate computes two
things:
- `corpusContentFingerprint` — hash over the **source** layer (index.json doc ids +
  per-doc content digests). Independent of how jobs are keyed. *New* input ⇒ this changes.
- `structuralChurn` — a diff of candidate forest vs prior `loadFramesCache()`, at two grains:
  - **Job-membership churn:** reuse the co-assignment metric already in `compileFrames`
    (`:304-309`, `topPart`/pairwise-agreement) but apply it **between prior and candidate**
    instead of within-run samples — same math, cross-derivation. Correspondence between a
    prior job and a candidate job is by **record-set overlap** (Jaccard over composing
    record ids — stable even when the key churns), NOT by key string.
  - **Frame-topology churn:** frames matched prior↔candidate by (name ∪ membership); count
    dissolved / merged / split / added frames.

**Gate logic.**

| corpus content | structural churn | action |
|---|---|---|
| unchanged | below threshold | **auto-commit** (normal path; byte-equal when nothing moved) |
| unchanged | **above threshold** | **HOLD** — this is pure derivation drift / re-key. Do not overwrite. |
| changed | any | commit, but **still emit the migration map** (§3) so overlays survive the legitimate re-org |

**HOLD semantics (fail-closed-but-VISIBLE).** On HOLD, `populate-frames` does **not**
overwrite `frames.json`. The prior forest stays live. The candidate is written to a shadow
path (`_metadata/frames.candidate.json`) and a **ratification ask** is emitted — modeled on
the Question Engine's sidecar: a proposal keyed by a **content-hash anchor**
(`question-state-types.ts` `QuestionStateSidecar` is already keyed by `SHA(anchor)`, the
exact position-independent pattern we want), lifecycle `open → accepted|archived`, surfaced
via a read endpoint (mirror `GET /api/questions`). On **accept** → promote candidate to
live **and** persist the old→new job-key migration map the diff already computed (§3). On
**reject** → discard candidate; prior stays. The exact merge-question ("should these two
vaccine frames become one?") is thereby **asked before it is enacted** — which is precisely
what died unasked in the incident.

**Threshold ownership.** Ross sets the churn threshold per-corpus, exactly like the §5b
`_metadata/stage-precision.json` gate: an append-only ruling file
(`_metadata/churn-gate.json`), no entry ⇒ conservative default (HOLD on any frame
dissolve/merge or >X% re-key on an unchanged corpus). This keeps the human in the loop
without hard-coding a magic constant.

**Flag & diagnostics.** `FRAMES_CHURN_GATE_ENABLED`, default OFF ⇒ `populate-frames`
behaves exactly as today, `frames.json` byte-equal (reader module in the
`ingress-magnet.ts:52` style; **added to `pilot-full` in `engine-profile.ts` same PR** per
the drift-gate). Register the flag in `DiagnosticsResponse.flags` and add a `computeWarnings`
entry (`diagnostics.ts:449`, which already warns on cache-vs-flag mismatch) that fires while
a HELD candidate awaits ratification — so `/api/diagnostics` featurePosture shows a pending
ask rather than silence.

---

## §3 — Deliverable 2: STABLE NODE IDENTITY

Anchor identity to the **stable record layer**. A job's identity is a hash over its
**composing record-id set**, not its slug:

```
stableJobId = sha256(sorted(composingRecordIds)).slice(0,16)
```

This is position- and slug-independent: it survives re-slugging and Veeva-anchor
acquisition because the underlying evidence set is unchanged. It is the same idea the
Question Engine already uses (`QuestionStateSidecar` keyed by `SHA(canonicalAnchor)`) and
the AnnotationOverlay's *"systemAssignedClass is locked on first-touch and never
reassigned"* invariant (`annotation-overlay-store.ts:283`) — human/anchor judgment is never
silently overwritten by a re-derivation.

Ship in two phases; **B first** (it rescues the least-recoverable state and is additive), A
as the durable end-state.

**Phase B (ships first) — persist the key-migration map.** The churn-gate diff (§2) already
computes prior↔candidate job correspondence by record-set overlap. Emit it as a **persisted,
append-only forwarding record** — the thing §1c proved does *not* exist today:

```
_metadata/job-key-migrations.jsonl   # mirrors hitl-events.jsonl
{ ts, fromKey, toKey, stableJobId, evidence:{sharedRecordIds, jaccard}, ratifiedBy }
```

- **Correspondence rule:** prior job P ≡ candidate job C iff `jaccard(records(P),records(C))
  ≥ τ`. Splits/merges recorded as 1→N / N→1 rows with evidence (mirrors the fold's
  merge/reparent semantics, so it composes with Phase 0 of the fold thread).
- **Fold-at-read resolution:** every keyed resolver — `frame-overlay.applyRecordMoves`,
  `grouping-resolver.jobKeyForRecord`/`toCanonical`, `confirm-fact.foldAliasedJobs`,
  `job-vigilance-receipt` — forward-resolves `fromKey → … → toKey` through the migration
  chain before matching. Same fold-at-read pattern as `sop-edits.loadCorrectedRecords()`
  (`sop-edits.ts:192`), which already maps overlays over the cache **without mutating it**.
  Flag OFF ⇒ empty map ⇒ byte-equal behavior.
- **Why persisted, when everything else is derived-at-read:** the map is the *one* artifact
  that cannot be recomputed after the fact — once `frames.json` is overwritten, the old
  forest is gone and the correspondence is unrecoverable. So the map is persisted **at the
  ratification/commit moment** (the consent point); everything else stays derived-at-read.

**Phase A (durable end-state) — decouple identity from slug.** Stamp each job with its
`stableJobId` in `frames.json` and the job caches; keep `job:<slug>` as a **display/routing
label** that may churn freely. New overlay/canon/receipt writes key on `stableJobId`; the
migration map becomes the compatibility shim for pre-existing slug-keyed events. This removes
the failure class permanently but touches every keying site §1c enumerated — hence it
follows B, not precedes it. Frames get the same treatment (a `stableFrameId` over their
dominant record set), retiring the by-name reference.

**Recommendation:** B now (additive, saves the pilots, reuses the diff we build for §2), A
next quarter (removes the class). One insight unifies them: `stableJobId` IS the record-set
anchor; the migration map is just "which slug carried this anchor, per derivation."

---

## §4 — Deliverable 3: migration story for existing pilots

The Trisha pilot is mid-incident — today's forest already re-keyed; the Jul-2 snapshot
(`~/scratch/trisha-pass-corpus`, 13 frames) + its org-edits are the prior truth. Three steps,
all using tooling that already exists plus the one new reconciler:

1. **Backfill the map for churn that already happened (one-time, offline).** Run the §2 diff
   between the Jul-2 snapshot forest and today's forest (both on disk) to produce the old→new
   job-key map by record-set overlap; write it as the seed `job-key-migrations.jsonl`. This
   retroactively reconnects any org-edits/canon/receipts that reference dead keys — adding the
   "backfill path" `contrastive-pairs.ts:15` says is missing, as a **migration tool**, not a
   runtime path.
2. **Adopt the gate going forward.** Flip `FRAMES_CHURN_GATE_ENABLED=true` for the pilot
   corpus (after Ross rules the threshold in `churn-gate.json`). The next `populate-frames`
   run then HOLDS and asks instead of silently committing.
3. **Fold into the org-state bundle.** Add `job-key-migrations.jsonl`,
   `frames.candidate.json`, and `churn-gate.json` to the backed-up set in
   `org-state-backup.sh`. `launch-engine-3020.sh` already auto-backs-up before launch; the
   gate makes re-derivation *after* a version swap unable to silently reorganize — closing the
   version-swap-reset incident class at its root rather than by restore-after-the-fact.

Constraints honored throughout: flags OFF ⇒ byte-equal; overlays append-only + event-sourced;
backup/restore untouched (this adds detection + consent + forwarding); §5b propose-don't-enact
for the HOLD.

---

## §5 — Coordination with the learned-fold thread

The fold's locked invariants (WP-Learning-Engine-Capability-Brief §1, §6.3) are: *derived-at-
read* (signals are a recomputable cache over `OrgEditEvents`), *soft-prior-not-hard-fact*
(**hard overlay — explicit edits — always wins**), *anti-self-training*, *reversibility*.
Two dependencies run **both ways**:

1. **This brief is a precondition for the fold's central guarantee.** "Hard overlay always
   wins" only holds if the overlay's **target survives re-derivation**. Today it does not: an
   `OrgEditEvent.toJobKey` (`frame-overlay.ts:271`) points at a job key that re-keys, so on
   the next operator run the hard edit silently **detaches** — it becomes a no-op or a
   `SignalConflict` against a phantom job. Deliverable 2 (stable id + migration map) is what
   makes the fold's "explicit edit wins" true across derivations. Flag this as a hard
   dependency on the fold's Phase 0 (structural-edit learning): Phase 0 *assumes* edit targets
   persist; without §3 that assumption is false on any `populate-frames` run.
2. **The churn gate IS the enforcement of "fold proposes, doesn't enact."** As the fold
   improves (Phase 3–4: semantic retrieve+veto, LLM judge, disjunction discovery) it will
   *want* to reorganize. The gate routes that reorganization through a **ratification ask**,
   not a silent commit — exactly the thread's stated goal ("the fold should improve
   PROPOSALS, not silently rewrite a pilot's world"). The fold's better forest becomes a
   *candidate* the human accepts; it never overwrites live state unasked. No new posture for
   the fold to invent — it emits candidates; the gate holds and asks.

Net: build §3 (stable id / migration map) **before or with** the fold's Phase 0 landing, and
wire the fold's re-org output through the §2 gate rather than direct to `saveFramesCache`.

---

## §6 — Open decisions for Ross

1. **Phase B vs A ordering** — recommend B (map) first, A (decoupled id) next quarter. Confirm.
2. **Churn threshold shape** — start with a categorical default (HOLD on any frame
   dissolve/merge, or >X% re-key on an unchanged-corpus window) rather than a single scalar?
   Recommend categorical; scalar is brittle.
3. **Jaccard τ for record-set correspondence** — needs a calibration read on the Jul-2↔today
   pair (we have both forests on disk; §4 step 1 is also the calibration run).
4. **Frame identity in Phase A** — stamp `stableFrameId` and retire by-name org-edits now, or
   defer frames and stabilize jobs first? (Jobs are the acute case; frames can lag.)

---

## §7 — Sequencing & acceptance

**Sequence:** §4.1 reconciler (offline, no engine change — also the τ calibration) →
Deliverable 2 Phase B (migration map + fold-at-read resolvers, flag OFF, golden byte-equal
test) → Deliverable 1 churn gate (diff + HOLD + ratify endpoint, flag OFF) → shadow-run on the
Trisha corpus (`FRAMES_CHURN_GATE_ENABLED=true`, :3020 harness) → Ross rules the threshold →
Phase A (decoupled id) as a follow-on WP.

**Acceptance = replay the incident under the gate.** Point `populate-frames` at the Jul-2
snapshot as prior and let it re-derive today's inputs with the gate ON: it must **HOLD** the
Jul-2 forest live, write `frames.candidate.json`, and surface the vaccine-pair merge as an
`open` ratification ask carrying the record-set evidence — with the `job:ep1-review-june-22 →
us-non-22189` forwarding row present in `job-key-migrations.jsonl` so a hand-edit against the
old key still resolves. That is the incident, caught and consented instead of silently
enacted.

## §8 — Explicitly out of scope (v1)

- LLM re-planning inside the gate (the gate diffs and holds; it does not re-organize).
- Cross-corpus / federated identity (N1/N2 sharing keys on the same substrate — its own WP).
- Auto-tuning the threshold from outcomes (Ross rules it; calibration-from-history is later).
- Purge/erasure of migration history (sovereignty item; tracked in the integrations thread).
- Frame Phase-A stabilization if §6.4 defers it.
