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

### Step 2 — First launch (right-click Open ceremony)

Because Threshold ships unsigned (signing tracked in FN-OCR-13-03), macOS Gatekeeper refuses to open it on a regular double-click. **One-time bypass:**

1. Open `/Applications` in Finder
2. **Right-click** (or Ctrl-click) on `Viktora Threshold.app` → **Open**
3. macOS warns: *"Viktora Threshold can't be opened because Apple cannot check it for malicious software"*
4. Click **Open** in the warning dialog (the right-click path makes this button available; a normal double-click does not)
5. The onboarding wizard appears in expanded-window mode

Subsequent launches via Spotlight work normally — Gatekeeper remembers the exemption per-app. **Note:** v0.3 sets `LSUIElement = YES` so Threshold does NOT appear in the Dock or `Cmd-Tab`. To find a running Threshold, look for the floating widget in a screen corner (see "Widget UX" below).

---

## Windows install

### Step 1 — Install via `setup.exe` (recommended) or `.msi`

Two installer variants are attached to each release. Use **`setup.exe`** unless your environment specifically requires MSI:

| File | Format | Notes |
|---|---|---|
| `Viktora Threshold_<version>_x64-setup.exe` | NSIS | **Recommended.** Smaller (~3.5 MB), simpler wizard, friendlier for individual users |
| `Viktora Threshold_<version>_x64_en-US.msi` | Windows Installer | For corporate IT deployment scenarios |

1. Download the chosen installer from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. Double-click
3. Windows SmartScreen warns: *"Microsoft Defender SmartScreen prevented an unrecognized app from starting"* (Threshold ships unsigned; Authenticode signing tracked in FN-OCR-13-02)
4. Click **More info** → **Run anyway**
5. Step through the installer (Next → Install → Finish)

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| I can't find Threshold after launching it | v0.3 has no Dock icon (Mac) / no Taskbar entry (Windows). Look for the small ~180×80 floating widget in a screen corner. If it's off-screen (e.g., last position was on an unplugged monitor), delete `~/Library/Application Support/Viktora Threshold/config.json` (Mac) or `%APPDATA%\Viktora Threshold\config.json` (Windows) — Threshold will re-center on next launch. |
| Test connection fails with "Connection refused" | Schema-browser isn't running at the URL you entered. Start it (`cd schema-browser && npm run dev`) or update the URL in Configure (right-click widget → Settings…). |
| Ingest fails with HTTP 401 toast | Bearer token doesn't match what the schema-browser was started with. Re-paste in Configure pane (right-click → Settings…). |
| Capture Screen on Windows: "Couldn't open the Snipping Tool" | Your Windows version is below the v0.2 floor. Capture Screen requires Windows 10 May 2020 update (build 19041) or later for the `ms-screenclip:` URI. Update Windows; file upload + drag-drop still work in the meantime. |
| Capture Screen on Windows: "Capture timed out — did you cancel?" | The snip didn't complete within 60s, OR you pressed Esc. Try again. |
| `.app` won't open on Mac even after right-click → Open | The quarantine attribute may be stuck. In Terminal: `xattr -d com.apple.quarantine "/Applications/Viktora Threshold.app"` then try again. |
| Can't quit Threshold on Mac (Cmd+Q does nothing) | By design — `LSUIElement = YES` removes Threshold from the focused-app list. Right-click the widget → **Quit Threshold**. |
| Widget vanishes the moment I close the expanded window | That's the collapse path. The widget is still running; look in the screen corner. The widget process keeps running in the background and waits up to 60s for in-flight ingestions before exit (D-12-02-AMEND). |
| `sourceApp` shows empty on my Mac captures | Known limitation — see "Known limitations" below. Filter ships honest empty-string rather than the misleading self-attribution. |

---

## Known limitations

| Limitation | Workstream |
|---|---|
| Unsigned binaries (Gatekeeper / SmartScreen ceremony per install) | FN-OCR-13-02 (Windows Authenticode) + FN-OCR-13-03 (Apple Developer ID) |
| Auto-update (manual download from GitHub Releases) | FN-OCR-13-09 (Sparkle + WinSparkle; requires signing first) |
| Rich file formats (`.docx`, `.pdf`, `.pptx`) | FN-OCR-12-02; use inbox-watcher or plain-text exports |
| `sourceApp` ships empty on **Mac** screen captures (asymmetric finding from v0.3 widget rollout) | The Mac widget click activates Threshold momentarily despite the v0.3 widget UX; the Mac `is_threshold_own_bundle_id` filter maps the self-reference to `""` rather than ship misleading data. **Windows captures DO attribute correctly** via `WS_EX_NOACTIVATE` shim (Phase 3) — empirically validated with `olk` (Outlook), `msedge` (Edge), etc. landing as the real `sourceApp` values. Mac NSPanel-style shim follow-up tracked as **FN-CUX-12** in the WP-Threshold-Compact-UX AAR. |
| Mac Keychain / Windows Credential Manager token storage (currently plain JSON in user config dir) | FN-OCR-12-05 |
| Deep-link Configure UX (`viktora-threshold://configure?token=...`) | FN-OCR-12-06; depends on WP-OCR-09 hosted Apolla |
| Marker-tidbit-return on capture (the GTM wow loop) | FN-OCR-12-12 + WP-OCR-09 free tier |
| Linux port | FN-OCR-13-01 |

See [WP-OCR-13 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-13-Threshold-Cross-Platform-OCR-Brief-v1_2-FINAL.md) for the cross-platform OCR spec, [WP-Threshold-Compact-UX v1.1-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-Threshold-Compact-UX-Brief-v1_1-FINAL.md) for the v0.3 widget direction, and [WP-OCR-12 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-12-Desktop-Capture-App-Brief-v1_2-FINAL.md) for the original desktop-app spec.
