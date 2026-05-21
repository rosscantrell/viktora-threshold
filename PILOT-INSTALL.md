# Viktora Threshold — Pilot Install Guide

Two-step install on Mac or Windows. ~2-3 minutes from download to first capture. No external utility setup; OCR is built in.

## What you'll need

- macOS (Apple Silicon or Intel) **or** Windows 10 May 2020 update / Windows 11 (x86_64)
- An Apolla workspace running somewhere reachable (local schema-browser via WP-OCR-08, or hosted Apolla once WP-OCR-09 ships)
- Your workspace's bearer token (the `INGESTION_API_KEY` your schema-browser was started with; the same value the OCR utility and Outlook Add-in use)

---

## macOS install

### Step 1 — Install the `.app`

1. Download `Viktora Threshold_<version>_aarch64.dmg` (Apple Silicon) or the Intel variant from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. Double-click the `.dmg` to mount it
3. Drag `Viktora Threshold.app` into `/Applications`
4. Eject the disk image

### Step 2 — First launch (right-click Open ceremony)

Because v0.2 ships unsigned (signing tracked in FN-OCR-13-03), macOS Gatekeeper refuses to open it on a regular double-click. **One-time bypass:**

1. Open `/Applications` in Finder
2. **Right-click** (or Ctrl-click) on `Viktora Threshold.app` → **Open**
3. macOS warns: *"Viktora Threshold can't be opened because Apple cannot check it for malicious software"*
4. Click **Open** in the warning dialog (the right-click path makes this button available; a normal double-click does not)
5. The 3-screen onboarding wizard appears

Subsequent launches via Spotlight or the Dock work normally — Gatekeeper remembers the exemption per-app.

---

## Windows install

### Step 1 — Install the `.msi`

1. Download `Viktora Threshold_<version>_x64_en-US.msi` from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. Double-click the `.msi`
3. Windows SmartScreen warns: *"Microsoft Defender SmartScreen prevented an unrecognized app from starting"* (because v0.2 ships unsigned; Authenticode signing tracked in FN-OCR-13-02)
4. Click **More info** → **Run anyway**
5. Step through the Wix installer (Next → Next → Install → Finish)

### Step 2 — First launch

1. Open the Start menu → search **Viktora Threshold** → click
2. The 3-screen onboarding wizard appears

Subsequent launches via Start menu or the desktop shortcut work normally.

---

## Step 3 (both platforms) — Onboarding wizard (~30-60s)

The wizard walks you through 3 screens:

| Screen | What you do |
|---|---|
| **Welcome** | Read the intro + click "Get started" |
| **Connect to your workspace** | Paste your Apolla base URL (`http://localhost:3001` for local, or your hosted URL) + paste the bearer token; click "Test connection" — should turn green; click "Next" |
| **You're set up** | Click any of the three action tiles (or "Take me to the app") to enter the main UI |

Subsequent launches skip the wizard and open straight to the main view.

---

## What capture gestures are supported

| Gesture | How |
|---|---|
| **Upload File** | Click the "Upload File" button → native file picker → select a `.txt` / `.md` / `.vtt` / `.srt` / `.html` |
| **Drag-drop** | Drag any plain-text file from Finder (Mac) or Explorer (Windows) onto the Threshold window → blue overlay confirms the drop zone → release |
| **Capture Screen** | Click "Capture Screen" → region-select overlay appears (macOS native crosshair / Windows Snipping Tool from `ms-screenclip:`) → drag a region (or press Esc / wait 60s on Windows to cancel) → OCR + ingest fires |

A toast appears top-right when each capture completes:

- **Green ✓** — new capture sent to Apolla (with extracted term count)
- **Yellow ↺** — duplicate content (server returned `alreadyExisted: true`)
- **Red ✗** — capture failed (wrong file type, connection refused, server returned an error, etc. — the body explains what)
- **Blue ⟳** — pre-flight pending; appears while the LLM extracts terms (~10-15s), disappears when the response arrives

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Test connection fails with "Connection refused" | Schema-browser isn't running at the URL you entered. Start it (`cd schema-browser && npm run dev`) or update the URL in Configure. |
| Ingest fails with HTTP 401 toast | Bearer token doesn't match what the schema-browser was started with. Re-paste in Configure pane. |
| Capture Screen on Windows: "Couldn't open the Snipping Tool" | Your Windows version is below the v0.2 floor. Capture Screen requires Windows 10 May 2020 update (build 19041) or later for the `ms-screenclip:` URI. Update Windows; file upload + drag-drop still work in the meantime. |
| Capture Screen on Windows: "Capture timed out — did you cancel?" | The snip didn't complete within 60s, OR you pressed Esc. Try again. |
| `.app` won't open on Mac even after right-click → Open | The quarantine attribute may be stuck. In Terminal: `xattr -d com.apple.quarantine "/Applications/Viktora Threshold.app"` then try again. |
| The window vanishes immediately after I close it during a capture | That's intentional (D-12-02-AMEND). The process keeps running in the background until in-flight ingestions finish (or 60s timeout), then exits cleanly. |
| Wizard appears again on every launch | Config isn't being persisted. On Mac, check `~/Library/Application Support/Viktora Threshold/` exists and is writable. On Windows, check `%APPDATA%\Viktora Threshold\`. |

---

## Known limitations

| Limitation | Workstream |
|---|---|
| Unsigned binaries (Gatekeeper / SmartScreen ceremony per install) | FN-OCR-13-02 (Windows Authenticode) + FN-OCR-13-03 (Apple Developer ID); v0.3+ |
| Auto-update (manual download from GitHub Releases) | FN-OCR-13-09 (Sparkle + WinSparkle; requires signing first) |
| Rich file formats (`.docx`, `.pdf`, `.pptx`) | FN-OCR-12-02; use inbox-watcher or plain-text exports |
| `sourceApp` ships empty on screen captures (FN-OCR-13-12) | Click-driven Capture Screen makes Threshold the frontmost app at capture time; the pre-invocation lookup resolves to Threshold itself, and the self-filter maps to `""` rather than ship misleading data. **Symmetric across Mac + Windows** — confirmed empirically in pilots. Architectural fix (NSWorkspace-activation-observer on Mac, equivalent on Windows) tracked in the compact-UX workstream for v0.3+. |
| Mac Keychain / Windows Credential Manager token storage (currently plain JSON in user config dir) | FN-OCR-12-05 |
| Deep-link Configure UX (`viktora-threshold://configure?token=...`) | FN-OCR-12-06; depends on WP-OCR-09 hosted Apolla |
| Marker-tidbit-return on capture (the GTM wow loop) | FN-OCR-12-12 + WP-OCR-09 free tier |
| Linux port | FN-OCR-13-01 |

See [WP-OCR-13 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-13-Threshold-Cross-Platform-OCR-Brief-v1_2-FINAL.md) for the cross-platform OCR spec and [WP-OCR-12 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-12-Desktop-Capture-App-Brief-v1_2-FINAL.md) for the original desktop-app spec.
