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

<a id="中文摘要"></a>
## Summary

The source repository includes public engineering knowledge and product gates. Development Skills,
internal supplements, work logs, and raw evidence are maintained in the internal source repository.
Split mixed materials by content and consumers rather than applying a blanket directory rule. Daily
development supports independent clones and native worktrees without requiring a parent repository
or documentation SHA. Only release, acceptance, and reproduction records pin exact versions.
Historical projections are intermediate audit material only.
