<a id="模型服务"></a>
# Model Services

## Target-Version Model-Services Reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows the natural state with no provider configured; does not prove connection, configuration, or invocation. See the [Build Basis](./build.md#202611121823-目标版本参考图) for source and digest.

Target-version model-configuration reference

Reference: same target build, 2026-11-12. Shows the natural configuration for built-in models; does not prove parameter saving, effect, or invocation.

Inspect model connections and model configuration. Entry point: main interface avatar menu → Settings → Model Services (`模型服务`); the page has “服务” (“Services”) and “配置” (“Configuration”) tabs.

![Model services reference](./reference.png)

![Model configuration reference](./configuration.png)

Additional references: [bottom of provider list](./providers.png), [parameter area after horizontal scrolling](./parameters.png). Source: macOS arm64, 0.3.0 / 202610281438, 2026-10-28. Connections, models, tiers, and counts are data from that time, not fixed later values.

<a id="查看连接"></a>
## Inspect Connections

<a id="服务目录model-obs-001--v03"></a>
### Provider Directory (MODEL-OBS-001 · v`0.3`)

Fixed: Page title, description, Services/Configuration tabs, connection search, and Add entry point are clear. Dynamic: Provider/connection names, number of enabled connections, and total list count match the current public provider directory and existing connections; do not hardcode counts. An unconfigured provider may show a not-added state.

<a id="当前详情model-obs-002--v03"></a>
### Current Details (MODEL-OBS-002 · v`0.3`)

Conditional: With no connection selected, the right pane shows guidance to select or add one. When a connection is naturally selected, API details show the corresponding name, address, masked key, and model area; OAuth details show the corresponding subscription connection information. Loading and load failure have corresponding messages and must not be treated as a stable empty state.

<a id="查看配置"></a>
## Inspect Configuration

<a id="模型与参数布局model-obs-003--v03"></a>
### Model and Parameter Layout (MODEL-OBS-003 · v`0.3`)

Fixed: The Configuration tab displays a Save entry point and columns for model name, reasoning effort, visibility, and context window. Dynamic: Model rows correspond to the current available and hidden model directory. Do not bind names/source verbatim to the historical reference image; do not fabricate rows when there are no models.

<a id="能力与当前偏好model-obs-004--v03"></a>
### Capabilities and Current Preferences (MODEL-OBS-004 · v`0.3`)

Dynamic/conditional: For models with selectable reasoning tiers, the displayed value is the effective saved tier; if no valid value is saved, use the model directory's default tier. If there are no selectable tiers, show fixed capability information or information whose exact meaning remains to be confirmed. Built-in models appear visible and cannot be toggled; other model visibility matches the current directory. For context window, inspect only the control entry and scale display; do not treat it as actual model capacity or an effective value.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted normal v`0.3` subcriteria: MODEL-OBS-001–004. This covers only the scope below, not every detail under these IDs.

The main areas for model services and configuration, provider directory/connection counts, and naturally selected current details should match the public directory and authorized minimum configuration fields. Model-row names, reasoning effort, visibility, and context explanation should be discernible; context display does not prove actual capacity.

Required references: check minimum projections for public providers, connections, available/hidden models, and reasoning preferences against the target instance's actual contract. The [old-package read record](build.md#当前制品复核) is only a clue. When no item is selected, verify the original MODEL-OBS-002 natural guidance state.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: adding connections, OAuth/API credentials, connection testing, saving parameter changes, and model invocation. Preserve original full criteria, stable IDs, versions, and historical results; layering does not authorize unconfirmed branches.

<a id="模型配置与生效候选专项"></a>
## Candidate Focused Scenarios for Model Configuration and Effect

The following are historical requirement clues and are not automatically included in the adopted scope for the current target version. Numbers after `@` are historical asset revisions, not product requirement versions. Target-build applicability, requirement version, and adoption remain unconfirmed. The existing display quick review does not prove configuration, saving, or model invocation succeeded.

- **Service configuration and directory (historical `MODEL-CONFIG-01@5`):** Save a specified test service through the real form in an authorized isolated configuration; independently verify the reopened configuration and that the target model appears in the selectable directory. Do not echo the key in plaintext. An empty form or built-in model alone does not prove saving or connection. Real credentials, external endpoints, and connection probes require separate authorization; do not record full keys.
- **Reasoning effort (historical `MODEL-REASONING-01@2`):** On a model supporting selectable options, change and save an authorized tier. Reopen settings and start a new task; verify the same model displays the selected tier in line with an independent saved reference, without changing other models. UI consistency does not prove that the provider accepted the parameter. Model invocation requires separate authorization.
- **Context window (historical `MODEL-CONTEXT-01@2`):** In a disposable isolated configuration, select, save, and reopen a value, then compare the selected value with the state received by the product. A control display or save notice alone does not prove real effect. Whether persistence is supported and whether it applies to the target version remain unconfirmed; do not change this historical candidate based on current implementation or screenshots.
- **Switch model for a conversation (historical `CHAT-MODEL-SWITCH-01@3`):** In an isolated task with two authorized available models, select the target model and observe the model identity of the next real turn against the UI selection. A selector change alone is not success. Requires authorization for model invocation, cost, and task writes; do not preselect model output.

Use a dedicated test account, isolated model configuration, controlled endpoint, and non-secret independent references. Do not copy real user keys or configuration. Synthetic original materials under `examples` may be used as task input, but their presence does not prove connection or an executed turn. Complete real-window screenshots of configuration/reopen and model switching, test endpoint, and permissions are missing; do not substitute existing display images, simulated responses, or prefilled results.
