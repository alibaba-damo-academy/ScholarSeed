# 预览场景的后端契约与适配边界

## Scope / Non-goals

本页说明当前 Desktop 预览对真实服务契约的消费范围与差异，供产品、设计师、前端和后端
按同一场景协作。预览沿用真实 renderer、HTTP URL、DTO 和事件投影；不要求后端新增
“场景服务”或复制一套业务接口。`/__preview/*` 仅属于本机开发预览，不是 Serve 产品协议。

**模拟服务支持不等于真实功能验收。** 本页不承诺全部页面已接入，也不将仅改变布局、
文案或组件的 UI 需求笼统列为“待后端适配”。没有新业务语义或数据需求时，无需新增后端
契约；仍须分别核对模拟场景与真实服务/Electron 的视觉、交互和副作用证据。

## 文献库存切片

**current**：`page-literature` 保留旧空库存，新增非空、读取等待/失败、详情等待/失败、
元数据保存等待/首次失败场景。实例级账本统一列表、计数、分类、标签、项目、详情和笔记；
重载保留当前实例，重置还原种子，销毁及取消不提交旧写入。生产页面无 mock 分支。

沿原客户端支持文献列表/计数/facets/tag-facets/projects/collections/tags 的 GET、
详情 GET/PATCH、笔记 GET/POST/PATCH/DELETE。笔记更新核对 version；元数据不虚构 CAS。
列表仅支持真实 HTTP 声明的文本、分类子树、标签交集、项目、without/recent、排序和分页；
不将 TypeScript 中未被真实接口声明的年份、类型、附件、未读过滤伪装为可用功能。
未读摘要沿现有契约，缺失附件记录仍计入已登记全文；无全文仅表示没有附件记录。
模拟写入的严格校验不代表真实后端所有宽松 JSON 行为已完全复刻。

可用 PDF 复用受审示例工程的真实字节、文件身份和 revision，不再创建一份假附件文件。
文献 attachment 与 project asset 的记录归属分开；附件 open/content/records/regions 走
原消费者，content 支持 GET/HEAD、单段 Range 与 ETag。PDF 只读，不宣称批注写入；
区域分析明确不可用。AI results GET 返回未生成的空缓存；AI state GET 复用同一
文献/附件与 VFS 字节核对 revision，返回附件身份、空结果和 null task，旧 revision
明确拒绝。只读状态不生成任务，不代表 AI 执行成功；其 Mock 负向错误映射不证明
真实 Serve 所有准备失败码均已复刻。

**gap**：附件原生 location、分类/标签实体管理、文献导入下载、附件及记录变更、AI 执行
仍明确拒绝为未接入（501）；缺失全文为 404，不映射用户本地路径或扩大授权根。
这些 mock 合同与 UI 验证不能替代真实 Serve、模型、原生平台或 Windows 验收。

## 回答注释引用移除

回答注释的上下文移除沿用 `DELETE /api/assistant/sessions/{id}/annotations/{annotation}/context`
及 `expected_context_revision`，只移除当前实例、同会话的 note 引用，保留原注释。
实际移除逐次递增修订，陈旧修订返回409及latest；无匹配引用幂等返回当前选择，
未知会话404、非法修订422。Mock不模拟claim生命周期，不开放注释永久删除或其他
未声明注释变更；真实存储、安全与并发语义由Serve Owner验证。

## 归档项目错误与显式恢复

**current（目标整合）**：任务归档沿目标复用 `ArchivedConversation → AiPanel → Stream / Composer`，
与普通会话共用 history、来源及活动投影；模拟端继续提供同一会话 DTO，不另建只读页面。
当前归档会话 thread 的 readOnly 禁止发送、停止、审批及 live/SSE 恢复，恢复后再沿原正常
会话入口访问。空历史是真正 `turns:[]`，不恢复目标已删除的空态文案或旧独立历史组件。

普通独立模拟会话没有显示子会话，`GET /api/serve/sessions/{id}/display-children`
返回同一 `session_id` 与 `child_count: 0`，供共享删除确认区完成只读准入检查。
未知会话返回404，非GET仍拒绝501；不代表fork或真实服务子会话级联已模拟。

项目布局场景仅切换原 Workspace 菜单及 `RendererPreferences.projectLayouts`，
正常左右换位保留同一组件与文档标签，重载只承诺偏好布局，不承诺草稿持久化。
数据与样式仍由原页面消费；预览不实现第二套归档或布局 renderer。

**当前切片已接入，整体仍未收口**：原 `GET /api/content/projects?includeArchived=true` 的失败与成功空列表
分别显示；活动项目目录与归档任务读取不因独立项目故障政策改变。单恢复沿原 archive
POST，在恢复及归档/活动目录刷新完毕前保持 busy，旧读取不覆盖新结果。不新增真实
Serve 协议或在生产页面判断预览模式。

预览专用 `POST /__preview/archives/recover` 仅解除当前实例显式 `projectRead: failed`
的模拟项目读取故障；重复恢复幂等，不变更项目/偏好/任务/历史，其他政策返回 409。
reset 新建 Owner 后重新故障，实例之间隔离。恢复不按请求或重试次数自动发生：任务页
也会读取同一项目目录，不能用辅助 GET 消耗计数来伪装项目页面恢复。
F8 从设置弹层打开原预览控制台，明确触发恢复后关闭控制台，再用原项目页重试；
不直接修改 Store，不关闭重建设置页来冒充原重试。此控制端点不进入生产制品。

Web 消费已验证持续失败、加载、显式解除故障后原页重试和延迟恢复期间禁用动作；真实
macOS Electron 已验证隔离项目归档、恢复及重载持久，最终构建只读重入通过。真实后端
503 与长延迟尚未运行，不用模拟成绩替代。当前验收优先 macOS，Windows 保留未验证。

## 浏览器设置切片

**current**：独立预览宿主直接复用原 `BrowserSettings`，不复制表单、不启用生产浏览器
开关。`BrowserBridge.policy/history/clearData` 在预览边界使用同源 POST
`/__preview/browser/{policy,history,data}`；请求与回执仍为 `src/browser.ts` 的原合同。
这些路径不是新的 Serve API，真实 Electron 继续走 main/preload，后端无需另造设置页。

实例 Owner 支持规则读取、增改移除、Agent 开关，精确 origin 和 action/decision 沿原
parser；未改变时不递增 revision，双 ask 移除规则，不新增客户端 CAS。模拟权限不会
产生任何网页或工具执行授权。sample 的关闭状态及示例来源只是场景种子，不是 Desktop
首次配置默认值。历史具有每 Owner 独立 UUID，搜索后计数、按时间及 ID 倒序分页，
删除未知合法 ID 返回 `deleted:false`。旧实例或重置前 ID 不能删除新账本的样本。

历史清理支持 `clear-history` 的包含边界 since 及 `clear-selected` 仅 history；同域
读取、删除、清理遵守互斥，提交点重新核对取消和生命周期。无效 payload 返回原
`invalid_command` 失败回执，未知路由不伪成功。重载保留同实例，reset/dispose 销毁旧
Owner 和等待，不能让旧写提交到新代。策略读取故障与历史读取/写入政策相互独立。

持续策略读取失败可以通过预览控制台的显式恢复动作解除，再由原页面按钮重读；
`POST /__preview/browser/recover` 只解除本实例的 failed 读取政策，重复调用幂等，
不改变规则、历史、偏好或原生权限，其他政策返回 409，reset 后重新失败。开发模式的
重复挂载会重复读取，不能用请求计数冒充“首次错误后重试”；归档与浏览器恢复控制按
同一声明式入口登记，不直接填 Store。策略写入 IO 失败时，原页面按既有安全策略隐藏
不可确认的规则；先用原重新读取恢复未变库存和输入，再次提交，不放宽生产失败关闭语义。

**gap**：原生网页重新打开、CDP、下载选择和配置、Vault、Cookie/缓存/站点数据清理
均保持不可用；没有模拟原生成功。当前 Web 规则/历史操作不等于真实磁盘、安全授权或
原生清理验收。macOS 只读验证原页面及自然读取，未写真实规则、删除或清理历史；
Windows 未验证。浏览器主页面及 viewer 的共享控件接入另行完成。

本切片最终 Web UI 全量 135/135 与 macOS 真实只读流程分别取证；前者仅证明模拟合同
被原页面消费，后者不证明真实规则写入、清历史、安全授权或完整浏览器运行。独立 Web
设置宿主与生产设置模态的可用宽度不同，不能将其画面当作宿主布局完全一致的证据。

## 浏览器共享引导与模拟快照

**current（契约，不是本轮产品验收）**：`page-browser` 与 `viewer-browser` 使用同一原 `Browser` 组件，
仅预览宿主增加模拟范围说明。预览不改 `browserEnabled`、生产导航、组件或注册策略；
不是给生产增加打开浏览器的入口，也不是另一套浏览器页面。
产品[浏览器契约](../browser.md)已移除内层网页标签栏和新建网页按钮，空白目标与无目标
均显示原引导；场景目录不恢复旧控件。没有 UI 入口的账本写等待/失败只保留领域契约，
不作为 UI 场景。空白快照、已有目标、读取等待/失败及通用未映射状态仍分别保留。

同一浏览器 Owner 可选 `surface` 政策；未配置时 snapshot/dispatch 仍返回原生不可用，
不影响前批设置场景。`/__preview/browser/snapshot` 和 `/command` 采用同源 POST，沿
原 `BrowserSnapshot`、`BrowserReply`、`BrowserCommand` 与 parser；snapshot 的 HTTP
请求体只接受空对象。只模拟新建空白、选择、关闭，ID 每 Owner 独立；关闭当前标签按
真实语义选择剩余首项，最后一项关闭后 active 为 null。快照不虚构 engine、自动化、
网页历史或原生目标，预览最多 100 个空白标签的保护上限不等于真实产品配额。

外部地址或搜索、navigate（包括已有标签导航到 blank）、后退/前进、reload、bounds、
devtools、automation 和复制端点均拒绝，不改变任何账本；并发写入互斥，取消或销毁
不能在 await 后提交。提交前对象拷贝，不能修改在途请求来改变最终动作。原组件的读取
等待阶段保留默认起始页，不补造并不存在的 Spinner；账本写协议不代表产品有新建按钮。
host 不提供 page/frames、菜单或原生浮层 bridge，空白标签没有原生 viewport。

仅已登记的浏览器 POST 允许解析合法 JSON 后交原 typed parser；数组等非法对象返回
`invalid_command`，非法 JSON 仍 HTTP 400，其他 API 的严格对象校验不变。body 读取后
及 Owner 回执后都复核实例代次；旧分块请求 reset 后补完 body 返回 409，不能写新账本。

领域用例承担快照与身份、拒绝、等待、互斥、取消及恢复边界；共享 Browser render
承担当前控件、引导、语言主题及在途地址编辑；原生 Mock 双入口只核共享 UI 接线、
导航拒绝与重载，不将旧十二项内层标签操作机械搬到 Electron。原 loading/error
要求仍保留，不由空白引导或底层契约自动补齐，也不以用例存在声称运行通过。

**gap**：生产入口受浏览器开关与运行面控制，现有“新标签页”入口归浏览器 Owner；
Mock 宿主不会开启该开关，本页不继承旧 Web 消费或其他版本的宿主验收。不得写 saved
navigation、插入历史、内部 dispatch 或放宽生产策略来制造起始页验收。真实设置只读证据不替代
Browser 起始页；原生内容、框架、CDP、真实导航以及 Windows 仍需适用环境和单独验收。

## 会话产物与模拟发布

**current / 产物切片已消费，不代表全状态验收**：`viewer-outputs` 保留原通用要求与空态，
另有两组已发布会话、目录/历史/内容的等待及持续失败与完成后发布场景。原 `Outputs`
仍从项目会话目录及逐会话历史筛选显式 publication，不接页面私有展示数组。

`PreviewArtifacts` 只持有从当前实例受审文件捕获的不可变字节与身份绑定；Session 历史
持有公开的 `SessionArtifact` 投影。同一 session/turn/file identity 幂等，同 Owner 之间
身份独立；源文件改名、修改或发布后的资源编辑不改变已发布快照。`publication_id`、
role、size、sha256、media_type 来自受审源与明确模拟发布，不能把任意工作文件计为产物。
三个阶段均有样本，但不代表真实模型生成或真实 publication 授权执行成功。

沿现有 `GET /api/serve/sessions`、`GET /api/serve/history/{session}` 和会话 open 快照
返回同一产物投影；`artifact_changed` 用原 `op:upsert` 合同，并在成功终态之前发布。
模拟长回合可以从原 Composer 停止；取消/失败不发布，源缺失预读失败转明确失败事件，
不产生部分成功交付。未配置产物政策的旧场景保留原不可用 capability 和空投影。

`message_delta.data.delta` 是同一 turn/item 的累计正文快照，不是待追加的文本片段。
模拟服务从同一历史正文发布累计值；实时消费采用原替换投影，断流重放和重新进入不把
多份快照相加。消费回归逐段调用真实投影，并核对恢复后最后快照与历史正文一致。

原 `GET/HEAD /api/serve/sessions/{session}/artifacts/{artifact}/raw` 返回 snapshot 字节、
ETag、长度与明确只读 header；`GET .../content` 沿原文本 DTO 的 binary/truncated 边界。
严格核对 session 与本实例 artifact 身份；原始 path 参数不能换源。PUT 编辑、真实导入、
另存、原生打开及发布 bridge 仍未接入，不返回假成功；后端无需为本切片另写一套页面。

读取故障通过政策分开作用于项目目录（`scope=project`）、历史、内容；全局启动目录不受
产物项目政策影响，不能在到达原产物页之前把全局恢复挡住。持续失败不按请求计数消失。
`POST /__preview/artifacts/recover` 只解除当前实例已声明的持续读取失败，重复恢复幂等；
其他政策返回 409。reset 还原故障并替换身份。异步回执后复核实例代次，取消/销毁不将
旧回执写入新代；恢复控制不修改历史、文件或 publication。当前仅安排 macOS 验收，
Windows 与真实生成/失败/恢复交付仍未验证。

新会话仍沿原 context PATCH 保存空 refs 的 project_policy 与 disabled/academic/web
选择元数据，保留 revision 与冲突的 latest 回执；保存检索选择不执行检索，能力标志仍
为不可用，不调用真实服务。非空上下文引用仍明确拒绝，不能把这一子集当完整上下文模拟。

## Source of truth

- 模拟实现与消费断言：[场景服务](../../preview/service.ts)、[服务测试](../../preview/service.test.ts)、
  [文件树](../../preview/files.ts)、[文件测试](../../preview/files.test.ts)。
- 文献库存与笔记账本：[文献模拟](../../preview/literature.ts)、[文献回归](../../preview/literature.test.ts)、[原生共享页面消费](../../preview/native.spec.mjs)。
- 项目操作的单一内存 Owner：[项目模拟](../../preview/project.ts)；
- 浏览器设置模拟：[规则与历史账本](../../preview/browser.ts)、[领域回归](../../preview/browser.test.ts)、[原生页面消费](../../preview/native.spec.mjs)。
- 浏览器共享引导：[组件回归](../../src/renderer/src/features/browser/browser.render.test.ts)、[原生 Mock 接线](../../preview/native.spec.mjs)、[独立预览宿主](../../preview/host.tsx)；账本写协议归上述领域回归，不是 UI 操作。
- 会话产物：[纯场景契约](../../preview/publications.ts)、[不可变快照](../../preview/artifacts.ts)、[领域回归](../../preview/artifacts.test.ts)、[原生产物页及完成后发布消费](../../preview/native.spec.mjs)。真实读取合同见 [Serve 会话 API](../../../serve/service/chat/api/sessions.py)。
  诊断记录边界：[诊断模块](../../preview/diagnostics.ts)。
- 文档读取时序：[内容政策](../../preview/content.ts)；PDF 不可用区域清单：
  [区域响应](../../preview/regions.ts)；真实操作消费者：[文档场景测试](../../preview/native.spec.mjs)。
- 页面与场景状态：[机器目录](../../preview/catalog.ts)。目录登记、`pending`、`unverified`
  均不代表已经可操作或验收通过；不在本页复制页面覆盖清单。
- renderer 消费：[会话与事件 DTO](../../src/renderer/src/api.ts)、
  [内容客户端](../../src/renderer/src/app/api/content.ts)、
  [工作区文档客户端](../../src/renderer/src/features/workbench/api.ts)、
  [资源客户端](../../src/renderer/src/features/resources/api.ts)。
- 真实后端：[会话路由](../../../serve/service/chat/api/sessions.py)、
  [会话交互服务](../../../serve/service/chat/service/sessions.py)、
  [项目与文件事件](../../../serve/service/content/api/routes.py)、
  [工作区读取与提交](../../../serve/service/workbench/api/routes.py)、
  [资源路由](../../../serve/service/resources/api/routes.py)。
- 技能目录与变更：[真实能力路由](../../../serve/service/capabilities/api/routes.py)，
  renderer 通过同一[公开客户端](../../src/renderer/src/api.ts)消费。
- 环境与准入：[预览架构](../architecture/preview.md)、[测试规范](../quality/testing.md)。

## Current / Required / Gap / Advisory

以下 **current** 指当前源码已实现的模拟响应，不是实际产品或跨平台验收结论。

- **required**：模拟端与真实端遵循同一消费契约，变更同步场景、字段说明和消费测试。
- **gap**：全页面、真实副作用与最终跨环境证据尚未齐备，具体差异逐域保留。
- **advisory**：优先补齐实际 UI 消费路径，避免为演示新增后端专用协议或页面分支。

通用 JSON/工作区字节请求体读取后，预览服务再次核对实例身份；读取期间实例已被
reset、移除或销毁时，旧请求返回 `409 {detail: "preview_instance_reset"}`，不向旧
会话重新提交回合或注册定时器。这是预览实例生命周期围栏，不是新增真实 Serve 协议。

| 领域 | 沿用的接口、DTO 与状态转换 | current：模拟端范围 | gap / 限制及适配归属 |
| --- | --- | --- | --- |
| 启动与会话目录 | `GET /api/healthz`、`GET /api/serve/sessions`、`POST /api/serve/sessions/open`；`HealthResp`、`ServeSession`、`OpenResp` | 内存项目/会话身份、目录筛选、恢复同一会话与运行快照 | readiness/capabilities 是模拟声明；不证明真实 Runtime、鉴权或恢复能力。后端已有接口，无需为预览另增接口 |
| 对话与工具 | `POST .../turns`、`GET .../events?from_seq=`、`GET /api/serve/history/{id}`；`TurnResponse`、`HistoryResult`、`ProductEvent` | 文本提交、思考、消息增量、模拟工具开始/输出/完成及失败；`running → completed/failed`；interrupt/terminate 转为 `interrupted` | 不执行模型或工具；附件、多模态、真实命令输出及完整队列调度未覆盖。新增业务事件必须由原契约 Owner 定义，而非由预览自造 UI 事件 |
| 审批与提交回执 | `POST .../hil/{request_id}`、`GET .../queue`、`POST .../queue/{id}/reconcile`；`ProductHilData`、`ProductInteraction`、`QueuedMessageReconcileResponse` | `hil_requested → waiting → hil_resolved → running/interrupted`；允许、拒绝、取消；直接提交回执包含 `accepted:true/disposition:direct/turn_id`，终态按真实协议发同一提交身份的 `message_removed`，reconcile 按 ledger 返回 applied/not_applied | 回执与 outbox 生命周期已有聚焦断言，最终全场景 UI 证据仍需收口；queue 当前返回空消息，不代表真实排队、编辑、删除及发送已模拟。真实后端已有交互/队列路由，不是待新增后端功能 |
| 项目与目录操作 | `/api/content/projects`、`/api/content/operations/{id}`；项目身份与准备完成后可用的语义 | 模拟创建返回 `202 {operation,state:"queued"}`，由有界定时任务推进 queued/running/终态，renderer 复用真实轮询客户端；成功才登记项目与独立空 VFS，示例种子项目仍保留样本。支持虚拟目录预览与名称/描述 PATCH；声明式 fail-once 场景支持失败后重试 | 未执行宿主目录创建、授权或迁移；归档/删除等未完整模拟。reset/dispose 清理待执行任务；真实后端已有生命周期，无需为预览退化为同步返回 |
| 文件与 viewer | `/api/resource/tree/list/count/read/raw/write/node/reveal`、`GET /api/workbench/open`、`GET/PUT /api/workbench/content`；`OpenDocumentResult`、`DocumentCapabilities`、ETag/revision | 九项受审字节样本，格式映射见下文；原字节读取、文本修改、文件重命名；项目树与 PDF records 读取绑定同一文件事实源，文档投影按能力声明支持的真实 viewer | PDF 当前只读、不宣称批注写入；XLS 字体供给、完整版本/审查、导入导出、目录创建及文件删除路由未完整接入。VFS 方法存在不等于 HTTP/UI 全链路支持 |
| 文件变化 | `GET /api/content/cursor`、`GET /api/content/events`；`epoch/seq/project_id/root/kind/path/previous_path` | 内存修改发布 created/modified/moved 事件，同实例订阅与重放 | 不证明真实文件监听、外部改盘、完整分页、进程重启持久化；游标与重置的一致性须独立测试 |
| 设置与上下文 | `/api/serve/settings/{key}`、`/api/serve/models`、`/api/assistant/sessions/{id}/context`；偏好与 revision | permission-mode/workflow/auto-review 内存设置、固定模拟模型、空 refs 的有限上下文选择；预览桥保存隔离 UX 偏好 | 不模拟真实连接创建、密钥验证、订阅登录、MCP/技能执行；有新字段才交对应 Owner 扩展契约，普通样式调整无需后端适配 |
| 技能设置 | `GET /api/capabilities/skills`、`GET .../{name}/document`、`POST/DELETE .../{name}/activate`、`DELETE .../{name}`；目录、文档、启用与删除回执 | 三个隔离技能记录展示用户技能、不可禁用内置技能、缺依赖技能；正常变更与未知名称/不可变更错误沿同一内存目录更新 | 不执行技能；上传、新建与 GitHub 导入明确 `501`，不伪造安装成功；仅契约回归不证明真实技能生命周期或设置 UI 已全部验收 |
| 文献与账号 | `/api/v1/literatures` 的列表/计数/facets，collections/tags，`/api/auth/status/me` | 文献空集合；默认场景无账号凭据，显式账号场景见下文只读 profile 合同 | 非空文献、附件、同步、积分与真实登录未覆盖；独立搜索结果场景不证明真实检索。空响应只证明初态，原生登录与账号安全仍走真实产品路径 |

### 会话执行与传输政策

目录通过 `simulation.conversation` 分开声明执行模式、流式样本及一次传输断线，
不是按问题正文、文件名或目录 ID 在服务核心增加特殊分支。普通 streaming 仍使用原三段
25ms 样本；取消场景显式采用十二段、每秒一段的交互样本，不改变生产模型或客户端速度。
**current（模拟会话政策）**：同一 Session 持有历史、快照、事件、在途提交预约与定时器。
`conversation-submit-pending` 接纳前等待两秒，不分配 turn 或追加用户历史；同期重复请求
返回 409。reset、销毁、删除、interrupt/terminate 或 HTTP 断连撤销预约，未断开的旧请求
返回 `410 {code:"preview_submission_cancelled"}`；延迟后再次核对实例、会话和连接，
不在另一实例或下一回合写入。该 410 是预览传输生命周期反馈，不要求真实后端新增协议。

工具政策复用 `tool_started / tool_output_delta / tool_completed`；延迟及失败场景两片输出
期间保持同一 pending 工具，终态分别 done/error，`success:false` 不伪装成 turn_failed。
中断保留已有前缀并取消后续回调。审批允许后清 pending，同 request/turn 发布 running
状态，延迟两秒后续答；拒绝不发布副作用，取消为 interrupted。所有回合定时回调绑定
原 active turn 身份，旧回调不落到下一回合。没有工具 queued 事件、真实工具执行或队列调度。

失败场景首轮产生 `turn_failed`，原继续动作提交新合法 turn；重试回答按段落增量发布，
合并后的字节与原默认回答一致。首个消息增量先发给当前订阅者，再关闭这些真实 HTTP 流一次。

Session 仍持续向原 history/event ledger 追加后续增量、终态及同一 client 提交身份的
`message_removed`，不因连接断开暂停领域计时。重连握手有界等待两秒，真实客户端使用
其原退避和最后投影的 `from_seq` 再请求；服务只回放严格更大的 seq，再接实时流。
这证明游标续流，不代替重叠帧去重、真实模型/网络故障及所有断线状态的产品验收。
传输定时器独立于领域定时器：正常完成/中断不会让等待握手悬挂；reset/dispose 取消旧
握手（410）并关闭旧流、清理 heartbeat/领域定时器，新实例不继承首轮失败或一次断线消耗。

### 开发者设置模拟凭据合同

复用 `account.ts` 的 `ApiKeySummary` / `ApiKeyCreated`，普通和托管记录共用当前实例账本。
账号 API 仅在显式 developer 场景接入，需本实例 bootstrap capability 的 Bearer；未知、
跨实例或 reset 前 capability 均不能授权。Serve 准备路由由同一预览实例身份选账本，
不与账号凭据混用，也不调用 `/api/account/api-keys/session` 或真实身份服务。

| 端点 | 模拟响应与状态 | 边界 |
| --- | --- | --- |
| `GET /api/account/api-keys` | `{keys:ApiKeySummary[]}`；sample/empty/delayed/failed | 无 token；读取失败持续 503，重试不伪造恢复 |
| `POST /api/account/api-keys` | `{name:string}` → `ApiKeyCreated` | 不可认证的 `preview-only:` 展示值只在此回执出现；掩码与其对应，完整值不入账本 |
| `DELETE .../{key_id}` | `{revoked:true}` | 仅普通记录；未知及其他实例 ID 404，托管记录 403 |
| `POST .../{key_id}/rotate` | `{rotated:true}`，无明文 | 仅托管记录；删除旧摘要，后续准备/刷新补新身份，不模拟真实凭据失效与会话迁移 |
| `POST /api/serve/skill-credential` | `{ok:true,ready:false}` | 幂等准备模拟托管摘要；empty 场景不补记录，没有真实凭据环境 |
| `POST /api/serve/skill-credential/refresh` | `{ok:true,issued:false,aligned:0}` | 仅模拟摘要生命周期，没有签发和会话对齐 |

普通变更政策 normal/delayed/fail-once，延迟两秒；非法写入不消耗首次失败，变更并发 409。
dispose、断连和 reset 取消未完成读写并返回 410，不污染新账本。生成名称允许空且上限 64，
与原 UI 输入上限对齐；100 条内存容量是预览防护，不宣称真实配额。账号服务不在本仓库，
该服务的错误码、名称校验、配额和安全行为仍须真实 Owner 核对；不能用模拟结果冒充认证验收。
不点击复制或接入真实剪贴板，不调用模型、外部命令或个人配置；浏览器内存回执不代表持久化。

### 文档内容读取与 PDF 区域清单

**current（源码）**：Markdown/PDF/Code/Image/DOCX 的显式 `simulation.contentRead.mode` 支持
`delayed / failed / fail-once`。初始化从所选目录条目的真实 document target 解析当前项目和
VFS file identity；不是按特殊文件名、扩展名或正文暗中决定结果。同身份重命名后政策仍生效，
原路径新建的不同身份不继承政策。仅作用于 `GET /api/workbench/content`，不改变
`GET /api/workbench/open`、raw、保存、版本和审阅接口，也不写第二份样本快照。

`delayed` 有界等待后读取同一 VFS 的当前 bytes/revision；`failed` 持续返回
`503 {detail:"preview_content_unavailable"}`，原重试仍失败；`fail-once` 首个合法目标内容
GET 返回同一错误，之后原重试可以成功。后者按请求语义消费，不宣称区分框架与人工请求；
消费测试要求错误先可见、真实点击重试前不得出现成功响应，不能靠增加失败次数掩盖自动请求。
无效路径与无关文件不消耗政策。reset/dispose 撤销在途延迟，旧读取不返回正常内容；
连接关闭清理等待，实例之间互不影响。

真实客户端先读 open projection 再读 content；503 由原客户端归类为 retryable，
真实 Dock 错误面调用 `workspace.retryLoad` 重新读取，不添加页面预览判断。
首次深链恢复会等待文档打开后才设置 `navigationRestored`，期间 App 展示恢复 Progress，
不能将其称为 Dock loading。延迟场景的消费判据是目标内容 GET 已发起但未响应时，
真实 `progress-screen` 可见、原 viewer 未出现，之后恢复面退出并呈现原文档。
关闭后从资料列表重开的尝试未证明 Dock loading，真实资源动作在打开 Promise 完成后才
激活文档；不能把服务延迟或成功响应当成格式内部加载面通过。持续失败通过原重试确认仍失败，
再按 F8 在 Console 显式解除当前实例目标文件的持续故障，关闭控制台后由原重试恢复。
`POST /__preview/content/recover` 不重建实例、不改文件、版本、偏好或真实磁盘；
仅 failed 政策可幂等恢复，其他模式/无政策为 409，已销毁 Owner 为 410。
领域计时器已 resolve 但续体未执行时仍复核销毁/断连；服务在 await 后复核实例和
项目登记，已摘登记项目不因保留文件字节而返回旧成功。恢复不代表真实后端故障验收。

真实项目内容 GET 沿当前 project/path 读取，没有 identity CAS。预览同身份编辑与
同路径替换均返回当前字节及 ETag；路径消失为 404，不为故障绑定额外伪造身份冲突。
`POST /api/resource/reveal` 是原客户端的只读位置解析，不等于写文件或执行原生揭示；
消费测试需按精确项目/路径与回执单独观测，不能将其与业务写混算或放行所有 POST。
项目 HEAD/Range 与内容内部的 PNG 解码、Monaco 握手、DOCX 解析、XLS/WASM 生命周期
尚待独立接入/验收，普通传输成功与原重试不能替代这些分支。

`GET /api/workbench/pdf/regions` 沿用 `path/project/revision/start_page/end_page` 参数和
原 `PdfVisualRegionManifest`。响应从同一现存 VFS PDF 字节用既有 `pdf-lib` 仅读真实页数，
保留 `source_revision`，使用 `schema_version:1`、`coordinate_space:"pdfjs_normalized"`。
预览没有区域检测器：`detector_version:"preview-unavailable"`，所有请求页明确
`unavailable:true`、`regions:[]`，并列入 `unavailable_pages`；不是声称检测成功而结果为空。
未知文件 404、非 PDF 415、过期 revision 409、缺参数/非法或越界页范围 422；损坏 PDF
解析失败 422。解析后再次核实例及文件 identity/revision，禁止返回旧实例或陈旧内容的清单。
图像裁剪等未实现请求仍明确 501，不制造公式、图片、表格或检测结果。

**gap / difference**：此切片覆盖 HTTP 读取延迟、失败和重试，不覆盖 PDF 解码失败、加密、
区域识别、真实文件系统故障或跨进程恢复。合同测试通过不等于最终场景 UI 验收；最终浏览器
消费和截图须按最终版本独立核验，也不替代真实 Serve/Electron 和跨平台验收。

### 账号只读场景合同

**current**：`settings-account-states / ready / pending / failed / anonymous` 的声明策略分别是
`no-base / ready / delayed / failed / anonymous`。控制面 `GET /__preview/state` 返回当前实例的
`account: {instance, mode, capability}`；普通场景按全局登录选择，显式账号场景的声明策略
优先但不清除全局选择。能力是每实例随机、内存保存的 opaque 值，
不是 JWT、用户令牌或持久登录。bridge 严格核对实例、模式及格式，再经公开 `setAccountBase`
设置同源 loopback；`getAuthToken` 仅返回该能力，`setAuthToken` 只接受清空，不采用传入凭据。

`GET /api/auth/status` 仍为 `enabled:false`；显式场景除 `no-base` 外返回当前本地请求的
`account_base_url`，普通场景同样沿当前全局策略设置同源地址，`no-base` 保持空地址。
真实客户端读取 `GET /api/account/me`：
只接受同一实例的 Bearer capability，返回原 `AccountProfile` 的 `user_id/nickname`，昵称明确
标识为模拟用户。延迟场景有界等待后返回同一 profile；失败场景持续 `503`，重试仍失败；
匿名没有能力，沿客户端未登录分支，不伪造成功。reset/dispose 失效旧能力并结束在途等待。

**current**：`GET /api/account/credits` 沿同一实例 capability、延迟、失败及销毁围栏读取，
已授权的普通场景明确返回 `503 {code: "preview_credits_unavailable"}`，表示没有模拟积分
数据，不伪造余额或放宽计量。原客户端保留模拟登录并显示余额占位，诊断记录明确503，
不再作为未知请求501。缺失/异实例能力仍401，销毁与重置使在途旧读410，含已授权读取恢复前
的微任务竞争；不调用真实积分服务。项目中心消费回归同时禁止实际页面出现未知501请求。

**gap / difference**：只读 profile 与积分不可用适配不表示真实登录或计费已实现。手机号、密码、昵称
修改和真实登录等 mutation 仍未实现；不执行真实账号动作。原客户端的默认 cookie 语义不改写，
模拟鉴权不使用 cookie，不代理账号服务，诊断不记录 capability。后端与 Electron 继续使用
原账号合同和凭据边界，无需给页面添加预览分支。

### 反馈消费边界

**current**：`POST /api/serve/feedback` 使用真实 `submitFeedback` multipart 字段；
正常场景返回 `{id}`，空描述及附件校验失败返回 `422 detail`，目录场景的
`simulation.feedback` 显式选择 `502` 或 `429`，不根据用户正文暗中切换结果。
图片数量、单图/总图大小、JSON 报告与描述长度沿真实 Owner 校验。
**gap / difference**：预览额外限制整个请求为 45 MiB，超限返回 `413`；仅在内存解析，
不采集系统日志、trace，不上传附件。成功回执额外声明 `simulated: true`、`bundle_bytes: 0`。
诊断只保留有界计数与用户请求采集/实际未采集标记，不保留正文、邮箱、文件名或附件字节；
reset 清空回执并更换 epoch。此消费链路不等于真实反馈上报或原生截图功能验收。

### 诊断与隐藏设置消费边界

`/__preview/state` 的诊断是开发预览数据，不要求真实后端增加对应接口。请求摘要按实例
有界保存 method/path/status/duration/outcome，不存查询参数、头部或正文；事件摘要从同一
会话和文件事件账本派生，不能成为第二份可变事件事实源。reset 后旧请求与事件不进入新实例。

账号仅在真实客户端确认 profile 成功时展示已登录及身份操作；加载与失败分别显示状态、
错误及重试。当前隔离工作台账号仍是 `no_base_url` 错误态，不把它改成匿名或伪造登录。
额外的中英 ready/loading/error/anonymous 消费回归使用本机 HTTP 样本边界，只证明共享内容
的渲染状态机，不证明工作台已有可选择的全部账号场景，也不证明真实账号登录。
权限页使用 account namespace 的状态文案；浏览器仍诚实展示原生能力不可用。
工作台权限场景现通过 typed bridge 提供正常不可用、2 秒有界延迟及持续失败策略，
控制台可直接选择，失败后的刷新走真实组件回调并再次查询。三项真实 UI 消费通过；
不修改系统权限、不模拟已授权，不把 bridge 合同误写为后端需适配的新 HTTP 接口。

### 版本读取与封存

**current**：`GET /api/resource/capability`、`GET /api/resource/files/{file_id}/versions`、
`GET /api/resource/versions/{id}` 及内容的 GET/HEAD/单 Range 复用同一 VFS 身份与不可变快照。
版本场景通过受审 modified fixture 推进文件当前字节，历史与当前不是彼此独立的静态响应；
普通场景保留初始快照。版本比较沿真实客户端分别读取两份版本内容，不依赖服务器 unified diff。
`POST .../files/{file_id}/versions` 的 seal 校验磁盘/head/pending fence 与幂等键，冲突返回
真实错误结构；未知版本或跨实例旧版本不可读取。缺少批注快照返回明确的 404，不伪造空成功。

**difference / gap**：预览每文件 1 MiB、累计版本字节 64 MiB、最多 50 版及 128 个封存回执，
容量失败在修改 VFS 前预检；这些是开发预览预算，不代表真实服务限制或磁盘持久化。
restore、alias、delete、服务器 unified diff 尚未接入，不将已能比较写成版本生命周期全覆盖。

### 批次审阅与文件冲突

**current（HTTP 客户端合同）**：实例内每项目的 `PreviewReviews` 复用唯一 Versions/VFS，
场景创建 pending candidate，树节点的版本状态暴露真实待审入口。支持
`GET /api/resource/review-batches`、批次详情、成员 `base/candidate/current` 与 `POST .../commit`；
决策沿真实客户端的 accept/reject/revise、pending revision、disk revision 与幂等键执行。
候选未封存；完成后同一文件身份、版本头与资源内容事件保持一致，不维护另一个可写副本。
文件 `pending`、审阅 base、`review/conflict` 与 `review/reconcile` 复用同一审阅事实源。
首次提交失败、重复回执、旧批次、跨实例、修订围栏和冲突恢复已有真实 API consumer 测试；
这些测试不替代浏览器批审 viewer 消费验收。

**difference / gap**：当前只覆盖已存在、同路径文件。新建、删除和跨路径恢复不支持时
明确返回冲突，不伪造成功；旧单文件审阅 POST 与全局 pending 列表仍未接线。
冲突场景通过 VFS 外部写入产生 drift；若用户已读取最新 revision 并明确接受，合同允许
恢复 candidate，不能为了展示错误而伪造过期提交。真实后端接口已存在，预览不新增产品协议。

### 隐藏资料模块与检索结果

**current**：资料模块复用真实 registry contribution；文件行始终预留菜单控件空间，
避免待审按钮与绝对定位菜单在静止/hover 间重叠。真实点击、矩形不相交与命中目标均有消费断言，
不以 force click 绕过。`GET /api/serve/settings/file-versions` 从版本 Owner 和同一 VFS 派生
只读配置与扫描摘要，满足模块挂载；修改策略、清理等 POST 仍明确不支持。

`GET /api/literature/searches` 仅在文献搜索场景播种 completed 历史任务，启动后由真实客户端
恢复标签，用户点击查看真实表格、选择和详情；结果状态接口返回同一受审论文身份。
`POST /api/resource/web-search` 使用原请求/official 输出 schema，真实表单提交后显示两条
明确标为 mock 的候选，可选中；候选 URL 使用 `example.invalid`，不联网检索或抓取正文。
网页图标路由只对受审来源返回空响应，不做任意 URL 代理。

**gap**：此切片不解锁文献隐藏的搜索发起/登录，不模拟入库、抓取、导入或外链成功；
搜索尚无可选择的加载/空/错误/重试政策，不能将结果成功态当全流程覆盖。
批审五项与检索两项真实 UI 消费通过，但多文件/Office 审阅、旧单文件快照及真实 Agent
磁盘生命周期仍待独立验收；样本不是已发表论文，不编造真实 DOI 或 arXiv 身份。

### 最小文件读写契约

样本唯一清单为[受审注册表](../../preview/documents.ts)，包含 minimal-project 的 Markdown、
Python、PDF，现有 PNG、Office corpus 的 DOCX/XLS，以及预览 CSV/TSV 和不支持格式样本。
[装载器](../../preview/samples.ts)校验 SHA256 及来源 manifest 后，采用实例隔离的内存覆盖。
XLS 属于 Office viewer，CSV 属于 spreadsheet，TSV 属于 table；未实现的转换请求明确失败，
不以其他格式字节冒充转换成功。XLS 已接入受审预置字体供给，实际可见性仍待验证；
它不授予系统字体权限，也不证明 Electron 排版一致，样本存在不等于可用验收。
`POST /api/resource/reveal` 仅按 body 的 project/path 解析同一 VFS，返回 `{absolute}`；
不存在返回 `404 node_not_found`，越界拒绝，query 不得替换项目身份。该路径是虚拟路径，
不是用户磁盘授权；真正原生打开仍由 bridge 明确返回 `desktop_bridge_unavailable`。
没有读取个人目录、写真实磁盘或将用户文件打入样本。文件 `identity` 在保存/重命名时保持，
`mtime` 为秒，`revision` 从实际字节计算为 `sha256:<hex>`；返回字节拷贝，避免调用者篡改库存。

```text
GET /api/workbench/open?project=<id>&path=readme.md
  → OpenDocumentResult {revision, content_url, asset_id, capabilities, ...}
GET /api/workbench/content?project=<id>&path=readme.md
  → 原始字节；ETag: "sha256:<current>"
PUT /api/workbench/content?project=<id>&path=readme.md
  Content-Type: application/octet-stream
  If-Match: "sha256:<current>"
  → 成功后读取新 ETag，再次 GET 必须得到同源新字节
```

**required（真实契约）**：真实提交要求 octet-stream、有效 `If-Match`，成功返回 `204` 与新 ETag；
缺少有效 revision、弱 ETag、冲突和不支持的媒体类型走原错误语义。当前模拟端已补齐
缺 revision 返回 `428`、冲突/弱 ETag 返回 `412`、错误媒体类型返回 `415`、成功 `204` 与新 ETag，
并接受与真实端一致的未加引号 revision。对应聚焦断言不证明幂等提交、自动版本或真实磁盘写入；
不能将“能够保存”写成全契约一致，不得通过放宽生产客户端或后端修正模拟差异。

**required（会话契约）**：事件保持 `v:2`、单调 `seq`、`session_id` 及所属 `turn_id/item_id`；
审批关联原 `request_id`，批准/拒绝/取消必须有不同可观察结果。`accepted` 只证明接收，
不证明回合完成；`reconcile` 必须根据实际提交身份说明 applied/not_applied/still_unknown，
不能为了消除前端 pending 统一返回成功。该批修复的完成状态以最终源码和消费测试为准。

会话置顶和归档当前已使用真实 `PUT .../pin`、`PUT .../archive`，回执包含 `session_id`
及 `pinned/archived` 状态，不再以模拟专用 POST 方法替代；真实持久化与重新打开仍需单独验收。

## Ownership / Dependency

真实 DTO、事件与业务状态归原 Serve/Runtime Owner；预览团队维护现有契约的有限模拟，
不反向要求业务后端实现 `/__preview/catalog`、`/__preview/state` 或 `/__preview/reset`。
这些开发接口只管理场景、隔离偏好和清理，生产排除由 [构建检查](../../preview/verify.ts) 核实。

新增 UI 先判断所需数据是否已能由现有契约表达：能表达则补同一消费路径的样本/状态；
不能表达才提出新增字段、校验、事件、错误和兼容语义，并同时更新真实与模拟实现。
原生选择器、WebContentsView、系统权限、安装更新不能由浏览器 mock 替代。

### MCP 设置配置

**历史记录（2026-10-29 已退役）**：独立 MCP 设置页与对应预览目录、场景和页面测试已移除，
用户入口统一为扩展中的连接器。以下只记录原页面的预览合同，不代表当前可打开的页面。
底层配置接口、预览配置模型及其单元测试保留，不迁移或删除真实用户数据。

原 `McpSettingsPage` 通过既有 typed bridge 消费
`GET/PUT /api/settings/mcp`。预览只在实例内存保存 `configuration` 的
`schema_version:1 / revision / servers`，成功写入才递增 revision，旧 expected_revision
返回 409；延迟写入在真正提交前再次比较 revision。重载读取同一实例，reset/dispose 或
断开取消旧等待，不迁移或写真实 MCP 配置文件。

场景政策 `simulation.mcp` 分别声明 read 的 normal/delayed/failed 与 write 的
normal/delayed/fail-once。非法请求和冲突不消费首次失败；首次合法写失败不改变配置，
用户沿原表单再次提交。原页面的等待、错误、启停、移除和刷新仍由真实状态机决定。
读取失败后的摘要复用原 loadError 消息，不再在已结算错误时显示“加载中”；同批 mock
错误政策与真实 UI 回归先暴露该问题，再验证原刷新入口下的正确摘要。
启用配置明确返回 `failed`、`tool_count:null` 和 `safe_error:"preview runtime not executed"`，
禁用配置返回 disabled；supported 表示预览支持配置消费，不代表真实 MCP 连接或工具可执行。

**difference / security**：真实接口的 `require_host_process` 与宿主代理不变，预览不持有
或伪造 Host-Key。HTTP URL 和 stdio command/args 仅为内存配置文本，绝不发请求、运行命令
或探测服务器。保留真实字段，但 headers/header_secrets/environment/environment_secrets
只接受空对象；非空映射及 URL query 返回 403，不回显其输入。其余格式错误 422、超出预算
413、实例销毁或等待取消 410。URL 拒绝 userinfo、fragment 和非法协议；查询整体禁止是
明确比真实合同更严格的预览限制。自由文本不是通用敏感信息检测器，协作样本只用受审虚拟
配置，不应输入真实密钥；不能把这些检查宣称为任意文本的 DLP 或完整安全审计。

**gap**：不模拟服务器 ready、OAuth/secret refs、工具发现/调用、stdio 进程或网络生命周期，
也不证明真实后端文件落盘、宿主权限或安装版 MCP 可用。真实后端已有该合同；预览政策不是
要求后端新增的 DTO，适配时仍消费原共享页面。
本批浏览器配置交互使用 HTTP 样本；stdio 表单字段、auth_required 等视觉分支尚无对应
消费场景，不能把当前五场景写成 MCP 所有关键状态已覆盖。

## 模型服务只读合同

**current**：正常设置入口复用 `AccountPanel` 的模型服务标签，沿真实客户端读取
`GET /api/serve/model-profiles`、`GET /api/serve/model-providers` 与现有
`GET /api/serve/models`。连接 DTO 保留真实公开结构；受审样本使用 `example.invalid`，
未启用、无密钥、非 OAuth，两个已选模型仅是能力声明，不表示可推理。厂商预设返回空数组，
真实界面仍显示其内建的未添加厂商入口，不复制另一套空态。

每个实例及重置使用新的连接身份；同实例重载保持资料一致，返回值独立复制。提供样本、
空配置、延迟读取和持续 503 四政策；重试不会按次数伪造恢复，重置/断开取消旧等待。
保存、启停、可见性、删除、探测与模型发现均不支持；旧或跨实例连接标识返回 404，
有效标识的不支持操作返回明确 501。不持久化输入，不连接上游，不执行 OAuth 或推理。

**gap**：本切片仅验证列表/筛选/详情及已选模型读取，不覆盖编辑保存、连接可用性、
OAuth、真实模型目录刷新或调用。实际 Electron 只能核验自然配置下的页面读取，不将
浏览器注入的错误、样本与延迟当作真实服务同态验证。

## 文件设置配置合同

**current（本轮接入）**：文件设置复用原 `FileVersionPage`，由
`GET /api/serve/settings/file-versions` 读取策略；次数与大小字段沿原 blur/Enter 自动
调用同路径无 `preview_token` 的 POST。当前生产页面隐藏高级规则设置，不能为演示
恢复隐藏控件或发明预估确认弹层。自动保存与格式化开关仍沿既有隔离偏好保存。

真实 Owner `resources/service/retention.py:configure` 仅校验并保存配置，不读取或清理
项目历史，因此配置回执的影响计数为零、token 为空具有明确生产语义。模拟接入亦仅
更新当前实例策略，GET 的扫描概览仍由同一 VFS/Versions 事实派生；不声称修改配置后
模拟历史容量已经随之裁剪。正常、提交等待与首次合法提交失败通过原控件消费，错误
保留输入并沿原 toast 操作重试；非法输入不能消费首次失败，重置取消旧等待。
模式、整数范围和错误回执沿真实协议；预览对 patterns 的非字符串/字符串数组类型
有意严格拒绝，真实服务部分输入会忽略或转字符串，当前真实页面发送字符串不受该差异影响。
原 Enter 自动保存路径曾因 blur 后的默认动作误激活通知导航；共享页两个字段先阻止
默认行为再 blur，模拟消费测试同时保留键盘时间线及输入/保存/重试断言。焦点约束本身
不改变，通用要求见[交互规范](../design/interaction.md)。

**gap**：带 token 的 apply、`/preview` 的影响计划/过期围栏/历史裁剪未接入，不得返回
假成功。读取异常尚无本轮消费场景，现有表面没有独立读取 loading/error 面；需要改进
时仍须共享 UI、mock 和真实 Electron 同步交付，不能只为预览造错误提示。

## 数据存储与虚拟目录

**current（本轮接入）**：原数据存储页分别读取宿主 `StorageConfig` 和
`GET /api/serve/workspace-root` 的 `{root, configured}`；前者 configured 为 Home
来源布尔值，后者为显式容器路径字符串，不能互相替代。Home 运行期只读，预览两个
修改 Home 的资格字段均为 false。预览 bootstrap 的 Home/runtimeStore 和候选都是
明确 `/preview/` 虚拟标识，不解析个人目录。

原“更改”按钮沿 `bridge.pickDir()` 打开预览宿主的受审候选 Dialog；未选择时确认禁用，
取消、Escape 与关闭返回 null、不发 PUT。选定后由原页面发
`PUT /api/serve/workspace-root {root:string}`；回执沿真实
`{root, configured, restartRequired}`，仅改变实例 configured，effective root 与现有
项目/VFS不变。模拟重启提示不执行重启、搬迁、新根探测或原生权限操作。非法/旧/跨实例
候选拒绝；延迟和首次合法提交失败必须经原 busy、失败提示及再次选择重试消费。
选择器回执为单消费者；已有请求时重复调用返回 null，不让多个调用者以同一路径
各自提交 PUT。取消/Escape/卸载结算为 null，不访问浏览器文件选择 API。

**current（双源读取）**：共享页面分别管理 Home 与容器根的 loading / ready / error，
一路失败不清除另一路；宿主拒绝和 workspace-root 的 null 均进入原错误及重试表面。
容器根未 ready 时禁止更改，选择器打开至保存结束保持互斥；卸载和读取代次围栏
阻止旧回执覆盖新配置，不改路径解析器或真实写入协议。

预览 bootstrap 仅给受审 DTO 与虚拟候选，不能因页面读取政策阻塞整个启动。
每次 `storageConfig()` 以 `cache: no-store` 经
`GET /__preview/storage/config?previewInstance=…` 读取同一
Owner 的当前配置，HTTP 失败先完整消费响应体，再拒绝调用，不回落 bootstrap，也不
遗留在重载时被取消的未消费响应。该路径只属于预览服务，不是后端
待实现的新 API。容器根继续使用原 GET；`homeRead` / `workspaceRead` 各自选择
normal / delayed / failed，failed 持续返回声明的 503，原重试不按次数自动恢复。
控制台 `POST /__preview/storage/recover` 仅解除当前实例读取故障，随后必须原页重试；
不改变配置、VFS、已登记项目、生效根或写入失败政策。重置与断连取消在途等待。

**current（同一宿主消费者）**：首启资格检查也消费 `storageConfig()`，读取拒绝显示
持久错误 Toast 与原重试；不能由设置页自行捕获后便声称无未处理错误。读取
失败不生成默认资格、不自动标记首启已完成，已完成首启则不再重复资格读取。
设置页尚无已知路径时不渲染空路径装饰块，有已知值时不得因另一来源失败而清空。
设置 Modal 打开期间不强制穿透外部 Toast；真实消费先关闭设置，再操作首启重试。
浏览器请求时序已证明默认缓存模式会使同 URL 的四个读取排队，预览宿主必须显式
禁用缓存，不能延长原页面等待判据或改变领域延迟来掩盖；正常/故障 DTO 合同不变。

**gap**：真实宿主读取故障与恢复尚无受控环境验收，mock 不能替代真实 IPC 失败。
真实 Electron 本批只读挂载 Storage，不选择或提交目录。
整合前历史版本的归档 Tabs 曾同时挂载任务和项目；目标 `208730236f` 已移除设置中的
任务页签，只保留项目，任务沿所属项目侧栏读取。目录 GET 客户端的原生授权根同步
与 HTTP 业务变更仍须分别观察，不能仅凭无 HTTP 写或配置 hash 不变断言零宿主副作用。

## 归档与模拟授权根合同

**current（目标整合接入）**：归档设置直接消费同一实例项目账本，不恢复已移除的任务
页签；任务从原项目导航展开归档区并打开只读会话，不维护截图专用第二份列表。
任务详情沿原历史接口返回
`kind:text, role:user/assistant` 及工具记录；用户角色与主对话共用历史投影判据。
背景目录刷新应合并在途归档读取，不取消并永久饿死相同延迟的请求。
三处动态会话/项目目录客户端共用 `LIVE_CATALOG_REQUEST` 显式请求 `cache:no-store`，
避免StrictMode和并行目录的同URL请求在Chromium缓存锁下串行等待。只选择目录的
请求策略，不修改所有API默认缓存、凭据、401传播或原超时，不调整模拟延迟凑绿。

| 消费路径 | 同一合同与模拟语义 | 真实后端 / 限制 |
| --- | --- | --- |
| `GET /api/serve/sessions?scope=project&project_path=...&archived=true`、原历史 GET | 当前项目样本或真实空库存；列表/历史分别支持延迟与持续503，原任务错误入口重试仍可失败；详情只读。模拟全局两条任务分别属于两项目，不能要求当前侧栏同时显示 | 真实接口已存在，不新增预览专用历史协议；不模拟模型执行；全局只读目录仍可独立测合同，不冒充当前项目消费 |
| `PUT /api/serve/sessions/{id}/archive` | 同步200含 `ok,session_id,archived`；恢复更新相同目录身份 | 真实运行中归档可终止/排空；mock运行中409明确拒绝，该终止链仍未模拟 |
| `DELETE /api/serve/sessions/{id}` | 同步200含 `ok,session_id`；删除历史、快照、事件流及待执行任务，旧ID不可访问 | 不能把同步任务回执用于项目摘登记 |
| `POST /api/content/projects/{id}/archive` | 返回完整ProjectRef及 `archived_at`，更新同账本；无效项目或当前运行根拒绝 | 真实接口已有；运行根不是renderer当前所选项目ID |
| `DELETE /api/content/projects/{id}` | 202含32位十六进制 `operation` 和 `state:queued`，沿原客户端轮询 operations；终态 `result:{id,removed:true,files_kept:true}` | 摘登记不是删除文件；接受后客户端断开不等于取消已接受操作 |

**current（等待与失败）**：写入按实例支持正常、延迟和首次合法提交503；非法请求不
消耗首次失败。项目批操作串行统计部分成功，失败项仍可选中重试。危险确认在途禁用
确认/取消及Escape关闭，等业务终态后显式关闭；不会因为收到202就当作操作已完成。
reset/dispose隔离旧读取及未接受写入；已接受操作的终态与观察者生命周期分别测试。
项目摘登记保留VFS字节，但所有资源/历史入口仍核对项目登记，旧ID不能继续读取。

**current（仅预览控制）**：`POST /__preview/roots` 接收显式实例下的
`{scope:workspace|session|external,mode:replace|add,roots:string[]}`，仅接受当前账本
精确的虚拟根；拒绝本机、父/子及跨实例路径。external同步沿真实 `writableRoots`
合同，包含登记项目自身根；没有外部链接不等于该集合为空，摘登记后根立即失效。bridge仅在HTTP与
`ok:true`均成立时返回true，失败保留拒绝诊断；集合不授予OS权限，也不替代资源访问校验。
`DELETE /__preview/state?previewInstance=...` 只销毁精确显式实例，不创建缺失实例，
不清空其他标签页。消费测试使用自己的新服务，证据先落盘、停止页面轮询再销毁自有实例，
浏览器上下文与trace由Playwright正常收口，不提高100个实例上限掩盖泄漏。

**current（场景迁移）**：`settings-archives` 保留九项项目场景，任务九项政策沿
`page-resource / project-archives-*` 消费。旧 `settings-archives-history-*` 的原要求迁到
对应 `project-archives-history-*`，不在设置页虚构历史或保留旧兼容入口；正常/等待/失败/
写入政策仍来自同一个 Archive Owner，服务接口及字段没有为页面迁移另造一份。
原混合 empty/暗色消费拆为各自入口，消费注解按真实页面与场景登记，不以跨页关联凑绿。

**gap**：真实后端读取错误与延迟恢复尚无对应运行证据；任务没有批量选择，归档设置与任务导航没有搜索控件，不虚构这些交互。Web模拟根
同步不证明原生realpath/权限；真实Electron及Windows适用验收独立记录。

## 目录浏览增量合同

`GET /api/content/projects/{id}/tree` 沿真实 DTO 返回 `root,path,total,offset,nodes`，
每页 100 项、目录优先及名称排序，末页 offset 截至 total；非法 offset 返回 422。
`GET /api/resource/list?project=...` 递归返回同一 VFS 的目录及文件，目录
`file_type:dir`、count 为直接孩子数；不是仅返回 manifest 的文件或根目录孩子。
目录 `updated_at:null`，文件类型为真实后缀大写（例如 `MD`），无后缀为空串；
类型筛选及日期显示不依赖页面再做 mock 专用归一化。
`GET /api/resource/tree` 使用同一分页投影，但作为辅助根读取不消耗首读或后续页政策。
打开、原始字节、文件数及版本身份仍来自原 VFS，不能为浏览另造数据账本。

预览声明 `simulation.browsing`：seed 为 sample/empty/paged，listingRead 与
explorerRead 独立 normal/delayed/failed；explorerMore 独立 normal/delayed/fail-once。
政策仅绑定当前实例初始目标项目；其他有效项目正常，无效项目仍拒绝。
后续页首次合法非空请求可失败一次，辅助读取、非法页和末页不消耗该次数。
`POST /__preview/browsing/recover` 只解除该实例目标项目的持续首读故障，
不改 VFS、页账本、偏好或原生磁盘；没有可恢复政策时 409。
reset/dispose/断连取消旧读取，返回前重新核验实例及项目仍有效。

原 Explorer 追加失败保留已有节点和明确错误，原 offset 重试；刷新、路径/项目切换、
卸载与重挂载阻止旧页回写及旧 finally 解锁新请求。资料列表没有前端分页，
不虚构加载更多。真实后端已有这两类读取协议；模拟失败/恢复不证明真实盘故障或
操作系统权限已验收，独立空目录持久化、符号链接与挂载不在当前 VFS 能力内。

## 正反例

- 正例：调整真实 Composer/工具卡样式，沿用现有事件，补模拟分支并分别取 Web 与 Electron 证据；无需新增后端接口。
- 正例：发现 mock 项目创建跳过 operation，修模拟生命周期并补消费断言，不把差异记成后端未完成。
- 反例：queue 固定空集合、审批按钮消失就宣称排队和安全授权已验收。
- 反例：用 `__preview` 返回值、内部 Store dispatch 或另一套专用 DTO 替代生产状态投影。

## Enforced by

实际检查入口以 [Desktop scripts](../../package.json) 为准；聚焦断言位于
`preview/service.test.ts`、`preview/files.test.ts`、`preview/catalog.test.ts` 和 `preview/verify.test.ts`。
它们分别检查模拟 HTTP/事件消费、文件不变量、清单契约与生产排除，不替代真实服务/Electron
验收。文档结构、链接及登记按 `pnpm ops ci check docs workspace` 核对，主任务统一维护导航登记。

## Update triggers

新 UI 引入字段/错误/事件、模拟服务新增或收紧路由、样本变化、能力声明变化，以及真实后端
契约变更时，更新受影响领域。每次只说明本次差异与未覆盖状态，不将历史测试通过沿用为最终验收。

## Stop condition

本批接口、DTO、样本、模拟差异与 Owner 可追溯即可交接；不等待所有领域重写后端。
场景可操作、协议一致、双环境证据和原生平台验收分别报告。未运行的项目/审批分支最终
UI 证据、完整排队与未运行的真实链路必须保留 gap，不能因文档或单测通过宣称全部页面、全部功能完成。
