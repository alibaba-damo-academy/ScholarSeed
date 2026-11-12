import privacyPolicy from './privacy-policy_zh.md?raw'
import serviceAgreement from './service-agreement_zh.md?raw'

// legal/index.ts — 用户协议与隐私政策正文。
//
// 两份 md 原件就是唯一源文件（法务改版时整份替换即可），用 Vite 的 `?raw` 在构建期
// 内联成字符串。不走接口也不读文件：这两份文档要在登录之前就能打开，那时既没有会话
// 也不该依赖主进程通路；内联还顺带保证 dev 与打包产物、联网与离线的行为一致。

export type LegalDocKey = 'agreement' | 'privacy'

export type LegalDoc = {
  /** 弹窗标题，取 md 的一级标题（带版本号），缺失时退回入口文案。 */
  title: string
  /** 去掉一级标题后的正文，交给仓内 Markdown 渲染器。 */
  body: string
}

/** 登录/注册页协议行上的入口文案。 */
export const LEGAL_LABELS: Record<LegalDocKey, string> = {
  agreement: '用户协议',
  privacy: '隐私政策',
}

// 法务原件出自语雀，带 `++…++`（下划线）这种非标准标记 —— 仓内 Markdown 渲染器不认，
// 会把加号原样印进正文。只摘掉标记本身，包在里面的 `**粗体**` 与字句一个不动。
const YUQUE_UNDERLINE = /\+\+(.+?)\+\+/g
const LEADING_HEADING = /^#\s+(.*)$/

function parse(source: string, fallbackTitle: string): LegalDoc {
  const [first, ...rest] = source.replace(YUQUE_UNDERLINE, '$1').split('\n')
  const heading = first.match(LEADING_HEADING)
  if (!heading) return { title: fallbackTitle, body: [first, ...rest].join('\n').trim() }
  return { title: heading[1].trim() || fallbackTitle, body: rest.join('\n').trim() }
}

export const LEGAL_DOCS: Record<LegalDocKey, LegalDoc> = {
  agreement: parse(serviceAgreement, LEGAL_LABELS.agreement),
  privacy: parse(privacyPolicy, LEGAL_LABELS.privacy),
}
