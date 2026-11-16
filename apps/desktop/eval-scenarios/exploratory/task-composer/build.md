# 任务输入器候选构建依据

## 建设状态

资产修订 `task-composer/14`（补充文献选择器显示空态图）。`COMPOSER-CAND-001–010` 均为候选标识，尚未冻结或纳入任何评测分母。目标 `0.3.2 / 202611121823 / preview` 的需求版本、安装包与源码同源关系及其他入口动作均待核实；源码或历史通过不自动批准目标版本行为。

## 文献选择器显示空态参考

`literature-picker-20261113.png` 是 `tmp/test_snapshot/desktop/literature-picker-observe-20261113/dialog.png` 原字节副本，SHA-256 `bdb73e413e0ccde423b98e974830fcf127dce02edd10659138c9872ac49b5af6`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例打开真实会话中的文献选择器，页面显示空态且未选择任何条目，随后取消。文献列表请求记录为 200，但未保存独立响应内容，不能据此认定库真实为空；读取可能触发缓存或权限检查。此图不证明非空选择、引用提交、导入或评测通过；候选采用状态不变。磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` 不证明运行内存字节。

## 文献库引用选择依据

引用选择设计映射记录用户截图及增量要求：资料库和文献库各自打开选择弹窗，不使用合并分类 Tab。`COMPOSER-CAND-010` 只记录入口与承载边界，不由此批准文献选择、过滤或提交细则；它不同于 `COMPOSER-CAND-008` 的项目文献拖入。目标包需求适用、非空真实文献及选择完成态完整窗口图待核；本轮不评测导入，`examples` 文件不代表文献已入库。

## 资料引用选择器参考

`resource-picker-20261113.png` 是 `tmp/test_snapshot/desktop/resource-picker-observe-20261113/dialog.png` 的原字节副本，SHA-256 `5dad3b254e53f611b22e2fa69551cad068fe4b8a461c84df27eadebd36e010e6`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例打开真实会话中的资料引用选择器，未选择条目即取消；完整窗口显示未选状态。资源读取可能触发既有索引或缓存；不据此证明目录勾选、引用提交、导入或模型消费。磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` 不证明运行内存字节；候选采用状态不变。

## 第二张合成图片输入：task-composer/10

[独立示例清单](../../../../../examples/projects/image-secondary/project.json)登记仓库使用 Pillow 12.3.0 生成的 `secondary.png`：256×160 RGB，1180 字节，SHA-256 `2f98c21d4db76db99f98fe77623de32046572a13f4ad0e849dc82d106c23ac39`。它与 `evaluation` 清单 `image` 的 `icon.png`（1024×1024，SHA-256 `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2`）外观及身份可区分；均为合成原始输入而非产品截图或草稿状态。选择前按两份清单核各自字节及隔离范围，由人工确认文件选择，并以独立前后引用和源文件身份核移除；草稿写入、文件读取及发送分别核授权。目标包适用、真实完整窗口图及真实操作仍待核，本修订不改变需求版本、采用状态或历史冻结。

## 草稿图片逐项移除依据

会话图片附件设计映射记载需求 `88208327` 及后续用户调整：草稿缩略图移除入口只在该图悬停或键盘焦点进入时显示，默认隐藏时不接受鼠标命中，不让整组同时显示。该记录中的真实两图草稿仅观察隐藏与悬停，未执行移除；`COMPOSER-CAND-009` 将移除候选的真实前后引用及源文件保护单独核验，不以历史截图或渲染测试宣称通过。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和真实完整窗口图待核；发送后图片、导入资料库及跨平台不由此覆盖。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 的 `setPendingRefs` 及移除回调按引用类型与身份更新 `composerRefs`，[Images.tsx](../../../src/renderer/src/features/assistant/Images.tsx) 的 `DraftAttachments` 与 `AttachmentImages` 将图片和索引映射到移除回调。两文件相对基点无未提交差异，SHA-256 分别为 `2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`、`25581f5739a8b389d66ebca9a80aea0cf9e63d09ab796bc2cb7edf8d92be00bf`。源码仅定位草稿引用状态，不证明目标包同源或正确；须用两张可区分合成图及摘要、同一隔离草稿引用前后态和源文件独立参照。修订 `task-composer/9` 时第二张输入及完整截图缺失；第二张输入见上节，目标包完整截图仍缺。本地选择由人工确认，草稿写入和源文件读取须分别核授权，不自动发送。

## 项目文献拖入引用依据

项目文献拖入任务设计映射记载需求 `87828208` 原型及 2026-10-21 人工反馈：原型提出同项目复制式拖入，反馈确认多条文献逐项展示及单独移除、不合并计数。原型所述已选行带入可见选择、未选行仅带自身是历史线索，其确认级别及目标适用待核，不由当前源码直接批准。`COMPOSER-CAND-008` 与资料文件拖入、文献导入和真实发送分别核验；历史 macOS 观察不证明目标包通过，Windows、目标版本及真实完整窗口图仍待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 在项目文献行提供 `writeLiteratureDrag`，[drag.ts](../../../src/renderer/src/drag.ts) 携带项目范围及文献身份，[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 的 `onComposerDrop` 读取并通过 `addContexts` 更新草稿。三文件相对基点无未提交差异，SHA-256 分别为 `a6d029a91dae5da55fd29183080bc3ba953949bc0c625b8fa76d493550375f47`、`3862ead81f513121be6bc2138c80d9f52627d524698b97fb040c18ad4a03909f`、`2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`。源码仅提供入口和状态流线索；真实验证需同项目已入库的隔离文献及选中状态、独立文献目录和草稿引用前后参照。合成 Bib/RIS 只是输入，人工确认导入；草稿写入、文件读取及模型发送的权限分别确认。

本次澄清 `COMPOSER-CAND-006` 的不重叠约束只针对本次提交的资料选择范围，并非要求删除草稿中无关的既有引用；历史确认未给出后者语义，保留待确认。现行源码使用已有引用与新候选合并只是实现线索，不能代替需求采用依据；执行须记录初态，不改历史判据或冻结记录。

## 项目资料拖入引用依据

项目文件与文件夹拖入任务设计映射记录需求 `87828198` 原型及 2026-10-21 人工反馈：同项目资料以复制式接入输入区，目录独立引用且按需读取，文件逐项显示与单独移除，不移动或重新上传源文件。`COMPOSER-CAND-007` 仅承接此范围，与资料选择弹窗和本地文件选择分别验证；项目文献拖入、跨项目行为、发送及模型读取不因此得到证明。历史 macOS 验证为来源线索，不代表目标包适用或本轮通过；目标版本、产品需求版本与真实完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Explorer.tsx](../../../src/renderer/src/features/project/Explorer.tsx) 以 `writeProjectEntryDrag` 传递项目内条目，[drag.ts](../../../src/renderer/src/drag.ts) 定义项目范围、类型及相对路径载荷，[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 的 `onComposerDrop` 读取载荷并通过 `addContexts` 更新草稿。三文件相对基点无未提交差异，SHA-256 分别为 `f120365ee5be15fc7e75b9076614fd4b0eb1025f2026d9e525ea8eba5fc18d0c`、`3862ead81f513121be6bc2138c80d9f52627d524698b97fb040c18ad4a03909f`、`2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`；源码只定位入口和数据流，不证明目标包行为。独立参照为获准隔离项目的 `examples` 文件及目录身份、源路径/摘要与草稿引用前后态；草稿写入、文件读取及准备时人工导入须分别核授权，不预置结果或自动发送。

## 资料目录引用选择依据

引用选择设计映射记载用户截图及增量要求：资料库与文献库使用不同选择弹窗；资料目录选择与展开独立，选择目录覆盖后代，取消后代使父项半选，提交只保留不重叠的引用范围。本次 `COMPOSER-CAND-006` 仅承接资料目录的可观察选择范围，不以此推定文献、任务、快捷键、发送或模型行为。记录中的历史真实 macOS 观察不能证明目标安装包同源或本轮通过；目标包的勾选和草稿结果完整窗口图尚缺，需求版本和适用性待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`：[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 将资料来源交给选择弹窗；[References.tsx](../../../src/renderer/src/components/business/References.tsx) 的 `ReferencePicker`、`fetchResourceListing` 与 `toggleSelection` 分别承接目录读取、展示和范围选择；[store.tsx](../../../src/renderer/src/store.tsx) 的 `addContexts` 依据会话、项目及草稿范围保护引用并可能调用 `persistAssistantContext`。三文件相对该基点无未提交差异，SHA-256 分别为 `2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`、`d0047b671bde55305e032edf0c1b5ea1fefaf93b47eecc00dc75dd927f3aca1b`、`ed81d7a9f13dd0f510ff4b079c267251ac6681341234a8d40615534f69b39342`。这仅定位入口、状态和数据边界，不证明目标包入口可达或行为正确。

按本轮获准方式准备 `examples/projects/evaluation` 的隔离副本，核对多层目录及文件身份，独立记录选择前后草稿引用；逐层自然加载后观察父子选择与确认终态。草稿写入和项目范围须核授权；如准备过程涉及导入，仍由人工确认。不能以预置草稿、模拟选择或静态截图冒充真实操作，也不发模型请求。

`evaluation` 清单中 `detail`、`summary`、`appendix` 分别映射 `notes/detail.txt`、`notes/summary.md`、`notes/methods/appendix.md`，SHA-256 依次为 `5ac03866d59c97942f7c2e1ff82441aa7e72abb1d437859d0952634122e67a11`、`749eb83681017d3bed102829eead2d17a1f551c64e2def33df8f1de4fdcdb6fb`、`e96924f026671ff3562e61a052b78cd206382d091b885ebc7ae80aa893ecd365`。以该多层树及当轮实际准备收据独立核隔离副本，选择和取消后另核草稿引用的身份与范围；源文件存在或摘要一致不等于草稿已选中。

## 普通文件附件确认依据

文件附件设计映射记载 2026-10-31 用户确认混合引用中普通文件保持名称和格式双行卡片，预览和右上角关闭沿用既有组件；2026-11-02 用户截图确认附件超宽时的水平滚动方向控制与边缘隐藏。该确认仅支持 `COMPOSER-CAND-005` 所述输入态，不扩展为其他来源的完整选择、真实发送或回答要求。历史开发实例截图位于 `tmp/test_snapshot/desktop/attachment-overflow/` 的 `start.png`、`end.png`；其是历史观察线索，不将开发实例认作目标安装包或当作目标版本参考图。目标包该状态的可复用完整窗口图、需求版本和适用性均待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 的本地文件入口调用选择器，`pendingRefs` 经 `partitionComposerReferences` 进入引用区域，移除动作更新 `composerRefs`；[reference.ts](../../../src/renderer/src/reference.ts) 负责引用分组顺序，[Images.tsx](../../../src/renderer/src/features/assistant/Images.tsx) 的 `DraftAttachments` 校验部分引用位置并以卡片呈现普通文件，[assistant.ts](../../../src/renderer/src/contracts/assistant.ts) 的 `ComposerReference` 区分文件、目录和技能。上述源码相对基点无未提交差异；后三文件 SHA-256 分别为 `d8bd81b503562242e9c25ae8da2d291d3ed440bf4e96d5c8595f480507d1818d`、`25581f5739a8b389d66ebca9a80aea0cf9e63d09ab796bc2cb7edf8d92be00bf`、`78440b443d282458a440b3c62a113f35990939347de19faef87dee76d030c975`，Composer 摘要见下节。源码是入口、状态与数据边界线索，不证明目标包可达或同源；资料、文献等上下文引用与本地文件附件不是同一数据状态。选择文件须人工确认，隔离草稿变更、文件访问与可能的授权根副作用须单独核定；不发起模型请求。

历史修复记录明确新任务空白、会话切换时未发送文字与附件引用隔离，并记载当时 macOS 真实界面验证。该次范围为会话内存草稿，不包含进程重启恢复；它证明历史需求及当时证据，不证明目标包已验收，也不约束后来实现必须继续只存内存。输入模式与发送门禁尚缺逐项确认的产品需求依据。

待发送消息队列的设计映射记载用户截图及追加要求：单行、悬停完整内容及纯附件消息的队列摘要/会话卡片；这是历史确认的要求线索，而非目标包已采用或通过。`COMPOSER-CAND-004` 只承接上述可见语义，不把像素、编辑/删除、发送门禁或异常恢复自动纳入正常展示。原记录的历史截图在本工作区未找到，且新版真实队列有记录的截图缺口；本页不以组件夹具或空态图冒充待发送队列图。目标需求版本与制品适用性仍待确认，真实待发送队列和仅附件回合需具备隔离任务、原始输入与模型/发送授权。

## 历史 ID 与范围映射

从[历史冻结](../../frozen/p1-20261025-e2567e836/freeze.json)所记 `sourceCommit` `e2567e836e14707ad71477cc9cbeee32a00f5357` 回查 `apps/desktop/docs/scenarios/catalog.json`：`CHAT-NEW-01@3` 的终态是首次发送后建立独立会话身份，`CHAT-HISTORY-01@3` 是重新打开已完成会话并读回原消息、回复和终态，`CHAT-LOCAL-FILE-01@3` 是添加本地文件并获得针对文件可核事实的回答。它们分别需要发送或已完成会话等前提，并非本页未发送草稿 `COMPOSER-CAND-001/002` 的同义 ID；`COMPOSER-CAND-003` 也未定义其完整终态，不能替代或覆盖它们。

历史 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/conversation.json` 的 `D4-CHAT-002/003/010` 分别引用上述三项，均明确 `expectedStatus=candidate_unapproved`；历史目录也标记 `reviewState=pending`、`coverageEligibility=exploratory`。两源文件 SHA-256 分别为 `b0f7f62ba4cb39a487ee2026d1bf38aed6f0baa110157430de10a12d240a0671`、`929ec7c1bfab9f0f231e91f44ec4869052dbbc6f5ec7128ca4d4704d3c032590`，与冻结清单一致；可用 `git show e2567e836e14707ad71477cc9cbeee32a00f5357:<路径>` 回查原文，不恢复或改写历史文件。历史 ID 和真实截图不自动证明本目标包适用、需求已采用或评测通过。

## 当前源码分析

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；以下四个源码文件相对该提交无未提交差异，尚未与目标安装包建立可信同源绑定。

- **入口与草稿：** [Navigation.tsx](../../../src/renderer/src/features/project/Navigation.tsx) 的项目导航“新建任务”调用 `startPanelDraft`；[store.tsx](../../../src/renderer/src/store.tsx) 管理草稿及偏好写入。打开新任务或切换任务不应预设为纯只读，需先核对隔离范围和实际保存副作用。
- **发送条件：** [Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 聚合运行时、模型、额度、上下文及输入等状态；[input.ts](../../../src/renderer/src/input.ts) 定义提交条件。它们是待核对的实现线索，不是已批准的需求或目标包可用性证明。
- **待发送队列：** `Composer.tsx` 的 `ComposerQueue` 由传入队列和引用生成摘要、用 Tooltip 呈现完整摘要，并依队列状态提供动作；分析文件 SHA-256 `2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`，相对源码基点无未提交差异。该当前源码只用于定位显示条件与副作用，不证明目标安装包同源或实际显示正确；候选只要求与该行同一真实输入的独立摘要对应。
- **副作用边界：** 页面展示、输入编辑、引用文件、任务切换与实际发送分别取证；发送可能进入真实队列或调用模型，不能以仅观察按钮或模拟事件证明发送成功。独立确认文件与授权根操作范围，不触碰真实用户数据。

## 后续交接

参考图复用任务列表自然空态：2026-11-12 在 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 的隔离实例进入项目中心后取得，显示空白新任务输入器，未输入或发送；截图 SHA-256 `429350c7c2d306b8302493dce2ba90592989fe268d01643948ab90b00b9f3bf9`，目标 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。右侧是合成文档；该图不证明草稿隔离、模式语义或发送行为。

确认需求 Owner、目标版本和模式语义；准备可区分的隔离任务、草稿及 `examples` 文件，核验独立参照和保存边界。完成确认前不冻结候选，不纳入冒烟；页面观察不声称任何场景通过。
