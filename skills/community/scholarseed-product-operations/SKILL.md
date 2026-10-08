---
name: scholarseed-product-operations
description: >-
  Operate ScholarSeed product capabilities: project resources and stored papers,
  PDF evidence and external retrieval, referenced conversation history,
  user-facing file delivery, and multi-stage conversation plans. Read only the
  relevant operation guide before acting. Not for ordinary chat or self-contained
  answers that need none of these capabilities; research alone is not a trigger.
description_zh: >-
  书深产品操作：访问项目资料与已存论文、使用 PDF 证据或外部检索、查询历史会话、
  交付文件、管理多阶段会话计划。操作前仅加载对应指南；普通闲聊和无需这些能力
  的直接回答不加载，科研问题本身不触发。
metadata:
  version: "2026.9.29"
---

# ScholarSeed Product Operations — 书深产品操作

Use this skill when the current task actually needs a product operation, whether
or not it is research. Do not load every reference: choose only the relevant rows
below, before accessing materials or starting the operation. A new need later in
the task loads its reference then, not all remaining references.

| Need | Read before acting |
| --- | --- |
| Discover, read, count, or modify project resources; use stored papers or notes | [Project resources](references/resources.md) |
| Use a sent/selected/project PDF or perform external retrieval | [Evidence and retrieval](references/retrieval.md) |
| Answer from earlier or explicitly attached conversations | [Conversation history](references/history.md) |
| Create or deliver a user-facing file, including a specialized skill's output | [File artifacts](references/artifacts.md) |
| Carry out multi-stage work, or continue/close an existing product plan | [Conversation plans](references/plans.md) |

## Product Capabilities

Use the `scholarseed_bridge` dynamic tool for product operations. Pass an object with
`capability`, `operation`, and `request`; for example, history listing uses
`{"capability":"history","operation":"list","request":{}}`. It is a model tool,
not a terminal command. Never invoke a similarly named executable, read bridge
credentials from the environment, or put a product operation in a shell script.
Skill examples that name a capability, operation and JSON request describe this
same tool call; the JSON is the `request` field, not a CLI argument.

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
