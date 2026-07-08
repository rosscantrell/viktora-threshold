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

[screenshot: 02-today-wide — the full Today view]

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
   Every workspace gets a private capture address, and can connect the
   sources your work already lives in. Send Threshold the raw material and
   it files every commitment it finds — who promised what, by when, in
   their exact words — then replies with a receipt listing exactly what it
   captured. Nothing invented; if it finds nothing, the receipt says so.
   [screenshot: 16-email-capture-address]
   [animation A: forward → receipt → items appear on Today]

2. **A two-week windshield, not a rear-view mirror.**
   Today opens with what's coming: every promise due in the next two weeks,
   who owns it, and — for the bigger ones — a worked-back plan: what has to
   happen first, and the latest date each step can start and still make the
   deadline. When that date passes with nothing seen, the item turns amber
   before it's late, not after.
   [screenshot: 21-workback-expanded — the Brian-style plan]
   [animation B: click a swimlane → the plan unfolds]

3. **You stay the editor.**
   Every plan is correctable in place — mark a step done, rule it out, move
   the date and watch everything recompute, undo any of it. Threshold also
   asks instead of guessing: "what should this workstream be called?",
   "are these two the same piece of work?" Your answers organize your
   workspace — and teach it.
   [screenshot: 28-name-ask or 29-merge-ask]
   [animation C: move the date → bars, tags, and ordering ripple]

4. **Put out the fire before it starts.**
   When something starts drifting, you see it early — while there's still
   time to reshuffle the plan, pull someone else in, or deliver part now and
   buy room for the rest. If a heads-up is the right call, one tap stages a
   short, no-blame note; nothing sends itself — every draft waits in your
   outbox for your judgment.
   [screenshot: 27-coming-up-headsup]

### No homework
You've tried the boards, the Gantt charts, the color-coded lists with
everyone's name tagged on them. You groom them for an hour and nobody looks
again. Every one of them asks the same thing: that somebody keep it current,
forever — the job that never gets done. Threshold doesn't ask. Forward what
matters and it does the filing — the emails, the meeting notes, the running
log of decisions and commitments — organized and kept current on its own.
When it isn't sure, it asks you one small question instead of handing you a
system to manage.

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

Footer: Viktora · Threshold is in active pilot · privacy note link.

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

## Open from the Trisha session (visual pass, not copy — 2026-07-08)
- **Hero poster frame**: current opening frame shows "the state of play,
  nothing important" (Ross). Re-select a meaningful first frame (the Today
  payoff or a receipt), or re-shoot.
- **Hero video end-state**: FIXED — resets to the poster on `ended` instead
  of resting on a dark final frame that read as a blank page.
- **Hero video audio**: none currently. Intended, or add VO/captions?
- **Section screenshots too dense** (Trisha): the example screens read as
  overwhelming/unreadable. Crop or zoom to legible pieces — "even if you
  don't know what it is, you should be able to read some of it."
- **"Learn from you"** (Ross, open): consider whether the teach-it beat in
  feature 3 needs its own surfacing. Currently covered by "your answers
  organize your workspace — and teach it."

## Claims for Ross to adjudicate (skill rule: flag, don't decide)
1. "in active pilot" in the footer — say it, soften it, or cut it?
   (No customer names/quotes anywhere, per the no-signed-customer rule.)
2. Product naming on the site: "Threshold" with "Viktora" as the company —
   matches installer branding. Confirm.
3. The hero story is Trisha's June-30 incident, fully genericized (no names,
   no client, no agency). Comfortable?
4. Beta promise wording: "onboarding a small number of teams" — accurate?

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
