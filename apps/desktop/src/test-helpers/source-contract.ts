import assert from 'node:assert/strict'

/**
 * Extract a substring between two anchors in source text.
 * Used by regex contract tests to pin semantic blocks without hardcoding line numbers.
 */
export function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing block start: ${start}`)
  const to = source.indexOf(end, from)
  assert.ok(to > from, `missing block end: ${end}`)
  return source.slice(from, to)
}

/** Extract from an anchor to the end of the source. */
export function tail(source: string, start: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing tail start: ${start}`)
  return source.slice(from)
}

/** Create a block reader bound to a specific source string.
 *  Usage: const read = createBlockReader(source); read(start, end) */
export function createBlockReader(source: string) {
  return (start: string, end: string): string => block(source, start, end)
}

/** Count non-overlapping occurrences of a pattern in source text. */
export function countOccurrences(source: string, pattern: string | RegExp): number {
  if (typeof pattern === 'string') {
    let n = 0
    let pos = 0
    while ((pos = source.indexOf(pattern, pos)) >= 0) {
      n++
      pos += pattern.length
    }
    return n
  }
  return (source.match(new RegExp(pattern, 'g')) ?? []).length
}
