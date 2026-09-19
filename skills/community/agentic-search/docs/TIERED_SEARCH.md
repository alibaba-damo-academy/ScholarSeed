# 分档学术检索设计

本文说明 agentic-search 如何把统一的检索内核映射为三个产品档位，以及当前实验证据的边界。默认产物都是论文级 `metadata.json`，不生成长报告。

## 产品档位

| 档位 | 主要场景 | 默认预算 | 模型配置 | 输出上限 |
|---|---|---:|---|---:|
| Quick | 快速搜索栏、候选预览 | 1 分钟 | Luna / low | 20 篇 |
| Balanced | 常规交互式论文检索 | 6 分钟 | Sol / high | 40 篇 |
| Quality | 系统综述前的高召回发现 | 不限时 | Sol / xhigh | 40 篇 |

连续的 `time_budget_minutes` 也使用同一入口：`B <= 2` 映射 Quick，`2 < B <= 6` 映射 Balanced，`B > 6` 映射带 deadline 的 Quality；未指定时默认 Quality。当前证据主要校准了 1 分钟、6 分钟和不限时三个产品端点，不应把每个中间分钟数都解释为已经验证过的 Pareto 最优点。

## 为什么不是简单截断同一流程

三个档位改变的是完整执行图，而不只是最大运行时间：

```text
Quick
  一次三路公网消歧 → 一次 PaperHub 检索图 → 确定性来源感知选稿

Balanced
  一次公网消歧 → 一轮高信息 PaperHub 检索 → 模型选稿与 provenance audit

Quality
  C1 逐实体缺口恢复 → 每轮模型选引用扩展 → provenance audit 与模型选稿
```

这种设计复用了 Perplexity preset 的有效控制结构：低档位减少模型决策点，高档位扩大自适应搜索；检索批处理、完整候选池和元数据规范则由所有档位共享。

### Quick

- 模型只负责从含蓄需求中解析实体，并通过 `$web-search` skill 在一个逻辑批次中并列搜索三条高信息 query。
- 随后只调用一次 `tools/quick_search.py`。它在同一进程中完成最多 4 条 keyword、8 条 exact-title、2 个自动 citation anchor、去重和选稿。
- 最终排序使用 exact-title、跨 query provenance、citation provenance、主题相关性和集合多样性；不再增加第二次模型选择回合。
- 这是同一个 skill 的正式档位，不维护一份容易漂移的独立快速 skill。

### Balanced

- 保留 Sol 对隐含实体和候选集合的判断能力，但将检索压成一次公网 batch 和一个最多 27 条 query 的逻辑 round。
- 只有在 deadline headroom 足够时才做少量 model-selected citation tracking。
- 为最后的模型选稿预留 150 秒，避免检索吃光预算。

### Quality

- 恢复 C1 高质量端点的逐实体–关系 checklist、完整 short-title probes、adaptive gap search、citation expansion 和 provenance-aware selection。
- 不固定跑满轮数，但“候选池已大”不等于覆盖充分；中心关系、新发现的命名家族或对比两侧仍有缺口时必须继续。
- 每个逻辑轮都由模型选择 3–5 个 citation anchor。自动选 anchor 的 C2 变体曾同时降低质量和速度，不用于 Quality。

## 完整 benchmark8 的当前证据

所有新结果均为盲测、严格串行、live PaperHub、query cache off；整批产物先冻结再读取 GT 评分，没有按质量重跑。

| 方法 | Recall | Precision | F1 | T1 Precision | T1+2 Recall | 平均篇数 | metadata 可用时间 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Quick（保守主结果） | 0.2229 | 0.0625 | 0.0973 | 0.1875 | 0.2229 | 20 | 0:50.5 |
| Quick（priority 重复） | 0.2479 | 0.0688 | 0.1073 | 0.2188 | 0.2229 | 20 | 0:49.8 |
| Balanced | **0.4813** | **0.0656** | **0.1151** | **0.3000** | **0.3937** | 40 | **4:33.5** |
| Quality/C1 当前复现端点 | **0.5604** | **0.0750** | **0.1318** | 0.2250 | **0.4771** | 40 | 8:14 metadata / 8:35 wall |
| Quality/C1 历史正式端点 | 0.5562 | 0.0750 | 0.1317 | 0.2500 | 0.4729 | 40 | 14:07 wall |
| Perplexity Agent fast | 0.1979 | 0.0481 | 0.0764 | 0.1000 | 0.1771 | 21.625 | 0:21.7 wall |
| Perplexity Agent medium | 0.3583 | 0.0551 | 0.0943 | 0.2250 | 0.2917 | 35.125 | 1:18.9 wall |
| Claude bench8 | 0.5750 | 0.0780 | 0.1380 | **0.3750** | **0.5125** | 39.75 | 9:19 wall |

当前 Quality/C1 行来自 commit `9a692bf` 的完整 bench8 严格串行 live 盲测：
query cache off，8 题全部先冻结再评分，基础设施失败题仅按预注册规则干净重跑。
完整 bench20 上 Recall 为 0.5167、T1 Precision 为 0.2450、T1+2 Recall 为
0.4431，平均 metadata 8:15、wall 8:33。历史 C1 行保留为跨时间重复参考，不与
当前结果混合。

Quick 两个 full-bench 批次的逻辑策略相同，第二批只为验证 Codex `priority` service tier。metadata 均值只从 50.48 秒变为 49.84 秒，7/8 低于 60 秒也没有改善，因此 priority 的端到端收益落在波动内，正式 profile 不默认启用它。两批 Recall 的 0.223–0.248 差异同样应视为 live 检索与 agent 路径波动，而不是 priority 的质量增益。

## 当前可作出的产品判断

- Quick 已形成可用的低延时、高于 Perplexity fast 质量的端点；但 60 秒仍是软 SLO。产品需要硬 SLA 时，应使用常驻 Codex session，并在调用层设置总 deadline 和结构化兜底。
- Balanced 是本轮最强的 Pareto 改进：相对旧 Full A，Recall 从 0.4562 提升到 0.4813，同时 metadata 可用时间从约 8:25 降到 4:33；也在完整 bench8 上明显高于 Perplexity medium。
- Quality 仍是当前 skill 的最高质量端点。本次 bench8 的 wall 比 Claude 参考快约
  8%，Recall 接近但略低（0.5604 对 0.5750）；完整 bench20 的 wall 也更短
  （8:33 对 10:43），但 Recall 仍低 0.0703。下一步应优先改善头部排序和减少
  冗余 title probes，同时保留 C1 证明有效的中心实体–关系覆盖。
- 三档目前各自适合不同产品场景，不存在一个档位在质量、速度和消耗上全面支配另外两个。

## 硬 SLA 与降级语义

skill 内部 deadline 只能阻止新的工具批次，不能中断正在生成的一次模型响应。若产品必须在 60 秒内返回，应在服务层补齐：

1. 常驻 session，避免 CLI 冷启动和进程 teardown；
2. 以 55–60 秒为外层硬 deadline；
3. 超时时返回已经落盘的 `metadata.json`，或降级到单次 PaperHub/Search API 候选；
4. 把 `mode`、实际耗时、结果是否降级写入响应元数据。

单次 Search API 可以做到几秒级，但 benchmark8 Recall 只有 0.0667，不应静默伪装成完整 Quick。它只适合作为硬 deadline 下明确标记的 fallback。
