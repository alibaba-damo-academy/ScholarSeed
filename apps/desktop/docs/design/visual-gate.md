# Gate for New Visual Values

## Scope / Non-goals

This gate constrains new fixed spacing, fonts, corner radii, shadows, dimensions, and z-index values in the renderer. It does not judge aesthetics, pixel fidelity to a design, or dynamic user geometry.

## Source of truth

`src/renderer/src/design/*.css` is the token source of truth; `scripts/ci/visual.mjs` is the AST rule source of truth. The audit starts at the Git revision recorded in the proposal. CI must obtain that object and must not treat the post-commit HEAD as a new baseline.

## Current / Required / Gap / Advisory

- **current**: the gate compares the worktree and index against a fixed audit starting point using AST identity.
- **current**: z-index rejects bare numeric classes, CSS declarations, and style objects; named tokens in `design/zindex.css` are the only source of numeric values.
- **current**: the gate resolves every `--vds-z-*` name referenced by changed files and rejects undefined tokens, preventing typos from silently falling back to `auto` at runtime.
- **current**: `components/ui` has a separate zero-allowance check: any non-token layer fails immediately. Existing product code remains governed by the ratchet against the fixed audit starting point.
- **required**: new page visual values must use `--vds-*` or component props. Structural `0/full/auto` values remain allowed, except that z-index zero must still use a token; runtime geometry also remains allowed. Checks cover className, style objects, named classes, local constants, conditional and template expressions, and shorthand properties.
- **gap**: static scanning cannot fully establish dynamic classes, cross-module aliases, function-computed styles, or the runtime cascade.
- **advisory**: record the source and real screenshot evidence for each exception in the review.

## Ownership / Dependency

The gate belongs to Desktop standards. Design defines tokens, UI components consume them, and pages do not define themes.

## Examples and Counterexamples

`gap-[var(--vds-layout-section-gap)]`, `rounded-[var(--vds-radius-4)]`, and `z-[var(--vds-z-dialog)]` are positive examples. `gap-4`, `z-[97]`, and `style={{ zIndex: 450 }}` are counterexamples for new code.

## Enforced by

`standards.mjs` calls `visual.mjs`. `visual.test.mjs` covers variants, arbitrary properties, owner migration, copying, index/worktree audit on both sides, dynamic geometry, and layer token ownership.

## Update triggers

Update this document and its tests when visual tokens, allowed structural values, the audit starting point, or scanned syntax change.

## Stop condition

Record a page as complete only after `pnpm ops ci check docs desktop` and `pnpm ops ci test --scope desktop` pass and real Desktop/browser screenshots have been inspected. If the historical baseline already fails, include a comparison against the same baseline; do not present passing new checks as an entirely green result.
