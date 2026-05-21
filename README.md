# Viktora Threshold

Mac + Windows desktop capture app for Apolla workspaces. Tauri (Rust shell + webview frontend); produces small `.app` (~7 MB on Mac) / `.msi` (~10 MB on Windows) bundles.

**Status:** v0.2.0 — native in-process OCR shipped on both platforms (Apple Vision on Mac via `objc2-vision`; `Windows.Media.Ocr` on Windows via the `windows` crate). Specs: [WP-OCR-12 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-12-Desktop-Capture-App-Brief-v1_2-FINAL.md) (original desktop-app scope) + [WP-OCR-13 v1.2-FINAL](https://github.com/rosscantrell/AI-Light-Prototype/blob/main/WP-OCR-13-Threshold-Cross-Platform-OCR-Brief-v1_2-FINAL.md) (cross-platform OCR).

## What it does

A single click-driven entry point for the most common ingestion gestures that don't fit existing Apolla capture surfaces:

1. **Select a file from disk** — plain-text formats (`.txt`, `.md`, `.vtt`, `.srt`, `.html`)
2. **Drag-and-drop** a file onto the window
3. **Capture Screen** — region-select screenshot OCR via native in-process bindings (Apple Vision on Mac; `Windows.Media.Ocr` on Windows). No external utility install required.

All three POST the resulting text to your Apolla workspace via the standard `/api/ingest-document` endpoint with bearer auth.

**Launch-on-demand UX:** open it when you need it, close the window when done. No menu bar, no Dock persistence, no background daemon.

## Pairs with

- An Apolla schema-browser deployment — either local-server ([WP-OCR-08](https://github.com/rosscantrell/AI-Light-Prototype)) or hosted (WP-OCR-09, forthcoming).
- [viktora-ocr-capture](https://github.com/rosscantrell/viktora-ocr-capture) — standalone Mac hotkey-driven OCR utility for power users who want a global-hotkey capture surface outside Threshold's click-driven flow. **No longer a runtime dependency** as of v0.2 (D-13-10); the two artifacts coexist for different use cases.

## Install

Pilot install (Mac or Windows):

1. Download `Viktora Threshold_<version>_aarch64.dmg` (Mac) or `Viktora Threshold_<version>_x64_en-US.msi` (Windows) from [Releases](https://github.com/rosscantrell/viktora-threshold/releases)
2. **Mac:** drag the `.app` to `/Applications`; right-click → Open (one-time Gatekeeper bypass for unsigned v0.2). **Windows:** double-click the `.msi`; SmartScreen → More info → Run anyway (signing tracked in FN-OCR-13-02)
3. Launch; the 3-screen onboarding wizard prompts for Apolla base URL + bearer token
4. First capture — Upload File, drag-drop, or Capture Screen

See [PILOT-INSTALL.md](PILOT-INSTALL.md) for the full guide including troubleshooting + known limitations.

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
