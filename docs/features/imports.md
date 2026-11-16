# 资源导入与任务中心

## 适用范围与职责

修改资料复制/关联导入、后台任务进度、取消/重试或任务中心时读取本页。
本页承接旧资源导入设计中的有效职责和决策理由；区分当前源码机制与目标约束，
不把历史测试结果当作当前产品验收。

| Owner | 职责与实际入口 |
| --- | --- |
| Serve Resources | 导入 job 编排、账本和 HTTP/SSE；[API](../../apps/serve/service/resources/api/jobs.py)、[服务](../../apps/serve/service/resources/service/jobs.py)、[持久化](../../apps/serve/service/resources/persistence/jobs.py) |
| Serve Content | 来源、目标与关联授权边界；[Content](../../apps/serve/service/content/)、[公共内容契约](../../apps/serve/service/platform/content.py)；Resources 不自行拼接项目根或越过该边界操作来源 |
| Serve 路径/组合 | [产品路径](../../apps/serve/service/paths.py) 持有用户级导入账本位置；[bootstrap](../../apps/serve/service/bootstrap.py) 组合依赖与生命周期 |
| Desktop Resources | [任务源注册](../../apps/desktop/src/renderer/src/features/resources/feature.tsx)、[API 投影与单任务事件订阅](../../apps/desktop/src/renderer/src/features/resources/imports.ts) |
| Desktop 任务展示 | [贡献契约](../../apps/desktop/src/renderer/src/contracts/features.ts)、[Provider/列表](../../apps/desktop/src/renderer/src/components/business/Tasks.tsx)、[TaskFeed](../../apps/desktop/src/renderer/src/components/business/taskfeed.ts)；[侧栏入口](../../apps/desktop/src/renderer/src/shell/ActivityRail.tsx)与[通知动作](../../apps/desktop/src/renderer/src/App.tsx)共用 TaskCenter Context，Shell 不拥有导入执行 |

Runtime、Adapter、Trace 不拥有产品导入 job。新增任务类型通过 Feature `taskSources`
注册，不把业务类型分支写入 Shell；展示协议不替代各域的真实执行模型。

## 为什么是后台 job，而不是弹窗 loading

资源导入是有文件系统副作用的长操作。弹窗等待原请求会把交互生命周期误当任务生命周期；
纯内存任务不能独立保存取消、事件游标和中断事实。持久 job 允许前端切页、切项目后
重新观察，而不要求 Renderer 持续存在。

导入账本位于用户级而不是项目级，因为它跨项目聚合且含本机来源和执行事实，
不能随项目复制到另一台机器。项目内应保留最终资源身份、内容与版本，而不是迁移本机任务来源。
具体路径和数据库归属见[持久化边界](../architecture/persistence.md)，不另维护路径推导规则。
本功能不是常驻 daemon；完全退出 App 后继续执行不属于已承诺能力。

## 当前机制

- 创建入口返回 202 和任务投影；LINK 在 admission 中仍有同步关联预检，不能概括为
  “返回前绝不访问文件系统”或仅凭 202 证明事件循环无阻塞。
- 权威状态为 `queued/running/completed/partial/failed/cancelled`；扫描、复制、关联和版本化
  另属 phase。[域契约](../../apps/serve/service/resources/domain/jobs.py) 是字段真源，
  不把旧设计的混合状态箭头当实际 Enum。
- API 按请求 owner 查任务；对外通过 `public_import_job` 派生 `source_names`，不把完整
  来源执行模型或绝对来源路径复制到通用任务展示协议。
- Desktop 活跃任务使用带 `after_seq` 的单任务 SSE；TaskFeed 丢弃不增长的 `eventSeq`，
  停止后递增 generation，使旧快照和订阅结果不再覆盖新会话的任务展示。
- Provider 在开始、打开和窗口聚焦时刷新快照；fallback 定时检查由 `needsRefresh()`
  判断未初始化来源或未连接的活跃 watcher。断线收敛不依赖弹层打开，避免后台任务
  因用户关闭展示而停止更新；旧“仅打开时”条件已被后续终态解耦决策替代。
- 过期运行 lease 的中断收敛按已完成项目或成功来源区分 `partial/failed`，并记录稳定
  中断错误；不能把部分成功改写为完成。后续实现存在 LINK/来源结果回执恢复入口，
  不能把旧“所有恢复一律失败且没有回执”描述泛化到当前所有恢复场景。

## 必须保留的目标约束与验证缺口

进度必须来自实际阶段：扫描显示发现数，复制百分比来自字节，关联是授权提交状态，
版本发现与初始化计数独立。不要计算伪造的跨阶段加权总百分比。复制结束、后端任务
终态与用户已经看见更新后的资料树是不同事实，不能相互代替。

取消意图、执行停止和最终副作用分别验证；重试不能重新发布已成功来源。
部分成功应显示逐来源结果，出错不能冒充成功；未完成文件清理与已发布文件保留需要
通过真实文件系统验证，不仅检查任务状态字段。

旧需求曾要求资料树读回成功才发布最终完成；后续设计明确改为后端任务终态与前台投影
解耦。TaskFeed 保留权威终态，Resources 的 `onTerminal` 只失效对应项目 revision，
面板进入/刷新独立读回。这样后台 A 完成不会强制在 B 或首页加载 A，也不会因资料树
刷新失败把成功 job 改成失败或 `refreshing`。刷新错误由资料页承接，不能吞掉错误或
用任务完成证明树已读回。扩展时保持单一账本、项目隔离、单调事件和旧响应 fencing；
分别验收后台终态与返回项目后的真实资源可见性。

当前任务中心由 [ActivityRail](../../apps/desktop/src/renderer/src/shell/ActivityRail.tsx)
使用 DOM Popover 呈现；[通知中的查看任务中心](../../apps/desktop/src/renderer/src/App.tsx)
通过同一 Context 打开它，不是第二个任务 Owner。内置浏览器的 [viewport](../../apps/desktop/src/renderer/src/features/browser/viewport.ts)
可能因相交浮层投影 `visible: false`；不能声称原生交互任务中心已经交付，不能靠
提高 CSS 层级、隐藏网页或旧导入截图证明覆盖实时网页的交互正常。

## 重名确认与版本化覆盖

供需求负责人评审与重复验证的 [COPY 需求恢复草案](imports/requirements.md)
单独记录候选要求、入口适用范围和待决项；尚未批准，不替代本页现行边界或发布基线。

重名处理另有 [同步导入入口](../../apps/serve/service/resources/api/routes.py) 与
[导入策略 Owner](../../apps/serve/service/resources/service/importer.py)。不能把这个入口的
两阶段冲突契约自动外推为后台 job 的全部能力；新增或改动调用方时分别检查真实链路。

首次 COPY 计划发现冲突时返回 `needs_resolution` 与 `plan_token`，不先执行整批导入。
确认需要显式决策及幂等键；服务端重算计划、检查冲突项集合和覆盖资格。
重命名按冻结目标精确创建，不能在目标变化后静默选择另一个名称；过期计划要求重新确认。
目录冲突不授权合并、递归删除或覆盖。Content 持有路径、稳定读取与精确创建，
Resources 持有冲突决策和版本政策，Desktop 不自行判断路径或 revision 安全。

文件覆盖必须经过 [版本 writer](../../apps/serve/service/resources/service/history.py) 的
`commit_versioned_replace`：检查当前快照 revision，先封存准确旧内容，再提交版本化 WRITE。
直接复制覆盖后等扫描补历史，会让旧字节丢失或产生竞态，因此不能代替此边界。
幂等重放不能追加重复版本；单文件 mutation 可恢复不等于多文件批次原子提交，
部分执行不得报告整批成功。旧提案中的回退描述不授权撤销现有代码或删除运行账本。

[ImportDialog](../../apps/desktop/src/renderer/src/features/resources/ImportDialog.tsx) 在同一弹窗
切换选择与冲突阶段，覆盖资格由服务端投影，忙碌时防重复提交。实现存在不等于当前验收通过；
修改时还需核验首次冲突零写、目标/来源变化拒绝、重放、目录禁覆盖、旧版本真实读回、
模态内错误与禁用状态，并结合 [导入契约](../../apps/serve/tests/contract_resource_import.py)
和真实 Desktop 文件系统操作取证，不用字段或旧截图代替。

## 文献附件进入项目资源

附件导入不是通用目录 job，也不是把文献关系加入项目。
[Literature API](../../apps/serve/service/literature/api/importer.py) 解析精确条目与附件，
读取来源字节及 revision，经 Content 校验资料根内目标，再调用 Resources 的
payload 预检/提交端口。来源路径不由 Desktop 提供。
[附件导入表单](../../apps/desktop/src/renderer/src/features/literature/Import.tsx) 当前只提供
独立复制与指定文件覆盖；旧方案的附件 LINK/标注共享模式已不在该契约中，不能从
通用 Resources 支持 LINK 推断附件也可关联。独占文献文件删除后可能消失，项目副本
不能依赖它的物理路径；文件副本与文献/项目关系不是同一生命周期。

预检绑定来源、目标与记录选项；提交要求 token 和幂等键。覆盖名与来源后缀必须匹配，
批注能力按 PDF 媒体类型判定，非 PDF 不接受记录复制/替换选项。显式替换批注另需确认，
来源/目标 record_revision 参与冲突校验，不能只核文件名就覆盖。
字节先提交，PDF 记录随后处理，最后 finish_payload；后续失败返回已写入路径，
不能声称跨域原子回滚或再次盲写。重放、目标变化、记录冲突、部分成功与重启恢复
仍需分别验证。旧 copy-to-project 路由仍存在，不能把新表单的两阶段契约外推到所有
旧调用方；修改入口时核对真实调用链与[API 类型](../../apps/desktop/src/renderer/src/features/literature/api.ts)。
源码与结构检查不证明实机目录选择、覆盖历史读回或副本删除隔离已通过。

## 修改后的验证选择

- 后端按改动检查 [导入 job 契约](../../apps/serve/tests/contract_resource_import_jobs.py)
  及受影响 Content/版本恢复契约；先确认当前测试类与执行入口。
- 前端检查 [导入映射与订阅测试](../../apps/desktop/src/renderer/src/features/resources/imports.test.ts)、
  [任务契约](../../apps/desktop/src/renderer/src/contracts/tasks.test.ts) 与实际 TaskFeed 测试。
- 在隔离运行态的真实 Desktop 中复制/关联真实目录，观察阶段、切页/切项目、取消、
  重试、错误和重启恢复；核对实际文件、资料树与网络事件，逐张检查最终合成截图。
- 有内置网页时另验任务中心展开/关闭、网页 bounds、滚动/表单/运行状态和输入归属。
  结构、类型检查或 renderer-only 截图不替代此验收。

本页的验证入口不授权执行产品操作。实施功能时须遵守当次任务授权与适用规则；
macOS 验收结果不能作为 Windows 产品行为证明。
