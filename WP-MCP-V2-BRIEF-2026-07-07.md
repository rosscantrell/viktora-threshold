# WP-MCP-V2 — Threshold's knowledge field as a platform-agnostic MCP server

**Date:** 2026-07-07 · **Status:** brief approved-pending-Ross-redline · **Owner lane:** engine (schema-browser), with one Threshold Settings increment at the end.

## 0. The one-paragraph version

Expose the knowledge field to *any* MCP-compliant AI platform (Claude, ChatGPT, Copilot, Cursor, …) as **read + capture**: query tools over the derived surfaces (state of play, decision log, receipts, commitments, entity cards) plus the single append-only `ingest_doc` write. Build it as a **forward extension of the v1 MCP server already live on engine main** (merged PR #163, 2026-05-19 — do NOT re-cut), swap the single `MCP_API_KEY` for scoped per-user tokens that resolve through the existing viewer-identity + WP-N1 slice pipeline, and add a thin OAuth 2.1 authorization server on the existing magic-link/session machinery so the platforms' connector UIs can connect without per-platform code. An OAuth consent = a grant; the token is the unit of revocation.

## 1. Ross's locked decisions (2026-07-07)

1. **Tool surface: read + capture.** No `run_task` in phase 1. No mutation of existing records. No raw document bodies — read serves records/receipts/derived surfaces only (tier-0 never travels; same disclosure ladder as the federation design note).
2. **Platform-agnostic.** Target the open spec, not vendors: Streamable HTTP MCP + OAuth 2.1 authorization-code + PKCE + RFC 9728 protected-resource metadata + dynamic client registration/CIMD. Claude and ChatGPT are *reference clients we validate against* (they are the strictest), not build targets. Bearer tokens remain a spec-permitted lane for headless clients (Claude Code, API, scripts).
3. **Capture is attributed and append-only** — `ingest_doc` through the universal ingestion machinery, stamped with the token's identity.

## 2. Ground truth (audited 2026-07-07 — do not re-derive)

- **v1 is live on main**, not a dead branch: `schema-browser/server/mcp/` — StreamableHTTP `POST /mcp` (stateless, per-request server), `MCP_API_KEY` fail-closed mount (`server/index.ts:~11499`), zod tool registry, 6 plans/markers-era tools, run-task executor, `test-mcp.ts`, `GET /mcp/health`. SDK pin `@modelcontextprotocol/sdk ^1.29.0` (current; stateful-transport upgrade is additive within 1.x). The old branch is 0 ahead / 540 behind — nothing to rebase.
- **Every v2 read surface has a clean internal function** (tools call in-process, not HTTP): decision log (`loadDecisionLog`/`deriveRecordStates`/`computeLifecycleIndexed`), SoP (`assembleForestSoPSubstrate`), receipts (decision-log family, entity-keyed), vigilance voids, question engine, entity cards, `ingestDocument`. Route file:line map in the audit report (this session's transcript).
- **Auth hooks that already exist:** per-user `apolla_` addinToken lane (`server/auth/users-store.ts` — `getUserByAddinToken`, mtime-reloaded `users.json`, manual revoke), viewer-identity middleware (`viewerEmail(req)`), WP-N1 grants store + `acl/slice.ts` (`resolveCorpusSlice`, "load → SLICE → derive"). v1's `mcp/auth.ts` was explicitly designed so only the token-lookup function changes.
- **Nov-2025 MCP spec:** OAuth 2.1 + PKCE mandatory for remote servers; RFC 9728 `/.well-known/oauth-protected-resource` required; ChatGPT connectors accept **no** custom API keys; claude.ai connector UI has **no** bearer-header field. Sources verified live 2026-07-07.

## 3. Phases

### Phase A — scoped tokens + v2 read/capture tools (dogfood gate)
- `mcpTokens` store next to `users-store.ts`, persisted under `reference/_metadata/` (users.json posture: atomic write, mtime reload, revoke = delete row). Token row: `{token: 'apolla_mcp_…', ownerEmail, scopes: ['read','capture'], label, createdAt, lastUsedAt, revokedAt?}`.
- Replace `verifyMcpAuth` single-key lookup with store lookup → resolves to a viewer identity. Keep `MCP_API_KEY` as a deprecation-windowed operator fallback.
- **Every read tool routes through `resolveCorpusSlice` for that identity.** This is the load-bearing rule (audit risk #2): a scoped MCP consumer must never see wider than the same identity over HTTP.
- New tools (wrapping the internal fns): `get_state_of_play`, `search_records`, `get_record`, `get_receipts` (entity-scoped), `get_commitments` (waiting-on/readiness view), `get_entity_card`, `ask_question`. Keep `ingest_doc` (attribute `submittedByEmail` from the token). Retire/hide the plans/markers-era tools from the default toolset (leave code; they still work for Boardwalk).
- v1 shortcuts must NOT leak into v2 contracts (audit risk #3): no tool built on `getContributors: () => []`; overlay-applied artifacts only.
- **Gate:** connect Claude Code via bearer token to ross.viktora.ai; live session answers "what am I waiting on and what's the evidence" from real corpus; `ingest_doc` files a note that appears in Threshold with receipts + attribution. Slice honesty test: a token scoped to a non-champion viewer must not see private docs' records.

### Phase B — OAuth 2.1 AS + discovery metadata (connector-UI gate)
- Thin AS on the existing session machinery: `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`, `/oauth/authorize` (gates on magic-link session; consent screen lists requested scopes = the grant ceremony), `/oauth/token` (code + PKCE S256 exchange → mints an `mcpTokens` row), dynamic client registration endpoint + CIMD acceptance. No implicit, no client-credentials. Exact-match redirect URIs; allowlist includes `https://claude.ai/api/mcp/auth_callback` + `https://chatgpt.com/connector_platform_oauth_redirect` + loopback (port-agnostic) for CLI clients.
- **Gate:** claude.ai custom connector AND ChatGPT connector both complete the flow against a pilot droplet with zero client-specific server code; revoking the row in `users.json`-style store severs the platform immediately.

### Phase C — Threshold Settings "Connected AI platforms" card
- Master-detail Settings panel (same grammar as Email capture): list active grants (label, platform-reported client name, scopes, last used), revoke button, mint-a-bearer-key affordance for CLI clients. Reads/writes a new engine admin API over the token store.
- Frontend = one-pair-of-eyes rules (threshold-frontend-posture).

### Deferred (named so they don't get lost)
- `run_task` re-exposure under a distinct scope; record mutations (HITL lane, needs identity); stateful transport + subscribe leg (additive in SDK 1.29); per-topic scopes (converges with N1.1 topic grants); Outbox line-items for MCP reads ("everything that has ever left my corpus").

## 4. Risks (from the audit, kept in front)

1. **Duplication:** anchor to main's live `mcp/` tree; the demo-critical `POST /api/agents/run-task` shares the executor — don't break it.
2. **Slice bypass = disclosure leak:** the single most important review item on every v2 tool.
3. **Silent-empty contracts:** v1's `getContributors` stub and first-match artifact heuristic must not underpin any v2 tool.
4. **Profile interaction:** `pilot-full` sets `AUTH_ENABLED:'false'` as a default — MCP/OAuth work assumes auth ON; droplets carry explicit `AUTH_ENABLED=true`. A fresh profile-only droplet would come up open; fix the profile default or provisioning template before Phase B ships to pilots.

## 5. Non-goals

No per-platform adapters. No raw-document read tools. No LLM-mediated disclosure decisions (grants are human acts, enforced deterministically — federation design note rule, applies verbatim here).
