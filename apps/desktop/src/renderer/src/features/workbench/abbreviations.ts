/**
 * Lean 4 tab-to-unicode abbreviations (`\alpha` + Tab becomes `α`).
 *
 * `abbrev.json` is the vscode-lean4 abbreviation table: keys are the tokens typed after
 * the backslash, values are the expansion text where `$CURSOR` marks the caret position
 * after the rewrite (snippet style, e.g. `{}` expands to `{` caret `}`). The table is
 * owned as data so it can be replaced without touching code; `monaco/runtime.ts` binds
 * it to the Tab key and the matcher stays pure so it is unit-testable without Monaco.
 */
import abbreviations from './abbrev.json' with { type: 'json' }

export const LEAN_ABBREVIATIONS: Readonly<Record<string, string>> = abbreviations

export const ABBREVIATION_CURSOR_MARKER = '$CURSOR'

export interface AbbreviationMatch {
  readonly start: number
  readonly replacement: string
  readonly cursorOffset: number
}

const ABBREVIATION_TOKEN = /\\[^\s\\]+$/

export function matchAbbreviation(textBeforeCursor: string): AbbreviationMatch | null {
  const token = ABBREVIATION_TOKEN.exec(textBeforeCursor)
  if (token === null) return null
  const raw = LEAN_ABBREVIATIONS[token[0].slice(1)]
  if (raw === undefined) return null
  const markerAt = raw.indexOf(ABBREVIATION_CURSOR_MARKER)
  const replacement = markerAt === -1 ? raw : raw.split(ABBREVIATION_CURSOR_MARKER).join('')
  return {
    start: token.index,
    replacement,
    cursorOffset: markerAt === -1 ? replacement.length : markerAt
  }
}
