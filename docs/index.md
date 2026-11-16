# 项目知识索引

本页是按任务意图定位当前 Owner、规范和验证入口的地图，不是正文或全库验收声明。
先使用已加载的根 [AGENTS](../AGENTS.md) 与适用局部规则；已有 Skill / Owner 直达链接时
直接读取，不为每项任务遍历本页。跨 Owner 契约变化再追加受影响方；规范与实现冲突时核验原因，
不自动放宽安全要求。

## 按意图与 Owner 定位

本目录维护仓库工程知识与架构契约；面向用户的扩展开发指南和离线页面见
[developer-docs](../developer-docs/README_zh.md)。

| 意图 / Owner | 起点与必要知识 | 源码与验证入口（按改动选取，不代表已执行） |
| --- | --- | --- |
| 仓库开发 CLI | [概要设计](architecture/ops-cli.md)、[现状与迁移台账](architecture/ops-cli-inventory.md)（仍为draft，实施验收未完成） | 源码已提供 `scripts/ops-cli.cjs` 与 `pnpm ops`，台账记录迁移现状；目标无需CLI独立包或编译，统一pre/dev/ci/cd；跨平台进程生命周期、公开投影和全量等价验证仍有缺口 |
| Desktop 页面、组件、交互 | [局部 AGENTS](../apps/desktop/AGENTS.md)、[DESIGN](../apps/desktop/DESIGN.md)、[局部知识地图](../apps/desktop/docs/README.md)；按 renderer / 样式 / 交互选规范，先[组件复用 工程规范](../apps/desktop/docs/design/components.md) | [renderer](../apps/desktop/src/renderer/src/)、[测试与真实验收](../apps/desktop/docs/quality/testing.md)；组件/类型门禁不替代真实 Desktop 流与最终截图 |
| PDFE 工作台、Mock 场景组织与后续功能接入 | [PDFE 概要设计](../apps/desktop/docs/architecture/PDFE.md)、[运行时详细架构](../apps/desktop/docs/architecture/preview.md)、[角色与修改范围](../apps/desktop/docs/work/pdfe.md) | [场景目录](../apps/desktop/preview/catalog.ts)、[开发启动与验证入口](runbooks/development.md)；同一产品 UI、实例隔离、按规模简化导航，Mock 展示不等于真实产品验收 |
| 评测、自动化测试、PDFE 的样本与示例项目数据 | [共享示例设计](architecture/examples.md)、[共享示例入口](../examples/README.md)；原始资料、项目定义、外部依赖和独立判据的职责边界 | 公共基础与文本准备已接线，复用内容、独立运行副本；真实验收及扩展缺口单列，不读取用户空间补样本，不把准备当被测成功 |
| PDF 阅读、拖选、标注与导出 | [文字层与标注几何](features/pdf.md)；加入对话或来源写回再读[选区知识](features/selections.md)，不把旧验收记录当当前规范 | [PDF viewer](../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx)、[几何测试](../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.test.ts)及真实 Desktop；单元测试不能证明跨行拖选和重开视觉结果 |
| L1 接入：文献库／PDF AI 解读、对话和综述复用 | 产品集成说明 (non-public execution/provenance record omitted)；区分 L1 资产接入、本地材料增强与原综述流程改动 | 说明内的模块入口、材料契约和定向验证；已实现不代表全面语义或发布验收通过 |
| Desktop 主进程、IPC、构建、打包 | [局部 AGENTS](../apps/desktop/AGENTS.md)、[边界与 Owner](../apps/desktop/docs/architecture/ownership.md)、[构建指南](runbooks/build.md)；涉及 renderer/Serve 时追加其契约 | [main](../apps/desktop/src/main)、[构建脚本](../apps/desktop/scripts/cd/build.cjs)、[开发启动与交付](runbooks/development.md)；平台、安装包与真实更新验证不能相互替代 |
| 跨仓库与发布边界 | [仓库与知识边界](architecture/repositories.md)、[构建指南](runbooks/build.md#cicd-渠道与发布职责) | 源码仓独立开发；内部发布与证据另行授权，上传不等于发布 |
| Windows 开发启动问题与解决记录 | [Windows 问题收集](runbooks/windows.md)、[开发入口](runbooks/development.md)、[构建指南](runbooks/build.md) | 按工具链、语言模式、缓存/Temp/workspace 权限和主窗口阶段定位；环境恢复不等于业务验收，不放宽安全校验 |
| 跨平台路径、权限、进程与归档 | [根硬门槛](../AGENTS.md#cross-platform-engineering-hard-gate)、[跨平台开发与验收](runbooks/development.md#跨平台开发与验收)；按实际代码 Owner 追加局部契约 | macOS/Windows 行为矩阵、各目标确定性门禁与真实流程；基线红项分别对照，不由单平台代替 |
| Windows 远程机器、ECS 与中英文兼容测试 | [Skill ownership](architecture/skills.md)、[Windows 连接 工程规范](runbooks/windows.md)；清单不保存密码，不代表连接已验证或永久操作授权 | 按当次范围核对主机身份、端口与交互会话；Server 2019/2025 的辅助测试不替代 Windows 10/11 桌面版验收 |
| Serve API、领域行为、HTTP/SSE 与会话 | [局部 AGENTS](../apps/serve/AGENTS.md)、[包 README](../apps/serve/README.md)；先定业务域，事件/取消看 `chat/runtime`；跨域协议、HTTP/SSE 安全、会话/事件生命周期或身份边界变化时再按章节读取[组合与跨域边界](architecture/serve.md)，不为简单领域缺陷加载全文 | [组合根](../apps/serve/service/bootstrap.py)、[业务域](../apps/serve/service)、[会话组合](../apps/serve/service/chat/runtime)、[契约入口](../apps/serve/tests/run_all.py)；重启不在对话中进行，healthz 不证明真实会话与业务回合通过 |
| 产品 Prompt、科研澄清与能力加载 | [产品指令正文](../apps/serve/service/chat/prompts/baseInstructions.md)；区分基础指令、开发者入口、科研指导与产品操作 Skill，不把旧整块同步方案当作现行职责 | [资产读取](../apps/serve/service/chat/active.py)、[会话组合](../apps/serve/service/chat/runtime/composition.py)、[契约入口](../apps/serve/tests/contract_codex_service.py)；固定上游 commit，保留授权边界，新会话与重启后恢复的真实验收不能由文本一致性替代 |
| Serve 数据、项目/用户路径与恢复 | [根持久化约束](../AGENTS.md)、[Serve README](../apps/serve/README.md)、[持久化边界](architecture/persistence.md)；先判断是否随项目迁移，保留用户资产与安全边界 | [产品路径](../apps/serve/service/paths.py)、[项目数据库](../apps/serve/service/persistence/project.py)、[内容边界](../apps/serve/service/content)；按真实域选择契约与创建/读写/恢复、安全拒绝的产品验证，不操作用户数据换取隔离 |
| 复制/关联导入、任务中心与后台进度 | [资源导入边界](features/imports.md)；区分后台权威 job、前端投影、资料树读回与实际终态，不照搬历史阶段或验收声明 | [Resources job](../apps/serve/service/resources/service/jobs.py)、[Desktop 任务源](../apps/desktop/src/renderer/src/features/resources/imports.ts)、[任务展示](../apps/desktop/src/renderer/src/components/business/Tasks.tsx)；取消/恢复、副作用及原生网页浮层分别做真实验证 |
| Runtime 公共 Provider/Session 契约、Gateway | [包 README](../packages/runtime/README.md)、[跨系统职责](architecture/ownership.md)；只有 contract/gateway，不恢复 Harness/转发层 | [contract](../packages/runtime/scholarseed_runtime/contract)、[gateway](../packages/runtime/scholarseed_runtime/gateway)、[Gateway 契约](../tests/contract_runtime_gateway.py)、[Driver 契约](../tests/contract_runtime_driver.py)、[发行边界](../tests/release/contract_package_boundary.py)；公开 ABI 变化核对 Adapter/Serve 消费者并另做真实产品验收 |
| 厂商执行、原生协议、认证发现 | Codex：[局部 AGENTS](../packages/adapters/codex/AGENTS.md)、[README](../packages/adapters/codex/README.md)；DSH：[README](../packages/adapters/dsh/README.md) 标明未接通，不假定可用 | [Codex 源码](../packages/adapters/codex/scholarseed_codex)、[Adapter 契约](../tests/contract_codex_adapter.py)、[真实 App Server 隔离契约](../tests/contract_codex_isolation.py)；资源准入/持久化/官方恢复与真实 Electron 验收按 README 承接，不以版本探测代替 |
| Trace 记录、存储、查询 | [独立包指南](../packages/damoatrace/AGENTS.md)；Trace 不依赖 Runtime、Adapter 或 Serve | [Trace 包](../packages/damoatrace)、[产品路径边界](../AGENTS.md)；按该包指南选验证，产品组合问题追加 Serve Owner |
| 开发 Skill 与产品技能 | [归属边界](architecture/skills.md)；开发工作流仅在内源仓维护，不是公开源码前提 | [产品源](../skills/community)、[registry](../skills/registry.json)、[制品核验](runbooks/build.md#产品-skill-冻结与制品核验)；产品验收仍走真实 Serve/Electron 流 |
| 评测技能中心中的 Skill | [Skill ownership](architecture/skills.md)、[宿主入口](../apps/desktop/docs/architecture/evaluation.md) | 指定项目、新对话、`/`选技能、预设Query真实执行与对话／文件回收；首版不做LLM评分，不代替页面发布快评 |
| 知识归属、回写、重复或过期入口 | [唯一治理正文](architecture/knowledge.md)、[治理 工程规范](architecture/knowledge.md)；默认只读，整改逐项确认写权，先承接有效理由/风险再处理旧入口 | [显式文件结构检查](../scripts/ci/docs/structure-check.mjs)、[当前知识门禁](../scripts/ci/docs/check.py)（`pnpm ops ci check docs workspace`）；按[实际检查范围](architecture/knowledge.md#当前检查范围)说明清单与遗漏，结构通过不替代语义或发现路径核验 |
| 独立知识效果评测 / 失败归因 | 独立评测 Skill 尚未交付，不把未复核的本地候选作为入口；选定失败再用 [Engineering guide](architecture/knowledge.md) | 冻结标准与原始记录在控制侧授权目录；治理报告不是评分答案。产品评测另用 [Engineering guide](../apps/desktop/docs/architecture/evaluation.md)，不冒称 Codex 知识评测 |

## 读取与维护边界

症状已明确、需要定位细粒度规则时，再查[诊断与专题路由](runbooks/triage.md)；它只提供
问题到现有 Owner 正文的入口，不复制机制，也不是默认必读页。

本索引维护 Owner 与读取条件，不复制机制、命令长流程或单次验收结果。已确认正文后停止扩展，
出现新问题再有界追加。知识归属、更新原则与治理检查范围见[知识规范](architecture/knowledge.md)。
根 `docs:check` 的实际发现清单和排除以[检查契约](architecture/knowledge.md#当前检查范围)为准；
结构检查不证明正文语义、宿主行为或真实产品验收。

- 没有匹配的需求或评测文档时明确缺口，经授权由负责 Owner 补充；源码存在不等于产品目标或已验收，不预建空领域页。
- 本索引不证明历史提案/研究/日报迁移、全部领域语义核验或全库链接已完成。显式文件结构检查与 Desktop 局部门禁各有范围，不替代语义、真实宿主或迁移验收。
