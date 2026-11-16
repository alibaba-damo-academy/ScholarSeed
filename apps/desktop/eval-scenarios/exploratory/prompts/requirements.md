<a id="ai-提示词"></a>
# AI Prompts

Reference for AI prompts in the target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; shows AI prompts, but does not prove recovery, saving, or a model request. See [build evidence](./build.md#202611121823-目标版本参考图) for the source and digest.

Inspect the prompts used for selection-based AI actions. Entry: main screen avatar menu → 设置 (Settings) → AI 提示词 (AI Prompts).

Confirmed current ownership mapping (2026-11-04): Explain, Polish, and Explain Chart remain under “AI 提示词” (AI Prompts); Translate is in the Prompts area of “翻译配置” (Translation Settings) within the same settings navigation. The four original requirements, stable IDs, and v`0.3` remain. The current read-only quick review gathers evidence from two separate page units as described below; it does not require recreating the old same-page layout. Interpret the old reference image, full text, and frozen runs within their original scope.

![AI prompt reference](./reference.png)

![Prompt bottom reference](./bottom.png)

Reference images from macOS arm64, 0.3.0 / 202610281438, 2026-10-28. Text, character counts, and button state reflect preferences at that time and are not fixed expectations for later versions.

Translation-configuration prompt reference

Translation service list in its collapsed state

Reference: the translation-configuration scrolling viewport from the same target version and date; shows services and their states collapsed at that time, but does not prove service configuration, validation, or a translation request.

The reference image is from an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance and shows the translation-prompt area, length, and recovery entry. Text and state are dynamic values from that time; the image does not prove recovery, saving, or a translation request. See [build evidence](./build.md#202611121823-翻译提示词参考图).

<a id="查看提示词与编辑状态"></a>
## Inspect Prompt and Editing State

<a id="操作分类prompt-obs-001--v03"></a>
### Operation categories (PROMPT-OBS-001 · v`0.3`)
Fixed: The title and purpose description are clear. Explain, Translate, Polish, and Explain Chart each have a separate prompt text area, and the full contents can be viewed by scrolling.

<a id="内容与字数prompt-obs-002--v03"></a>
### Content and character count (PROMPT-OBS-002 · v`0.3`)
Dynamic: Each text area matches its corresponding currently saved prompt, or that version's default prompt if none is configured. The displayed current character count equals the text length, with a limit of 2000.

<a id="初始按钮状态prompt-obs-003--v03"></a>
### Initial button state (PROMPT-OBS-003 · v`0.3`)
Conditional: On entry, before editing, Save is disabled. Each item has a Restore Defaults entry; that entry is disabled when the content already equals that version's default.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoints from v`0.3` are PROMPT-OBS-001–003. This covers only the scope below and does not mean every detail of these IDs passes.

The historical same-page quick-review wording remains: prompt settings should have four input areas—Explain, Translate, Polish, and Explain Chart. Current content and its character count, the Save button state when unmodified, and the Restore Defaults state should match the read values. Scroll when needed; do not enter text. New runs use the same original criteria according to the confirmed mapping below; do not rewrite old runs.

| Current page unit | Mapping to original IDs and selected subpoints only |
| --- | --- |
| prompts (AI Prompts) | Three separate Explain/Polish/Explain Chart areas under PROMPT-OBS-001; the current values of those three fields, target-default fallback, JavaScript string length, and the displayed limit of 2000 under 002; initial Save-disabled state and each Restore Defaults state under 003. |
| translation-prompts (prompt area in Translation Configuration) | Separate Translate area under PROMPT-OBS-001; current `translate` value, target-default fallback, JavaScript string length, and displayed limit of 2000 under 002; Restore Defaults entry and its state based on current value under 003. The old explicit-save-button condition does not map to a requirement that this page have a button; an auto-save notice is not evidence of successful saving. Save behavior remains a specialty. |

One prompts asset maps to two physical page units. Do not remove any of the four fields or duplicate them as a second criteria set. Record observations and conclusions separately for each page; evidence from the AI page cannot fill in missing translation-page evidence. Only read-only scrolling or reading `textarea.value` is allowed. Do not type, clear, paste, restore defaults, or click Save. Translation services, switches, languages, credentials, and translation requests are outside this mapped quick review.

Required reference: check the target instance's actual contract for the four-field `selectionPrompts` allowlist, target-package default text, and independent JavaScript string-length count. Retain the [confirmed current ownership mapping](build.md#已确认当前承载映射2026-11-04); historical read methods are clues only. If the startup snapshot may be stale, record a gap in the content reference. Compare each page with its corresponding field; do not infer the saved value from the screen.

<a id="专项层"></a>
## Specialized Layer

<a id="翻译服务与划词偏好translation-config-cand-001需求版本待确认"></a>
### Translation service and text-selection preferences (`TRANSLATION-CONFIG-CAND-001`; requirements version to be confirmed)

Historical user requirements and mock design cover choosing the default translation service, a translate-on-PDF-text-selection switch, and retaining the selection while disabling the switch when the toolbar is closed. Later observations were made in a real macOS development instance; applicability to the target package, requirements version, and real service semantics remain unconfirmed. Do not treat the mock's service-validation strategy or historical defaults as target criteria. Use the isolated instance's public configuration, available services, and toolbar state as independent references. Preference writes, credentials, network access, and translation requests each require separate authorization. A display or single snapshot does not prove that saving took effect. This candidate is separate from the translation-prompt quick review.

Not selected in this layer: editing, length boundaries, restoring defaults, and saving. The original full criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved by layering.

That translation text is saved directly by `onChange` is an implementation fact. It does not authorize or prove automatic saving under the read-only mapping. The old save condition and real translation-saving lifecycle were not accepted by this quick review; a “Saved” message is not a substitute. Translation requests and product-model costs are also outside this authorization.
