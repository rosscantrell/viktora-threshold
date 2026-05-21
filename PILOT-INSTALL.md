# Viktora Threshold — Pilot Install Guide

Three steps from `.dmg` download to first capture. ~3-5 minutes including the one-time setup script.

## What you'll need

- macOS (Apple Silicon or Intel)
- [Homebrew](https://brew.sh) installed
- An Apolla workspace running somewhere reachable (local schema-browser via WP-OCR-08, or hosted Apolla once WP-OCR-09 ships)
- Your workspace's bearer token (the `INGESTION_API_KEY` your schema-browser was started with; the same value the OCR utility and Outlook Add-in use)

---

## Step 1 — Run `setup.sh` (one-time)

`setup.sh` installs the `viktora-ocr-capture` utility globally via `pipx` so Threshold's bundled `.app` can find it. (Required because macOS GUI-launched `.app` bundles inherit a stripped PATH — see WP-OCR-12 v1.2-FINAL D-12-19.)

From your clone of `viktora-threshold`:

```bash
bash setup.sh
```

The script will:

1. Verify Homebrew is installed (fail with a clear pointer if not)
2. Install `pipx` if missing
3. Run `pipx install git+https://github.com/rosscantrell/viktora-ocr-capture.git`
4. Verify the binary landed at `~/.local/bin/ocr-capture`

Idempotent — safe to re-run if you need to upgrade or recover.

---

## Step 2 — Install the `.app`

1. Download `Viktora Threshold_<version>_aarch64.dmg` (Apple Silicon) or the Intel variant from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. Double-click the `.dmg` to mount it
3. Drag `Viktora Threshold.app` into `/Applications`
4. Eject the disk image

---

## Step 3 — First launch (right-click Open ceremony)

Because v1 ships unsigned (per P-12-01 (b) — signing deferred to second pilot), macOS Gatekeeper refuses to open it on a regular double-click. **One-time bypass:**

1. Open `/Applications` in Finder
2. **Right-click** (or Ctrl-click) on `Viktora Threshold.app` → **Open**
3. macOS warns: *"Viktora Threshold can't be opened because Apple cannot check it for malicious software"*
4. Click **Open** in the warning dialog (the right-click path makes this button available; a normal double-click does not)
5. The 3-screen onboarding wizard appears

Subsequent launches via Spotlight or the Dock work normally — Gatekeeper remembers the exemption per-app.

---

## Step 4 — Onboarding wizard (~30-60s)

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
| **Upload File** | Click the "Upload File" button → native macOS file picker → select a `.txt` / `.md` / `.vtt` / `.srt` / `.html` |
| **Drag-drop** | Drag any plain-text file from Finder onto the Threshold window → blue overlay confirms the drop zone → release |
| **Capture Screen** | Click "Capture Screen" → macOS region-select overlay → drag a region (or press Esc to cancel) → OCR + ingest fires |

A toast appears top-right when each capture completes:

- **Green ✓** — new capture sent to Apolla (with extracted term count)
- **Yellow ↺** — duplicate content (server returned `alreadyExisted: true`)
- **Red ✗** — capture failed (wrong file type, connection refused, server returned an error, etc. — the body explains what)
- **Blue ⟳** — pre-flight pending; appears while the LLM extracts terms (~10-15s), disappears when the response arrives

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Capture Screen" button is greyed out | Step 1 didn't complete. Re-run `bash setup.sh`. The button enables once `~/.local/bin/ocr-capture` exists. |
| Test connection fails with "Connection refused" | Schema-browser isn't running at the URL you entered. Start it (`cd schema-browser && npm run dev`) or update the URL in Configure. |
| Ingest fails with HTTP 401 toast | Bearer token doesn't match what the schema-browser was started with. Re-paste in Configure pane. |
| `.app` won't open even after right-click → Open | The quarantine attribute may be stuck. In Terminal: `xattr -d com.apple.quarantine "/Applications/Viktora Threshold.app"` then try again. |
| The window vanishes immediately after I close it during a capture | That's intentional (D-12-02-AMEND). The process keeps running in the background until in-flight ingestions finish (or 60s timeout), then exits cleanly. Verify with `ps aux \| grep viktora-threshold`. |
| Wizard appears again on every launch | `config.json` isn't being persisted. Check `~/Library/Application Support/Viktora Threshold/` exists and is writable. |

---

## What's NOT in v1

| Limitation | Workstream |
|---|---|
| Unsigned `.app` (right-click-Open friction per install) | P-12-01 (b) → (a) before second pilot |
| Auto-update (manual download from GitHub Releases) | FN-OCR-12-03 (Sparkle, requires signing first) |
| Rich file formats (`.docx`, `.pdf`, `.pptx`) | FN-OCR-12-02; use inbox-watcher or plain-text exports |
| Cross-surface toast unification | FN-OCR-12-04 |
| Mac Keychain token storage (currently plain JSON in `~/Library/Application Support/`) | FN-OCR-12-05 |
| Deep-link Configure UX (`viktora-threshold://configure?token=...`) | FN-OCR-12-06; depends on WP-OCR-09 hosted Apolla |
| Windows port | FN-OCR-12-07 + WP-OCR-04 |
| Marker-tidbit-return on capture (the GTM wow loop) | FN-OCR-12-12 + WP-OCR-09 free tier |

See [WP-OCR-12 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-12-Desktop-Capture-App-Brief-v1_2-FINAL.md) for the full spec.
