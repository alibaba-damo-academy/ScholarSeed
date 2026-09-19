# LLM 评测场景（eval-scenarios）

对照**文档化需求基线**系统性验证 LLM 对话行为：工具调用、任务完成、上下文保持、
安全边界。评测不是随意聊天——每个场景都有明确的期望指标（baseline），online run
采集真实指标并与 baseline 做结构化对比。

设计权威：[`docs/architecture/testing-strategy.md`](../docs/architecture/testing-strategy.md)
「LLM 评测体系」一节。运行 harness：`scholarseed-desktop --say / --drive / --shoot`
（真实 renderer + 真实 backend + 真实 LLM，见 `src/main/drive.ts` 头部指令参考）。

## 目录结构

```
eval-scenarios/
├── README.md          # 本文件：评测总纲 + 格式规范
├── regression/        # 日常回归场景（入库；offline replay 可跑，零 token）
│   ├── health-check/      # Smoke：单轮最小健康检查
│   └── single-turn-qa/    # 单轮问答 + 一次文件读取工具调用
├── release/           # 版本发布场景（需真实 LLM online run；可选入库）
└── fixtures/          # 评测专用测试数据（大文件走 contentFrom 引用）
```

每个场景目录固定三个文件：

| 文件 | 角色 |
|---|---|
| `scenario.json` | 场景描述（declarative descriptor）：项目文件树、配置、auth、期望 |
| `cmd.jsonl` | drive 指令序列：一行一个 JSON op（`say/wait/status/text/shot/quit` 等） |
| `baseline.json` | 期望输出基线：结构化指标 + 合理区间 |

运行产物（`ack.jsonl`、`shots/`、录制数据）**不写回场景目录**：runner 先把场景
复制到运行目录（如 `tmp/eval/<scenario>/` 或 gitignore 的 `eval-recordings/`），
物化 `project.files` 到 workspace（`SCHOLARSEED_DEFAULT_WORKSPACE` 指向它），再对
副本执行 `--drive`。入库的场景目录保持只读、可重复。

## scenario.json 格式

```jsonc
{
  "id": "single-turn-qa",            // 与目录名一致，全局唯一
  "project": {                        // 可选；health-check 类场景可省略
    "name": "Single Turn QA",
    "files": [
      { "path": "main.py", "content": "..." },          // 内联小文件
      { "path": "big.pdf", "contentFrom": "fixtures/..." } // 引用外部数据
    ]
  },
  "config": { "model_name": "qwen3.8-max", "language": "zh" },
  "auth": "none",                     // "none" | "logged-in" | "subscription"
  "drive": "cmd.jsonl",               // 相对场景目录
  "expected": {                       // 人读的期望摘要；机器对比以 baseline.json 为准
    "toolCallsIncludes": ["read_file"],
    "minTurns": 1,
    "maxTurns": 3
  }
}
```

## baseline.json 格式

非确定性指标一律用**区间（min/max）或包含关系**，不做精确字符串匹配：

```jsonc
{
  "scenarioId": "single-turn-qa",
  "version": "2026-09-20",            // 录制/修订日期
  "model": "qwen3.8-max",             // 录制时的模型；切模型必须重录
  "metrics": {
    "taskCompleted": true,                          // boolean，精确
    "turnCount": { "min": 1, "max": 3 },            // 区间
    "toolCalls": [],                                // 精确序列（可为空）
    "toolCallsIncludes": ["read_file"],             // 子集断言（序列不稳定时）
    "responseContains": ["HEALTH_OK"],              // 关键片段包含
    "responseNotContains": ["无法完成", "I cannot"]  // 失败话术不包含
  },
  "traceDigest": {                    // 可选；来自 DamoATrace 的 token/span 摘要
    "totalTokens": { "min": 2000, "max": 8000 },
    "toolSpans": 3,
    "errorSpans": 0
  }
}
```

当前入库的两个 regression baseline 是**手写期望值（provisional）**：对比工具
（`scripts/eval/`）与 offline replay 尚未实现，首次 online run 后必须用真实采集
指标复核并重新录制。

## 维护规则

- Baseline 变更 **MUST** 随代码一起提交，MR 中可见 diff；不允许只改代码不改基线。
- 模型切换时 **MUST** 重新录制全部 regression baseline（`model` 字段随之更新）。
- Prompt / system message 变更时 **MUST** 重新录制受影响的 baseline。
- 每次 online run 成功后用实际指标更新 baseline（区间放宽必须给出偏离原因）。
- regression/ 入库并保持精简；release/ 大场景与录制数据（`eval-recordings/`）
  gitignore，只入库其 baseline。
- 新增场景走 `desktop-eval` skill（`.agents/skills/desktop-eval/SKILL.md`）的
  create 流程，保证三件套齐全、命名一致。
