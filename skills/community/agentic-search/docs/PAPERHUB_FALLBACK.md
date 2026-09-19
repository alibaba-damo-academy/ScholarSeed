# PaperHub 不可用时的降级策略

## 目标

登录用户继续使用原 Quick、Balanced 或 Quality 检索图；未注入 PaperHub 凭据或
PaperHub 整体不可用时，不要求用户提供 token，改用已安装的 `$web-search` skill 返回可验证
的论文结果。降级不改变有凭据路径的查询、引用扩展、排序和选稿。

## 旧版与当前策略

| 场景 | 旧版 | 当前版本 |
|---|---|---|
| 缺少 key | PaperHub 操作失败，无法稳定生成 metadata | 不访问 PaperHub，直接 Web-only |
| 401/403 | 检索失败 | 首个鉴权错误后停止 PaperHub 并降级 |
| 全部请求遇到传输错误或 500/502/503/504 | 有界重试、写失败 round，随后流程失败 | 有界重试、记录故障事件，随后 Web-only |
| 部分 PaperHub 请求成功 | 保留成功结果 | 行为不变，不触发整体降级 |
| 最终产物 | 故障时通常没有 metadata | `metadata.json` + `fallback_event.json` |

429、单个操作超时、非法响应和业务参数错误目前不自动降级，以免把限流或代码/配置问题
伪装成正常搜索结果。`$web-search` 的所有允许 provider 也不可用或没有可验证论文时明确失败。

## 数量契约

| 档位 | Web-only 请求目标 | 检索批次上限 |
|---|---:|---:|
| Quick | 20 | 已有批次；少于 5 篇时最多再补 1 批 |
| Balanced | 40 | 最多 2 个 Web 批次 |
| Quality | 40 | 最多 4 个 gap-driven Web 批次 |

目标数量不是保证值。候选必须具有论文直达 URL、DOI 或 arXiv ID，并经过年份过滤和
去重；不足时不以普通网页或低相关结果补齐。只有达到请求目标时 `result_status` 才是
`complete`，否则为 `partial`。

截至当前，相同两个 query 的四次无凭据真实 Quick 冒烟返回 5–8 篇，两次成功的 401
降级分别返回 4 篇和 6 篇；同两个 query 的 Quality 无凭据实测分别返回 40/40 和
38/40 篇。样本包含重复 query，只用于验证链路、候选漏斗和随机性，不代表稳定数量分布
或 benchmark 质量。产品接入前需要明确：接受可变数量、增加检索批次并承担额外延迟，
或采用“首屏少量结果 + 后台异步扩展”。Balanced 的降级数量和各档位质量指标仍需通过
正式 benchmark 单独评测，不能从这些链路测试外推。

## 故障记录

- `RESULT_DIR/session/fallback_event.json`：Runner 内检测到故障时先写，记录错误码、
  计划/执行操作数、重试数、PaperHub wall time 和逐操作失败摘要。
- `RESULT_DIR/fallback_event.json`：Web-only 完成前写入的合并记录，追加公网查询数、收到
  的候选数、通过校验数、实际选中数、请求目标数和最终状态。
- `RESULT_DIR/metadata.json`：通过 `degraded`、`source_mode`、`source_status`、
  `limitations` 和 `fallback_event_file` 向下游暴露降级语义。

错误文本中的常见密钥形态会替换为 `[REDACTED]`。事件文件不记录请求头、Bearer token
或环境变量值。

## 产品凭据生命周期

Codex session 在启动时继承 `SCHOLARSEED_API_KEY`。产品应在登录时注入 key，退出登录后
销毁对应 session/Worker 并启动不含 key 的新进程，避免旧进程继续持有凭据。
