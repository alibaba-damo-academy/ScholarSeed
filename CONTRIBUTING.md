# ScholarSeed Development Guide

**English** · [中文](CONTRIBUTING_zh.md) · [Back to README](README.md)

This guide covers source setup, local development, troubleshooting, testing, and native packaging. For product features and model configuration, start with the [README](README.md).

## Environment Setup

| Tool | Requirement |
| --- | --- |
| Git | Available in your terminal; clone the repository rather than downloading a source ZIP |
| Node.js | **24.16.0**, including npm/npx |
| pnpm | **12.14.0**; the commands below invoke it with npx, so a global installation is optional |
| uv | **≥ 0.12.11**, available on PATH |
| Native tools | macOS: Xcode Command Line Tools or a working full Xcode toolchain; Windows x64: the scripts prepare the pinned LLVM-MinGW compiler |

The desktop commands download the pinned Python runtime and prepare `.venv`; you do not need to install Python separately for this setup. Runtime assets are downloaded from the reviewed HTTPS URLs in the manifests, verified by size and SHA-256, and cached locally. Git LFS is not required. The first setup needs internet access for JavaScript/Python dependencies and runtime assets.

### macOS

Homebrew is not required. Source startup compiles native modules as well as the frontend, so these tools are needed even when you are not building a DMG. Install [Apple's Command Line Tools](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/) and complete the system installation dialog before continuing; skip installation if a working Xcode toolchain is already available:

```bash
xcode-select --install
```

Install **Node.js 24.16.0** using the [official macOS installer](https://nodejs.org/download/release/v24.16.0/node-v24.16.0.pkg), then open a new terminal. An unversioned `brew install node` or `brew install pnpm` may select an incompatible version.

Install uv using its [official installer](https://docs.astral.sh/uv/getting-started/installation/):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

Confirm the tools in the same terminal you will use to launch ScholarSeed:

```bash
git --version
node --version
npm --version
uv --version
xcode-select -p
```

Node must report `v24.16.0`. If another version appears, select 24.16.0 in your version manager or correct PATH before continuing. Configure uv's installation directory on PATH for future terminals if the installer has not already done so.

### Windows

Use a Windows x64 machine and PowerShell. First install **Node.js 24.16.0** from the [official Windows x64 installer](https://nodejs.org/download/release/v24.16.0/node-v24.16.0-x64.msi), including npm and adding Node to PATH. Do not substitute the latest Node version.

Install Git and uv if they are not already available, using the commands documented by [Git for Windows](https://git-scm.com/install/windows) and [uv](https://docs.astral.sh/uv/getting-started/installation/#winget):

```powershell
winget install --id Git.Git -e --source winget
winget install --id astral-sh.uv -e --source winget
```

If WinGet is unavailable, use the Git installer and uv installation instructions linked above instead. Open a new PowerShell window after installing the tools, then check:

```powershell
git --version
node --version
npm.cmd --version
uv --version
npx.cmd --yes pnpm@12.14.0 --version
```

Node must report `v24.16.0`, uv must be at least `0.12.11`, and pnpm must report `12.14.0`. In the installation and development commands below, Windows users can use `npx.cmd` instead of `npx`; this avoids invoking PowerShell's `npx.ps1` wrapper and does not require changing the global execution policy.

The native build entry downloads and verifies its pinned LLVM-MinGW compiler and related inputs. You do not need to install Visual Studio or a separate compiler for these modules. Do not run `xcode-select` or the macOS shell installer on Windows. These are source-development prerequisites, not requirements for running a prebuilt installer; the instructions do not certify a clean Windows end-to-end run.

## Install and Run

In a writable local directory, run:

```bash
git clone https://github.com/alibaba-damo-academy/ScholarSeed.git
cd ScholarSeed
npx --yes pnpm@12.14.0 install --frozen-lockfile
npx --yes pnpm@12.14.0 ops pre install python --mode desktop
npx --yes pnpm@12.14.0 dev
```

Run subsequent commands from the repository root. Allow the first installation/startup to finish downloading dependencies. Keep the terminal running while using the application; press Ctrl+C there to stop it. Configure your model connection in Settings or sign in to ScholarSeed. Literature services and model calls require the corresponding access permissions.

The Python preparation step must precede the Skill build on a fresh clone. `dev` compiles `skills/community/` into the ignored runtime directory `apps/serve/service/capabilities/skills/`, then starts Electron. Skill sources are included in Git; the generated pack is not. Successful Electron startup alone does not prove the built-in Skills are available.

For later starts, `npx --yes pnpm@12.14.0 ops dev` is sufficient only when the pack already exists and Skill sources have not changed. After changing Skill sources or seeing a missing-Skill error, stop the current instance and run `npx --yes pnpm@12.14.0 dev` to rebuild before starting again.

If you already have pnpm 12.14.0, you can replace `npx --yes pnpm@12.14.0` with `pnpm` throughout this guide. Do not replace the pinned version with whichever version Homebrew or Corepack selects.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `ERR_PNPM_NO_LOCKFILE` | Confirm you are at the repository root and `pnpm-lock.yaml` is beside `package.json`. For an outdated clone, run `git pull --ff-only`, then retry the frozen install. Do not remove `--frozen-lockfile` to generate a replacement lock. |
| `pnpm ... expected 12.14.0` | Use the explicit `npx --yes pnpm@12.14.0 ...` commands above instead of the globally installed pnpm. |
| `node: command not found` / wrong Node version | Finish installing Node 24.16.0, reopen the terminal, and check PATH or your version manager. |
| `uv: command not found` | Add uv's installation directory to PATH and verify `uv --version` in the launch terminal. |
| Built-in Skill not found | Stop Electron, then rerun the Python preparation and `dev` commands above. Do not use `ops dev` alone on a fresh clone or manually copy user Skills into the bundled pack. |
| Download failure | Check the failing URL in the log and your network/proxy access. Rerun the same command after restoring access; do not bypass checksum verification. |
| Install stays at `scripts/pre/electron.cjs` / `Running...` | See [Windows download diagnostics](#windows-download-diagnostics). This stage downloads the Electron binary separately from npm packages. |
| `stale ACL policy outputs` on Windows | See [Windows checkout line endings](#windows-checkout-line-endings). Do not regenerate reviewed security outputs just to suppress this error. |
| `writable or replaceable private state ACL` during `native.compile` | See [Windows private build directory](#windows-private-build-directory). This is an actual filesystem permission rejection, not a line-ending mismatch. |
| Build reports an environment is in use | Stop the development instance with Ctrl+C before packaging; do not delete an active process's lock. |

`SCHOLARSEED_ARTIFACT_CACHE` selects an alternative runtime-asset cache directory. `pnpm ops dev` enables DevTools and the copy-session-ID button by default; set `SCHOLARSEED_DEVTOOLS=0` to disable them. Do not delete user data or overwrite model credentials while troubleshooting.

### Windows download diagnostics

`Packages ... done` does not mean installation has finished: the Electron postinstall downloads its platform binary, and pnpm may collapse the nested output. A GitHub clone timeout and an Electron release download timeout are separate network failures. Neither an npm `email` warning nor the optional Playwright Skill approval notice establishes the cause of a stalled download.

If the original installation is still running, stop that command with Ctrl+C before retrying. From the repository root in PowerShell, show the download URL and keep the log expanded:

```powershell
$env:DEBUG = '@electron/get*'
npx.cmd --yes pnpm@12.14.0 install --frozen-lockfile --reporter=append-only
```

Check access to the URL reported in the log using your approved network/proxy. If GitHub release downloads are unavailable and your organization permits the npm mirror, set the following in the same PowerShell session and retry the install command:

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
```

Changing the npm package registry alone does not change Electron's binary download URL. These environment settings affect this terminal and its child processes, not global configuration; a new PowerShell terminal starts without these temporary overrides. Keep the pinned pnpm version, lifecycle scripts and checksum verification enabled. After installation exits successfully, continue with the Python preparation and `dev` commands in this guide. The first `dev` also builds native modules and the frontend; inspect its stage output before assuming it has stalled.

### Windows checkout line endings

Reviewed ACL policy files and generated outputs are checked byte-for-byte. Older Windows checkouts with `core.autocrlf=true` can contain CRLF bytes where the reviewed receipt expects LF. The current `.gitattributes` pins these files to LF; do not disable `core.autocrlf` globally or remove the security check.

After saving any local work, update a clean checkout with `git pull --ff-only`, then inspect it:

```powershell
git ls-files --eol -- apps/desktop/native/security.json apps/desktop/native/security.outputs.json apps/desktop/native/security.h apps/desktop/updater/internal/security/evaluate.go apps/serve/service/platform/security.py packages/adapters/codex/scholarseed_codex/permissions.py scripts/shared/security.cjs
node apps/desktop/scripts/pre/security.cjs --check
```

The expected working-tree marker is `w/lf`. An existing checkout can retain `w/crlf` even after pulling the new attributes; restoring a file that Git considers unchanged is not guaranteed to rewrite its bytes. The least destructive recovery is to clone the latest repository into a **new, unused directory** and follow the setup steps there. Keep the old directory for local changes and recovery; do not copy its `node_modules`, `.venv` or generated security outputs into the new clone. If the check still fails with LF files, investigate the reported policy/output differences instead of regenerating the receipt or skipping verification.

### Windows private build directory

Native compilation requires a private directory with non-replaceable ancestors. If the error names `%TEMP%`, inspect its permissions in PowerShell:

```powershell
Get-Acl -LiteralPath $env:TEMP | Format-List Owner,AccessToString
```

Some development tools grant other accounts write access to the user temporary directory. Such a directory is unsuitable for private compiler state, even when the current user owns it. Do not remove another tool's ACL entries, run as administrator, or disable the permission check. Instead, stop the failed development command and select the existing native-build override in the same terminal:

```powershell
$env:SCHOLARSEED_NATIVE_BUILD_ROOT = Join-Path $HOME '.ss-debug\native-build'
npx.cmd --yes pnpm@12.14.0 dev
```

The build creates and protects a new directory, and still validates its owner, permissions and ancestors. This setting affects only the current terminal and its child processes; it does not change the system temporary directory or global ACLs. If the selected location is also rejected, retain the error and choose a genuinely private local location with your administrator rather than weakening the policy. This addresses native-build directory selection only, not model authentication or general application acceptance.

## Development and Testing

Inspect the local toolchain:

```bash
npx --yes pnpm@12.14.0 ops pre doctor
```

Build the desktop frontend without producing an installer:

```bash
npx --yes pnpm@12.14.0 ops cd build local --stage app
```

Run desktop tests and type checks after installing dependencies:

```bash
npx --yes pnpm@12.14.0 --dir apps/desktop test
npx --yes pnpm@12.14.0 --dir apps/desktop run typecheck
```

Select tests relevant to your changes and exercise the affected flow in the real application. A passing build or type check does not prove that model calls, login, or tools work. Real-model tests require your own authorized credentials and may incur charges.

Research skills live in `skills/community/`. Build them with `npx --yes pnpm@12.14.0 ops cd build local --target skills`. For the developer-preview plugin interfaces, see the [plugin guide](doc/plugins.md).

## Packaging

Stop the development instance first. Build a local development installer on the target machine:

```bash
npx --yes pnpm@12.14.0 ops cd build local
```

| Native host | Installer |
| --- | --- |
| Apple Silicon macOS | arm64 DMG |
| Intel macOS | x86_64 DMG |
| Windows x64 | x86_64 EXE |

Cross-platform packaging is not supported. Read the exact output paths and status from the build's `release-result.json` under `apps/desktop/release/`; do not mistake an old installer for the current result. Local development packages are not signed production releases.

To build and check an unpacked candidate without producing an installer or requiring release signing credentials, use a clean, committed checkout:

```bash
npx --yes pnpm@12.14.0 ops cd build release --stage dir --candidate
```

The production distribution entry is `npx --yes pnpm@12.14.0 ops cd build release --workflow distribution`. It requires release configuration and signing credentials; macOS production releases also require notarization. Supply secrets through protected CI variables or a secure credential store, never through committed files. Candidate checks and local packages do not replace native installer validation or authorize publication.

## Project Map

| Path | Responsibility |
| --- | --- |
| `apps/desktop/` | Electron desktop client and research workbench |
| `apps/serve/` | FastAPI local product service |
| `packages/runtime/` | Runtime contracts and Gateway |
| `packages/adapters/codex/` | Codex execution adapter |
| `packages/damoatrace/` | Execution tracing and debugging |
| `skills/community/` | Research skills and workflows |
| `scripts/` | Toolchain, configuration, and build scripts |
| `tests/` | Cross-package integration and acceptance tests |
| `product.json` | Product and runtime configuration |

## Contributing

Keep pull requests focused, explain the problem and approach, and state which checks and real user flows you exercised, including anything not verified. For bug reports, include the source commit, OS/architecture, tool versions, reproduction steps, and redacted error logs. Never include API keys, passwords, signing credentials, or private research data. Preserve the [Apache-2.0 license](LICENSE) and third-party notices when changing dependencies or bundled assets.
