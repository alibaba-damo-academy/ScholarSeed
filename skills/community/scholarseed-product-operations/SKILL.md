---
name: scholarseed-product-operations
version: "2026.10.29+4"
description: >-
  Access project resources and stored papers,
  PDF evidence and external retrieval, referenced conversation history,
  user-facing file delivery, explicit session-file imports into resource or literature libraries,
  multi-stage conversation plans, and MCP server configuration. Read only the
  relevant operation guide before acting. For file-only transfer/processing, read
  this skill and references/artifacts.md together, not evidence/search/library guides.
  Not for ordinary chat or self-contained
  answers that need none of these capabilities; research alone is not a trigger.
description_zh: >-
  访问项目资料与已存论文、使用 PDF 证据或外部检索、查询历史会话、
  交付文件、按用户要求将会话文件导入资料库或文献库、管理多阶段会话计划、配置 MCP 服务器。操作前仅加载对应指南；普通闲聊和无需这些能力
  的直接回答不加载，科研问题本身不触发。
metadata:
  version: "2026.10.29+4"
---

# Materials and Task Tools — 资料与任务工具

Use this skill to work with project materials, saved papers, conversation history,
file delivery, plans, or MCP settings. Do not load every reference: choose only the relevant rows
below, before accessing materials or starting the operation. A new need later in
the task loads its reference then, not all remaining references.

## Choose the requested operation

File bytes are not research evidence. Downloading supplied links, copying, renaming
or converting files does not by itself require interpreting their content, discovering
sources or managing a library. For file-only work, read this skill and the file-artifacts
guide together and execute the requested operation; do not load retrieval, resource or
plan guides merely because files are papers or PDFs. Do not explore product operations
to find a more elaborate workflow for an already concrete task.

Load `pdf-evidence` when the requested answer needs PDF content, `web-search` when
external evidence discovery or verification is needed, and `project-literature` when
the task actually uses stored literature. Follow the corresponding guide then; mixed
tasks load only the guides needed by their requested parts. File acquisition does not
authorize library imports or bypass current-turn restrictions.

For tasks that may depend on existing materials, prioritize sources relevant to the
question and goal: materials explicitly referenced or specified by the user first,
then related files in the current session, then the current project's resource and
associated literature libraries. Discover and retrieve project materials as needed
without requiring the user to attach each item. Read only relevant content, not the
whole library, and prefer internal evidence that actually supports the answer. This
does not require visiting every source location on every turn. If internal evidence
is insufficient, explain the gap before supplementing it through available external
retrieval under the current turn's permissions. Provide references that lead back to
the sources used; never present bibliography metadata or abstracts as full-text
evidence. Do not search other projects or scan all local files.

### Answering from project sources

Cite only sources relevant to the requested claim, not unrelated materials merely
inspected during discovery. If no relevant internal evidence is found, state the
gap without a source list or links to unrelated files or papers. Do not add an
inventory of checked materials just to provide references.

For each relevant project source used in the answer, include a Markdown link
`[source name](source_url)`, copying the returned `source_url` unchanged.
`resource/read` and `resource/stat` return file navigation URLs;
`literature/detail` returns the bibliography navigation URL and stored abstract.
A plain path, filename, or `literature:<id>` is not a clickable source link.
If you used a filesystem locator, obtain the file's URL with `resource/stat`.
If the question needs only a stored abstract, use `literature/search` then
`literature/detail` instead of PDF `list`/`read`; a missing PDF does not mean
the abstract is missing. Do not scan private state or the project tree to recover it.
Before the final answer, check that each used source has its returned navigation
link; if unavailable, state the limitation rather than calling a path clickable.
Navigation links do not establish PDF full-text evidence.

| Need | Read before acting |
| --- | --- |
| Discover, read, count, or modify project resources; use stored papers or notes | [Project resources](references/resources.md) |
| Interpret a sent/selected/project PDF or retrieve external evidence | [Evidence and retrieval](references/retrieval.md) |
| Answer from earlier or explicitly attached conversations | [Conversation history](references/history.md) |
| Create or deliver a file, or import a session file into a resource or literature library | [File artifacts](references/artifacts.md) |
| Carry out multi-stage work, or continue/close an existing product plan | [Conversation plans](references/plans.md) |
| Inspect, add, remove, enable, disable, or change an MCP tool server | [MCP configuration](references/mcp.md) |

## Product Capabilities

For a requested file deliverable, read the file-artifacts guide and describe
`artifact/publish` before writing the files. After verification, publish each
requested deliverable with its intended role and inspect the successful receipt
before claiming delivery. A Markdown file link or a successful shell write is not
a publication receipt. Do not claim the bridge is unavailable merely because you
have not called it: if the tool is exposed, check its contract and actual result.
If discovery or publication fails, report that concrete failure and leave the
files as unpublished working files; do not invent a registration or a receipt.

Keep file deliverables proportional to the requested task. Once they satisfy the
specified inputs and behavior, verify them, publish them, and finish. Do not delay
delivery to add unrequested discovery heuristics, fallback paths, frameworks, or
speculative refinements; expand only to fix an observed failure of the requested
behavior. An independently reviewable stage deliverable can be verified and
published when ready rather than waiting for optional work on the final files.

Use the `scholarseed_bridge` dynamic tool for product operations. Pass an object with
`capability`, `operation`, and `request`; for example, history listing uses
`{"capability":"history","operation":"list","request":{}}`. It is a model tool,
not a terminal command. Never invoke a similarly named executable, read bridge
credentials from the environment, or put a product operation in a shell script.
Skill examples that name a capability, operation and JSON request describe this
same tool call; the JSON is the `request` field, not a CLI argument.

Before the first call to a product operation, obtain its request contract through
`scholarseed_bridge` with `{"capability":"contract","operation":"describe","request":{"target_capability":"<capability>","target_operation":"<operation>"}}`.
Reuse that operation's contract only while it is visible in the current model context;
after context loss or compaction, describe it again. Fetch only the operation needed
now, not every contract. Examples below illustrate intent, not a complete parameter
schema; use the returned contract and real result identifiers, never guessed fields.
Contract discovery does not grant permission or replace any approval below.

## Ownership and scope

Follow the specialized skill named by the relevant guide when available. Those
skills own their evidence processing and business workflows; this skill owns
only the product access, plan, and delivery contracts. It does not authorize
downloads, publishing unrelated files, or other external actions on its own.

Research interpretation remains in `academic-research-guidance`, not here.
Do not route back to this skill as a research deliverable or force a product
operation solely because a task is research. Simple chat and direct answers
need no product workflow. If a needed skill or tool is unavailable, state the
limitation; do not invent calls, paths, results, or a substitute protocol.
