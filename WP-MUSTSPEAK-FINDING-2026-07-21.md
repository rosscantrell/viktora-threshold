# Design finding — directive adoption fails in the voice register; mustSpeak is the mechanic (2026-07-21)

## The measurement (contract of 2026-07-17, agreed with the WF lane)

- Denominator = serves carrying a dayGraph directive (serves.jsonl); numerator =
  coordination-view met (grades.jsonl); window = 7 days from 07-17 night; bar ≥80%.
- **Measured through 07-21 morning: 0 met / 9 directive-carrying serves**
  (5 graded missed, 4 n/a where the capture axis carries the miss — the
  denominator counts them per the contract's "served" term).
- The bar is **arithmetically unreachable**: reaching 80% from 0/9 needs 36
  consecutive met serves; the corpus produces ~3 gradable serves a day, so the
  remaining 3 days top out near 9/18 = 50% even if perfect.

## The verdict (per the contract: a DESIGN finding, never a window extension)

Text + ordering + directive field are sufficient in the UNATTENDED register
(passes adopt structurally) but insufficient in the VOICE register: the spoken
session consistently serves the directive and never speaks the beat. This is
the oneQuestion lesson replayed on a new surface — the fourth data point for
"text instructs, structure enforces" (oneQuestion→mustAsk, know-your-shop→
guide gate, charge-ordering→registry compile, dayGraph directive→THIS).

## The mechanic — mustSpeak, the #477 mustAsk analogue

Engine-side only, no new obligation (the registry already carries
speak-the-coordination-view with gradeAxis=coordination-view — this is that
existing obligation moved from text into DATA):

1. The dayGraph/coordination section of the VOICE-register digest gains
   `mustSpeak: true` whenever a directive fires (clusters ≥ bar), plus a
   compiled one-line spoken form served IN the data (`spokenForm`), so the
   model repeats a served sentence instead of composing one.
2. Ordering: the coordination beat moves ABOVE the item agenda in the served
   voice block — the mustAsk early-ordering mechanic verbatim.
3. The serve ledger already snapshots the directive; it additionally records
   mustSpeak so the grader's denominator is exact.
4. Grade axis UNCHANGED (coordination-view) — no axis churn; the axis is the
   measurement of this mechanic.

Honest all-quiet stays: zero clusters ⇒ no directive ⇒ no mustSpeak.

## Grader hygiene found during the same read (separate small fix)

Same-second double-serves (e.g. 07-20 16:40:08.449 + .914; 07-17 22:24:59.8 +
22:25:00.6) each grade separately: the first window closes in <1s and files
phantom "no capture / question missed" rows, polluting one-question and
capture tallies. Fix: collapse serves for the same (viewer, lens) within a
short join window (~10s) into one serve row before windowing — projection-side,
mirror of the probe-filter repair.

## self-report-accuracy (axis backlog) — design position, no build

Three banked instances (incl. the MDA answer-refusal misreport, WF-confirmed).
A mechanical join of SPOKEN failure claims vs the tool ledger requires NL
judgment over transcript prose; any phrase-list shortcut is exactly the
trigger-vocab sediment the ruling bans. Position: land as `manual`-graded info
axis with the three fixtures attached (the reconciliation-consumed precedent);
mechanize only if/when voice turns carry typed outcome stamps. Not dispatched.
