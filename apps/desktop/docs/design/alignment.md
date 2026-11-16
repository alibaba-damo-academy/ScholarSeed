# 基础组件设计对齐矩阵

## Scope / Non-goals

本表保留2026-09-10基础设施整改时的19族组件对齐快照（Badge/Tag合并一族），按设计角色串联当时的证据、实现与预览。它不替代当前源码、设计节点或动态资产，也不宣布业务页面完成迁移。

## Source of truth

设计文件203335358980331、page 5:43395；[公开设计契约](foundations.md)用于定位目标状态。支持资产 (non-public execution/provenance record omitted)的2026-09-09截图与下表2026-09-10 HTTP 属性均为历史取证，修改前须重新核对实际设计节点。组件 API 以[生成资产](../_generated/components.md)链接到的当前源码为准。

“推导”表示没有取得该控件独立精确稿，沿统一语义和可访问性推导；不能把组件展示板或复合业务卡片尺寸直接当作基础组件默认尺寸。暗色和未给出的交互状态均按语义推导，未取得对应独立设计稿。

## Current / Required / Gap / Advisory

- **current**：已建立19族设计角色、源码语义与真实运行证据索引，逐行结果如下。
- **required**：有精确节点的控件按对应状态取证；缺稿状态明确标注推导，并验证真实明暗、键盘和窄窗。
- **gap**：部分组件缺独立暗色或交互设计稿；这些状态已按统一语义和可访问性推导并用真实预览验证，后续页面迁移遇到更具体稿件时继续补证。
- **advisory**：开发页面时只读取相关行并跟随链接到真实props，不遍历全部历史设计文档。

运行截图目录为仓库忽略目录 `tmp/test_snapshot/design-infrastructure/`，light/dark编号为真实dev:web分别打开组件的截图；默认图不证明浮层已展开或所有状态通过。后续每次改动必须重新取得受影响状态证据。

| 角色 / 状态 | 设计证据及性质 | 基础实现 / 语义入口 | 预览与当前验证 / 剩余项 |
| --- | --- | --- | --- |
| Button 主操作、次操作、禁用/加载 | 当前HTTP 25:36297/25:36301：36高、8圆角；主底#2C5545；25:36310为32高，不能全改36 | Button standard；brand-bg与text-on-brand三状态；warning变体使用warning语义 | 按钮 Button，00；三主题品牌文字对比度确定性检查；standard实测36，sm/md/lg与禁用/长文本已有预览证据 |
| IconButton 紧凑操作、hover/selected | 当前截图及HTTP 5:81200子节点5:81197/5:81206/5:81210：40方、8圆角、图标16、padding12；历史8:8919另有28方 | IconButton继承Button；sm/md/lg方形尺寸独立于文本Button；ghost使用surface-hover/active | 图标按钮 IconButton，01；实测26/32/40方形、图标14/16/16；lg为40/8圆角/icon16；明暗hover/selected截图已读；28px历史档位仍留给具体调用选型 |
| Input 单行/密码、focus/invalid | 当前HTTP25:36288：340×36、8圆角、padding8/12、白底 | Input/PasswordInput standard；control-border、text、语义背景 | 输入框 Input，02；36尺寸能力已补；宽340是稿中组合宽度 |
| Textarea 多行输入、禁用 | 历史9:02274为420×228复合输入区，其输入padding12/radius12；非Textarea独立稿 | Textarea；control-border/hover、背景/文字语义 | 多行输入 Textarea，03；暗色边框已修并读图；复合输入区布局留给业务owner |
| Select 默认/展开/disabled | 当前HTTP25:36281：340×36、8圆角、padding8/12 | Select standard，组合Trigger继承size；control-border | 选择器 Select，04；实测standard 36高/8圆角；组合式明暗展开图、End/Enter选值、Escape恢复已验；360px窄窗打开无横向溢出，禁用跳过render通过 |
| Checkbox 选中/禁用 | 历史认证稿14:10465的协议勾选角色；未取得独立完整状态值 | Checkbox、checkbox-size/radius、brand-bg | 复选框 Checkbox，05；明暗稳定截图已读，Space切换与禁用保持disabled已验 |
| Radio 单选/禁用 | 当前独立精确设计缺失，语义推导 | Radio/RadioGroup、radio语义与品牌选中态 | 单选框 Radio，06；明暗稳定截图已读，真实方向键切换、跳过禁用并循环返回已验，长label自然换行 |
| Switch 开关/禁用 | 历史14:50537模型支持资产包含开关普通/启用外观；未取得独立状态几何 | Switch；共享轨道和品牌语义 | 开关 Switch，07；明暗稳定截图已读，暗色轨道修复，Space切换和禁用状态已验 |
| Tabs 选中/禁用 | 历史14:10465认证tab；5:003411文档页签另属NavigationTabs，不能互换 | Tabs与NavigationTabs各自owner；背景/文字/边框语义 | 标签页 Tabs，08；明暗稳定截图已读，点击设定初值后ArrowRight切换和禁用跳过循环已验；NavigationTabs悬空token修复由契约覆盖 |
| Badge/Tag 状态与附件标识 | 历史9:13940附件片208×28、padding4/8/gap8；属于业务组合，不能作为所有Tag宽度 | Badge/Tag；tone语义；Tag品牌底前景已接text-on-brand | 徽标 Badge/标签 Tag，09/10；明暗tone颜色、small、可移除、长文本省略均已实测；业务附件片组合留给业务owner |
| Card 容器/强调 | 历史25:59495首项目卡25:58306：430×148、padding16、gap12、radius12 | Card bordered/elevated/flat，card-radius/padding与surface | 卡片 Card，11；内容布局与业务动作归项目owner；已有className局部card-radius + padding=md + gap工具类实测12/16/12；card-detail-480-light/dark已读，无横向溢出，默认8圆角保留 |
| Divider 横/竖分隔 | 逐稿分隔观察；11:12961是可拖拽分割器，另属Resizable | Divider/Separator；divider-color/size | 分割线 Divider，12；实测横向1px、竖向1px×32；不把拖拽手柄混入Divider |
| Dialog 模态与非模态 | 设计弹层外观来源逐稿；焦点/键盘未给精确稿，按交互规范推导 | Dialog + focus scope；modal与非modal兼容 | 对话框 Dialog，13；dialog-1440/480实测Tab/Escape恢复；嵌套render通过 |
| Popover 可交互浮层 | 菜单/设置组合观察；独立完整状态值缺失，语义推导 | Popover + floating/focus；非模态定位后聚焦 | 弹出层 Popover，14；popover-after展开图已读；初始焦点/Space/Escape/外部点击回归通过 |
| DropdownMenu 操作菜单/子菜单 | 逐稿菜单快照部分只有外壳，不冒充完整item属性 | Menu owner；语义菜单底/项；aria-controls/focus scope | 下拉菜单 DropdownMenu，15；menu-after展开图已读；方向键/首尾/禁用跳过/嵌套Escape已验；左右键和字符搜索缺口见交互规范 |
| Tooltip 短说明 | 未取得独立完整状态稿，按balloon语义推导 | Tooltip使用balloon而非悬空tooltip token | 工具提示 Tooltip，16；明暗hover展开、480px窄窗展开与Escape已验并读图，焦点保留render通过；极端边缘定位仍按floating通用逻辑约束 |
| Sheet 详情侧面板 | 历史文献详情抽屉见literature逐稿；内容高/宽为该稿组合约束 | Sheet/Drawer；drawer语义；modal共用focus scope；Trigger登记恢复目标 | 侧边面板与抽屉 Sheet/Drawer，17；480px明暗展开图已读，真实Tab循环、Escape关闭和触发器恢复已验；Drawer底部展开图已读 |
| Alert 持续反馈 | 独立完整状态稿缺失，按info/success/warning/error语义推导 | Alert语义背景/边框/文字/图标；警告禁用底已修 | 提示 Alert，18；明暗tone语义和长说明已实测，四tone映射由class契约覆盖；完整四tone独立设计稿仍缺 |
| Toast 临时反馈 | 独立完整状态稿缺失，按反馈语义推导 | Toast/Toaster；toast几何与状态语义；关闭hover悬空token已修 | 通知 Toast，19；480px明暗反馈触发/关闭已验，360×66px、右16；多tone触发与队列叠放已实测，带操作toast为360×102 |

## Ownership / Dependency

design持有语义和基础数值；ui持有通用状态与样式；examples承载可运行组合；具体项目卡片、认证、文献详情等页面由原owner在后续开发中按相关UI范围迁移。不得为本表清零去改业务页面。

## 正反例

正例：API Key表单的Input使用standard，并核对25:36288与实际36px高度；布局宽度由表单owner处理。

反例：把项目卡片430px宽写成所有Card默认宽，或把Tooltip未展开的截图登记为hover状态通过。

## Enforced by

资产、token引用和CSS规则由docs:check/desktop-test核验；每行视觉和交互仍需本次真实预览与共享消费者证据。缺独立设计稿的状态按语义推导记录，不沿用旧运行日志判定当前通过。

## Update triggers

设计节点、token、组件props/状态、示例变化后更新对应行及证据日期；新增独立设计稿证据时补充对应行的证据性质。

## Stop condition

每行均有可追溯设计证据或明确推导、真实实现、运行状态证据与兼容性结果后完成本矩阵验收。不能以默认截图或绿色门禁替代所有状态验证。当前矩阵达到基础设施交付所需证据；仍缺独立设计稿的状态按推导记录，后续业务页面迁移时继续补具体稿件证据。
