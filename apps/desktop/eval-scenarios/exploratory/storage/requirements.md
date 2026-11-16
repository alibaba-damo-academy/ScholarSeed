<a id="数据存储"></a>
# Data Storage

<a id="目标版本数据存储参考"></a>
## Target-Version Data Storage Reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows the isolated instance's data root and project root, including the local username and isolated paths. Paths are dynamic values and do not prove migration or modification. See [Build Basis](./build.md#202611121823-目标版本参考图) for source and digest.

Inspect the current data directory and default project location. Entry point: avatar menu (`头像菜单`) → Settings (`设置`) → Data Storage (`数据存储`).

![Data storage reference](./reference.png)

Reference image source: macOS arm64, 0.3.0 / 202610281438, 2026-10-28. Paths are from a synthetic test environment. Confirm platform details and paths against the later target instance; the values shown are not fixed.

<a id="查看路径与生效边界"></a>
## Inspect Paths and Their Effective Scope

<a id="当前数据目录-storage-obs-001-v03"></a>
<a id="当前数据目录storage-obs-001--v03"></a>
### Current Data Directory (STORAGE-OBS-001 · v`0.3`)

Dynamic: The Data Directory section fully displays the data root actually used by the client on this launch and matches an independent launch record. Do not substitute the project directory or application installation directory. Show corresponding loading and read-failure feedback; do not invent a path on failure.

<a id="默认项目位置-storage-obs-002-v03"></a>
<a id="默认项目位置storage-obs-002--v03"></a>
### Default Project Location (STORAGE-OBS-002 · v`0.3`)

Dynamic: The default project location shows the project root configured in this instance. When no location is configured, show the current project root and verify it against an independent project-root setting. Do not treat a configured path as proof that it is effective. Show the change entry point; disable it while the project root is not ready or an operation is in progress.

<a id="存储边界说明-storage-obs-003-v03"></a>
<a id="存储边界说明storage-obs-003--v03"></a>
### Storage Boundary Explanation (STORAGE-OBS-003 · v`0.3`)

Fixed/conditional: Explain that changing the default project location affects only projects created in the future and does not migrate existing projects. Data-root selection and installation/first-launch explanation match the target platform. This run does not change the location and does not require a restart notice that would only be triggered by a change made on this page.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted v`0.3` normal subcriteria: STORAGE-OBS-001–003. This covers only the scope below, not every detail under those IDs.

Storage settings should display the current runtime data directory, default project location, and explanation that the setting applies only to future projects. Verify both paths separately against the startup Owner and the read project-root configuration/fallback reference; do not conflate them with the current project's resource directory.

Required references: verify the target instance's actual contract using the minimum fields for independent startup data root, `storageConfig`, and `workspace-root`. The [old-package read record](build.md#当前制品复核) is only a clue. Check current root and configured separately; do not read directory contents.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: selecting/opening/copying a directory, migration, changing a location, and restarting. Preserve the original full criteria, stable IDs, versions, and historical results. Layer approval does not authorize an unconfirmed branch.
