# WP-VOICE-THRESHOLD-ENTRY — click-to-talk from the desktop app (2026-07-16)

Status: DESIGN. Addendum to `WP-VOICE-BRIEF-2026-07-13.md`. That brief listed
"voice on the Threshold desktop widget" as a v1 non-goal (mobile/PWA first);
Ross pulled the desktop entry forward on 2026-07-16 — this doc supersedes that
one line and nothing else. Owner altitude unchanged: Ross gates every
pilot-facing step; Ross-corpus-first; Trisha sees nothing until voice
out-grades the text baseline (WP-VOICE §G).

## A. What already exists (verified 2026-07-16)

The entire stack below the button is built and running; today its only entry
point is the ElevenLabs dashboard test console.

| layer | state | where |
|---|---|---|
| Voice I/O (STT, TTS, turn-taking, barge-in) | ElevenLabs agent, custom-LLM mode, no ElevenLabs-side tools | agent created by `~/scratch/voice-spike/elevenlabs/create-agent.mjs` |
| Reasoner | Claude behind an OpenAI-compatible `/chat/completions` SSE endpoint; native Anthropic MCP connector runs the full `/mcp/v2` tool loop server-side | `companion-backend.mjs`, deployed on the ross droplet behind nginx `/voice-llm/` (pm2 `voice-llm`) |
| Protocol | packet-first check-in, voice register lines, HARD LATENCY RULE (one tool call per spoken turn), `VOICE_LLM_ALLOWED_TOOLS` allowlist incl. day-graph + capabilities + outbox verbs | same file; git log in `~/scratch/voice-spike/elevenlabs` |
| Session close | post-call webhook → HMAC verify → capture doc via `ingest_doc` (`Check-in — Voice Transcript — <lens> — <date>`) → engine post-close wing fires | `postcall.mjs`, registered webhook |
| Continuation | Grade-1 "same mind" — voice resumes the prework run (`CONTINUE_PASS_RANK`) | backend |
| Grading | per-stage JSONL timings + `mcpCalls[]`; rubric + graded baselines | `voice-spike/RUBRIC.md`, `GRADES-2026-07-13.md` |

Deployment caveat: commit `8448751` is the md5-matched droplet sync; commits
after it (allowlist growth, latency rule) may not be live. **Byte-verify the
droplet copy before building on it** (false-silence discipline).

## B. Why desktop entry is the cheap next step

WP-VOICE's mobile path stalls on T4 (identity: email-login, per-user grant
minting from a phone). The desktop app already holds the whole identity story:
every install has a per-user `baseUrl` (their droplet) + bearer token in the
Connection pane. Voice-from-Threshold needs **zero new identity machinery** —
the droplet the app already talks to is the droplet running that user's voice
backend. T4 stays where it was: mobile-only concern.

New work is exactly three pieces:

1. **A mint route** on the companion backend (the only server change).
2. **A call window + entry button** in the app (the only UI change).
3. **Mic plumbing** in the macOS bundle (the only native change).

## C. The click-to-talk chain

```
[Threshold: "Check in" button]
        │  opens dedicated call WebviewWindow (small, always-on-top)
        ▼
[call window JS]
        │  POST {baseUrl}/voice-llm/app-session   Authorization: Bearer <app token>
        ▼
[companion-backend /app-session]                       NEW, ~50 lines
        │  1. validate bearer by replaying it against the LOCAL engine's
        │     authenticated endpoint (same check the app's Test Connection
        │     uses); ≠200 → 401. No new client secret.
        │  2. mint ElevenLabs conversation credential server-side
        │     (ELEVENLABS_API_KEY + VOICE_AGENT_ID from /etc/voice-llm.env —
        │     two env additions, droplet step)
        │  3. return { conversationToken | signedUrl, expiresAt }
        ▼
[call window] starts session via vendored @elevenlabs/client (ESM file in
        src/assets/vendor/ — frontend has no bundler; plain module import)
        │  WebRTC preferred (echo cancellation, the latency the spike graded);
        │  WebSocket is the documented fallback
        ▼
[ElevenLabs cloud] ↔ /voice-llm/chat/completions ↔ Claude ↔ /mcp/v2
        (unchanged — the deployed loop)
        ▼
[hang up] → post-call webhook → capture doc → post-close wing  (unchanged)
```

Client-side secret inventory after this change: **unchanged** (bearer it
already had; conversation credential is short-lived + single-conversation).
The ElevenLabs API key, MCP token, shared secret, webhook secret all stay in
droplet env, exactly as today.

## D. Why a dedicated call window (binding for v1)

The app is ONE window that **navigates** between `widget.html` and
`index.html` on collapse/expand (`window.location.replace` in
widget_collapse). A call living in `index.html` dies the moment the user
collapses the widget — mic stream and WebRTC peer destroyed mid-sentence.

So the call runs in its own small `WebviewWindow` ("call pill": state +
mute + hang-up), spawned on click, independent of widget state. Wins:

- collapse/expand can't kill the call; widget behavior untouched (no
  styleMask work near the fullscreen landmine);
- a visible OS-level surface exists whenever the mic is live (trust);
- the window's content origin is swappable (see Spike-0 fallback) without
  touching the main app.

## E. Native checklist (macOS) — small, but each item is load-bearing

- `Info.plist`: `NSMicrophoneUsageDescription` (absent today; without it the
  process is killed on first mic touch in a signed build).
- `entitlements.plist`: add `com.apple.security.device.audio-input`
  (hardened-runtime resource entitlement; absent today).
- WKWebView permission delegate: **no work** — bundled wry 0.55.1 auto-grants
  media-capture requests (`WKPermissionDecision::Grant`,
  `wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs:126`). Verified
  in the vendored source, not assumed.
- TCC prompt appears once per install at first mic use — the call window's
  connecting state should say so ("macOS will ask for microphone access").
- House rule applies: after the native change, `cargo test --lib` locally +
  byte-verify the RUNNING binary (Info.plist keys grep-able in the bundle).

## F. Spike-0 — the one genuine unknown (gate for everything else)

`navigator.mediaDevices` requires a secure context. Dev builds load over
`http://localhost` (a secure context — dev will happily lie about prod). Prod
loads `tauri://localhost`, a custom scheme wry registers via
`setURLSchemeHandler` **without** marking it secure. Whether WKWebView exposes
`mediaDevices` + working `getUserMedia` under the prod scheme is unverified.

**Spike:** a throwaway `voice-probe.html` in a PROD-built bundle that calls
`getUserMedia({audio:true})` and prints outcome + `isSecureContext`. Run once
on-device with the E-item plumbing in place.

- **GO** → call window ships as a bundled page.
- **NO-GO** → call window loads a droplet-served **https** page instead
  (companion-backend grows one static route; https origin in WKWebView is
  battle-tested for WebRTC). Same call-window shell, same mint route, same
  everything — only the page's origin changes. The spike picks the origin;
  it cannot kill the WP.

## G. Increments (small PRs; each Ross-gated at its pilot-facing edge)

| # | slice | contents | gate |
|---|---|---|---|
| V0 | Spike-0 | E-item plumbing + probe page (removed after) | GO/NO-GO on bundled origin |
| V1 | click-to-talk, Ross corpus | `/app-session` mint route (+2 env vars, droplet step per devops discipline); call window; ONE entry point (Today header "Check in" mic button); vendored client | works end-to-end on Ross's install; session graded per RUBRIC |
| V2 | session UX | connecting/listening/speaking/working states, mute, barge-in verified live, failure states (mint 401/timeout → visible reason, never silent) | render-look loop with Ross (one pair of eyes; no agent fan-out) |
| V3 | entries that matter | routines chip → voice check-in (chip, not notification-click — known unreliable); deep-link `apolla-threshold://voice-checkin`; widget-pill affordance | Ross approves each surface |
| V4 | pilot exposure | Trisha-droplet backend deploy + per-user agent (create-agent.mjs with her env) | WP-VOICE §G bar: voice out-grades text baseline + explicit named go |

Fail-visible (house law): if the backend lacks the mint route / voice is
unconfigured, the entry button renders disabled with a plain reason in
Settings → Connection ("Voice isn't set up on this engine"), never hidden
silently and never a dead click.

## H. Cost honesty (WP-VOICE §F.3)

ElevenLabs agent minutes ≈ $0.08/min + Claude tokens. A 10–15 min check-in ≈
low single-digit dollars — a small multiple of a runner pass (~$0.25–0.40),
not the same order. Acceptable for Ross-daily-use; re-price before any pilot
exposure (V4).

## I. Open questions (answer during V1, none blocking start)

1. WebRTC conversation-token API surface vs signed-url — pin against current
   ElevenLabs docs at build time (SDK shapes drift; create-agent.mjs already
   documents this pattern).
2. Echo cancellation on open laptop speakers — WebRTC AEC default should
   cover it; verify in the first live session (it's a grading row).
3. Collapse-during-call polish — v1: call window is simply independent; any
   fancier coupling (widget shows in-call state) is V3+.
4. Backend redeploy — reconcile local `ec90ec0` vs droplet copy before V1
   (md5 check; §A caveat).

## J. References

- `WP-VOICE-BRIEF-2026-07-13.md` (parent; §G ship gates unchanged)
- `~/scratch/voice-spike/` — README, RUBRIC, GRADES-2026-07-13 (why Claude
  stays the reasoner), `elevenlabs/README.md` (custom-LLM contract, droplet
  runbook, postcall bridge), `elevenlabs/companion-backend.mjs` (deployed)
- `WP-DAY-GRAPH-ADDENDUM-2026-07-15.md` §B (voice lane owns doctrine/protocol)
- `COMPANION-NETWORK-AS-BUILT-2026-07-15.md` (voice registers already speak
  peer accept-cards)
