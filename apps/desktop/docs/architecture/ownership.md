# Desktop 所有权与依赖规范

## Scope / Non-goals

覆盖 main、preload、renderer 以及 renderer 内 app/shell/features/components/design 的职责。本文不复制 IPC channel、feature 或组件动态清单。

## Source of truth

`src/main/`、`src/preload/index.ts`、`src/renderer/src/contracts/`、`src/renderer/src/app/composition.tsx` 和各 owner 的实际测试是当前事实源。

## Current / Required / Gap / Advisory

- **current**：main 持有 Electron、文件系统、进程与窗口能力；preload 是隔离桥；renderer 使用 typed browser-facing API。
- **required**：renderer MUST NOT 导入 Node/Electron 或绕过 preload；新增能力 MUST 同时确定 main handler、preload 暴露、renderer 类型契约与失败语义。
- **required**：领域代码放 `features/<domain>`；跨领域业务组件放 `components/business`；无业务语义的复用构件放 `components/primitive`；设计系统原子放 `components/ui`。
- **gap**：历史 `App.tsx`、root renderer modules 和旧 `components/` 仍有混合职责，应渐进收敛，不能作为新增放置依据。
- **advisory**：MAY 先扩稳定 contract 再迁调用者；不要创建只转发名称的空壳层。

## Ownership / Dependency

`renderer → preload contract → main handler → OS/service`。业务 UI 的允许方向为 `app/shell/features/business → ui/primitive/contracts/design`；`components/ui` MAY 使用无业务语义的 `components/primitive`，不得读取 API/store 或任何 feature。

## 对话卡片的绑定校验

**current（源码）**：main 的 `skills.ts` 持有绑定校验请求的响应生命周期。校验通过窗口
Session 访问既有 binding 接口，逐块读完并丢弃响应正文后才返回状态；成功与错误状态都
必须收尾。读取异常或达到独立校验预算时中止原请求，不能只取消 Response body，
也不能把收到 HTTP 状态当作网络资源已释放。校验预算短于卡片 RPC 预算，由所属代码常量持有。

主窗口来源、本机后端、Host-Key、用户/reference 与 revision 校验保持原边界；异步读取
结束后 main 仍复核 lease。生命周期校验不额外要求 pending，历史卡片的复制路径仍可使用。
轻量回执接口与改变发现根不属于这项响应收尾机制。

**required**：除完整正文、错误状态、断流与截止回归外，真实产品需在任务/SSE 存活时
反复操作卡片，并核对技能页和会话请求持续可用；macOS 结果不替代 Windows。

## Feature 贡献与工作台能力

领域贡献由各自 `features/<domain>/feature.tsx` 暴露，在
[`app/composition.tsx`](../../src/renderer/src/app/composition.tsx) 汇总，
[`contracts/features.ts`](../../src/renderer/src/contracts/features.ts) 定义插槽与注册表。
新增功能先使用适用贡献项，不在 Shell 按文件扩展名、库类型或业务状态增加特例，
也不为接线复制领域 Store。当前协议包含任务源、上下文来源、文档面板等插槽，
不能照抄历史文档里的字段或路由清单；新增导航键须同时核对类型与实际消费者。

组合顺序决定需要去重的贡献项优先级，冲突时保留先注册项并告警；不是静默覆盖，
也不能推断所有贡献数组具有同一种去重规则。Viewer 的装配期加载/错误边界在组合根
统一施加，避免 Feature 作者和各 Shell 消费点重复负责。产品启用策略决定哪些模块
参与装配，模块源码存在不等于产品入口已启用。

Workbench 持有文档会话与查看器；业务面板接收稳定身份和窄贡献上下文，不接收
工作台可变 Store 或其他领域私有 API。Viewer 能力匹配以 Serve 返回的查看器与能力
契约为依据，不在前端按扩展名另建“能否编辑”的第二份判断。选区加入和发送的边界见
[选区快照知识](../../../../docs/features/selections.md)，不能将冻结文字当作当前来源的写回授权。

**current（源码）**：会话 Artifact 的 `/open` 投影通过已注入的 `DocumentFormatPort`
复用资料库的格式注册表，renderer 与文献附件共用投影加载分支，不再根据 Artifact 的
MIME 或展示提示另选编辑器。目录成员沿同一入口保持只读；产物版本、大小和来源限制仍
由 Artifact Owner 裁决，不继承项目文件的版本管理或标注权限。兼容表格预览复用格式
Port，原始字节及写回修订不被转换结果替代。

**Current (source)**: Session artifacts use the injected `DocumentFormatPort` and the
project Workbench format registry through their authorized `/open` projection. The
renderer shares the attachment projection loader rather than selecting a viewer from
artifact MIME hints. Directory members remain read-only; artifact ownership, size,
revision and edit restrictions still apply. Compatibility previews use the same format
port without replacing original bytes or write revisions. Project versioning and
annotation permissions are not granted to artifacts.

**current（源码）**：产物选区资格使用格式投影的 `can_select`，不与编辑或标注权限绑定。
PDF 解释与翻译携带 session/artifact/member 身份，后端经产物 Owner 校验会话访问权、
发布成员及源修订；选区添加到会话使用稳定产物文档身份和完整冻结文字，不冒充项目路径。

**Current (source)**: Artifact selection follows the format projection's `can_select`,
independently of editing and annotation permissions. PDF explanation and translation
carry session/artifact/member identity; the artifact owner checks session access and
published membership, and analysis validates the source revision. Adding a selection
uses stable artifact document identity and frozen text, not a fabricated project path.

修改贡献协议时核对所有注册/消费方及禁用模块路径；类型与注册表测试不替代实际入口、
文档打开、主题/语言切换和真实任务交互。动态贡献清单留给源码，不在本页镜像数量。

## 会话提醒与原生通知

- **current（源码）**：main 在既有提醒快照 GET 中携带已接受的 `epoch` / `after_revision`；同一归属代次内仅新增完成提醒附带临时 `markdown` 原文，不新增正文接口或持久副本。冷启动及代次不匹配不带原文、不补弹历史；原文绑定提醒的 turn/item/source sequence。序列化 UTF-8 原文单条最多 1 MiB、批次最多 4 MiB，缺失或超限返回 `null`，不传截断 Markdown。main 与正文共用 `src/markdown/` 的纯解析规则，提取可见文字后脱敏并按字素边界截断；原文不可用时记录错误并使用本地化兜底。附带原文不保留到 main 快照或传给 renderer IPC。
- **Current (source)**: Main sends its accepted `epoch` and `after_revision` on the existing attention snapshot GET. Only new completed reminders in the same ownership epoch carry transient `markdown`, anchored to their turn, item and source sequence, without a separate content endpoint or persisted copy. Cold starts and epoch mismatches neither fetch original text nor replay notifications. Serialized UTF-8 originals are limited to 1 MiB per answer and 4 MiB per batch; missing or oversized sources are `null`, never partial Markdown. Main and the answer renderer share pure rules in `src/markdown/`; notifications extract visible text, redact it and truncate on grapheme boundaries. Unavailable sources log an error and use localized fallback text. Originals are discarded before retaining the main snapshot or forwarding renderer IPC.

- **current（源码）**：Serve 的 `chat/persistence/attention.py` 在产品事件事务内投影待处理、每轮完成和最终失败提醒；未查看条数与已读水位保存在现有会话目录数据库，不从侧栏状态或消息时间推算。历史会话不批量回填提醒，业务请求、失败及结果不因已读而删除。
- **current（源码）**：已结束的交互请求不生成待处理提醒；收到交互已处理事件时，仅撤销同会话、同请求的待处理提醒投影，并在同一事务内推进提醒版本以触发桌面刷新。授权与事件历史保留，不冒充用户已读；查询不追加过滤，启动不扫描或清理历史残留，旧提醒仍由用户通过全部已读处理。
- **current（源码）**：main 的 `reminders.ts` 持有一条共享通知 SSE，按提交后的失效消息合并拉取归属范围内的提醒快照，经受控 IPC 供 renderer 复用；快照失败独立退避重试，空闲时不定时读取。`attention.ts` 在原生提交前持久化交付水位。启动先建立基线并恢复角标，不补弹历史；任何本应用可见且聚焦的窗口都抑制通知和声音。renderer 不直接发通知或独立蜂鸣。无 Desktop bridge 的 Web 提醒仍保留原轮询路径。
- **current（源码）**：renderer 的 assistant 提醒模块负责未查看投影和内容可见后的确认；通知与托盘点击由 `shell/Background.tsx` 统一订阅，`app/background.ts` 持有同一导航请求序号，异步读取后只有最新请求可以发布项目、打开会话或关闭设置。后端实例、工作台就绪或登录状态变化及卸载使旧请求失效。全部已读带快照 epoch 与 revision，覆盖所有项目和三类提醒，保留并发新提醒；进入会话、点击或关闭系统通知本身不等于已读。
- **required**：点击只传不透明提醒 ID，Serve 按任务当前状态解析项目、会话及待处理、结果或失败锚点；不执行授权、重试或其他业务动作。旧目标无效时只恢复应用窗口。
- **current（源码）**：macOS 使用系统通知及 Dock 数量；Windows 复用既有原生 Toast 与任务栏数字覆盖图标，隐藏到托盘、无任务栏按钮时不承诺可见角标。系统设置入口分别打开 macOS 通知首页和 Windows 通知页。声音开关只决定通知是否请求静音，最终受系统权限、静音和专注设置控制。
- **required / gap**：源码与确定性测试不证明原生弹出、声音、角标或历史通知激活通过；每个平台需独立真实产品证据。系统拒绝投递或清理失败不回滚已读状态，也不自动反复补发。

## 工作台驻留与资源释放

**current（源码）**：Serve 在准备会话遇到已知共享 Host 配置冲突时自动发起后台
受控切换，触发请求先退出，后台再等真实任务和资源排空。Composer 的 business
`Reconfigure` 只读 current/UUID 状态并显示非阻塞 Alert，不再提供确认弹窗、
mutation IPC 或客户端切换 POST。组件卸载不取消后台操作；未知提交不触发切换，
未知查询仅有界读回，页面恢复不创建操作，原消息不自动重发。
状态观察的错误分类、退避策略及业务错误码归 `src/reconfiguration.ts`：可恢复故障
每个观察周期最多连续失败四次，间隔依次为 500、1000、2000 ms；成功后重置计数。
永久 HTTP 错误或无效响应立即停止，耗尽后只提示查询不可用，不推断存在切换。
重新打开任务重新开始观察；已取得 UUID 后的暂时查询故障才表示切换结果待确认。
`Reconfigure` 的纯状态解析同时决定翻译 key 与 Alert tone，不分别维护平行判断。
**gap**：确定性契约、UI render 与类型检查不证明两平台真实模型切换成功。

Office 字体准备由 `src/main/fontfiles.ts` 持有系统字体文件目录与读取身份，
`native/fonts.c` 仅通过 CoreText / DirectWrite 异步发现字体来源。preload 暴露目录和
opaque ID 读取，不接受 renderer 文件路径。目录按实际文件身份合并 TTC 的多字体引用，
保留系统公开的 face 和字重；读取前后核对文件身份及修改状态，不静默忽略失败字体。
不同 Office 宿主共享进行中的枚举，不在 main 持久缓存字体内容。浏览器独立运行模式
不获得该本机能力。字体与宿主的生命周期一致，同宿主切换文档沿用已安装的完整字体。

**current**：主工作区、导航恢复及后端就绪后，OfficeRuntimeProvider 在首帧后的空闲调度中
准备一个隐藏的单例宿主，不等待文档需求。prepare 负责完整字体和 WASM 初始化，bind
负责文档；引擎 running 前仅保留绑定，不提前上传。提前开档、后续 DOC/PPT/XLS 切换和
关闭最后文档都复用同一宿主。CSV/DOCX/PPTX/XLSX 原生预览不绑定该宿主，也不创建
第二个引擎。无文档锚点时后台准备和失败重试均不展示进度或通知；预热恢复计时归宿主，
不随文档绑定变化重置。现有字体权限、清单完整性、缓存校验及卸载清理保持原边界。

**current（源码）**：`src/main/fontcache.ts` 在 desktop userData 的 `office-fontconfig`
目录原子保存一份有界 Fontconfig 派生索引，不保存字体字节或文档。身份涵盖完整来源文件
元数据、face 选择、安装顺序及冻结引擎/字体制品清单；变化、损坏或不完整的记录作为未命中。
`office/fontcache.js` 等待完整字体和资源安装后恢复索引及原目录时间，未命中时由
[`native/fontconfig`](../../native/fontconfig/README.md) 的固定 wasm32 生成器使用同一份
字体字节生成。该生成器绕开冻结引擎的硬链接锁失败；原 Office 引擎保持不变。生成失败
保留诊断并让引擎扫描完整字体，字体读取失败仍由原 gate 阻止启动。
**required**：安装命名、TTC 选择或缓存语义变化且制品未变化时，递增
`OFFICE_FONT_CACHE_SCHEMA`。兼容验证须包含真实引擎首开、独立进程重启和切换文档。

`office/frame.ts` 同时准备完整字体和 WASM 资源，locale 参数先于 loader 捕获。
`local-fonts.js` 在同步 preRun 中持有 run dependency；完整字体写入 FS 后才释放。
字体、资源或脚本失败不会放行该 gate，销毁后的异步结果不能访问旧 FS；失败重试
沿用宿主的 frameEpoch 重建机制，正常切换文档继续复用已初始化的引擎。

历史材料中的 LFS 指 Least Frequently Selected，不是 Git Large File Storage。
现行驻留策略是关闭合资格的 LRU Tab，不沿用保留 Tab 后把 Session 标为
`suspended/restoring` 的旧预算方案；重新打开已淘汰文档走正常 Loader，而不是
宣称存在该旧状态机。不要按历史 `implemented` 标记恢复选择次数或字节预算机制。

- **current**：[workspace.ts](../../src/renderer/src/features/workbench/workspace.ts) 的注册表跨项目持有 Tab 选择序列与统一上限；候选按最近使用顺序淘汰，当前活动项目可见 Tab、dirty Session 和非 clean 保存状态受到保护。没有安全候选时允许暂时超限，不通过自动保存、回退或丢弃编辑强行收敛。
- **current / required**：Tab 是共享 Session 的投影。自动关闭走 `closeCleanTab` 的防御性检查和既有关闭原语；最后一个 Tab 引用消失才删除 Session、保存代理与文本历史。隐藏 Tab 或组件卸载不能等同于共享模型释放，分屏中的剩余引用仍须有效。
- **current**：离开文档区时的自动保存通过普通 `save` 流程先准备编辑器本地文本，再判断 Session 是否 dirty，避免遗漏尚未投影的输入。无变化的文本沿既有保存流程结束，焦点保存只处理当前文档。
- **current**：[reclaim.ts](../../src/renderer/src/features/workbench/reclaim.ts) 以实际存活 Session/Tab 集合调用已注册 Viewer 回收器。Viewer 负责自己的缓存释放，工作台不能为调用回收辅助函数静态导入具体 Viewer 实现并扩大首屏依赖。
- **current**：[limits.ts](../../src/renderer/src/features/workbench/limits.ts) 持有大文件与 Markdown 轻量路径阈值；字节数或行数严格超过对应边界才关闭高开销编辑辅助能力。这是编辑性能策略，不修改正文或保存语义，也不是全局按内存字节拒绝打开的准入机制。
- **required**：修改驻留策略时验证跨项目淘汰、dirty/可见/保存中保护、分屏共享引用、最后引用释放与大文件边界。纯策略测试不证明真实 Monaco/PDF/Office 缓存回收或 renderer OOM 消失；仍需真实 Desktop 超限打开与最终截图。两平台产品验证分别保留，不由本轮 macOS 文档核验替代。

- **required**：renderer 崩溃后，窗口对象存活不保证 WebContents 可发送；向主窗口发送前须核对两者生命周期。`src/main/index.ts` 的 `aliveMainWindow` / `sendToMainWindow` 是现有接点，不等于全部发送点已覆盖，也不授权自动重启或掩盖未保存数据风险。

## 正反例

```ts
// 正例：renderer 使用 preload 声明的受限能力
await window.scholarseed.saveDocument(request)

// 反例：renderer 直接拥有系统能力
import { ipcRenderer } from 'electron'
```

## Enforced by

TypeScript 的 node/web project 边界、`scripts/ci/__tests__/standards.test.mjs` 的 UI 依赖检查，以及 main/preload/renderer 对应 tests。

## Update triggers

模型订阅登录的 current 边界：`src/subscriptions.ts` 定义 IPC 合同，main 校验主窗口、
本机托管服务与授权 URL，并用窗口账号 session 请求登录、打开系统浏览器。preload 只投影
事务状态；renderer 不接收 host key、授权 URL 或上游 token。浏览器/远程 attach 明确报告不可用。

新增 IPC/OS 能力、一级目录职责、跨域 contract 或依赖方向时更新。

### 文献检索结果与授权读取

- 科研结果承接加入文献库、仅添加元信息及 BibTeX 导出；只有精确检索卡片、且勾选论文中已有下载完成时，批量入库才提供“元信息和全文”，复用已下载字节作为主附件。不提供独立全文下载卡、文件夹交付卡或 PDF 保存操作，也不为入库重新下载全文。
- Serve 继续提供经授权的托管全文读取和历史引用解析，不将内部获取写为用户入库或保存成功；已下载全文的判定与挂载同样由 Serve 持有，renderer 只带回可复用篇数并据此决定是否渲染该选项。

### 登录窗口尺寸

登录窗口尺寸由 `src/window.ts` 定义，renderer 仅报告登录页是否可见，
preload 转交 main；main 校验发送窗口与布尔参数并管理尺寸，浏览器模式不调整宿主。
退出登录页时恢复进入前的工作台位置、尺寸和最大化状态；重复通知不重置用户调整。

| 平台 | required：登录页 | required：退出登录页 | 验证边界 |
| --- | --- | --- | --- |
| macOS | 原生窗口外框 900×600，先降低最小尺寸 | 恢复工作台窗口 | 真实 Desktop 截图与尺寸检查 |
| Windows | 同一 Electron `setSize` 外框尺寸语义，系统缩放使用 DIP | 同一恢复逻辑 | 尚需 Windows 真实 Desktop 验证 |

## 前后端并行启动

**current**：main 的 `assets.ts` 在 loopback 独立托管只读前端制品，主窗口不再等待
Python 健康检查才加载。静态服务不提供 API 代理；Serve 保留业务 API。第一次导航仍
安装 CSP、COOP/COEP 与权限控制，可信账号地址由同一启动配置供两端使用。

主窗口的显示与业务 ready 分开：Windows 安装版只有原生组件检查确认可复用后，
才在 `ready-to-show` 交接到主窗口；若本轮进入过下载/准备，继续保留组件进度窗口，
待后端及窗口服务完成再交接。macOS 的组件随包交付，开发版无该原生组件准备阶段，
均可在首屏绘制后显示。交接按窗口和启动代次校验且只执行一次，后端完成不会再次
抢回用户已隐藏的窗口；失败页也不绕过首次绘制和退出检查。

Desktop 在固定 Python 来源、版本、SQLite、架构与环境，并建立后端进程后，使用
相同环境在后端私有通道完成认证后运行 `service.platform.executables` 探针，避免与冷导入争用资源。
认证仅确定探针的启动时序，不代表工具链或业务就绪。探针仍执行产品拥有的
Skill Python launcher `--version`，不以解释器版本检查代替 launcher 校验；结果通过
继承 stdin 建立的私有认证通道一次性交给 Serve。Serve 的 lifespan 等待该回执，
不再串行重复探测；失败或断链不开放 HTTP。独立 Serve 仍本地查找、验证及整理 PATH。
launcher 的版本与诊断入口只校验实际解释器和 Serve 身份，不代表全部技能依赖健康；
脚本与任务经同解释器的 `service.cli.skill` 入口加载完整静态依赖并执行原准入校验，
依赖加载、冻结清单或在线准入失败均不执行脚本。
TeX 回执和 AI 执行门控保持独立。探针属于启动资源，退出需收束；Windows 在放行
探针前绑定 Job，macOS 使用独立进程组处理取消，均不继承后端控制 stdin。
Windows 在主进程退出后先有界等待 Job 成员自然退出，再对仍未退出的成员强制清理；
退出事件不等于 Job 已归零。发生过强制清理的进程族即使后续归零或重试，仍不能作为
干净退出或探针就绪的依据；取消与探针超时仍立即终止其拥有的进程族。

`startup.ts` 定义带 generation/revision 的启动快照；main 发布，preload 在读取初值前
订阅并缓存，renderer 的 `app/connection.ts` 读取。未就绪端点不可用于业务请求。
`app/Startup.tsx` 提前绘制启动状态，首次 ready 后才挂载业务 Store；后端重启不重挂
整个业务树，健康轮询和实时订阅按代次恢复。关闭窗口入口不依赖后端挂载。

**required**：窗口已显示不代表工作台、模型或更新候选健康确认完成。原生资格、存储
检查和更新确认门槛不变；应用退出要关闭资源监听并收束后端。首次安装中 Electron
之前的下载、解包与原生激活不在这段并行范围内。

**gap**：目前仅 macOS 源码 Electron 的隔离启动、重载和退出有真实验证；两平台
安装版首装/升级、异常恢复、Office 和账号全链路仍需独立验收，不能以首屏替代。

### 基础健康与 AI 就绪

后端早期诊断不参与准入：`window.log` 的 `[startup] backend checkpoint` 区分
spawn 调用返回、spawn 事件、Windows Job 绑定/放行排队及首份输出接收；排队不等于
子进程已放行，spawn 事件也不等于 Python 已执行。`backend.log` 的 `startup_checkpoint`
由子进程直接写出，覆盖 Windows wrapper 入口、握手放行、模块分派以及 Serve 的
前置依赖、默认环境、bootstrap 和剩余导入完成。子进程标记携带 PID、单调时钟和 Unix
时间；同进程间隔用单调时钟，跨进程以 Unix 时间辅助对齐，不直接相减不同格式的单调
时钟。wrapper 前仍包含解释器初始化，不能将整段空白归为业务导入。macOS 保持 `-m`
启动，只有父进程与 Serve 标记，不产生 Windows 握手标记。日志不输出参数或凭据，
不修改健康期限、签名策略或就绪定义；Windows 安装版效果需重新采集验证。

托管 backend 使用 `/api/healthz/backend` 确认基础服务，attach 保留完整健康探测。
旧独立 Serve 不支持轻健康时，renderer 仅对 404/405 回退完整健康；
认证、维护和服务错误不触发回退。
renderer 分别轮询基础健康与完整 AI 诊断，实例/代次改变后忽略旧响应；
AI 未知继续禁止发送，目录未知不覆盖已打开会话的就绪事实。
更新健康回执仍等待完整 AI 诊断返回，不以基础服务提前开放替代原有门槛。
开发态 Codex 热缓存解析改为完整库存/no-links/哈希核验，执行兼容性由 Adapter 探测；
默认构建、首次供应和并发发布仍保留原有精确版本验证。安装态不走该开发解析路径，
因此开发态去重收益不能直接外推安装版。

Python 身份检查使用异步子进程，版本、SQLite、平台/架构、来源与 venv 校验不变。
TeX 使用独立准备任务，基本后端不等待其完成；完整 PATH、字体/cache 环境在 spawn
前冻结，AI 执行通过私有控制回执等待准备完成。失败只关闭执行准入，不冒充全部就绪。
退出取消供应并等待实际下载/解压/探测收尾，不遗弃仍写 staging 的任务。Windows
legacy 组件供应允许延后 TeX；native resident 在 Electron 前的全组件供应不在此优化内。

## 主窗口 CSP 生命周期

- **current（源码）**：`src/main/loading.ts` 持有主窗口首次导航的 commit/load/ready-to-show 联合终态，失败、取消和截止后清理本 attempt 的监听与 timer，并阻止迟到完成继续启动；导航成功即解除截止，后端仍使用自己的启动预算。`index.ts` 在首次工作台交接前继续保护 renderer 崩溃终态，失败使用既有启动失败表面，不自动刷新已有会话。
- **current（源码）**：`child-process-gone` 在启动窗前注册，记录原始 type/reason/exitCode/serviceName/name、时间与导航 attempt；Electron 未提供 child PID 时不编造。存储发布前只输出并有界缓存，发布后经现有目录 writer 和轮转日志落盘；事件本身不触发重载或降低权限。两平台真实验收仍需独立证据。

- **current / required**：[csp.ts](../../src/main/csp.ts) 持有主窗口 CSP 构造与安装；Session 响应回调必须在注册时捕获稳定的 `webContentsId`，不能在回调内访问可能已销毁的 `BrowserWindow` / `WebContents`。保持只向目标主框架注入策略，不通过移除 CSP 或吞异常处理退出竞争。
- **required**：定向回归在仓库根运行 `node --experimental-transform-types --test apps/desktop/src/main/csp.test.ts apps/desktop/src/main/index.test.ts`；真实产品回归先运行 `pnpm ops cd build local --stage app`，再运行 `pnpm ops ci test e2e --scope desktop -- --project=smoke e2e/csp.spec.ts`。Electron 注入的 CSP 在 Playwright 响应头视图中可能不可见，真实策略验收应触发受限请求并断言 `securitypolicyviolation` 的 directive 与 originalPolicy。构建验收的成功 JSON 必须与进程正常退出分别核对；文档给出命令不自动授权产品启动。
- **required**：macOS / Windows 使用相同的 Electron Session 回调与稳定内容 ID，但 macOS 实机结果不替代 Windows 实机与安装包验收。当前知识迁移不修改两平台的进程、路径、权限或终止语义，源码接线与确定性契约也不证明真实平台验收已完成。

## 浏览器原生浮层

- **current（源码）**：安装/重启遮罩通过更新专属 Portal 投影原 React 内容，复用设置的模态生命周期与绘制确认；`blocking` 原生层高于设置、对话及菜单，低层模态不能抢回焦点。更新状态、取消和进度仍由原更新 Owner 持有，不隐藏或缩小网页。原生呈现失败显式记录并提示，DOM 回退不构成覆盖成功；两平台真实更新生命周期验收仍需独立证据。
- **Current (source)**: Installation and restart screens project the original React content through a dedicated update Portal, sharing the modal lifecycle and paint handshake with settings. The native `blocking` layer stays above settings, conversation panels, and menus; lower modal surfaces cannot reclaim focus. Update state, cancellation, and progress remain with the update owner without hiding or resizing web pages. Native presentation failures are reported explicitly; a DOM fallback is not successful native coverage. Real update lifecycle acceptance requires independent evidence on both platforms.


- **required**：内置网页是独立 `WebContentsView`，主 renderer 的 DOM 层级不是跨原生视图的合成层级。相交的产品提示和地址建议由 main 管理的隔离原生浮层展示，不能通过隐藏、移动或缩小网页解决覆盖问题。
- **required**：共享展示 contract 校验纯数据；preload 只暴露最小浮层通道；main 校验发送者与主 frame、限制本地资源和权限、持有生命周期。浮层不是网页注册表或 CDP/Agent 目标。非交互提示与地址建议须保持独立状态与焦点边界。
- **current（源码）**：`renderer/src/layout.ts` 在同一 renderer 帧内依次准备全部锚点、测量全部投影、提交位置；网页视口与 `shell/Floating.tsx` 共用调度，不由各自的观察器立即交错写入。Portal 的异步位置请求仍串行合并最新值；这不是原生 compositor 原子提交保证。网页 bounds 更新不广播未变化的业务快照，菜单位置资格检查与原生显示状态变化分开。
- **current（源码）**：`src/main/layers.ts` 统一维护控件、面板、菜单/提示、模态的原生顺序，仅在实际顺序失配时重排；浮层新建时不能盖住已打开的菜单或模态。两个分栏拖拽条分别占用有界 `RESIZE_PORTAL` 槽位，关闭一个不得撤销另一个，不允许合并成跨网页的透明大矩形。
- **required**：最终版本验收覆盖连续拖动的中间帧、左右交换后的导航分栏、折叠恢复、键盘焦点、窄宽度视口，以及菜单/提示先打开再创建原生面板的顺序。网页采用真实视口尺寸与原站点响应式规则；不得注入第三方 CSS、伪造 UA 或自动改变用户缩放来掩盖固定最小宽度。
- **required**：原生提示只占内容及主题阴影的绘制矩形，原生视图与提示页面背景同时透明；内容锚点不能随绘制边界扩展而移动。不能承诺 `WebContentsView` 鼠标穿透或转发底层网页点击。保留模态遮挡保护与主 renderer 无障碍描述。
- **current（源码）**：浏览器相邻分栏的拖拽条由独立 `RESIZE_PORTAL` 承载，复用 `src/main/portal.ts` 的主 frame 预约、无脚本页面、绘制确认与回收边界；`shell/Divider.tsx` 通过 `ResizablePanel.renderHandle` 投影原控件。占位几何与网页 bounds 不变，拖动仍由原分栏宿主计算。原生范围只覆盖控件及实际焦点阴影，不与对话浮层合并为透明大矩形；设置和对话浮层保持在其上方。macOS/Windows 原生拖动、焦点与合成截图分别验收，不以 fixture 代替。
- **required**：可滚动的纯文本标题提示沿原生提示通道投影；hover 只向当前 revision 回传悬停状态以保持原 tooltip 生命周期，不获得菜单动作、网页或焦点能力，滚动/点击内容不得直接撤销提示。
- **required**：可交互菜单由 `src/main/menuhost.ts` 校验实际窗口/网页资格，固定动作与有界 view 属于 `src/menu.ts`；原生 seed/publish 失败不得降级挂被网页遮挡的 DOM 菜单。共享 `components/primitive/presenter.ts` 的 consumer handle 按 surface/lease 隔离，旧消费者卸载不得撤销新菜单。
- **required**：账户请求与导航留在原业务宿主，普通/native 共用纯 `AccountMenuPanel`；paint ACK 前的业务或主题更新须在同 lease ACK 后串行合并补投影，替换/身份变化后禁止旧补发。renderer epoch 不是 Main/Serve 凭据安全保证，两者分别验证。
- **current（源码）**：普通设置与浏览器对话浮窗的原生呈现 owner 为 `src/main/portal.ts`，分别采用模态全窗口与有界非模态策略，原 React 树与业务 owner 不变；`shell/Settings.tsx`、`shell/Floating.tsx` 仅向无脚本子文档 Portal，`components/ui/Portal.tsx` 提供所属文档作用域，不复制 Store、不扩展业务 IPC 的 sender 权限。具体生命周期及验收缺口见下述浏览器边界。

根因、取舍和后续开发检查路径见[浏览器原生网页与产品浮层](../browser.md#原生网页与产品浮层开发设计约束)。

## 窗口关闭确认与后台菜单

- **current**：`src/main/tray.ts` 管理 Windows 关闭请求与偏好，并持有 macOS 菜单栏 / Windows 系统托盘的原生菜单；`src/window.ts` 定义关闭 IPC，`src/tray.ts` 定义有界后台菜单快照与导航动作。main 只接受所属主窗口主 frame 对当前菜单请求的合法回复；渲染层不持有系统窗口生命周期。
- **current**：每次左键或右键展开均请求新快照；`shell/Background.tsx` 接桥，`app/background.ts` 读取真实项目与任务 API，复用现有导航。最近项目是最近进入的项目，独立保存在 `recentProjectId` 偏好中，进入文献全览不清空；任务按活跃时间倒序最多三条，无任务隐藏整组。无可用项目显示打开应用，读取失败或超时显示不可用提示，不使用过期列表。
- **current**：托盘项目名与任务名仅在 main 菜单展示层归一为空白单行并按字符簇中间省略；整行预算包含本地化操作前后缀，ASCII 字符簇计 1、其余计 2，预算为 48，不代表固定像素宽度。完整名称保留在可访问标签与 macOS 原生悬停提示中；Windows 通过打开对应页面查看。原始数据、协议长度限制及导航 ID 不变。
- **required**：展开菜单不唤起主窗口；选择项目、新建对话、任务或文献全览才恢复窗口，点击项目/任务后重新核验目标归属与可用性。新建对话进入该项目草稿，不发送消息；退出复用 `app.quit()` 和现有保存排空。用户标题不得成为 IPC 指令或文件路径。
- **current**：`shell/Close.tsx` 组合统一 `Dialog` / `Button` / `Checkbox`，复用主题及本地化；内容自适应高度，底部按钮整颗换行，极端小视口才允许弹窗内部滚动。窗口级确认使用 `design/zindex.css` 的专属层级，覆盖设置、登录与反馈弹层。
- **required**：使用真实非 headless Desktop 的关闭事件验证；测试不得伪造 `process.platform` 或注入关闭 IPC 充当 Windows 验收。
- **current（源码）**：`src/main/window.ts` 协调 macOS 关闭隐藏：原生全屏先请求退出，收到 `leave-full-screen` 后才隐藏；重复关闭只保留一个待办。恢复入口撤销待办，销毁释放监听，退出或维护期间不执行延迟隐藏。窗口及 renderer 不销毁，Windows 的确认与托盘策略不变。时序单测不替代真实全屏 Space、红色按钮及恢复操作验收。
- **current**：托盘与窗口生命周期诊断写入 `$SCHOLARSEED_HOME/logs/window.log`，复用滚动日志，记录时间、进程、关闭选择、托盘鼠标进入/点击、原生菜单打开、恢复前后窗口状态与退出事件。日志用于区分事件未送达、恢复失败和进程退出，不把诊断改动当作托盘失效已修复。

| 平台 | 关闭窗口 | 真正退出 | 验证边界 |
| --- | --- | --- | --- |
| macOS | 保持原有隐藏窗口，不展示 Windows 确认 | 应用菜单或菜单栏图标退出 | 后台菜单需真实菜单栏展开、隐藏/唤起与退出验证；确定性测试不能替代原生验收 |
| Windows | 默认显示统一确认；取消不改变偏好；托盘操作保留后台工作；记住偏好保持原有下次直接隐藏语义 | 确认退出或托盘退出交给 `app.quit()` | 确定性测试覆盖请求与动作；Windows 真机主题、DPI 与交互验收仍为 **gap** |

## 反馈录制的探针所有权与停止快照

- **current**：问题反馈弹窗的录制按钮向所有用户开放，通过共享启动事件进入同一 Recorder；先关闭弹窗并等待渲染提交，再采集初始页面。右下角问号入口向所有用户显示，悬停提示“问题反馈”和快捷键。点击与空闲态快捷键共用身份策略：内部开关开启且已登录时启动录制，外部或未登录用户打开既有反馈表单。macOS 使用 `⌘+⌥+F`，Windows 使用 `Ctrl+Alt+F`；录制或暂停中快捷键仍执行截图，其余录制阶段不触发新流程。不新增第二套录制或反馈表单状态。
- **gap**：Windows、外部已登录用户、暗色主题及最小原生窗口尚未完成真实验收；不以纯策略测试或 macOS 结果代替。
- **current**：[probe](../../src/renderer/src/features/feedback-recorder/probe.ts) 只维护一个活动 lease，安装新探针前释放旧 lease。`dispose` 先同步提交防抖中的输入，再标记 inactive 并卸载监听；仅当 fetch、XHR 或 History 的当前实现仍是该探针的 wrapper 时恢复原函数，不覆盖后来安装者。
- **required**：停止不能只清定时器丢弃最后输入，也不能先生成 review 快照再释放探针。[Recorder.stop](../../src/renderer/src/features/feedback-recorder/Recorder.tsx) 在 dispose 后读取权威 session ref，使最后一步进入 stopped 快照；后续调整须保持该顺序与幂等释放，不复制第二份录制业务状态。
- **current（2026-10-28，源码）**：录制栏输入按步骤自动暂存在本轮 Renderer 会话，不再提供“记录”按钮、Enter 提交或逐条记录 toast；普通 Enter 换行。截图标记同样不单独请求后台；底部“提交”停止录制并打开补充说明弹窗，弹窗确认后才统一提交全部步骤、各步最新说明、截图和诊断信息。失败保留录制供手动重试；退出清空本轮暂存，不删除历史远端反馈。确定性回归覆盖自动保留、多步关联、确认前零提交、失败重试和退出隔离；最终实机上传仍须单独验收。
- **current**：密码类型、凭据名称及敏感 autocomplete 输入不会由 `inputValue` 提取普通值。这只说明该输入机制的保护，不能外推请求正文、响应或截图自动去除所有秘密；录制与诊断日志的授权及实际提交范围仍分别核验。
- **required**：Renderer 持有语义录制与状态，截图交由 Main 的 typed 能力；Desktop 经 preload 的受限提交协议，由 Main 校验附件、取得托管凭据并向产品配置的 `feedback_base_url` 提交。Renderer 不指定远端、凭据或宿主文件路径。Serve 仅作为可选的完整诊断 ZIP 收集器；不可用时 Main 打包已有录制、Renderer 报告和有界脱敏宿主日志，界面明确提示诊断不完整。远端失败不自动改道或重试，避免重复反馈。独立 Web/Serve 保留原有提交入口。不把探针搬入 Runtime 或 Trace，也不为反馈新增通用监控框架。截图覆盖原生网页时还须核对当前合成层，不把主 Renderer 的 capture 当作全窗口证据。
- **gap**：旧评审的提交ID、截图及“无未解决发现”只证明当时范围；本页不追认当前或 Windows 实机验收。改动时先运行 [probe 契约](../../src/renderer/src/features/feedback-recorder/probe.test.ts)，再真实验证立即停止、暂停/恢复、多次安装、敏感输入、截图、审核与提交错误。fixture 中普通输入被保留不证明产品提交或凭据零泄漏。
- **current（源码）**：Windows 勾选日志且 Serve 收集失败时，Main 从同一启动 Home 的有界持久后端日志提取白名单沙箱事件，另附 `host/sandbox-diagnostics.log`。保留 setup 尝试、固定探针、工具检查失败、RPC 关联字段和已报告的原生阶段/系统码，不复制整份后端或原生私有日志。记录缺失仍保持部分诊断；此兜底不代表完整原生阶段或真实提交已验收。
- **current（源码）**：仅在最新可关联的 runner 管道握手失败未报告系统码时，Main 才在该请求时间窗查询 Windows System 的 Application Popup。唯一匹配的官方 runner 记录只导出 NTSTATUS、事件编号和时间、RPC 关联字段，标注为时间窗关联，不当作同一进程的证明或 Win32 错误码；缺失、歧义或读取失败不影响已有诊断，不导出系统事件原文。

## Stop condition

确定能力 owner、跨边界 contract 和覆盖测试后读对应源文件；不要把 preload 当业务层。

## Preview 更新范围

**current（源码，安装包验收待完成）**：Desktop main 的 `preview.ts` 定义仅 preview
使用的范围与固定候选判定；`updater.ts` 在既有更新状态目录保存 `preview.json`。
默认 current-line，只接收当前 major.minor 的修复；current-version 只接收当前完整
版本号的新构建。显式跨线选择绑定已查询且服务端允许的具体制品，取消后回到原范围，
成功更新消耗一次性选择并保留范围偏好。release 不读取该状态，也不显示该入口。

**current（源码）**：preview 的 ready / preparation 候选记录使用更新状态目录内的
`preview/`，DMG 载荷使用系统更新缓存内的 `preview/`；release 保持原路径。
取消或重置在准备任务排空后回收该目录中尚无 ready 记录的部分下载，仍遵守活跃挂载保护。
旧共享目录中的候选不会被 preview 认领或无归属删除；安装交接和恢复日志保持原路径，
不以候选隔离绕过历史交接恢复。Windows Velopack 的安装根缓存和共享 runtime 另由其
既有 Owner 管理，不因取消 preview 而清空。

**required**：范围改变须排空准备任务、失效旧候选并拒绝迟到检查结果；启动恢复、
下载和安装授权再次核对范围及服务端发布状态。仅展示已缓存候选不构成安装许可。
设置关于页的 Preview 入口复用 Select、Dialog、Button，使用现有更新确认层级；
无对应新版 MasterGo 画板，布局为沿既有设置与组件的语义推导。

**gap**：旧客户端的无来源上下文安装授权仍保持既有 published 与制品身份校验，
新服务端只能在旧检查请求处默认同线，无法可靠撤销旧客户端已经缓存的跨线包。
真实 macOS / Windows 签名包与配套发布服务的升级、取消及重启验收不能由组件测试替代。

## macOS 启动交接记录续接

**current（源码）**：macOS 安装版将未决更新与一般启动故障分开。两处更新准入拒绝、
交接观察失败，以及已观察事务中的目录恢复或最终复核失败，由 `admission.ts` 尝试发出
非阻塞系统通知并以非零码退出，不显示会持续占用目标 App 的恢复对话框、不自动重启。
不创建业务 BrowserWindow/Session、不启动后端、不发布存储选择，不消费或改写更新记录。
无更新事务的一般存储故障仍使用独立 OS 原生恢复对话框。文案来自随包资源；主进程
语言尚未初始化时使用默认语言，不读取未准入目录的偏好。

原生 helper 活跃且失败回执已经通过绑定与目录身份核验时，观察结果为 `restoring`，
不能因此启动旧版。它与 `installing` 一样保留既有五秒有界观察；helper 退出后重新
检查回执才可能得到 `failed`。观察结束仍未决时退出，不能把原生的启动请求接受标记
当作工作台恢复成功，也不通过延长原生安装超时掩盖竞争。

未决更新诊断通过 macOS `/usr/bin/logger` 写入系统日志，消息包含 `ScholarSeedStartup`、
状态、PID、版本和有界脱敏错误，不初始化未准入 Home。可在 macOS“控制台”搜索该标记，
或运行 `log show --last 1h --style compact --predicate 'eventMessage CONTAINS "ScholarSeedStartup"'`。
`installing` / `restoring` 使用 `user.notice`，`failed` / `unconfirmed` 使用 `user.err`；
状态文案与日志级别由同一穷尽映射持有。通知对象保留强引用至报告完成，完成回调幂等释放。
通知的 `show` 事件不再提前结束报告，留用既有两秒总预算的剩余时间供系统呈现，
失败则提前结束；不追加固定延时、不延长原生安装等待，也不承诺通知必达。
通知与日志报告各有两秒上限；通知被系统禁用、日志失败或 app ready 未完成都不能保活
目标 App，也不回退到阻塞错误框。headless 仅尝试系统诊断并退出。此报告不授予重装、
删除记录或再次安装权限。手动覆盖必须先区分旧构建、精确目标和超越目标，验证原生终态、
签名、渠道及遗留交接；残留原生请求或变化的目标目录身份仍可能拒绝，不能保证任意新包覆盖可恢复。

一般存储故障的恢复对话框保持以下交互：
“复制诊断信息”仅在用户点击后写入系统剪贴板并继续显示恢复窗口；“重试启动”保留
原始工作目录及启动参数，退出后重新执行完整准入。“退出”及 Escape 只退出当前进程。
原生异步对话框或重启调度失败时仍显示 OS 错误框；显式 headless 调用只记录诊断并以
非零码退出。Windows 不进入 macOS 未决更新的通知、系统日志或强制退出分支。

**current（源码）**：存储选择后的最终启动准入结果绑定实际 Home、当前构建及完整交接
记录。release 与 preview 复用这一安全判定，更新快照只投影通知，不再因交接目标较新
重复阻断已允许的旧版本启动。启动后端前独立复核证据，不依赖快照是否已缓存；记录、
构建、存储或启动上下文变化仍拒绝。只有已安装目标的成功对账可以消费对应记录；
许可前失败及原生证明已恢复的失败保留证据，不恢复安装授权，再次更新仍须重新检查
并授权。已验证失败只授权既有工作台健康确认入口结束相匹配的启动上下文；就绪前
继续保留自定义存储恢复信息，健康确认后仍按完整记录比较再消费，不能删除新事务。
后端启动前的最终证据失效仍走 OS 原生恢复入口，一般后端错误不改为准入错误。
本进程真实在途的安装交接不由启动结果解除。

**required / gap**：上述失败续接须分别完成 macOS release、preview 签名安装版的
失败后启动、正常更新及再次更新验收，还须覆盖 Dock 重入、恢复 App 先启动而 helper 后退出、
持续未决与系统通知被禁用。源版本也须包含重入处理；只更新目标包不能改变旧版在替换前的行为。
确定性状态回归和系统日志宿主探针不替代原生更新生命周期与最终截图证据。

**current（源码）**：新交接记录使用 schema 2。原生 `persistentIdentity(pin)` 从已通过
逐层 no-follow、权限和本地卷准入的目录句柄读取卷 UUID、inode 和创建时间；不将随
挂载/重启可能变化的 `st_dev` 作为持久身份。卷 UUID 缺失、目录身份不可读或任一身份
字段变化仍拒绝交接。运行期 `identity/lineage` 的设备号与 inode 比较不变，不将跨重启
身份用于运行期锁或祖先关系判断。

schema 1 仍按原始设备号与 inode 完整比较，不忽略设备号、不按年龄丢弃、不自动清空
记录。旧记录没有稳定卷身份，设备号已变化时不能仅凭 inode 相同证明目录未被替换；
这类既有故障需要保留现场后另行核验恢复。新协议的跨重启保障要求发起更新的源版本
已包含 schema 2 写入能力；仅升级目标版本不能补回旧记录中缺失的证据。

| 平台 | 持久启动交接 | 运行期目录校验 |
| --- | --- | --- |
| macOS | schema 2 比较卷 UUID、inode、创建时间；schema 1 保持严格旧校验 | 原生 no-follow/权限/本地卷准入及设备号、inode 校验不变 |
| Windows | Velopack 不调用此协议；不导出 Darwin 持久身份接口 | 现有原生目录和更新校验不变 |

**current（源码）**：`src/main/relaunch.ts` 在原生目录写租约和记录锁内判定已有
交接。UID、应用路径、bundle、三个存储根及其原生目录身份必须一致。相同源构建、
目标构建、候选与调试端口的重试复用原字节；重试取消不删除原事务。当前安装构建
已达到旧目标，且新目标严格更新时，可以原子发布下一次交接。旧记录的延迟清理
仍需比较完整字节，不能删除新记录。

取消或终态失败的下一次交接，在同一锁内比较当前记录字节后恢复前次记录原字节，
不提前消费其健康确认；已被消费的记录不重新创建。复用交接的取消保留原记录，
原生终态失败通过显式 `failed` 清理原因消费该事务。发生竞争时拒绝清理或恢复。

**required**：此处只管理启动上下文，不授权候选、原生安装或后台静默；这些检查仍由
`updater.ts` 和 Squirrel 持有。未知源侧事务、不同存储身份和非法记录继续拒绝，
不能按记录年龄推断安装结束。Windows Velopack 不调用本协议。

**required/gap**：文件系统契约覆盖重试、目录替换和延迟清理；正式签名应用的更新、
中断续接、原版本恢复与最终运行截图仍需通过 CI 产物验收，契约测试不证明这些流程。

## macOS 终态恢复只读预检

**current（源码）**：较新构建接管旧启动上下文时，`squirrelstartup.ts` 按当前安装及
绑定候选的规范化助手路径判断 ShipIt 归属，其他应用的同名助手不阻断。保留的原生
请求必须与 bundle、binding、源/目标路径一致，并具备非零错误码及原目录身份绑定的
失败 ack；前后再次检查进程、请求字节与文件身份。完成接管前重新准入，再沿原路径
消费 handoff，日志区分接管与安装成功。不删除原生凭据或用户数据。
当前应用目录替换后，单独验证签名 Team/bundle，并固定新应用及 Contents 身份；旧 ack
仍须匹配冻结旧目标、未变的目标父目录和原 source。普通原版本恢复仍要求旧目标身份。
source 被替换、ack 缺失或旧请求未绑定时继续拒绝；较新构建号不能补足这些证据。
原生日志的持久终态 publication 证明旧恢复已完成，允许同一目标父目录中的独立新请求推进；
不重放旧 source，不跳过新候选签名及安装准入。无 publication 的 legacy journal 仍要求
原目标存活。日志推进后保留的 ack 继续拒绝旧请求，缺失 ack 不构成永久防重放账本。
Windows 不执行该 macOS 分支。确定性/宿主进程检查不替代真实签名应用恢复验收。

**current（内部基础层）**：`retirement.h` 将明确操作、源/目标路径与已归档请求/日志摘要
写入独立、有限容量的 `retired.plist`，先持久保存拒绝记录再清空旧准备日志。后续新事务
不会覆盖此账本，容量满时拒绝而非淘汰历史。旧 source/ack 缺失不要求伪造失败凭据；
候选目录与应用保留。写入前复查准备目录及锁的持有身份，当前日志须与已加载事务一致；
缓存为空也不能掩盖新写入的事务。只读资格、非空 cleanup、变化的日志及不确定写入不能退休。
原生预检也按源/目标应用树及规范别名识别助手，已解析的第三方 ShipIt 不阻断；
旧目录删除导致 `proc_pidpath` 返回 ENOENT 时，改用内核文件映射证明归属：公共区域
迭代器遍历至结束（最多 4096 个区域），须包含原生可执行映射；三次 PID/出生时间/UID
核对之间两次映射快照必须一致。所有映射 vnode 路径都检查书深源/目标树，维护还检查
已准备候选；书深自己的映像即使文件已删除仍阻断。依据是内核路径与 device/inode，
不是进程名、argv、当前替换文件或厂商白名单。Intel 原生 macOS 仅排除普通用户 VM
上限之外、与观察者自身启动时选定地址及属性一致的 4 KiB RX commpage submap；
当前/最大权限必须均为 RX、共享继承且无 vnode，submap 的零对象 ID 不作为身份证据。
arm64 与 Rosetta 不启用此例外。真实内核回归验证已删除第三方映像为 absent、自有
映像为 active、额外普通匿名执行内存为 unknown；Intel 原生运行还必须观察到实际
commpage，arm64 或合成契约通过不替代 Intel 验收。部分/缺失 vnode、其他匿名可执行映射、权限
错误、映射漂移、超界/超时及其他路径错误仍拒绝；该分支不授予精确助手停泊豁免。
不扫描其他应用数据、不停止其进程，也不要求第三方更新完成。

**current（源码）**：独立签名修复 App 的 `--repair-update-mode=retire` 配合
`--repair-update-target=<canonical App>` 接入显式退休：支持缺 source/ack、无 binding 的旧日志/
请求，以及目标父目录已替换。目标必须先安装 CI 新签名包；工具校验目标 Developer ID、
封存 receipt 的 retirement overlay 与实际 helper Mach-O 指纹。工具本身不签名、不替换安装。
数据域与交接记录互斥先于原生资格和任务停泊；只停止 label、规范 helper 路径、参数、
PID/出生时间/UID 全部匹配的 user-domain 任务，system-domain 任务或无法核实的服务/进程拒绝。
停泊前归档原生原字节，消费前持久保存 TS 原字节与原生 proof；先写拒绝账本再推进日志，
保留应用和候选。中断重跑复用原 intent，拒绝新记录或新 inode。缺启动 context 时必须明确
提供三个既有存储根，不猜用户配置。无 binding 的 TS handoff 以原字节哈希标识仅拒绝的
维护操作，不伪造旧安装授权；旧请求原字节已不存在的孤儿接续以归档日志摘要绑定拒绝记录。
私有 ledger 暂存中断可重建。普通 inspect/apply 仍保留原严格前提；正式签名与故障机验收在合并后。

**current（源码）**：`src/main/terminal.ts` 与 `scripts/recovery.ts` 提供阶段 1
只读预检；显式 `build` 仅编译工具，`inspect` 不隐式构建、不写产品记录，也不授予
恢复、启动或安装权限。参数、签名 Team、全部相关 App/ShipIt 正常退出前提及输出边界见
[原生 Owner 的操作说明](../../native/shipit/README.md#read-only-terminal-recovery-preflight)。

**current（源码）**：`restoration.ts` 的显式 `apply --request-id` 在同一 Node 进程持有
原生 Cleanup/Preparation 资格、整组数据维护资格与 context-write 锁；通过原字节和
inode 比对、持久 mutation reservation、不可变 WAL 和 intent 精确消费旧 context/handoff。
中断只前滚同一事务，handoff 最后消费；新记录、Unknown 或释放不确定均拒绝。
原 App/Contents、原生凭据和用户数据不改；原存储选择保留在 intent 和恢复输出中。

**current（源码）**：原生退出观察使用完整内核身份与仅存活映像覆盖，在同一截止内
至多补齐一批新 PID，再独立终检；身份漂移、SIDL、缺证或再次新增仍拒绝，不重试
失败 PID。此为点时观察而非持续启动围栏，执行期间须保持其他 App 实例退出；
详细约束由原生 Owner 持有，名称和父 PID 只作诊断，不作放行依据。

**current（源码）**：旧目录删除导致 `proc_pidpath` 返回 ENOENT 时，改用内核文件映射
证明归属：公共区域迭代器遍历至结束（最多 4096 个区域），须包含原生可执行映射；
三次 PID/出生时间/UID 核对之间两次映射快照必须一致。所有映射 vnode 路径都检查
书深源/目标树；书深自己的映像即使文件已删除仍阻断。依据是内核路径与 device/inode，
不是进程名、argv、当前替换文件或厂商白名单。Intel 原生 macOS 仅排除普通用户 VM
上限之外、与观察者自身启动时选定地址及属性一致的 4 KiB RX commpage submap；
当前/最大权限必须均为 RX、共享继承且无 vnode，submap 的零对象 ID 不作为身份证据。
arm64 与 Rosetta 不启用此例外。真实内核回归用例断言已删除第三方映像为 absent、自有
映像为 active、额外普通匿名执行内存为 unknown；Intel 原生运行还必须观察到实际
commpage，arm64 或合成契约通过不替代 Intel 验收。部分/缺失 vnode、其他匿名可执行映射、权限
错误、映射漂移、超界/超时及其他路径错误仍拒绝；该分支不授予精确助手停泊豁免。
不扫描其他应用数据、不停止其进程，也不要求第三方更新完成。

**current（源码）**：新 preparation 协议在私有 journal 原子提交绑定的终态事实后，
再发送 cache ack；ack 为兼容通知，不是唯一耐久终态权威。旧协议缺 source/ack 不自动迁移，
损坏或未知版本不降级。此协议不替换已安装旧 helper，也不授权孤儿 Native 记录退役；
提交顺序、回收语义和限制见[原生终态 Owner](../../native/shipit/README.md#durable-terminal-publication)。

**current（源码）**：新 helper 在尚未获得安装许可的新请求中，可对严格匹配的 legacy
失败孤儿事务执行原生 supersession：原 source 与完整私有 candidate 目录均须经 no-follow
检查确实缺失，无 ownership/rollback；当前 App 和新 source 独立通过与 helper 同 Team、
指定 bundle 的离线签名验证。双原生锁内复核身份与记录，先原字节归档及拒绝账本再原子退役旧准备
记录，随后仍走正常准备、签名及安装授权。不把当前 App 身份当旧目标已恢复的证明，
不补造 ack、不消费 Desktop 启动记录、不清理历史目录或用户数据。限定形态、拒绝边界及
旧 helper 的部署缺口见[原生 supersession Owner](../../native/shipit/README.md#automatic-legacy-orphan-supersession)。
此源码能力尚须原生运行及正式签名产品的“故障状态→恢复→更新→再次更新”完整验收。

**current（源码）**：新签名 App 的 `--repair-update-target=<canonical App>` 在普通启动
准入前进入独立修复模式，不先覆盖旧安装，不启动后端、不发布默认 profile。
`repair.ts` 按明确目标读取原启动上下文；`restoration.ts` 复用维护组、context-write、
不可变 intent、WAL 和 mutation reservation。随包 macOS `repair.node` 在同进程持有
现有 Cleanup/Preparation 锁，观察真实进程退出、原数据目录身份及无安装许可的 native
请求。该独立 orphan 协议允许尚未收到 downloaded 事件、因而没有 nativeRequest 的
requested/failed 交接，不放宽既有 terminal 观察。

持久 intent 与 mutation reservation 后，先原生归档并退役孤儿记录及精确未授权请求，
再消费旧 context、最后消费 handoff；原生拒绝不会先清掉原 context。

Cleanup maintenance 仅观察：不创建缺失锁，所有现有锁都须为私有权限，冻结打开时
journal 基线，Cleanup 写接口一律 EROFS。`SSCleanupMaintenanceSnapshot` 返回 Cleanup
而非 Preparation 快照；普通只读与可写会话不能交叉使用快照入口。缺失 journal 是
可重复比较的成功观察，不遗留 ENOENT NSError。重读的 Preparation 当前与归档 plist
须先核根和 record 类型，损坏内容拒绝而非原生异常，也不修改证据。

独立 CLI 仅支持 terminal 恢复，orphan 及其 intent 只能由签名 App 入口执行。探针
限额/schema 由 terminal 协议统一持有，存储身份版本与 intent 版本分离。存储准入前
修复开始、完成和失败仅写系统日志，记录是否显式选择及成功请求/构建，不写私有路径
或提前打开 profile 写产品日志。`compilation.cjs` 统一持有修复编译框架、参数和支持
单元，并进入模块/恢复工具源码指纹。原生拒绝回归直接覆盖 maintenance、损坏记录及
succession/parking；parking 测试的 SMJobRemove 为测试内计数替身，要求拒绝前零调用。
这不证明真实签名放行和 launchd 移除成功，两条正向路径仍须合并后的正式签名产品验收。

顺序为消费旧 context、原生归档并退役孤儿记录及精确未授权请求、最后消费 handoff。
运行时显式注入原生能力；工具发现、编译及独立探针调用留在 `scripts/recovery.ts`，不随产品打包。
中断只从本安装唯一未完成的有效 intent 前滚；空 journal/缺失请求须有完全匹配的私有
原字节归档，不按时间挑最新记录，不接受同字节新 inode、外来 scope 或新事务。
提交后、重启前中断时，仅 context、handoff 和 native 请求均仍缺失才允许已提交 intent
接续启动；仍须原生归档、签名和真实进程退出资格，无歧义选择不因已提交而放宽。
修复后经签名源 App 的 executable 和原 Home/userData/workspace/CDP 上下文重开旧版，
再由旧版正常更新；不回放旧授权、不清 rollback、不迁移配置或凭据。该入口不杀进程，
需要目标 App 和自有运行时先正常退出；ad-hoc、开发模式及 Windows 拒绝。
正式签名修复包、原故障机器的更新成功及再次更新仍须独立验收，不能用原生/事务 fixture
代替。命令及完整约束见[独立修复 Owner](../../native/shipit/README.md#independent-signed-repair-entry)。

**current（源码）**：旧客户端超时后可能已消费 context、仅保留 failed handoff 和未授权
native 请求。此时入口必须显式给出既有 Home/userData/workspace，不猜默认值；以新授权
目录及其当前原生持久身份建立 schema-2 `mac-orphan-selection-recovery` intent，
`context: null`，持续验证旧 context 仍缺失。不得补造或消费虚构 context；新 context、
冲突显式路径及未知身份均拒绝。未完成 intent 保存所选目录，后续同目标修复从该 intent
接续，不按时间挑选。路径须核验为用户原选择，缺失记录本身不证明原选择。

**current（源码）**：旧 helper 可在退出 App 后仍每两秒由 launchd 拉起。修复在两把
原生锁内核对 user-domain 任务的 label、三个参数、安装内 canonical helper、未授权
绑定请求及无 rollback 所有权，并验证修复宿主/源/候选签名。停任务前仅可豁免该已核验
任务的精确用户 PID/启动身份和 executable，不能豁免目标进程或外来 helper；移除后
必须由无豁免的普通观察证明退出。不按进程名杀进程，不操作 system-domain、不删
launch-agent、不提权兜底。旧 updater 正常重提任务；仅已释放锁的短暂竞争在事务前
有界重新取证，签名、绑定和 uncertain release 不重试。

**required / gap**：预检摘要不是执行权限；真实签名产品的恢复、正常重开及再次更新仍须
独立验收，不能由 fixture 或 Native 契约代替。Windows 不执行恢复入口；不改选已指定目标。

**current（源码）**：macOS 正常更新采用两阶段：归档/来源信任检查、原生准备和绑定
downloaded 回执先完成，随后才冻结偏好、请求 Serve 维护并保存启动上下文。准备阶段
工作台不被遮罩；维护或授权失败且释放结果确定时恢复写者，仅复用同一候选与归档的
已就绪原生请求。后端干净退出后再次获取在线授权，紧邻 native quit-and-install 同步
复核授权及绑定。此时瞬态网络失败允许重试原请求，不重跑准备、不回放旧授权。
下载、只读校验和最终授权的临时网络/文件竞争最多尝试三次，取消中断退避；
签名、绑定和确定事务冲突不按瞬态重试。

`rescue.ts` 持有原生文件选择与确认交互。产品修复动作只选择独立官方签名 App，
要求密封的 `update_repair_protocol: 1`、分发 lane 和原 Team/bundle。旧客户端停工前先验
签名/能力，再在原生锁下执行无修改权的 `orphan-plan`；允许源进程仍运行，但不同
proof kind、无 repair 方法，不能作为执行权限。退出后独立 worker 重新取得完整资格。
较新的独立 App 不能消费其他安装或无 nativeRequest 绑定的 handoff；准入拒绝时提供
原生修复向导，显式 `--repair-update` 也可进入。向导要求目标与三个原有目录，不先
发布默认 profile、不启动后端。占用只允许最多三次显式重检，部分修改、释放不确定、
签名或绑定失败停止；恢复后重开旧版正常更新，不能把“恢复更新能力”说成“更新成功”。

界面区分非阻塞准备、保存/退出和交接，交接后不再显示假取消按钮；源应用未退出不报
“正在重启”。与启动 context 绑定的新构建报告“正在启动新版”，仅真实后端/主工作台
健康确认后报告“更新已完成并验证”。Windows 仍归 Velopack，拒绝 macOS 修复入口，
仅将源侧最终显示改为交接而非提前重启。
**required / gap**：合并后仍须正式签名 macOS 原故障恢复、正常更新、再次更新及真实截图，
Windows 原生产品验收独立进行；本地编译和契约测试不是这两类产品准出。

## 更新候选授权冲突恢复

**current（源码）**：安装授权 409 以 `activation_candidate_changed` 传递；updater 在候选状态目录
先原子保存带代次的 `rejected.json`，再撤销对应 ready、准备检查点和归档。清理失败不取消拒绝记录。
main 在维护恢复和安装锁释放后重置准备队列、作废旧检查代次，并展示无候选的“检查更新”动作。
普通网络失败与用户取消仍保留原重试语义；维护恢复不确定时继续阻止安装。

冷启动只把磁盘包当作可复用字节，线上检查及准备完成前不恢复 ready。重新检查若仍返回被拒绝的
候选，必须取得并验证一次新授权，且拒绝记录代次未变，才能清除此记录。该授权不缓存为安装许可，
最终交接仍取得新授权。选择这一策略是为了允许服务端恢复同一候选，同时避免仅靠发布查询结果撤销
安装拒绝；不采用永久拉黑、直接重试旧包或关闭在线授权。

**required/gap**：macOS Squirrel 与 Windows Velopack 共用候选恢复语义；磁盘及状态机契约测试
不替代两平台正式签名包的授权冲突、退出重开和成功升级验收。签名、公证、原生交接和运行时退出边界不变。

## 启动控制通道与 TeX 缓存

**current**: Startup exit diagnostics join the child `close` pipe barrier before
classification, because `exit` can precede the final stderr exception line. This
barrier does not await preparation cleanup, which may itself await startup ready.

**current（源码）**：启动退出后的诊断分类等待子进程 `close` 管道屏障；`exit` 可能
早于 stderr 最后的异常行。该屏障不等待准备任务清理，避免与其等待 ready 形成环。

**current**: Failure of private-channel authentication before a preparation probe
starts is a startup failure, not evidence of an undrained probe. Shutdown still
joins every started preparation, backend process family, owned pipe/log writer
and agent transport. Actual probe cleanup uncertainty blocks shutdown; a drained
nonzero backend exit remains `FailedExit` and cannot authorize update handoff.

**current（源码）**：准备探针尚未启动时，私有通道认证失败属于启动失败，不表示
探针资源尚未排空。退出仍等待所有已启动的准备任务、后端进程族、自有管道/日志
writer 和 agent transport。实际探针清理不确定仍阻止退出；已排空的非零后端退出
保留 `FailedExit`，不能授权更新交接。

**current（源码）**：启动期的工具链通知等待私有通道认证，由后端 health 启动预算、
进程退出和停止路径管理等待寿命。不能在子进程仍合法初始化时套用维护请求的连接
截止时间。health 成功后尚未连接的通道进入普通连接期限；认证后的操作响应仍有
独立期限，错误凭据和不确定回执继续失败关闭。

TeX 可写缓存与存储概览共用 `backend.runtimeStoreRoot()`：Windows 安装版位于
安装根 `runtime/cache/texlive/<version>`，位于签名组件 `<kind>/<version>` 之外；
macOS 与开发模式保留产品 home 下的 runtime 根。缓存写入仍由目录 writer 准入，
不修改已有 ACL，不迁移旧 home/runtime，不把缓存纳入组件签名库存。
版本来自 Windows 安装组件清单或随程序冻结的工具链清单；完整 SHA-256 指纹保存在
`identity.json`，覆盖版本、归档摘要、实际工具链路径、平台和有效字体配置。
配置和字体文件匹配时复用版本目录。
macOS 应用更新或 AppTranslocation 路径变化使配置失效时，在版本根取得现有数据域
独占维护资格后重建派生缓存；不删除版本根本身，保留其目录身份。运行实例的祖先域、
子域或持久 family 占用阻止重建。删除前检查全部内容，未知根成员、符号链接、硬链接
及特殊文件均拒绝；旧路径哈希子目录同属派生缓存，可在独占期间回收。中断后下次启动
重新检查并重建。配置没有变化时不清空缓存。
Windows 使用同一数据域独占维护，在固定版本根下以相对句柄预检并保留所有子项句柄，
拒绝重解析点、硬链接、只读项和占用项，全部通过后才删除派生内容。版本根保持原有
身份。若旧发布留下两个名称，Windows 只移除能够通过句柄证明与正式文件同一对象、
且恰好有两个链接的暂存名，再进入清理预检。新发布用同目录原生无覆盖重命名。
清理或发布中断后，下次启动重新校验，配置不完整时重新进入维护。
Windows 安装态在重建后由 Desktop 重新取得共享缓存版本域并复核配置，持有至后端
Job 排空。Serve 启动时独立持有同一缓存域，项目和用户存储重新取得资格时继续保留，
关闭时在 HTTP 与资源排空之后释放。
开发态和 macOS 由 Serve 的长期祖先域保护。两端在后端健康就绪后、开放 TeX 执行前
再次只读核验身份和字体配置，交接期间发生变化则保持不可用并记录。
Windows 更新成功后的原生 after-update
钩子统一回收当前安装的 `runtime/cache/texlive`，不判断哈希、版本或内容；下次启动
由同一初始化入口重建。回收先独占固定根并移入 `texlive.retired`，全树通过句柄预检
才删除；占用、链接、超预算及失败保留并记录，更新不阻断。中断不留下半份活动缓存，
残余在下次更新重试。工具链、下载归档及 macOS 行为不变，详见
[更新回收契约](../../updater/README.md#windows-velopack)。
安装器预算包含初始化创建的目录、身份文件、字体配置及原子发布临时文件；这不
构成任意 TeX 文档生成文件名的长度上界，会话工具缓存仍沿下面的独立沙箱边界。

TeX 资源解析的开始、成功、取消及异常，环境准备成功/异常，以及最终回执的
resourcesReady/environmentReady 分项结果写入现有持久生命周期日志 `window.log`，
同时保留 console/IPC 输出。失败仍关闭执行准入，不自动删除缓存或忽略身份校验。

**required**：覆盖慢启动晚于普通连接期限、启动失败/退出清理、维护连接及响应
期限、旧缓存保留和安装缓存路径。**gap**：契约测试不能代替 Windows 安装版
冷启动、更新及 MCP 页面截图验收。

**current（缓存范围）**：产品 `runtime/cache` 的当前写入方只有 TeX 初始化，
其 `fontconfig`、`texmf-var`、`texmf-config` 和 `fonts.conf` 全部位于同一个
`texlive/<version>` 根。Serve 的 `TEXLIVE_CACHE_DIR` 是旧形状
的路径声明，当前没有读写消费者；不能把该声明视为安装版的缓存解析入口。
Codex 开发制品缓存由 `runtime/codex.cjs` 管理，安装版不调用开发解析器；
下载归档缓存由 `scripts/shared/artifacts.cjs` 管理，两者均不依赖旧产品 runtime/cache。
Serve 工具执行的 TeX 缓存位于获准会话工作目录 `.tool-cache/texlive`，为维持沙箱
写入边界继续随会话隔离，不提升为共享安装目录写入。


## 开发运行的源码身份

开发版 main 在启动后端前由 `source.ts` 从实际程序源码目录采集仓库 URL、分支、完整 commit、tracked/untracked 改动状态及启动时间。URL 去除认证信息；采集失败记录 unavailable，不复用上次启动记录。它独立于用户会话的 cwd，保持会话目录和权限语义不变。

`backend.ts` 记录启动日志，并将冻结记录经 `SCHOLARSEED_SOURCE_BASELINE` 注入本次 Serve。诊断导出在 ZIP 预算内优先写入 `feedback/source-baseline.json`，不需要对话记录授权；不选诊断日志则不导出。后端不可用时，main 的本地诊断打包使用同一启动记录。安装版清空该开发记录，继续使用安装包构建身份。记录的是启动时 Git 状态，不能证明未提交文件已归档，也不保证启动后源码未变化。
