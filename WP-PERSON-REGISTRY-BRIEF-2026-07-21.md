# WP-PERSON-REGISTRY — identity as substrate: resolve at mint, never invent

**Date:** 2026-07-21 · **Status:** brief for Ross's ratification · **Origin:**
Ross's ruling today, after the Rob-goals vigilance blindness: *"We shouldn't have
issues where Rob and Robert are not found to be the same person, this is basic
stuff."*

## §0 FIELD-CONFORMANCE (binding, per the WP-FRAME-COMPANION preamble)

People are entities of the field. The registry is the persistent home of each
person's ENTITY-IDENTITY POSTERIOR; a resolution is an evidence-rung collapse of
that posterior; every retroactive unification is a CANON FOLD applied at read —
records and substrate are NEVER rewritten (verbatim provenance preserved).
Thresholds are derived slots, not invented constants. The evidence-ladder
discipline of D2 (PR #358) and Ross's 2026-07-17 ruling (*dominance is a PRIOR,
not evidence*) govern every rung below. Binding refs: field dossier /
PLAN-Frame-Dynamics math spec, D2 evidence-ladder spec, ORG-STATE laws,
WP-FRAME-COMPANION §0.

## §1 FOUNDING INCIDENTS (all one disease)

- **2026-07-21 Rob-goals blindness:** Monday's recorded goals conversation with
  Rob could not close Monday's open goal-setting commitment. Owners split
  (`ross` vs `ross-cantrell` from two capture lanes), entity slugs split
  (`goal-setting-catch-up` vs `monthlyperiod-goal-setting-catch-up` vs junk
  frame-slugs), so every join the vigilance watcher has was blind. The watcher
  worked as built; the identity graph under it was fractured.
- **Speaker-N class (#533/#538):** 265 placeholder owners; 79 resolved by the
  re-tiered sweep; 57 per-recording name-asks remain.
- **Second-person class:** voice-capture "You" minted owner `user` — the top
  day-graph cluster was "14 items wait on user" (the viewer himself).
- **OLYSENSE (entity sibling):** one product under 4 spellings, 58 occurrences.
- **Bare `ross`:** a capture lane minted a first-name slug beside the canonical
  `ross-cantrell`.

## §2 ROOT CAUSE

Identity is a BYPRODUCT of extraction. The extraction prompt instructs the LLM:
*"actor/owner are kebab-case person slugs"* (extract.ts:50) — the model invents
canon from whatever surface form the transcript used, per record, with no
authority consulted. `people.json` already exists (canonicalId, aliases,
mergedFrom) but is read by display surfaces only (who_to_inform, packet, claims)
— NEVER by the mint path. Each incident class got a point fix (the guard, the
sweep, the lexicon); the class keeps regenerating because minting is unresolved.

## §3 THE REGISTRY (extends people.json — no parallel store)

Per person: `canonicalId` · `displayName` (human name, not a slug) · `slugs[]`
(every slug this person has ever minted as — the join keys) · `aliases[]`
(surface forms: "Rob", "Robert", "Robert Rhem", each with the EVIDENCE that
bound it: rung + source + receipt + timestamp) · `emails[]` · `mergedFrom[]` ·
`status` (active/provisional). Seeding: users.json + email-correspondents.json
(69 real name↔email pairs, currently unjoined) + the observed owner-slug census
+ the speaker-owner sweep's applied resolutions. The registry is substrate:
versioned, receipted, human-correctable via the existing correction lane.

## §4 THE RESOLVER — one chokepoint, a deterministic ladder

Extraction stops minting canon. The LLM emits the name AS SPOKEN (additive
`ownerSurface` field; the `owner` slug becomes resolver-assigned). At the
existing `validate.sanitizeRecords` chokepoint (where the speaker-owner guard
already lives — it BECOMES the general owner-resolution ladder), every mint path
(prose extraction, capture docs, MCP captures, peer docs) resolves surface →
`canonicalId` → canonical slug:

- **r1 — exact:** surface matches a registry alias or slug.
- **r2 — email:** surface co-occurs with / maps to a known email
  (email-correspondents join).
- **r3 — hypocorism in scope:** closed nickname table (Rob→Robert, Bob→Robert,
  Liz→Elizabeth, …) + the match must be UNIQUE within the recording's
  participant set. NEVER corpus-global: two Roberts in one meeting ⇒ ask.
- **r4 — the guard's existing rungs:** a1 second-person-by-construction,
  a2 sole-speaker, a3 summary self-id (unchanged, #538 semantics).
- **r5 — unresolved:** provisional per-recording identity + a filed name-ask
  (the surfacing build in flight rides unchanged: factKey-idempotent, ladder-
  budgeted, answers fold to the record-scoped overlay).

Laws: NEVER a zero-evidence merge (ambiguity always asks); dominance/frequency
is a prior, never a rung; the resolver is pure-deterministic, no LLM; flag
`PERSON_RESOLVER_ENABLED`, pilot-full same-PR, flag-off byte-identical.

## §5 THE LOOP — an unknown costs ONE question, ONCE

Every resolution at r2+ writes the surface form back to the person's aliases
(receipted, undoable — the capture-lexicon pattern: the posterior's decision
cached). Every name-ask answer, every `propose_correction` owner/spelling fix,
and every QE person-alias confirm ALSO writes an alias. Next occurrence of the
same surface form is r1. This is the durability property: variants stop being
incident classes and become one alias-write each.

## §6 RETROACTIVE — registry-driven canon fold

A sweep (sibling of sweep-speaker-owners, same disciplines: dry-run default,
tiered evidence table, --apply Ross-gated, fold-at-read, zero substrate bytes,
per-entry receipts + undo) clusters the historical owner-slug census against the
registry and folds variants: `ross`→`ross-cantrell` is the founding fixture.
Ambiguous clusters become asks, never merges. Display surfaces then render
registry displayNames (summaries keep their verbatim text; folds act at read —
the OLYSENSE law).

## §7 NOT IN SCOPE (P2 pointer)

Non-person entity slugs (`goal-setting-catch-up` class) are the same disease in
an open world; they ride the entity-canon fold + region-anchor machinery later.
People come first: closed structure (names, nicknames, emails, participant
sets) makes the ladder decidable.

## §8 PHASING

- **P0:** registry enrichment (seeding joins) + resolver at the chokepoint +
  `ownerSurface` prompt change + alias learning. Acceptance: bare first-name
  slugs can no longer mint; the Rob fixture — a NEW goals conversation closes
  the open commitment without a human joining anything.
- **P1:** retroactive sweep + Ross's --apply; registry hygiene passes join the
  groomer's pass family (dup detection files QE person-alias questions,
  suggest-only).
- **P2:** entity slugs (out of scope here).

## §9 DIVISION + CO-SHIPS

- **WF/coordinator lane:** registry schema/seeding, resolver + ladder + tests,
  sweep, alias-learning writes, prompt change.
- **Voice lane:** capture-lane stamping routes through the resolver (their
  postcall/boardwalk lanes stamped `ross` vs `ross-cantrell` — the founding
  variance); teaching lines per coherence architecture (registry, never prose).
- **Networking lane:** peer-doc/envelope identities resolve through the same
  ladder (the `companion+<frameKey>@<host>` email-form identity choice already
  anticipated slug pollution — r2 handles it); contest window open.
- Cross-lane contract: identity evidence rungs are THE shared vocabulary; any
  lane minting an owner goes through the chokepoint or names why not.

## §10 ACCEPTANCE

- The Rob fixture end-to-end (P0 acceptance above).
- Measured: distinct-owner-slug census converges toward registry cardinality;
  placeholder + variant mint rate → 0 on new docs; name-ask volume decays as
  aliases accumulate (each answer is terminal).
- No regression pins: sweep-style zero-substrate-byte test; flag-off
  byte-identity; guard suite (28/28) green unchanged.
