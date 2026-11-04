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
| Native tools | Xcode Command Line Tools on macOS; build on the matching native OS and architecture |

The desktop commands download the pinned Python runtime and prepare `.venv`; you do not need to install Python separately for this setup. Runtime assets are downloaded from the reviewed HTTPS URLs in the manifests, verified by size and SHA-256, and cached locally. Git LFS is not required. The first setup needs internet access for JavaScript/Python dependencies and runtime assets.

### macOS

Homebrew is not required. Install Apple's Command Line Tools and complete the system installation dialog before continuing:

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

Use a Windows x64 machine and PowerShell. Install Git, [Node.js 24.16.0](https://nodejs.org/download/release/v24.16.0/), and [uv](https://docs.astral.sh/uv/getting-started/installation/) using their Windows installers/instructions. Open a new PowerShell window and confirm `git --version`, `node --version`, `npm --version`, and `uv --version`. The native build entry prepares its manifest-pinned build dependencies; macOS commands such as `xcode-select` and the shell installer above do not apply on Windows.

## Install and Run

In a writable local directory, run:

```bash
git clone https://github.com/alibaba-damo-academy/ScholarSeed.git
cd ScholarSeed
npx --yes pnpm@12.14.0 install --frozen-lockfile
npx --yes pnpm@12.14.0 ops dev
```

Run subsequent commands from the repository root. Allow the first installation/startup to finish downloading dependencies. Keep the terminal running while using the application; press Ctrl+C there to stop it. Configure your model connection in Settings or sign in to ScholarSeed. Literature services and model calls require the corresponding access permissions.

If you already have pnpm 12.14.0, you can replace `npx --yes pnpm@12.14.0` with `pnpm` throughout this guide. Do not replace the pinned version with whichever version Homebrew or Corepack selects.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `ERR_PNPM_NO_LOCKFILE` | Confirm you are at the repository root and `pnpm-lock.yaml` is beside `package.json`. For an outdated clone, run `git pull --ff-only`, then retry the frozen install. Do not remove `--frozen-lockfile` to generate a replacement lock. |
| `pnpm ... expected 12.14.0` | Use the explicit `npx --yes pnpm@12.14.0 ...` commands above instead of the globally installed pnpm. |
| `node: command not found` / wrong Node version | Finish installing Node 24.16.0, reopen the terminal, and check PATH or your version manager. |
| `uv: command not found` | Add uv's installation directory to PATH and verify `uv --version` in the launch terminal. |
| Download failure | Check the failing URL in the log and your network/proxy access. Rerun the same command after restoring access; do not bypass checksum verification. |
| Build reports an environment is in use | Stop the development instance with Ctrl+C before packaging; do not delete an active process's lock. |

`SCHOLARSEED_ARTIFACT_CACHE` selects an alternative runtime-asset cache directory. `pnpm ops dev` enables DevTools and the copy-session-ID button by default; set `SCHOLARSEED_DEVTOOLS=0` to disable them. Do not delete user data or overwrite model credentials while troubleshooting.

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
