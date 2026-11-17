# 主计划与子计划

[English](plans.md) · **简体中文**

仅用户明确要求持久任务树、已有产品计划需要继续，或工作流确实要求持久阶段跟踪
（例如文献综述执行流程）时使用产品计划。普通科研、多步骤、长工具、检索和产物发布
都不要求产品计划；文字方案或原生轻量计划也不启用它。

尚未启用时，读取打包的 plan/enable 契约，以 scholarseed_bridge 调用 capability=plan、
operation=enable，request 为 purpose=user_requested 或 workflow_required 及实际需求 reason。
它只返回当前状态，不授权执行、不创建步骤、不开始计时。本轮随后走 [Bridge 路径](plans/fallback.zh.md)，
不要把产品参数传给接受 plan/explanation 的 Codex 原生 update_plan；宿主在下一回合边界选择
专用产品工具。已有产品树无需重复启用；release 退出产品计划但保留历史。
仅阅读本指南不启用任何能力。

保持稳定 ID 和 parent_id，只记录真实阶段，不逐工具调用建步骤，也不事后制造已完成清单。
计划不替代科研工作流。

先检查实际工具 Schema。旧式工具要求 request 包装时读[旧版计划](plans/legacy.zh.md)，不套用扁平形式。
产品工具缺失时读 [Bridge 回退](plans/fallback.zh.md)。当前扁平工具不预加载两个分支，
不把已有树切换到另一套原生计划系统。

下列形式仅适用于扁平工具。先仅传 operation=get，返回计划、expected_revision、turn_id 和各 ID 的 actions。
不使用 request 包装、operation=write 或 progress。每次变更带 plan_id、expected_revision、request_id。
宿主绑定已认证回调轮次，不猜可选 model turn_id。复用返回的身份和 revision；参数变化使用新 request_id，
结果不确定的相同重试保留原参数和 ID。

结构操作 create/update/revise/release 传完整扁平 items 快照（含未变项），字段为 id、content、可选 parent_id、kind。
不传 status、title、嵌套 children 或 kind=item。旧执行状态不变，新项 pending。Create 使用新 plan_id 和返回的 revision
（仅计划元数据不存在时为 0）；其他操作保留 plan_id。Update 保留根 ID、内容/顺序及父关系；
revise 需真实范围/结构变化及原因，不能抹去执行历史。Release 是明确退出，不代表普通完成。

执行操作 start/complete/pause/block/fail/partial 使用 step_ids，不用 items/status，按返回 actions 选择。
真实工作或检查点前 start，组合命令前 start 全部受影响叶子。验证完成后优先 complete，reason 引用观察结果；
它可原子完成已开始及未开始叶子，后者不获得虚构开始时间或耗时。严格 finish 只适用已开始项。
等用户时 pause，处理回复前重新 start；独立叶子可并行。执行前声明 kind=group 并细化孩子，已开始叶子不能改容器或删除。

拒绝后使用返回当前状态或重读并修正原因；被拒绝写入不推进 revision，不猜下一版本。
工作未做则先 start 再做；已做但未记录开始时验证结果后 complete，并说明观察证据。
Reconcile 仅用于未开始叶子；两者都不虚构开始/耗时。只有全部后代已完成或同次完成才包括非空 group；
选父项不会完成未选孩子。Complete 不是独立验收，文件存在不证明满足要求。
不为补账制造 start/finish；block 仅用于真实障碍，不用于缺计时。验证叶子只在实际执行获准验证时建立，
不盲目重复非幂等操作。

重命名保留 ID。Group 是容器，不是执行项，不改成 step；工作前细化并 start 其具体叶子。

估时：执行约定确定后，若约定计划包含处理时间范围，在 create/revise 传 estimate:{lower_seconds,upper_seconds}。
不从技能选择或处理预算推导；范围覆盖整个计划（revise 包括已执行工作），排除用户等待，start 后才显示。
Update 省略则保留，null 清除；create/revise 省略则清除范围。估时不等于实测执行时间。

时间由宿主记录，不编造耗时或从流逝时间推断进度。只有观察到的 in_progress 区间给出叶子耗时；
缺计时留空，不记零或回推估计。父子和并行区间可重叠，不相加伪造总耗时。
空组不能完成，完成的父项必须只有已完成孩子。

轮次结束前以执行动作对齐已完成工作，或报告 partial/blocked/failed 及真实原因。
根仍 pending/in_progress 时不宣称整体完成，中途停下需点名未结束阶段。
续做先 get；原生工具绑定当前回调轮次，不重放历史 turn_id。
结束动作属于取得完成证据的轮次。
