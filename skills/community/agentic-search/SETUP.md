# Codex 与网络设置

## 推荐安装

```bash
scholarseed-skill-python tools/install_codex.py --scope user --with-network-profile
# 可选：仅为已登录用户注入 PaperHub 增强能力
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
codex --profile agentic-search-quality
```

安装器会同时安装默认 Quality 别名和三个产品档位：

| profile | 用途 | 默认模型/推理强度 | service tier / Apps |
|---|---|---|---|
| `agentic-search-quick` | 快速搜索栏，目标约 1 分钟 | Luna / low | 默认值 / 继承 |
| `agentic-search-balanced` | 常规交互，目标 5–6 分钟 | Sol / high | 默认值 / 继承 |
| `agentic-search-quality` | C1 质量优先，不设时限 | Sol / xhigh | fast（请求级 priority）/ 关闭 |
| `agentic-search` | 默认 Quality 的短别名 | Sol / xhigh | fast（请求级 priority）/ 关闭 |

这些 profile 都会启用 live web search、保持 `workspace-write` 文件沙箱，并允许该沙箱中的命令联网。档位 profile 还会选择对应的模型和推理强度。`agentic-search` 与
`agentic-search-quality` 内容相同，因此未明确选择低延时配置时，以 Quality/C1 为
默认。若不想安装 profile，也可以临时运行：

```bash
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true
```

`web-search` skill 的 `codex-native` provider 是托管工具，不走 Python/shell 的
`HTTP_PROXY`；其 `official-api` provider、PaperHub 和 Brave 是本地命令发出的 HTTP 请求，
会继承启动 Codex 时的网络环境。这两类路径需要分别判断。运行 agentic-search 前必须
另行安装 `web-search`，项目级安装位置为 `.agents/skills/web-search/`。

### 模型与运行配置覆盖

当前 Quality/C1 的完整盲测组合是 `gpt-5.6-sol + xhigh +
service_tier=priority + Apps off`。仓库中的 Quality profile 用 Codex CLI 的
`service_tier = "fast"` 配置对应的快速服务路径，并设置
`features.apps = false`。这些设置只影响以该 profile 启动的 session，不改变
`SKILL.md` 中的 C1 算法。

Codex 配置优先级从高到低为：命令行参数、项目 `.codex/config.toml`、所选 profile、
用户 `~/.codex/config.toml`、系统配置和内置默认值。因此账号没有推荐模型或快速服务
额度时，可以这样替换：

```bash
codex --profile agentic-search-quality \
  -m <账号可用的模型> \
  -c model_reasoning_effort='"high"' \
  -c service_tier='"default"'
```

也可以直接编辑安装后的 `$CODEX_HOME/agentic-search-quality.config.toml`，作为该机器
的持久默认值。安装器不会覆盖已有 profile；要采用仓库新版，请先备份旧文件再重新
安装。更换模型或 effort 后仍会走 Quality/C1 检索图，但实体解析、停止判断、延迟和
质量可能变化，应把实际组合当成独立版本验证。

profile 只能配置 session 环境，不能强制 Skill 在 prompt 中选择哪一档。调用时仍应
明确写 Quick、Balanced 或 Quality；未指定档位和时限时，Skill 默认 Quality。

## PaperHub

无需配置时，工具使用仓库内 `tools/search_config.default.json` 的当前直连地址。覆盖优先级是：

1. 环境变量（如 `PAPERHUB_URL`、`PAPERHUB_PROXY_MODE`）；
2. `AGENTIC_SEARCH_CONFIG` 指向的 JSON；
3. `~/.config/agentic-search/search_config.json`；
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

自定义 endpoint 按用户配置保留。对官方 `scholarseed.damo.alibaba.com` 域名，配置文件或
显式 `PAPERHUB_URL` 中的 `http://` 会被强制升级为 `https://`；localhost 与其他
自定义/内网 URL 不会被改写。

PaperHub Bearer token 只从环境变量读取。它是可选的增强能力；要启用时，必须在启动
Codex 的同一个 shell 中设置：

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
```

不要把真实 key 写入仓库、`search_config.json`、Codex profile、命令参数或共享日志。
当前默认 endpoint 使用 HTTPS。

没有 key 时，Skill 不会要求用户补充，而是使用 `$web-search` 生成明确标记的降级
结果。环境变量只会在 Codex 启动时被继承。产品应在登录用户的进程环境中注入 key，
退出登录后创建不含 key 的新进程；不要通过 prompt、命令参数或共享日志传递 key。

若 `export SCHOLARSEED_API_KEY=...` 发生在 session 启动之后，请退出并重新启动 Codex；若
全局 Codex 配置自定义了 `shell_environment_policy`，还要确认它没有过滤
`SCHOLARSEED_API_KEY`、代理变量或 `PATH`。

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

本仓库安装的 profile 面向本地 Codex CLI。Codex Cloud 的 agent internet access 需要在对应 cloud environment 中另外开启，并把 PaperHub 主机加入 allowlist；若使用 Brave，再加入 `api.search.brave.com`。仓库代码不能替用户修改云端组织/环境权限。

### 新接口行为

所有 PaperHub 操作现在都通过同一个 `POST /papersearch/` endpoint：

- `keyword`：发送 `query`，支持 Elasticsearch `query_string` 语法；
- `title`：发送 `title` 做已知题名匹配；
- `references`：发送 `cited_by` 列表，返回“这些论文各自引用了哪些论文”，不是返回引用这些论文的后续文献；
- `papers`：发送 `ids` 列表批量获取论文详情。

新服务暂不支持 semantic search；`paperhub.py semantic ...` 会明确返回 `PAPERHUB_UNSUPPORTED_MODE`，skill 工作流只使用 keyword、title 和 citation tracking。keyword/title 默认要求 abstract；确需保留无摘要结果时可加 `--allow-missing-abstract`，年份过滤可用 `--year-start` 与 `--year-end`。

### 可复现实验缓存

普通用户保持 `cache_mode: "off"` 即可。做策略 A/B 时，可用查询缓存固定 PaperHub 响应：

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

- 符号链接安装：更新本仓库后即可获得新代码；若要启用 PaperHub，再更新
  `SCHOLARSEED_API_KEY` 和用户配置并重启 Codex；
- copy 安装：安装器不会覆盖现有 skill，请先把旧目录移动到备份位置，再以 `--mode copy` 重新安装；
- 安装器不会覆盖已有的 `~/.config/agentic-search/search_config.json`，发现旧默认 URL 时只会提示；运行时兼容迁移不会改写该文件。

## web-search skill

推荐用安装好的 profile：

```bash
codex --profile agentic-search-quick
codex --profile agentic-search-balanced
codex --profile agentic-search-quality
```

或者每次加 `--search`，供 `$web-search` 的 `codex-native` provider 使用。`web-search`
skill 可被发现不代表 PaperHub 可用；`official-api` 和 PaperHub 仍受 sandbox 命令网络与
机器代理控制。agentic-search 的所有公网检索都必须经由 `$web-search`，不得直接调用
原生 Web Search。

## Brave（默认关闭，显式启用）

正常运行使用 `$web-search`，并在凭据可用时增强使用 PaperHub。即使环境中存在
`BRAVE_API_KEY`，Skill
也不会仅因为检测到 key 就自动调用 Brave。只有用户明确要求，或两个主要路径不可用
且用户接受备用检索源时，才启用 Brave。

需要启用时设置：

```bash
export BRAVE_API_KEY="你的 key"
```

请求目标是 `api.search.brave.com`。key 缺失、认证失败或额度耗尽时，Skill 会继续
使用 PaperHub 和 `$web-search`，不反复重试 Brave。

## 验证

```bash
# 不联网：查看安装、配置来源、key 是否存在和代理环境（不会输出密钥）
scholarseed-skill-python tools/doctor.py

# 发出一个最小 PaperHub 请求
scholarseed-skill-python tools/doctor.py --live

# 单独验证
scholarseed-skill-python tools/paperhub.py title "Attention Is All You Need" --limit 1
scholarseed-skill-python tools/brave.py "Attention Is All You Need paper" --count 1
```

诊断时可按错误码区分问题：`PAPERHUB_AUTH_MISSING` 是 key 未进入进程，会触发 Web-only
降级而不是要求用户配置；`PAPERHUB_HTTP_401` 是认证失败，
`PAPERHUB_TRANSPORT_ERROR` 才是网络、代理或隧道问题。若 `doctor.py --live` 在 sandbox
内提示网络受限，使用任一 `agentic-search-*` 档位 profile（或兼容的
`agentic-search` profile）重新启动 Codex；若批准后切到 sandbox 外出现失效回环
代理，`auto` 模式会自动尝试干净直连。仍失败时再检查目标地址是否能从该机器访问。
