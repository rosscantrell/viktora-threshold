# Code Signing — Setup Runbook

This is the operator runbook for making tagged Threshold builds install **cleanly**
on macOS and Windows — no "damaged / can't be opened" (macOS) and no SmartScreen
"unrecognized app" wall (Windows).

**The workflow is already wired.** `.github/workflows/release.yml` + `src-tauri/tauri.conf.json`
are done. Signing turns on automatically the moment the secrets/variables below
exist — you do **not** edit any code. Until then, tagged builds still succeed; they
just ship unsigned (the old Gatekeeper / SmartScreen ceremony in `PILOT-INSTALL.md`
applies).

- macOS work → **FN-OCR-13-03** (Apple Developer ID + notarization)
- Windows work → **FN-OCR-13-02** (Authenticode via Azure Trusted Signing)

Everything is added in **GitHub → repo → Settings → Secrets and variables → Actions**.
That page has two tabs: **Secrets** (encrypted, write-only) and **Variables**
(plain text, readable). Put each item on the tab named below.

---

## Part A — macOS (notarized DMG)

### A1. Accounts / artifacts to procure (one-time)

1. **Apple Developer Program** — enroll at <https://developer.apple.com/programs/> ($99/yr).
   Note your **Team ID** (10-char, e.g. `AB12CD34EF`) from
   <https://developer.apple.com/account> → Membership.
2. **Developer ID Application certificate** — in Xcode (Settings → Accounts →
   Manage Certificates → `+` → *Developer ID Application*) **or** at
   <https://developer.apple.com/account/resources/certificates> → `+` →
   *Developer ID Application*.
   - This is the only cert type whose apps run **outside** the App Store. Do **not**
     use "Apple Development" or "Mac App Distribution" — those won't open on pilots' Macs.
3. **Export it as a `.p12`** — open **Keychain Access** → *My Certificates* →
   right-click the "Developer ID Application: …" entry → **Export** → `.p12` → set a
   password (you'll paste this password as a secret). The export must include the
   **private key** (expand the cert with the ▸ disclosure triangle and confirm a key
   is nested under it before exporting).
4. **App-specific password for notarization** — at <https://account.apple.com> →
   Sign-In and Security → App-Specific Passwords → generate one (label it "threshold
   notarize"). This is **not** your normal Apple password. Format looks like
   `abcd-efgh-ijkl-mnop`.

### A2. Convert the `.p12` to base64

GitHub secrets are text, so the binary `.p12` must be base64-encoded:

```bash
base64 -i /path/to/DeveloperID_Application.p12 | pbcopy   # now on your clipboard
```

### A3. Secrets to add (Settings → … → Actions → **Secrets** tab → *New repository secret*)

| Secret name                  | Value                                                                                   |
|------------------------------|-----------------------------------------------------------------------------------------|
| `APPLE_CERTIFICATE`          | The base64 string from A2 (paste from clipboard)                                        |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` in A1.3                                   |
| `APPLE_SIGNING_IDENTITY`     | The full identity name, exactly: `Developer ID Application: Your Name (TEAMID)` †        |
| `APPLE_ID`                   | The Apple account email enrolled in the Developer Program                               |
| `APPLE_PASSWORD`             | The **app-specific** password from A1.4 (the `abcd-efgh-…` one, not your login password)|
| `APPLE_TEAM_ID`              | Your 10-char Team ID from A1.1                                                           |

† Get the exact string by running `security find-identity -v -p codesigning` on a
Mac that has the cert installed — copy the quoted name verbatim, including the
`(TEAMID)` suffix.

That's it for macOS. On the next `v*` tag, `tauri-action` imports the cert into a
temporary keychain, signs `Viktora Threshold.app` with the hardened runtime +
`src-tauri/entitlements.plist`, submits it to Apple notarization, waits, and staples
the ticket into the DMG — all automatically.

> **Notarization alternative (optional):** instead of `APPLE_ID` / `APPLE_PASSWORD` /
> `APPLE_TEAM_ID` you can use an App Store Connect API key
> (`APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`). The Apple-ID path
> above is simpler for a single signer; only switch if you hit 2FA friction. If you
> go this route, tell me and I'll add those three env vars to the build step.

---

## Part B — Windows (signed installer, no SmartScreen)

Recommended path: **Azure Trusted Signing** (~$10/mo) — modern, cloud-based, no
hardware token, and it earns SmartScreen trust without the per-download reputation
wait that plain OV certs suffer. The workflow signs the inner `.exe` **and** the
NSIS `setup.exe` / MSI via `trusted-signing-cli`.

### B1. Azure setup to procure (one-time)

1. **Azure subscription** — <https://portal.azure.com> (pay-as-you-go is fine).
2. **Trusted Signing account** — Portal → create resource → *Trusted Signing Account*.
   Note the **account name** and the **endpoint URI** for its region
   (e.g. `https://eus.codesigning.azure.net` for East US — the exact host is shown on
   the account's Overview page).
3. **Identity validation + Certificate Profile** — inside the Trusted Signing account:
   complete the one-time **identity validation** (individual or organization; org
   validation needs a D-U-N-S number and takes a few business days), then create a
   **Certificate Profile** (type *Public Trust*). Note the **profile name**.
4. **App registration (service principal)** for CI auth — Portal → *Microsoft Entra ID*
   → App registrations → New registration. Then:
   - Create a **client secret** (Certificates & secrets → New client secret) — copy the
     **Value** immediately (it's shown once).
   - Note the **Application (client) ID** and **Directory (tenant) ID** from Overview.
   - Grant this app the **Trusted Signing Certificate Profile Signer** role on the
     Trusted Signing account (account → Access control (IAM) → Add role assignment).

### B2. Secrets to add (Settings → … → Actions → **Secrets** tab)

| Secret name           | Value                                              |
|-----------------------|----------------------------------------------------|
| `AZURE_CLIENT_ID`     | App registration's Application (client) ID (B1.4)  |
| `AZURE_CLIENT_SECRET` | The client secret **Value** (B1.4)                 |
| `AZURE_TENANT_ID`     | Directory (tenant) ID (B1.4)                       |

> `AZURE_CLIENT_ID` is the on/off switch: its presence is what flips the Windows job
> from unsigned to signed. The three together are how `trusted-signing-cli`
> authenticates to Azure.

### B3. Variables to add (Settings → … → Actions → **Variables** tab → *New repository variable*)

These aren't secret (they appear in build logs), so they live on the Variables tab.

| Variable name    | Value                                                              |
|------------------|--------------------------------------------------------------------|
| `AZURE_ENDPOINT` | Your account's signing endpoint, e.g. `https://eus.codesigning.azure.net` (B1.2) |
| `AZURE_ACCOUNT`  | Trusted Signing **account name** (B1.2)                            |
| `AZURE_PROFILE`  | Certificate **profile name** (B1.3)                                |

The workflow assembles these into the `trusted-signing-cli` command at build time —
no source edit needed.

> **Don't have Azure / prefer a cert file?** Two alternatives, both a workflow tweak
> (ping me and I'll wire whichever you pick):
> - **EV or OV `.pfx` cert:** add `WINDOWS_CERTIFICATE` (base64) + `WINDOWS_CERTIFICATE_PASSWORD`
>   secrets and switch the bundle to `certificateThumbprint`/signtool. EV = instant
>   SmartScreen trust but needs a hardware token/HSM (awkward in CI). OV = cheaper but
>   SmartScreen reputation is earned over download volume.
> - **`azure/trusted-signing-action`** as a post-build step instead of `trusted-signing-cli`
>   (signs the installer artifacts but not the inner `.exe`; the in-bundle `signCommand`
>   path we chose is stronger).

---

## Part C — Verify on a test tag

After the secrets/variables are in, cut a throwaway tag and confirm the artifacts are
genuinely signed. (The release is created as a **draft** — delete it + the tag when done.)

```bash
git tag v0.8.1-signtest && git push origin v0.8.1-signtest
```

Watch the run in **Actions**. Both the macOS and Windows logs should show signing
activity (macOS: "Signing … / Notarizing"; Windows: the "Configure Windows signing
overlay" step prints `Azure Trusted Signing configured …` and `trusted-signing-cli`
runs during bundling).

### macOS — download the DMG to a clean path and verify

```bash
# Simulate a real download (adds the com.apple.quarantine attribute):
cd ~/Downloads && curl -L -O "<DMG asset URL from the draft release>"

# Gatekeeper assessment — must say "accepted" + "Notarized Developer ID":
spctl -a -vvv -t install "Viktora Threshold_0.8.1-signtest_aarch64.dmg"

# Mount, then inspect the .app signature — TeamIdentifier must NOT be "not set":
codesign -dvvv "/Volumes/Viktora Threshold/Viktora Threshold.app"

# Confirm the notarization ticket is stapled (offline-verifiable):
xcrun stapler validate "/Volumes/Viktora Threshold/Viktora Threshold.app"
```

**Pass = ** double-clicking the mounted `.app` opens with **no** "damaged" dialog and
**no** `xattr` dance; `spctl` reports *accepted / source=Notarized Developer ID*;
`codesign` shows a real `TeamIdentifier=<your team id>` and `Authority=Developer ID
Application: …`; `stapler validate` reports *The validate action worked*.

### Windows — verify on a fresh download (run on a Windows box)

```powershell
# signtool ships with the Windows SDK; verify the installer chains to a trusted root:
signtool verify /pa /v ".\Viktora Threshold_0.8.1-signtest_x64-setup.exe"

# And the inner executable after install:
signtool verify /pa /v "C:\Program Files\Viktora Threshold\Viktora Threshold.exe"
```

**Pass = ** `signtool verify` reports *Successfully verified*; the file's
Properties → **Digital Signatures** tab shows your identity; and double-clicking the
freshly-downloaded `setup.exe` installs **without** the "Windows protected your PC"
blue wall (a brief "publisher verified" UAC prompt is normal and expected).

### Clean up the test

```bash
git push --delete origin v0.8.1-signtest && git tag -d v0.8.1-signtest
# then delete the draft release in the GitHub Releases UI
```

---

## How the graceful-degrade works (so nothing breaks before secrets exist)

- **macOS:** `tauri-action` only sets up signing when `APPLE_CERTIFICATE` is non-empty;
  otherwise it ad-hoc-signs (unsigned). All Apple env vars empty ⇒ normal unsigned build.
- **Windows:** the signing steps are gated on `AZURE_CLIENT_ID != ''`. No secret ⇒ the
  `signCommand` overlay is never generated and `trusted-signing-cli` is never installed ⇒
  normal unsigned build.
- `src-tauri/entitlements.plist` is referenced unconditionally but is inert during an
  unsigned/ad-hoc codesign, so it never causes a failure.

This is why the deliverable is "ready" and the only remaining work is pasting the
secrets above.
