import { strFromU8, unzipSync } from 'fflate'

import type { SelectionLocator } from '../../../contracts/workbench'

export interface PreviewSelection {
  locator: SelectionLocator
  text: string
  rect: DOMRect
}

export interface TextAnchor {
  element: HTMLElement
  fragments?: HTMLElement[]
  ignored?: HTMLElement[]
  text: string
  locator: SelectionLocator
}

/** Only the pinned PPTX renderer's generated marker can be excluded from source text. */
export function slideMarkers(element: HTMLElement, paragraphs: string[]): HTMLElement[] {
  const rendered = Array.from(element.querySelectorAll<HTMLElement>('div')).filter((node) =>
    node.style.width === '100%' && node.style.minWidth === '0px' && node.style.maxWidth === '100%'
    && node.style.boxSizing === 'border-box' && node.style.overflowWrap === 'anywhere')
  if (rendered.length !== paragraphs.length) return []
  return rendered.flatMap((paragraph, index) => {
    const marker = paragraph.firstElementChild
    if (!(marker instanceof HTMLElement) || marker.tagName !== 'SPAN' || marker.children.length
      || !marker.style.fontSize || !marker.style.color || !marker.textContent?.endsWith(' ')) return []
    const expected = paragraphs[index].replace(/[\n\v]/g, '')
    const text = paragraph.textContent ?? ''
    // A normal run cannot pass this check: removing it would remove authoritative text.
    return text !== expected && text.slice(marker.textContent.length) === expected ? [marker] : []
  })
}

function domText(root: Node, ignored: HTMLElement[], range?: Range): string {
  const nodes: Node[] = []
  if (root.nodeType === Node.TEXT_NODE) nodes.push(root)
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node)
  }
  return nodes.filter((node) => !ignored.some((element) => element.contains(node)) && (!range || range.intersectsNode(node)))
    .map((node) => (node.textContent ?? '').slice(range?.startContainer === node ? range.startOffset : 0, range?.endContainer === node ? range.endOffset : undefined)).join('')
}

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const PARAGRAPH_CLASS = 'scholarseed-paragraph-'
const WORD_PART = 'word/document.xml'

/** Parse only the part needed for identity; rendered text is never the source of authority. */
export function wordParagraphs(bytes: Uint8Array): { body: Element; paragraphs: Element[] } {
  const parts = unzipSync(bytes, { filter: (entry) => entry.name === WORD_PART })
  const source = parts[WORD_PART]
  if (!source) throw new Error('Missing Word document part')
  const document = new DOMParser().parseFromString(strFromU8(source), 'application/xml')
  const body = document.getElementsByTagNameNS(WORD_NAMESPACE, 'body')[0]
  if (!body || document.querySelector('parsererror')) throw new Error('Invalid Word document')
  return { body, paragraphs: Array.from(body.children).filter((item) => item.localName === 'p') }
}

/** Matches python-docx paragraph.text: runs/hyperlinks, tabs and text-wrapping breaks. */
export function wordText(paragraph: Element): string {
  const runs = Array.from(paragraph.children).flatMap((child) => child.localName === 'r'
    ? [child]
    : child.localName === 'hyperlink' ? Array.from(child.children).filter((run) => run.localName === 'r') : [])
  return runs.flatMap((run) => Array.from(run.children).map((child) => {
    if (child.localName === 't') return child.textContent ?? ''
    if (child.localName === 'tab') return '\t'
    if (child.localName === 'cr') return '\n'
    if (child.localName === 'br' && (!child.getAttributeNS(WORD_NAMESPACE, 'type') || child.getAttributeNS(WORD_NAMESPACE, 'type') === 'textWrapping')) return '\n'
    return ''
  })).join('')
}

interface WordNode { type: string; className?: string; children?: WordNode[] }

/** docx-preview flattens content controls. Walk that same structure, but number only body paragraphs. */
export function markWordParagraphs(body: Element, model: WordNode[]): void {
  let cursor = 0
  let paragraph = 0
  const walk = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (child.localName === 'sdt') {
        const content = Array.from(child.children).find((entry) => entry.localName === 'sdtContent')
        if (content) walk(content)
      } else if (['p', 'tbl', 'altChunk'].includes(child.localName)) {
        const node = model[cursor++]
        if (parent === body && child.localName === 'p') {
          paragraph++
          if (node?.type !== 'paragraph') throw new Error('Word paragraph mapping mismatch')
          node.className = [node.className, `${PARAGRAPH_CLASS}${paragraph}`].filter(Boolean).join(' ')
        }
      }
    }
  }
  walk(body)
}

export function wordAnchors(root: HTMLElement, paragraphs: Element[]): TextAnchor[] {
  return paragraphs.flatMap((paragraph, index) => {
    const elements = root.querySelectorAll<HTMLElement>(`.${PARAGRAPH_CLASS}${index + 1}`)
    if (!elements.length) return []
    return [{ element: elements[0], fragments: Array.from(elements), text: wordText(paragraph), locator: {
      kind: 'writer' as const, format: 'docx' as const, paragraph: `paragraph-${index + 1}`, start: 0, end: 0
    } }]
  })
}

/** Map a DOM endpoint through the whole anchor's text, rejecting altered/generated text. */
function contains(anchor: TextAnchor, node: Node): boolean {
  return (anchor.fragments ?? [anchor.element]).some((element) => element.contains(node))
}

function sourceOffset(anchor: TextAnchor, node: Node, offset: number, start: boolean): number | null {
  const fragments = anchor.fragments ?? [anchor.element]
  const fragmentIndex = fragments.findIndex((element) => element.contains(node))
  if (fragmentIndex < 0) return null
  const prefix = document.createRange()
  prefix.selectNodeContents(fragments[fragmentIndex])
  prefix.setEnd(node, offset)
  const ignored = anchor.ignored ?? []
  if (ignored.some((element) => element.contains(node))) return null
  const rendered = fragments.map((element) => domText(element, ignored)).join('')
  const before = fragments.slice(0, fragmentIndex).reduce((sum, element) => sum + domText(element, ignored).length, 0) + domText(prefix.commonAncestorContainer, ignored, prefix).length
  const expected = anchor.locator.kind === 'writer' ? anchor.text.replace(/\t/g, '\u2003') : anchor.text
  if (rendered === expected) return before
  // HTML block/BR boundaries do not contribute to textContent; source keeps its logical breaks.
  const compact = expected.replace(/[\n\v]/g, '')
  if (rendered !== compact) return null
  let consumed = 0
  for (let index = 0; index < anchor.text.length; index++) {
    if (consumed === before && (!start || (anchor.text[index] !== '\n' && anchor.text[index] !== '\v'))) return index
    if (anchor.text[index] !== '\n' && anchor.text[index] !== '\v') consumed++
  }
  return consumed === before ? anchor.text.length : null
}

export function textSelection(range: Range, anchors: TextAnchor[]): PreviewSelection | null {
  if (range.collapsed) return null
  // Native dragging can end in the blank page margin, whose endpoint is a section/article.
  // Resolve only intersected source anchors; the text equality check below still rejects
  // unmodelled table/header/footer content inside the selected DOM range.
  const intersected = anchors.filter((anchor) => (anchor.fragments ?? [anchor.element]).some((element) => range.intersectsNode(element)))
  const first = anchors.find((anchor) => contains(anchor, range.startContainer)) ?? intersected[0]
  const last = anchors.find((anchor) => contains(anchor, range.endContainer)) ?? intersected.at(-1)
  if (!first || !last) return null
  const start = contains(first, range.startContainer) ? sourceOffset(first, range.startContainer, range.startOffset, true) : 0
  const end = contains(last, range.endContainer) ? sourceOffset(last, range.endContainer, range.endOffset, false) : last.text.length
  if (start === null || end === null) return null
  if (first === last) {
    if (first.locator.kind !== 'writer' && first.locator.kind !== 'impress') return null
    const text = first.text.slice(start, end)
    const expected = first.locator.kind === 'writer' ? text.replace(/\t/g, '\u2003') : text
    if (domText(range.commonAncestorContainer, first.ignored ?? [], range).replace(/[\n\v]/g, '') !== expected.replace(/[\n\v]/g, '')) return null
    return text ? { text, locator: { ...first.locator, start, end }, rect: range.getBoundingClientRect() } : null
  }
  if (first.locator.kind !== 'writer' || last.locator.kind !== 'writer') return null
  const from = anchors.indexOf(first)
  const to = anchors.indexOf(last)
  const covered = anchors.slice(from, to + 1)
  const firstNumber = Number(first.locator.paragraph.split('-')[1])
  const lastNumber = Number(last.locator.paragraph.split('-')[1])
  if (covered.length !== lastNumber - firstNumber + 1) return null
  const text = covered.map((anchor, index) => anchor.text.slice(index === 0 ? start : 0, index === covered.length - 1 ? end : undefined)).join('\n')
  if (range.toString().replace(/[\n\v]/g, '') !== text.replace(/\t/g, '\u2003').replace(/[\n\v]/g, '')) return null
  return { text, locator: { ...first.locator, end_paragraph: last.locator.paragraph, start, end }, rect: range.getBoundingClientRect() }
}
