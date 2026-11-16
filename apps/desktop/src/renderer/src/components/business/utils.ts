const SECOND_MS = 1000
const MINUTE_SECONDS = 60
const HOUR_SECONDS = 60 * MINUTE_SECONDS
const DAY_SECONDS = 24 * HOUR_SECONDS
const RELATIVE_DAYS = 7
const USER_MESSAGE_URL = /\bhttps?:\/\/[^\s<>"`，。！？；、【】「」]+/giu
const URL_TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、…]+$/u
const URL_CLOSING_PAIRS = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
] as const

export function userMessageParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = []
  let offset = 0
  for (const match of text.matchAll(USER_MESSAGE_URL)) {
    let href = match[0]
    let previous: string
    do {
      previous = href
      href = href.replace(URL_TRAILING_PUNCTUATION, '')
      for (const [opening, closing] of URL_CLOSING_PAIRS) {
        while (href.endsWith(closing) && href.split(closing).length > href.split(opening).length)
          href = href.slice(0, -closing.length)
      }
    } while (href !== previous)
    try {
      if (!new URL(href).hostname) continue
    } catch {
      continue
    }
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) })
    parts.push({ text: href, href })
    offset = match.index + href.length
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) })
  return parts
}

export function libraryFileType(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '—'
}

export function libraryUpdatedAt(
  timestamp: number | undefined,
  locale: string,
  now = Date.now(),
  justNow?: string
): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—'
  const elapsed = Math.max(0, (now - timestamp * SECOND_MS) / SECOND_MS)
  if (elapsed < MINUTE_SECONDS)
    return justNow ?? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second')
  if (elapsed >= RELATIVE_DAYS * DAY_SECONDS)
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(timestamp * SECOND_MS)
  const unit =
    elapsed >= DAY_SECONDS
      ? 'day'
      : elapsed >= HOUR_SECONDS
        ? 'hour'
        : elapsed >= MINUTE_SECONDS
          ? 'minute'
          : 'second'
  const divisor =
    unit === 'day'
      ? DAY_SECONDS
      : unit === 'hour'
        ? HOUR_SECONDS
        : unit === 'minute'
          ? MINUTE_SECONDS
          : 1
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    -Math.floor(elapsed / divisor),
    unit
  )
}
