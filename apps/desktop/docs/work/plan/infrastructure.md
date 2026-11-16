# Desktop 设计基础设施整改台账

## Scope / Non-goals

本 Goal 仅整改 design、components/ui、registry/barrel、components/examples、资产文档、规范及门禁。features、shell、components/business 和 primitive 默认只读；混合 styles.css 仅允许有证据的基础入口/声明修改。业务页面迁移不属于本次完成条件。

独立 worktree：`<task-workspace>`。
分支：`codex/desktop-design-infrastructure`；起点：`shushen_release/mvp_v0.2_open_source`，`2745b256e69556a47bd6f28cde1a721dc43a9f52`。
原工作区的未提交改动保持原样；本任务仅复制自身资产/规范/主题预览草稿，不包含并行国际化文档和入口。

## Source of truth

用户 Goal 全文为本次范围与验收要求；设计来源文件 `203335358980331`，page `5:43395`。定位见[公开设计契约](../../design/foundations.md)，组件实况见[资产入口](../../design/assets.md)。历史截图须标注采集日期，不冒充当前节点。

## Current / Required / Gap / Advisory

- **current**：2026-09-10 已读取 Goal、根及 Desktop 约定，核实源码与独立工作区；执行 `make ui-find Q='主按钮 输入框 选择器'`，发现 Button/Input/Select 真实入口。
- **current**：用根工作区 `.env` 的既有凭据显式加载环境，运行 mastergo skill 的 `mastergo_analyze.py`，节点 `5:81200` 返回 Button 组件集及默认/悬停/选中三状态、10 个节点。凭据未打印或复制到 worktree。
- **current**：已完成顶部主题切换、资产生成器、Tailwind/CSS 边界规范、组件资产与设计对齐矩阵，并以源码、真实预览和 Desktop 产物复核。
- **required**：每阶段执行设计取证、基础层实现、确定性门禁、dev:web 与真实 Desktop 消费者验证、自审和台账更新。
- **gap**：独立设计稿未覆盖的 Badge/Tag、Alert、Toast 队列及部分边缘状态仍按语义推导，后续可继续补充证据；不阻塞本次基础设施交付。
- **advisory**：兼容现有 props/导出/事件语义；设计缺少尺寸时优先增补变体，不改变旧尺寸含义迫使页面迁移。

## Ownership / Dependency

| Owner / 文件范围 | 现有消费者与影响 | 兼容策略 | 验证 |
| --- | --- | --- | --- |
| design/*.css | UI 与旧页面共享 token；变化可能全局生效 | 保留旧别名，区分品牌底与前景；不统一业务私有主题 | token 引用、明暗对比度、真实代表页面 |
| components/ui | feature/shell/business 经 barrel 消费 | 保留导出与受控约定；增加必要尺寸/状态 | 组件契约、键盘、状态矩阵、消费者截图 |
| registry/barrel/examples | 中文意图检索与开发预览 | 从源码生成库存，示例完整登记 | reuse/docs/typecheck、真实 dev:web |
| docs/规范/技能/门禁 | 后续 Codex 与人工开发 | 渐进约束本次新增或修改 UI；历史债务不清零、不放宽 baseline | 门禁反例、真实 Codex 调用与产物审查 |

## 正反例

正例：暗色品牌按钮对比度问题在基础 token/组件解决，回归消费者；36px 设计尺寸新增明确变体，页面后续按实际设计选用。

反例：为统一设置页面视觉修改 features，或把整个 workbench.css 视作第三方覆盖；复制其他任务未提交变更进入基础分支。

## Enforced by

已执行：`npm run docs:check`、`npm test`、`npm run typecheck`、`make desktop-test`、`make wiki-check`、`git diff --check`；视觉验证使用真实 dev:web 和 Desktop，不以确定性测试代替产品验收。最新 Desktop 证据见 `/tmp/scholarseed-design-final2-shoot.log` 及 `tmp/test_snapshot/desktop/`。

## Update triggers

每阶段记录设计节点/证据日期、差异、文件、兼容性、测试与截图、未验收项；实际完成才勾选。

- [x] 独立 worktree 与原工作区改动隔离。
- [x] 当前 MasterGo HTTP 结构读取成功。
- [x] 基础设施方案与完整证据映射。
- [x] 主题、优先组件及 Tailwind 基础层整改。
- [x] 资产、规范、渐进门禁同步。
- [x] dev:web 状态矩阵和真实 Desktop 无新增回退证据。
- [x] 实际 Codex 使用规范验证。
- [x] 适用门禁、自审和最终范围审计。

## Stop condition

仅当 Goal 全部基础设施完成条件有当前证据时结束；页面历史迁移另行记录，不阻塞基础设施完成。当前状态：基础设施交付完成，待用户授权合并/推送。

## 后续页面迁移责任

业务页面旧颜色与选择器、workbench 的自有布局、literature 样式、image/editor 外壳、PDF 自有工具栏均留给对应页面 owner。后续开发仅整改新增或修改的相关 UI，不能因触碰文件要求重写整个模块。基础代码合并本身不会自动迁移页面。
