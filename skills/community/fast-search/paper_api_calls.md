# Paper API Calls Reference

本文档整理了 agentic-search skill 中所有与论文搜索相关的 API 调用，包括调用格式、参数说明和返回结构。

---

## 目录

1. [PaperHub 搜索 (paperhub.py)](#1-paperhub-搜索-paperhubpy)
   - [keyword - 关键词搜索](#11-keyword---关键词搜索)
   - [semantic - 语义搜索](#12-semantic---语义搜索)
   - [title - 标题查找](#13-title---标题查找)
   - [references - 引用追踪](#14-references---引用追踪)
   - [papers - 批量获取论文详情](#15-papers---批量获取论文详情)
2. [Brave Web Search (brave.py)](#2-brave-web-search-bravepy)
   - [基础搜索](#21-基础搜索)
   - [带 PaperHub 对账的搜索](#22-带-paperhub-对账的搜索)
3. [论文选择 (paper_select.py)](#3-论文选择-paper_selectpy)
4. [论文去重 (dedup.py)](#4-论文去重-deduppy)

---

## 1. PaperHub 搜索 (paperhub.py)

主检索源，覆盖付费期刊论文。以下低层接口需要通过 `PAPERHUB_URL` 配置兼容的 PaperHub 服务；产品默认服务由工具的公开配置决定。

### 1.1 keyword - 关键词搜索

基于 ES `query_string` 的布尔关键词搜索，是主要的论文发现工具。

**调用格式：**

```bash
python3 tools/paperhub.py keyword "<query>" --limit <N>
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | 位置参数 | 是 | 固定为 `keyword` |
| `query_or_ids` | 位置参数 | 是 | ES query_string 语法的搜索词 |
| `--limit` | int | 否 | 返回结果数量上限，默认 20 |
| `--url` | string | 否 | 覆盖 PaperHub 后端 URL |

**query_string 语法要点：**

- 布尔运算符必须大写：`AND` / `OR` / `NOT`
- 多词短语用双引号 `"..."`（不能用单引号）
- 字段限制：`title:(...)` 仅在标题中匹配
- 排除：`-term` 或 `NOT term`
- 分组：`(A OR B) AND C`
- 通配符：`neuro*`
- 默认 OR（匹配任一即命中，按 BM25 排序）
- 建议查询不超过 8 个词，长查询拆成多个短查询

**示例：**

```bash
# 简单关键词搜索
python3 tools/paperhub.py keyword "reinforcement learning search agent" --limit 20

# 标题字段限制 + 布尔运算
python3 tools/paperhub.py keyword 'title:("oxidative stress" AND Alzheimer)'

# 通配符 + 排除
python3 tools/paperhub.py keyword 'title:(transformer AND attention) -video'

# 单复数变体
python3 tools/paperhub.py keyword 'title:(biomarker OR biomarkers) AND (detection OR detections)'
```

**返回结构（JSON）：**

```json
{
  "papers": [
    {
      "paper_id": "257767360",
      "title": "论文标题",
      "authors": ["Author1", "Author2"],
      "year": 2024,
      "venue": "NeurIPS 2024",
      "abstract": "摘要内容",
      "citation_count": 150,
      "doi": "10.xxx/xxx",
      "arxiv_id": "2403.xxxxx",
      "is_open_access": true,
      "source": "paperhub"
    }
  ],
  "count": 20,
  "elapsed": 1.23,
  "query": "reinforcement learning search agent",
  "mode": "keyword"
}
```

---

### 1.2 semantic - 语义搜索

基于语义向量的自然语言搜索。

**调用格式：**

```bash
python3 tools/paperhub.py semantic "<natural language query>" --limit <N>
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | 位置参数 | 是 | 固定为 `semantic` |
| `query_or_ids` | 位置参数 | 是 | 自然语言描述的搜索查询 |
| `--limit` | int | 否 | 返回结果数量上限，默认 20 |
| `--url` | string | 否 | 覆盖 PaperHub 后端 URL |

**示例：**

```bash
python3 tools/paperhub.py semantic "methods for training LLMs to search autonomously" --limit 20
```

**返回结构：** 同 keyword 搜索，`mode` 字段为 `"semantic"`。

> **注意：** SKILL.md 中建议不要使用语义搜索（"Do not use semantic search"），推荐优先使用 keyword 搜索。

---

### 1.3 title - 标题查找

精确标题匹配，是最强的"已知项"检索方式，命中率约 99%。

**调用格式：**

```bash
python3 tools/paperhub.py title "<paper title>" --limit <N>
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | 位置参数 | 是 | 固定为 `title` |
| `query_or_ids` | 位置参数 | 是 | 论文标题或标题的前几个词（前 6 个词即可） |
| `--limit` | int | 否 | 返回结果数量上限，默认 20 |
| `--url` | string | 否 | 覆盖 PaperHub 后端 URL |

**示例：**

```bash
python3 tools/paperhub.py title "Attention Is All You Need"
python3 tools/paperhub.py title "Swin Transformer Hierarchical Vision Shifted Windows" --limit 5
```

**返回结构：** 同 keyword 搜索，`mode` 字段为 `"title"`。

---

### 1.4 references - 引用追踪

获取指定论文的参考文献 ID 列表，用于引用链追踪。

**调用格式：**

```bash
python3 tools/paperhub.py references "<paper_id1>,<paper_id2>,..."
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | 位置参数 | 是 | 固定为 `references` |
| `query_or_ids` | 位置参数 | 是 | 逗号分隔的 paper_id 列表（支持 `unified_` 前缀，会自动去除） |
| `--url` | string | 否 | 覆盖 PaperHub 后端 URL |

**示例：**

```bash
# 使用纯数字 ID
python3 tools/paperhub.py references "257767360,12345"

# 使用搜索结果返回的 ID（unified_ 前缀会自动处理）
python3 tools/paperhub.py references "unified_257767360,unified_12345"
```

**返回结构（JSON）：**

```json
{
  "references": {
    "257767360": ["11111", "22222", "33333"],
    "12345": ["44444", "55555"]
  },
  "count": 2,
  "elapsed": 0.45
}
```

---

### 1.5 papers - 批量获取论文详情

根据 paper_id 批量获取论文完整元数据。

**调用格式：**

```bash
python3 tools/paperhub.py papers "<paper_id1>,<paper_id2>,..."
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | 位置参数 | 是 | 固定为 `papers` |
| `query_or_ids` | 位置参数 | 是 | 逗号分隔的 paper_id 列表 |
| `--url` | string | 否 | 覆盖 PaperHub 后端 URL |

**示例：**

```bash
python3 tools/paperhub.py papers "11111,22222,33333"
```

**返回结构（JSON）：**

```json
{
  "papers": [
    {
      "paper_id": "11111",
      "title": "论文标题",
      "authors": ["Author1"],
      "year": 2023,
      "venue": "ICML 2023",
      "abstract": "摘要",
      "citation_count": 80,
      "doi": "10.xxx/xxx",
      "arxiv_id": "2301.xxxxx",
      "is_open_access": true,
      "source": "paperhub"
    }
  ],
  "count": 3,
  "elapsed": 0.67
}
```

---

## 2. Brave Web Search (brave.py)

可选的第三检索路径，通过 Brave Web API 进行公网搜索，支持将结果与 PaperHub 对账以获取结构化元数据。

**前置条件：** 需要设置环境变量 `BRAVE_API_KEY`。

### 2.1 基础搜索

```bash
python3 tools/brave.py "<query>" --count <N>
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | 位置参数 | 是 | 搜索关键词 |
| `--count` | int | 否 | 返回结果数量，默认 10，最大 20 |

**示例：**

```bash
python3 tools/brave.py "protein structure prediction deep learning 2024" --count 10
```

**返回结构（JSON）：**

```json
{
  "results": [
    {
      "title": "网页标题",
      "url": "https://...",
      "snippet": "摘要片段"
    }
  ],
  "count": 10,
  "query": "protein structure prediction deep learning 2024"
}
```

---

### 2.2 带 PaperHub 对账的搜索

加 `--reconcile` 标志，自动将 Brave 结果与 PaperHub 进行标题匹配，区分能匹配到 PaperHub 结构数据的论文和仅 Brave 能找到的论文。

```bash
python3 tools/brave.py "<query>" --count <N> --reconcile
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | 位置参数 | 是 | 搜索关键词 |
| `--count` | int | 否 | 返回结果数量，默认 10 |
| `--reconcile` | flag | 否 | 启用 PaperHub 对账（较慢但元数据更丰富） |

**示例：**

```bash
python3 tools/brave.py "novel search agent architecture" --count 10 --reconcile
```

**返回结构（JSON）：**

```json
{
  "matched": [
    {
      "paper_id": "257767360",
      "title": "论文标题",
      "authors": ["Author1"],
      "year": 2024,
      "venue": "...",
      "abstract": "...",
      "citation_count": 50,
      "doi": "...",
      "arxiv_id": "...",
      "is_open_access": true,
      "source": "brave+paperhub",
      "brave_url": "https://..."
    }
  ],
  "unmatched": [
    {
      "title": "仅 Brave 找到的标题",
      "url": "https://...",
      "snippet": "摘要",
      "arxiv_id": "2403.xxxxx",
      "source": "brave_only"
    }
  ],
  "total_brave_results": 10,
  "matched_count": 6,
  "query": "novel search agent architecture"
}
```

---

## 3. 论文选择 (paper_select.py)

从论文池中基于相关性评分 + 多样性优化进行集合级选择，输出分层（Tier 1/2/3）结果。

**调用格式：**

```bash
python3 tools/paper_select.py --pool <pool.json> --query "<query>" --output <metadata.json> [--budget 5,15,15] [--concepts "..."]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--pool` | string | 是 | 论文池 JSON 文件路径（数组或 `{papers: [...]}`） |
| `--query` | string | 是 | 用户原始查询，用于相关性评分 |
| `--output` / `-o` | string | 是 | 输出 metadata.json 路径 |
| `--budget` | string | 否 | 三层配额 `tier1,tier2,tier3`，默认 `5,15,15` |
| `--concepts` | string | 否 | 逗号分隔的查询概念词，用于评分；不传则自动从 query 提取 |
| `--diversity-weight` | float | 否 | 多样性惩罚权重，默认 0.3 |

**示例：**

```bash
# 默认配额
python3 tools/paper_select.py --pool pool.json --query "attention mechanism in transformers" --output metadata.json

# 自定义配额和概念词
python3 tools/paper_select.py --pool pool.json --query "..." --output metadata.json --budget 5,15,15 --concepts "attention,transformer,self-attention"
```

**评分策略：**

- **关键词匹配分 (0-10)**：查询概念词在标题+摘要中的命中数
- **引用影响力分 (0-5)**：`log10(citation_count + 1)` 对数缩放
- **时效性加分 (0-1.5)**：2020 年后每年 +0.3
- **标题匹配加分 (0-6)**：概念词出现在标题中每个 +1.5
- **多样性惩罚**：AdaGReS 风格的贪心选择，逐步增加多样性权重

**返回结构（JSON）：**

```json
{
  "search_summary": {
    "query": "original query",
    "pool_size": 156,
    "selected_count": 35,
    "budget": [5, 15, 15],
    "diversity_weight": 0.3
  },
  "papers": [
    {
      "paper_id": "...",
      "title": "...",
      "tier": 1,
      "relevance_score": 12.5,
      ...
    }
  ]
}
```

---

## 4. 论文去重 (dedup.py)

基于归一化标题的论文去重工具，支持文件输入或标准输入。

**调用格式：**

```bash
# 从文件读取
python3 tools/dedup.py --input papers.json

# 从标准输入读取
cat papers.json | python3 tools/dedup.py
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--input` / `-i` | string | 否 | 输入 JSON 文件路径；不指定则从 stdin 读取 |

**示例：**

```bash
python3 tools/dedup.py --input raw_papers.json > deduped.json
```

**返回结构（JSON）：**

```json
{
  "papers": [...],
  "original_count": 50,
  "deduped_count": 42,
  "removed": 8
}
```

**去重规则：**

- 标题归一化：去除非字母数字字符，转小写
- 完全匹配即视为同一篇论文
- 长标题（>20 字符）子串包含且长度比 >0.8 也视为同一篇
- 首次出现的论文优先保留；若后出现的论文有摘要而先出现的没有，则替换

---

## 底层 HTTP API 参考

paperhub.py 实际调用的 PaperHub 后端 HTTP 接口：

### 搜索接口

- **URL**: `{PAPERHUB_URL}/es/search`（需要兼容此接口的服务）
- **Method**: POST
- **Content-Type**: application/json

| 模式 | 请求体 |
|------|--------|
| keyword | `{"query": "<query_string>", "limit": N}` |
| semantic | `{"semantic_query": "<natural language>", "limit": N}` |
| title | `{"title": "<title text>", "limit": N}` |

### 批量获取接口

- **URL**: `{PAPERHUB_URL}/es/mget`（需要兼容此接口的服务）
- **Method**: POST
- **Content-Type**: application/json

| 模式 | 请求体 |
|------|--------|
| references | `{"index": "references", "ids": ["id1", "id2", ...]}` |
| papers | `{"index": "papers", "ids": ["id1", "id2", ...]}` |

---

## 典型工作流中的调用顺序

```
1. 关键词发现搜索
   paperhub.py keyword "..." --limit 20     (多个短查询分别搜索)

2. 标题精确探测
   paperhub.py title "canonical phrase"     (每个关键概念短语)

3. 去重
   dedup.py --input pool.json

4. 引用追踪（每轮重复）
   paperhub.py references "id1,id2,id3"     (从池中选 3-5 篇核心论文)
   paperhub.py papers "ref_id1,ref_id2,..." (获取前 20-30 条参考文献详情)

5. 可选：公网补充
   brave.py "..." --count 10 --reconcile    (Brave 搜索 + PaperHub 对账)

6. 集合级选择
   paper_select.py --pool pool.json --query "..." --output metadata.json
```
