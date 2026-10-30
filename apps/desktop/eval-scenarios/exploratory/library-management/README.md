# 资料库管理：P1人工执行资产

探索方向 `RES-MGMT-01`，只补原有稳定点，不增加默认P0或正式覆盖。任务与候选判据分别见[Driver](driver.md)、[Judge](judge.md)，映射见[checks.json](checks.json)。

准备、可变参数、资料及授权门禁统一见[配套资产](../p1-assets/README.md)。`scenario.json`只是描述，`cmd.jsonl`仅状态探针；没有自动执行器。必须由获准Driver经desktop-control真实UI逐点执行；资料物化和账号/模型前提在正式执行前完成与冻结。准备业务状态的创建/导入/模型请求若属于必测动作，仍在执行窗口计时，不能预做后冒称本轮实测。

| 稳定业务点 | Check | 类型 | 现有主用例 |
| --- | --- | --- | --- |
| RES-COPY-DIR-01 | RES-COPY-DIR | A | D4-RES-005 |
| RES-CONFLICT-RENAME-01 | RES-CONFLICT-RENAME | A | D4-RES-007 |
| RES-CONFLICT-REPLACE-01 | RES-CONFLICT-REPLACE | A | D4-RES-008 |
| RES-CHAT-REF-01 | RES-CHAT-REF | mixed | D4-RES-014 |
| RES-VERSION-RESTORE-01 | RES-VERSION-RESTORE | A | D6-RES-001 |
| RES-AUTOSAVE-01 | RES-AUTOSAVE | A | D6-RES-004 |

不默认连带执行更高级变体。按冻结清单分别记录前提、结果、独立Check状态和点击原图；缺一个点不跳过其他独立点。资产存在不等于已执行、已批准需求、环境就绪或Windows验收；历史观察及其缺口保持不变。


## 第三档输入准备

任务见[driver.md](driver.md)，判据见[judge.md](judge.md)，映射见[checks.json](checks.json)。复用[P2合成输入与前提](../p2-assets/README.md)；必须先物化、校验、冻结，执行只读该版本。现场授权/账号/隔离/策略语义不足如实阻塞，不等于产品失败。Windows与macOS各自验证，不由资产就绪宣称实机通过。
