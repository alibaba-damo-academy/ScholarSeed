# Reviewed python-build-standalone runtimes

`apps/desktop/scripts/cd/build.cjs` embeds a **relocatable CPython** into the
packaged ScholarSeed.app so the desktop backend runs off any machine (no dev repo /
`.venv`). That runtime comes from
[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone).

The archives are not stored in Git. `manifest.json` pins reviewed HTTPS download URLs,
byte lengths and SHA-256 values. `scripts/shared/artifacts.cjs` restores missing files
through a verified user-level cache before development setup or packaging.

The exact Python version, upstream release, SQLite engine and platform paths are
declared in `manifest.json`. `scripts/shared/python.cjs` validates that declaration and
the archive's SHA-256 for both development and packaging. Default `pnpm ops pre install python`
extracts the same archive to the ignored `.python/<sha256>/` cache and uses it as
the base of `.venv`; `pnpm ops pre doctor --scope interpreter` verifies the actual Python/SQLite and base
path. Stop processes using a venv before switching its base runtime.

## Layout

One archive per target triple, named **exactly** as the upstream release asset:

```
cpython-<series>.<patch>+<release>-<target-triple>-install_only.tar.gz
```

Currently reviewed:

| Platform      | Target triple            | Asset                                                             |
| ------------- | ------------------------ | ---------------------------------------------------------------- |
| macOS arm64   | `aarch64-apple-darwin`   | `cpython-3.14.10+20261026-aarch64-apple-darwin-install_only.tar.gz` |
| macOS x86_64  | `x86_64-apple-darwin`    | `cpython-3.14.10+20261026-x86_64-apple-darwin-install_only.tar.gz` |
| Windows x86_64 | `x86_64-pc-windows-msvc` | `cpython-3.14.10+20261026-x86_64-pc-windows-msvc-install_only.tar.gz` |

This upgrade candidate uses standard-GIL builds from the official GitHub release,
mirrored byte-for-byte under `oss://deep-rd/scholarseed-vendor/vendor/python-build-standalone/`.
All three manifest URLs were anonymously downloaded and verified against their frozen
byte lengths and SHA-256 values before switching to OSS. The manifest change is not native-platform acceptance
or release authorization. Python package metadata retains the separate `>=3.12`
library compatibility contract. See the [Chinese version](README_zh.md).

New targets add an entry to `manifest.json` with URL, byte length and SHA-256.
New Desktop targets also register their installer policy in `target.cjs`.

The manifest selects one exact archive per triple; missing or damaged assets fail
explicitly. There is no system-Python fallback.

## Refreshing / adding an archive

```bash
cd scripts/vendor/python-build-standalone
SERIES=3.14                          # Python minor series build.cjs pins
TRIPLE=aarch64-apple-darwin          # or x86_64-pc-windows-msvc, x86_64-apple-darwin, …

# 1. pick the release + asset (browse https://github.com/astral-sh/python-build-standalone/releases)
REL=20261026
ASSET="cpython-3.14.10+${REL}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${REL}/${ASSET/+/%2B}"

# 2. download and calculate the reviewed metadata
curl -fL --retry 3 "$URL" -o "$ASSET"
stat -f%z "$ASSET"
shasum -a 256 "$ASSET"

# 3. update manifest.json; do not commit the downloaded archive
```

Update `manifest.json` with the Python version, release and actual SQLite version,
and use the verified official HTTPS URL for local candidate work. If a vendor mirror
is required for release, obtain upload authorization, upload the byte-exact archive,
and anonymously verify its bytes before changing the URL. Do not point at a missing mirror.
Verify every affected native target. Packaging verifies the actual engine again in
the final App. `fetch-vendor.sh` is a legacy macOS upstream acquisition helper;
normal development and packaging use the manifest through `scripts/shared/artifacts.cjs`.
