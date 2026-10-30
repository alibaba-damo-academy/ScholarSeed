# Fast AI Search

面向搜索栏场景的低延迟学术论文检索。它通过另行安装的 `$web-search` skill 解析潜在论文实体，
再以 PaperHub 完成一次有界的关键词、题名和参考文献检索，最终返回最多 20 篇论文的
`metadata.json`。直接查找出版社/arXiv 链接、DOI 或明确题名时，agent 在原有网页批次内解析规范题名
`best_target` 并把它作为精确 PaperHub title 查询；并行核验输入链接/DOI 及原有网页批次中少量重要论文的元数据。
PaperHub 未召回但可独立核实的论文也能返回；单篇目标保留为 Tier 1 首篇，一篇真实结果也有效。两条路径都无法核实才明确失败，
不会用一组泛相关论文伪装成功。Tier 1 中依次优先用户查询的显式标识、agent 声明的
`best_target` 和既有确定性相关性得分；普通主题检索不改变分层，单篇查找只为身份核实的目标保留首位。这一步不增加
模型回合，普通主题检索的排序及分层规则不变。摘要只在单次 runner 进程内参与相关性
计算，不会写入 `metadata.json`、session、round trace 或检索缓存。
本仓库只提供名为 `fast-search` 的 Veryfast 检索 Skill 及其部署入口，不生成长报告，
也不会注册或覆盖其他检索 Skill。

## 先选择使用方式

前提：已安装并登录 Codex CLI、从 ScholarSeed Desktop 或 `scholarseed-serve` 启动、已安装 `web-search` skill，并持有 PaperHub API key。
以下命令都在仓库根目录执行。

| 方式 | 适合场景 | 优点 | 需要注意 |
|---|---|---|---|
| Codex Skill | 个人检索、交互式使用、开发调试 | 安装后可直接用 `$fast-search` 调用，接入最简单 | 每个新 Codex 进程仍有启动、skill 加载和无关能力初始化开销 |
| 常驻 App Server Worker | 搜索栏、服务端集成、重复请求 | 复用 Codex 进程和鉴权，提供结构化进度事件，通常延迟更低、更稳定 | 需要后端托管 Worker、隔离输出目录并实现超时与进程健康管理 |

两种方式使用同一个 `SKILL.md`、同一个 `quick_search.py` 和相同的
`metadata.json` schema（默认返回 20 篇）。App Server 改变的是承载方式，不会自动增加检索轮次或提高
论文质量。OpenAI 官方也把 App Server 定位为带 thread、turn 和流式事件的产品集成接口：
[Codex App Server](https://developers.openai.com/codex/app-server/)。

## 方式一：安装为 Codex Skill

适合已经在使用 Codex、希望手动发起论文检索的用户。

### 1. 安装

```bash
scholarseed-skill-python tools/install_codex.py --scope user --with-search-config
```

默认使用符号链接，因此需要保留仓库目录；不能使用符号链接时加 `--mode copy`。

### 2. 启动 Codex

先设置 PaperHub key，再启用 live web search 和 sandbox 内的命令联网：

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true
```

如果这些能力已写入用户级 Codex 配置，则不必每次重复传参。新增 skill 未出现时，
重启 Codex。

### 3. 调用

```text
$fast-search $web-search 检索“检索增强生成中的引用可靠性评估”相关论文
```

两个 skill 必须显式加载到同一个 turn，不依赖隐式发现。交互式调用会在实体解析开始、
PaperHub 检索开始和最终完成时给出简短进度；文案自动匹配
用户指定的语言或 query 的语言。这些信息复用已有动作边界，不增加计时命令、模型调用或
检索轮次。它会执行相同的 Veryfast 检索图，但不会获得常驻 Worker 的进程复用收益。

### Skill 方式的性能配置

模型、reasoning effort 和 service tier 由当前 Codex session 决定，skill 自身不能修改
已经启动的 session。若优先考虑低延迟，可在账号支持时使用低延迟模型、较低 effort、
fast service tier，并关闭本流程不需要的 Apps：

```bash
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --disable apps \
  -m gpt-5.6-luna \
  -c model_reasoning_effort='"low"' \
  -c service_tier='"fast"'
```

这只是推荐起点，不是所有账号都可用的固定组合。更换为更强模型或提高 effort 可能改善
复杂实体解析，也会增加延迟和 token；应把每种组合当作独立版本重新评测。Skill 方式的
配置应放在 Codex 用户配置或 profile 中，PaperHub 地址、代理和缓存仍由
`~/.config/fast-search/search_config.json` 管理。

### 仓库级安装

让某个项目中的协作者都能发现这个 skill：

```bash
scholarseed-skill-python tools/install_codex.py --scope repo --repo /path/to/target-repo
```

它会创建 `/path/to/target-repo/.agents/skills/fast-search`。`web-search` 仍需另行安装到
同级 `.agents/skills/web-search`。产品后端直接运行 Worker 时会注入仓库内的
fast-search 与已安装的 web-search；不会复制或下载后者。

## 方式二：常驻 App Server Worker

适合搜索栏或其他产品后端。Worker 保持一个 Codex App Server 进程常驻，但每个 query
使用新的 ephemeral thread，不共享用户历史或候选池。文件名中的 `quick` 是内部兼容
名称，不代表本分支还提供另一档算法。

### 1. 启动 Worker

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
# 仅当 web-search 不在标准 skill 目录或 fast-search 的同级目录时需要：
export WEB_SEARCH_SKILL_PATH="/absolute/path/to/web-search"
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

### 2. 接入请求和进度

等待 `server.ready` 后，向标准输入逐行写入：

```json
{"id":"request-1","query":"完整的论文检索需求","output_dir":"/absolute/path/to/result-1","language":"zh"}
```

Worker 根据实际事件最多输出 `analyzing`、`entity_resolution`、`paper_retrieval`、
`finalizing` 和 `completed`，每条包含一句与请求语言匹配的说明及累计
`elapsed_seconds`；不会为了补齐阶段增加模型调用、检索或等待。默认根据 query 中是否
包含中文自动选择中文或英文，也可以由配置或单次请求的 `language` 显式指定。成功结果
写入 `output_dir/metadata.json`。一个
Worker 严格串行，需要并发时由后端运行有界 Worker 池。

单题冒烟验证：

```bash
scholarseed-skill-python tools/appserver_quick.py \
  --query "检索增强生成中的引用可靠性评估" \
  --output-dir /absolute/path/to/result
```

### Worker 方式的性能配置

默认配置位于 `config/fast-search-veryfast.json`。部署时建议复制到仓库外，通过
`--config` 或 `FAST_SEARCH_VERYFAST_CONFIG` 加载；启动参数优先级最高：

```bash
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl \
  --config /etc/fast-search/veryfast.json \
  --model <账号可用的模型> --effort low --service-tier default
```

```bash
scholarseed-skill-python tools/appserver_quick.py --print-effective-config \
  --config /etc/fast-search/veryfast.json
```

默认的 `gpt-5.6-luna + low + priority + enable_apps=false` 是当前低延迟验证组合。
保持 Worker 常驻、关闭无关 Apps、使用可用的低延迟模型和 service tier，主要改善
延迟；提高模型能力或 effort 可能改善规划质量，但必须重新评测。PaperHub 可可靠直连时
使用 `direct` 可减少网络绕行；不可直连时必须改为 `auto`/`inherit` 或使用 SSH 隧道。
线上应保持 `cache_mode=off`，避免把实验 replay 当作实时搜索结果。

完整配置优先级、字段含义、后端拓扑和网络设置见 [SETUP.md](SETUP.md)。Veryfast 是
软延迟目标，不是硬 30 秒 SLA；产品调用层仍需设置总 deadline、取消和失败降级。
模型、入口和搜索 provider 的实测开销、解释边界与上线监控要求见
[Veryfast 运行时性能与检索风险](docs/VERYFAST_RUNTIME_RISKS.md)。

## 检索源与网络说明

Veryfast 使用公网 web 检索和 PaperHub，并对已有论文链接做有界元数据核验。每个公网检索 batch 必须优先
从独立的 `$web-search` skill 开始，按 official → native → browser 路由执行；偶发但成功的
runtime native Web Search 可作为兼容结果，失败时必须在同一 turn 回到 `$web-search`。Worker 会把
两个 skill 显式注入同一 turn，并打开 native provider 与 `workspace-write` 下命令所需
的联网权限。PaperHub 仍要求机器
自身能通过直连、代理或 SSH 隧道到达服务，并在 Worker 启动前设置
`SCHOLARSEED_API_KEY`。详细配置见 [SETUP.md](SETUP.md#paperhub)。

补充核验不增加模型或搜索轮次：最多 4 个已有 DOI/论文链接，使用 Crossref 精确 DOI 记录或
文章页的学术引用元数据，与 PaperHub 并行、共享 8 秒等待上限。不采信搜索摘要或模型编造的
作者/日期，不下载 PDF，不落盘论文摘要。核验使用匿名公网 HTTPS，不读取代理凭据、Cookie
或登录状态；网络不可达时跳过补充路径，已有 PaperHub 结果仍可使用。若 PaperHub 服务失败而已有
合格核验结果，也允许返回，并记录来源与服务失败情况。

这不是全文获取功能，也不保证任意网站都能解析：没有可核实元数据、页面拦截或超时仍可能失败。
外部论文沿用时间约束和现有排序；不把预印本与正式版的标识混用。正常检索无需为凑数量添加网页候选。

## 诊断

```bash
scholarseed-skill-python tools/doctor.py
scholarseed-skill-python tools/doctor.py --live
```

`api_key_present: false` 表示 key 没有进入当前进程；`PAPERHUB_AUTH_MISSING` 表示缺少 key，`PAPERHUB_HTTP_401` 表示 key 无效。诊断输出只显示 key 是否存在，不打印其内容。

更换 PaperHub 地址、SSH 隧道、代理模式和 Codex Cloud 设置见 [SETUP.md](SETUP.md)。

## 目录结构

```text
fast-ai-search/
├── agents/openai.yaml                    # Codex UI 与调用元数据
├── config/fast-search-veryfast.json      # 常驻 Worker 默认配置
├── SKILL.md                              # Veryfast 权威工作流
├── SETUP.md                              # 网络与部署配置
└── tools/
    ├── appserver_quick.py                # 常驻 Veryfast Worker
    ├── quick_search.py                   # 单调用检索与选稿入口
    ├── search_round.py / paperhub.py     # 有界检索与 PaperHub 接口
    ├── quick_finalize.py / ranking.py    # 确定性排序与选稿
    ├── state.py / search_policy.py       # 单次运行状态与硬约束
    ├── localconf.py / cache.py           # 机器配置与可选请求缓存
    ├── doctor.py                         # 本地诊断
    └── install_codex.py                  # 可选的交互式 skill 安装器
```

fast-search 自带的 Python 工具只使用标准库；独立 `web-search` skill 的依赖由其
自身安装包负责。产品调用方通过每次请求的
`output_dir` 指定结果目录；交互式调用则写入当前工作区下的新结果目录。

内部文件和输出中的 `quick` 是为兼容已验证实现与 schema 保留的名称；它只承载
Veryfast，不对外提供档位切换。
