# WP-BYOM — Bring Your Own Model: the engine's inference on a customer's private AI

**Date:** 2026-07-08 · **Status:** Phases 1+2 SHIPPED (engine #525/#526, 2026-07-16/17) · live acceptance PASSED 2026-07-17 · six-outcomes addendum below (Ross-confirmed 2026-07-17) · **Sequencing (Ross ruling):** does NOT hold the 0.10.x release train; runs concurrently while MCP v2 + email capture are in pilot. **Owner lanes:** engine (Phase 1), eval (Phase 2 — the hard one), Threshold app (Phase 3).

## 0. The one-paragraph version

Let a customer run the engine's own inference — extraction, generation, query, embeddings — on *their* AI: an OpenAI-compatible private endpoint (vLLM/TGI/gateway), or Bedrock in their own tenancy. Composed with WP-MCP-V2 this closes the full sovereign loop: their assistant reads/writes the field over MCP while the field's inference runs behind their firewall. The plumbing mostly exists (the provider facade + per-surface routing ARE the sovereignty machinery); the work is (1) two engine gaps — facade streaming for the pinned trio, endpoint auth — (2) a **model certification harness**, because "it runs" ≠ "it meets the quality bar," and this program has repeatedly measured that model swaps shift behavior, and (3) the posture selector UI the privacy brief already called for.

## 1. Ground truth (audited 2026-07-07/08 — do not re-derive)

- **Facade** (`schema-browser/server/ai/anthropic-client.ts`): dispatch by model-spec prefix — `anthropic:` | `bedrock:…` (Anthropic SDK) | `bedrock:` non-Claude via Converse (`bedrock-converse.ts`) | `fireworks:` | `local:` (`local-openai.ts` → any OpenAI-compatible endpoint at `LOCAL_BASE_URL`). Degraded mode when none configured.
- **Per-surface routing**: ~36 `*_MODEL` env vars grouped GENERATION/EXTRACTION/QUERY; `SOVEREIGNTY_TIER` presets fill unset vars; explicit env always wins (`sovereignty-tiers.ts`).
- **The streaming-pinned trio**: `DECISION_LOG_EDITOR_MODEL`, `EVAL_MODEL`, `RENDERING_CONTRACT_VALIDATOR_MODEL` require streaming, which the facade implements **Anthropic-only** — these surfaces cannot move to a customer endpoint today, and `fullySovereign` is unreachable while they're enabled. This is THE engineering gap.
- **Embeddings**: `voyage` | `local` | inert; house rule — never silently fall back to cloud.
- **Reporting gap** (privacy audit): `dataLeavesOrg` is binary — a customer's own Bedrock tenancy reports as "Cloud." Needs the three-way locus: *your hardware / your cloud tenancy / vendor cloud*.
- **Why certification is not optional — program history**: prompt-change emission regression −33–69% across UCs (WP-Monitoring v1 revert); decision-log editor output 31–36k tokens and truncates on tight caps (64k backstop rule); judge-ceiling lesson on agreement gates; laptop-tier generation quality floor (`SOVEREIGNTY_ALLOW_LOCAL_GENERATION` guard exists because small models fabricate on open-ended generation). Model identity is a load-bearing input to output quality.

## 2. Phases

### Phase 1 — engine plumbing (small, well-bounded)
1. **Facade streaming for non-Anthropic providers.** OpenAI-compatible endpoints speak SSE; Bedrock has streaming APIs. Implement streaming in `local-openai.ts` (+ Converse if cheap), un-pin the trio when the resolved provider supports streaming. Fallback stance: a surface whose provider can't stream stays pinned and *reported* (current honest behavior).
2. **Endpoint auth**: `LOCAL_API_KEY` (bearer/api-key header) on the `local:` lane; optional custom header pass-through for gateways. Consider an `endpoint:` alias for `local:` in docs (it's a customer-endpoint lane, not a localhost lane) without breaking existing specs.
3. **Three-way data locus** in `describeSovereignty`: `processingLocus: 'org-hardware' | 'org-cloud' | 'vendor-cloud'` per surface (own-account Bedrock = org-cloud), threaded to the Privacy panel. Backward-compatible: keep `dataLeavesOrg` (= locus !== org-hardware? NO — keep current semantics, add the field).
4. Flags off / behavior identical by default; explicit-env-wins preserved; profile untouched.

### Phase 2 — BYOM certification harness (the eval-lane centerpiece)
A customer endpoint is enabled per-surface only after passing a graded run:
- **Inputs**: the customer endpoint + a golden corpus (the graded Meridian/eval corpora + the calibration evals that already exist).
- **Per-surface gates**: extraction fidelity vs graded baseline; decision-log quality (record class / receipts verbatim-anchoring); editor output-budget behavior (no truncation at the 64k backstop); same-corpus **emission-count regression gate** (the §397 lesson — fail if any surface's emission drops >X% vs baseline); judge surfaces get the judge-ceiling treatment (never certify a judge with the judged model).
- **Output**: a per-surface certificate `{surface, model, endpoint-fingerprint, grade, certifiedAt}` persisted in corpus `_metadata`; the engine refuses (or warns loudly, decide at impl) to route a surface to an uncertified model.
- **Acceptance**: (a) a known-good reference run certifies (GLM-5.2-on-Fireworks or Bedrock Claude — models already validated in production); (b) a **negative control**: a deliberately weak model (e.g. an 8B) must FAIL generation certification — a harness that passes everything is measuring nothing.
- **Recertification**: certificates are point-in-time; endpoint fingerprint change (model id/version header) invalidates. Cadence question deferred to pilot experience.

### Phase 3 — posture selector UI (Threshold app; one-pair-of-eyes rules)
The Privacy panel grows from read-only to deployment-level selector: per-surface provider rows (with the three-way locus chips), certification status per surface ("certified 2026-07-08"), and an operator-authed engine admin API to change routing without SSH/env edits. The `.privacy-future` placeholder in main.js is the marked home. Depends on Phase 1's locus field + Phase 2's certificates existing to render.

## 3. Composition with the rest of the program

- **With WP-MCP-V2**: their platform ↔ the field (MCP) + the field's inference on their model (BYOM) = the fully-inside-the-boundary story. This is the pitch for buyers who reject vendor-cloud AI outright (pharma/medtech procurement).
- **With the privacy brief**: Phase 1.3 ships the three-way locus that brief flagged; Phase 3 ships its posture-selector; the deletion-endpoint + encryption-at-rest items remain separate (procurement hygiene, unowned).
- **Streaming un-pin also benefits** the on-prem/laptop tiers that exist today.

## 4. Risks

1. **Certification theater** — a harness tuned until everything passes. The negative control is mandatory; grades are against frozen baselines, not vibes.
2. **Prompt/format variance** — tool-use and structured-output reliability differs by model; extraction schemas may need per-model conformance checks inside the harness rather than prompt forks (NO per-customer prompt forks — one prompt set, certified or not).
3. **Endpoint drift** — customers upgrade their models silently; fingerprint invalidation is the mitigation, but expect pilot friction here.
4. **Scope seduction** — this WP is inference portability, NOT fine-tuning, NOT customer-specific prompts, NOT training on customer corpora. Say no early.

## 5. Non-goals

Per-customer prompt engineering; model hosting of any kind; certifying the three pinned surfaces on non-streaming providers (they stay pinned-and-reported until Phase 1.1 lands); any change to default deployments (flags off, byte-equal until opted in).

---

## Addendum 2026-07-17 — the six user-facing outcomes (Ross-confirmed frame)

**Status update.** Phase 1 shipped (engine #525: provider-portable streaming — native SSE on local/fireworks/bedrock-Claude, buffered on Converse; `endpoint:` alias + `LOCAL_AUTH_HEADER`/`LOCAL_EXTRA_HEADERS`/`LOCAL_STREAM_IDLE_TIMEOUT_MS`; three-way `processingLocus`; stream-telemetry gap closed). Phase 2 shipped (engine #526: certification store/gates/CLI/boot-check; fixes #531/#535/#537). **Live acceptance passed 2026-07-17** on a ross-corpus golden slice: GLM-5.2-on-Fireworks **generation CERTIFIED** (0 fabrications); GLM-5.2 **extraction FAILED** the verbatim floor (85% < 89% — the harness independently reproduced the June "GLM over-extracts, generation-only" ruling); **negative control passed** (gpt-oss-120b failed extraction via the emission gate: 41 vs 85 baseline records — the silent-recall-collapse mode). Ground-truth corrections vs §1: `LOCAL_API_KEY` bearer auth already existed (#315); only the decision-log editor ever streamed — `EVAL_MODEL` and the contract validator are `create()`-only, pinned by judge/policy, not transport.

### A. The offer, as outcomes

| # | Outcome | Lane | Mechanism | Status |
|---|---|---|---|---|
| 1 | Threshold-managed models | substrate | today's default (Viktora keys, `ENGINE_PROFILE`) | shipped |
| 2 | Their subscription (Claude Max, ChatGPT Plus) | assistant | MCP v2 connectors (OAuth) — their plan pays for their assistant's usage | shipped; needs product framing/copy only |
| 3 | Their own API key | substrate | facade lanes (`anthropic:`/`fireworks:`/`local:`/`endpoint:`) + Phase 3 key store/selector | plumbing shipped; UI = Phase 3 |
| 4 | Org-approved model, minimal IT | substrate | engine-side org config users inherit automatically; Phase 3b profile import for personal deployments | Phase 3/3b |
| 5 | Self-hosted, own hardware | substrate | `local:`/`endpoint:` lane + sovereignty tiers + certification | shipped (P1+P2) |
| 6 | Self-hosted, own cloud | substrate | `bedrock:…@region` own tenancy, or `endpoint:` at their VPC gateway | shipped (P1+P2) |

### B. The two-lane boundary (binding)

**Substrate inference** — extraction, records, receipts, frames, synthesis: everything persisted into the field's derived state — runs engine-side on deployment-routed, certified models (outcomes 1/3/4/5/6, one mechanism). **Assistant-lane inference** — a user's own AI reading/writing the field over MCP — is outcome 2, on the user's model and bill. The rule: *anything persisted into derived state is substrate (engine-routed + certified); anything ephemeral in a conversation is assistant-lane.* Assistants contribute through capture/proposal channels only (`ingest_doc`, `propose_*`) — never derivation.

Substrate inference on a consumer subscription is **not offerable**: consumer plans expose no API surface a third-party server may draw on (Anthropic's subscription-for-tooling is first-party-only). Watch-item: if "Sign in with ChatGPT"-class programs open to third parties, a *subscription grant* becomes a new credential type in the grants layer — design the store to admit it; do not build on it today.

### C. Unit-of-selection ruling

Substrate model choice is **per-deployment** (org-level), not per-user: shared-corpus coherence (one user's model choice would rewrite everyone's derived state), certification provenance ("this corpus is certified on X"), org-state stability, and cost attribution. Personal deployments collapse user==deployment, so individuals keep the full menu. If a pilot org demands per-user choice, the only defensible middle tier is per-user routing on the read-only **query lane** — noted and deferred until demanded.

### D. Phase 3b — model profile import (the click-a-link path)

For outcomes 3/4/5: a small signed JSON profile (endpoint URL, per-surface-group model ids, auth header name, expected locus) delivered as a `threshold://` deep link or file. Settings → import → the app writes engine config through the Phase 3 admin API → health check → certification status → posture panel updates. Keys stay server-side; the user pastes at most their own key; IT publishes the link once. For org pilots (outcome 4) inference is engine-side, so users inherit the org grant by doing nothing — the profile path exists for personal and self-hosted deployments.

### E. Provider coverage (v1)

Anthropic direct + everything OpenAI-compatible (OpenAI, Azure OpenAI via `LOCAL_AUTH_HEADER=api-key`, Together, DeepInfra, Fireworks, vLLM/Ollama/gateways) + Bedrock own-tenancy. Gemini/Vertex deferred until a buyer asks. Negative-control candidates and provider walls are recorded in `server/ai/CERTIFICATION.md` (engine).

### F. Out of scope (unchanged, one addition)

§5 non-goals stand. Added: a consumer-grade "everything on my laptop" one-installer bundle (engine + model runtime packaging) is its own WP, not BYOM.
