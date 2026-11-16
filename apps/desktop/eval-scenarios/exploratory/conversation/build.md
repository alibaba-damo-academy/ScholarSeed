# 真实对话与任务结果候选构建依据

## 建设状态

资产修订 `conversation/39`（补充已发送图片组预览及原文件操作候选；此前 `conversation/38` 补充待审阅文件不阻断新任务对话候选）。本页复用历史稳定业务 ID，`@` 后数字为历史资产修订，不是产品需求版本；文件恢复、长用户消息、工具及文献授权与结果、任务分支、历史排序、产物概览与引用来源使用候选标识以区分既有历史业务点。各项均作为目标版本候选，未纳入本轮冒烟或评测分母；需求 Owner、产品需求版本、安装包适用及采用依据仍待确认。候选基线整理不等于产品真实运行或通过。

## 已发送图片组依据

会话图片附件设计映射记录需求 `88208327` 及用户截图确认的同组预览、原文件菜单和导入冲突规则；记录中的历史 macOS 两图观察、原文件操作和导入摘要比较不证明目标安装包同源或本轮通过。MasterGo 输入框附件节点不是已发送图片查看器的设计依据；设计截图接口曾返回 `Network Error`。历史截图位于忽略目录，本次未检查或复用，目标包真实完整窗口参考图仍缺。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Images.tsx](../../../src/renderer/src/features/assistant/Images.tsx) 组合已发送图片、预览及原文件桥接，[Gallery.tsx](../../../src/renderer/src/components/primitive/Gallery.tsx) 承载预览，[ImageStrip.tsx](../../../src/renderer/src/components/ui/ImageStrip.tsx) 承载图片行。三文件相对基点无未提交差异，SHA-256 依次为 `25581f5739a8b389d66ebca9a80aea0cf9e63d09ab796bc2cb7edf8d92be00bf`、`f1abc7197bef5cbe1596459f5987265cb179330e8e9f5b17f32fdb33ed6a607b`、`65b9fe3549ed267c9c549d8ea0c9d12264d299f9e27a26449330d200a95ffc4a`。源码仅为定位线索，不证明目标包同源或采用。设计映射记载最新菜单替代另存项，当前源码仍展示 `saveAs`；冲突须由 Owner 确认，不以任一实现状态自动改判。原生打开方式枚举的 Windows 能力及全格式和失败分支不由历史 macOS 局部观察外推。

`CHAT-IMAGE-GROUP-CAND-001` 与仅核已发送混合内容展示顺序的 `CHAT-MIXED-CONTEXT-CAND-001` 分离；草稿移除、模型图片理解和原文件操作分别判断。当前源码打开“更多”菜单即可能重验会话文件、增加宿主授权根并枚举应用，不能当作无副作用展示；目标包是否同源仍待核。目标 `0.3.2 / 202611121823 / preview` 适用、需求版本和采用待核；真实隔离会话、独立图片身份及各项读写、模型、剪贴板与宿主操作授权均为执行前提，不修改历史冻结或裁决。

## 待审阅文件与对话解耦依据

历史用户输入及范围确认明确要求文件未审阅也不阻断对话；历史方案保留显式审阅、资源错误及修订保护。历史总结报告隔离 macOS Desktop 中旧审阅存在时的新对话、前后审阅状态与显式处理观察，Windows 未验收；历史证据不证明目标安装包同源或本轮通过。上述三份文件 SHA-256 依次为 `f65e9e5ea09e36753be2697685c7ae9d073ee711b4d11afaa08fae738c1b2288`、`379a89f942dc96641848d7a369e1a549c60d0728ea2c297c3e15efe51733ff28`、`878094eb1eff283fcd26a0b3ff0963365d2b56801d2fbd42b6569b555070b344`。

[Resources 当前边界](../../../../../docs/features/resources.md)说明对话准入与审阅决定解耦、发送不自动处置审阅，真实资源操作错误仍明确报告。当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 承接发送，[turns.py](../../../../serve/service/chat/service/turns.py) 在回合结束时调用 [delivery.py](../../../../serve/service/resources/service/delivery.py) 采集文件交付；三文件相对基点无未提交差异，SHA-256 依次为 `2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`、`12f6a0cee4cf3d17864795ad6f1d73735ec36890048e246bb887481a598b05ea`、`b2e548852c012e09dfcb9ee13d5bc4026923edb68e26c914e281b425cd9e298d`。源码仅定位边界，不证明安装包同源或需求采用。

`CHAT-REVIEW-DECOUPLE-CAND-001` 与普通 `CHAT-NEW-01@3` 单轮不同，须具备同项目真实旧待审阅前置及独立审阅前后参照；同会话、队列、失败重发、dirty 编辑器和连续修改不由本候选完成态外推。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本、采用及真实完整窗口图待核；历史忽略目录截图未经本次检查，不复用为目标参考。生成文件、模型、发送、显式审阅与相关状态写入分别核授权，不改历史冻结和裁决。

## 普通问答历史回放依据

历史用户要求明确原单选、多选及文本框只读回显，无法可靠识别的旧记录保留原文；历史结果限定普通澄清和内置问答，说明超时不当作用户确认，以及自定义插件、授权和待作答维持原策略。该记录报告 macOS 真实会话的单选、多行补充、重载及复制，实际多选与不可识别旧回执仅由自动化覆盖；这不是目标安装包通过或多选实机证据。其列出的 `work/answer-replay/S1-final-card.png`、`S1-final-window.png` 和录像在本工作树未找到，无法检查或复用为完整窗口参考图。

上述用户要求及结果文件 SHA-256 分别为 `de675a5eb6b46f7c064e203bc4e6fedb0aafdc9cf826a3e082309b5830d49849` 和 `00d9c993f5f90c9356f57579938fe6b99c42af5d505847a905231ec083e04746`，作为历史依据身份，不代替目标包绑定。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`：[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 的普通表单回放分支展示禁用选项、只读文本和复制；[hil.ts](../../../src/renderer/src/hil.ts) 校验结构化选项及其与原答案一致性，不能可靠匹配时以原答案文本降级；[transcript.ts](../../../src/renderer/src/transcript.ts) 投影历史回执，[interaction.py](../../../../serve/service/chat/runtime/interaction.py) 保存决策细节并将其与业务答案区分。上述文件相对基点无未提交差异；实现只作数据流线索，不证明目标包同源或将异常实现批准为要求。历史用户确认与目标包适用、产品需求版本及采用须分别核对；不改历史冻结或裁决。

## 历史任务浮层入口观察

2026-11-13 在 `0.3.2 / 202611121823` 隔离实例、已有两个合成任务的项目中，公开目录给出两任务身份与最后回复时间；当前窗口未见可辨的历史任务浮层入口。记录见 `tmp/test_snapshot/desktop/two-task-observe-20261113/attempt-monitoring/history-observe/`，该次未打开浮层；这不证明其他入口不存在或功能不适用。两任务回复同一分钟且创建和回复顺序相同，不能据此区分排序依据，需求版本和目标适用仍待核。

## 长消息连续视口参考

`long-message-scroll-01-20261113.png`、`02`、`03` 分别是 `tmp/test_snapshot/desktop/two-task-observe-20261113/attempt-monitoring/scroll-run/evidence/01.png`、`02.png`、`03.png` 的原字节副本，SHA-256 依次为 `287ca3b0573a4f6fd97bb894b2afa77657ce8dfee65ccfa8a48bf880a731ce64`、`6fee36fd23c2933fc1fa1b5073d816350fef3f1fec22c5ad587275c6fc847b6e`、`78f046155b3362053874e83602ec4d1b91585fd320a92e7c1429bfbdc2769b81`。2026-11-13 在 macOS 安装版 `0.3.2` 隔离实例中展开并滚动真实合成消息，三张完整视口前后重叠，末图展示原始末尾；随后收起。图不代替逐字符复制验证或跨布局验收。本次记录的进程、profile 和端口与连接是时序关联，目标构建及独立会话 ID 来自后续或先前参照，非同一原子快照；不改变采用状态或历史冻结。

## 长消息状态参考

`long-message-expanded-20261113.png` 与 `long-message-collapsed-20261113.png` 是 `tmp/test_snapshot/desktop/two-task-observe-20261113/attempt-monitoring/identity-run/evidence/` 中 `expanded.png`、`collapsed.png` 原字节副本，SHA-256 分别为 `19f71f13da6d67e00fe6a7a48dbc2907f37deeca965aae984180893d35085845` 和 `d304f26585557489111ea3f46fcd55d8660c1baa4ecb4dbc751e5785e41d32ce`。2026-11-13 在隔离实例观察真实合成任务长用户消息的展开与收起；图为完整渲染视口，展开内容下半部分超出视口。采证时磁盘应用版本为 `0.3.2`、ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，与本轮早先所核 `202611121823 / preview` 包摘要相同；本次未单独取得 renderer 构建号、渠道或任务独立 ID，实例及同任务关联为有界时序与内容关联，不是原子身份或运行内存证明。未核剪贴板、消息末尾可见性或重启恢复，不作正式评测通过。

后续 `attempt-monitoring/reference-run2/` 在同隔离项目补采两个任务的公开目录与历史最小投影：两项标题各唯一，用户输入、最终回答和完成的同一回合与先前观察对应；同次 renderer 投影为 `0.3.2 / 202611121823 / preview`。此参照晚于截图，截图时未直接记录会话 ID，故关联仍非原子；两个回复在同一分钟且创建、完成顺序相同，不能验证排序依据。此补证不证明不可见工具/网络活动不存在，不改变候选采用状态或旧裁决。

## 文献综述卡片依据

用户原始要求记录综述卡片四区、大纲与章节总结、引用和问题表，以及文献库和网络引用分别在新侧边窗口打开对应目标；用户后续允许调整交换契约，历史 `v1.2` 及开发结果不证明当前安装包适用。历史结果先记录一个阶段尚未进行真实 Desktop 验收，后续记录 macOS 真实综述与引用导航及最终修订重发；各阶段不能混同，也未证明目标安装包同源或完整要求通过。`CHAT-REVIEW-CARD-CAND-001` 仅覆盖所列展示和导航，不代替完整综述生成、来源真实性或质量评审；数量看板原图细节、目标适用及截图待核。

## Agent 裸网址依据

文字消息记录用户对 Agent 正文裸网址的单行省略、完整提示以及完整复制和打开的确认，普通描述链接保持原换行语义；历史 macOS 验收不证明目标安装包适用。`CHAT-BARE-URL-CAND-001` 与用户长消息复制和引用来源列表分开，须同一真实回答及独立完整地址参照；模型、剪贴板与外部导航各自核授权。

## 过程文献操作依据

过程文献操作入口的缺陷原始截图要求可发现的更多操作并保持 PDF 阅读；其列出的具体菜单项是源码/语义推导，未在此全部升格为已确认规则。`CHAT-PROCESS-LITERATURE-CAND-001` 不等同文献中心附件入口，需同一真实会话与独立附件参照；目标包适用和完整窗口图待核。

## 对话文件版本依据

对话文件版本记录同轮同发布路径的最新卡片及以不可变 publication/artifact 身份打开历史版本的用户要求；历史 Windows 验收不证明本目标 macOS 包适用。`CHAT-ARTIFACT-VERSION-CAND-001` 与普通文件产物打开分开，需可区分的真实版本及独立内容身份；模型、文件写入和刷新等分别核授权，不改原历史判据或冻结。

## 悬浮调宽状态参考

2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离真实任务中观察左右边缘拖动并退出悬浮。`float-resize-before-20261113.png`、`float-resize-left-20261113.png`、`float-resize-right-20261113.png` 分别是 `tmp/test_snapshot/desktop/floating-resize-observe-20261113/` 下 `floating.png`、`left.png`、`right.png` 原字节副本，SHA-256 依次为 `d38c07b14b10905d9190782116a4b3e47eb5b8b8ca7c3d03ed24819ecb911ef1`、`5cecf3fc7988d0dd7014495cc396e19dddfe0d0b2f82fe7523989847bfd0104b`、`b1adee56978628b48fc98fda4e5078f7d6a8a446a141eb92f63ff27ad0133a07`。记录的几何仅为 `workspace-conversation` 输入条元素，不代表整个展开面板高度；不证明极限、跨平台、持久化或正式评测通过。磁盘 ASAR 身份与动作记录见同目录 `observation.md`，不据此推断内存字节。

## 悬浮会话调宽依据

悬浮会话左右调宽记录用户录屏及要求：左右边缘拖拽改变宽度，对侧固定，不增加底边调高；历史 macOS 开发实例结果不证明目标包适用。`CHAT-FLOAT-RESIZE-CAND-001` 与拖动停靠分开，须核同一会话及工作区几何、真实完整窗口和界面布局变化授权；不外推高度或跨重启保持。

## 真实任务操作菜单参考

`task-menu-20261113.png` 是 `tmp/test_snapshot/desktop/task-menu-observe-20261113/menu.png` 原字节副本，SHA-256 `790c671500b5a5ce06b91533582b07566f32c571ab1bce0cd8bd93329c60f734`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例打开真实任务标题区菜单，工作台处于打开状态；观察后关闭菜单，未执行菜单项。图中展示该状态的可见入口，不证明重命名、分支、归档或删除终态，也不证明关闭工作台时的菜单或需求采用。记录中的磁盘 ASAR SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，不证明运行内存字节。

## 同进程任务读回参考

`reopened-20261113.png` 是 `tmp/test_snapshot/desktop/real-history-readback-20261113/reopened.png` 原字节副本，SHA-256 `d028538b77e3dc3e8895943c5088da61072f2028fd45ae3239fc71d21976cf83`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例切至新任务后重新选中前述真实任务，图中显示原请求、回答及完成状态。观察记录记载切换前后同项目目录的会话身份一致和历史请求成功，但原始响应未另存，不能仅凭图独立核验身份映射；不证明跨重启恢复或正式评测通过。磁盘制品摘要见下节；候选采用状态及历史冻结不变。

## 真实单轮完成状态参考

`turn-20261113.png` 是 `tmp/test_snapshot/desktop/real-turn-20261113/final.png` 的原字节副本，SHA-256 `84d780d6d6f1f63e900aa2d142c87cd49050878b225d9b9ce6c114c25a479a9e`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例获准发送一次合成请求，页面显示对应请求、回复和完成状态；内置模型显示为 Qwen 3.8 Flash，界面未展示更具体上游身份。界面快照显示输入框文字为占位提示。磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，不证明内存字节。截图只作状态参考，不能单独证明完整请求链、重开读回、产物或评测通过；不改变候选采用状态及历史冻结。

## 引用摘录候选依据

缺陷工作记录记录 240/241 字符边界、展开收起、分组状态与原文导航的历史 macOS 真机验证；当时场景索引无已采用的摘录预览 ID。设计映射的“同类型多文件引用预览”同样记录按 Unicode 码点计数及分组独立状态，但折叠行数分别写为四行和三行，须由 Owner 确认，不在候选中裁定。当前源码 `components/business/Citation.tsx` SHA-256 `7c58b2c97b8ab495a69e514ff221ae9bca26e76e445bf5f1ae49903ca74443d7`，是定位线索而非目标包同源证明。历史真机截图位于另一工作区的忽略目录，未作为本目标参考图；目标版本适用、需求版本、采用和完整窗口图均待核。Windows、暗色和设计像素验收不由历史记录证明。

## 科研结果入库依据

用户确认记录取消独立全文下载与文件夹交付卡，保留科研结果中的入库、仅元信息及 Bib 导出。[文献检索结果与授权读取](../../../docs/architecture/ownership.md#文献检索结果与授权读取)明确仅精确检索且所选含已下载全文时提供含全文选项、复用已下载字节作为主附件。当前源码 `features/literature/Results.tsx` 承载结果展示，`JoinMenu.tsx`、`join.ts` 负责入库选择和执行；源码不证明目标制品同源或真实结果通过。仅入库与项目资料目录交付不是同一终态；真实任务、导入、写入和导出须分别核授权与独立参照。本修订不改变历史判据或冻结。

## 对话画布往返依据

文件产物反馈记录 2026-11-09 画布预览与工作台同实例往返要求及后续工作台承载要求。当前源码 `features/canvas/feature.tsx` 注册画布内容和工作台 viewer，`features/canvas/Scope.tsx` 管理画布位置；SHA-256 分别为 `4376b1177f2063601b4845b778265fecfae077ffbfe6be3fb3eae054b46e9364`、`5dd6b0be9a48e4d3f2569af2209d98a5d00f548d0daa2f0a9865a612351ccdb6`。源码仅为承载线索，未证明目标制品同源、真实画布可达或需求通过；组件模拟图不可替代真实会话证据。

`conversation/21` 补明使用工作台自身收起按钮、保留原文档但不自动切回；默认预览高度和滚动、工作台正文与工具栏衔接及不重复返回行属于原确认细则，本次往返候选不声称覆盖，仍需专项。该澄清不改变需求版本或历史结果。

## 空任务悬浮参考图

2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例，从新任务更多操作进入悬浮模式，聚焦输入框后采集完整窗口，随后通过任务操作退出悬浮并断开连接。此过程新增了工作台新任务标签、改变了隔离布局；没有发送消息或调用模型，也不代表真实会话的悬浮状态。实例 PID 2153，隔离 profile，本机端口 49382；磁盘 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，不等同运行内存取证。`floating-20261113.png` 是 `tmp/test_snapshot/desktop/floating-observe-20261113/active.png` 原字节副本，SHA-256 `c0c9d0a5d2f80fea10cf5c48ad2abbf29fcdd7993eae0dc8cb6d9a30e383e34c`；已打开检查，右侧为合成文档。此图不证明五点拖动、最小化、还原或正式评测通过。

## 悬浮会话停靠依据

悬浮会话拖拽与停靠记录用户确认的五点吸附、拖动热区及最小化还原保持停靠点。当前源码 `shell/Workspace.tsx` 持有浮层入口及停靠状态，`shell/geometry.ts` 计算位置；两文件 SHA-256 分别为 `b4d255cfe05e87750e26ee8254a9ad9d35169b0403f57e868c54276000a76e33`、`e94bea566264938aadee923f3fc87a777d0131e54c9bd8007a7ed2356ca701c7`，相对当前工作树基点无未提交差异。进入悬浮可能打开工作台标签并改变布局，需记录隔离状态；无需因此发起模型请求。源码和历史记录不证明目标包适用、真实入口或执行通过。

引用来源的去重子点须有同轮可独立辨认的同源重复引用；文件和网页各仅出现一次不能区分去重计数与引用次数。此处只补数据前提，不改变需求版本或历史判据。

## 发送后混合上下文顺序依据

会话文件引用设计映射记录用户确认及需求 `88208442`：发送后的划词／注释、图片、文件和文字依次展示，前三类分别成行；这保留需求 `88208440` 的图片、文件、文字相对顺序。`CHAT-MIXED-CONTEXT-CAND-001` 仅承接同一真实消息的显示分组，不替代草稿附件、模型读取或文件打开判据，也不改变发送载荷及持久引用顺序。目标 `0.3.2 / 202611121823 / preview` 的适用、产品需求版本及真实完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 的 `UserBubble` 组织发送态内容并调用 [assistant/Attachments.tsx](../../../src/renderer/src/features/assistant/Attachments.tsx) 的 `SentAttachments`，后者使用 [Images.tsx](../../../src/renderer/src/features/assistant/Images.tsx) 的图片展示及文件附件能力；文件附件再经其本地消费者复用 [primitive/Attachments.tsx](../../../src/renderer/src/components/primitive/Attachments.tsx)。四文件相对基点无未提交差异，SHA-256 依次为 `9b9f6305b7c6b77cd4b1f3fec865358657863e8c741783746e8339544e7430a5`、`012ead2bcaea244d7fcaa713eda2ccca05ebfd116f2388d0a052bc62813e6139`、`25581f5739a8b389d66ebca9a80aea0cf9e63d09ab796bc2cb7edf8d92be00bf`、`470879c6969a7503177ae8ed5cda90954b40ad3585b71d907ef06fd548a34642`。本次仅校正证据链，不改变需求、版本或采用状态；源码仅是数据投影线索，不证明目标包同源或正确。验证须独立记录同一隔离会话及发送前引用、文本身份，并观察真实发送消息；文件选择人工确认，草稿写入、模型请求及费用分别核授权，不使用预置消息或模型自述替代。

后续用户确认将 E09/E10 的外观更新为自定义确认卡；本次候选只整理行为和真实终态，视觉外观按目标版本另核，不据旧提示样式建立判据。

## 混合引用来源依据

引用来源展开弹层标记 `current（混合来源）`，并记载产品后续确认：保留来源数量入口，文件与网页按回答中的来源顺序混排于单一可滚动列表，不设分类页签，同源对象去重计数；该记录未给出独立产品需求版本。`CHAT-CITATIONS-CAND-001` 仅承接列表与数量，不将点击来源、文件版本校验或网页访问自动纳入；设计记录同时指出最终真实会话消费仍需验收。目标 `0.3.2 / 202611121823 / preview` 适用性、采用及真实完整窗口图待核，不能以历史组件预览或其他构建观察当目标产品通过。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 在回答中调用 [Citations.tsx](../../../src/renderer/src/features/assistant/Citations.tsx) 的 `TurnCitationSources`，再由 [Citation.tsx](../../../src/renderer/src/components/business/Citation.tsx) 承载来源列表。三文件相对基点无未提交差异；后两文件 SHA-256 分别为 `5b64283a23b33b7f0c0e48e0b8a7d2649e360342bceba31aed76b6c542bcc51f`、`7c58b2c97b8ab495a69e514ff221ae9bca26e76e445bf5f1ae49903ca74443d7`，Stream 摘要见普通工具权限卡依据。源码仅定位入口与投影，不证明目标包同源或正确；核验须绑定同会话、同轮回答及独立来源身份和顺序，分别确认模型、联网及文件读取权限，不由卡片或截图推断真实来源内容。

## 文件恢复确认依据

文件恢复确认卡记录用户截图和说明：无法读取文件与没有文件夹写入权限分别提供“重试／移除这个文件”和“去授权／取消”，恢复决策不改变文件访问授权范围。后续文件异常卡接入记载历史 macOS 真实读取重试与写入取消观察；其不证明系统权限已授予或保存成功，也不代表目标安装包同源或本轮通过。`CHAT-FILE-READ-RECOVERY-CAND-001` 与 `CHAT-FILE-WRITE-RECOVERY-CAND-001` 分别记录，不扩展为文件访问审批或普通工具授权；目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本及真实完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[feature.tsx](../../../src/renderer/src/features/assistant/feature.tsx) 注册 [recovery.ts](../../../src/renderer/src/features/assistant/recovery.ts) 的读取与写权限恢复策略，[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 承载确认卡，[decisions.py](../../../../serve/service/resources/service/decisions.py) 为资源决策线索。四文件相对基点无未提交差异；前两文件及 decisions 的 SHA-256 分别为 `381c933106ba304103c113ffde15a80168881033255741408e5ee90ef8cb976c`、`09c13546463b2eb38d2c156360640ceaf9e0290638f1714a303f9b0ec8aaaa7d`、`85c3d19eac66c5cde3af3ed2f05512899a6775a1fc8763fb8e4283cb87679904`；Stream 摘要见下节。源码只用于定位，不证明目标包正确。独立参照须绑定同一真实请求、文件/目录和决策，并核实际读取或文件前后状态；模型、工具、系统权限、决策及写入各自确认，不能伪造事件或以设置打开、回执当作成功。

## 普通工具权限卡确认依据

会话工具权限卡复用记录用户截图确认待处理工具授权复用确认卡；当时源码保留决策身份、拒绝及可用权限范围等信息，历史 macOS 真实会话曾分别观察拒绝及允许一次。该历史样例不意味着所有请求均有一次性选项，也不证明目标安装包同源或本轮通过。`CHAT-TOOL-AUTH-CAND-001` 仅承接真实普通工具请求的展示及获准决策关联；文献与浏览器授权、危险操作、异常及跨平台分别核需求和权限，目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 的待处理权限分支使用 `permissionDecisionOptions` 和 `answerPermission` 承载可用决策，该文件相对基点无未提交差异，SHA-256 为 `9b9f6305b7c6b77cd4b1f3fec865358657863e8c741783746e8339544e7430a5`。此为 UI 及数据流线索，不证明目标包正确或工具已执行；真实验证需同会话、同请求决策身份及作用范围的独立记录，后续工具结果另核。触发模型、执行工具、联网、写入及作出授权决策各需适用权限，不能伪造桥事件或利用未经授权的危险任务制造样例。

## 检索结果入库状态确认依据

全文操作确认中工单 `88762162` 的检索结果列表要求：已加入行的勾选框禁用且不计入表头全选及已选数量；未加入行保留选择、批量入库和导出，已加入行详情可单独导出 BibTeX。`CHAT-JOIN-STATE-CAND-001` 仅承接已加入/未加入行的展示及选择边界；批量入库、单独或批量导出分别核终态及授权，不把选择结果当作入库或文件导出。该状态不改变全文授权范围，与 `CHAT-RESULT-CAND-001` 的摘要列及项目文献关联需求不同。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和真实完整窗口图仍待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Matches.tsx](../../../src/renderer/src/features/literature/Matches.tsx) 根据 `isSaved` 和可选集合控制行及全选，[JoinMenu.tsx](../../../src/renderer/src/features/literature/JoinMenu.tsx)、[joinState.ts](../../../src/renderer/src/features/literature/joinState.ts) 与 [catalog.ts](../../../src/renderer/src/features/literature/catalog.ts) 提供入库与目录状态线索。四文件相对基点无未提交差异，SHA-256 分别为 `fb2a1efa7530fda07410ae1788080f67797726601db963a27fdc0459e132f848`、`2e0c5c3c26d8ab21d581378f80f0ef19a4ccb4f56def30f8a991ad794adeceda`、`8c373bcb55e938106ad666355699991ab10906ad1716908c7d5740daffd89e89`、`fcfe7a8a8ed419a9a59168f58578e51b40e9a2ed664eb9791aa5f30a3030c9b5`；这些仅定位实现，不证明目标包同源或正确。需绑定同会话检索快照、同范围独立库目录与已加入和未加入的真实文献身份；模型调用、联网、人工确认导入、入库和导出各自核授权，不用模拟结果代替。

## 检索结果授权投影确认依据

全文操作确认记录 2026-11-06 的检索结果列集要求：授权前、拒绝或未知时展示文献与推荐理由，确认授权后增加摘要列；部分授权仅展示所选文献已有摘要，未选文献保留且不显示摘要，不重新检索或生成摘要。`CHAT-RESULT-CAND-001` 检查同一结果与决策的投影，区别于授权卡 `CHAT-AUTH-CAND-001` 及文献库列表，不把列显示解释为下载、阅读或入库。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和真实完整窗口图仍待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Results.tsx](../../../src/renderer/src/features/literature/Results.tsx) 结合会话或历史结果调用 [interaction.ts](../../../src/renderer/src/features/literature/interaction.ts) 的授权关联，[Report.tsx](../../../src/renderer/src/features/literature/Report.tsx) 按授权状态与选择投影列集。三文件相对基点无未提交差异，SHA-256 分别为 `ea715f18adfe8f4e77384e38dd27fbc2fafb77139046c926f0fc542364e67440`、`d849f3e1f742cd70ad840be58fb3042fd1ff897374e9fe01ac3b46aab87d6abf`、`7344e0c6e0b4fcde67312401cb878a12fea01d9cdecf09b6aa86a98ad8308da8`。该链路是入口与数据线索，不证明目标包同源或正确；独立参照须绑定同会话、检索运行、结果快照及真实授权决策和所选身份，不按标题推断关联。模型调用、联网和授权决策分别核权限，不通过模拟桥事件或静态结果替代真实流程。

## 任务概览产物展开确认依据

任务概览产物原位展开记录用户截图要求：输出与过程产物各自默认最多五项，溢出时显示剩余数，原位展开并可收起；该记录明确覆盖更早的三项预览和产物悬停明细等旧规则。历史 macOS 真实观察覆盖两个输出与十七个过程产物，只有过程组足够验证溢出；输出组溢出及 Windows 尚无该次真实产品验收。历史记录不证明目标安装包同源或本轮通过；目标 `0.3.2 / 202611121823 / preview` 适用、需求版本及可复用完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Overview.tsx](../../../src/renderer/src/features/assistant/Overview.tsx) 承载 [SessionArtifacts.tsx](../../../src/renderer/src/components/business/SessionArtifacts.tsx) 的任务产物区域，后者按当前会话的 `thread.artifacts` 和 `getSessionFiles` 数据分组并由 `OverviewGroup` 处理各组展示。两文件相对基点无未提交差异，SHA-256 分别为 `279b91bf60261756a7e8ce28fb51ab29d284a295e53e7e956748011b4f7b8c7f`、`e738d0856bd8acee8cd9d8f21938a454a2d40959129529b324a4dfaf86e341e2`；源码仅为入口和数据边界线索，不证明目标包行为。须以同一真实隔离会话的独立产物清单及各组身份数量为参照；已有会话观察与创建、模型生成、写入和外部动作的授权分别核定，不使用合成结果替代真实产物。

## 历史任务排序确认依据

历史任务回复时间记录用户截图要求：项目内与文献中心的历史任务浮层按 Agent 最后回复时间倒序显示该时间。同一记录中无回复置后且不显示时间属于当时 `current` 实现，缺少独立用户确认，保留待确认，不作为已确认要求。历史 macOS 真实会话的显示、排序及刷新观察是来源线索，不证明目标安装包同源或本轮通过。`CHAT-HISTORY-SORT-CAND-001` 与历史读回 `CHAT-HISTORY-01@3`、项目侧栏置顶分组分别计检查范围；目标包适用性、需求版本与非空浮层完整窗口图待核，不外推跨页极值或 Windows。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[AiPanel.tsx](../../../src/renderer/src/features/assistant/AiPanel.tsx) 的历史浮层调用 [history.ts](../../../src/renderer/src/features/assistant/history.ts) 的 `listTaskHistory`，从 [api.ts](../../../src/renderer/src/api.ts) 请求包含最后 Agent 回复时间的会话目录；[sessions.py](../../../../serve/service/chat/service/sessions.py) 与 [events.py](../../../../serve/service/chat/persistence/events.py) 分别承接会话查询与回复时间投影。五文件相对基点无未提交差异；除 api 外四文件 SHA-256 分别为 `610035bbe1479755f4312b1864344990116e73a64026be7eab4d92880f03da02`、`56af5429fcdaefba4b686aee81c364d4d6f40f2a0011b8e688662719e58ec64d`、`cd11dfa9bc89692d2447e00a26e06471c5f909fd9cd7dcbea86fbb66f76aa8dc`、`f35596658ea76cd95ce7835b52457b42e6a757e80182703c7c106d0dec93450e`；源码仅为入口与数据 Owner 线索，不证明目标包可达或正确。独立参照须绑定同实例、同范围会话身份及对应最后 Agent 回复时间，不能以当前浮层文本自证；准备真实会话或续聊不自动获授权。

## 任务分支确认依据

分支会话入口与来源条记载用户截图与确认：项目任务菜单提供创建分支，来源条提供返回来源；历史 macOS 开发实例实际观察不证明目标安装包同源或本轮通过。`CHAT-FORK-CAND-001` 仅承接从任务菜单创建、独立身份及来源回跳；不把空白新任务、普通历史读回或一次截图当成完整历史继承，也不外推轮次级分叉及拖动脱离。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和真实完整窗口图仍待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Tasks.tsx](../../../src/renderer/src/features/project/Tasks.tsx) 复用 [SessionContextMenu.tsx](../../../src/renderer/src/components/business/SessionContextMenu.tsx) 的 `SessionForkMenuItem`，[store.tsx](../../../src/renderer/src/store.tsx) 的 `forkSession` 通过 [api.ts](../../../src/renderer/src/api.ts) 的 `openSession` 提交源会话身份并打开返回的新身份；[origin.ts](../../../src/renderer/src/features/assistant/origin.ts) 读取分支来源，[Branch.tsx](../../../src/renderer/src/features/assistant/Branch.tsx) 承接来源展示。六文件相对该基点无未提交差异；Tasks、菜单、来源读取及展示文件 SHA-256 分别为 `2bfcb698686401de12c6b6192fbda074884383da3d5a5b39766d9265365056ba`、`f064bf91777485fa05e2f55051a242064f3df8be37742d478a94c37691e22c2d`、`37dd0c404acbbed5d8046766b2c60dca8fdf73f4d95b860fc897ef90763ee79c`、`e4c70ef1ea0c209db23eb597d577e87b95114c4cca7625147e52e659462720a8`。源码仅为入口及数据流线索，不证明目标包可达或正确；需真实隔离源会话、创建写权限及同项目目录前后身份与来源独立参照，不自动发送模型请求或预置分支结果。

## 长消息原始输入：conversation/4

复用共享 [evaluation 清单](../../../../../examples/projects/evaluation/project.json)的 `document`（`files/sample.md`，644 字节，SHA-256 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`）作为可选合成长消息原文；以 `resolveExample({ projectId: 'evaluation' })` 取得该文件并通过 `readExampleFile` 复核字节。文本含多行及可辨首尾边界，但其源文件行数不能代替真实窗口的视觉行数；执行时记录实际发送原文及换行，按当轮布局和独立参照核展开与复制，不预置消息或回答。准备输入不代表创建会话、模型调用、发送或剪贴板操作获准，各项须分别核授权；目标制品适用及真实完整窗口图仍待核。本修订只补输入来源，不改变判据、需求版本、采用状态或冻结结果。

## 文献全文授权候选依据

全文操作确认历史与用户确认记录 2026-11-03 用户确认的待处理勾选卡默认收起且展开不改变选择或请求，以及 2026-11-11 用户走查确认的历史状态默认收起、保留范围和部分勾选、决策与范围只读，并区分手动与自动或来源未知的授权。历史 macOS 观察仅作来源，不证明本目标制品适用或本轮真实授权。

同节 2026-11-02 的通用全文回执记录“明确拒绝后可重新授权，允许与超时不显示”，而 2026-11-11 历史状态记录拒绝与超时保留重新授权入口；两者涉及的回执或历史承载、适用范围与后续演进须向需求 Owner 核对，不将二者归并为统一判据，也不由当前代码自行裁决。通用文件审批及文件恢复有不同对象与决策范围，不与文献授权混计。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`：[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 承载会话待处理确认与展开状态、按真实问题提交选择；[Scope.tsx](../../../src/renderer/src/features/literature/Scope.tsx) 区分历史只读范围，[Authorization.tsx](../../../src/renderer/src/features/literature/Authorization.tsx) 与 [interaction.ts](../../../src/renderer/src/features/literature/interaction.ts) 关联请求、回执及重授权条件；[gate.py](../../../../serve/service/literature/api/gate.py) 的全文授权门禁是服务端数据边界线索。五文件相对该基点无未提交差异，SHA-256 依次为 `9b9f6305b7c6b77cd4b1f3fec865358657863e8c741783746e8339544e7430a5`、`74c52c3f0d1df08b35756206b2bf589ee1cda76d24503ea22a524c6ced45ef11`、`d06e3f0476b1fa8f81e3eb3eba366413dce5872d9e617dc05dc719474553a7e4`、`d849f3e1f742cd70ad840be58fb3042fd1ff897374e9fe01ac3b46aab87d6abf`、`5f2ed42ce714119e10549d87802f5a4f525678536491e9849c67b890fc0805d1`。源码与安装包尚未可信绑定，不能以源码、静态回执或模拟事件代替真实任务与同期决策记录。

目标版本 `0.3.2 / 202611121823 / preview` 的适用性、需求版本及可复用真实完整窗口图仍缺。若后续执行，须准备可区分的隔离会话及合成/获准文献范围，核真实模型、材料读取、范围选择、授权决策与费用等各自权限；以同一请求、选择范围与独立决策记录为参照，保留状态变化和回执，不能将授权确认推断为下载、阅读或入库。Windows 和异常分支另核。

## 长用户消息展示依据

文字消息需求与历史验收记录用户确认发送后的文字超过六个视觉行时折叠，原文及复制值不得截断；历史 macOS 验收展示折叠、展开和系统剪贴板回贴，但不等于本目标包的截图或通过结果。`CHAT-MESSAGE-CAND-001` 是本页候选标识，不替换历史稳定 ID，也不依据历史工作项号推定产品需求版本。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，[AiPanel.tsx](../../../src/renderer/src/features/assistant/AiPanel.tsx) 承载会话，[Stream.tsx](../../../src/renderer/src/components/business/Stream.tsx) 使用同一 `displayText` 展示消息和向桌面剪贴板复制，[Message.tsx](../../../src/renderer/src/components/business/Message.tsx) 依据实际行高测量并提供展开/收起；三文件相对基点无未提交差异，SHA-256 依次为 `610035bbe1479755f4312b1864344990116e73a64026be7eab4d92880f03da02`、`9b9f6305b7c6b77cd4b1f3fec865358657863e8c741783746e8339544e7430a5`、`5472fa92e42f087941d27450b63c417371fbae304a52fad6f36d8c70069ef829`。这只是当前源码线索，不证明目标安装包同源、功能正确或需求自动采用。

执行时以获准隔离任务中预先记录的合成长消息原文及同一会话身份为独立参照，核视觉行数与完整复制值；发送需模型、费用及写入授权，剪贴板操作须在本次权限内。目标制品、需求版本及可复用真实完整窗口图待核；不以旧截图、组件或草稿代替完成态。

## 历史需求与冻结

从[历史冻结](../../frozen/p1-20261025-e2567e836/freeze.json)所记 `sourceCommit` `e2567e836e14707ad71477cc9cbeee32a00f5357` 回查 `apps/desktop/docs/scenarios/catalog.json` 和 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/conversation.json`，两者 SHA-256 分别为 `b0f7f62ba4cb39a487ee2026d1bf38aed6f0baa110157430de10a12d240a0671` 和 `929ec7c1bfab9f0f231e91f44ec4869052dbbc6f5ec7128ca4d4704d3c032590`，与冻结源清单一致；可使用 `git show e2567e836e14707ad71477cc9cbeee32a00f5357:<路径>` 回查，不恢复或改写冻结文件。

| 历史稳定点 | 历史语义及证据边界 |
| --- | --- |
| `CHAT-TURN-01@1` | 真实一轮回答、对应请求并达到终态；目录标记 `reviewState=current` 但 `coverageEligibility=exploratory`，对应 `D4-CHAT-001` 的预期仍为 `candidate_unapproved`，不外推为本目标已采用。 |
| `CHAT-NEW-01@3` | 首次发送后建立与原会话隔离的新会话；对应 `D4-CHAT-002`，历史 `reviewState=pending`、`candidate_unapproved`。它不等同未发送草稿的隔离。 |
| `CHAT-HISTORY-01@3` | 重新打开已完成会话，读回原消息、回答和终态；对应 `D4-CHAT-003`，历史为待审探索候选。 |
| `CHAT-ARTIFACT-01@2` | 真实对话交付的文件产物身份一致且可打开，事实、来源和语义质量独立判断；对应 `D6-CHAT-005`，历史为待审探索候选。它不要求所有普通回合均生成产物。 |

历史截图和执行记录可能引用任务外原会话或旧环境，不自动作为本目标参考；后续获准真实回答的目标包完整窗口图见[真实单轮完成状态参考](#真实单轮完成状态参考)，真实文件产物完成态图仍缺。用户已确认的输入器草稿与队列要求分别由[输入器构建依据](./../task-composer/build.md)持有，不能将其 ID 或空态图冒充对话终态。

## 当前源码定位与边界

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；下列文件相对该提交无未提交差异。它们为定位、数据流和副作用线索，不证明与安装版同源、不自行批准需求。

- **入口与提交：** [AiPanel.tsx](../../../src/renderer/src/features/assistant/AiPanel.tsx) 持有任务面板和新任务入口；[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 的 `submitOnce` 处理输入、引用和提交状态，再调用公开客户端 `postTurn`。该调用可创建或推进真实会话，可能产生模型费用和持久化数据，不能作为只读准备。
- **回合与历史：** [api.ts](../../../src/renderer/src/api.ts) 的 `postTurn` 对目标 session 发起回合请求，历史数据由会话接口返回；[transcript.ts](../../../src/renderer/src/transcript.ts) 的 `projectHistory` 将历史回合投影为会话条目。响应受服务端、模型、网络与会话状态影响，不能以源码或预置桥事件证明真实终态。
- **产物：** [Artifacts.tsx](../../../src/renderer/src/features/assistant/Artifacts.tsx) 按回合及产物身份呈现文件条目，[assistant/api.ts](../../../src/renderer/src/features/assistant/api.ts) 提供产物内容和导入边界；有产物显示不等于文件可读或资料已导入。真实打开须核产品可见回合、产物身份和获准文件内容，导入另按人工条件执行。
- **条件与副作用：** 模型可用、登录/额度、会话隔离、运行中/失败或回合恢复可能影响提交和展示；状态不得以成功 ACK 代替真实回复。创建任务、发送、文件生成和导入是不同的写入或外部操作，需各自权限；本次未进行这些动作。

上述源码 SHA-256：`AiPanel.tsx` `610035bbe1479755f4312b1864344990116e73a64026be7eab4d92880f03da02`、`Composer.tsx` `2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`、`api.ts` `6eaddf9622cd43ab5adebcc9511a4ecce763e1ca7877f5237f60f6cd13fbb2af`、`transcript.ts` `518d70e77b770322ac477d50beba24e129791a554f01794b4f46c7c7d561e42f`、`Artifacts.tsx` `639691f76dc07fa9baef8d3884256a7ca9201df366358525ff8fb61869408d4b`、`assistant/api.ts` `14b524a0b29e7cbc1878389eb6a79ea398416d579b1cad20f6638657537cde00`。

## 输入、截图与交接

当前目标线索为 macOS arm64 `0.3.2 / 202611121823 / preview`，既有运行记录的 ASAR SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；后续执行仍须重新核对实际实例和精确制品，不能由当前源码 HEAD 或历史包号建立同源关系。[examples 项目](../../../../../examples/projects/evaluation/project.json) 提供合成原始文件，不提供真实会话或预置回答；选定后按清单核来源、摘要与隔离副本。

本页已有获准的目标版本真实对话单轮完成态完整窗口图，来源及限制见[真实单轮完成状态参考](#真实单轮完成状态参考)；真实文件产物完成态完整窗口图仍缺，不用输入器空态或组件测试图代替。下一步需确认 Owner、需求版本及采用/目标适用性，准备获准隔离项目、模型、费用和真实原始输入；创建会话、发送、生成、打开或导入的授权分别确认。确认前交执行方的只是候选和缺口，不进入已采用冒烟分母，也不改历史裁决。
