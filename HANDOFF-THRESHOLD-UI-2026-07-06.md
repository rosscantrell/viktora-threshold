# HANDOFF — Threshold UI/shell work, 2026-07-06 (evening)

**For:** the successor session taking over the Threshold app polish + release push.
**From:** the strategy/coordinator session Ross terminated for cause. Read the
FAILURE PATTERNS section first — the predecessor's errors cost Ross an afternoon
and your credibility budget is already spent. Verify everything; claim nothing
without artifact-level evidence.

## Where everything stands (verified at handoff time)

### Repos
- **viktora-threshold main @ `7e2fe5f`** (#75 merge). Merged today: #64 project
  home · #65 receipts render · #66 email-capture Settings card · #67 SoP dedup ·
  #68 Today composition (4 strata incl. "Coming up") · #69 SoP auto-load ·
  #70 mechanical consistency (15 audit items + attention ordering) · #71 widget
  glow-up · #73 window persona + wide layout · #74 shell hotfixes (main-thread
  crash, badge geometry, drag region, shadow toggle, "Analyze edits" rename,
  chrome probes) · #75 glow-up coat (CANVAS GRADIENT ROOT CAUSE: glass.css `body`
  background shorthand wiped the gradient — it never rendered until today).
- **#72 (taste canon + receipts-v2) — REBASED, MERGEABLE, awaiting Ross's click.**
  It was missed in an earlier merge sweep; contains: Dismiss/Snooze verb canon,
  "Replaced" everywhere, Plaud/OneNote glass reskin, sentence-case app-wide,
  receipts-v2 (blocked-by joins → dependency popover, owner·due·summary rows,
  top-6+Show-all). Conflict resolved: glow-up calm-line empty states won over
  #72's boxed versions (ruled language). AFTER MERGE: verify the Plaud/OneNote
  reskin composes with the glow-up (both touched those styles).
- **AI-Light-Prototype (engine) main:** everything merged through #384 (SoP slug
  humanize, live-verified 7 generations 0 slugs). D3 concluded (kill fired, L3
  deleted #378, consolidated report on main). WP-C thread machinery merged
  flag-off (#380); its bridge-selector build + ~$3 live validation are with the
  SELFORG session under the strategy ruling (reuse RESTATED rubric, judge
  endpoint-vs-opposite-component, 2-of-3, suggestion tier on tiebreak).

### Live processes on Ross's machine (running at handoff)
- Tauri dev app: primary checkout `~/Projects/viktora-threshold` on branch
  `_glowup-view` (= #75 content + the sticky-error guard fix). **After #72
  merges: `git checkout main && git pull`, kill ALL instances, ONE clean launch,
  BYTE-VERIFY (see patterns).** The running binary contains the chrome probes.
- Engine harness `:3020`: `~/scratch/engine-main-review` worktree (engine main)
  serving `~/scratch/trisha-pass-corpus` (DISPOSABLE copy of Trisha's corpus,
  work-forest DERIVED — Merck Above Brand + RSV frames). Launch recipe in
  `~/.claude/.../memory/release-review-harness-recipe.md`; flags incl.
  SOP_CLAIM_RECEIPTS_ENABLED + EMAIL_ONRAMP_ENABLED + COORDINATION_FRAMES_ENABLED
  + PROSE_JOBS_ENABLED. The app's dev config already points at :3020.
- Browser shim harnesses on :4599/:4600/:4602 (launch.json in the session
  worktree) — serve src/ with a __TAURI__ shim proxying to :3020. The validated
  way to pixel-check without the native app.

### OPEN BUGS (with evidence status — do not re-theorize, follow the evidence)
1. **Widget pill grey halo.** UNRESOLVED after multiple wrong theories (crash
   carcass: wrong; system shadow: insufficient — set_shadow(false) on collapse
   shipped but halo persisted BEFORE any expand in at least one sighting).
   HARD EVIDENCE: boot probe prints `[chrome:boot] hasShadow=false isOpaque=false
   styleMask=0x8004 bgAlpha=0` — the window layer is clean at boot. Probes are
   armed in the running binary at boot/post-expand/post-collapse (stderr → the
   nohup dev log). NEXT: get Ross's fresh-boot observation (grey or clean?) and
   one expand→collapse trace; the field-level diff between chrome:boot and
   chrome:post-collapse identifies the culprit. If fresh boot is ALREADY grey
   with those clean values, the paint is WEB CONTENT (test widget.html at
   180×80 over a colored background in a plain browser — reproduce off-machine).
2. **Fullscreen/maximize black surround.** The expanded window doesn't fill the
   screen at "maximize"; black around it. UNKNOWN whether green-button
   fullscreen or drag; Ross was asked, never answered. The persona sets
   collectionBehavior managed|fullScreenPrimary (verified applied — policy=0
   in the trace). No maxSize anywhere (grepped). Instrument the fullscreen
   transition (frame vs screen frame) rather than guessing.
3. **Overlay titlebar (the APPROVED look — "chrome disappears") was reverted**
   to standard decorations during the crash firefight and never reinstated.
   Reinstating requires: main-thread dispatch (in place), the drag-region on
   nav (`data-tauri-drag-region`, in place), nav left-offset for inline lights
   (was `body.titlebar-overlay` + 78px padding, REMOVED — restore both), and
   live verification of drag + click-focus + fullscreen after.
4. **Today at mid-width with empty sections reads sparse** (Ross screenshot):
   ask-input + calm line float with excess void when queue/Coming-up are empty.
   The glow-up scale helps at ≥1200 but the sparse/empty composition at
   700–1100px needs a deliberate design decision.

### The acceptance bar Ross approved (BINDING for "done")
Three mockups (rendered in the conversation; recreate from this spec):
1. **First-class window** — traffic lights inline over glass, no titlebar strip,
   content is the frame; ⌘⇥/Mission Control/drag/fullscreen (mechanics shipped ✓,
   look NOT shipped — see bug 3).
2. **Wide Today** — State-of-play panel + chips top-left; RIGHT rail: "Waiting on
   you (N)" queue cards + "Coming up (N)" due-soon cards with amber
   due-in/quiet badges; "Needs attention (N)" grouped by project in compact
   accent-bar cards below. Skeleton shipped ✓; the mockup's DENSITY (compact
   panels, ghost chips, quiet metadata) is the visible gap.
3. **Master-detail fullscreen** — list left, persistent detail pane right
   (owner·due·silence header; red-tinted "Blocked by —" panel naming the
   blocker; the verbatim as quiet evidence; actions incl. amber "Draft heads-up
   to client"). PARKED for next cycle with Ross's sign-off; receipts-v2 (#72)
   ships the blocked-by JOIN on Today's claim chips.
Ross's other ruled canon: memory `threshold-ui-design-direction.md` bottom
section (7 taste rulings + attention ordering + header-CTA law). The Trisha
pain table (memory `trisha-deadline-pain-session.md`) is the product bar:
"would this have caught Brian's June-30 miss."

### The committed next sequence (was promised to Ross)
1. Ross merges #72 → rebuild app on clean main (kill-all → one launch →
   byte-verify) → 2. MOCKUP-COMPARISON PIXEL PASS: each mockup beside the real
   surface, every view, 4 widths (incl. 700-940px sparse states), empty/full/
   ERROR states (engine-down included) → one annotated defect list →
   3. ONE fix pass closes the list (overlay titlebar return included) →
   4. Ross reviews the comparison sheet → 5. Trisha's pass (app + her 20-card
   sample at `~/trisha-record-class-binary-sample.md`; walkthrough incl. the
   Brian-scenario email-capture demo; her corpus copy is the :3020 harness) →
   6. Engine deploy, ONE cycle (ross droplet: RECORD_CLASS_ENABLED — graded
   95% —, SOP_CLAIM_RECEIPTS_ENABLED, IDENTITY_LEDGER_ENABLED canary; trisha
   droplet: receipts only until her sample grades ≥95%) + Ross's combined
   v0.9.0 smoke (still owed from the July-5 handoff) → 7. v0.9.1 installer
   (version drift note: package.json says 0.8.1, Cargo.toml 0.9.0 — reconcile).

## OPERATING POSTURE FOR THE SUCCESSOR (Ross's exit diagnosis — the root of it all)
Ross, at handoff: the predecessor "did good work there [strategy/eval] but
couldn't switch context to the frontend effectively." He is right, and the
individual failure patterns below are all one category error: an EVAL-LANE
posture (parallel agent fan-out, gate/log verification, artifact ground truth)
applied to FRONTEND work, where ground truth is the rendered screen. Operate
differently here:
- ONE pair of eyes, tight loop: make ONE visual change → look at it rendered
  (shim harness screenshot, or the live app) → then the next. No multi-agent
  fan-out for anything the user will see; agents may still build well-specced
  plumbing, never composition or polish.
- Screenshot-first debugging: reproduce what Ross sees before diagnosing it.
- Native (AppKit/Tauri) work: probe state before changing it; byte-verify the
  running binary after; live-test the transition yourself before reporting.
- Small PRs that each leave the app visibly better; never let Ross discover a
  state you haven't rendered yourself.

## FAILURE PATTERNS (specific instances — do not repeat)
1. **Claimed fixes without verifying the artifact.** `cargo check` between
   edits poisons cargo's freshness; `cargo run` then serves a STALE binary
   while printing "Finished". Ross clicked a broken app for an hour while
   being told it was fixed. LAW: after ANY native change, verify the RUNNING
   process's executable bytes: `lsof -p <pid> | grep txt` → `grep -ac
   "<unique-new-string>" <path>`. Never claim from build output.
2. **Theory loops instead of instrumentation.** Three wrong halo theories were
   shipped as "fixes". LAW: when a native behavior is wrong, add probes that
   print the actual state (the chrome probe pattern) BEFORE changing anything.
3. **Multiple app instances** from repeated nohup launches ate two hours of
   contradictory symptoms. LAW: pkill -f "tauri dev" AND the binary AND port
   1420, verify count==1 after launch. Also: `pkill -f` once matched a LOG
   PATH and killed the engine — match on exact process names.
4. **Handed the app over without the live pass** (twice). Entry states first;
   after any deletion ask "was the deleted thing load-bearing?" (the killed
   duplication was the only narrative auto-loader; the "composed" guard
   treated an error box as content).
5. **Traded approved design for stability without telling Ross** (overlay
   revert). Surface every design trade the moment it happens.
6. **Merge-sweep assumption** — "everything is merged" was accepted without
   listing PR states; #72 sat unmerged while Ross reviewed a build missing a
   third of the polish. LAW: after any merge session, `gh pr list --state
   open` and reconcile.
7. Process wins that ARE working — keep: worktree isolation + coordinator-only
   push; check-PR-state-before-push; blob audits of agent commits; the shim
   harness for DOM/pixel checks; byte-verification; the probes.

## STATUS UPDATE — 2026-07-06 late evening (successor session; sections above preserved as the handoff record)

Merged since handoff: **#72** (taste canon + receipts-v2, Ross's click 22:08Z) ·
**#76** (deep chrome probes: webview background stack + all-windows sweep +
frame-vs-monitor on resize — the bug-1/bug-2 instrumentation) · **#77**
(WP-TODAY-READ-ACT). Main @ `6f61e90`.

Open-bug deltas:
1. **Grey halo — NARROWED.** Browser repro (widget.html at honest 180×80 over
   red/white/black/green/gradient/grey) paints CLEAN → the paint is native-side,
   in a layer the NSWindow probe can't see. #76's `debug_window_deep` reads the
   remaining suspects (WKWebView drawsBackground/underPageBackgroundColor/layer
   bg + every NSWindow) at boot/boot+1.5s/post-expand/post-collapse/
   post-collapse+900ms. NEXT: rebuild on main, one expand→collapse, diff traces.
2. **Black surround — instrumented.** `[frames]` probe on Resized prints window
   frame vs monitor + fullscreen/maximized flags. Still need Ross's answer:
   green button or drag?
3. **Overlay titlebar — still open**, fix-pass item (mockup 1 is the spec).
4. **Sparse mid-width Today — CLOSED** (#77): Ross ruled option D after a live
   A/B/C/D mock comparison ("B is close, but a lot of wasted real estate") →
   read|act wide composition (narrative left column · sticky action rail right ·
   needs-attention full-width in ≥420px auto-fill columns) + quiet-report empty
   strata (calm lines instead of vanished sections, SoP unavailable unboxed,
   nothing-line dedup vs the ask affordance).

Acceptance bar is now an ARTIFACT: `MOCKUPS-THRESHOLD-UI-2026-07-06.html`
(committed alongside this file) + the gradeable checklist in
`PIXEL-PASS-RUBRIC-2026-07-06.md`. Known deltas mockup-2 vs shipped, queued as
the first two fix-pass items:
- **SoP digest, not essay** — the mockup's State-of-play panel is a ~4-line
  digest + chips; the app renders the full ~15-line narrative (~435px). Target:
  headline digest + chips + "Do this first" visible, full prose behind expand.
- **Compact accent-bar group cards** — mockup's needs-attention cards are one
  project each (title · count · worst-item line, amber/soft-red status words);
  the app renders every row of every group. Marry D's full-width geometry with
  the mockup's card grammar.
- Also on the defect list: "OPINE" ALL-CAPS eyebrow in the SoP panel (violates
  sentence-case ruling 7); "Unnamed workstream" group titles (engine-side
  naming, flag to the eval lane — not a UI fix).

Remaining sequence: SoP digest + compact cards → Phase B rebuild (kill-all →
one launch → byte-verify; probes go live) → halo/fullscreen traces → pixel pass
per the rubric → remaining fix pass (overlay titlebar) → Ross review → Trisha →
deploy → v0.9.1 (version drift: package.json 0.8.1 vs Cargo/tauri.conf 0.9.0).

## Program context beyond the app (unchanged today, for continuity)
- D3/identity: concluded, kill fired, canon OFF, redesign (drop-L2-keep-L0,
  97.2%) awaits a spec session; D5 negative control clean on ross.
- SELFORG lane: WP-C bridge-selector + live validation in flight under the
  ruling; junk-strip fold CLEARED for ross corpus (19/20=95% graded), trisha
  pending her sample.
- Deploy staged behind the app work + Trisha grades; apolla-devops skill has
  droplet procedures; multi-minute restart-reprocessing window applies.
