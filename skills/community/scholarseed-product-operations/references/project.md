# Project Work

**English** · [简体中文](project.zh.md)

Use this guide before changing project files, running tests or maintaining a
repository. It grants no write, execution, network or release permission.
For code explanation without execution or changes, answer directly.

## Inspect Before Editing

Read the applicable project instructions and the relevant current source.
For Git work, inspect the branch, status and relevant diff; preserve unrelated
tracked, staged and untracked changes. Use history or blame only when needed
to understand the affected behavior. Do not commit, create branches, push,
revert, reset or clean without the corresponding authorization and project rules.

Identify the owning component and fix the cause rather than suppressing errors,
removing features or weakening tests. Make focused changes consistent with the
project's style, dependencies and architecture. Follow project conventions for
comments and naming; do not impose arbitrary global prohibitions. Do not add
license or copyright headers unless requested. Use a declared patch tool for
text edits when available, with its actual schema. Do not reread an unchanged
whole file just to confirm a successful patch; inspect relevant diffs and verify
the affected behavior instead.

Before executing code or installing dependencies, read the
[execution environment](execution.md) guide. A project edit does not authorize
changing the user's global environment, deleting data or broad dependency upgrades.

## Verify the Affected Result

Use the project's existing test/build/format commands and authorization rules.
Start with checks closest to the change, then expand when the impact warrants it.
Add focused regression coverage where the project already has an appropriate
test pattern; do not introduce a new testing or formatting framework incidentally.
Update affected documentation when behavior changes. Do not reformat unrelated
files or fix unrelated baseline failures merely to get a green result.

Distinguish contract tests, integration checks and real user-flow acceptance.
Report actual commands, failures and unverified prerequisites; static checks do
not prove runtime behavior. If verification requires a model call, external
service, installation or destructive operation, establish its authorization
before running it. Do not assume an approval mode itself authorizes those actions.

## Deliver

Review the final diff and summarize the change, verification and remaining gaps.
For source locations, name the actual project-relative file and put any line
number in the label when using a clickable session-file link, not its target.
Do not fabricate clickable files or apply CLI line-suffix syntax to product links.
User-facing file deliverables follow the [file-artifacts guide](scholarseed-bridge/guides/artifacts.md);
an incidental source edit is not automatically a published deliverable.
