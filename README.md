# Viktora Threshold

Mac desktop capture app for Apolla workspaces. Tauri (Rust shell + webview frontend); produces a small `.app` bundle (~10-15 MB).

**Status:** Pre-development scaffold. Spec lives in [WP-OCR-12 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-12-Desktop-Capture-App-Brief-v1_2-FINAL.md).

## What it does

A single click-driven entry point for the most common ingestion gestures that don't fit existing Apolla capture surfaces:

1. **Select a file from disk** — plain-text formats (`.txt`, `.md`, `.vtt`, `.srt`, `.html`)
2. **Drag-and-drop** a file onto the window
3. **Capture Screen** — invokes [viktora-ocr-capture](https://github.com/rosscantrell/viktora-ocr-capture) as a subprocess for region-select screenshot OCR

All three POST the resulting text to your Apolla workspace via the standard `/api/ingest-document` endpoint with bearer auth.

**Launch-on-demand UX:** open it when you need it, close the window when done. No menu bar, no Dock persistence, no background daemon.

## Pairs with

- [viktora-ocr-capture](https://github.com/rosscantrell/viktora-ocr-capture) — the Python OCR utility this app subprocesses out to for screenshot capture. Hard prerequisite for the Capture Screen button; the file picker and drag-drop paths work without it.
- An Apolla schema-browser deployment — either local-server ([WP-OCR-08](https://github.com/rosscantrell/AI-Light-Prototype)) or hosted (WP-OCR-09, forthcoming).

## Install

Pre-development. Once v0.1.0 ships, install via:

1. **One-time setup** — `bash setup.sh` (installs `viktora-ocr-capture` via `pipx`)
2. Download `Viktora Threshold.dmg` from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
3. Drag `Viktora Threshold.app` to `/Applications`
4. Right-click → Open (one-time Gatekeeper bypass for unsigned v1)
5. 3-screen onboarding wizard → paste Apolla base URL + bearer token → first capture

See `PILOT-INSTALL.md` (forthcoming) for the canonical install guide.

## Architecture

```
                ┌─────────────────────────────────────────┐
                │  Viktora Threshold.app (Tauri bundle)   │
                │                                         │
   File picker  │  ┌──────────────┐    ┌───────────────┐  │
   Drag-drop  ──┼─→│ Webview (UI) │←──→│ Rust shell    │  │
   Screenshot   │  │ (HTML/CSS/JS)│IPC │ (reqwest HTTP)│  │
                │  └──────────────┘    └───────┬───────┘  │
                │                              │          │
                └──────────────────────────────┼──────────┘
                                               │
                                  POST /api/ingest-document
                                  (bearer auth, no Origin header
                                   → no CORS preflight needed)
                                               │
                                               ▼
                              Apolla schema-browser (local or hosted)
```

The Rust shell handles HTTP because Tauri's webview JS would trigger CORS preflight; Rust's `reqwest` doesn't set an `Origin` header so the request passes through the schema-browser's CORS middleware (which explicitly allows no-Origin requests).

## License

Apache 2.0 — see [LICENSE](LICENSE).
