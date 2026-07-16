# COMPANION NETWORK — AS-BUILT REFERENCE (2026-07-15)

**What this is:** the definitive record of what WP-COMPANION-NETWORK actually
shipped, how it behaves (everything below was live-verified on the demo-droplet
rig, not just unit-tested), and how to use it. Written for two consumers:
1. **The UI/UX build** — §6 is the surface inventory: every piece of data the
   app can render, its shape, its invariants, and the exact user-facing strings
   already in the product.
2. **Multi-user onboarding** — §7 is the runbook for linking two real users.

The design of record remains `WP-COMPANION-NETWORK-BRIEF-2026-07-13.md`; where
this doc and the brief disagree, THIS doc reflects what's on main.

**Status:** the full transactional coordination loop is DONE and demonstrated
end-to-end on live infrastructure (2026-07-15): a question filed by user A,
routed to user B's companion, answered faithfully by B's companion with no
human present, returned as durable substrate, offered to A as a truthful
one-tap accept card (including in the voice registers), and closed on A's tap.
Two human acts total; everything between was bare unattended passes.

---

## §0 PR ledger (all engine = AI-Light-Prototype, all merged to main)

| PR | What it did |
|---|---|
| #468 + #471 | P1 pipe: `server/peer/` (links/secrets/dispatch/health/flags), `addressedToPeer` outbox, dispatch route, `frameHint` |
| #474 | `ingestedAt` mapped into DocumentEntry — un-broke intake receipts for EVERY channel (plaud/email/peer), product-wide |
| #475 | Receipts attribute peer arrivals as `peer:<peerId>` channel |
| #482 | Envelope title double-prefix fix |
| #484 | P2 verbs: `envelope_kind` question/answer/receipt, `in_reply_to`, `fact_key`, intake rows carry kinds, `peerAnswer` fold-back, doctrine §6/§7 |
| #488 | peerAnswer field-read fix + peer-answered close-by-id path on `answer_question` |
| #489 | PATCH ratifications immediately visible to MCP reads |
| #497 | Staged fold-back: `PreworkAcceptCard` + `accept_cards` on `stage_prework` (grounding gate), peer triage in the pass contract, voice-register accept-card lines |
| #498 | Runner pre-injects peer arrivals (watermark-independent, once-per-doc marker); accept-card summaries EXTRACTED from the envelope (model summary ignored); viewer-alignment posture warning |
| #505 | Identity-less viewer lanes unified (+ migration of stranded stores); triage markers mark-on-bank |

Threshold repo: #166/#167 (the brief + amendments). Flags `PEER_LINKS_ENABLED`
and `PEER_AUTOAPPROVE_SEND` are enrolled `'false'` in pilot-full — **nothing
here is active on any pilot droplet.**

## §1 Concept map (read this first)

Two products were deliberately separated:
- **(a) Standing corpus enrichment** — continuous shared projections. NOT
  BUILT; gated on the Enron-dyad identity validation (P3). Its unsolved
  problems (cross-account entity identity, revocation-can't-unsee, chaperone)
  are quarantined there.
- **(b) Transactional companion coordination** — THIS IS WHAT'S BUILT. Peers
  exchange discrete, human-gated, self-contained **envelopes**. Each envelope
  is structurally email: a consented disclosure act, revocation-moot,
  identity-matched per-message via hints.

Core principles wired into the code (not just documented):
- **The receiver's pipeline is sovereign.** An envelope is just a document; the
  receiving corpus's own extraction mints whatever records it mints. There is
  NO cross-corpus record minting and NO remote mutation of any kind.
- **Nothing flips state without a human.** Closures arrive as INERT proposals;
  peer answers arrive as INERT accept cards; both are test-pinned.
- **References are hints.** `senderRecordIds`/`entityHints`/`frameHint` are
  provenance and placement *priors*, never dereferenced by logic.
- **Attention budget:** a peer question NEVER spends the receiving human's
  attention by default — the companion field-answers it; only unanswerable
  ones enter the global one-question budget. (Held under live test.)
- **Fail-closed-but-visible:** failed dispatches hold `pending` with a visible
  error; dead links show `disconnected` with a reconnect hint; ungroundable or
  unverifiable accept cards are refused with named errors — never silence.

## §2 The plumbing

**Peer link** — `reference/_metadata/peer-links.json` per engine (hand-editable
JSON, atomic writes, mtime-reload, no restart needed):
```jsonc
{ "version": 1, "selfPeerId": "ross-r",
  "links": [{ "peerId": "elena-p", "label": "Elena", "baseUrl": "https://…",
    "direction": "both",              // send | receive | both
    "scopes": ["handoff","question","answer","receipt"],
    "outboundTokenRef": "peer-elena-p", "status": "active",
    "createdAt": "…", "revokedAt": null }] }
```

**Identity & credentials:** the outbound bearer for a link is a standard
`apolla_` token row minted in the RECEIVING engine's `users.json`
(label `peer:<peerId>`, email-form `peer+<peerId>@<host>`). This buys
attribution (`submittedByEmail` stamping via the existing bearer machinery) and
revocation (clear the row — mtime-reload) with zero new auth code. The token
value lives ONLY in the sender's `peer-secrets.json` (never returned by any
route; fingerprint-only everywhere else).

**Transport:** sender's `peer-dispatch` POSTs the envelope to the peer's
existing `POST /api/ingest-document` (fast-ack, bearer). No new receiving
endpoint exists. Dispatch fires from (a) the human send action —
`POST /api/outbox/:id/dispatch-peer` on the app bearer lane (flag-off ⇒ calm
`{enabled:false}`), or (b) automatically at queue time when
`PEER_AUTOAPPROVE_SEND=true` (EXPERIMENT MODE — loud boxed boot banner +
posture warning; never for real users' corpora).

**Health:** one `peer:<peerId>` channel row per active link on the SENDER side
(`ok` / `stale` / `disconnected`-with-reconnectHint), served in boot posture,
`/api/diagnostics`, and the check-in packet's `intake.health` — same ledger as
plaud/email. Revoked token ⇒ 401 ⇒ item held `pending` with
`lastDispatchError {at, message, status}` + row flips `disconnected`
(live-verified both directions).

## §3 The envelope (contract v1, as-built)

A self-contained document. `PEER-<senderPeerId>-<id>` documentId; title
`"<Kind> — <subject> — <date>"` (kind prefix never doubles, #482).
`sourceMetadata` as actually emitted:
```jsonc
{ "captureMethod": "peer-link", "captureTool": "apolla-companion",
  "peerId": "ross-r",                    // sender's self-id
  "envelopeKind": "handoff|question|answer|receipt",
  "inReplyTo": "PEER-…",                 // answer/receipt only (required)
  "factKey": "mcpq:…",                   // question/answer (the never-re-ask join)
  "senderRecordIds": ["…"], "entityHints": ["…"], "frameHint": "…"  // hints only
}
```
Content rule: the body must read as a complete message to a human — the
receiving side's extraction, accept-card extraction, and voice surfaces all
assume self-contained prose.

## §4 The verbs — how each loop actually runs (all live-verified)

**Queueing (all kinds):** MCP `propose_to_outbox` with `addressed_to_peer` +
`envelope_kind` (+ `in_reply_to` for answer/receipt, `fact_key` for
question/answer, `entity_hints`, `frame_hint`). Queue-time validation gives
typed refusals naming the missing link/scope (`peer_link_unavailable`, …);
NOTHING queues on refusal. Items ride the normal outbox lifecycle
(pending → sent | dismissed) and render alongside classic items.

**Question → Answer (the flagship loop):**
1. A-side human (or attended companion) files a question (`file_question`,
   mcpq factKey) and routes it: outbox item kind `question` + `fact_key`
   (validated open-local). Human sends (or auto-approve dispatches).
2. B-side: envelope lands as receipted intake (`channel: peer:<A>`); B's
   UNATTENDED pass gets it pre-injected into its opening turn (§5), answers it
   FROM B's FIELD, queues the answer envelope (`in_reply_to` + factKey
   passthrough). B's human never sees it (attention budget) unless the field
   can't answer — then it becomes B's own filed question in the global budget.
3. A-side: the answer lands as durable substrate; `peerAnswer {docId,
   receivedAt}` attaches to the still-open question (deterministic factKey
   equality, NO auto-apply); A's unattended pass stages a
   **PreworkAcceptCard**; A taps accept in an attended session →
   `answer_question` closes by id citing the envelope ("the question never
   re-asks"). Immediately visible on the next read (#489).

**Handoff:** kind `handoff` with the baton-as-content; receiver's extraction
mints commitments/`depends_on` natively (proven: correct owners, auto-minted
dependency edges).

**Receipt → co-signed closure:** B sends kind `receipt` (`in_reply_to` the
handoff) with closure evidence; A's side surfaces it (kind + trace fields in
the intake row), A's companion proposes `propose_record_edit` resolve — INERT —
A's human ratifies via the existing PATCH lane → record resolves. Full chain
live-verified. This is the two-corpus error-correction win (closure recall
0.49→0.83 in the founding experiments) landing in product.

**Accept card (the trust artifact):**
```jsonc
{ "questionId": "mcpq:…", "answerDocId": "PEER-…",
  "peerLabel": "Elena's side",
  "summary": "<EXTRACTED from the envelope body — the model's proposed summary is IGNORED>",
  "stagedBy": "org" }
```
Two gates, both fail-closed with named errors: **grounding**
(`ungrounded_accept_cards` — must name an open question whose factKey matches
that exact envelope) and **faithfulness** (summary derived server-side from the
answer's own bottom line; unreadable body ⇒ `unverifiable_accept_cards`).
Rationale for extraction-not-overlap (pinned by test): a refuting answer QUOTES
the stale value it corrects, so word-overlap passes exactly the misleading
summary it should reject.

## §5 Unattended machinery

- Master enable is **ENV-only**: `PREWORK_RUNNER_ENABLED=true` +
  `PREWORK_RUNNER_USER_EMAIL=<the user's login email>` (must be a real viewer
  identity or `org`; misalignment fires the `preworkRunnerViewerAlignmentWarning`
  posture warning). The store can never turn the runner on. Cron per-pass;
  `run-now` for on-demand.
- **Arrivals are pre-injected:** the runner deterministically gathers pending
  peer-link docs (watermark-INDEPENDENT) into the pass's opening turn as a
  structured block, with a persisted once-per-doc marker written **on bank,
  not on offer** (a crashed pass re-offers). Lesson encoded: never rely on the
  model electing to call the tool that would show it its own agenda.
- **Doctrine §6 triage order** (what every pass is taught): ANSWERS (stage
  accept cards) → QUESTIONS (field-answer, queue the reply; the send gate
  governs dispatch) → RECEIPTS (inert resolve proposals) → HANDOFFS
  (now-or-wing). §7 invariant: "A PEER QUESTION NEVER SPENDS THE USER'S
  ATTENTION BY DEFAULT."
- `answer_question` remains FORBIDDEN on all unattended passes — closes happen
  only in attended sessions, via the accept card.
- Observed pass economics on the rig: ~$0.05–0.08/pass (Sonnet), ~30–45 tool
  calls, zero forbidden-tool violations across every graded run.

## §6 SURFACE INVENTORY — for the UI/UX build

Everything below EXISTS and is serving data today. No engine work is needed to
render any of it; all of it is currently MCP/API-only (zero app surfaces
built — deliberately, per the one-pair-of-eyes rule).

| Data | Where it's served | Shape / key fields | Natural surface |
|---|---|---|---|
| Peer links + health | `/api/diagnostics` channels, `intake.health`, boot posture | `{channel:"peer:<id>", state: ok\|stale\|disconnected, reconnectHint}` | Settings → Integrations "Connections" doctor card per link (reuse the channel-card pattern; disconnected ⇒ reconnect affordance) |
| Addressed outbox items | outbox store / existing outbox surfaces | `addressedToPeer`, `lastDispatchError{at,message,status}`, `proposedBy:'mcp-agent'`, artifacts | The outbox companion card + a "to <peer>" chip; pending-with-error = visible held state, NEVER silent |
| Peer arrivals | check-in packet `intake.received` | `{title, channel:"peer:<id>", envelopeKind, inReplyTo, senderRecordIds, ingestedAt}` | Today brief intake band: "2 questions, 1 receipt from Elena's side" |
| Accept cards | packet `prework.acceptCards` | `{questionId, answerDocId, peerLabel, summary, stagedBy}` | **The flagship card**: one-tap "Accept & close" in the Today brief; tap → `answer_question` by id |
| peerAnswer on questions | `get_questions` rows | `peerAnswer{docId, receivedAt}`, `peerAnswerDocId` | Questions surface: "answered by Elena's side" badge; open the envelope as evidence |
| Inert resolve proposals | proposals read-back / ratify inbox | `{verb:"resolve", proposalId, status:"proposed"}` citing the receipt envelope | Existing ratify affordances; "Elena's side reports this done — confirm?" |
| Voice/register lines | check-in registers (incl. voice) | deterministic `peerAcceptCardPrompt` | Already speaks: **"Elena's side answered your question — accept and file it?"** — arrivals-first in evening voice, opener in morning standup |
| Experiment banner | boot posture / diagnostics warnings | `PEER_AUTOAPPROVE_SEND` boxed warning | If ever surfaced: a loud "auto-send is ON" badge; this mode is not for real users |

**Language canon (already in product strings — keep it):** "<Peer label>'s
side" for the counterpart companion; "answered your question — accept and file
it?"; kinds render as Question/Answer/Handoff/Receipt. NEVER surface:
"envelope", "peer-link", "factKey", "dispatch", or any operator jargon.

**Invariants the UI must not break:**
1. The accept tap is the ONLY way a peer answer closes a question; render the
   summary verbatim (it's extraction-grounded — editing it re-opens the
   faithfulness hole).
2. A receipt never shows as "done" — it shows as "reported done, confirm?"
   until ratified.
3. Suppressed/held things get counts and affordances (held dispatch errors,
   refused cards), never disappearance.
4. Conflicts coexist: if the peer's substrate disagrees with local substrate
   (dates, owners), show both with provenance; the machinery deliberately
   never auto-supersedes across the boundary.
5. Provenance is displayable everywhere: every peer-derived thing traces to
   its envelope doc, which traces to a send the sender's human approved.

## §7 ONBOARDING RUNBOOK — linking two real users (A ↔ B)

Prereqs per side: engine ≥ #505 deployed; `ENGINE_PROFILE=pilot-full` plus
explicit `PEER_LINKS_ENABLED=true` (it is `'false'` in the profile — deliberate);
email-login live so each user has a real identity; org-state backup taken.
**Leave `PEER_AUTOAPPROVE_SEND` OFF for real users — the human send gate IS the
product'ssovereignty promise.**

1. **Mint inbound identities (each side):** on B's engine, add a `users.json`
   row for A's companion — label `peer:<A-peerId>`, email
   `peer+<A-peerId>@<A-host>`, fresh `apolla_` token. Mirror on A's engine.
   (Hand-edit today; the grants-writer UI is future work.)
2. **Write the link files (each side):** `peer-links.json` (selfPeerId, the
   counterpart's peerId/label/baseUrl/direction/scopes) + `peer-secrets.json`
   (outboundTokenRef → the token the OTHER side minted for you). Transfer the
   token out-of-band; verify files with a read-back; no restart needed.
3. **Scope deliberately:** start `direction:"both"`, scopes
   `["question","answer","receipt","handoff"]` — or narrower (e.g. a
   question/answer-only link is a real, useful posture).
4. **Runner alignment (per side, if unattended passes are wanted):**
   `PREWORK_RUNNER_ENABLED=true` + `PREWORK_RUNNER_USER_EMAIL=<that user's
   login email>`; confirm the alignment posture warning is ABSENT.
5. **Smoke it attended first:** A files a question, routes it, human-sends via
   the dispatch route; confirm B's intake receipt (`peer:<A>` channel), B
   answers attended; confirm A's peerAnswer + accept card + close. Then let
   the unattended passes take over.
6. **Watermarks:** each user should have done one `mark_seen` check-in before
   arrival counts are meaningful (receipts need a baseline).
7. **Revocation:** clear the counterpart's token row (mtime-reload, instant) +
   set the link `status:"revoked"`. The sender sees `disconnected` + held
   items with visible errors. Disclosed envelopes remain (disclosure is final,
   like mail) — set that expectation with users up front.
8. **What to monitor:** the `peer:` health rows (3× cadence ⇒ stale; 401 ⇒
   disconnected), held outbox items with `lastDispatchError`, and the posture
   warnings. All fail-closed-but-visible.

## §8 The experimental rig + ops notes

- **Demo droplet** hosts the permanent two-user rig: `apolla-exp-r` :3041
  (Ross-corpus copy) + `apolla-exp-p` :3042 (Elena persona, 21 docs / 123
  records, ground-truth seed ledger in `~/scratch/tier1-persona/PERSONA.md` —
  seeds S2-1/2/4 consumed, S2-3 consumed by the closing run; S1/S3/S4 partially
  exercised). Loopback-only; live demo (`apolla`) and `waitlist` untouched.
  Experiment flags currently ARMED (auto-approve + runner); cron idle.
- Evidence trail: `~/scratch/tier0-acceptance-2026-07-13/`,
  `p2-acceptance-2026-07-14/`, `unattended-*-2026-07-15/` (+ Tier-1 deploy).
- Gotchas that cost time (don't rediscover): MCP needs the SDK
  StreamableHTTP client (raw curl fails); `cachedData` refreshes ~30–60s after
  ingest; receipts need a `mark_seen` watermark; peer bearer rows live in
  `users.json` NOT `mcp-tokens.json`; engine worktrees need `npm install`
  before trusting tsc; the runner master is ENV-only.
- **Open items:** `search_records` returned 0 on the exp rig's bearer lane
  (unexplained — verify before building UI on it); envelope v2 license
  inheritance (min-of-chain on relay — committed, lands with the next verbs
  change); demo swapfile (needs Ross sudo); no purge endpoint (mis-received
  docs are manual); grants-writer UI unbuilt.

## §9 Not built (deliberately) — the next frontier

- **P3 standing projections** (N1-on-server / N2 bridge-entity joins): gated
  on an Enron-dyad identity-matching validation. Every factKey join and
  co-signed closure the transactional loop produces is accumulating as the
  labeled ground truth for exactly that gate. Tooling exists
  (`schema-browser/scripts/enron/`, `~/scratch/enron-emails/derived/`).
- Topic-scoped grants enforcement, per-capture private-toggle UX, backfill,
  n-ary topologies (the link schema is already per-peer — hub/care-circle
  shapes are config, not code).
- All app UI (this doc's §6 is its spec input).
