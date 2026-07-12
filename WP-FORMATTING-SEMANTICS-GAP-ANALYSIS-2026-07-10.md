# WP-FORMATTING-SEMANTICS — Gap Analysis (2026-07-10)

Deliverable for the brief's mandated **first step** ("gap analysis, do before any
build"). Traced by code, grounded in real corpus data. Decisions taken with Ross:
**first slice = email/HTML path**; **fixtures = Ross supplies Trisha's real ones**.

---

## Headline finding (this re-sizes the whole cluster)

**Formatting is destroyed *upstream of the engine*, at capture time — not in
extraction.** The struck-"done"→live-commitment misfire is not extraction
misreading a strikethrough; extraction operates on text that **never contained
the strikethrough**. So Stage 1 ("Extract/preserve") is a *capture-surface*
change, not an extraction change.

Evidence (engine = `AI-Light-Prototype/schema-browser`, on `main`):

- **The engine has no document parser.** Only doc dep is `docx@9.7.1` — a
  *writer*, not a parser. No `mammoth` / `jszip` / `adm-zip` / `mailparser` /
  `cheerio` / html-to-text lib anywhere in `server/`. It *cannot* read
  `w:comment`, `w:ins/w:del`, `w:ilvl`, or style runs — it never receives them.
- **`/api/ingest-document` accepts `content: string` only** (`server/index.ts:4443`).
  No HTML/XML/binary is ever accepted. Whatever reaches the engine is already flat.
- **Downstream is all flat-text**: `document-ingestion.ts`, the sequential
  extractor, `ingress-magnet.ts` — none see source formatting.
- **The record model has nowhere to store spans.** An `index.json` document entry
  has `id/title/topics/participants/extractedEntities/pass1Output/…` and **no
  span/annotation/rich-text field.** Stage 2 ("Represent") has no home today.

**Real evidence in the corpus now** (`~/scratch/threshold-uat-repro-corpus`):
`ingested/EMAIL-b7485f535957be7b.txt` is one of Trisha's actual Merck status
emails. Its nested action-item tree — job headers `US-NON-16619`, `HQ-NON-01479`,
`US-NON-19757`, each with `OPR to…` / `Allie to…` sub-bullets — is flattened into
a single run, all indentation gone. **That is the "can't tell which job"
complaint, reproduced from real data.** (The header block is also concatenated
with no breaks: `…4:49 PMTo: Angelica…`.)

---

## The email/HTML path, traced to the exact line

The email-capture receiver **is** in the engine repo (on `main`, not on the
current `field/n1-federation-experiments` branch's tree):
`server/ingest/email/` — `routes.ts`, `parse.ts`, `receipt.ts`, `parse`, etc.
Provider is **Resend inbound** (`email.received` webhook → droplet fetches full
message).

**The flattening line** — `server/ingest/email/routes.ts:320`:

```js
const bodyText = full.text ?? htmlToText(full.html ?? '');
```

- The fetched message carries **both** `text` and `html` (`routes.ts:62-63`).
- The pipeline prefers `full.text` — the mail client's **plaintext MIME
  alternative**, which already has zero formatting.
- The fallback `htmlToText` (`routes.ts:553`) is a naive tag-stripper:
  `.replace(/<[^>]+>/g, '')` — obliterates `<s>`/`<strike>`/`<del>`/`<ins>`,
  `style="text-decoration:line-through"`, `color:`/`background`, and
  `<blockquote>`/`<ul>`/`<ol>` nesting depth.
- `parse.ts` (threading, quote-strip, signature removal) is **pure text**, no HTML
  awareness. Note the **forward exception** it documents: forwards RETAIN the body
  (Trisha forwards the Brian thread to her capture address) — so the struck-"done"
  misfire rode in on the forward path, which hits exactly this line.

**`full.html` — the fully-formatted source — is already in hand at line 320 and
thrown away.** That is the cheap win the brief predicted: the raw formatting is
present at the boundary; we just discard it.

---

## Right-sizing correction to the brief's plan

The brief lists **comments + indentation** as "cheapest + highest value, do
first" (zero interpretation risk). That's true for *interpretation* but **not for
plumbing**, and the two point at **different capture surfaces**:

| Signal | Lives in | Capture surface | Plumbing cost |
|---|---|---|---|
| Strikethrough, color, blockquote-nesting | forwarded **email** (already HTML) | `routes.ts:320` — one line, source in hand | **Low** |
| **Comments** (`w:comment`) | **Office** `.docx`/`.pptx` only | add-in change **or** raw-file channel + new OOXML parser | **High** |
| Track-changes (`w:ins/w:del`), `w:ilvl` | **Office** | same as comments | **High** |

So **"comments first" (Office/OOXML) and "cheapest first" (email/HTML) are
different first slices** — they can't both be slice one. Per Ross's call, **slice
one = email/HTML**: it covers the *proven* misfire + color + blockquote-nesting
through a single surface where the source is already present, with **no Office
add-in work**. Comments/track-changes become a separate, heavier workstream.

---

## Proposed email/HTML slice (Stage 1 → 2), located

1. **Preserve** (`routes.ts:320`): stop discarding `full.html`. Parse it into
   offset-aligned **formatting spans** over the same cleaned text
   (`parsed.cleanText`, `routes.ts:455`, is what items anchor into — spans MUST be
   offset-aligned to it). Replace the naive `htmlToText` with a real formatting
   parser: `<s>/<strike>/<del>/text-decoration:line-through` → struck; `<ins>` →
   inserted; `color`/`background` → colored/highlighted; `<blockquote>/<ul>/<ol>`
   depth → indent level. Keep `full.text` fallback only when no HTML exists.
2. **Represent**: add a spans field to the record/index doc entry (absent today).
   Each span = `{start, end, kind, meta}` over `cleanText`.
3. **Flag, don't guess** (Phase-2 discipline, applies to the ambiguous ones):
   struck spans carried as **flagged**, surfaced as "this line was struck through —
   done, or removed?" — never silently read as status. Fail-closed-but-**visible**.
4. **Anchor** (the free hierarchy win): blockquote/list-depth spans give each line
   a parent, feeding the Work-Forest "which job" cross-reference.

Interpretation (Stage 3) stays conservative — no "strikethrough → mark done."

---

## Real fixture — Trisha's "Action Items 7/7" (received 2026-07-09)

Ross supplied it: `~/scratch/wp-formatting-semantics-fixtures/` (PDF +
`rendered/page-*.png` + `SIGNAL-INVENTORY.md`). It's a PDF export of the Gmail
thread; the actionable content is a nested action-item list revised by three
authors via inline color + strikethrough. It exercises **every signal in the
brief's table** and quantifies the gap on real data:

- **8 distinct indent depths** (x-offsets 27→225) — all collapse to 0 when
  flattened. Job codes `US-NON-16619` / `HQ-NON-01479` / `US-NON-19757` are level-2
  headers whose action items lose their parent = the "which job" bug, verbatim.
- **3-color grammar**, one of it stated by Trisha herself (*"I've noted my
  revisions in blue text"*): blue `#356ea5` = Trisha revisions/notes; green
  `#0f5c1a` = edits; purple `#5e327c` = OPR owner; underlined blue = links/@mentions.
- **Strikethrough = SIX meanings in one doc** — done, cancelled, deadline-removed,
  deadline-changed, word-edit, merged-away — two of them *opposite* (done vs.
  cancelled) under the identical signal. **Definitive real-data proof that
  "strikethrough → done" is unshippable.**
- **The inversion, reproduced byte-for-byte** by naive text extraction:
  `…done w/o 7/13` (struck deadline reads live), `needs to can shift to 10 AM`
  (struck word garbles the line), a merged-away bullet + its editorial note emitted
  as one live commitment, and a coaching note (*"Beauty… please ping the team…"*)
  emitted flush with real tasks (mintable as a phantom "Beauty to ping" task).

**Parse-target caveat:** the live ingest path receives the **email HTML** (Resend
inbound), not this PDF. In HTML these signals are *exact* (`<s>`/`line-through`,
color, `<ul>` depth); PDF geometry is noisy (~30% strike false positives from
link-underlines + wrapped colored notes), so the PDF is the ground-truth catalog,
not the production parse target. Ideal follow-up: the original `.eml` for a true
HTML byte-diff — but the signal inventory + acceptance are fully specced without it.

## Status & what's next

- **Done**: gap analysis (this doc) + the byte-diff on Trisha's real fixture
  (`SIGNAL-INVENTORY.md`).
- **BUILT** (email/HTML Phase-1 slice) — worktree `~/scratch/wp-formatting-semantics-wt`
  (branch `claude/wp-formatting-semantics` off `main`). **Report, do not merge** (per
  brief). Changeset (6 files +70 lines, 2 new):
  - `server/ingest/email/formatting.ts` (NEW) — dependency-free, deterministic HTML
    formatting parser → `{ text, spans }`. Preserves bullet/blockquote **indentation**
    in the text; emits offset-aligned **strike / insert / color / highlight** spans.
    Conservative: `<u>`/`<a>`/`underline` are NOT strike; color carried as **raw hex
    only** (no "blue = Trisha" — that's Phase-3 convention learning). `remapSpansToCleanText`
    re-homes spans through parseEmail's quote/signature strip, **fail-closed** to no-span.
  - `routes.ts` — at the flatten line (was `full.text ?? htmlToText(full.html)`), when
    the flag is on and HTML exists, render via the parser + carry spans onto the ingest
    `sourceMetadata.formatSpans`. Flag OFF ⇒ **byte-equal** legacy path.
  - `deps.ts` / `document-ingestion.ts` `SourceMetadata` — thread `formatSpans` through
    the funnel onto the persisted doc (additive; round-trips via existing passthrough).
  - `engine-profile.ts` + `test-engine-profile.ts` — flag `EMAIL_FORMATTING_SEMANTICS_ENABLED`
    added to `pilot-full` + the drift-gate `POST_FREEZE_ADDITIONS` allowlist.
  - `test-email-formatting.ts` (NEW) — **17/17 green**: parser units, the **6
    strikethrough meanings** (each preserved as a flagged span, struck text not
    removed), remap (forward-retain / out-of-slice drop / fail-closed), and E2E
    `handleInbound` (flag-ON persists struck spans + indented hierarchy; flag-OFF
    byte-equal). Drift-gate 14/14 + email-parse 11/11 still green; touched files tsc-clean.
- **Phase-1 success criteria** — (1) comments: N/A on the email path (Office/OOXML,
  separate slice); (2) nested item **anchors to parent job**: hierarchy preserved as
  indentation in the captured body ✓; (3) struck line preserved as a **flagged span**,
  not read as status ✓ (verified vs. the flattened baseline).
- **Deferred (noted, not done)**: receipt-level flagging of struck items
  (`extractVerbatimItems` still lists a fully-struck/cancelled line verbatim) — that's
  Phase-2 *display*; the record-level spans that enable it are shipped. Original `.eml`
  for a true live-HTML byte-diff remains the nice-to-have.

## Guardrails carried
Precision-first; flag-don't-guess on ambiguous signals; fail-closed-but-visible;
byte-verify against a real fixture; no formatting *inference* becomes calibration
ground-truth without human confirm.
