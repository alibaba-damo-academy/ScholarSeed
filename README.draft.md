<p align="center">
  <a href="https://scholarseed.damo.alibaba.com/">
    <img src="assets/readme/brand/brand-mark.svg" alt="ScholarSeed" width="96">
  </a>
</p>
<p align="center">
  <a href="https://scholarseed.damo.alibaba.com/">
    <img src="assets/readme/brand/brand-wordmark.svg" alt="ScholarSeed 书深" width="260">
  </a>
</p>

<h2 align="center">Where your ideas, documents, and AI stay connected.</h3>
<p align="center">Search, read, ask, verify, and build,  with your own models, using your own skills and plugins, on your own machine.</p>
<p align="center">Keep your papers, notes, and conversations together as your research evolves.</p>

<p align="center">
  <b>PDF reader</b> · <b>Literature library</b> · <b>Evidence-linked answers</b> · <b>Research skills</b> · <b>Your models</b> · <b>Local-first</b>
</p>

<p align="center">
  <a href="https://scholarseed.damo.alibaba.com/"><img src="https://img.shields.io/badge/homepage-scholarseed.damo.alibaba.com-2f5744" alt="Homepage"></a>
  <a href="https://scholarseed.damo.alibaba.com/download.html"><img src="https://img.shields.io/badge/download-macOS%20%7C%20Windows-2f5744" alt="Download"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <a href="https://github.com/alibaba-damo-academy/ScholarSeed/releases"><img src="https://img.shields.io/github/v/release/alibaba-damo-academy/ScholarSeed" alt="Release"></a>
  <!-- TODO: add CI badge once a public workflow runs on main -->
  <!-- TODO: Linux badge when a Linux build ships -->
  <!-- TODO: community badge (Discord / WeChat / Slack) once one channel is chosen -->
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-scholarseed">Why</a> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#recipes">Recipes</a> ·
  <a href="#integrations">Integrations</a> ·
  <a href="#for-developers">For developers</a> ·
  <a href="README_zh.md">中文</a>
</p>

<!-- Hero animation. Until a screen recording exists, the two product GIFs from
     the homepage work as a hero pair. Swap for assets/readme/hero.gif
     (select a sentence → ask → citation opens the passage) when recorded. -->
<p align="center">
  <img src="assets/readme/brand/core-02-context-smaller.gif" alt="AI that builds on your project context" width="400">
</p>

---

## Why ScholarSeed?

Most "AI for research" tools are a chat box next to your real work. You paste in a PDF, get an answer, and lose track of where it came from. Next week you start over.

| The pain | What ScholarSeed does |
|---|---|
| "Research is scattered across applications." | Search, read, discuss, and write around the same research project. |
| "Each new task requires rebuilding context." | Keep papers, notes, conversations, and outputs organized so you can bring relevant materials into later tasks. |
| "Cannot always trust AI answers." | Follow source-linked citations and inspect supporting evidence. |
| "AI agents are difficult to control." | Use research workflows with review checkpoints, decision cards, and permission controls to guide the next step. |
| "I don't want my library and notes on someone else's server." | Store research materials and project data locally; external models, search, and connectors process the requests you send to them. |
| "Every researcher and lab works differently." | Encode your methods in Skills and customize interactions with plugins and connected tools. |

---

## Quick start

**1. Install** — grab the installer from **[scholarseed.damo.alibaba.com/download.html](https://scholarseed.damo.alibaba.com/download.html)** (macOS Apple silicon, macOS Intel, Windows x64)

**2. Connect a model** — Configure a model service in Settings → Models, or sign in to use services available to your ScholarSeed account.

**3. Add a paper or bring them from Bib/Ris/Zotero**.

**4. Read and ask** — Open the PDF, select a passage, and use **Explain** or **Translate**. Add relevant papers, notes, or project files to a conversation for broader questions.

**5. Inspect and save** — Follow citations to check supporting sources and passages where available. Save your notes or draft in the project for later work.

<!-- TODO: `scholarseed doctor` / "Copy diagnostics" command for bug reports.
     The CLI already has inspection modules (service/cli/inspection.py,
     desktop_inspection.py); expose one command and document it here. -->

---

## What it does

<!-- Grouped by what a researcher is trying to do, not by code module.
     Only list things that work today. Future items go in Roadmap. -->

### Read — Keep your thinking beside the paper

Read PDFs, highlight passages, and record questions and observations without leaving your research workspace.

- Navigate paper outlines and revisit annotations.
- Select passages for AI explanation or translation.
- Use AI assistance to examine methods, equations, and figures, then compare the explanation with the original paper.
- Keep notes and project materials available for follow-up discussions.

<p align="center">
  <img src="assets/readme/demos/ScholarSeed-Read.gif" alt="Read papers with AI assistance in the PDF reader" width="800">
</p>

### Find — Turn a research question into a reading list

Describe what you want to investigate, discover relevant literature, and decide which papers belong in your project.

- Use `agentic-search` for literature discovery and `precise-literature-search` for targeted retrieval and full-text workflows.
- Work with literature metadata from sources including OpenAlex and arXiv.
- Import local papers or connect Zotero, then organize materials around a research question.
- Review candidate papers and available evidence before moving into deeper analysis.

<p align="center">
  <img src="assets/readme/demos/ScholarSeed-Find.gif" alt="Find relevant papers with literature search" width="800">
</p>

### Verify — Know where AI answers come from

Follow citations back to sources and supporting passages, returning to the original text where a location is available.

- Compare an AI interpretation with what the source actually reports.
- Keep reported findings, your own interpretations, and open questions distinct in your notes and drafts.
- Use DamoATrace diagnostics to inspect recorded, product-visible events when debugging a task.

Citations help you inspect an answer; they do not establish that its claims are correct or fully supported. Research conclusions still require judgment against the original evidence.
<p align="center">
  <img src="assets/readme/demos/ScholarSeed-Verify.gif" alt="Verify AI answers against cited source passages" width="800">
</p>

### Write — Develop materials into research outputs

Turn selected literature and project context into a draft you can examine and revise.

- Use `literature-review` to develop a structured review with evidence processing and review checkpoints.
- Refine the scope, outline, supporting evidence, and wording.
- Produce Markdown or LaTeX/PDF through the review workflow; LaTeX compilation uses the bundled toolchain.
- Save outputs as project files and bring them into subsequent discussions.

<p align="center">
  <img src="assets/readme/demos/ScholarSeed-Write-Fast.gif" alt="Generate a literature review from selected papers" width="800">
</p>

### Extend — Turn your research methods into reusable AI workflows

Turn your methods into reusable workflows and add tools or interactions for your field.

- **Skills** describe research steps, required materials, decision points, and expected outputs.
- **Plugins** combine Skills with conversation cards for reviewing results and collecting decisions. Plugins are in **developer preview**.
- **MCP servers** connect external tools and services through the Model Context Protocol.
- **Runtime interfaces** provide a development route for adding agent engines. Codex is the currently included executable agent provider.

Bundled Skill sources include `agentic-search`, `precise-literature-search`, `literature-review`, `research-idea-partner`, `design-research-validation`, `pdf-evidence`, `project-literature`, `web-search`, `fast-search`, `find-skill`, and `plugin-create`. Browse the [Skill sources](https://github.com/alibaba-damo-academy/ScholarSeed/tree/main/skills/community) for their contracts and supporting tools.

<p align="center">
  <img src="assets/readme/demos/ScholarSeed-Extend.gif" alt="Extend research workflows with skills" width="800">
</p>

## Recipes

Start with a concrete question and review the evidence as you go. These examples use Skills present in the repository; outputs depend on the materials, model, and services available.

| Goal | Workflow | What to review |
| --- | --- | --- |
| Build a literature review | `agentic-search` → review candidates → `literature-review` | Paper selection, evidence coverage, outline, citations, and final draft |
| Understand a difficult paper | Import PDF → annotate → select-to-explain → `pdf-evidence` | Source passages, assumptions, methods, and limitations |
| Explore a research idea | `research-idea-partner` → targeted literature discovery | Related work, unresolved questions, and assumptions worth testing |
| Plan research validation | `design-research-validation` with your idea and project context | Validation criteria, alternative explanations, and evidence needed |

## Models and integrations

### Trust & local-first
- Local SQLite; projects are folders you own. Data lives in `~/.scholarseed` (override with `SCHOLARSEED_HOME`).
- Agents run in isolated homes with plugins, hooks and marketplaces disabled, MCP config projected explicitly, secrets passed by environment, binaries pinned by SHA-256.
- Native per-directory authorization (Windows job-object broker, macOS leases), notarized and Authenticode-signed builds.
- Every skill result that touches full text requires your explicit grant.

<p align="center">
  <img src="assets/readme/demos/ScholarSeed-Trust-Local.gif" alt="Research in a local project workspace with control over agent actions" width="800">
</p>

---

## Bring your own model

<!-- Counts from apps/serve/service/settings/capabilities.*.json on
     2026-11-07. Regenerate per release. Do not list individual model names
     that cannot be verified publicly. -->

| Provider | Models in catalog |
|---|---|
| Alibaba (Qwen) | 34 |
| OpenAI | 9 |
| Anthropic (Claude) | 6 |
| DeepSeek | 6 |
| Zhipu (GLM) | 6 |
| Moonshot (Kimi) | 5 |
| **Any OpenAI-compatible endpoint** | your `base_url` + API key (or a custom auth header) |

Switch models per conversation. Keys stay on your machine.

**Coming:** first-class presets for **Google Gemini** and for local models via **Ollama, vLLM and LM Studio**; and **Claude Code** as a second agent runtime next to Codex. See [Roadmap](#roadmap).

---

## Integrations

**Literature**

<p align="center">
  <a href="https://www.zotero.org" title="Zotero"><img src="assets/readme/logos/zotero.svg" width="40" alt="Zotero"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://arxiv.org" title="arXiv"><img src="assets/readme/logos/arxiv.svg" width="40" alt="arXiv"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://openalex.org" title="OpenAlex"><b>OpenAlex</b></a>&nbsp;&nbsp;&nbsp;
  <a href="https://elicit.com" title="Elicit"><b>Elicit</b></a>
</p>

**Code & docs**

<p align="center">
  <a href="https://github.com" title="GitHub"><img src="assets/readme/logos/github.svg" width="40" alt="GitHub"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://gitlab.com" title="GitLab"><img src="assets/readme/logos/gitlab.svg" width="40" alt="GitLab"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://huggingface.co" title="Hugging Face"><img src="assets/readme/logos/huggingface.svg" width="40" alt="Hugging Face"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://www.notion.so" title="Notion"><img src="assets/readme/logos/notion.svg" width="40" alt="Notion"></a>
</p>

**Web**

<p align="center">
  <a href="https://www.firecrawl.dev" title="Firecrawl"><b>Firecrawl</b></a>&nbsp;&nbsp;&nbsp;
  <a href="https://brave.com/search/api/" title="Brave Search"><img src="assets/readme/logos/brave.svg" width="40" alt="Brave Search"></a>
</p>

**Models — today**

<p align="center">
  <a href="https://www.alibabacloud.com/en/product/modelstudio" title="Alibaba Cloud Model Studio (Qwen)"><img src="assets/readme/logos/alibabacloud.svg" width="40" alt="Alibaba Cloud"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://platform.openai.com" title="OpenAI"><b>OpenAI</b></a>&nbsp;&nbsp;&nbsp;
  <a href="https://www.anthropic.com" title="Anthropic"><img src="assets/readme/logos/anthropic.svg" width="40" alt="Anthropic"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://www.deepseek.com" title="DeepSeek"><img src="assets/readme/logos/deepseek.svg" width="40" alt="DeepSeek"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://www.zhipuai.cn" title="Zhipu"><b>Zhipu</b></a>&nbsp;&nbsp;&nbsp;
  <a href="https://www.moonshot.cn" title="Moonshot (Kimi)"><img src="assets/readme/logos/kimi.svg" width="40" alt="Kimi"></a>
</p>

**Models & agents — coming**

<p align="center">
  <a href="https://claude.com/claude-code" title="Claude Code (agent runtime)"><img src="assets/readme/logos/claude.svg" width="40" alt="Claude Code"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://ai.google.dev" title="Google Gemini"><img src="assets/readme/logos/googlegemini.svg" width="40" alt="Google Gemini"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://ollama.com" title="Ollama"><img src="assets/readme/logos/ollama.svg" width="40" alt="Ollama"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://docs.vllm.ai" title="vLLM"><img src="assets/readme/logos/vllm.svg" width="40" alt="vLLM"></a>&nbsp;&nbsp;&nbsp;
  <a href="https://lmstudio.ai" title="LM Studio"><img src="assets/readme/logos/lmstudio.svg" width="40" alt="LM Studio"></a>
</p>

<!-- TODO: setup guides — Zotero (most requested), a custom MCP server, a
     custom / local model endpoint. Each ≤1 screen, with one "Pro tip". -->

---

## For developers

<!-- Developer proposition: "a foundation for AI research apps".  -->

ScholarSeed is a working research application you can extend rather than a framework you must assemble. PDF handling, the library, projects, model routing, sandboxing, citations, and the UI are already there.

### Build from source

Requires Git, **Node.js 24.16.0**, **pnpm 12.14.0**, **uv ≥ 0.12.11**, and your platform's native build tools. On macOS:

```bash
xcode-select --install
```

On Windows x64, follow the [Windows setup](CONTRIBUTING.md#windows); the build scripts fetch the pinned native compiler themselves.

```bash
git clone https://github.com/alibaba-damo-academy/ScholarSeed.git
cd ScholarSeed
pnpm ops pre   # pinned JS + Python deps, Office assets, bundled Skill pack
pnpm ops dev   # starts Electron
```

Run both on a fresh clone; afterwards `pnpm ops dev` alone, and rerun `pnpm ops pre` after dependency or Skill changes. The first run needs internet. No separate Python install or Git LFS is needed.

- Package a macOS DMG or Windows EXE: [Packaging](CONTRIBUTING.md#packaging).
- Rebuild the Skill pack: `pnpm ops cd build local --target skills`; check it against source: `pnpm ops ci check skills product --mode source`.
- Windows gotchas: [Electron download stalls](CONTRIBUTING.md#windows-download-diagnostics), [stale ACL policy outputs](CONTRIBUTING.md#windows-checkout-line-endings), [private build directory rejection](CONTRIBUTING.md#windows-private-build-directory).
- Optional env vars: [`.env.example`](.env.example). Never commit keys, tokens, session data or certificates.

### Architecture

```text
Electron / React
      │ HTTP + SSE
      ▼
ScholarSeed Serve (FastAPI)
      │ commands + events
      ▼
Runtime Gateway ──► Codex Adapter ──► Codex App Server (sandboxed)
      │
      └────────────► DamoATrace evidence recording
```

<!-- TODO: replace the ASCII diagram with assets/readme/architecture.svg; mark
     Skills, Plugins and MCP as the three extension points. -->
     
| Path | Responsibility |
| --- | --- |
| `apps/desktop/` | Electron + React desktop application |
| `apps/serve/` | FastAPI product backend and the `scholarseed` distribution |
| `packages/runtime/` | Runtime-neutral contracts, provider discovery, event-driven gateway |
| `packages/adapters/codex/` | Codex App Server process integration and protocol translation |
| `packages/damoatrace/` | Independent trace contracts, recording, storage, query, CLI |
| `packages/ui/` | React SDK for conversation cards (plugins) |
| `skills/community/` | Research skills compiled into the product |
| `tests/` | Cross-package contracts, integration, acceptance, release gates |


### Extension points

**Write a Skill** — a folder with `SKILL.md`. Encode your lab's method; the agent follows it inside the sandbox.

**Write a UI plugin** — a React card that renders in the conversation. The `window.plugin` bridge gives you `submit`, `save`, `request`, `onState`. Pack and validate offline with `python -m service.cli.plugins`.
<!-- TODO: link packages/ui/example and doc/plugins.md (currently Chinese; needs an
     English version); state SDK version + compatibility policy
     (packages/ui/contract.ts exposes `version` and `compatibility`). Say
     plainly: "SDK is pre-1.0; breaking changes are listed in CHANGELOG." -->

**Add a runtime** — the agent engine sits behind a typed contract (`packages/runtime`): sessions, events, permissions, sandbox, MCP, secrets, incidents. Providers are discovered through the `scholarseed_runtime.providers` entry point and enabled in `product.json`. The Codex adapter (`packages/adapters/codex`) is the reference implementation; a **Claude Code** adapter is planned.

**Observe everything** — `damoatrace` is a standalone trace CLI + web UI (SQLite FTS5 search, per-session digests, token/cost rollups, secret redaction) with no dependency on the agent.
<!-- TODO: finish the rename; the package still references damoagent and
     ~/.veda paths. Consider publishing it on PyPI on its own. -->

**What's under the hood**
- Electron 44 + React + Vite desktop; FastAPI backend on an embedded relocatable CPython 3.12; native C modules for leases, authorization and signing checks.
- ~3,000 test and contract files; bilingual eval scenarios with independent LLM judges and explicit `not_evaluated` / `inconclusive` verdicts.
<!-- TODO: make `pnpm test` / `uv run pytest` instructions public and
     accurate; link CONTRIBUTING.md; add 5–10 `good first issue` labels
     (new skill, new connector preset, UI card) -->

---

## Roadmap

<!-- Only promise what is scheduled. Mark each with a target quarter or
     "exploring". Move items up into "What it does" as they ship, with a
     🆕 tag and date for one release. -->

| Area | Status |
|---|---|
| **Skill Hub** — browse, audit, install community skills, scan verdict shown before install | **soon** |
| **Claude Code** as a second agent runtime | planned |
| **Google Gemini** provider preset | planned |
| **Local models** — Ollama, vLLM, LM Studio presets with model discovery (reachable today via an OpenAI-compatible `base_url`) | planned |
| LaTeX editor in the workbench with cite-from-library | planned |
| Linux build | exploring |

---

## Community & contributing

<!-- Pick ONE primary channel and repeat it here, in Quick start, and in the
     issue template. The homepage already shows a WeChat QR
     (assets/scholarseed-community-qr.png on the site); reuse it. -->

- <!-- TODO --> Chat: Discord / WeChat group link
- Issues: use *Copy diagnostics* <!-- TODO: once the command exists --> and paste the output.
- Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: <!-- TODO: label link -->.
- Built by Alibaba DAMO Academy, Decision Intelligence Lab.

### Built on

ScholarSeed stands on a lot of other people's work. Thank you to:

| Area | Projects |
|---|---|
| Agent runtime | [OpenAI Codex](https://github.com/openai/codex) App Server 0.165.0 · [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) |
| Literature | [Zotero](https://www.zotero.org) · [zotero-mcp](https://github.com/54yyyu/zotero-mcp) · [OpenAlex](https://openalex.org) · [arXiv](https://arxiv.org) · [Brave Search](https://brave.com/search/api/) |
| PDF & documents | [PDFium](https://pdfium.googlesource.com/pdfium/) via [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) · [pypdf](https://github.com/py-pdf/pypdf) · [pdfplumber](https://github.com/jsvine/pdfplumber) · [python-docx](https://github.com/python-openxml/python-docx) · [python-pptx](https://github.com/scanny/python-pptx) · [openpyxl](https://foss.heptapod.net/openpyxl/openpyxl) |
| Office preview | [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) · [ExcelJS](https://github.com/exceljs/exceljs) · [pptx-renderer](https://github.com/aiden0z/pptx-renderer) · [emf-converter](https://github.com/ChristopherVR/emf-converter) · Zeta Office engine (wasm) with [Fontconfig](https://www.freedesktop.org/wiki/Software/fontconfig/) and [FreeType](https://freetype.org) <!-- confirm the Zeta engine's upstream name and license before publishing --> |
| Writing | [TeX Live](https://tug.org/texlive/) 2026 · [Milkdown](https://milkdown.dev) · [CodeMirror](https://codemirror.net) |
| Desktop | [Electron](https://www.electronjs.org) 44 · [React](https://react.dev) · [Vite](https://vite.dev) / [electron-vite](https://electron-vite.org) · [electron-builder](https://www.electron.build) · [Velopack](https://velopack.io) (Windows updates) · [Tailwind CSS](https://tailwindcss.com) · [i18next](https://www.i18next.com) · [Playwright](https://playwright.dev) |
| Backend | [FastAPI](https://fastapi.tiangolo.com) · [python-build-standalone](https://github.com/astral-sh/python-build-standalone) CPython 3.12 · [uv](https://github.com/astral-sh/uv) · [DuckDB](https://duckdb.org) · [httpx](https://www.python-httpx.org) · [Pydantic](https://pydantic.dev) · [truststore](https://github.com/sethmlarson/truststore) |
| Tools shipped in the package | [ripgrep](https://github.com/BurntSushi/ripgrep) · [PowerShell](https://github.com/PowerShell/PowerShell) 7.6 (Windows) |
| Fonts | [IBM Plex Mono](https://github.com/IBM/plex) · [Newsreader](https://github.com/productiontype/Newsreader) · [Noto Serif SC](https://fonts.google.com/noto) |
| README logos | [Simple Icons](https://simpleicons.org) (CC0; marks remain their owners' trademarks) |

<details>
<summary><b>Troubleshooting</b></summary>

<!-- TODO: collapsed. Start with the three most common: Windows sandbox
     setup / VC++ redistributable (see PR #6), model key rejected, PDF
     fails to open. -->

</details>

<details>
<summary><b>Screenshots</b></summary>

<!-- TODO: 6–9 images, one per surface: Reader, Library, Project, Evidence
     panel, Skill center, Model settings, Trace viewer, Review output. -->

</details>

## License

Apache-2.0. See [LICENSE](LICENSE).
