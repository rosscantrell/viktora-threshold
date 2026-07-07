# HANDOFF — Threshold app + engine UAT push, 2026-07-07 (evening)

**For:** the successor session taking over the Threshold polish → pixel pass →
Trisha UAT → v0.9.1 release push.
**From:** the 2026-07-06/07 session (successor to the terminated coordinator —
its handoff, `HANDOFF-THRESHOLD-UI-2026-07-06.md`, remains binding for posture
and history; THIS file is current state). Verify everything below before
building on it; the verification commands are inline.

---

## 0. OPERATING POSTURE (binding, Ross-ruled — do not relax)

1. **Frontend = ONE pair of eyes.** One visual change → render it (shim
   harness or live app) → look → next. No agent fan-out for anything
   user-visible. Agents build well-specced plumbing only (engine modules,
   deterministic producers) and get explicit Bash timeouts + `| tail -40` on
   every long command (two agents stalled without this).
2. **Native changes: byte-verify the RUNNING binary** (`lsof -p <pid> | grep
   txt` → `grep -ac "<unique-string>" <path>`), probe state before changing
   it, live-test transitions. Never claim from build output.
3. **Small PRs, each leaving the app visibly better.** Commit locally in a
   worktree; verify; push; PR; merge (Ross has delegated merges — pattern
   holds until he says otherwise); `git pull` in the primary checkout after.
4. **Evidence over theory.** This session closed a 3-session-old bug by
   proving the app innocent (the "halo" was an Apple Notes text selection
   behind the pill). Reproduce what Ross sees before diagnosing; when a claim
   matters, measure the API/window-server/file, don't read the screenshot.
5. **Surface every trade and every incident immediately.** Ross forgives
   mistakes surfaced with evidence and containment; he fires sessions that
   paper over.
6. **Before ANY review/UAT against a harness corpus:**
   `~/scratch/verify-corpus-integrity.sh <corpus> <engine-url>` must print OK.
   (Born from today's incident — see §4.)

## 1. REPO STATE (verify: `git fetch origin && git log origin/main --oneline -3`)

### viktora-threshold — main @ `3eda2f3` (#99)
Merged this session, newest first:
- **#99** name-ask card refit to the ONE question-card grammar (statement +
  Question tag + "Why I'm asking" + canon Snooze/Dismiss; localStorage
  `nameask-suppress`).
- **#98** record-class app half: `recordClass==='not-a-commitment'` suppressed
  at the shared chokepoint (`withoutDismissed`).
- **#97** board gate retired at ≥1200px (queue + needs-attention board render
  together; narrow keeps the WP-R2 focus gate). Debounced resize re-reconcile.
- **#95** queue capped at 4 + "Show all N →"; `.watching-reasons[hidden]` fix
  (dismiss-as pickers rendered open on every card); "Dismiss as" sentence-case.
- **#94** workspace window OPAQUE on expand / transparent on collapse (the
  green-button fullscreen fix candidate — AWAITING Ross's verification click);
  boot styleMask captured + restored on collapse (fixes click-and-hold pill
  resize); `[fs-poll]` 60s transition poller after every expand.
- **#91/#92** halo instrumentation: underPageBackgroundColor cleared (kept as
  hygiene), probe v4 (full view-tree dump + `[page-probe]` page-side paint
  report). Bug 1 CLOSED as external (Notes selection).
- **#89/#90** WP-NAME-ASKS app half: 4th queue source + ask card + save →
  existing `project_canon_rename` (backend mints fresh keys); honest code
  labels (`US-NON-22189`, mask retired); aliases+jobNames+recordJobs plumbed
  into Today's grouping + one-shot board re-render (board went 3 → 10+ correct
  groups on the real corpus).
- **#87/#88** expand opens 1280×860 (monitor-clamped 88%, floor 720×560),
  `[expand] initial size` probe; rail un-stickied (it floated over the board
  on scroll).
- **#83/#85/#86** WP-READINESS app half: "no draft observed" badge on
  Coming-up rows; `outbox_heads_up` Rust cmd + amber "Draft heads-up to
  client" on flagged rows; `.log-row-actions .btn-link` position fix; guide
  updated.
- **#84/#96** USER-GUIDE.md + 16 real screenshots (`docs/user-guide-assets/`);
  Log screenshot re-shot post-restoration.
- **#77/#79** (previous evening) read|act composition + quiet report; SoP
  digest + compact accent-bar cards.
- **#93** (Ross's own) email-capture owner prompt.
Docs on main: `HANDOFF-THRESHOLD-UI-2026-07-06.md` (posture + failure
patterns), `MOCKUPS-THRESHOLD-UI-2026-07-06.html` (BINDING acceptance bar),
`PIXEL-PASS-RUBRIC-2026-07-06.md` (the gradeable checklist), `USER-GUIDE.md`.

### AI-Light-Prototype (engine) — main @ post-#388
- **#385** WP-R-a readiness: `readiness: active|quiet|no-precursor` on due-soon
  OPEN commitments (`READINESS_ENABLED`, default OFF, byte-equal off) +
  `dueSoonNotReady` summary count. Pinned-clock Brian fixture = the logic
  replay.
- **#386** WP-R-b heads-up: `POST /api/outbox/heads-up {recordId}` →
  deterministic no-blame client draft staged to outbox; never leaks readiness
  internals (fixture-tested).
- **#387** WP-NAME-ASKS producer: `GET /api/project-canon/name-asks`
  (`NAME_ASKS_ENABLED`, default OFF) — unnamed code-shaped project keys with
  ≥3 open records; self-clears via canon resolution.
- **#388** derived-cache sentinel: startup banner when job/frames caches are
  missing while their features are enabled.
Also pre-existing, exercised today: `RECORD_CLASS_ENABLED` (binary junk gate,
v2.0 per Ross's ruling; `scripts/backfill-record-class.ts`), project-canon
rename/merge/unmerge (default ON), `scripts/populate-frames.ts` (forest
compiler — reads the LIVE job set; garbage-in if jobs are empty).

## 2. LIVE PROCESSES (verify each; PIDs WILL have changed)

- **Dev app**: `nohup npm run tauri dev` from `~/Projects/viktora-threshold`
  (primary checkout, branch **main** — keep it there; frontend is live-served
  from `src/`, Rust changes auto-rebuild + relaunch). Check:
  `pgrep -f "target/debug/viktora-threshold$"` (must be exactly 1). stderr →
  `~/scratch/threshold-chrome-probe.log` (ALL probes land here: `[chrome*]`,
  `[tree]`, `[page-probe]`, `[frames]`, `[fs-poll]`, `[expand]`, `[persona]`,
  `[halo-fix]`).
- **Engine :3020**: `~/scratch/engine-main-review` worktree on engine main,
  serving `~/scratch/trisha-pass-corpus`. **The env is load-bearing** — the
  canonical relaunch (every var matters; omissions this session silently
  degraded SoP and broke captures):
  ```
  cd ~/scratch/engine-main-review/schema-browser && \
  env PORT=3020 META_PROJECT_PATH=~/scratch/trisha-pass-corpus \
    ANTHROPIC_API_KEY=<from AI-Light-Prototype/.claude/launch.json> \
    INGESTION_API_KEY=ss \
    ENABLE_DECISION_LOG=true ENABLE_DECISION_LOG_EDITOR=true \
    ENABLE_ENTITY_CARDS=true ENABLE_PRIORITY_OPERATOR=true \
    ENABLE_QUESTION_ENGINE=true ENABLE_SYNTHESIS=true \
    ENABLE_COHESION_OPERATORS=true AUTH_ENABLED=false \
    COORDINATION_FRAMES_ENABLED=true EMAIL_ONRAMP_ENABLED=true \
    EMBEDDINGS_ENABLED=true JOB_VIGILANCE_ENABLED=true \
    PROSE_JOBS_ENABLED=true SOP_CLAIM_RECEIPTS_ENABLED=true \
    SOP_COMPOSE_ENABLED=true VIGILANCE_VOID_ENABLED=true \
    WORKFOREST_SOP_ENABLED=true READINESS_ENABLED=true \
    NAME_ASKS_ENABLED=true RECORD_CLASS_ENABLED=true \
    nohup npx tsx server/index.ts >> ~/scratch/engine-3020-readiness.log 2>&1 &
  ```
  (`INGESTION_API_KEY=ss` = the dev app's bearer from
  `~/Library/Application Support/Viktora Threshold Dev/config.json`.)
- **Shim harnesses** (browser pixel-checks without the native app; preserved
  durably at `~/scratch/threshold-shim-harness/`): `server.mjs` serves a src/
  dir with a `__TAURI__` shim proxying :3020. Env: `HARNESS_PORT` (4651/4652),
  `HARNESS_SRC_DIR` (point at YOUR worktree's src), `HARNESS_EMPTY=1`
  (typed-empty backend = quiet states), `HARNESS_READINESS_DEMO=1` (due-soon +
  readiness fixtures + name-ask/rename stubs). `mock.js` (`?mock=a|b|c|d`) is
  the historical design-option layer — superseded by production, keep for
  archaeology. **Browser caching bites: recreate the preview context (stop/
  start) after changing served JS, or cache-bust the page URL.**

## 3. THE CORPUS (`~/scratch/trisha-pass-corpus`) — state + history

DISPOSABLE copy of Trisha's corpus. Current derived state (all verified):
- `job-names.json` + `prose-jobs.json` **restored from
  `~/scratch/trisha-corpus-restore/_metadata/`** (the July-5/6 copy had
  dropped them — see §4). Serving: jobNames=74, recordJobs=280.
- `frames.json` = the June-25 13-frame forest (restored; the July-6
  re-derivation — 8 abstract frames, compiled against the then-empty job set —
  is backed up at `frames.json.bak-jul6-rederivation`).
- `project-canon.json`: one rename — Ross named `us-non-22189` → **"Ep1
  Review"** (10:44 today). ⚠ OPEN BUG: the name-ask for that key may STILL be
  served post-rename (last check showed it asking) — the producer's canon
  resolution on doc-project keys needs verification (§5.3).
- Record-class overlay APPLIED (195 commitments → 175 action / 20
  not-a-commitment / 0 parse fails; 10.3% junk, ZERO junk in the urgent 25).
- Two UAT seed docs (`uat-seed-brian-0707a`, `uat-seed-deckdraft-0707b`)
  captured via the real `/api/ingest-document` path → 5 records incl. 3
  due-soon commitments carrying `readiness` (the Brian-scenario demo rows).
  Remove before any "pristine" demo, or keep for the readiness walkthrough.
- Trisha's REAL corpus/droplet: never touched by any of this.

## 4. THE CORPUS INCIDENT (context for §3; full detail in memory + PR #388)

The July-5/6 harness corpus copy silently dropped the two job caches. Chain:
empty job resolution → Log collapsed to 44 raw doc-keys ("Unframed"
everything) → the July-6 forest compile ran on the empty job set → 8 junk
frames. It presented as a product regression of the Trisha-UAT'd Log; Ross
caught it by memory ("finished at release 8/9"); diagnosis burned a review
cycle and two wrong theories. Fixes now standing: the restore (§3), the
engine startup sentinel (#388), the local gate
(`~/scratch/verify-corpus-integrity.sh`), and the recipe memory. Treat
anything validated 2026-07-05→07-07-morning against this harness as suspect
until the pixel pass re-covers it.

## 5. OPEN WORK (the successor's queue, in order)

1. **Bug 2 verdict (green-button fullscreen).** Fix candidate SHIPPED (#94:
   opaque workspace window). Ross owes one green-button click; `[fs-poll]`
   prints the transition every 500ms for 60s post-expand. Read the trace, then
   either close bug 2 or fix from the measurements. (Two pre-fix traces showed
   the window never resizing, `is_fullscreen()=false`, black letterbox.)
2. **PIXEL PASS** — the committed step-2 of the release sequence. Rubric:
   `PIXEL-PASS-RUBRIC-2026-07-06.md`; put `MOCKUPS-THRESHOLD-UI-2026-07-06.html`
   literally beside each surface; 4 widths × empty/full/error; ONE annotated
   defect list. Run against the RESTORED corpus only (integrity gate first).
3. **Fix pass** — closes the pixel-pass list, plus already-known items:
   overlay titlebar reinstatement (mockup 1 — `body.titlebar-overlay` + 78px
   nav offset + live drag/focus/fullscreen verification; the headliner);
   verify the name-ask self-clear after rename (§3 ⚠); Today board label for
   un-renamed job-code keys (check whether `job:` prefix join now covers it);
   dead-space check at true fullscreen.
4. **Merge-ask producer** (Ross approved interest): the name-asks sibling —
   deterministic near-duplicate project keys ("laa" vs
   "lung-ambition-alliance", singular/plural) → combine-asks in the queue →
   existing canon merge route. Same build pattern as name-asks (engine
   producer via agent + card by hand + live round-trip).
5. **Engine/eval-lane items (file, don't do, unless told):** frame-compiler
   quality (June-13-frames vs July-8-frames evidence is in this file + memory);
   forest re-derivation now that jobs are restored (`populate-frames.ts`,
   POPULATE_FRAMES_FORCE=1 — coin-flip, June backup exists); extraction
   minting near-duplicate project keys; server-side counts (summary/SoP) still
   include not-a-commitment records (app suppresses, server doesn't); QE
   `confirmName` question type as the structural home for name-asks.
6. **Release sequence** (unchanged from the July-6 handoff): Ross review →
   Trisha's pass (her 20-card record-class sample gates her droplet's
   RECORD_CLASS at ≥95%; the Brian-scenario demo = the readiness rows in §3)
   → deploy (ross droplet: RECORD_CLASS + SOP_CLAIM_RECEIPTS +
   IDENTITY_LEDGER canary; READINESS/NAME_ASKS are new flag candidates — Ross
   decides) → v0.9.1 installer (version drift: package.json 0.8.1 vs
   Cargo/tauri.conf 0.9.0 — reconcile at cut).

## 6. LANDMINES LEARNED (cheap to re-hit, expensive to re-learn)

- `.btn-link { position:absolute; top:4px; right:0 }` global — EVERY new
  btn-link needs `position: static` (three fixes this session).
- Class rules with `display:flex` outrank `[hidden]` — add explicit
  `[hidden] { display:none }` guards (dismiss-as pickers, outbox tray).
- macOS has NO `timeout` binary; use the Bash tool's timeout parameter.
- objc2 `msg_send!` + ObjC exceptions = process abort. `valueForKey:` on an
  unexposed key crashed the app once. `respondsToSelector`-guard EVERYTHING
  in probes; probes must never be able to kill the app.
- wry's webview class is `WryWebView` (+`WryWebViewParent` wrapper) — not
  "WKWebView"; the parent answers `n/a` to everything.
- `requestAnimationFrame` never fires in hidden webviews — use `setTimeout`
  for layout-after-insert work.
- GitHub `gh pr merge` can 502 mid-merge and report "already in progress" —
  retry-poll, don't re-create.
- The engine's decision-log serve has a cache; a page loaded seconds after an
  ingest can race enrichment — reload before concluding data is missing.
- Chrome preview contexts cache served JS hard — stop/start the preview
  server (fresh context) or cache-bust; `fetch('/main.js')` proving the
  server serves new code does NOT mean the page runs it.
- `git checkout -b` in the worktree invalidates your Read snapshots —
  re-read before editing after any branch switch.

## 7. WHERE EVERYTHING IS (paths)

| What | Where |
|---|---|
| Primary checkout (dev app runs here, keep on main) | `~/Projects/viktora-threshold` |
| Engine primary | `~/Projects/AI-Light-Prototype` |
| Engine :3020 worktree | `~/scratch/engine-main-review` |
| UAT corpus (restored) | `~/scratch/trisha-pass-corpus` |
| Pristine snapshot (the restore source) | `~/scratch/trisha-corpus-restore/_metadata/` |
| Shim harness (durable copy) | `~/scratch/threshold-shim-harness/` |
| Probe/dev log (all shell probes) | `~/scratch/threshold-chrome-probe.log` |
| Engine log | `~/scratch/engine-3020-readiness.log` |
| Corpus integrity gate | `~/scratch/verify-corpus-integrity.sh` |
| Record-class backfill log | `~/scratch/record-class-backfill.log` |
| Acceptance bar / rubric / guide | repo root + `docs/user-guide-assets/` |
| WP briefs | `WP-READINESS-BRIEF-2026-07-06.md` (root, untracked) |
