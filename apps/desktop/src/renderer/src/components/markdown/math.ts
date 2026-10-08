import type { Construct } from 'micromark-util-types'
import remarkMath from 'remark-math'
import type { Processor } from 'unified'

const DOLLAR_CODE = '$'.charCodeAt(0)
const DIGIT_START = '0'.charCodeAt(0)
const DIGIT_END = '9'.charCodeAt(0)
const DOUBLE_DOLLAR = '$$'
const WHITESPACE = /\s/

export function remarkAnswerMath(this: Processor): void {
  remarkMath.call(this)
  const extension = this.data().micromarkExtensions?.at(-1)
  const constructs = extension?.text?.[DOLLAR_CODE]
  for (const construct of (Array.isArray(constructs) ? constructs : constructs ? [constructs] : []) as Construct[]) {
    const tokenize = construct.tokenize
    construct.tokenize = function (effects, ok, nok) {
      const start = this.now()
      return tokenize.call(this, effects, (code) => {
        const source = this.sliceSerialize({ start, end: this.now() })
        const followedByDigit = code !== null && code >= DIGIT_START && code <= DIGIT_END
        if (!source.startsWith(DOUBLE_DOLLAR) && (
          WHITESPACE.test(source.charAt(1))
          || WHITESPACE.test(source.charAt(source.length - 2))
          || followedByDigit
        )) return nok(code)
        return ok(code)
      }, nok)
    }
  }
}
