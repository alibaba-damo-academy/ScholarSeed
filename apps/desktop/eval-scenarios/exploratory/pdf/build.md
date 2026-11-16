# PDF基础阅读需求构建依据

## 前向整合与图片型合成输入：pdf/48

本次前向整合保留目标分支的翻译结果加入草稿与诊断重开依据，以及本工作 `pdf/47` 的合成输入；原需求编号、版本和历史裁决不变，各记录的旧修订号保留为来源标识。

[独立示例清单](../../../../../examples/projects/pdf-image-only/project.json)登记单页图片型 PDF `image-only.pdf`，21496 字节，SHA-256 `a1e04eddbf1780744e154da50fb5d65066b796f1547c365a55a3705a9a263680`。使用 Pillow 13.0.0 在 1200×1600 白底 RGB 图像上以默认字体绘制 `SYNTHETIC IMAGE-ONLY PAGE`、`VISIBLE-IMAGE-NEEDLE` 和 `No selectable text layer`，再以 ReportLab 4.4.9 invariant 模式将整图放入 600×800 pt 单页 PDF；未绘制 PDF 文本。该合成原始输入不预置产品状态或结果，不承诺 OCR、查找表现或真实扫描文件的全部特征；导入由人工确认，须核隔离目标及权限。它仅供无文本层条件专项准备，不替代两页正常快评，需求版本、采用状态、异常语义和历史冻结均不变。

独立以 pypdf 与 PDFium 分别解析为一页且提取文本为空，pypdf 确认未加密且含一张图像；PDFium 渲染后逐页查看，可见三行完整文字。共享解析器及 `readExampleFile` 核验清单并读回 21496 字节；这些仅证明原始文件属性，不证明产品行为。

## 查找无匹配状态参考：pdf/46

`no-match-20261113.png` 是 `tmp/test_snapshot/desktop/pdf-no-match-observe-20261113/no-match.png` 原字节副本，SHA-256 `0880b8228a78a1089f27019812e0c88ceef77edf6f8e4d28e468612dd675a99a`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例中对 `evaluation/pdf` 查询 `NO-MATCH-SYNTHETIC`，界面显示无匹配及禁用导航；之后清空并关闭查找。截图为完整渲染视口，PDF 正文因并排面板较窄仅部分可见。隔离文件与 examples 原件 SHA-256 均为 `ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`；无匹配词的独立文本参照见本页历史记录，非本轮独立解析输出。操作改变活动标签并清除原查询，可能更新阅读辅助状态；不证明全部 PDF、搜索跳转或正式评测通过，不改旧判据及冻结。

## 缩放与适应状态参考：pdf/45

以下为 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的 1280×840 真实完整窗口原图副本；原运行目录为 `tmp/test_snapshot/desktop/baseline-1823-pdf-scale-20261113/`，冻结及准备记录绑定目标 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` 和 `evaluation/pdf` 两页合成输入。采集时间均为 2026-11-13 +0800：

| 参考副本 | 原始证据及截图命令 | 时间 | SHA-256 |
| --- | --- | --- | --- |
| `zoom-in-20261113.png` | `driver/evidence/zoom-in.png`，`driver/index.md` 第 8 项 | 12:36:51 | `3b37671cd0654ddc5045c9187a89c786887b99b42c1c7f61c9a32be977c6b19a` |
| `zoom-out-20261113.png` | `driver/evidence/zoom-out.png`，`driver/index.md` 第 12 项 | 12:37:00 | `38d991ebe52a554ec3157631e108c7512d819f5a0465fc2b2ef8e180452a765c` |
| `fit-page-20261113.png` | `driver/evidence/fit-page.png`，`driver/index.md` 第 18 项 | 12:37:17 | `709122422bc0cbc00b85d0b0ed97c1e135df3f11d863cac1eed08a4fec8fcc32` |

`driver/evidence/fit-width.png` 为第 22 项截图，时间 12:37:27，与 `fit-page.png` 原图逐字节相同，故只保存一份参考；两模式在本次布局受相同可用宽度约束，不能凭这张静图区分模式。逐图打开检查，普通放大时正文部分被视口裁切，适应状态可见整页；右侧为窄分屏合成文档，无可见凭据。静图不单独证明缩放动作、模式或几何关系；独立 Judge 的结论仅适用于冻结的两页正常子点，不外推极限、其他布局、异常或历史旧构建缺陷修复。需求版本、判据及历史冻结保持不变。

## 两页缩略图状态参考：pdf/44

两张参考图为 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的 1280×840 真实完整窗口原图副本；原运行目录为 `tmp/test_snapshot/desktop/baseline-1823-pdf-thumbnails-20261113/`，冻结及准备记录绑定目标 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` 和 `evaluation/pdf` 两页合成输入。采集时间均为 2026-11-13 +0800：

| 参考副本 | 原始证据及截图命令 | 时间 | SHA-256 |
| --- | --- | --- | --- |
| `thumbnail-page1-20261113.png` | `driver/evidence/page1.png`，`driver/index.md` 第 9 项 | 12:30:31 | `2fba176c22be686d32841fad76d63d506fe7e1f36e6db1cba0094b2ec13da710` |
| `thumbnail-page2-20261113.png` | `driver/evidence/page2.png`，`driver/index.md` 第 12 项 | 12:30:34 | `37f264bfa47d43677c1f015ce38380b6cf39d5bda765b1a38b337dee93010a34` |

逐图打开检查：均展示两页缩略及对应正文状态，右侧为窄分屏合成文档，无可见凭据。静图不单独证明点击或跳转；该轮独立 Judge 对 `PDF-OBS-006` 选定两页正常子点的裁决见运行报告，不外推长缩略列表、十页样本、异常或完整 PDF。需求版本、采用状态、判据和历史冻结均不变。

## 目录与查找状态参考图：pdf/43

以下为 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的真实完整窗口原图副本，1280×840；原运行目录为 `tmp/test_snapshot/desktop/baseline-1823-pdf-outline-20261113/`，冻结与准备记录绑定目标 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` 和 `evaluation/pdf` 两页合成输入。时间均为 2026-11-13 +0800：

| 参考副本 | 原始证据及截图命令 | 时间 | SHA-256 |
| --- | --- | --- | --- |
| `outline-detail-20261113.png` | `supplement/evidence/outline-detail.png`，`supplement/index.md` 第 21 项 | 12:13:21 | `9bb780ab3d50b21b6eda96e46cac42ca09b685679bf785fcf352761be0a6ac41` |
| `outline-overview-20261113.png` | `supplement/evidence/outline-overview.png`，`supplement/index.md` 第 24 项 | 12:13:24 | `deb89631be63a02fd2d350b04f742d66fa902b3a20d261290fe1afb80b5cc379` |
| `find-third-20261113.png` | `geometry/evidence/third.png`，`geometry/index.md` 第 6 项 | 12:19:31 | `3c76f515262ba99ea025ecfebea3a5a23a6145d90e603e47bcb2542addfd739b` |
| `find-second-20261113.png` | `geometry/evidence/second.png`，`geometry/index.md` 第 10 项 | 12:19:43 | `a7c7b280aa1e335f5985f3cdf2b11f40d24a11d93510aad53c19ec348f148da8` |

逐图打开检查，前两图展示目录选中与对应页面，后两图展示查找结果的不同状态；右侧为合成文档且分屏较窄，未见凭据。静图不单独证明跳转或命中切换；同轮几何及独立 Judge 的选定两页子点结论见运行报告，不外推十页样本、完整 PDF 或异常范围。首轮及首次补证的缺证裁决、需求版本、判据与历史冻结均保留；本次仅补参考图。

## 多页合成输入：pdf/42

[独立示例清单](../../../../../examples/projects/pdf-multipage/project.json)登记仓库自制的十页 PDF，`multipage.pdf` 为 6838 字节，SHA-256 `255322ad540ce1297af7252a4a807eb8f56c7a847e29347cc76229d4066a672d`。使用 ReportLab 5.0.1 的 invariant 模式及内置 Helvetica 字体生成，各页显示合成页号 `SYNTHETIC-PAGE-01` 至 `SYNTHETIC-PAGE-10`；仅第 8、9 页含 `CROSS-BATCH-NEEDLE`。独立解析应核十页、逐页标识及命中分布，实际运行还须记录对应隔离项目及文件身份。当前源码 `PdfDocument.tsx` 的查找分批大小为 8，仅作为样本覆盖边界的实现线索，不作为产品需求、安装包同源或通过依据。该文件是原始输入，不预置产品状态或结果；导入由人工确认，须核隔离与权限。默认两页快评、需求版本、采用状态和历史冻结均不变。

## 需求与运行进度分离：pdf/41

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。参考图注的采集日期按下述既有来源补全。

## 两页参考图补充：pdf/40

2026-11-12 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例中，以合成 `sample.pdf` 采集两页状态；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。`page-one-20261112.png` 和 `page-two-20261112.png` 分别为原图 `tmp/test_snapshot/desktop/baseline-1823-batch1/driver/evidence/f1-pdf-1.png`、`f1-pdf-2.png` 的未改动副本，SHA-256 依次为 `fc6c05d74bb122d04d38cb3956ece32df3dab0bdf21321e0c3e31cb8471b453c`、`96d43f2f562e37dcbe80f8dfc9d1cea6d067463a1b6f6d5897d4ee84cfa1110b`。原运行目录为忽略证据，仅本机可回查；参考图不能单独证明翻页动作或其他专项。本修订不改需求版本、判据或历史结果。

## 共享输入去重：pdf/39

原页面目录的合成输入已迁至字节一致的共享 `examples/projects/evaluation/files/`，原路径与内容可按历史提交 `854dfa6c81` 回查；仅整理输入引用，不更改需求版本、判据或冻结记录。

## F1 普通阅读路径沿用依据：pdf/38

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用 2026-10-30 用户统一采用规则及本页既有普通阅读快评中 PDF-OBS-001、002 的已采用子点：打开已知两页 PDF 后对照正文及页数，普通翻页后页码与正文共同变化。本页 `pdf/32` 的已确认引用定位变化明确保留普通翻页语义和基础快评分母；已核本页既有采用及后续修订，未发现该子范围被确认退役或改变的记录。此为有界记录核查，不宣称完整需求变更史或源码与制品同源；引用定位、缩放、选区及异常等其他要求不因此被验证。原编号、v`0.3`、判据及旧运行不变；新运行仍须核目标身份及独立 PDF 原件，由独立评审判断证据，不因本记录认定产品通过。下方 `pdf/37` 所述目标适用性待核针对当时未完成此项有界沿用分析的状态。

## 共享示例输入对齐：pdf/37

本修订仅将现行基础阅读快评的两页 PDF 输入指向 `examples/projects/evaluation/files/sample.pdf`，保留原稳定 ID、需求版本、判据与历史结果。2026-11-12 核对该文件与本场景旧副本 SHA-256 均为 `ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`；旧路径 `exploratory/pdf/sample.pdf` 可从源提交 `854dfa6c81` 回查，下列构建记录保留历史溯源。每轮按共享项目清单 `evaluation/pdf` 和准备收据核输入身份及产品路径，准备不证明导入功能；目标包适用性仍需独立核实，本修订不代表产品通过。
## 2026-11-13 翻译结果加入草稿恢复

最终集成基线为 Preview `87eab33f0`，Reading 的原始 blob 与初始基线一致；其间同步的改动属于运行时协调与新任务引用显示。沿用本节补充范围，不把这些目标分支改动归为本 Bug 修复。 / Final integration uses Preview `87eab33f0`; its original Reading blob matches the starting baseline. Intervening target changes concern runtime coordination and new-task reference visibility, not this repair's diff or scope.

资产修订：`pdf/38`。依据用户对 Bug 88916076 的明确要求，比较 Preview `817b2710c` 与本任务差异。PDF-OBS-009 补充结果底部与顶部原文入口的不同语义；保留稳定 ID、版本及基础阅读快评分母。直接影响共用 Reading 的翻译与解释结果操作，关联 AssistantIngress 的草稿准备和文献上下文；不改变翻译后端、语言检测、全文翻译或自动发送规则。回归核对完成、生成中、空结果、中英文草稿字节及顶部原文快照；真实模型/Electron 验收另记，不由确定性检查推定通过。

Asset revision: `pdf/38`. The user's explicit Bug 88916076 requirement covers Preview `817b2710c` plus this task's diff. PDF-OBS-009 distinguishes the result footer from the original-text toolbar action while preserving its ID, version and basic-reading quick-check scope. Translation and explanation result actions share Reading; draft preparation and literature context use AssistantIngress. Translation providers, language detection, full-document translation and sending rules stay unchanged. Focused regression covers ready, generating and empty states, bilingual draft bytes and the toolbar's original snapshot. Real-model/Electron acceptance is recorded separately, not inferred from deterministic checks.

## 2026-11-12 AI 解读诊断重开修复依据

资产修订：`pdf/37`。依据 Bug 88834603 重开反馈与用户当前截图确认，分析 Preview `02f275b55` 加本轮修复差异。`b4dd06466` 将诊断改为并列区块时移除了隐藏边界；本轮把整组可见性固定在共享 Summary，不改后台指标、保存或引用。直接影响 PDF 与文献详情 AI 解读。保持原隐藏要求、稳定 ID、需求版本与快评分母，补充新完成结果、重新打开及键盘不可达的专项覆盖；独立 Generation 数据展示测试不代表用户页面应该公开诊断。运行结果另记，旧截图不作为本轮通过证据。

Asset revision: `pdf/37`. Based on Bug 88834603 reopening and the user's current screenshot, analyze Preview `02f275b55` plus this repair diff. `b4dd06466` removed the hidden boundary while splitting diagnostics into sibling sections. Shared Summary now owns visibility of the entire group without changing metrics, persistence or citations. PDF and literature-detail readings are directly affected. Preserve the hidden-entry requirement, stable IDs, requirement versions and quick-check scope; add focused coverage for newly completed results, reopening and keyboard exclusion. Standalone Generation data tests do not authorize diagnostic visibility in user-facing readings. Execution evidence is recorded separately; old screenshots do not prove this revision.

## 2026-11-12 划词翻译重开修复依据

资产修订：`pdf/36`，在集成 Preview 的 `pdf/35` 后顺延。依据用户批准的 Bug 88834262 方案与实施授权，分析 `7f5d81fd5` 加修复提交 `4f9ae9064`，并合入 Preview `365653927`。PDF-OBS-009 保留 ID、需求版本和快评分母，补充源选区/修订/目标/请求绑定、旧译文实际语言提示、正文覆盖及明显中英文矛盾拒绝和一次有界纠正。直接影响文献 PDF；项目与会话产物 PDF 共用 Reading，复用对应源权限与修订契约。TranslationControls 的新增参数为可选，仅此宿主启用，不改变提示词设置或其他翻译入口的默认行为。并发换选区、拒绝分支、纠正次数与来源撤权属于专项。确定性回归不替代真实模型及 Electron 证据，运行结果单独记录。

Asset revision: `pdf/36`, following Preview's `pdf/35`. The user-approved Bug 88834262 plan and implementation authority cover `7f5d81fd5` plus repair commit `4f9ae9064`, integrated with Preview `365653927`. Keep PDF-OBS-009's ID, requirement version, and quick-check denominator. Add selection/revision/target/attempt binding, actual-language identification for retained results, source coverage, clear Chinese/English contradiction rejection, and one bounded correction. Literature PDFs are directly affected; project and conversation-artifact PDFs share Reading and their existing source authorization/revision contracts. The optional TranslationControls parameter is enabled only by this host; prompt settings and other translation defaults remain unchanged. Selection replacement, rejection, correction limits, and access revocation are focused checks. Deterministic regressions do not replace real-model and Electron evidence; execution results are recorded separately.

## 2026-11-12 持续标注按钮 Esc 复验补充

资产修订：`pdf/35`。Bug 88837628 的 Reopen 复验与真实 macOS Desktop 均暴露持续按钮提示在 capture 阶段消费 Esc、PDF 退出监听因此跳过的问题。共享 Tooltip 增加默认保持原行为的 `consumeEscape` 策略，仅持续标注按钮选择透传；保留 PDF 输入、弹层及已消费事件保护。补充悬停、键盘焦点、后续划选无自动保存及已有标注保留回归，不改变需求版本或基础快评分母。Windows 现场和发布制品未复验；本记录不是验收通过证明。

Asset revision: `pdf/35`. Bug 88837628's Reopen report and real macOS Desktop reproduction identify a tooltip consuming Escape during capture before PDF cancellation. Tooltip gains an opt-out `consumeEscape` policy with unchanged defaults; only continuous annotation buttons opt out. Preserve PDF editable, overlay and consumed-event boundaries. Add hover, keyboard-focus, subsequent-selection and saved-mark regressions without changing requirement versions or basic-reading scope. Windows and release artifacts remain unverified; this record is not acceptance evidence.

## 2026-11-12 Preview 合并语义对齐

资产修订：`pdf/34`。将 `c3ffd541a` 合入三个缺陷的修复分支时，保留两侧历史记录；本分支原 `pdf/21`、`pdf/22` 与 Preview 同号记录属于并行历史，不重新判定旧运行。当前合并口径区分阅读视口隐藏与选区锚点滚出视野：隐藏或停用阅读来源时不显示普通工具条；阅读区仍可见时，滚出视野的选区仍可操作，浮层受 `pdf/30` 的阅读区边界约束。保留 Esc、批注草稿、固定结果、笔记宽度/展开、窗口缩放及来源版本保护。补充组合回归，不扩大快评分母；真实合并后证据单独记录。

Asset revision: `pdf/34`. Integration of `c3ffd541a` preserves both branches' historical records; the repair branch's original `pdf/21` and `pdf/22` overlap Preview numbering and do not reinterpret earlier runs. Distinguish a hidden or inactive reader from an offscreen selection anchor: ordinary tools hide with their reader, while offscreen selections remain usable within the visible reader's `pdf/30` bounds. Preserve Escape, drafts, pinned results, notes resizing/expansion, window resizing, and revision checks. Add combined regressions without expanding the quick-check scope; runtime evidence is recorded separately.

## 2026-11-12 阅读来源隐藏回归依据

资产修订：`pdf/22`。用户要求同分支修复 Bug 88838778；在 `pdf/21` 的差异上补充选区宿主与 PDF 视口生命周期。PDF-OBS-009 区分“保留选区/草稿/固定结果”和“显示普通工具条”：来源隐藏或锚点不可见时隐藏普通工具条，重新可见后可恢复操作；不把保留状态等同于持续遮挡其他页面。此补充取代 `pdf/16` 中普通工具条绕过可见性检查的要求，保留历史记录与需求版本，不扩大基础快评分母。回归收起/展开、滚动、任务与文献切换、未完成批注、固定结果、Esc 和笔记布局；非 PDF 生命周期保持不变。原始 Windows 截图和录制报告未记录完整收起顺序，真实执行与平台缺口另行报告。

Asset revision: `pdf/22`, for Bug 88838778 on the existing branch. PDF-OBS-009 separates retained selections, comment drafts, and pinned results from ordinary toolbar visibility. Hide ordinary tools while their source or anchor is invisible and restore usable actions when visible again. This supersedes the ordinary-toolbar visibility exemption recorded in `pdf/16`, without changing historical records, requirement versions, or the basic-reading quick-check scope. Regress collapse/restore, scrolling, task/document switching, drafts, pinned results, Escape, and notes layout; non-PDF lifecycle rules remain unchanged. Original Windows evidence lacks the complete collapse sequence; execution evidence and platform gaps are recorded separately.

## 2026-11-12 标注退出与笔记布局回归依据

真实验收补充定位：铺满笔记后 PDF 容器内容宽度归零，但内边距使 `clientWidth` 仍为 32；按该宽度重算会触发最小缩放，并在还原时跳页。几何监听改用 ResizeObserver 的内容区域判断是否可读，折叠时保留上次尺寸。回归补充隐藏内容区域、还原页码与缩放；不依赖固定内边距值。本条是源码因果记录，运行证据单独保存。

Runtime investigation found that a collapsed PDF retained padding in `clientWidth` despite a zero-width content box, triggering minimum zoom and a page jump on restore. Geometry observation now retains the last readable size when the ResizeObserver content box is empty. Regression coverage includes collapsed geometry and restored page/zoom without binding the fix to a padding value. Runtime evidence remains separate.

资产修订：`pdf/21`。用户明确要求在最新 0.3.2 分支修复 Bug 88837628、88838604；源码范围为 `c5e91057d2a9` 加本次未提交差异。PDF Owner 补全 Esc 临时选区清理，并复用现有 Resizable 分栏承载显式声明可调整的笔记贡献；不修改存储或桥接协议。PDF-OBS-003、008、009 保留原要求，追加退出与笔记尺寸专项；关联回归涵盖输入/子浮层优先级、已存标注保留、笔记草稿与编辑器挂载、AI 解读及信息面板。文献笔记专项尚无独立基线，暂在其实际 PDF 宿主记录，不创建平行占位资产。真实运行证据及环境缺口另行记录，本节不证明产品通过。

Asset revision: `pdf/21`, based on the user's request to fix Bugs 88837628 and 88838604 against `c5e91057d2a9` plus the current changes. Existing IDs and requirement versions remain intact. Regress PDF selection dismissal, input and overlay precedence, saved annotations, notes resizing and draft continuity, interpretation, and fixed information panels. Notes checks are recorded at the actual PDF host because a separate notes baseline does not yet exist. This source-impact record is not product acceptance evidence.

## 2026-11-12 会话产物划词增量依据

资产修订：`pdf/33`。依据用户对缺陷88838444的明确修复要求，补充PDF-OBS-009的会话产物来源，沿用既有工具条与权限边界，不修改历史运行结果或推定新产品需求版本。分析基线为`3a52b0f8f`及本次未提交差异；影响Artifact投影、PDF解释/翻译来源解析、Workbench选区宿主和Assistant冻结快照。直接回归产物PDF跨行选区、开关、复制、添加上下文及真实解释/翻译；关联回归文献与项目来源，拒绝越权、非法目录成员和过期修订。基础阅读和标注原预期不变；本记录不是产品验收结论。

## 2026-11-12 PDF 引用先跳页再定位

资产修订：`pdf/32`。Bug 88839255 的用户确认「先跳转到页，再做页内滚动」；源码依据为 `7f361d7aa6b75c0032171d0e8616e1c677a47094` 加本次 `pdf/Page.tsx` 差异。沿用既有引用几何、高亮与证据切换，不改变 PDF-OBS-002 的稳定 ID、普通翻页语义和基础快评分母。专项覆盖远页、连续切换、无坐标和减少动态效果。

Asset revision: `pdf/32`. For Bug 88839255, the user confirmed jumping to the target page before scrolling within it. The source basis is `7f361d7aa6b75c0032171d0e8616e1c677a47094` plus the change to `pdf/Page.tsx`. Citation geometry, highlights, and evidence switching remain in place; PDF-OBS-002 keeps its stable ID, ordinary page navigation, and basic-reading scope. The targeted regression covers distant pages, repeated switching, page-only citations, and reduced motion.

## 2026-11-12 AI 解读讨论入口迁移依据

资产修订：`pdf/31`。依据用户两张截图及“生成完成后才激活”要求，分析来源为`c32ff9893`加本次共享`components/business/Reading`及中英文资源差异，保留其他未提交修改。PDF侧栏和文献详情复用同一组件；入口从顶部IconButton移至正文滚动区之外的底部Button，完成状态沿既有任务、预览和已保存summary判断，不改生成、后台提取、持久化、上下文接纳或草稿交接。独立需求版本未指定，更新既有转对话补充约束，不改变稳定ID、版本或基础快评分母。回归覆盖空态、提交中、渐进预览、完整发布、后台提取未结束但解读已完成、降级结果、取消恢复、重复交接、失败恢复、键盘、长内容、中英与明暗窄栏；真实产品入口与状态须独立验收，本记录不代表运行通过。

Asset revision: `pdf/31`. The user's two screenshots require moving the discussion entry and enabling it only after generation finishes. Source scope is `c32ff9893` plus this shared Reading component and bilingual-resource change; unrelated local changes remain intact. The PDF sidebar and literature detail share the component. A bottom Button outside the reading scroll area replaces the top IconButton; availability follows existing task, preview, and saved-summary state. Generation, background extraction, persistence, context acceptance, and draft handoff remain unchanged. No separate requirement version is assigned; update the existing supplemental handoff constraint without changing stable IDs, versions, or the basic-reading scope. Regress empty/submitting/streaming/published states, completed readings with background extraction still active, fallback results, cancellation restoration, duplicate/failing handoffs, keyboard access, long content, and bilingual light/dark narrow panes. Real product flows need separate acceptance evidence.

## 2026-11-12 划词浮泡阅读区限位依据

资产修订：`pdf/30`。用户截图明确要求浮泡不越过文献阅读区域，四边至少20px。分析来源为`c32ff9893`加当前保留差异；`PdfDocument`将实测阅读视口按design间距token内缩，沿既有页签级SelectionPresentation传给`SelectionActionHost`。定位、移动、调整大小及已拖动浮泡的重新限位共用placement几何，不改变文档选区、生成请求、内容或持久化。PDF-OBS-009追加用户确认的边界约束，保留稳定ID与需求版本，不扩基础快评分母。回归包括选区滚出上下边界、四向移动与缩放、窄分栏、侧栏收放、内部滚动和非PDF原有定位；真实实例验证正常PDF交互，不以夹具证明产品验收。

Asset revision: `pdf/30`. The user requires floating selection surfaces to remain at least 20px inside every edge of the document-reading viewport. Source scope is `c32ff9893` plus the retained local changes. PdfDocument measures and insets its viewport using a design spacing token, then passes that boundary through the existing tab-scoped SelectionPresentation. Placement, movement, resizing, and re-clamping share geometry helpers without changing selections, requests, content, or persistence. PDF-OBS-009 gains this confirmed constraint; stable IDs, requirement versions, and the basic-reading denominator remain unchanged. Regress offscreen selections, all movement and resize directions, narrow panes, sidebar toggling, internal scrolling, and unchanged non-PDF placement. Real PDF interaction requires separate runtime evidence.

## 2026-11-11 颜色按钮悬停内距纠偏

资产修订：`pdf/29`。用户补充截图重申PDF-OBS-008已采用的左右各4px内距，不改变需求版本或预期。分析来源为`c32ff9893`及当前未提交差异；`PdfTools`的颜色按钮内容宽度选择器被Tailwind解析成错误的后代关系，内部图标超出容器。修复既有内容宽度选择器，并保证顶栏方形按钮规则不覆盖组合按钮的自然宽度。回归直接测量色点左缘和箭头右缘，而非仅测内部包装容器；覆盖浅深主题、划词、顶栏和标注菜单，保留选色、焦点与禁用行为。本记录不是真实产品验收证明。

Asset revision: `pdf/29`. The user screenshot reiterates the adopted 4px horizontal padding in PDF-OBS-008, without changing requirement versions or expectations. Source scope is `c32ff9893` plus the current uncommitted changes. Tailwind interprets PdfTools' content-width selector as an incorrect descendant relationship, allowing the icons to overflow their wrapper. Correct the selector and preserve the compound trigger's natural width against square toolbar-button rules. Regress the actual swatch and arrow edges in both themes and in selection, top-toolbar, and annotation contexts, retaining color selection, focus, and disabled behavior. This record is not product acceptance evidence.

## 2026-11-11 纯评论正文定位依据

同一修订补充：真实定位暴露窄阅读区的引用浮动条会遮住页首气泡；复用浮动条实际测量高度设置阅读区顶部留白，保留浮动定位与正文滚动，回归覆盖中英文换行后的页首避让。

Within the same revision, real navigation also exposes first-page bubbles covered by the citation toolbar in narrow readers. The reader derives initial top padding from the toolbar's measured height, retaining floating placement and page scrolling. Regress first-page clearance after wrapping in both languages.

资产修订：`pdf/28`。用户截图明确要求侧栏纯评论定位正文气泡。分析来源为`c32ff9893`加本次及保留的目录尺寸差异：`Annotations`评论正文原为无动作段落，现复用`Button`接入既有`onFocus`；`PdfDocument`布局恢复优先保留明确焦点，避免自动适应因评论轨道宽度变化而抢回原引用。沿用PDF-OBS-008和既有版本，不扩基础快评范围；回归核鼠标、Enter/Space、纯评论无原文、复制/展开/编辑不导航，及缩放、侧栏、并排布局下的焦点优先级。真实实例另核跨页定位与气泡命中，本记录不是执行通过证明。

Asset revision: `pdf/28`. The user screenshot requires comment-only sidebar cards to locate their document bubbles. Source scope is `c32ff9893` plus this change and the retained outline-sizing edits. Annotations replaces passive comment paragraphs with shared Buttons calling the existing onFocus path. PdfDocument preserves explicit focus during geometry restoration so auto-fit changes caused by comment rails do not return to the opening citation. PDF-OBS-008 and existing versions remain unchanged. Regress mouse and Enter/Space activation, source-free comments, non-navigating copy/expand/edit controls, and focus precedence during resizing, sidebar changes, and split layouts. Real cross-page navigation and bubble targeting require separate evidence; this record is not execution evidence.

## 2026-11-11 目录行与展开按钮尺寸依据

资产修订：`pdf/27`。用户两张截图明确要求28px按钮和标题背景、14px箭头，各层级一致。分析来源为`c32ff9893`加本次差异；`Outline`递归复用既有`Button`、`IconButton`及`Collapsible`，展开按钮改用sm档位，目录行高token复用同档位高度并移除多余垂直内距，避免22px文字行被裁切。PDF-OBS-004追加视觉约束，不改变既有需求版本与基础快评范围。回归覆盖三级目录在明暗主题下的正常、hover及按压尺寸、文字完整性、展开键盘操作和真实跳页；本记录不是执行通过证明。

Asset revision: `pdf/27`. The user's two screenshots require 28px controls and title backgrounds with 14px arrows at every depth. Source scope is `c32ff9893` plus this change. Outline keeps its recursive Button, IconButton, and Collapsible composition, uses the sm toggle size, aliases row height to the same control token, and removes excess vertical padding so 22px text lines remain intact. PDF-OBS-004 gains a visual constraint without changing requirement versions or the basic-reading scope. Regress three levels in both themes, hover and pressed geometry, text bounds, keyboard expansion, and real page navigation. This record is not execution evidence.

## 2026-11-11 引用浮动条窄分栏补充

资产修订：`pdf/26`。沿用用户确认的浮动条需求，补充导航侧栏展开后的极窄阅读区边界：按钮复用`EllipsisText`约束宽度并保留完整提示和可访问名称；浮动条位于局部高亮层之上，避免正文高亮穿透。聚焦回归覆盖中英文本溢出、箭头命中、键盘定位和层级关系，真实实例另核导航侧栏展开与收起；不改变需求版本或基础快评分母，本记录不是运行通过证明。

Asset revision: `pdf/26`. The confirmed floating-toolbar requirement also covers narrow reading space beside an open navigation sidebar. Buttons reuse EllipsisText to constrain labels while preserving full tooltips and accessible names. The toolbar sits above local highlights so document highlights do not paint over its controls. Regress both languages, overflow, arrow bounds, keyboard navigation, and stacking; verify open and closed sidebars separately in the real app. Requirement versions and the basic-reading scope remain unchanged; this record is not execution evidence.

## 2026-11-11 引用依据浮动条依据

资产修订：`pdf/25`。用户提供冲突截图与浮动条参考，明确将会话文献引用的前后依据导航从PDF顶栏移入阅读区。分析来源为`f880f7b00`加本次未提交差异；`PdfDocument`保留引用版本校验、区域展开、顺序及`requestFocus`，仅将既有按钮迁入阅读视口外的`FloatingToolbar`，复用主题、边框、圆角与阴影，并跟随导航侧栏宽度。关联消费者包括项目资料、文献PDF及并排解读；补充PDF-OBS-002专项，不改既有版本或基础快评分母。回归覆盖首尾/同页多区/跨页、正文滚动、窄分栏、中英与主题；真实会话引用的打开、定位和不遮挡分别取证，本记录不是运行通过证明。

Asset revision: `pdf/25`. The user supplies the conflicting header and desired floating-strip screenshots. Source scope is `f880f7b00` plus this uncommitted change. PdfDocument retains revision checks, region ordering, and requestFocus while moving the existing actions into a FloatingToolbar outside the scrolling viewport, respecting navigation-sidebar width. Project and literature PDFs and split reading share the change. PDF-OBS-002 receives a supplemental citation check without changing existing requirement versions or the basic-reading denominator. Regress boundaries, same-page and cross-page regions, scrolling, narrow panes, both languages, and themes. Real conversation navigation and unobstructed controls require separate evidence; this record is not execution evidence.

## 2026-11-11 缩小按钮提示文案依据

资产修订：`pdf/24`。依据用户截图及明确tooltip要求，在`f880f7b00`上的本次增量将`pdf:reading.shrinkPanel`调整为“缩小”/“Shrink”，重新生成类型，保留此前未提交修改。消费者为划词结果的尺寸按钮与共享PdfPanel的展开态按钮；仅改资源，不改变状态或布局。沿用PDF-OBS-009及已有需求版本，不扩大基础快评分母；回归覆盖中英切换、真实放大结果的悬停提示及恢复紧凑浮层，本记录不代表执行通过。

Asset revision: `pdf/24`. The user requests the tooltip “缩小”. This incremental change on `f880f7b00` updates `pdf:reading.shrinkPanel` to “缩小” / “Shrink” and regenerates types, retaining earlier uncommitted changes. Selection-result size controls and expanded PdfPanel controls share this resource; state and layout remain unchanged. Existing IDs, requirement versions, and the basic-reading quick-check scope remain unchanged. Regress language switching, the real expanded-result tooltip, and restoring the compact overlay; this record is not execution evidence.

## 2026-11-11 AI解释入口文案依据

资产修订：`pdf/23`。依据用户截图及“文案调整为AI解释”的要求，在`f880f7b00`上的本次增量同步修改PDF namespace的`selectionExplain`与`pdfAnnotation.explain`中英资源并生成类型；保留此前未提交修改。消费者为划词工具栏、阅读解释入口和标注工具栏，提交按钮不变。沿用PDF-OBS-009及已有需求版本，不扩大基础快评分母；回归覆盖中英往返、标注渲染及真实划词入口，本记录不代表执行通过。

Asset revision: `pdf/23`. The user requests “AI解释” for the toolbar action. This incremental change on `f880f7b00` updates the Chinese and English `pdf:selectionExplain` and `pdf:pdfAnnotation.explain` resources and generated types, retaining earlier uncommitted changes. Selection, reading, and annotation toolbars consume these labels; the submit button is unchanged. Existing IDs, versions, and the basic-reading quick-check scope remain unchanged. Regress language round trips, annotation rendering, and the real selection entry; this record is not execution evidence.

## 2026-11-11 解释提交按钮去图标依据

资产修订：`pdf/22`。用户截图明确移除“解释一下”按钮的前置图标；`f880f7b00`上的本次增量仅调整共享`pdf/Explanation.tsx`及相邻渲染回归，保留此前翻译提示样式修改。影响PDF划词和标注解释，沿用PDF-OBS-009及已有需求版本，不扩大基础快评分母。回归核按钮文字、无装饰图标、编辑器及原交互；本记录不代表真实产品验收通过。

Asset revision: `pdf/22`. The user screenshot explicitly removes the leading icon from “Explain this”. This incremental change on `f880f7b00` updates shared `pdf/Explanation.tsx` and its render regression, retaining the earlier translation-notice changes. It affects selection and annotation explanations while preserving PDF-OBS-009, existing requirement versions, and the basic-reading quick-check scope. Regress the text-only button, editor, and existing interactions; this record is not product acceptance evidence.

## 2026-11-11 翻译配置变更提示样式依据

资产修订：`pdf/21`。依据用户截图及明确的“不加粗、text-placeholder”要求，补充PDF-OBS-009的提示样式约束。源码范围为`f880f7b00`上的本次未提交差异，Owner为`features/translation/Controls.tsx`；关联消费者为PDF划词翻译及资料选区翻译。回归核明暗主题、父容器加粗时的400字重、语义颜色、旧译文保留与显式刷新。独立需求版本未指定，保留已有ID、版本及历史结果，不扩大基础快评分母；本记录不代表真实产品验收通过。

Asset revision: `pdf/21`. The user screenshot and explicit regular-weight/text-placeholder request supplement PDF-OBS-009. Source scope is `f880f7b00` plus this uncommitted change in `features/translation/Controls.tsx`, shared by PDF and resource selection translation. Regress both themes, regular 400 weight under emphasized ancestors, semantic color, retained results, and explicit refresh. No separate requirement version is assigned; existing IDs, versions, historical results, and the basic-reading quick-check scope remain unchanged. This record is not product acceptance evidence.

## 2026-11-11 AI 解读诊断入口回归依据

资产修订：`pdf/20`。来源为用户对 Bug 88834603 的修复确认；分析基线为
`d8982caef` 加本次差异。共享 Summary 的整体隐藏语义影响 PDF 与文献详情，
因此在既有 requirements 追加诊断入口约束；不改变基础阅读稳定 ID、需求版本或
快评分母。回归覆盖有无诊断元数据的已保存解读、正文、引用及既有操作；后台用量、
首字时间上报和持久化不变。本记录不是运行通过证明，实际验收与环境缺口另行报告。

Asset revision: `pdf/20`. The user confirmed restoring hidden reading diagnostics for
Bug 88834603. Source scope is `d8982caef` plus this change. The shared Summary affects
both PDF and literature details. The supplemental constraint preserves existing IDs,
requirement versions, and the basic-reading quick-check scope. Regress saved readings
with and without metadata, content, citations, and existing actions; usage recording,
first-token reporting, and persistence remain unchanged. This is not execution evidence.

## 2026-11-10 正文评论工具条增量依据

资产修订：`pdf/19`。按用户截图要求，PDF-OBS-008的正文评论和点评论草稿复用标注工具条的评论展开区，侧栏内联编辑保持不变。点评论草稿与持久化记录复用同一位置构造函数；保留无原文的类型边界及禁用操作，草稿不在保存前写入记录。确定性回归核位置、工具条、输入焦点、保存失败与取消，真实Desktop核新建点评论和已有正文评论；不扩大基础快评分母或修改历史版本结论。

## 2026-11-10 AI 解读转对话增量依据

资产修订：`pdf/18`。依据用户对“与书深对话”无反应问题的分析及修改确认，追加交接反馈、草稿保护和对话可见性补充约束。当前源码涉及Reading业务组件的异步回调、store共享上下文交接、layout分栏恢复及AiPanel首次打开的草稿初始化；已有文献上下文不能被视为空白新草稿。沿用既有需求版本，不将本项或模型输出质量扩入默认快评分母；确定性与真实产品证据另行记录。

## 2026-11-10 划词顶部操作组对齐增量依据

资产修订：`pdf/17`。依据用户截图要求，PDF-OBS-009的顶部复制、评论操作组随浮层加宽保持靠右，不改变单排展示、按钮行为和历史版本。聚焦布局回归覆盖默认及加宽尺寸，真实Desktop拖拽浮层核右侧间距；运行证据单独保存。

## 2026-11-10 划词浮层保留增量依据

资产修订：`pdf/16`。按用户截图要求，PDF-OBS-009不因客户端失焦、尺寸变化或点击其他任务清除PDF选区；PDF消费者不因锚点暂时不可见隐藏工具栏，临时切换时保留展开状态。非PDF文档原有关闭策略和来源版本失效保护保持不变。确定性回归覆盖全局关闭入口的PDF/非PDF区分、不可见锚点和既有非PDF浮层生命周期；真实窗口与任务切换验收另行记录，不将环境阻塞当通过。

## 2026-11-10 选区翻译对齐与滚动增量依据

资产修订：`pdf/15`。按用户截图，PDF-OBS-009的放大按钮移至控件操作组最右侧并使用“放大”提示；紧凑翻译操作组靠右，滚动区外壳取消圆角，保留浮层整体圆角与滚动所有权。回归核紧凑控件右对齐和滚动区实际圆角，不改变稳定ID或历史结论。

## 2026-11-10 导航宽度与复制图标增量依据

资产修订：`pdf/14`。依据用户截图要求，PDF-OBS-008的导航默认宽度由190px调整为260px，保留既有拖拽范围及用户保存的宽度；评论复制按钮使用icon-outline-default。确定性回归核默认值与图标实际颜色，真实Desktop核默认宽度260px及评论复制图标颜色。不改变稳定ID、既有版本和历史结论。

## 2026-11-10 评论样式增量依据

资产修订：`pdf/13`。按用户截图，PDF-OBS-008/009的正文点评论及草稿入口颜色与右侧浮标一致，输入框由PdfCommentInput统一复用工具条的Textarea组合与样式，新增中英占位文案。新建评论不重复显示标题，编辑已有评论和保存/取消语义保留；不修改持久化或历史结论。

## 2026-11-10 浮层工具栏单排增量依据

资产修订：`pdf/12`。依据用户截图，选区和标注浮层的操作区保持单排，宽度不足时局部横向滚动；仅调整PDF消费者，不改变共享FloatingToolbar默认行为、评论编辑或持久化。沿用PDF-OBS-008/009的稳定ID和历史版本，回归核操作按钮处于同一行及真实评论展开状态。

## 2026-11-10 筛选图标与提示增量依据

资产修订：`pdf/11`。按用户截图要求，PDF-OBS-008的高亮筛选图标复用顶栏同款Lucide Highlighter，类别页签复用Tooltip提供名称提示，不改变筛选行为、稳定ID或历史结论。回归核图标身份、悬停提示和原键盘导航。

## 2026-11-10 侧栏空态增量依据

资产修订：`pdf/10`。依据本次用户截图和要求，PDF-OBS-008的侧栏空态居中，使用12px常规字重，大纲文案改为“暂无大纲”（英文“No outline”）。复用compact EmptyState，仅在PDF消费者调整字号；不改变全局空态或数据行为。保留稳定ID、需求版本和历史结论。

## 2026-11-10 菜单文案增量依据

资产修订：`pdf/9`。依据用户明确要求，仅将PDF-OBS-008的“编辑”菜单项改为“修改标注方式”（英文“Change mark type”），沿用`pdfAnnotation.edit`资源键与既有动作。不改变交互、稳定ID、需求版本或历史结论。

## 2026-11-10 编辑子菜单增量依据

资产修订：`pdf/8`。依据用户截图与三项明确要求，PDF-OBS-008新增编辑子菜单右侧展开、标注颜色按钮左右各4px内边距及展开箭头icon-outline-default颜色要求。沿用`PopoverContent`的right/start定位，不改共享浮层；`pdf/Tools.tsx`仅扩展组合颜色按钮的内容宽度和内边距，不改变颜色值或保存行为。`pdf/annotation.render.test.ts`覆盖父子菜单位置、左右实际留白与箭头颜色。保留原稳定ID、需求版本与历史结果，不扩大基础阅读快评分母。

## 2026-11-10 筛选选中态增量依据

资产修订：`pdf/7`。依据用户截图和明确要求，PDF-OBS-008的标注类别筛选选中态仅文字加粗，图标保持原描边粗细；未指定新需求版本，保留原稳定ID、版本与历史结论。实现入口为`pdf/Annotations.tsx`，回归覆盖文字字重和图标切换前后的实际描边宽度。不改全局Tabs或基础阅读快评分母。

## 2026-11-10 工具栏颜色增量依据

资产修订：`pdf/6`。依据本次用户截图及明确颜色要求，仅修订PDF-OBS-009的选区/批注工具栏颜色；保留稳定ID、既有需求版本及历史结果，本次增量的独立产品需求版本未指定。不改基础阅读快评分母。

源码基线为`8b7d2b9666c77af55d004dbd1e68d6f6bcb2e342`上的本次未提交差异：`Selection.tsx`、`pdf/Annotation.tsx`及两者共用的`pdf/Tools.tsx`。文本按钮图标与文字分色，单图标按钮按现有aria-pressed状态变色；解释图标复用已有单色sparkle资产。回归范围为两种浮层的解释、翻译、添加到会话框、复制和评论按钮，含明暗主题与默认/激活状态。不改模型请求、标注持久化或全局Button/IconButton。

`pdf/annotation.render.test.ts`增加实际CSS颜色断言；确定性渲染回归不替代真实Desktop截图验收，也不证明模型输出质量或Windows产品验收。

## 2026-11-05 界面增量依据

同日用户追加确认正文评论气泡复用顶部工具栏的MessageSquareText图标，PDF-OBS-008升级为v`0.2`；文字评论、点评论与草稿图标均由`pdf/Page.tsx`持有，位置与交互保持不变，`pdf/pins.render.test.ts`覆盖真实点击坐标、定位及图标一致性。

PDF-OBS-008/009由本次用户逐项截图、明确尺寸、颜色、交互和最后的默认十行/调整高度滚动要求采用，适用于本次checkout的开发修订；不将其归入202610301343安装包的已知能力。设计文件203335358980331中593:81210的原文为PingFang SC 12px/18px、字重400，页码为10px/16px；源节点442:089081的导航按钮为28×28、8px圆角、4px间距。链接中的实例路径返回空节点时改读其明确提供的source_layer_id，不凭截图比例推断。

源码入口为`PdfDocument.tsx`、`Selection.tsx`及`pdf/Annotations.tsx`、`Annotation.tsx`、`Comment.tsx`、`Reading.tsx`、`Tools.tsx`，共享紧凑翻译控件位于`translation/Controls.tsx`，生成笔记列表位于`literature/Generate.tsx`。均相对`src/renderer/src/features/workbench`或其上级features目录定位。回归覆盖导航键盘、标注与评论编辑、激活状态、默认十行及调整高度后的滚轮和渐变；单次界面验收不代表模型输出质量、Windows或全量发布快评通过。旧基础阅读采用范围与冻结记录保持不变。

## 历史修订：202610301343包内静态复核

资产修订：`pdf/5`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。
- `renderer/assets/PdfDocument-CDP-g4K8.js`：SHA256 `e9bc5c697c23ec41d93696c9c8998e56c1885dcf52b03f511c5f37e99f2af335`。

包内PdfDocument:65463读取session/tab，65634–65652重载清页数并取PDF解析pageCount；65739 navigate按pageCount裁决目标、更新页状态并滚动实际页节点；66647/66682按钮按边界禁用。原两页sample.pdf与正常阅读/翻页链相容，独立页数和两页特征不变；仅选001/002一次有效翻页，不将注册或计数变化当正文显示。原003缩放历史不符合及目录/查找/异常专项保留，新chunk与源码存在不能改写该历史结论。MRU、PDF辅助记录与索引初始化仍需执行权限，不称零状态写。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：pdf/4。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及独立需求/数据Review。PDF-OBS-001–006的正常加载、翻页、缩放（自定义10%–500%）、原生目录、查找与缩略已采用；004目录读取失败、005文本/查找失败及007损坏、加密、局部加载/渲染失败的反馈与恢复仍待确认，保留专项，不批准失败混同无目录或零命中。全部未实测，采用不授予产品操作或额外读取权限。

修订2的合成多页/目录输入及独立属性保留；本修订仅变更采用状态，七个ID、判据和需求版本不变。选区/批注/AI阅读及生成/保存仍另行覆盖，不由基础阅读扩大权限或推定通过。

## 精确制品绑定

目标为已安装macOS 0.3.0 / 202610281438 / preview，Info.plist及product.json与目标相符。重新读取ASAR SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`；其`out/main/index.js:41022`的packaged serveAssets链指向`applicationResources(app)/renderer`。以下为`Contents/Resources/renderer/assets/`的重核摘要：

| 文件 | SHA256 |
| --- | --- |
| index-C4-PYlXk.js（index） | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js（workspace chunk） | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| PdfDocument-y2KblsYr.js（PDF chunk） | `ce55e6d5a9cee62662b9c655a73365587b9ed0d6fbe4b06a1755c6cabc18ab99` |

index:64402显式导入此PDF chunk，PDF chunk开头又从index/workspace chunks导入几何工具及工作台契约，本文仅核所读函数，不声称整仓同源。PDF.js加载、文字层和canvas实现来自此真实打包阅读器；后端旧pdf字节路由的“Chromium内置、不自带pdf.js”注释与当前renderer不符，不能据旧注释改判渲染路径或批注能力。

以下Owner逐文件比较仓库`apps/serve/`与安装包`Contents/Resources/backend/python/lib/python3.12/site-packages/`，SHA256两边一致：

| 相对路径 | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/workbench/domain/model.py | `4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| service/workbench/service/records.py | `c3071a67b5e65262c0cad4c73b0f72bcadae8beda52ccf1a7ae556c073ecd708` |
| service/workbench/service/regions.py | `7621aad37e095c3df6714bc302c98cef70c3174456d957b01b1b184f019679be` |
| service/workbench/service/indexing.py | `9e25b9983f3e1b522e03ff1d85b8f1158428c653363bcf5868eaca4f4dbe8361` |
| service/platform/citations.py | `53830408d916c00ae0ddcd4467e2c4363a6118e34635ff869b0e4b82b0e4b1ea` |

## 固定、动态与条件链路

| 条目 | 源码及打包定位、预期参照 |
| --- | --- |
| 001 动态/条件 | [PdfDocument.tsx](../../../src/renderer/src/features/workbench/PdfDocument.tsx):343/482建立getDocument与PdfLifecycle，active且有bytes才加载；PDF chunk:64905起，:65109附近读取原生目录。[lifecycle.ts](../../../src/renderer/src/features/workbench/pdf/lifecycle.ts):64的open按generation排除过期结果、读取numPages并加载目标页，存在内嵌ScholarSeed批注附件时先恢复再开。[api.ts](../../../src/renderer/src/features/workbench/api.ts):385通过项目open/content取得身份、能力、revision与字节；[routes.py](../../../../serve/service/workbench/api/routes.py):156依据snapshot、大小及格式能力投影，:235 content提供ETag/内容。[model.py](../../../../serve/service/workbench/domain/model.py):227的PDF默认can_edit=false，不代表不能翻阅；不拿扩展名替代公开viewer/capabilities。文档外壳、页数与渲染状态分开核 |
| 002 动态 | PdfDocument.tsx:615 navigate更新页码并scrollIntoView，:1323 onScroll由最可见页更新页码；PDF chunk:65182/65829。[geometry.ts](../../../src/renderer/src/features/workbench/pdf/geometry.ts):142/355及index:59751/59939分别钳制物理页序、比较可见高度。工具栏:1636输入在Enter/blur提交；快捷跳页对话框:1531/2226只接受有效整数，PDF chunk:66143/66729。工具栏非法页输入的钳制与跳页对话框校验不同，不强求同一错误文案；已知页特征与真实视口才证明到达 |
| 003 动态/固定范围 | PdfDocument.tsx:596/1177按页面尺寸和可用视口计算fit或custom scale，:1594起为减、PdfScale、加。[Scale.tsx](../../../src/renderer/src/features/workbench/pdf/Scale.tsx):49–116单击切换page/width，双击编辑百分比，Enter/blur提交、Escape取消；PDF chunk:64695。[zoom.ts](../../../src/renderer/src/features/workbench/pdf/zoom.ts):33与PDF chunk:64797处理Ctrl/Meta滚轮及限幅，PdfDocument.tsx:1182保留缩放锚点。[geometry](../../../src/renderer/src/features/workbench/pdf/geometry.ts):20/149/159及index:59673/59758固定0.1–5、步长0.25，percentScale处理百分比。自定义10%–500%正常范围已采用，其余数值保留为实现参照，不是截图固定像素 |
| 004 条件 | PdfDocument.tsx:524从PDF getOutline取原生目录，经[navigation.ts](../../../src/renderer/src/features/workbench/pdf/navigation.ts):193的outlineTree逐层解析named/explicit destination及物理页；PDF chunk:45890。[Outline.tsx](../../../src/renderer/src/features/workbench/pdf/Outline.tsx):18/36/70提供层级折叠与可解析目标导航，PDF chunk:62095/62159。无dest条目aria-disabled且不跳页；getOutline失败catch也清空目录，与真正无目录呈现混合，是待验证缺口，不能批准为正确异常语义 |
| 005 动态/条件 | PdfDocument.tsx:695将query延迟后按8页一批getTextContent、hasEOL拼接，调用matchText；PDF chunk:65257起。[geometry.ts](../../../src/renderer/src/features/workbench/pdf/geometry.ts):164及index:59773采用大小写不敏感、空白分词匹配，非OCR/语义检索。:1170/1858提供命中列表及前后环绕定位；PDF chunk:66396。Page.tsx:348将文本层match映射到可见高亮，命中数/页与事前核验样本比较，不以搜索自身结果列表作唯一答案 |
| 006 动态 | PdfDocument.tsx:1812按pageCount创建缩略入口，PDF chunk:66335；[Page.tsx](../../../src/renderer/src/features/workbench/pdf/Page.tsx):857的PdfPageSlot及PDF chunk:46580使用IntersectionObserver近页加载，主文档与缩略均允许暂时占位，缩略不建文字层。点击仍走navigate而非仅改选中态；缩略图可辨内容、物理页序与正文位置共同核 |
| 007 条件 | [loading.ts](../../../src/renderer/src/features/workbench/pdf/loading.ts):15将PasswordException/EncryptedPdfError归加密，其余归unknown，PDF chunk:61859；PdfDocument.tsx:1506/1555展示专门加密态，:1761展示普通loadFailed或source不可用，:2005为加载中。Page.tsx:293/529对canvas渲染失败显示pageRenderFailed。后续页getPage拒绝路径、文字层失败后已有canvas的提示覆盖待核，不能把“当前catch有覆盖”当完整错误恢复能力；没有凭据不得尝试解密或外部打开 |

键盘真实入口为[shortcuts.ts](../../../src/renderer/src/shortcuts.ts):187–204及PdfDocument.tsx:1242，PDF chunk:65752：只对focusedTab生效，普通可编辑输入中不拦截PDF命令，前后命中仅搜索框聚焦时响应。按平台/快捷键覆盖配置解析，不在正文固化全部键位；基础翻页、查找、缩放按对应已采用正常要求核真实内容变化，批注/复制命令不因此获准。

## 独立参照及阅读状态边界

项目公开GET `/api/workbench/open`顶层的project_id/path/asset_id/revision/viewer/content_kind/capabilities核文档身份与预览能力；GET `/api/workbench/content`的字节/ETag可与获准样本摘要关联。该open投影不提供原生目录、全文命中或阅读器实际页位置，不凭API成功推断跳页/缩放正确。

公开GET `/api/workbench/pdf/regions?project=…&path=…&revision=…&start_page=…&end_page=…`在routes.py:293/306校验revision与PDF媒体类型，[regions.py](../../../../serve/service/workbench/service/regions.py):17返回source_revision、page_count、unavailable_pages及区域元数据，可在获准范围内辅助独立核页数，但不是原生目录或全文搜索答案，也不能替代已知样本及UI位置。此读取会进入[indexing.py](../../../../serve/service/workbench/service/indexing.py):267/299，页数与页面结果可能写入索引缓存，不能称为绝对零写的参照查询。

每个已选数据在执行前须有相同revision的总物理页数、至少两个可区分目标页特征、原生目录有无/层级/目标、文本层有无及已知查询命中页/次数。随场景样本已给出下述独立输入属性；运行仍须核所用字节摘要与来源，无参照保留未覆盖，不能从本轮待判阅读器反推答案再自证。

PdfDocument.tsx:297/470从tab.viewState读写page/scale/mode/sidebar/query/navigationWidth；[workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):2080只publish标签viewState，workspace chunk对应setTabViewState。:655在重挂载或几何改变后定位当前页；这是当前进程/标签状态，不是已证明的重启后阅读进度持久化。阅读状态或分屏独立性若专项加入，须对照动作前可见记录，不能读内部store自证。

已复用[DESIGN](../../../DESIGN.md)与[vibe](../../../docs/design/vibe-coding.md)约束：阅读区内部滚动，工具栏与导航在支持窗口边界内可达；源码结构与静态门禁不代替主题、窄窗和键盘真实证据。

## 副作用、数据与缺口

正常项目打开会沿[store.tsx](../../../src/renderer/src/store.tsx):3140/3196更新recentFiles，文献打开recorder在:1813更新recentLiterature；这些进入:1881的偏好提交链，不承诺打开即零写。PDF active时:563订阅/读取records，[records.py](../../../../serve/service/workbench/service/records.py):107/148的snapshot_asset在缺辅助记录时可catalog.create，虽不改原PDF也会初始化辅助持久状态。:1420还会自动读取邻页visual regions，触发前述索引缓存；真实文献的Reading.tsx:364/410会读既有AI结果，不证明调用了模型，也不授予AI生成权限。文件源、内置源和文献源不同，不外推所有伴随记录Owner已完整覆盖。

[sample.pdf](../../../../../examples/projects/evaluation/files/sample.pdf)由仓库[最小项目样本](../../../e2e/fixtures/data/minimal-project/sample.pdf)及[预览样本](../../../e2e/fixtures/preview_pdf_1MB.pdf)各取一页，增加原生目录，作为新的合成输入；保留原页文字，不继承原预览文件的1MB定长属性。实际文件2182字节，SHA256为`ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`，未加密、无表单、无JavaScript，尚未导入产品。这是测试输入，不是产品截图、完成状态或真实文献。

两页分别含“Minimal sample PDF”和“PDF Preview Test”。原生目录父项“Synthetic reading sample”指向物理第1页，其两个子项“Synthetic overview”“Synthetic detail”分别指向第1/2页；可核层级展开及跨页跳转。独立文本参照：“Needle”仅第1页1处，“padding”仅第2页1处；不区分大小写的“PDF”第1页1处、第2页2处，共3处；“NO-MATCH-SYNTHETIC”无命中。源文中原有padding表述不作为本文件尺寸预期。

生成配方仅为用pypdf按上述顺序合并原页并添加三项目录及合成数据元信息；生成、独立解析和两页渲染核验事实保留于忽略运行记录，不作为产品验收。原有[引导样本](../../../src/renderer/src/features/onboarding/assets/sample.pdf)及上述两份源PDF均为单页无原生目录，可复用对应分支，不能替代本样本的多页/目录检查。长缩略列表、超过8页的分批查找、扫描、损坏、加密及局部失败资料仍未就绪，不以小样本缩减原业务或宣布完整覆盖。

[onboarding/sample.ts](../../../src/renderer/src/features/onboarding/sample.ts):4/8与index:71586–71607绑定builtin:onboarding-v1，读取随包字节、只读、不可批注/保存，明确不调用文献导入。该单页无目录样本可作基础渲染输入，不能替真实literatureId/attachmentId、多页场景或证明AI业务，也不把源码注册成功当产品已通过。

未明/待观察包括真实PDF入口、错误及加载完整覆盖、原生目录读取失败与无目录混合、后续页获取拒绝、文本层失败反馈、真实样本适用性、活动页与缩放后的视口对应、快捷键配置/焦点行为和跨重启恢复边界。没有本页产品运行或真实参考图，不造图、不建机器三件套；条件不足保留已采用要求与待确认异常，不宣布通过或修改产品以制造验收。

## 发布快评分层（2026-10-30）

本资产修订为pdf/4；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为PDF-OBS-001、002的正文明确子要点；必要参照为已有eval-pdf-20261030.pdf；原件两页文本/页数及build摘要。未选范围为缩放/限幅（保留003历史不符合）、目录、查找、缩略图及异常，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。

## 当前参考图修订：pdf/37

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-examples/evidence/pdf-page1-ready.png` 的未改动副本，SHA-256 `fa7bd5c9c760ccb0f83460773f0938fab78c57d3f058fa1989bf6d57111725f9`；仅展示合成 PDF 首页，不证明其它交互或异常。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`，不改变需求或历史裁决。
