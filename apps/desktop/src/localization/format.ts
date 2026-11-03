import { LOCALES } from './catalog'
import type { PreferenceLanguage } from '../preferences'
import zhLayout from './locales/zh/layout.json'
import enLayout from './locales/en/layout.json'

const BYTES_PER_KILOBYTE = 1024
const JUST_NOW_LABELS = { zh: zhLayout.justNow, en: enLayout.justNow }
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE ** 2
const FILE_SIZE_UNITS = [
  { minimum: BYTES_PER_MEGABYTE, divisor: BYTES_PER_MEGABYTE, suffix: 'M', precision: 2 },
  { minimum: BYTES_PER_KILOBYTE, divisor: BYTES_PER_KILOBYTE, suffix: 'K', precision: 2 },
  { minimum: 0, divisor: 1, suffix: 'B', precision: 0 },
] as const

function formatBytes(value: number, locale: string): string {
  const unit =
    FILE_SIZE_UNITS.find((candidate) => value >= candidate.minimum) ??
    FILE_SIZE_UNITS[FILE_SIZE_UNITS.length - 1]
  const amount = numberFormatter(locale, {
    useGrouping: false,
    maximumFractionDigits: unit.precision,
  }).format(value / unit.divisor)
  return `${amount} ${unit.suffix}`
}

// 构造 Intl formatter 是重活 (实测 2060 次 new Intl.DateTimeFormat ≈ 63ms, 复用同一实例
// ≈ 0.95ms)。列表类页面会在每次渲染里为每个单元格取一次格式化器, 所以按
// 「种类 + locale + options」缓存实例; formatter 本身不可变、format() 无状态, 复用安全。
const FORMATTER_CACHE_LIMIT = 64

function cachedFormatter<T>(cache: Map<string, T>, key: string, create: () => T): T {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  // 上限只是防止调用方把动态用户数据当 options 传进来时无界增长; 命中上限整体清空
  // 比逐条淘汰更简单, 也不改变任何一次调用的结果。
  if (cache.size >= FORMATTER_CACHE_LIMIT) cache.clear()
  const created = create()
  cache.set(key, created)
  return created
}

function optionsKey(kind: string, locale: string, options?: object): string {
  return `${kind}|${locale}|${options === undefined ? '' : JSON.stringify(options)}`
}

const NUMBER_FORMATTERS = new Map<string, Intl.NumberFormat>()
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>()
const RELATIVE_FORMATTERS = new Map<string, Intl.RelativeTimeFormat>()

function numberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedFormatter(
    NUMBER_FORMATTERS,
    optionsKey('number', locale, options),
    () => new Intl.NumberFormat(locale, options)
  )
}

function dateFormatter(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cachedFormatter(
    DATE_FORMATTERS,
    optionsKey('date', locale, options),
    () => new Intl.DateTimeFormat(locale, options)
  )
}

function relativeFormatter(
  locale: string,
  options?: Intl.RelativeTimeFormatOptions
): Intl.RelativeTimeFormat {
  return cachedFormatter(
    RELATIVE_FORMATTERS,
    optionsKey('relative', locale, options),
    () => new Intl.RelativeTimeFormat(locale, options)
  )
}

/** Explicit locale, with caller-owned precision, currency and time-zone semantics. */
export function createFormatters(language: PreferenceLanguage) {
  const locale = LOCALES[language].tag
  return {
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      numberFormatter(locale, options).format(value),
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      dateFormatter(locale, options).format(value),
    relative: (
      value: number,
      unit: Intl.RelativeTimeFormatUnit,
      options?: Intl.RelativeTimeFormatOptions
    ) =>
      value === 0 && (unit === 'minute' || unit === 'second') && options?.numeric === 'auto'
        ? JUST_NOW_LABELS[language]
        : relativeFormatter(locale, options).format(value, unit),
    bytes: (value: number) => formatBytes(value, locale),
  }
}
