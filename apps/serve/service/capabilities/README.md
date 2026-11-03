# 本地插件作者契约

当前提前集成分支暂不透出创建技能和对话组件预览入口，设置页隐藏系统预置的 `plugin-create`；相关实现、技能包及运行时发现保持不变。这是前端展示限制，不是禁用或权限隔离。用户仍可上传自己的插件 ZIP，检查并确认安装；正常对话组件继续运行。

## 当前范围

当前源码提供作者 CLI、产品 plugin-create Skill、候选检查、对话组件预览、明确安装确认，以及启用组件注册和通用交互入口。安装后的流程仍由 Skill 指令和工具推进；自定义 JavaScript 在对话内呈现，不生成独立插件页面。组件可用性取决于设置中的启用状态，不依赖用户先输入 `/技能`；启用不立即渲染，也不自动执行全部 Skill。本文描述实现机制，不表示真实产品、四个科研流程或跨平台验收已经通过。

插件继续使用现有 Skill ZIP 与 `.scholarseed-package.json` 完整性清单。新增 `.scholarseed-plugin.json` 仅描述插件，不能替代包清单或使用 `.scholarseed.json` 冒充内置技能权限。当前协议使用一个根 `SKILL.md` 作为入口。

## 离线 CLI

在安装了产品后端的 Python 环境运行：

```bash
python -m service.cli.plugins describe
python -m service.cli.plugins describe --identity
python -m service.cli.plugins prepare ./contract.json
python -m service.cli.plugins validate ./my-plugin/.scholarseed-plugin.json ./request.json
python -m service.cli.plugins --host-version 0.2.0 pack ./my-plugin --name my-plugin --version 0.1.0 --output ./my-plugin.zip
python -m service.cli.plugins --host-version 0.2.0 check ./my-plugin.zip
```

`--host-version` 是明确的兼容检查目标；省略时读取已安装的 `scholarseed` distribution 版本。源码检出可按开发规范以 `PYTHONPATH=apps/serve` 使用实际已核验的解释器，不能因此把源码检查当作已安装产品验收。

所有输出均为 JSON。`describe` 返回实际 Pydantic JSON Schema；`pack` 复用原 Skill packer，不执行源码目录中的脚本，也不覆盖已有 ZIP；`check` 核对真实 ZIP 中的文件摘要、描述身份、兼容范围及声明资源。退出码 0 表示对应离线检查通过，1 表示失败；命令行参数错误沿用 argparse 的非零退出码。

`describe --identity` 返回契约 `version` 和规范化内容的 SHA-256。完整 `describe` 包含描述 schema、组件请求 schema、SDK 状态形状与消息上限。两项与作者使用的快照完全一致时可以跳过静态契约探索；这不是 Desktop 版本，也不能跳过当前 slot、权限、依赖和安装检查。`validate` 检查完整请求及该 slot 的输入 schema，不创建交互、不预占 slot，不授予权限。必需字段错误返回字段路径与缺失字段名，不回显用户输入；修正该字段，不删除其他材料或已填值来通过校验。

运行中的 Agent 可通过 `scholarseed_bridge` 调用 `component/preflight`，传入 `{"slots":["research.my-selection"]}`。返回每个 slot 是否可用及 occupied/reserved 原因；它包含已占用但当前不可见的 slot，不泄露其他插件内容。注册表不可用时明确失败，不把未知当空闲。检查不预占资源，安装与启用仍须再次检查竞争。

## 创建方式

使用产品 `plugin-create` 时，先说明科研目标、输入来源、用户决策点、交付物及禁止的副作用。AI 澄清必要缺口后生成源码、预览场景和 ZIP，用户从安装卡片检查、预览并明确安装；创建成功不等于生成技能实际可用，仍须用真实材料验证卡片回传与后续流程。

`prepare` 一次核对本地契约快照与当前宿主契约，匹配时复用快照；不匹配时返回当前契约，不再重复发现。它不授予权限或预占 slot，动态冲突及安装安全检查仍执行。安装卡片发布只返回 `published` 和固定包身份，不表示安装成功，也不阻塞创建对话。多轮修改分别使用新版本、新 ZIP 路径与请求 ID，旧卡片仍指向旧包；用户可稍后预览、安装或重试，不需要重发创建消息。

产品会话通过 `scholarseed-skill-python -m service.cli.plugins` 使用作者 CLI。入口只分发已注册的产品命令处理器，不执行任意 `-m` 模块，不接受安装插件或 Python 依赖的子命令；原有内置脚本仍须通过冻结清单准入，普通任务 Python 不获得产品环境。

不使用 AI 也可以手工创建根 `SKILL.md`、插件描述、组件代码和场景文件。产品 Skill 的 [scaffold.py](../../../../skills/community/plugin-create/scripts/scaffold.py) 提供 selection、comparison、stages 三种可编辑起点；使用实际产品 Python 运行，指定新的目标目录、包名和真实 host 范围。脚本不会安装插件，输出不是已完成业务的成品。修改生成的流程、输入输出 schema、选项和分支，再用上述 CLI 打包。`pack` 已检查其输出字节，未变化时不必立即再执行一次 `check`；外部来源或发生变化的 ZIP 必须重新检查。

组件作者使用 [交互指南](../../../../skills/community/plugin-create/references/interaction.md) 与 [测试模板](../../../../skills/community/plugin-create/references/testing.md)；科学分析流程还需遵守 [证据规范](../../../../skills/community/plugin-create/references/evidence.md)。预览使用同一组件及桥接，仅以样例业务响应替代执行端。独立 HTML 可以作为样例体验载体，但不能代替宿主隔离、权限和真实等待流程验收。

`pack` 只接受目录，输出必须在源码目录之外。已有 `.scholarseed-package.json` 的依赖声明默认保留；也可通过 `--dependencies <JSON文件>` 显式指定。依赖格式复用现有审核依赖声明规则，但工具不会安装依赖、运行探测或声称这些依赖实际可用。源码没有依赖清单时按空声明处理，作者必须显式补齐所需依赖。

## 最小声明

```json
{
  "schema": 2,
  "id": "my-plugin",
  "version": "0.1.0",
  "host": ">=0.2.0,<0.3.0",
  "skill": "SKILL.md",
  "capabilities": ["interaction.answer"],
  "components": [{
    "id": "method-selection",
    "slot": "research.method-selection",
    "entry": "components/selection.js",
    "preview": "components/scenario.json",
    "input_schema": {"type": "object"},
    "output_schema": {"type": "object"},
    "actions": [{"id": "select", "capability": "interaction.answer"}]
  }, {
    "id": "question",
    "slot": "interaction.question",
    "public": true,
    "preview": "components/question.json",
    "actions": [{"id": "choose", "capability": "interaction.answer"}]
  }],
  "configuration": []
}
```

插件 ID、版本必须与最终包内 Skill 一致。components 可为空；自定义组件提供包内 UTF-8 JavaScript `entry`，公共引用使用 `public: true` 并省略 `entry`。预览是包含 data 和 responses 的 JSON 对象；responses 精确覆盖组件动作，每个响应为 state（resolved/failed/cancelled）与 data。组件 ID、单包槽位及组件内动作 ID 不可重复。所有已启用插件的自定义 slot 还需通过宿主互斥检查；公共 slot 不属于插件注册权。文件存在和编码通过不证明代码安全或浏览器运行正确。

`input_schema`、`output_schema` 与动作的 `input_schema` 默认是 object；可使用宿主公布的受限 JSON Schema，禁止外部引用和未支持的关键字。宿主在创建自定义交互时验证输入，在操作回传时验证动作输入及结果。准确范围读取 [descriptor.py](service/descriptor.py)，不能把通用 JSON 校验当作文献授权或项目访问检查。

动作由 `id` 与 `capability` 组成，能力名使用 `能力.操作` 形态，并必须同时出现在 `capabilities` 中。这只描述请求，不能添加任意 HTTP 路由、宿主导入或启动命令。离线 CLI 没有可信的运行能力目录，因此始终明确返回 `capabilities_verified: false`；不把 Agent Bridge 中存在某个操作等同于 UI 可以调用它。

配置字段包含 `key`、`type`、`label`、可选 `required` 与 `default`。当前只支持 string/integer/boolean，默认值严格匹配类型，不支持在清单中携带凭据或 secret 类型。配置定义不等于配置已经保存或注入运行环境。

类型检查不会自动识别普通字符串中的秘密；开发者仍须审阅配置和资源，不得把拒绝 secret 字段类型当作完整的凭据泄漏检测。

## 报告语义

- `valid`：本次离线结构检查中不存在 error；warning 不会被隐去。
- `validation_stage: offline`：尚未进行 UI 渲染和产品运行验证。
- `integrity_verified`：ZIP 文件集合、大小及摘要通过既有包校验，不是签名或安全审计结论。
- `capabilities_verified`：只有调用者提供真实宿主能力集合时才可能为 true；CLI 不伪造目录。
- `dependencies_verified: false`：声明格式通过不代表依赖存在或已获准安装。
- `authorized: false`、`runtime_verified: false`：离线工具不能作出授权或运行通过的结论。
- `sha256`：本次检查的完整 ZIP 身份；后续安装应重新检查相同字节，不沿用对可变目录的结论。

资源路径拒绝绝对路径、父目录、盘符、反斜杠、歧义分隔、Windows 保留名与编码路径。描述和预览 JSON 拒绝重复键、非有限数字和超限数据。检查不联网补依赖、不写用户安装目录、不创建运行状态。

## 桌面使用与授权

在技能设置中添加本地 ZIP，选择“检查插件”。报告展示包身份、SHA-256、请求的能力和诊断。预览在原生对话卡片容器中使用样例，不提交业务请求；只有可信主窗口中的安装确认会消耗候选并安装原始字节。候选限时 15 分钟、最多 4 个；相同内容复用候选，超限淘汰最旧候选，旧报告必须重新检查。普通 Skill 上传入口拒绝插件包，已有插件不能用普通覆盖安装绕过授权。

首次安装可选择仅安装、不启用；slot 冲突时不能报告组件已可用。启用与更新先检查完整候选注册表，冲突返回 slot 及占用插件，不静默覆盖。更新引入冲突时拒绝发布，并保留旧安装和注册。安装确认、版本切换与启用状态协调由 [routes.py](api/routes.py) 持有；普通 Skill 上传不能绕过插件安装确认。

公共组件按注册来源加载：UI 1.0 的 `literature.selection` 来自独立官方资源包，其余公共组件仍由宿主实现。自定义组件从校验后的科研插件包加载。工具或业务事件创建持久交互并由宿主解析 slot，不从模型提交的版本或指纹选择代码。文献 gate 仍拥有论文范围及授权规则；组件只提出选择，校验成功后原工具收到结果继续流程。Skill 声明版本用于其任务身份，UI 内容摘要用于组件绑定，二者不能互相替代。

### 官方 UI 1.0 系统依赖

Desktop 从 [UI 资源 Owner](../../../../packages/ui/README.md) 独立构建 `ui.zip`，随 Desktop 分发，启动时校验并协调系统依赖。它不是 Skill，无普通关闭、卸载或手动更新入口；普通插件上传与确认拒绝 UI 资源包。组件资源不因此重新编译进宿主 renderer。清单完整性不是发布者身份认证，不能把任意本地 ZIP 自称官方当作可信来源。

科研包可声明 `ui: {"compatibility":"1.0","exports":["React","mount","Button","Checkbox"]}`。公共 slot 引用由宿主解析官方实现；基础控件导出供自定义代码调用，不注册卡片、不获得额外权限。兼容版本与资源 `version` 分开；只接受 UI 1.0，后续不兼容版本尚未开放。

每次新绑定固定科研包和 UI 字节摘要，资源在同一隔离租约内加载；更新只切换新绑定所用资源。旧绑定、数据、草稿、权限和动作含义不被覆盖。迁移前 `host-v1` 选择卡保留原宿主实现仅服务旧绑定，不用新版 UI 解释旧卡。旧快照目前保守保留，不自动回收；此为运行快照保留，不是多版本任选平台。

预览也固定资源并复用相同组件、桥接和动作校验，业务响应用样例。检查后的科研候选若依赖已变，安装拒绝并要求重新检查。UI 更新不得删除既有导出或改变公共动作契约；静态清单不能证明 JavaScript 语义兼容，仍需包级回归和实际预览验证。

### 对话槽位与数据

| 公共槽位 | 完整交互与边界 |
| --- | --- |
| `interaction.question` | 前置问答、选项、附言、确认及提交状态，继续原等待请求 |
| `display.literature-search` | 检索摘要及查看完整结果，不删减原详情操作 |
| `preview.literature-results` | 完整结果、筛选、分页、来源、入库及分类交互；名称中的 preview 不授予样例写入真实业务的权限 |
| `literature.selection` | 论文选择及 `selected_paper_ids`，仅在原领域允许时进行子集授权 |
| `literature.authorization` | 原候选全集授权；批准或拒绝由可信宿主确认，不扩大成任意子集策略 |
| `display.literature-downloads` | 下载及入库状态、全文和资料库打开 |
| `display.literature-delivery` | 保存位置、冲突处理、取消和结果反馈 |
| `display.literature-references` | 完整引用列表、来源、加入资料库及分类交互 |

这八个 slot 在 [宿主契约](service/descriptor.py) 中保留，任何插件均可声明引用，但不得提供覆盖代码。四个科研 Skill 均按实际需要引用它们；综述额外保留 `literature.outline`、`display.literature-review` 两个包内自定义 slot。公共实现复用原完整组件，不能用简化展示替代详情、选择或业务操作。

`agentic-search` 的真实 metadata 使用 `literature result` 的 `checkpoint: metadata`，同时传入 `run`（会话相对目录）和 `skill`（包名）；复用现有 metadata 校验、产物发布与结果投影，不进入全文授权。独立搜索页继续由其原调用方消费结果，不伪造对话确认。

### 固定绑定与恢复

[组件注册表](service/components.py) 将 slot 注册与交互实例分开。新实例固定 plugin、component、内容摘要、会话和回合身份，保存初始 data、草稿 state/revision 及状态；后续加载从绑定快照取得原 UI 资源，不重新查找最新 slot 所有者。普通关闭只影响新绑定，旧交互在当前权限校验通过后继续。更新只用于新交互，不把旧卡片换成新版本或其他插件；原选择通过宿主确认的草稿恢复。

在途绑定引用的版本不会被删除；当前实现也不在终态立即回收旧资源。资源回收策略不等于授权延续：操作仍校验用户、会话、交互状态、动作声明、输入和实际业务权限。相同请求的重复操作走幂等结果，不能用重新发文字“确认”绕过。这里固定的是 UI 资源和交互数据，不是完整科研任务或 Skill 脚本执行环境；脚本仍在原 Agent 权限及任务生命周期下运行。

持久数据使用 paths Owner 的 `SERVICE_COMPONENTS_DATABASE`，由 capabilities 持有 revision、slot 和 binding 表；复用 persistence 的事务与路径校验，不从 renderer 推导路径。HIL 决策及回执仍由 chat 原存储持有，不建立第二套业务确认账本。恢复注册失败时阻止新的绑定，已有固定交互仍单独校验权限。

[安装 journal](service/install.py) 记录候选及旧目录身份、发布阶段和旧启用状态。staging 位于技能根的同父目录旁路，不把 candidate 或 previous 暴露给技能根的递归发现。恢复先验证完整记录与实际内容，缺失或不一致时保留现场并报错，不把“找不到 staging”当成删除既有包的依据。回滚落入 `rolled_back` 后通过幂等回调恢复旧状态，回调失败保留 journal 供重试；启动恢复后重新协调注册，恢复前不接受新的自定义绑定。注册数据库事务与文件重命名不是同一个数据库事务；跨进程排他与两平台故障恢复仍需对应验证。

### 通用调用和预览

通过 `scholarseed_bridge` 的 `component.catalog` 查询可用契约，`component.request` 发起等待用户的自定义交互，`component.display` 发布不等待回答的自定义卡片。调用结构见 [bridge.py](../platform/bridge.py)；request/display 携带 `request_id`、slot、data、title 和可选 prompt，同回合同 request_id 重试必须参数一致。增加自定义 slot 不需要增加核心类型分支；新宿主权限仍需正式实现，不能由插件声明自动获得。

公共领域卡必须从对应领域入口发布，通用入口拒绝借公共 slot 伪造文献授权或入库。用户操作经声明、schema、绑定及权限校验后回传业务或等待中的 AI；取消、失败或未知回执不能当成成功。展示卡创建成功也不代表相关业务已经完成。

预览与运行复用公共实现或包内入口、选择状态和交互机制，只有执行端替换为显式样例响应。场景可声明初始数据、状态转换及成功、失败、重试、取消等情境；没有真实动作的组件不新增演示确认按钮。预览不得执行业务写入，也不能证明模型会按 Skill 正确调用工具。真实运行数据和回执仍必须来自实际领域产物与持久请求。

样例响应中的 `{"$input":"字段路径"}` 引用当前操作参数，`{"$state":"字段路径"}` 引用样例状态，`{"$data":"字段路径"}` 引用当前组件的数据；路径只读取自身字段，不支持原型链或脚本执行。`data.target` 用于在当前样例中打开已声明组件的详情，传入本次结果数据，返回后仍停留在原组件页；它不同于顶部的组件样例翻页。`data.view` 的 title、body 和可选 identifier 展示可关闭的样例内容，关闭后保留原组件的选择与搜索状态，不访问真实论文、文件或目录。它们只定义预览业务响应，不增加运行权限或宿主导航能力。

自定义组件在 sandbox iframe 中加载包内 JS，只有 allow-scripts，没有 allow-same-origin、Node 或宿主 preload。随机实例 lease 绑定主窗口，资源只从固定快照提供；宿主检查 contentWindow、lease、动作和消息大小，并在接受前复验实例。普通关闭不撤销合法旧交互，也不跳过每次操作的权限检查。CSP、请求拦截及 guest Connection-Allowlist 限制资源、fetch、导航和 WebRTC；原生网络策略与两平台边界仍需独立安全验证。

`window.plugin.onState(callback)` 接收 data/draft/status/language/slot/theme，返回取消订阅函数。`window.plugin.save(values)` 返回宿主草稿状态和 revision；确认保存成功后才能显示已保存，失败保留本地输入。`window.plugin.submit(actionId, values)` 提交声明动作，不自行批准业务；`window.plugin.request(actionId, values)` 对已接通的受控宿主操作获取回执。实际可用动作以宿主能力和绑定为准，不暴露任意 HTTP 代理或旧 context/invoke。组件挂载到 #root，不能将草稿保存误认为确认或 AI 续行。

配置持久化、完整任务执行代码快照、自动升级和外部客户端立即撤权不属于此组件契约。论文子集和授权范围检查仍归 literature，通用 schema 不取代它。Skill 仍在 Agent 自身权限边界内运行，不能把 UI sandbox 当作 Skill 脚本沙箱。依赖不自动安装，安装落盘与启用成功分别报告。schema 1 独立页面包不兼容 schema 2，需重新生成、检查和确认安装。

## 分层验证

### 原生能力发现与调用

Skill 在实际 Agent 回合中调用 `scholarseed_bridge`，或由宿主提供环境的 `scholarseed-bridge` CLI。先用 `contract/list` 发现能力，针对所需操作调用 `contract/describe`，参数为 `{"target_capability":"literature","target_operation":"read"}`。返回的参数 schema、结果和确认要求是真源；不存在固定的“所有插件都已获准”能力集。不要复制会话凭据到插件，也不要直接请求内部 HTTP 路由。

| 能力组 | 常用操作与用途 | 边界 |
| --- | --- | --- |
| `component` | `catalog` 查看可用自定义组件；`preflight` 检查 slot；`request` 等待回答；`display` 展示 | 公共领域 slot 不走通用伪造请求；草稿保存不是确认 |
| `resource` | `list/read/search/stat/versions/diff` 查找、读取项目资料及已有版本 | 读取结果可能分页或截断；读取不等于修改/恢复授权 |
| `literature` | `list/search/detail/read/annotations` 读取项目文献、题录、全文页与标注 | detail 不授予全文权限；标注不是论文原文证据 |
| `pdf` | `list/prepare/status/read/search` 处理当前获准 PDF 引用 | 使用真实返回的 ref_id、物理页码及引用，不编造材料身份 |
| `literature` | `result/review/authorize/receipt` 发布领域检查点及核对授权 | 必须有真实产物和领域状态；卡片显示不等于授权成功 |
| `literature` | `acquire/ingest/delivery/import` 获取、入库、保存或导入 | 有真实副作用，先明确用户授权；确认、取消、失败分别消费 |
| `artifact` | `publish` 登记已生成的会话文件 | 登记不是生成文件，也不等于外部发布 |
| `plugin` | `install` 展示生成包检查、预览和安装确认 | 不静默覆盖已有包；以安装回执及实际目录为准 |
| `plan` | `get/write` 读取与更新执行计划 | 使用当前 revision、完整 items 和生命周期；失败不盲试参数 |

表格是用途索引，不替代当前能力目录。UI 与 AI 的调用上下文不同：组件只通过 `window.plugin`，受其声明动作、固定绑定和宿主处理器约束；不能把上述所有 Agent 命令直接转换成 UI 能力。公共组件的目录选择、打开全文、分类菜单等由原领域处理器执行；自定义组件若没有公开处理器，应明确缺口，不伪造成功按钮或引入任意网络/文件代理。使用官方基础控件不会获得额外权限。

截至当前 UI 1.0 清单，基础导出为 React、mount、Button、Checkbox、useTranslation；不能把输入框、菜单、弹窗等未导出的控件当成已公开 API。其余公共科研卡片仍由宿主持有，只有论文子集选择独立资源化。完整公共卡片体验应在书深预览中验证，不把独立资源体验 HTML 宣称为全部宿主组件。

确定性回归覆盖 descriptor、实际临时 ZIP、四包公共引用、注册冲突、版本固定、草稿、通用回传和安装恢复；入口见 [Serve runner](../../tests/run_all.py)。这些测试不调用模型或启动真实 Desktop，不能代替真实生成、预览、安装和使用的验收。最终交付仍需要四个 Skill 的卡片操作推进真实流程、重启恢复，以及两平台隔离和安全边界证据；真实验收暂停时必须保留这项未完成状态。
