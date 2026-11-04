---
name: plugin-create
description: Create a local research workflow plugin for ScholarSeed with a Skill, custom conversation component code, sample interactions and an inspected ZIP. Verify the actual host interaction slot before promising runtime support. Use only when asked to create or change a plugin.
description_zh: 为书深创建包含 Skill、自定义对话组件代码和预览场景的本地插件，检查后交付安装包；先核实宿主实际支持的交互入口，不承诺未接通的流程。
version: "0.5.6"
---

# 开发插件

目标是生成用户可以检查、预览、明确授权安装并使用的本地插件，不修改书深核心代码。

## 先确定流程

用用户语言明确输入、处理步骤、需要用户参与的位置和交付物。不要凭空增加实验平台等业务依赖。
只在会改变工作内容的需求缺失时提问。Skill 是 AI 的工作指令；UI 用于交互和展示，不代替流程指令。
先整理目标、输入来源、不可违反的约束、需要用户决定的分支、交付物和插件身份。已说明的内容不重复追问；布局没有被指定时给出合理默认，不把每个视觉细节都变成澄清问题。未知且影响结果的内容集中澄清，不替用户补充新业务需求。
用户明确指定包名时，目录名、SKILL.md 的 name、插件 id 和打包 --name 必须一致。同名或同版本冲突不自动覆盖、改名或借用旧包完成新任务，说明冲突并由用户决定。
在用户允许的工作目录建立一个新目录，不写书深的安装根、用户凭据、宿主配置或已有插件。
源码、归档、检查日志和可复用中间材料放在当前会话的持久工作目录，过程文件放其 work/ 子目录；不自行写入 /tmp、/private/tmp、/var/tmp 或系统临时目录，不靠搬走旧包绕过输出冲突。

## 获取实际契约

先执行 `scholarseed-skill-python -m service.cli.plugins prepare <本Skill目录>/references/contract.json`，一次取得当前宿主版本和契约匹配结果。
本版适配的契约版本与摘要在 [契约快照](references/contract.json) 的 identity；两项完全匹配时，直接使用该快照中的 schema、状态形状和本指南，不重复探索宿主源码。
matched=true 时使用已核验快照；matched=false 时直接使用返回的 contract，仅核对差异，不再执行 describe。旧宿主不支持 prepare 才退回一次 describe。缺少所需能力则说明阻塞，不猜测补齐。契约身份不是 Desktop 版本，也不是运行权限；不能跳过动态 slot、安装完整性和权限检查。
该命令只发现本地结构契约，不代表原生权限已经授予。不要调用未存在的 install 或 preview CLI。
原生业务命令与插件结构契约分开核实：对确实需要的未知操作，使用快照中的 native_contract_discovery，即 `scholarseed_bridge` 的 `capability: "contract", operation: "describe", request: {target_capability: "literature", target_operation: "read"}`。替换目标即可取得真实参数、返回结构及前置条件；这是只读发现，不执行读取或授予权限。不要向业务接口发送 contract_probe 等虚构参数来诱发报错，也不读取宿主源码找字段。一次结果足够指导当前生成；缺失的返回结构标记未声明，不杜撰。真正运行时仍核当前资源、上下文和权限。
先阅读 [交互与流程指南](references/interaction.md)。仅在当前契约不能回答具体问题时精准查询工具帮助；不盲试 plan 等无关接口，不反复读取整棵源码，不把旧测试插件当作可信模板。
需要执行计划时，直接读取已匹配作者契约的 `planning.operations`，其中 schema 与 `x-bridge-guidance` 来自宿主当前注册的 plan 工具，不再重复探索源码。契约可以复用，当前会话的 plan、turn_id 和 revision 必须通过 plan/get 获取，不能从快照猜测。按其生命周期更新；同一工具错误不改参数猜试。解析错误路径后定点修正；连续出现相同错误时停止该调用并说明缺口，不把规划工具调试变成创建任务主体。

创建根级 `SKILL.md` 和 `.scholarseed-plugin.json`，身份和版本必须一致。
描述中声明目标宿主的兼容版本；不要为了通过检查随意放宽版本范围。
一个包只有一个入口 Skill，可以用指令组合现有工具。不要声称插件指令能覆盖系统指令、权限审批或强制模型执行。
首期不自动安装 Python/系统依赖；无实际依赖时保持依赖声明为空。

## 从可编辑模板开始

三类模板由同一个隔离组件与官方基础控件支撑：selection（选择修订）、comparison（比较）、stages（多阶段）。按需求选最小模板，不因模板增加需求。
模板的可选 `data.fields` 接受 `{id, label, placeholder?, value?}` 文本字段；用于自定义问题、部署约束等时直接声明字段，不重写输入状态机。显示默认空字符串，草稿与提交使用 `fields: {字段id: 文本}`，支持清空、重新输入及保存期间继续编辑。无 fields 时不显示额外输入。同步更新请求载荷、预览响应、submissions 及最终科研步骤对 fields 的消费；需要动态增删多行时仍需专门验证，不能声称单字段模板已覆盖。
使用本 Skill 目录下的 `scripts/scaffold.py`：

```sh
scholarseed-skill-python <本Skill目录>/scripts/scaffold.py comparison ./my-plugin-source --name my-plugin
```

默认 host 精确限定当前宿主版本；用户指定更广范围时用 --host 声明，先核兼容性，不擅自扩大。目标目录必须不存在。
脚本只创建可编辑源码、流程起点和通过 schema 校验的预览场景，不代表已完成用户需求。按用户目标修改流程、布局、真实数据映射和分支；不要把样例选项用于真实科研结论。
脚本同时生成 requests/ 下的本包调用载荷，并在生成的 SKILL.md 中引用。生成及每轮修改时同步维护这些载荷，保留必填字段和动作字符串；分别运行 validate，运行技能时直接读取并映射真实数据，不重新猜测组件参数。新增组件也要提供对应载荷和引用，不能只有预览样例。
复用模板的事件处理和草稿修订逻辑，只有业务需要才扩展；不重新发明状态信封或复制 React。模板正常确认、失败重试、取消、未知场景是测试起点，还须补具体业务的边界，使用 [测试模板](references/testing.md) 核对。
先区分需求需要改变 data 还是交互代码：单组选择的标题、说明、选项和动作可直接映射模板数据，不重写整张卡片。确需自定义输入、布局或多阶段交互时保留模板的状态与保存机制，将业务区域拆成短小的渲染函数，不在一个巨大的嵌套 createElement 表达式中混写全部控件。每次只修改需求涉及的结构；语法错误定点修正，不反复重生成整个文件。未要求的第二张卡、额外选项和迭代流程不提前加入。
确定自定义 slot 后调用 `scholarseed_bridge`：`capability: "component", operation: "preflight", request: {slots: [实际自定义slot]}`。该只读检查包括当前不可见但已占用的 slot；不返回未授权插件内容、不预占 slot。冲突由用户决定新身份或更新范围，不能擅自覆盖。安装时会再次检查竞争。

## 公共引用与自定义对话组件

使用 schema 2 的 `components`，不要生成 schema 1 的 `ui`、独立 HTML 页面或旧 `context/invoke` 调用。
每个组件声明 `id`、`slot`、场景 JSON `preview` 和 `actions`。公共组件声明 `public: true`，引用 `describe` 返回的公共 slot，不提供 `entry`；公共实现由宿主维护，插件不得覆盖。
非公共组件省略 `public` 或使用 `false`，提供包内 JavaScript `entry`，开发者自行定义非公共 slot。新增自定义卡片不需要修改核心组件分支，不能借此新增任意宿主权限。
按实际数据声明 `input_schema`、`output_schema` 和动作 `input_schema`；只使用 `describe` 公布的受限 JSON Schema，不使用外部引用。输入、选择草稿和返回值都必须是 JSON 数据，不能存放密钥或函数。
代码可自定义布局、样式和交互，编译为不依赖远程模块的普通 JavaScript，挂载到宿主提供的 `#root`。
不用 CDN、网络请求、Node、宿主 DOM、弹窗、下载、外链或远程模块。宿主创建隔离容器，开发者不创建独立窗口。

`window.plugin.onState(callback)` 接收 `{data, draft, status, language, slot, theme}`；根据状态更新，非 `pending` 时停止回答提交。用宿主确认的 `draft` 恢复选择；通知不等于重置，保留本地未保存编辑，详见交互指南的本地编辑与保存修订规则。
`await window.plugin.save(values)` 持久化当前交互的 JSON 草稿，返回 `{state, revision}`；检查成功回执后才显示已保存。它不执行业务、不授权、不推进 AI。保存失败保留本地输入并提示未保存，不把本地状态冒充持久状态。

自定义卡片用 `await window.plugin.setCopyContent({text, markdown?})` 登记包含当前选择和来源链接的文本版本；书深提供卡片和消息复制按钮。草稿保存后根据新 `onState` 的 `revision` 重新登记，失败时提示未保存；不读取或写入系统剪贴板，不导出按钮等操作文案。
其中 `state` 是保存后的 JSON 草稿对象，不是字符串 `"saved"`；以 Promise 成功和返回的 revision 为回执，不做 `receipt.state === "saved"` 判断。
`window.plugin.submit(actionId, values)` 提交声明过的动作与 JSON 对象，不代表批准成功，也不返回可直接等待的业务结果。
实际结果通过后续 `onState` 更新。提交选择不能自行获取权限，敏感操作必须由组件之外的可信宿主确认。
回答使用 submit；有 Promise 回执的宿主能力使用 request。能力声明不等于当前组件上下文具备该处理器，尤其不能在 display 卡通过 submit 模拟导航；发现未开放能力先说明缺口，不交付无效按钮。
只调用实际契约公开的能力，不生成任意 HTTP 代理，也不用组件选择代替敏感操作授权。领域公共组件继续调用原领域工具和状态机，不能伪造候选、下载成功或授权记录。

## 注册、流程与存量交互

设置中的启用状态决定组件是否参与新的绑定，不依赖用户输入 `/技能`。启用不等于立即显示卡片，也不等于自动执行所有 Skill。
在 Skill 指令中明确何时请求组件、传入什么真实数据、如何消费返回结果和继续科研流程；声明文件、Markdown 和预览本身不会触发卡片。
使用宿主公开的组件目录、请求和展示契约，不为新 slot 要求修改核心代码。组件请求等待宿主校验过的操作结果，确认成功后继续流程；失败、取消、过期或未知投递结果不能当成确认，不要求用户再发送文字“确认”。
自定义 slot 在所有启用插件间互斥。首次安装冲突时可以仅安装不启用，不能假称组件已经可用；更新引入冲突会被拒绝，并保留原版本和注册。
普通关闭只阻止新绑定。旧交互固定原包内容、数据和已保存选择，在权限校验通过后继续；新版本不能替换旧卡片或扩大其授权。被在途交互引用的旧版本保留到交互结束。
组件必须根据宿主传入的状态恢复选择和输入，不把 iframe 生命周期当成业务生命周期，不在前端自行宣布授权或业务完成。

通过模型工具 `scholarseed_bridge` 使用以下调用；不要在 shell 中复制桥凭据：

- `capability: "component", operation: "catalog", request: {}`：读取本会话可用组件及契约。
- `capability: "component", operation: "request"`：请求自定义交互并等待操作结果。
- `capability: "component", operation: "display"`：发布自定义展示卡，不等待用户回答。

后两者的 `request` 为 `{request_id: "flow-step-1", slot: "research.method-comparison", data: {...}, title: "方法对比", prompt: "选择后续分析方法"}`，以目录返回的实际 slot 和 schema 替换示例。
同一会话回合中重试相同 `request_id` 必须保持参数一致，不能把重试变成另一张卡；新的流程步骤使用新 ID。
同一步骤修改内容后重新确认属于新修订轮，也使用新 ID（如 outline-r2）；只有同参数的运输重试才复用原 ID。已确认答案直接用于后续步骤，不要求文字再次确认。
公共 slot 不接受通用调用，必须使用原业务工具提供的权威数据和授权流程，不能用通用组件请求伪造全文授权或入库。
`request` 成功后，从 `result.answers` 中解析宿主返回的 JSON 回答 `{action, values}`，按动作和数据推进流程；`result.cancelled` 表示取消。只有成功回执才能继续依赖该选择的操作。
`display` 返回卡片记录不等于相关业务已完成，也不能代替需要等待用户选择的 `request`。

场景 JSON 使用 `{data, responses}`，responses 必须覆盖所有动作，每项为 `{state, data}`，state 为 resolved、failed 或 cancelled。
为每个自定义确认动作添加 `submissions: {动作ID: [真实提交的values样例]}`。包检查会校验这些样例；实际预览提交也经宿主相同校验后才执行样例响应。必须同时满足动作 input_schema 和组件 output_schema；不要把外层 `{action, values}` 当作 values 的 schema。
样例应覆盖选择、确认、失败、取消和后续状态；保留所引用公共组件的完整详情和操作，不用简化列表替代。公共预览复用宿主实现，自定义预览与实际运行加载同一份包内代码。
预览只替换执行端为样例响应，不添加真实流程没有的确认按钮。场景响应仅验证组件状态，不能证明模型调用、业务授权或科研结果，不能在预览中执行真实业务。

## 检查和交付

使用以下真实入口（替换路径、名称、版本）：

```sh
scholarseed-skill-python -m service.cli.plugins pack ./plugin-source --name my-plugin --version 0.1.0 --output ./my-plugin.zip
```

输出必须在源码目录之外；不能覆盖已有输出。检查失败时按 issues 修复后重新打包。
pack 已检查同一归档的完整内容，不必紧接着重复 check。外部已有 ZIP、归档被转移后需核字节或安装前复核时，才执行 `scholarseed-skill-python -m service.cli.plugins check ./my-plugin.zip`。任何源码修改均需新归档与新摘要，不能复用旧检查结果。
只有命令退出成功且 valid 为 true 才交付 ZIP；保留检查返回的实际 `sha256`，分别说明结构检查、宿主能力检查、授权和实际运行的状态。
新生成的自定义确认卡不能留有 `component_submission_samples_missing` 警告；补齐真实 values 样例并检查后交付，不把旧包兼容性警告机制当作跳过验证的许可。
不要执行新插件里的安装脚本，不打包密钥、环境文件、缓存或依赖环境。
交付 ZIP 和源目录后，通过模型工具 `scholarseed_bridge` 调用 `capability: "plugin", operation: "install"`，request 为 `{request_id: "install-generated-plugin", path: "相对当前工作区的 ZIP 路径", sha256: "检查返回的摘要"}`。宿主重新读取并检查同一字节，发布安装卡片；不要把源码目录、绝对路径或模型自报的检查结果提交给安装卡片。
安装卡片由宿主显示检查报告、交互预览、权限和更新风险。安装由用户在卡片中明确确认；AI 不能把生成需求当作安装授权，也不能直接调用设置页安装接口。工具返回 published 表示卡片已发布，不表示已安装；立即继续回答或结束创建，不等待、不轮询、不要求安装或跳过。用户可稍后在原卡片中预览、安装或重试。
没有实际宿主安装回执时只报告“生成并发布安装卡片”，不报告已安装或已启用。未知投递不盲目新建卡片；按原 request_id、路径和摘要重试同一次发布。安装并启用后，可直接发送自然语言任务，AI 按需使用 Skill，由真实工具请求在对话中呈现组件；无需通过技能选择器绑定，不是另外打开页面。

## 快速路径与同会话修改

澄清结束后记录时间，按“prepare 一次 → 模板一次 → 完成业务修改 → 动态 slot preflight → pack 一次 → 发布安装卡片”推进。目标 5 分钟不是跳过检查的理由。仅不变的契约知识和未变源码可以复用；安装准入、权限、slot 竞争和修改后的归档检查不能缓存代替。
prepare 匹配后不读取宿主源码，不重复 describe，不通过试错发现已知参数。已有模板使用普通 JavaScript，不引入无必要的编译、依赖安装或打包链。只有检查报告指出具体问题才修复并重新 pack；同一个未变归档不再重复 check。
在源目录外维护简短 requirements.md，记录已确认目标、约束、最终流程、布局、动作及本轮变化；记录包 id、版本、源码位置、ZIP、摘要和卡片 request_id。不要将本文件塞进科研输入。修改任务先读此记录和实际需要修改的文件，不重做全量发现或再次 scaffold。
增量修改保留未变需求、状态恢复和安全逻辑；用户撤销要求时同步删除相关流程、卡片动作和场景，不能保留隐藏的旧决策。若需求冲突才澄清。每次可交付修改递增包版本，更新 SKILL.md 与描述符；使用新的 ZIP 文件名与安装 request_id，永不覆盖先前卡片引用的归档。旧卡片仍指向旧版本，新卡片才代表本轮产物。
新增可编辑字段时，显示、编辑、保存和提交必须读写同一份状态。空数组渲染出的首个输入行不能只存在于显示补位中：首次输入必须初始化或按索引写入真实状态；删除至空后再次输入也须成立。不要仅靠静态 submissions 判定输入可用，按测试指南核真实输入与取消选择的往返；无法实际操作时标记未验证，不宣称交互通过。
输入、动作或布局改变时同步更新对应预览数据、submissions 和边界场景；用 validate 检查真实首卡请求，再 pack 检查完整包。修改后概括保留项、变更项、撤销项和当前版本，邀请用户查看新卡片，不要求先安装才能继续修改。
预览通过不等于 Skill 已运行；需真实任务、工具输出及产物证明流程完成。
生成的科研流程须保留材料来源、数值、单位和比较方向，在输出结论前核对引用与数值；不同实验设置的结果差异不能直接称为矛盾。已明确排除的主题不得作为可选候选；未调用的检索或资料库检查不能声称已完成。无法核实的事实标记为未知，不用合理猜测补齐。
为每条关键主张核对“主张—实际读取片段—实验条件”：引用句柄存在不等于支持相邻句子。报告值、从原值推算的结果和不可直接比较的指标明确分开，推算保留算式；无相应片段时保留缺证，不借附近无关引用充数。
生成的科研 Skill 必须落实 [证据与决策检查](references/evidence.md) 的逐项核对，不只复制“科学严谨”口号；这些规则也适用于创建过程中引用的论文。
