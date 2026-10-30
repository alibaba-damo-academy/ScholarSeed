import type { RemarkPluginRaw, Root } from '@milkdown/kit/transformer'
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $remark } from '@milkdown/kit/utils'

const LITERAL_LATEX_LANGUAGE = 'latex-source'
const LATEX_LANGUAGE = 'latex'

export const codeLanguageLabel = (language: string, literalLatexLabel: string): string =>
  language === LITERAL_LATEX_LANGUAGE ? literalLatexLabel : language
const PROTECTED_NODES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])
const LINK_NODES = new Set(['link', 'linkReference'])
interface SyntaxPoint {
  offset?: number
  line?: number
  column?: number
}

interface SyntaxNode {
  type: string
  lang?: string | null
  children?: SyntaxNode[]
  position?: { start: SyntaxPoint; end: SyntaxPoint }
}

interface NormalizedMathSource {
  text: string
  /** Original UTF-16 offset for every normalized offset, including the end sentinel. */
  origins: number[]
}

/** Convert only prose delimiters; original parser offsets protect code and existing math. */
export function normalizeMathSource(source: string, tree: SyntaxNode): NormalizedMathSource {
  const protectedRanges: Array<[number, number]> = []
  const linkRanges: Array<[number, number]> = []
  const collect = (node: SyntaxNode): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (LINK_NODES.has(node.type) && start !== undefined && end !== undefined) {
      linkRanges.push([start, end])
    }
    if (PROTECTED_NODES.has(node.type) && start !== undefined && end !== undefined) {
      protectedRanges.push([start, end])
      return
    }
    node.children?.forEach(collect)
  }
  collect(tree)
  protectedRanges.sort((left, right) => left[0] - right[0])
  const escaped = (offset: number): boolean => {
    let count = 0
    while (offset > 0 && source[--offset] === '\\') count++
    return count % 2 !== 0
  }
  let text = ''
  const origins: number[] = []
  const emit = (value: string, origin: number): void => {
    text += value
    for (let index = 0; index < value.length; index++) origins.push(origin)
  }
  const copy = (start: number, end: number): void => {
    text += source.slice(start, end)
    for (let index = start; index < end; index++) origins.push(index)
  }
  let offset = 0
  let rangeIndex = 0
  while (offset < source.length) {
    while (protectedRanges[rangeIndex]?.[1] <= offset) rangeIndex++
    const range = protectedRanges[rangeIndex]
    if (range && offset >= range[0]) {
      copy(offset, range[1])
      offset = range[1]
      continue
    }
    const opener = source.slice(offset, offset + 2)
    const literalLinkBracket =
      opener === '\\[' && linkRanges.some(([start, end]) => offset >= start && offset < end)
    if ((opener === '\\(' || opener === '\\[') && !escaped(offset) && !literalLinkBracket) {
      const closer = opener === '\\(' ? '\\)' : '\\]'
      let end = source.indexOf(closer, offset + 2)
      while (end >= 0 && escaped(end)) end = source.indexOf(closer, end + 2)
      if (end >= 0 && (!range || end < range[0])) {
        const content = source.slice(offset + 2, end)
        const linePrefix = source.slice(source.lastIndexOf('\n', offset - 1) + 1, offset)
        const lineEnd = source.indexOf('\n', end + 2)
        const lineSuffix = source.slice(end + 2, lineEnd < 0 ? source.length : lineEnd)
        const fenced =
          content.includes('\n') && /^(?:\s*>)*\s*$/.test(linePrefix) && !lineSuffix.trim()
        const inline = opener === '\\('
        const delimiter = inline ? '$' : '$$'
        if (inline || fenced) {
          emit(delimiter, offset)
          copy(offset + 2, end)
          emit(delimiter, end)
        } else {
          const trimmedStart = offset + 2 + (content.length - content.trimStart().length)
          emit(`\n${delimiter}\n`, offset)
          copy(trimmedStart, trimmedStart + content.trim().length)
          emit(`\n${delimiter}\n`, end)
        }
        offset = end + 2
        continue
      }
    }
    copy(offset, offset + 1)
    offset++
  }
  origins.push(source.length)
  return { text, origins }
}

export function normalizeMathDelimiters(source: string, tree: SyntaxNode): string {
  return normalizeMathSource(source, tree).text
}

/** Re-express positions of a tree parsed from normalized text in original source coordinates. */
export function restoreSourcePositions(tree: SyntaxNode, source: string, origins: number[]): void {
  const lineStarts = [0]
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1))
    lineStarts.push(index + 1)
  const restore = (point: SyntaxPoint): void => {
    if (point.offset === undefined) return
    const offset = origins[Math.min(point.offset, origins.length - 1)]
    let line = 0
    let high = lineStarts.length - 1
    while (line < high) {
      const middle = Math.ceil((line + high) / 2)
      if (lineStarts[middle] <= offset) line = middle
      else high = middle - 1
    }
    point.offset = offset
    point.line = line + 1
    point.column = offset - lineStarts[line] + 1
  }
  const visit = (node: SyntaxNode): void => {
    if (node.position) {
      restore(node.position.start)
      restore(node.position.end)
    }
    node.children?.forEach(visit)
  }
  visit(tree)
}

/** Runs before Markdown escapes are consumed, using the native parser for code boundaries. */
export function mathCompatibility(this: ThisParameterType<RemarkPluginRaw<unknown>>): void {
  const parse = this.parser
  if (!parse) throw new Error('Markdown parser is required for math compatibility')
  this.parser = (source, file) => {
    const original = parse(source, file) as Root
    const normalized = normalizeMathSource(source, original)
    let tree = original
    if (normalized.text !== source) {
      tree = parse(normalized.text, file) as Root
      // Downstream parsers and selection mapping address the original file, not the rewrite.
      restoreSourcePositions(tree, source, normalized.origins)
    }
    // Native Crepe serializes all LaTeX code blocks as math. Preserve literal fences.
    const protectCode = (node: SyntaxNode): void => {
      if (node.type === 'code' && node.lang?.toLowerCase() === LATEX_LANGUAGE) {
        Object.assign(node, { literalLanguage: node.lang, lang: LITERAL_LATEX_LANGUAGE })
      }
      node.children?.forEach(protectCode)
    }
    protectCode(tree)
    return tree
  }
}

export const mathCompatibilityPlugin = $remark(
  'workbenchMathCompatibility',
  () => mathCompatibility
)

export const literalLatexSchema = codeBlockSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, literalLanguage: { default: null } },
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (state, node, type) => {
        state.openNode(type, {
          language: node.lang ?? '',
          literalLanguage: node.literalLanguage ?? null,
        })
        if (node.value) state.addText(node.value as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      ...base.toMarkdown,
      runner: (state, node) => {
        if (node.attrs.language === LITERAL_LATEX_LANGUAGE && node.attrs.literalLanguage) {
          state.addNode('code', undefined, node.textContent, { lang: node.attrs.literalLanguage })
        } else if (String(node.attrs.language).toLowerCase() === LATEX_LANGUAGE) {
          state.addNode('math', undefined, node.textContent)
        } else {
          base.toMarkdown.runner(state, node)
        }
      },
    },
  }
})

const CODE_BLOCK_SELECTOR = '.milkdown-code-block'
const CODE_EDITOR_SELECTOR = '.codemirror-host'
const PREVIEW_SELECTOR = '.preview-panel'
const PREVIEW_TOGGLE_SELECTOR = '.preview-toggle-button'

function mathNodeForBlock(block: HTMLElement, view: EditorView): ProseNode | null {
  try {
    const position = view.posAtDOM(block, 0)
    const direct = view.state.doc.nodeAt(position)
    if (direct?.type.name === 'code_block') return direct
    const resolved = view.state.doc.resolve(position)
    for (let depth = resolved.depth; depth >= 0; depth--) {
      const ancestor = resolved.node(depth)
      if (ancestor.type.name === 'code_block') return ancestor
    }
    if (resolved.nodeAfter?.type.name === 'code_block') return resolved.nodeAfter
    if (resolved.nodeBefore?.type.name === 'code_block') return resolved.nodeBefore
  } catch {
    return null
  }
  return null
}

/** Coordinate native CodeMirror previews so block math has one focused editor. */
export function installMathBlockInteraction(root: HTMLElement, view: EditorView): () => void {
  let expanded: HTMLElement | null = null
  const isMathBlock = (block: HTMLElement): boolean => {
    const node = mathNodeForBlock(block, view)
    if (node)
      return (
        String(node.attrs.language).toLowerCase() === LATEX_LANGUAGE && !node.attrs.literalLanguage
      )
    const language = block.querySelector('.language-button')?.firstChild?.textContent?.trim()
    return language?.toLowerCase() === LATEX_LANGUAGE
  }
  const synchronizeBlocks = (): void => {
    root.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTOR).forEach((block) => {
      if (isMathBlock(block)) {
        block.dataset.mathBlock = 'true'
        block.dataset.mathExpanded = String(
          !block.querySelector(CODE_EDITOR_SELECTOR)?.classList.contains('hidden')
        )
      } else {
        delete block.dataset.mathBlock
        delete block.dataset.mathExpanded
      }
    })
    if (expanded && !expanded.isConnected) expanded = null
  }
  const setExpanded = (block: HTMLElement, next: boolean): void => {
    const editor = block.querySelector<HTMLElement>(CODE_EDITOR_SELECTOR)
    const toggle = block.querySelector<HTMLButtonElement>(PREVIEW_TOGGLE_SELECTOR)
    if (!editor || !toggle || editor.classList.contains('hidden') === !next) {
      block.dataset.mathExpanded = String(next)
      return
    }
    toggle.click()
    block.dataset.mathExpanded = String(next)
  }
  const closeExpanded = (): void => {
    if (!expanded) return
    setExpanded(expanded, false)
    expanded = null
  }
  const open = (block: HTMLElement): void => {
    if (expanded && expanded !== block) closeExpanded()
    setExpanded(block, true)
    expanded = block
    requestAnimationFrame(() => block.querySelector<HTMLElement>('.cm-content')?.focus())
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element)) return
    const block = event.target.closest<HTMLElement>(CODE_BLOCK_SELECTOR)
    if (block && isMathBlock(block) && event.target.closest(PREVIEW_SELECTOR)) {
      event.preventDefault()
      open(block)
      return
    }
    if (expanded && (!block || block !== expanded)) closeExpanded()
  }
  const onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const toggle = event.target.closest(PREVIEW_TOGGLE_SELECTOR)
    const block = toggle?.closest<HTMLElement>(CODE_BLOCK_SELECTOR)
    if (!block || !isMathBlock(block)) return
    requestAnimationFrame(() => {
      const isOpen = !block.querySelector(CODE_EDITOR_SELECTOR)?.classList.contains('hidden')
      if (!isOpen) {
        if (expanded === block) expanded = null
        block.dataset.mathExpanded = 'false'
        return
      }
      if (expanded && expanded !== block) closeExpanded()
      expanded = block
      block.dataset.mathExpanded = 'true'
    })
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!expanded) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeExpanded()
      view.focus()
    }
  }
  const observer = new MutationObserver(synchronizeBlocks)
  observer.observe(root, { childList: true, subtree: true })
  synchronizeBlocks()
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    observer.disconnect()
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }
}
