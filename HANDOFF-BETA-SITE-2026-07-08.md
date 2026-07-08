# HANDOFF — Threshold beta site (out-of-stealth) — 2026-07-08

For the successor coordinator taking over the website workstream. Read this
whole file before touching anything. The build is DONE and QA'd; what remains
is Ross's final calls, the deploy, and the post-launch queue.

## State: what exists and where

- **PR #121** (viktora-threshold, branch `claude/wp-beta-site`, OPEN, do not
  merge without Ross's go): the complete site in `site/` — `index.html`
  (self-contained, zero external requests), `assets/` (5 recompressed
  screenshots + hero.mp4/webm ~2.8/3.1MB + 3 section clips + posters),
  `waitlist-server.mjs` (stdlib-only: JSONL append + Resend notify via
  EMAIL_API_KEY + per-IP rate limit + honeypot + strict CORS),
  `DEPLOY.md` (nginx vhost for viktora.ai + www, certbot, pm2 line,
  GoDaddy A-record step — written for the demo droplet), and
  `preview-desktop.png` / `preview-mobile.png`.
- **WEBSITE-SPEC-THRESHOLD-BETA.md** (committed on the branch): THE source
  of truth for copy. The build passed a copy-verbatim gate against it —
  KEEP THEM IN SYNC: any copy change edits the spec first, then the page.
- **Ross's shareable preview**: artifact at
  https://claude.ai/code/artifact/e5e7f467-1619-4012-bb7f-da1896aaed84
  (label draft-2-no-homework; screenshots inlined, videos as posters, form
  falls back to mailto). Rebuild procedure: the inline-assets node script is
  in this session's history — pattern: read site/index.html, base64 pngs,
  video→poster img, strip outer html/head/body, prepend <title>, publish
  via the Artifact tool to the SAME url.
- **Local preview**: `.claude/launch.json` config `beta-site-preview`
  (python http.server :4653 on site/).
- QA already done (Fable): desktop+mobile renders, hero-video key frames
  (title card, receipt mock, Today segment), copy gates, vCard of the
  Email-capture screenshots is current (post-#119).

## Decisions LEDGER (do not relitigate)

1. **GTM = Dropbox motion** (Ross): individual-first beta → waitlist waves →
   rapid individual expansion. All copy speaks to ONE person, never
   "your organization." Referral line after signup ("invites move you both
   up the list").
2. **Hosting**: static site + waitlist service on the DEMO droplet
   (apolla-demo, 157.245.218.217) under **viktora.ai** root (Ross owns it;
   A record to be added at GoDaddy manually — dcc.godaddy.com portfolio).
3. **Signup**: the bundled waitlist-server (no third-party forms). Download
   links are deliberately NOT public — invites carry them (wave gating).
4. **Copy positions** come from the marketing playbook AS AMENDED by Trisha
   evidence — memory file `marketing-playbook-trisha-amendments.md` (7
   overrides: incident-led, promise-vs-list reframe, NO benchmark numbers,
   calibration = the selling point, AI never mentioned, Trisha vocabulary
   bar, product name = Threshold / company = Viktora).
5. **"No homework"** section + problem-section list-rot line (Ross,
   2026-07-08) — already in draft-2.

## PENDING — Ross's three calls (the only gate)

1. Footer: "Threshold is in active pilot" — keep / soften / cut.
2. Hero story (genericized June-30 incident) — final comfort check.
3. **The go.** Nothing merges, deploys, or publishes without it. This is
   outward-facing stealth-exit — Ross presses the button.

## Deploy runbook (after the go)

1. Merge PR #121.
2. Load the `apolla-devops` skill (mandatory for droplet work). Deploy per
   site/DEPLOY.md: rsync site/ to the demo droplet, nginx vhost
   (viktora.ai + www: static root + /api/waitlist proxy), GoDaddy A record
   (manual, TTL 600), wait for propagation, certbot, start
   waitlist-server.mjs under pm2 with EMAIL_API_KEY sourced from
   /opt/apolla/.env (the Recovery-Pattern env discipline: pm2 delete+start
   --update-env, never bare restart after env edits).
3. Smoke: form submit end-to-end → Ross receives the Resend notification;
   JSONL row lands; 429 after burst; mailto fallback with JS off.
4. Verify zero mixed-content / external requests in the served page.

## Post-launch queue (in priority order)

1. **Self-serve provisioning brief** — THE strategic gate on "rapid
   expansion": every user today is a manual single-tenant droplet
   (15-30 min + manual DNS). The waitlist buys time; the Dropbox curve
   needs automated provisioning or multi-tenant. Ross asked for this brief
   to be drafted "soon" — it's engine/infra work (PILOT-OPERATIONS-RUNBOOK
   §7-8 has the current architecture; provision-pilot.sh is the manual
   flow to automate).
2. **Viral-surface decision** — opt-in "Sent via Threshold" on receipts +
   heads-up drafts (the Dropbox shared-folder analogue). Ross adjudicates;
   sensitive (touches client-facing email). Not built.
3. Waitlist ops: who reviews signups, wave cadence, the invite-email
   template (carries download link + workspace details).
4. Receipt-email screenshot for the site/guide (marked TODO in the guide —
   capture from a real receipt when convenient).

## Gotchas for the successor

- The blissful-mccarthy worktree is ON the site branch; the frontend pass
  (tasks #4/#5, 0.10.1) lives in `.claude/worktrees/wp-focus-pass` —
  different workstream, don't mix commits.
- Playwright 1.61.1 + chromium: installed in the session scratchpad
  (`<scratchpad>/node_modules`); h264 ffmpeg at
  `<scratchpad>/fftools/node_modules/ffmpeg-static/` (Playwright's bundled
  ffmpeg is VP8-only). Re-recording video needs the shim harness
  (`~/scratch/threshold-shim-harness/server.mjs`, HARNESS_SRC_DIR +
  HARNESS_PORT env) against the local engine on :3020 — and any REAL
  gesture recorded must end with undo + verified restoration.
- The hero video's receipt beat is an ILLUSTRATIVE MOCK (labeled in a code
  comment) — if the real receipt template changes, consider re-shooting
  from a real receipt.
- Voice rules: viktora-marketing skill + the Trisha amendments memory.
  Banned words list is enforced by adjudicated copy — don't "improve" copy.
- Site content must never include internal codenames, repo names, pilot
  names, or infrastructure details.

## Kickoff prompt for the successor session

---
Take over the Threshold beta-site workstream. Start by reading
HANDOFF-BETA-SITE-2026-07-08.md at the root of the viktora-threshold repo
(also on branch claude/wp-beta-site in the blissful-mccarthy worktree) —
it has the full state, the decisions ledger, the deploy runbook, and the
post-launch queue. Current status: the site is built and QA'd on PR #121;
the ONLY gate is my three pending calls (footer pilot-mention, hero-story
comfort, and the explicit go). When I give the go: merge #121, load the
apolla-devops skill, and execute the deploy runbook in the handoff
(viktora.ai on the demo droplet + GoDaddy A record + certbot + waitlist
service under pm2), then run the smoke test and show me the proof. If I ask
for copy changes first: edit WEBSITE-SPEC-THRESHOLD-BETA.md and
site/index.html together (the spec is the copy source of truth), verify in
the local preview (launch config beta-site-preview, :4653), commit to the
PR, and refresh my shareable artifact at
https://claude.ai/code/artifact/e5e7f467-1619-4012-bb7f-da1896aaed84 using
the inline-assets pattern described in the handoff. Voice rules: the
viktora-marketing skill as amended by the marketing-playbook-trisha-
amendments memory — do not relitigate the decisions ledger. After launch,
the first follow-on is drafting the self-serve provisioning brief (the
strategic gate on the Dropbox GTM). Farm implementation-grade work to Opus
agents; keep strategy, copy adjudication, deploys, and visual QA at the
coordinator level. Nothing outward-facing ships without my explicit word.
---
