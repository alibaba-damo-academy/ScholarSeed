# scholarseed-runtime

外部智能体 Harness 的中立接入协议与 Gateway。此包不实现 Agent 循环，不依赖书深后端、桌面端或任何厂商 Adapter。

`RuntimeOpenNotAppliedError` 是首次打开的负证明：Provider 独占领取 reservation、尚未调用
原生会话创建且自身资源清理完成后才能抛出，并携带 reservation 身份。取消、创建回执丢失、
清理失败都不符合该契约。它是可选的加法契约；其他错误不提供安全重试保证，ABI 不变。

`contract.incident.RUNTIME_TURN_NOT_SUBMITTED` 是 Turn 的明确负证明错误码：执行器
证明该命令未尝试写入，或供应商明确未受理时，才能在 `TURN_FAILED` 的 `safe_error`
与 `error_code` 中报告。`USER_RETRYABLE` 本身不是未提交证明；已尝试写入但缺少
受理结果仍须 `TURN_UNKNOWN`。此错误码不授予自动重试权限，不改写历史未知结果，
也不代替宿主的准入和安全检查。
`CommandReceipt.ACCEPTED` 或产品已记录输入，不能单独作为供应商已受理 Turn 的证明。

## 代码入口

- `scholarseed_runtime/contract/`：Provider、Session、命令、事件、审批回调、能力声明与会话绑定等公开数据契约。
- `scholarseed_runtime/gateway/catalog.py`：从已安装发行包的 `scholarseed_runtime.providers` entry point 发现 Provider，检查 ABI、重复 ID 和别名。
- `scholarseed_runtime/gateway/driver.py`：单事件消费者、绑定与序号校验、命令回执及最终结果关联。

产品 manifest 的启用策略、用户认证、消息队列、SSE 和数据库不属于本包，由 `apps/serve/service/` 持有；Codex 的原生协议与进程执行由 `packages/adapters/codex/` 持有。

`ModelCapabilities.native_web_search` 可声明模型连接能否执行服务端原生搜索；
`None` 表示未声明，`False` 表示明确不支持。宿主经模型桥转换协议时，应传递实际上游
的能力，不能用桥的入站协议替代。此声明不限制由宿主执行的普通函数搜索或浏览器搜索。

`ModelCapabilities.native_agent_messages` 声明连接是否支持原生多代理通信输入；
`None` 保持供应商默认，`False` 要求 Adapter 使用兼容的本地工具协作协议，
不代表禁用子任务。声明同时属于模型目录项与当前模型意图，参与冻结目录和重配置身份；
不授权转换密文或改写已持久化的历史。

## 接入一个 Harness

可选 `contract.provider.RuntimeHostReconfiguration` 与 `host_reconfiguration` 能力用于
产品授权意图驱动的共享 Host 配置切换。宿主先封锁新根任务并排空附件与执行资源；Provider
证明旧物理进程退出后，原子解除配置锁并初始化指定目标。普通 reserve/prewarm 与
release_idle_resources 不自动切换；未知退出或写入继续围栏，不能伪称回滚。
该加法协议不改变 ABI，APPLIED 不证明模型真实回合成功，也不创建 Session/Turn。

可选 `turn_confirmation` 能力与 `contract.session.RuntimeTurnConfirmation` 提供未知提交的
两阶段风险确认，不改变必选 SPI 或 ABI 6。精确目标包含产品/原生会话、client、incident
及故障代次；ticket 绑定执行器实例、活动修订和观察水位。Gateway 等待该水位持久投影后
才提交确认，消费失败则拒绝。APPLIED 仅证明该次提交的准入歧义已由执行器安全解除，
不证明原提交已成功、失败或未执行，也不授权重放。产品决策与确认凭据由 Serve 持久化。

可选 `thread_replacement` 能力与 `contract.session.RuntimeThreadReplacement` 提供原生
线程不可恢复后的两阶段封闭端口。目标包含完整 binding、产品 command、当前线程恢复
失败 incident 和原故障代次；`ThreadReplacementProof` 保留准确缺失代次及观察水位。
Gateway 核验身份并等待原观察水位投影，产品在提交票据前持久化替代围栏。APPLIED 仅证明
旧附件已封闭、原执行进程已实际退出收尾，不证明旧 Turn 未提交、未执行或结果已确定。
它与 `EmptyThreadReplacementProof` 的未提交负证明独立，不解除原未知结果，也不授权
重放。产品负责候选创建、原子绑定切换、上下文重建及有界续作；旧能力缺失时明确拒绝。
此可选加法契约不改变必选 SPI 或 ABI 6，真实跨平台故障恢复仍需产品验收。

可选 `contract.provider.RuntimeHostWarmup` 与 `host_warmup` 能力支持应用启动时预热
Host；`contract.command.HostWarmupRequest` 必须显式声明共享授权域，仍使用原有模型及
秘密端口。APPLIED 仅证明 Host 协议初始化，不创建 Session/Thread/Turn，不证明模型
调用成功或上游认证有效。健康 Host 可独立于附件驻留，退出仍由显式排空和 shutdown
协调。本加法协议不改变必选 Provider SPI 或 ABI 6；未声明能力时不隐式调用。

`shared_host_control` 声明无 Thread 控制也复用执行 Host。盘点和技能配置请求的可选
`host` 必须包含真实授权域与完整 `HostWarmupRequest` 启动意图，缺失时不得推断匿名
身份或选取任意现存 Host。`RuntimeInventory.host_identity` 是用于缓存核验的非授权
身份/代次标记；宿主每次使用缓存前仍校验完整意图，不解析或持久化兼容摘要。
声明此能力的 Codex 不接受独立的盘点 launch_secrets；秘密只从完整 host 意图解析。
共享配置忙时返回 `runtime_host_busy`；写入结果无法确认时保持围栏并返回
`runtime_host_configuration_uncertain`，其他配置发布不得清除该失败。

`ResourceReceipt.safe_error=runtime_host_configuration_conflict` 表示请求与驻留执行
Host 的进程上下文不兼容，Provider 拒绝准入，未授权创建另一执行进程、驱逐已有
资源或中断其他工作。预热可返回 `RESTART_REQUIRED` 及同一安全码；此回执不是重启
许可，宿主必须另走明确确认与完整排空。回执不携带凭据、环境或兼容摘要。

ABI 6 的 Provider 必须提供无副作用的 `storage_roots()`，返回不可变的
`StorageRoot(path, create)` 元组：path 为绝对 Path，create 必须显式给出布尔值，
只声明宿主是否可以准备缺失目录结构，不允许改写已有权限或据此读写数据。
共享同一路径时，只有所有声明均允许创建才允许准备；否则缺失须报错。
无持久状态时显式返回空元组。声明在配置/执行前调用，不得创建目录、
启动进程或准备认证。Catalog 检查所选 Provider 的声明，旧 ABI 或缺少声明明确拒绝。
`storage_roots(inspection)` 是取得根资格后的只读发现阶段；Provider 只能通过公开的
`StorageInspection.selected/read` 读取已选择目录中的有界文件，未选择的源先返回
目录声明，供宿主下一轮获取资格。无参数阶段不得打开持久文件。两阶段均不产生业务写入。
Catalog 的 `inspect_storage` 同时记录读取源的路径、存在性、长度和 SHA-256，返回
不可变 `StorageInventory`；同次发现重复读取同一文件时若内容改变则拒绝。Provider
拿到的只读视图在同步发现调用结束后失效，宿主继续拥有底层目录资格。指纹用于发现
快照比较，不是旧版本读取兼容证明，也不应写入公开诊断日志。
这些路径只是清单，实际目录占用、数据格式验证和根变化后的重验仍由宿主协调；会话
工作区由宿主单独提供，不能把目录声明视作重启许可。

当前 Provider 配置可注入物理资源租约工厂；Adapter 在创建原生资源前取得租约，
仅在确认 OS 生命周期结束后关闭，不能以最后一个请求返回代替释放。
`release_idle_resources` 只释放无主且确认空闲的资源，返回 APPLIED 表示本次检查无资源残留；
它不会永久关闭 Provider，也不关闭新工作准入。调用方必须独立协调准入和其他活动，
不能把此回执直接当成应用重启许可。最终 `shutdown` 保持独立语义。

独立 Adapter 实现 `contract.provider.RuntimeProvider` 与 `contract.session.RuntimeSession`，并在自身 `pyproject.toml` 注册工厂：

```toml
[project.entry-points."scholarseed_runtime.providers"]
example = "example_adapter.provider:provider"
```

工厂 descriptor 的 runtime ID 必须与 entry point 名一致，ABI 必须等于宿主当前版本。真实能力通过 capability 声明；不支持的能力明确返回 unsupported，不模拟实现。

## 边界与验证

Open/Resume 请求的可选 `process_sharing_scope` 由可信宿主声明进程共享授权域，
不替代 `execution_scope`、产品会话或原生会话身份。空值不授权跨 execution scope
共享；非空也不是强制共享要求，Provider 仍须核对平台、认证与进程配置兼容性，
不支持时保持独占。共享域不是凭据，也不能用于推导或合并权限；凭据值变化仍须
通过原有安全端口解析并重新准入。此加法意图不要求旧 Provider 实现复用，ABI 不变。

Open/Resume 的 `execution_environment` 只承载非敏感会话工具配置（例如会话私有编译
缓存），不改变 Host 启动环境，也不授予目录或网络权限。凭据仍通过 `launch_secrets`
与 `secret_port` 传递。Provider 必须保留恢复时的执行配置与原有环境继承安全语义。

`OpenSessionRequest` 区分 `required_capabilities`（不可用时拒绝）和
`optional_capabilities`（按实际模型/供应商协商，不支持时不启用）。两者不得重叠；
取消、凭据或进程故障不是“不支持”，仍需传播并收尾。Session binding 的能力集记录
实际启用状态，独立的 `optional_capabilities` 保留需求强度，恢复时不得升级为 required。

发行名为 `scholarseed-runtime`，导入名为 `scholarseed_runtime`；没有 `damoagent` 兼容转发层，也不初始化用户路径。仓库根的 `tests/contract_runtime_gateway.py`、`tests/contract_runtime_driver.py` 检查通用机制，发布门禁检查 wheel 内容；真实产品验收仍需运行书深桌面端。

Windows 沙箱资源端口 `prepare(local_group, *, cwd)` 必须携带本次执行 cwd。
ABI 6 不兼容旧宿主回调，Runtime/Codex 0.2.1 需成套交付；路径与 ACL 策略仍由宿主拥有。
