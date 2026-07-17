# WP-PEER-HANDSHAKE — connect-by-invitation for peer links

**Date:** 2026-07-15 · **Status:** DESIGN BRIEF (pre-build) · **Owner:** Ross
**Parent:** `COMPANION-NETWORK-AS-BUILT-2026-07-15.md` (§7 is the manual runbook
this WP automates; §2 is the link machinery it drives). Design of record for
the underlying link semantics: `WP-COMPANION-NETWORK-BRIEF-2026-07-13.md`.
**Scope:** the invite/accept wire protocol, the accept-screen scope picker, the
Connections card lifecycle, and the v2 lookup registry's privacy contract.

---

## §0 Product frame

**v1 is connect-by-invitation: you invite someone you already know, by email.
There is NO directory, NO search, NO browse.** Discovery never discloses more
than the seeker already knows; connection is always mutual, explicit, and
scoped. This is the Signal/Keybase pattern and it is load-bearing for the
sovereignty story — a browsable who-uses-this directory is itself a
disclosure, and v1 refuses to create one.

What the user experiences:
1. A opens Settings → Connections → "Invite someone", enters B's email, picks
   what the connection may carry (plain-language scope picker), adds a note.
2. B gets an email: "Ross wants to connect your workspaces." Clicking lands B
   in **B's own app** on an accept screen: who's asking, what they proposed,
   B's own scope picker (B may narrow), Accept / Decline.
3. On accept, the two engines complete the credential exchange automatically.
   Both users see an **active connection card** with its scopes and health.
   Nothing else changes — all traffic still rides the human send gates.

This compresses the as-built §7 runbook (hand-edited `users.json`,
`peer-links.json`, `peer-secrets.json`, out-of-band token transfer) into one
email and one accept screen.

## §1 The handshake protocol (wire)

Terminology: A = inviter, B = invitee. Each side's engine is single-tenant and
speaks TLS to the other's public baseUrl.

**1. Invite creation (A's engine).**
`POST /api/peer/invites` (app bearer lane) with `{email, proposedScopes[],
note?, label?}` →
- Creates a row in a new `reference/_metadata/peer-invites.json` store
  (grants-store posture: atomic write, mtime-reload, hand-auditable):
  `{inviteId, inviteTokenHash, invitedEmail, proposedScopes, note, selfPeerId,
  selfLabel, selfBaseUrl, state: 'sent', createdAt, expiresAt, singleUse: true}`.
- The invite token is a capability: random ≥128-bit, stored **hashed** (the
  magic-link precedent), single-use, default expiry **14 days**.
- Sends the invite email via the existing email-provider (`EMAIL_API_KEY` —
  note the RESEND_API_KEY naming gotcha). The email carries ONE link to A's
  engine: `GET /peer/invite/<token>`.

**2. The landing page (A's engine, auth-exempt route).**
`GET /peer/invite/:token` serves a minimal public page (no corpus data; shows
only what A chose to disclose in the invite: A's label, note, proposed scopes):
- "Open in Threshold" → deep link
  `apolla-threshold://peer-invite?token=…&host=<A-baseUrl>` (mirrors the auth
  deep-link pattern — Rust `on_open_url` → app event → accept screen).
- No-app path: install/waitlist pointer; the invite stays `sent` until expiry.
- Route joins the auth-exempt prefix list; the #414 lesson applies — the
  bearer-audit test must pin it in the same PR.

**3. Accept (B's app → B's engine → A's engine).**
B's accept screen POSTs to B's OWN engine (`/api/peer/handshake/accept`, app
bearer lane) with `{inviteToken, inviterBaseUrl, acceptedScopes[], label?}`.
B's engine then does its half and calls A's engine **server-to-server**:
- B's engine mints the inbound token row for A (`users.json`, label
  `peer:<A-peerId>`, email-form `peer+<A-peerId>@<A-host>`), writes its own
  `peer-links.json` entry (`status:'pending-confirm'`) + secrets placeholder.
- `POST <A-baseUrl>/api/peer/handshake/complete` authenticated BY THE INVITE
  TOKEN ITSELF (single-use, consumed on success) carrying
  `{peerId, label, baseUrl, scopes: acceptedScopes, inboundTokenForA}`.
- A's engine validates + consumes the token, mints ITS inbound row for B,
  writes its link + stores B's token in `peer-secrets.json`, and returns
  `{peerId, label, inboundTokenForB, activeScopes}` in the response. B's
  engine stores that token, both sides flip the link `active`.
- One round trip; both tokens only ever travel inside this TLS exchange.

**4. Scope algebra (consent rule).**
`activeScopes = intersection(proposedScopes, acceptedScopes)` — B may NARROW
without further ceremony; a link can NEVER activate wider than what A's human
proposed and B's human accepted. Widening later = a fresh invite for the added
scopes (same protocol, additive to the existing link). Direction in v1 is
always `both` at the transport level — the scope set is the real control.

**5. Failure and hygiene.**
Every state is visible: `sent` (with expiry countdown, resend + cancel),
`expired`, `declined` (B may decline with/without a reason; A sees declined,
not why, unless B adds a note), `accepted/active`, `revoked`. Invite ledger
entries are append-only for audit. Rate-limit invite creation (per-day cap).
A cancelled or expired token fails the complete-call closed with a typed
error. Nothing about this flow auto-retries silently.

## §2 The accept screen + scope picker (UX contract)

The scope picker speaks the product language, never the wire vocabulary:

| Wire scope | Picker label |
|---|---|
| question+answer | "Ask each other's companions questions" |
| handoff | "Pass work items to each other" |
| receipt | "Confirm each other's completions" |

- Default proposal: questions only. That is a real, useful, minimal posture —
  the brief's §7 already blesses question/answer-only links.
- The accept screen must show: who (label + email + workspace host as claimed
  by the invite — email delivery is the v1 identity verification), the note,
  the proposed scopes as checkboxes B can UNcheck, and exactly two actions:
  Accept / Decline. No third path, no "maybe later" state beyond closing.
- Post-accept toast on both sides names the active scopes ("You and Elena can
  now ask each other's companions questions.").

## §3 Connections card lifecycle (Settings → Integrations → Connections)

Extends the existing doctor-card pattern; one card per link + an Invite row.
States: **Invited** (pending, countdown, Resend/Cancel) → **Active** (peer
label, plain-language scope list, health from the `peer:` channel row —
ok/stale/disconnected-with-reconnect-hint, and a Disconnect affordance) →
**Disconnected** (their side revoked or token rotted — reconnect = fresh
invite) → **Revoked** (history row). Revoke = the as-built §7 step 7
(clear token row + mark revoked) behind a confirm dialog whose copy sets the
expectation honestly: *"Already-shared messages remain in their workspace —
disconnecting stops anything new."*

## §4 v2 — lookup, not browse (deferred; privacy contract locked now)

When invitation-only isn't enough (teams, communities), add **exact-address
lookup** against an opt-in registry — with this contract, locked before any
build:
1. **Opt-in listing only**; a row = {display name, salted email hash,
   workspace URL}. Unlisted is the default forever.
2. **Exact-match lookup only**: query = an email the seeker already knows;
   answer = workspace URL or nothing. No substring/fuzzy/browse/enumerate; the
   API is rate-limited and returns nothing distinguishable for
   not-listed vs not-exists.
3. The registry never sees link traffic, tokens, or corpus data — it resolves
   addresses, full stop. Delete-me honored immediately.
4. Architectural note: this is the first centralized component in an otherwise
   sovereign architecture. The federated alternative — domain-level
   `.well-known` workspace resolution, org-published — should be preferred for
   enterprise tenants; the registry is for individuals. Both produce the same
   downstream flow: resolution feeds the SAME invite protocol (§1); lookup
   never creates a link by itself.

Same-org (v3) gets its own treatment later: directory is trivial inside an
org, the interesting question is lighter-weight defaults, and it converges
with N1 sharing rather than peer links.

## §5 Build phases

- **H1 — engine protocol (agent-buildable plumbing):** peer-invites store,
  the four routes (create/list/cancel; public landing; handshake accept;
  handshake complete), token capability semantics (hashed, single-use,
  expiring), scope-intersection activation, ledger + posture visibility,
  `PEER_HANDSHAKE_ENABLED` flag ('false' in pilot-full same PR, drift gate),
  bearer-audit + auth-exempt pins. Tests must include a REAL two-engine e2e
  (the exp-rig pattern: complete a handshake between two local engines and
  then dispatch a question envelope over the freshly minted link).
- **H2 — app surfaces (one-pair-of-eyes, render-look loop):** Connections
  card lifecycle, invite composer, accept screen + deep-link handler
  (mirrors the auth deep-link), the two confirm dialogs. Language canon per
  §2/§3; no wire vocabulary anywhere.
- **H3 — the v2 registry / .well-known resolution:** separate brief when
  wanted; §4's contract is the non-negotiable input to it.

**Acceptance for H1+H2 together:** two fresh corpus copies on the demo rig get
linked END-TO-END through the real flow — invite email → landing → deep link →
accept screen → handshake — with zero hand-edited files, then pass the
as-built §7 smoke (question over the new link, receipt round-trip, revoke →
disconnected). The hand-runbook (§7) stays documented as the operator fallback.

## §6 Security posture (summary)

- Invite token = single-use expiring capability, hashed at rest, is the sole
  authentication of the handshake-complete call; peer bearers never travel
  except inside the one TLS exchange; nothing sensitive in URLs beyond the
  invite token itself (which is single-purpose and consumed).
- Both humans consent before any credential exists; scopes can only narrow at
  accept; widening requires a fresh consent cycle.
- All states visible (fail-closed-but-visible); append-only invite ledger;
  rate-limited creation; typed refusals throughout.
- The email leg rides each user's own engine's email provider — no central
  relay touches the handshake.

## §7 Open questions (decide at H1 kickoff)

1. Invite expiry default — 14 days proposed.
2. Does A get a confirm step when B accepts (even at narrowed scopes), or is
   intersection-activation automatic? Proposed: automatic (A already
   consented to the ceiling), with a notification.
3. Multi-workspace users (same email, two engines) — punt to v2 lookup?
4. Should Declined invites be re-sendable, and after what cooldown?
