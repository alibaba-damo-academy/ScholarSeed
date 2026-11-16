# 资料树浏览与版本能力投影

按下表选择当前问题的章节，不要求每次完整读取本页；适用的根与局部 AGENTS
仍需遵守。章节内的源码链接定位实际 Owner，跨端契约变化再追加受影响方。
复制/关联导入任务另见[导入知识](imports.md)；读取、列表能力、版本写入及后台
任务终态不是同一操作。本页记录当前源码与决策理由，不承诺固定延迟或已完成实机验收。

## 按任务读取

| 当前问题 | 先读章节 | 涉及的 Owner |
| --- | --- | --- |
| 资料列表加载、分页、刷新或慢请求 | [版本准入](#格式能力与版本准入规则)、[惰性激活](#项目惰性激活与批量版本发现) | Desktop 资料投影、Serve Content/History |
| 版本状态文案、资料树与工作台提示不一致 | [版本能力投影](#版本能力投影的展示边界) | Desktop 资料状态与工作台、Serve 版本观察 |
| 文件版本数量、大小或保留策略设置 | [设置保存边界](#文件版本设置的保存与清理边界) | Desktop 设置页、Serve 保留策略 |
| 移动、删除、取消关联或引用同步 | [资料生命周期](#资料移动删除与当前引用同步) | Desktop 生命周期与 Store、Serve Content |
| 保存、版本别名、删除确认或版本对比 | [自动保存](#项目工作区与自动保存边界)、[版本管理](#版本别名与确认式删除)、[对比身份](#版本对比的固定身份与格式呈现) | Desktop 工作台、Serve VersionStore |
| 审阅、修订提交、撤销或恢复 | [成员终态](#审阅成员终态与批次投影)、[内容事实与恢复点](#内容事实决定与恢复点)、[草稿与撤销](#审阅草稿修订提交与撤销边界) | Desktop 审阅投影、Serve History/VersionStore |
| 大文件读取、批注变化或源身份 | [存储与读取限额](#完整存储与交互式读取分别限额)、[源身份与批注](#源文件身份与批注记录不可混同) | Serve Content/History/版本对象存储 |
| 发布产物、可编辑副本或 Agent 变更归因 | [发布与副本](#发布快照与可编辑产物副本)、[差分与归因](#回合差分事实与-agent-归因) | Desktop 工作台、Serve Delivery/History |
| Office 宿主、格式能力或 PDF 阅读记录 | [Office 与格式处理器](#office-生命周期与格式处理器是两个维度)、[PDF 阅读边界](#pdf-阅读资源与业务状态) | Desktop Office/处理器、Serve Content/PDF |
| 编辑器快捷键、重绑或默认行为冲突 | [快捷键边界](#编辑器快捷键目录与用户覆盖) | Desktop 命令目录、编辑器适配与偏好 |
| Markdown 纸张宽度、语言提示、源码查找或引用跳转 | [Markdown 阅读与链接](#markdown-阅读与链接) | Desktop Markdown 编辑器与保存引用解析 |
| 自动全网搜索、本地目录引用或摘录入库 | [搜索证据](#全网搜索的单次执行与阶段证据)、[本轮目录引用](#本轮本地目录引用不是资料库导入)、[回答摘录](#回答摘录入库与来源保留) | Desktop 资料交互、Serve Context/Content、产品 Skill |

任务可能跨行；表格不替代章节中的安全约束、当前缺口与验证前提。
修改后核对[验证与更新](#验证与更新)，不将导航或源码存在作为真实产品验收。

## Owner 与当前机制

### 项目根与关联根的授权边界

[组合根](../../apps/serve/service/bootstrap.py)唯一解析新项目工作区根：产品
`workspace_root` 设置优先于 `SCHOLARSEED_DEFAULT_WORKSPACE`，再取调用方传入
的 cwd 或进程 cwd。不得让启动器和 Content 各自推导根路径；既有项目的登记
身份与实际根不能从目录名重新猜测。路径与数据库归属见[持久化边界](../architecture/persistence.md)。

[ContentPort](../../apps/serve/service/platform/content.py)负责跨域路径契约，
[ProjectSpace](../../apps/serve/service/content/service/space.py)解析项目或挂载
路径后复核归属，拒绝越界及文件挂载下的子路径；字符串前缀不是授权检查。
这个解析步骤不替代文件操作的原子安全边界，也不证明 Windows reparse-point
或并发替换已验收。

[关联根 Owner](../../apps/serve/service/content/service/roots.py)校验项目归属、
保留软撤销记录，并从当前有效根生成可写根集合；组合根将该能力注入会话域，
不要求会话反向导入 Content。[Codex Adapter](../../packages/adapters/codex/scholarseed_codex/permission.py)
拥有当前 `sandboxPolicy` 翻译，workspace-write 组合 cwd 与显式提供的根，
read-only/full-access 分支不同。旧 damoagent host 不再是当前 Owner。
Windows 在提供当前已授权的可写根时，复用平台存储能力保留当前宿主用户对子项的
可继承访问，以便 Serve 读取 sandbox 创建的产物；不扩大根集合或向其他主体授权，
初始化失败时不提供该集合。未注册或不可用项目不执行权限初始化。
此初始化不递归重写受保护的历史子项 DACL；旧副本若已禁止继承，不会因此自动恢复
可读。此类恢复应由范围明确的数据恢复流程处理，不在 Review 读取失败时递归授权。
撤销登记、下一回合策略更新及正在运行的进程权限是不同终态；不能将软撤销或
中断请求返回宣称为运行中 OS 写权限即时剥夺。

真实授权验收必须同时证明允许根可写、未授权根拒绝、撤销后新回合拒绝。
负例须避开沙箱可能默认放行的临时目录，并核对实际版本的隐式允许范围，不能
以 `$TMPDIR` 写入成功推断显式授权失效。历史版本的真实 turn 报告不是当前
Adapter、平台或迁移流程已通过的证明。

### 资源名称与路径过长

[Content 错误分类](../../apps/serve/service/content/service/utils.py)只把实际文件系统
`ENAMETOOLONG`、Windows 对应路径错误映射为 `name_too_long`，其他 I/O 错误仍保留
原有分类；[Resources API](../../apps/serve/service/resources/api/routes.py) 将该业务码
返回 400。文件或文件夹名称不预设跨文件系统统一字符上限：Markdown 的 `.md` 后缀
和重名后缀也占据真实路径长度，失败后不能留下部分发布产物。项目**显示名**另有
[ProjectRegistry](../../apps/serve/service/content/service/port.py) 的领域长度限制，
不可把它误用为资料文件名上限。回归入口是
[名称边界契约](../../apps/serve/tests/contract_folder_names.py)；其中 Windows 错误分类
夹具不替代 Windows 真机创建与错误提示验收。

### 资料移动、删除与当前引用同步

[生命周期规则](../../apps/desktop/src/renderer/src/features/resources/lifecycle.ts)
负责落点反馈与路径子树变换；[Content assets](../../apps/serve/service/content/service/assets.py)
最终校验后缀、挂载范围与自身后代目标。关联资料重命名或同根移动会影响外部源，
不能与复制副本编辑混同；取消关联则撤销登记，不删除外部字节。
本地删除使用一次性 trash token 与系统废纸篓，兑换不是已删除；
[Content 完成回执](../../apps/serve/service/content/service/port.py) 校验目标消失后登记事件，
Electron 回执请求保持原 Chromium 会话。物理操作、回执、页签和引用更新分别报告，
不能因后续同步失败假称文件操作未发生或静默回滚。

[客户端编排](../../apps/desktop/src/renderer/src/store.tsx) 在内容操作成功后更新资料投影、
项目内页签和当前可变引用；CAS 冲突时以服务端 latest 做有界重放，保留无关新增引用。
已提交引用不变，子树匹配必须包含路径分隔符，避免误改同前缀邻居；移动后的可变
引用清除旧 source_revision，不能沿用可能失效的摘要。磁盘变化与上下文数据库不是
同一事务；同步错误需要明确部分成功，不授予历史回合重写或正在运行 Agent 立即
失去权限的保证。取消关联后的可选中断也不能以请求返回证明原生进程全部退出。

修改时核对 lifecycle、Content 契约和 Workbench 状态消费者，并真实验证外部源保留、
同名避让、后缀、脏页签、并发引用及部分失败；当前实现片段不替代产品验收。

### 全网搜索的单次执行与阶段证据

修改资料库自动全网搜索时，先看[执行 Owner](../../apps/desktop/src/renderer/src/features/resources/driver.ts)
与[请求及投影 Owner](../../apps/desktop/src/renderer/src/features/resources/search.ts)。
搜索框先调用 [Serve 资源搜索入口](../../apps/serve/service/resources/api/search.py)，
由业务服务按当前账号和凭据准入直接请求官方接口。有效 `completed` 或 `empty`
直接结束、零 Invocation；未登录、官方不可用或请求失败才进入一次 `fallback`
Invocation，按 native → browser 执行，不再由 Agent 重试官方接口。
选择 Serve 直连而非 Renderer 外部请求，避免向前端暴露凭据或复制身份逻辑；
选择资源专属 fallback 而非改写公共 automatic，保持右侧对话及直接 provider 调用不变。
这里的单次执行不要求浏览器临时上下文合并，也不能仅凭前端 POST 数量宣称
真实 Runtime session 生命周期已验收。

官方结果绑定真实 HTTP search ID；浏览器使用固定相对 artifact 路径，native
使用原生事件和结构化输出。投影按执行证据、结构化结果及校验错误选择阶段，
不从模型叙述推断成功。明确为空不是回退理由；身份变化、本地准入失败与取消
不能被当作官方不可用而绕过。阶段 attempt 只是展示投影，不代替实际供应商证据。

资源专属结果策略在同一工具成功 receipt 与安全产物快照验证后，由宿主发布
`result.ready`，前端即可展示候选，不再等模型发布或组织最终回复。该事件不是
执行终态；宿主仍请求停止、消费真实 Runtime 终态并等待清理，清理失败不得伪装成功。
普通 Invocation 不注入此策略；取消、关闭标签和身份变化仍拒绝迟到结果。

搜索框浏览器命令显式选择 `resource-session`；普通调用保留 `standard`。
Serve 通过本次 Invocation 的环境注入私有 profile，位于用户级 service 下的
`resource-search-profiles/<owner-sha256>/<browser-channel>`；保留 Cookie、缓存，
不共享普通对话 profile。原生 profile 锁冲突明确失败，不换临时目录绕过。
前者从 Bing 首页等待输入框可见，再等 1 秒、填写并执行所属 `form.submit()`；
等待自然导航与结果容器后再等 1.5 秒，两段等待均计入原超时预算。
必要时正常滚动 auto-skipped 内容，
随后从同一文档原子采集并比较连续完整快照。标题和 HTTP(S) URL 必需，摘要缺失
保留空字符串；仅资源 browser fallback 投影允许空摘要，不丢卡、不编造。
选择可见稳定快照而非强制刷新，保留 query、文档、可见性、busy 与
challenge 校验。隐藏停滞仍明确失败，不改 CSS、伪造 Cookie 或提取隐藏结果冒充通过。

搜索候选不是全文核验或结论证据。候选收集不打开结果页；普通对话若需全文支撑，
按 Skill 的对应场景另行核验并标明来源。automatic 请求包含网络与 full-access
sandbox 能力，这是实际调用的权限边界，不是文档阅读授予的权限；不能用 shell
绕过 `action_required`，也不能把前端 `capabilities` 参数当作已执行的准入校验。

搜索启用以本次执行要求为准，而不是普通对话天然联网：请求明确设置
`execution.web_search`，普通 required 请求仍要求 Runtime `WEB_SEARCH`；
搜索框 fallback 使用 optional，Codex adapter 按实际模型/供应商协商，支持时由
会话配置 Owner 注入 `web_search=live`，不支持时允许继续浏览器路线。
这些检查分属请求、产品组合与供应商执行边界，不能用旧搜索会话 HTTP 示例替代，
也不能从能力声明推断实际产生搜索事件或获得有效候选。

定向投影契约入口为
`node --experimental-transform-types --test apps/desktop/src/renderer/src/features/resources/driver.test.ts`。
该测试替换 fetch 并提供 SSE/artifact fixture，只证明单请求与投影断言；真实验收仍需
Desktop 自动搜索和 Trace 的 invocation/session、阶段 provider/status/artifact 对照。
不能用历史提案的 implemented 状态、单测或旧截图替代当前产品运行证据。

### 本轮本地目录引用不是资料库导入

对话引用外部目录时，先区分用户明确选择的本轮输入与资料库复制/关联导入。
[Session 注册 Owner](../../apps/serve/service/chat/service/sessions.py) 的
`register_local_paths` 为精确文件或目录生成会话内引用 ID，不复制目录、不递归
授权子文件；目录不是冻结快照。注册要求绝对路径，拒绝目录链接根，并按真实类型
返回 `kind`。既有 `/api/serve/sessions/{session_id}/file-references` 路由名称
不意味着它只能处理普通文件。

[发送 Owner](../../apps/serve/service/chat/service/turns.py) 要求目录只使用已注册
引用 ID，不能同时传路径；解析时核对会话和输入类型，发送前再次拒绝链接、junction
或已不存在的普通目录。目录引用不带文件大小，不能借用文件预览/保存语义；注册
和发送检查不是对后续工具读取期间目录不可变或原子无竞争访问的保证。
[Runtime](../../packages/runtime/scholarseed_runtime/contract/input.py) 只持有中性的
`InputKind.DIRECTORY`；[Codex 输入投影](../../packages/adapters/codex/scholarseed_codex/input.py)
明确传递用户选择的目录身份并说明内容尚未读取，不声称已遍历。后续访问仍受实际
运行时权限约束，不把引用变成目录内容或访问授权快照。

回归还需真实 Desktop 选择/取消、文件与目录同轮、发送后清空、历史/重试，以及
注册后删除或替换目录；macOS 合选和 Windows 分选分别验收，源码存在不证明
产品交互或跨平台通过。不能采用前端展开子文件、伪装成 `file` 或自动导入来替代
单一有类型目录引用。

定向确定性入口：在 `apps/serve/` 使用项目 Python 执行
`PYTHONPATH=../..:. python -m tests.contract_serve_attachments`。现有套件使用
隔离目录、ASGI TestClient 与 fixture Driver，覆盖目录类型、非复制、跨会话拒绝
及移动后重校验；不是实际 Codex、Desktop 选择器、junction 或竞争攻击验收。

- [Resources API](../../apps/serve/service/resources/api/routes.py) 的
  `GET /api/resource/tree` 组合 Content 列表与版本能力。`path` 空值表示资料库根，
  非空通过 Content 的 `within_root` 翻译为项目逻辑路径；不是任意绝对文件路径。
  `depth` 与每层分页控制展示；响应 `total/offset` 表示当前层，不表示全库计数。
- [Content](../../apps/serve/service/content/service/port.py) 拥有树、逻辑根、
  外部关联根与 Git 根观察。路由对本次返回节点计算 Git 根，再向能力计算传递
  文件路径子集的结果，避免同一请求重复查询；不是跨请求永久缓存。

[Git 根识别](../../apps/serve/service/content/service/repository.py)只在已授权资源根或
关联目录边界内向上寻找最近的 `.git` 标记，不运行 Git，也不读取 gitfile 指向的路径；
每次请求的查询缓存不跨授权或文件系统变化。识别出的文件由
[版本观察](../../apps/serve/service/resources/service/observe.py)投影为 `git`，版本写入
由 [History](../../apps/serve/service/resources/service/history.py)等 Owner 以
`git_version_disabled` 拒绝；分类不删除旧历史，也不禁止普通内容保存。
修改这一边界须分别验证根/关联根、Git 标记损坏或消失、普通保存、版本写入拒绝及历史读取；
旧 macOS 导入截图不证明当前 Windows 文件系统语义。
- [版本观察 Owner](../../apps/serve/service/resources/service/observe.py) 的
  `capability_states` 去重选中路径，使用 `resource_entries` 定点观察文件、批量
  读取持久版本与手动准入状态，不为每个列表能力查询递归扫描整个库。
  空路径集合直接返回空投影；调用方缺少 Git 根结果时仍可由 Content 计算。

### 版本能力投影的展示边界

Serve 的管理状态由 Desktop [资料状态映射](../../apps/desktop/src/renderer/src/features/resources/state.ts)
和[工作台映射](../../apps/desktop/src/renderer/src/features/workbench/Dock.tsx)分别投影为
本地化文案：`migration_required` 提示需要设置版本管理，`ignored` 与 `unsupported`
提示未加入版本管理，`oversized` 提示超过上限，`unavailable` 表示无法确认状态。
这几类状态不能统一写成“版本不可用”，也不能从提示文案反推文件已写入版本历史。
变更映射时同时核对资料树、工作台和对应的[行为测试](../../apps/desktop/src/renderer/src/features/workbench/office.test.ts)；
旧版本的截图或局部通过不证明当前产品显示与跨平台结果。

### 文件版本设置的保存与清理边界

[Desktop 设置页](../../apps/desktop/src/renderer/src/components/business/AccountPanel.tsx)
对版本数量和最大文件大小在输入失焦时提交，回车先使输入失焦；成功、失败和校验
结果走全局 Toast，失败重试由用户触发。不能把旧记录中的“每次输入变化后防抖保存”
视为当前行为，也不能把 Toast 或界面回读等同于历史版本已被清理。

[Serve 设置路由](../../apps/serve/service/resources/api/settings.py)对不带预览 token
的 POST 只校验并持久化配置，调用[保留策略 Owner](../../apps/serve/service/resources/service/retention.py)
的 `configure`，不扫描或改写项目历史。显式预览与携带 token 的 `apply` 是另一条
会重新校验并可能清理历史的路径；新上限的后续执行不由普通设置保存瞬间证明。
修改这条边界应核对[保留策略契约](../../apps/serve/tests/contract_resource_retention.py)
与真实 Desktop 设置操作，分别观察配置回读和版本历史，不沿用旧单次截图。
- [VersionStore](../../apps/serve/service/resources/persistence/version.py) 的
  `manual_admitted_states` 经 Resources 服务按项目访问，在一个事务内按 SQLite
  参数批量界限查询。多批 SQL 不等于每个文件重新连接；不存在数据库时返回空状态，
  已有数据库的 `ensure`/连接开销不能视为不存在。

## 编辑器快捷键目录与用户覆盖

[shortcuts.ts](../../apps/desktop/src/renderer/src/shortcuts.ts) 持有第一方命令身份、
默认绑定与匹配；[preferences.ts](../../apps/desktop/src/preferences.ts) 校验用户级
`shortcutOverrides`。缺键使用默认，绑定对象替换默认，`null` 表示禁用；恢复默认
删除键，而不是写回当前默认值。不要把用户键位写进项目文件或另建编辑器常量目录。

`resolveShortcut` 按调用者提供的 activeScopes 排序，不自行发现活动 DOM 或为所有
入口安装监听器；编辑器与工作台适配仍须实际接线。`primary` 在不同平台的编译、
有效绑定与命令执行分开核验，不能由目录存在推断全局抢键已解决。修改清空/重绑时
回归活动编辑器、普通输入、弹窗及 Office iframe 的命令归属，防止旧按键意外落到
其他作用域；纯 matcher 或偏好序列化测试不替代真实焦点/按键验收。

## 格式能力与版本准入规则

### 显式打开与版本观察

[Workbench open](../../apps/serve/service/workbench/api/routes.py) 返回 `versioning`，
`can_version` 从同一能力投影派生；[Desktop loader](../../apps/desktop/src/renderer/src/features/workbench/api.ts)
在 content 成功后复用该状态，不以扩展名猜版本资格或再做一次首屏 capability 请求。
内容字节仍走独立二进制通道，不能为优化把两个未绑定代际的读取并行后忽略差异。
当前 loader 使用 open revision；这不是 open/content 单一稳定快照或条件读取证明。

[Resources capability](../../apps/serve/service/resources/service/observe.py) 对目标路径
定向分类，已管理目标实际观察后投影最新状态。此查询可能创建 CAS spool 或推进
WorkingHead，不是只读预热；不通过 TTL、删除观察或跳哈希取得性能结果。
外部事件、历史刷新与显式恢复仍须各自观察，不能把首屏复用推广为跨请求永久缓存。
优化分别核目标路径数量、实际观察、revision/ETag及viewer-ready，HTTP成功不证明提速。

[Workbench 格式注册表](../../apps/serve/service/workbench/domain/model.py) 的
`versionable` 默认为 false，显式声明的格式生成常见纳入模式与格式预览能力。
它提供默认模式和能力投影，不是所有版本写入的不可扩展扩展名硬门禁；新增 Viewer
不会自动增加默认纳入格式，也不应在前端复制一份扩展名清单。

当前[准入策略](../../apps/serve/service/resources/domain/policy.py) 为单一活动模式：
whitelist 只判断 include，blacklist 只判断 ignore，不是旧方案的“先白名单、再黑名单，
黑名单总优先”。规则使用 gitignore 风格匹配，但不能据此把项目 `.gitignore` 的全部
旧联动当作现行自动准入。Supervisor 先区分 Git 管理文件，再通过同一策略输入
投影版本资格；预览/可编辑格式与是否管理完整字节仍是不同能力。

[设置 Owner](../../apps/serve/service/chat/service/settings.py) 区分未配置纳入规则与
显式空规则，缺失纳入规则回到注册表默认；缺失排除配置使用产品默认，显式空列表保留。
不能用 `value || defaults` 抹掉用户选择，也不能把旧记录中的固定规则数量当当前契约。
体积限制先于手动资格；旧配置需迁移时，未手动准入项投影为 migration_required，
不擅自选择模式或把存量版本清掉。手动资格不是读取授权、路径越界或体积限制的豁免。

[Desktop 场景预设](../../apps/desktop/src/renderer/src/features/resources/scenes.ts)
只把阅读、数据、办公和代码选择投影到既有纳入规则，不另存场景 ID 或修改 Serve
准入字段。切换场景取新预设的规则并集，保留不属于旧预设的自定义规则；共享类型在
仍选中的场景中继续保留。含自定义规则时，页面不从部分匹配推断一个已选场景。
[设置视图](../../apps/desktop/src/renderer/src/components/business/VersionScope.tsx)
负责这种编辑投影，最终版本资格仍由上述 Serve 策略决定；旧截图中的场景数量、
固定排除项数量或颜色布局不是当前配置契约。

相关依据为[准入契约](../../apps/serve/tests/contract_resource_policy.py)和
[保留设置契约](../../apps/serve/tests/contract_resource_retention.py)。变更时核对活动模式、
缺失/空配置、资格投影、影响预检与已有历史保留；源码机制和历史 UI 截图不替代
当前代码的真实设置保存、独立读回与扫描验收。

## 版本历史入口与审阅入口

### 完整存储与交互式读取分别限额

[History capture](../../apps/serve/service/resources/service/history.py) 在 CAS 私有
spool 中经 Content 稳定采集源字节，再按预期对象身份发布并验证；
[Content](../../apps/serve/service/content/service/port.py) 持有授权路径、普通文件、
大小和稳定读取的检查，不把物理项目路径交给 Resources 自行拼接。
[平台稳定读取](../../apps/serve/service/platform/storage.py)比较同一句柄读取前后的
完整身份；再核对路径仍指向该句柄及长度。Windows Python 3.12 的 `fstat` 与
路径 `stat` 对 `st_ctime_ns` 语义不同，跨 API 比较跳过该字段，但仍比较设备、
文件 ID、大小和修改时间；不能因此取消句柄前后变化检查。核对
[存储契约](../../apps/serve/tests/contract_storage.py)后仍需 Windows 真实 Desktop 的
文件打开、外部变更及 junction/reparse 拒绝验收，macOS 预览截图不能替代。
[CasStore](../../apps/serve/service/resources/persistence/objects.py) 小对象走完整
缓冲，大对象发布分块；verify 增量校验，materialize 经临时文件、fsync 和替换。
完整版本存储、自动准入设置、历史预览/diff 的内联读取是不同限额，值只由实际
Owner 常量与配置持有。History.read 在完整 bytes 返回前拒绝超过内联上限的对象，
不能为支持大版本而允许 Renderer 全量 arrayBuffer 或回退无界读取。
这些接点不是恒定内存、锁时长、完整HTTP流或跨平台文件安全的验收；性能优化
还需核大对象发布的实际锁范围、并发、源变化、空间不足、损坏与失败清理。

### 源文件身份与批注记录不可混同

[source identity](../../apps/serve/service/resources/domain/version.py) 明确只比较
object/state/path/mode，不比较独立持久化批注。批注记录、锚点 source_revision
和文件版本不是同一事实；新知识不能把标注增删改自动解释为源文件字节修改，
也不能因旧 schema 仍有 annotation 字段就清理历史行或用户批注。
当前恢复与历史读取仍保留旧批注字段及兼容路径；
[pending.sync_working](../../apps/serve/service/resources/persistence/pending.py) 的
saved 查询仍比较 head/version 的 annotation_object_id，因此不能断言旧 annotation
在全部新状态决策中已经退出。此为待 Owner 核验的覆盖边界，不证明已复现用户问题，
不授权改库、修改通用相等语义或在知识治理中修产品。变更须分别验收源字节、
批注即时保存、旧历史保留、恢复与显式导出副本，不能用文档宣称全部隔离通过。

排查“版本历史菜单丢失”时先看[资料树菜单](../../apps/desktop/src/renderer/src/features/resources/NodeMenu.tsx)，
不是直接修改审阅卡。当前仅文件节点且存在 `snapshotState` 或管理状态为 `managed`
时展示历史项；手动准入资格与历史展示资格分别判断，不能用所有文件常显绕过资格。
菜单关闭后调用 `openResourceHistory`，由[产品状态 Owner](../../apps/desktop/src/renderer/src/store.tsx)
读取当前项目的版本 capability，等待期间切项目即不继续投影；缺少 `file_id` 明确报错。
历史目标携带 project/path/fileId，由[资料面板](../../apps/desktop/src/renderer/src/features/resources/ResourcePanel.tsx)
只在目标项目仍选中时呈现既有[VersionHistory](../../apps/desktop/src/renderer/src/features/workbench/VersionHistory.tsx)，
不要求先打开该文件的编辑器。

历史可用性与格式是否支持历史预览分开；[historyAccess](../../apps/desktop/src/renderer/src/features/workbench/history.ts)
以文件身份判断 available，再结合 `can_preview_history` 判断 canPreview。
不能因无法预览某格式就删掉它的历史访问入口。资料树审阅标记则进入批次审阅，
不跳版本历史；历史访问、审阅决定与编辑器内存撤销不是同一能力。
这仅记录已核验入口和身份边界，不证明历史恢复、删除、编辑器冲突或平台文件操作安全。

[资料树状态投影](../../apps/desktop/src/renderer/src/features/resources/state.ts)按精确项目与路径
寻找编辑会话，分别给出 dirty、待审阅和版本异常；
[显示层](../../apps/desktop/src/renderer/src/features/resources/Indicators.tsx)以红点、审阅入口、
不可用/漂移警告呈现，不显示历史“待存版本”或“已保存版本”徽标。Git 管理文件仍可显示
编辑 dirty，但不投影本产品的版本/审阅信号。调整这些状态应先跑
[投影契约](../../apps/desktop/src/renderer/src/features/resources/indicators.test.ts)并在真实资料树
核对悬停、警告操作与项目切换；旧树状态截图不能证明当前版本。

### 版本别名与确认式删除

[History 服务](../../apps/serve/service/resources/service/history.py) 的 `update_alias`
只修改展示元数据，规范化空白并校验长度及控制字符；
[VersionStore](../../apps/serve/service/resources/persistence/version.py) 在事务内按
`metadata_revision` 比较交换并保存幂等回执，不能覆盖版本字节、身份或序号。
冲突后应重新读取实际投影，不靠客户端最后一次写入覆盖并发修改。

单版本删除先读取 `preview_delete` 的阻断项及受影响 Delivery，再明确确认。
确认写事务重算当前版本、阻断项和 Delivery 集合，并比较 `preflight_token`；
预检过期或存在阻断时拒绝。当前最新版本、pending、迁移保护和进行中恢复引用
分别阻止删除；幂等请求只能重放自己的回执，不能把预检当永久删除授权。
这里记录实际令牌绑定字段，不声称令牌签名、过期时间或额外跨项目绑定已经实现。
真实验收还须覆盖预检后事实变化、并发修改、重复确认与关联交付影响。

恢复历史版本不只恢复正文：[恢复 Owner](../../apps/serve/service/resources/service/recovery.py)
以源版本的路径作为 present 目标，在预检、准备与执行阶段核对目标路径占用和
当前修订；即使选择 force，也不能覆盖另一个文件占据的历史路径。重放须保持
原文件身份且不重复追加版本，中断恢复仍从持久化事务继续，不能只凭编辑器显示
旧名称判定成功。定向看[恢复契约](../../apps/serve/tests/contract_resource_recovery.py)，
真实验收还要分别读磁盘、资料树、标签与历史，并测试预检后新增占用者。

### 版本对比的固定身份与格式呈现

文件版本资格与回合审阅资格独立。Workbench 格式注册表中的 PDF 保留读取、预览和
版本能力，但不参与回合审阅基线、结束快照或新审阅候选；PDF 新增、修改或删除均
不应阻断其他文件的审阅。项目及会话目录内由 `TASK_PYTHON_PARTS` 定义的 Python
环境（命令入口、锁、收据和 venv）同样不参与审阅，不影响普通用户 Python 源文件。
既有版本与冻结历史不重写，缺失的旧快照不能用当前文件补造。

[历史入口](../../apps/desktop/src/renderer/src/features/workbench/VersionHistory.tsx)
打开对比前要求实际 file ID 和 current version ID；
[Tab 身份](../../apps/desktop/src/renderer/src/features/workbench/tabs.ts) 包含项目、文件、
路径、两侧版本 ID、历史序号及 processor，相同版本对复用，不能用路径替代快照身份。
“当前”指打开时传入的版本 ID，不是随磁盘变化自动更新的右侧内容。
`projectId` 同时决定对比页签的可见作用域：切到其他项目应隐藏，返回所属项目
再恢复原页签；不能只把项目编码进 tab ID 却遗漏可见性投影。

[VersionDiff](../../apps/desktop/src/renderer/src/features/workbench/VersionDiff.tsx)
并发读取两份版本正文，文本交给只读 Diff；当前 Office/表格以切换控件选择一份
快照呈现，不是旧提案中的可拖动双栏同时展示。不能将文本 Diff 能力外推为 Office
语义差异、PDF 像素差异或未知二进制比较，也不为承接历史研究新增产品功能。
[OfficeSnapshot](../../apps/desktop/src/renderer/src/features/workbench/OfficeDocument.tsx)
在卸载时注销显式 binding，复用
[原生格式宿主 runtime](../../apps/desktop/src/renderer/src/features/workbench/office/runtime.tsx)；
显式 binding 不取得普通 workspace session，bind 消息的 editable 为 false。
这些具名接点不证明全部写入路径隔离或运行时验收；变更须检查内容读取失败、
版本切换、关闭释放与不可编辑性，不用历史双栏截图替代当前真实结果。

## Office 生命周期与格式处理器是两个维度

[viewer policy](../../apps/desktop/src/renderer/src/features/workbench/policy.ts) 将
Office/Spreadsheet 归同一 exclusive group，声明不可 move、split 和并行比较；
[host 协调](../../apps/desktop/src/renderer/src/features/workbench/office/hosts.ts)
首次 demand 才创建一个 host；无文档启动不读取系统字体。已创建的 host 在关闭全部
文档后仍保留并复用，绑定首个 demand，其余显式 queued。runtime 合并普通工作区与
快照 demand，不能仅删额外 iframe 就宣称全局准入、dirty 决策与跨项目替换已通过。
旧“每Tab私有WASM/按文档字体”研究已被替代；当前
[frame](../../apps/desktop/src/renderer/src/features/workbench/office/frame.ts) 读取默认
字体及可枚举系统字体并注入 preRun。系统字体完整容器先按摘要定位候选，再逐字节
确认相等后去重；不同内容全部保留，注册文件名碰撞不会覆盖。font-read 诊断区分
读取字节与唯一容器字节；不以字体族或大小跳过目录条目。权限/枚举整体失败与单字体降级分开，不能
据历史实验承诺固定启动时延、关闭即销毁或已经完成真实排版/内存验收。

[预热恢复](../../apps/desktop/src/renderer/src/features/workbench/office/runtime.tsx)
用 frame epoch 重建失败的 WASM iframe，不向已失败实例继续发送重试；恢复状态与
错误原因由 [recovery](../../apps/desktop/src/renderer/src/features/workbench/office/recovery.ts)
和 [progress](../../apps/desktop/src/renderer/src/features/workbench/office/progress.ts)
持有。反馈目前通过 [OfficeLoading](../../apps/desktop/src/renderer/src/features/workbench/office/Loading.tsx)
显示在文档锚点，而非历史版本的全局 Portal 通知；旧截图和旧耗时不代表当前验收。
旧“移除预热提示”的交付后来已被恢复反馈替代：当前未就绪文档仍显示阶段、失败原因、
自动重试倒计时和手动重试。`runtime-ready` 不等于文档可见；[Office worker](../../apps/desktop/src/renderer/src/features/workbench/office/office-thread.js)
接收 `OnLoadFinished` 或 `OnLayoutFinished` 后，[frame](../../apps/desktop/src/renderer/src/features/workbench/office/frame.ts)
还要求相同 binding 的 viewport 绘制 ACK 与后续浏览器绘制帧，才通知文档 ready。
诊断须区分字体/运行时失败、文档加载失败与绘制门禁；不能靠固定等待、旧截图或
假成功事件绕开这些状态。

Office 画布的键盘、组合输入和菜单不是普通 DOM 输入：
[frame](../../apps/desktop/src/renderer/src/features/workbench/office/frame.ts)
负责画布事件及宿主消息，[UNO 策略](../../apps/desktop/src/renderer/src/features/workbench/office/policy.js)
按格式与编辑权限限定命令，[菜单治理](../../apps/desktop/src/renderer/src/features/workbench/office/governance.js)
裁剪原生命令。修改快捷键或 IME 时须同时验证光标、选区、保存回读与不可编辑文档；
不能仅凭浏览器按键事件或历史语言截图断言 Qt/WASM 已正确接收输入。
剪贴板写入被浏览器拒绝时，[clipboard 桥](../../apps/desktop/src/renderer/src/features/workbench/office/clipboard.js)
记录诊断并处理拒绝 Promise，不能把该拒绝误判为字体预热失败，也不能据此断言
复制已经写入系统剪贴板。Impress 选区、窗口失焦后的工具条与实际剪贴板内容
仍须分别从真实产品路径验证。

Assistant 面板改变可用视口时，[runtime](../../apps/desktop/src/renderer/src/features/workbench/office/runtime.tsx)
向既有 iframe 发出尺寸更新；[frame](../../apps/desktop/src/renderer/src/features/workbench/office/frame.ts)
在动画帧合并请求，再由持有 OffscreenCanvas 的
[Office worker](../../apps/desktop/src/renderer/src/features/workbench/office/office-thread.js)
调用打包 Qt 的 `qtResizeAllScreens` 更新屏幕几何与绘制像素。不要在画布已转移后直接改
HTML canvas 宽高，也不要为重绘重载文档；修改此路径须同时核对渲染尺寸、选区、未保存状态
和真实 XLSX 的面板开合及窄窗行为。历史截图与旧门禁结果不替代当前运行版本验收。

格式行为由 [Content spreadsheet registry](../../apps/serve/service/content/service/spreadsheet.py)
分别注册 XLS、XLSX 与 CSV 的处理器，
[Workbench](../../apps/serve/service/workbench/domain/model.py) 投影 processor 和能力；
Desktop 的[处理器注册表](../../apps/desktop/src/renderer/src/features/workbench/office/processors/registry.ts)
按协议身份选择 bind，缺失或未知身份明确拒绝，后缀校验不等于靠后缀重新猜身份。
共享一个 viewer/runtime 不授权合并 XLS/XLSX 解析或把某格式可编辑性外推给其他格式。
处理器变更须分别验证检查、预览、选区、加载和副本编辑能力；运行时复用与格式隔离
各有证据，不能用一张健康截图或同一个库的单测代替。

## 审阅成员终态与批次投影

### 旧 DOCX 原生修订生成器已退出

更早的独立Documents版本库、用户级revision与原生tracked changes方案已被项目
Resources/CAS/whole-file review取代，不因保留历史理由恢复旧服务域或先校验哈希
再无保护替换的保存协议。旧方案的独立引擎宿主、CompatibilityReport与整文档
只读分级是候选设计，不是当前已实现机制或一律只读规则。新增复杂格式编辑能力
时仍应明确隔离、外链/活动内容、保真范围和往返验收；引擎能打开或普通字节Diff
不证明复杂排版、签名及未知部件无损，也不能据旧提案推定已有该能力门禁。

当前 Workbench 不再持有旧 `redline` 生成器，版本历史与 whole-file review
不能描述成仍能导出 Word 原生 tracked changes。旧 Office 引用闭包、格式等价
规则和验收快照不作为当前产品接口或默认开发要求，也不应为了历史文档重建处理器。

[版本对端口](../../apps/serve/service/platform/resources.py) 和
[历史读取 Owner](../../apps/serve/service/resources/service/history.py) 仍保留中立
`read_pair`：同一逻辑文件、严格版本顺序、present 状态与完整 CAS 读取，在同一
writer 保护窗口内物化两份字节，返回后不让锁或流逃逸。保留这一窄契约不证明
某个 DOCX 派生功能仍有调用方。后续新增格式原生派生物需另行设计与验收，不能
拿当前磁盘/编辑器草稿替换已选历史版本，或污染源文件的线性版本历史。

文件审阅属于 Resources，不是[文献综述工作区](review.md)。

### 内容事实、决定与恢复点

base 是 Agent 前基线，candidate 是 Agent 后候选，disk 是当前稳定读取，draft 是
尚未提交的内存内容；外部变化不是用户修订决定，候选也不是已接受 Version。
[ReviewDraft](../../apps/desktop/src/renderer/src/features/resources/draft.ts) 保留显式
动作和预期身份；不能因 disk 与 candidate 不同就静默改动作、刷新预期修订后覆盖。

[恢复 Owner](../../apps/serve/service/resources/service/recovery.py) 的审阅前备份
核稳定磁盘修订，把完整内容存入 CAS，再登记关联 review 的恢复版本；备份失败须
停止覆盖。同操作重放与已完成成员不应重写新内容，部分成功不得显示整批成功。
恢复记录、文件写入、备份历史与批次收尾须对账，不能把单文件原子性称跨文件原子。
尚未提交的内存草稿不承诺崩溃后已保存；决定选择、普通保存、审阅提交与撤销分开核验。
这些要求不追认所有异常路径已实现，尤其下述提交捷径身份 gap 仍须 Owner 验证。

[批次持久化](../../apps/serve/service/resources/persistence/batch.py) 的
`reconcile_completed` 只在非空批次所有成员均为 completed 时修复批次投影；
不根据 pending 消失、磁盘存在或按钮不可点击推断完成，也不重新执行文件写入。
`prepare` 校验成员身份和已有决定，完成成员不退回 applying；全员完成批次保持
completed。否则投影错误会把重试变成新的文件操作，覆盖审阅后用户的新修改。

[提交服务](../../apps/serve/service/resources/service/batch.py) 要求非空幂等键、
无重复且覆盖该批次全部成员的决定，先核验请求摘要/回执，再收敛完成投影。
已有回执返回与当前批次投影组合的结果；新键的全员完成请求仍拒绝改变已提交决定，
只登记结果，不走文件操作。当前捷径校验完整且唯一的 file_id 集合与原 action；
已有键另校验 batch_id/request_digest，但新键全员完成分支不调用 `prepare`，不能
将其描述为已核验 review_id、pending_revision 或磁盘身份。决定不可变、重试不重写
仍是要求；严格身份绑定也是安全要求，但此捷径的身份校验存在未闭合 gap，须由
Resources Owner 核验，不以当前实现取消要求或断言已复现覆盖。不得手工改库绕过；
混合完成/未完成成员的恢复还需检查各自操作回执，不能套用全员完成捷径。

[ReviewBatch](../../apps/desktop/src/renderer/src/features/resources/ReviewBatch.tsx) 分别
向 [ReviewBar](../../apps/desktop/src/renderer/src/features/workbench/ReviewBar.tsx)
传入当前成员可决定及批次仍有未完成成员的状态。完成成员的决定/撤销和全员完成后的
批量重选禁用，不代表提交收尾入口也应禁用；提交另按 busy、未决定数量和非空批次判定。
修复状态时保留原 UI 组件与业务 Owner，不新增第二套完成判据。

审阅提交后退出使用 Store 的具名 `completeResourceReview`，不套用手动关标签的
相邻标签导航。ReviewBatch 先要求响应成功且批次 completed，再清临时决定、收敛
内存草稿与路径；同步失败时保留错误，不进入完成导航。成功导航固定资料主视图和
目标项目，选择当前成员路径（无当前成员时取首成员），活动标签取 documentTabId
或总览。此导航转换不重新打开缺失文档，也不证明删除类成员一定落到文件内容页；
须核验实际标签与文件存在状态，避免把“审核成功”混同于“返回落点正确”。

[批次契约](../../apps/serve/tests/contract_review_batches.py) 有重复决定、旧 applying
投影恢复及后续文件内容保护的定向用例；[界面测试](../../apps/desktop/src/renderer/src/features/resources/review.test.ts)
检查成员/批次按钮接线。实际验收还需通过真实审阅提交核对 API、UI 退出、磁盘字节与
版本数；历史修复的成功报告不证明当前代码已完成模型回合或跨平台验收。

## 审阅草稿、修订提交与撤销边界

[ReviewDraftStore](../../apps/desktop/src/renderer/src/features/resources/draft.ts) 按
project/batch/file 保存临时决定与 review、pending、candidate、expected disk revision；
编辑字节仍由原工作区 session 持有，不新增第二套编辑器或服务端可变草稿库。
成员消失、review 身份或 candidate 改变时 hydrate 丢弃旧选择；同一身份的 pending
revision 更新会更新选择。它不是磁盘 CAS 或提交成功证据，完成仍由 Serve 回执判定。

hydrate 的失效保护不等于提交刷新保护：当前 `submitBatch` 获取 refreshed 后直接
以新 member 身份调用 `choose`，保留旧 action/expectedDiskRevision，再由 `decisions`
读取重绑后的完整向量；此处没有调用 hydrate 的失效检查。不能提交用户从未看过的
后续 revision 仍是审阅不变量；refresh/rechoose 是否保持它尚待独立行为核验。
后续 Serve CAS/恢复仍可能拒绝，不能据此断言已覆盖，也不能用纯草稿测试证明该接点安全。

当前 ReviewBatch 提交对 dirty 的 revise 成员经 `reviewDraftBytes` 采集字节，刷新批次后
形成完整决定向量，将 `revised_content` 随决定交给批次 API；不是旧方案描述的先逐个
调用普通保存 API 再提交。Serve 在自己的批次应用流程内备份当前内容、以 expected
revision 调用 `commit_working`，再继续该成员的审阅决定。该步骤可能有独立恢复状态，
不能由“一个 HTTP 请求”推导整批跨文件原子写入；失败后保留原 Owner 的恢复与错误反馈。

选择 accept/reject/revise 与撤销不同。撤销先读当前修订：磁盘已偏离 candidate 或先前
revise 的 expected revision 不同，会预检并调用 `restore_candidate` 恢复协调；dirty
内存还需原工作区丢弃/同步。因此不能把所有撤销概括为纯内存操作，或认为关闭标签
就撤销了磁盘副作用。真实验证需检查恢复备份、期间新增输入和迟到结果，而非仅看选择清空。

文本比较左侧为 base；右侧随选择为 accept 的 candidate、reject 的 base，或 dirty
session 文本/当前磁盘内容。旧“始终 base→current”描述不适用所有状态。固定审阅 base
与历史 Version 的关联也不能互换；读取三种内容不授权跳过文件身份、修订或恢复校验。

[VersionStore](../../apps/serve/service/resources/persistence/version.py) 的 `finalize_review`
固定修改前的完整 `SnapshotIdentity`：正文对象、存在状态、路径、权限语义与批注对象；
`base_version_id` 只是历史关联，`base_origin` 保留此前 pending 来源。拒绝的
`_cancel_pending` 取 exact review.base 并核验恢复身份，不取最近 Version；普通无 review
的丢弃才取最近 Version，随后均由 `sync_working` 重新投影。必须保护修改前未封存的
用户输入，不将审阅拒绝等同普通丢弃。旧“不新增 Version、原用户修改仍 pending”的
要求不能直接写成当前保证：`commit_restore` 在恢复 base 不同于最近 Version 时会
条件封存 base，外部修改还可能生成 review backup；迁移保留旧历史也可能使恢复后
形成普通 pending。封版/pending 结果须分别核验，条件封版与旧要求的差异交 Owner 确认。

同一存储 Owner 的 `live_object_ids` 将 pending 与 batch 成员的 base/candidate 正文
及批注作为 GC 强引用；retention 排除开放 pending 的 `base_version_id`，否则审阅或
拒绝依赖的基线可能提前丢失。[恢复 Owner](../../apps/serve/service/resources/service/recovery.py)
在 applying 重查位置：target 只记已应用，before/partial/relocated 才继续恢复；其他
竞争状态进入 `NEEDS_ATTENTION`，不盲目覆盖。迁移历史资产保留另见
[持久化边界](../architecture/persistence.md#旧审阅数据读取不等于恢复旧运行-owner)。
这些具名分支不是完整恢复或平台验收；macOS/POSIX 权限结果不得外推 Windows。

[Turn 准入](../../apps/serve/service/chat/service/turns.py) 与文件审阅决定解耦：项目中开放、
失败或应用中的审阅批次，不阻断同一会话、新会话、队列发送或失败重发；审阅编辑器有
未保存内容也不成为对话准入条件。发送不查询审阅状态，不自动接受、拒绝或清空旧审阅。
显式审阅决定仍由 Resources Owner 处理；回合前基线采集、文件修订冲突和恢复校验保留，
真实资源操作失败仍明确报错。连续 Agent 修改沿用原审阅基线并更新候选，不将待审阅
候选视为已接受版本。相关纯草稿测试见
[draft.test.ts](../../apps/desktop/src/renderer/src/features/resources/draft.test.ts)；
它们不验证实际 Office 序列化、提交 CAS、撤销磁盘操作或真实下一轮准入。

待审阅期间磁盘偏离候选时，新回合以当前稳定磁盘内容捕获自己的修改前基线，
不推进工作头、不修改待审阅记录或自动封版。只聊天且文件不变时不产生新的文件候选。
若后续确有文件改动，原审阅基线和旧批次仍保留；未被原审阅基线/候选覆盖的写前
快照在现有回合记录中保留 GC 强引用，直到该文件显式审阅结束才释放已完成回合的
临时引用。保存、审阅和恢复的修订、身份及备份校验不因此放宽。

Pending reviews do not block chat when disk bytes differ from the candidate. Each turn captures
the stable current disk without accepting it or changing the working head or pending review.
Read-only turns create no file candidate. A later file change retains its otherwise unprotected
pre-write snapshot in the existing turn ledger until explicit review completion; normal revision,
identity, recovery and garbage-collection boundaries still apply.

以下为旧具名未决验收，是否已在后续关闭待 Resources/对应平台 Owner 核验，
不是当前版本故障复现；关闭须提供同类真实产品证据，不以确定性夹具或旧 MR 状态代替：

| 旧未决条件与来源 | 待核验的关闭依据 |
| --- | --- |
| 旧审阅未决 F2：真正 provider-failed 终态未验收，DOCX 设计最后增量未测试 | 真正 FAILED 终态的审阅收尾与恢复；工具失败后 completed、interrupted 或 failed 夹具不替代它 |
| 旧审阅未决 F2：真实文本/Office 批次未完成，Agent 请求超时 | 真实批次的提交、字节/版本/账本、重启及失败续跑；历史启动/健康检查不够 |
| 旧审阅未决 F2：新会话 open 500：`SessionCatalogStore.allocate()` unexpected `thinking` | 正常 UI 新会话与真实模型回合产生审阅批次；不自动认定今天仍复现 |
| 旧审阅未决 F2：Windows 真实 Desktop 未执行 | Windows 对应真实审阅/恢复流程；macOS 结果不替代 Windows |

旧局部证据的 PASS53 仅确定性交付夹具，11pass 仅纯草稿，1pass 仅导航源码接线；
均不关闭以上未决，也不证明完整恢复、Office 或模型验收。

## 回合资源摘要与诊断证据

[资源摘要](../../apps/serve/service/resources/service/context.py) 仅投影本会话的开放
review 与最近非空 capture 所关联文件；不遍历全项目，不复制文件正文，不另建 memory
或资源状态 Owner。路径排序后按该模块的字符上限裁剪，`omitted_count` 明示遗漏，
路径作为数据而非指令；pending review 也不是已采纳版本。该上限是字符数，不是 token
预算，不能与其他资源 AI 功能的正文预算混用。

[回合基线捕获](../../apps/serve/service/resources/service/history.py) 将摘要与基线交给
同一 `VersionStore.begin_turn` 事务持久化；[Delivery](../../apps/serve/service/resources/service/delivery.py)
对同 session/turn 重放读取原摘要，不按重放时的磁盘状态重新生成。由
[Chat 准入](../../apps/serve/service/chat/service/turns.py) 接入真实 `TurnInput`，
不是模型自行读取所有资源的保证，也不授权跳过开放审阅的显式决定栅栏。

[资源事件](../../apps/serve/service/resources/service/events.py) 通过独立 Trace writer
提供诊断，不充当版本真相或第二套操作账本。`context.prepared` 记录摘要指纹与长度，
不记录摘要正文，也不证明已发送或模型已理解。提交与证据写入之间可能有缺口，
不能承诺 exactly-once；证据写入的 `OSError` 警告不将已提交的业务决定改报失败。
排障须分别核对账本、回合输入与诊断关联，不能只看一个 prepared 事件。

[捕获契约](../../apps/serve/tests/contract_pending_capture.py) 包含会话隔离、同回合
冻结重放、下一回合状态变化与遗漏计数用例；其中预算用例使用 mock 状态，不能当真实
长项目或模型验收。真实验证须检查相同会话前后回合的输入、资源状态与 Trace 关联，
历史设计的模型回复与截图不证明当前版本通过。

## 回答摘录入库与来源保留

入口由 [Annotations](../../apps/desktop/src/renderer/src/features/assistant/Annotations.tsx)
调用既有 ResourceSaveDialog，提交回答身份、回答修订、UTF-16 选区范围、选中文字
哈希、目标项目与位置，不把页面可见字节数当字符范围。
[Assistant resources](../../apps/serve/service/assistant/service/resources.py) 核对当前
回答修订、范围切片与哈希；回答改变、非法范围、内容不匹配分别失败，不根据旧
选区直接覆盖资料。保存动作与整段复制是不同入口，不能拿剪贴板成功证明入库。

已保存来源仅从该项目/路径的导入记录挑选保留的 handle；自包含 citation 元数据
优先，旧记录才经原回答解析其保留句柄。记录、原回答或引用服务不可用时明确失败，
不解析任意链接来补齐来源。复用导入 provenance 表与既有引用解析，避免创建第二
套来源库；保存文件的有效性与来源可追溯/语义正确仍分别判断。
真实回归需核对长回答复制首尾、所选 Markdown 与原问题、引用计数/来源、目标目录
与文件名、保存反馈及打开后的面板状态。HTTP fixture 不证明系统剪贴板、原生保存
对话框或原对话/PDF 回跳；历史 macOS 截图与门禁数量不作为当前通过证据。

## 项目工作区与自动保存边界

### 文档会话、标签与关闭守卫

文档内容、dirty、revision与编辑状态属于DocumentSession；Tab只持有视图和布局
身份，不能以相同路径或每个Tab局部状态重新建立内容权威。当前
[splitTab](../../apps/desktop/src/renderer/src/features/workbench/workspace.ts)复制标签
投影时保持原sessionId，移动时沿用tabId；Office编辑视图复制成预览前先采集其
dirty字节。移动、分栏成功不等于Office运行时、undo或selection已完整实机验收。

关闭队列只在dirty session的最后一个Tab引用处进入pendingClose；取消会清空
关闭队列，保存失败不继续关闭，丢弃恢复已保存内容。最后一个引用关闭后才移除
session及其保存委托/历史等状态，不因关闭另一个视图丢失未保存内容。
[Dock关闭弹窗](../../apps/desktop/src/renderer/src/features/workbench/Dock.tsx)的保存
按钮在conflict时显式变为覆盖保存；不能把旧“三选按钮”概括成自动覆盖许可。
需验证逐个关闭、批量关闭、取消、保存失败和外部冲突，不能仅凭标签消失报成功。

布局由[layout Owner](../../apps/desktop/src/renderer/src/features/workbench/layout.ts)
持有递归leaf/split和两行、两列、最多四个非空面板的上限；非法拆分应保留原布局
及标签，不能留下孤立文档，不是无限分栏。文档revision是内容并发
令牌，不是长期版本号；已有版本准入、保存事务、PDF记录和Office生命周期章节
分别持有这些职责，扩展格式不得重新实现文件IO、版本账本或第二套预览状态。

分栏页签经[共同标签组件](../../apps/desktop/src/renderer/src/features/workbench/Dragging.tsx)
复用顶部 `NavigationTabs` 的标题、dirty、关闭与拖拽插入语义，不另造分栏专用样式。
[页签菜单](../../apps/desktop/src/renderer/src/features/workbench/Menu.tsx)把“拆分”与“移到
已有相邻分栏”分开：拆分受非空面板上限约束，移动须有实际目标；两者不能因菜单
文案相近而共用可用条件。拖拽边界取实际页签布局，不能恢复固定高度推算；移动后空栏
由布局 Owner 收拢。更改时核[工作区契约](../../apps/desktop/src/renderer/src/features/workbench/workspace.test.ts)
的满栏、相邻方向与空栏收拢，并在真实 Desktop 检查右键、拖拽、窄窗和焦点。

源码视图的自动换行属于[用户偏好](../../apps/desktop/src/preferences.ts)，缺省开启，
对已打开 Monaco 实例通过 `updateOptions` 生效，不重建模型或撤销历史；所有源码标签
读取同一偏好，重启后从偏好文件恢复。切换后应核对长行、选区与撤销、跨标签一致性，
不能以偏好序列化测试代替真实编辑器视觉与输入验收。

文件标签、布局、焦点与 dirty session 由
[DocumentWorkspaceRegistry](../../apps/desktop/src/renderer/src/features/workbench/workspace.ts)
按 project ID 持有实际工作区实例，缺少 ID 归入 null scope。不能仅过滤可见标签：
隐藏的编辑状态及异步保存仍需要原实例身份。当前 registry 直接使用传入 ID，
不在这里规范化路径或自行推导项目身份；切项目经产品 Store 的 `selectProject`
恢复目标实例焦点，不把相同文件路径视为跨项目同一编辑会话。

[个人偏好](../../apps/desktop/src/preferences.ts) 的 `autoSave` 当前默认开启，
缺失或无效配置回到该默认值，显式 false 保留；旧方案的默认关闭不再是现行事实。
[Dock](../../apps/desktop/src/renderer/src/features/workbench/Dock.tsx) 在外部 focusin、
pointerdown 或窗口 blur 时调用捕获工作区的 `saveFocused`；工作区内部和受标记的
选择交互区不触发此保存。它只处理聚焦、dirty 且可保存的 session，不是周期性保存
所有文件，也不能以红点隐藏证明字节已落盘。
单靠编辑器 `onBlurCapture` 不足以覆盖 iframe 与产品弹层的跨边界焦点变化；
在 [Markdown 可视编辑](../../apps/desktop/src/renderer/src/features/workbench/MarkdownDocument.tsx)
中，内部投影或编辑器销毁消息也不等于用户修改。实际输入意图先于工作区更新；
`Backspace`/`Delete` 可能不产生宿主 `beforeinput`，须在下一帧确认正文确有变化，
避免漏存删除或把无变化按键标成 dirty。切换可视/源码模式时不能让销毁阶段空内容
覆盖权威 session；定向验证应同时读编辑器、磁盘字节与 dirty 状态。

普通保存入口与显式封存入口不同，但不能据此推断普通保存不生成版本。
保存委托先 `prepare` 最新编辑状态，异步 `beforeSave`
后再次 prepare，再采集提交快照；[Monaco](../../apps/desktop/src/renderer/src/features/workbench/MonacoDocument.tsx)
在此边界同步 model 并序列化，而不是 blur 后延时猜测同步已经完成。工作区按
`changeVersion` 去重/串联保存；成功后只有提交期间没有新增编辑才清除 dirty，
冲突或失败保留错误状态。不能在通用工作区把所有委托字节当文本解码，Office 等
二进制委托有各自序列化职责。落盘后的版本元数据刷新失败单独报告，不把已提交
字节描述成未保存；也不由此推断版本与 UI 状态均已更新。

[保存事务](../../apps/serve/service/resources/service/history.py) 根据准入及 pending
状态决定自动封存，不能把所有保存统一解释为一次新增版本。
[VersionStore](../../apps/serve/service/resources/persistence/version.py) 对普通编辑器
保存使用以首次创建时间为起点、不滑动延长的合并窗口：仅符合来源、路径、状态、
时间及保护条件的最新版本可替换内容，保留身份、序号和创建时间，CAS 对象不变。
有别名、审阅/会话/恢复来源、交付或其他业务引用时不得合并；不能把这个有条件的
编辑器例外推广为历史版本普遍可变。窗口大小以 Owner 常量为准，历史方案不另设值。

定向依据包括 [工作区测试](../../apps/desktop/src/renderer/src/features/workbench/workspace.test.ts)、
[偏好测试](../../apps/desktop/src/preferences.test.ts) 及
[自动保存 E2E](../../apps/desktop/e2e/autosave-workbench.spec.ts)。修改该机制需真实
编辑后独立读回文件、检查保存期间的新输入、同路径跨项目切换，以及窗口内合并、
窗口外追加和被引用版本的保护；不能统一断言版本数量不增加。
状态指示、历史报告的截图或单测名称不替代当前代码的实际验收。

### 保存时格式化与字节约定

[偏好 Owner](../../apps/desktop/src/preferences.ts) 的 `formatOnSave` 当前默认关闭，
缺失或无效值回到该默认，显式布尔值保留；它不同于默认开启的 `autoSave`。
格式化属于 Desktop 保存转换，不属于 Serve 版本策略，也不是打开文件时的迁移。
旧提案中的默认 `true` 与其默认关闭目标冲突，不能据此改变现行偏好。

[格式模块](../../apps/desktop/src/renderer/src/features/workbench/format.ts) 集中声明
可格式化后缀与内建 Prettier 插件，不读取项目格式配置或加载第三方插件，也不为
格式化扩大文件准入。未支持的格式与解析失败分别返回显式结果；
[Monaco](../../apps/desktop/src/renderer/src/features/workbench/MonacoDocument.tsx) 和
[Markdown](../../apps/desktop/src/renderer/src/features/workbench/MarkdownDocument.tsx)
在保存委托中处理结果，失败警告后继续保存未格式化内容。异步结果回写前核对
编辑状态，不能覆盖等待期间的新输入；格式化成功仍不等于持久化已成功。

[文本字节边界](../../apps/desktop/src/renderer/src/features/workbench/text.ts) 以原保存
字节的首个行尾确定 LF/CRLF/CR，无行尾时用 LF，并恢复原 UTF-8 BOM。序列化也会
统一混合行尾，因此关闭格式化不保证混合行尾逐字节保真；不能继承旧方案的过宽
“原样保存”承诺。打开不产生 dirty 是独立编辑器约束，不以内部规范化文本重设
保存基线来掩盖编辑。修改时结合[格式测试](../../apps/desktop/src/renderer/src/features/workbench/format.test.ts)
与偏好/工作区测试，真实核对打开、格式失败、并发输入、撤销及保存后的字节读回；
本页未声称这些产品场景已经验收。

### Markdown 阅读与链接

[Markdown 编辑器](../../apps/desktop/src/renderer/src/features/workbench/MarkdownDocument.tsx)当前使用随容器可用宽度伸展的纸张，不再提供历史记录里的常规、超宽、全宽三档选择器；顶部旧提示也已移除。调整布局时核对当前[编辑器契约](../../apps/desktop/src/renderer/src/features/workbench/markdown.test.ts)，不要从旧截图推断控件仍存在。

编辑器语言在文档打开时固定；界面语言切换后若两者不同，显示可关闭的待应用提示。
关闭仅隐藏当前目标语言的提示，再次切换语言会重新允许提示出现；不能用立即重建
编辑器来消除提示，否则会改变当前文档的编辑状态。修改时核对上述编辑器契约及
真实 Desktop 的语言切换、关闭与原标签保留，不继承历史白屏或截图结论。

源码模式的 Monaco [查找遮挡适配](../../apps/desktop/src/renderer/src/features/workbench/find.ts)
根据当前命中是否被查找控件覆盖，动态启用顶部额外空间；无命中、下方命中或关闭
查找后不应继续推开正文。控件位置随实际边界同步，不以固定高度或永久增加上边距
解决首行遮挡。修改时核对[命中判定](../../apps/desktop/src/renderer/src/features/workbench/find.test.ts)
及真实编辑器中首行、下方命中与 tooltip 位置；旧静态截图不能代替交互验收。

[链接路由](../../apps/desktop/src/renderer/src/features/workbench/links.ts)只允许完整 HTTP(S) URL 经 Desktop 的 `openExternal` 打开；`#` 片段定位须匹配[显式文内锚点](../../apps/desktop/src/renderer/src/features/workbench/anchors.ts)，不能把较短来源标签误当目标；保存引用句柄由项目来源解析，只有精确、可打开且有匹配区域时直达 PDF，不可用或来源变化应反馈错误，其余有效状态保留预览。未知协议、本地文件和裸相对路径不作为浏览器导航目标。链接交互仍由现有编辑器处理，Tooltip 不是 URL 权限校验。先跑[链接契约](../../apps/desktop/src/renderer/src/features/workbench/links.test.ts)与[锚点契约](../../apps/desktop/src/renderer/src/features/workbench/markdown.test.ts)，再在真实 Desktop 核对点击、键盘、来源定位和保存重开；历史交付截图不证明当前构建。

### 托管全文的引用定位

托管全文的 `managed_fulltext` 引用由 [CitationService](../../apps/serve/service/assistant/service/citations.py) 消费服务器保留的回执，再通过 [ManagedFulltexts](../../apps/serve/service/literature/service/fulltexts.py) 按原项目、原会话、论文标识及原字节 revision 找回获取记录；任务结束后无需重新激活全文读取租约。找不到精确记录时不可用，字节完整性变化时标记来源已变，不借用其他会话或新版本，也不信任回执中的绝对路径来直接打开文件。

Desktop 将此来源与附件、文献引用一样交给已有 session-file 引用入口；会话、报告产物和已保存引用继续使用各自的受控 raw/preview 接口。文件读取仍由文献存储 Owner 持有，不把整篇托管全文复制到 Agent 工作区。回归覆盖原回执解析、字节读取、会话/项目/版本隔离，以及会话和保存引用的工作区路由；真实验收需点击会话及报告引用，核对原 PDF 页码与高亮，并保留普通全文打开对照。

### 引用 PDF 的翻译源身份 / Citation PDF translation identity

PDF 全文翻译保留 `session-file` 中的 answer、saved 或 artifact 引用身份，而不把来源句柄转换成文献库 ID 或磁盘路径。请求中的 `citation` 与文献库/项目定位互斥，必须有原 PDF 的字节 revision；三种引用载体不代表底层来源类别，实际附件、托管全文、文献或项目文件仍由 Assistant 的回执解析及原存储 Owner 读取。直接缺失身份或混合身份应拒绝，不通过强制入库、隐藏翻译入口或任意文件读取兜底。

组合根将受控引用读取注入 Literature AI；Assistant 按本次数据归属 principal 校验 answer/artifact 的 session，再校验原回答或产物版本、handle 与回执。saved 引用继续只读指定项目导入回执所保留的 handle。模型计量账号与数据归属 principal 分开，不能用账号切换扩大本机数据权限。准备、执行重读及结果提交前的读取复用同一权限路径；任务源 key 保留完整引用身份并与 PDF SHA 隔离，前端文档 key 也包含引用，切换文档时沿原生命周期取消订阅并拒绝旧结果。现有文献库和项目请求及其授权读取保持兼容，不迁移用户文献或正文。

Full-document translation retains the answer, saved-report, or artifact citation carried by a `session-file`. A citation is exclusive with library/project locators and requires the PDF byte revision. The carrier is not the underlying source kind: existing Assistant receipts and storage owners still resolve attachments, managed full text, library attachments, and project files. Missing or mixed identities fail closed; translation neither forces library import nor falls back to arbitrary filesystem paths.

The composition root injects the authorized reader into Literature AI. Session access uses the data-ownership principal, independently of the model billing account; answer/artifact revisions and receipt handles remain checked. Saved references use only the named project's retained import receipt. Preparation and execution rereads share that boundary. Task and frontend document identities retain the citation and PDF revision so switching documents cannot apply stale results. Existing library/project requests remain compatible and user data is not migrated.

## 发布快照与可编辑产物副本

### 独立副本与发布身份

“复制到资料库”不是移动源文件，也不是让目标持续跟随源文件变化。
[Content 描述符复制](../../apps/serve/service/content/service/native.py) 的
`copy_descriptor_exclusive` 从已打开源生成排他创建的独立目标，保持源描述符原位置，
同步目标与目录；异常清理核对本次目标身份，不删除同名替代项。
不要用路径重新解析、硬链接或消费暂存名的移动替代这一路径。
显式移动、覆盖替换及其他原子发布由各自 Owner 持有，不把所有文件操作改为复制。

[快照发布](../../apps/serve/service/content/service/snapshot.py) 以 scope/digest 的
持久 claim 区分 prepared 与 completed。旧无 claim 对象仍须完整校验；既有损坏
对象不能从当前工作文件悄悄修复。恢复 prepared 目标须核对 marker 与物理身份，
完成复制并读回后才登记完成，不用成功创建文件名证明内容完整。

[PreparedContent](../../apps/serve/service/content/service/assets.py) 发布前复核暂存
身份与字节，已有目标仍须证明同一操作 marker 与内容，不能把 FileExists 当幂等成功。
资料副本可独立编辑；发布字节、编辑 draft、导入回执和用户源是不同身份。
最终文件名可能在复制期间被外部观察，独立复制不等于整个文件系统瞬时原子可见。

改动按 [快照契约](../../apps/serve/tests/contract_artifact_snapshots.py) 及受影响导入
契约核验独立物理身份、大小/摘要、旧对象读取、失败清理、冲突与重放；真实验证
还须生成产物、导入非默认目录、修改或删除源后读回副本、重启与重复导入。
各平台描述符与文件系统安全语义分别核验，macOS 结果不证明 Windows 通过。

### 旧文本批次方案的必要理由

旧 Documents/ChangeSet 实施计划已被文件快照审阅取代，不能恢复其表名、API、
状态清单或假定所有格式仍只支持文本。仍需保留的理由是：写后监听无法补回首次
写入前的完整基线；路径事件、归因证据、实际 before/after 与用户决定分别核验。
不完整 Diff 不能伪造完整行号或数量，未支持格式不能声称已审阅；用户处理变化须
核对当前权威修订，历史聊天卡片不成为接受或恢复的写入授权。

逐文件原子替换、预校验或进程内补偿不等于跨文件瞬时原子提交，也不证明崩溃后
可恢复。失败/中断后的已落盘变化不能因缺成功事件而失去核验与恢复入口；其实际
候选、批次终态与版本语义仍由当前 Resources Owner 和真实验证决定，不将旧计划
中整轮接受/撤销、空版本或崩溃排除范围写成现行保证。

### 文件变更候选不等于最终交付

观察、声明和发布是三种事实。[声明消费](../../apps/serve/service/chat/runtime/live.py)
将 `intermediate` 登记为工作文件引用，`final/supporting` 才进入
[发布 Owner](../../apps/serve/service/chat/service/publication.py) 的字节捕获与持久记录。
显式声明 ID 重放返回原捕获版本，同 ID 不同请求冲突，不能因源文件后来变化
重新生成旧交付。发布投影按 publication 身份去重；pending 投影可恢复并确认，
这不等于自动资料库导入、全部跨库操作原子提交或供应商任务已结束。
声明失败使用产品产物错误事件，不伪造 Runtime 工具失败。

[Codex 文件监听](../../packages/adapters/codex/scholarseed_codex/watch.py) 按 `watchId`
路由，只在活跃且无歧义的 Turn 中收集工作目录内的合格路径。该关联说明事件所属
监听与时间窗，不证明文件必然由 Agent 写入，也不证明最后变更就是最终交付物；
同目录内其他进程的写入仍须与明确产物声明区分。不得解析命令文本猜测写入清单，
或把监听候选直接称为已验证的最终成果。

历史 Markdown 实验稿的“只显示最新已完成 Turn、单张汇总卡、最后文件优先”是当时
策略，不是当前卡片契约。当前 [ArtifactCard](../../apps/desktop/src/renderer/src/features/assistant/Artifacts.tsx)
逐项渲染传入产物；实际 Turn 筛选还须核对调用方，不能由该组件外推历史保留或
`role=final` 的全链路优先级。修改此路径需分别验证结构化变更、脚本写盘、同目录
非 Agent 写入、多文件、中断与重启恢复；监听代码和旧实验计划都不是实时产品验收。

[产物卡打开](../../apps/desktop/src/renderer/src/features/assistant/Artifacts.tsx) 先查询
当前会话的资源关联；只有同产物、当前项目、completed、无错误且存在 node 的关联
才打开资料库副本。等待期间会话或项目改变时放弃旧结果；关联查询失败明确反馈，
不按文件名猜路径。没有合格关联才走默认打开/会话预览，已保存标签不是直接写入
Agent 源文件的授权，也不能把已导入副本与尚未导入的产物当成同一个编辑目标。

[ArtifactService](../../apps/serve/service/chat/service/artifacts.py) 将发布快照和用户编辑
分开：已发布产物的 `read_raw` 优先读取 SQLite draft；`export_bytes` 仍读取不可变
发布字节，`export_document_bytes` 优先读取 draft。修改编辑路径不得将 draft 写回
发布快照，或让内部快照导出静默变成用户最新编辑版本。

[会话 raw API](../../apps/serve/service/chat/api/sessions.py) 的 GET/HEAD 返回当前文档，
PUT 必须携带 `If-Match`：缺失返回 428，修订冲突返回 412；成功返回新 ETag。
发布副本写入在同一事件事务内比较当前内容修订、核对新旧字节的编辑资格、保存
draft 并追加产物变化事件。重开应获取当前文档修订，不能拿旧发布哈希覆盖最新编辑。

编辑资格由来源和 [Workbench 格式投影](../../apps/serve/service/workbench/domain/model.py)
共同决定：FILE_CHANGE 或已发布 ARTIFACT_PUBLISH 才能进入该编辑路径，普通
`can_edit/can_save` 之外还可能有 `can_edit_artifact`。后者要求注册资格、处理器及
实际内容检查通过；不能把旧记录的“Office 全局只读”视为现行规则，也不能据此
反向声称所有 Office 格式均可编辑。当前契约包含 XLSX 发布副本可编辑用例。

[用户导入](../../apps/serve/service/assistant/service/resources.py) 调用
`export_document_bytes`，可选预期哈希针对实际导出内容比较；导入来源键包含会话、
产物和本次内容哈希。产物身份与已保存关联的查找不等于导入幂等键，不能笼统描述为
“所有关联只按身份、不比较哈希”。Markdown 导入还可能经过所属来源上下文转换。

[导入修订读取](../../apps/desktop/src/renderer/src/features/assistant/api.ts) 通过带
凭据、no-store 的 raw HEAD 获取当前 ETag，并校验 SHA256 格式；缺失、畸形、HTTP
失败或网络异常返回 null，不把卡片旧哈希当刷新成功。保存后事件与当前修订应共同
使导入采用最新编辑内容；正确修复不是关闭 expected hash 或并发保护。

[会话产物契约](../../apps/serve/tests/contract_session_artifacts.py) 中的
`test_published_document_draft_is_durable_and_snapshot_is_immutable` 覆盖
MD/TXT/PY/XLSX 的重建读回、旧 revision 拒绝、导出副本与发布字节不变。
该契约不证明当前真实 Desktop 的编辑、重开和资料库导入通过；修改时还需按实际
格式操作产品、读回保存结果，并分别核验快照和副本，不能沿用旧截图作为新验收。

## 项目惰性激活与批量版本发现

Supervisor 的 `start` 只检查 preparation 绑定并启动活跃项目维护循环，不在这里
逐个恢复全部历史项目。`schedule_all` 面向已经准备的项目；离线或忘记登记时清理
对应活跃状态，不能把重新上线当作自动预热全部旧项目的授权。
这只说明 Resources 生命周期，不证明整个 Serve 启动没有其他数据准入或恢复成本。

资料树处理器在读取树前等待 `activate_project`。Supervisor 持有项目准备锁和
当前可用周期的 prepared 状态，调用[ResourceActivation](../../apps/serve/service/resources/service/activation.py)
按序恢复 pending、working mutations、交付和迁移，再尝试 GC；准备后重新确认项目
可用，才建立事件消费与调度扫描。GC 是单独 best-effort 维护，失败记录日志后继续；
不能把它改述为“任何准备步骤失败都禁止读取”，也不能将此例外推广到恢复步骤。

[Agent 文件交付](../../apps/serve/service/resources/service/delivery.py) 的 `begin_turn`
直接等待同一个 `prepare_project`，不依赖 UI 先打开资料树。Supervisor 编排可用周期，
ResourceActivation 负责恢复顺序，由组合根绑定；不新增第二套 registry 或恢复器。
首次打开大项目仍可能等待该项目恢复，增加全局启动超时不是这类职责问题的解法。

首次扫描用 `versioned_paths` 一次取当前 identity 至少有一个已发布 Version 的路径集；
identity-only、managed 集合和已有 Version 不是同一判据。集合只用于本轮扫描，不能
缓存为跨请求权威；rename 使用当前路径，历史 Version 的存在不要求它就是当前文件内容。
集合外候选仍经[版本服务](../../apps/serve/service/resources/service/history.py) 的
`ensure_initial` 与 writer lock 重查初始状态并调用存储 Owner，不因批量快照绕过并发
幂等或未完成交付的初始版本资格。这里是已有机制，不是新增数据迁移或回滚许可。

## 回合差分事实与 Agent 归因

[Delivery](../../apps/serve/service/resources/service/delivery.py) 在回合开始捕获合资格
路径基线，终态重新枚举合资格路径并包含原基线的缺失路径，稳定捕获后比较 revision、
mode bits 及移动等变化；不是只监听 Bash 或用文件事件决定所有差分路径。
扫描合资格资源也不是监视整台机器。UNKNOWN outcome 不结算确认终态，已有收据和
staged 快照有自己的重放/恢复路径，不应在重复终态重新解释当前磁盘为原回合结果。

归因与差分事实分开：当前 `_attribution` 接受记录的路径 hint，或候选文件名在
记录 tool call 文本中出现时投影为 Agent，否则为 UNKNOWN。这是实现采用的关联
启发式，不是同一路径每次写入都由 Agent 执行的证明；不能从旧“仅精确事件”方案
推导当前因果可靠性或无误报保证。

[VersionStore.finalize_review](../../apps/serve/service/resources/persistence/version.py)
对非 Agent 归因成员同步 external working pending，不创建该成员 PendingReview；
Agent 关联差异才构造审阅候选。因此旧“外部变化也全部进入同一审阅批次”的要求
不能写成已实现事实，也不能在知识治理中擅自扩展审阅或取消该要求。回合外的外部
观察没有该回合身份，不应伪造聊天审阅卡。修改规则前需由 Resources Owner 明确
需求、归因证据与现行差异，保护源文件基线、已有版本、失败回合与重复收尾语义。

相关依据为[交付契约](../../apps/serve/tests/contract_resource_delivery.py)。确定性文件
差分与持久化测试不证明真实工具归因、Office 预览或实际模型回合均正确。

## 回合期间产品导入与 Agent 新增的区分

[Delivery 结算](../../apps/serve/service/resources/service/delivery.py) 对新增候选批量查询
当前版本资格，只有 `snapshot_state` 为 SAVED、working revision 与本次稳定捕获
相同、head 为 present 且 mode bits 相同时，才跳过生成 Agent 待保存/待审阅交付。
这样避免把回合进行期间已经由产品保存的导入文件再次当作 Agent 新增。

不能仅凭导入来源标签、路径出现或旧“已保存”显示跳过审阅，也不能把这组条件
简化为只比较正文哈希；用户修改或权限语义变化仍需所属版本/交付机制处理。
同内容移动匹配和缺失初始基线有独立分支，不由这一新增候选规则取代。
真实回归需分别验证回合中产品导入保持已保存，以及导入后发生修改仍正确结算；
本节描述源码机制，不继承旧缺陷记录的完成声明。

## 为什么这样组织

能力展示只需当前返回文件的资格与已保存事实。为了页面节点而全库扫描、重复探测
Git 根、逐文件开 SQLite 连接，会把全库大小和重复初始化成本放大到每次列表请求。
按路径投影和批量查询减少这类重复工作，但不证明整个请求复杂度只取决于页面大小：
项目激活、目录树扫描、关联目录和 Git 观察仍有各自成本。

手动准入是持久版本资格事实，不是内容读取授权、导入成功或任意安全检查的绕过。
实际分类仍受文件大小、格式、忽略规则、Git 管理与已有版本状态影响。
资格变化不是文件删除证据；已有历史的保留由版本 Owner 决定。

[定点枚举](../../apps/serve/service/content/service/enumeration.py) 检查解析后的允许根、
文件类型和排除条件，关联根也由 Content 提供；消费者不得自行拼路径扩大观察范围。
这里的 `resolve/stat` 检查不是原子 no-follow 写入保证，不能推导出所有平台竞争安全。
写入、恢复与删除须遵守对应平台存储边界和[持久化规则](../architecture/persistence.md)。

### 产品写入的观察范围

Content 的写入通知先保留 watcher 回声抑制，再按登记的资源根和关联根取交集；
产品拥有的会话等目录不进入资源版本观察。判断使用逻辑路径与已登记排除范围，
不依赖目标仍存在，保证删除仍可更新已有身份。
Resources 仅枚举变更文件或子树，目录移动按目标子树补充新候选，已有身份仍由
版本 Owner 映射和保留。显式项目扫描不受此限制；单批资格判定只读取一次设置
快照，并批量查询手动准入，避免逐文件初始化数据库。

会话创建的目录准备（含平台权限准备）通过 Activities 托管线程运行；调用方
等待实际完成后才释放会话串行锁，即使请求取消也不提前结束资源生命周期。
这隔离同步磁盘工作对事件循环的影响，不承诺磁盘或权限调用自身有固定完成时间。

## 验证与更新

### 历史工作台要求的继承边界

旧 Research Workbench 设计将研究元数据与通用文件版本混在同一规划中；其后已将
通用 Version/Delivery 的职责移交 Resources。修改版本、差分或恢复时，不能恢复
第二套研究专属内容版本库，也不能凭历史图中的实体名称认定当前产品存在相同能力。

仍需保留的验证要求：比较 Base/Target 不改变写入基线；恢复历史内容采用追加版本，
而非覆盖已有历史；第二会话或外部编辑引发冲突时，旧编辑授权不得覆盖新内容，
用户草稿与原选区证据不能被静默丢弃。重复交付与重启恢复应核对同一业务身份，
不得生成重复交付或跨项目关联。这里是需要维护的约束，不是这些路径已真实验收。

旧方案要求失败回合的变化只标为未交付；当前终态、审阅候选与版本发布的具体
规则须沿本页 Delivery/VersionStore Owner 核对，不能把旧结论写成当前全称保证，
也不能在知识治理中取消该要求。旧方向关联、召回审计及固定工作台布局未由此页
承接；它们不属于通用文件版本实现的证明，产品要求的去向仍须分别确认。

真实验证至少包含查看旧版本后继续编辑、外部冲突、失败回合、重复收尾、恢复后
继续使用，以及 Renderer/Serve 重启与项目切换；同时核对文件内容、版本/交付事实、
实际界面与最终截图。历史 mock、直接 endpoint 或旧截图不替代当前产品证据。

相关确定性入口为 [资源扫描契约](../../apps/serve/tests/contract_resource_scan.py)、
[资格契约](../../apps/serve/tests/contract_resource_eligibility.py) 与
[树契约](../../apps/serve/tests/contract_content_tree.py)；按改动核对定点观察、越界路径、
分页、Git/手动准入分类及已有历史保留，不能把文件存在当作这些测试已通过。
真实验证还需 Desktop 首次打开、刷新与展开目录；正确列表与性能证据分别记录。

[项目激活契约](../../apps/serve/tests/contract_resource_activation.py) 覆盖轻量启动、
显式激活、项目隔离及离线根不能被重建等场景；改准备机制时还核对无 UI 的 Agent
交付路径、失败重试和维护排空。healthz 可达不证明项目恢复、扫描或会话回合完成。

性能比较固定项目规模、页面范围、激活/缓存与运行版本，单独报告首次和稳定请求；
健康探针或 HTTP 200 不证明耗时改善。旧报告的阶段耗时字段在当前 Resources 源码
未找到，旧毫秒表与测试数字不成为当前基准或现成诊断能力。
列表组合、观察范围、资格规则或批量查询变化时由上述 Owner 更新本页及相关契约。

## PDF 阅读资源与业务状态

[Viewer contract](../../apps/desktop/src/renderer/src/contracts/features.ts) 的 `active`
表达当前可见性，不等同于 React 挂载或业务状态寿命。
[PdfDocument](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)
与 [PdfLifecycle](../../apps/desktop/src/renderer/src/features/workbench/pdf/lifecycle.ts)
分别持有呈现与重资源：失活时清页面/文字缓存，释放字体与 LoadingTask；恢复时按
阅读状态加载当前页。generation 拒绝旧异步结果，destroy 同一 task 保持幂等。
不能为保留标签状态让隐藏标签永久保有重资源，也不在 Dock 按 PDF 名称硬编码淘汰。

总页数与已加载页面代理分开；当前页先加载，邻页和 outline 后补，不用整文档初始化
阻塞正文。[页面 owner](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx)
分别暴露 canvas 与 text readiness；画布有像素不代表搜索、选择和文字层已就绪。
退出页面须等渲染终止后释放 canvas 与页面缓存，不能仅隐藏 DOM 宣称内存释放。
legacy 批注是否需要恢复由 attachment catalog 判定，不通过裸字节搜索猜测。
前端停止订阅或投影不意味着后台 AI 任务被取消。

相关确定性入口为 [生命周期测试](../../apps/desktop/src/renderer/src/features/workbench/pdf/lifecycle.test.ts)
与 [渲染测试](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.render.test.ts)。
真实验证分别记录首屏、多个 PDF 标签切换、阅读状态恢复、关闭与资源释放，保留
搜索、选择、批注和导出回归；截图证明视觉，时序/结构性 owner/内存另有运行证据。
RSS 不即时回落不能单独证明资源泄漏或释放；固定 corpus、DPI、运行版本和同机基线。
历史提案的固定 SLA、测试数量或 Windows 状态不追认为当前通过。

### 后端 PDF 技术边界

[Serve PDF 平台](../../apps/serve/service/platform/pdf.py) 用窄能力统一结构、布局、
坐标与渲染，不把文献标识符、引用段落、业务准入或 AI 动作搬成万能 PDF 服务。
当前依赖分别为 pypdf、pdfplumber 和 pypdfium2；产品采用此拆分以减少许可证、
几何及渲染职责耦合。第三方许可与发行 notices 仍须核真实锁定依赖及构建产物，
不能由提案列出的许可名或源码 import 推断已完成合规验收。

PDFium 渲染结果统一 RGB；normalized viewer、CropBox、rotation 与文字布局坐标
须同页核验，能提取文字不证明选区哈希、双栏/CJK、图表排除或引用回跳正确。
[提取版本](../../apps/serve/service/workbench/service/extraction.py) 与
[物化版本](../../apps/serve/service/workbench/service/materialize.py) 参与缓存身份，
算法变更需核旧键失效与重建，不能复用旧几何缓存并称行为不变。
独立产品 Skill 由自身 Owner 维护 PDF 能力，不反向导入 Serve 平台模块。

`embedded_pdf_records` 校验唯一 `scholarseed-annotations.json` 的大小、codec 与页码，
并合并标准 PDF 阅读标注；已有记录只补识别原生来源，不重放内嵌记录覆盖编辑。
无效内嵌记录告警后忽略，独立有效的原生标注继续解析；无效容器返回空记录。
来源描述随记录保存，防止删除复活和显示/导出重影。详见 [PDF 几何与记录边界](pdf.md)。
容器准入仍归其 Owner。 / Embedded records are validated and reconciled with native PDF reading
annotations. Existing records receive native backfill without replaying embedded edits. Invalid
embedded data does not hide valid native annotations. Retained provenance prevents resurrection
and duplicate appearances; container admission remains with its owner.
改动核 [引擎契约](../../apps/serve/tests/contract_pdf_engine.py)、
[布局契约](../../apps/serve/tests/contract_pdf_layout.py) 和
[记录契约](../../apps/serve/tests/contract_pdf_records.py)，再验证真实选区、回跳、
批注导出/重新导入及截图。源码迁移不代替 wheel/技能包闭包与各平台实际验收。

### PDF 自动区域与权威裁剪

[Region manifest](../../apps/serve/service/workbench/service/regions.py) 归 Workbench
索引，不由 Renderer 另建检测器：revision、提取器版本、page、kind 与规范化 quad
参与 region ID，manifest 同时声明坐标空间和不可用页。[提取器](../../apps/serve/service/workbench/service/extraction.py)
分别生成可交互 Region 与排除文本的 Omission；公式可操作不意味着其文字应被排除。
检测依据是可审计信号，不等于概率或百分之百召回，手动框选仍是漏检兜底。

项目文件与文献附件保留各自读取/准入入口，不用通用裸文件接口绕过资源身份。
自动裁剪提交源 revision、页与 region ID，服务端从该文档索引重解析区域，再由
原始 PDF 字节生成 PNG；不接受客户端替换自动区域 quad。手动框选的受限坐标与
自动区域身份是两条不同边界，不能为了兼容混成自动坐标 fallback。
当前项目入口先 snapshot 校验 revision，再单独 read_bytes；这不等于已证明两次读取
无竞争，不能据路由中有 revision 检查就宣称整个裁剪链原子绑定成功。

解释与 LaTeX 转写需显式动作；悬停不是模型调用授权，转写不是论文事实证明。
系统剪贴板复用 Electron 既有能力，不以可见 canvas/DPR 作为权威截图来源。
区域 overlay 保持文字选择/滚动/链接/批注可用，按钮与键盘焦点分别验证；源码样式
不证明这些交互通过。来源增强与不可信 TeX 编译不属于当前本地检测交付，不能为
提高召回擅自接网络下载、执行 TeX 或改变授权。验证分别覆盖版本变化、缺失区域、
不可用页、旋转/双栏/CJK、复制与真实多模态动作，不能由旧 implemented 状态追认。

### 图表解读的请求生命周期

[Literature Figure](../../apps/serve/service/literature/service/figure.py) 保有权威 PDF
源、revision、区域与 crop 的编译；共享 AssistantActionService 执行一次性模型动作，
不把 PDF 输入硬塞进文本 Resource 域。成功终态重新读取源 hash，拒绝源变化后的
旧解读；用户提示词是受限要求，不拥有改写来源或安全规则的权限。

[Figure API](../../apps/serve/service/literature/api/analysis.py) 先检查图片能力和准备，
在同一 POST SSE 中先给 prepared/crop，再交共享 action_stream。prepared 不是模型
成功，delta 只作临时预览，复制等后续操作以完整 terminal output 为准。
图表不走旧长任务提交，全文解读/翻译仍有独立长任务机制；不能将一次性流结论
推广为取消全部 PDF 后台任务。

取消须核 owner 与 invocation；中止 fetch 不证明上游已停止，迟到输出不可覆盖
新选区或切换后的文档。真实验证包括个性提示词持久化、生成中首段、完整终态复制、
取消/立即重框及生成中替换源，分别核输入身份、事件和界面。
[图表流契约](../../apps/serve/tests/contract_figure_stream.py) 是定向入口，不把协议
fixture、历史截图或 HTTP 200 当真实多模态模型调用和取消终态证明。
