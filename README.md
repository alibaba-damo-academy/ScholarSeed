<div align="center">

# ScholarSeed

**A local desktop Agent platform for scientific research and R&D.**

[English](README.md) · [简体中文](README_zh.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x86__64-black)
![Windows](https://img.shields.io/badge/Windows-x86__64-0078D4)
![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F)
![Python](https://img.shields.io/badge/Python-FastAPI-3776AB)

</div>

ScholarSeed is a local-first desktop Agent application for research and engineering workflows. It combines an Electron desktop experience with a Python service, a runtime-neutral Agent contract, pluggable runtime adapters, research skills, and auditable execution traces.

## Features

<!-- Product team: add the approved core feature list here. -->

## Screenshots

<!-- Product team: add approved product screenshots here. -->

## Architecture

ScholarSeed is a monorepo. The root `pyproject.toml` coordinates an uv workspace; each application and package owns its source, dependencies, and distribution boundary.

```text
Electron / React
      │ HTTP + SSE
      ▼
ScholarSeed Serve
      │ commands + events
      ▼
Runtime Gateway ──► Codex Adapter ──► Codex App Server
      │
      └────────────► DamoATrace evidence recording
```

| Path | Responsibility |
| --- | --- |
| `apps/desktop/` | Electron + React desktop application |
| `apps/serve/` | FastAPI product backend and the `scholarseed` distribution |
| `packages/runtime/` | Runtime-neutral contracts, provider discovery, and the event-driven gateway |
| `packages/adapters/codex/` | Codex App Server process integration and native protocol translation |
| `packages/adapters/dsh/` | Reserved DeepSeek Harness adapter boundary; no provider is implemented yet |
| `packages/damoatrace/` | Independent trace contracts, recording, storage, query, and CLI |
| `skills/community/` | Research skills compiled into the product |
| `tests/` | Cross-package contracts, integration tests, acceptance tests, and release gates |

The executable Agent provider currently included by ScholarSeed is Codex. Runtime discovers providers through the `scholarseed_runtime.providers` entry point; product enablement is controlled by `product.json`. The removed proprietary Harness and the historical `damoagent` namespace are not part of this repository.

## Requirements

- Git and Git LFS
- Node.js `24.16.0`
- npm `11.13.0`
- Python `3.12+`
- uv `0.12.11+`
- Native build tools for the target platform

Installers are built natively for macOS arm64, macOS x86_64, or Windows x86_64. Cross-platform packaging is not supported.

## Run From Source

Clone the repository with Git rather than downloading a source archive so that Git LFS resources are available:

```bash
git clone <repository-url>
cd Scholarseed
git lfs install
git lfs pull
npm ci
npm run dev
```

`npm run dev` prepares the repository-pinned Python runtime and development environment before starting Electron. You normally do not need to install the workspace packages manually.

## Model and Service Configuration

ScholarSeed requires a model connection that you are authorized to use. Configure the provider endpoint, model name, and credential in the application settings. Local HTTP authentication and model authorization are separate concerns: a healthy local service does not imply that a model account is authorized.

Optional development and service variables are documented in [`.env.example`](.env.example). Do not commit API keys, access tokens, user configuration, session data, certificates, or private keys.

`UPLOAD_BASE_URL` enables the optional paper-card upload service. When it is not configured, ScholarSeed reports the missing configuration instead of connecting to an internal or historical endpoint.

## Local Data and Privacy

The default user data directory is `~/.scholarseed`. Set `SCHOLARSEED_HOME` to use a different location.

- User-level configuration, credentials, project registry, session catalog, and literature data are managed under `SCHOLARSEED_HOME`.
- Project-owned data is stored under `<project>/.scholarseed/` and travels with the project directory.
- Codex state is isolated under the ScholarSeed home unless an explicit source home is configured.
- DamoATrace records product-visible diagnostic events for debugging; it does not imply access to undisclosed executor internals.

Keep user data and credentials outside the repository. Review diagnostic bundles before sharing them.

## Development

Common repository commands are exposed from the root `package.json`:

```bash
# Build the desktop application
npm run build

# Run deterministic desktop tests
npm run desktop:test

# Check Python types
npm run python:typecheck

# Check formatting and import rules
npm run fmt-check

# Inspect the local toolchain and runtime
npm run doctor
```

`npm run check` runs static checks; it is not a substitute for real Electron, backend, model, and tool-flow acceptance.

## Packaging

Build installers on the matching native operating system:

```bash
# Build and verify an unpacked application without signing or an installer
npm run package:check

# Build a local development installer
npm run package

# Build a release installer; signing and notarization credentials come from CI
npm run package:dist
```

| Target | Native build host | Installer |
| --- | --- | --- |
| macOS arm64 | Apple Silicon macOS | DMG |
| macOS x86_64 | Intel macOS | DMG |
| Windows x86_64 | Windows x64 | NSIS EXE |

Release credentials must be supplied through protected CI variables or the local secure credential store. Certificates, private keys, notarization secrets, and internal upload addresses must never be committed.

## Community and Support

<!-- Product team: add approved community, issue tracker, and support links here. -->

## License

ScholarSeed's original source code is licensed under the [Apache License 2.0](LICENSE).

Third-party software, assets, and bundled runtimes remain under their respective licenses. Their licenses are not replaced by Apache-2.0. Available notices include:

- [Desktop dependencies and corresponding source notices](apps/desktop/resources/notices/README.md)
- [Office viewer third-party notices](apps/desktop/src/renderer/public/office/THIRD_PARTY_NOTICES.md)
- [`paper-fulltext-dl` third-party notices](skills/community/precise-literature-search/vendor/THIRD_PARTY_NOTICES.md)
