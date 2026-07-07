# Organization-state preservation — the no-more-regressions discipline (2026-07-07)

**Why this exists:** three separate incidents made Trisha's/the corpus organization
LOOK like it regressed, and none was the categorization engine getting worse:

1. **Version-swap resets** (documented in `HANDOFF-Trisha-WorkForest-Feedback.md`
   Issue 5, 2026-06-30): local version spin-ups reset the corpus AND the
   org-edits overlay — Trisha's hand-categorization was wiped, twice.
2. **July-5/6 corpus-copy incident:** the copy silently dropped
   `job-names.json`/`prose-jobs.json` → Log collapsed to raw doc keys → a forest
   re-derivation against the empty job set compiled 8 junk frames.
3. **July-7 engine relaunch:** an unexpanded `~` in `env META_PROJECT_PATH=~/...`
   pointed the engine at a nonexistent dir; it served 200s with zero caches.

## The bundle (what must never be silently lost)

`<corpus>/reference/_metadata/`:
- `org-edits/<viewer>.json` — the user's hand-corrections (append-only overlay;
  the highest-value, least-recoverable state)
- `project-canon.json` — renames + merges (user-authored)
- `frames.json` — the derived forest the org-edits reference BY NAME
- `job-names.json`, `prose-jobs.json` — the derived job caches (their absence
  collapses the Log and poisons any re-derivation)
- `record-class-overlay.json` — the paid classification backfill

## The tooling (all in `~/scratch/`, executable)

| Script | What it does |
|---|---|
| `org-state-backup.sh <corpus> [dest]` | tars the bundle to `~/scratch/org-state-backups/` with a timestamp |
| `org-state-restore.sh <corpus> <tgz>` | restores a bundle (refuses while :3020 serves; auto-snapshots what it overwrites) |
| `launch-engine-3020.sh [corpus]` | THE way to (re)launch the harness engine: absolute paths only, pre-flight corpus check, **auto-backup before every launch**, runs the integrity gate after and reports OK/FAIL |
| `verify-corpus-integrity.sh <corpus> <url>` | the review gate — files present + engine actually serving them. Never review/UAT against a FAIL |

## The laws

1. **Before any version swap or corpus reset:** `org-state-backup.sh <corpus>`.
   After: restore the bundle (or at minimum `org-edits/` + `project-canon.json`)
   so hand-corrections survive.
2. **Engine relaunches go through `launch-engine-3020.sh`** — never the
   hand-typed env recipe (the `~`-expansion landmine lives there).
3. **No review/UAT against a harness whose gate doesn't print OK** (standing law
   since 07-06; two incidents were caught by exactly this).
4. Engine-side guards filed as
   [AI-Light-Prototype#392](https://github.com/rosscantrell/AI-Light-Prototype/issues/392)
   (populate-frames refuses an empty job set) and
   [#393](https://github.com/rosscantrell/AI-Light-Prototype/issues/393)
   (fail loudly on unresolvable META_PROJECT_PATH).

## Current baseline (verified 2026-07-07)

The harness serves the Trisha-validated June-25 forest (13 frames: Merck Above
Brand + 4 nested workstreams, LAA + 3, GAVI/RSV/AZ) with jobNames=74 /
recordJobs=280. **No org-edits overlay exists** — her 6/30 hand-corrections were
lost to version swaps before this discipline existed and must be redone once
(the correction tools — nested create, re-home/reparent, sub-frame merge — are
all live in the app now). First bundle snapshot taken 2026-07-07 14:50.
