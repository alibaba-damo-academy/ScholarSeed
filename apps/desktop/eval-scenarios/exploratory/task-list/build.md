# 项目任务列表候选构建依据

## 建设状态

资产修订 `task-list/13`（补充多任务状态图）。本页为候选草案，未冻结到任何评测分母；`TASK-LIST-CAND-001–008` 仅为候选标识。新增或实质变化要求的产品需求版本及目标 `0.3.2 / 202611121823 / preview` 适用依据尚未核实，不从分支名、源码版本或安装版本推断 v`0.3`。正常行为统一采用规则不自动批准异常、歧义或未经核实的目标版本映射；未经确认不得将候选变为通过判据。

## 多任务状态参考

`multiple-tasks-20261113.png` 是 `tmp/test_snapshot/desktop/two-task-observe-20261113/attempt-monitoring/run/evidence/b-reopen.png` 原字节副本，SHA-256 `0faa2dd05f45629683f343b8bd5f4d6f634d62e41fc75a1de4632b23580ab830`。2026-11-13 在隔离合成项目观察到多个真实任务及其中一条回复；后续同项目公开目录和历史投影确认两个新任务身份，renderer 投影为 `0.3.2 / 202611121823 / preview`。目录投影及磁盘摘要均晚于截图，关联非原子，不证明截图采集时的运行内存、完整列表或排序依据；右侧合成文档分屏较窄。此图不证明置顶、持久化或正式评测通过，不改变候选状态。

## 非空任务状态参考

复用[对话构建依据](./../conversation/build.md#同进程任务读回参考)中的真实完整窗口图，展示隔离项目的一个已完成任务；仅为页面状态参考，不证明置顶、排序或完整任务列表判据。

## 任务重命名线索

用户菜单截图依据确认重命名入口；历史 `CHAT-RENAME-01@2` 可从 `git show e2567e836e14707ad71477cc9cbeee32a00f5357:apps/desktop/docs/scenarios/catalog.json` 回查，提出新标题保存及重开后对应原会话，但其为源码探索、`reviewState=pending`，不能当已批准保存规则。当前项目任务、会话菜单与标题更新代码仅是 Owner 线索；目标包入口及版本适用待核。真实操作须有同项目会话独立目录和写入授权，不以提示或 UI 文字代替读回。

## 归档任务删除依据

项目侧栏任务归档记载用户确认归档任务可沿用原确认直接删除；这是归档对象操作，不等同运行中任务停止与删除。当前源码 `features/project/Navigation.tsx`、`components/business/SessionContextMenu.tsx` 分别持有项目导航及任务菜单入口，SHA-256 分别为 `32b5628dc34550aa7279fd0d445288ca361be6c51a737d7950503103769c4546`、`f064bf91777485fa05e2f55051a242064f3df8be37742d478a94c37691e22c2d`；源码不证明目标制品同源或执行正确。原始资料保护、删除失败及目标版本须另核，不以历史确认或列表消失推断全部数据影响。本次未操作产品或改变历史冻结。

## 运行中任务删除确认依据

运行中任务删除与归档记载需求 `88280173`：用户确认删除或归档后自动停止，删除保留不可逆确认及原始资料保留说明。`TASK-LIST-CAND-006` 单列删除与取消，不由归档候选推断删除通过；该记录未明确所有资料对象的保留范围，须由需求 Owner 及实际隔离目标核实，不能把单个样本外推为全部对象。停止或收尾失败保留任务是当时 `current` 源码说明，失败分支仍待确认；历史 macOS 实测不代表目标包或 Windows 通过。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本及真实完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[SessionContextMenu.tsx](../../../src/renderer/src/components/business/SessionContextMenu.tsx) 提供删除入口，[sessions.py](../../../../serve/service/chat/service/sessions.py) 的 `SessionService._delete` 先调用 `_stop_for_removal`，成功后交删除 Owner。两文件相对基点无未提交差异，SHA-256 分别为 `f064bf91777485fa05e2f55051a242064f3df8be37742d478a94c37691e22c2d`、`cd11dfa9bc89692d2447e00a26e06471c5f909fd9cd7dcbea86fbb66f76aa8dc`。源码只用于定位，不证明目标包行为；验证前须明确可丢弃任务、精确影响路径和原始合成资料身份，分别获得真实运行、停止及不可逆删除授权，并用同任务独立运行状态与目录前后态核终态，不以预置结果或列表消失代替。

## 运行中任务归档确认依据

运行中任务删除与归档记载需求 `88280173`：用户确认删除或归档后自动停止任务，不再要求单独中断；本候选只承接已获准运行任务的确认归档与停止，不涵盖删除。该记录中停止或收尾失败时保留任务是当时 `current` 源码说明，失败语义须另核确认，不自动纳入本候选；历史 macOS 真机结果不证明目标安装包同源或本轮通过。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本及真实完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[sessions.py](../../../../serve/service/chat/service/sessions.py) 的 `SessionService.set_archived` 在归档路径使用 `_stop_for_removal`，并在满足条件后更新归档状态；项目导航见[Navigation.tsx](../../../src/renderer/src/features/project/Navigation.tsx)。两文件相对基点无未提交差异，SHA-256 分别为 `cd11dfa9bc89692d2447e00a26e06471c5f909fd9cd7dcbea86fbb66f76aa8dc`、`32b5628dc34550aa7279fd0d445288ca361be6c51a737d7950503103769c4546`。源码仅为入口和生命周期 Owner 线索，不证明目标包行为；需同一隔离项目及真实任务的独立运行前态、停止终态和归档目录参照。创建或触发运行、模型/工具、停止及归档写入分别核权限，不伪造事件或预置结果。

## 置顶操作确认依据

项目任务置顶设计映射记录需求 `87828007`、用户反馈及历史真实置顶/取消：Serve 会话目录持有状态，项目列表按置顶分组，同组保持活动顺序，首页最近任务不按置顶排序。`TASK-LIST-CAND-004` 仅承接隔离项目的置顶、取消及目录对应，不以图钉展示替代动作终态；首页顺序、重启保持、状态组合及 Windows 等分别核条件，历史 macOS 结果不代表目标包通过。目标包适用性、需求版本及动作状态的完整窗口图仍待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Navigation.tsx](../../../src/renderer/src/features/project/Navigation.tsx) 的 `changePin` 对目标任务调用 `setSessionPinned`，更新状态并重取目录；[api.ts](../../../src/renderer/src/api.ts) 按会话身份发送置顶状态并校验响应。两文件相对基点无未提交差异，SHA-256 分别为 `32b5628dc34550aa7279fd0d445288ca361be6c51a737d7950503103769c4546`、`6eaddf9622cd43ab5adebcc9511a4ecce763e1ca7877f5237f60f6cd13fbb2af`。源码只提供入口及数据流线索，不证明目标制品同源或结果正确。独立参照为同项目会话目录、任务身份与活动顺序，需分别核对置顶前、置顶后及取消后；置顶属于状态写入，执行前确认隔离项目、真实任务及授权，不需要为该动作发送模型请求。

## 归档任务确认依据

项目侧栏任务归档设计映射记载用户确认：当前项目侧栏归档区默认折叠、数量对应真实目录，归档任务可查看只读历史和恢复；该要求覆盖同文档更早“任务仅设置可见”的旧口径。`TASK-LIST-CAND-003` 仅承接展示、只读及恢复的可观察范围；删除、运行中自动停止、错误恢复及跨平台行为分别核依据和授权，不用旧口径或历史开发版观察自动批准目标包。该记录明确其后真实归档展示与恢复的验证缺口；目标包真实完整窗口图、适用性和需求版本均待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Navigation.tsx](../../../src/renderer/src/features/project/Navigation.tsx) 使用当前项目范围的 `listAllSessions` 读取归档目录，归档行进入 `archivedSession`，恢复调用 `setSessionArchived`；[store.tsx](../../../src/renderer/src/store.tsx) 管理当前会话与只读历史状态。两文件相对基点无未提交差异，SHA-256 分别为 `32b5628dc34550aa7279fd0d445288ca361be6c51a737d7950503103769c4546`、`ed81d7a9f13dd0f510ff4b079c267251ac6681341234a8d40615534f69b39342`。这是当前源码的入口和状态线索，不证明目标安装包同源或功能已通过。真实验证需获准隔离任务、同实例项目及任务身份、归档和普通目录前后独立参照；归档、恢复会改变任务状态，授权与准备须分别确认，不伪造数据库或会话结果。

设计映射记录需求 87828007 的项目任务置顶与未置顶分组、置顶状态由 Serve 会话目录持有及同组活动顺序，并记录历史集成回归；该依据支持历史需求存在，不证明当前目标包可达、已实测或目标版本映射。2026-10-30 用户统一采用已核实安装版正常行为的规则见既有交付记录，具体适用仍需核对。任务列表名称、空态及查询规则的全部产品语义尚未从已确认需求逐项恢复。

## 历史 ID 与范围映射

从[历史冻结](../../frozen/p1-20261025-e2567e836/freeze.json)所记 `sourceCommit` `e2567e836e14707ad71477cc9cbeee32a00f5357` 回查 `apps/desktop/docs/scenarios/catalog.json`：`CHAT-HISTORY-01@3` 是打开已完成会话并读回原消息、回复和终态；`CHAT-NEW-01@3` 是首次发送后建立与旧会话分离的新身份。两项历史目录均为 `reviewState=pending`、`coverageEligibility=exploratory`；任务列表的 `TASK-LIST-CAND-001` 可为历史会话提供入口线索，但不覆盖其消息或终态，`TASK-LIST-CAND-002` 的置顶分组也不是上述任何一项的同义 ID。不得据候选展示或历史资源就宣称这些历史点已采用或通过。

对应历史 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/conversation.json` 的 `D4-CHAT-003` 和 `D4-CHAT-002` 分别引用上述 ID，均明确 `expectedStatus=candidate_unapproved`。两源文件 SHA-256 分别为 `b0f7f62ba4cb39a487ee2026d1bf38aed6f0baa110157430de10a12d240a0671`、`929ec7c1bfab9f0f231e91f44ec4869052dbbc6f5ec7128ca4d4704d3c032590`，与冻结清单一致；可用 `git show e2567e836e14707ad71477cc9cbeee32a00f5357:<路径>` 回查原文，不恢复或改写历史文件。

## 当前源码分析与边界

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；本次核对的 `Navigation.tsx`、`Tasks.tsx` 和 `api.ts` 相对此提交无未提交差异。该源码未与目标安装包建立可信同源绑定，源码存在不证明 UI 可达或正确需求。

- **入口与固定内容**：[Navigation.tsx](../../../src/renderer/src/features/project/Navigation.tsx) 的项目导航展示任务标题、置顶分组和普通任务区域；`pinnedTasks`、`unpinnedTasks` 通过分组结果区分，置顶区只在非空时出现。行由 [Tasks.tsx](../../../src/renderer/src/features/project/Tasks.tsx) 组装，父子关系和收起状态影响可见行。入口及名称仍须真实目标版本验证。
- **动态来源与回退**：`Navigation.tsx` 按当前 `projectPath` 调用 `listAllSessions`；[api.ts](../../../src/renderer/src/api.ts) 的 session catalog 通过项目 scope、path、分页游标取数并按 session ID 去重；游标失效有一次重启，响应失败返回缺口。任务身份、分组及选中关系须与本轮隔离项目的独立目录对照，不能用画面自身作为参照。
- **条件状态**：列表加载、失败及空态条件分别由当前请求状态与可见项驱动；`Tasks.tsx` 以活动状态及父子/折叠数据组织行。失败与状态矩阵不自动纳入正常快评，也不能把空态当非空目录通过。
- **副作用**：`listAllSessions` 默认调用 `syncSessionRoots`，经 [preload](../../../src/preload/index.ts) 的 `syncAuthorizedRoots` 同步会话目录；读取列表不能简单认定为零写入或不影响授权根。置顶、排序、重命名、归档和删除属于不同状态写入或危险动作，须分别授权和验证真实终态。

## 数据、截图与交接缺口

`examples` 仅提供合成原始项目文件，不提供真实会话或预置任务结果。非空与置顶候选依赖隔离项目中的真实可区分任务、同实例任务目录与目标版本确认；没有这些前提时只记录缺口，不直接写数据库或模型结果。

`reference-20261112.png` 是 2026-11-12 在 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 的隔离实例中进入项目中心后取得的真实页面截图，原件为 `tmp/test_snapshot/desktop/candidate-1823-observation/task-empty.png`；显示隔离项目任务空态与空白新任务输入器，右侧是合成文档。截图 SHA-256 为 `429350c7c2d306b8302493dce2ba90592989fe268d01643948ab90b00b9f3bf9`，目标 `app.asar` SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。该图仅作参考，不证明非空任务、置顶或执行通过；不以当前画面代替需求采用或独立参照。

本候选已登记[场景索引](../../README.md)与[需求概览](../../requirements-overview.md)；后续由需求 Owner 确认版本及候选范围后再交执行 Skill 冻结。源码分析与真实页面观察不声明评测通过。跨平台、异常和写入矩阵另列专项，不能由项目列表展示推断完成。
