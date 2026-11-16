---
name: plugin-create
description: Create or revise a local ScholarSeed workflow plugin with verified host interactions, fixed OpenUI result views where applicable, editable source and an inspected installation ZIP.
description_zh: 为书深创建或迭代本地工作流插件，核实宿主交互，适用时用固定 OpenUI 布局展示结果，交付可编辑源码和经检查的安装包。
version: "0.5.30"
---

# Create a ScholarSeed workflow plugin

Use this Skill only to create or revise a plugin. The generated Skill owns the workflow: it reads authorized inputs, obtains decisions when necessary, performs the work and delivers the actual results. Components present data or collect decisions; they do not replace those steps or grant permissions. Use the user's language.

## 1. Define the workflow

Identify the real inputs, decisions, constraints, outputs and any required interaction or workbench behavior. Ask only about gaps that affect the outcome. For multi-round authoring, you may keep a `requirements.md` beside the source, outside the package. For revisions, read the affected source and available requirements, preserve unchanged inputs and decisions, and remove withdrawn steps and their associated actions and scenarios.

Work in the actual session output directory (`SESSION_DIR`) or another authorized location. Keep intermediate files under `work/`. Do not modify the host, credentials or an installed plugin. Resolve identity conflicts rather than overwriting or silently renaming a package.

## 2. Check the host and choose each surface

Run `scholarseed-skill-python -m service.cli.plugins prepare <skill-directory>/references/contract.json` once. If matched, use the [snapshot](references/contract.json); otherwise use the returned contract. Use `describe` only if `prepare` is unavailable. Discover unknown domain operations with the contract's `native_contract_discovery`; discovery is not permission.

Use the [interaction guide](references/interaction.md) to map each step to a supported surface:

- Prefer registered OpenUI primitives for conversation results. Use a fixed package layout and `input_schema`, without component JavaScript. The Agent supplies business JSON and Desktop renders it.
- For decisions, authorization and execution, use the applicable native question or domain operation and consume its actual result. Do not put confirmation in a display-only card.
- For workbench use, check the native Canvas contract or a supported independent workbench integration against the actual requirements. A fixed conversation layout cannot move to the workbench or provide custom actions.

Do not depend on `components/ui` or its shared plugin UI SDK in the generated package. If an essential behavior has no compatible surface, explain the missing capability, affected steps and supported alternatives. Agree on a changed flow before substituting another surface or omitting a requirement; otherwise leave the affected delivery blocked. Do not change the host or present a static substitute as working interaction.

## 3. Author the package

Keep an entry `SKILL.md` and a schema 2 `.scholarseed-plugin.json` with matching package ID and version. Implement the requested stages, state and output handling; do not import example workflow logic unless it fits. A workflow that uses only host operations does not need a custom component.

For fixed OpenUI, the optional comparison scaffold is an editable layout example, not a required workflow:

```sh
scholarseed-skill-python <skill-directory>/scripts/scaffold.py comparison "$SESSION_DIR/my-plugin-source" --name my-plugin
```

Use a new destination. Customize layout, schema, sample data and invocation together. Use the [design guide](references/DESIGN.md) for the first view, the [evidence guide](references/evidence.md) for research, and the [testing guide](references/testing.md) to define independent expected values and verify the package. Before packing, check custom slots with `component/preflight` and resolve conflicts. A successful check does not reserve a slot.

## 4. Verify and hand off

Validate actual-shaped requests, then pack a new ZIP outside the source directory:

```sh
scholarseed-skill-python -m service.cli.plugins pack "$SESSION_DIR/my-plugin-source" --name my-plugin --version 0.1.0 --output "$SESSION_DIR/my-plugin-0.1.0.zip" --check-entries
```

Require the applicable checks and keep the resulting SHA-256. Do not bundle secrets, caches or dependency environments. Preview the exact candidate where supported. Deliver editable source and the ZIP, then publish the installation card through `scholarseed_bridge` → `plugin/install` with `{request_id, path, sha256}`. Use the workspace-relative ZIP path and checked digest. If delivery is unknown, retry with identical values. `published` means the user can decide whether to install; never install directly or poll for their decision.

For a new revision, bump both source versions and use a fresh archive and request ID. Never replace a ZIP referenced by an earlier card. If keeping iteration notes, record package identity, source, ZIP, digest and request ID. Report package, preview, user-authorized installation and actual usage separately. Verify usage with a real task after installation and enablement; do not present package or preview checks as runtime success.
