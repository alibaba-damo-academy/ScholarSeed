# Desktop 设计规范

这里是 `apps/desktop` 局部架构与设计规则的唯一权威。根 [知识索引](../../../docs/index.md)与[职责正文](../../../docs/architecture/ownership.md)维护跨系统边界和到本目录的路由；组件数量、token 清单、债务统计等动态事实由源码生成，禁止复制到人工规范。

日常 UI 开发先读 [DESIGN.md](../DESIGN.md)，按页面和任务定位下列详细规范。

先从[组件资产与复用指南](design/assets.md)查用法，或直接搜索[完整资产列表](_generated/components.md)。

## 路由

| 任务 | 必读规范 |
| --- | --- |
| MasterGo设计稿、逐稿布局/视觉与实现追踪 | [设计证据](design/mastergo.md)、[公开设计契约](design/foundations.md) |
| 国际化、多语言文案、locale 与语言切换 | [概要设计](architecture/i18n.md)、[接入规范](architecture/localization.md)、[验证规范](quality/testing.md)；历史计划不替代当前源码与本次验收证据 |
| renderer feature、shell、状态与组合 | [renderer](architecture/renderer.md)、[ownership](architecture/ownership.md) |
| PDFE 工作台设计理念、场景组织、Mock 数据及后续功能接入 | [PDFE 概要设计](architecture/PDFE.md)、[运行时详细架构](architecture/preview.md)、[后端契约](work/preview-contracts.md)；Electron 是展示宿主，浏览器/headless 用于测试，完整功能与原生验收仍有缺口 |
| PDFE 工作台的产品、设计、前端角色知识与 Agent 修改范围 | [角色与范围](work/pdfe.md)；角色是任务视角，不是账号权限或独立产品代码 |
| 评测、自动化测试与 PDFE 的共享样本、项目空间及外部依赖 | [共享示例设计](../../../docs/architecture/examples.md)、[共享示例入口](../../../examples/README.md)；公共基础与文本准备已接线，运行副本/判据隔离，真实验收与扩展缺口分别报告 |
| 颜色、间距、字体、层级与动效 | [foundations](design/foundations.md) |
| 选组件、新增组件、复用门禁 | [components](design/components.md) |
| Dialog、Popover、键盘、焦点与反馈 | [interaction](design/interaction.md) |
| Vibe Coding 页面组织与统一布局契约 | [vibe-coding](design/vibe-coding.md) |
| 自动化测试（负责人 A：逻辑单元 / API 接口 / PDFE UI） | [验收规范](quality/testing.md)、[测试架构](architecture/testing-strategy.md)、库存盘点与实施计划 (non-public execution/provenance record omitted)；程序驱动/断言，UI 状态组合复用 PDFE Mock API，保留原生专项和迁移前既有 E2E 门禁 |
| LLM 评测（负责人 B：真实任务链路 / 语义评审） | [LLM 评测架构](architecture/evaluation.md)；真实操作、独立评审与程序事实核验配合；现有页面快评不等于全部模型任务专项，权限与预算不自动扩大 |
| 页面快速评审基线 | [评测资产](../eval-scenarios/README.md)；按页面稳定需求编号关联证据，自动快评与人工专项分开 |
| 开发启动、attach、初始化 Home 与会话验收前提 | [开发启动契约](../../../docs/runbooks/development.md#工具链与支持入口)、[初始化前提](../../../docs/runbooks/development.md#初始化-home-与-harness-前提)；按实际入口核对 argv、模型授权与证据，不由 healthz 或场景截图推定业务通过 |
| main、preload、IPC 与原生宿主边界 | [ownership](architecture/ownership.md)、[testing](quality/testing.md)；按实际宿主核对窄桥与消费者，不把主窗口 preload 当作所有宿主唯一桥 |
| 安装包、静态依赖闭包与构建结果 | [构建指南](../../../docs/runbooks/build.md)、[testing](quality/testing.md)；干净提交上的真实 package:check 不由普通 build 或 closure 单测替代，平台结果分别取证 |

产品操作：[内置浏览器与 Playwright CDP](browser.md)；开发必读：[原生网页与产品浮层的设计约束](browser.md#原生网页与产品浮层开发设计约束)，说明 CSS 层级限制、提示生命周期、原生鼠标命中取舍与回归路径。

## 状态词与强度

- `current`：源码已经具备并有锚点的事实。
- `required`：新改动必须达到的规范；用 MUST 表示硬约束。
- `gap`：当前实现明确未达到目标，不能被描述为已有能力。
- `advisory`：推荐方向；用 SHOULD/MAY 表示，不能冒充门禁。

## 派生库存

- [组件库存](_generated/components.md)
- [Token 库存](_generated/tokens.md)
- [债务库存](_generated/debt.md)

`pnpm ops ci check docs desktop --write` 只从源码更新它们；`pnpm ops ci check docs desktop` 校验入口同步、必备章节、链接、生成内容、UI import/依赖边界和样式棘轮。生成命令不会改 baseline；baseline 变化必须单独审查且只能收紧。`registry.json` 是本地文档契约，不复刻根 Wiki frontmatter。

## 更新原则

`architecture/` 只放架构设计文档；执行计划统一放在 `work/plan/`，通过链接引用对应架构设计，不在计划中另立总体方案。

人工规范只写长期不变量、所有权、决策理由与门禁。动态清单只进 `_generated/`。修改规则时同步修改对应门禁；修改源码动态事实时重生成库存。生成文件开头均带来源与勿手改标记。

## 设计文档与证据归档

`DESIGN.md` 维护视觉方向摘要、页面索引和读取流程；本目录维护详细规则与逐稿分析，数值不在两处重复定义。MasterGo 操作参数放在[工具说明](design/tooling.md)，仅取数或编辑画布时读取。

长期规范、逐稿报告、设计目录和维护台账随 Git 提交；原始节点快照保留精确属性和缺失证据的依据。历史执行、审查与检查记录放入日期归档，不作为最新开发状态。机器本地截图和临时日志不作为共享依赖，重新获取方式见台账 (non-public execution/provenance record omitted)。
