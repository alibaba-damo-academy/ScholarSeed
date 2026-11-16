# PDF基础阅读

PDF 查找无匹配显示状态

参考：macOS arm64 `0.3.2 / 202611121823 / preview`，2026-11-13；合成 PDF 的一次无匹配查询，完整视口中正文因并排面板较窄仅部分可见，不代表其他查询或正式评测通过。

PDF 阅读页面参考

参考：macOS arm64，0.3.2 / 202611121104，2026-11-12；合成 PDF 的第一页，不代表批注、选区或异常状态。

两页合成 PDF 的第一页

两页合成 PDF 的第二页

参考：macOS arm64，0.3.2 / 202611121823 / preview，2026-11-12；两图分别展示 PDF-OBS-001、002 的第一页和第二页状态。截图不单独证明翻页动作，也不代表目录、缩放、批注或异常已验证；来源见[构建依据](./build.md)。

目录选中第二页

目录选中第一页

查找第三处状态

查找第二处状态

参考：macOS arm64，0.3.2 / 202611121823 / preview，2026-11-13；前两图分别展示两页合成 PDF 的目录选中状态，后两图展示查找第三处及第二处状态。静图不单独证明跳转、命中定位或切换动作，不代表十页样本及其他 PDF 要求通过；来源与本轮独立评审边界见[构建依据](./build.md)。

选中第一页缩略图

选中第二页缩略图

参考：同一目标版本，2026-11-13；分别展示两页合成 PDF 的缩略图选中及对应正文状态。静图不单独证明点击或跳转，不代表长缩略列表、十页样本、异常或完整 PDF 功能通过。

PDF 普通放大状态

PDF 普通缩小状态

PDF 适应状态

参考：同一目标版本，2026-11-13；两页合成 PDF 在当次分屏布局下的普通放大、缩小和适应状态。放大图的正文部分被视口裁切；适应页面与适应宽度的原图在该布局下字节相同，仅复用一份。静图不能单独证明模式、缩放动作或几何关系，不代表极限、其他布局及完整 PDF 功能通过。

## 标注退出与笔记布局补充约束

持续标注按钮保持鼠标悬停或键盘焦点、提示已显示时，按一次 Esc 仍须退出模式；不要求先点击正文或移开鼠标。随后划选只产生临时选区，不新增已保存标注。颜色子菜单与批注输入仍保留自身的 Esc 优先级。

One Escape must exit continuous annotation even while its button remains hovered or keyboard-focused with a visible tooltip; moving the pointer or focusing the document first is not required. Subsequent selection stays temporary without creating a saved mark. Color menus and comment inputs retain their Escape priority.

按2026-11-12用户确认修复的 Bug 88837628，当前 PDF 的临时文本选区及选中标注工具栏可通过 Esc 退出；持续高亮或下划线模式退出后，再划选不得继续自动标注。退出保留已保存标注。输入法组合、输入框、内层弹窗及已消费 Esc 的交互保留优先级，不清理其他分屏文档。

按同日用户确认的 Bug 88838604，PDF 笔记面板支持拖动左边框和键盘调整宽度，提供铺满 PDF 阅读区域与恢复入口；展开/恢复保留调整后的宽度、正在编辑的内容与同一编辑器实例。AI 解读既有分栏和展开行为不变，信息面板不因此改变布局。

两项为已确认专项补充，不新增基础阅读快评分母，不推定操作系统级全屏；独立需求版本未指定，沿用原稳定 ID 与版本标记。回归关联 PDF-OBS-003、008、009 及文献笔记专项，真实数据写入与产品启动权限仍单独核验。

For user-confirmed Bugs 88837628 and 88838604 (2026-11-12), Escape dismisses the current PDF selection or selected-annotation toolbar and exits continuous highlighting or underlining without deleting saved annotations. Editable fields, IME composition, nested overlays, consumed events, and other document panes retain their interaction boundaries. The notes panel supports left-edge and keyboard resizing, filling the PDF area, and restoring its width and the same editor with its draft intact. Existing interpretation and information-panel behavior remains unchanged. These are supplemental checks, not OS fullscreen or additions to the basic-reading quick-check scope; existing requirement IDs and version markers remain unchanged.

已核实的正常PDF阅读与定位行为已采用为v`0.3`需求；004–005的目录/文本读取失败及007异常反馈、加密与局部失败分支仍待确认，不随正常阅读一并批准。

在工作台阅读PDF，通过页码、缩放、目录、查找和页缩略定位内容。语义入口为资料正常打开后的PDF阅读器；引导内置示例也可展示阅读器，但不代表真实文献或AI能力，具体入口待授权观察。

## 阅读与定位页面

### 加载与文档身份（PDF-OBS-001 · v`0.3`）
动态与条件：具备预览能力的有效PDF应从加载状态进入可辨认正文，工具栏总页数与同一份已核验样本的实际页数一致；未加载的页占位不算正文已呈现。对照本轮文档身份、公开来源及样本摘要，不把文件后缀或阅读器外壳出现当成加载成功。

### 页码与翻页（PDF-OBS-002 · v`0.3`）
动态：上一页、下一页、页码输入及适用的翻页/首末页/跳页快捷操作，应到达样本已知的目标页，当前页码随实际主要可见页面变化且不越界。用页码、目标页独有正文或图案及操作前后实际位置共同判断，不用输入框变化或按钮确认自证跳页成功；物理页序不等于正文印刷页码。

按2026-11-11用户两张截图确认的引用定位专项：会话文献引用含多处依据时，“上一处依据 / 共N处或当前位置 / 下一处依据”使用带上下箭头的浮动条，位于PDF阅读区右上方、顶栏下方，不挤占或遮挡顶栏翻译设置与导出操作，也不覆盖右侧工具栏。浮动条不随正文滚动；窄分栏仍可访问按钮。依据顺序、计数、首尾禁用、真实定位和高亮保持原语义；单处或无依据不展示切换条。本专项不扩入基础阅读快评分母。

Citation-location supplement confirmed by the user's two screenshots on 2026-11-11: when a conversation citation contains multiple evidence regions, previous/count-or-position/next actions appear in a floating toolbar with up/down arrows at the upper right of the PDF reading area, below the header. It must not overlap translation settings, export, or the side rail. It stays fixed while pages scroll and remains usable in narrow panes. Evidence ordering, counts, boundary disabling, actual navigation, and highlights retain their semantics; zero or one region shows no navigation strip. This supplement does not expand the basic-reading quick-check scope.

导航侧栏展开后仍不得裁切浮动条按钮及箭头；空间不足时文本可省略，但保留完整提示与可访问名称。正文高亮不得覆盖浮动条。

An open navigation sidebar must not clip the floating toolbar's buttons or arrows. Labels may truncate when space is limited, while full tooltips and accessible names remain available. Document highlights must not paint over the toolbar.

引用定位先即时跳到目标页，再在该页内平滑滚到高亮；开启系统「减少动态效果」时页内也即时定位。只有页码时直接跳页。跨远页验收应观察滚动过程，确认没有逐页扫过，再核对目标页码和原文高亮。

Citation navigation jumps immediately to the target page, then scrolls smoothly within that page to the highlight. With reduced motion enabled, the within-page move is also instant. A page-only citation just jumps to the page. For distant citations, observe the transition to confirm it skips intervening pages, then verify the page number and source highlight.

### 缩放与适应模式（PDF-OBS-003 · v`0.3`）
动态：放大、缩小、百分比编辑、适应页面/宽度切换及适用快捷操作应改变真实正文尺寸，百分比与实际模式对应，缩放不误换文档或丢失当前阅读页。自定义缩放范围为10%–500%；以已知页面纵横比、当前可用阅读区及操作前后关系判断，不固定截图像素，也不把百分比显示变化单独当成缩放成功。

## 从内容找到页面

### 目录结构与目标页（PDF-OBS-004 · v`0.3`）
条件：有原生目录的样本应显示对应标题与层级，展开/折叠及可解析条目的跳页与事前已知目录目标一致；无可解析目标的条目不能误跳。没有原生目录的PDF可以显示无目录状态，不要求从正文标题自动生成目录；已知有目录却读取失败不能当无目录正确通过。

按2026-11-11用户截图及明确尺寸要求，目录展开/折叠按钮为28×28px，内部箭头为14×14px；标题行及选中、按压、hover背景高度统一为28px，一级、二级、三级及更深层级保持一致，不改变缩进、展开和跳页行为。

Per the user screenshots and explicit sizing request on 2026-11-11, outline expand/collapse buttons measure 28×28px with 14×14px arrows. Title rows and selected, pressed, and hover backgrounds remain 28px high at every depth, preserving indentation, expansion, and page navigation.

### 文本查找与命中定位（PDF-OBS-005 · v`0.3`）
动态与条件：在查找区输入样本已知文本，结果条目、命中数量及前后命中切换应与事前核验的文本和所在页对应，选择结果后正文定位到实际命中。区分查找中、无匹配、无文本层和查找失败；纯扫描PDF不承诺可搜索或自动OCR，不能把无文本层当作找不到已知可搜索文本。

### 页缩略与正文对应（PDF-OBS-006 · v`0.3`）
动态：页缩略区显示对应物理页序和可辨认的缩略内容，滚动到后续缩略后可继续查看；选择目标缩略应使正文到达该页，当前页指示与正文一致。以已知目标页特征及真实前后位置核对，不要求所有远端缩略在首次打开瞬间都完成渲染。

## 理解不可阅读状态

### 错误、受保护文件与加载边界（PDF-OBS-007 · v`0.3`）
条件专项：损坏或无法渲染的PDF应给出与失败层级相符的可理解反馈，不冒充正文已就绪；已知加密文件应与普通损坏文件区分，不能要求在内置阅读器完成未提供的解密流程。加载与错误须依据已知样本性质或独立失败前提判断，不因一个瞬时加载画面宣布失败；系统外部打开属于另行授权动作。

## 验证归属与数据

001–006已采用的正常分支归普通阅读快评，前提为已有获准可读样本及独立页数、目标页特征、目录/文本层资料；单页或无目录资料不能代表多页、目录、命中切换分支完成。007及特殊故障分支仍为待确认的条件专项，缺数据保留待覆盖，不事后移项追绿。

[共享示例项目的两页合成PDF](../../../../../examples/projects/evaluation/files/sample.pdf)有文本层及两级原生目录；“Needle”仅在第1页，“padding”仅在第2页，“PDF”跨页共3处，供跳页、查找和缩略对照。准备状态以本轮收据为准；损坏、加密及局部失败数据仍待准备，长缩略列表和大文档行为不由此覆盖。

[单页图片型合成 PDF](../../../../../examples/projects/pdf-image-only/files/image-only.pdf)的可见文字位于图像中，没有文本层，可供无文本层条件专项准备；它不承诺 OCR 或具体查找结果，也不代表真实扫描文件的全部情况。输入身份及独立核验见[构建依据](./build.md)；文件是原始输入，不代表已导入或产品通过，导入由人工确认并核隔离目标及权限。

[独立十页合成 PDF](../../../../../examples/projects/pdf-multipage/files/multipage.pdf)每页有独立页号标记，`CROSS-BATCH-NEEDLE` 只在第 8、9 页出现，可供多页查找与后续缩略定位专项使用；输入身份及独立解析见[构建依据](./build.md)。它不替代默认两页快评，不证明加载、查找或导入成功；导入由人工确认，执行须核隔离目标及权限。

阅读可伴随最近打开记录、导航偏好及索引/辅助记录初始化，不承诺零写入；进入真实流程前明确允许这些副作用。选区、批注、导出/生成/保存及AI阅读仍是独立业务范围，不在本页通过分母中，也不因本页基础阅读通过而视作已验证。

## 发布快评层

采用v`0.3`的正常子要点：PDF-OBS-001、002；仅代表下述范围，不代表这些ID全部细则通过。

正常打开已知两页PDF后，正文身份与页数应对应独立原件；作一次有效方向的普通翻页，页码与目标页独有正文同时变化。不以页码变化代替正文变化。

必要参照：[共享 sample.pdf](../../../../../examples/projects/evaluation/files/sample.pdf)的获准隔离副本；原件两页文本/页数及build摘要。数据准备不等于导入功能测试，导入测试由人工确认。

## 专项层

本层未选：缩放/限幅（保留003历史不符合）、目录、查找、缩略图及异常。原完整判据、稳定ID、版本和历史结果保留；未确认分支不因分层获批。

## 2026-11-05 已确认界面专项

以下为用户在本次开发中明确确认的增量要求，不追改001–007的版本、历史结论或既有冻结运行。

### 导航与标注记录（PDF-OBS-008 · v`0.2`）
按2026-11-11用户截图确认，左侧纯评论卡片点击评论正文时，必须返回对应页的评论气泡位置并显示定位态；支持键盘触发。复制、展开收起及编辑不触发定位，评论文字仍可选择。自动缩放或布局变化不得将明确的评论定位抢回打开文献时的原引用。

Per the user screenshot confirmed on 2026-11-11, clicking the body of a comment-only sidebar card reveals its page's comment bubble and focused state, including keyboard activation. Copy, expand/collapse, and editing must not navigate; comment text remains selectable. Automatic fitting or layout changes must not replace explicit comment focus with the citation that originally opened the document.

存在引用浮动条时，阅读区根据浮动条实际高度留出页首空间，换行后的浮动条也不得遮挡页首评论气泡。

When a citation toolbar is present, the reader reserves initial space using its measured height so even a wrapped toolbar cannot cover comment bubbles at the top of the first page.

按2026-11-10用户确认，文献导航栏默认宽度为260px，保留用户调整后的宽度；评论复制按钮默认使用icon-outline-default。

按2026-11-10用户确认，正文点评论和草稿入口与右侧评论浮标统一使用中性色背景与outline图标色，评论输入复用工具条输入样式，占位文案为“添加评论”（英文“Add a comment”），保留保存和取消操作。

按2026-11-10用户最新截图确认，新建点评论及正文已有评论入口直接展开划词/标注工具条中的评论区，不再单独展示紧凑输入弹窗；工具条评论按钮为激活态并聚焦输入框，侧栏内联编辑保持原流程。点评论无选中文本时，格式、解释、翻译和原文复制操作不可用，不伪造原文来源；新草稿保存失败时保留输入，取消或Escape不创建记录。

按2026-11-10用户确认，PDF选区及标注浮层工具栏默认保持单排，评论图标不换行；可用宽度不足时在工具栏内横向滚动，不压缩或隐藏操作。

按2026-11-10用户确认，标注筛选的高亮图标与顶栏统一使用Lucide Highlighter，各类别页签提供对应名称的Tooltip，保留原键盘导航与选中逻辑。

按2026-11-10用户确认，全文档无标注时使用“暂无标注”（英文“No annotations”），类别筛选无结果文案保持不变。

按2026-11-10用户确认的增量要求，PDF侧栏大纲、标注记录（含类别筛选）及搜索无结果空态在各自内容区域水平、垂直居中，使用12px常规字重；无大纲文案为“暂无大纲”（英文“No outline”）。页面预览保留真实缩略图，不伪造空态。

按2026-11-10用户确认的增量要求，“更多操作 → 修改标注方式”的二级工具栏在父菜单右侧展开；标注颜色按钮的交互背景左右各留4px内边距，展开箭头使用icon-outline-default语义色。

按2026-11-10用户确认的增量要求，标注类别筛选选中时仅文字加粗，图标保留未选中时的描边粗细。

正文中的文字评论、点评论及草稿气泡，统一采用顶部工具栏同款带横线的评论图标，不改变评论定位或编辑行为。

页码输入框为28×28逻辑像素。工具栏图标使用outline语义色；文献导航保留左侧位置，与下方导航首个按钮左边距均为12px。导航按钮tooltip依次为“文献导航”“目录”“页面预览”“标注记录”；下方三个按钮为28×28、8px圆角、4px间距。

标注卡片不在页码前显示方式图标，原文及评论正文为常规体12px/18px。左侧“编辑”浮层仅提供方式和颜色修改，评论编辑框默认保留三行可见空间。评论和AI解释的复制操作复用工具条同款复制图标；生成笔记弹窗的标注列表不显示上下滚动阴影。

### 划词面板与翻译滚动（PDF-OBS-009 · v`0.1`）
按2026-11-13用户确认的 Bug 88916076，划词翻译完成后，结果底部提供“添加到会话框”，将该结果对应的完整原文和译文一起加入草稿，不自动发送；解释结果保留相同入口。顶部工具条入口仍添加原文上下文，不替换成译文。生成中、无结果或空结果不提供结果加入操作；保留复制及添加为评论。按钮在常规与最小支持窗口下可见并支持键盘操作。本项为专项补充，保留原稳定 ID、版本及基础阅读快评分母。

Per user-confirmed Bug 88916076 on 2026-11-13, completed selection translations expose a footer action that adds the complete original text and its translation to the conversation draft without sending. Explanations retain the same action. The top toolbar still adds original-text context, not the translation. Generating, missing and empty results do not expose the result action. Preserve copying and adding comments. The action remains visible and keyboard-accessible at normal and minimum supported window sizes. This focused supplement preserves the existing ID, version and basic-reading quick-check scope.

按2026-11-12用户批准的 Bug 88834262 重开修复方案，划词翻译结果绑定本次选区、文档修订、目标语言及请求身份。改选区首次翻译沿用明确选择的目标语言；仅修改配置而未刷新时保留旧译文，并标明其实际语言。明显违反中英文目标语言或遗漏正文的结果不得作为完成译文展示、复制或缓存；语言校验失败最多按同一原文和目标语言纠正一次，仍失败显示错误，不无限重试。本约束不宣称通用语言识别或翻译质量保证；保留作者、术语、年份和标识符。沿用本项需求版本，竞态和拒绝分支属于专项回归，不扩大基础阅读快评分母。

Under the user-approved reopened Bug 88834262 plan on 2026-11-12, selection translations bind to the current selection, document revision, target language, and attempt. A new selection retains the explicitly selected target. Changing configuration without refreshing preserves the old translation and identifies its actual language. Clear Chinese/English target contradictions or omitted prose must not become completed, copyable, cached translations. Language validation permits at most one correction using the same source and target; a second failure remains an error, not an unlimited retry. This is not general language identification or translation-quality certification. Preserve names, terms, years, and identifiers. Keep the existing requirement version; race and rejection branches remain focused checks outside the basic-reading quick-check denominator.

按2026-11-12用户确认，会话产物PDF也支持划词工具条：开关开启后选择真实文本，应显示解释、翻译、添加到会话和复制；关闭开关隐藏普通工具条，重新开启后可再次使用。复制应与选中文字一致，添加到会话保留完整选区且不自动发送；解释和翻译使用原产物身份与修订，不要求先导入资料库或文献库，不因此授予编辑、标注或版本管理权限。本增量需求版本未指定，保留既有标记，不扩大基础阅读快评分母。

按2026-11-12用户补充截图要求，PDF划词悬浮工具条及展开的解释、翻译、评论气泡限制在当前文献阅读视口内，与上、下、左、右边界至少保持20px。滚动后选区离开可见区域、拖动、调整浮泡大小、收放侧栏或改变阅读区尺寸时均保持该约束；空间不足时限制浮泡尺寸，内容在内部滚动，不覆盖文献顶栏、导航或其他面板。

Per the user's supplementary screenshot on 2026-11-12, PDF selection toolbars and expanded explanation, translation, and comment bubbles remain within the current document-reading viewport, at least 20px from each edge. Preserve this boundary when the selection scrolls out of view, the bubble moves or resizes, the sidebar toggles, or the reader changes size. Constrain oversized bubbles and scroll their content internally instead of covering the document header, navigation, or other panels.

按2026-11-11用户截图及明确文案要求，放大结果面板的缩小按钮tooltip显示“缩小”（英文“Shrink”），不再显示“还原 PDF 面板”；仍将结果恢复为紧凑浮层，保留正文及原有操作。

Per the user screenshot and explicit wording request on 2026-11-11, the expanded result panel's shrink tooltip reads “缩小” / “Shrink”, not “Restore PDF panel”. The action still restores the compact overlay and preserves content and existing controls.

按2026-11-11用户截图及明确文案要求，划词和标注工具栏的解释入口显示“AI解释”（英文“AI explanation”）；下方提交按钮仍为“解释一下”（英文“Explain this”），激活态及动作保持不变。

Per the user screenshot and explicit wording request on 2026-11-11, selection and annotation toolbars label the explanation action “AI解释” in Chinese and “AI explanation” in English. The submit button remains “解释一下” / “Explain this”; active states and actions are unchanged.

按2026-11-11用户截图确认，“解释一下”提交按钮仅展示文字，不显示前置装饰图标；划词及标注解释共用该规则，提示词设置图标、禁用和提交行为保持不变。

Per the user screenshot confirmed on 2026-11-11, the “Explain this” submit button is text-only in both selection and annotation explanations. The prompt-settings icon, disabled state, and submission behavior remain unchanged.

按2026-11-11用户截图确认，“配置已变更”提示使用常规字重400和text-placeholder颜色，不继承工具栏加粗；保留旧译文和显式刷新行为。此为补充视觉约束，不改变已有需求版本或基础阅读快评分母。

Per the user screenshot confirmed on 2026-11-11, the configuration-change notice uses regular 400 weight and text-placeholder color, without inheriting toolbar emphasis. Existing translations and explicit refresh behavior remain unchanged. This supplemental visual constraint preserves existing requirement versions and the basic-reading quick-check scope.

按2026-11-10用户确认，顶部复制与评论按钮组成右侧操作组，浮层加宽时保持靠右展示，不随前部文字按钮停留在左侧。

按2026-11-10用户确认，PDF选区不因窗口失焦、尺寸变化或点击其他任务而清除；点击当前文献空白处仍清除选区并关闭浮层。按2026-11-12 Bug 88838778 的修复要求，阅读来源隐藏或停用时必须隐藏普通划词工具条，不得继续遮挡会话；这不等于丢弃选区、未完成批注或用户明确固定的结果。阅读区仍可见而仅选区锚点滚出视野时，保留浮层并遵循阅读区限位要求。恢复阅读后可重新划词，已有批注草稿保留；文献关闭或版本身份失效仍不得复用旧结果。

PDF selections survive window blur, layout resizing, and task switching. Clicking blank space in the current document still clears the selection. Bug 88838778 requires ordinary selection tools to hide when the reader is hidden or inactive, without discarding selections, unfinished comments, or explicitly pinned results. When only the selection anchor scrolls offscreen, retain the surface within the visible reader's bounds. Restoring the reader permits selection again and retains comment drafts. Closed documents and invalid source revisions must not reuse stale results.

按2026-11-10用户确认，选区翻译的放大按钮位于操作组最右侧，与上方评论按钮右侧对齐，悬停提示为“放大”（英文“Enlarge”）；滚动区外壳不使用圆角，避免裁剪滚动条，不改变浮层整体圆角。

解释、翻译、评论展开时对应按钮保持激活；一次性标注、复制或添加到会话框不保持激活。浅色激活背景为rgba(103,73,15,0.08)。按2026-11-10用户确认的增量要求，选区及批注浮层工具栏的文本按钮文字使用text-primary、图标使用icon-outline-default；单图标按钮默认使用icon-outline-default，保持激活时改用text-primary。翻译控制按钮应在一行完整展示。

划词翻译正文14px，默认内容区最多展开十行；浮层默认空间应容纳十行，用户调整浮层高度后内容使用实际可用高度。超过可用高度时支持滚轮滚动，首尾渐变随滚动位置变化，不得只裁剪正文。翻译及选区解释不显示顶部进行中入口，也不显示内容区生成中、等待中或取消操作；保留真实错误提示。

本专项涉及实际标注及模型调用，需单独具备相应数据和操作授权；不自动加入原基础阅读快评分母。

### AI 解读转对话补充约束

按2026-11-12用户截图与确认，原顶部图标入口改为面板底部右侧的“继续与书深讨论”主按钮，带对话气泡图标，正文滚动时保持可达。入口在未生成、加载、生成中及仅有部分预览或降级结果时保持可见且禁用；完整解读可用后激活。重新生成期间再次禁用；取消后恢复上次完整解读时可继续讨论。沿用既有交接等待、防重复和失败恢复语义，不自动发送消息。

Per the user's screenshots and confirmation on 2026-11-12, replace the top icon action with a bottom-right primary “Continue discussing with ScholarSeed” button and a chat-bubble icon. It remains accessible outside the scrolling reading content, visible but disabled before generation, during loading/generation, and for partial previews or fallback results. Enable it only for an available complete reading; disable it again during regeneration and re-enable it when cancellation restores a complete saved reading. Preserve pending, duplicate-prevention, failure recovery, and no-auto-send behavior.

按2026-11-10用户确认，PDF及文献详情中的“与书深对话”应显示交接等待态并防止重复触发；文献上下文接纳成功且目标会话、项目和草稿身份仍一致后，展示可用的对话输入框、保留已有草稿并附加解读摘要。隐藏或最小化的项目对话恢复为可见分栏，不自动发送消息。成功后再关闭PDF解读面板，并显示待发送提示；失败时保留解读内容、解除等待态并显示可重试的错误。首次打开空输入框但已有文献上下文时，不重新初始化草稿身份。

此为本轮补充交互约束，独立需求版本未指定；不修改已有稳定ID、版本标记或基础阅读快评分母。回归覆盖已有解读交接、已有草稿、空草稿首开、任务切换、上下文拒绝与请求异常，不要求重新调用模型生成解读。

### AI 解读诊断入口补充约束

按2026-11-11用户确认恢复的要求（Bug 88834603），PDF及文献详情的AI解读整体隐藏“生成详情”入口和内部“技术明细”，不能仅默认折叠内容而保留入口。已保存结果有无诊断元数据均遵循同一规则；正文、引用及重新生成、与书深对话等既有操作不受影响。后台用量记录、首字时间上报与已保存元数据保留。

独立需求版本未指定；此为已确认的回归补充约束，不变更已有稳定ID、需求版本标记或基础阅读快评分母。验证已有解读即可，不要求重新调用模型。

Per the user-confirmed restoration on 2026-11-11 (Bug 88834603), PDF and literature readings hide the entire generation-details entry and its technical diagnostics, both with and without saved metadata. Merely collapsing the content is insufficient. Reading content, citations, regeneration, chat handoff, usage recording, first-token reporting, and saved metadata remain unchanged. No separate requirement version is assigned; existing IDs, version markers, and the basic-reading quick-check scope remain unchanged. Verification can use saved readings without a new model request.

2026-11-12 重开确认：上述要求也适用于新生成完成的结果，且不因生成详情与技术明细改成并列区块而改变。两入口均不得进入键盘焦点顺序；重新打开已保存的结果后仍应隐藏。新生成生命周期属于定向回归，不扩大基础快评分母或隐式授权模型调用。

Reopening confirmation on 2026-11-12: The same requirement applies to newly completed readings and is independent of nested or sibling diagnostic sections. Neither entry may enter keyboard navigation, and reopening saved results must keep both hidden. The generation lifecycle is a focused regression check, not an expansion of the basic-reading quick-check scope or implicit authorization for model calls.

### AI 解读失败呈现补充约束

按2026-11-13用户确认，PDF及文献详情共用以下行为：流式预览保留论文类型并使用对应章节标题；失败时保留已有完整解读，无完整解读时将部分生成正文默认折叠并提供查看入口；内部L1拼接资产不作为正式解读显示，不展示“基础解读 · L1”或逐条L1来源标签。显示可操作的失败原因和重试入口，后台资产、诊断与首字上报保持不变。此为专项回归，独立需求版本未指定，不改变原有稳定ID、版本和基础快评分母。

As confirmed by the user on 2026-11-13, PDF and library readings retain the paper type in streaming previews. Failed generation preserves an existing complete reading; otherwise partial prose is collapsed behind a view action. Internal L1 projections are not presented as completed readings or labelled as basic L1 readings. Keep actionable failure messages, retry, stored assets, diagnostics and first-text reporting. This is targeted regression coverage, with no new requirement version or change to existing IDs and quick-check scope.
