---
name: scholarseed-product-operations
version: "2026.11.13+1"
description: >-
  Use ScholarSeed's Bridge, guide users to supported product destinations, and
  choose official conversation components. Load for project resources and papers,
  PDF evidence and retrieval, session history, file delivery and imports, task
  plans and MCP settings, user-clicked navigation, or when structured display or
  interaction materially improves the result. Load when the user wants to pick
  from displayed options and continue with their choice, even if no card was requested.
  Skip for self-contained text answers and discussion that requires no product operation.
metadata:
  version: "2026.11.13+1"
---

# ScholarSeed Product Operations

Load only the reference needed for the next action. A task may move from one
reference to another; do not preload all three.

| Intent | Open first |
| --- | --- |
| Read or change product state, retrieve evidence, publish files, import into a library, manage plans or MCP | [ScholarSeed Bridge](references/scholarseed-bridge/README.md) |
| Give the user a clickable entry to a source, result, or published file | [ScholarSeed Frontend](references/scholarseed-frontend/README.md) |
| Compare and pick from displayed rows, show a chart or native result card, or edit a task Canvas | [ScholarSeed Chat UI](references/scholarseed-chat-ui/README.md) |

For file-only transfer or processing, read the [file-artifacts guide](references/scholarseed-bridge/guides/artifacts.md)
and the Bridge contract for publication when needed. File bytes are not research
evidence; do not load retrieval or library workflows merely because a file is a PDF.
Use `pdf-evidence` for PDF interpretation, `web-search` for web evidence discovery,
and `project-literature` for stored literature when the relevant workflow calls for it.
Research reasoning belongs to `academic-research-guidance`.

Judge component use from the user's goal and available data, not from mentions of
“card”, “chart”, or a skill name. Do not add a card when a short answer is clearer.
Keep input, progress, clarification, authorization and error recovery in their
native product flows. This skill grants no access or write permission on its own.
