# P0＋P1资产冻结：2026-10-25

**输入已冻结，尚未执行评测。** 本版本固定原有41个稳定业务点：P0 10点、P1 31点；逐点绑定41条主用例，51项必需Check和1项可选Check。共享Check只计一次，不把点数、手工行数、Check数混算。默认P0仍为五方向10点18必需Check，没有调级或扩大范围。

- 源资产提交：`e2567e836e14707ad71477cc9cbeee32a00f5357`。
- [macOS原样预检](macos.json)、[Windows原样预检](windows.json)，各自 `scopeIdentity.state=committed`、资产就绪41/41、资产缺口0、Check分母完整。
- [freeze.json](freeze.json)绑定平台快照摘要、115个源文件摘要、点位/主用例修订、Check及10条未自动纳入的同点变体。快照不可覆盖；后续变更需新版本，旧报告不回填。
- 这不是103条全部手工行或全部客户端场景；相同点的本地技能、同名文件或表达变体不默认连带执行。所选主用例的具体任务使用对应冻结Driver资产，不能在运行中改题。
- 所有判据仍为探索候选，不因资产齐备变成批准PRD/正式覆盖；待审来源及历史未实测/证据不足状态保留。
- 本轮没有启动客户端、登录、安装、检索或发产品模型请求，也没有修改产品逻辑或规则。Windows只是独立资产清单，未实机验收。

## 如何用于下一次评测

指定本版本目录与目标构建/平台，先只读核[平台预检](macos.json)及[配套前提](../../exploratory/p1-assets/README.md)，确认冻结文件摘要和实际现场前提，再申请本轮授权与预算。不能拿原安装/已有账号状态替代专用配置或真实登录检查。

完整P1需要更多真实动作，不沿用P0的7次动作或30分钟；时间、模型费用、必要检索/确认、配置写入、归档恢复、Zotero本机连接与两模型身份须在正式执行前明确。缺账号、可信端点、真实Zotero、权限或可核范围时，相关Check阻塞，其他独立就绪点继续；不边测边补资产、改判据或重试洗绿。

## 逐点清单

| 等级 | 点位/修订 | 冻结主用例 | 目标 | A/B | 必需Check |
| --- | --- | --- | --- | --- | --- |
| P0 | `RES-DOCX-01@1` | `D4-RES-001` | 导入、打开并使用 DOCX 资料回答问题 | mixed | `RES-DOCX` |
| P0 | `RES-XLSX-01@1` | `D4-RES-002` | 导入、打开并使用 XLSX 资料回答问题 | mixed | `RES-XLSX` |
| P0 | `RES-MD-01@1` | `D4-RES-003` | 导入、打开并使用 Markdown 资料回答问题 | mixed | `RES-MD` |
| P0 | `RES-PDF-01@1` | `D4-RES-004` | 导入、打开并使用资料库 PDF 回答问题 | mixed | `RES-PDF` |
| P0 | `LIT-PDF-OPEN-01@1` | `D4-LIT-001` | 打开文献附件 PDF 并阅读可选中文字 | A | `LIT-OPEN`、`LIT-EVIDENCE` |
| P0 | `LIT-PDF-EXPLAIN-01@1` | `D4-LIT-002` | 对文献 PDF 的指定选区执行 AI 解释 | mixed | `LIT-EXPLAIN`、`LIT-EVIDENCE` |
| P0 | `LIT-PDF-TRANSLATE-01@1` | `D4-LIT-003` | 对文献 PDF 的指定选区执行中文翻译 | mixed | `LIT-TRANSLATE`、`LIT-EVIDENCE` |
| P0 | `CHAT-TURN-01@1` | `D4-CHAT-001` | 完成一轮真实模型对话并给出切题回答 | mixed | `CHAT-TURN`、`CHAT-QUALITY`、`CHAT-BOUNDARY` |
| P0 | `DISC-NEW-PAPER-01@1` | `D4-LIT-004` | 通过 AI 对话检索发现可核实的新文献 | mixed | `DISC-ENTRY`、`DISC-NEW`、`DISC-SOURCE`、`DISC-BOUNDARY` |
| P1 | `PROJ-CREATE-01@3` | `D6-PROJ-001` | 新建可进入的项目 | A | `PROJ-CREATE` |
| P1 | `PROJ-SWITCH-01@2` | `D6-PROJ-002` | 切换项目并隔离工作台资料范围 | A | `PROJ-SWITCH-SCOPE` |
| P1 | `RES-COPY-DIR-01@3` | `D4-RES-005` | 复制导入目录并保留层级与文件内容 | A | `RES-COPY-DIR` |
| P1 | `RES-CONFLICT-RENAME-01@4` | `D4-RES-007` | 同名导入时通过重命名保留新旧文件 | A | `RES-CONFLICT-RENAME` |
| P1 | `RES-CONFLICT-REPLACE-01@4` | `D4-RES-008` | 同名导入时版本化替换并追溯旧版 | A | `RES-CONFLICT-REPLACE` |
| P1 | `RES-CHAT-REF-01@4` | `D4-RES-014` | 将已有项目资料作为对话上下文引用 | mixed | `RES-CHAT-REF` |
| P1 | `LIT-IMPORT-PDF-01@3` | `D4-LIT-005` | 导入本地 PDF 为文献条目 | A | `LIT-IMPORT-PDF` |
| P1 | `LIT-JOIN-PROJECT-01@5` | `D4-LIT-011` | 将已有文献条目加入项目 | A | `LIT-JOIN-PROJECT` |
| P1 | `LIT-ADD-ATTACHMENT-01@4` | `D4-LIT-013` | 为已有文献条目添加附件 | A | `LIT-ADD-ATTACHMENT` |
| P1 | `LIT-PDF-DOCUMENT-TRANSLATE-01@3` | `D4-LIT-019` | 对文献 PDF 执行文档逐页翻译 | mixed | `LIT-DOCUMENT-TRANSLATE` |
| P1 | `LIT-PDF-SUMMARY-01@3` | `D4-LIT-020` | 对文献 PDF 生成可追溯 AI 解读 | mixed | `LIT-DOCUMENT-SUMMARY` |
| P1 | `LIT-SEARCH-SAVE-01@4` | `D4-LIT-015` | 将 AI 检索结果中的题录加入文献库 | A | `LIT-SEARCH-SAVE` |
| P1 | `CHAT-NEW-01@3` | `D4-CHAT-002` | 从新对话入口建立独立会话 | A | `CHAT-NEW` |
| P1 | `CHAT-HISTORY-01@3` | `D4-CHAT-003` | 重新打开历史会话并读回消息 | A | `CHAT-HISTORY` |
| P1 | `CHAT-FOLLOWUP-01@3` | `D4-CHAT-006` | 在同会话追问并按要求修订回答 | mixed | `CHAT-REVISION` |
| P1 | `CHAT-STOP-01@4` | `D4-CHAT-007` | 停止正在运行的模型回合 | A | `CHAT-STOP` |
| P1 | `CHAT-MODEL-SWITCH-01@3` | `D4-CHAT-009` | 切换当前会话所用模型 | A | `CHAT-MODEL-SWITCH` |
| P1 | `CHAT-LOCAL-FILE-01@3` | `D4-CHAT-010` | 向当前对话添加本地文件并依据其内容回答 | mixed | `CHAT-LOCAL-FILE` |
| P1 | `MODEL-CONFIG-01@4` | `D6-SET-001` | 配置获准模型服务并在客户端选择 | A | `MODEL-SAVE-SELECT`、`MODEL-KEY-REDACTION` |
| P1 | `ACCOUNT-LOGIN-01@3` | `D6-SET-002` | 登录并在客户端恢复账户状态 | A | `ACCOUNT-LOGIN`、`ACCOUNT-RESTORE` |
| P0 | `SKILL-INVOKE-01@1` | `D4-SKILL-008` | 从技能中心显式选择内置技能并完成获准的只读任务 | mixed | `SKILL-SELECT`、`SKILL-RESULT`、`SKILL-BOUNDARY` |
| P1 | `PROJ-ARCHIVE-01@2` | `D6-PROJ-007` | 归档项目后默认列表隐藏且归档管理保留对象 | A | `PROJ-ARCHIVE` |
| P1 | `PROJ-RESTORE-01@2` | `D6-PROJ-008` | 恢复归档项目后读回原资料与任务 | A | `PROJ-RESTORE` |
| P1 | `CHAT-ARCHIVE-01@2` | `D6-CHAT-002` | 已完成任务归档后历史可读且输入只读 | A | `CHAT-ARCHIVE` |
| P1 | `CHAT-RESTORE-01@2` | `D6-CHAT-003` | 恢复归档任务后原消息保留并可编辑 | A | `CHAT-RESTORE` |
| P1 | `RES-VERSION-RESTORE-01@2` | `D6-RES-001` | 查看并恢复合成资料的指定历史版本 | A | `RES-VERSION-RESTORE` |
| P1 | `LIT-IMPORT-ZOTERO-01@2` | `D6-LIT-003` | 从专用Zotero资料源导入所选题录 | A | `LIT-IMPORT-ZOTERO` |
| P1 | `CHAT-ARTIFACT-01@2` | `D6-CHAT-005` | 真实对话交付可从多个入口打开的文件产物 | mixed | `CHAT-ARTIFACT` |
| P1 | `CHAT-ARTIFACT-IMPORT-01@2` | `D6-CHAT-006` | 将已发布任务产物保存为资料库副本 | A | `CHAT-ARTIFACT-IMPORT` |
| P1 | `CHAT-TASK-REF-01@2` | `D6-CHAT-007` | 新任务引用指定历史任务并据其回答 | B | `CHAT-TASK-REF` |
| P1 | `CHAT-LIT-REF-01@2` | `D6-CHAT-008` | 引用指定文献题录并区分摘要与全文依据 | B | `CHAT-LIT-REF` |
| P1 | `RES-AUTOSAVE-01@2` | `D6-RES-004` | 资料自动保存策略与实际落盘行为一致 | A | `RES-AUTOSAVE` |

## 校验与证据边界

- 资产测试核四档投影、稳定ID、29点修订、P0不漂移、Check分母、分片聚合、候选/历史保留及PDF确定性；不是产品验收。
- 两页合成PDF与独立附件已通过PDF页数/文本检查及逐页渲染人工检查；渲染图片保存在本地忽略目录，不作为客户端打开能力证据。
- [冻结消费测试](../frozen.test.mjs)读回两平台JSON，逐项核快照SHA及Git源文件SHA、41主用例/51必需Check映射。
- 根 `npm run docs:check`通过；Desktop全局 `docs:check`仍报未改动的CSS视觉债务、Listing样式债务及tokens库存过期。本轮未改这些产品文件、未放宽门禁或重写其基线。完整最终校验结果另在交付会话说明。
