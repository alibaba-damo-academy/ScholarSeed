# Repository and knowledge boundaries

The product repository owns executable code, global and local `AGENTS.md`,
architecture/interface contracts, durable design decisions, contribution guidance, and their gates.
An independent clone or native Git worktree must support public development, testing, build and review
without accessing a private parent, internal service or private document revision.

Private supplements own development workflow Skills, internal-system integrations, organization/personal information,
private approval/delivery processes, work logs and raw evidence. Mixed material must be split by meaning and
consumers, not by a blanket rule for every `docs/`, `AGENTS.md` or Skill. General knowledge has one
maintained source; optional private supplements reference it rather than duplicating its rules.

Requirements use stable IDs, revisions and implementation status. Architecture contracts change with
their mechanisms. Routine work does not pair every code version with a whole documentation repository.
Release, acceptance and reproduction records identify the exact product SHA, relevant document/tool
revisions and artifacts. A submodule may capture a reproducible release, but is not a daily worktree manager.

Historical projections and their author/date/message/parent mappings are audit records, not evidence
that the publication boundary is safe. Forward corrections preserve existing commits; do not rewrite
shared history or merge unreviewed private document history into a public branch. Publication requires
content, dependency and historical review independently of a successful internal push.

## 中文摘要

源码仓自带公开工程知识和产品门禁；开发 Skill、内部补充、工作日志和原始证据由内源仓维护。
按内容及消费者拆分混合材料，不按目录一刀切。日常开发支持独立克隆与原生 worktree，
不强制绑定父仓或文档 SHA；发布、验收及复现记录才绑定精确版本。历史投影只是中间审计材料。
