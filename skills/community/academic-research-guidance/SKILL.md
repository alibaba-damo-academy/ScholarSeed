---
name: academic-research-guidance
description: >-
  Guide academic and scientific research requests: scholarly concepts, paper
  understanding, research questions, research methods, experimental design,
  and academic evidence analysis across natural sciences, engineering,
  humanities, and social sciences. Clarify unresolved intent and route to
  specialized research skills. Not for ordinary coding, writing, file management,
  or product operations without a research objective.
description_zh: >-
  科研任务指导：适用于学术概念解释、论文理解、研究问题、研究方法、实验设计和
  学术证据分析，覆盖自然科学、工程、人文与社会科学。澄清未明确的科研意图并衔接
  专项科研技能；不用于没有科研目标的普通编程、写作、文件管理或产品操作。
metadata:
  version: "2026.9.29"
---

# Academic Research Guidance — 科研任务指导

Apply this skill to the research portion of the current request, not unrelated
tasks merely sharing its vocabulary or tools. Inspect relevant user-provided
materials and prior answers before deciding anything is missing.

## Choose the appropriate depth

- For precise literature retrieval, read and follow the
  `precise-literature-search` skill's clarification and confirmation contract
  **before** any general clarification loop. Do not run both loops or bypass its
  mandatory start confirmation.
- For research tasks needing intent clarification or selection among specialized
  capabilities, read [Research intent clarification and routing](references/clarification.md).
  A fully specified request requires no extra questions. Preserve all stated
  constraints and previous answers; do not ask again merely because a skill changed.
- For a clear research concept explanation or other explicit deliverable not
  covered by a specialized skill, answer directly. Do not force literature
  retrieval, a multi-stage workflow, or clarification simply because it is research.
- Before presenting key research conclusions, read
  [Research conclusions and evidence](references/evidence.md).
  Apply these rules to substantive research claims, not to greetings or questions.

## Respect task ownership

This skill supplies shared research guidance, not a research deliverable or a
mode option. Never select it again as a routing destination. Determine matching
task skills from their available descriptions and actual scope; use general
capabilities only when no available task skill covers the explicit deliverable.

The selected task skill owns its stages, modes, checkpoints, authorizations,
and recovery. Intent clarification is not authorization to start, download,
or publish. Do not reproduce or override those protocols here.

Keep internal classification and routing reasoning private, while still explaining
evidence limits and any user-facing execution modes, costs, or confirmations the
task skill requires. Follow the host's current search restrictions; loading this
skill does not authorize external retrieval.

When the user switches to a nonresearch task, stop applying research-specific
clarification and conclusion formatting. Previously read text may remain in the
conversation history; its presence does not make unrelated tasks research.
