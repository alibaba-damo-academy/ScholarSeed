# Veda UI 实现说明

本目录只保存组件实现附近的说明。组件选择、所有权、token 与交互规则的唯一权威位于
[`components.md`](../../../../../docs/design/components.md)、
[`foundations.md`](../../../../../docs/design/foundations.md) 和
[`interaction.md`](../../../../../docs/design/interaction.md)。

组件与 export 的完整动态清单由 `registry.ts` 生成到
[`docs/_generated/components.md`](../../../../../docs/_generated/components.md)，不要在本文手写镜像。

## 实现契约

- `index.ts` 是消费域唯一出口；`registry.ts` 是 family、意图、替代项和反模式的机器真源。
- 新 family 同时提供实现、样式、barrel export、registry 元数据、`ComponentsPage.tsx` 预览和测试。
- 本层无业务语义，不读 API/store，不依赖 app、shell、feature 或 business component。
- 样式使用 `design/` 的 `--vds-*` token；图标使用共享 Iconfont。
- `FormField`、`CopyButton`、`Pagination`、`LoadingOverlay`、`EmptyState`、`Table` 等是呈现原子，不持有业务数据、分页请求或全局业务状态。

`AlertDescription` keeps the default two-line summary. Pass `truncate={false}`
for complete instructions that must remain readable, such as recovery choices.

`FormField` is intentionally a presentational field structure. It provides
label, description, and message ids to `FormControl`, but owns no validation or
form-library state.

## 复杂交互成熟度

复杂交互按具体 family、调用组合与宿主核验，不以统一的 preview 标签推断全部能力缺失
或已经达到成熟 primitive 的完整保证。当前 `DialogContent` 使用 `useFocusScope`：
modal 时管理焦点范围与 Tab 循环，关闭时在满足恢复条件且目标仍连接的情况下恢复焦点；
`DialogPortal` 显式提供到 `document.body` 的 portal，调用方是否使用仍须核对。
Focus scopes use the owning document's live window for DOM checks. After that window
is closed or the document loses its window, scope membership is false and cleanup
still releases observers/listeners, but does not restore focus into the retired document.
焦点范围使用所属文档的有效窗口进行 DOM 判断；窗口关闭或文档失去窗口后，范围判断返回
false，清理仍释放 observer 和监听器，但不再向失效文档恢复焦点。
这不证明所有 dialog/menu/tooltip family 都有相同的 scroll lock、碰撞定位、嵌套菜单、
typeahead 或全局 Escape 仲裁。新增保证先由设计系统 owner 评估现有能力并扩展，
保持公共 family API，补适用 DOM 与真实 Electron 验证，不在 feature 复制替代实现。

DOM portal 和 CSS 层级不能越过原生 `WebContentsView` 的窗口合成边界；有内置网页时，
另按 [浏览器宿主约束](../../../../../docs/browser.md)选择已验证的呈现机制，
不能用 renderer-only 浮层测试证明原生网页覆盖与输入归属正确。

`Calendar`、`Carousel` 和 `Chart` 同样是无外部依赖的基础实现，适合低风险预览；复杂日期范围、
物理滚动或统计图交互需要先由设计系统 owner 升级能力。

`Select` 同时保留原生 option 子节点路径和组合 API。组合路径的 `SelectContent`
使用 portal、打开时聚焦选中项、按视口空间选择上下位置，并处理 Esc、方向键与首尾导航；
不能因此承诺任意碰撞、搜索、多选或 typeahead 都已支持。需要额外能力时先核对
`Command`、`ToggleGroup` 或由本层升级 Select family，不在 feature 另搭一套 popover。

## 开发预览与门禁

```bash
pnpm ops dev browser            # 启动浏览器产品后打开本地 Vite 地址并附加 ?dev=components
npm run ui-find -- Q="<意图>"
pnpm ops ci check docs desktop
pnpm ops ci test --scope desktop
```

若实现与本文成熟度说明冲突，以源码和测试证据为准，并在同一变更中更新局部规范与本说明。
