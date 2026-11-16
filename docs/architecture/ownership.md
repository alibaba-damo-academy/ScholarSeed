# 跨系统职责与发行边界

需要判断跨包改动归属、允许的依赖方向或公共协议消费者时读取本页。
已经确定 Owner 后转到对应包入口，不为补上下文通读历史提案。
本页只维护跨系统边界；各包的 ABI、实现细节和实际命令不在这里复制。
源码存在不代表功能或发行已验收；验收结论须核对对应产品与制品证据。

## 按改动快速定位

| 改动 / 问题 | 先读 | 边界提示 |
| --- | --- | --- |
| 跨包契约、Provider 发现、依赖方向 | 下方[系统地图与依赖图](#当前仓库地图)、[Runtime README](../../packages/runtime/README.md)、实际 Adapter README 与[Serve 组合边界](serve.md) | 先确定契约 Owner 与消费者；不要把厂商协议或产品策略下沉到通用 Runtime |
| 产品 API、会话、身份、路径或数据 | [Serve AGENTS](../../apps/serve/AGENTS.md)、[Serve 架构](serve.md)、[持久化边界](persistence.md) | 产品组合及路径由 Serve 持有，按具体业务域追加源码和测试 |
| Trace 记录、查询或诊断 | [DamoATrace AGENTS](../../packages/damoatrace/AGENTS.md)、[Engineering guide](../../packages/damoatrace/README.md) | Trace 是只读诊断 Owner；产品事件投影仍属于 Serve |
| Desktop 内部职责、renderer / main / IPC | [Desktop 文档入口](../../apps/desktop/docs/README.md)、[Desktop ownership](../../apps/desktop/docs/architecture/ownership.md) | Desktop 内部细分以局部 Owner 为准，不在本页复制 |
| 发行、安装包、公开准备或制品 | [构建指南](../runbooks/build.md)、[公开准备说明](repositories.md) | 源码目录、发布包边界与外部发布授权是不同问题 |
| 开发 Skill、产品 Skill 或 Prompt | [Skill 边界](skills.md)、[Product instructions](../../apps/serve/service/chat/prompts/baseInstructions.md) | 文档内源仓的开发 Skill 是开发流程真源，`skills/community/` 是产品资产；不得互相替代 |

快速阅读约定：本页提供跨系统职责、依赖和决策边界；上表链接到具体 Owner，机制、配置、验证命令及产品验收留在这些 Owner。普通单 Owner 改动直接从根索引或已匹配 Skill 进入，不需通读本页。

## 当前仓库地图

| 位置 / Owner | 主要职责与契约 | 不负责 / 禁止越界 | 深入入口 |
| --- | --- | --- | --- |
| `apps/desktop/` | Electron/React 产品前端与本机原生宿主；HTTP/SSE 消费 Serve，原生能力经 main/preload 受控暴露 | 不拥有 Serve 业务或 Python 包边界；Renderer 不直接获得 Node/Electron 能力 | [Desktop 约定](../../apps/desktop/AGENTS.md)、[局部分层](../../apps/desktop/docs/architecture/ownership.md) |
| `apps/serve/` | `scholarseed` 发行与 `service` namespace；产品配置、用户/项目、凭据、持久化、业务 API/SSE 和组合根 | 不拥有厂商协议实现、通用 Provider 契约或 Trace 存储 | [Serve README](../../apps/serve/README.md)、[bootstrap](../../apps/serve/service/bootstrap.py) |
| `packages/runtime/` | `scholarseed-runtime` / `scholarseed_runtime`；厂商中立公共 contract、Provider 发现与通用 Gateway | 不实现 Agent loop、产品策略或任何厂商协议；不解析产品用户目录 | [Runtime README](../../packages/runtime/README.md) |
| `packages/adapters/codex/` | `scholarseed-codex` / `scholarseed_codex`；官方 App Server 原生协议、进程执行、认证发现及权限映射 | 仅依赖 Runtime 公开 contract；不依赖 Serve/Desktop，不拥有产品认证、会话或 UI 逻辑 | [Codex README](../../packages/adapters/codex/README.md) |
| `packages/adapters/dsh/` | `scholarseed-dsh` / `scholarseed_dsh`；预留独立边界 | 当前没有 Provider/Session 或可运行 entry point，不可描述为已接通能力 | [DSH README](../../packages/adapters/dsh/README.md) |
| `packages/damoatrace/` | `damoatrace`；独立持有 Trace 记录、存储、路径、查询与诊断入口 | 不依赖 Runtime、Adapter、Serve 或 Desktop；查询不修改产品会话、工具状态或业务记录 | [Trace 约定](../../packages/damoatrace/AGENTS.md) |
| `skills/` | 产品技能源码与构建输入 | 不是开发宿主工作流 Skill 真源；开发 Skill 只维护于 文档内源仓的开发 Skill | [产品技能适配](../../skills/ADAPTATION.md) |
| `packages/ui/` | OpenUI 声明式注册/Schema/Renderer；另保留隔离可执行插件的资源 SDK | 声明式只消费注册组件与宿主 scoped ports；可执行代码仅走隔离桥接，不持有业务权限 | [对话 UI 与隔离资源](../../packages/ui/README.md) |
| `scripts/`、`tests/` | 开发构建工具及跨包集成/发行门禁 | 不作为产品领域业务 Owner；检查通过仅覆盖其明确契约范围 | [构建指南](../runbooks/build.md)、[开发入口](../runbooks/development.md) |

根 [pyproject](../../pyproject.toml) 是 `package = false` 的 uv workspace 编排，
不是一个可安装 wheel。成员的发行名、namespace、依赖和包数据以各自 pyproject 为准；
Desktop 构建产物不因目录位于 monorepo 而成为 Python 发行内容。
版本与 workspace 成员变化时更新真实声明，不在本页维护一份版本常量镜像。

历史材料提及的根 `service/`、`ui/veda/`、`work/scholar/`、`account/` 或根子模块布局
不是当前源码 Owner，须从上表定位现行 `apps/`、`packages/`、`skills/` 与 `tests/`。
被忽略的 `build/`、`*.egg-info` 与 bytecode 可能留有已删除 Harness 的产物，
不能视作源码；发行包须由[构建 Owner](../runbooks/build.md)的 `scripts/cd/wheel.py`
及 wheel 内容门禁验证，不能以工作区残留证明发行边界。

Desktop 设计系统只拥有 renderer 通用 UI，不向 Serve 反向暴露 React/Electron 概念。
官方 UI 包以独立构建的浏览器资源归档随产品后端包数据分发；Serve 只校验、固定和提供
归档字节，不执行或导入前端源码。宿主 renderer 与官方包运行时分别构建，不能以共享
构建输入代替独立资源更新。详细组件与依赖约束只维护在 Desktop 局部 docs，
动态组件/token/债务库存由源码生成，不在跨系统正文复制计数或第二套组件名单。

## 依赖与组合

```text
Desktop ──产品 HTTP/SSE──> Serve
                            ├──公共契约/通用 Gateway──> Runtime
                            ├──证据能力──────────────> Trace
                            └──已发现 Provider ABI───> Adapter ──公开 contract──> Runtime
```

Adapter 不导入 Serve/Desktop；通用 Runtime 不依赖厂商 Adapter 或产品业务；
Trace 不依赖 Runtime、Adapter 或 Serve。产品策略不能为了代码复用下沉到通用 ABI，
厂商协议也不能为了便捷直接成为 Serve 的内部调用面。

Provider 发现来自已安装发行包的 `scholarseed_runtime.providers` entry point。
[Gateway catalog](../../packages/runtime/scholarseed_runtime/gateway/catalog.py) 校验
factory、ID/别名冲突与 ABI；不通过 import 副作用或第二注册表发现。
[Serve selection](../../apps/serve/service/chat/runtime/selection.py) 再应用产品 manifest
的启用/默认策略；配置启用但未安装 Provider 是明确错误，不能造空实现通过。
安装 Adapter、允许产品使用与业务验收是三个条件，不互相替代。
DSH 预留包不能被当成已接通能力；不支持的功能应明确 unsupported。

[Binding 校验](../../packages/runtime/scholarseed_runtime/gateway/binding.py) 比较已有绑定
的厂商身份及已声明协议版本/schema 身份，不解释不透明厂商状态；不能从校验成功
推断官方私有数据可迁移或可降级。[Driver](../../packages/runtime/scholarseed_runtime/gateway/driver.py)
保持每个 Runtime session 的单事件消费者，校验序号并关联命令回执/最终结果；
产品多路投影由 Serve 承接，不另外并发消费同一原生事件流来满足前端订阅。

[RuntimeBinding](../../packages/runtime/scholarseed_runtime/contract/binding.py) 记录产品会话、
厂商身份、协议与不透明原生引用，不是模型、权限及凭据配置的冻结快照。
不能用 frozen dataclass 推定全部配置永远不可修改，也不能用配置变化授权迁移
厂商私有身份。变更仍走实际配置/权限 Owner 的受控契约；数据库迁移从现行 schema
幂等升级并保留用户资产，不套用历史提案中不同列名的建表语句。

公共依赖边界由发行包和公开协议保证，不取决于名字里是否含品牌。
用户路径由实际 Owner 解析，见[持久化边界](persistence.md)；Runtime 不推导用户目录。
Provider 的 storage 声明、目录资格、资源租约与准入/重启许可不同，详细限制只维护在
Runtime/Adapter/Serve Owner，不能根据 storage 清单或空闲释放回执直接宣称可安全重启。

## 决策理由与扩展规则

### 公共源码与发布就绪不能混同

企业控制面、部署凭据与内部拓扑不属于公共产品发行，不能为便捷联调回填本仓库。
公开工程知识、开发 Skill、领域约束和门禁随源码一起维护，独立检出及原生 worktree
不依赖内部父仓。内部系统接线、组织/个人信息、协作补充及工作证据不进入公共正文，
按[仓库与知识边界](repositories.md)拆分混合内容，不以目录名决定公开范围。
历史路径投影只是中间审计材料；内部验证成功不授予发布权限，也不证明历史可公开。

导出检查 required files、未知二进制与内容规则，只证明对应检查的范围；LICENSE
存在、哈希匹配或扫描通过不代表第三方代码、字体、图片、技能、模型及二进制的
再分发权已审查。权属或许可证不明仍是发布待决项，工程提案不能替代法务授权。
仓库排除用户资产也不等于已审计历史 refs、LFS、缓存及已有克隆；清理当前树不能
宣称历史秘密消失，凭据处置与历史操作均需另外授权。

[构建契约](../runbooks/build.md)持有包、签名与安装验收边界。最终制品的依赖
闭包、许可证、来源与完整性证据不能仅由源码扫描代替；Apple 签名/公证只证明
相应分发身份，不替代来源追溯。旧方案所选 REUSE、SBOM 格式、SLSA 等级和
签名技术不能不经当前 Owner 决策就写成已实现门禁；缺少相应证明时明确披露，
不因旧方案退役取消供应链风险。公开来源构建、真实模型/工具及恢复流程仍需
各自产品验收，准备仓库同步成功不证明这些已通过。

### Adapter 双向协议与产物观察

产品提交中立模型/权限意图、开发者指令与不透明凭据引用；Adapter 映射原生协议，
输出 Runtime 事件与 callback。产品身份、审批持久化、SSE 与产物登记仍归 Serve，
不通过 Adapter 直接输出产品卡片。凭据材料的契约见
[ModelCredential](../../packages/runtime/scholarseed_runtime/contract/model.py)：短暂使用，
不得持久化或进入运行证据；具体准入/解析时点由 Owner 契约决定，不概括为每次调用相同。

Codex 的[文件观察](../../packages/adapters/codex/scholarseed_codex/files.py) 排除私有、
缓存、临时路径以及 `_` 前缀的工作态目录；目录规则让 Skill 存放日志和阶段产物时
不必修改 Adapter 白名单。交付物不能放在这种工作态目录。仅文件名以 `_` 开头
（如 `_notes.md`）不触发该目录规则，实际过滤以 Owner 常量与函数为准。
文件观察、产品登记和界面呈现是不同边界；当前
[会话活动呈现](../../apps/desktop/src/renderer/src/activity.ts) 的角色过滤不能推广为
所有产物列表都使用同一过滤条件，也不代表目录规则是文件安全授权。

官方会话恢复和认证同步规则直接读 Codex README：不读取/复制私有数据库或 rollout，
不修改官方二进制；兼容范围由 Adapter 持有，准确打包版本/hash 与更新由 Desktop 持有。
不在本页复制固定版本或旧实施阶段声明。支持与不支持能力分别核验，不能以占位实现
或最低公共子集隐藏差异；DSH 保留边界不等于已提供会话能力。

- 公共契约/Gateway、厂商执行、产品组合和证据基础设施分开，才能新增 Adapter 而不改
  通用发现核心，避免把 Codex 或 Serve 的业务策略变成所有 Provider 的硬编码要求。
- 删除旧自研 Harness 不等于恢复一组转发包：不重建 `damoagent`、core/work/sdk/bench
  或旧 facade/第二注册表；真实定义迁到 Owner 后同步消费者，不留下兼容空壳。
- 目录、发行名和导入名是不同契约。源码迁移不自动授权用户数据迁移、native thread
  私有恢复或公共包发布；不能复制历史实施方案中的路径与发布许可。
- 企业控制面、部署资产、DamoCli 与 Lattice 不属于本仓产品代码；只维护本产品需要的
  消费契约，不带回外部服务拓扑或其他产品的实现和 launcher。

## 验证与维护

### Trace 消费与诊断正文

Trace 的记录、存储、查询和路径由独立包持有，产品 action 数据只经显式路径或 Port
接入；查询不得改会话、工具状态或产品记录。内部规则和查询入口直接读
[包指南](../../packages/damoatrace/AGENTS.md)，诊断编排用
[Engineering guide](../../packages/damoatrace/README.md)，结论关联真实 evidence/span，
不绕过其查询契约直接解析存储来取得有利结论。

诊断正文的采集授权与查询展示是两层控制：CLI 的 `--full` 仅增加字段，
不等于授权读取正文；`--include-content` 显式选择未过期内容，
[内容投影](../../packages/damoatrace/damoatrace/recording/content.py) 仍隐藏过期块。
不能从参数名推断采集已经获准，也不能恢复过期或原本缺失的数据作为验收证据。
历史品牌环境变量是否保留，以真实配置 Owner 为准，不因旧 Harness 删除机械重命名。
环境变量契约归实际读取方，不按注入方品牌统一改前缀。产品启动默认值由
[brand](../../apps/serve/service/brand.py) 在路径消费者导入前投影，使用 setdefault
保留显式配置；Trace 与 Codex 自有环境契约仍由各自 Owner 解释。旧更名表中的
DAMOAGENT 名称不构成恢复旧 Harness 或静默兼容双读的理由，更名也不授权目录迁移。

产品采集策略归 [RecordingService](../../apps/serve/service/chat/service/recording.py)：
无设置时默认 detailed，明确关闭仍优先；不要将 `RecordingPolicy()` 的 metadata
冻结哨兵也改为 detailed。[Capture](../../apps/serve/service/chat/runtime/capture.py)
同时要求本次冻结策略与当前策略 active、revision 相同，默认策略不授权补录历史。
关闭采集、清理本机正文与已导出包是不同生命周期，不以查询开关替代采集策略。

[详细导出](../../apps/serve/service/chat/service/diagnostics.py) 需先预览并明确确认，
校验签名、用户/会话、策略修订、到期时间与文件 watermark，记录或策略变化需要
重新确认。Trace 的块/轮/会话/共享容量及保留期限由内容 Owner 持有，不复制成
产品常量；缺失、截断、到期或淘汰须如实显示，不恢复原本未采集的内容。
导出快照只有在 [manifest 完整性核验](../../packages/damoatrace/damoatrace/recording/diagnostics.py)
通过后按 exported_at 投影；普通 JSONL 不因“离线”而绕过正文到期限制。
默认 detailed 不是外部分享授权，脱敏也不保证所有个人信息已经消失。

模型桥接观测属于 [Serve streams](../../apps/serve/service/chat/service/streams.py)，
不是 Trace 包的模型执行机制。上游 SSE、ASGI send 与消费者解析是不同观察面；
发送成功、HTTP 200、EOF、事件数下降都不单独证明模型终态成功或端到端提速。
流转换、脱敏和终态判据见[模型桥接流](../runbooks/streams.md#观察面与终态)，
修改时在该 Owner 核验，不用 Trace 查询成功代替产品协议验收。

产品证据由 [SessionTrace](../../apps/serve/service/chat/runtime/evidence.py) 显式投影，
当前接点使用独立包的 `EvidenceWriter` 写文件；不能将旧设计中的 Product Evidence
Journal、outbox 或异步 SQLite Ledger 当成已实现的可靠交付。业务 Owner 的提交、
原生执行方的确认、Renderer 呈现和 Trace 落盘分别证明，不用日志存在代替业务成功。
历史事件名或缺失观察也不能证明业务从未发生。

当前 Trace batch 记录失败会锁存不完整证据，checkpoint 检查失败计数并调用 writer
的文件 fsync；失败不得视为可安全释放资源的水位。恢复只表示后续记录重新可写，
不会补齐此前缺失事件或重执行业务。默认 evidence completeness 为 partial 并列出
缺口，不能把可查询、正常退出或恢复告警消失当全链关联完整。文件同步源码本身
不证明跨平台断电恢复、产品事务原子性或全部原生操作呈现已验收。

### Runtime Gateway 与外部 LLM Gateway

Runtime Gateway 是本仓的 Provider 发现与命令/事件驱动层，不是企业 LLM 网关。
企业 LLM Gateway 的实现、数据迁移和部署资产由外部企业仓拥有；本仓只维护
产品配置、认证与模型协议消费。两者名称相似不能成为引入企业实现的理由。

产品启用与连接政策由实际 [product manifest](../../product.json) 和
[Desktop 资源 manifest](../../apps/desktop/resources/product.json) 声明；不在本页复制
端点、部署拓扑或凭据。Serve 的[上游调用边界](../../apps/serve/service/chat/service/completions.py)
持有产品侧连接与调用时凭据处理，Adapter 持有厂商执行协议；不能从 manifest 存在
推断模型授权或连通性通过，也不能把旧部署文档的分支与命令当作当前操作授权。

企业内部实现变更在对应仓库进行；本仓不创建 `llm_gateway/`、`deploy/` 或兼容副本。
托管账号服务的数据库、管理员 SPA、RBAC 与迁移也不属于本仓；不能把旧 `account/`
的 PostgreSQL/Alembic 方案用于替换 Serve 的本地业务持久化。本仓仍消费账号服务的
登录交接和信任协议，[AccountTrust](../../apps/serve/service/identity/service/account.py)
负责本地验签与吊销缓存，[handoff](../../apps/serve/service/identity/api/handoff.py)
负责现有交接 API。外部实现退出不等于可删除这些消费者或放宽用户/管理员令牌隔离。
[发行边界门禁](../../tests/release/contract_package_boundary.py) 包含 Git 跟踪目录检查，
这与检查本地目录不存在、真实 wheel 闭包及模型调用成功是不同证据，不能相互替代。
产品侧消费契约或外部仓库归属改变时更新本边界，外部运维流程不复制到本仓。

公共契约/发现改动选 [Gateway 契约](../../tests/contract_runtime_gateway.py)、
[Driver 契约](../../tests/contract_runtime_driver.py) 及受影响 Adapter/Serve 消费者。
发行边界必须检查[真实 wheel 边界](../../tests/release/contract_package_boundary.py)与
[发行检查](../../tests/release/contract_distribution.py)，不能只 grep 源码树。
产品组合改动另做真实 Desktop 流；已安装、healthz 或 Provider readiness 不证明业务回合完成。
这些是按改动选取的验证入口，本知识治理没有执行产品或 wheel 验收。

新增/删除成员、改变 namespace/entry point/依赖方向或跨系统 Owner 时更新本页和
对应包入口；机制细节回写 Owner，任务证据归 `work-records/`。
冲突时核验源码、规范、后续决策和验证证据，不把“代码优先”解释为自动取消安全规则。
