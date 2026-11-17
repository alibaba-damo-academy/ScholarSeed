# Verify a generated workflow

## Before packing

Define expected results independently of the implementation: real inputs, decisive output values and locators, applicable actions and their failure conditions. Use different inputs when they can change the result. Include applicable invalid data, cancellation or unknown delivery; do not require irrelevant scenarios.

Validate actual-shaped private-slot invocation payloads, including a malformed OpenUI input that must fail:

```sh
scholarseed-skill-python -m service.cli.plugins validate ./plugin-source/.scholarseed-plugin.json ./work/request.json
```

Fix the reported path rather than weakening the schema. For a fixed layout, check that two data sets populate the same tree with correctly aligned values and evidence. Verify there is no component JavaScript for that layout or dependency on the shared plugin UI SDK. For an agreed executable workbench, require entry syntax success and applicable submission examples: cover declared actions with preview `responses` and real-shaped `submissions`, not preview-only controls.

Pack and inspect one candidate. Retain its digest and use the same ZIP for preview and installation. Run `check <zip> --check-entries` for external or transferred archives, not as a duplicate check of unchanged output from `pack`.

## Preview and real use

Inspect the first view before scrolling. Check labels, values, evidence, narrow widths, themes, and keyboard and pointer operation where applicable. Preview samples are not real model inputs or actual receipts; if preview is unavailable, mark it unverified.

After user-authorized installation and enablement, run the real generated Skill with fresh data. For fixed OpenUI, verify that the Agent sends business data only, Desktop renders the expected values, and an earlier result retains its own data when reopened. If the workflow depends on a decision or workbench, operate the actual surface: check selection and edit retention, the real receipt, continuation only on success, and the final artifact or export. Check recovery and copy where required; a preview or tool response does not prove the installed workflow worked.

Report creation/package, preview, installation and usage separately. Keep evidence of failures and retest affected steps against the new digest after changes. If a required host action or installation consent is unavailable, record the stage and reason; do not replace it with a fixture.
