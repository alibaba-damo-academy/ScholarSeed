<a id="视觉基础规范"></a>

# Visual Foundations

<a id="字重"></a>

## Font Weights

**required**: Except for Markdown rendered as conversation content, all text on pages and in their overlays uses only regular 400 (`--vds-fw-regular`) or medium 500 (`--vds-fw-medium`). Weights of 600 and above are prohibited.

**Required.** Except for Markdown rendered as conversation content, all text on pages and in
their overlays uses only regular 400 (`--vds-fw-regular`) or bold 500 (`--vds-fw-medium`).
Font weights of 600 or above are prohibited.

<a id="图表配色与文字"></a>

## Chart Colors and Text

**current**: Chart semantic tokens are owned by `design/theme.css`. `--vds-chart-series-1` through `--vds-chart-series-8` are used for categorical data in this order: sage green, ochre gold, terracotta, gray-blue, olive, rock brown, sandstone, and gray-purple. Heatmaps use the separate continuous scale `--vds-chart-heat-low/mid/high`; categorical colors do not encode numeric magnitude.
`Chart` reads theme tokens, and `Plot` reuses the same shell for all ten statistical chart types.

**required (2026-11-05 user reference image)**: Map the light-theme header to fill-4 and the content area to fill-2. Use text-tertiary, 12px, weight 400 for all content-area text, including axes, legends, hints, data tables, and descriptions.
Consume these semantics through `--vds-chart-header/surface/text/font-size/font-weight`; define concrete values only in design.
Provide mappings for light, dark, and system themes. Dark-theme colors are inferred.

## Scope / Non-goals

This document governs the use of color, typography, spacing, radius, shadow, layer, theme, and motion tokens. Do not maintain a manually updated inventory of dynamic variables and values in documentation.

## Source of truth

Effective values are defined in `src/renderer/src/design/*.css` and its entry point `design/index.css`; see [`../_generated/tokens.md`](../_generated/tokens.md) for the complete derived inventory. `tokens.ts` provides typed access for compatibility with legacy variables; it is not a second source of numeric values.

## Current / Required / Gap / Advisory

- **current**: The new design system uses `--vds-*`; `legacy.css` provides aliases for old variables.
- **required**: New visual styles MUST use existing semantic tokens. If a token is missing, add its semantics in the design owner rather than writing hex/rgb/hsl or fixed Tailwind colors in a feature.
- **required**: Lucide icons consume `--vds-icon-stroke-width` (1.5) through a shared Tailwind descendant utility on the application and component-example root containers. This does not affect non-Lucide SVGs; do not add local stroke widths for Lucide icons.
- **required**: z-index, duration, and size thresholds MUST come from named tokens/constants; “adjust until it covers the other element” is not a valid basis.
- **gap**: Some legacy variables remain defined in both root `styles.css` and `design/legacy.css`. This document records the overlap; it does not claim to have unified them.
- **advisory**: Dynamic geometry, document coordinates, progress, and user-provided colors MAY use inline styles, but SHOULD be passed through CSS custom properties with their source documented.

## Ownership / Dependency

`design/` owns tokens and themes; UI components consume tokens; features consume semantic variables and do not define global themes. Evaluate both light/dark themes and all component consumers when tokens change.

**current**: `design/plugin.css` for isolated conversation components only combines the shared theme, fonts, and Tailwind scanning entry point, and is compiled by `scripts/cd/components.cjs`. The Guest shell consumes utility classes and does not define a private global theme. This style entry point grants no host API, network, or same-origin access.

<a id="正反例"></a>

## Examples and anti-patterns

```tsx
// 正例：布局与视觉写在组件上，数值消费 token。
<div className="grid gap-[var(--vds-space-3)] text-[var(--vds-text-secondary)]" />
// 反例：为可用 Tailwind 表达的布局另建 .result CSS 规则。
```

## Enforced by

`scripts/ci/standards.mjs` applies per-file ratchets to fixed colors in consumer domains, fixed Tailwind colors, and visual inline styles; the generated token inventory is used to review duplicate definitions.

## Update triggers

Update the inventory and review this document when adding, removing, or renaming a token, theme entry point, legacy alias, z-index, or style policy.

## Stop condition

Once you find an existing semantic token, continue in the actual CSS. If a token is missing, first define its semantics and theme values in the design owner; do not invent a temporary value in a page.

<a id="mastergo-设计证据补充"></a>

## Additional MasterGo Design Evidence

Evidence dated 2026-09-09, source file 203335358980331/page5:43395; see [design entry point](mastergo.md) for original nodes and screenshots by design. The candidates below were checked by role. They do not rewrite current CSS or claim pixel-level parity at runtime.

| Design role and direct value | Existing current candidate | Required / gap |
| --- | --- | --- |
| Warm workbench background #FAF8F4 | --vds-bg-gray-default | Not equivalent to --vds-bg-page; choose by semantic role and the corresponding design |
| Web/Settings surface #FAF9F7 | --vds-bg-gray-light-default | Do not declare the old Landing `--auth-page-bg` duplicate equivalent |
| Settings navigation #F6F3EE | --vds-bg-component | Not a fixed template shared with the white profile shell |
| Primary text #272727, secondary #4C4C4C, muted #6D6D6D | --vds-text-primary/secondary/tertiary | Choose by the actual node role; do not substitute based on approximate color similarity |
| Divider #E8E8E8 / border #DFDFDF | --vds-divider-default / --vds-border-default | These differ; do not unify both under border-default |
| Brand #2C5545 | --vds-brand-6 / --vds-brand-bg-default | `brand-text-primary` is a different value; do not claim the colors match |
| Label 14px/20px/500 | body-lv2 size 14, medium 500 | body-lv2 line height is 22, so a difference remains; do not claim a complete match |
| Heading: Source Han Serif CN | --vds-font-serif fallback entry | Noto Serif SC is currently preferred; this does not prove the actual font is the same |
| Explicitly expanded button height 36 | New `control-height-standard=36`; retain old 28/32/40 | Button/Input/Select explicitly use `standard`; distinguish a component name such as L-36 from its actual height |
| Model overlays .2/.3, ordinary Settings .3 | Current `--vds-bg-mask` is .5 | Preserve per-design differences; do not infer one unified overlay from matching Settings names |

**required**: Shadows/fonts/colors inside images are raster content and must not be turned into product tokens; use expanded design nodes as evidence for exact values. Keep dark, hover/focus/error, and narrow-window behavior unknown when not shown.

**advisory**: The workbench's 320/700/420 columns, 48px top bar, and 56px activity rail may serve as comparison baselines for the corresponding 1440 design. Implement with existing responsive boundaries and themes; do not mechanically infer responsive behavior from exported absolute positioning or `overflow:hidden`.

<a id="页面样式tailwind-css-必须优先"></a>

## Page Styling: Prefer Tailwind CSS

- **required**: In owned pages, panels, and components, use Tailwind CSS for every style it can express. This includes layout, spacing, dimensions, typography, color, borders, shadows, responsive rules, pseudo-elements, and hover/focus/disabled/data/aria states. Use arbitrary variants/properties for complex selectors or nonstandard properties.
- **required**: Prefer existing UI props/variants. Reuse repeated combinations through static className constants or `cx` in the owning module. Do not add page CSS, CSS Modules, or CSS-in-JS, move page styles back into CSS with `@apply`, or dynamically concatenate Tailwind class fragments.
- **required**: Write selector CSS only when an adaptation must override a third-party library's internal DOM, such as Milkdown/Crepe or the PDF.js text layer. First use the library's theme/API/className capabilities; override only when they are insufficient. Keep overrides in the integration owner, scope them to a container, and comment with the library name, overridden behavior, and why the public API cannot provide it. Owned shells, toolbars, and buttons are not third-party overrides.
- **required**: `design/` still owns foundational declarations (CSS variables, Tailwind entry points, necessary font declarations, and shared keyframes for animations unavailable as built-ins). This does not authorize ordinary page selectors to remain in CSS. Preserve third-party distributed CSS/font assets from their original sources; do not mechanically translate vendor files. Migrate reset/typography rules that Preflight/component utilities can replace.
- **required**: Pass dynamic coordinates, scaling, dragging, and user data through existing geometry contracts or CSS custom properties for Tailwind to consume. Do not enumerate arbitrary runtime values just to generate classes. Themes must consistently use `--vds-*`; migration must not introduce fixed light colors.
- **gap**: Current gates check fixed colors, inline styles, component reuse, and dependency boundaries, but do not automatically prove that all migratable CSS has been migrated. Third-party exceptions and migration status still require source review and screenshots of real pages.

<a id="现有-css-的分类与迁移要求"></a>
### Existing CSS Categories and Migration Requirements

The following analysis is based on selectors and imports read on 2026-09-10; it does not claim that migration is complete. The scope is the Desktop renderer; styles for the static Wiki site are not application-page styles.

| File | Current responsibility | Requirement |
| --- | --- | --- |
| `styles.css` | Mixes legacy tokens, global element rules, component styles, and animations | Consolidate tokens in design; move owned layout/interactions to Tailwind and remove duplicate legacy definitions. |
| `shell/workbench.css` | Mixes workbench, conversation, project/literature pages, and internal Crepe overrides | Migrate owned areas to Tailwind; extract only necessary Crepe overrides to the editor integration owner. Do not exempt the entire file. |
| `features/literature/literature.css` | Lists, filters, details, sidebar, and overrides for owned UI | Migrate all owned-page styles; compressing them into a few long lines does not reduce the debt. |
| `features/workbench/image.css` | Owned image container, toolbar, and drag states | Replace all expressible styles with utilities; preserve the source of runtime scale/coordinate values. |
| `features/workbench/MonacoDocument.tsx` | Owned grid container and toolbar around Monaco | Already migrated to component Tailwind classes and the old editor.css removed; govern iframe/vendor internals separately. |
| `features/workbench/pdf/pdf.css` | Mixes owned toolbar/sidebar/annotations with PDF.js TextLayer | Move owned styles to Tailwind. Retain evidence-backed integration CSS for positioning, rotation, scaling, and selection behavior of the text layer generated by PDF.js. The owned annotation layer is not library-generated DOM. |
| `design/*.css` | Tokens, entry points, themes, animations, and legacy utility selectors | Keep necessary foundational declarations; migrate legacy utility selectors. Legacy aliases are transitional debt. |
| `Iconfont/download/` | Icon-font binary and vendor JSON mapping | IconFont reads glyphs from JSON, and Tailwind pseudo-elements display them; `design/typography.css` owns required font declarations. Legacy CSS and unused download demos were removed; the original export is traceable to 0165dcf13. Do not modify font binaries or the debt inventory. |

Historical infrastructure remediation does not mean that the business pages above have been migrated. Page owners should handle relevant UI only when adding or changing it; they are not required to rewrite an entire page. Determine actual remaining debt from current source, style gates, and real acceptance of the relevant pages; do not carry forward completion checks from old plans.

Migrate page by page: record existing light/dark screenshots and interaction states → move owned styles to the real component → remove corresponding CSS and stale imports → check third-party content and cascade → run deterministic checks and the real Desktop flow, then inspect screenshots. Do not merely delete CSS, reduce functionality, or substitute static screenshots for product acceptance.

<a id="基础组件-token-引用检查"></a>

## Foundational Component Token Reference Check

The update/restart destructive confirmation reuses `AlertDialog` through `components/business/UpdateAction.tsx` and covers the update notice and the Settings update entry. Its overlay and content consume `--vds-z-update-confirmation-overlay` and `--vds-z-update-confirmation` from `zindex.css`, placing them above the update notice and below installation loading. Business components do not calculate layers themselves. macOS and Windows share this renderer semantic, but real update and interruption-recovery flows still require separate acceptance on both platforms; deterministic DOM tests do not replace product evidence.

**current**: `pnpm ops ci check docs desktop` and standards tests check that static `var(--vds-*)` references in design and components/ui have declarations. They recognize CSS declarations, Tailwind-local custom properties, and runtime property names; explicit fallbacks may be undefined. New dangling references fail directly; the historical page-debt baseline is not changed.

**required**: A declared reference does not prove that scope or CSS value type is correct. Use `shadow-[var(--vds-focus-brand)]` for a focus shadow; a box-shadow string cannot be used as an outline color. Review state colors, typography, and shadows in the real component.

**gap**: This check verifies static symbol resolution but not dynamic concatenation, runtime cascade, or unit semantics. Existing style ratchets continue to govern business pages; this task does not require clearing all historical page debt.

<a id="基础-css-选择器门禁"></a>

## Foundational CSS Selector Gate

**current**: `scripts/shared/styles.cjs` owns Tailwind PostCSS scanning configuration.
The normal `postcss.config.cjs` scans only `src/renderer`; PDFE's `vite.preview.config.ts` explicitly selects a scan range that includes the development directory. Both use the same product `styles.css` and design tokens; runtime environment variables and test markers do not switch product behavior. Scan ranges use absolute `node:path` paths and do not depend on the command's working directory. Actual compilation has run on macOS; the corresponding host verification remains for Windows.
`scripts/shared/__tests__/styles.test.cjs` alternates compilation of normal/PDFE/normal styles to check that scan dependencies do not leak between configurations. Isolating build inputs does not equal acceptance of the complete release artifact or native product.

**current**: `docs:check` requires `design/*.css` to contain only root theme properties and shared keyframes; it prohibits `@apply` and selectors for owned components. `components/ui/` may not contain private CSS files. System dark mode continues to use `:root:not([data-theme]):not(.light)` and does not change manual-theme priority. Unused legacy reset/typography utility selectors have been removed.

**current**: The foundational-structure gate and the CSS rule-identity ratchet below jointly cover the renderer. Existing fixed colors in CSS remain constrained by the original per-file count ratchet.

<a id="css-规则身份与第三方覆盖门禁"></a>

## CSS Rule Identity and Third-Party Override Gate

**current**: Native browser scrollbars use low-specificity Tailwind descendant rules at the renderer entry point. Markdown overrides size and thumb geometry with Tailwind on the actual Crepe container; it does not mix with unlayered global CSS.
Native scrollbar size uses `--vds-native-scrollbar-size`; ScrollArea continues to use the existing `--vds-scrollbar-size`. These values are not changed to match each other. The thumb uses a background-color utility to avoid the background shorthand resetting background-clip; ordinary areas retain content-box, and Markdown retains padding-box. Both light and dark themes consume the same semantic color token.

**current**: `scripts/ci/css.mjs` is integrated into `docs:check` and the standards tests in `npm test`. It scans all renderer CSS; design is covered by the foundational-structure gate, and other files are constrained by rule identities in `scripts/ci/css.baseline.json`. Vendor-distributed font files are explicitly registered too; directories are not exempted wholesale. The initial inventory came from the development-branch baseline commit recorded in the file, not from the remediated working tree.

Rule identity includes the complete parent selector/@rule context, declaration order, properties and values, and the important flag; comments and formatting between declarations do not affect identity. Historical rules may be preserved unchanged or removed entirely. New files, selector replacements, declaration changes, and duplicated old rules cannot reuse historical allowances. When changing a historical rule, move the related owned UI to Tailwind; unrelated rules may remain, and a whole page need not be cleared at once. Formatting inside selectors may be detected as a change, so do not format unrelated business CSS.

**current**: A top-level `@import 'tailwindcss'` without a rule body (optionally with `source(none)`) and an `@source` in the same file that references scan paths are Tailwind build entry points, not hand-written styles. Other CSS imports, nested/directives with rule bodies, owned selectors, and `@apply` do not qualify. Positive and negative examples are covered by `scripts/ci/__tests__/standards.test.mjs`.

**required**: Register genuinely necessary overrides of third-party internals in the `overrides` array of `scripts/ci/css.exceptions.json`, with path, scope, selector, library, reason, and verification for each. `scope` must be a single class for the integration container; each selector must be a descendant within that container and match exactly. Whole-file and directory wildcards are not accepted. Explain in `reason` why the public theme/API is insufficient, and in `verification` give the real verification steps. New rules must use flat selectors; do not nest owned rules or use `@apply`. Updating library-distributed files is a vendor asset upgrade: review its source and diff separately and update the corresponding inventory. It is not an exception for owned CSS.

```json
{
  "path": "src/renderer/src/features/example/vendor.css",
  "scope": ".document-integration",
  "selector": ".document-integration .vendor-generated-text",
  "library": "enter the actual dependency name and version",
  "reason": "provide evidence about the actual internal DOM and why the public API is insufficient",
  "verification": "provide the real editor/document scenario, steps, and screenshot location"
}
```

The example above documents the schema; it does not authorize an exception. The current override list is empty, and existing mixed CSS is historical inventory. Do not change the baseline or broaden scope to make new violations pass; business pages are not migrated on the foundational branch. Historical allowances removed later should be tightened in a separate review. `docs:write` does not modify this inventory and provides no automatic rebuild command.

**gap**: Static checks cannot prove that a class was generated by a third party or automatically establish that the public API is insufficient, or that CSS value types, cascade, and visuals are correct. Check real source and screenshots for these. This gate covers CSS files; CSS-in-JS, dynamically generated class names, and similar cases still require source review and other applicable rules.

<a id="页面默认值与新增固定值"></a>

## Page Defaults and New Fixed Values

**current**: layout.css retains only the page padding, section/control spacing, and reading width actually consumed by Page compositions.
Unused workbench dimensions, overlays, controls, and shadow aliases were removed to avoid a second source of truth alongside theme.css/components.
See the [page contract](vibe-coding.md) for page-composition rules and the [new visual-value gate](visual-gate.md) for its check scope.
**gap**: Historical CSS/style-gate debt remains unresolved. Passing the new gate does not mean all historical layouts have been unified.

<a id="层级契约"></a>

## Layering Contract

`design/zindex.css` is the sole owner of renderer layer values. Pages and UI families consume only its `--vds-z-*` tokens; do not write `z-10`, `z-[97]`, `zIndex: 97`, or reuse a layer value from another family.

| Use | Token family | Constraint |
| --- | --- | --- |
| Decoration/hit target in the same local stacking context | `--vds-z-local-*` | Express sibling order only; do not use it to cover a portal or Dialog. |
| Persistent workbench panels, in-session scrolling controls, and in-session confirmation | `--vds-z-surface-panel`, `--vds-z-scroll-control`, `--vds-z-session-confirm` | Use only for sibling panels or feedback within the corresponding surface; do not replace cross-portal layering for Dialog/Popover. |
| Sheet, inline flyout, and Dialog | `--vds-z-sheet-*`, `--vds-z-inline-flyout`, `--vds-z-dialog-*` | Preserve the currently verified order across siblings. Nested dangerous confirmations use `--vds-z-dialog-nested-overlay` / `--vds-z-dialog-nested` above the parent Dialog; components must not promote themselves into a global top layer. |
| Action menu inside a drawer | `--vds-z-sheet-flyout` | Above Sheet content and below the Dialog overlay. Menus reuse the shared portal; forms and confirmation dialogs inside a drawer use DialogPortal / AlertDialogPortal to escape the host stacking context, without raising ordinary workbench menus. |
| Nested dialogs and dropdowns inside a global modal | `--vds-z-modal-nested-*` | Use the existing Dialog composition to preserve the parent window, focus, and dismissal return behavior. Nested dropdowns use `--vds-z-modal-nested-flyout` above nested content; raising only the container could leave its original portal obscured. Ordinary Sheets do not use this layer to escape the modal. |
| Host sticky headers and local state gates | `--vds-z-sticky-header`, `--vds-z-surface-gate` | Keep sticky headers below the resize handle. A surface gate blocks only its own workbench and must stay below global search/Settings surfaces. |
| Cross-portal menus, hints, overlays, notifications, and loading | `--vds-z-dropdown` and subsequent global layers | First confirm opening location, focus, and dismissal semantics, then select a family token. |

**current**: Foundational UI local layers, Sheet, inline overlays, and Dialog consume tokens. Toast, Tooltip, Sheet, and LoadingOverlay layer aliases in theme also point back to `zindex.css`.
**required**: Before adding a layer, determine whether it is local or cross-portal. Only the design owner may add a token, and must document its purpose, relative order, and real interaction verification. `visual.mjs` must resolve each `--vds-z-*` reference in a changed file to an actual definition in `zindex.css`; do not evade bare-value checks with similarly named variables.
**gap**: Historical pages, `styles.css`, and business components still contain bare numeric layers. The new-value gate prevents further additions but does not mean the repository-wide migration is complete.
**advisory**: Migrate current values into compatibility bands that preserve behavior. Tokenization is not a reason to move menus/hover cards into a higher global band.
