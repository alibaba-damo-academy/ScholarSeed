import type { Construct } from 'micromark-util-types'
import type {} from 'remark-parse'
import remarkMath from 'remark-math'
import type { Processor } from 'unified'
import type { Element, ElementContent, Root } from 'hast'

export const FORMULA_SOURCE = 'data-conversation-formula'
export const INLINE_FORMULA_SOURCE = 'data-conversation-inline-formula'
const DOUBLE_DOLLAR = '$$'

function inlineMathCode(
  node: ElementContent | undefined
): node is Element & { properties: { className: Array<string | number> } } {
  return (
    node?.type === 'element' &&
    node.tagName === 'code' &&
    Array.isArray(node.properties.className) &&
    node.properties.className.includes('math-inline') &&
    node.children.every((child) => child.type === 'text')
  )
}

function formulaBlock(node: Element, source: string): Element {
  return {
    ...node,
    tagName: 'div',
    properties: { ...node.properties, [FORMULA_SOURCE]: source },
    children: [],
  }
}

function mathText(node: Element): string {
  return node.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
}

function standaloneDisplayMath(node: ElementContent, source: string): node is Element {
  if (!inlineMathCode(node) || !node.position) return false
  const { start, end } = node.position
  if (start.offset === undefined || end.offset === undefined) return false
  return (
    source.startsWith(DOUBLE_DOLLAR, start.offset) &&
    source.startsWith(DOUBLE_DOLLAR, end.offset - DOUBLE_DOLLAR.length) &&
    /^[\t ]*$/.test(source.slice(start.offset - start.column + 1, start.offset)) &&
    /^[\t ]*(?:\r\n?|\n|$)/.test(source.slice(end.offset))
  )
}

function splitFormulaParagraph(paragraph: Element, source: string): Element[] {
  if (!paragraph.children.some((child) => standaloneDisplayMath(child, source))) return [paragraph]
  const blocks: Element[] = []
  let prose: ElementContent[] = []
  const separator = (child: ElementContent | undefined): boolean =>
    (child?.type === 'text' && !child.value.trim()) ||
    (child?.type === 'element' && child.tagName === 'br')
  const flush = (): void => {
    while (separator(prose.at(-1))) prose.pop()
    if (prose.length) {
      const start = prose[0].position?.start
      const end = prose.at(-1)?.position?.end
      blocks.push({
        ...paragraph,
        children: prose,
        position: start && end ? { start, end } : undefined,
      })
    }
    prose = []
  }
  for (const child of paragraph.children) {
    if (standaloneDisplayMath(child, source)) {
      flush()
      blocks.push(formulaBlock({ ...paragraph, position: child.position }, mathText(child)))
    } else if (prose.length || !separator(child)) {
      prose.push(child)
    }
  }
  flush()
  return blocks
}

export function rehypeAnswerMath(source = '') {
  return (root: Root): void => {
    const walk = (parent: Root | Element): void => {
      for (let index = 0; index < parent.children.length; index += 1) {
        const node = parent.children[index]
        if (node.type !== 'element') continue
        if (node.tagName === 'p') {
          const standalone = node.children.length === 1 ? node.children[0] : undefined
          if (inlineMathCode(standalone)) {
            Object.assign(node, formulaBlock(node, mathText(standalone)))
            continue
          }
          if (source && node.children.length > 1) {
            const blocks = splitFormulaParagraph(node, source)
            if (blocks[0] !== node) {
              parent.children.splice(index, 1, ...blocks)
              for (const block of blocks) walk(block)
              index += blocks.length - 1
              continue
            }
          }
        }
        if (inlineMathCode(node)) {
          const source = mathText(node)
          node.tagName = 'span'
          node.properties = {
            ...node.properties,
            className: node.properties.className.filter(
              (name) => name !== 'math-inline' && name !== 'language-math'
            ),
            [INLINE_FORMULA_SOURCE]: source,
          }
          node.children = []
          continue
        }
        const code = node.children[0]
        if (
          node.tagName === 'pre' &&
          code?.type === 'element' &&
          code.tagName === 'code' &&
          Array.isArray(code.properties.className) &&
          code.properties.className.includes('math-display') &&
          code.children.every((child) => child.type === 'text')
        ) {
          Object.assign(node, formulaBlock(node, mathText(code).replace(/\n$/, '')))
        } else walk(node)
      }
    }
    walk(root)
  }
}

const DOLLAR_CODE = '$'.charCodeAt(0)
const DIGIT_START = '0'.charCodeAt(0)
const DIGIT_END = '9'.charCodeAt(0)
const WHITESPACE = /\s/

export function remarkAnswerMath(this: Processor): void {
  remarkMath.call(this)
  const extension = this.data().micromarkExtensions?.at(-1)
  const constructs = extension?.text?.[DOLLAR_CODE]
  for (const construct of (Array.isArray(constructs)
    ? constructs
    : constructs
      ? [constructs]
      : []) as Construct[]) {
    const tokenize = construct.tokenize
    construct.tokenize = function (effects, ok, nok) {
      const start = this.now()
      return tokenize.call(
        this,
        effects,
        (code) => {
          const source = this.sliceSerialize({ start, end: this.now() })
          const followedByDigit = code !== null && code >= DIGIT_START && code <= DIGIT_END
          if (
            !source.startsWith(DOUBLE_DOLLAR) &&
            (WHITESPACE.test(source.charAt(1)) ||
              WHITESPACE.test(source.charAt(source.length - 2)) ||
              followedByDigit)
          )
            return nok(code)
          return ok(code)
        },
        nok
      )
    }
  }
}
