# 技能中心与显式调用：探索性业务评测

方向：`SKILL-01`；关联点：`SKILL-INVOKE-01`。目标是从真实技能中心查看内置技能说明，在真实 Composer 中显式选择稳定 ID 为 `design-research-validation` 的技能，并完成一轮仅在对话中交付的验证方案。此场景不改写 `SKILL-BROWSE-01` 的稳定身份、P3 优先级或仅浏览的原有含义。

本次用户明确确认四域核心探索目标及方向维护，不等于已批准的正式 PRD/Check。本场景及 `baseline.json` 均为 provisional 探索资产，不是实测通过记录、不计发布覆盖，也不证明 Windows 产品验收。目录点位、方向行修订和默认范围由各自真源维护，不能因本目录存在就推定已联动完成。

沿用 [场景库格式](../../README.md) 的三件套；`cmd.jsonl` 只有 `status`，不会自动浏览、选择技能或发送消息。真实 Driver 按 [公开任务](driver.md) 和实时观察手工操作，不新增 runner；[候选判据](judge.md) 仅供隔离的独立 Judge 与人工复核，不能交给 Driver 或产品。`checks.json` 的三项必需 Check 依次为 A、B、A，均只映射新点 `SKILL-INVOKE-01`。

## 来源与边界

- [产品能力目录](../../../../serve/service/capabilities/catalog.json) 声明目标技能出现在 conversation/settings surface，并要求产品登录；这不是某次安装包已登录、active 或可调用的证据。
- [实际技能正文](../../../../../skills/community/design-research-validation/SKILL.md) 要求只交付验证方案、不生成或执行实验代码；直接输入的主张跳过材料预检，已有材料足够时跳过检索，对话是主要交付物。场景的禁止检索、下载、写文件和实验边界来自公开用户任务，不从工具可用性反推授权。
- [技能就绪语义](../../../src/renderer/src/skill.ts) 区分 enabled、active、登录与依赖状态；中心开关选中不单独证明可调用。
- [Composer](../../../src/renderer/src/components/business/Composer.tsx) 以 `type=skill`、稳定 `id`、实际 `path` 和 `version` 形成引用并检查可调用性；[SkillRefs](../../../src/renderer/src/components/business/SkillRefs.tsx) 显示引用。源码只解释数据语义，不能替代真实选择器、请求及执行身份的观察。
- [Turn 接入](../../../../serve/service/chat/service/turns.py) 核验技能 name/path/version 与当前执行库存；需要本轮真实请求及执行记录关联，不能用消息中提及技能名或正确答复推定调用。

本次现场已观察到技能中心的“系统预置”分组、目标条目及详情入口；未来运行仍须重新观察当前构建，未观察到的选择器入口不编造 testid、不通过内部 dispatch 补齐。只浏览或只出现引用标签而未发送，不算技能执行；入口不可用时保留执行与采证缺口，不改写任务或预期。

## 执行与证据

运行前冻结本次方向 ID/行修订、点位修订、场景与判据版本、构建/平台、实际模型、隔离 Home/profile/workspace、账号态及预算。本轮只允许一条产品用户消息；模型就绪、目标技能 active 且可调用，以及本次模型操作授权都必须现场确认。未来运行单独核权限模式；仅在该轮明确授权时才可通过真实 UI 切换该隔离会话为“请求批准”，不改变产品默认规则、不自动批准未知高风险操作。

按 [评测执行入口](../../../../../.agents/skills/llm-evaluation/SKILL.md#batch-与-report) 在首个必需业务动作前记录 T0；中心浏览、详情查看、技能选择、请求、等待、取证及独立评审均纳入本轮适用窗口。到界停止新调用，不能缩小必需 Check 分母或另发消息重试到绿。

Observer 保存条目/详情、真实 selected reference、原始用户请求、实际请求与执行技能身份、产品 `session_id`/turn、动作 seq、完整终态答复、同回合工具/任务记录、可见产物及已打开检查的截图。必要运行因果只按 [Trace 入口](../../../../../.agents/skills/evidence-trace/SKILL.md) 取证；不读取供应商私有会话库或手工解析 JSONL 代替。证据保存在本轮忽略目录，不写回场景或 baseline；缺必要读回时记缺口，不以静态关键字、选择标签、正确回答或健康状态证明完成与边界。


## 第三档输入准备

任务见[driver.md](driver.md)，判据见[judge.md](judge.md)，映射见[checks.json](checks.json)。复用[P2合成输入与前提](../p2-assets/README.md)；必须先物化、校验、冻结，执行只读该版本。现场授权/账号/隔离/策略语义不足如实阻塞，不等于产品失败。Windows与macOS各自验证，不由资产就绪宣称实机通过。
