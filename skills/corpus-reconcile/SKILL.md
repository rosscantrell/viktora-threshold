---
name: corpus-reconcile
description: >-
  Check a draft document against the user's Viktora Threshold knowledge field
  (the connected "Threshold" MCP server) and report what's MISSING, UNSUPPORTED,
  or CONFLICTING before it goes out. Use this whenever the user pastes or
  attaches an action-item list, meeting follow-up, status update, client
  deliverable, or any submission and asks whether it's complete, correct, or
  matches what was actually decided — phrases like "does this list have
  everything," "check this against my corpus/Threshold," "did I miss anything,"
  "is this right before I send it," "reconcile this," or "review this draft
  against what we agreed." Also use it proactively when a reviewer is vetting a
  more junior person's draft before submission. This is a CHECKER, not a writer:
  reach for it whenever a draft needs to be verified against the record of
  record, even if the user doesn't say the word "reconcile."
---

# Corpus Reconcile

Verify a draft against the Threshold knowledge field and surface the gaps before
the draft is sent, submitted, or filed. The knowledge field is the record of
what was actually decided, committed, and scheduled — so it, not the draft, is
the source of truth. Your job is to make the record talk back.

## When this earns its keep

A junior teammate drafts an action-item list from a stack of meeting notes and
emails. It's roughly right — but a missed commitment, an invented line, or a
quietly changed deadline slips through, and the reviewer only finds out when the
client complains. This skill is the extra pair of eyes *before* send: the
reviewer runs it on the draft, and every discrepancy comes back anchored to the
exact quote in the record that proves it.

It works on any artifact the knowledge field is authoritative for — action-item
lists, meeting follow-ups, weekly status updates, client deliverables,
compliance submissions. The reconciliation logic is the same every time; only
the final formatting changes per use case (see **Output adapters**).

## What you have access to

The connected **Threshold** MCP server exposes read tools over the user's
corpus. You will mostly use:

- `get_commitments` — open commitments / who-owes-what, with owners and dates.
- `search_records` — find decisions and commitments by topic/entity/timeframe.
- `get_record` — one record in full, with its receipts and related edges.
- `get_receipts` — the verbatim, source-anchored evidence lines for an entity.
- `get_state_of_play` — the current rollup, useful to scope what's in play.

Every record carries **receipts**: verbatim quotes from the meeting or email
where the thing was actually said, with their source. Receipts are what make
this trustworthy — a flag without a receipt is just your opinion, and this skill
does not trade in opinions.

Note that `get_commitments` and `search_records` already return each record's
`verbatim` (the receipt quote), `owner`, `due`, and `date` **inline** — so for
most reconciliations you have the receipt in hand from the first call. Reach for
`get_receipts` or `get_record` only when you need more evidence around a
specific item than the inline verbatim gives you. Don't make extra calls you
don't need.

## The procedure

Work in this order. Do not skip to formatting.

### 1. Scope the corpus slice

Figure out what the draft is *about* — which project, client, workstream, and
timeframe — and pull the matching records. Use `get_commitments` for anything
action/deadline-shaped; `search_records` scoped to the topic and date window for
decisions. Pull enough that you can speak to every line of the draft, but stay
scoped — you are checking this draft, not auditing the whole corpus.

If you genuinely can't tell what the draft covers, ask one clarifying question
(which project / what week) rather than guessing wide.

### 2. Diff into three buckets

Compare the draft line-by-line against the records. Sort every discrepancy into
exactly one of three buckets. These three are the whole method — keep them fixed
and named, every time, so the output is predictable and scannable.

- **MISSING** — in the corpus, absent from the draft. A commitment that was made
  or a decision that was reached, which the draft failed to carry. These are the
  silent omissions that get a team in trouble.
- **UNSUPPORTED** — in the draft, no backing in the corpus. A line the record
  can't account for: possibly fabricated, possibly a genuine item that was never
  captured, possibly just wrong. Flag it and say which you suspect — do not
  assume malice; an unsupported line is often a real thing that simply never made
  it into the record.
- **CONFLICTING** — the draft and the corpus disagree on the same item. The
  highest-value bucket. The classic case: a deadline the draft has quietly moved.
  When the record says a date was set and no later decision changed it, a draft
  that shows a different date is a conflict — name the record's date, the draft's
  date, and the absence of any authorizing decision.

### 3. Anchor every flag to a receipt

This is non-negotiable and it is the point. For every MISSING and CONFLICTING
item, quote the verbatim receipt from the corpus that establishes the truth —
the actual sentence from the meeting or email, with its source. For UNSUPPORTED
items, state plainly that *no* receipt backs the line (that absence is itself the
finding). The reviewer should be able to act on your report without re-opening
the corpus, because the corpus is already quoted in it.

### 4. Report

Use this structure. Lead with conflicts, because a wrong deadline heading to a
finicky client is more urgent than a cosmetic omission.

```
## Reconciliation: <draft name> vs. your knowledge field

**Conflicting (N)** — the draft disagrees with the record
- <item>: draft says "<X>", record says "<Y>" — no decision authorizes the
  change.  ↳ receipt: "<verbatim quote>" (<source>)

**Missing (N)** — in the record, not in the draft
- <item>  ↳ receipt: "<verbatim quote>" (<source>)

**Unsupported (N)** — in the draft, not in the record
- <item> — no receipt backs this. Likely <fabricated / real-but-uncaptured / wrong>.

**Clean** — <count> lines matched the record with no issue.
```

If a bucket is empty, say so in one line rather than dropping the heading — "No
conflicts found" is a result the reviewer wants to see.

### 5. (Optional) Apply an output adapter

Only once the draft is reconciled — the user has seen the buckets and decided
what to fix — offer to produce the cleaned, formatted version. The format is
use-case-specific; see **Output adapters** below. Never format an unreconciled
draft: a beautifully formatted wrong list is worse than an ugly right one,
because it *looks* trustworthy.

## Output adapters

The reconciliation above is identical for every use case. What differs is what
the user wants out the other end. Pick the adapter that matches; if none fits,
just return the corrected content as clean prose.

### Adapter 1 — House hot-list format

`references/hot-list-format.md` holds the house formatting rules. **It is a
placeholder until the user fills it in** — the correct format is theirs, not
ours, and it is finicky (bullets, bold, links, spacing) in ways only a real
sample reveals. On first use, if that file still reads as a placeholder, ask the
user to paste one correctly-formatted list; capture its rules into the file so
future runs are consistent. Then format the reconciled content to match it
exactly.

### Adding more adapters

Status-update email, meeting-minutes template, compliance-submission layout —
each is a new file under `references/` with that use case's formatting rules,
selected in step 5. The core never changes.

## Guardrails — read these, they define the edges

- **This is a checker, not an author.** It verifies a draft against the record;
  it does not invent content the record doesn't have. If asked to "just write
  the list," reconcile first and be explicit that unsupported additions are the
  user's call, not yours.
- **It is only as good as corpus coverage.** The knowledge field is authoritative
  only for what's been captured into it. If the draft covers work that never
  entered the corpus, you will mark real items UNSUPPORTED — say so honestly
  ("the record has no entry for this; it may simply be uncaptured") rather than
  implying the item is wrong. Never claim the corpus is complete.
- **Run it on the draft, before submission.** The value is catching the problem
  before it reaches the client / reviewer / regulator — not after. It reads the
  *draft*; it cannot see wherever the draft ultimately gets submitted.
- **The reviewer runs it, not necessarily the author.** Whoever cares about the
  output being right can run the check on someone else's draft. That is a
  feature: the safety net doesn't depend on the drafter remembering to self-check.
- **Distinguish "wrong" from "uncaptured" in the UNSUPPORTED bucket** — conflating
  them erodes trust fast. A fabricated line and a real-but-unrecorded line look
  identical to the corpus; your job is to flag the ambiguity, not resolve it by
  guessing.
