<a id="共享示例项目"></a>
# Shared Example Projects

This directory stores rebuildable raw inputs shared by PDFE, automated tests, and evaluations. It does not store databases, credentials, runtime workspaces, reference answers, or screenshots. See [Shared Example Design](../docs/architecture/examples.md) for principles and boundaries.

<a id="当前入口"></a>
## Current Entry Points

- `defaultProjectId` in `manifest.json` is the sole source of truth for the default project; the README is not parsed.
- `projects/research/project.json` describes the base project. Its three files are synthetic inputs, not execution results. `sample.md` and `sample.ts` were migrated verbatim from the original evaluation inputs, preserving their original digests.
- `projects/evaluation/project.json` groups synthetic raw materials used by quick evaluations. They are copied byte-for-byte from reviewed repository samples and their digests are checked; this does not change the default `research` project or historically frozen inputs.
- `projects/connector-preview/project.json` stores synthetic input for connector JSON previews. Validate and read it through `resolveExample({ projectId: 'connector-preview' })` and `readExampleFile`, then copy it manually to an authorized isolated instance. A `.invalid` address does not represent an available service. This does not automatically create a project, save a connector, or initiate a connection; confirm the side effects of reading configuration before previewing.
- `projects/browser-navigation/project.json` registers two synthetic web pages with no external resources, solely to prepare browser navigation and search. The files do not serve a site or prove that the target product is accessible or that browsing history was created.
- `projects/skill-import/project.json` registers a synthetic `SKILL.md` for focused skill-import work. Read the file as manual import input; it does not automatically prepare a project, install a skill, or call a model. Before importing, verify the isolated target, name conflicts, and authorization.
- `projects/literature-ris/project.json` registers synthetic RIS records for focused literature-import work. They are only raw inputs confirmed manually; they do not automatically import records or generate a literature library. Before importing, verify the isolated target and authorization.
- `projects/pdf-multipage/project.json` registers a ten-page synthetic PDF input for multipage reading and search. The sample is not a product result. Import requires manual confirmation and verification of the isolated target and authorization.
- `projects/pdf-image-only/project.json` registers a single-page synthetic image-only PDF with no text layer, to prepare a focused scenario. It does not promise OCR or product search results. Import requires manual confirmation and verification of the isolated target and authorization.
- `projects/image-secondary/project.json` registers a synthetic image distinguishable from images in the evaluation project. It is raw input only; file selection must be confirmed manually, and no draft is generated or sent automatically.
- `projects/resource-conflict/project.json` registers two same-name inputs with different contents for a resource-conflict scenario. They are used separately to prepare the isolated target's initial state and a later import confirmed manually; the sample does not preconfigure a conflict or product result.
- `projects/resource-pagination/project.json` registers 101 synthetic files at one level for preparing a resource-tree pagination scenario. The preparation tool has not actually run this project yet; manual import and product operations each require authorization.
- `projects/empty-document/project.json` registers a zero-byte Markdown raw input for preparing a scenario that saves an empty document with a path. File existence does not mean it has been imported, edited, or saved; each related operation requires separate authorization.
- `projects/table-long/project.json` registers a synthetic CSV with 120 rows and 12 columns for preparing a grid-positioning scenario. The file is not a product result; import requires manual confirmation and verification of the isolated target and authorization.
- `workspaces/empty.json` explicitly defines zero projects. `workspaces/pair.json` creates two logical instances by reusing a template.
- `workspaces/scope-pair.json` references two different synthetic projects, `research` and `evaluation`, to prepare cross-project scope checks. Creating isolated instances and verifying switches each require separate authorization.
- Public read capabilities are in `scripts/shared/examples.cjs`. `resolveExample()` selects the default project; `resolveExample({ workspaceId: 'pair' })` selects a recipe; `readExampleFile(file)` revalidates and returns bytes.

Returned manifests are immutable, and `contentDigest` does not include the local source directory. Projects and files are located by `key` and `id`. Absolute `sourcePath` and `sourceRoot` are used only for reads on the current machine and must not be persisted in another machine's configuration. `expectedDigest` rejects changes to frozen inputs; it cannot automatically restore old files.

<a id="评测使用"></a>
## Evaluation Use

When an evaluation needs project materials, follow the [Evaluation Procedure](../apps/desktop/docs/architecture/evaluation.md) and call `prepareExample` from `scripts/shared/preparation.cjs` with `resolveExample({ projectId: 'evaluation' })` and the public manifest. Do not hand-write project or file manifests. First verify the real target API base URL, task-isolated workspace, and authorization for this run; freeze the content digest, then prepare once. API/directory matching checks do not replace verifying instance ownership before the call.

The `empty` recipe verifies the real registration by querying the public project directory with `includeArchived=true`. It is ready only when the directory format, project identity, and workspace are valid and there are no project entities. Any existing default or archived project is an explicit failure; do not delete, archive, or hide a project to manufacture an empty state. The default project and `pair` recipe add only their corresponding entities and make no promise about the workspace's total project count; other existing projects remain unchanged.

The receipt maps template keys/file IDs to real project IDs and product-returned material paths. Preparation proves only that raw inputs are ready, not that the evaluation passed. The first search-to-open-Markdown sequence is performed through the real UI; preparation does not search or open anything beforehand. On failure, preserve the partial receipt and first error; do not automatically retry creation. Keep full raw identity and independent criteria on the control side; the Driver receives only the task locator it needs. Static wiring is not proof of an actual Skill call or native acceptance; check the development plan for actual results. The preparation tool uses official project and material APIs to prepare and read back text and integrity-checked binary inputs; this does not replace import-feature testing, which requires manual focused confirmation. Having original RIS records in the materials library does not mean they have been imported into the literature center.

<a id="状态与维护"></a>
## Status and Maintenance

Basic parsing, integrity checks, and empty/pair recipes are implemented. Local PDFE, the real project API/E2E, and the specified search evaluation chain have consumed the same inputs. See the [development plan](../work-records/proposals/2026-11-02/examples/plan.md) for exact versions, screenshots, and limitations. This task was explicitly limited by the user to local acceptance; other runtime computers and Windows have not been verified, and compatibility must not be inferred from local results. Remote asset retrieval, task generation, and historical recovery services are not implemented; unknown fields or capabilities do not silently degrade.

After changing materials, use the public `fileMetadata(path)` to generate size and digest, then update the corresponding revision and necessary references. Do not remove integrity checks. Input identity must also be bound to the repository commit and uncommitted changes; a digest cannot restore the original file. Verify independence from the default source directory, instance isolation, and actual consumption, not just JSON structure.

Focused contract test, run from the repository root: `node --test scripts/shared/__tests__/examples.test.cjs`. The public module itself does not create product projects, write raw inputs, start programs, or access the network; production entry points must not import it.
