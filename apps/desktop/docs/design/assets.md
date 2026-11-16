# 组件资产与复用指南

## Scope / Non-goals

面向参与 Desktop 页面开发的后端同学：按需求找组件、查看效果、核对接口，再接业务数据。覆盖现有 UI、primitive、business 资产，不把所有导出都当作独立组件，也不承诺所有预览已完成真实产品验收。

## Source of truth

- **[完整组件资产列表](../_generated/components.md)**：从 UI 注册表和 business/primitive 实际导出自动生成，含用途、限制、源码与直接依赖。
- [统一导入出口](../../src/renderer/src/components/ui/index.ts)：UI 可用导出及对应实现文件。
- [运行示例源码](../../src/renderer/src/components/examples/ComponentsPage.tsx)：组件组合、props 和状态示例。
- [Token 列表](../_generated/tokens.md)：主题、字号、间距与层级变量。

## Current / Required / Gap / Advisory

- **current**：资产列表由 `pnpm ops ci check docs desktop --write` 生成；`pnpm ops ci check docs desktop` 检查与源码同步。
- **required**：先找资产，再读真实 props；UI 从 `components/ui` 统一出口导入，页面布局使用 Tailwind CSS，详细要求见[样式规范](foundations.md)。
- **gap**：业务模块可能依赖 StoreProvider、账号、项目、会话和后端 API；列表中的依赖只表示直接源码边，不证明整个运行环境已就绪。部分复杂 UI 仍为 preview-grade，见[交互规范](interaction.md)。
- **advisory**：优先组合已有能力，缺失时向所属组件补充通用变体，避免复制页面私有版本。

## Ownership / Dependency

| 层 | 应如何复用 |
| --- | --- |
| `components/ui` | 按用途选按钮、输入、表格、菜单和反馈；由 props 驱动，不接业务 API。 |
| `components/primitive` | Markdown、附件、浮窗等机制；阅读源码确认环境与输入约定。 |
| `components/business` | 账号、会话、项目、技能等完整业务区域；沿现有调用者组合，不当作脱离上下文的纯 UI。 |
| `features` / `shell` | 接 API 和状态并编排页面；业务数据与操作留在对应 owner。 |

这些是 React renderer 资产，Python 后端通过 API 提供数据；需要开发界面时在 renderer 内复用。

## 从需求到可运行页面

1. 在资产列表搜索中文意图，例如“表单”“搜索选择”“详情抽屉”；命令行也可以在仓库根目录运行 `npm run ui-find Q="表单"`。
2. 启动预览：`pnpm ops dev browser`，打开 [组件示例](http://localhost:5173/?dev=components)。通过左侧组件菜单找示例，顶部切换明暗主题；右侧“查看代码”给出组合方式。
3. 从统一出口跳到实现，确认必填 props、事件参数、受控状态和 Provider。业务示例需要真实 Serve 时启动 `.venv/bin/scholarseed-serve`；出现未配置或登录提示不代表组件 API 不存在。
4. 在自己页面所在目录计算相对导入路径，连接真实数据与 pending/error 状态。用 `rg` 搜索同组件的现有调用方式。
5. 实际打开页面验证明暗主题、长文本、空数据、失败、键盘和窄窗。组件展示不替代业务流程验收。

选型提示：表单选值用 Select，执行操作用 DropdownMenu；短说明用 Tooltip，可交互浮层用 Popover；常驻提示用 Alert，一次性反馈用 Toast；详情侧面板用 Sheet，危险操作确认用 AlertDialog。完整选择和限制以资产表为准。

## 正反例

下面路径适用于 `features/<domain>/` 下的页面；其他目录按实际层级调整。示例 props 由业务 owner 提供，不写假 API：

```tsx
import { Button, Card, Input } from '../../components/ui'

interface NameEditorProps {
  name: string
  saving: boolean
  onNameChange: (value: string) => void
  onSave: () => void
}

export function NameEditor({ name, saving, onNameChange, onSave }: NameEditorProps) {
  return (
    <Card className="grid gap-[var(--vds-space-4)]">
      <Input
        label="名称"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
      />
      <Button loading={saving} disabled={!name.trim()} onClick={onSave}>
        保存
      </Button>
    </Card>
  )
}
```

反例：复制原生 button/input 并自写 CSS；从 UI 内部文件深导入；把 AccountPanel 脱离其环境直接放进新页面；根据资产名称猜测 props。

## Enforced by

`pnpm ops ci check docs desktop` 与 `scripts/ci/__tests__/standards.test.mjs` 检查资产生成一致性；`scripts/ci/__tests__/reuse.test.mjs` 检查 UI 出口/意图/预览覆盖。`pnpm ops ci check types desktop` 检查消费者 API，真实页面按[测试规范](../quality/testing.md)验证。

## Update triggers

增加或删除导出、修改 UI 意图/使用限制后运行 `pnpm ops ci check docs desktop --write`，提交生成的资产变化。业务用途和环境变化同时更新本指南相关示例，不手改生成表。

## Stop condition

找到合适组件、确认 props/依赖、在示例中看过状态后进入页面开发。未找到能力时按 owner 补组件；不以写一份新清单代替源码注册。

## AI 开发入口

组件复用契约由 [components](components.md) 和实际 registry 持有；公开检索工具为
`apps/desktop/scripts/ci/find.mjs`，不依赖内部开发 Skill。
开发 Skill、MasterGo 接线和宿主发现由文档内源仓维护，不随源码分发。
Desktop 文档与复用门禁继续检查实际源码和派生资产；业务页面只在本次开发范围内渐进整改。
