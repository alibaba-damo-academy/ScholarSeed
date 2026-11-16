# 选区加入对话：快照与来源证据

修改划词加入对话、选区上下文解析、文献附件加入/预览、文献笔记或来源校验时读取本页。它描述当前机制，
不是完整工作台需求或产品验收报告；查看器、编辑与版本管理仍由各自 Owner 维护。

按任务读取相关章节，不要求通读：选区发送看[快照与证据](#两种操作不能混用)，
输入或响应异常看[附件身份与错误反馈](#选区动作的来源身份与错误反馈)，
阅读追问看[引用与草稿](#阅读结果追问文献范围与文字草稿)，
框选/流替换看[图表临时结果](#图表框选与临时结果)，
翻译调度/页布局看[逐页翻译](#文献逐页翻译与页内分段)。
涉及模型目录、授权或出站来源时再追加[Serve 对应边界](../architecture/serve.md#模型目录执行键与凭据门禁)。

## 两种操作不能混用

| 操作 | 权威数据与边界 |
| --- | --- |
| 选区加入对话后发送 | `SelectionAnchor.snapshot_text` 保存用户加入时的完整正文；发送直接使用冻结文字，不重新读取源文件、比较版本或定位选区 |
| 解释、翻译、润色及写回 | 按所属动作校验来源、版本、定位和内容；只读动作的受限快照恢复不授予编辑或写回权限，见下文 |
| 整文件引用 | 遵循所属上下文 Provider 的读取与冻结规则，不自动改为选区快照语义 |

这项区分保证已加入的文字不会因文件修改、移动或删除而改变，同时避免将旧文字
误用作当前文件的编辑授权。`preview_text` 仅用于展示，不能作为完整正文的替代。
历史引用缺少完整快照时报告 `selection_snapshot_required`，要求重新选择并加入，
不回退到读取来源。完整正文仍受 Assistant 上下文容量预算约束，不静默截断为预览。

### 回复期间追加 PDF 选区

同一会话本轮已认领的选区 A 与回复期间新加入的 B 是两种状态：
[上下文补丁入口](../../apps/serve/service/assistant/api/routes.py)将 PDF anchor 用 JSON
模式规范化，避免请求模型中的 tuple 与持久化 list 在精确比较时误报修改；
[上下文 Owner](../../apps/serve/service/assistant/service/context.py)仍保持 A 不可变，
本轮终态只消费 A，B 留待下一轮认领。待发送区只呈现 B，不把已发送 A 当作新输入；
真正修改 A 继续返回 `assistant_claimed_refs_immutable`。改变此边界须核
[API 契约](../../apps/serve/tests/contract_assistant_context.py)及
[前端投影](../../apps/desktop/src/renderer/src/features/assistant/state.test.ts)，
并在真实两轮会话中核对待发送区、补丁结果和引用消费；历史 macOS 截图不能证明
当前版本或 Windows 已验收。

## 资料解释、翻译与润色

[Resources AI 路由](../../apps/serve/service/resources/api/ai.py) 提供独立的
`/api/resource/ai/explain`、`translate`、`polish` 和任务读取/取消入口，不复用
Agent Invocation 或文献任务协议。模型可用性与任务身份按实际路由的
`request_user_id` 校验，不从通用 owner 术语推导所有入口使用同一身份轴。
请求 source 是项目相对身份与 revision，选中文字快照需符合哈希，未保存草稿
另带 change_version；翻译必须提供目标语言。字段与限制由该输入契约维护。

[ResourceAIService](../../apps/serve/service/resources/service/ai.py) 先解析选区证据。
润色资格来自实际 `can_edit`，不只按旧 Markdown/DOCX 格式名单判断；接口返回
建议，不代替编辑器事务、撤销与显式保存。特定 PDF/旧 DOC 的只读动作在具名
可恢复错误且冻结快照有效时允许使用快照；不是所有格式、异常或润色的通用回退。
重复 attempt 不能改变输入/模型绕过幂等，取消 accepted 也不证明上游已停止。
返回 JSON 与 SSE 的错误/终态分别核验，断流或片段不作为可写回的完成结果。
验证入口为[资料 AI 契约](../../apps/serve/tests/contract_resource_ai.py)，另需真实
查看器选区、模型、流关闭及编辑写回验收。

[资料建议窗](../../apps/desktop/src/renderer/src/features/resources/Suggestion.tsx)的翻译
原文按实际渲染行数决定是否提供三行折叠，原文和译文各有滚动区域；尺寸或视口变化
由观察器触发位置约束，不能用固定窗口坐标代替。结果复制经
[剪贴板边界](../../apps/desktop/src/renderer/src/components/primitive/clipboard.ts)：
Desktop 优先走 preload IPC，普通浏览器保留浏览器权限检查；按钮出现或模型请求完成
不证明系统剪贴板已写入。定向核[几何契约](../../apps/desktop/src/renderer/src/features/resources/utils.test.ts)
与[剪贴板契约](../../apps/desktop/src/renderer/src/components/primitive/clipboard.test.ts)，
真实 Desktop 仍需从成功译文点击复制、读回系统剪贴板，并观察折叠、拖动、窄窗、
PDF/Markdown 两类选区。旧记录的翻译失败与单次订阅截图不能代替这一成功路径。

[选区宿主](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx)将建议窗标为
[文档选区交互区域](../../apps/desktop/src/renderer/src/features/workbench/focus.ts)，
使窗内按钮的按下事件不会先被外部点击处理清空选区并卸载结果。已完成的非替换
结果提供复制；润色的显式替换仍走编辑器操作，不由复制按钮代替。修改时核对
[选区契约](../../apps/desktop/src/renderer/src/features/workbench/selection.test.ts)，
并在真实 Office/Markdown 选区与成功模型输出后读回剪贴板；历史记录中模型
不可用导致的未完成验收不能作为此路径通过证明。

解释与翻译在结果提交后可固定建议窗；[选区宿主](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx)
在清空高亮后保留同一活动结果与生成状态，附着位置与选区是否仍可见是另一件事。
主动关闭、取消固定后的外部点击、切换文档或来源 revision 变化仍应结束旧结果；
不能为了固定浮窗而放宽来源身份校验。变更时核对[生命周期测试](../../apps/desktop/src/renderer/src/features/workbench/selection.render.test.ts)
及真实生成中、完成后、窄窗与取消固定操作，旧 macOS 截图不代表当前版本或
Windows 实机结果。

### Impress 选区：PPT 与 PPTX 不共用降级

[Office 选区采集](../../apps/desktop/src/renderer/src/features/workbench/office/selection.js)
从原生 transferable 获取实际高亮文本，在当前幻灯片唯一定位形状，投影 slide、
shape 与 UTF-16 范围；歧义时不把整个文本框冒充选区。拖选结束还由
[frame](../../apps/desktop/src/renderer/src/features/workbench/office/frame.ts)
显式提交最终选区，不能只依赖拖动中可能缺失的原生变化事件。

[格式分派](../../apps/serve/service/workbench/service/slides.py)将旧二进制 PPT 与
OOXML PPTX 交给不同处理器：PPTX 从当前权威源解析并复核 slide、shape、范围；
PPT 不让 OOXML 解析异常代替格式判定，返回需要冻结快照的明确结果。
[资料动作](../../apps/serve/service/resources/service/ppt.py)仅在源 revision 校验后，
对解释、翻译接受哈希匹配且长度受限的 PPT 选中文字快照；源过期仍拒绝，润色和
PPTX 不走此降级。选区加入对话使用本页前述冻结文本发送语义，不等于授权当前源
上的解释或写回。定向检查分别看
[Office 选区契约](../../apps/desktop/src/renderer/src/features/workbench/office/selection.test.ts)、
[PPTX 权威复核](../../apps/serve/tests/contract_pptx.py)与
[资料 AI 契约](../../apps/serve/tests/contract_resource_ai.py)；还需真实 PPT/PPTX
局部拖选、菜单与模型动作，旧截图不证明当前或跨平台验收。

### 个人选区提示词与临时要求

[提示词契约](../../apps/desktop/src/prompts.ts)现在按解读、翻译、润色、图表四项保存
用户可编辑要求；[设置页](../../apps/desktop/src/renderer/src/components/business/AccountPanel.tsx)
显式保存及逐项恢复默认，[用户偏好](../../apps/desktop/src/preferences.ts)持久化并在缺失、
空白、非字符串或超过 2000 个 JavaScript 字符单元时回退该项默认值。执行时
`selectionInstruction` 将对应个人提示词与本次临时要求分别去空白后组合；没有临时要求
仍可提交。资料建议与文献 PDF 选区的引导组件直接打开设置中的 `prompts` 页，
不新建另一份提示词配置或页面路由。该文字只影响本次动作输入，不授予扩大文件范围、
绕过来源/版本校验、改变
模型能力或改写服务端 JSON/证据约束的权限。文献 PDF 的选区解读/翻译与资料划词
各按所属动作接线，不能把四项设置外推为所有文献全文任务均消费个人提示词。
回归先跑[提示词契约](../../apps/desktop/src/prompts.test.ts)，再在真实 Desktop
分别检查保存重启、逐项恢复、临时要求、资料与文献选区的请求及实际模型结果；
旧记录中的文献 PDF `generation_failed` 未由设置回读或请求到达证明已经解决。

### 替换确认与不确定结果

[Desktop 应用回调](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx)
在执行替换前重新核对选区 fingerprint 与 changeVersion，并把捕获身份传给所属
编辑器替换能力；这不是磁盘写入许可。保留编辑器事务、撤销和普通保存的版本保护，
不能将模型建议直接写入源文件或自动保存。

历史资料选区方案明确要求：替换请求超时且未收到编辑器确认时，结果应标为
“待确认”，不能断言一定未修改，也不能自动重放替换。当前回调区分
`replacement_timeout` 与其他替换失败；这个错误分支本身不证明编辑器最终状态
或界面已正确表达不确定性。后续修改须核对编辑器确认协议、实际提示、关闭与迟到
结果处理，并在真实产品中验证内容、dirty 状态、撤销与显式保存；本页不宣称这些
路径已验收。

Office 的[运行宿主](../../apps/desktop/src/renderer/src/features/workbench/office/runtime.tsx)
用 requestId 等待替换确认；超时移除等待项，晚到且无对应等待项的确认被忽略。
这是调用侧结束等待，不是取消编辑器动作或证明文档未变。不得据此给出“未修改”
保证；排障应同时检查所属编辑器实际内容与确认事件，不靠延时推测终态。

### 仍需保留的资料动作要求

资料动作绑定本次模型快照、用户要求、来源及动作身份；重试不能静默换模型或计费
来源。生成前缺模型、凭据或实际所需能力时明确拒绝，不能退化成普通 Agent 请求。
草稿上下文来自当前编辑器和同文件必要邻近内容，不能拼入磁盘旧稿、其他项目文件、
聊天历史或网络资料；没有可靠邻近上下文时明确仅基于选区。输入超限不能静默截断。

低延迟策略由所属推理层根据协议和实际模型能力编码，不由 UI、隐藏 reasoning 或
提示词代替。普通 API 关闭思考与订阅模型采用最低支持等级是不同要求，未知能力
不能写成已关闭；临时目录及一次 turn 本身也不证明无工具或单次内部模型请求。
引用 [Serve 的执行与工具隔离边界](../architecture/serve.md#模型目录执行键与凭据门禁)
核对实际准入；这里记录要求，不宣称所有传输已满足。

历史资料方案限定解释/润色及 Markdown/DOCX 润色，当前契约增加翻译、以实际
can_edit 判断润色资格。这是范围演进，不能机械恢复旧名单或据代码认定需求已获
批准。选区限定仍由当前 ResourceScope.SELECTION 和服务入口校验；原提案残留的
“当前文件解释”描述不能作为新增全文入口的授权。DOCX 复杂跨结构选区须先核对
编辑器能力，不能用生成成功证明格式保持；未完成输出、取消或晚到结果不得应用。

[动作 SSE 传输](../../apps/serve/service/assistant/api/stream.py) 按请求投影 observer
事件，再发送 `result` 或安全 `error`；流式响应已发送 headers 后，不能仍按 JSON
HTTP 状态判断动作成功。[纯模型传输](../../apps/serve/service/inference/transport.py)
仅转发模型的文本输出，reasoning 不是可写回建议；不再回退到临时 Agent。
断连收尾屏蔽外层取消、在有限预算内请求取消并排空队列，避免背压阻塞收尾；随后
取消和等待本地执行 task 需要覆盖 HTTP 清理；此入口不启动原生 Agent 进程。
取消接口的 `accepted` 及成功请求不是权威终态，必须结合所属调用记录验收。

## Owner 与加入时机

- [平台上下文契约](../../apps/serve/service/platform/context.py) 持有选区锚点；
  [Desktop 选区入口](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx)
  通过原有上下文 ingress 添加引用，不建立第二套上下文 Store。
- [Workbench Provider](../../apps/serve/service/workbench/service/context.py) 解析项目选区；
  [Literature Provider](../../apps/serve/service/literature/service/context.py) 解析文献选区。
  两者的发送分支均读取快照；文献引用及附件仍使用所属领域身份。
- 未保存的项目编辑先通过编辑控制器保存并取得提交版本；失败时不继续加入。
  表格查看器仅提供范围描述时，在加入阶段调用所属来源的快照接口取得完整单元格文字。
  [Workbench 快照 API](../../apps/serve/service/workbench/api/selection.py) 复用来源证据服务，
  返回正文与证据版本；这个阶段允许读取和校验来源，不是发送阶段的回读。

Markdown 跨标题、格式标记与代码块的可见选区不能通过全文纯文本搜索反推来源。
[Desktop 映射](../../apps/desktop/src/renderer/src/features/workbench/mapping.ts)从语法叶节点生成有序 UTF-16 源片段，仅为选中内容补齐必要格式控制符；
[嵌入代码编辑器](../../apps/desktop/src/renderer/src/features/workbench/MarkdownDocument.tsx)同步与统一选区相交的高亮并清除不相交的旧高亮。
[Serve locator](../../apps/serve/service/workbench/service/context.py)在**加入时**校验片段顺序与边界并拼接来源文字；加入后发送仍只消费冻结 `snapshot_text`，不能把 locator 校验移到发送时重新读取文件。
定向核对[映射测试](../../apps/desktop/src/renderer/src/features/workbench/sourcemap.test.ts)与[来源契约](../../apps/serve/tests/contract_selection_context.py)，跨编辑器拖选、高亮与实际加入文本仍需真实 Desktop 验收。

## 文献附件文件输入与预览身份

整附件不是选区文本，也不应为二进制文件新增 Assistant 文本上下文类型。
[Desktop Store](../../apps/desktop/src/renderer/src/store.tsx) 的 `attachActiveFileToAi`
对当前项目文件仍走已有 file context；文献附件经
[位置解析](../../apps/desktop/src/renderer/src/features/workbench/api.ts) 按 literature/attachment
身份请求服务端位置，不在 Renderer 拼目录。当前会话已存在时注册本地文件引用，
尚无会话时暂存 registrationRequired，发送路径在获得会话后注册，再构建消息输入。
注册失败或等待期间切会话不能当成功发送；预览文件本身不应强制创建会话。
项目页签加入对话先核活动文件与助手所属项目一致，再提交项目相对路径的具名
`file` 引用；文献附件的绝对位置注册是另一条入口，不应把它复用到项目文件以
绕过项目作用域。树与页签重复添加应由同一上下文 Owner 去重；加入成功不证明
模型已读取，真实验证需在新旧会话各跑一轮并核来源与最终回答。

文件型 ComposerReference 的 `previewSource` 经
[Attachments](../../apps/desktop/src/renderer/src/components/primitive/Attachments.tsx)
传入 FilePreviewTarget；`openFilePreview` 优先使用该显式来源，随后才走 artifact/session/
runtime 推导。来源为 literature 时切换文献主视图并给标签设置相同导航归属，避免无标签
预览落在总览。这里是 Renderer 预览身份，不是 Turn 输入中新增的权限字段；历史消息
没有该身份时不能凭标题或绝对路径伪造 literature/attachment ID。

[Literature 附件 Owner](../../apps/serve/service/literature/service/attachment.py) 的位置读取
要求所属附件行与托管附件；绝对路径 citation reader 还检查该路径登记于附件行，
不先 resolve 后授权未登记别名。当前项目文件 link 附件语义已移除，不恢复旧方案中的
关联附件路径分支。文献位置读取与
[会话文件注册](../../apps/serve/service/chat/service/sessions.py) 是不同授权边界：后者
接收 Desktop 选择的本地文件/目录，检查 live session、绝对路径、存在与类型并返回
reference ID，不仅限文献附件。绝对路径字符串或 UI 预览身份本身不是通用读取许可，
不能由这些预检推断全部平台的原子 no-follow 安全。

### 选区动作的来源身份与错误反馈

[分析输入 Owner](../../apps/serve/service/literature/service/analysis.py) 的 `read_source`
在文献请求提供 `attachment_id` 时读取该附件，不回退主附件；缺少该字段时仍存在
主附件分支，不能宣称全部请求都禁止回退。项目 PDF 使用项目身份与 Content Port，
不允许同时混入文献身份；资产/路径读取与文献附件读取分别校验。

[分析 API](../../apps/serve/service/literature/api/analysis.py) 在准备边界把内容域错误
映射为结构化 422：已知缺失内容码归文献缺失，其余归来源无效，内容错误的诊断为空。
[PDF 请求工具](../../apps/desktop/src/renderer/src/features/workbench/pdf/analysis.ts)
先读取文本，再解析 JSON；解析失败返回 `pdf_ai_invalid_response`，HTTP 失败时附状态，
不向用户展示 JSON 解析器异常。成功响应的 JSON 可解析不等于通过业务结构校验；
该通用请求函数仍直接返回解析结果，不据此承诺空响应或任意对象都被拒绝。

回归须覆盖打开非主附件后实际选区动作、附件丢失的 API 反馈及异常响应的浮层提示。
[分析契约](../../apps/serve/tests/contract_pdf_analysis.py) 与
[请求工具契约](../../apps/desktop/src/renderer/src/features/workbench/pdf/analysis.test.ts)
提供输入选择和错误投影证据，不替代真实阅读器、服务网络和模型回合。

### 托管附件删除与翻译输入故障

当前 [附件文件 Owner](../../apps/serve/service/literature/persistence/files.py) 的
`managed_object` 用文献身份、内容摘要和 UUID 组成落盘名；相同字节再次导入仍生成
独立副本。`revision` 是字节的 SHA256 身份，不是物理文件共享许可。因此删除某条
文献或附件后，所属 API 清理其物理文件与派生索引，不沿用旧内容寻址时代的跨条目
引用计数方案。删除仅处理托管根内普通文件；项目文件不归此清理入口所有。

不能从命名机制推断历史数据库中任意共享路径都已迁移。遇到全文翻译失败，先核对
当前附件行、托管文件是否存在、实际请求阶段和错误响应，再区分输入丢失、模型授权
及输出预算；请求尚未到模型时，增加输出预算不能修复缺失文件。
既有 [仓储契约](../../apps/serve/tests/contract_literature_store.py) 覆盖相同字节独立
副本、删除范围和附件删除 API；临时目录契约不替代真实导入、阅读、删除与翻译验收。

相关接线测试见 [resources.test.ts](../../apps/desktop/src/renderer/src/resources.test.ts)；
其中源码/AST 断言不是产品交互验收。真实回归需分别在无会话及已有会话时加入图片/PDF，
点击卡片检查 viewer、主视图、标签和实际读取 API，再核对发送注册及失败反馈；
复制路径、Finder/Explorer 定位还需各自系统桥证据，不恢复废弃 raw 路由规避身份缺失。

## PDF 选区事实与浮层投影

### AI 结果局部选择与原生复制

全局界面默认禁止文本选择，生成结果正文须由对应展示 Owner 显式恢复，
而不是把整个应用改为可选。[共享 Markdown](../../apps/desktop/src/renderer/src/components/primitive/Markdown.tsx)
及 PDF 的阅读、摘要、翻译正文使用可选文本；局部选区复制与已有整体复制动作
不是同一输入，不应互相替代或改变生成接口。

[主窗口菜单](../../apps/desktop/src/main/index.ts) 仅在 Electron 报告非空且可复制的
文本选区时显示原生 `copy` role；这个接点只属于主窗口，不保证内置网页或隔离
原生宿主具有相同菜单。Cmd+C / Ctrl+C 使用原生选区复制，不用整体结果覆盖选区。

[Workbench 捕获阶段](../../apps/desktop/src/renderer/src/features/workbench/Dock.tsx)
先调用 [focus.ts](../../apps/desktop/src/renderer/src/features/workbench/focus.ts)
判断右键坐标是否处于现有非空 Range 的任一文本矩形：命中时阻止默认选区重定位，
并跳过该路径的选区清除。只判断“点在正文内”不等价于“点在选区内”；
右键选区外、左键与空选区不适用此保留规则。其他失焦和工具栏关闭机制仍有各自
Owner，不能由这一分支推断全部平台、窗口或浮层始终保留选区。

定向入口为 [原生菜单契约](../../apps/desktop/src/main/contextmenu.test.ts) 与
[选区契约](../../apps/desktop/src/renderer/src/features/workbench/selection.test.ts)；
源码与几何 helper 断言不能代替真实跨段选择、选区内/外右键及剪贴板读回验收。
改正文选择或关闭监听时同时检查两端的事件顺序，避免菜单截取文本前先清除选区。

滚动和页面虚拟化不能把临时 DOM Range 当作选区唯一事实。
[PdfDocument](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)
在拖选期间用 `selectionDragSpan` 保留起始页至当前页的渲染，防止虚拟化改写原生 Range 起点；捕获后再保留 page/text/归一化 quads，`persistedSelectionViewport` 根据最后一页选区与当前
页面 bounds 投影位置，用末个 quad 的右下角判断锚点是否落在 PDF viewport 和窗口内。
锚点不可见与选区语义失效不是同一状态；滚动时可移除原生 Range，不应据此删掉
已经捕获的跨页选区。无对应页面元素时函数返回 null，不能把这一步描述为选区已清除。

[PDF Page](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx)
用独立 `pointer-events-none` 标记层画临时选区 quads，避免高亮拦截文本选择或批注
点击；真实批注有自己的交互层，不能给全部层统一禁用指针事件。
[通用选区入口](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx)
消费 exact 状态、can_select、presentation.visible 与锚点可见性决定是否展示工具栏，
不通过在通用菜单重做 PDF 几何形成第二套事实。

既有需求是选区/批注锚点离屏时浮层隐藏、返回时恢复，跨页位置以末页为准。
以上相关分支的存在不证明页面卸载/重挂载、缩放和批注编辑框全生命周期已正确；
修改时必须在真实 Desktop 第二页划词，滚动到完全离屏再返回，分别核对高亮、
菜单、批注位置和操作仍可用。PDF 临时选区不是自动落盘的阅读记录，也不替代
解释/编辑动作的来源证据校验。

## PDF 检查器、笔记保留与侧栏边界

### 稳定资产身份、源状态与记录版本

项目 PDF 的业务身份来自 Content `asset_id`，路径与外部根是可变 locator，内容
revision 是校验信号；不能以同名或相同字节静默合并独立副本的记录。
[记录持久化](../../apps/serve/service/workbench/persistence/records.py) 经 Content Port
定位项目数据库，以资产关联阅读记录，不在 Renderer 另存路径 sidecar 或双写迁移账本。
文献附件的记录归原附件 Owner，项目资产链接可转交该 Owner，不复制成第二份事实。

[记录服务](../../apps/serve/service/workbench/service/records.py) 在源缺失、失权或冲突时
仍能投影已保存记录及源状态；尚未初始化且源不可用则明确失败。初始化读取后重新
核对物理 revision；提交分别检查 expected source revision 与 record revision，不能
把阅读记录 CAS 当文件移动或原 PDF 字节写入的事务。
[Content identity](../../apps/serve/service/content/service/identity.py) 持有物理绑定、
locator 变更与恢复；缺失/授权/冲突不应被 UI 当空记录或重新分配资产来掩盖。
源恢复、外部根重绑、独立复制与跨设备移动仍须真实验证，不从单一状态分支外推。

当前记录 schema 对非精确列集合报 `workbench_pdf_record_requires_cutover`，不是
自动兼容历史路径记录或 additive 迁移的证明。更改持久化前先核既有数据与
[资产保留规范](../architecture/persistence.md)，不得在知识迁移中据旧提案执行清库。
回归看 [PDF records](../../apps/serve/tests/contract_pdf_records.py) 与
[Content identity](../../apps/serve/tests/contract_content_identity.py)，并在真实产品验证
移动后记录、失联与恢复、版本冲突及操作前后原 PDF 字节不变。

### 附件记录与跨库操作的归属

[统一记录契约](../../apps/serve/service/platform/records.py)以owner/scope_id/subject_id
区分项目资产与文献附件，source_revision和record_revision分别持有原PDF与记录
版本；它是Serve产品契约，不应搬进Runtime或让Renderer从路径/页面猜存储Owner。
[附件记录存储](../../apps/serve/service/literature/persistence/reading.py)校验附件实际
父文献，用附件ID作主键、record revision作CAS；
[列表投影](../../apps/serve/service/literature/api/catalogue.py)返回具体附件的record_target。
[Desktop订阅](../../apps/desktop/src/renderer/src/features/workbench/api.ts)按完整目标
三元组投影更新，不因相同PDF字节合并两个独立Owner。字节写入、记录写入与UI
订阅更新不是一个跨库原子事务，副本导入的两阶段与部分成功见[导入契约](imports.md#文献附件进入项目资源)。

项目关联不自动复制批注；已有具名资产记录链接可委托原附件Owner，与显式独立
复制不同。不能据旧方案的“副本独立”删除当前链接能力，也不能从它推导新表单
支持LINK或所有旧入口会复制快照。附件表非精确schema报requires_cutover，是明确
不兼容信号，不证明历史整库切换/恢复机制已经交付。旧清空批注和重建表的计划
不作为今天的数据操作授权；如需处理存量，须另行核实际资产、保留要求、失败恢复
与精确授权，不能在知识清理中执行，亦不能降级为空记录掩盖错误。

大纲由 [navigation](../../apps/desktop/src/renderer/src/features/workbench/pdf/navigation.ts)
递归保留子树，单节点 destination 解析失败返回不可跳转状态，不使整树失败；
查找由活动 PDF 标签的快捷键处理，避免劫持其他可编辑控件。它们已有当前接点，
不能沿用旧“无快捷键、统一压平层级”的结论，也不以源码证明窄窗口或深层大纲视觉验收。

[批注检查器](../../apps/desktop/src/renderer/src/features/workbench/pdf/Annotation.tsx)
展示页码、原文、已有批注和三种标记样式，颜色、样式、批注与删除经
[PdfDocument](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)
的记录提交链；乐观呈现不能伪造已提交 revision，失败回滚、冲突重读仍须保留。
屏幕标记与[PDF 导出](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.ts)
分别实现删除线几何；界面有按钮不证明导出正确，两条链分别验收。

移除独立“添加笔记”入口不等于删除协议的 `notes` 数据。新增标记、改颜色/样式和
添加批注当前携带原 `notes`；删除标记则显式移除关联 excerpt，并过滤无 excerpt 且
正文为空的 note。因此不能把旧计划“所有提交原样保留 notes”当作当前事实，也不能
由入口消失推导可清空历史笔记。涉及这些操作时核对关联清理与资产保留要求；源码
分支并非已证明用户资产无损，本知识治理不授权改数据或重建表。

文献 PDF 的标注侧栏入口取决于 `session.source.kind`，不按文件路径、标题或当前
主视图推断。打开标注会关闭分析/文档面板；分析的 exclusive-surface 接点会关闭
标注。呈现条件和入口切换都需核对，不能仅藏住一个面板而保留冲突的活动状态。
资料库 PDF 仍可通过页内标记检查器操作，不应把“无文献专属侧栏”写成无法批注。

[百分比控件](../../apps/desktop/src/renderer/src/features/workbench/pdf/Scale.tsx)
区分单击适应模式切换与双击数值编辑：双击取消待执行单击，键盘触发直接切换；
Enter/失焦提交、Escape 退出编辑。百分比解析及上下限由
[几何 Owner](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.ts)
维护，提交进入 custom 模式。纯函数测试不证明浏览器事件序列、失焦提交和页面
位置恢复全部正确；真实回归需覆盖双击不夹带单击、Escape 后不误提交及标签切换。

## 文献 Markdown 笔记：共享编辑与保存边界

当前 [文献详情](../../apps/desktop/src/renderer/src/features/literature/LiteratureDetail.tsx)
的 `DETAIL_TAB` 与实际 Tabs 为信息、附件、笔记三个页签，不是历史提案的四页签。
标记列表在选中附件的详情内展示，且当前仅 PDF 附件挂载 `AttachmentMarks`；
打开标记通过附件身份与页码进入共享阅读器。不能由附件标记可见推断所有 Viewer
都具有批注能力，也不为匹配旧提案另建标记表或第二套详情业务状态。

文献条目笔记与上节 PDF 阅读记录中的 `notes` 不是同一保存链。
[详情入口](../../apps/desktop/src/renderer/src/features/literature/LiteratureDetail.tsx) 与
[阅读面板](../../apps/desktop/src/renderer/src/features/literature/ReaderNotes.tsx)
复用 [LiteratureNotes](../../apps/desktop/src/renderer/src/features/literature/Notes.tsx) 和
`NoteEditor`；阅读入口从 `recordTarget.owner` 与 `scope_id` 取得文献身份，不按标题或
文件路径猜测。保存后按 itemId 发布 `literature-notes-changed`，各入口重新加载，
不是复制一套笔记业务状态或用事件正文替代服务端数据。

[自动保存 Owner](../../apps/desktop/src/renderer/src/features/literature/autosave.ts)
在单个编辑实例内串行处理请求：等待已有请求后再提交最新 dirty 草稿；创建回执绑定
笔记身份，保存期间的新输入保留并沿用回执版本继续保存。它不是跨窗口全局队列。
版本冲突留下 dirty 草稿与错误，不强制覆盖其他编辑器的新版本。切换笔记/新建通常
要求 flush 成功，尚无请求的空白新笔记可以直接切换；已有笔记空正文会拒绝保存。

**当前限制不能写成数据保留保证：** `Notes.requestClose` 在保存或导出错误可见时
直接 `close()`，清空草稿且不等待 flush；已有源码断言还明确固定这一分支。
无错误时返回才按保存状态等待 flush。卸载 cleanup 发起异步 flush，但 React 不等待
其完成；不能声称任意关闭、切页或退出均已可靠落盘。保留用户草稿仍是数据安全要求，
这一差异需要单独的产品修复与真实错误路径验收；文档中的目标约束不表示关闭行为已修复。

[Markdown 导出](../../apps/desktop/src/renderer/src/features/literature/note.ts)
使用当前编辑草稿：非空标题生成一级标题，原 Markdown 正文与 Unicode 保留；文件名
清理平台分隔符，经 `saveFileCopy` 打开原生保存链。取消不是成功落盘，也不报写入错误；
缺少 bridge 或实际写入失败会抛错，由界面呈现。不能把导出等同于笔记已自动保存。

定向入口为 [note 测试](../../apps/desktop/src/renderer/src/features/literature/note.test.ts)：
身份、标题、序列化与 bridge fixture，以及错误返回的源码断言；它不验证异步竞态、
真实保存对话框或重启恢复。修改时实际覆盖保存期间继续输入、重复新建、版本冲突、
错误返回、切换入口及重启；导出须从真实 Desktop 保存后读回文件。历史报告的原生
对话框验收受阻且截图属于旧运行，不作为当前版本已验收证明。

## 已保存 PDF 批注的 AI 动作边界

已保存标记菜单不是新划词工具栏的同一宿主。
[PdfDocument](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)
将 mark 的 page/text/quads 显式传给解释/翻译动作后再关闭标记菜单，不能先清空
共享选区再让请求回读它。[批注检查器](../../apps/desktop/src/renderer/src/features/workbench/pdf/Annotation.tsx)
截断 mouseup 冒泡，避免 Portal 的菜单事件沿 React 组件树被 PDF viewport 当作
新选区捕获；Portal 本身不保证隔离这些事件。

[PDF Reading](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx)
使用显式 target 或实时选区构建请求，解释输入先捕获选区，提交时才携带补充要求
发起任务。request 保存文本、页码、quads 与来源身份；文档身份变化与临时选区变化
分别清理状态，不能将所有结果窗口统一绑定到 DOM Range 是否仍存在。通用选区
建议宿主和文献 PDF contribution 的能力、选中态及关闭条件须分别核对，不因一方
已有 `aria-pressed` 就认定另一方达到相同要求。

历史需求还要求解释输入时保留菜单/选中态、翻译窗内部交互不误关闭，以及右侧
标注面板拖动调宽。当前 [PdfPanel](../../apps/desktop/src/renderer/src/features/workbench/pdf/Panel.tsx)
相关呈现只有宽度 token、最大宽度与展开/收缩分支；不能用左侧导航的 ResizablePanel
证明右侧标注调宽已实现，也不将旧计划的像素值升格为当前规范。这些需求与实际
验收缺口须在相关修改中单独核验，不能随历史目录删除而消失。

**划词重新生成与原文呈现：** 解释输入与结果窗复用动作模型偏好，翻译与解释结果窗
均有显式重新生成。Reading 从该动作保存的 request 取 module 与选区，再以当前
模型、翻译目标构建新请求；retry 保留原文、页码、quads、区域与补充要求，重新
生成 action/attempt ID。运行中按钮禁用，但按钮启用条件检查通用 lastRequest，
回调仍须取得该动作 request，不能把启用本身当受理成功证据。
翻译原文使用按 attempt 身份重建的 Collapsible，默认收起以保留译文可视区域；
折叠是呈现策略，不裁剪请求原文。批注身份仅在存在 floatingResult 时构造，不能
用两个空字符串相等推定已添加。实际取消、增量预览、结果替换及偏好重载仍须
真实验收；旧报告的单次首正文时间与模型盘点不证明当前全部模型联网或普遍提速。

真实回归分别从已保存标记和新划词入口触发解释/翻译，检查请求文本非空、页码
及坐标属于正确标记、连续切换不串用数据、错误可读，输入焦点与窗口内部点击、
复制、滚动不误关闭；没有实际模型/产品结果时不报告任务创建或端到端行为通过。

## Bridge 批注上下文与原文证据分权

[引用服务](../../apps/serve/service/assistant/service/citations.py) 的 `pdf_annotations`
从当前 snapshot 和项目身份解析文件 ref，再向 records Owner 读取，不能由调用者任意
指定其他项目或原始 RecordTarget。文献分支经
[文献证据 Owner](../../apps/serve/service/literature/service/evidence.py) 校验项目/全局
作用域，合并条目笔记和所有 PDF 附件的记录；单附件不可用返回 warnings，不将缺失
记录冒充空白，也不因主附件可引用而漏掉其他附件的批注。

结果声明 `user_feedback`，按 offset/limit 分页并带记录 revision；它是用户意见，
不是 PDF 原句证明或可执行指令，不自动生成 citation URL，也不与回答 UTF-16 批注
合并。论文事实仍须另读来源取得证据。记录读取与 source revision 核验分别判断，
不能把反馈 revision 当作论文内容未变或事实正确的保证。

[Bridge 路由](../../apps/serve/service/assistant/api/citations.py) 保留活动
session/snapshot/turn 前后检查及响应大小上限；活动全文策略下 annotations 与 read
均检查授权。没有活动策略的其他路径仍须分别核验，不因操作只读或标记为反馈就
扩大范围、默认加载所有记录或绕过原文授权。回归入口为
[批注契约](../../apps/serve/tests/contract_assistant_annotations.py)，另需真实会话中
项目/全局作用域、附件错误、分页、过期请求和用户意见不冒充引用的验证。

## PDF 文本物化不签发引用凭证

[物化 Owner](../../apps/serve/service/workbench/service/materialize.py) 当前使用产品
共享 PDF 文本提取边界，不沿用旧 PyMuPDF 方案。prepare 有界提取带页分隔的 UTF-8
文本，publish 经 Content Port 的 session artifact scope 发布相对 TXT；目标拒绝
绝对路径、上级路径、Windows 分隔/驱动或流语义及非 TXT 后缀，冲突不覆盖旧文件。
错误分别报告源不可用、加密、非法 PDF、缺少文本层和资源上限，不以 TXT 空文件
代表扫描文档已 OCR。限额与版本以该 Owner 常量为准，不在文档复制数值。

Bridge 在异步 prepare 后重新检查活动轮次才 publish；托管全文被具名
`ensure_materializable` 拒绝，因为整篇明文落盘会留下读取门禁无法撤回的副本。
该限制不等于删除所有普通文档物化能力，PDF 到 TXT 与下游句子编号/PaperCard
处理也是不同职责。返回 digest、revision 和页数不是引用级坐标或 citation receipt；
事实定位仍通过引用索引完成，不能从 TXT 提取成功推定证据定位成功或权限永久有效。

变更时核对 [物化契约](../../apps/serve/tests/contract_pdf_materialize.py) 的受控发布、
冲突、非法目标、源故障、活动轮次失效和托管来源拒绝，并验真实 Bridge 使用路径。
当前源码不证明两平台文件发布或批量 Skill 全链路已验收；旧提案耗时和默认 worker
数量不作为当前性能与执行契约。

## Markdown 可视选区与源码坐标

### 回答渲染与编辑器映射的独立 Owner

[共享 Markdown](../../apps/desktop/src/renderer/src/components/primitive/Markdown.tsx)
消费标准语义解析，再经 [source](../../apps/desktop/src/renderer/src/components/markdown/source.ts)
和 [decorate](../../apps/desktop/src/renderer/src/components/markdown/decorate.ts)
映射原始 UTF-16 边界、引用及批注。隐藏私有引用标记不能改变后续源码坐标，
DOM 文字不能直接当原文切片；回答渲染与下述 Workbench 编辑器映射不是同一实现。
当前跳过 raw HTML，图片呈现为文字占位，外链走产品 openExternal；不恢复手写
语义 parser、双渲染回退或让 Markdown 内容绕过 Electron 安全边界。

修改需覆盖转义/实体、重复文字、跨块、流式半截私有标记、数学和批注边界。
纯映射测试不能代替真实拖选及批注操作，也不能凭渲染成功证明坐标正确。

渲染文字省略标题、强调和代码围栏等语法标记，不能把 DOM 文本直接当作原始
Markdown 的连续切片。[映射 Owner](../../apps/desktop/src/renderer/src/features/workbench/mapping.ts)
对齐语法叶子与编辑器文字流，返回 start/end、segments 及拼接出的源码文字；
[MarkdownDocument](../../apps/desktop/src/renderer/src/features/workbench/MarkdownDocument.tsx)
当前使用 `milkdown-source-map-v3`，不是旧计划的 v2 单连续区间契约。
完整引用需保留受选内容及必要语法边界，不把跨块范围内所有未选文字都加入引用。

[数学兼容](../../apps/desktop/src/renderer/src/features/workbench/mathematics.ts)
在规范化分隔符后恢复树位置到原始源码坐标，否则渲染对齐成功也可能定位错源。
无法取得编辑器精确映射时当前入口仍有既有 DOM 文本/空白匹配回退；不能据纯函数
返回 null 就宣称整条产品路径完全禁止回退，也不因菜单能显示而认定替换安全。
替换还核对原编辑器位置、选区 fingerprint 和 changeVersion。

[Serve locator 解码](../../apps/serve/service/workbench/service/context.py) 按 UTF-16
切片；segments 存在时校验列表数量、顺序、非空与外层范围，再拼接各段。
坐标单位、拼接文字和版本校验须与 Desktop 一致，不用 Python 字符索引替代。
这与发送已经冻结的 snapshot_text 是不同阶段：加入/编辑时的定位证据不能转为
发送时自动回读来源，反之快照可发送也不授予编辑当前文件的权限。

定向纯映射入口为 [sourcemap 测试](../../apps/desktop/src/renderer/src/features/workbench/sourcemap.test.ts)，
包括重复文字、跨标题/段落、标记/转义、代码块、数学位置和不对齐拒绝。
测试不覆盖实际 DOM/CodeMirror 端点或真实菜单；修改后仍需真实 Desktop 拖选、加入
对话及写回验证，不能继承旧计划的跨平台成功声明。

## Markdown 格式快捷栏的单一动作来源

[MarkdownDocument](../../apps/desktop/src/renderer/src/features/workbench/MarkdownDocument.tsx)
从编辑器 TopBar 的原生 item 建立动作映射，`FORMAT_ACTIONS` 再选取粗体、斜体、
删除线、链接、行内代码和行内公式的 icon/onRun。划词格式栏是上方工具栏的子集，
不是独立维护的第二套图标与编辑命令；缺失原生动作直接报错，不静默提供替代行为。
链接动作经现有 `editDocumentLink` 接点，行内公式复用 `ToggleLatex`。

修改格式快捷栏时同时核对上下方动作、选中态、图标和实际编辑结果；不要仅使图标
外观相同而留下不同命令。旧记录中的尺寸、测试数量及截图是历史证据，不是当前
设计 token 或最终验收。当前源码接点不证明所有编辑生命周期和主题效果已通过。

## 阅读结果追问：文献范围与文字草稿

[Reading](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx)
的解释/翻译追问使用 `floatingResult` 中原文、AI 结果、页码和版本生成
`reading.selectionDraft`；中英文模板都标明 AI 生成内容待核验，不在点击后自动发送。
它不是新建 PDF 选区 anchor，也不是把结果当成已核实研究事实。

当前 `openDocumentChat` 在有 literatureId 时先 `addContext`：文献稳定 ID、标题、
`next_turn` 与显式 origin，但不带选区 anchor；只有 accepted_ref_ids 非空才设置
Composer 草稿并聚焦。无 literatureId 的路径跳过该文献引用步骤。解读面板的继续
对话也复用这一接点。因此既不能沿用旧“输入框为空、仅选区胶囊”，也不能沿用旧
“纯结果快照、不再创建结构化引用”的无条件表述。

[Literature Context](../../apps/serve/service/literature/service/context.py) 将无 anchor
引用解析为条目元数据身份的 tool scope，文字为空、带文献 locator，不自动读 PDF
全文；有 anchor 的发送分支才消费 snapshot_text。范围引用与结果文字草稿分别
承担职责，不能从文献胶囊存在推断正文已注入，也不能声称引用受理完全不依赖当前
条目。动作结果保存的版本仅作为草稿文字，不伪装为当前附件的授权版本。

阅读结果浮窗当前不传 `pinned/onPinnedChange`；通用 FloatingWindow 的固定能力
仍由其他调用方使用，不删公共能力来改局部外观。旧记录另要求已有标记弹窗移除
AI 入口，但当前 Annotation/PdfDocument 仍有解释/翻译回调，见本页已保存标记章节。
这是需求与实现差异，不能靠较新源码自动宣布旧要求取消；修改时向产品 Owner
确认并分别验收标记与新划词入口，本次不更改产品要求或行为。

[PDF 契约](../../apps/desktop/src/renderer/src/features/workbench/pdf.test.ts) 的追问、
显式浮窗控制和标记快照案例是源码断言，不能证明异步引用失败、切换期间身份不串用
或窗口拖动/关闭。真实回归要覆盖文献与项目 PDF、受理拒绝、进入后手动发送、
结果及引用分别移除、原文件/条目变化与焦点恢复；旧追问成功截图不代表当前路径。

## 回答来源展开与原文跳转

### 图注索引、主动省略与引用连续性

自动证据索引不等于 PDF 全部文字层或手动选区。
[提取 Owner](../../apps/serve/service/workbench/service/extraction.py) 先依据版面分类
过滤图表内部区域，再对保留文字分句，保留 caption、原 page/quads 和省略信息；
不生成图注、不改 PDF bytes，也不宣称 OCR、表格语义或图中数据已理解。索引身份
包含 source revision 与提取器版本，版本值以源码为准，不复制旧 sentences-v6 描述。

[句子组装](../../apps/serve/service/workbench/service/sentences.py) 将省略断点、图注
类型和不可用页参与 continuity；[引用窗口](../../apps/serve/service/assistant/service/citations.py)
不把搜索命中压缩后的列表当新邻接，不跨图注或不同 continuity 组拼接证据。
否则被删除的图内文字会使本不相邻正文形成虚假的连续引用。

[索引作业](../../apps/serve/service/workbench/service/indexing.py) 区分无 fragments 且
无 omissions 的无文本层与有主动省略信息的结果，输出 coverage 限制；不能用没有
返回片段证明整页无文字或全部已读。修改分类、缓存或窗口时，核对
[版面契约](../../apps/serve/tests/contract_pdf_layout.py) 与
[PDF 解析](../../apps/serve/tests/contract_pdf_parser.py)，再以实际 PDF 验证图注坐标、
双栏、旋转、整页背景图、主动省略和历史引用。旧诊断样本与解析成功不证明任意 PDF
完美识别；识别限制与源版本失效不得隐去。

### PaperCard 原句、独立本地证据与严格定位

[文献证据 Owner](../../apps/serve/service/literature/service/evidence.py) 将 PaperCard
字段提炼值与 `card_mapping` 指向的原句分开，保留 card/sid/版本身份；不能把提炼值
当全文原话。卡片 PDF 版本不匹配时退回本地证据路径，不借旧坐标定位新字节。
读取和历史点击复用[严格锚定 Owner](../../apps/serve/service/literature/domain/anchors.py)：
仅接受枚举的排版等价与有界连续片段，唯一坐标候选才返回位置。不得以删除数字、
否定、公式或运算符、模糊最近句或首次命中提高 exact 数量；复杂排版与未定位结果
仍须诚实保留，坐标定位也不证明结论语义正确。

[本轮读取 Owner](../../apps/serve/service/assistant/service/citations.py) 对有 PDF 但
含未定位原句的卡片尝试同版本本地索引；命中时本次只给可定位卡片与独立本地片段，
不把本地片段伪装成卡片 sid 或给历史原句套替代坐标。原卡片和旧回执不改写，
本地无命中仍可保留未定位卡片。候选发现、卡片登记与本轮实际读取回执是不同事实，
不能用发现命中或登记成功代替本轮读取与授权。

历史引用打开时从不可变回执投影当前源可用性。缺失或不同字节版本分别保持
unavailable/changed，不删除旧名称、页码与 quote，也不对另一版本搜索后复用旧坐标。
最初没有 PDF 的 papercard 回执可在同来源后来补 PDF 后严格查找保存的原句，
新定位只进入返回投影，不修改原始回执；这不是任意同名文件自动关联机制。

变更以上机制时核对[引用契约](../../apps/serve/tests/contract_citations.py)与实际
Desktop 原句/高亮、来源删除恢复、错版本、无 PDF 后补 PDF，以及单文档标签复用。
历史定位数量、旧模型会话与诊断 PDF 集不代表当前全覆盖，OCR、表格语义和复杂
跨页能力不能仅凭定位器存在宣称通过；本页不复制 Skill 的执行流程。

[Citations](../../apps/desktop/src/renderer/src/features/assistant/Citations.tsx) 使用会话、
回答身份、回答文本修订与范围解析句柄；不是仅凭编号跳转任意文件。
来源 `exact` 且允许打开 PDF 时调用 workspace.revealCitation，激活返回的真实标签，
并记录关闭后返回放大对话的意图，不固定跳回总览。`source_only`、`changed`、
`unavailable` 或不能打开 PDF 时先显示来源问题，不冒充已定位原文。

来源名称、页码与片段可追溯不同于结论语义正确；句柄过滤的具体边界见
[Serve 证据规则](../architecture/serve.md#产品指令资产与渐进规则)。修改时分别验证
多个来源的编号/身份、实际 PDF 激活、引用页/匹配片段、来源改变或不可用反馈，以及
放大对话返回行为。已有 workspace 契约是状态/加载 fixture，不是实际点击和原生
网页导航验收；历史两PDF通过不能外推网页跳转、所有格式或当前全量门禁。

## 文献 AI 解读：显式生成与结果可信度

### 直接推理决策与结果发布边界

普通模型动作不等于 Agent Invocation：复用任务身份、幂等、取消和结果投影，但
不为五项阅读动作另建执行系统或聊天历史。订阅临时 turn 是独立执行策略，不能
把订阅凭据提取到私有模型端点或静默改用 API Key 计费；实际执行限制见
[Serve 单轮边界](../architecture/serve.md#单轮模型动作与订阅推理边界)。

历史方案的原始 PDF、整篇单请求和不分段要求已与当前提取文本、页级翻译及长文
分段机制不同；相关现状和后续限制见下文，不恢复旧门禁或借旧验收批准新能力。
保留跨版本仍必要的结果安全要求：完整校验后发布，失败/取消不把部分预览当成功，
来源改变后旧结果不能冒充当前版本，重启不自动重发模型请求以恢复状态。

[结果仓储](../../apps/serve/service/literature/persistence/analysis.py) 当前持久键是
literature_id/revision/module，并在一次事务内写入提交的模块；invocation_id 是
记录字段，不是唯一约束。不能据此宣称已经具备历史方案要求的发布幂等、generation
并发保护或任务状态与结果原子提交。后续改动须分别验证重复发布、竞争刷新、源变化、
取消及崩溃恢复；全文翻译还须核对语言与页级合并。旧结果保留要求不等于各临时
浮层都保留旧展示，两种状态分开核验。引用定位只证明原文可定位，不证明推断正确。

[Reading](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx)
的 `toggleInterpretation` 只开关面板，并协调排他面板与自动翻译状态，不直接创建
解读任务。无结果空态的“生成阅读总结”和结果态的“重新生成”才调用 `run`；模型
选择等其他任务触发点仍按各自分支核对。不要把旧“首次打开即运行”的交互报告当
当前要求，也不把打开面板或出现进度预览当作完成结果。

[结果验证 Owner](../../apps/serve/service/literature/service/analysis.py)
先严格 `json.loads`，仅 JSON 语法错误进入已有 `json-repair` 解析，再走动作所属
对象/字段/内容校验。恢复语法不等于恢复可信内容，不在 UI 再做另一套解析或用摘要
替代失败数据。修复失败或不接受的顶层结果走 `pdf_ai_result_rejected`；缺少解读
模块、总结字段或结构另有具名错误，不能将所有错误都归为一个 rejection code。
修复日志只记录位置、解析原因与类型，不增加模型全文或文献正文日志。

**证据校验的实际边界：** `verify_evidence` 按页范围与规范化原文定位过滤引用，
删除无法匹配的条目；没有有效引用或原来已不确定时标记 `uncertain`，不是一律
拒绝整份结果，也不证明研究结论正确。解读各结构段与模块均进入该接点，不能将
“结构化结果已返回”写成“每项结论都有可靠证据”。改变这项安全语义需另行确认。

[增量预览](../../apps/serve/service/literature/service/preview.py)
从部分 JSON 投影可展示文字，解读预览剥离 evidence，只保留相应文本字段；它是
临时呈现而非终态验证。[Serve 契约](../../apps/serve/tests/contract_pdf_analysis.py)
有语法修复、字段拒绝、引用过滤与预览案例；
[Desktop 契约](../../apps/desktop/src/renderer/src/features/workbench/pdf.test.ts)
检查入口源码，不是实际点击/请求/模型验收。真实回归需分别确认无历史结果打开
不发任务、显式生成才发任务、重新生成失败反馈、预览与最终结果区分及引用定位。
旧模型名称、通过数量与截图不替代当前版本验证。

## 文献任务快照流与临时预览

模型已有流式输出不等于阅读界面已有正文反馈。保留结构化结果的理由是译文定位、
覆盖校验、解读证据与既有任务生命周期；不为更早展示改成未经校验的 Markdown
终态。Serve invoke 的 observer 累积输出，交给 preview Owner 投影可展示字段，
仅 running 的当前任务状态接收预览；正式解析、校验与发布仍是另一接点。

[文献 tasks/events](../../apps/serve/service/literature/api/analysis.py) 按当前 Owner
节奏发送最新任务快照，终态后停止；不是 Agent 会话的持久 sequence 重放流，也
不是每个 token 的无界队列。不可因此声称断线恢复或服务重启任务持久化已通过。
图表另用 action_stream/invokeFigure，不因路径同为 SSE 就混用两个协议。

[subscribePdfAiTask](../../apps/desktop/src/renderer/src/features/workbench/pdf/analysis.ts)
检查 HTTP、stream 类型、task_id 与状态，终态快照后停止；未到终态的 EOF 报
invalid response，已取消订阅不再投影快照。该接点不完整校验每种 preview/result
业务结构，不把传输身份检查写成完整数据安全验证。
生成中的当前正文、增量增长和最终可定位结果须分别验收；SSE 建连、占位文字、
上一份结果与动画都不是本次首正文。计时到首可见正文不同于上游首 token，
同次完成时刻的对照不等于旧版本 A/B，更不证明总模型时间下降。

## 长文解读的预算与分段缓存

长文解读的分段属于 [Serve 编译 Owner](../../apps/serve/service/literature/service/analysis.py)
与 [任务执行 Owner](../../apps/serve/service/literature/api/analysis.py)，不是 Desktop
提交多份独立总结任务。保留完整原文和物理页码，是选择分段后汇总而非截取前缀的
原因；中间摘要不直接成为用户可见的最终总结。

`interpretation_input_limit` 把声明的模型窗口减去保留预算，再取产品字符上限；
声明缺失或不足时使用保守回退。这是字符准入启发式，不是精确 tokenizer 计算或
供应商绝不会拒绝的保证；即使正文不足产品上限，也可能因模型预算进入分段。
分组按编译 payload 长度检查，连续页超限时切组，单页也可拆片，保留原页号。
不能把“50 万字符内单次”脱离实际模型与编译输入条件作为承诺。

分段缓存由独立 [AnalysisStore](../../apps/serve/service/literature/persistence/analysis.py)
管理，身份包含文献、revision、提示词版本、模型键与编译输入内容哈希。
命中时收集已有摘要，未命中时调用并校验后发布分段缓存；最终汇总另行执行。
汇总输入仍可能分组递归缩减，不承诺任意长文都只增加一次汇总调用。
现有契约可验证预算计算与测试 PDF 的物理页覆盖，不代替真实长篇、缓存重启、
取消、来源变化与最终结果的产品验收；历史截图和通过数量不作为当前证据。

## 翻译目标语言与偏好边界

[语言 Owner](../../apps/desktop/src/renderer/src/components/business/Language.tsx)
当前目标目录仅含简体中文与 English；选择器不是可检索的多语言目录。
自动推断按中文、拉丁、假名与西里尔字符数量判断，不是语言识别模型：英文界面
遇到英文默认中文，否则英文；其他界面遇到中文默认英文，否则中文。不可识别文本
默认使用界面对应目标。手动目标优先于推断，不因与原文相同而自动改向。

目标语言读取先取共享 localStorage 键，再取入口旧键；读到有效旧值会写入共享键，
写入同时更新共享键与该入口键。因此不能承诺全文、文献划词与资料划词的目标语言
互不覆盖；这也不代表已打开的组件立即同步。模型是另一条偏好路径：资料划词使用
入口模型键，文献各动作使用产品 Store 的 `literatureAiModels`，不能把两者描述成
同一套 Language 模型存储。

文献全文换目标清除旧页集并从当前页启动；文献划词仅已有结果或请求时重跑。
文献模型菜单回调只更新动作模型偏好，不能仅据此承诺换模型必然重生成。
历史“入口独立、多语言可检索、所有切换立即重跑”的提案与当前实现不完全一致，
产品目标是否调整须由 Owner 确认，知识迁移不自动批准或修复这些差异。
现有 translation 测试主要检查目录和源码接点，不替代真实菜单、持久化或重生成验收。

## 图表框选与临时结果

### 请求级流与单一模型调用

[FigureActionService](../../apps/serve/service/literature/service/figure.py) 负责文献来源、
区域准备与结果元数据，模型执行仍经 AssistantActionService.invoke_compiled；
图表不维护另一套模型调用或后台轮询协议。[HTTP入口](../../apps/serve/service/literature/api/analysis.py)
要求 figure 类型与 SSE Accept，先核对当前连接的 image_input，再准备裁剪；
prepared 事件携带来源修订、页码、矩形与预览，后续使用共享 action_stream。
完成时重新读取来源并核对修订，不把增量文本当作来源仍有效的最终结果。

[Desktop消费](../../apps/desktop/src/renderer/src/features/workbench/pdf/analysis.ts)
将 prepared 与当前文本合成预览，output_delta追加、output_completed替换正文，
仍须等有效 result 与 completed 状态；未完成流不能作为成功结果。
文献全文翻译及解读的多步任务保留其原有Owner，不因图表使用请求级流而全部改成
单次调用。UI不轮询也不等于删除 AssistantInvocationStore 的调用身份与诊断记录；
关闭结果窗、请求取消及供应商实际终止分别核验，accepted不证明执行已结束。

### 框选与展示状态

图表解释的框选模式与结果窗口是独立状态：有效区域进入 `startFigure`，先清除
当前展示，检查实际模型图片能力，再发起专用流。新请求中断旧 AbortController，
只接收当前请求身份对应的预览/终态；不是旧顺序队列或多卡归档方案。
PdfDocument 的命名最小选区阈值限制误点，文档/语言等身份改变时清理当前状态；
普通滚动不在该身份键中。退出框选与取消正在运行的流不是同一个动作，调用方
必须明确选择；例如关闭图表结果窗同时取消并退出，不能泛化为所有退出都取消。

[结果仓储](../../apps/serve/service/literature/persistence/analysis.py) 把图表解释与
公式视为 transient 模块，初始化移除旧模块投影，publish 跳过这些模块；这不等于
全部通用调用/诊断记录都被删除。不要用旧恢复图表历史卡需求重建第二套持久结果。
引导/结果显示复用公共浮窗与 HoverCard，实际边缘避让、Esc、连续框选、迟到结果
和滚动行为仍须在真实阅读器验收，不能由源码模式测试推断输入安全或视觉一致性。

## 文献逐页翻译与页内分段

### 结果与阅读布局

选区新请求开始时清除该类旧结果，Reading 的 `floatingResult` 还在忙碌态强制为空；
当前任务的流式预览是另一条投影，不把“没有旧结果”理解为生成期间完全无文本。
这项规则针对浮动动作，不推导为全文翻译必须清除所有已完成页。

[PdfDocument](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)
在统一页轨道中将同页原文与译文组成 `data-page-pair`，共用页面导航，不再建立
第二个固定翻译面板来做跨滚动器同步。当前译文宽度为原文宽度乘命名列比例，页高
随 PDF 的 scale 计算；传入 Reading 的已缩放尺寸使用 pageScale=1，不能从旧报告
推断正文和所有控件仍通过共同 zoom 同比放大。长译文在页内滚动，避免推移后续页对。

开启翻译时适配尺寸仍按原文两倍宽度计算，而实际译文列较窄；该事实不是已经验证
最优适宽或无溢出的保证。旧“左右等宽”及旧像素数据不作为现行验收标准。修改时
分别验证页配对、跳页、窄窗、适宽/自定义缩放和页内滚动，勿以源码断言替代实测。

文献翻译/解读以已提取的带页码文本作为 `document_pages`，不因源文件是 PDF 就
要求模型 `pdf_input`；模型连接仍须有效，图表/公式裁剪的图片附件另校验
`image_input`。[模型准入](../../apps/serve/service/literature/api/analysis.py) 与
[实际推理传输](../../apps/serve/service/inference/transport.py) 分别承担对应检查，
不能删除通用附件能力门禁。当前提取引擎归 [PDF Owner](../../apps/serve/service/platform/pdf.py)，
不沿用旧 PyMuPDF 实现描述。

页级编译使用 analysis Owner 当前命名预算；旧一次整篇翻译的大输出预算不是当前
规则。长解读超过输入边界时先分段再汇总，长翻译页分段；其他超限分支仍可失败，
不是静默截断输入或无限提高上限。字符阈值与输出 token 数不能混用。订阅连接的
临时推理与禁止工具能力边界见 [Serve 单轮推理](../architecture/serve.md#单轮模型动作与订阅推理边界)。

文献“全文翻译”当前由 [Reading](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx)
前台调度单物理页任务，不是一次整篇模型请求，也不是持久化后台队列。
[sequence](../../apps/desktop/src/renderer/src/features/workbench/pdf/sequence.ts) 固定从
开启页到末页再回补前序页，跳过已有译文；忙碌或失败时不提交下一页。页面完成结果
按页合并，同页重译替换该页，目标语言变化清除当前旧语言页集，不混合展示。
前台调度状态与已完成页持久结果不同，不能因重启后能读译文就声称队列跨重启续跑。

全文翻译侧栏动作开启自动调度并记录起始页，失败或取消的旧任务状态可在显式
重新开启时清理；后续 effect 按队列前提提交，不沿用旧“没有结果且没有任何任务才
首次直接 run”的通用面板规则。解读仍由前面的显式生成入口控制，两种动作不合并。

生成完成也不是发布完成：[分析 API](../../apps/serve/service/literature/api/analysis.py)
先验证结果，再经 `read_source` 重读请求对应源字节，比较 SHA256 与准备时 revision；
变化返回 `SOURCE_CHANGED_DURING_GENERATION`，不发布该次结果。该段还在发布前检查
取消，文献结果才走所属结果仓储。这个观察次序不等于文件校验与结果写入原子化，
也不证明所有异常都保留旧结果；回归需分别覆盖源改变、删除、取消和实际发布读取。

[编译与验证](../../apps/serve/service/literature/service/analysis.py) 对全文翻译只提供
目标页文本，清空相邻页 context；长页按该 Owner 的字符阈值顺序分段，不把字符阈值
当模型 token 上限。划词解释/翻译另有选区与页布局上下文，不套用全文翻译的空 context。
[任务 API](../../apps/serve/service/literature/api/analysis.py) 顺序汇总页内译块，
对可重试结构/覆盖错误继续二分直到最小段边界，不能用空译文或摘要填补失败段。
根尝试保持运行态，整页完成后才进入发布，不把子段成功当该页已保存。

`verify_translation` 检查译块结构与原文定位，`verify_translation_coverage` 对规范化
原文/译块来源使用序列相似度门槛；它不是译义正确率或每个段落完整性的形式证明。
改变拆分或重试时保留失败语义，核对目标页号、原文覆盖、取消与发布前来源修订，
扫描/图片/空白页不能伪造为成功。[持久化合并](../../apps/serve/service/literature/persistence/analysis.py)
在既有文献结果表的事务内按页覆盖，同语言保留其他页，换语言使用新页集。

[页序测试](../../apps/desktop/src/renderer/src/features/workbench/pdf/sequence.test.ts)
只证明纯函数排序、跳过和合并；真实验收须检查非首页开启、失败停止、重译保留其他页、
换语言及重启读回。历史长文缺段报告只验证特定失败页和两种模型，明确未跑完整长篇，
不能当当前整篇、任意模型或 Windows 通过证据。

## 验证与维护

变更锚点、加入入口、Provider 或证据解析时，同步检查持久化和跨端消费者。
定向测试入口包括 [Desktop selection 测试](../../apps/desktop/src/renderer/src/features/workbench/selection.test.ts)
及 [Serve 选区契约](../../apps/serve/tests/contract_selection_context.py)、
[上下文 Provider 契约](../../apps/serve/tests/contract_context_provider.py) 与
[完整契约清单](../../apps/serve/tests/run_all.py)，按实际分支确认覆盖，不把领域边界测试
当作完整选区行为测试。真实 Desktop 验证至少区分加入后修改/删除来源、缺少快照、
表格范围捕获失败、容量超限与编辑动作证据失效；类型、源码和协议检查不替代这些流程。
定位到受影响 Owner 后停止扩展阅读；新格式通过原有契约承接，不在 Assistant 按扩展名
复制读取逻辑。安全或来源校验要求发生变化时先明确影响，不以文档迁移授予产品改动权限。
