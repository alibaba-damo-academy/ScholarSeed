import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

import { isCitationUrl } from '../../contracts/citations'
import type { EvidenceAnnotation } from '../../model'
import { encodedBoundaries, sourceLeaf, type SourceLeaf } from './source'

const CITATION_PARENTHESES = new Map([['(', ')'], ['（', '）']])
const CITATION_SEPARATOR = /^[\t \u00a0、,，]+$/

const SOURCE_START = 'dataMdSourceStart'
const SOURCE_END = 'dataMdSourceEnd'
const SOURCE_BOUNDARIES = 'dataMdSourceBoundaries'
const EVIDENCE_ID = 'data-scholarseed-evidence-id'
const EVIDENCE_TERMINAL = 'data-scholarseed-evidence-terminal'
const ANSWER_MARKER = 'data-scholarseed-answer-marker'
const ANSWER_ANNOTATION_ID = 'data-scholarseed-answer-annotation-id'
const ANSWER_ANNOTATION_FOCUSED = 'data-scholarseed-answer-annotation-focused'

export interface MarkdownAnswerAnnotation {
  id: string
  start_utf16: number
  end_utf16: number
  focused?: boolean
}

interface DecorationOptions {
  source: string
  sourceMapped: boolean
  citationUrls?: ReadonlySet<string>
  evidence: EvidenceAnnotation[]
  answers: MarkdownAnswerAnnotation[]
}

interface Range {
  id: string
  start: number
  end: number
}

interface RecoveredRange {
  start: number
  end: number
}

type OffsetCache = Map<Element, Map<Text, RecoveredRange> | null>

// remark-cjk-friendly 等插件重建 CJK 文本节点后 position 丢失, 导致正文拿不到源码偏移。
// 按文档顺序从块起点游标重建: 有 position 的节点负责重新对齐, 无 position 的文本
// 从游标起在源码中顺序匹配(允许中间仅隔换行/硬中断符), 匹配失败则整块放弃恢复。
const RECOVER_GAP_PATTERN = /^[ \t\r\n\\]*$/

function recoverTextOffsets(block: Element, source: string): Map<Text, RecoveredRange> | null {
  const blockStart = positionOffset(block, 'start')
  if (blockStart === null) return null
  const recovered = new Map<Text, RecoveredRange>()
  let cursor = blockStart
  let consistent = true
  const visit = (node: Element | Text): void => {
    if (!consistent) return
    if (node.type === 'text') {
      const start = positionOffset(node, 'start')
      const end = positionOffset(node, 'end')
      if (start !== null && end !== null) {
        cursor = end
        return
      }
      const found = source.indexOf(node.value, cursor)
      const gap = found < 0 ? null : source.slice(cursor, found)
      if (found < 0 || gap === null || !RECOVER_GAP_PATTERN.test(gap)) {
        consistent = false
        return
      }
      recovered.set(node, { start: found, end: found + node.value.length })
      cursor = found + node.value.length
      return
    }
    if (node.tagName === 'br') return
    const start = positionOffset(node, 'start')
    const end = positionOffset(node, 'end')
    if (start !== null) cursor = start
    for (const child of node.children) {
      if (child.type === 'element' || child.type === 'text') visit(child as Element | Text)
    }
    if (end !== null) cursor = end
  }
  for (const child of block.children) {
    if (child.type === 'element' || child.type === 'text') visit(child as Element | Text)
  }
  return consistent ? recovered : null
}

function recoveredRange(
  cache: OffsetCache,
  source: string,
  node: Text,
  parents: Element[]
): RecoveredRange | null {
  let block: Element | null = null
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    if (positionOffset(parents[index], 'start') !== null) {
      block = parents[index]
      break
    }
  }
  if (!block) return null
  if (!cache.has(block)) cache.set(block, recoverTextOffsets(block, source))
  return cache.get(block)?.get(node) ?? null
}

function positionOffset(node: Element | Text, edge: 'start' | 'end'): number | null {
  const offset = node.position?.[edge].offset
  return typeof offset === 'number' ? offset : null
}

function mappedLeaf(source: string, node: Text, parents: Element[], cache?: OffsetCache): SourceLeaf | null {
  const parent = parents.at(-1)
  const grandparent = parents.at(-2)
  const classes = Array.isArray(parent?.properties.className) ? parent.properties.className : []
  if (classes.some((value) => String(value).includes('math'))) return null
  const codeKind = parent?.tagName === 'code'
    ? grandparent?.tagName === 'pre' ? 'fenced-code' : 'inline-code'
    : 'text'
  const positioned = codeKind === 'fenced-code' ? parent : node
  let start = positioned ? positionOffset(positioned, 'start') : null
  let end = positioned ? positionOffset(positioned, 'end') : null
  if (start === null || end === null) {
    if (codeKind !== 'text' || !cache) return null
    const recovered = recoveredRange(cache, source, node, parents)
    if (!recovered) return null
    start = recovered.start
    end = recovered.end
  }
  return sourceLeaf(source, node.value, start, end, codeKind)
}

function shiftPoint(
  point: { line: number; column: number; offset?: number },
  offset: number,
  direction: 'forward' | 'backward'
): void {
  const delta = Math.abs((point.offset ?? offset) - offset)
  point.offset = offset
  point.column += direction === 'forward' ? delta : -delta
}

function isProjectedCitation(node: RootContent | undefined, citationUrls: ReadonlySet<string>): boolean {
  if (node?.type !== 'element' || node.tagName !== 'a') return false
  const href = String(node.properties.href ?? '')
  return Boolean(href) && (isCitationUrl(href) || citationUrls.has(href))
}

/** Citation labels own their brackets; compact a prose-wrapped run such as `（[1]、[2]）`. */
function unwrapCitationParentheses(
  parent: Root | Element,
  source: string,
  parents: Element[],
  citationUrls: ReadonlySet<string>
): void {
  const childParents = parent.type === 'element' ? [...parents, parent] : parents
  for (const child of parent.children) {
    if (child.type === 'element') {
      unwrapCitationParentheses(child, source, childParents, citationUrls)
    }
  }
  for (let index = 1; index < parent.children.length - 1; index += 1) {
    const previous = parent.children[index - 1]
    const citation = parent.children[index]
    if (previous.type !== 'text' || citation.type !== 'element') continue
    if (!isProjectedCitation(citation, citationUrls)) continue
    const opening = previous.value.at(-1) ?? ''
    const closing = CITATION_PARENTHESES.get(opening)
    if (!closing) continue

    const separatorIndexes: number[] = []
    let closingIndex: number | null = null
    let cursor = index
    while (cursor < parent.children.length - 1) {
      const next = parent.children[cursor + 1]
      if (next.type !== 'text') break
      if (next.value.startsWith(closing)) {
        closingIndex = cursor + 1
        break
      }
      const following = parent.children[cursor + 2]
      if (!CITATION_SEPARATOR.test(next.value) || !isProjectedCitation(following, citationUrls)) break
      separatorIndexes.push(cursor + 1)
      cursor += 2
    }
    if (closingIndex === null) continue

    const next = parent.children[closingIndex]
    if (next.type !== 'text') continue
    const previousLeaf = mappedLeaf(source, previous, childParents)
    const nextLeaf = mappedLeaf(source, next, childParents)
    const previousEnd = previousLeaf?.boundaries.at(-2)
    const nextStart = nextLeaf?.boundaries[1]
    if (previousEnd === null || previousEnd === undefined || nextStart === null || nextStart === undefined) continue
    previous.value = previous.value.slice(0, -opening.length)
    next.value = next.value.slice(closing.length)
    for (const separatorIndex of separatorIndexes) {
      const separator = parent.children[separatorIndex]
      if (separator.type === 'text') separator.value = ''
    }
    if (previous.position) shiftPoint(previous.position.end, previousEnd, 'backward')
    if (next.position) shiftPoint(next.position.start, nextStart, 'forward')
  }
  parent.children = parent.children.filter(child => child.type !== 'text' || child.value.length > 0)
  parent.children = parent.children.filter((child, index, children) => (
    child.type !== 'text'
    || !CITATION_SEPARATOR.test(child.value)
    || !isProjectedCitation(children[index - 1], citationUrls)
    || !isProjectedCitation(children[index + 1], citationUrls)
  ))
}

function element(tagName: string, properties: Record<string, string | number>, children: ElementContent[]): Element {
  return { type: 'element', tagName, properties, children }
}

function activeRanges<T extends Range>(ranges: T[], start: number, end: number): T[] {
  return ranges.filter((range) => range.start < end && range.end > start)
}

function decorateLeaf(node: Text, leaf: SourceLeaf, options: DecorationOptions): ElementContent[] {
  const ranges: Range[] = [
    ...options.evidence.map((annotation) => ({
      id: annotation.claim_ref,
      start: annotation.start_utf16,
      end: annotation.end_utf16
    })),
    ...options.answers.map((annotation) => ({
      id: annotation.id,
      start: annotation.start_utf16,
      end: annotation.end_utf16
    }))
  ]
  const cuts = new Set([0, node.value.length])
  for (let index = 0; index < leaf.boundaries.length; index += 1) {
    const boundary = leaf.boundaries[index]
    if (boundary !== null && ranges.some((range) => range.start === boundary || range.end === boundary)) cuts.add(index)
  }
  const orderedCuts = Array.from(cuts).sort((left, right) => left - right)
  const decorated: ElementContent[] = []
  const terminalAnswers = new Set<string>()
  for (let index = 0; index < orderedCuts.length - 1; index += 1) {
    const displayStart = orderedCuts[index]
    const displayEnd = orderedCuts[index + 1]
    const rawStart = leaf.boundaries[displayStart]
    const rawEnd = leaf.boundaries[displayEnd]
    if (rawStart === null || rawEnd === null || displayEnd <= displayStart) continue
    let child: ElementContent = { type: 'text', value: node.value.slice(displayStart, displayEnd) }
    if (options.sourceMapped) {
      const segment: SourceLeaf = {
        value: node.value.slice(displayStart, displayEnd),
        startUtf16: rawStart,
        endUtf16: rawEnd,
        boundaries: leaf.boundaries.slice(displayStart, displayEnd + 1)
      }
      const boundaries = encodedBoundaries(segment)
      child = element('span', {
        [SOURCE_START]: rawStart,
        [SOURCE_END]: rawEnd,
        ...(boundaries ? { [SOURCE_BOUNDARIES]: boundaries } : {})
      }, [child])
    }
    const evidence = activeRanges(
      options.evidence.map((annotation) => ({ ...annotation, id: annotation.claim_ref, start: annotation.start_utf16, end: annotation.end_utf16 })),
      rawStart,
      rawEnd
    )
    for (const annotation of evidence.slice().reverse()) {
      const terminal = rawEnd === annotation.end
      child = element('span', {
        [EVIDENCE_ID]: annotation.id,
        [EVIDENCE_TERMINAL]: terminal ? 'true' : 'false'
      }, [child])
    }
    const answers = activeRanges(
      options.answers.map((annotation) => ({
        id: annotation.id,
        start: annotation.start_utf16,
        end: annotation.end_utf16,
        focused: annotation.focused
      })),
      rawStart,
      rawEnd
    )
    for (const annotation of answers.slice().reverse()) {
      child = element('mark', {
        className: 'md-answer-annotation',
        [ANSWER_ANNOTATION_ID]: annotation.id,
        ...(annotation.focused ? { [ANSWER_ANNOTATION_FOCUSED]: 'true' } : {})
      }, [child])
      if (rawEnd === annotation.end) terminalAnswers.add(annotation.id)
    }
    decorated.push(child)
    for (const id of terminalAnswers) {
      decorated.push(element('span', { [ANSWER_MARKER]: id }, []))
      terminalAnswers.delete(id)
    }
  }
  return decorated
}

function transformChildren(parent: Root | Element, parents: Element[], options: DecorationOptions, cache: OffsetCache): void {
  const next: ElementContent[] = []
  for (const child of parent.children) {
    if (child.type === 'element') {
      const childParents = [...parents, child]
      transformChildren(child, childParents, options, cache)
      next.push(child as ElementContent)
      continue
    }
    if (child.type !== 'text') {
      if (child.type !== 'doctype') next.push(child)
      continue
    }
    const leaf = mappedLeaf(options.source, child, parents, cache)
    if (!leaf || (!options.sourceMapped && !options.evidence.length && !options.answers.length)) {
      next.push(child)
      continue
    }
    next.push(...decorateLeaf(child, leaf, options))
  }
  parent.children = next
}

/** One post-parse transform owns source mapping, evidence, and answer annotations. */
export function rehypeScholarSeedDecorations(options: DecorationOptions): () => (tree: Root) => void {
  return () => (tree: Root): void => {
    const cache: OffsetCache = new Map()
    unwrapCitationParentheses(tree, options.source, [], options.citationUrls ?? new Set())
    transformChildren(tree, [], options, cache)
  }
}
