# WP-COMPANION-COHERENCE — teach the system, stop sedimenting rules

**Date:** 2026-07-16 · **Status:** brief for Ross's ratification · **Origin:** Ross's
ruling, tonight, verbatim in substance: *"keeping a list of verbs to trigger actions
on doesn't seem scalable, nor does it respect that we have an LLM that should handle
natural language. The issue is in the coordination and the teaching of the LLM on how
it fits into the entire voice-companion flow — where prework is, its ability to go
through the field, where its operators are, its agenda, its rituals. Look at this
holistically: do we have the best and durable way of making these agents interact
appropriately, or not?"*

Answer, in one line: **the interaction mechanics between agents are sound; the
teaching layer inside each agent is a sediment of incident patches, and that is the
non-durable part.** This brief is the audit (Phase A) and the redesign (Phase B).

---

## PHASE A — THE AUDIT

### A1. Where teaching text lives today (the surface inventory)

Nine places instruct the companion, maintained by hand, each with its own idiom:

| # | Surface | Location | Size / shape | Served |
|---|---------|----------|--------------|--------|
| 1 | Check-in protocol | `checkin-packet.ts` `protocolText()` — preamble, 7-obligation COMPLIANCE CONTRACT, reconciliation note, 3 lens bodies, session-close step, navigation recipe, operator playbook, ledger pointer, sessionBrief note, 3 mode tails | ~10 KB | **on every packet call**, every surface |
| 2 | Voice protocol | `voiceProtocolText()` — a **hand-forked parallel** of #1 (voice preamble, interaction rules, 7-obligation voice contract, evening script, voice close, 2 tails) | ~4 KB | every voice packet |
| 3 | Operator doctrine | `get-doctrine.ts` `DOCTRINE_TEXT` — assembly line, license ladder, per-item-state, per-moment, compositions, peer coordination, **19 invariants** (§7) | ~200 served lines | once per session (when the model remembers to call it) |
| 4 | Tool descriptions | every `*_TOOL_DESCRIPTION` — behavior + **trigger vocabulary** + phrasing exemplars | ~0.5–2 KB each × ~30 tools | in the tool schema, every call |
| 5 | Capability ledger | `mcp/index.ts` CAPABILITIES — purpose / whenToUse / unlocks per capability | ~1 KB each | on list_capabilities |
| 6 | Runner pass prompts | `prework-runner.ts` — 5 pass-kind system prompts + injected blocks (groomer agenda, peer arrivals, day-graph gather) + whitelists | ~1–2 KB each | per scheduled pass |
| 7 | Voice identity block | `companion-backend.mjs` IDENTITY — spoken register, no-CoT, hard latency rule | ~1.5 KB | every voice session |
| 8 | ElevenLabs agent config | dashboard-side prompt | small | every call |
| 9 | Pin tests | `test-mcp-gateway.ts` etc. — **regex pins on prose phrases** | ~40 pins | CI-time |

Two structural observations before any content critique:

- **The registers are hand-forked.** #2 is a manual compression of #1; every
  obligation edit is a two-place edit and the pin suite is what catches drift —
  i.e., we already pay a maintenance tax to keep two copies of the same contract
  coherent, and it grows linearly with obligations × registers.
- **The pins ossify wording, not behavior.** A pin like `/A PARK IS A FILED VERB,
  NEVER A NOD/` locks the *sentence*. You cannot rewrite the doctrine for coherence
  without touching ~40 regexes. The tests protect the sediment.

### A2. The duplication audit (obligation → homes)

Counted against the sources read tonight (engine `8fdea5e` + PRs #522/#523):

| Obligation | Homes | Where |
|---|---|---|
| One question, one budget | **~10** | contract cl.5 · voice contract cl.5 · MORNING_BODY step 2 · PREPARE_TAIL · VOICE_PREPARE_TAIL · PREWORK_TAIL · doctrine §1.7 · doctrine §4-morning · doctrine §7 invariant · `mustAsk`/`directive` packet fields |
| Now-or-wing routing | **~8** | contract cl.7 · voice contract cl.7 · 3 lens bodies · doctrine §4-morning · doctrine §6-handoffs · doctrine §7 invariant (+ postclose runner prompt) |
| Artifacts never chat-only | **~5** | contract cl.6 · voice contract cl.6 · doctrine §1.9 · doctrine §7 invariant · postclose sweep prompt |
| 30-day horizon | **~5 prose + 2 structural** | doctrine §7 · voice evening script (vii) · evening agenda reorder · widget fold `b2fb548` · packet fold #522 |
| Park is a verb (age: 1 day) | **5** | tool description trigger-vocab · doctrine §1.9 · doctrine §7 invariant · §1.7 ask-step line · capability ledger |
| Peer question ≠ user attention | **~4** | doctrine §6 · doctrine §7 · runner peer-arrivals block · contract-adjacent |

The park row is the self-indictment: the *newest* obligation, written under full
awareness of the house style, acquired five homes on day one — because five homes
is what the current architecture *requires* for an obligation to be seen by every
surface. The problem is architectural, not authorial discipline.

And the decisive empirical fact: **the one-question obligation failed live while it
had eight prose homes, and began holding only when `mustAsk` moved it into the data**
(#477). Same for the day-graph beat (#521 `directive` + early ordering) and deck
quality (#520 gate). The data-inline/gate pattern is 3-for-3; prose repetition is
0-for-3 on the same obligations.

### A3. The incident ledger, re-classified

Every incident that produced a rule, classified by what actually failed:

| Incident | Patched as | Actual failure class |
|---|---|---|
| Plaud "blocked pending tool access" — invented a raw-file-fetch step, filed 3 questions, blocked 5 plan items | (unpatched; intake-literacy invariant proposed) | **World-model** — doesn't know how channel intake works |
| Markdown file shipped as a "slide" | know-your-shop invariant + #520 guide-gate | **World-model** — didn't know its shop |
| "Six days quiet" for a 2-months-overdue item | register line in the 30-day invariant | **World-model** — misread what lifecycle measures |
| Walked a 14-item cluster live on a phone line | now-or-wing extension to voice | **World-model** — didn't know the wing exists for digs |
| Spoken chain-of-thought on the line | identity-block register fix | Register (right home, right fix) |
| Parks touched no state | **#523 verb** | **Capability gap** — the verb genuinely didn't exist |
| Stale-walk, three strikes | **#522 structural fold** | **Policy needing structure** |
| oneQuestion offered-never-asked | **#477 mustAsk (data-inline)** | Attention — fixed by moving obligation into data |
| dayGraph in context, unspoken ×2 | **#521 directive + ordering (data-inline)** | Attention — same fix, same success |
| Outbox dup spam (7× slide) | **#510 idempotency gate** | Structural (right fix) |

The pattern that matters: **the world-model failures are one failure occurring in
different subsystems.** Know-your-shop taught the *tool registry* — and the very
next world-model gap surfaced in the *intake pipeline*, untouched by that invariant.
Rules chase the symptom sites of a single cause: **nobody ever taught the companion
the system it lives inside.** There is no document, anywhere in the nine surfaces,
that explains how a recording becomes records, what the passes are and why, or what
each surface *is*. The doctrine teaches judgment and obligations; the protocol
teaches ritual steps; the descriptions teach tools. The *system* is taught nowhere.

### A4. What is sound (explicitly keep)

- **Typed verbs at the API boundary.** A closed enum + HITL ratification lane is a
  *contract with the substrate*, not keyword matching. The LLM's job is mapping
  natural language onto a small state model — exactly what it's good at, **given
  the state model**. (What's brittle is the synonym lists bolted onto the
  descriptions to compensate for the state model never being taught.)
- **Document-mediated agent coordination.** Captures, staging, the companion plan,
  the outbox, proposals — the blackboard pattern. Auditable, durable, and notably:
  *no incident in the ledger is an inter-agent coordination failure.* Every failure
  was inside one mind's understanding.
- **Gates at write boundaries** for true non-negotiables (#520, #510).
- **Data-inline directives** where the data itself carries the obligation (3-for-3).
- **Calm absence / fail-closed-but-visible / plain product language** — house laws,
  untouched by this WP.
- **Scope whitelists per pass** — structural enforcement of write-rights.

---

## PHASE B — THE ARCHITECTURE

Five layers, one rule. Each obligation and each fact about the system lives in
**exactly one authored home**; everything else is *derived or mechanical*.

### L0 — THE SYSTEM MAP (new; the missing layer)

One stable document that teaches the companion **what it is inside of**:

- **One companion, many sittings.** The 07:00 prework pass, the 12:15 delta, the
  17:15 closure, the postclose wing, the attended voice call, the text session —
  the same mind at different hours with different write-rights. Why unattended
  passes stage-and-stop; why attended sessions capture.
- **How the field works.** Documents → ingestion → records → derived views
  (buckets, receipts, entity cards, day graph). *A synced recording IS its
  records.* Channels sync passively; `pending: 0` means nothing waits; health rows
  say when a channel is broken; there is no raw-file-fetch step. (This paragraph
  alone would have prevented the Plaud incident.)
- **The item state model.** An item is open until a human ratifies a disposition.
  The companion's verbs are *proposals*: complete → resolve · date moved → re_date
  · related → link · set aside → park (snooze) · wrong fact → correction. The
  user's natural language maps to these **by meaning** — no trigger vocabulary.
- **What each surface is.** Packet = the shared table (never re-derive the day);
  plan = the wing's own book; outbox = the delivery lane that never sends itself;
  questions = the one-ask budget plus the filed queue; staging = prework's only
  write; capture = the meeting's minutes.
- **The day's rhythm** and what each moment is *for* (confer vs produce).
- **What the companion is not:** ground truth, a scheduler, or silent.

Target: **≤ 2 pages**, versioned, served once per session as a *cached block*
(voice backend already stacks cached system blocks — L0 slots in at block 0 and
pays for itself in latency under the hard-latency rule). Draft v0 ships with this
brief: `COMPANION-SYSTEM-MAP-v0-2026-07-16.md`.

### L1 — DOCTRINE, shrunk to judgment

What remains doctrine: the license ladder, phrasing and register, calibration
(taste), the composition patterns (§5), peer-coordination judgment. What leaves:
every compliance obligation (→ L2/L3), every system-explanation (→ L0), every
trigger vocabulary (→ deleted; L0's state model replaces it). Expected effect:
§7's 19 invariants collapse to the handful that are genuinely *judgment* ("precision
over nag", "absence is a question").

### L2 — THE PACKET stays data; obligations ride inline where data carries them

The `mustAsk` pattern, generalized: any section whose presence creates an
obligation carries a machine-readable `directive` field. The obligation text is
authored **once** in the obligation registry (below) and stamped into the section
at build. The agenda-cursor WP slots in here unchanged.

### L3 — GATES, reserved for non-negotiables

Unchanged in kind (#510/#520 class). The redesign *stops using invariant-prose as
the primary control surface*, which is different from abolishing structure — gates
remain the enforcement of last resort for the few things that must never happen.

### L4 — GRADES become mechanical

The postclose grader checks compliance from telemetry, not vibes: `mustAsk`
present → did `answer_question` fire with that qid? Artifact named in transcript →
did `propose_to_outbox` fire? Park spoken → did a `snooze` proposal file? Cluster
directive present → was a cluster beat in the capture? Emitted as the per-axis
JSONL already promised to the WF lane. **Design test for every future obligation:
if it can't be mechanically graded, it probably shouldn't be an obligation** — it's
judgment, and belongs in L1.

### The single-source mechanism: the obligation registry

A typed table (one file, engine-side) is the *only authored home* for obligations:

```
{ id: 'one-question-budget',
  statement: <the one authored sentence>,
  registers: { text: <derived-full>, voice: <derived-compressed> },
  appliesTo: ['attended', 'voice'],          // pass kinds
  packetHook: 'oneQuestion.directive',       // L2 stamp point, if data-carried
  gradeCheck: 'answer_question fired with offered qid',   // L4 probe
}
```

`protocolText()` / `voiceProtocolText()` **compile** their contracts from the
registry. Pin tests move from prose regexes to registry shape: *every obligation
has exactly one entry; every entry appears in each applicable register; every
entry names its grade probe.* Rewording a sentence becomes a one-line diff with
pins intact. The voice register stops being a hand-maintained fork.

---

## MIGRATION — each phase removes prose as it lands

| Phase | Ship | Remove | Acceptance |
|---|---|---|---|
| 1 | System Map v1 served (`get_system_map` or doctrine §0; voice cached block 0; runner block 0) | the system-explanations scattered in protocol/doctrine (ledger pointer prose, capability-registry re-explanations ×3) | Plaud-class probe: a fresh session, asked to "process the July recordings", reads records instead of requesting files |
| 2 | Obligation registry + compiled contracts | hand-forked voice contract; duplicate obligation prose in lens bodies/tails | byte-diff: served text carries each obligation once per register; pin suite migrated to registry shape |
| 3 | Trigger-vocab strip | synonym lists in tool descriptions (park, resolve, etc.) — state model teaching lives in L0 | closure-lane tests green; a live park in natural words still files (graded) |
| 4 | Mechanical grade checklist (L4) | grading-by-narrative for the covered axes | one graded day produces per-axis JSONL with zero human transcription |
| 5 | Doctrine shrink to judgment | §7 invariants that moved to registry/gates/L0 | doctrine < half current length; WF co-sign (shared surface) |

**Disposition of in-flight work:** #522 merges as-is (it *is* L2/L3 — structure).
#523 merges as-is — the verb, lane, and projection are the durable state-model
half; its trigger-vocab and invariant additions are relocated (not reverted) in
Phases 3/5. The agenda-cursor build waits for Phase 1 so it lands inside L2 rather
than adding a tenth teaching surface.

**Governance:** doctrine and registry are shared surfaces with the WF lane — every
phase that touches them co-ships under the existing boundary contracts. Voice
backend changes follow the paid-for deploy discipline (env sourcing, md5 verify).
The ElevenLabs dashboard prompt (surface #8) folds into L0's identity paragraph so
the dashboard carries only transport config.

## Measures of success

1. **Homes per obligation:** ~5–10 → 1 authored + derived.
2. **Served instruction bytes per attended turn** (protocol + identity + doctrine):
   measurably down; L0 cached, packet near data-only.
3. **World-model incident recurrence:** the class stops appearing in new
   subsystems (probe per Phase-1 acceptance).
4. **Grade mechanization:** % of graded axes computed from telemetry without
   reading prose — target 80%+ of the standing contract.
5. **Pin fragility:** rewording an obligation = 1-line registry diff, 0 pin edits.
