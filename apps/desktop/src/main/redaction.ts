// Update diagnostics must remain useful without exporting transport credentials.
const REDACTED = '<REDACTED>'
const URL = /https?:\/\/[^\s<>"']+/gi
const COOKIE_HEADER = /(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gim
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const SECRET =
  /(["']?\b(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|nonce|download_url)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)/gi
const USER_PATH = /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\r\n"']+|\/(?:Users|home)\/[^/\r\n"']+)/gi

export function redactUpdateLog(line: string): string {
  return line
    .replace(URL, '<URL>')
    .replace(COOKIE_HEADER, `$1 ${REDACTED}`)
    .replace(AUTHORIZATION, `$1 ${REDACTED}`)
    .replace(SECRET, (_match, key: string) => `${key}${JSON.stringify(REDACTED)}`)
    .replace(USER_PATH, '<HOME>')
}
