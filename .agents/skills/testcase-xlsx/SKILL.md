---
name: testcase-xlsx
description: Turn requirements, designs, or bug evidence into traceable manual test cases and generate, extract, and validate an XLSX workbook.
---

# Test Case Workbooks

Read the [case rules](references/generation-rules.md) and [JSON schema guide](references/schema.md). Use JSON as the maintained source and preserve existing case IDs. Map each case to the source rule, describe its preconditions, and give observable outcomes. Mark ambiguous or unread inputs.

From the repository root, run:

```sh
python3 .agents/skills/testcase-xlsx/scripts/build_testcase_xlsx.py --cases <cases.json> --output <cases.xlsx>
python3 .agents/skills/testcase-xlsx/scripts/validate_testcase_xlsx.py --input <cases.xlsx> --expected-count <count>
```

For an existing workbook, use `extract_testcase_json.py --input <cases.xlsx> --output <cases.json>` from the same scripts directory, then edit JSON and rebuild. Store the deliverable at the authorized path and keep temporary output ignored. Automation annotations may point to confirmed project paths and commands. An annotation does not establish that a test ran.
