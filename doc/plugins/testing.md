---
id: reference-plugin-testing
title: Test a Plugin
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: Validate packages, verify cards and backend results in real tasks, and diagnose failures.
---

# Test a Plugin

**English** · [简体中文](testing.zh.md) · [Read offline](../plugins.html#testing)

[Plugin Overview](../plugins.md)

Use the [paper-reading-notes tutorial](create.md) to exercise validation, installation, and conversation use.

## Validate the Package

Follow [Validate and Package](create.md#validate-and-package) for `validate` and `pack`. The validation file contains the inner `request` object.

Check a ZIP received from someone else, or verify its bytes after transfer, in a Python environment with the matching ScholarSeed backend installed:

```sh
python -m service.cli.plugins check ./paper-reading-notes-0.1.0.zip
```

- Review the package identity, version, actual SHA-256, and every reported issue.
- Check that scenarios cover every action and its submitted values.
- Keep the ZIP outside the source directory. Paths must be portable and relative: no absolute paths, drive letters, backslashes, `..`, or Windows reserved names.
- Do not package credentials, `.env`, login caches, virtual environments, or unrelated files.

`capabilities_unchecked` means actual calls still need verification inside ScholarSeed.

## Install and Complete a First Conversation

Prepare `paper-reading-notes-0.1.0.zip` and a paper you are authorized to use.

1. Open ScholarSeed and go to the Skills center → **Add skill**, then select the ZIP.
2. Review the plugin name, version, and check results, and confirm installation.
3. Find `paper-reading-notes` in your skills list and enable it. For an AI-generated plugin, you can instead confirm installation on its conversation card.
4. Open your conversation, upload the paper or paste an excerpt, and send the prompt below.
5. When the reading-focus card appears, choose **Understand the method**. Verify that notes cover the research question, method steps, and applicable conditions, with source locations.
6. Start another task and choose **Check the evidence**. Verify that notes instead cover conclusions, supporting evidence, and limitations. Missing information must be marked as not stated.

Example prompt:

> Please use paper-reading-notes to make reading notes for the paper I just uploaded. Let me choose the reading focus first.

No prior binding through the Skill picker is required. If no card appears, check that the plugin is enabled and the tool history contains a `component/request` call.

## Check Task Results

| Test | Expected result |
| --- | --- |
| Choose Understand the method | The answer has `focus: "method"`; method notes include sources. |
| Choose Check the evidence | The answer has `focus: "evidence"`; evidence notes include sources. |
| Cancel the focus selection | No further notes are generated for that request. |
| Provide only an abstract | Notes state that they are based only on the abstract; they do not invent full-text experiments or conclusions. |
| Use a plugin that downloads, saves, or imports | Verify actual files, project resources, or literature-library entries. |

Record input, tool results, and notes. Preserve screenshots or recordings of failures without exposing credentials or private research materials.

## Check UI and Updates

For a custom card, call `setCopyContent()` and use the message's copy button. Paste into a text editor and verify the order of prose, cards, and subsequent conclusions, including choices, citations, and links. Switch conversations and return: copying history must still include the card. Register new copy content after editing a draft; do not copy stale choices. Missing card text must be explicitly indicated when none is registered.

- **UI:** Light/dark themes, narrow windows, keyboard use, long text, and errors.
- **State:** Re-rendering preserves edits; old save responses do not overwrite new input; cancellation does not continue the task.
- **Updates:** A new package, digest, and installation confirmation; slot conflicts do not take over other plugins; failures preserve the old version.
- **Historical cards:** Restore their pinned version and recheck current permissions.
- **Platforms:** Verify affected installation and runtime behavior separately on macOS and Windows.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Cannot find a creation or preview button | These page entries are hidden; ask for `plugin-create` in a conversation. |
| Cannot use `plugin-create` | Whether this version includes and enables the Skill, and whether the skill catalog initialized correctly. |
| Incompatible host | Backend distribution version, descriptor range, and actual contract. |
| Installed but no card | Enabled status, `component/catalog`, slot, and actual tool request. |
| `component_value_invalid` | `data`, action `values`, and `output_schema`; do not treat the outer answer envelope as `values`. |
| `plugin_capability_unavailable` | Whether this card has an actual handler; declaration is not connection. |
| `ui_dependency_unavailable` | Official resources, compatibility, and actual exports; do not substitute a bundled React runtime for the official one. |
| Input disappears after saving | Local-edit/snapshot merging and whether an old response overwrote newer input. |
| Skills list fails or returns 503 | Skill catalog and initialization logs; retry after recovery, without simulating success. |
