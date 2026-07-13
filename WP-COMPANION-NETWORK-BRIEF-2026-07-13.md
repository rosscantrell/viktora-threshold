# WP-COMPANION-NETWORK — networked corpora + companion-to-companion coordination

**Date:** 2026-07-13 · **Status:** DESIGN BRIEF (agreed frame, pre-build) · **Owner:** Ross
**Scope:** the link/grant schema, the addressed-outbox transport, the coordination
envelope, typed verbs, the experimental corpus plan, and phase gates.
**Repos:** engine (AI-Light-Prototype/schema-browser) is where nearly all of this
lives; Threshold app changes are limited to a Settings surface much later (out of
scope for P1–P2).

---

## 0. Thesis — two products are hiding in "network the corpora"

**(a) Standing corpus enrichment** — projections shared continuously between
corpora so each user's field is denser. This is where every unsolved problem
lives: cross-account entity identity ("two independent canons never matched",
N2 E1–E10 FINDINGS), bridge over-generation (median fan-out 27, top-1 31%),
revocation-can't-unsee, third-party chaperone.

**(b) Transactional companion coordination** — companion A hands companion B a
specific thing during prework/async: a commitment handoff, a question only the
other field can answer, a task brief, a closure receipt. Each message is an
**explicit, human-gated disclosure act** — structurally email, not a standing
projection. Revocation is moot (nobody expects to unsend mail). Identity
matching is per-message, not canon-wide.

**Build (b) first.** Its traffic — co-signed receipts, answered cross-corpus
questions — is exactly the labeled entity-identity + outcome data that (a) is
blocked on. Evidence already in hand:

- `two_corpus_recall_scratch.py` (4/4): closure recall lifts super-linearly
  0.49→0.83 when either corpus's capture suffices; false-nags −61%; co-signed
  receipts = free labeled outcomes.
- `task_assembly_scratch.py` (6/6): the execution brief is *impossible* from one
  corpus alone — the concrete "why link".
- N2 E1–E10: recompute-on-slice proven necessary; deterministic FIELD-vs-DOCS
  routing; the unsolved trio above is real and stays out of P1–P2.

And (b) is cheap because the transport already exists in halves: the
**outbox** (send gate = the sender's human) on one side, **`/api/ingest-document`
→ intake receipts → prework triage** on the other. The "coordinate through the
field" ruling generalizes across corpora — companions never need a chat channel.

## 1. Binding constraints & standing rulings

1. **Trisha's corpus is no longer available for this work** (Ross, 2026-07-13).
   All experiments run on Ross's corpus + experimental corpora on a separate
   droplet. Nothing here is pilot-facing; the release/pilot action gate is not
   triggered — but see §6 on the demo droplet.
2. **ONE COMPANION per human** (Ross, 2026-07-11): new human = new companion;
   companions coordinate through the field, never through session choreography.
3. **Ask-boundary**: drafting is free; *sending to a third party* requires the
   sender's human. Peer traffic is third-party send ⇒ human-gated on the send
   side. Receive side follows the WP-INTAKE ruling: auto-ingest, receipts are
   the trust surface (`decisionSource` union already carries user|auto|agent).
4. **Fail-closed-but-VISIBLE**: dead links, held sends, and dropped envelopes
   get counts + review affordances, never silence.
5. **Proposals never flip state** (test-pinned): cross-corpus verbs land as
   INERT proposals / standard substrate, never direct record mutation on the
   receiving corpus.
6. **Flag discipline**: every new flag enrolls in `pilot-full`
   (engine-profile.ts) in the same PR per the drift gate — here enrolled with
   explicit `'false'` (precedent: AUTH_ENABLED carried an explicit value while
   opt-in). Experiment-mode flags must additionally print a LOUD boot-posture
   warning when on.
7. **No purge endpoint exists** (sovereignty gap) — mis-sent disclosures into a
   corpus are manual to remove. This drives the §6 rule that ross.viktora.ai
   joins as SENDER-only until verbs stabilize.

## 2. The LINK primitive

A **peer link** is a mutual, scoped, hand-auditable grant between two engine
instances.

**State file:** `${META_PROJECT_PATH}/reference/_metadata/peer-links.json` —
plain JSON, atomic temp+rename, mtime-reload, hand-editable by an operator with
no restart. Same posture as `sharing-grants.json` (acl/grants-store.ts) and
`users.json`. Deterministic module, no LLM imports (extend the acl determinism
grep pattern).

```jsonc
{
  "version": 1,
  "links": [{
    "peerId": "snapshot-b",            // stable slug, unique per link
    "label": "Ross snapshot engine",   // display only
    "baseUrl": "https://exp.viktora.ai:3041",
    "direction": "both",               // send | receive | both
    "scopes": ["handoff", "question", "answer", "receipt"],
    "outboundTokenRef": "peer-snapshot-b",  // see credential posture below
    "status": "active",                // active | revoked
    "createdAt": "…", "revokedAt": null
  }]
}
```

**Credential posture (URL-as-secret precedent from the ICS lane):** the
outbound bearer for a peer is a standard per-user `apolla_` token **minted on
the RECEIVING engine** (users-store row, label `peer:<peerId>`, email-form
identity `peer+<peerId>@<sender-host>`). It is stored on the sending engine in
a separate secrets file (`peer-secrets.json`, never in peer-links.json, never
returned by any GET — fingerprint only, exactly like the ICS URL). This buys:

- **Attribution for free** — `require-bearer.ts` already resolves `apolla_`
  tokens to `addinTokenUser`; `submittedByEmail` stamps the peer identity on
  every arriving doc (when ENABLE_CORPUS_SHARING is on; harmless otherwise).
- **Revocation = the existing story** — clear the token row (mtime-reload) +
  mark the link revoked. One mechanism, already built, already documented.
- **No new auth lane** — peer ingest rides `ingestionAuth` untouched.

**Send transport:** the sender's engine POSTs the envelope to the peer's
`/api/ingest-document` (fast-ack, bearer, the one funnel every producer already
uses). No new receiving endpoint in P1.

**Health:** channel-health ledger (`ingest/channel-health.ts`) gains a
`peer:<peerId>` row per active link — `ok` / `stale` (no successful dispatch or
heartbeat within 3× expected cadence) / `disconnected` (401 from peer = token
revoked or rotated; carries a reconnect hint). Rows surface in boot posture +
`/api/diagnostics` + the check-in packet's `intake.health`, same as Plaud/email.

## 3. The addressed outbox (send side)

`OutboxItem` (outbox/outbox-store.ts) gains an additive optional field:

```ts
addressedToPeer?: string; // peerId from peer-links.json; absent = classic item
```

- Items with `addressedToPeer` render in the existing outbox lifecycle
  (pending → sent | dismissed) with the same review affordances; artifacts ride
  `artifactIds` unchanged.
- **Dispatch:** on the human's send action (or §5 auto-approve), a new
  `outbox/peer-dispatch.ts` resolves the link + secret, builds the envelope
  (§4), POSTs to the peer, and only then transitions the item to `sent`
  (`decidedAt` = dispatch ack time). A failed POST keeps the item `pending`
  with a visible `lastDispatchError` — fail-closed-but-visible, never a silent
  drop, never a phantom `sent`.
- `proposedBy: 'mcp-agent'` continues to mark companion-prepared items; the MCP
  `propose_to_outbox` capability gains the optional `addressedToPeer` arg
  (validated against active links + `direction`/`scopes` at queue time — a
  typed refusal names the missing grant, mirroring the workback verb pattern).

## 4. The coordination envelope (payload contract v1)

The envelope is a **document**, not an API object — the receiving corpus treats
it as ordinary substrate and its own extraction pipeline mints records. No
cross-corpus record minting, ever (receiver's HITL posture is sovereign).

```jsonc
// POST /api/ingest-document body, from sender's peer-dispatch
{
  "documentId": "PEER-<senderPeerId>-<ulid>",
  "title": "Handoff — <one-line> — <date>",       // or Question — / Answer — / Receipt —
  "content": "<the message body: prose + structured sections>",
  "participants": ["<sender human email>", "<receiver human email>"],
  "sourceMetadata": {
    "captureMethod": "peer-link",
    "captureTool": "apolla-companion",
    "peerId": "<sender's id for itself on this link>",
    "envelopeKind": "handoff" | "question" | "answer" | "receipt",
    "inReplyTo": "<documentId of the envelope this answers>",   // answer/receipt only
    "senderRecordIds": ["…"],   // sender-side ids, provenance only — NEVER
                                // assumed resolvable on the receiver
    "entityHints": ["acme-renewal", "brian-k"]  // sender's slugs, hints only
  }
}
```

Contract rules:

- **References are hints.** Receiver-side identity resolution is its own
  corpus's job; `senderRecordIds`/`entityHints` exist so future N2 work can
  score identity matching against real traffic — they are never dereferenced
  in P1–P2 logic.
- **Content is self-contained prose.** An envelope must read as a complete
  message to a human (the doctrine's inform-first posture applies to
  companion→companion mail too).
- **Recency/agenda posture:** envelopes are LIVE intake (not backfill) — they
  ride normal agenda eligibility. The `PEER-` documentId prefix keeps them
  auditable/greppable, mirroring `MCP-` captures.

## 5. Flags

| Flag | Default | pilot-full | Meaning |
|---|---|---|---|
| `PEER_LINKS_ENABLED` | off | `'false'` (explicit, commented) | mounts peer-dispatch, link loading, health rows |
| `PEER_AUTOAPPROVE_SEND` | off | `'false'` | **experiment mode**: outbox items addressed to peers dispatch without a human send action. LOUD boot-posture warning when on. Exists because Enron replays and unattended persona-prework runs have no human at the gate. Never on where a real human's corpus receives. |

## 6. Corpus & droplet plan (Trisha-less)

Three counterpart tiers — no single corpus covers both "someone to run the live
loop with" and "real data to validate identity against":

- **Tier 0 — Ross-snapshot pair (plumbing smoke test).** Two engine instances
  on the experimental droplet, both seeded from `~/scratch/ross-corpus-snapshot`
  (347 records). Total bridge overlap by construction — valid for pipe/protocol
  proof only, no identity claims.
- **Tier 1 — constructed counterpart persona (the live-loop corpus).** A small
  corpus authored from the other side of real interactions in Ross's field
  (shared projects/people/meetings). Its companion runs the same prework
  passes; Ross plays both humans at the gates. Honest boundary: validates
  protocol + companion behavior, NOT real-world identity matching (author
  bias — same caveat as the conversation-extract evals).
- **Tier 2 — Enron dyad (the identity-validation corpus).** Two
  heavy-correspondence employees, each corpus built from their own mailbox only
  (WP-IDR adapter + scanner, `schema-browser/scripts/enron/`, derived data in
  `~/scratch/enron-emails/derived/`). First setup ever with two genuinely
  independently-captured corpora of shared events AND ground-truth identity —
  this is what scores the cross-corpus join and gates Phase 3.

**Topology:** one experimental droplet, **multiple engine instances on distinct
ports**, each with its own corpus dir, users.json, peer-links.json, and
launcher env (`ENGINE_PROFILE=pilot-full` + explicit experiment flags).
Cross-server semantics are preserved (distinct origins over HTTP). If
demo.viktora.ai still serves prospects, keep experiments OFF it — a small
dedicated droplet is cleaner; Ross's call.

**Live-corpus rule:** ross.viktora.ai participates as **SENDER-only** until P2
verbs stabilize (no purge endpoint ⇒ received experimental docs are manual to
remove). `org-state-backup.sh` before it ever flips to receiving. All
experimental instances get integrity-gate + posture checks per
ORG-STATE-PRESERVATION.md like any other harness.

## 7. Phases & acceptance gates

**P0 — gates (verify, don't build):**
- SoP/entity-card slice-honesty fix status (task_b46892e9 outcome) — must be
  confirmed landed before ENABLE_CORPUS_SHARING is on anywhere envelopes flow.
- Email-login live on the droplets involved (merged: engine #293 + app main).
- Experimental droplet stood up; two Tier-0 instances pass the integrity gate.

**P1 — the link + dumb pipe:**
peer-links store + secrets posture; addressed outbox + peer-dispatch; health
rows; `propose_to_outbox` addressing.
*Acceptance (Tier 0):* companion on engine-A stages an outbox item addressed to
peer B during a prework pass → human (or auto-approve) sends → envelope lands
on B via `/api/ingest-document` with full provenance → appears in B's check-in
packet `intake` section with a receipt → `peer:` health rows show `ok` on both
sides; kill B's token → A shows `disconnected` with reconnect hint, item held
`pending` with visible error.

**P2 — typed verbs on the pipe (in order):**
1. **question / answer** — highest-value prework behavior: A's companion files
   a gap-question whose answerer lives in B's field (the P0 dry-run's identity
   and external-state gap classes become *routable*). A-side it rides the
   questions lane (`file_question`, mcpq factKey = never-re-ask); the envelope
   carries it to B; B's companion answers **from B's field during B's own
   prework pass** (draft → B's human gate → answer envelope back); the answer
   lands as A's substrate (answers-become-substrate, the re-ask killer,
   structurally).
2. **commitment handoff** — envelope content is the baton-with-content pattern
   (the pass-back names its expected input); receiver's extraction mints the
   commitment + `depends_on` locally (mint-lane verified 2026-07-10: action-list
   docs mint owners incl. apolla-companion, depends_on auto-minted).
3. **co-signed closure** — when both corpora hold the same commitment, either
   side's closure sends a `receipt` envelope; the receiver's companion turns it
   into an INERT `propose_record_edit` resolve proposal (never a silent flip).
   This is the error-correction win (0.49→0.83) landing in product.
*Acceptance per verb:* a scripted Tier-1 run (persona corpus) demonstrating the
full loop incl. both human gates, plus the never-silent-flip test pinned.

**P3 — standing projections (NOT in this brief's build scope):**
gated on an **Enron-dyad identity-matching validation report** produced from
real P1/P2-shaped traffic + ground truth. Only then do N1-on-server or
N2 bridge-entity joins get a build brief.

## 8. Non-goals

- No raw-corpus sync, no standing projections, no N2 bridge joins in P1–P2.
- No auto-applied cross-corpus mutations of any kind.
- No pilot exposure; nothing here ships to a pilot droplet or a pilot user.
- No revocation promises about disclosed content (disclosure is final, like
  mail; the LINK is revocable, the envelope is not).
- No new receiving endpoint, no new auth lane, no agent-to-agent chat channel.

## 9. Open questions (decide during P1)

1. Heartbeat: do idle links need a ping envelope kind, or is `stale` computed
   from last successful dispatch enough for experiments? (Lean: no ping in P1.)
2. Does the receiving companion's prework get a doctrine amendment for
   `envelopeKind` triage (answer-questions-first)? Likely yes, small.
3. `participants` on envelopes: human emails only, or peer companion
   identities too? (Affects owner-scoped pulls; watch the speaker-N slug
   pollution class from WP-IDENTITY.)
4. Where the experiment harness lives: `schema-browser/experiments/
   companion-network/` following the field-projection precedent.
