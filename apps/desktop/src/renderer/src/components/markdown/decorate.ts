import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

import type { EvidenceAnnotation } from '../../model'
import {
  CITATION_MARKER,
  CITATION_PENDING,
  REFERENCE_LABEL,
  citationReferences,
  citationText,
  isCitationLink,
  streamingReferenceEnd,
  streamingReferenceStart,
  type MarkdownCitationReference,
} from './citations.ts'
import { encodedBoundaries, sourceLeaf, type SourceLeaf } from './source.ts'

const CITATION_PARENTHESES = new Map([
  ['(', ')'],
  ['（', '）'],
])
const CITATION_SEPARATOR = /^[\t \u00a0、,，]+$/
const CITATION_EXCLUDED_TAGS = new Set(['code', 'pre', 'a'])
const STREAMING_URL = /\bhttps?:\/{0,2}[^\s<>，。；！？、）]*|\bwww\.[^\s<>，。；！？、）]*/g
const RAW_URL_LABEL = /^(?:https?:|www\.)/
const ESCAPED_LINK_PREFIX = /\\\[[^\]\n]*\]\($/
const EXPLICIT_REFERENCE = /^(?:\[[0-9]+\][\t ]*)+$/
const INLINE_REFERENCE_GAP = /^[\t ]*$/
const CITATION_STYLE_TAGS = new Set(['strong', 'em'])
const CITATION_TABLE_CONTAINERS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr'])
const CITATION_TABLE_CELLS = new Set(['td', 'th'])
const SOURCE_LINK_EXCLUDED_TAGS = new Set(['a', 'pre', 'script', 'style'])
const SOURCE_PATH =
  /(?:[a-z]:[\\/]|\/|(?<![\p{L}\p{N}_.-])(?:\.\/?[\\/])?[\p{L}\p{N}_.-]+[\\/])[^\s<>"'`，。；！？、（）()[\]{}]+/giu
const SOURCE_PATH_PUNCTUATION = /[.,;!?]+$/

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

export interface MarkdownCitationOccurrence {
  href: string
  end_utf16: number
}

interface DecorationOptions {
  source: string
  sourceMapped: boolean
  citationUrls?: ReadonlySet<string>
  citationReferences?: readonly MarkdownCitationReference[]
  citationOccurrences?: readonly MarkdownCitationOccurrence[]
  citationPending?: boolean
  evidence: EvidenceAnnotation[]
  answers: MarkdownAnswerAnnotation[]
  isSourceLink?: (href: string) => boolean
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

function mappedLeaf(
  source: string,
  node: Text,
  parents: Element[],
  cache?: OffsetCache
): SourceLeaf | null {
  const parent = parents.at(-1)
  const grandparent = parents.at(-2)
  const classes = Array.isArray(parent?.properties.className) ? parent.properties.className : []
  if (classes.some((value) => String(value).includes('math'))) return null
  const codeKind =
    parent?.tagName === 'code'
      ? grandparent?.tagName === 'pre'
        ? 'fenced-code'
        : 'inline-code'
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

function isProjectedCitation(node: RootContent | undefined): boolean {
  return node?.type === 'element' && Boolean(node.properties[CITATION_MARKER])
}

interface CitationContext {
  urls: ReadonlySet<string>
  references: ReadonlyMap<string, string>
  partialStart: number | undefined
  partialEnd: number | undefined
}

function sourcePoint(
  source: string,
  offset: number
): { line: number; column: number; offset: number } {
  const prefix = source.slice(0, offset)
  return { line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n'), offset }
}

function citationTextSlice(
  node: Text,
  source: string,
  leaf: SourceLeaf,
  start: number,
  end: number
): Text {
  return {
    ...node,
    value: node.value.slice(start, end),
    position: {
      start: sourcePoint(source, leaf.boundaries[start] ?? leaf.startUtf16),
      end: sourcePoint(source, leaf.boundaries[end] ?? leaf.endUtf16),
    },
  }
}

function markCitations(
  parent: Root | Element,
  parents: Element[],
  options: DecorationOptions,
  cache: OffsetCache,
  context: CitationContext
): void {
  if (parent.type === 'element' && CITATION_EXCLUDED_TAGS.has(parent.tagName)) return
  const { urls, references, partialStart, partialEnd } = context
  const next: ElementContent[] = []
  for (const child of parent.children) {
    if (child.type === 'element') {
      const start = positionOffset(child, 'start')
      const end = positionOffset(child, 'end')
      if (
        partialStart !== undefined &&
        partialEnd !== undefined &&
        start !== null &&
        end !== null &&
        start > partialStart &&
        end <= partialEnd
      )
        continue
      if (
        isCitationLink(child, urls, Boolean(options.citationPending)) &&
        !(start !== null && ESCAPED_LINK_PREFIX.test(options.source.slice(0, start)))
      ) {
        child.properties[CITATION_MARKER] = true
        if (options.citationPending) child.properties[CITATION_PENDING] = true
      } else {
        markCitations(child, [...parents, child], options, cache, context)
      }
      next.push(child)
      continue
    }
    if (child.type !== 'text') {
      if (child.type !== 'doctype') next.push(child)
      continue
    }
    const leaf = mappedLeaf(options.source, child, parents, cache)
    if (!leaf) {
      next.push(child)
      continue
    }
    if (
      partialStart !== undefined &&
      partialEnd !== undefined &&
      partialStart < leaf.endUtf16 &&
      partialEnd > leaf.startUtf16
    ) {
      const displayStart = leaf.boundaries.indexOf(Math.max(partialStart, leaf.startUtf16))
      const displayEnd = leaf.boundaries.indexOf(Math.min(partialEnd, leaf.endUtf16))
      if (displayStart >= 0 && displayEnd >= 0) {
        next.push(...citationTextNodes(child, options.source, leaf, references, 0, displayStart))
        if (partialStart >= leaf.startUtf16)
          next.push(element('span', { [CITATION_PENDING]: 'true' }, []))
        next.push(
          ...citationTextNodes(
            child,
            options.source,
            leaf,
            references,
            displayEnd,
            child.value.length
          )
        )
        continue
      }
    }
    next.push(...citationTextNodes(child, options.source, leaf, references, 0, child.value.length))
  }
  parent.children = next
}

function citationTextNodes(
  child: Text,
  source: string,
  leaf: SourceLeaf,
  references: ReadonlyMap<string, string>,
  from: number,
  to: number
): ElementContent[] {
  const next: ElementContent[] = []
  let cursor = from
  for (const match of child.value.matchAll(REFERENCE_LABEL)) {
    if (match.index < from || match.index + match[0].length > to) continue
    const href = references.get(match[1])
    const start = leaf.boundaries[match.index]
    const end = leaf.boundaries[match.index + match[0].length]
    if (
      !href ||
      start === null ||
      start === undefined ||
      end === null ||
      end === undefined ||
      source.slice(start, end) !== match[0] ||
      source[start - 1] === '\\'
    )
      continue
    next.push(citationTextSlice(child, source, leaf, cursor, match.index))
    next.push({
      type: 'element',
      tagName: 'a',
      properties: { href, [CITATION_MARKER]: true },
      children: [{ type: 'text', value: match[1] }],
      position: { start: sourcePoint(source, start), end: sourcePoint(source, end) },
    })
    cursor = match.index + match[0].length
  }
  if (cursor < to)
    next.push(
      cursor === 0 && to === child.value.length
        ? child
        : citationTextSlice(child, source, leaf, cursor, to)
    )
  return next
}

function tableCitationHost(node: Element): Element | undefined {
  if (CITATION_TABLE_CELLS.has(node.tagName)) return node
  if (!CITATION_TABLE_CONTAINERS.has(node.tagName)) return undefined
  for (const child of [...node.children].reverse()) {
    if (child.type !== 'element') continue
    const host = tableCitationHost(child)
    if (host) return host
  }
  return undefined
}

function markNativeCitations(
  parent: Root | Element,
  parents: Element[],
  options: DecorationOptions,
  cache: OffsetCache,
  pending: MarkdownCitationOccurrence[]
): void {
  const next: ElementContent[] = []
  const take = (offset: number): Element[] => {
    const matches = pending.filter((occurrence) => occurrence.end_utf16 === offset)
    for (const match of matches) pending.splice(pending.indexOf(match), 1)
    return matches.map(({ href }) => ({
      type: 'element',
      tagName: 'a',
      properties: { href, [CITATION_MARKER]: true },
      children: [],
      position: {
        start: sourcePoint(options.source, offset),
        end: sourcePoint(options.source, offset),
      },
    }))
  }
  for (const child of parent.children) {
    if (child.type === 'element') {
      if (!CITATION_EXCLUDED_TAGS.has(child.tagName))
        markNativeCitations(child, [...parents, child], options, cache, pending)
      next.push(child)
      const end = positionOffset(child, 'end')
      if (isProjectedCitation(child) && end !== null) {
        for (const occurrence of [...pending]) {
          if (occurrence.href === child.properties.href && occurrence.end_utf16 === end)
            pending.splice(pending.indexOf(occurrence), 1)
        }
      }
      if (end !== null && child.tagName !== 'pre') {
        const host = tableCitationHost(child)
        if (host) host.children.push(...take(end))
        else if (!CITATION_TABLE_CONTAINERS.has(child.tagName)) next.push(...take(end))
      }
    } else if (child.type === 'text') {
      const leaf = mappedLeaf(options.source, child, parents, cache)
      if (!leaf) {
        next.push(child)
        continue
      }
      let cursor = 0
      const offsets = [...new Set(pending.map((occurrence) => occurrence.end_utf16))].sort(
        (left, right) => left - right
      )
      for (const offset of offsets) {
        if (offset <= leaf.startUtf16 || offset > leaf.endUtf16) continue
        const boundary = leaf.boundaries.indexOf(offset)
        if (boundary < 0) continue
        next.push(citationTextSlice(child, options.source, leaf, cursor, boundary), ...take(offset))
        cursor = boundary
      }
      if (cursor < child.value.length)
        next.push(
          cursor
            ? citationTextSlice(child, options.source, leaf, cursor, child.value.length)
            : child
        )
    } else if (child.type !== 'doctype') next.push(child)
  }
  parent.children = next
}

function compactCitationEntries(parent: Root | Element, source: string): void {
  const next: ElementContent[] = []
  for (let child of parent.children) {
    if (child.type === 'doctype') continue
    if (child.type === 'element') {
      if (!CITATION_EXCLUDED_TAGS.has(child.tagName)) compactCitationEntries(child, source)
      if (CITATION_STYLE_TAGS.has(child.tagName) && child.children.length === 1) {
        const nested = child.children[0]
        if (nested.type === 'element' && isProjectedCitation(nested)) {
          child = { ...nested, position: child.position }
        }
      }
      const gap = next.at(-1)
      const hasGap = gap?.type === 'text' && INLINE_REFERENCE_GAP.test(gap.value)
      const reference = hasGap ? next.at(-2) : gap
      if (
        isProjectedCitation(child) &&
        reference?.type === 'element' &&
        isProjectedCitation(reference) &&
        reference.properties.href === child.properties.href &&
        reference.position &&
        child.position &&
        (citationText(child) === child.properties.href ||
          EXPLICIT_REFERENCE.test(
            source.slice(child.position.start.offset, child.position.end.offset)
          ) ||
          /^\d+$/.test(citationText(child))) &&
        (EXPLICIT_REFERENCE.test(
          source.slice(reference.position.start.offset, reference.position.end.offset)
        ) ||
          /^\d+$/.test(citationText(reference)) ||
          citationText(reference) === reference.properties.href)
      ) {
        reference.position.end = child.position.end
        if (hasGap) next.pop()
        continue
      }
    }
    next.push(child)
  }
  parent.children = next
}

function containsPendingCitation(node: RootContent): boolean {
  return (
    node.type === 'element' &&
    (Boolean(node.properties[CITATION_PENDING]) || node.children.some(containsPendingCitation))
  )
}

function markPendingUrls(
  parent: Root | Element,
  parents: Element[],
  options: DecorationOptions,
  cache: OffsetCache
): void {
  if (
    parent.type === 'element' &&
    CITATION_EXCLUDED_TAGS.has(parent.tagName) &&
    !(parent.tagName === 'a' && RAW_URL_LABEL.test(citationText(parent)))
  )
    return
  const next: ElementContent[] = []
  for (const child of parent.children) {
    if (child.type === 'element') {
      markPendingUrls(child, [...parents, child], options, cache)
      if (child.tagName === 'a' && containsPendingCitation(child)) next.push(...child.children)
      else next.push(child)
    } else if (child.type === 'text') {
      const leaf = mappedLeaf(options.source, child, parents, cache)
      if (!leaf) {
        next.push(child)
        continue
      }
      let cursor = 0
      for (const match of child.value.matchAll(STREAMING_URL)) {
        const start = leaf.boundaries[match.index]
        const end = leaf.boundaries[match.index + match[0].length]
        if (start === null || start === undefined || end === null || end === undefined) continue
        if (ESCAPED_LINK_PREFIX.test(options.source.slice(0, start))) continue
        next.push(citationTextSlice(child, options.source, leaf, cursor, match.index))
        next.push({
          ...element('span', { [CITATION_PENDING]: 'true' }, []),
          position: {
            start: sourcePoint(options.source, start),
            end: sourcePoint(options.source, end),
          },
        })
        cursor = match.index + match[0].length
      }
      if (cursor < child.value.length)
        next.push(
          cursor
            ? citationTextSlice(child, options.source, leaf, cursor, child.value.length)
            : child
        )
    } else if (child.type !== 'doctype') next.push(child)
  }
  parent.children = next
}

/** Citation labels own their brackets; compact a prose-wrapped run such as `（[1]、[2]）`. */
function unwrapCitationParentheses(
  parent: Root | Element,
  source: string,
  parents: Element[]
): void {
  const childParents = parent.type === 'element' ? [...parents, parent] : parents
  for (const child of parent.children) {
    if (child.type === 'element') {
      unwrapCitationParentheses(child, source, childParents)
    }
  }
  for (let index = 1; index < parent.children.length - 1; index += 1) {
    const previous = parent.children[index - 1]
    const citation = parent.children[index]
    if (previous.type !== 'text' || citation.type !== 'element') continue
    if (!isProjectedCitation(citation)) continue
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
      if (!CITATION_SEPARATOR.test(next.value) || !isProjectedCitation(following)) break
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
    if (
      previousEnd === null ||
      previousEnd === undefined ||
      nextStart === null ||
      nextStart === undefined
    )
      continue
    previous.value = previous.value.slice(0, -opening.length)
    next.value = next.value.slice(closing.length)
    for (const separatorIndex of separatorIndexes) {
      const separator = parent.children[separatorIndex]
      if (separator.type === 'text') separator.value = ''
    }
    if (previous.position) shiftPoint(previous.position.end, previousEnd, 'backward')
    if (next.position) shiftPoint(next.position.start, nextStart, 'forward')
  }
  parent.children = parent.children.filter(
    (child) => child.type !== 'text' || child.value.length > 0
  )
  parent.children = parent.children.filter(
    (child, index, children) =>
      child.type !== 'text' ||
      !CITATION_SEPARATOR.test(child.value) ||
      !isProjectedCitation(children[index - 1]) ||
      !isProjectedCitation(children[index + 1])
  )
}

function element(
  tagName: string,
  properties: Record<string, string | number>,
  children: ElementContent[]
): Element {
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
      end: annotation.end_utf16,
    })),
    ...options.answers.map((annotation) => ({
      id: annotation.id,
      start: annotation.start_utf16,
      end: annotation.end_utf16,
    })),
  ]
  const cuts = new Set([0, node.value.length])
  for (let index = 0; index < leaf.boundaries.length; index += 1) {
    const boundary = leaf.boundaries[index]
    if (
      boundary !== null &&
      ranges.some((range) => range.start === boundary || range.end === boundary)
    )
      cuts.add(index)
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
        boundaries: leaf.boundaries.slice(displayStart, displayEnd + 1),
      }
      const boundaries = encodedBoundaries(segment)
      child = element(
        'span',
        {
          [SOURCE_START]: rawStart,
          [SOURCE_END]: rawEnd,
          ...(boundaries ? { [SOURCE_BOUNDARIES]: boundaries } : {}),
        },
        [child]
      )
    }
    const evidence = activeRanges(
      options.evidence.map((annotation) => ({
        ...annotation,
        id: annotation.claim_ref,
        start: annotation.start_utf16,
        end: annotation.end_utf16,
      })),
      rawStart,
      rawEnd
    )
    for (const annotation of evidence.slice().reverse()) {
      const terminal = rawEnd === annotation.end
      child = element(
        'span',
        {
          [EVIDENCE_ID]: annotation.id,
          [EVIDENCE_TERMINAL]: terminal ? 'true' : 'false',
        },
        [child]
      )
    }
    const answers = activeRanges(
      options.answers.map((annotation) => ({
        id: annotation.id,
        start: annotation.start_utf16,
        end: annotation.end_utf16,
        focused: annotation.focused,
      })),
      rawStart,
      rawEnd
    )
    for (const annotation of answers.slice().reverse()) {
      child = element(
        'mark',
        {
          className: 'md-answer-annotation',
          [ANSWER_ANNOTATION_ID]: annotation.id,
          ...(annotation.focused ? { [ANSWER_ANNOTATION_FOCUSED]: 'true' } : {}),
        },
        [child]
      )
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

function markSourceLinks(
  parent: Root | Element,
  parents: Element[],
  options: DecorationOptions,
  cache: OffsetCache
): void {
  const accepts = options.isSourceLink
  if (!accepts) return
  const next: ElementContent[] = []
  for (const child of parent.children) {
    if (child.type === 'element') {
      const classes = child.properties.className
      if (
        SOURCE_LINK_EXCLUDED_TAGS.has(child.tagName) ||
        (Array.isArray(classes) && classes.some((value) => String(value).includes('math')))
      ) {
        next.push(child)
        continue
      }
      if (child.tagName === 'code') {
        const value =
          child.children.length === 1 && child.children[0].type === 'text'
            ? child.children[0].value
            : null
        next.push(
          value && accepts(value)
            ? { ...element('a', { href: value }, [child]), position: child.position }
            : child
        )
        continue
      }
      markSourceLinks(child, [...parents, child], options, cache)
      next.push(child)
      continue
    }
    if (child.type !== 'text') {
      if (child.type !== 'doctype') next.push(child)
      continue
    }
    const leaf = mappedLeaf(options.source, child, parents, cache)
    if (!leaf) {
      next.push(child)
      continue
    }
    let cursor = 0
    for (const match of child.value.matchAll(SOURCE_PATH)) {
      const href = match[0].replace(SOURCE_PATH_PUNCTUATION, '')
      if (!accepts(href)) continue
      if (match.index > cursor)
        next.push(citationTextSlice(child, options.source, leaf, cursor, match.index))
      const end = match.index + href.length
      const label = citationTextSlice(child, options.source, leaf, match.index, end)
      next.push({ ...element('a', { href }, [label]), position: label.position })
      cursor = end
    }
    if (cursor < child.value.length)
      next.push(citationTextSlice(child, options.source, leaf, cursor, child.value.length))
  }
  parent.children = next
}

function transformChildren(
  parent: Root | Element,
  parents: Element[],
  options: DecorationOptions,
  cache: OffsetCache
): void {
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
export function rehypeScholarSeedDecorations(
  options: DecorationOptions
): () => (tree: Root) => void {
  return () =>
    (tree: Root): void => {
      const cache: OffsetCache = new Map()
      if (options.citationPending) markPendingUrls(tree, [], options, cache)
      const candidate = options.citationPending
        ? streamingReferenceStart(options.source)
        : undefined
      const partialStart =
        candidate !== undefined && options.source[candidate - 1] !== '\\' ? candidate : undefined
      markCitations(tree, [], options, cache, {
        urls: options.citationUrls ?? new Set(),
        references: citationReferences(options.citationReferences ?? []),
        partialStart,
        partialEnd:
          partialStart === undefined
            ? undefined
            : streamingReferenceEnd(options.source, partialStart),
      })
      compactCitationEntries(tree, options.source)
      unwrapCitationParentheses(tree, options.source, [])
      const occurrences = (options.citationOccurrences ?? []).filter(
        (occurrence, index, all) =>
          options.citationUrls?.has(occurrence.href) &&
          Number.isInteger(occurrence.end_utf16) &&
          occurrence.end_utf16 > 0 &&
          occurrence.end_utf16 <= options.source.length &&
          all.findIndex(
            (other) => other.href === occurrence.href && other.end_utf16 === occurrence.end_utf16
          ) === index
      )
      if (occurrences.length) markNativeCitations(tree, [], options, cache, [...occurrences])
      markSourceLinks(tree, [], options, cache)
      transformChildren(tree, [], options, cache)
    }
}
