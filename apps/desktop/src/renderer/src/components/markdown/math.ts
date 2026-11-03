import type { Construct } from 'micromark-util-types'
import type {} from 'remark-parse'
import remarkMath from 'remark-math'
import type { Processor } from 'unified'
import type { Element, Root } from 'hast'

export const FORMULA_SOURCE = 'data-conversation-formula'

export function rehypeAnswerMath() {
  return (root: Root): void => {
    const walk = (parent: Root | Element): void => {
      for (const node of parent.children) {
        if (node.type !== 'element') continue
        const code = node.children[0]
        if (
          node.tagName === 'pre' &&
          code?.type === 'element' &&
          code.tagName === 'code' &&
          Array.isArray(code.properties.className) &&
          code.properties.className.includes('math-display') &&
          code.children.every((child) => child.type === 'text')
        ) {
          const source = code.children
            .map((child) => (child.type === 'text' ? child.value : ''))
            .join('')
            .replace(/\n$/, '')
          node.tagName = 'div'
          node.properties = { ...node.properties, [FORMULA_SOURCE]: source }
          node.children = []
        } else walk(node)
      }
    }
    walk(root)
  }
}

const DOLLAR_CODE = '$'.charCodeAt(0)
const DIGIT_START = '0'.charCodeAt(0)
const DIGIT_END = '9'.charCodeAt(0)
const DOUBLE_DOLLAR = '$$'
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
