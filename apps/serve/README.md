# apps/serve — 书深产品后端

FastAPI 后端与产品组合根，distribution 为 `scholarseed`，namespace 为 `service`。

## 职责与边界

- `bootstrap.py:create_app` 装配业务域；`chat/api/routes.py:create_chat_app` 装配会话服务。
- 管理项目、资料、文献、工作台、上下文、会话、凭据、技能、产物和 SSE。
- `chat/service/adapters.py` 解析产品 manifest；`chat/runtime/selection.py` 将产品启用策略应用于 Runtime Gateway 发现的 Provider。
- `chat/runtime/` 将产品状态与 Runtime 公共契约组合，投影并持久化产品事件。
- Runtime contract/Gateway、Codex 执行器和 Trace 分别由独立包拥有；Serve wheel 只打包 `service`。

跨业务域协议位于 `platform/`，实现由组合根注入。项目路径经 `ContentPort` 解析；项目业务库统一通过 `persistence/project.py` 打开。

## 入口

| 命令 | 作用 |
| --- | --- |
| `scholarseed` / `scholarseed-desktop` | 启动 Electron 桌面产品 |
| `scholarseed-serve` | 启动后端，默认绑定本机回环地址 |
| `scholarseed-bridge` | Agent 调用产品能力的受控桥 |

Desktop 固定以 `auth-mode=off`、`ownership-axis=machine` 启动；独立 Serve 支持显式认证模式。模型连接的凭据与本地 HTTP 访问模式独立。

## 匿名技能广场

`capabilities/service/clawhub.py` 持有在线市场读取与下载契约，默认连接
`https://scholarseed.damo.alibaba.com/skillhub/`。启动时可通过 `SCHOLARSEED_CLAWHUB_URL` 指定另一个
HTTP/HTTPS base URL，可带无歧义子路径，尾斜杠统一去除；不接受查询参数、fragment、URL 内凭据、
点路径、编码路径分隔符或空白。所有初始列表、搜索、详情、版本及下载请求保留 base path；
下载 Location 按当前请求 URL 解析；仅来自该 base 的后端根相对 `/api/v1/skills/...` 跳转
补回 base path，已带前缀的路径不重复添加。其他根相对路径、绝对 URL 和白名单下载保持原解析规则，
信任校验仍比较 origin 而非 base path，不将来源等价集合用于下载授权。
只使用网关后端接口，不依赖 SkillHub 前端或修改集群配置。修改部署环境后重启应用，
不覆盖用户账号、模型或技能配置。HTTP 不能保证传输完整性，生产服务应使用 HTTPS。

Desktop 经既有设备技能桥访问 `/api/capabilities/skills/marketplace` 的列表、详情及
固定版本安装路由；仅使用宿主本机能力，不需要账号登录，不向市场传递该能力或
书深身份。独立 Serve 仍遵循自身认证策略，不能从匿名远端读取推断所有本机 API 公开。

此部署的匿名 ClawHub 兼容接口返回 `nextCursor`，下一页请求以 `page` 参数传回，
并提供关键词搜索、技能详情及下载。`namespace--slug` 兼容身份解码后读取对应
namespace 的公开版本元数据，未带命名空间的身份使用 `global`。服务实现或协议变化
需要核对该契约，不回退到旧构建用 Registry 的登录/Token 流程。

下载保留服务自行发放的匿名 Cookie，同源跳转后只允许 HTTPS 下载主机白名单。
`SCHOLARSEED_CLAWHUB_DOWNLOAD_HOSTS` 可用逗号分隔覆盖默认 OSS 主机
`deep-rd.oss-cn-hangzhou.aliyuncs.com`；跨域请求清除 Cookie，不转发任何用户凭据。
请求、JSON 和归档都有超时/体积/跳转限制；可疑或恶意标记拒绝安装，缺扫描不当作安全。
远端正文只展示，不执行脚本或声明的操作。

安装复用用户技能安装器，拒绝跨平台路径穿越、符号链接与同名覆盖，在用户技能根的
`.origin.json` 保存市场地址、slug 与版本，经现有原生 inventory 配置链刷新发现。
安装渠道与包内上游来源独立：上传、广场安装、创建及 GitHub 导入入口在产品技能状态中
记录 `installationSources`，列表以 `installationSource` 返回。上传 ZIP 自带的旧
`.origin.json` 不改变本次上传渠道；无可信历史记录返回 `unknown`，不按缺少来源记录
推断为上传。删除用户技能同时清除该渠道记录，系统预置卡片始终展示“官方”。
安装项属于“我添加的”，不混入随包技能，也不绕过其后续依赖或第三方授权要求。
“我添加的”按界面语言读取已映射 SkillHub 来源的元数据，标题复用其 `displayName`，
与技能广场保持一致；远端缺少标题或不可用时保留本地名称，不改写技能身份及安装记录。
内置 `find-skill` 以部署中的 `skillhub-registry` 为原型，保留上游来源，使用模型工具
`scholarseed_bridge` 的 `skill/search`、`detail`、`list`、`document` 读取市场和本机技能。
`install`、`enable`、`disable`、`update`、`delete` 复用同一 capabilities 管理服务，
不要求安装外部 CLI，不开放模型指定的 registry、安装目录或远端发布。
写操作必须经过当前回合的真实确认卡，并在执行前重查权限与上下文；同回合相同
`client_op_id` 重试复用已完成回执，换目标或参数必须换 ID。安装使用固定版本，
升级检查原来源与预期旧版本，预置不可删除、必需技能不可停用的约束不变。
写入后应通过 `skill/list` 核对本地状态，不把安装、启用、当前可用和当前回合已加载混同。
只有来源地址与 slug 一致才显示已安装；Serve 提供 `registryAliases`，仅将旧默认
`http://120.26.99.45` 与新默认地址视为同一目录（忽略尾斜杠），避免切换后重复安装。
其他环境覆盖地址、同源不同子路径保持独立，不按主机名或技能名称合并；旧来源记录不重写，
新安装记录规范化后的完整 base URL。来源等价不扩大下载 origin 或白名单信任。

技能归属展示复用包内与 SKILL.md 同目录的 `registry.json`，不是 SkillHub 发布账号。
广场列表按 namespace、原生 slug 和已发布版本读取版本文件；详情读取选中版本。
Serve 统一投影 authors 与 GitHub 来源，卡片作者栏显示可点击的 owner/repo，
原作者声明、技能目录、revision 与改编类型在详情展示。已安装项直接读取本地登记，
不复制作者到 `.origin.json`，不为旧安装联网补全；缺失、无效或读取失败不会回退到发布者。
登记只用于展示，不证明作者身份，也不改变标签、审核或安装准入。远端文件受体积和并发
限制，逐项失败不影响其余目录；不为展示下载整包或访问 GitHub API。

本地上传先经 `POST /api/capabilities/skills/upload/preview` 校验并读取 name、description、
正文、版本及作者，预览不创建安装记录；用户确认后调用原 upload 路由并重新校验。
只接受 SKILL.md 或根目录／唯一一级目录内含唯一 SKILL.md 的 ZIP；必填 name、description
和说明正文。上传不限制 ZIP 压缩文件大小，但仍限制说明文档、展开体积和条目数量，拒绝
路径越界、特殊／加密文件及重复路径。上述校验和预算仍覆盖 macOS 元数据；通过校验后，
预览与安装共同排除 `__MACOSX` 目录、`.DS_Store` 和 `._` 前缀的 AppleDouble 文件，
不将其计作技能目录或写入安装结果，其他隐藏文件保留。相同稳定 name 冲突不覆盖；运行时状态同步失败
删除本次新增安装，不触碰已有技能。产品默认策略不再锁定 fast-search，所有内置技能可停用。

上传预览仅按技能根目录是否同时存在 `.scholarseed-package.json` 和
`.scholarseed-plugin.json` 区分卡片插件包，不解析两者内容。上传弹窗不展示技能详情预览，
也不显示独立的插件检查按钮；普通技能点击安装直接安装，插件点击安装自动检查后显式授权。
缺少包清单时，上传仅安装普通技能，不保留可被宿主发现的插件声明，也不加载卡片。
仅有包清单不触发插件校验；同时声明两者时，卡片安装必须经过既有插件校验与权限确认，
不能通过普通上传绕过。普通上传仍校验 SKILL.md、解压安全和同名冲突。

Desktop 反馈由 Main 直接提交远端，不依赖 Serve 存活。`POST /api/serve/feedback/bundle`
复用反馈附件校验、会话作用域与日志预算，只返回诊断 ZIP，不创建托管凭据或提交远端。
独立 Web/Serve 的原提交接口保持不变；Desktop 收集失败时明确降级为部分诊断。

会话目录 `GET /api/serve/sessions` 保留每页最多 500 条，按最后活跃时间倒序、同时间戳按会话 ID 排序。
响应的 `next_cursor` 非空时，保持原 scope/project/query 并传入 `cursor` 继续读取；空值表示结束。
游标只标记排序位置，每页仍重新执行归属与项目校验；非法游标返回 422。
`total` 保持既有有界候选批次数语义，不代表全库总量。分页不提供并发修改时的冻结快照。

## 全文授权桥

`literature/authorize` 与综述检索检查点共用 Assistant 授权 Owner 的
`authorize_sources`：发布产品 HIL 并等待真实决策，不把待确认的 `question`
交给模型转述。模型工具与 CLI 将全文授权登记为长等待操作，不设固定读取超时，
由用户决策或任务取消结束等待；连接、写入及普通请求的超时限制保持不变。
响应的 `ok` 不等于授权；只有 `disposition=authorized` 时，
`granted_refs` 中的文献才可继续读取。已决范围复用原决策，新增范围仍需授权。
授权等待后重新核对调用作用域与任务身份，逐篇读取仍独立检查授权，不自动激活任务、
猜测授权类型或放宽托管全文访问限制。确定性回归见 `tests/contract_literature_bridge.py`
及 `tests/contract_fulltext_gate.py`；真实模型与 Desktop 验收另行执行。

整条文献作为显式任务引用时，其所属附件可通过 `literature/read` 的
`attachment_id` 按需读取；仅打开或选中某个附件时不据此授权其他附件。
`literature/list` 返回全部关联附件标识，`readable/error` 仍只描述主 PDF。
PDF 沿用页码与片段引用；UTF-8 文本附件使用 `start_page=1/end_page=1` 和
字符 `offset/limit` 分段返回，`next_offset` 为空表示读完。文本来源链接回到
所属文献附件列表，不伪装为 PDF 片段引用；其他格式明确返回不支持。

## 文献交付测试边界

文件名规则由 [domain/utils.py](service/literature/domain/utils.py) 持有，
[contract_filenames](tests/contract_filenames.py) 在显式审计作用域内装载
[filenames](tests/filenames.py) 并执行全部4项业务用例，使用独立字面量预期与输入不变断言，
不构建项目、数据库或运行时；故意替换错误清洗规则时原断言必须失败。
入口拒绝业务用例的skip/expectedFailure；[logic guard](tests/logic.py) 同时覆盖模块装载
与执行，异常退出恢复审计激活状态和bytecode设置，负向测试核验导入、后续分支及入口接线。
该设施检查Python审计事件，不是安全沙箱；业务用例文件不作为独立测试入口。
在 `apps/serve` 下用 `../../.venv/bin/python -m tests.contract_filenames` 可独立执行。

[contract_literature_delivery](tests/contract_literature_delivery.py) 保留真实SQLite、项目保存、
冲突及重试断言；试点额外通过 [delivery fixture](tests/delivery.py) 在独立子进程中绑定
各例Home，验证同业务键的并发隔离、新进程重开读回、错误摘要拒绝与setup/执行/清理失败。
fixture通过公开目录选择接口持有真实DirectoryHandle，收尾时先关闭service，再在子进程
退出前核验POSIX fd为EBADF或Windows原生句柄为无效句柄，输出release_proof；不能仅依赖
closed标志或进程退出。遗漏close必须失败，实际释放失败与业务失败并发时保留两者诊断，
fixture最终尝试释放自己持有的资源，不把恢复释放报告成原操作成功。Windows原生分支须另机验证。
fixture只模拟外部PDF下载，业务服务、入库与文件保存不模拟。可变目录由创建者在子进程
退出后清理；旧套件的模块Home也在收尾时释放，并恢复原环境选择。
两套件均登记在 [run_all](tests/run_all.py)，定向执行不代表完整CI或真实Desktop验收。
首次会话启动只有匹配 reservation 的 `RuntimeOpenNotAppliedError` 才能回到可重试状态。
Catalog 按 session、attempt、OPENING 且无原生 binding/vendor 身份原子重置，保留原消息及
attempt 记录；下一次重试生成新 attempt。真正未知结果、取消、清理失败和历史
OPEN_UNKNOWN 不自动清除；数据库提交失败也不解除打开围栏。

同一 Turn 提交的传输未知与进程退出未知按精确会话、命令和代次归一为一个待结算边界，
优先保留提交歧义 incident 的权威恢复关联；两份原始 Trace 均保留。重复报告不解除
未知围栏，不伪造终态；其他身份或矛盾终态仍拒绝。Gateway 消费失败立即记录脱敏
类型和投影序号并停止，不跳过失败事件；正常消费恢复不等于人工确认闭环已验收。
已闭合旧未知的晚到报告不得覆盖后续轮状态，也不清除另一轮的活动身份。

运行中的崩溃恢复先核对原生历史：已完成补回结果且不重发，已中断继续未完成任务，
仍未知则按产品策略授权一次原输入重试，接受可能重复执行的风险。旧结果不改成成功或
未提交，自动授权独立记录，不伪装用户确认。Serve 复用原生确认票据和精确 ledger CAS，
只解除本次 TURN 围栏，保留 HIL、其他操作未知、取消、维护及配置检查。每原始回合只
创建一个持久关联后继，后继再崩溃不生成无限恢复链，启动不扫描历史未知批量重发。
恢复后继复用原冻结上下文及原认领，完成后结算原一次性材料；不能重新冻结而静默丢失
已认领材料。实际 Windows 产品验收及尚未验证项见任务记录，不以此机制说明代替验收。

声明 `turn_confirmation` 的执行器在 UI 风险确认时先经 Gateway 排空观察、取得精确
确认票据并核验投影水位，执行器确认后才按 generation/incident CAS 更新产品账本。
确认凭据与原始 RuntimeEvent 保留在 uncertainty payload，DB 或事件发布失败可按同一
目标幂等重试；持久 typed 确认的补发布不重新触碰原生状态。旧产品-only 确认不被推定为
原生安全证明。HTTP 仍返回 unknown_outcome=true，风险确认不改变旧提交的未知结果。

## 项目启动边界

项目注册表完全为空时，启动恢复完成后通过常规受控创建流程在生效工作区目录下创建
`书深默认项目`（MANAGED 子目录），而不是把工作区容器登记为项目。已归档项目仍算已有项目，
因此仅归档不会在下次启动时生成替身；删除只移除登记并保留本机文件，若注册表随后仍为空，
再次启动会在不覆盖旧目录的位置新建默认项目。

`POST /api/serve/sessions/open` 接受成对的 `fork_session_id` / `fork_turn_id`，
不能混入模型、权限或恢复覆盖字段。Serve 验证源访问、完成轮与当前原生绑定，
继承项目及模型/权限选择，用现有 activation 建立新任务，再导入截点前的用户/
助手文本与完成轮事件；不复制队列、审批或产物写入头。源任务及项目文件不回退，
新的原生结果不确定时仍由原有 OPEN_UNKNOWN 边界处理，不自动重复创建。

MCP 首次盘点必须同时满足宿主工具链已就绪与工作台准入已开放。等待工具链回执时，
由 lifespan 拥有的后台任务继续等待，不阻塞 Serve 启动，也不提前发布失败配置。
工具链准入失败不发布 MCP；退出时取消并收尾该等待任务，不能在应用关闭后继续盘点。

普通原生启动器仅检查客户端核心目录，检查结果以 `projects_deferred=true` 明确标记
项目尚未检查；这一结果不能用于更新迁移或初始化项目存储。Serve 按项目检查登记位置、
项目数据库和外部授权目录，失败时保留登记与失败原因，禁止该项目的业务 I/O，继续启动
其他项目。一次启动内的失败资格不会因目录重新出现而自动变为可用，重新启动后重新检查。

创建、移除及授权恢复先标记各项目的恢复状态，再由受生命周期管理的队列执行。同一项目
恢复保持顺序，失败保留待恢复记录和不可用原因；其他项目可以继续提交操作。恢复上下文
仅能越过本项目的“恢复中”状态，不能越过真实权限或存储故障。更新检查仍要求完整项目
快照及迁移证明，不把普通启动中的项目隔离当作更新兼容性通过。

项目目录使用 `project` 角色，由操作系统检查读取、列举、创建等实际操作权限，允许既有
沙箱共享 ACL，不删改 ACL，也不要求项目所有可写主体都属于客户端私有信任名单。
配置、凭据、协调器及更新控制数据仍使用 `private` 角色。两种角色都保留目录身份、
no-follow/reparse 及原生句柄释放检查；共享同一根的私有数据不能被项目声明降级。

## Windows 打包配置源

Windows 个人安装的打包默认配置源使用精确只读安装绑定：组合根同时核对已加载
模块、运行解释器与默认配置的同根安装布局，原生层保留全部祖先句柄与身份，
安装根及内部每层仍严格检查 ACL。安装根之外的位置风险不作为私有数据目录授权。
该能力只读 `defaults/config.json`，不允许写入、创建、删除或回收，也不能在路径替换
后重新建立信任。普通私有数据、外部配置源及项目权限规则不变；不支持该绑定的
guardian 路径明确拒绝，不降级授权。这不是全用户安装或额外的签名真实性证明。

## Windows 会话目录属性权限

默认会话继续使用 Home/service/sessions/会话ID，不迁移新旧会话。组合根仅将
Home、service、sessions 三个产品目录交给沙箱权限准备，增加目录自身非继承的
读取属性权限；不递归授权、不开放目录列举或私有文件内容，不改 UAC。
私有目录校验接受这种精确元数据授权，文件及继承/内容权限仍严格拒绝。
Home/projects 仍由 Trace ledger 检索使用，不改作会话工作区。
## 启动健康与能力

后台 Runtime readiness 预热同时等待工具链回执与工作台准入，不能在私有通道认证及
工具链回执完成前抢先启动物理探测；工作台准入不代表 HTTP listener 已就绪。公开 readiness 在工具链准备或失败时直接报告
对应安全状态，不先启动探测再覆盖结果；默认工具链已就绪的独立 CLI 保持原行为。
生命周期持有并收尾等待任务，等待期间不占执行租约；实际探测前重新取得 root STARTUP
准入，维护期间不抢跑或互等。关闭时取消并等待实际探测收尾；鉴权、健康截止和失败关闭规则不放宽。

`/api/healthz/backend` 仅报告基础服务、实例身份及存储准入，不等待 AI 探测；
`/api/healthz` 保留完整 Runtime 就绪诊断。两者均受 STARTUP 准入保护，维护期不放行。
会话目录的 `readiness: null` 表示尚未探测，不是执行授权；创建、打开和发送仍使用原有能力校验。
独立 CLI 在组合与存储资格成功后，将只读 Skill Python 验证与 Runtime 就绪探测并行执行；
PATH 仍在主线程提交且早于 HTTP 开放。预热任务由 RuntimeService 持有，
启动失败和退出均等待实际探测收尾。此拆分不证明模型认证或真实回合已成功。

应用启动时，身份已确定的 UI 模型目录初始化调度共享执行 Host 预热，不等首次发消息，
也不通过 healthz 轮询反复启动。等待 workbench/工具链时不持执行租约，条件满足后
重新取得 root RUNTIME 准入；身份环境改变则放弃该次预热，后续初始化可重试。
预热不创建产品会话或原生 Thread，使用正常模型连接及凭据投影，准备锁不跨容量等待。
健康 Host 在全部附件释放后继续驻留；已附着 Thread 有产品订阅或执行树未确认空闲时
不自动撤销订阅。无订阅且完整空闲时及时 detach，由原生独自等待默认30分钟再卸载。
被动历史 SSE 不隐式启动或恢复执行；已 detached 的 Thread 经正常授权执行需求加载。
显式维护/退出仍负责排空及真实资源收尾，未取消 Windows 准入与原生制品门禁。
Serve 启动不猜测匿名执行主体，避免登录前的预热锁住错误共享域。执行 Host 配置
冲突在资源准入阶段明确拒绝，经既有会话/队列出口呈现；不触发附件压力回收、不
重试到另一 Host，也不自动拉起确认或重启。预热收到 `RESTART_REQUIRED` 只记录
需要重启，不误记为 host_ready。用户等待任务完成后，通过明确确认的整应用退出/
重启及既有排空切换配置；本轮未新增原地热切换入口。
CONTROL 通过真实请求主体、实际模型和完整启动意图复用 EXECUTION Host；技能、模型、
MCP 盘点不另起 Host，配置冲突明确拒绝。Skill 缓存按主体、经核验 Host 身份/代次和
cwd 分区，每次命中前重新校验启动意图。会话普通读取及 Thread 级 enablement 不触发
全局强制刷新；配置写入和显式刷新须通过共享空闲围栏，未知写入要求明确恢复/重启。
MCP 设置仍要求宿主授权，桥接仍验证当前会话/回合；运行时盘点前额外校验共享主体
启动上下文。启动阶段只提交已有管理配置，不以匿名身份启动盘点进程。
本轮按要求暂停测试与真实 Desktop 验收，不能据此宣布生命周期验收通过。

托管 Desktop 可用 `--await-toolchain` 将 TeX 准备从基础 HTTP 前置拆为 AI 执行前置。
该模式必须使用私有父子进程控制；一次性布尔回执不携带环境或路径。TeX 路径、字体
及缓存环境在 Python 创建前冻结，准备失败或控制通道在回执前断开均禁止 AI 执行，
不回退宿主 TeX。版本探测仍并行；模型/技能盘点等待，资源进程创建再次检查准入。
这是所有 AI 执行共用的保守门槛，不是按技能精确判断 TeX 依赖。重新启动重做准备。

## 崩溃后的安全续作

Adapter 只重建执行器、恢复同 Thread 并提供权威历史；产品 `RecoveryService` 在宿主证据
完整时，经原持久队列创建一次新的系统续作命令，不重发旧 `turn/start` 或工具，也不调用
人工 UNKNOWN 确认。自动续作自身再次崩溃不会自动接龙；此前已完成的原轮只对账。

模型桥在实际向客户端暴露任何工具输出、或向上游授予未知托管工具执行权之前持久记账。
未知/分片/超限输出保守阻断；没有完整桥接证据不能从历史“未看到工具”推断没有副作用。
用户授权的只读 `web_search` 请求仅在组合根登记的精确 Responses 端点和既定声明字段下
允许有界重复查询，可能重复收费，不代表上游尚未执行。Bridge 不跟随重定向，不接受
模型自报 trusted 标记；任意兼容端点、未知参数、MCP 或嵌套托管工具无此豁免。
即使是 `web_search_call`，实际工具输出仍保守阻断原轮自动续作。

进程退出先封住旧流并撤销、关闭、等待其真实 HTTP 消费者；同 Thread 恢复后，还须等待
原执行、资源准备与队列结算 Owner 完成。仅精确 client/native 身份的 interrupted 历史、
完整空闲执行树、无未知操作/HIL、无用户取消/新输入/主体/模型/权限/维护变化才准入。
原用户消息的 admitted→bound 是同一意图；只有 client、正文、引用及上下文快照版本完全
一致的绑定更新才允许，不能让绑定投影误判成新输入，也不能只凭相同 client 放行新正文。
UNKNOWN 对账按持久队列和明确提交身份定型，单边冒充与命名空间碰撞保持未知。

续作提交在 Runtime `TURN_ADMISSION` 能力下绑定代次、活动修订、水位和同步产品授权，
Adapter 与原生 writer 实际写入前复核；上游注册、目的地、协议或主体变化也撤销该授权。
维护、关闭、用户新消息或取消不会在等待后悄悄启动旧续作。续作显示为系统状态而非普通
用户消息，实时、历史、取消及队列均不展示内部提示。由崩溃对账得到的 interrupted 携带
process_exit 原因，不误报用户主动停止；Turn 终态不代替 Adapter 宣布整个进程恢复。
恢复状态也是新轮的显示边界，保留 admitted 起始序号，另记绑定更新序号；历史合并按
会话事件序号及普通用户/恢复轮边界放置旧状态，避免将旧崩溃显示为续作再次失败。

macOS 与 Windows 采用相同授权、持久队列和写前围栏；进程退出与真实产品流程分别验收。
受控故障不冒充 Windows.Globalization.dll 原生故障复现，也不代表该 DLL 根因已修复。

## 历史目录续载

`GET /api/serve/sessions` 可显式传入非负 `offset`（首批为 `0`），沿既有身份、Runtime
和项目/未归属过滤后的稳定候选序列续读。`limit` 仍是本批返回上限；`next_offset`
指向下一条未消费命中的候选位置，`null` 明确表示耗尽。搜索保留标题、正文及定位信息，
不再只检查前 500 个候选；仅为当前返回批次构建完整行。此模式的 `total` 是范围候选数，
不是搜索命中数，客户端不得据此或可见行数推算后续位置。

省略 `offset` 保留旧调用的上限和 `total` 语义，不返回 `next_offset`。新续载客户端
必须拒绝缺失、非法或不前进的位置，不能将旧服务响应静默当作耗尽。位置不提供跨请求
快照；并发新增、删除和更新时间变化可能移动记录，已知目录变化应重取首批并在追加时去重。
这一实现复用完整授权范围的目录元数据读取，成本随目录规模增长，未新增存储或索引。
契约入口为 `contract_session_listing`；真实 Desktop 与目标平台验收另行完成。

## Trace 启动边界

普通 Serve、原生 `--startup` 及升级兼容性检查仅获得 Trace 目录资格并检查 SQLite 索引，
不枚举、读取或散列历史 JSONL；快照以 `history=deferred` 明确表示历史尚未检查，
而不是完整校验通过。历史追加不参与启动或升级检查的收敛判断。
已获资格并确认 Trace 目录不存在时保留 `history=complete` 的空证据，不创建目录；
这只证明该次快照无历史，不等同于检查了后来新增的诊断记录。

升级不迁移原始 Trace、旧 context ledger 或 FTS 索引，不做历史全量审计或整库复制；
原始历史和旧账本均明确标为延迟检查。候选写入格式仍通过 `trace-write-formats` 互验，
业务数据库迁移投影、目录资格及索引未知格式拒绝不变。显式完整审计仍遵守原有预算，
但不再是升级准入条件。升级通过不证明全部旧诊断数据可解释。

Trace 查询、全文索引及内容改写在消费边界拒绝不支持的诊断格式，查询时权限、I/O
或编码错误明确失败，不冒充无历史。旧账本的实际生命周期投影在按需查询时执行。
已安装旧 source inspector 仍执行它自己的检查；新 candidate 不会修改或绕过旧二进制，
只有两端都采用新边界才解除旧 source 的全量扫描限制。

启动日志的 `bytes_read=0` 仅指历史 JSONL，不代表 SQLite 或其他启动域没有 I/O。
索引只读检查遇到 SQLite 明确的 `SQLITE_READONLY_ROLLBACK` 时，仅记录待恢复状态。
普通启动通过既有原生排他目录维护，以 `mode=rw` 打开既有索引并让 SQLite 回滚，
随后重新只读检查并证明启动快照收敛；不手动删除 journal、重建索引或调整权限。
原生启动预检不写入，升级兼容性预览和显式完整审计仍拒绝未恢复的索引。
其他权限、IO、损坏和格式错误不会被归为可恢复，文件绑定变化亦明确失败。
首次实际写入 Trace 时，现有内容配额维护仍可能扫描历史；本层解耦不改变保留策略，
不删除历史、不重建索引，也不将这项写入成本描述为已消除。

### 初始化与停止的绑定边界

首次原生初始化成功但产品尚未领取任何提交时，绑定持久化为 `unsubmitted`。
停止仍取消未提交消息，并等待受保护初始化和清理结束；等待期间保持
`interrupting`，不能将取消请求当作已完成。Windows 回合前刷新、空闲回收或
重启之后，这种有明确未提交证据的绑定走现有 CAS 替换，新建空原生线程，
保留产品会话和取消记录，不把取消消息作为原生历史重放。

领取消息进入 `submitting` 与绑定转为 `bound` 在同一事务完成，先于任何可能的
原生执行。跨过此边界即不再视为空线程；未知提交、已有历史和旧版本的 `bound`
绑定仍按原身份恢复，不能因缺少 turn ID 或恢复错误自动重建。未确认的 open
仍为 `open_unknown`，不以初始化完成标记补造可恢复证明。
macOS 正常驻留附件继续复用；仅重新激活明确未提交的附件时采用上述替换。
状态不读取原生私有数据库或 rollout，不改变官方 Codex 制品。

## 技能与发行

### Windows 内置工具访问

打包 Windows 还通过 `platform/recovery.py` 连接安装内受编译策略约束的原生助手。
该恢复端口与工具 RX admission 分开，绑定发现并冻结的 Runtime storage roots；
Adapter 在已有资源租约/启动锁内传入实际 Home、版本和 executable。恢复不读取凭据，
不迁移自定义目录、不向 renderer 提供任意提权 API。输出有界且只允许固定结果类型，
原始 stderr 不进入产品日志；取消必须等助手终态，不能把取消请求当作权限操作结束。
实际 Windows UAC、权限隔离和对话恢复仍需原生安装版验收。

恢复失败时只消费固定 schema 的 `stage`、`reason` 与可选数值 `system_error`，
校验白名单后写入 `windows_sandbox_recovery`；不记录原生自由文本、路径或未知字段。
`ancestor_profile`、`ancestor_product`、`ancestor_codex` 区分祖先检查；`elevation`
区分 `cancelled`、`access_denied` 等实际结果，不从通用非零退出码推断用户取消。
异常/超量输出记录为 `transport`，无法启动助手记录为 `helper_launch`。
worker 的数值系统码可能未传回；日志中的 `system_error=0` 表示无可用数值，不能
解释为操作成功。安装版必须同时包含新的 helper 与宿主消费者。

打包 Desktop 由实际安装/组件路径 Owner 投影固定工具资源声明。Serve 在 Provider
配置时冻结，`platform/toolchain.py` 核对其与实际解释器、产品模块所在位置一致，
不接受模型/会话路径，不扫描 PATH 或用户技能；打包 Windows 缺清单及外部 override
明确拒绝，独立 Serve/开发模式不自动授予工具目录权限。
Windows 无内置资产清单时仍注入空资产的资源准备对象，绑定已准入 workspace 后，
在原生沙箱 ready 时准备该 workspace 自身的非继承属性读取权限。此步骤与工具 RX
清单独立，避免 PowerShell 路径解析因 workspace 元数据不可读而丢失当前位置；
不递归扩权；账户内项目的必要祖先另按下述属性策略准备，不改变会话文件的删除权限。workspace 已有的
沙箱写权限予以保留；工具资产仍严格拒绝超过 RX 的沙箱权限。元数据准备沿用
Adapter 的已审定版本门禁（当前 0.159.0、0.163.0）；开发模式的其他版本现在也会明确拒绝，
须单独完成版本审定，不绕过门禁。
该准备不覆盖工作区之外的私有祖先目录；若这些目录拒绝沙箱读取属性，
PowerShell 仍可能无法解析当前位置。此时应选择祖先可解析的工作区位置，
不能把初始化 ready 当作 cwd 或文件操作已经验收通过，也不自动扩大祖先权限。

名单限内置 `backend/bin`、当前 Python 发行树、组件布局的冻结 `backend/pylibs`，
以及已声明的 PowerShell、Electron/Node 和 TeX 组件；
平铺布局的产品模块已位于 Python 树。`platform/access.py` 向已存在的本机沙箱组
按安装阶段已完成的固定资源准入 SID 绑定动态元数据权限；固定工具树由安装 Owner
检查和赋权，Serve 不遍历或修复它们。对经运行解释器和产品模块双重校验的安装根内父目录，仅增加
不继承的目录查询权限（列目录、读属性、同步），以支持 Windows 长路径查找；对组合根
解析的工作区目录仅增加不继承的读属性权限，以支持 PowerShell 定位及文件操作。
不增加写权限，不授权安装根之外的祖先。目录/文件通过固定
no-reparse 句柄预检，保留 owner、控制位和其他 ACE；拒绝未知类型、链接和读取/执行
拒绝项。每个根独立协调，部分根完成后其他根失败时，已新增 RX 保留并记录，不用旧
DACL 覆盖回滚。授权持久且沙箱组共享，不在会话退出时移除；新增/替换资产须随产品
重启重新准备。跨进程 mutex 仅协调产品写者，不保证任意外部管理员并发 ACL 操作的事务性。
Desktop 将安装准入的真实本机 SID 通过 `SCHOLARSEED_TOOL_PRINCIPAL` 注入；固定资源
声明缺少有效 SID 时启动拒绝，不回退会话期全树检查。动态元数据授权之前解析实际
沙箱组 SID 并与准入绑定比较，不匹配则拒绝，不在对话中修复旧安装。每代原生沙箱
就绪检查以及工作区、父目录的动态权限准备保持不变。独立 Serve/开发模式没有固定
资源声明时仅准备已准入工作区的属性权限；固定资源或安装目录缺少准入 SID 仍明确拒绝。
不支持安装资产或其 ACL 热修改；更新须排空并重启产品并重新完成安装准入。
Desktop 在已校验 TeX 资源准备成功后，通过私有认证 ParentControl 通道一次性传递
版本、归档 SHA-256 和字体目录描述；就绪状态与描述同时生效，失败或未收到描述时拒绝执行。
资源描述只提供配置数据，不授权额外路径或变更 Windows 固定资源准入。
macOS 与 Windows 会话组合将 TeX/XDG 缓存放到该会话的 `.tool-cache/texlive` 并在启动工具前
通过 no-reparse 句柄准备目录，新目录继承会话 ACL，已有目录权限保持不变；
fontconfig 保留内置与系统字体目录，在会话内按内容摘要生成独立配置；拒绝链接和已有不同内容，
不覆盖用户文件。通过 Thread 执行环境传递配置及缓存，不污染共享 Host 启动环境；同时设置 Windows TeX Live 的
`XE_FONTCONFIG_PATH` / `XE_FC_CACHEDIR`，避免其退回安装目录缓存。缓存不复用 Desktop Home
下的写入路径，不增加工具目录或 Home 的沙箱写权限。

当前原生版本准入由 Adapter 控制。源码与本机契约测试不代替 Windows 原生 ACL、
真实帮我审批搜索、不可写及发现隔离验收；未完成这些验收不能宣称产品修复通过。

内置工具探针失败使用 `windows_sandbox_tool_probe_failed`，与资源权限准备失败的
`windows_sandbox_tool_access_failed` 分开；普通进程非零退出不解释为 Win32 权限错误。
编译失败或 PDF 校验失败时，在该次随机 `verification` 目录中保留
`scholarseed-probe-result.json`，包含实际退出码及 stdout/stderr 各最多 64 KiB 的尾部、
截断标记；缺失或非法字段不补造。此文件与已有编译日志一起保留，目录位置沿既有
后端日志回查，需要随问题反馈另行提供，不自动加入反馈包。原始输出不进入普通日志、
异常消息或界面；新文件拒绝覆盖及链接路径，留存失败仍传播原始预检错误。
成功预检继续清理随机目录；超时及原生结果未知仍保持未知结果语义，不提示安全重发。

`capabilities/skills/` 是从仓库 `skills/community/` 离线编译的生成物，不手工维护。根 `desktop` dependency group 与 `uv.lock` 冻结随包 Python 依赖；技能 provision 只安装已审查本地 wheels，不另行解析依赖。用户技能不进入产品包。

安装和验证入口见 [根 README](../../README.md)。

本地插件作者的离线描述、检查与打包入口见 [插件作者契约](service/capabilities/README.md)。当前仅提供离线检查，不代表桌面隔离预览、安装确认或原生能力接入已完成。
项目会话的资源准备接收本次执行 cwd，不在共享实例上保存可变路径。Windows 只为
OS 账户目录以下、实际 cwd 以上的必要祖先添加非继承读取属性权限，确保 Documents
等私有目录下 PowerShell 能解析当前位置。先固定完整链并预检，再授权；不跟随链接、
不忽略 deny 或实际链缺失、不递归扫描。账户目录自身及账户外项目不自动扩权，固定
工具与官方沙箱工作区读写策略不变；macOS 不执行该 ACL 准备。

Windows 诊断反馈在用户同意附带日志时，额外从产品 Codex Home 的 `.sandbox/`
读取当前 UTC 日期及前两天的固定 `sandbox.YYYY-MM-DD.log`。每份只读取末尾 128 KiB，
最多保留 64 个疑似失败行的分类/数值系统码与 SHA-256，摘要上限 64 KiB；无文件、
不可读、截断均显式标注。分类为文本线索，不证明根因。目录和叶子经文件系统 Owner
以 no-follow 方式打开，拒绝 reparse/链接与多硬链接，不创建目录、不修复权限。
反馈包只包含 `feedback/sandbox-summary.json`，不含原始命令、路径、异常正文，
不读取 `.sandbox-secrets`。macOS 跳过此来源；诊断授权关闭时不采集。
完整安装版的真实失败→落盘→反馈 ZIP 链路待 CI 包在 ecs-win4 验收。

恢复 helper 的装载阶段只声明绝对路径，是否需要调用仍由 Adapter 的受审版本准入
决定；未使用的 helper 缺失不阻断运行时发现。实际 CreateProcess 失败按 helper_launch
阶段记录数值系统码，不记录原始路径，也不推断用户取消授权；版本准入集合未扩展。
