# Veryfast 部署与网络设置

## 最小启动

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
export WEB_SEARCH_SKILL_PATH="/absolute/path/to/web-search"  # 非标准安装位置才需要
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

Worker 会自行启动 `codex --search app-server`，为每个请求显式配置模型、reasoning
effort、service tier、`workspace-write` 和命令联网权限，不依赖 Codex profile。只在
交互式 Codex 中安装 skill 时，才需要这样启动会话：

```bash
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true
```

`web-search` skill 的 native provider 是托管工具，不走 Python/shell 的
`HTTP_PROXY`；其 official provider 与 PaperHub 是本地 Python 命令发出的 HTTP 请求，
会继承 Worker 启动时的网络环境。这两类路径需要分别判断。Worker 会从 fast-search
同级目录、`.agents/skills/web-search`、用户 skill 目录或 `WEB_SEARCH_SKILL_PATH` 查找
该独立 skill；找不到时启动即失败，不会绕过它直接调用原生 Web Search。
这是 Worker 的启动依赖检查；Skill 方式则必须在同一 turn 显式加载
`$fast-search` 与 `$web-search`，不能依赖隐式 skill 发现。

## PaperHub

无需配置时，工具使用仓库内 `tools/search_config.default.json` 的当前直连地址。覆盖优先级是：

1. 环境变量（如 `PAPERHUB_URL`、`PAPERHUB_PROXY_MODE`）；
2. `FAST_SEARCH_CONFIG` 指向的 JSON；
3. `~/.config/fast-search/search_config.json`；
4. skill 内兼容文件 `tools/search_config.json`；
5. 仓库自带 `tools/search_config.default.json`。

安装器会把默认文件复制到第 3 个位置，且不会覆盖已有文件。示例：

```json
{
  "paperhub_url": "https://scholarseed.damo.alibaba.com/paperhub",
  "paperhub_proxy_mode": "auto",
  "extra_no_proxy": ["scholarseed.damo.alibaba.com"],
  "cache_dir": "",
  "cache_mode": "off",
  "cache_replay_timing": "instant"
}
```

自定义 URL 和显式 `PAPERHUB_URL` 不会被自动改写。

PaperHub Bearer token 只从环境变量读取。必须在启动 Codex 的同一个 shell 中设置：

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
```

不要把真实 key 写入仓库、`search_config.json`、Codex profile、命令参数或共享日志。当前
ScholarSeed endpoint 使用 HTTPS；只有显式配置本地 SSH 隧道时才使用 localhost HTTP。

环境变量只会在 Codex 启动时被继承。若 `export SCHOLARSEED_API_KEY=...` 发生在 session 启动之后，请退出并重新启动 Codex；若全局 Codex 配置自定义了 `shell_environment_policy`，还要确认它没有过滤 `SCHOLARSEED_API_KEY`、代理变量或 `PATH`。

`paperhub_proxy_mode` 可取：

- `auto`（推荐）：遵循继承的代理和 `NO_PROXY`；传输/代理失败后尝试干净直连；
- `inherit`：只使用 Python 从环境继承的代理；
- `direct`：忽略代理，只直连 PaperHub。

三种常见连接方式如下：

| 场景 | `paperhub_url` | `paperhub_proxy_mode` | `extra_no_proxy` |
|---|---|---|---|
| 默认直连 | `https://scholarseed.damo.alibaba.com/paperhub` | `auto` 或 `direct` | 包含 `scholarseed.damo.alibaba.com` |
| 必须走 HTTP 代理 | 同上 | `inherit` 或 `auto` | 移除 `scholarseed.damo.alibaba.com` |
| SSH 隧道 | `http://localhost:18000` | `direct` | 包含 `localhost`、`127.0.0.1` |

`extra_no_proxy` 会同时写入 `NO_PROXY` 与 `no_proxy`。因此仓库默认值会绕过代理直连当前域名；若公司网络要求 PaperHub 必须走代理，必须从用户配置中移除该域名。不要在仓库配置中提交代理密码。

### SSH 隧道

直连不可用时，可把服务映射到本机：

```bash
ssh -N -o ServerAliveInterval=30 \
  -L 18000:<PAPERHUB_HOST>:<PORT> <USER>@<JUMP_HOST>
```

然后在用户配置中设置：

```json
{
  "paperhub_url": "http://localhost:18000",
  "paperhub_proxy_mode": "direct",
  "extra_no_proxy": ["localhost", "127.0.0.1"]
}
```

注意：Codex Cloud 中的 `localhost` 是云容器，不是你的个人电脑；云任务应使用可从云环境访问的 PaperHub 地址，并允许 `/papersearch/` 的 HTTP `POST`。

Codex Cloud 的 agent internet access 需要在对应 cloud environment 中另外开启，并把
PaperHub 主机加入 allowlist。仓库代码不能替用户修改云端组织或环境权限。

### 新接口行为

所有 PaperHub 操作现在都通过同一个 `POST /papersearch/` endpoint：

- `keyword`：发送 `query`，支持 Elasticsearch `query_string` 语法；
- `title`：发送 `title` 做已知题名匹配；
- `references`：发送 `cited_by` 列表，返回“这些论文各自引用了哪些论文”，不是返回引用这些论文的后续文献；
- `papers`：发送 `ids` 列表批量获取论文详情。

新服务暂不支持 semantic search；`paperhub.py semantic ...` 会明确返回 `PAPERHUB_UNSUPPORTED_MODE`，skill 工作流只使用 keyword、title 和 citation tracking。keyword/title 默认请求 abstract 供当前进程内相关性判断，但所有持久化边界都会删除摘要；确实不需要内存摘要时可加 `--allow-missing-abstract`，年份过滤可用 `--year-start` 与 `--year-end`。

### 可复现实验缓存

普通用户保持 `cache_mode: "off"` 即可。做策略 A/B 时，可用查询缓存固定 PaperHub 响应：

新写入的缓存会删除所有摘要字段。升级前已经存在的旧缓存和历史结果不
会由运行时代码批量改写，部署方应按法务保留策略单独清理。

- `readwrite`：命中则回放，未命中则实时请求并记录；
- `refresh`：强制实时请求并覆盖旧记录；
- `replay`：严格回放，未命中返回 `SEARCH_CACHE_MISS`，绝不偷偷访问实时后端；
- `readonly`：只读已有记录，但是否在未命中时继续实时请求由调用方决定；
- `off`：完全关闭。

新格式会同时记录完整响应和该请求的实际 wall。`cache_replay_timing` 可设为：

- `instant`：立即返回，适合快速功能测试；
- `account`：立即返回，但在 PaperHub `elapsed` 指标中补回记录的 wall；
- `sleep`：实际等待记录的 wall，适合比较端到端 agent 行为。

正式可归因实验推荐 `replay + sleep`；最终真实效果仍要用 `off` 再做一次联网盲测。缓存 key 不包含主机，因此直连和 SSH 隧道可以共用；`$web-search` 不经过这个 PaperHub Python 缓存。

### 从旧版升级

- 符号链接安装：更新本仓库后即可获得新代码，再更新 `SCHOLARSEED_API_KEY` 和用户配置并重启 Codex；
- copy 安装：安装器不会覆盖现有 skill，请先把旧目录移动到备份位置，再以 `--mode copy` 重新安装；
- 安装器不会覆盖已有的 `~/.config/fast-search/search_config.json`，发现旧默认 URL 时只会提示；运行时兼容迁移不会改写该文件。
- 产品运行参数统一由 `config/fast-search-veryfast.json`、部署配置和启动参数管理。

## web-search skill

常驻 Worker 启动 App Server 时自动加 `--search`，并把 fast-search 与已安装的
web-search 一起作为结构化 skill input 注入。公网 batch 必须先从 web-search skill
开始；`--search` 为其 native provider 提供能力。偶发但成功的 direct native 调用可
作为兼容结果，失败时必须在同一 turn 回到 web-search official 路径。official provider
与 PaperHub 仍受命令网络权限与机器代理控制。交互式调用也必须安装并显式加载
web-search，并用 `codex --search` 或用户级配置为其 native provider 启用 live Web Search。

## 常驻 Veryfast / App Server

### 使用边界

本仓库只提供 `fast-search` 的 Veryfast 工作流。产品后端需要托管下面的 Worker，而不是为每个请求重新启动
一个交互式 Codex：

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

Worker 自行启动本地 Codex App Server，使用 stdio JSONL 通信，并在每个请求中显式
设置模型、effort、service tier、联网 sandbox 和结构化 skill input。因此不需要、
也不读取 Codex profile 中的模型设置。Codex 必须已经用运行 Worker 的系统账号登录；
PaperHub key 和代理变量必须在 Worker 启动前进入环境。

OpenAI 官方把 App Server 定位为产品深度集成接口，并支持 thread、turn 和流式事件。
本 Worker 使用本机 stdio，不对外开放 App Server。若另行使用远程 WebSocket，需注意
该传输目前仍为实验性，并应配置 TLS 与认证：
https://developers.openai.com/codex/app-server/

### 统一配置

仓库默认文件是 `config/fast-search-veryfast.json`：

```json
{
  "model": "gpt-5.6-luna",
  "effort": "low",
  "service_tier": "priority",
  "timeout_seconds": 900,
  "enable_apps": false,
  "cache_mode": "off",
  "cache_dir": "",
  "cache_replay_timing": "instant",
  "paperhub_proxy_mode": "direct",
  "progress_language": "auto"
}
```

不要直接在共享仓库中写机器配置。复制一份到部署目录，再用以下任一方式选择：

```bash
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl \
  --config /etc/fast-search/veryfast.json

export FAST_SEARCH_VERYFAST_CONFIG=/etc/fast-search/veryfast.json
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

配置优先级从低到高为：程序兜底值、仓库默认文件、部署配置文件、现有的
`PAPERHUB_*` / `SEARCH_CACHE_*` 环境变量、单项启动参数。环境变量只覆盖对应的
PaperHub/缓存项；模型、effort 和 service tier 使用配置文件或启动参数。可以先检查
合并结果，不启动 Codex，也不需要 PaperHub key：

```bash
scholarseed-skill-python tools/appserver_quick.py --print-effective-config \
  --config /etc/fast-search/veryfast.json
```

所有 Worker 启动参数都可以覆盖配置文件，例如账号没有默认模型或 priority 权限时：

```bash
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl \
  --config /etc/fast-search/veryfast.json \
  --model <账号可用的模型> \
  --effort low \
  --service-tier default
```

模型必须对当前 Codex 账号可用，effort 也必须被该模型支持；否则 App Server 会在创建
thread 或 turn 时返回错误。更换模型、effort 或 service tier 会改变延迟、token 消耗
和检索质量，工程侧应把实际组合当成一个独立版本验证。

| 配置 | 默认值 | 工程影响 |
|---|---|---|
| `model` | `gpt-5.6-luna` | 速度、能力、quota 和可用 effort；可换成账号可用模型 |
| `model_provider` | 空 | 非 OpenAI 模型使用的 App Server provider id，例如本地已注册的 `qwen38`；OpenAI 默认留空 |
| `effort` | `low` | 提高通常增加推理时间和 token，也可能改善复杂实体解析 |
| `service_tier` | `priority` | `priority` 请求更快的服务档；无权限时使用 `default`，不应视为延迟 SLA |
| `timeout_seconds` | `900` | 单题 turn 的监督上限；超时后请求中断并退出 Worker，不等同于产品端到端 SLA |
| `enable_apps` | `false` | Veryfast 不依赖 Apps；开启会扩大工具面并可能增加初始化工作 |
| `cache_mode` | `off` | 线上默认 live；缓存仅覆盖 PaperHub 请求，不缓存 `$web-search` |
| `cache_dir` | 空 | `record`、`readwrite`、`readonly`、`refresh`、`replay` 模式必须设置 |
| `cache_replay_timing` | `instant` | replay 时选择立即返回、只记账或真实等待历史耗时 |
| `paperhub_proxy_mode` | `direct` | 直连可减少代理路径；不可直连时必须改为 `auto`/`inherit` 或配置隧道 |
| `progress_language` | `auto` | 进度文案语言；`auto` 按 query 判断，也可固定为 `zh` 或 `en` |

`SCHOLARSEED_API_KEY` 不允许写入该 JSON，仍只从环境变量读取。PaperHub URL、`NO_PROXY`
和 SSH 隧道继续由本文件前面的 PaperHub 配置机制管理，避免在两个配置文件中重复维护。

### 有利于低延迟的部署方式

- 保持同一个 Worker 与 App Server 长期存活；每题重启脚本会失去常驻入口的意义。
- 保持 `enable_apps=false`，除非修改后的 Veryfast 确实调用 Connector/App。
- 使用专用服务账号和最小 Codex 配置，避免继承与搜索无关的个人 MCP、plugin 和 hook。
- 使用账号可用的低延迟模型与较低 effort；变更后重新验证质量。
- PaperHub 能可靠直连时使用 `direct`；必须经代理时正确配置 `auto`/`inherit`，不要为了
  直连 PaperHub 而清除 Codex/OpenAI 所需的代理环境。
- 保持 `cache_mode=off` 获取实时结果。若产品接受结果时效语义，可在业务层设计独立缓存，
  不要把 benchmark replay 当作线上缓存方案。

App Server 只是承载接口，不会消除每题的模型推理、`$web-search` 或 PaperHub 请求。
Veryfast 的低延迟依赖“常驻进程、精简工具面、单轮检索图和合适模型配置”的组合。

### 后端接入

推荐拓扑：

```text
浏览器搜索栏 -> 产品后端 -> 常驻 appserver_quick.py -> Codex App Server
                                            |-> web-search skill
                                            `-> PaperHub
```

产品后端从 Worker stdout 等到 `server.ready` 后，再向 stdin 逐行写请求：

```json
{"id":"request-1","query":"完整的论文检索需求","output_dir":"/absolute/path/result-1","language":"zh"}
```

Worker 根据实际可观察到的 App Server 事件，可能输出以下精简阶段，均带请求 ID、本地化
`message` 和累计 `elapsed_seconds`：

| `stage` | 含义 |
|---|---|
| `analyzing` | 理解需求并规划检索路径 |
| `entity_resolution` | 通过公网检索识别候选论文实体 |
| `paper_retrieval` | PaperHub 检索、引用扩展和确定性排序 |
| `finalizing` | metadata 已生成，正在结束本次 turn |
| `completed` / `failed` | 请求完成或失败 |

中间事件使用 `type: "progress"`，不会逐条透出内部 reasoning 或原始 App Server
事件，也不会为了生成进度增加检索、模型调用或等待。`output_dir` 必须是绝对路径且不能
已经存在，每个请求应使用唯一目录。
进度语言默认是 `auto`：含中文的 query 使用中文，其余使用英文。部署配置中的
`progress_language` 可全局固定为 `zh` 或 `en`，单次 JSONL 请求的 `language` 字段具有
更高优先级。`stage` 始终保持英文机器枚举，便于前端稳定处理。
当前一个 Worker 严格串行；并发应由后端维护有界 Worker 池，每个进程使用独立请求与
输出目录，并结合账号额度做容量测试。

不要把 Worker stdin/stdout、Codex 登录态或密钥暴露给浏览器。由后端把必要的进度事件
转换成 SSE/WebSocket，并在外层实现总 deadline、取消、重试、进程健康检查和失败降级。
当 `timeout_seconds` 到达时，Worker 会请求 `turn/interrupt` 并退出，进程管理器应启动
全新 Worker；这样不会让旧 turn 与下一位用户的请求重叠。固定并记录生产 Codex CLI
版本；App Server schema 与可用字段可能随 CLI 版本变化。

## 验证

```bash
# 不联网：查看安装、配置来源、key 是否存在和代理环境（不会输出密钥）
scholarseed-skill-python tools/doctor.py

# 发出一个最小 PaperHub 请求
scholarseed-skill-python tools/doctor.py --live

# 单独验证
scholarseed-skill-python tools/paperhub.py title "Attention Is All You Need" --limit 1

# 不启动 Codex，检查最终 Worker 配置
scholarseed-skill-python tools/appserver_quick.py --print-effective-config
```

诊断时可按错误码区分问题：`PAPERHUB_AUTH_MISSING` 是 key 未进入进程，
`PAPERHUB_HTTP_401` 是认证失败，`PAPERHUB_TRANSPORT_ERROR` 才是网络、代理或隧道问题。
若交互式调用在 sandbox 内提示网络受限，请用本页的 `codex --search` 命令重新启动；
若 sandbox 外出现失效回环代理，`auto` 模式会尝试干净直连。仍失败时再检查目标地址
是否能从该机器访问。
