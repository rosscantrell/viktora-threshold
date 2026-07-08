# WP-BYOM — Bring Your Own Model: the engine's inference on a customer's private AI

**Date:** 2026-07-08 · **Status:** brief approved-pending-Ross-redline · **Sequencing (Ross ruling):** does NOT hold the 0.10.x release train; runs concurrently while MCP v2 + email capture are in pilot. **Owner lanes:** engine (Phase 1), eval (Phase 2 — the hard one), Threshold app (Phase 3).

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
