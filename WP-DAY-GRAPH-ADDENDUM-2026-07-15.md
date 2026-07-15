# WP-DAY-GRAPH — cross-item operators for the coordinator (addendum to WP-FRAME-COMPANION)

**Date:** 2026-07-15 · **Status:** JOINT CONTRACT — operators (work-forest lane) +
instructions/question-grammar (voice/enhancements lane) · **Owner:** Ross
**Parent:** `WP-FRAME-COMPANION-BRIEF-2026-07-15.md` — its §0 field-conformance
preamble and §8/§9 amendments BIND everything here. Division of work is Ross's
2026-07-15 ruling: **this lane writes the OPERATORS** (insight + access through
frames, regions, summaries, and the day's item set); **the voice lane writes the
INSTRUCTIONS** — how the companion uses and interprets them, including EXPANDING
the question types the companion can originate and follow up with.

**Problem:** the coordinator's machinery works item-by-item (per-item navigation
recipe, per-item briefs). Nothing computes the joins ACROSS today's set: four items
waiting on the same person should become ONE conversation with an agenda; a
cross-item critical path should reshape the wing's work order; plan collisions
should surface before they cost a day. Post-#478 (work-the-plan) and #500
(companion plan), execution is covered — cross-item sight is the gap.

---

## §A The operators (this lane builds; contracts BINDING)

### A1 `day_graph` — the cross-item join
- **Universe:** today's calendar buckets ∪ `todaysPlan` items ∪ companion-plan
  (wing) items. **Join key = the underlying recordId, never the plan-item id**
  (voice-lane build-to: a plan item and its source record are ONE member —
  double-count is the pinned negative fixture).
- **Joins (all existing substrate, no new derivation):** owner (through owner
  canon), subject entities (through entity canon), `depends_on` edges, workback
  steps, region anchors. Human-revised outbox artifacts (#508 obligation 4b) count
  as plan-state input to collision detection.
- **Output: typed clusters**, each `{ clusterId, kind, members[], basis, band,
  licenseTier, receipts[] }` where `clusterId = sha256(sorted member recordIds)`
  (stable across passes — session grades and arbitration receipts reference it),
  `kind ∈ batch-by-person | shared-blocker | ordering | collision | region-touch`
  (CLOSED enum), members carry recordId + one receipt each, and `licenseTier` is
  emitted per finding so downstream phrasing strength is keyed mechanically
  (license inheritance end-to-end).
- **Discipline:** deterministic, NO LLM, no compute chains; admission bands are
  derived slots (cluster ≥2 members; collision = workback/owner/day overlap above
  the corpus's own distribution); **calm absence** — no clusters ⇒ empty, never
  filler.

### A2 Delivery (the voice lane's ruled injection points, adopted verbatim)
- **Scheduled passes:** the RUNNER gathers and injects the day-graph into the §9.1
  gather block **BEFORE the item-selection step** — batching-by-person must reshape
  bank-as-you-go ORDERING (four Naoki items = one banked conversation-prep), not
  decorate the agenda after.
- **Attended packet:** a new compact `dayGraph` section — counts + top clusters
  with refs + a pull hint; v3.2 payload discipline; omitted-when-absent with dual
  test pins. **Voice register cap ~1–1.5KB:** counts + TOP cluster only (kind,
  person/entity, member count, ≤2 named members, one receipt ref).
- **Pull:** `get_day_graph` capability (MCP + HTTP, bearer-pattern enrolled with
  audit pin) — full clusters + receipts; **<2s** (pure join over ~100s of items).
- **No LLM at packet read** (#467 law, pinned).

### A3 Region sweep
`get_region_brief` gains a list mode (enrolled regions + per-region freshness/
alignment), and the packet gains enrolled-region POINTERS (ids + counts only) so
the CoS consumes N briefs per parent-brief §4 without re-derivation.

### A4 Bearer-lane batch
`/regions/:id/charter/ratify` (missed in #507) + the new day-graph route join
`THRESHOLD_APP_PATTERN` in the same PR, each with a bearer-audit regression pin.

## §B Instructions + question grammar (voice lane AUTHORS; boundary contracts binding)

The voice lane owns: doctrine/protocol text for consuming `dayGraph` (scheduled +
attended), the SPOKEN register (their one-breath contract: "«N» of today's items
wait on «person» — want one conversation instead of «N» nudges?"; never enumerate
beyond two names aloud; never speak cluster ids or operator terms), and the
**expanded companion-originated question grammar**: richer question types minted
from operator findings (charter-fit misfits, ratification debt, fragmentation/
absorption, clusters) with multi-turn FOLLOW-UP.

Boundary contracts (joint, non-negotiable):
1. Cluster OFFERS are prep framing, never asks — they **never spend the
   one-question budget**. New question types ride the T1/T3 FILED lanes; the
   dequeue ladder is untouched; a ladder change is a JOINT amendment.
2. Phrasing strength keys off the emitted `licenseTier` — instructions may not
   exceed it (min-of-chain inheritance holds through relays).
3. `answerShape` extensions beyond `yes_no`/`yes_no_members` are FILED-only
   (store-only, no org-edit fold). Engine-question folds stay binary. Open-answer
   FOLDS, if ever wanted, are a jointly-designed seam.
4. Follow-up lineage rides factKey chaining (the mcpq discipline) — never-re-ask
   and receipts survive multi-turn.

## §C Pre-registered fixtures (build the tests to these)

1. **Naoki batching:** N≥3 synthetic items, same canonical owner, mixed sources
   (bucket + plan + wing) ⇒ ONE batch-by-person cluster, stable clusterId across
   two runs, one receipt per member.
2. **Double-count negative:** a wing plan item whose sourceRecordId is already in
   a bucket ⇒ ONE member, not two.
3. **Collision:** two workback chains claiming the same owner/day above the
   derived band ⇒ one collision cluster; below the band ⇒ silence.
4. **Injection-before-selection:** with the day-graph injected, the scheduled
   pass's banked order differs observably (conversation-prep banked once).
5. **Caps + absence:** voice section ≤1.5KB at any corpus size (pin); zero
   clusters ⇒ section omitted byte-identically (pin).
6. Flag-off byte-identity everywhere; drift-gate enrollment same-PR.

## §D Phasing

- **PR-1 (this lane, dispatching now):** the `day_graph` module + `get_day_graph`
  capability + attended `dayGraph` packet section + §9.1 runner injection wired to
  the voice lane's ruled point + A3 region sweep + A4 bearer batch + §C fixtures.
  Flag `DAY_GRAPH_ENABLED`, default OFF, pilot-full `'true'`, drift gate same-PR.
- **Co-ship at PR-1 (voice lane):** doctrine/protocol text + voice-register
  consumption, same-day per the #473/#509 pattern.
- **PR-2 (voice lane's own WP):** the expanded question grammar — their design,
  reviewed jointly at the §B boundary contracts.
