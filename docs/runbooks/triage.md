# 症状级知识路由

本页供症状或失败现象已明确时按关键词查找；只将问题路由到实际 Owner 正文，正文与证据仍以链接目标为准。一般开发从根 [知识索引](../index.md) 按任务定位，不预先读取本页。这里不授权启动产品、读取用户正文、迁移数据或修改权限。

## 身份、会话与授权

- 登录/退出后技能凭据、排队消息撤权或继承环境问题：读[受管执行凭据的实际准入](../architecture/serve.md#受管执行凭据的实际准入)。真实账号身份、会话所有权与模型密钥分开，失败不回退旧授权，记录不含秘密值。
- 登出后文献综述/精准检索任务续做出现 `task_context_missing`、`login_required` 或错误工作区：读[登录后产品任务恢复](../architecture/serve.md#登录后产品任务恢复)。保存的绑定不是跨轮授权，重新登录也不自动使旧租约有效。
- 项目切换串会话、历史检索或当前对象自动引用：读[会话隔离与上下文](../features/conversations.md)。范围授权先于历史匹配，自动引用与显式引用分开，前台导航不等于后台任务终止。
- 页签点击或首次引导关闭后输入草稿丢失：读[草稿与导航边界](../features/conversations.md#页签导航不得回写过期输入草稿)；导航只提交所属字段。
- 首轮完成后发送按钮持续禁用或 `recovery_pending` 未解除：读[完成后的恢复等待与连续发送](../features/conversations.md#完成后的恢复等待与连续发送)，不要直接清空恢复保护。
- 排队发送因项目文件权限拒绝或基线读取失败：读[资源基线读取权限失败](../features/conversations.md#资源基线读取权限失败)；先核对来源授权，不把失败卡当作模型回合结果。
- 回复期间追加 PDF 选区、误报 `assistant_claimed_refs_immutable` 或下一轮引用串用：读[回复期间追加 PDF 选区](../features/selections.md#回复期间追加-pdf-选区)，保留本轮认领引用的不可变边界。
- 授权卡跨轮次失效、答复后假 running、全文续跑：读[授权等待与跨轮次续跑](streams.md#授权等待与跨轮次续跑)。
- 审批模式选择值与实际策略不一致、热切未确认：读[权限选择意图与原生生效确认](streams.md#权限选择意图与原生生效确认)。
- 子代理等待、进度归属或摘要内容边界：读[子代理进度](streams.md#子代理进度的可信性与未解决内容边界)。
- 内容拒绝后的原生线程恢复与审计历史：读[可见历史与模型恢复历史](streams.md#可见审计历史与模型恢复历史)。
- 回答模型标签漂移、引用编号/位置或来源信任：读[回答元数据与引用证据](streams.md#回答元数据与引用证据)。
- 工具仍运行、取消回执与原生进程回收不一致：读[中断后的原生终端回收](streams.md#中断后的原生终端回收)。

## 文献、资源与检索

- 文献分类树、项目导航、同级重名或分类/标签删除：读[文献分类与项目作用域](../features/catalogue.md)。项目身份归 Content，删除分类不删除文献；旧开发期清库要求不构成当前数据删除授权。
- 文献列表拖入 PDF、项目落点或混合文件失败隔离：读[文献 PDF 文件拖放](../features/catalogue.md#文献-pdf-文件拖放)，不要误入 Resources 目录 job。
- 文献批量同步题录、限流后重试或取消后仍有在途写回：读[题录元数据批量同步](../features/catalogue.md#题录元数据批量同步)；批量不自动确认标题模糊命中，进度面板与应用进程生命周期不同。
- 资料树首次加载、分页、刷新、版本能力或列表慢请求：读[资料知识任务导航](../features/resources.md#按任务读取)，再选加载、版本、审阅或格式章节；定点能力观察不等于整个请求没有激活/遍历成本，旧性能报告不作为当前延迟或实机通过证明。
- Office 文档停在“分配编辑器”、WASM 预热失败或重试后仍不可见：读[Office 生命周期与绘制就绪门禁](../features/resources.md#office-生命周期与格式处理器是两个维度)；区分运行时就绪、文档加载事件与绘制 ACK。
- Markdown 纸宽、源码查找遮挡、外部链接、文内锚点或保存引用跳转：读[Markdown 阅读与链接](../features/resources.md#markdown-阅读与链接)，不沿用已退出的三档纸宽截图。
- 文件标签串项目、离焦自动保存或审阅重复提交：读[资源知识任务导航](../features/resources.md#按任务读取)中的项目工作区与批次终态；文件审阅不走文献综述流程，UI 状态不能替代落盘或业务终态证据。
- 划词加入对话、选区发送或来源证据：读[选区快照边界](../features/selections.md)；发送快照与解释/编辑的来源校验不是同一操作。
- PPT/PPTX 局部拖选变成整框、旧 PPT 解释失败或 PPTX 错用快照：读[Impress 选区与格式分派](../features/selections.md#impress-选区ppt-与-pptx-不共用降级)，区分旧 PPT 受限只读降级与 PPTX 权威源复核。
- 文献附件加入对话、无会话预览或标签导航异常：读[选区知识](../features/selections.md)附件章节；分别核对文件消息输入、Renderer 预览身份与服务端本地文件授权，不误走复制导入或文献综述流程。
- 文献笔记共享编辑、保存竞态或 Markdown 导出：读[笔记保存边界](../features/selections.md#文献-markdown-笔记共享编辑与保存边界)；区分条目笔记与 PDF 阅读记录，不从错误返回或任意退出推定草稿已保存。
- 文献 AI 解读首次打开、显式生成或模型 JSON 结果：读[解读结果边界](../features/selections.md#文献-ai-解读显式生成与结果可信度)；语法修复、字段有效、引用定位与临时预览是不同证明。
- 选区翻译读错附件、缺失文件或非 JSON 报错：读[来源身份与错误反馈](../features/selections.md#选区动作的来源身份与错误反馈)；物理删除再读[独占附件副本](../features/selections.md#托管附件删除与翻译输入故障)。框选覆盖、取消或迟到结果读[图表临时结果](../features/selections.md#图表框选与临时结果)；全文任务调度、页对布局和发布前源校验读[逐页翻译](../features/selections.md#文献逐页翻译与页内分段)。
- 资料审阅成功后落点错误：读[审阅完成与导航](../features/resources.md#审阅成员终态与批次投影)；业务完成、内存同步和标签导航分别核验。
- 科研结果入库和 Agent 授权全文读取：[文献结果与全文边界](../features/downloads.md)。
- 全网搜索重复执行、降级阶段或搜索证据：读[单次执行与阶段证据](../features/resources.md#全网搜索的单次执行与阶段证据)。
- 搜索栏断线、恢复或删除任务：读[搜索栏任务生命周期](../features/downloads.md#搜索栏任务与对话结果是不同生命周期)。
- 对话检索结果展示、状态或入库混淆：读[结果展示与入库边界](../features/downloads.md#检索结果展示不等于下载或入库)。
- 同任务跨回合全文同意、异任务误复用：读[全文同意与有效范围](../features/downloads.md#全文同意与有效授权范围)。
- PaperCard 原句、独立本地证据或 PDF 精确定位：读[原句与定位边界](../features/selections.md#papercard-原句独立本地证据与严格定位)。
- 文献综述激活、历史工作区或产物读取：读[综述安全边界](../features/review.md)及其产品 Skill/Serve Owner；业务问题不需要加载全部通用 Skill 发现知识。

## Desktop 与平台

- 反馈录制丢最后一步、暂停/停止或探针恢复：读[探针所有权与停止快照](../../apps/desktop/docs/architecture/ownership.md#反馈录制的探针所有权与停止快照)；分别核验输入过滤、网络正文、截图和诊断日志，不以历史提交成功证明当前安全或实机通过。
- 反馈上报、诊断包、会话归属或上游错误：读[Serve 反馈上报边界](../architecture/serve.md#反馈上报与诊断包边界)；本地契约测试不证明上游当前部署或真实提交。
- 工作台缓存、标签回收或资源释放：读[驻留与释放边界](../../apps/desktop/docs/architecture/ownership.md#工作台驻留与资源释放)，不将历史状态机或缓存预算当作当前实现。
- 退出重开后页面、设置子页、活动文档或停靠会话未恢复：读[Renderer 上次位置与目录校验](../../apps/desktop/docs/architecture/renderer.md#current--required--gap--advisory)；保存导航指针不等于持久化未保存内容。
- 内置浏览器、原生浮层、CDP 或浏览器产品开关：读[Desktop 浏览器约束](../../apps/desktop/docs/browser.md)，区分源码状态与真实验收。
- 后台准备更新、激活、恢复或候选 Provider 启动：读[Desktop 更新兼容边界](../../apps/desktop/updater/README.md#windows-velopack)；准备完成、重启授权、排空与健康提交不是同一证明。
- 跨平台路径、权限、进程、缓存/Temp/workspace 或归档问题：先读[跨平台开发与验收](development.md#跨平台开发与验收)，再定位实际代码 Owner；不放宽安全校验。

## Serve、Runtime 与出网

- 模型连接保存或启停失败：读[连接准入](../architecture/serve.md#模型连接保存与启停准入)；个人模型能力和代理差异读[个人连接声明](../architecture/serve.md#个人连接的能力声明)，网关来源拒绝读[出站来源](../architecture/serve.md#出站来源与目的地)。不因普通聊天可用就跳过动作模态、低延迟策略或来源检查。
- 模型列表刷新、连接快照或 Codex Host 复用：读[连接域模型与 Host 边界](../architecture/serve.md#连接域模型快照与-codex-host-共享)。
- HTTP 200 后瞬时失败、是否能重试：读[流内失败重试窗口](streams.md#流内瞬时失败的重试窗口)。
- 观察读取被持久化拖慢、backlog 与终态顺序：读[观察接收与临时暂存](streams.md#原生观察接收投影与临时暂存)。
- EOF/终态混淆、delta 聚合或工具前缀转换：读[观察面与终态](streams.md#观察面与终态)与[聚合边界](streams.md#聚合不是协议降级)。会话、权限和流证据取数流程只维护在[Engineering guide](../../packages/damoatrace/README.md)；本表不授权启动产品、读取用户正文或修改权限。
- 连接地址、检索传输或发行来源变化：读[出网与凭据边界](../architecture/network.md)，区分目标可配置与接收方授权；旧出网清单不是当前零泄漏证明。
- Codex 固定制品、完整 vendor 载荷或 DMG 工具联网回退：读[构建 Owner 的内置制品](build.md#内置制品)及构建前提。
- 品牌或包名切换涉及旧用户目录：读[路径真源与启动投影](../architecture/persistence.md#1-路径真源与启动投影)；不沿历史计划自动执行迁移。
- 科研结论的事实/综合/推断分类与证据缺失：读[科研证据规则](../../skills/community/academic-research-guidance/references/evidence.md)；加载与常驻指令归属见[Product instructions](../../apps/serve/service/chat/prompts/baseInstructions.md)。规则存在或引用可追溯不证明结论正确。

## 开发与验证

- CI 绿色含跳过、隔离或验证范围不明：读[CI 模式与质量结论](development.md#ci-模式临时隔离与质量结论)，先核对原始报告和实际模式。
- 选择验证层级、编辑循环 affected、提交/发布门或 CI 提速：读[验证分层与 CI 编排器](development.md#验证分层与-ci-编排器)；GitLab 离散 job 与 `ci:test` 编排器职责不同。
- Desktop 打包出现重复 `node_modules`、asar 闭包失败或把 `ws` 声明为运行时依赖：读[Electron 入口闭包](build.md#electron-入口闭包与浏览器驱动-node)；`build` 通过不替代 `package:check`。

定位到 Owner 正文后按当前源码、适用契约和真实验证要求继续；本表的路由与提醒不代替产品验收，也不证明链接目标的现状已核验。
