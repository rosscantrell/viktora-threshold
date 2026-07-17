# HANDOFF — Work-Forest / Coordinator lane (2026-07-17, session at compaction)

**From:** the "Work forest categorization and improvements" session (2026-07-13 → 17).
**Read FIRST:** auto-memory `workforest-categorization-assessment.md` (the full arc,
chronological, every contract/gotcha — this handoff indexes it, doesn't repeat it).
**Role you are inheriting:** the work-forest/coordinator OPERATOR lane — you own the
forest pipeline, region/day-graph operators, question machinery, identity guards,
sweeps, deploys of this lane, and cross-session contracts with the MCP-companion/voice
lane (which owns instructions/doctrine/register/grading).

## What is LIVE on both pilots (release ≥ 874d735 + their 48062e9)
oneQuestion channel (ladder/receipts/arbitration jsonl) · jobless backfill (127→59→
watch weekly) · CONFIRM_SPLIT · churn gate ARMED on ross (ruling: rekey 2%, dissolve+
merge hold; baseline advancing; commit path is silent — known nit) · propose_correction
+ groomer machinery (groomer pass NOT cron-wired, flag pinned OFF — arming = Ross go)
· entity-canon fold + capture lexicon · region anchors + get_region_brief ·
**Hikari charter RATIFIED** (FRAME-CHARTER-hikari-mda; Ross's objective verbatim) ·
day_graph (+directive #521, own-load #513, companion-exclusion #524) · premiseNote
(#527) · speaker-owner guard (#533, being re-laddered) · calibration flags (SOP_EDITS,
learned-fold structural+guards) · their lane: L0 System Map (#528), Phase-4 mechanical
grades (#536, grades.jsonl + serves.jsonl live), 30-day fold (#522), PARK (#523).

## IN FLIGHT right now (you will receive task-notifications)
1. **Speaker-guard extension PR** (opus agent, worktree `~/scratch/wp-speaker-owner-wt`,
   branch `claude/speaker-owner-guard` follow-up): adds (a1) You/user-by-construction
   class + **Ross's evidence re-ladder** — (a2) sole-speaker, (a3) summary self-id →
   known identity; dominant-among-many DEMOTED to per-recording name-asks. On landing:
   audit (independent suite run + pins), Ross merges, deploy, run re-tiered sweep
   dry-run, present the table, **Ross's --apply word** (never apply without it).
2. **Voice lane's Phase-2 obligation registry** ships tonight on their delegated path.
   My two flags await their confirmation: stripper must not touch data-inline section
   FIELDS (oneQuestion/dayGraph directives); `work-the-plan` appliesTo must EXCLUDE
   the groomer pass (its whitelist forbids get_companion_plan).
3. **Tonight:** first mechanically graded sessions (17:15 closure + evening call).
   Directive adoption verdict needs 2/2 spoken cluster beats → then record the
   standing law in memory: "text instructs, structure enforces — packet directive +
   early ordering for any must-speak surface" (3-for-3: #477/#521/#520).

## OWED by this lane (next builds, roughly in order)
- **Capture-mint dedup design note** (joint w/ voice lane): extend the dormant
  double-capture machinery (#367, DOUBLE_CAPTURE_COLLAPSE_ENABLED off +
  capture-suppressions.json) to capture-doc mints — same-owner same-ask near-dupe
  join at mint ⇒ suppress + duplicates edge; deterministic first, LLM only above a
  derived ambiguity band. Fixture: Keith Griffiths reminder ×5 (consolidation onto
  6580f249 proposed by their lane, Ross ratifies). Design-review before build.
- Groomer cron-wire (+ Ross's arm — scheduled-spend gate).
- Churn-gate commit-path log line + ledger row (observability).
- Snapshot script additions: regionAlignment row + substanceStability
  (median membership Jaccard) + chainTrackablePct.
- Ladder-v2 consideration: the ~9 selfId-"(Ross)" false-negatives (now covered by a3).
- WP-ONEQUESTION PR-4 (capture-doc → index-extractor bridge; their capture format is
  a versioned stable contract) — speced in WP-ONEQUESTION-BRIEF §5.
- Frame-Dynamics selective build (BIRTH/DORMANT + pace governor; E[a] from outbox +
  priority gestures) — designed, not urgent.

## ROSS'S DECISION QUEUE (do not act without his word)
Sweep --apply (after re-tiered table) · groomer arm · #176 coherence-brief
ratification status (check — L0 already shipped) · zombie resolves 170a8d1f/8460fcc3 ·
DEFAULT_VIEWER_EMAIL config (DEFER — changes which overlay the whole bearer lane
reads; decide alongside a #505 wp-viewer-lane-unify review) · transcripts for
grading (superseded by Phase-4 stream going forward).

## COORDINATION LANES (send_message; each send prompts Ross)
- **Voice/enhancements successor:** session `local_af9e39b2-6941-44c1-a478-eb312548a930`
  ("MCP Companion voice continuation") — owns doctrine/register/grading/runner
  conventions/voice backend (VOICE_LLM_ALLOWED_TOOLS on droplet). Boundary contracts:
  WP-DAY-GRAPH addendum §B (budget/ladder joint; licenseTier inheritance; answerShape
  filed-only; factKey follow-up lineage). They loop you on SESSION-AGENDA-CURSOR's
  sticky pointQuestion (joint) and PR-2 question grammar.
- **Networking lane:** session `local_07ecad67…` — P2 verbs, Enron/persona corpora;
  peer questions field-answer first (staked); frameHint in envelopes.
- Contest-before-merge with silence-=-build-to is the working convention; co-ships
  same-day per the #473 pattern; ping at PR time.

## DESIGN DOCS OF RECORD (threshold repo root, all merged)
WP-FRAME-COMPANION-BRIEF-2026-07-15 (+§8/§9 amendments) · WP-DAY-GRAPH-ADDENDUM-2026-07-15
· WP-ONEQUESTION-BRIEF-2026-07-13 · WP-CHURN-GATE-DISPATCH + WP-ORG-STATE-STABILITY-BRIEF
· their WP-COMPANION-COHERENCE (PR #176) governs ALL teaching-layer work (L0-L4;
no doctrine sediment — obligations go in the registry as ONE entry).

## OPERATING DISCIPLINES (all paid-for; violations have bitten)
- **Deploys:** Ross-gated per deploy; routine PR merges delegated. Recipe: worktree
  `~/scratch/alp-main-read-forest` → checkout origin/main (NEVER the primary engine
  checkout — parked on a federation branch) → `source ~/.zshrc` →
  `./scripts/provision-pilot.sh <ross|threshold-eval> --code-only` → org-state-backup
  (`bash /tmp/org-state-backup.sh /mnt/<p>-corpus /home/deploy/org-state-backups-0714`)
  BEFORE swap → verify posture zero-warnings + integrity gate + recompile if
  frames-stale (gated now). Bearer for reads: Dev-app config
  (`~/Library/Application Support/Viktora Threshold Dev/config.json`) → ross pilot.
- **Audit before recommending merge:** independent suite rerun + pin greps on the PR
  branch in the read worktree; restore to origin/main after. Never trust agent
  reports or exit codes alone (false-silence: verify mergeable via FRESH `gh pr view`,
  byte-verify merges on main; two incidents this arc).
- **Implementation → opus agents** (Ross's cost rule); registry tails
  (engine-profile.ts + test-engine-profile.ts POST_FREEZE_ADDITIONS) collide nightly —
  keep-both, whoever lands second rebases; flags enroll pilot-full same-PR (drift gate).
- **Standalone tsx scripts don't get ENGINE_PROFILE expansion** — pass flags explicitly.
- **Identity:** evidence ladder binds — by-construction > sole-speaker/self-id >
  everything-else-asks. Never a zero-evidence merge. Record-scoped overlays for
  per-recording identities. Records/substrate are NEVER rewritten — canon folds only,
  with receipts + undo.
- Weekly: forest-stats cron Mondays 10:00 UTC both droplets (+ scheduled task
  `weekly-forest-stats-report` Mon 07:30 local reads it). Snapshot script:
  `/home/deploy/forest-stats-snapshot.sh <corpus>`.

## KICKOFF PROMPT (for the successor session — paste as first message)
> You are inheriting the work-forest/coordinator operator lane. Read
> HANDOFF-WORKFOREST-2026-07-17.md at the threshold repo root and your auto-memory
> `workforest-categorization-assessment.md` end to end before acting. Then: (1) check
> the speaker-guard extension PR state (branch claude/speaker-owner-guard follow-up —
> audit it per the handoff's discipline if landed); (2) check the voice lane's Phase-2
> registry PR for their response to the two flags (stripper scope, groomer appliesTo);
> (3) read the first mechanical grades (`session-grades/grades.jsonl` on the ross
> droplet) and report the directive-adoption status toward 2/2; (4) present Ross the
> re-tiered sweep table when available and await his --apply word. Deploys and
> activations are Ross-gated; routine merges delegated; audit before recommending;
> coordinate with the voice lane by send_message per the handoff's lanes. House laws
> and the field-conformance preamble of WP-FRAME-COMPANION-BRIEF bind everything.
