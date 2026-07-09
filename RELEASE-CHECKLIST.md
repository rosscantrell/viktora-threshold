# Release Checklist

Mechanical steps for cutting a Viktora Threshold release. This does **not**
pick the version number — that's a product decision made separately. Once a
number is chosen (`X.Y.Z`, semver), the bump itself is a one-line-each edit
in three files, plus a changelog heading rename and a git tag.

## Where the version lives

| File | Key | Current value |
|---|---|---|
| `src-tauri/tauri.conf.json` | top-level `"version"` | `0.10.2` |
| `src-tauri/Cargo.toml` | `[package]` → `version` | `0.10.2` |
| `package.json` | top-level `"version"` | `0.10.2` |

`tauri.conf.json` is the only one that drives the release. Tauri does not read
the version from `Cargo.toml` for the app bundle — `tauri.conf.json`'s
`version` is what `tauri-action` uses to name artifacts (e.g.
`Viktora Threshold_0.10.2_aarch64.dmg`) and what shows in the app's
About/metadata. `Cargo.toml`'s `version` is the Rust crate version.
`package.json`'s `version` drives **nothing** in the build — it was verified
during the v0.10.2 release that a stale `package.json` still ships the correct
bundle version. All three are kept identical **by convention only** (nothing
enforces it), so **edit all three by hand in the same commit** to keep them
from drifting apart.

## Steps, in order

1. **Decide the version number** (`X.Y.Z`). Not automated — a human call.
2. **Edit `src-tauri/tauri.conf.json`** — change the top-level `"version"`
   value to the new number.
3. **Edit `src-tauri/Cargo.toml`** — change `[package].version` to the same
   number.
4. **Edit `package.json`** — change the top-level `"version"` to the same
   number. (Cosmetic — drives nothing in the build — but keep it in sync so it
   doesn't read as stale.)
5. **Rename the changelog heading** in `CHANGELOG.md`: move the
   `## [Unreleased]` content under a new `## [X.Y.Z] - YYYY-MM-DD` heading,
   and leave a fresh empty `## [Unreleased]` above it for the next wave.
6. **Commit** the file changes together, e.g.
   `chore(release): bump to vX.Y.Z`.
7. **Tag** the commit: `git tag vX.Y.Z` (the leading `v` is required — the
   release workflow triggers only on tags matching `v*`; see
   `.github/workflows/release.yml`).
8. **Push the tag**: `git push origin vX.Y.Z`. This fires the `release`
   GitHub Actions workflow, which builds the macOS (Apple Silicon) and
   Windows (x86_64) bundles, signs/notarizes them per `SIGNING.md`, and
   attaches them to a **draft** GitHub Release.
9. **Review and publish** the draft release on GitHub. Pilots install from
   the published release page per `PILOT-INSTALL.md`.

## Sanity checks before tagging

- `tauri.conf.json`, `Cargo.toml`, and `package.json` versions match exactly.
- `CHANGELOG.md` has no leftover `## [Unreleased]` entries that should have
  moved under the new version heading.
- The tag doesn't already exist (`git tag -l vX.Y.Z` should be empty).
- You're tagging the commit you intend to ship (usually the tip of `main`
  after the version-bump commit lands).
