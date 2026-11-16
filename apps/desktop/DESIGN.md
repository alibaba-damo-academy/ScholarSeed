<a id="scholarseed-desktop-设计开发指南"></a>
# ScholarSeed Desktop Design and Development Guide

## Scope / Non-goals

Public requirements, tokens, component contracts and the design-to-code map are maintained in this
checkout. Private design-platform access is optional; omitted raw evidence is not a development
prerequisite and must not be presented as publicly reproducible pixel-exact provenance.

This guide is for AI-assisted and human development of Desktop pages, panels, overlays, forms, and lists.
Use it first to understand the visual direction and locate the relevant design, then read the detailed
specifications. This page maintains the summary and navigation; the owning documents maintain
specific design parameters, component APIs, and implementation gaps.

## Source of truth

| Information to verify | Authoritative source |
| --- | --- |
| Information to confirm | Authoritative source |
| --- | --- |
| Design source, layers, and states | [MasterGo evidence entry](docs/design/mastergo.md) and the corresponding layers |
| Colors, fonts, spacing, stacking, and themes | [Foundations specification](docs/design/foundations.md) and the source it references |
| Component reuse and ownership of new components | [Components specification](docs/design/components.md) |
| Keyboard, focus, overlays, and feedback | [Interaction specification](docs/design/interaction.md) |
| Gaps between current implementation and design | [Public design contract](docs/design/foundations.md); reread source during implementation |
| Actual component and token inventories | [Component inventory](docs/_generated/components.md), [token inventory](docs/_generated/tokens.md) |
| Page structure without a product design | [Vibe Coding page contract](docs/design/vibe-coding.md#业务无关的页面类型) |

Design links can be re-evidenced; screenshot paths on the collection machine are not guaranteed to be
accessible to other developers. Historical source mappings are dated evidence and must not be treated
as facts about the current version without verification.

## Current / Required / Gap / Advisory

- **current**: Design reports show warm backgrounds and surfaces, deep-green brand actions, and layered neutral text; the existing implementation uses `--vds-*` and `components/ui`.
- **required**: Choose existing tokens based on the specific layer, state, and semantics. Exact values and differences are in the foundations specification. Keep design attributes, screenshot observations, code facts, and implementation recommendations distinct.
- **gap**: Evidence is still missing for candidate-version decisions, some internal component parameters, dark mode, and narrow-window states. Completing design analysis does not mean visual reconstruction is complete.
- **advisory**: Distinguish work areas with backgrounds and surfaces, and emphasize primary actions with the brand color. Organize headings, body copy, and supporting information using the existing text hierarchy; confirm use cases against evidence for each design.

<a id="视觉与布局要点"></a>
### Visual and Layout Considerations

- Check font family, size, and line height separately; a design font appearing in the fallback list does not prove that actual rendering matches.
- Compose the workbench from the design's navigation, materials, editing, and AI areas; a fixed artboard size does not directly define responsive behavior for every window.
- In login scenarios, distinguish the operating system's display background, the actual Desktop window, and the external authentication webpage.
- Desktop layout acceptance follows the [window-size boundaries](docs/design/vibe-coding.md#desktop-窗口布局边界), using the default and minimum window contract in `src/window.ts`; do not require phone-like viewports below the native minimum.
- The same name may refer to different onboarding steps, menu states, or candidate versions; locate them by layer ID.
- Corner radii, shadows, masks, and control sizes vary between designs; do not infer that every parameter matches just because components share a name.

<a id="页面定位"></a>
### Locating a Page

For a new page without a corresponding product design, first select a page type using the
[Vibe Coding page contract](docs/design/vibe-coding.md#业务无关的页面类型), then adjust its slots
based on real design evidence. Page types provide extensible default structures and do not replace
design-by-design reconstruction. Keep unknown states, dark-mode behavior, and narrow-window behavior
marked as `gap` and add evidence in the acceptance record.

| Development area | Per-design report | Verify first |
| --- | --- | --- |
| Login and account entry | Authentication (non-public execution/provenance record omitted) | Desktop/external webpage boundary, login state, and return navigation |
| Project overview and first use | Projects (non-public execution/provenance record omitted) | Empty state, project switching, onboarding steps, and candidate designs |
| Materials and workbench | Materials (non-public execution/provenance record omitted) | Columns, collapsed panels, menus, and permission entry points |
| Literature library | Literature (non-public execution/provenance record omitted) | Standard, multi-select, details, and action integration |
| Settings | Settings (non-public execution/provenance record omitted) | Actual entry points for model candidates, accounts, and notifications |
| Global search | Search (non-public execution/provenance record omitted) | Recently opened items, results with a query, and keyboard behavior |

Consult the [Public design contract](docs/design/foundations.md) for the source code, component
candidates, and gaps associated with each report. Read the supporting components and reference-image
categories only when you need to inspect component examples or image sources.

<a id="codex-默认对齐清单"></a>
### Codex Default Alignment Checklist

When a development request does not include a complete product design, Codex establishes an auditable
default plan in the following order:

1. **Inventory evidence**: Read the current page source, host scroll boundaries, `design-map`, and available MasterGo layers; mark sizes, states, dark mode, or narrow-window behavior without real evidence as `gap` or “inferred.”
2. **Choose a skeleton**: Select a composition type from the [Vibe Coding page contract](docs/design/vibe-coding.md#业务无关的页面类型), prefer `Page`, `PageHeader`, `PageBody`, and `PageSection`, and do not create product-bound page templates.
3. **Find components**: First run `npm run ui-find Q="<意图>"` or use `ui-component-reuse`; reuse components through the `components/ui` barrel. If a capability is missing, extend it under its owner and update the registry, examples, and tests.
4. **Implement the visual design**: Use `--vds-*` tokens or component props for spacing, fonts, colors, corner radii, shadows, and stacking. Choose stacking from semantic tokens in `design/zindex.css`; change gates verify that tokens actually exist. Pages must not add theme aliases, bare numeric z-index values, fixed visual values, or a second scroll container.
5. **Verify and record**: Run applicable `docs:check`, `npm test`, and `typecheck` checks, and verify screenshots and interactions through the real Desktop/dev:web flow. Update the design-map and MasterGo ledger, recording passes, baseline failures, and unresolved gaps separately.

This checklist is a development entry point and does not replace domain specifications; parameters,
component behavior, and acceptance boundaries remain governed by their respective sources of truth.

<a id="页面迁移状态"></a>
### Page Migration Status

Settings no longer provides a standalone MCP server page; server management is available under
“Extensions → Connectors.” The underlying MCP configuration and existing user data remain unchanged.

| Page | Current skeleton | Next | Evidence status |
| --- | --- | --- | --- |
| Notifications | `Page` + `PageHeader` | Add keyboard and narrow-window regression coverage item by item | Desktop light/dark screenshots inspected |
| AI prompts | `Page` + `PageHeader` + `PageSection` | Keep regression coverage for the real save/restore flow | Editing, saving, reload, and restore at 480px verified |
| About | `Page` + `PageHeader` + `PageBody` | Keep real regression coverage for version, external links, and onboarding actions | macOS wide-window and 480px screenshots inspected; see migration report for detailed comparison |
| Account | Historical `SettingsPageHeader` | Re-expose the user entry point, collect real state, then migrate | Currently absent from `NAV_ITEMS`; `visiblePage` falls back to Notifications, which is a gap |
| Skills | `Page` + `PageHeader` + `PageBody` + `Skills` | Add regression coverage for enable, install, delete, details dialog, narrow windows, and keyboard | Real macOS Desktop `settings-skills` screenshot inspected; layout is inferred |
| Workspace files | Full-screen product surface + `Spinner` / `EmptyState` + `Button` / `IconButton` | Add regression coverage for directory listing, file actions, context menu, narrow windows, and keyboard | Real macOS Desktop screenshots before and after the failure state inspected; layout is inferred |
| Conversation task progress | `Card` + `Collapsible` + `Badge` + `EllipsisText` | Add regression coverage for completion/failure, narrow windows, and keyboard | No corresponding MasterGo node; inline metadata width is inferred. Real runtime Desktop screenshot inspected, but no archivable harness file is available yet |
| Pre-run conversation checks | Conversation surface + `Button`; local readiness gate | Add regression coverage for blocking, opening Settings, narrow windows, and Windows | No corresponding MasterGo node; hierarchy is inferred from the current product flow, and no real Desktop screenshot of the blocked state has been captured yet |
| Project overview | Workbench shell + `HomeOverview` + `Button` / `IconButton` / `DropdownMenu`; project switching reuses `Popover` + `ProjectMenu`; project form uses `Dialog`, and removal confirmation reuses `AlertDialog` | Add hover, empty-state, create/edit/remove, narrow-window, and keyboard regression coverage | MasterGo `25:49064` covers the default/hover card. Real Desktop project-switch menu and Escape return to trigger inspected. No corresponding MasterGo node for the project form; nested confirmation hierarchy is inferred |
| File versions | `Page` + `PageHeader` + `PageBody` + `Card` | Add regression coverage for write operations and expanding complex policies | Real macOS Desktop before/after screenshots inspected |
| Model configuration | `Page` + `PageHeader` + `PageBody` + `Tabs` | Add regression coverage for model-configuration tabs, narrow windows, and keyboard | Real macOS Desktop before/after screenshots inspected |
| Developer | `Page` + `PageHeader` + `PageBody` + `PageSection` + `Card` | Add regression coverage for generation, rotation, revocation, and narrow windows | Real macOS Desktop before/after screenshots inspected; layout is inferred |

Migration status describes only the current code and evidence; it is not a visual acceptance
commitment for uncovered pages.

<a id="ownership--dependency"></a>
## Ownership / Dependency

Detailed rules belong in [docs/](docs/README.md); components and themes belong to their respective
source owners. This page does not maintain a second list of values. Renderer composition and
dependency boundaries are described in [renderer](docs/architecture/renderer.md) and
[ownership](docs/architecture/ownership.md).

<a id="开发顺序"></a>
### Development Sequence

1. Locate layers and states in the page index and design-map; if the target version is missing, retain the candidates and identify the open decision.
2. Read the corresponding screenshots, node properties, and per-design analysis. To collect fresh data, read the [MasterGo tooling guide](docs/design/tooling.md) and its skill entry point.
3. Use `ui-component-reuse` / `npm run ui-find Q="<意图>"` and read the existing component APIs and semantic tokens.
4. Re-read the current source and actual integration points; identify what is implemented, required, a gap, or advisory.
5. Implement according to existing component and product ownership; when a general capability is missing, identify its owner first and avoid copying components or themes into a page.
6. Use Tailwind and semantic tokens for new pages. For existing pages, fix only the related UI added or modified in this task; do not rewrite the whole page or expand into other owners. If a base component lacks a capability, extend it generally at the base layer; do not copy a replacement component.
7. Run the applicable deterministic checks and real product flow, inspect product screenshots, and update affected mappings and ledgers.

<a id="正反例"></a>
## Examples and anti-patterns

Good example: To align the Desktop login page, locate the client layer, reuse buttons and themes, and verify browser login and deep-link return; handle an external CAPTCHA webpage according to its owning system.

Bad example: Hard-code project counts, model examples, or points copy from a design as product constants; or treat opening an onboarding menu as proof that multi-step onboarding is implemented.

Page UI must continue to follow [AGENTS.md](AGENTS.md): consume components through the barrel, reuse `components/ui`, use semantic tokens, and do not hand-code equivalent native controls or SVG icons in a feature.

<a id="enforced-by"></a>
## Enforced by

This page is included in Desktop document registration and link checks. For specification maintenance, run `pnpm ops ci check docs desktop` and the checks required by the repository; for product changes, perform real-product verification according to the [testing specification](docs/quality/testing.md).

## Update triggers

Update this page when the visual direction or navigation changes; update specific parameters in their
owning detailed specifications, and generate component and token inventories from source. After a
design or code change, clear affected stages in the maintenance ledger, gather fresh evidence, and
review them. Records of this round's execution and review are in the historical archive and do not
represent the latest implementation status.

## Stop condition

Once the target layer, owning specification, and implementation entry point are located, proceed to
the detailed reading required for the task; there is no need to traverse every design or historical
execution record. Keep unavailable design states and incomplete product acceptance explicit; do not
invent them from a summary.

New CSS debt is constrained by the rule-identity gate in `scripts/ci/css.mjs`. Register third-party
exceptions precisely according to the [styling specification](docs/design/foundations.md); migrate
existing pages within the relevant UI scope, without requiring the entire page to be debt-free.
