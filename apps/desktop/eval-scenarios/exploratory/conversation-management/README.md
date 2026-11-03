# 会话管理与交付：P1人工执行资产

探索方向 `CHAT-FLOW-01`，只补原有稳定点，不增加默认P0或正式覆盖。任务与候选判据分别见[Driver](driver.md)、[Judge](judge.md)，映射见[checks.json](checks.json)。

准备、可变参数、资料及授权门禁统一见[配套资产](../p1-assets/README.md)。`scenario.json`只是描述，`cmd.jsonl`仅状态探针；没有自动执行器。必须由获准Driver经desktop-control真实UI逐点执行；资料物化和账号/模型前提在正式执行前完成与冻结。准备业务状态的创建/导入/模型请求若属于必测动作，仍在执行窗口计时，不能预做后冒称本轮实测。

| 稳定业务点 | Check | 类型 | 现有主用例 |
| --- | --- | --- | --- |
| CHAT-NEW-01 | CHAT-NEW | A | D4-CHAT-002 |
| CHAT-HISTORY-01 | CHAT-HISTORY | A | D4-CHAT-003 |
| CHAT-FOLLOWUP-01 | CHAT-REVISION | mixed | D4-CHAT-006 |
| CHAT-STOP-01 | CHAT-STOP | A | D4-CHAT-007 |
| CHAT-MODEL-SWITCH-01 | CHAT-MODEL-SWITCH | A | D4-CHAT-009 |
| CHAT-LOCAL-FILE-01 | CHAT-LOCAL-FILE | mixed | D4-CHAT-010 |
| CHAT-ARCHIVE-01 | CHAT-ARCHIVE | A | D6-CHAT-002 |
| CHAT-RESTORE-01 | CHAT-RESTORE | A | D6-CHAT-003 |
| CHAT-ARTIFACT-01 | CHAT-ARTIFACT | mixed | D6-CHAT-005 |
| CHAT-ARTIFACT-IMPORT-01 | CHAT-ARTIFACT-IMPORT | A | D6-CHAT-006 |
| CHAT-TASK-REF-01 | CHAT-TASK-REF | B | D6-CHAT-007 |
| CHAT-LIT-REF-01 | CHAT-LIT-REF | B | D6-CHAT-008 |

不默认连带执行更高级变体。按冻结清单分别记录前提、结果、独立Check状态和点击原图；缺一个点不跳过其他独立点。资产存在不等于已执行、已批准需求、环境就绪或Windows验收；历史观察及其缺口保持不变。


## 第三档输入准备

任务见[driver.md](driver.md)，判据见[judge.md](judge.md)，映射见[checks.json](checks.json)。复用[P2合成输入与前提](../p2-assets/README.md)；必须先物化、校验、冻结，执行只读该版本。现场授权/账号/隔离/策略语义不足如实阻塞，不等于产品失败。Windows与macOS各自验证，不由资产就绪宣称实机通过。
