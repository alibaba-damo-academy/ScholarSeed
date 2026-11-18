---
name: scholarseed-product-operations
version: "2026.11.17+2"
description: >-
  Use ScholarSeed product operations, conversation components, local code execution
  and project edits. Covers resources/PDFs, retrieval, history, delivery/imports,
  plans, MCP, webpages and permission recovery. Load for choosing displayed rows,
  even if no card was requested. Skip for self-contained text answers and feature discussion.
metadata:
  version: "2026.11.17+2"
---

# ScholarSeed Product Operations

**English** · [简体中文](SKILL.zh.md)

Load only the reference needed for the next action. Do not preload all linked guides.
Read one language version, not both.
Reuse unchanged guidance still in context; reread after change or context loss.
Do not load Bridge merely to run local code or use the native plan tool.

| Intent | Read directly |
| --- | --- |
| Run code or install dependencies, including research/data work | [Execution](references/execution.md) |
| Edit project files, test or maintain a repository | [Project](references/project.md) |
| Recover a denied tool call | [Recovery](references/recovery.md) |
| Read/manage project resources | [Resources](references/scholarseed-bridge/guides/resources.md) |
| Interpret PDFs or retrieve evidence | [Evidence](references/scholarseed-bridge/guides/retrieval.md) |
| Read earlier/attached conversations | [History](references/scholarseed-bridge/guides/history.md) |
| Transfer/process/publish files or directories | [Artifacts](references/scholarseed-bridge/guides/artifacts.md) |
| Explicitly import into a library | [Imports](references/scholarseed-bridge/guides/imports.md) |
| Manage a product plan | [Plans](references/scholarseed-bridge/guides/plans.md) |
| Inspect/change MCP servers | [MCP](references/scholarseed-bridge/guides/mcp.md) |
| Open a webpage, including external-browser requests | [Browser](references/scholarseed-bridge/guides/browser.md) |
| Provide a clickable source/result/file entry | [Links](references/scholarseed-frontend/README.md) |
| Use native artifact previews or the workbench | [Workbench](references/scholarseed-chat-ui/guides/workbench.md) |
| Show ordinary charts or tables | [Display](references/scholarseed-chat-ui/guides/conversation.md) |
| Let the user pick rows and continue | [Selection](references/scholarseed-chat-ui/guides/selection.md) |
| Create/edit a task Canvas | [Canvas](references/scholarseed-chat-ui/guides/canvas.md) |
| Author an executable custom card/plugin | [Authoring](references/scholarseed-chat-ui/guides/authoring.md) |

Before a Bridge call, read its short [protocol](references/scholarseed-bridge/README.md)
once and only the selected operation contract. For an unclear UI choice use the
[UI chooser](references/scholarseed-chat-ui/README.md), not every UI guide.

For file-only transfer or processing, use the artifacts guide; File bytes are not
research evidence. Do not load retrieval or library workflows just because a file
is a PDF. Evidence tasks route to `pdf-evidence`, `web-search` or `project-literature`;
research reasoning remains with `academic-research-guidance`.
Use text when clearer. Input, progress, clarification, authorization and recovery
remain native product flows. This skill grants no access or write permission.
