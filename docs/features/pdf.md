# PDF 文字选区与标注几何

修改 PDF 阅读器的拖选、标注投影或导出时读取本页；这是当前实现的边界说明，不是历史验收记录。选区加入对话的来源和写回权限另见[选区知识](selections.md)。

## 当前机制与理由

- 根据标注生成笔记时，笔记面板通过 SSE 接收写作正文预览；预览沿用现有 Markdown 投影并隐藏各段末尾的来源标记，不展示编排消息。每段可绑定多个来源，来源可跨段复用；模型不再另写编号来源表。生成中的正文不落库，完整正文按下文“正文优先试验”保存，来源失败提示待核对；生成失败仍保留明确标识为未保存的预览。预览跟随文献身份，切换面板不丢失当前进度。 / Annotation-to-note generation streams the existing Markdown preview into the notes panel, hiding paragraph-local provenance markers and orchestration messages. Each paragraph can bind multiple sources, which can be reused across paragraphs; the model no longer writes a separately numbered source table. Previews are not persisted; completed text follows the text-first trial below, with a notice for unverified provenance. Generation failures retain an explicitly unsaved preview, and panel switches preserve progress for the same literature item.
- 根据标注生成笔记的正文写作采用低延迟策略，按模型能力关闭可切换的思考；编排调用不强制覆盖思考档位。普通聊天设置保持独立。 / Note writing uses the low-latency generation policy, disabling toggleable thinking where declared by the model; orchestration does not force a reasoning-effort override. Ordinary chat settings remain independent.
- [Page](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx) 使用安装版本的 PDF.js `TextLayerBuilder`，并在页面换代或卸载时取消渲染、事件和文字层。文字层的 `endOfContent` 选择边界由 [PDF 集成样式](../../apps/desktop/src/renderer/src/features/workbench/pdf/pdf.css) 保持；只用裸 TextLayer 曾使跨行拖选落到文字层根节点并带入前文。不要为调整外观移除该选择边界。
- [geometry](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.ts) 的 `selectionRectangles` 只采集被选文字节点范围，因为对整段 `Range` 调用 `getClientRects()` 还会包含外围 span。`PdfDocument` 再裁剪到页面并归一化四边形；`normalizeQuads` 只合并同一行重叠或相邻片段，不填满跨列空白。
- [外部链接](../../apps/desktop/src/renderer/src/features/workbench/pdf/links.ts)仅将 PDF `Link` 注释中有效的 HTTP(S) URL 与有限数值矩形转换为页面命中区；[Page](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx)通过 `openExternal` 打开系统浏览器，不把任意 PDF URI 直接交给外部程序。内部目录与页内目标由[导航解析](../../apps/desktop/src/renderer/src/features/workbench/pdf/navigation.ts)单独处理，勿混用外链路径。
- [导航侧栏](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)复用 `ResizablePanel`，当前宽度下界为 190px、上界为 360px；[目录项](../../apps/desktop/src/renderer/src/features/workbench/pdf/Outline.tsx)单行省略，实际溢出时经 `EllipsisText` 显示完整提示，不可跳转项仍可悬浮查看。查找使用软换行 `Textarea`，仅在查找框聚焦时由快捷键处理 Enter / Shift+Enter 前后匹配，侧栏与结果列表禁止横向溢出。旧方案中的 160px 下界不是现行约束。
- [滚轮缩放](../../apps/desktop/src/renderer/src/features/workbench/pdf/zoom.ts)仅在 Ctrl/Command 修饰时接管 PDF 视口滚轮，普通滚动仍归页面；`PdfDocument` 将有限增量合并到动画帧并记住指针所指页面坐标，缩放后恢复相同锚点。改动需同时核对触控板细粒度输入、缩放边界和锚点稳定性。
- [标注投影](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.ts)按创建时间与 ID 稳定排序，同样式的新标注只在可见投影中遮盖旧标注重叠区域，保存记录不删除；渲染与命中复用这一投影，删除新标注后旧标注可恢复。[高亮视觉层](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx)单独使用 `mix-blend-darken` 保持文字字形清晰，不把该混合模式施加到命中层。
- [阅读 AI 状态](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx)以选区内容建立身份；新选区出现时，同时清空解释面板的展开状态、补充说明草稿和旧选区快照，避免把前一次划词要求带入下一次。通用资料选区建议另由 [Workbench 选区 Owner](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx)在未固定且发生外部指针操作时关闭；不要将“输入仍有焦点”当成保留旧浮窗的依据。
- 浮窗能力按实际入口区分：[通用选区建议](../../apps/desktop/src/renderer/src/features/resources/Suggestion.tsx)的翻译/解释结果接有 Pin，固定只保留该建议的生命周期，不恢复已取消的选区；[PDF Reading 结果窗](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx)复用可拖动的 `FloatingWindow`，但当前没有传入 `onPinnedChange`，因此不能沿用旧记录的“所有 PDF AI 浮窗可 Pin”结论。[PDF 契约](../../apps/desktop/src/renderer/src/features/workbench/pdf.test.ts)明确锁定这一差异。结果写批注时使用已完成结果的页、文字和 quads，缺失几何时才回退当前请求快照，不重新读取 DOM 选区；改动须核对来源身份与保存冲突。
- 同一标注的几何归一化还用于 [PDF 导出](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.ts)；变更重叠策略时分别核对显示、命中、保存和导出，而不是只看一种颜色的截图。
- [项目记录 Owner](../../apps/serve/service/workbench/service/records.py)与[文献附件入口](../../apps/serve/service/literature/api/reading.py)首次读取内嵌记录，并由[原生标注解析](../../apps/serve/service/platform/annotations.py)补入 Highlight、Underline、StrikeOut、Squiggly、Text 和 FreeText。文字按 QuadPoints 内的字符中心提取，坐标转换包含 CropBox 与旋转；评论只按显式 IRT 关联。已有记录通过 revision/CAS 补识别一次，保留 `native_annotations` 来源描述，即使用户清空标注也不重新导入。复制到项目仍遵守 `copy_records`。 / Both record owners reconcile embedded records and native PDF reading annotations. Per-quad text, crop/rotation geometry and explicit reply links are preserved. Revision-guarded backfill retains source descriptors through edits and deletions; explicit copy policy still applies.
- 无效内嵌 JSON、schema 或关联记录写警告并被忽略；独立有效的原生标注仍可读取。纯扫描、压平到正文的颜色或无文字层标记不会凭空生成摘录，几何标记没有摘录或评论时不能用于生成笔记。 / Invalid embedded records are logged and ignored independently of valid native annotations. Flattened paint and scanned marks do not create invented excerpts; geometry without text or comments is ineligible for note generation.
- [PDF 导出恢复](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.ts)仅在内存中移除与来源描述匹配的原生标注及 Popup，以及与内嵌记录完整绘制指令和图形状态匹配的末尾书深标注流。未知标注、链接、正文和磁盘源文件保留；导出逆变换裁剪/旋转坐标，重复导出不能叠加旧着色。 / Viewer and export restoration remove only matched native annotations/popups and exactly matched ScholarSeed paint in memory. Links, unmatched annotations, source content and original files remain intact; export applies inverse crop/rotation transforms and avoids accumulated paint.

## Selection translation / 划词翻译

- **current**: A selection translation freezes the document revision, selected text and geometry, effective model, language choice and attempt identity. Preview, completed text, copy and annotation use that snapshot. A new selection invalidates the previous selection's display eligibility; historical results cannot become a new attempt's result. Changing configuration keeps the old translation explicitly labelled with its applied language until refresh.
- **current**：划词翻译固定文档修订、选区文字与几何、实际模型、语言配置和尝试身份，预览、完成正文、复制与批注共用该快照。新选区使旧选区失去展示资格，历史结果不能冒充新尝试的结果。改配置但未刷新时，明确标示保留旧译文的实际语言。
- **current**: The selection result must cover the selected source. The service checks the declared target and rejects clear Chinese/English body contradictions while preserving identifiers, names, necessary terms and same-language content. This is a bounded contradiction check, not general language identification or a guarantee of translation quality; it does not classify a bibliography by its overall character ratio.
- **current**：选区译文必须覆盖所选原文；服务端核对声明目标并拒绝可确定的中英文正文违约，同时保留引用标识、人名、必要术语与同语言内容。这是有界的矛盾检查，不是通用语言识别或译文质量保证，也不以整条参考文献的字符比例判定语言。
- **current**: A target-language failure permits at most one correction with the original source, target and model. The existing invocation store keeps rejected provider attempts separately from the logical task's validated result. A second failure remains an explicit failure and cannot be copied or published as a completed translation. Correction success is disclosed in the result window; the service never silently switches model or translation provider.
- **current**：目标语言违约最多允许一次纠正，固定原文、目标和模型；既有调用记录将被拒绝的模型尝试与逻辑任务的有效结果分别保留。再次失败时明确报错，不能复制或发布为完成译文；纠正成功在结果窗告知，不静默切换模型或翻译服务。

## 自动图表与公式框

- 阅读器交互框由 [regions](../../apps/desktop/src/renderer/src/features/workbench/pdf/regions.ts) 持有。成功完成画布渲染后，使用 PDF.js `getOperatorList` 的绘制路径边界、仿射变换和 `imageCoordinates` 的独立图片实例，结合该页文字几何归组；不再从后端 manifest 加载交互框。操作级 `recordedBBoxes` 会把依赖和后续操作的范围累积到操作上，并且其容量不一定覆盖完整 operator list，不能当作独立对象边界。
- 归组先建立绘图连通组件，再按正文、图注、页眉分隔线限制相邻标签归属。矢量字形标签同样参与近邻归属；重复对齐的着色行识别为表格，按行带吸纳完整单元格和紧邻的着色标题。公式以展示行和数学关系为候选，合入上下标与编号，不吞同一行的正文片段。不使用固定放大框或案例页码规则。
- **current**：有表题、至少三条同宽对齐横线、重复多行且多列对齐的表格独立识别，不依赖着色块。完整横线边界封闭，不再按标签邻接扩展到表题或后续章节；仅有表题、横线或多栏文字均不足以给框。着色行表格还要求相邻行支持，带流程箭头的框图不按着色表格归类。
- **current**：字体 ascent/descent 非有限时使用有限度量回退，进入归组和输出的几何均检查有限性。公式拒绝列表、代码及明显正文，非编号展示行还需局部栏居中；短公式额外需要数学关系及上下留白，页眉分隔线另一侧不计作同块正文。不降低全局宽度或归组距离；不满足完整性或归属要求时省略候选。
- 显示、命中与操作复用同一 `PdfVisualRegion`。复制将四边形传到现有文献/资料裁图入口；入口仍先验证项目/附件访问权与源 revision，再验证有限、合法的页内坐标。解释和公式识别传递同一框转换出的 `rect`，不传后端 `region_id`，避免服务端重新选取旧框。
- 后端 layout/extraction 继续持有正文提取、引用和正文排除政策。交互框上的 `text_policy: retain` 不是正文排除规则；扩大图表命中范围不能改变正文索引。既有 manifest API 保留为后端索引投影，不是阅读器的第二套选框真源。
- **gap**：任意 PDF 语义无法仅靠几何保证。可选内容标记中的矢量路径保守不作为独立种子，曲线裁剪仅采用外接矩形；复杂透明组、非矩形裁剪和文字不对齐的无边框表仍需要真实样本回归。归组正确性、真实复制和模型解释分别验收，几何探针不代表真实 Desktop 验收或全量准确率提升。
- **gap**：无表题、缺少闭合横线、跨页或列结构证据不足的表格，以及混有解释文字的无编号多行公式，保守不保证识别。样本检查只能说明已检查页的结果，不能证明任意论文零误报。

## 验证边界

[记录契约](../../apps/serve/tests/contract_pdf_records.py)与[附件导入契约](../../apps/serve/tests/contract_attachment_import.py)覆盖首次初始化、已有记录与复制边界；运行入口按[Serve 测试路径约束](../runbooks/development.md#按改动选择命令与证据)选择，根目录和 `apps/serve` 的同名 `tests` 包不能混用。[几何测试](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.test.ts)、[文字层渲染测试](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.render.test.ts)与[导出测试](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.test.ts)覆盖各自契约。拖选抖动、跨行/上下标、两库标注重开、导出内容和工具栏仍须用当前构建的真实 Desktop 与代表性 PDF 验收；旧工作记录中的截图和通过数不能证明当前版本或 Windows 已通过。


## Paragraph sources in generated notes / 生成笔记的段落来源

Generated note text stays plain Markdown. The literature note stores a separate
JSON provenance field derived from the accepted source map and frozen selection.
Preview attaches existing source controls after each uniquely matching paragraph;
source identities can be reused across paragraphs. Changed or ambiguous paragraphs
show a warning and do not receive stale controls. Existing manually attached source
links remain readable. Markdown export contains only the note text; this change
does not add a sidecar download to the export dialog. The annotation note writer
requests disabled thinking through declared provider controls; unsupported controls
still follow the existing model capability policy.

生成笔记的正文保持纯 Markdown，来源关系由文献笔记的独立 JSON 字段保存，依据验收后的
来源表和冻结的所选标注解析。预览在唯一匹配的段落后显示现有来源按钮，同一来源可用于
多个段落。已修改或无法唯一匹配的段落显示提示，不沿用失效关联。已有手动插入的来源
链接仍可读取。Markdown 导出只包含正文，本次不增加配套 JSON 的下载入口。标注笔记
写作通过供应商声明的控制请求关闭思考；不支持的控制仍遵循既有模型能力策略。

- 生成输入优先呈现完整标注与评论，相关原文保留上下文索引。来源验收由本地代码判定：有阅读信号却完全没有显式关联时拒绝来源验收，但下文试验仍保留正文；部分遗漏允许保存，并在预览末尾直接展示“已获取但未使用”的溯源按钮。未关联来源不会追加到 Markdown 或冒充段落溯源。 / Generation input presents full marks and comments first, with indexed paper context. Local provenance acceptance rejects outputs with no explicit reading-signal references when signals were supplied; the text-first trial below still retains their text; partial coverage may be saved, with directly visible “captured but unused” source buttons at the end of the preview. Unreferenced sources are never appended to Markdown or presented as paragraph provenance.

- 无摘录文本的标记以独立定位来源保留，与其评论身份分开；输入快照和回查共用来源枚举，避免引用合法定位标记时保存失败。 / Marks without extracted text retain distinct location sources, separate from their comments. Input snapshots and source resolution share source enumeration so valid location references remain saveable.

## Text-first trial / 正文优先试验

The annotation-note host enables `writing.py accept --preserve-text`. Completed
nonempty Markdown is retained verbatim as `note.raw.md`. When source validation
fails or a valid source map is unavailable, the app saves that original text with
an unverified-provenance notice; raw source markers remain visible. Validated
results keep the existing clean text and paragraph source controls. Partial model
responses, changed input bindings, and persistence failures are not accepted.
The strict writer mode remains available without this flag. This stage does not
infer corrected IDs or turn uncertain citations into verified source buttons.

标注笔记入口启用 `--preserve-text`：完整非空正文原样保留为 `note.raw.md`。
来源校验失败或有效来源表不可用时，应用仍保存原始正文，显示溯源待核对提示并保留
原始来源标记。验证成功时沿用干净正文和段后按钮。不完整响应、输入绑定变化或保存
失败仍报错。不带此参数仍走严格模式；本阶段不猜测或修正来源 ID。

### Local reference index / 本地来源索引

The second stage indexes explicit paragraph source IDs against `reading.json`,
independently of semantic acceptance and without another model call. Generation
publishes the reading index as an optional supporting artifact. A missing, invalid,
oversized or unreadable index never prevents completed raw text from being saved.
The note panel provides source-index export without a manual import entry.
The Markdown remains unchanged; the index is stored separately with the note
and can be exported as `note-index.json`.

Only the preview hides recognized transport markers and places annotation,
and comment controls after their exact unique paragraph. Unknown IDs
remain visible. Captured but unused marks and comments appear at the bottom;
using a location mark does not imply using its comment. Indexed means an ID can
be looked up, not that the source supports the paragraph's claim. Modified or
ambiguous paragraphs lose their old controls. Nested or unsupported Markdown
paragraphs remain unchanged with an explicit notice.

第二步使用 `reading.json` 对显式来源 ID 建立本地索引，不再调用模型，也不依赖语义验收。
生成入口把阅读索引作为可选制品发布；索引缺失、损坏、超限或无法读取均不阻止完整原文保存。
笔记面板提供来源索引导出，不再显示手动导入入口。Markdown 不变，索引单独随笔记保存，
可导出为 `note-index.json`。

仅预览隐藏已识别的传输标记，并把标注和评论按钮放在唯一匹配的段落后。
未知 ID 保留可见，已获取但未使用的标注和评论列在末尾；引用定位标记不等于引用附属评论。
“已索引”仅表示 ID 可回查，不表示内容支持关系已核验。修改或重复段落不会沿用旧按钮；
嵌套或暂不支持的 Markdown 段落保持原样并提示。

Reference groups use a compact `[source kind] ‹ position / total ›` control. The
source kind is a non-interactive badge with regular text; arrows and count are enlarged
and bold. Only the arrows are interactive. Each
arrow selects the previous or next source and navigates to its PDF location;
boundary arrow is disabled for multi-source groups. For a single source, either
arrow locates that source. Page and excerpt remain available in the tooltip.
The same control is used for captured-but-unused sources at the bottom.
Paper-text sources retain their saved index but show no reference or navigation
controls in preview. Annotation and comment controls remain available.
The opening bibliographic paragraph also has no navigation controls.

引用组采用 `[来源类型] ‹ 当前序号 / 总数 ›` 的紧凑控件；来源类型为不可点击的标签，
标签保持常规字号与字重，箭头和计数加大加粗，仅左右箭头可点击。箭头切换上一条或下一条并同步定位 PDF，
多条引用时首尾禁用对应箭头，只有一条时两侧箭头均可定位当前来源。页码与摘录保留在悬停提示中，末尾未使用来源也
使用同样的逐条浏览方式。
论文原文来源保留已保存的索引，但预览不显示其引用或跳转控件；标注和评论控件继续保留。
开头的文献信息段也不显示跳转控件。

Successful indexing adds no persistent explanatory banner. Actual unresolved IDs
or skipped paragraphs still have their specific notice.

索引成功后不常驻展示说明横幅；存在未知 ID 或跳过的段落时仍显示对应的具体提示。
