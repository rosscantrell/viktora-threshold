# WP-SESSION-AGENDA-CURSOR — design brief (2026-07-16)

Ross's question, verbatim: *"if pre-work has been done and an agenda is set, why do
some come up and others get dropped with different calls at the same checkin
point?"*

This brief answers it and designs the fix: a **session-agenda cursor** that sits
beside the companion plan, so **the same check-in point resumes the same agenda
minus what's already been covered.**

---

## 1. Why the walk is non-deterministic today

The *packet* is deterministic — `compileCheckinBrief` is pure over field state,
and `buildCheckinPacket` shapes it the same way every call. But the *walk* (what
the companion actually surfaces, and what it drops) is stochastic across calls at
the same point. Four causes, in order of impact:

1. **Parks touched no state.** A spoken "park it" got a nod, not a filed verb, so
   the item was still `open`+dated on the next compile and re-led. — **FIXED** by
   the `snooze` park verb (engine PR #523): a ratified park leaves the walked
   `overdue` bucket; a *proposed* park should also count as covered (see §4).
2. **No per-point coverage memory.** Nothing records "we already walked A, B, C at
   *this* midday point today." Each call recompiles the full packet and the model
   re-picks its ~3–5 leaders from scratch — so a second call at the same point can
   surface a *different* subset and never reach what the first call was mid-way
   through. This is the dominant remaining cause and the one this WP closes.
3. **The oneQuestion pool moves.** The dequeue *ladder* is deterministic, but its
   *pool* shifts between calls as questions are filed/answered — so re-calls at the
   same point can rotate to a different single question. (July 16 alone ingested 8
   midday voice transcripts — crashes + retries — each a "same point" re-call.)
4. **LLM selection variance.** Even given an identical remaining agenda, which of
   the top-N the model speaks first varies. Bounded, not eliminated, by pinning a
   canonical order the walk resumes against (§3).

The 30-day fold (PR #522) removes a *related* churn source (aged items re-leading)
but is orthogonal: it shrinks the walkable set; the cursor gives the walk memory.

---

## 2. The cursor — shape and placement

A per-**point** coverage overlay, stored beside `companion-plan-store.ts` (same
viewer-keyed, flag-gated, pure-read discipline). A **point** = `(viewer, lens,
localDay)` — the natural unit of Ross's question ("the same checkin point"), and it
resets when the local day rolls over (a new day is a fresh point, so yesterday's
coverage never suppresses today's agenda).

```
session-agenda-cursor.json
{
  "<viewer>": {
    "<lens>": {                       // morning | midday | evening
      "day": "2026-07-16",            // localDay; a mismatch ⇒ fresh point (reset)
      "covered": [
        { "recordId": "aada7509…", "disposition": "walked",   "at": "…", "byRunId": "…" },
        { "recordId": "8460fcc3…", "disposition": "parked",   "at": "…", "byRunId": "…" },
        { "recordId": "1a556ebd…", "disposition": "deferred", "at": "…", "byRunId": "…" }
      ],
      "pointQuestion": { "qid": "mcpq:…", "offeredAt": "…" }   // §5
    }
  }
}
```

- `disposition`: **walked** (surfaced to the user this point), **parked** (a snooze
  was proposed/ratified this point), **deferred** ("not now, next" — user moved
  past it without a park). All three mean *covered for this point*; the difference
  is only in how it's reported back and whether it re-enters *tomorrow's* point
  (parked follows the snooze window; walked/deferred re-enter fresh next day).
- **Monotonic within a point.** `covered` only grows until the day rolls; the reset
  is the only thing that shrinks it.

Placement note: companion-plan-adjacent, **not** inside the companion plan. The
plan is the companion's own *work* of record; the cursor is the *reading* state of
a shared point. Keeping them separate keeps the veto-lane semantics clean.

---

## 3. How a call consumes it (the determinism guarantee)

At packet build, after `compileCheckinBrief`:

1. Load the cursor for `(viewer, lens, today)`; if `day` ≠ today, start empty
   (fresh point).
2. Partition the compiled agenda by the covered set:
   - **remaining** = agenda items whose recordId is *not* covered, in the packet's
     existing canonical order (overdue-at-risk-first → today → week → coming up).
   - **covered** = the rest, collapsed to `{recordId, disposition}` refs.
3. Emit a new packet section `sessionAgenda`:
   ```
   sessionAgenda: {
     point: { lens: "midday", day: "2026-07-16" },
     resumeAt: "<recordId of the first remaining item>",   // the canonical resume point
     remaining: [ …ordered uncovered agenda refs… ],
     covered:   [ {recordId, disposition}… ],              // count-complete, collapsed
     coveredCount: N
   }
   ```
4. Omitted-when-absent: no cursor / nothing covered yet ⇒ the section is omitted and
   the packet is byte-identical (calm-absence discipline, v3.2).

**Guarantee:** at the same `(viewer, lens, day)`, call *k+1* sees
`packet(fieldState_{k+1})` with the covered set subtracted and the remainder in a
fixed order. If the field is stable, the walk resumes exactly at `resumeAt`. Field
changes stay honest: a **new arrival** since call *k* is simply not in `covered`, so
it appears in `remaining` (and leads only if its priority outranks `resumeAt`); a
**resolved** item drops from the packet entirely. This is precisely "same point =
same agenda minus what's covered," with new arrivals and closures reflected.

The remaining LLM variance (cause 4) is bounded by the register instruction:
*"resume at `resumeAt`; items in `covered` are done for this point — never re-walk
them; walk `remaining` in the order given."*

---

## 4. How an item becomes covered (the write)

Coverage must be *recorded as the walk happens*, mirroring `mark_seen` but
per-item. Two write paths, no new obligation the model can skip:

1. **Parks auto-cover.** A `propose_record_edit(snooze)` this point writes the
   recordId into `covered` with `disposition:"parked"` as a side-effect (the verb
   already exists; the cursor write is additive). This is the highest-value link:
   the exact items that re-led are parked *and* marked covered in one gesture.
2. **Walked/deferred at close.** The session-close capture (the transcript ingest)
   already enumerates what was discussed. Fold a `mark_agenda_covered(recordIds,
   disposition)` into the close path (or infer coverage from the action-list's
   surfaced records). Attended-only, like `mark_seen` — a prepare/prework pass
   never marks coverage (it hasn't conferred).

Design choice: prefer **inference at close over a mid-walk obligation.** The
compliance contract is already long; adding "mark each item as you walk it" invites
the skip failure mode. Deriving coverage from the captured transcript's surfaced
records (the same set the action list is built from) keeps the write automatic. A
mid-walk `mark_agenda_covered` tool stays available for the voice register, where a
crash mid-call should still persist partial coverage (the July-16 crash pattern).

---

## 5. The oneQuestion, made point-stable

Pin the question chosen at a point until it's answered or the day rolls:
`pointQuestion:{qid, offeredAt}`. On a re-call at the same point, the dequeue ladder
**prefers the already-offered qid** if it's still pending, instead of rotating to a
newly-top-of-pool question. This makes the single up-front question deterministic
per point without touching the ladder's *scoring* — it's a "sticky pointer," a
coverage overlay, not a re-rank. (The four day-graph boundary contracts hold: the
dequeue ladder is unchanged; any change to *it* is a joint amendment.)

---

## 6. Boundaries & non-goals

- **Not a re-scorer.** The cursor annotates and reorders-by-coverage on top of the
  deterministic packet; it never changes priority scoring or the dequeue ladder.
  (Honors the WP-DAY-GRAPH boundary contracts — ladder changes are joint-only.)
- **Pull-served / packet-section**, like the other v3.2 sections: refs + counts, no
  LLM at read, calm absence, fail-closed-but-VISIBLE (covered items ride as a
  count, never silently gone).
- **Flag-gated**, default OFF; ON in `pilot-full` with the launcher/profile
  drift-gate parity (per the standing rule).
- **Voice register**: `sessionAgenda` rides compact (resumeAt + remaining refs +
  coveredCount); the spoken instruction is one line ("pick up where we left off —
  N already covered").

---

## 7. Why this is the right instrument (and how we grade it)

The cursor makes agenda-determinism **measurable**, which is what turns "some come
up and others get dropped" from a complaint into a graded axis: a session grade can
assert *"call k+1 resumed at `resumeAt` and re-walked 0 covered items,"* emitted as
machine-readable per-axis JSONL (the outcome-posterior stream WF's lane consumes).
The park verb (#523) is the state half; this cursor is the memory half; together
they close Ross's question — a check-in point that resumes itself.

---

## 8. Build order (proposed)

1. `session-agenda-cursor-store.ts` (pure read/write + day-roll reset) + tests.
2. Packet wiring: `sessionAgenda` section + omitted-when-absent + trim/voice
   compaction + protocol/register resume line + pins.
3. Cover-on-park: additive write from `propose_record_edit(snooze)`.
4. Cover-at-close: derive from the capture's surfaced records (+ optional
   `mark_agenda_covered` tool for mid-call voice persistence).
5. `pointQuestion` sticky pointer in the oneQuestion dequeue.
6. Grade emission: per-axis determinism JSONL.

Steps 1–2 are the spine (the determinism guarantee); 3 rides free on #523; 4–6 are
the completeness pass. Flag-gated throughout; co-ship the ladder-adjacent piece (5)
with the WF day-graph lane per the boundary contracts.
