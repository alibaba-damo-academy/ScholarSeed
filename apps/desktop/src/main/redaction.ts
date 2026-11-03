// Update diagnostics must remain useful without exporting transport credentials.
const REDACTED = '<REDACTED>'
const URL = /https?:\/\/[^\s<>"']+/gi
const COOKIE_HEADER = /(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gim
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const SECRET =
  /(["']?\b(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|nonce|download_url)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)/gi
const USER_PATH = /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\r\n"']+|\/(?:Users|home)\/[^/\r\n"']+)/gi
const DIAGNOSTIC_ERROR_MAX_CHARS = 8_192
const DIAGNOSTIC_CAUSE_DEPTH = 3
const DIAGNOSTIC_AGGREGATE_LIMIT = 3

/** Allowlisted, bounded error evidence; never serialize arbitrary error properties or env. */
export function redactDiagnosticError(error: unknown): unknown {
  let remaining = DIAGNOSTIC_ERROR_MAX_CHARS
  const text = (value: unknown): string => {
    const result = redactUpdateLog(String(value)).slice(0, remaining)
    remaining -= result.length
    return result
  }
  const capture = (error: unknown, depth: number): unknown => {
    if (typeof error !== 'object' || error === null) return text(error)
    const value = error as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of ['name', 'code', 'systemCode', 'path', 'message', 'detail']) {
      const field = value[key]
      if (typeof field === 'string') result[key] = text(field)
      else if (typeof field === 'number' && Number.isFinite(field)) result[key] = field
    }
    // Preserve inner native failures before spending the remaining budget on stacks.
    if (depth < DIAGNOSTIC_CAUSE_DEPTH) {
      if (value.cause !== undefined) result.cause = capture(value.cause, depth + 1)
      if (Array.isArray(value.errors))
        result.errors = value.errors
          .slice(0, DIAGNOSTIC_AGGREGATE_LIMIT)
          .map((item) => capture(item, depth + 1))
    }
    if (typeof value.stack === 'string') result.stack = text(value.stack)
    return result
  }
  return capture(error, 0)
}

export function redactUpdateLog(line: string): string {
  return line
    .replace(URL, '<URL>')
    .replace(COOKIE_HEADER, `$1 ${REDACTED}`)
    .replace(AUTHORIZATION, `$1 ${REDACTED}`)
    .replace(SECRET, (_match, key: string) => `${key}${JSON.stringify(REDACTED)}`)
    .replace(USER_PATH, '<HOME>')
}
