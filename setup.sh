#!/bin/bash
# Viktora Threshold — one-time setup for pilots.
#
# Installs the viktora-ocr-capture utility globally via pipx so the bundled
# .app's subprocess can find it. Required because macOS GUI apps inherit a
# minimal launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin) that excludes
# ~/.local/bin, /opt/homebrew/bin, and /usr/local/bin — see WP-OCR-12 v1.2
# D-12-19 + AAR §6 Phase A primitive (f).
#
# Idempotent — safe to re-run.

set -e

echo "Viktora Threshold — setup.sh"
echo "──────────────────────────────"

# 1. Homebrew must be installed
if ! command -v brew >/dev/null 2>&1; then
    cat <<'EOF'
✗ Homebrew is required but not installed.

Install it from https://brew.sh, then re-run this script:

    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

EOF
    exit 1
fi
echo "✓ Homebrew found: $(brew --version | head -1)"

# 2. pipx (idempotent install)
if ! command -v pipx >/dev/null 2>&1; then
    echo "→ Installing pipx via Homebrew (one-time, ~30s)…"
    brew install pipx
else
    echo "✓ pipx found: $(pipx --version)"
fi

# 3. Make sure ~/.local/bin is on the user's PATH for future shells
pipx ensurepath >/dev/null

# 4. Install (or reinstall) viktora-ocr-capture from its public repo
echo "→ Installing viktora-ocr-capture from public repo…"
if pipx list 2>/dev/null | grep -q "ocr-capture"; then
    pipx upgrade ocr-capture \
        --pip-args "git+https://github.com/rosscantrell/viktora-ocr-capture.git" \
        2>/dev/null \
        || pipx install --force git+https://github.com/rosscantrell/viktora-ocr-capture.git
else
    pipx install git+https://github.com/rosscantrell/viktora-ocr-capture.git
fi

# 5. Verify the absolute path matches what Threshold's D-12-19 probe checks for
if [ -x "$HOME/.local/bin/ocr-capture" ]; then
    echo ""
    echo "✓ OCR utility installed at $HOME/.local/bin/ocr-capture"
    echo "  Version: $($HOME/.local/bin/ocr-capture --version 2>/dev/null || echo 'unknown')"
    echo ""
    cat <<'EOF'
You're set up. Next:

  1. Drag "Viktora Threshold.app" from the .dmg into /Applications
  2. Right-click "Viktora Threshold.app" → Open
     (macOS will warn that the app is unsigned; click Open in the dialog)
  3. Walk through the 3-screen wizard to connect to your Apolla workspace

See PILOT-INSTALL.md for the full guide.
EOF
else
    cat <<EOF
⚠ Install completed but the expected path doesn't exist:
    $HOME/.local/bin/ocr-capture

Check the pipx output above. If pipx installed to a different location,
report this so PILOT-INSTALL.md can document the alternate path.
EOF
    exit 1
fi
