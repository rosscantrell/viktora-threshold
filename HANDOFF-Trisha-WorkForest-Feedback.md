# HANDOFF — Trisha UAT feedback: Work-Forest hierarchy + capture-widget blocker

**For:** the next engineer picking up Work-Forest usability.
**From:** a session that was building the SoP Team-Update compose feature; this feedback surfaced adjacent and is handed off rather than fixed inline.
**Date:** 2026-06-30. **Source:** live UAT/data-cleanup session with Trisha Comsti (the pilot user) + the auto-synopsis of that call (both quoted below).
**Corpus:** Trisha's `apolla-threshold-eval` (the Merck Above Brand demo). **App:** viktora-threshold on branch `claude/workforest-sop-ui`. **Backend:** schema-browser (`AI-Light-Prototype`) on `claude/intelligent-hofstadter-066107`.

This is an INFORM-FIRST brief: it captures the feedback faithfully and points at the code, then offers fix *directions* as hypotheses — it does not lock a plan. Verify each claim before building.

---

## TL;DR — five issues, prioritized

| # | Issue | Severity | Where it lives |
|---|---|---|---|
| 2 | **Can't create a *nested* category** — every "New category" lands at the top level (Trisha's "Job Expirations and Renewals" became a sibling of "Merck Above Brand" instead of a child) | **P1 — the real work** | UI: `src/main.js:6376`. Backend already supports it. |
| 3 | **Can't re-home an existing top frame to become a sub-frame** (demote/re-parent). No affordance; merge is the only nearby op and it flattens jobs | **P1** | UI + backend overlay (no `reparent` event) |
| 4 | **Redundant categories can't be merged** when they're sub-frames ("Vaccine Story Refresh" ≡ "Narrative Refresh") — merge only lists top frames | **P1** | UI: `openFrameEditMenu` merge list |
| 1 | Capture-widget **window flicker** | **Likely already fixed — VERIFY only** | Tauri/Rust OneNote-sync management |
| 5 | Trisha's categorization "reset" | **Not a code bug — operational** | Local dev resets corpus + org per version |

**Two of the five reported issues are NOT engineering work** (owner clarification, 2026-06-30):
- **Issue 1 (flicker)** should already be resolved by the current OneNote-sync management — just **confirm** it no longer reproduces; don't re-root-cause unless it does.
- **Issue 5 ("reset")** is **expected local behavior**: the corpus + organization are reset every time a new version is spun up locally to try out. It is not an overlay/persistence defect. (See Issue 5 below for the one residual thing worth doing.)

So **the real remaining work is Issues 2–4** — the frame-correction tools are incomplete. The through-line: the automated frame classification does not match Trisha's mental model, and the tools to *correct* it by hand can't fully execute her intent (nest, re-parent, merge sub-frames).

---

## Issue 1 — capture-widget flicker: LIKELY ALREADY FIXED — verify only

**Trisha (verbatim, from the session):**
> "it does that thing where I'm trying to … open up the … widget … the window screen keeps popping up."
> "you have to go to the task manager and … force it to close."

**Owner clarification (2026-06-30):** this **should already be resolved** by how OneNote syncs are now managed. The transcript predates (or straddles) that fix.

**What to do:** a quick **confirmation pass only** — bring up the current build and check the capture widget no longer flickers/regrabs focus. Do **not** re-root-cause unless it still reproduces. If it does reproduce, the pointers are: `src-tauri/src/lib.rs:52` (focus-steal note), `:135` (`poll_for_tidbit`), and the OneNote export-watch polling (`WP-ONENOTE-EXPORT-*`, `lib.rs:23-135`) — look for a timer-driven `show()/set_focus()/always_on_top`. But start from "verify fixed," not "assume broken."

---

## Issue 2 — P1: "New category" is always top-level (no nesting)

**Trisha (verbatim):**
> "That goes to that job expiration. So make a new one."
> "So now this is at the project level, same as a Merck above brand … but … this one falls under Merck above brand. So the job expirations should be [a sub]. Everything related to Merck falls under Merck above brand. … The only other project there would be … AstraZeneca."

So: she made a new category **"Job Expirations and Renewals"**, and it landed at the **top level** (a sibling of Merck Above Brand). Her model: it must be a **sub-frame under Merck Above Brand**.

**Root cause (confirmed in code):** the backend already supports nesting, but the UI never uses it.
- **Backend supports it:** `frame-overlay.ts:135-137` — `create_frame` reads an optional `parentFrameName`; if a parent is found, the new frame gets `parentFid = parent.fid` (a real sub-frame). The field is declared at `frame-overlay.ts:53`.
- **UI never passes it:** `src/main.js:6376` — the "New category" input calls
  `frame_edit({ eventType: "create_frame", frameName: name, frameType: "initiative" })`
  with **no `parentFrameName`** and a **hardcoded `frameType: "initiative"`**. So every hand-created category is a top-level initiative.

**Fix direction:** when the user creates a new category *from within a job that already belongs to a top frame*, offer "create under `<top frame>`" (pass `parentFrameName` + a `workstream` type), vs "create as a new top-level category." The move picker (`openMovePicker`, `main.js:6355`) already knows the job's top frame (`grp._top`), so the parent is in hand. Small UI change; the backend plumbing is done.

---

## Issue 3 — P1: no way to re-home an existing top frame as a sub-frame

Trisha's "Job Expirations and Renewals" already exists at the top level. She needs to make it a **child of Merck Above Brand** *without* losing it as a distinct grouping.

**Gap:** the overlay event types are `create_frame | rename | merge | mark_type | move | undo | reject_signal` (`frame-overlay.ts:26`). There is **no `reparent`/`demote`** event that changes an existing frame's `parentFid`.
- **Merge is not a substitute:** `merge` folds the from-frame's jobs *directly* into the target and deletes the from-frame (`frame-overlay.ts:33-40`) — so "merge Job Expirations into Merck Above Brand" would scatter its jobs into Merck and lose the sub-grouping. Not what she wants.
- `mark_type → workstream` doesn't help either: `mark_type` only sets a type/`state`; it does not assign a parent (`frame-overlay.ts:153-155`), and a workstream with no parent is force-demoted to `misc` at compile (`frame-compiler.ts:141`).

**Fix direction:** add a `reparent` overlay event (`{ frameName, newParentFrameName }` → set `parentFid`) + a UI affordance ("Make this a sub-category of…") on the frame gesture menu. Keep it substrate-preserving (overlay only, never mutates `decision-log.json`). This is the single most direct fix for her stated model ("everything Merck → under Merck Above Brand").

---

## Issue 4 — P1: redundant sub-categories can't be merged

**Trisha (verbatim):**
> "narrative refresh is the same as … vaccine story refresh."
> "you just need to combine these together, which you have the ability to" — *but only if they're top frames.*

**Gap:** the "Merge into" list in `openFrameEditMenu` is built from **top frames only**:
`others = frames.filter(f => f.parentFid == null && f.name !== frame.name)` (`main.js` ~6295). If "Vaccine Story Refresh" and "Narrative Refresh" are **workstreams** (sub-frames), neither appears as a merge target for the other. **Check their tier first** — if they're nested, merge is unreachable from the UI even though `applyOrgEdits` handles `merge` for any frame.

**Fix direction:** allow merging sibling sub-frames (list nested frames under the same parent as merge targets), or surface merge on workstream headers too.

---

## Issue 5 — categorization "reset": OPERATIONAL, not a bug

**Trisha (verbatim):**
> "Didn't you put this in before? Job expirations." — Engineer: "It re-… it resets it."

**Owner clarification (2026-06-30):** this is **expected local behavior** — the corpus **and** the organization (frames + org-edit overlay) are **reset every time a new version is spun up locally to try out**. Trisha's earlier hand-categorization was wiped by a version swap, not by an overlay/persistence defect. The overlay engine itself (`frame-overlay.ts`) is not implicated.

**So there is no code fix here.** Two residual, optional follow-ups:
1. **UX/process:** from the pilot user's seat, "my categorization vanished" reads as lost work even when it's "just" a local reset. If Trisha is ever testing against a build that *should* retain her edits, make sure the local refresh preserves (or re-imports) her `org-edits/<viewer>.json` overlay so a version bump doesn't silently discard her corrections mid-pilot.
2. **Sanity check (cheap):** confirm that within a *single* run, org edits DO persist across reads (they should — the overlay is written by `appendOrgEdit` and re-applied every read at `index.ts:3501-3514`). This just rules out a real persistence bug hiding behind the operational reset.

Do not build the "key overlay refs to a stable frame id" rework that an earlier draft of this brief speculated about — the reset was operational, so that rework isn't warranted on this evidence.

---

## Cross-cutting: the mental-model gap + the learning loop

Trisha's model is simple and stable: **one top frame per real distribution unit** (Merck Above Brand; AstraZeneca), **everything else nests under it**. The machine over-produced top-level frames and split one initiative into two ("Vaccine Story Refresh" / "Narrative Refresh"). The learned-fold loop (`learned-fold.ts`) is meant to learn from her moves — but it can only learn if she can *make* the moves, and Issues 2–5 block or lose them. **Fix the correction tools before leaning on the learning loop.** Also worth noting for whoever picks this up: the frame-type picker was just made legible in this session (tiered "home / nested / lens" grouping, tooltips, dropped the unmodeled "Tracker"; `main.js` `FRAME_TYPE_TIERS`) — that's context, not a fix for the above.

---

## Suggested next moves (for the investigator)

The two "big scary" items (flicker, reset) are de-scoped by owner clarification — the real work is the three correction-tool gaps.

1. **Ship nesting (Issue 2)** — smallest, highest-clarity win; backend is ready, only `main.js:6376` + a picker option ("create under `<top frame>`"). Start here.
2. **Add `reparent` (Issue 3)** — the direct answer to "make Job Expirations a sub of Merck Above Brand."
3. **Extend merge to sub-frames (Issue 4)** — for the redundant vaccine categories.
4. **Verify Issue 1 (flicker) is gone** — a quick confirmation pass on the current build; only dig in if it still reproduces.
5. **(Optional) Issue 5 sanity check** — confirm org edits persist within a single run; and consider preserving the overlay across local version bumps so a pilot user's edits aren't silently wiped.
6. Then re-run the cleanup *with Trisha* and confirm the learned-fold loop picks up her moves.

## File-reference index
- Move picker + always-top-level create: `viktora-threshold/src/main.js:6355` (`openMovePicker`), `:6376` (create_frame, no parent).
- Frame gesture menu + merge list: `viktora-threshold/src/main.js:6252` (`openFrameEditMenu`), merge `others` filter ~`:6295`.
- Frame-type tiers (recent, context): `viktora-threshold/src/main.js` `FRAME_TYPE_TIERS` / `FRAME_TYPE_HELP`.
- Overlay engine: `schema-browser/server/ai/decision-log/frame-overlay.ts:26` (event types), `:53` + `:135` (parentFrameName → nesting), `:33` (merge), `:153` (mark_type), `:80` (viewer-keyed path).
- Overlay-over-compile: `schema-browser/server/ai/decision-log/frame-compiler.ts:16` (read-time overlay), `:141` (orphan-workstream → misc), `:241` (`frames.json` path).
- Apply sites: `schema-browser/server/index.ts:3501-3514`; SoP substrate loader `assembleForestSoPSubstrate` (same chain).
- Flicker pointers: `viktora-threshold/src-tauri/src/lib.rs:52` (focus-steal note), `:135` (`poll_for_tidbit`).
