import { LOCALES } from './catalog'
import type { PreferenceLanguage } from '../preferences'

const BYTES_PER_KILOBYTE = 1024
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE ** 2
const FILE_SIZE_UNITS = [
  { minimum: BYTES_PER_MEGABYTE, divisor: BYTES_PER_MEGABYTE, suffix: 'M', precision: 2 },
  { minimum: BYTES_PER_KILOBYTE, divisor: BYTES_PER_KILOBYTE, suffix: 'K', precision: 2 },
  { minimum: 0, divisor: 1, suffix: 'B', precision: 0 }
] as const

function formatBytes(value: number, locale: string): string {
  const unit = FILE_SIZE_UNITS.find((candidate) => value >= candidate.minimum)
    ?? FILE_SIZE_UNITS[FILE_SIZE_UNITS.length - 1]
  const amount = new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumFractionDigits: unit.precision
  }).format(value / unit.divisor)
  return `${amount} ${unit.suffix}`
}

/** Explicit locale, with caller-owned precision, currency and time-zone semantics. */
export function createFormatters(language: PreferenceLanguage) {
  const locale = LOCALES[language].tag
  return {
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value),
    relative: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => new Intl.RelativeTimeFormat(locale, options).format(value, unit),
    bytes: (value: number) => formatBytes(value, locale)
  }
}
