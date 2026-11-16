<a id="资料库文件"></a>
# Library Files

## Target-Version Library-Files Reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows naturally occurring preferences and version limits; values in the image are dynamic and do not prove that a policy was saved or took effect. See the [Build Basis](./build.md#202611121823-目标版本参考图) for source and digest.

Inspect file-saving preferences and version-retention limits. Entry point: main interface avatar menu → Settings → Library Files (`资料库文件`).

![Library files reference](./reference.png)

Reference image source: macOS arm64, 0.3.0 / 202610281438, 2026-10-28. Switches and limit values reflect settings at that time and are not fixed expectations for later versions.

<a id="查看保存与版本策略"></a>
## Inspect Saving and Version Policies

<a id="保存偏好file-obs-001--v03"></a>
### Save Preferences (FILE-OBS-001 · v`0.3`)

Fixed: The title, explanation, and the Auto Save and Format on Save rows are clear. Dynamic: Each of the two switches corresponds to the client's current save preference; if no preference has been saved, use that version's default.

<a id="保留限制file-obs-002--v03"></a>
### Retention Limits (FILE-OBS-002 · v`0.3`)

Dynamic: The number of retained versions per file, maximum file size, and unit are clear. Values correspond to the current file-version settings in this instance. File size is displayed in MB and converted from the setting in KB. Temporary defaults before settings finish loading are not a final reference.

<a id="说明与可用性file-obs-003--v03"></a>
### Explanation and Availability (FILE-OBS-003 · v`0.3`)

Fixed/conditional: The retention count and size fields have purpose explanations. Values are available after settings load successfully; show failure feedback if loading fails. If the current setting is marked as requiring migration, show a migration notice. Require advanced configuration to appear only when that capability is enabled in the target version; when disabled, do not require an extra configuration area.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted normal v`0.3` subcriteria: FILE-OBS-001–003. This covers only the scope below, not every detail under these IDs.

File policy should display current Auto Save/Format on Save states, version-retention count and size, and their explanations. Values correspond to successfully read settings or declared defaults; the size-unit conversion is correct.

Required reference: check the minimum fields for save preferences and file-version settings against the target instance's actual contract. The [old-package read record](build.md#当前制品复核) is a clue only. Convert size from KB using /1024 and compare to two decimal places after removing unnecessary trailing zeros.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: editing preferences, migration confirmation, retention/cleanup, and the real save lifecycle. Preserve original full criteria, stable IDs, versions, and historical results. Layering does not authorize unconfirmed branches.
