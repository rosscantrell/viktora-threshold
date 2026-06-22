# Code Signing — Runbook & Reference

Tagged Threshold builds install **cleanly** on macOS and Windows:

- **macOS** — signed with an Apple **Developer ID** + **notarized** (app *and* DMG). Opens on a normal double-click; no "damaged / can't be opened", no `xattr` dance.
- **Windows** — installers **Authenticode-signed** via **Azure Trusted Signing** (a.k.a. Azure Artifact Signing), chaining to a Microsoft public-trust root. No SmartScreen "unrecognized app" wall.

It's all wired into `.github/workflows/release.yml`. Push a `v*` tag → the build signs + notarizes (macOS) and signs (Windows) automatically, and attaches the artifacts to a **draft** GitHub Release for you to review + publish.

**Publisher identity:** both certs are **individual** (Viktora AI isn't a registered legal entity yet), so the macOS signer and Windows publisher both read **"James Cantrell"** (Apple Team ID `UM4X982395`). When the business is registered, you can re-do both as **Organization** validation to rebrand the publisher to "Viktora" — see [Future: switch to Organization](#future-switch-to-organization).

Everything below is the **as-built** state, plus how to rotate/renew and the gotchas we hit (so you don't re-hit them).

---

## What's configured (GitHub → Settings → Secrets and variables → Actions)

**Secrets** (9):

| Secret | What | Notes |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID `.p12` | exported with `openssl ... -legacy` (see gotchas) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password | |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: James Cantrell (UM4X982395)` | |
| `APPLE_ID` | Apple account email | ross.cantrell@gmail.com |
| `APPLE_PASSWORD` | app-specific password (notarization) | `account.apple.com` → labeled "threshold notarize" |
| `APPLE_TEAM_ID` | `UM4X982395` | |
| `AZURE_CLIENT_ID` | app registration (client) ID | SP `viktora-threshold-signing` |
| `AZURE_CLIENT_SECRET` | app registration client secret | **rotate periodically** (24-mo expiry) |
| `AZURE_TENANT_ID` | personal directory tenant ID | |

**Variables** (3, non-secret):

| Variable | Value |
|---|---|
| `AZURE_ENDPOINT` | `https://eus.codesigning.azure.net` |
| `AZURE_ACCOUNT` | `viktora-signing` |
| `AZURE_PROFILE` | `viktora-threshold` |

When all are present, signing turns on automatically. When absent, that platform builds **unsigned-but-green** (graceful degrade — see end).

---

## macOS — how it was set up (Apple Developer ID + notarization)

1. **Apple Developer Program** (Individual enrollment, $99/yr). Team ID `UM4X982395`.
2. **Developer ID Application certificate.** Created via OpenSSL (this Mac had no Keychain Access app):
   ```bash
   # CSR + private key
   openssl req -new -newkey rsa:2048 -nodes -keyout developerID.key -out developerID.csr -subj "/CN=James Cantrell"
   # upload developerID.csr at developer.apple.com → Certificates → + → Developer ID Application (G2 Sub-CA) → download .cer
   # build the .p12 (note -legacy, see gotchas):
   openssl x509 -inform DER -in developerID_application.cer -out developerID.pem
   curl -s -o DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   openssl x509 -inform DER -in DeveloperIDG2CA.cer -out DeveloperIDG2CA.pem
   openssl pkcs12 -export -legacy -inkey developerID.key -in developerID.pem \
     -certfile DeveloperIDG2CA.pem -name "Developer ID Application: James Cantrell" -out developerID.p12
   # secrets:
   base64 -i developerID.p12 | pbcopy        # → APPLE_CERTIFICATE
   ```
3. **App-specific password** at `account.apple.com` → Sign-In and Security → App-Specific Passwords → `APPLE_PASSWORD`.
4. **Workflow:** `tauri-action` reads the `APPLE_*` env, signs the `.app` with hardened runtime + `src-tauri/entitlements.plist`, notarizes, and staples. A post-build step then **also notarizes + staples the `.dmg`** (tauri only does the `.app`; an un-notarized DMG still trips Gatekeeper on mount).

Apple cert expires **2031-06-19**. Back up `developerID.p12` + its password off-machine (it *is* the signing identity).

---

## Windows — how it was set up (Azure Trusted Signing)

1. **Azure subscription.** ⚠️ Must be a **personal / individual-billed** subscription — an org-billed subscription **cannot** do *Individual* identity validation (see gotchas). We used a personal Pay-As-You-Go sub (tenant = personal "Default Directory", subscription `37441897-2676-478d-8b8e-6c0d02b30f8c`).
2. **Register provider** `Microsoft.CodeSigning` on the subscription.
3. **Artifact Signing account** `viktora-signing` (East US, Basic ~$10/mo) → endpoint `https://eus.codesigning.azure.net`.
4. **Identity validation** — *Individual*, type *Public*. Requires the **Artifact Signing Identity Verifier** role on the account, then a **Face Check** in Microsoft Authenticator against a government photo ID. ⚠️ Use a **driver's license** (carries a home address) — a **passport fails** ("home address not provided").
5. **Certificate profile** `viktora-threshold`, type **Public Trust**, linked to the completed validation. Status must be **Active**.
6. **App registration** (service principal) `viktora-threshold-signing` → `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` + a client secret (`AZURE_CLIENT_SECRET`). Grant it the **Artifact Signing Certificate Profile Signer** role on the `viktora-signing` account.
7. **Workflow:** Microsoft's official **`azure/trusted-signing-action`** runs *after* the build, signing the NSIS `setup.exe` + MSI under the bundle dir, then re-uploading them over the release assets. SP creds are passed to the action **explicitly** (inputs + step env), not via job-env (see gotchas).

Resulting signature chain (verified): `CN=James Cantrell` → `Microsoft ID Verified Code Signing PCA 2021` → `Microsoft ID Verified CS EOC CA 03` → `Microsoft Identity Verification Root Certificate Authority 2020`.

---

## Verify a tagged build

### macOS — download the DMG to a clean path
```bash
spctl -a -vvv -t open --context context:primary-signature "Viktora Threshold_<ver>_aarch64.dmg"   # accepted / Notarized Developer ID
hdiutil attach "Viktora Threshold_<ver>_aarch64.dmg" -nobrowse
codesign -dvvv "/Volumes/Viktora Threshold/Viktora Threshold.app"   # TeamIdentifier=UM4X982395, flags=runtime
spctl -a -vvv -t exec "/Volumes/Viktora Threshold/Viktora Threshold.app"   # accepted / Notarized Developer ID
xcrun stapler validate "/Volumes/Viktora Threshold/Viktora Threshold.app"  # + validate the .dmg too
```
Pass = double-clicking the downloaded DMG mounts with no warning, and the app launches with no "damaged" dialog.

### Windows — on a Windows box (authoritative)
```powershell
signtool verify /pa /v ".\Viktora Threshold_<ver>_x64-setup.exe"   # Successfully verified
```
Pass = `signtool` verifies, Properties → Digital Signatures shows "James Cantrell", and a fresh download installs with no "Windows protected your PC" wall (a "verified publisher" UAC prompt is normal).

### Windows — quick signature check from macOS (no signtool)
Parse the PE Certificate Table and read the signer; confirms a signature is embedded and shows the chain:
```bash
python3 - <<'PY'
import struct
f=open("Viktora Threshold_<ver>_x64-setup.exe","rb").read()
pe=struct.unpack_from("<I",f,0x3C)[0]; opt=pe+24
magic=struct.unpack_from("<H",f,opt)[0]; ddir=opt+(112 if magic==0x20b else 96)
off,size=struct.unpack_from("<II",f,ddir+4*8)
open("sig.p7","wb").write(f[off+8:off+size]) if size else print("NO SIGNATURE")
PY
openssl pkcs7 -inform DER -in sig.p7 -print_certs -noout | grep -i subject=
```

---

## Rotating / renewing

- **Azure client secret** (`AZURE_CLIENT_SECRET`): App registrations → `viktora-threshold-signing` → Certificates & secrets → New client secret → copy the **Value** → update the GitHub secret → delete the old secret. (Default expiry 24 months; rotate before then, or immediately if it's ever exposed.)
- **Azure cert profile**: renews automatically while the account + identity validation stay valid.
- **Apple app-specific password**: regenerate at `account.apple.com` if revoked, update `APPLE_PASSWORD`.
- **Apple Developer ID cert**: expires 2031; renew via the same OpenSSL flow + re-base64 into `APPLE_CERTIFICATE`.

---

## Gotchas we hit (don't re-learn these)

- **OpenSSL 3 `.p12` won't import on macOS.** A `.p12` made by Homebrew OpenSSL 3 fails `security import` with *"MAC verification failed"* — macOS's `security` can't read its modern crypto. Export with **`-legacy`**.
- **Org-billed Azure subscription blocks Individual validation** (*"billing account does not indicate ownership by an individual"*). Use a **personal** subscription for individual validation.
- **Passport has no address** → individual validation fails on missing home address. Use a **driver's license / state ID**.
- **tauri's in-bundle `signCommand` swallows the signer's stderr.** Our first Windows approach (`trusted-signing-cli` via `signCommand`) failed with an opaque *"failed to run trusted-signing-cli"*. The official `azure/trusted-signing-action` (post-build) prints real errors — use it.
- **`DefaultAzureCredential` didn't pick up job-level env** in the action (*"EnvironmentCredential not fully configured"*) even with valid creds. Pass `azure-client-id/secret/tenant-id` **explicitly** as action inputs (+ step env).
- **Verify SP creds directly** when auth fails — a client-credentials token request isolates "bad secret" from "plumbing":
  ```bash
  curl -s -X POST "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
    -d "client_id=$AZURE_CLIENT_ID" -d "scope=https://management.azure.com/.default" \
    -d "grant_type=client_credentials" --data-urlencode "client_secret=<value>"
  ```

---

## Future: switch to Organization

Once **Viktora AI** is a registered legal entity, you can rebrand the publisher to "Viktora" on both platforms:
- **Windows:** new Trusted Signing **Organization** identity validation (needs the legal entity + Microsoft review, days) → new Public Trust cert profile → point `AZURE_PROFILE` at it.
- **macOS:** re-enroll the Apple Developer Program as an **Organization** (needs a D-U-N-S number) → new Developer ID cert → update the `APPLE_*` secrets.

Neither is required to ship; both are cosmetic (publisher name). The individual setup is fully functional.

---

## Graceful degrade

Every signing path is gated on its secret. No `APPLE_CERTIFICATE` ⇒ macOS builds ad-hoc/unsigned. No `AZURE_CLIENT_ID` ⇒ Windows builds unsigned. The build stays green either way; signing simply switches on when the secrets exist.
