# WP-THRESHOLD-NEEDS-YOU — one ratification lane, a calm Today, one row grammar (2026-07-20)

Status: BRIEF (Ross "go" 2026-07-20). Companion doc:
`MOCKUPS-THRESHOLD-REVIEW-2026-07-20.html` (same date, repo root) — the
propose-before-code mockups this brief turns into increments. Ross picked
Concept 1 (brief/queue split) + L1 (row grammar) + the standing law, with the
walk / modes-v2 / done-strip deferred.

Owner altitude: frontend posture applies to EVERY increment here — one pair of
eyes, tight render-look loop, no agent fan-out for anything user-visible.
Small PRs; Ross gates each user-visible slice against the pixel rubric
(`PIXEL-PASS-RUBRIC-2026-07-06.md`). No native (Rust window/AppKit) work in
this WP except one new HTTP-forwarding IPC (N1) — `cargo test --lib` still
runs on that PR (constants-pin test).

## A. Why (the three complaints, 2026-07-20)

1. **Today is crowded again.** The Concept-D ruling (2026-07-12) fixed Today at
   four strata, one per user intention. It now renders six sections — the two
   post-ruling arrivals both break the ruling's own law: "From your colleagues"
   (companion-network #182) is organized by transport, not intention; "Prepared
   for you" fuses review-needed with approved-awaiting-send. Sediment mechanism:
   every WP that ships adds its section to Today. Twice decrowded, twice silted.
2. **No view to ratify items.** Ratification exists as six scattered
   affordances (proxy inbox, One-question card, filed-automatically line,
   outbox approvals, prework review, edge confirms). The biggest queue — the
   proxy inbox — is reachable ONLY from the widget badge/right-click; it has no
   nav destination, even though the widget's amber badge counts exactly it.
3. **List items don't skim.** A Log card is a panel: four stacked zones, up to
   six always-visible controls; ~8 expanded items fill a screen. Ordering is
   capture-order; the lens × filter grid is two control systems (Trisha's
   confusion was patched with a sentence, not solved).

## B. What exists (verified against code 2026-07-20)

| thing | state | where |
|---|---|---|
| Today's 6 sections + load pipeline | live | `src/index.html:742-910`, `enterLogView` main.js ~5443 |
| Proxy inbox view + confirm/dismiss UI | live, hash-only entry | `view-proxy-queue`, `enterProxyQueueView` main.js ~16494 |
| **Engine proxy-queue verbs** | **EXIST on engine main** | `GET /api/proxy-queue` + `POST /api/proxy-queue/:id/{confirm,dismiss,undo}` — `schema-browser/server/fleet/routes.ts:76,147-149` |
| App `proxy_queue_decide` IPC | **MISSING** — ratify decisions are local-only optimistic, lost on restart | `proxyRatify` main.js ~16856 calls it; absent from `src-tauri/src/lib.rs` invoke list |
| Peer intake rows (questions/answers/handoffs/receipts) | live in check-in packet | `fetch_checkin_brief → intake.received[]`, rendered `renderPeerArrivals` main.js ~6488 |
| Receipt → record join | **ABSENT** — receipt rows carry `docId` but no `recordRef`, so one-tap confirm can't resolve the cited commitment | packet shape; the one genuine engine seam in this WP (N3) |
| Question verbs | exist | engine `/api/questions/:id/{route,answer,lifecycle}` |
| Outbox verbs | exist | engine `/api/outbox` family incl. `dispatch-peer` |
| Record resolve/snooze/dismiss | exist | app `appendResolveSnoozeControls` / `appendDismissControl` + engine PATCH lanes |
| Voice desktop entry | designed, docs branch `claude/voice-agent-app-integration-179ee0` | `WP-VOICE-THRESHOLD-ENTRY-2026-07-16.md` — SEPARATE WP, parallel lane; its V3 walk target lands after this WP's N1 |

Engine-primary-checkout trap note: the local `~/Projects/AI-Light-Prototype`
checkout sits on a June experiment branch — every engine fact above was
verified against `origin/main`, not the working tree. Re-verify against the
running engine before N1/N3 build (false-silence discipline).

## C. The shape (what Ross approved)

1. **One row grammar everywhere (L1).** Collapsed = one line: state/action
   chip · summary · owner · due. Click → expands in place into today's full
   card (verbatim receipt, relationship chip, all actions). Nothing removed —
   deferred. The same component renders Today rows, Needs-you cards (expanded
   default), and Log rows.
2. **"Needs you" — the ratification lane, one nav destination.** Absorbs, in
   three weight groups:
   - *Calls only you can make* — proxy adjudicate-band items, QE question
     overflow, name/merge asks, peer questions;
   - *Work awaiting your go* — outbox drafts (approve/dismiss), staged
     prework, peer handoffs;
   - *Confirm what happened* — peer receipts, looks-done confirmations,
     filed-automatically reviews (undo per row).
   One card grammar, canon verbs (Dismiss/Snooze), honest counts, affirmative
   empty state ("Nothing needs you — all yours"). The widget amber badge points
   here. Fail-visible: an unreachable source renders its group header with a
   couldn't-reach line, never a silent absence.
3. **Nav:** Today · Needs you · Watching · Log · Relationships · ⚙. Outbox
   folds into Needs you ("awaiting send" is a ratification state); ⌂ leaves
   the nav (widget is the capture surface; capture screen stays reachable via
   wizard/fallback routes, just not a destination).
4. **Today slims to the brief:** plan · Don't miss (cap 4) · Due this week
   (cap 3 + honest count) · One question. Peer arrivals + prepared items
   become quiet-line counts into Needs you.
5. **Standing law (lands in CLAUDE.md, N2):** *Today accepts no new sections —
   a WP that wants surface area on Today buys a quiet-line count into its own
   destination.*
6. **Modes v1 (Log):** exactly two chips — ⚡ Catch up (small, clearable,
   quick-verb items, priority-sorted, due-date-default weighting) and
   Everything (today's archive; lens × filter grid unchanged inside it).
   Focus / For-someone / Runway modes deferred until live use argues.

Plain-language canon: no "proxy fleet"/"adjudicate" survives to shipped chrome
— source chips read "filed for you". Amber only on urgency/primary action.
Every list ships with a hard cap + overflow line (suppression stays visible).

## D. Increments (small PRs; every user-visible one gated by the render-look loop)

| # | slice | contents | notes / gate |
|---|---|---|---|
| N0 | Row component + Log swap | The L1 row as ONE shared renderer; Log's `renderDecisionCard` call sites render rows that expand into the existing card body. Render-only — no IPC, no engine. | Pixel-rubric pass with Ross. Biggest skim win, zero data risk. |
| N1 | Needs-you view + nav + persistence | New `view-needs-you` built from N0 rows (expanded-by-default cards); client-side aggregation over EXISTING IPCs (`fetch_proxy_queue`, `fetch_question`, `fetch_checkin_brief` prework+peer, `fetch_outbox`); nav swap (Outbox folds in, ⌂ out); widget badge target → `#needs-you`; **new Rust IPC `proxy_queue_decide`** forwarding to the engine's existing confirm/dismiss/undo verbs (closes the lost-on-restart hole). | `cargo test --lib` (IPC touches lib.rs). Group names locked: "Calls only you can make" / "Work awaiting your go" / "Confirm what happened". |
| N2 | Today slimming + the law | Peer + prepared sections dissolve into quiet-lines into Needs you; week cap 3; CLAUDE.md gains the no-new-sections law. ONLY after N1 ships — items must have somewhere to go before they leave Today. | Render-look pass; verify nothing silently disappears (counts match). |
| N3 | Receipt one-tap confirm | ENGINE: intake receipt rows grow `recordRef` (envelope doc → cited record join). APP: Confirm on a receipt card resolves the cited record via the existing resolve verb (+ Undo toast). Until N3, receipt cards ship in N1 with open-the-doc + manual resolve (two-step, honest). | Engine PR + app PR; re-run against live engine per §B trap note. |
| N4 | Catch-up mode | Two mode chips on the Log (Catch up / Everything); Catch up = priority-sorted quick-verb rows, due-date-default weighting; the sub-line names the sort ("sorted by due date, then who's waiting"). | Deferred-friendly; needs N0 only. |
| — | Deferred | The walk (one-at-a-time queue clear; also voice's co-presentation target), Focus/For-someone/Runway modes, done-strip + looks-done detection surface, per-person learned priority weights. | Each gets its own slice when pulled. |

Voice lane (separate WP, parallel): push the docs branch → Spike-0 → V1 per
`WP-VOICE-THRESHOLD-ENTRY-2026-07-16.md`. Standing decision from this session:
the Needs-you walk is V3's co-presentation target — voice carries the verbs,
the screen carries the evidence, spoken confirm/skip/snooze maps to the same
PATCH verbs as the cards.

## E. Acceptance

- Every user-visible increment: pixel-rubric pass with Ross at the machine;
  screenshots via the shim/headless-Chrome recipe where the live app isn't
  needed (`render-loop-shim` recipe).
- N1: ratify a proxy item → restart the app → the decision HELD (the
  lost-on-restart hole is the regression test).
- N2: sum of quiet-line counts + slimmed sections == the pre-slim item count
  on the same corpus (nothing silently disappears).
- CI watched to green after every merge; primary checkout pulled after each.
