<a id="veda-ui-实现说明"></a>
# Veda UI Implementation Notes

This directory contains only notes adjacent to component implementations. The sole authorities for
component selection, ownership, tokens, and interaction rules are
[`components.md`](../../../../../docs/design/components.md),
[`foundations.md`](../../../../../docs/design/foundations.md), and
[`interaction.md`](../../../../../docs/design/interaction.md).

The complete dynamic inventory of components and exports is generated from `registry.ts` into
[`docs/_generated/components.md`](../../../../../docs/_generated/components.md); do not hand-maintain a mirror here.

<a id="实现契约"></a>
## Implementation Contract

- `index.ts` is the sole export for consumer domains; `registry.ts` is the machine-readable source of truth for families, intents, alternatives, and anti-patterns.
- Every new family must include its implementation, styles, barrel export, registry metadata, a `ComponentsPage.tsx` preview, and tests.
- This layer has no business semantics, does not read APIs/stores, and does not depend on app, shell, feature, or business components.
- Use `--vds-*` tokens from `design/` for styling; use the shared Iconfont for icons.
- `FormField`, `CopyButton`, `Pagination`, `LoadingOverlay`, `EmptyState`, `Table`, and similar components are presentation primitives; they do not own business data, pagination requests, or global business state.

`AlertDescription` keeps the default two-line summary. Pass `truncate={false}`
for complete instructions that must remain readable, such as recovery choices.

`FormField` is intentionally a presentational field structure. It provides
label, description, and message ids to `FormControl`, but owns no validation or
form-library state.

<a id="复杂交互成熟度"></a>
## Complex Interaction Maturity

Verify complex interactions for each specific family, call composition, and host. Do not infer from a
shared preview label that all capabilities are missing or that the complete guarantees of a mature
primitive have been achieved. `DialogContent` currently uses `useFocusScope`: in modal mode it manages
the focus scope and Tab loop, and on close restores focus when the restoration conditions are met and
the target remains connected. `DialogPortal` explicitly provides a portal to `document.body`; verify
whether each caller uses it.
Focus scopes use the owning document's live window for DOM checks. After that window
is closed or the document loses its window, scope membership is false and cleanup
still releases observers/listeners, but does not restore focus into the retired document.
This does not prove that all dialog/menu/tooltip families provide the same scroll lock, collision
positioning, nested menus, typeahead, or global Escape arbitration. Before adding a guarantee, have
the design-system owner assess and extend the existing capability, preserve the public family API,
add applicable DOM and real Electron verification, and do not copy a replacement implementation into a feature.

DOM portals and CSS stacking cannot cross the native `WebContentsView` window-compositing boundary.
When an embedded webpage is present, select a verified rendering mechanism according to the
[browser host constraints](../../../../../docs/browser.md); renderer-only overlay tests cannot prove
native webpage occlusion or correct input ownership.

`Calendar`, `Carousel`, and `Chart` are likewise basic implementations without external dependencies
and are suitable for low-risk previews. Complex date ranges, physical scrolling, or chart interactions
first require the design-system owner to extend the capability.

`Select` retains both the native option-child path and the compound API. In the compound path,
`SelectContent` uses a portal, focuses the selected item on open, chooses above or below based on
available viewport space, and handles Esc, arrow keys, and Home/End navigation. This does not promise
support for arbitrary collision handling, search, multi-select, or typeahead. For additional
capabilities, first check `Command` and `ToggleGroup`, or extend the Select family at this layer; do
not build another popover in a feature.

<a id="开发预览与门禁"></a>
## Development Preview and Gates

```bash
pnpm ops dev browser            # Start the browser product, then open the local Vite URL with ?dev=components
npm run ui-find -- Q="<意图>"
pnpm ops ci check docs desktop
pnpm ops ci test --scope desktop
```

If the implementation conflicts with the maturity notes here, source code and test evidence take
precedence; update the local contract and these notes in the same change.
