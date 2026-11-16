<a id="deeprd-到-veda-token-映射"></a>
# DeepRD-to-Veda Token Mapping

This page maps the sources used in the initial migration; it is not the current token inventory or a
styling-stack specification. During development, first read the [visual foundations specification](../../../../docs/design/foundations.md),
then inspect the actual `design/*.css` files and [generated inventory](../../../../docs/_generated/tokens.md).
“Migrated” in the table records the initial handling; it does not prove that values still match their
sources, fully cover current variables, or that themes have passed real-device acceptance.

`styles.css` currently imports Tailwind, and Desktop PostCSS uses `@tailwindcss/postcss`.
Do not carry forward the initial decision not to introduce Tailwind, and do not treat this as
authorization to re-import an entire vendor theme.

<a id="初期迁移规则"></a>
## Initial Migration Rules

- Migrate DeepRD `--ds-*` uniformly to this project’s `--vds-*`.
- Rewrite the DeepRD `.dark` theme entry uniformly as this project’s `:root[data-theme='dark']`.
- New code may use `--vds-*` only; do not add new `--ds-*` tokens.
- Tailwind `@theme`, `@plugin`, and `@custom-variant` from the source were not migrated initially; current styling rules are owned by the visual foundations specification.
- Deferring the source `markdown.css` was an initial scope record; it does not mean all Markdown rendering capabilities remain unimplemented today.

<a id="特殊映射"></a>
## Special Mappings

| DeepRD token | Veda token | Source file | Target file | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| `--z-*` | `--vds-z-*` | `platform_frontend/src/styles/z-index-variables.css` | `design/zindex.css` | Migrated | Removed Tailwind `@theme` and used ordinary CSS variables |
| Tailwind `@theme` | - | `platform_frontend/src/styles/theme.css` | - | Not migrated initially | Tailwind is now integrated; this does not authorize restoring the entire source theme |
| `markdown.css` | - | `platform_frontend/src/styles/markdown.css` | - | Migration deferred | Revisit when product pages need unified Markdown rendering |

<a id="初期-token-映射快照"></a>
## Initial Token Mapping Snapshot

| DeepRD token | Veda token | Source file | Target file | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| `--ds-accent-bg-default` | `--vds-accent-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-accent-light-bg-default` | `--vds-accent-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-accent-light-border` | `--vds-accent-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-accent-text-primary` | `--vds-accent-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-component` | `--vds-bg-component` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-active` | `--vds-bg-gray-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-active-transparent` | `--vds-bg-gray-active-transparent` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-default` | `--vds-bg-gray-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-default-transparent` | `--vds-bg-gray-default-transparent` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-hover` | `--vds-bg-gray-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-hover-transparent` | `--vds-bg-gray-hover-transparent` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-gray-light-default` | `--vds-bg-gray-light-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-mask` | `--vds-bg-mask` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-page` | `--vds-bg-page` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-white-active` | `--vds-bg-white-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-white-active-transparent` | `--vds-bg-white-active-transparent` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-white-default` | `--vds-bg-white-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-white-disable` | `--vds-bg-white-disable` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-white-hover` | `--vds-bg-white-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-bg-white-hover-transparent` | `--vds-bg-white-hover-transparent` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-border-brand` | `--vds-border-brand` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-border-default` | `--vds-border-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-border-width-1` | `--vds-border-width-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-border-width-2` | `--vds-border-width-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-border-width-3` | `--vds-border-width-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-1` | `--vds-brand-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-10` | `--vds-brand-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-2` | `--vds-brand-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-3` | `--vds-brand-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-4` | `--vds-brand-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-5` | `--vds-brand-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-6` | `--vds-brand-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-7` | `--vds-brand-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-8` | `--vds-brand-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-9` | `--vds-brand-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-bg-active` | `--vds-brand-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-bg-default` | `--vds-brand-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-bg-disabled` | `--vds-brand-bg-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-bg-hover` | `--vds-brand-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-light-bg-active` | `--vds-brand-light-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-light-bg-default` | `--vds-brand-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-light-bg-hover` | `--vds-brand-light-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-light-border` | `--vds-brand-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-text-placeholder` | `--vds-brand-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-brand-text-primary` | `--vds-brand-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-divider-default` | `--vds-divider-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-1` | `--vds-error-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-10` | `--vds-error-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-2` | `--vds-error-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-3` | `--vds-error-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-4` | `--vds-error-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-5` | `--vds-error-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-6` | `--vds-error-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-7` | `--vds-error-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-8` | `--vds-error-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-9` | `--vds-error-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-bg-active` | `--vds-error-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-bg-default` | `--vds-error-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-bg-disabled` | `--vds-error-bg-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-bg-hover` | `--vds-error-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-light-bg-active` | `--vds-error-light-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-light-bg-default` | `--vds-error-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-light-bg-hover` | `--vds-error-light-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-light-border` | `--vds-error-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-text-placeholder` | `--vds-error-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-error-text-primary` | `--vds-error-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-1` | `--vds-fill-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-10` | `--vds-fill-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-2` | `--vds-fill-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-3` | `--vds-fill-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-4` | `--vds-fill-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-5` | `--vds-fill-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-6` | `--vds-fill-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-7` | `--vds-fill-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-8` | `--vds-fill-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fill-9` | `--vds-fill-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-focus-brand` | `--vds-focus-brand` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-focus-default` | `--vds-focus-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-focus-error` | `--vds-focus-error` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-focus-ring` | `--vds-focus-ring` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-body-lv1` | `--vds-font-body-lv1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-body-lv2` | `--vds-font-body-lv2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-caption` | `--vds-font-caption` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-code` | `--vds-font-code` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-display-lv1` | `--vds-font-display-lv1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-display-lv2` | `--vds-font-display-lv2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-display-lv3` | `--vds-font-display-lv3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-display-lv4` | `--vds-font-display-lv4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-headline` | `--vds-font-headline` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-main` | `--vds-font-main` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-serif` | `--vds-font-serif` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-subhead` | `--vds-font-subhead` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-font-title` | `--vds-font-title` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fw-light` | `--vds-fw-light` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fw-medium` | `--vds-fw-medium` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-fw-regular` | `--vds-fw-regular` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-1` | `--vds-gradient-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-10` | `--vds-gradient-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-2` | `--vds-gradient-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-3` | `--vds-gradient-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-4` | `--vds-gradient-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-5` | `--vds-gradient-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-6` | `--vds-gradient-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-7` | `--vds-gradient-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-8` | `--vds-gradient-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-9` | `--vds-gradient-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-bg-default` | `--vds-gradient-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-bg-disable` | `--vds-gradient-bg-disable` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-bg-hover` | `--vds-gradient-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-bg-press` | `--vds-gradient-bg-press` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-border` | `--vds-gradient-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-light-bg` | `--vds-gradient-light-bg` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-text-highlight-1` | `--vds-gradient-text-highlight-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-text-highlight-2` | `--vds-gradient-text-highlight-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-gradient-text-loading` | `--vds-gradient-text-loading` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-1` | `--vds-help-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-10` | `--vds-help-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-2` | `--vds-help-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-3` | `--vds-help-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-4` | `--vds-help-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-5` | `--vds-help-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-6` | `--vds-help-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-7` | `--vds-help-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-8` | `--vds-help-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-9` | `--vds-help-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-bg-active` | `--vds-help-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-bg-default` | `--vds-help-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-bg-disabled` | `--vds-help-bg-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-bg-hover` | `--vds-help-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-light-bg-active` | `--vds-help-light-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-light-bg-default` | `--vds-help-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-light-bg-hover` | `--vds-help-light-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-light-border` | `--vds-help-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-text-placeholder` | `--vds-help-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-help-text-primary` | `--vds-help-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-10` | `--vds-icon-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-6` | `--vds-icon-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-7` | `--vds-icon-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-8` | `--vds-icon-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-9` | `--vds-icon-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-fill-default` | `--vds-icon-fill-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-outline-default` | `--vds-icon-outline-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-icon-outline-muted` | `--vds-icon-outline-muted` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-body-lv1` | `--vds-lh-body-lv1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-body-lv2` | `--vds-lh-body-lv2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-caption` | `--vds-lh-caption` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-display-lv1` | `--vds-lh-display-lv1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-display-lv2` | `--vds-lh-display-lv2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-display-lv3` | `--vds-lh-display-lv3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-display-lv4` | `--vds-lh-display-lv4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-headline` | `--vds-lh-headline` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-subhead` | `--vds-lh-subhead` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-lh-title` | `--vds-lh-title` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-1` | `--vds-line-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-10` | `--vds-line-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-2` | `--vds-line-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-3` | `--vds-line-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-4` | `--vds-line-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-5` | `--vds-line-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-6` | `--vds-line-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-7` | `--vds-line-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-8` | `--vds-line-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-line-9` | `--vds-line-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-link` | `--vds-link` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-link-active` | `--vds-link-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-link-disabled` | `--vds-link-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-link-hover` | `--vds-link-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-1` | `--vds-notice-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-10` | `--vds-notice-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-2` | `--vds-notice-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-3` | `--vds-notice-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-4` | `--vds-notice-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-5` | `--vds-notice-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-6` | `--vds-notice-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-7` | `--vds-notice-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-8` | `--vds-notice-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-9` | `--vds-notice-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-bg-active` | `--vds-notice-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-bg-default` | `--vds-notice-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-bg-disabled` | `--vds-notice-bg-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-bg-hover` | `--vds-notice-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-light-bg-active` | `--vds-notice-light-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-light-bg-default` | `--vds-notice-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-light-bg-hover` | `--vds-notice-light-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-light-border` | `--vds-notice-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-text-placeholder` | `--vds-notice-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-notice-text-primary` | `--vds-notice-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-other-balloon` | `--vds-other-balloon` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-other-mask` | `--vds-other-mask` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-other-overlay-1` | `--vds-other-overlay-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-other-overlay-2` | `--vds-other-overlay-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-other-overlay-3` | `--vds-other-overlay-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-other-white-overlay-1` | `--vds-other-white-overlay-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-1` | `--vds-radius-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-10` | `--vds-radius-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-12` | `--vds-radius-12` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-2` | `--vds-radius-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-3` | `--vds-radius-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-4` | `--vds-radius-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-6` | `--vds-radius-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-8` | `--vds-radius-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-radius-circle` | `--vds-radius-circle` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-1-center` | `--vds-shadow-1-center` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-1-down` | `--vds-shadow-1-down` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-1-left` | `--vds-shadow-1-left` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-1-right` | `--vds-shadow-1-right` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-1-up` | `--vds-shadow-1-up` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-2-center` | `--vds-shadow-2-center` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-2-down` | `--vds-shadow-2-down` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-2-left` | `--vds-shadow-2-left` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-2-right` | `--vds-shadow-2-right` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-2-up` | `--vds-shadow-2-up` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-3-center` | `--vds-shadow-3-center` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-3-down` | `--vds-shadow-3-down` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-3-left` | `--vds-shadow-3-left` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-3-right` | `--vds-shadow-3-right` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-3-up` | `--vds-shadow-3-up` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-aidialog-1` | `--vds-shadow-aidialog-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-shadow-aidialog-2` | `--vds-shadow-aidialog-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-0` | `--vds-space-0` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-1` | `--vds-space-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-2` | `--vds-space-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-3` | `--vds-space-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-4` | `--vds-space-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-5` | `--vds-space-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-space-6` | `--vds-space-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-static-black` | `--vds-static-black` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-static-transparent` | `--vds-static-transparent` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-static-white` | `--vds-static-white` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-1` | `--vds-success-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-10` | `--vds-success-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-2` | `--vds-success-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-3` | `--vds-success-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-4` | `--vds-success-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-5` | `--vds-success-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-6` | `--vds-success-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-7` | `--vds-success-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-8` | `--vds-success-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-9` | `--vds-success-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-bg-active` | `--vds-success-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-bg-default` | `--vds-success-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-bg-disabled` | `--vds-success-bg-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-bg-hover` | `--vds-success-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-light-bg-active` | `--vds-success-light-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-light-bg-default` | `--vds-success-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-light-bg-hover` | `--vds-success-light-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-light-border` | `--vds-success-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-text-placeholder` | `--vds-success-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-success-text-primary` | `--vds-success-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-1` | `--vds-text-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-10` | `--vds-text-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-2` | `--vds-text-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-3` | `--vds-text-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-4` | `--vds-text-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-5` | `--vds-text-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-6` | `--vds-text-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-7` | `--vds-text-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-8` | `--vds-text-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-9` | `--vds-text-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-disabled` | `--vds-text-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-highlight` | `--vds-text-highlight` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-placeholder` | `--vds-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-primary` | `--vds-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-secondary` | `--vds-text-secondary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-text-tertiary` | `--vds-text-tertiary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-1` | `--vds-warning-1` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-10` | `--vds-warning-10` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-2` | `--vds-warning-2` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-3` | `--vds-warning-3` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-4` | `--vds-warning-4` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-5` | `--vds-warning-5` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-6` | `--vds-warning-6` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-7` | `--vds-warning-7` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-8` | `--vds-warning-8` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-9` | `--vds-warning-9` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-bg-active` | `--vds-warning-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-bg-default` | `--vds-warning-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-bg-disabled` | `--vds-warning-bg-disabled` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-bg-hover` | `--vds-warning-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-light-bg-active` | `--vds-warning-light-bg-active` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-light-bg-default` | `--vds-warning-light-bg-default` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-light-bg-hover` | `--vds-warning-light-bg-hover` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-light-border` | `--vds-warning-light-border` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-text-placeholder` | `--vds-warning-text-placeholder` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
| `--ds-warning-text-primary` | `--vds-warning-text-primary` | `platform_frontend/src/styles/token.css` | `design/tokens.css` | Migrated | Value retained from DeepRD |
