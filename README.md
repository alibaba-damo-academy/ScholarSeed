<div align="center">

# ScholarSeed

**Turn every reading session and insight into your next research step.**

**English** · [简体中文](README_zh.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x86__64-black)
![Windows](https://img.shields.io/badge/Windows-x86__64-0078D4)
![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F)
![Python](https://img.shields.io/badge/Python-FastAPI-3776AB)

[Why ScholarSeed](#why-scholarseed) · [From Papers to Progress](#from-papers-to-progress) · [Get Started](#get-started) · [Installation](#run-from-source) · [Development](#development) · [Community](#community-and-support)

</div>

ScholarSeed is a local-first AI research workbench built around your projects. It brings literature search, reading and annotation, AI discussions, and research writing into one place. Start with a paper or a question, then turn your materials and ideas into research outputs you can check, refine, and build on.

## Why ScholarSeed

- **One workbench for a continuous research process.** Find papers, read, take notes, discuss ideas with AI, and revise drafts in the same workspace. Organize materials around your project to spend less time switching tools and rebuilding context.
- **Traceable citations, evidence you can inspect.** View the sources and supporting passages behind AI responses, and return to the original text where a location is available. Keep reading, analysis, and writing connected to evidence you can check.
- **An AI partner that builds on your research context.** Bring papers, notes, project files, and past conversations into each discussion. Every reading session, follow-up question, and revision can become a starting point for the next step.
- **Local-first, with your research in your hands.** Store and manage research materials and outputs locally, and connect your own model service. When you use cloud models or online search, the configured services process the relevant requests.
- **Research Skills for reusable workflows.** Use Skills for literature discovery, review writing, and research idea exploration, or extend the workbench with workflows that fit how you work.

## From Papers to Progress

### Explore the Literature

Import local PDFs or papers from Zotero, or describe a research question and let AI help find and screen relevant work. Gather the papers worth reading into your research project.

![Literature search and screening in ScholarSeed](assets/literature-search-en.png)

### Capture Your Thinking

Highlight passages, annotate papers, and take notes as you read. Use AI to help understand methods, equations, and figures. Keep your questions and observations alongside the literature for later comparison and discussion.

![PDF reading with annotation and AI explanation tools](assets/reading-notes-en.png)

### Continue the Discussion

Bring papers, notes, and project files into the conversation. Compare methods, examine disagreements, and explore research ideas that are worth testing with the resources you have.

![Adding project files to an AI research discussion](assets/research-discussion-en.png)

### Check the Evidence

Follow citations in an answer to inspect its sources and supporting passages. Return to the original text to compare the AI's analysis with what the paper actually concludes, and form your own judgment.

![Tracing a citation from an AI response to the original paper](assets/citation-source-en.png)

### Turn Insights into Progress

Develop your research materials into a cited literature review, related-work section, or research report. Add evidence, refine the structure, and revise the wording. Save the result as a project file you can build on in your next round of research.

![A generated research review open alongside the AI task summary](assets/research-output-en.png)

## Get Started

After installing and launching ScholarSeed, configure your own model service or sign in to use services enabled for your ScholarSeed account.

1. Create a project and import a paper or a collection of research materials.
2. Choose a model and add the relevant materials to an AI conversation.
3. Describe your research question, check the citations in the response, and save your notes or generated draft.

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

`npm run dev` enables DevTools and the copy-session-ID button by default on macOS and Windows. Set `SCHOLARSEED_DEVTOOLS=0` to disable them.

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

Share bugs and feature requests through Issues, or contribute code, research Skills, documentation, and examples through pull requests.

When reporting a problem, include your operating system, application version, steps to reproduce, and expected behavior. For contributions, describe the problem you are solving and how you verified the change; include screenshots for interface changes.

If ScholarSeed helps your research, give it a star and share the research problems you would like it to help solve.

## License

ScholarSeed's original source code is licensed under the [Apache License 2.0](LICENSE).

Third-party software, assets, and bundled runtimes remain under their respective licenses. Their licenses are not replaced by Apache-2.0. Available notices include:

- [Desktop dependencies and corresponding source notices](apps/desktop/resources/notices/README.md)
- [Office viewer third-party notices](apps/desktop/src/renderer/public/office/THIRD_PARTY_NOTICES.md)
- [`paper-fulltext-dl` third-party notices](skills/community/precise-literature-search/vendor/THIRD_PARTY_NOTICES.md)
