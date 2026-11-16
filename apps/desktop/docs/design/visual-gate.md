# 新增视觉值门禁

## Scope / Non-goals

约束 renderer 新增的固定 spacing、字体、圆角、阴影、尺寸和 z-index；不判断审美、设计稿像素还原或动态用户几何。

## Source of truth

`src/renderer/src/design/*.css` 是 token 真源，`scripts/ci/visual.mjs` 是 AST 规则真源。
审计起点固定为提案记录的 Git revision；CI 必须取得该对象，不能把提交后的 HEAD 当作新基准。

## Current / Required / Gap / Advisory

- **current**：门禁用固定审计起点和 AST identity 比较 worktree/index。
- **current**：z-index 同时拒绝裸数字 class、CSS 声明和 style 对象；`design/zindex.css` 中的命名 token 是唯一数值来源。
- **current**：门禁还会解析变更文件引用的每个 `--vds-z-*` 名称，拒绝未定义 token，避免拼写错误在运行时静默回退为 `auto`。
- **current**：`components/ui` 另有零历史额度检查，任何非 token 层级都会直接失败；业务存量仍由固定审计起点的棘轮管理。
- **required**：页面新增视觉值必须使用 `--vds-*` 或组件 props；结构性 `0/full/auto`（z-index 的 0 仍必须用 token）和运行时几何保留。检查同时覆盖 className、style 对象、命名 class、局部常量、条件/模板表达式及简写属性。
- **gap**：动态 class、跨模块别名、函数计算的样式和运行时级联不能由静态扫描完整证明。
- **advisory**：每个例外都要在评审记录来源和真实截图证据。

## Ownership / Dependency

门禁属于 Desktop standards；design 定义 token，UI 组件消费 token，页面不定义主题。

## 正反例

`gap-[var(--vds-layout-section-gap)]`、`rounded-[var(--vds-radius-4)]` 与 `z-[var(--vds-z-dialog)]` 是正例；`gap-4`、`z-[97]`、`style={{ zIndex: 450 }}` 是新增代码反例。

## Enforced by

`standards.mjs` 调用 `visual.mjs`，`visual.test.mjs` 覆盖变体、任意属性、owner 迁移、复制、index/worktree 双面审计、动态几何和层级 token 归属。

## Update triggers

视觉 token、允许的结构性值、审计起点或扫描语法变化时更新本文和测试。

## Stop condition

`pnpm ops ci check docs desktop` 和 `pnpm ops ci test --scope desktop` 通过，并且真实 Desktop/browser 截图已阅读后，才可记录该页面完成；若历史基线已失败，必须附相同基线对比，不能把新增相关检查伪装成全绿。
