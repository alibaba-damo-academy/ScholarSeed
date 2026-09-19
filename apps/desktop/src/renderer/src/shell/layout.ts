/**
 * 四区外壳的布局常量（MVP 0.2）。
 *
 * 所有栏宽/栏高集中在此，禁止在组件里写魔法数字。数值取自
 * demo0827 原型与设计截图实测。
 */

/** 左侧活动栏宽度。 */
export const ACTIVITY_RAIL_WIDTH = 56

/** 活动栏图标尺寸。 */
export const ACTIVITY_ICON_SIZE = 18

/** 顶栏高度。 */
export const TOP_BAR_HEIGHT = 48

/** 模块面板（第二栏）默认宽度与可拖拽范围。 */
export const MODULE_PANEL_WIDTH = 264
export const MODULE_PANEL_MIN_WIDTH = 200
export const MODULE_PANEL_MAX_WIDTH = 480

/** AI 面板默认宽度与可拖拽范围。 */
export const AI_PANEL_WIDTH = 380
export const AI_PANEL_MIN_WIDTH = 300
export const AI_PANEL_MAX_WIDTH = 640

/** 标签栏高度。 */
export const TAB_BAR_HEIGHT = 40

/**
 * 深色底控件上的图标颜色（活动栏图标、深绿圆形发送按钮等）。
 *
 * 必须作为 `color` prop 传给 `Icon`：Icon 自带内联
 * `style={{ color: 'var(--text-3)' }}`，内联样式优先级高于任何外部
 * CSS，因此在父元素上写 `color` 不会生效。
 */
export const ON_DARK_ICON_COLOR = '#ffffff'
