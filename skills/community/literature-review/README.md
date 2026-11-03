# literature-review

`literature-review` 是一个只适配 Codex 的系统性文献综述 skill。它从框架已经澄清好的“一句话精准研究意图”出发，完成多轮论文检索、筛选、全文/摘要获取、paper card 抽取、大纲设计、所有顶层章节并行起草与一次全稿 delta refine、图表生成、发布和最终核验。

当前发行版不包含 Claude Code 兼容层，也不在 skill 内执行前置意图问卷。PDF 英文排版固定使用 NeurIPS 2026 preprint，中文排版固定使用 `ctexart`；也可以选择原生 Markdown。

当前图文流程：各章直接生成原生 LaTeX 或 Markdown 正文及表格；独立生图子 agent
与正文并行完成图片、caption和包装，不增加图片审查或重画环节。图文全部完成后
装配完整v1，经一次全稿delta精修形成v2。出版对当前源码中的未知引用、未解析交叉引用
提供非阻塞诊断；有大纲时，章节和表格覆盖也仅作提示。PDF编译失败需修复。
main直接编辑v2及其依赖文件，统一运行 `workflow publish`。JSON格式要求适用于
任务包、大纲和delta，不适用于原生章节输出；这些检查不等于科学质量审查。

全文获取优先使用 PaperHub 文档 ID，保留其既有超时、重试与代理策略；失败后仅在已有
arXiv ID 时尝试 arXiv，连接限时 3 秒、单篇降级总预算 10 秒（含并发等待），否则使用
已有摘要。本地 PDF 优先。表格布局发现仅作为解析报告中的提示，提取文本继续进入
LLM paper card 生成；空文本、损坏文件等失败仍明确报告。提取结果保存在本地。

PDF 在布局解析前先用轻量文本探测正文边界（最多探测200页）。独立参考文献标题需有
文献条目佐证，补充材料封面需有明确标题；目录和普通正文提及不作为边界。确认边界时
保留边界所在整页，允许少量引用随正文进入后续提取，避免丢失同页正文。候选正文不超过
40页时全部解析，超过40页时仅解析前20页和后20页；未确认边界时对整份PDF使用同一预算，
包括超过200页的文档。原文件不变，原始页码继续用于证据定位。选择页码、边界和探测异常
只写本地解析诊断，不新增主agent确认、裁剪通知或降级提示。

图、表和公式的布局边界告警不拒绝成功提取的文本；仅有这些布局告警且提取到非空文本时返回OK。损坏文件、
不安全压缩包和无可提取文本仍保持失败。LaTeX数学分隔符按转义奇偶顺序扫描，未闭合
公式不触发回溯搜索。

LaTeX 章节使用现有模板的一份简短能力说明，涵盖已加载宏包、数学记号与字体。
指标函数使用明确给出定义的双线大写符号。v1 在现有一次 refine 前进行最多 10 秒的
单次预编译：成功时不增加 refine 上下文，源码错误作为修复输入，超时或工具不可用时
使用同一份模板能力说明和修复要求。预编译输出位于 `_internal/compilation_precheck/`，
不覆盖正文或交付物，也不替代 v2 的最终出版编译。

## 运行要求

### 框架runtime与独立运行

模型请求优先导入环境提供的 `skill_model_client.SkillModelClient`，通过
`from_runtime()` 获取当前任务的真实调用上下文。仅公共模块导入失败时才使用
现有直连实现。模块可导入后，初始化、上下文、协议或请求错误都会明确返回，
不会退回直连；runtime路径不要求本地文本／图片API key。

当前适配遵循公开API草案的 `chat(...).text` 和 `image(...).save(path)`：
文本产物声明 `output_kind="file"`，`review_text`只取当前任务说明，不拼接论文材料、
系统提示或消息历史；图片直接传实际prompt。连接路由、会话/轮次/call ID、请求摘要、
来源标记与审核由框架client负责，skill不复制协议，也不猜测企业网关地址。
框架负责其内部传输重试；脚本不会在runtime调用外再叠加传输重试。

草案目前只定义完成结果API，因此runtime文本分支缓冲完整结果，不伪造中间流事件；
原有直连SSE保持不变。可选模型参数只传给公开方法声明支持的参数，未支持的参数
记录为 `runtime_options_omitted`，由runtime连接配置决定其默认值。
公共模块由宿主环境提供，不加入本skill的强制依赖。离线mock测试不能替代实际框架
及网关审核联调；发布者需使用正式client版本完成产品侧验收。

最低要求：

- Codex Desktop 或支持 skills、subagent，并能通过当前模式可用的交互工具或普通对话取得用户真实回复的运行环境；`request_user_input` 不是必需工具；
- 绑定的 Python 3.12.x；其他版本须另行验证；
- 环境提供的可用 runtime client，或独立运行时的 OpenAI-compatible 文本模型网关
  与 `SCHOLARSEED_ACCOUNT_TOKEN`；
- 已单独安装最新版 `agentic-search` skill；
- 可访问 PaperHub 或 Codex 公共网页搜索；AS 在 PaperHub 不可用时自动降级。

可选系统能力：

| 能力 | 依赖 | 缺失时的行为 |
|---|---|---|
| 英文 PDF | `pdflatex`、`bibtex` | 选择 Markdown，或在最终发布时无法编译 PDF |
| 中文 PDF | `xelatex`、`bibtex`、CTeX/中文字体 | 选择 Markdown，或中文 PDF 无法编译 |
| 数据图 | `matplotlib` | 报告技术失败；不能静默删除必需图表 |
| PDF 全文解析与页面核验 | `pypdfium2` + `pdfplumber` + `pypdf` | 全文：无法解析的论文自动回退到可信摘要；页面核验：报告 render_error，人工页面检查未完成 |

TeX 建议安装 MacTeX 或 BasicTeX 后补齐 `bibtex`、CTeX 和所需字体。Debian/Ubuntu 通常需要 `texlive-xetex`、`texlive-latex-extra`、`texlive-lang-chinese`、`texlive-pictures` 和常用字体包。

Python 包统一记录在 `requirements.txt`，由产品构建安装到产品 Python，技能运行时不创建独立 `.venv`。

## 从压缩包安装

SLR 与 AS 是两个独立发行物。先解压并安装最新版
`agentic-search-<version>.tar.gz`，按其中 README 运行安装器和 doctor；再安装
`literature-review-<version>.tar.gz`：

```bash
mkdir -p ~/.codex/skills
tar -xzf literature-review-<version>.tar.gz -C ~/.codex/skills
cd ~/.codex/skills/literature-review
./scripts/setup
```

`./scripts/setup` 验证产品 Python 及已安装依赖，不安装或升级包。内部发行包已经包含打包机器当前使用的配置；安装后确认或按目标机器需要调整：

- `config/model_config.fast.json`：文本与可选 IdeaLab 图片模型的默认 URL 和模型参数；
- `config/endpoints.json`：SLR 全文获取与上传端点。

Windows 原生使用 Python 3.12，无需 Bash 或激活虚拟环境。在 PowerShell 中从 skill 目录执行：

```powershell
.\scripts\setup.cmd
.\scripts\slr.cmd doctor --no-network --json
.\scripts\slr.cmd init --workspace 'C:\Reviews\我的综述' --intent '实际研究请求'
```

首次 doctor 可在依赖未安装时运行，报告实际系统、架构、Python、可用输出能力和修复命令。它还用当前产品 Python 和继承的代理环境检查同步、异步 HTTP 传输能否初始化；缺少 SOCKS 依赖时应修复 ScholarSeed 产品安装，而不是在会话中临时安装。`SCHOLARSEED_PYTHON` 由产品入口指定。`setup.py` 只验证当前产品环境，不创建私有虚拟环境。

| 平台 | 代理预检执行方式 |
| --- | --- |
| macOS | 使用绑定的产品 Python 子进程，继承当前代理变量；只初始化传输，不发起请求。 |
| Windows | 使用绑定的产品 `python.exe` 子进程，继承当前代理变量；不依赖 POSIX Shell，也不发起请求。 |

`init` 返回 `runtime.cli.argv` 及 PowerShell/CMD/POSIX 写法；后续主代理和子代理复用该命令，避免自行拼接路径。Windows 工作区另有 `slr.cmd` 快捷入口。仅需诊断已有绑定时，运行 `doctor --workspace <工作区> --no-network --json`。WSL 使用其 Linux Python 与 Linux 路径，不能复用 Windows 虚拟环境。

PDF 需要目标机器的 TeX 工具链（Windows 可使用 TeX Live 或 MiKTeX）及对应中文/模板包；doctor 分别报告中英文 PDF 与 Markdown 能力。AS 仍独立安装和诊断，SLR 不修改其配置。自动测试使用假模型和本地材料，不需要模型服务凭据；它们不能代替真实产品与 Windows 验收。

模型凭据不写入 skill config。文本模型读取 `SCHOLARSEED_ACCOUNT_TOKEN`；图片模型优先读取
`IMAGE_API_KEY`，缺失或为空时降级读取 `SCHOLARSEED_ACCOUNT_TOKEN`。两个 URL 环境变量
是可选覆盖，未设置时才使用 config 中的 provider 默认值：

```bash
export SCHOLARSEED_ACCOUNT_TOKEN="<your-text-token>"
export IMAGE_API_KEY="<your-image-token>"
export TEXT_BASE_URL="<optional-text-gateway>"
export IMAGE_BASE_URL="<optional-image-gateway>"
```

ScholarSeed 是英文展示与署名名称；凭据变量 `SCHOLARSEED_ACCOUNT_TOKEN`、
`IMAGE_API_KEY`、真实网关域名和引用样式标识不随展示名称替换。
图片缺少 `IMAGE_API_KEY` 时会回退使用 `SCHOLARSEED_ACCOUNT_TOKEN`。

解析优先级固定为 `TEXT_BASE_URL > providers.qwen.base_url` 和
`IMAGE_BASE_URL > providers.idealab.base_url`。请在启动 Codex 前设置这些变量；
若 Codex 已在运行，设置后需完全退出并从相同环境重新启动，随后运行 doctor。

检索 API、认证和检索端点完全由独立 `agentic-search` 管理；SLR 不复制、
覆盖或校验其配置。调用 AS 时默认显式指定 `balanced`，在 subagent 任务描述中要求完整摘要、有效作者和出版年份；
不修改 AS 的代码、配置或接口，SLR 导入端对这三项条件独立过滤；
用户明确指定的检索模式或时间预算优先。不要省略模式而继承 AS 独立运行时的默认值。
AS 按自己的目录规则写入综述 workspace 的 `agentic-search-results/`，
检索子代理随后调用 `./scripts/slr import-search --workspace <workspace> --source <AS结果目录>`。
SLR 保留原始运行快照，再适配 `metadata.json`；新版和旧版字段均可读取，
不再强制要求旧版 `report.md` 和 `search_provenance.json`。
Web-only、摘要缺失、检索数量不足和追踪缺失会显式报告降级。

配置确认后执行：

```bash
./scripts/slr doctor
```

出现 `BLOCKED` 时先处理所有 required `MISS`。`warn` 表示对应能力会降级；例如没有 LaTeX 时仍可测试 Markdown。`--no-network` 只跳过端点探测：

```bash
./scripts/slr doctor --no-network
```

安装或更新 skill 后，下一轮即可调用；若当前任务未刷新发现列表，可新建任务。

## 五分钟离线冒烟测试

PDF 回归测试使用 ReportLab 生成真实测试文件，在独立测试环境中先运行 `python -m pip install -r requirements-test.txt`；运行时不需要 ReportLab。不要向产品 Python 安装测试依赖。

这个测试不调用 PaperHub、模型或图片接口，用于确认压缩包、Python 环境、CLI、引用资产和 workspace 初始化正常：

```bash
./scripts/slr stages
./scripts/slr citations examples
./scripts/slr templates list
scholarseed-skill-python scripts/test_bibtex_entry_types.py
scholarseed-skill-python scripts/test_model_config_env.py
./scripts/slr init \
  --workspace ../slr-smoke \
  --intent "综述 2021–2026 年检索增强生成在企业知识库问答中的方法、评测与可靠性进展，并保留更早的奠基工作。"
python -m json.tool ../slr-smoke/01_input/query.json
python -m json.tool ../slr-smoke/01_input/writing_request.json
```

如果机器有 TeX，再运行：

```bash
./scripts/slr templates check
scholarseed-skill-python scripts/smoke_citation_styles.py
```

`init` 不覆盖已有 `writing_request.json` 或同名工作区 launcher。重复测试请换一个 workspace 名称。

## 在 Codex 中做一次真实测试

先用范围明确、成本可控的主题。推荐直接写成一句精准意图，例如：

> 使用 `$literature-review`，综述 2021–2026 年检索增强生成在企业知识库问答中的方法分类、常用数据集与指标、可靠性风险及最新进展；时间范围是软约束，允许收录更早的奠基工作。输出中文标准篇幅综述。

Host 保留原始任务及后续要求，检索通过独立 `$agentic-search` 执行，默认
Balanced。新检索结果缺摘要、作者或年份时排除并报告缺口，不启动补齐元数据的循环；
本地或旧材料仍按原导入/恢复策略处理。processing 明确报告材料深度
与卡片就绪性。大纲使用一次模型请求；完整综述默认所有顶层章节并发生成，
制图与正文并发，待图文全部完成后装配完整v1，由一次全稿 delta refine 请求和
脚本自动应用修复形成v2。
大纲展示为“1–2句话概括需求和个性化要求 → 缩进目录及挂载caption → 询问引用格式与模板”；
已有选择或自动执行授权可复用。出版对当前源码提供非阻塞内容诊断，PDF编译失败
需修复；main查看首页及图表实际所在页（含跨页表格续页）并直接编辑v2，不重生成已完成章节。详细口径见
SKILL.md 的出版与检查说明。

一次完整运行使用独立 workspace：

```text
01_input/       writing_request.json 唯一任务输入；query 为派生视图
02_retrieval/   检索、筛选、全文或真实摘要及来源
03_process/     paper cards、冻结引用 ID、BibTeX、元数据审计
04_outline/     大纲、确认包、真实决定及派生出版规格
05_generation/  chapters/ 原生章节、完整v1、delta、可编辑v2、图表及出版依赖
06_output/      survey.pdf 或 survey.md
07_verifier/    当前源码诊断、编译结果与首页/图表页图像
_logs/          请求和阶段日志
```

## 输入格式与大纲修订

需要接口格式时，按需调用以下只读帮助；它们不会初始化任务、调用模型或修改文件：

```bash
./my-survey/slr writing configure --describe-input
./my-survey/slr writing approve --describe-input
./my-survey/slr outline configure --describe-input
./my-survey/slr figures plan --describe-input
./my-survey/slr evidence build --describe-input
./my-survey/slr papers import-local --describe-input
```

大纲LLM只生成初始大纲。用户要求修订时，main根据当前完整大纲和字段定义直接修改，
提交 `outline configure --request outline.json` 校验，再展示review-packet。
已有大纲时再次调用outline generate只会校验并复用，不会重新调用模型。
来源修复接口和摘要网页补抓已移除；本地PDF的原文解析与缺失来源诊断保留。

## 常用命令

先使用 skill 入口创建工作区：

```bash
./scripts/slr doctor --no-network
./scripts/slr init --workspace ../my-survey --intent "<original request>"
```

init 返回工作区专属 launcher。已有任务缺少 launcher 时使用
`./scripts/slr init --workspace ../my-survey`，不传 `--intent`。
之后从固定 caller 目录执行短命令，例如：

```bash
./my-survey/slr writing configure --request request.json
./my-survey/slr run retrieval_adapt
Call the `scholarseed_bridge` model tool with `{"capability":"literature","operation":"review","request":{"workspace":"my-survey","checkpoint":"retrieval"}}`.
./my-survey/slr workflow evidence --from fulltext
./my-survey/slr status --stage workflow
./my-survey/slr status --stage processing
./my-survey/slr papers show --ids 123
./my-survey/slr run processing
./my-survey/slr outline generate
./my-survey/slr outline review-packet
./my-survey/slr writing approve --request decision.json
./my-survey/slr manuscript prepare
./my-survey/slr manuscript generate
./my-survey/slr status --stage writing
./my-survey/slr figures context --ids F1
./my-survey/slr figures plan --request figure-plan.json
./my-survey/slr figures plan-generate
./my-survey/slr workflow publish
```

以上是接口索引，不是无条件顺序执行的脚本：真实用户确认使用 approve；已有
自动授权无需 approve；新建完整综述默认采用下述五分钟策略。无图任务跳过制图；有图任务在 prepare 后并发启动。

### 五分钟确认窗口

新建完整综述默认 `outline_review:"timeout_auto"`、`review_timeout_seconds:300`；旧任务的 `required/auto` 不会被更改。用户要求必须等其确认时设置 `required`。大纲和推荐出版设置实际展示后，主代理说明“5 分钟未回复将按以上设置继续”，再启动计时：

```text
writing review-start --request displayed.json
writing review-wait --packet-id <当前ID> --wait-seconds 30
writing review-response --request actual-reply.json
writing review-timeout --packet-id <当前ID>
writing review-status --packet-id <当前ID>
```

这些是追加到绑定 CLI 的子命令，不是独立可执行文件。`displayed.json` 包含实际 `packet_id` 和 `displayed:true`；回复文件包含实际 `packet_id`、`user_response`，可附真实 `message_id`。所有接口支持 `--describe-input`，状态/等待/到期操作也接受同形状的 `--request`。

上述命令是分支流程：有回复时立即记录并停止超时，暂停或修改也一样；无回复且状态变成 `expired` 时才执行 `review-timeout`。它返回用户通知和稳定的 `decision_id/notice_id`，记录为超时默认决定，不伪造用户回复，也不自行启动模型。主代理先发送通知，再准备/生成正文。任务或大纲变化会使旧窗口失效；重复调用不会延长窗口或创建第二个决定。

宿主可通过动态等待工具和持久化定时器在 `deadline_at` 唤醒任务，并在用户输入到达时先调用 `review-response`；同一时刻到达的输入应先入队处理。没有后台调度器时，主代理必须保持活跃并使用最多 30 秒的可中断等待。单独结束 agent 回合不会自动恢复，此仓库不包含桌面端的调度实现。
首次出版和修改v2后的再次出版都只需 `workflow publish`，它包含检查、编译导出和
首页及图表页渲染，跨页表格覆盖全部续页。返回的 `inspection_scope` 包含实际 PDF 页码、图表标签与图片路径；定位不完整会明确报告。维护诊断时可以单独调用 `manuscript publish` 或 `run verify_postcheck`，
但它们是工作流子步骤，不是运行完 `workflow publish` 后还要追加的常规步骤。
从原始 skill 入口调用时仍可显式传 `--workspace`。短入口绑定一个工作区和
skill 版本，不依赖跨工具调用保留 cd 或 export。

main 的正常路径只读 `SKILL.md`。检索导入后先把 `run retrieval_adapt` 作为独立命令执行，
再调用书深阻塞式 `literature review(checkpoint=retrieval)` 等待用户授权；只有返回
`authorization.disposition=authorized` 后才使用 `workflow evidence --from fulltext`
连续执行全文获取、处理、大纲生成和展示包。不得从不带 `--from` 的
`workflow evidence` 开始：脚本即使被误调用，也只会执行检索适配并在
`fulltext_authorization` 边界返回，不会进入全文。错误、检索例外会提前返回，授权后的
证据链最终总是在 `outline_display` 停下，已有自动授权也必须展示。修复后也可从
processing、outline 或 review-packet 恢复，起点及其后续阶段都会执行，脚本不自动跳过已完成阶段，也不猜测输入是否仍有效。
已有大纲仅需重新展示时从 review-packet 开始，不能从 outline 开始。
章节响应的持久复用由 manuscript generate 自身负责。正文和制图完成后用
`workflow publish`，连续出版和 postcheck，在 PDF 人工检查处返回；Markdown
返回交付边界。不要在这些命令之后重复执行其已完成的单步命令。

主流程 JSON 输出默认精简，完整报告和模型输入保留在磁盘；`--full` 返回完整
诊断。状态读取用 `status --stage workflow|writing|processing`。精简输出不改变
模型提示词、证据内容、调用次数或确认要求。

`writing configure` 是部分更新；`constraints` 替换完整当前列表。保留原始
意图和有效要求，JSON 文件或 stdin 输入由 CLI 验证并原子提交。章节任务用
`output_scope:"section"`，可选 `selected_section_ids:["3"]`；不继承完整综述
的默认摘要与确认要求。详见 SKILL.md；输入形状可通过相应命令的 `--describe-input` 查询。

旧 section-writing/review 命令仅保留为兼容作者路径，不能因整稿失败自动切换。
旧 requirements 文件没有兼容导入；已有 workspace 缺失完整 writing_request
时必须补全权威任务。query 和 output_spec 都不能独立修改用户要求。

## 图表在大纲阶段统一规划与展示

大纲模型仍规划章节、图表的ID、所属章节、用途、内容范围和证据，供后续脚本使用。
向用户展示时，main先用1–2句话总结研究需求及个性化要求；再展示层次化缩进目录，
图表仅以ID和caption挂载到对应章节或小节下；最后询问引用格式和模板。
不展示论文清单、分析任务、图表用途或排布理由；已明确的选择不重复询问。

`outline review-packet` 默认只返回 main 所需的大纲展示、任务摘要、出版选项与身份字段；
内部完整规划保存在 `04_outline/review_packet.json`，需要诊断时用 `--full` 返回。
prepare派生图表清单，章节作者生成原生表格，制图分支并发执行。
图文完成后装配v1并进入refine。图表规划和归属指导生成，不作为main修改v2后的
出版许可；出版诊断以当前源码和参考文献为准，旧大纲覆盖仅作提示。

完整字段与可校验示例由 `outline configure --describe-input` 提供。大纲修订由main完成，
通过 `outline configure --request` 做确定性校验与保存，不重新调用大纲LLM。

## 图片 prompt 与 caption

制图作者根据同一张图的章节意图和完整相关证据，一次产出两个用途不同的字段：
`_prompt` 明确视觉对象、标签、布局、箭头和风格，独自送入图片 API；
`_caption` 用简短、描述性的出版语言解释图的对象与组织关系，写入图外的 caption。
模型不再接收被脚本拼入的图注或内部任务 JSON。图注不能回退成大纲意图；
出版脚本处理百分号等特殊字符的转义。仅改 caption 时可以复用原图。

## 署名、图片后处理与进度

整篇综述沿用参考工作流的署名格式：中文“书深AI 生成•研究综述初稿”，
英文 `AI-assisted research review draft by "ScholarSeed"`。PDF、Markdown 和
PDF 降级 Markdown 共用同一文案；单独组件保持其请求范围。

图片模型的输出固定先裁剪上下空白、保留宽度，再在右下角写入
`Generated by ScholarSeed AI`。字体、灰度和边距沿用参考实现；若水印区域
包含内容，则向下延伸背景，不覆盖原图。原始图片留在请求日志，已完成任务重复执行不
叠加水印。未完成任务可重试，后处理失败不能当作成图成功。

主代理应在开始任务、切换阶段、启动长任务、并发分支完成和处理异常时主动
汇报进度，说明当前阶段、正在执行的操作和下一步，使用真实状态与计数。

## 内部分发配置

- 打包脚本原样包含整个 `config/` 目录，包括当前不含凭据的
  `model_config.fast.json`；
- `config/model_config.fast.example.json` 保留为重置或迁移时的模板；
- `PAPER_HUB_URL` 可覆盖 `config/endpoints.json` 的 PaperHub 地址；
- PaperHub 全文下载默认继承代理，连接失败才回退直连；`NO_PROXY` 不会默认加入 PaperHub 域名。确需直连时使用 `PAPERHUB_PROXY_MODE=direct` 或 `SLR_NO_PROXY_EXTRA`，其他端点通过 `config/endpoints.json` 的 `proxy_bypass` 显式配置绕行；
- 打包脚本只排除 `.venv`、缓存、日志和已有压缩包；模型凭据仅从接收者环境读取；
- AS 必须作为独立压缩包分发，其最新版配置是唯一可信检索配置。

因此该发行方式仅适合可信的内部接收者。SLR 压缩包不会包含任何 AS
实现或检索配置。

## 生成发行包

在 skill 根目录运行：

```bash
./scripts/package_skill.py --output ../dist
```

输出为 `../dist/literature-review-<version>.tar.gz`，并在终端打印 SHA-256。压缩包内含 `PACKAGE-MANIFEST.sha256`，可在解压目录校验：

```bash
shasum -a 256 -c PACKAGE-MANIFEST.sha256
```

建议每次发给同事前，在一个新的临时目录解压，严格按“从压缩包安装”和“五分钟离线冒烟测试”重新跑一遍。

## 常见问题

- `scholarseed-skill-python is unavailable`：从 ScholarSeed Desktop 或 Serve 启动。
- doctor 报 `SCHOLARSEED_ACCOUNT_TOKEN` `MISS`：在启动 Codex 前导出文本 token；
  图片默认可复用该 token，也可以单独设置优先级更高的 `IMAGE_API_KEY`；
  provider URL `MISS` 则设置对应 URL 环境变量或修正 config 默认值。
- doctor 报 independent agentic-search `MISS`：先按 AS 自己的 README 安装；
  SLR 不提供内置检索回退。
- 检索端 PaperHub unreachable：由 AS 按自己的规则降级到公共网页检索；
  若已降级，不重复请求 PaperHub 或索要 token。SLR 不持有检索配置。
- 没有 PDF 工具链：先选择 Markdown 测试完整语义流程；需要 PDF 时再安装 TeX 和 `requirements.txt` 中的 PDF 依赖。
- 新检索论文缺摘要、作者或年份：从候选/SLR语料中排除并报告；本地用户PDF按独立导入契约保留。
- 图片生成很慢：图片按大纲计划提前启动，并与全文写作并行；已成功或已失败的请求不会在 publish 阶段重复发送。

故障处理以命令返回的字段错误、next_action、状态和日志为准；SKILL.md保留流程判断。
references仅保留subagent的roles，不再提供重复的阶段说明。

旧角色提示词与历史设计说明已从活动 skill 删除，可从 Git 历史恢复。当前只使用
searcher 和 figure-planner 两个角色。保留的底层兼容接口不进入默认 CLI 帮助、
阶段列表或 doctor 检查；维护旧工作区时可用 `--legacy-help` 和
`stages --include-legacy` 查看，边界见 `scripts/compatibility/README.md`。
旧直接审计器所需 jieba 已移入其可选 requirements，当前安装与原生v2出版流程无需它。

## 原生章节、完整 v1 与可编辑 v2

确认大纲后，`manuscript prepare` 保留完整章节任务包。所有顶层章节并发调用，
脚本将固定章节开头放在prompt末尾，LLM只续写原始LaTeX（或Markdown），不包装JSON。
章节文件保存“固定开头＋续写”，组装时直接拼接，不重复添加章节标题。
摘要由脚本提供环境开头和结尾；无标题组件不添加章节标题。
表格由章节写成原生正文；图片只在正文引用，由独立生图agent按既有顺序完成。

`manuscript generate` 等待所有章节和真实图片、caption、包装完成，组装带模板的
`05_generation/full_draft_v1.tex`。一次refine读取完整v1、文本依赖、需求、大纲和证据，
返回target/before/after结构化delta。脚本检查唯一匹配与不重叠，形成
`05_generation/full_draft_v2.tex`；delta不合法则保留响应并交给main修复v2基础稿。

仅调用失败会重试对应任务，已完成章节不重写；内容缺陷由refine或main修复。
没有章节、精修、图片或编译缓存，没有hash、acceptance和seal编辑门槛。
任务状态和完成文件仅支持本次失败恢复，不是跨任务缓存。

main直接修改v2及其实际依赖文件中的一切论文问题；无需同步JSON、accept或
管理恢复状态。唯一常用出版命令为 `workflow publish`：当前源码诊断、编译导出、
渲染首页及图表实际所在页。旧大纲差异仅提示，编译失败需修复；后续出版永不重新装配覆盖v2。
历史工作区不批量改名，需将已知最终旧稿显式导入新出版工作区。

生成、恢复和v2直接编辑规则统一见 SKILL.md。

## 新网关与本地 PDF

默认模型地址为 `https://scholarseed.damo.alibaba.com/v1/`；PaperHub base 为
`https://scholarseed.damo.alibaba.com/paperhub`，搜索与下载分别追加
`/papersearch`、`/paperdownload`。已知退役地址会规范化到新地址，自定义覆盖保留。

用户给定的 PDF 先通过 `papers import-local --request local-files.json` 导入：
`{"files":["/absolute/path/papers",{"path":"/absolute/path/a.pdf","title":"真实标题"}]}`。
再用 `papers budget` 获取补检数，交给检索子代理。38 篇补 10 篇、28 篇补 20 篇；
达到 40 篇不再补检，超过 40 篇仍全部保留。相同文件按哈希去重。

导入的 PDF 与 PaperHub 下载共用工作区缓存和后续解析→paper card→大纲→写作
流程，不上传文件。来源和元数据缺失均显式记录。本地导入字段可查询 `papers import-local --describe-input`；缺少可用文本时明确报错，不补抓摘要。

## 仓库集成与平台验证

ScholarSeed 的大纲 checkpoint 会追加产品确认卡，询问是否按大纲及当前输出格式、
引用样式开始写作，并允许直接输入修改意见。五分钟等待由产品拥有；主 Agent 将 bridge
返回的 confirmation 原样交给 `writing review-complete --request FILE`，不再并行启动
shell 轮询。修改不等于批准；取消不自动继续。独立宿主仍可使用原有显式等待命令。

本次选择性合入上游 2026.09.22.2 的大纲五分钟确认与出版文案，产品版本为 2026.9.22+2。保留产品全文授权 checkpoint、工作区 task activate、产品 Python 准入、pypdf 补丁下限和 Fandol 字体。独立安装章节仅为上游背景；本仓库构建使用 `pnpm ops pre install python` 与 prebundle。

| 行为 | macOS | Windows |
|---|---|---|
| 入口 | scripts/slr | scripts/slr.cmd |
| Python 与准入 | 产品解释器执行 service.cli.skill_python | 相同，使用 argv 或产品 cmd 入口 |
| 工作区锁 | filelock 的系统锁 | filelock 的系统锁 |
| 超时清理 | POSIX 进程组 | Windows Job Object / taskkill |
| 中文字体 | TeX Fandol | TeX Fandol |
| 源码换行 | LF | Git 保留 LF，生成的工作区 cmd 使用 CRLF |

源码字节哈希以 LF 为准，避免跨平台 checkout 改变清单。运行技能 test_*.py、保留的 smoke_publication.py、产品 prebundle/依赖契约，再从实际 Desktop 触发技能。每个平台分别记录真实结果；本机测试不代表另一个平台通过。
