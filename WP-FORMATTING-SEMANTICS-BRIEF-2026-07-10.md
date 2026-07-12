# WP-FORMATTING-SEMANTICS — Agent Kickoff Brief (2026-07-10)

**Goal:** teach ingestion to read the *formatting* of emails and attached docs
(strikethrough, comments, track-changes, color, highlight, indentation) as
**semantics** — status, authorship, instruction-vs-content, hierarchy, attention —
so the knowledge field stops inverting meaning and starts catching what a
flattened read misses. From Trisha's pilot UAT (2026-07-09/10).

This is **engine / ingestion plumbing** (AI-Light-Prototype), not user-visible
frontend — so it's a legitimate agent build (per the frontend posture). Do it
**precision-first**: Trisha's trust dies on confident-but-wrong.

---

## The problem, in her words
For Trisha's team, **formatting IS the message.** Threshold currently flattens
every doc to plain text, which doesn't just lose nuance — it **inverts meaning.**
The proven misfire: a "done, week of 7/13" line she'd **struck through** as an edit
instruction was read as *current status* → a wrong card. She also loses:
- **comment-embedded client asks** ("I'll check on this internally and come back")
  — routinely missed by her team, high-stakes when the client follows up;
- **which job a line belongs to** — bullet indentation/hierarchy is dropped, so 5
  similarly-named jobs collapse together (the "can't tell which job" complaint).

## The signals — each means something different, each is ambiguous
| Signal | What her team means | Ambiguity | Value / Effort |
|---|---|---|---|
| **Comments** (Word/PPT) | side-channel asks, often from the client | not in body text at all | **High / Low** — pure additive capture |
| **Indentation / bullet nesting** | which JOB a line belongs under | — (structural, not nuance) | **High / Low** — dropped today; fixes job cross-ref |
| **Strikethrough** | done · OR delete · OR "this was an instruction" | opposite meanings | High / Med — needs flag-not-guess |
| **Track-changes** | proposed edits, not current state | multiple authors stacked | High / Med |
| **Font color** (her blue) | author identity / annotation vs content | conventions are personal/per-team | Med / Med |
| **Highlight** | directed attention ("X, look at this") | who is it for? | Med / Med |

**Key reframe:** *comments* and *indentation* aren't "formatting nuance" — they're
**structural content the flattener drops entirely.** Cheapest + highest value; do
them first.

## The pipeline — 4 stages, strictly ordered (this is the gate)
1. **Extract/preserve** — does ingestion keep the formatting spans? Today it
   flattens. **Nothing downstream is possible until this changes.**
2. **Represent** — carry "this span was struck / blue / a comment anchored to line
   X / indented under Y" into the record/doc model.
3. **Interpret** — turn spans into signals (status / authorship / instruction /
   hierarchy / attention).
4. **Display/receipt** — show *why* a record believes what it does, citing the
   formatting evidence.

## Staged plan (preserve → surface → interpret → learn)
- **Phase 1 — the two structural, zero-interpretation-risk wins (start here):**
  - **Comment extraction** (Word/PPT `w:comment` nodes) → surface client asks as
    their own signal (feeds records/voids — pairs with the vigilance work).
  - **Indentation/hierarchy preservation** → a line knows its parent job. This
    *also* delivers the Work-Forest cross-reference / "which job" fix for free.
- **Phase 2 — preserve + FLAG the ambiguous ones (do NOT interpret yet):** detect
  strikethrough / track-changes / highlight / color, carry them as **flagged
  spans**, render as "this line was struck through — done, or removed?" with a
  review affordance. This alone would have prevented the misfire (flag, don't
  assert). Fail-closed-but-**visible**.
- **Phase 3 — learn the team's conventions (the real moat, later):** once spans
  are preserved and Trisha confirms/corrects ("blue = my annotation," "strikethrough
  here = done"), the team's formatting grammar becomes learnable per-corpus. Ties
  to the HITL-capture-as-calibration direction. Don't scope until Phase 1–2 generate
  the signal it needs.

## The governing risk (non-negotiable)
The strikethrough misfire was **confident-but-wrong** — same family as the QE
vaccine-merge. So: **when formatting is ambiguous, SURFACE the signal and ask —
never silently reinterpret.** Do NOT ship "strikethrough → mark done"; that just
replaces one confident-wrong with another.

## How this improves the knowledge field
- **Correct status** — struck "done" lines stop minting live commitments.
- **Correct hierarchy** — records anchor to the right job (fixes the Log's
  "5 jobs" ambiguity and cross-references).
- **New signal from comments** — client asks that were invisible become records /
  voids (directly strengthens the vigilance "what am I missing" catch).
- **Provenance** — a record can cite the formatting evidence (a struck span, a
  comment) in its receipt, not just a flat quote.

## First concrete step — the gap analysis (do before any build)
Take a **real fixture** and diff what the source actually contains vs. what
ingestion currently emits:
- **Fixtures:** the emails/docs Trisha forwarded (ask Ross for the latest); and
  `email-capture.json` in `~/scratch/threshold-uat-repro-corpus/reference/_metadata`
  (the formatting-misfire source). Her real docs are `.docx`/`.pptx` (track-changes
  + comments) and forwarded emails (HTML with strikethrough/color).
- **The diff:** for a fixture, dump the raw XML/HTML (strikethrough runs, `w:comment`
  nodes, list `w:ilvl` levels, font-color runs) and compare against the plain text
  the current ingest pipeline produces. **This gap report right-sizes the whole
  cluster** — tells you exactly how much is "we drop it at parse" (cheap) vs. "we
  never modeled it" (deeper).

## Where the code is (investigation pointers — trace, don't assume)
- Ingestion/doc-parse lives in AI-Light-Prototype `schema-browser/server` — find
  the document parser (the void agent found `indexParser.extractSourceMetadata`
  reads email `from/to/cc`; the same parser layer is where body/formatting is
  flattened). Trace how a `.docx`/`.pptx`/email becomes doc text + how extraction
  consumes it.
- Extraction (`extract.ts`) mints decision/commitment records from doc text — the
  point where a struck "done" currently becomes a live commitment.
- Use a git worktree off `main` for isolation; run against a **copy** of a corpus,
  never the live pilot data.

## Success criteria for the Phase-1 milestone
On a real fixture: (1) Word/PPT **comments** are captured as distinct signals; (2)
a nested bullet's record **anchors to its parent job**; (3) a **struck-through**
line is preserved as a *flagged* span (not silently read as status) — verified by
the record it produces vs. the flattened baseline. Report the gap analysis + the
Phase-1 diff + tests; do not merge.

## Guardrails
- Precision-first; flag-don't-guess on ambiguous signals; fail-closed-but-visible.
- Engine plumbing → agent-buildable, but keep the *interpretation* conservative.
- Byte-verify against a real fixture, not synthetic text.
- Don't let a formatting *inference* become ground-truth in calibration without
  human confirm (same discipline as the agent-work-record / deprioritized traps).
