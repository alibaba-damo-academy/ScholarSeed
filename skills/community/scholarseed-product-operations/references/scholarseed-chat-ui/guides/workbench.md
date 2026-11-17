# Artifacts and Workbench Components

**English** · [简体中文](workbench.zh.md)

Use the product's native file cards and workbench for artifacts. Do not generate artifact cards through OpenUI. There is no separate slot for artifact previews or artifact selection.

## Generate and Publish Real Artifacts First

Follow the [file artifacts guide](../../scholarseed-bridge/guides/artifacts.md) and the bundled `artifact/publish` contract. Write files in the currently authorized working directory and check their contents, types, and integrity before publishing. Keep a separate receipt and object identity for each file. Publish multiple files individually; partial success is not full success.

The host owns native file cards, image viewing, versions, open and save actions, the system application menu, and workbench navigation. Prefer native cards created by successful publication receipts. Generic plugins do not get arbitrary file or external link access and must not call the host DOM, HTTP, or filesystem or fabricate menu results.

## Use Native File Cards and Groups

Use native file cards generated from real publication receipts. The host displays multiple files and folders in their original order. Do not substitute a hand-written path or sample version for a publication receipt. The host owns permission checks, revision-matched content, and open actions. React exports are not directly callable public slots.

Use the artifact image preview for actual images; an arbitrary URL is not an authorized asset. Lean files can be displayed in the editor, but editing, syntax highlighting and preview are not proof verification. For requested formal verification, follow the available formal-verification skill and its actual authorization and service contract. Do not assume the workbench provides a diagnostics service. Only report verification supported by real evidence for the delivered revision; unavailable verification or mismatched revisions must remain explicit. Do not present sample goals or diagnostics as proof. A preview does not establish that a file is accessible or the workbench opened.

Combine with other conversation cards as needed and reuse the original artifacts and receipts. Saving, importing, overwriting, and system actions remain subject to actual host permissions; loading this skill grants none.
