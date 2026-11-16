<a id="desktop-设计基础设施整改台账"></a>

# Desktop Design Infrastructure Remediation Log

## Scope / Non-goals

This Goal covers only remediation of design, components/ui, registry/barrel, components/examples, asset documentation, standards, and gates. features, shell, components/business, and primitive are read-only by default; in mixed styles.css files, only evidence-backed changes to foundational entry points/declarations are allowed. Migrating business pages is not a completion criterion.

Separate worktree: `<task-workspace>`.
Branch: `codex/desktop-design-infrastructure`; base: `shushen_release/mvp_v0.2_open_source`, `2745b256e69556a47bd6f28cde1a721dc43a9f52`.
Keep uncommitted changes in the original workspace intact. This task copies only its own asset/standard/theme-preview drafts, excluding parallel localization docs and entry points.

## Source of truth

The full user Goal defines this task's scope and acceptance criteria. Design source file `203335358980331`, page `5:43395`. See the [public design contract](../../design/foundations.md) for mappings and the [asset entry point](../../design/assets.md) for component status. Historical screenshots must show their capture date and must not be presented as current design nodes.

## Current / Required / Gap / Advisory

- **current**: On 2026-09-10, read the Goal and root/Desktop conventions, and checked the source and separate work area. Ran `make ui-find Q='主按钮 输入框 选择器'` and found the actual Button/Input/Select entry points.
- **current**: Loaded the environment explicitly using existing credentials from the root workspace `.env` and ran the MasterGo Skill's `mastergo_analyze.py`. Node `5:81200` returned the Button component set, with default/hover/selected states and 10 nodes. Credentials were neither printed nor copied to the worktree.
- **current**: Completed the top-level theme switch, asset generator, Tailwind/CSS boundary rules, component catalog, and design-alignment matrix, and reviewed them against source, live preview, and Desktop output.
- **required**: At every phase, gather design evidence, implement the foundational layer, run deterministic gates, verify consumers in dev:web and real Desktop, self-review, and update the log.
- **gap**: Badge/Tag, Alert, Toast queues, and some edge states remain derived from semantics because independent design files do not cover them. Evidence can be added later; this does not block delivery of the infrastructure in this Goal.
- **advisory**: Preserve existing props/export/event semantics. When a design omits a size, prefer adding a variant over changing the meaning of an existing size and forcing page migration.

## Ownership / Dependency

| Owner / file scope | Existing consumers and impact | Compatibility approach | Verification |
| --- | --- | --- | --- |
| `design/*.css` | UI and legacy pages share tokens; changes may apply globally | Preserve legacy aliases and distinguish brand backgrounds from foregrounds; do not unify business-specific themes | Token references, light/dark contrast, and representative real pages |
| `components/ui` | feature/shell/business consume through the barrel | Preserve exports and controlled-component conventions; add required sizes/states | Component contracts, keyboard behavior, state matrix, consumer screenshots |
| registry/barrel/examples | Chinese intent search and development preview | Generate inventory from source and register examples completely | reuse/docs/typecheck and real dev:web |
| docs/standards/Skills/gates | Future Codex and human development | Apply progressive constraints to UI added or changed in this task; do not erase historical debt or relax the baseline | Gate counterexamples, real Codex invocation, and artifact review |

<a id="正反例"></a>

## Examples and anti-patterns

Positive example: fix dark-theme brand-button contrast in the foundational token/component and run consumer regression; add an explicit variant for a 36px design size so pages can adopt it according to their actual designs.

Counterexamples: changing features to unify settings-page visuals; treating all of workbench.css as a third-party override; or copying uncommitted changes from another task into the base branch.

## Enforced by

Executed: `npm run docs:check`, `npm test`, `npm run typecheck`, `make desktop-test`, `make wiki-check`, and `git diff --check`. Visual verification used real dev:web and Desktop; deterministic tests do not replace product acceptance. The latest Desktop evidence is in `/tmp/scholarseed-design-final2-shoot.log` and `tmp/test_snapshot/desktop/`.

## Update triggers

For each phase, record design nodes/evidence dates, differences, files, compatibility, tests and screenshots, and items not yet accepted. Check items off only after completion.

- [x] Separate worktree isolated from changes in the original workspace.
- [x] Successfully read the current MasterGo HTTP structure.
- [x] Infrastructure plan and complete evidence mapping.
- [x] Remediated themes, priority components, and Tailwind foundations.
- [x] Synchronized assets, standards, and progressive gates.
- [x] dev:web state matrix and real Desktop evidence with no new regressions.
- [x] Verified standards through actual Codex use.
- [x] Applicable gates, self-review, and final scope audit.

## Stop condition

End only when current evidence supports every infrastructure completion criterion in the Goal. Track historical page migration separately; it does not block infrastructure completion. Current status: infrastructure delivery is complete, pending user authorization to merge/push.

<a id="后续页面迁移责任"></a>

## Responsibility for Future Page Migration

Legacy business-page colors and selectors, workbench-specific layout, literature styles, image/editor shells, and PDF-specific toolbars remain with their respective page owners. Future development should remediate only related UI added or changed in that task; touching a file does not require rewriting its entire module. Merging foundational code does not automatically migrate pages.
