# Viktora Threshold — Pilot Install Guide

Two-step install on Mac or Windows. ~2 minutes from download to first capture. No external utility setup; OCR is built in.

## What you'll need

- macOS (Apple Silicon or Intel) **or** Windows 10 May 2020 update / Windows 11 (x86_64)
- An Apolla workspace running somewhere reachable (local schema-browser via WP-OCR-08, or hosted Apolla once WP-OCR-09 ships)
- Your workspace's bearer token (the `INGESTION_API_KEY` your schema-browser was started with; the same value the OCR utility and Outlook Add-in use)

---

## macOS install

### Step 1 — Install the `.app`

1. Download `Viktora Threshold_<version>_aarch64.dmg` (Apple Silicon) from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. Double-click the `.dmg` to mount it
3. Drag `Viktora Threshold.app` into `/Applications`
4. Eject the disk image

### Step 2 — First launch

Threshold is **signed with our Apple Developer ID and notarized by Apple** (FN-OCR-13-03), so it opens on a normal double-click — no quarantine dance:

1. Open `/Applications` in Finder
2. **Double-click** `Viktora Threshold.app`
3. The onboarding wizard appears in expanded-window mode

**Note:** v0.3 sets `LSUIElement = YES` so Threshold does NOT appear in the Dock or `Cmd-Tab`. To find a running Threshold, look for the floating widget in a screen corner (see "Widget UX" below).

> **Got an older / unsigned build?** If you downloaded a build cut before signing was enabled, macOS may say *"…is damaged and can't be opened"* or *"cannot be checked for malicious software."* In that case: **right-click** the app → **Open** → **Open**, or in Terminal run `xattr -dr com.apple.quarantine "/Applications/Viktora Threshold.app"`. Current releases don't need this.

---

## Windows install

### Step 1 — Install via `setup.exe` (recommended) or `.msi`

Two installer variants are attached to each release. Use **`setup.exe`** unless your environment specifically requires MSI:

| File | Format | Notes |
|---|---|---|
| `Viktora Threshold_<version>_x64-setup.exe` | NSIS | **Recommended.** Smaller (~3.5 MB), simpler wizard, friendlier for individual users |
| `Viktora Threshold_<version>_x64_en-US.msi` | Windows Installer | For corporate IT deployment scenarios |

The installers are **Authenticode-signed via Azure Trusted Signing** (FN-OCR-13-02), so SmartScreen no longer blocks them.

1. Download the chosen installer from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. Double-click
3. Approve the **User Account Control** prompt — it shows our verified publisher name (this is normal, not the SmartScreen wall)
4. Step through the installer (Next → Install → Finish)

> **Got an older / unsigned build?** If you downloaded a build cut before signing was enabled, SmartScreen may still warn *"Windows protected your PC."* In that case click **More info → Run anyway**. Current releases don't trigger this.

### Step 2 — First launch

1. Open the Start menu → search **Viktora Threshold** → click
2. The onboarding wizard appears in expanded-window mode

**Note:** v0.3 sets `skipTaskbar: true` so Threshold does NOT appear in the Windows Taskbar. To find a running Threshold, look for the floating widget in a screen corner.

---

## Step 3 (both platforms) — Onboarding wizard (~30s)

The wizard runs in **expanded window mode** (800×600). When it finishes, the window collapses to the floating widget (~180×80 pill in a screen corner).

| Screen | What you do |
|---|---|
| **Welcome** | Read the intro + click "Get started" |
| **Connect to your workspace** | Paste your Apolla base URL (`http://localhost:3001` for local) + paste the bearer token; click "Test connection" — should turn green; click "Next" |
| **You're set up** | Click "Take me to the app" — wizard finishes, window collapses to the floating widget |

Subsequent launches skip the wizard and open straight to the widget.

---

## Widget UX (v0.3 → v0.4)

Once configured, Threshold lives as a **small floating widget in a screen corner**:

- **Size:** ~180×80 pill shape, always-on-top, drag-to-move
- **Two action buttons:**
  - **Capture (crosshair icon)** — single-click → region-select overlay → OCR + ingest
  - **Upload (file icon)** — single-click → native file picker. Also accepts OS-level drag-drop: drop a `.txt` / `.md` / `.vtt` / `.srt` / `.html` directly onto the widget; the button glows green during drag-over
- **Status dot** (bottom-right corner): gray = unknown, green = last capture/POST succeeded, red = last capture/POST failed. **Hover the dot** to see the last toast's title + body inline (useful for diagnosing red-state failures)

### Right-click menu

| Item | What it does |
|---|---|
| **Capture Screen** | Same as clicking the crosshair button |
| **Pick File…** | Same as clicking the upload button |
| **Expand…** | Resizes window to 800×600 + restores chrome + loads the full v0.2-style UI (Configure tab, wizard re-entry, etc.) |
| **Settings…** | Same as Expand, but routes directly to the Configure tab |
| **Quit Threshold** | Drains any in-flight POSTs (D-12-02-AMEND) then exits |

**Cmd+Q does NOT quit on Mac** because `LSUIElement = YES` removes Threshold from the focused-app list. Quit via the right-click menu.

### Drag-to-move

Click-and-hold anywhere on the widget body (button area or surrounding pill), then drag. The position persists to `config.json` and is restored on next launch.

### Expand / collapse

Right-click → **Expand…** grows the window to 800×600 with normal title bar + close button, loading the v0.2-style full UI. To return to the widget, click the **▢ Collapse** button at the top-right of the expanded UI.

---

## What capture gestures are supported

| Gesture | How |
|---|---|
| **Capture Screen** | Click the Capture button on the widget (or use the right-click menu's "Capture Screen" item) → region-select overlay appears (macOS native crosshair / Windows Snipping Tool from `ms-screenclip:`) → drag a region (or press Esc / wait 60s on Windows to cancel) → OCR + ingest fires |
| **Upload File** | Click the Upload button on the widget (or right-click → "Pick File…") → native file picker → select a `.txt` / `.md` / `.vtt` / `.srt` / `.html` |
| **Drag-drop** | Drag any plain-text file from Finder (Mac) or Explorer (Windows) onto the widget → upload button glows green → release to ingest |

OS-level native notifications appear when each capture completes (depending on your system preference). The widget's status dot also reflects the last outcome — hover to see the title + body.

---

## Tidbits — the wow-loop (NEW in v0.4)

When you capture something, the corpus does more than just file it away. About 5–30 seconds after the capture-success notification lands, Apolla reads what you captured against everything you've previously captured + extracts a short "why this matters" preview — the **tidbit**.

When the tidbit is ready, three things happen at once:

1. **A second OS notification fires** with the tidbit's headline (e.g., "You've been tracking pricing-realignment — a new thread connects")
2. **The widget pulses** with a soft yellow ring — visible even if you missed the notification
3. **A small yellow ●💡 badge** appears in the corner of the widget

**To see the full preview**, tap the badge OR click the OS notification. The widget expands to a panel that shows:

- The tidbit headline
- The full "why this matters" prose (a few sentences explaining what your capture connected to)
- Highlight chips — the 1-3 entities Apolla pulled out, with blue chips for entities you've seen before (showing how many prior captures) and gray chips for new entities
- A **"View full in Apolla →"** button that opens the document in the Apolla browser surface

**If no tidbit appears**, that's intentional — not every capture surfaces a structurally surprising connection. The first capture-success notification still landed; you just didn't get a second one. Captures of content well outside your existing corpus (e.g., a one-off PDF about an unrelated topic) typically fall in this bucket.

**Notification click vs. widget click:** the OS notification's click handler is best-effort. On some platforms / Tauri plugin versions, clicking the notification reliably opens the panel; on others, the click does nothing. **The widget badge always works** — if you don't see the panel after clicking the notification, click the badge directly.

**Mac vs Windows asymmetry:** on Windows captures from Outlook/Edge/etc., the tidbit may include a "from your Outlook" / "from your Edge" framing line above the headline (the corpus knows which app you captured from). On Mac, this framing falls back to "from your screen" — the underlying app-attribution gap from v0.3 (see `AAR-WP-Threshold-Compact-UX.md` §3.2 + §5) is still open.

---

## Passive email intake — OneDrive mail flow (optional, Windows-friendly)

Threshold can pull your email into your workspace passively — no forwarding, no
BCC — via two Power Automate flows in **your own** Microsoft account that drop
each message as a small JSON file into `OneDrive → Apps → Threshold → mail`.
Threshold's app sweeps that folder on its channel tick. This works even with
New Outlook (which has no add-in/COM surface).

The onboarding **integration doctor** generates the flows for you (a
`Threshold-PowerAutomate/` folder with `threshold-mail-inbox.flow.json`,
`threshold-mail-sent.flow.json`, `IMPORT-RECIPE.md`, plus the Teams + backfill
artifacts described in the next two sections) and prepares the
`Apps/Threshold/mail` sweep folder under your detected OneDrive root. Building
the flows is a one-minute, no-admin step.

**5-step manual build/import test** (do it once for **Inbox**, once for **Sent**
— the full test is that a test email lands as a `.json` file):

1. **New flow.** Power Automate → **Create → Automated cloud flow**. Name it
   `Threshold mail — Inbox` (second flow: `Threshold mail — Sent`).
2. **Trigger.** **Office 365 Outlook → When a new email arrives (V3)**. Set
   **Folder** to **Inbox** (Sent flow: **Sent Items**).
3. **Action.** **OneDrive for Business → Create file**. **Folder Path:**
   `/Apps/Threshold/mail`. **File Name** (expression): `concat(guid(),'.json')`.
4. **File Content** (expression editor) — paste the exact expression from
   `IMPORT-RECIPE.md` for that mailbox (it starts `string(createObject('schemaVersion',1,'mailbox',…`).
   This shape is FROZEN — it's what Threshold's sweep parses.
5. **Save + test.** Send yourself a test email; within ~1 minute a `.json` file
   appears in `OneDrive/Apps/Threshold/mail` and the channel flips green on the
   next sweep.

> A blocked connector ("your admin hasn't allowed this") is an org policy, not a
> bug — the doctor records "blocked by org" and falls back to the classic-Outlook
> or add-in path. Nothing here exposes more than the email you already receive.
>
> **Break-glass only — the classic-Outlook COM thread-follower is OFF by default**
> (Ross ruling 2026-07-13). This OneDrive mail flow is the primary email transport.
> The app also ships a local-Outlook COM thread-follower (desktop Outlook only),
> but it is redundant for flow users and is the path most likely to trip Outlook's
> "a program is trying to access…" object-model-guard prompt, so it stays disabled
> unless your flow/OneDrive path is org-blocked. Turn it on only in that case, by
> setting `email_com_follower_enabled: true` in the app config.

---

## Passive Teams intake — channel-message flow (optional, one flow per channel)

The same file-drop pattern carries **Teams channel messages** into your
workspace. One Power Automate flow per channel you want followed; the doctor's
generated package includes `threshold-teams-live.flow.json` and the paste-ready
`TEAMS-RECIPE.md`.

**5-step build** (repeat per channel):

1. **New flow.** Power Automate → **Create → Automated cloud flow**. Name it
   after the channel, e.g. `Threshold Teams — Renewals`.
2. **Trigger.** **Microsoft Teams → When a new channel message is added** — pick
   the **Team** and **Channel** in the trigger.
3. **Action.** **OneDrive for Business → Create file**. **Folder Path:**
   `/Apps/Threshold/mail` (same swept folder as mail — the sweep routes by
   kind). **File Name** (expression): `concat(guid(),'.json')`.
4. **File Content** (expression editor) — paste the exact expression from
   `TEAMS-RECIPE.md` (it starts `string(createObject('schemaVersion',2,'kind','teams-channel',…`).
   It maps the message's **HTML body** (`body/content`) into `bodyHtml` — do NOT
   add any "Html to text" step; formatting like strikethrough carries meaning
   and is interpreted engine-side.
5. **Save + test.** Post a test message in the channel; within ~1 minute a
   `.json` file appears in the folder and the Teams channel flips green on the
   next sweep (the doctor's `teamsProcessedCount` starts counting).

---

## Coldstart backfill — import your last 30 days (optional, one-time)

After the doctor goes green, you can jump-start your field with the last 30
days of history. These are **instant** (manually-triggered) flows: run each
ONCE, watch the files land, then **delete the flow**. The engine dedupes
against anything already captured, and backfilled items are stamped
`capture: backfill` (filed as background context — they won't crowd today's
agenda).

- **Recommended: `Threshold backfill — Sent mail 30d`** (dense signal, low
  noise). Instant flow → **Office 365 Outlook → Get emails (V3)** with
  **Folder** = `Sent Items`, **Pagination ON**, search query limiting to the
  last 30 days → **Apply to each** over `value` → **Create file** with the
  expression from `BACKFILL-RECIPE.md` (`'kind','email','capture','backfill'`).
- **Optional: `Threshold backfill — Teams channel 30d`** per channel. Instant
  flow → **Microsoft Teams → Get messages** (pick Team + Channel, Pagination
  ON) → **Apply to each** → a **Condition** keeping only messages from the
  last 30 days → **Create file** with the Teams backfill expression from
  `BACKFILL-RECIPE.md`.

Both recipes follow the same capture rule as live flows: the source's **HTML
body** token → `bodyHtml`, never a text preview, never an html-to-text step.
The generated `threshold-mail-backfill-30d.flow.json` /
`threshold-teams-backfill-30d.flow.json` definitions mirror these steps.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| I can't find Threshold after launching it | v0.3 has no Dock icon (Mac) / no Taskbar entry (Windows). Look for the small ~180×80 floating widget in a screen corner. If it's off-screen (e.g., last position was on an unplugged monitor), delete `~/Library/Application Support/Viktora Threshold/config.json` (Mac) or `%APPDATA%\Viktora Threshold\config.json` (Windows) — Threshold will re-center on next launch. |
| Test connection fails with "Connection refused" | Schema-browser isn't running at the URL you entered. Start it (`cd schema-browser && npm run dev`) or update the URL in Configure (right-click widget → Settings…). |
| Ingest fails with HTTP 401 toast | Bearer token doesn't match what the schema-browser was started with. Re-paste in Configure pane (right-click → Settings…). |
| Capture Screen on Windows: "Couldn't open the Snipping Tool" | Your Windows version is below the v0.2 floor. Capture Screen requires Windows 10 May 2020 update (build 19041) or later for the `ms-screenclip:` URI. Update Windows; file upload + drag-drop still work in the meantime. |
| Capture Screen on Windows: "Capture timed out — did you cancel?" | The snip didn't complete within 60s, OR you pressed Esc. Try again. |
| `.app` won't open on Mac ("damaged" / "can't be checked") | Current releases are notarized and shouldn't hit this. If you have an older unsigned build, in Terminal run `xattr -dr com.apple.quarantine "/Applications/Viktora Threshold.app"` then try again, or grab the latest signed release. |
| Can't quit Threshold on Mac (Cmd+Q does nothing) | By design — `LSUIElement = YES` removes Threshold from the focused-app list. Right-click the widget → **Quit Threshold**. |
| Widget vanishes the moment I close the expanded window | That's the collapse path. The widget is still running; look in the screen corner. The widget process keeps running in the background and waits up to 60s for in-flight ingestions before exit (D-12-02-AMEND). |
| `sourceApp` shows empty on my Mac captures | Known limitation — see "Known limitations" below. Filter ships honest empty-string rather than the misleading self-attribution. |

---

## Known limitations

| Limitation | Workstream |
|---|---|
| Auto-update (manual download from GitHub Releases) | FN-OCR-13-09 (Sparkle + WinSparkle) |
| Rich file formats (`.docx`, `.pdf`, `.pptx`) | FN-OCR-12-02; use inbox-watcher or plain-text exports |
| `sourceApp` ships empty on **Mac** screen captures (asymmetric finding from v0.3 widget rollout) | The Mac widget click activates Threshold momentarily despite the v0.3 widget UX; the Mac `is_threshold_own_bundle_id` filter maps the self-reference to `""` rather than ship misleading data. **Windows captures DO attribute correctly** via `WS_EX_NOACTIVATE` shim (Phase 3) — empirically validated with `olk` (Outlook), `msedge` (Edge), etc. landing as the real `sourceApp` values. Mac NSPanel-style shim follow-up tracked as **FN-CUX-12** in the WP-Threshold-Compact-UX AAR. |
| Mac Keychain / Windows Credential Manager token storage (currently plain JSON in user config dir) | FN-OCR-12-05 |
| Deep-link Configure UX (`viktora-threshold://configure?token=...`) | FN-OCR-12-06; depends on WP-OCR-09 hosted Apolla |
| Marker-tidbit-return on capture (the GTM wow loop) | FN-OCR-12-12 + WP-OCR-09 free tier |
| Linux port | FN-OCR-13-01 |

See [WP-OCR-13 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-13-Threshold-Cross-Platform-OCR-Brief-v1_2-FINAL.md) for the cross-platform OCR spec, [WP-Threshold-Compact-UX v1.1-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-Threshold-Compact-UX-Brief-v1_1-FINAL.md) for the v0.3 widget direction, and [WP-OCR-12 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-12-Desktop-Capture-App-Brief-v1_2-FINAL.md) for the original desktop-app spec.
