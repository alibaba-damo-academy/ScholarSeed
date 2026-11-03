import { decodeNamedCharacterReference } from 'decode-named-character-reference'

const REFERENCE_OPEN = '<!--'
const REFERENCE_CLOSE = '-->'
const REFERENCE_NAME = 'scholarseed-ref'
const CHARACTER_REFERENCE = /^&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/
const ESCAPABLE_PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/
const BOUNDARY_SEPARATOR = ','
const UNMAPPED_BOUNDARY = 'x'

export interface SourceLeaf {
  value: string
  startUtf16: number
  endUtf16: number
  boundaries: Array<number | null>
}

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

function numericCharacterReference(raw: string): string | null {
  const body = raw.slice(2, -1)
  const radix = body[0]?.toLowerCase() === 'x' ? 16 : 10
  const digits = radix === 16 ? body.slice(1) : body
  const codePoint = Number.parseInt(digits, radix)
  if (!Number.isFinite(codePoint)) return null
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return null
  }
}

function decodedCharacterReference(raw: string): string | null {
  if (raw.startsWith('&#')) return numericCharacterReference(raw)
  return decodeNamedCharacterReference(raw.slice(1, -1)) || null
}

function appendAtom(
  output: { value: string; boundaries: Array<number | null> },
  displayed: string,
  sourceStart: number,
  sourceEnd: number,
  linear: boolean
): void {
  output.value += displayed
  for (let index = 1; index <= displayed.length; index += 1) {
    const splitsSurrogate =
      index < displayed.length &&
      /[\uD800-\uDBFF]/.test(displayed[index - 1]) &&
      /[\uDC00-\uDFFF]/.test(displayed[index])
    output.boundaries.push(
      splitsSurrogate
        ? null
        : linear
          ? sourceStart + index
          : index === displayed.length
            ? sourceEnd
            : null
    )
  }
}

function decodeSource(
  raw: string,
  base: number
): { value: string; boundaries: Array<number | null> } {
  const output = { value: '', boundaries: [base] as Array<number | null> }
  let cursor = 0
  while (cursor < raw.length) {
    if (
      raw[cursor] === '\\' &&
      cursor + 1 < raw.length &&
      ESCAPABLE_PUNCTUATION.test(raw[cursor + 1])
    ) {
      appendAtom(output, raw[cursor + 1], base + cursor, base + cursor + 2, false)
      cursor += 2
      continue
    }
    if (raw[cursor] === '&') {
      const match = raw.slice(cursor).match(CHARACTER_REFERENCE)
      const decoded = match ? decodedCharacterReference(match[0]) : null
      if (match && decoded !== null) {
        appendAtom(output, decoded, base + cursor, base + cursor + match[0].length, false)
        cursor += match[0].length
        continue
      }
    }
    const codePoint = raw.codePointAt(cursor)
    const displayed = codePoint === undefined ? raw[cursor] : String.fromCodePoint(codePoint)
    appendAtom(output, displayed, base + cursor, base + cursor + displayed.length, true)
    cursor += displayed.length
  }
  return output
}

function mapCodeSource(
  raw: string,
  base: number,
  newline: '\n' | ' '
): { value: string; boundaries: Array<number | null> } {
  const output = { value: '', boundaries: [base] as Array<number | null> }
  let cursor = 0
  while (cursor < raw.length) {
    const lineBreak =
      raw[cursor] === '\r' && raw[cursor + 1] === '\n'
        ? '\r\n'
        : raw[cursor] === '\r' || raw[cursor] === '\n'
          ? raw[cursor]
          : ''
    if (lineBreak) {
      appendAtom(output, newline, base + cursor, base + cursor + lineBreak.length, false)
      cursor += lineBreak.length
      continue
    }
    const codePoint = raw.codePointAt(cursor)
    const displayed = codePoint === undefined ? raw[cursor] : String.fromCodePoint(codePoint)
    appendAtom(output, displayed, base + cursor, base + cursor + displayed.length, true)
    cursor += displayed.length
  }
  return output
}

function inlineCodeLeaf(raw: string, base: number, expected: string): SourceLeaf | null {
  const opening = raw.match(/^`+/)?.[0] ?? ''
  const closing = raw.match(/`+$/)?.[0] ?? ''
  if (!opening || closing.length !== opening.length) return null
  const contentStart = opening.length
  const contentEnd = raw.length - closing.length
  const mapped = mapCodeSource(raw.slice(contentStart, contentEnd), base + contentStart, ' ')
  if (/^\s/.test(mapped.value) && /\s$/.test(mapped.value) && /\S/.test(mapped.value)) {
    mapped.value = mapped.value.slice(1, -1)
    mapped.boundaries = mapped.boundaries.slice(1, -1)
  }
  const mappedStart = mapped.boundaries[0]
  const mappedEnd = mapped.boundaries.at(-1)
  return mapped.value === expected &&
    typeof mappedStart === 'number' &&
    typeof mappedEnd === 'number'
    ? {
        value: expected,
        startUtf16: mappedStart,
        endUtf16: mappedEnd,
        boundaries: mapped.boundaries,
      }
    : null
}

function fencedCodeLeaf(raw: string, base: number, expected: string): SourceLeaf | null {
  const openingEnd = raw.search(/\r?\n/)
  if (openingEnd < 0) return null
  const opening = raw.match(/^\s*(`{3,}|~{3,})/)?.[1]
  if (!opening) return null
  const lines = raw.split(/\r?\n/)
  const closingLine =
    lines.length > 1 &&
    new RegExp(`^\\s*${opening[0]}{${opening.length},}\\s*$`).test(lines.at(-1) ?? '')
      ? lines.length - 1
      : -1
  const contentLines = lines.slice(1, closingLine < 0 ? lines.length : closingLine)
  const displayed = contentLines.join('\n') + (contentLines.length ? '\n' : '')
  if (displayed !== expected) return null
  const contentStart = openingEnd + (raw[openingEnd] === '\r' ? 2 : 1)
  const rawContent = raw.slice(
    contentStart,
    closingLine < 0 ? raw.length : raw.lastIndexOf(lines[closingLine])
  )
  const mapped = mapCodeSource(rawContent, base + contentStart, '\n')
  const mappedEnd = mapped.boundaries.at(-1)
  if (mapped.value !== expected || typeof mappedEnd !== 'number') return null
  return {
    value: expected,
    startUtf16: base + contentStart,
    endUtf16: mappedEnd,
    boundaries: mapped.boundaries,
  }
}

export function sourceLeaf(
  source: string,
  expected: string,
  start: number,
  end: number,
  kind: 'text' | 'inline-code' | 'fenced-code' = 'text'
): SourceLeaf | null {
  const raw = source.slice(start, end)
  if (kind === 'inline-code') return inlineCodeLeaf(raw, start, expected)
  if (kind === 'fenced-code') return fencedCodeLeaf(raw, start, expected)
  const decoded = decodeSource(raw, start)
  return decoded.value === expected
    ? { value: expected, startUtf16: start, endUtf16: end, boundaries: decoded.boundaries }
    : null
}

export function encodedBoundaries(leaf: SourceLeaf): string | undefined {
  const linear = leaf.boundaries.every((boundary, index) => boundary === leaf.startUtf16 + index)
  if (linear) return undefined
  return leaf.boundaries
    .map((boundary) => (boundary === null ? UNMAPPED_BOUNDARY : String(boundary - leaf.startUtf16)))
    .join(BOUNDARY_SEPARATOR)
}

export function mappedSourceBoundary(element: HTMLElement, offset: number): number | null {
  const start = Number(element.dataset.mdSourceStart)
  const end = Number(element.dataset.mdSourceEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || offset < 0) return null
  const encoded = element.dataset.mdSourceBoundaries
  const boundary = encoded ? encoded.split(BOUNDARY_SEPARATOR)[offset] : String(offset)
  if (boundary === undefined || boundary === UNMAPPED_BOUNDARY) return null
  const mapped = start + Number(boundary)
  if (!Number.isInteger(mapped) || mapped < start || mapped > end) return null
  return mapped
}

export function sourceOffsetRect(root: HTMLElement, sourceOffset: number): DOMRect | null {
  for (const leaf of root.querySelectorAll<HTMLElement>('[data-md-source-start]')) {
    const start = Number(leaf.dataset.mdSourceStart)
    const end = Number(leaf.dataset.mdSourceEnd)
    if (sourceOffset < start || sourceOffset >= end) continue
    const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT)
    let textOffset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode
      const length = node.textContent?.length ?? 0
      for (let offset = 0; offset < length; offset += 1) {
        if (mappedSourceBoundary(leaf, textOffset + offset) !== sourceOffset) continue
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        return range.getClientRects()[0] ?? null
      }
      textOffset += length
    }
  }
  return null
}
