# Agentic Search：分档学术论文检索

这是一个面向 Codex 的学术论文检索 Skill。用户可以直接输入自然语言研究问题，
包括没有写出论文名、方法名或数据集名的含蓄问题；Skill 会识别隐藏实体、检索候选
论文、沿参考文献补充相关工作，并返回按相关性分层的 `metadata.json`。

它适合这些场景：

- 从一段研究设想或争议中寻找最相关论文；
- 根据零散线索定位方法、项目、数据集、标准或奠基论文；
- 为调研、related work 或系统综述建立候选论文池；
- 在响应速度和检索质量之间选择合适档位。

默认只返回论文元数据，不生成长篇研究报告。

## 三个检索档位

| 档位 | 适合场景 | 时间目标 | 默认论文数 | 推荐 Codex 配置 |
|---|---|---:|---:|---|
| **Quick** | 搜索栏、快速预览 | 1 分钟内 | 最多 20 篇 | Luna / low |
| **Balanced** | 日常交互式论文检索 | 5–6 分钟 | 38–40 篇 | Sol / high |
| **Quality** | 高召回调研、复杂或含蓄问题 | 不设硬时限；当前基准约 8–9 分钟 | 38–40 篇 | Sol / xhigh / fast |

**默认档位是 Quality。** 用户没有指定档位或时间预算时，会执行当前质量最好的 C1
工作流。Quick 和 Balanced 只在用户明确指定，或给出相应时间预算时启用。

三个档位不是把同一流程简单截断：

- **Quick**：一次实体解析、一次有界 PaperHub 检索图和确定性选稿；
- **Balanced**：一轮集中检索、模型选择引用锚点和集合级选稿；
- **Quality**：按实体–关系缺口进行多轮检索，每轮选择引用锚点，最后执行
  provenance audit。当前 Quality 使用完整 C1 策略。

## 快速开始

前提：已安装并登录 Codex CLI，并从 ScholarSeed Desktop 或 `scholarseed-serve` 启动。PaperHub API key 是登录用户的
增强能力，不是运行前提。

### 1. 安装

在本仓库根目录执行：

```bash
scholarseed-skill-python tools/install_codex.py --scope user --with-network-profile
```

这个命令不会安装 Codex。它会安装：

- 用户级 Skill：`~/.agents/skills/agentic-search`；
- 四个 Codex profile：默认 Quality 别名，以及 Quick、Balanced、Quality；
- PaperHub 用户配置：`~/.config/agentic-search/search_config.json`。

默认使用符号链接，因此需要保留本仓库目录；如果需要独立副本，加 `--mode copy`。
新增 Skill 没有出现在 Codex 中时，请重启 Codex。

### 2. 可选：启用 PaperHub 增强能力

```bash
export SCHOLARSEED_API_KEY="你的 PaperHub API key"
```

必须在启动 Codex 前设置。key 只从环境变量读取，不应写入仓库、配置文件或共享日志。
没有 key 时无需额外配置，Skill 会通过另行安装的 `$web-search` skill 返回明确标记的降级结果，也
不会要求用户提供 token。

### 3. 选择档位并调用

#### Quality：默认档位

```bash
codex --profile agentic-search-quality
```

进入 Codex 后直接调用，无需再写档位：

```text
$agentic-search 检索“检索增强生成中的引用可靠性评估”相关论文
```

`codex --profile agentic-search` 是同一 Quality 配置的短别名。显式写“Quality”也可以：

```text
$agentic-search 用 Quality 模式完整检索“检索增强生成中的引用可靠性评估”
```

#### Balanced：5–6 分钟档

```bash
codex --profile agentic-search-balanced
```

```text
$agentic-search 用 Balanced 模式检索“检索增强生成中的引用可靠性评估”
```

#### Quick：1 分钟档

```bash
codex --profile agentic-search-quick
```

```text
$agentic-search 用 Quick 模式检索“检索增强生成中的引用可靠性评估”
```

profile 选择适合该档位的模型、reasoning effort 和联网权限；用户 prompt 决定实际
检索算法。为了获得已经验证过的质量和延迟，建议二者保持一致。例如使用 Quick
profile 时，也在请求中明确写 Quick。

也可以只指定端到端时间预算：

```text
$agentic-search 在大约 6 分钟内完成“检索增强生成中的引用可靠性评估”的论文检索
```

当前映射规则：

- `time_budget_minutes <= 2`：Quick；
- `2 < time_budget_minutes <= 6`：Balanced；
- `time_budget_minutes > 6`：带 deadline 的 Quality；
- 未指定：无时限 Quality/C1。

deadline 可以阻止新的检索批次，但不能中断正在生成的一次模型响应，因此这些时间是
软目标，不是硬 SLA。

## 默认检索源

默认策略是 **有凭据时 PaperHub 直连优先 + `$web-search` skill + 不使用 Brave**：

1. **PaperHub** 是可选的结构化增强源，用于关键词、题名、论文详情和参考文献查询；
2. **`$web-search` skill** 统一承接公网检索，宿主依次尝试 `official-api`、`codex-native`；
   两者统一返回 `scholarseed.web_search.v1` 候选核心，agentic-search 不直接绕过该 skill
   调用原生 Web Search，也不使用 automatic/browser profile；
3. **Brave 默认关闭**。即使环境中存在 `BRAVE_API_KEY`，也不会自动使用。

凭据缺失、被拒绝，或 PaperHub 在有界重试后整体不可达时，Skill 会停止 PaperHub
请求，复用/补充公网论文候选并写入 `source_mode: "web_only"`、`degraded: true` 和覆盖
限制；不会把普通网页伪装成论文，也不会为了凑数写入噪声。如果 `$web-search` 也
不可用，则明确失败。

降级数量契约、故障记录和旧版行为对比见
[PaperHub 降级策略](docs/PAPERHUB_FALLBACK.md)。

PaperHub 默认配置为 `auto`，并继承当前网络代理；传输异常时还会尝试清理代理环境后的
直连。若宿主通过受限网络代理执行域名授权，旧用户配置中的 PaperHub `NO_PROXY`
绕行可能导致请求失败，需移除该配置。需要直连或 SSH 隧道的机器，可以修改用户配置，
详见 [SETUP.md](SETUP.md)。

只有用户明确允许，或 PaperHub/`$web-search` 不可用且用户接受备用路径时，才会
使用 Brave。例如：

```text
$agentic-search 用 Quality 模式检索……；如果主要检索源覆盖不足，允许使用 Brave 补充
```

`$web-search` 的 `codex-native` provider 使用 Codex 托管 Web Search；`official-api`、
PaperHub 和 Brave 由本地 Python 进程发出 HTTP 请求。后者需要 sandbox 允许命令联网，
也需要机器具备可用网络路径。`web-search` 必须作为独立 skill 安装并可被运行时发现。

## 输出内容

结果默认写入当前工作区：

```text
agentic-search-results/<topic>/metadata.json
```

论文按用途分为：

- **Tier 1**：最直接回答问题的核心论文；
- **Tier 2**：明确相关的方法、证据和重要扩展；
- **Tier 3**：用于提高召回的相关实体、引用链和次级子主题论文。

每篇论文可包含题名、作者、年份、venue、期刊名、页码、volume、摘要、DOI、arXiv ID、
引用数、URL、命中来源、所属 tier 和入选理由等字段。完整 schema 见
[references/output-schema.md](references/output-schema.md)。

## 模型和配置可以更换吗？

可以。推荐 profile 是经过评测的默认组合，不是硬编码依赖。若账号没有对应模型或
fast service tier，可以在启动时覆盖：

```bash
codex --profile agentic-search-quality \
  -m <账号可用的模型> \
  -c model_reasoning_effort='"high"' \
  -c service_tier='"default"'
```

命令行参数优先于项目配置和 profile。更换模型或 effort 后仍会运行相同检索图，但
延迟、token 和质量可能变化，应作为新的运行配置验证。配置优先级、全局设置、代理、
SSH 隧道、Codex Cloud 和缓存说明见 [SETUP.md](SETUP.md)。Codex 官方的 Skill 与
profile 机制可参考 [Build skills](https://learn.chatgpt.com/docs/build-skills) 和
[Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)。

## 诊断

```bash
# 只检查配置和环境，不发网络请求
scholarseed-skill-python tools/doctor.py

# 发出一个最小 PaperHub 请求
scholarseed-skill-python tools/doctor.py --live
```

常见状态：

- `api_key_present: false`：当前会使用 Web-only 降级，不是安装错误；
- `PAPERHUB_AUTH_MISSING`：缺少 key；
- `PAPERHUB_HTTP_401`：key 无效；
- `PAPERHUB_TRANSPORT_ERROR`：网络、代理或隧道问题。

## 其他安装方式

如果 Codex 全局配置已经启用 live web search、已安装 `web-search` skill，并允许 `workspace-write` 中的命令
联网，可以只安装 Skill：

```bash
scholarseed-skill-python tools/install_codex.py --scope user
```

让某个项目的协作者都能发现它：

```bash
scholarseed-skill-python tools/install_codex.py --scope repo --repo /path/to/target-repo
```

仓库级安装不会修改用户 profile 或 PaperHub 配置。更详细的三档设计和评测边界见
[docs/TIERED_SEARCH.md](docs/TIERED_SEARCH.md)。
