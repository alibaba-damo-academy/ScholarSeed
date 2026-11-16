# Desktop Design Standards

This directory is the authoritative source for the local architecture and design rules of `apps/desktop`. The root [knowledge index](../../../docs/index.md) and [ownership guide](../../../docs/architecture/ownership.md) maintain cross-system boundaries and routes into this directory. Dynamic facts, such as component counts, token inventories, and debt statistics, are generated from source and must not be copied into manually maintained standards.

For day-to-day UI development, read [DESIGN.md](../DESIGN.md) first, then use the standards below for the page and task at hand. Consult the [component assets and reuse guide](design/assets.md) or search the [complete asset inventory](_generated/components.md) for usage.

## Routes

| Task | Required reading |
| --- | --- |
| MasterGo designs, per-frame layout and visual tracking, and implementation traceability | [Design evidence](design/mastergo.md), [public design contract](design/foundations.md) |
| Internationalization, multilingual copy, locales, and language switching | [Overview](architecture/i18n.md), [integration guide](architecture/localization.md), [verification standard](quality/testing.md); historical plans do not replace current source or acceptance evidence |
| Renderer features, shell, state, and composition | [Renderer](architecture/renderer.md), [ownership](architecture/ownership.md) |
| PDFE workbench design, scenarios, mock data, and future feature integration | [PDFE overview](architecture/PDFE.md), [runtime architecture](architecture/preview.md), [backend contract](work/preview-contracts.md); Electron is the display host, browser/headless modes are for testing, and full functionality and native acceptance still have gaps |
| Product, design, frontend roles, and Agent change scope for the PDFE workbench | [Roles and scope](work/pdfe.md); roles are task perspectives, not account permissions or separate product code |
| Shared examples, project spaces, and external dependencies for evaluation, automated testing, and PDFE | [Shared example design](../../../docs/architecture/examples.md), [shared example entry](../../../examples/README.md); common infrastructure and text preparation are wired up, runtime copies and criteria are isolated, and real acceptance and extension gaps are reported separately |
| Colors, spacing, typography, layers, and motion | [Foundations](design/foundations.md) |
| Component selection, new components, and reuse gates | [Components](design/components.md) |
| Dialogs, popovers, keyboard, focus, and feedback | [Interaction](design/interaction.md) |
| Vibe Coding page organization and shared layout contract | [Vibe Coding](design/vibe-coding.md) |
| Automated testing (owner A: logic units, API interfaces, and PDFE UI) | [Acceptance standard](quality/testing.md), [test architecture](architecture/testing-strategy.md), inventory and implementation plan (non-public execution/provenance record omitted); use programmatic drivers and assertions, reuse the PDFE mock API for UI state combinations, and retain native-specific and pre-migration E2E gates |
| LLM evaluation (owner B: real task flows and semantic review) | [LLM evaluation architecture](architecture/evaluation.md); combine real operations, independent review, and programmatic fact checks. Existing quick page reviews do not cover all model task evaluations, and permissions and budgets are not automatically expanded |
| Quick page review baselines | [Evaluation assets](../eval-scenarios/README.md); associate evidence with stable page requirement IDs and keep automated quick reviews separate from specialist manual reviews |
| Development startup, attach, Home initialization, and session acceptance prerequisites | [Development startup contract](../../../docs/runbooks/development.md#工具链与支持入口), [initialization prerequisites](../../../docs/runbooks/development.md#初始化-home-与-harness-前提); check argv, model authorization, and evidence for the actual entry point rather than inferring business success from healthz or scenario screenshots |
| Main, preload, IPC, and native host boundaries | [Ownership](architecture/ownership.md), [testing](quality/testing.md); check the narrow bridge and consumers for the actual host instead of treating the main-window preload as the sole bridge for every host |
| Installers, static dependency closure, and build results | [Build guide](../../../docs/runbooks/build.md), [testing](quality/testing.md); a real `package:check` on a clean commit is not replaced by a normal build or closure unit tests, and platform results need separate evidence |

Product operation: [Built-in browser and Playwright CDP](browser.md). Required for development: [Native web pages and product overlay design constraints](browser.md#原生网页与产品浮层开发设计约束), covering CSS layering limits, tooltip lifetimes, native mouse hit-testing tradeoffs, and regression paths.

## Status Terms and Strength

- `current`: a fact present in source with an identifiable reference.
- `required`: a standard new changes must meet; MUST indicates a hard requirement.
- `gap`: a known difference between the current implementation and the goal; do not describe it as an existing capability.
- `advisory`: recommended direction; SHOULD/MAY do not represent gates.

## Generated Inventories

- [Component inventory](_generated/components.md)
- [Token inventory](_generated/tokens.md)
- [Debt inventory](_generated/debt.md)

`pnpm ops ci check docs desktop --write` updates these inventories from source only. `pnpm ops ci check docs desktop` checks entry points, required sections, links, generated content, UI import and dependency boundaries, and the style ratchet. Generation does not change the baseline; baseline changes require separate review and may only tighten it. `registry.json` is the local documentation contract and does not duplicate root Wiki frontmatter.

## Update Principles

Keep architecture designs in `architecture/`. Place execution plans in `work/plan/` and link to the corresponding architecture design instead of creating a separate overall design in the plan.

Manually maintained standards describe enduring invariants, ownership, decision rationale, and gates. Dynamic inventories belong only in `_generated/`. Update the corresponding gate when rules change, and regenerate inventories when dynamic source facts change. Generated files carry a source and do-not-edit notice at the top.

## Design Documents and Evidence Archives

`DESIGN.md` maintains the visual direction summary, page index, and reading workflow; this directory maintains detailed rules and per-frame analysis. Do not define the same values in both places. MasterGo operation parameters are in the [tooling guide](design/tooling.md), which is needed only when fetching data or editing the canvas.

Commit long-term standards, per-frame reports, design indexes, and maintenance ledgers to Git. Retain original node snapshots as evidence of exact properties and missing information. Archive historical execution, review, and check records by date rather than treating them as the latest development status. Local screenshots and temporary logs are not shared dependencies; the ledger explains how to retrieve them again (non-public execution/provenance record omitted).
