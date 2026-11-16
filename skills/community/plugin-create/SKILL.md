---
name: plugin-create
description: Create a local research workflow plugin for ScholarSeed with a Skill, custom conversation component code, sample interactions and an inspected ZIP. Verify the actual host interaction slot before promising runtime support. Use only when asked to create or change a plugin.
description_zh: 为书深创建包含 Skill、自定义对话组件代码和预览场景的本地插件，检查后交付安装包；先核实宿主实际支持的交互入口，不承诺未接通的流程。
version: "0.5.27"
---

# Create a plugin

Use this Skill only to create or revise a local ScholarSeed plugin. Deliver editable source, an inspected ZIP, and a host installation card. Do not change ScholarSeed core, install without the user's confirmation, or claim a workflow has run when only its package or preview has been checked. Use the user's language for conversation and generated deliverables.

## 1. Define the workflow

Record the goal, actual input sources, constraints, user decisions, outputs, and package identity in `requirements.md` outside the source directory. Ask only about gaps that change the workflow or result; use reasonable layout defaults and do not invent steps, dependencies, or options. The generated Skill owns the workflow; UI only presents results or collects decisions.

Work in the current session's actual output directory (`SESSION_DIR`) unless the user authorizes another location. Keep source, archives and logs there, with intermediate files under `work/`. Never write into system temporary directories, the host installation/configuration, credentials, or an existing plugin. Resolve identity or version conflicts with the user rather than silently overwriting, renaming, reusing, or moving an existing package.

For a revision, read the existing requirements and affected source instead of scaffolding again. Preserve unchanged requirements, state handling and security; remove withdrawn steps, actions and scenarios together. Clarify only actual conflicts.

## 2. Confirm what the host supports

Run `scholarseed-skill-python -m service.cli.plugins prepare <skill-directory>/references/contract.json` once for the current host. On `matched=true`, use the verified [snapshot](references/contract.json); on `matched=false`, use the returned contract and inspect the differences. Use one `describe` only if the host does not support `prepare`. Do not rediscover known arguments through trial and error, read host source to guess fields, or invent install/preview commands.

For a necessary but unknown business operation, use the contract's `native_contract_discovery` through `scholarseed_bridge`. Do not send probe parameters to a business API. If a plan is needed, use `planning.operations` and get the actual plan, turn and revision through `plan/get`. Fix errors at the reported path and stop repeating an unchanged failure. Contract discovery neither grants authorization nor proves the current slot, permissions or installation are valid. Explain unsupported capabilities instead of promising them.

## 3. Choose the surface and define success

- **No user decision:** keep a simple result in the conversation when an official presentation component fits. Use `conversation.ui` only if the current OpenUI contract covers it. Use a custom display card for browse-only interaction; do not save a draft or submit an answer from it.
- **User decision required:** request an answer only when later work actually depends on it.
- **Exploration or dense comparison:** use a custom workbench component if the contract supports it; keep the conversation preview useful on its own.

For new or changed UI, read the [design guide](references/DESIGN.md). Record what users should see first, what they need to compare, and what they need to do now; omit anything not needed. Sketch the first view with realistic values before choosing a template.

Before implementation, use the [testing guide](references/testing.md) to define the decisive inputs, actions, expected values and failure conditions. For research workflows, read the [evidence guide](references/evidence.md) and put the applicable checks in the generated Skill, including source-specific read operations and approval boundaries. Apply the same checks to sources cited while creating the plugin.

## 4. Author the source

For a new package, choose the smallest scaffold: `selection`, `comparison`, or `stages`. For example:

```sh
scholarseed-skill-python <skill-directory>/scripts/scaffold.py comparison "$SESSION_DIR/my-plugin-source" --name my-plugin
```

Use a destination that does not exist. If the user specified a package name, use it for the directory, Skill name, plugin ID and pack name. Maintain one entry `SKILL.md` and a root `.scholarseed-plugin.json` with the same identity and version. A generated Skill can compose existing tools, not override system instructions or permission checks. The scaffold pins the current host; use `--host` for a requested wider range only after checking compatibility. Do not install system or Python dependencies as part of creation; leave declarations empty when there are none.

The scaffold is editable source, not a finished workflow. Replace its example logic with the user's actual workflow, and rewrite its default request instructions if a step uses display or a public domain tool instead of confirmation. Prefer mapping data over rewriting interaction code; preserve state handling, use ordinary JavaScript and keep custom render functions small. The installed component owns layout and interaction. On each run, the generated Skill extracts new data, fills the applicable `requests/` payload, calls the existing slot and consumes actual receipts; it does not rewrite UI code or use preview data in research.

For component work, follow the [interaction guide](references/interaction.md) for schema, slot invocation, edits, receipts and preview scenes. When inputs, actions or layout change, update the descriptor, payloads and generated Skill references, preview scenes and tests together. Once custom slots are known, use `scholarseed_bridge` → `component/preflight` with `{slots: [actualCustomSlot]}` before packing. It detects occupied slots, including hidden ones, without reserving them or exposing unauthorized plugin content. Resolve conflicts with the user; installation checks again.

## 5. Verify and hand off

Validate the actual invocation payloads and run the task-specific assertions using the [testing guide](references/testing.md). Pack the source into a new ZIP outside the source directory, then use that exact archive for preview and installation:

```sh
scholarseed-skill-python -m service.cli.plugins pack "$SESSION_DIR/my-plugin-source" --name my-plugin --version 0.1.0 --output "$SESSION_DIR/my-plugin-0.1.0.zip" --check-entries
```

Do not bundle secrets, environment files, caches or dependency environments, or execute a plugin's installation scripts. For custom components, require command success, `valid: true`, `entry_syntax.valid: true`, and no `component_submission_samples_missing` warning. Fix reported issues in source, build a new ZIP and retain its returned `sha256`. Missing parser or flag support leaves the syntax gate unmet. `pack` checks its own output; use `check <zip> --check-entries` for external archives, byte verification after transfer, or necessary pre-install rechecking, not as a duplicate check of unchanged output.

Preview the exact candidate in the host when available and rerun affected checks after a fix. Otherwise report preview as unverified and retain interactive scenarios. Package checks and preview do not prove that the installed workflow ran; use a real task after authorized installation to check mounting, key actions, actual receipts and artifacts.

Deliver the source and ZIP. Through `scholarseed_bridge`, call `plugin/install` with `{request_id, path, sha256}`: `path` is the ZIP path relative to the current workspace, and the digest must be the actual check result. The host verifies the bytes and publishes an installation card. If delivery is unknown, retry the same publication with the same ID, path and digest. Never call settings installation directly.

`published` means the card is available for the user's decision, not that the plugin is installed or enabled. Report what was verified and what remains pending; finish without waiting, polling, or asking the user to install or skip. After installation and enablement, a natural-language task can use the Skill without picker binding.

Record the package ID/version, source, ZIP, digest and installation request ID in `requirements.md`. For each deliverable revision, bump both source version declarations and use a new ZIP filename and installation request ID; never replace a ZIP referenced by an earlier card. Summarize what was kept, changed, and removed. Do not require installation before making further revisions.
