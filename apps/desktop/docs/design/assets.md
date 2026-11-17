<a id="组件资产与复用指南"></a>

# Component Catalog and Reuse Guide

## Scope / Non-goals

For backend engineers contributing to Desktop pages: find components by intent, inspect their behavior, check their interfaces, and then connect business data. This guide covers existing UI, primitive, and business assets. It does not treat every export as a standalone component or claim that every preview has passed real product acceptance.

## Source of truth

- **[Full component catalog](../_generated/components.md)**: generated from the UI registry and actual business/primitive exports; includes purpose, constraints, source, and direct dependencies.
- [Unified import barrel](../../src/renderer/src/components/ui/index.ts): available UI exports and their implementation files.
- [Runnable example source](../../src/renderer/src/components/examples/ComponentsPage.tsx): component compositions, props, and state examples.
- [Token list](../_generated/tokens.md): theme, typography, spacing, and layer variables.

## Current / Required / Gap / Advisory

- **current**: `pnpm ops ci check docs desktop --write` generates the catalog; `pnpm ops ci check docs desktop` checks it against source.
- **required**: Find the asset first, then inspect its actual props. Import UI through the `components/ui` barrel and use Tailwind CSS for page layout; see [styling rules](foundations.md) for details.
- **gap**: Business modules may depend on StoreProvider, accounts, projects, sessions, and backend APIs. Listed dependencies represent direct source edges only and do not prove that the full runtime is ready. Some complex UI is still preview-grade; see [interaction rules](interaction.md).
- **advisory**: Prefer composing existing capabilities. When something is missing, add a general variant to its owning component instead of copying a page-specific version.

## Ownership / Dependency

| Layer | How to reuse it |
| --- | --- |
| `components/ui` | Choose buttons, inputs, tables, menus, and feedback by intent; drive them with props and do not connect business APIs. |
| `components/primitive` | Mechanisms such as Markdown, attachments, and floating surfaces; read the source to confirm runtime and input assumptions. |
| `components/business` | Complete business areas such as accounts, sessions, projects, and skills; compose them through existing consumers instead of treating them as context-free UI. |
| `features` / `shell` | Connect APIs and state and compose pages; keep business data and actions with their respective owners. |

These are React renderer assets. The Python backend provides data through APIs; reuse these assets in the renderer when building interfaces.

<a id="从需求到可运行页面"></a>
## From Requirements to a Running Page

1. Search the catalog by intent, such as “form,” “search selection,” or “details drawer.” You can also run `npm run ui-find Q="表单"` from the repository root.
2. Start the preview with `pnpm ops dev browser` and open [component examples](http://localhost:5173/?dev=components). Find examples in the left component menu, switch light/dark themes at the top, and use “View code” on the right to see how components are composed.
3. Follow the unified barrel to the implementation and check required props, event parameters, controlled state, and Providers. For business examples that require a real Serve, start `.venv/bin/scholarseed-serve`; a configuration or login prompt does not mean the component API is missing.
4. Calculate the relative import path from your page directory and connect real data plus pending/error states. Use `rg` to find existing uses of the same component.
5. Open the actual page and verify light/dark themes, long text, empty data, failures, keyboard use, and narrow windows. A component showcase does not replace business-flow acceptance.

Selection tips: use Select for choosing form values and DropdownMenu for actions; Tooltip for short explanations and Popover for interactive floating surfaces; Alert for persistent notices and Toast for transient feedback; Sheet for a details side panel and AlertDialog to confirm dangerous actions. Refer to the catalog for the full set of choices and constraints.

<a id="正反例"></a>
## Examples and anti-patterns

The paths below apply to pages under `features/<domain>/`; adjust them for other directory depths. Business owners provide the example props; do not invent APIs:

```tsx
import { Button, Card, Input } from '../../components/ui'

interface NameEditorProps {
  name: string
  saving: boolean
  onNameChange: (value: string) => void
  onSave: () => void
}

export function NameEditor({ name, saving, onNameChange, onSave }: NameEditorProps) {
  return (
    <Card className="grid gap-[var(--vds-space-4)]">
      <Input
        label="名称"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
      />
      <Button loading={saving} disabled={!name.trim()} onClick={onSave}>
        保存
      </Button>
    </Card>
  )
}
```

Counterexamples: copying native button/input elements and writing custom CSS; deep-importing an internal UI file; placing AccountPanel in a new page without its required context; or guessing props from an asset name.

## Enforced by

`pnpm ops ci check docs desktop` and `scripts/ci/__tests__/standards.test.mjs` check catalog generation consistency. `scripts/ci/__tests__/reuse.test.mjs` checks the UI barrel, intents, and preview coverage. `pnpm ops ci check types desktop` checks consumer APIs; verify real pages according to the [testing rules](../quality/testing.md).

## Update triggers

After adding or removing exports or changing UI intents/usage constraints, run `pnpm ops ci check docs desktop --write` and include the generated catalog changes. When business purpose or runtime requirements change, update the relevant examples in this guide too. Do not edit generated tables by hand.

The generated catalog's English descriptions are maintained in `scripts/ci/ui-registry-en.json`; Chinese search keywords remain in `registry.ts`. After changing the first four `intents`, `use`, or `avoid` entries in the registry, review and update the corresponding English translation. Set `sourceHash` to the SHA-256 digest, in UTF-8, of `JSON.stringify([entry.intents.slice(0, 4), entry.use, entry.avoid])`.

## Stop condition

Start page development once you have found a suitable component, confirmed its props and dependencies, and inspected its states in the examples. If a capability is missing, extend the owning component; do not replace source registration with a new list.

<a id="ai-开发入口"></a>
## AI Development Entry Point

The component reuse contract is defined by [components](components.md) and the actual registry. The public search tool is `apps/desktop/scripts/ci/find.mjs`; it does not depend on an internal development Skill.
Development Skills, MasterGo integration, and host discovery are maintained in the documentation source repository and are not distributed with source code.
Desktop documentation and reuse gates continue to check actual source and derived assets. Business pages are improved incrementally only within the scope of each development task.
