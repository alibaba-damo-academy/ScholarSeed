const REFERENCE_OPEN = '<!--'
const REFERENCE_CLOSE = '-->'
const REFERENCE_NAME = 'scholarseed-ref'

interface ReferenceRange {
  start: number
  end: number
}

export function referenceRanges(source: string): ReferenceRange[] {
  const ranges: ReferenceRange[] = []
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf(REFERENCE_OPEN, cursor)
    if (start < 0) break
    const end = source.indexOf(REFERENCE_CLOSE, start + REFERENCE_OPEN.length)
    const rangeEnd = end < 0 ? source.length : end + REFERENCE_CLOSE.length
    if (source.slice(start, rangeEnd).toLowerCase().includes(REFERENCE_NAME)) {
      ranges.push({ start, end: rangeEnd })
    }
    if (end < 0) break
    cursor = rangeEnd
  }
  return ranges
}

/** Hide private evidence transport comments from copied and rendered text. */
export function visibleMarkdownText(source: string): string {
  const ranges = referenceRanges(source)
  if (!ranges.length) return source
  let cursor = 0
  let result = ''
  for (const range of ranges) {
    result += source.slice(cursor, range.start)
    cursor = range.end
  }
  return result + source.slice(cursor)
}

/** Keep complete comments so parser offsets remain exact; mask an incomplete streaming tail. */
export function prepareMarkdownSource(source: string): string {
  const ranges = referenceRanges(source)
  const partial = ranges.find(
    (range) => range.end === source.length && !source.endsWith(REFERENCE_CLOSE)
  )
  if (!partial) return source
  return source.slice(0, partial.start) + source.slice(partial.start).replace(/[^\r\n]/g, ' ')
}

/** Translate TeX math delimiters without shifting source annotation offsets. */
export function prepareMathSource(source: string): string {
  const delimiters: Array<{ index: number; kind: 'inline' | 'display'; opening: boolean }> = []
  let fenceCharacter = ''
  let fenceLength = 0
  let inlineTicks = 0
  let offset = 0

  for (const line of source.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!inlineTicks && fence) {
      const marker = fence[1]
      if (!fenceCharacter) {
        fenceCharacter = marker[0]
        fenceLength = marker.length
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = ''
        fenceLength = 0
      }
      offset += line.length
      continue
    }
    if (fenceCharacter) {
      offset += line.length
      continue
    }

    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '`') {
        let end = index + 1
        while (line[end] === '`') end += 1
        const length = end - index
        if (!inlineTicks) inlineTicks = length
        else if (inlineTicks === length) inlineTicks = 0
        index = end - 1
        continue
      }
      if (inlineTicks || line[index] !== '\\' || line[index - 1] === '\\') continue
      const marker = line[index + 1]
      if (marker === '(' || marker === ')' || marker === '[' || marker === ']') {
        delimiters.push({
          index: offset + index,
          kind: marker === '(' || marker === ')' ? 'inline' : 'display',
          opening: marker === '(' || marker === '[',
        })
        index += 1
      }
    }
    offset += line.length
  }

  const replacements = new Set<number>()
  const openings: Partial<Record<'inline' | 'display', number>> = {}
  for (const delimiter of delimiters) {
    if (delimiter.opening) openings[delimiter.kind] = delimiter.index
    else {
      const openingIndex = openings[delimiter.kind]
      if (openingIndex === undefined) continue
      replacements.add(openingIndex)
      replacements.add(delimiter.index)
      delete openings[delimiter.kind]
    }
  }
  if (!replacements.size) return source
  return source.replace(/\\[()[\]]/g, (delimiter, index: number) =>
    replacements.has(index) ? '$$' : delimiter
  )
}
