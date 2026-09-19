/**
 * 设计令牌（开发 7 拥有）。
 *
 * 架构文档 §3.7 把「设计 Token、颜色、字体、间距、组件状态」划给开发 7。
 *
 * 令牌的事实源是 `styles.css` 的 `:root`（含亮/暗双主题）。本文件**不新增
 * 一套变量名**，只把已有变量收敛成一份带类型的清单。
 *
 * 为什么不在 TS 里存真值：样式最终由 CSS 生效，且暗色主题会覆盖同名变量。
 * 若 TS 再存一份数值，改了 CSS 忘了改 TS 就会出现"代码里写着 #fff、
 * 实际渲染是深色"这类查不出来的偏差，而且暗色主题根本无法表达。
 */

/** 令牌名 → CSS 变量引用。取值随主题自动切换。 */
export const token = {
  // 背景层次
  bg: 'var(--bg)',
  bgRaised: 'var(--bg-2)',
  bgSunken: 'var(--bg-3)',

  // 描边
  border: 'var(--border)',
  borderSoft: 'var(--border-soft)',

  // 文字
  text: 'var(--text)',

  // 强调色
  accent: 'var(--accent)',
  accentInk: 'var(--accent-ink)',
  accentSoft: 'var(--accent-soft)',

  // 圆角
  radius: 'var(--radius)',
  cardRadius: 'var(--card-radius)'
} as const

export type TokenName = keyof typeof token

/**
 * 取一个令牌的 CSS 引用。
 *
 * 存在的意义是让 TypeScript 拦住拼错的令牌名 —— 直接写字符串
 * `'var(--bg-4)'` 这种不存在的变量，CSS 会静默回落到继承值，
 * 表现为"某个区块颜色莫名不对"，很难定位。
 */
export function cssVar(name: TokenName): string {
  return token[name]
}
