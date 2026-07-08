# Threshold beta site — copy + build spec (draft 3, post-Trisha-session 2026-07-08)

Goal: out-of-stealth, recruit beta testers. One page, one CTA. Audience:
people who run client work day-to-day — agency leads, program managers,
chiefs of staff — accountable for promises scattered across other people's
threads.

## Page copy (in order)

### Hero
**The deadline was in the thread the whole time.**
Someone on your team made a promise three weeks ago, at the bottom of an
email you were barely on. Nobody put it on a list. Someone had to ask.
Threshold exists so that never happens again.

[HERO IMAGE: hero-app.jpg — the Today view showing MORE OF THE APP (Ross):
the State of Play digest (synthesized forest narrative + counts pills:
"32 overdue · 6 blocked · 3 gone stale" + Compose-update-to-team) above the
two-week deadline outlook, with the waiting-on-you queue on the right. REAL
capture from the ANONYMIZED scrub-corpus (Northwind/Daniel/Maya). The SoP
had to be composed live (valid ANTHROPIC key) then the rendered panel
injected into a headless page — the harness shim's fetch_sop lens param
returns 400, so the on-Today panel wouldn't populate otherwise. Video
DEFERRED pending an audio/VO revisit — hero.mp4/webm stay in the repo.]

CTA button: **Ask for a beta invite**

### The problem, plainly
You're accountable for work you don't personally do. The promises that sink
you don't live in your task tracker — they live in side threads, forwarded
decks, and meeting notes. For example, someone says, "I should have
something by the 30th." Search can't find a date you don't know exists. A list can't hold a promise
nobody wrote down. And every system that could is homework: somebody has to
file, tag, and groom it, forever — which is exactly the job nobody was doing
the day the deadline slipped.

### What Threshold does
Threshold watches the work you give it and keeps the promises in front of
you before they're due.

1. **Forward an email — or a note, a screenshot, a recording. That's the
   whole workflow.**
   Every workspace gets a private capture address, and connects to the
   sources your work already lives in. Threshold files every commitment it
   finds — who promised what, by when, in their exact words — and replies
   with a receipt. Nothing invented; if it finds nothing, the receipt
   says so.
   [screenshot: 16-capture-crop-dots — address strip + receipt line; the
   random token renders as PASSWORD DOTS (`cap-` + dots + `@in.viktora.ai`)
   — it's a private address and any real one is an unreadable 30+ char
   token; blur was tried and looked smudgy (Ross)]

2. **A two-week windshield, not a rear-view mirror.**
   Today opens with every promise due in the next two weeks and who owns
   it. The bigger ones get a worked-back plan — the latest date each step
   can start and still make the deadline. Threshold watches your connected
   sources: when a step's work shows up, it's checked off — seen — and the
   plan recomputes. When a date passes with nothing seen, the item turns
   amber before it's late, not after.
   [screenshot: 22-workback-seen — the expanded plan with two steps ✓ seen
   (green), two pending with latest-start dates, bar recomputed to
   "on track". REAL capture from the Trisha-pass corpus via shim harness;
   the seen states were staged with the product's own step-done gestures
   and undone after (verified restored). The auto-observe lane
   (workback-judge evidence match) produces this identical render.]

3. **You stay the editor.**
   Every plan is correctable in place — mark a step done, rule it out,
   move the date, undo any of it. When Threshold isn't sure, it asks
   instead of guessing — and your answers teach it.
   [screenshot: 23-plan-editor — Trisha's plan with the editing controls
   visible: done / doesn't-apply on every step, the move-the-date inline
   editor OPEN (date input + apply), add a step, undo last change. REAL
   capture from the Trisha-pass corpus via shim harness; the date editor
   is a client-side toggle — no gesture posted, no corpus mutation.
   (Prior 28-name-ask was the wrong screenshot here (Ross) — it shows the
   ask, not the editor; it moved to No homework.)]

4. **Put out the fire before it starts.**
   When something starts drifting, you see it early — while there's still
   time to reshuffle, pull someone in, or deliver part now and buy room
   for the rest. If a heads-up is the right call, one tap stages a short,
   no-blame note that waits in your outbox. Nothing sends itself.
   [screenshot: 27-headsup-crop — cropped to the single drifting-item card]

### No homework
You've tried the boards, the Gantt charts, the color-coded lists with
everyone's name tagged on them. You groom them for an hour and nobody looks
again. Every one of them asks the same thing: that somebody keep it current,
forever — the job that never gets done. Threshold doesn't ask. Forward what
matters and it does the filing — the emails, the meeting notes, the running
log of decisions and commitments — organized and kept current on its own.
When it isn't sure, it asks you one small question instead of handing you a
system to manage.
[screenshot: 29-merge-ask, inside the trust card — the literal "one small
question": "Are 'Vaccines Story Refresh' and 'Vaccine Confidence &
Narrative Refresh' the same piece of work?" with Yes→consequences spelled
out ("14 jobs move, 44 entries re-home… Fully undoable") and No→it stops
suggesting. Ross picked this card over 28-name-ask (2026-07-08) — the
consequence lines + "fully undoable" carry the calibration beat.
Source: docs/user-guide-assets/29-merge-ask.png, header sliver cropped.]

### Trust, stated plainly
Threshold only sees what you forward or connect. Every claim it makes
carries a receipt — the exact words, the source document, the date. When it
can't see enough to judge, it says so instead of guessing.

### CTA (repeated, the only one)
**Join the beta.** Threshold works for one person from day one — you don't
need your team, your IT department, or anyone's permission to start. We're
letting people in in small waves.
[form: name, work email, one line about what you run] → waitlist.
**Referral hook (Dropbox mechanic):** after signup — "know someone else who's
accountable for other people's promises? Invites move you both up the list."

Footer: **Viktora · Threshold · Privacy** — "in active pilot" CUT (Ross,
2026-07-08): earliness is already carried by the beta CTAs + "small waves,"
and "pilot" reads as a hedge / implies an unnamed customer. The Privacy link
now resolves to a REAL one-line note (email used only for the invite + spot
notice, never sold/shared, removal on request at ross@viktora.ai) instead of
scrolling to the signup form.

## GTM notes (Dropbox strategy, Ross 2026-07-08)
- Individual-first: beta users → rapid individual expansion. All copy speaks
  to ONE person's deadlines, never "your organization."
- HERO VIDEO: consolidate the three clips into one ~75s hero screencast
  (forward → receipt → Today fills → plan unfolds → date-move ripple →
  heads-up draft) — the Dropbox launch artifact. Separate short loops stay
  as section accents.
- Waitlist + referral priority = the growth loop at the gate.
- STRATEGIC CONSTRAINT (flagged, not solved here): rapid individual expansion
  collides with single-tenant-droplet provisioning (~15-30 min manual per
  pilot, GoDaddy DNS step). The Dropbox motion needs self-serve workspace
  provisioning (automated or multi-tenant) before the waitlist opens wide.
  Site can launch on manual waves; infra work is the real gate to "rapid."
- PRODUCT-INHERENT VIRAL SURFACES (Ross to adjudicate, later): receipts and
  heads-up drafts are seen by non-users (colleagues, clients) — the organic
  exposure loop analogous to Dropbox shared folders. A tasteful opt-in
  "Sent via Threshold" line is the lever; touching client-facing email is
  sensitive, so it's a decision, not a default.

## SCRUB STATUS (real-data → anonymized, 2026-07-08)
All screenshots came from Trisha's live corpus (real names/clients). Fix:
an anonymized corpus COPY at ~/scratch/scrub-corpus (Vantage Collective /
Northwind / Daniel-Maya persona set; 0 residual real entities, verified),
served by a throwaway engine on :3030, re-captured via the shim harness.
- **hero-outlook.jpg, 22-workback-seen.jpg, 23-plan-editor.jpg** — RE-SHOT
  clean and swapped in (Daniel / Maya; amber + seen states re-staged and
  reverted). Visually QA'd, zero real names.
- **29-merge-ask.jpg (No homework)** — RESTORED as a faithful reconstruction.
  The QE merge/alias question doesn't surface from the scrubbed corpus (the
  scrubbed job names aren't similar enough to re-trigger alias detection), so
  the card was rebuilt with the app's REAL render classes (rule-card
  question-card, question-futures, etc. — copied from buildQuestionCard in
  main.js) + the anonymized text from frame-questions/default.json ("Product
  Story Refresh" / "Product Trust & Narrative Refresh"). Rendered against the
  live app CSS and captured at 2x. Pixel-faithful to the original; 0 real info.
  The prior 29-merge-ask.png (real "Vaccines Story Refresh" / "Vaccine
  Confidence & Narrative Refresh" — client-confidential) is retired.
- **27-headsup-crop.jpg (feature 4)** — still PULLED; feature 4 is copy-only.
  The heads-up card ("no draft observed · Draft heads-up to client") doesn't
  surface from the scrubbed corpus either. Options: same reconstruction
  technique, a live "Coming up" card substitute, or leave copy-only.

## Open from the Trisha session (visual pass, not copy — 2026-07-08)
- **Hero poster frame**: current opening frame shows "the state of play,
  nothing important" (Ross). Re-select a meaningful first frame (the Today
  payoff or a receipt), or re-shoot.
- **Hero video end-state**: FIXED — resets to the poster on `ended` instead
  of resting on a dark final frame that read as a blank page.
- **Hero video audio**: none currently. Ross wants to REVISIT and add audio
  (2026-07-08, confirmed post-launch queue item) — VO or a scored
  walkthrough; pairs with the hero-poster re-shoot. Not a launch gate.
- **Section screenshots too dense** (Trisha): ADDRESSED for statics
  (2026-07-08 pass) — features 1/2/4 now use tight crops (capture strip,
  expanded plan card, single drifting-item card); feature copy trimmed
  ~60→~45 words; feature grid top-aligned (numbers align).
- **Section loop clips REMOVED** (Ross, big-screen review: "can't see
  anything", "click-throughs really fast") — the three full-app clips are
  off the page pending zoomed re-shoots. Re-shoot spec: zoom to the acting
  region (not full app), SLOW the interaction pacing (his complaint), ≤2MB,
  same shim-harness recipe. Hero video unaffected.
- **Capture address token redacted** (Ross: "the really bad email address")
  — the raw 30+ char token is off-putting. v1 blur looked smudgy (Ross);
  v2 = password dots (`cap-` + • • • + `@in.viktora.ai`), crisp and reads
  as "private secret". Asset: 16-capture-crop-dots.jpg (unblurred crop +
  original kept in assets/).
- **Feature layout restacked full-width** (Ross, big-screen: "still cannot
  see the pictures easily") — the 2-col grid rendered every screenshot at
  ~490px (36% scale for the plan card). Now copy-above, media-below at
  natural size capped at content width (~1030px); never upscaled.
- **"Learn from you"** (Ross, open): consider whether the teach-it beat in
  feature 3 needs its own surfacing. Currently covered by "your answers
  organize your workspace — and teach it."

## Claims for Ross to adjudicate (skill rule: flag, don't decide)
1. ~~"in active pilot" in the footer~~ — RESOLVED (Ross, 2026-07-08): CUT.
   Footer is now Viktora · Threshold · Privacy with a real privacy note.
2. Product naming on the site: "Threshold" with "Viktora" as the company —
   matches installer branding. Confirm. (Standing as-is; no objection raised.)
3. ~~The hero story (Trisha's June-30 incident, genericized)~~ — RESOLVED
   (Ross, 2026-07-08): comfortable. Rebuilt WITH Trisha in the live session;
   she confirmed it's her experience and "not a very unique thing."
4. Beta promise wording — the site says "one person from day one / small
   waves," not "onboarding a small number of teams." Individual-first per
   the Dropbox GTM. (Consistent; no open question.)

REMAINING GATE: only Ross's explicit GO. All three prior calls are closed.

## Build spec (for the Opus build agent, after copy sign-off)
- Static single page, self-contained (inline CSS, no trackers, no CDN
  dependencies), dark glass visual language lifted from the app's styles.css
  tokens (bg #15161d, glass surfaces, Hind-adjacent system font stack, amber
  = warning accent only — gold/amber is earned, never chrome).
- Assets: reuse docs/user-guide-assets captures (already 2x); 3 short
  looping MP4/WebM clips captured via playwright video against the shim
  harness (A: Today load populating; B: swimlane click → plan unfolds;
  C: move-the-date ripple). Poster frames for no-autoplay contexts.
  ≤ 2MB per clip, lazy-loaded below the fold.
- Signup: static form POST → decided by Ross (options: Resend-backed
  endpoint on an existing droplet /api route behind rate limit; or
  mailto: fallback). NO third-party form service without Ross's say.
- Hosting: Ross decides — proposal: nginx static site on the existing demo
  droplet under viktora.ai (or www/threshold subdomain; GoDaddy A record
  exists for root?). HTTPS via certbot, same stack as pilots.
- Responsive; screenshots in device-frame-less glass cards; no scroll-jack,
  no parallax. Lighthouse ≥90 performance.
- Nothing publishes until Ross reviews the built preview.
