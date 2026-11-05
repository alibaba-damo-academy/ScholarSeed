// locale.ts — Host-independent detection for the system language mode.
//
// 判定链（用户口径，按序取第一个非 null）：
//   ① System language → Chinese for zh, otherwise English
//   ② Mainland China time zone → Chinese
//   ③ Other usable time zone → English
//   ④ 全都失败 → 中文
//
// 本模块只吃「信号」不采信号：Electron 侧由 src/main/locale.ts 采集，浏览器形态在
// renderer/src/browser.ts 内联采集。分成两处是为了守住 renderer 不得获得 Node/Electron
// 能力的边界 —— 合并会把 electron 拉进 tsconfig.web.json 的 include。刻意做成有序
// 检测器数组而不是 if 分支：日后新增信号（账号 locale、IP 地理）是往 LANGUAGE_DETECTORS
// 追加一个检测器，不是回来改这里的控制流。
//
// 本模块同时刻意保持「运行时无相对导入」：它被 src/locale.test.ts 用
// node --experimental-transform-types 直接加载，而 Node 的 ESM 解析器不做扩展名探测，
// 生产源文件按仓库约定又一律写无扩展名的相对导入 —— 一旦在这里 import 值就会
// ERR_MODULE_NOT_FOUND。permissions.ts / notifications.ts / preferences.ts 同样是叶子。
// 因此下面只留 type-only 导入（编译与运行时都会被擦除），最终兜底就地声明。
import type { PreferenceLanguage } from './preferences'

/** 判定所需的宿主信号。缺信号一律用 null / 空数组表达，不用 undefined 混着来。 */
export interface LocaleSignals {
  /** IANA 时区名；取不到为 null。 */
  timeZone: string | null
  /** OS 界面语言偏好列表，按优先级降序（BCP-47 标签）。 */
  languages: readonly string[]
}

export type LanguageDetector = (signals: LocaleSignals) => PreferenceLanguage | null

export const CHINESE_LANGUAGE: PreferenceLanguage = 'zh'
export const NON_CHINESE_LANGUAGE: PreferenceLanguage = 'en'

/**
 * 中国大陆时区。口径是**严格大陆**，不是整个 UTC+8 —— 新加坡 / 台北 / 珀斯 / 马尼拉
 * 同为 +8 但判英文。后四项是已废弃的大陆别名，ICU 通常只吐 canonical 名，留着是防
 * 旧 tzdata 或其它信号源给出别名。
 */
export const CHINA_TIME_ZONES: ReadonlySet<string> = new Set([
  'Asia/Shanghai',
  'Asia/Urumqi',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Kashgar',
  'PRC',
])

/**
 * UTC/GMT does not determine a regional fallback. System languages have already
 * been checked; when neither signal is usable, the final fallback is Chinese.
 */
export const INDETERMINATE_TIME_ZONES: ReadonlySet<string> = new Set([
  'UTC',
  'UCT',
  'GMT',
  'GMT0',
  'Zulu',
  'Universal',
  'Greenwich',
  'Factory',
  'Etc/UTC',
  'Etc/UCT',
  'Etc/GMT',
  'Etc/GMT0',
  'Etc/GMT+0',
  'Etc/GMT-0',
  'Etc/Zulu',
  'Etc/Universal',
  'Etc/Greenwich',
])

export const CHINESE_PRIMARY_SUBTAG = 'zh'

/**
 * 规则 ④：信号全都用不上时落中文。这与 `DEFAULT_RENDERER_PREFERENCES.language` 是同一
 * 个约定，就地声明是为了让本模块保持运行时无相对导入；两者不漂移由 locale.test.ts 断言。
 */
export const FALLBACK_LANGUAGE: PreferenceLanguage = CHINESE_LANGUAGE

/**
 * BCP-47 主语言子标签：2-3 位字母（ISO 639）或 5-8 位字母（保留段），后接分隔符或结尾。
 * 兼容 POSIX 风格的下划线（`zh_CN`）。`x-` / `i-` 前缀、纯数字、超长首段都自然不匹配，
 * 无需为它们单列分支。
 */
const PRIMARY_SUBTAG_PATTERN = /^([A-Za-z]{2,3}|[A-Za-z]{5,8})(?:[-_]|$)/

export function primaryLanguageSubtag(tag: string): string | null {
  const matched = PRIMARY_SUBTAG_PATTERN.exec(tag.trim().toLowerCase())
  return matched ? matched[1] : null
}

/** 取宿主时区。纯 ECMAScript，两个宿主共用；引擎缺 ICU 或抛错一律当「取不到」。 */
export function readTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.trim() ? zone.trim() : null
  } catch {
    return null
  }
}

function timeZoneDetector(signals: LocaleSignals): PreferenceLanguage | null {
  const zone = signals.timeZone?.trim()
  if (!zone || INDETERMINATE_TIME_ZONES.has(zone)) return null
  return CHINA_TIME_ZONES.has(zone) ? CHINESE_LANGUAGE : NON_CHINESE_LANGUAGE
}

/**
 * 第一个**格式合法**的标签说了算 —— 它就是 OS 的界面语言。畸形条目跳过而不是决定性：
 * `['', 'en-GB']` 应判英文，而不是被空串短路成兜底中文。
 */
function systemLanguageDetector(signals: LocaleSignals): PreferenceLanguage | null {
  for (const tag of signals.languages) {
    const subtag = primaryLanguageSubtag(tag)
    if (!subtag) continue
    return subtag === CHINESE_PRIMARY_SUBTAG ? CHINESE_LANGUAGE : NON_CHINESE_LANGUAGE
  }
  return null
}

export const LANGUAGE_DETECTORS: readonly LanguageDetector[] = [
  systemLanguageDetector,
  timeZoneDetector,
]

export function detectPreferenceLanguage(signals: LocaleSignals): PreferenceLanguage {
  for (const detect of LANGUAGE_DETECTORS) {
    const detected = detect(signals)
    if (detected) return detected
  }
  return FALLBACK_LANGUAGE
}
