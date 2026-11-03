import assert from 'node:assert/strict'
import test from 'node:test'
// Monaco's internal tokenizer has no declarations; used only by this grammar contract.
// @ts-expect-error upstream JavaScript-only module
import { compile } from 'monaco-editor/editor/standalone/common/monarch/monarchCompile'
// @ts-expect-error upstream JavaScript-only module
import { MonarchTokenizer } from 'monaco-editor/editor/standalone/common/monarch/monarchLexer'

import { LEAN_CONFIGURATION, LEAN_LANGUAGE } from './lean.ts'
import { languageFor, TOML_LANGUAGE } from './language.ts'

const formats: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', py: 'python', r: 'r', js: 'javascript',
  jsx: 'javascript', ts: 'typescript', tsx: 'typescript', java: 'java', c: 'c',
  cpp: 'cpp', h: 'cpp', sh: 'shell', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', lean: 'lean', xml: 'xml', txt: 'plaintext', log: 'plaintext'
}

test('every promised extension resolves its language, including uppercase paths', () => {
  for (const [suffix, expected] of Object.entries(formats)) {
    assert.equal(languageFor(`研究/test.${suffix}`), expected)
    assert.equal(languageFor(`研究/test.${suffix.toUpperCase()}`), expected)
  }
  assert.equal(languageFor('directory.py/README'), 'plaintext')
})

test('TOML root classifies tables, keys, booleans, dates, and numbers', () => {
  const rules = TOML_LANGUAGE.tokenizer.root as [RegExp, string, ...unknown[]][]
  for (const [sample, expected] of [
    ['# comment', 'comment'], ['[[packages]]', 'type.identifier'],
    ['[database]', 'type.identifier'], ['enabled =', 'key'], ['true', 'keyword'],
    ['2026-09-03T10:30:00Z', 'number.date'], ['-1.2e3', 'number'], ['0xDEAD', 'number.hex']
  ]) {
    const match = rules.find(([pattern]) => {
      const found = sample.match(pattern)
      return found?.index === 0
    })
    assert.equal(match?.[1], expected, sample)
  }
})


test('real Monaco tokenizer retains multiline TOML string state and resumes keys', () => {
  // Deterministic grammar contract only: classic tokenization uses no DOM, theme, or LLM.
  const lexer = new MonarchTokenizer({}, {}, 'toml', compile('toml', TOML_LANGUAGE), {
    getValue: () => Number.MAX_SAFE_INTEGER,
    onDidChangeConfiguration: () => ({ dispose() {} })
  })
  try {
    let state = lexer.getInitialState()
    const tokens = (line: string): string[] => {
      const result = lexer.tokenize(line, true, state)
      state = result.endState
      return result.tokens.map((token: { type: string }) => token.type)
    }
    assert.ok(tokens('message = """first').includes('key.toml'))
    assert.deepEqual(tokens('# string content, not a comment'), ['string.toml'])
    assert.deepEqual(tokens('last"""'), ['string.toml'])
    assert.ok(tokens('enabled = true # comment').includes('keyword.toml'))
    assert.ok(tokens("literal = '''first").includes('key.toml'))
    assert.deepEqual(tokens('enabled = false'), ['string.toml'])
    assert.deepEqual(tokens("last'''"), ['string.toml'])
    assert.ok(tokens('count = 42').includes('number.toml'))
  } finally {
    lexer.dispose()
  }
})

test('Lean configuration owns comment toggling and indentation folding', () => {
  assert.equal(LEAN_CONFIGURATION.comments?.lineComment, '--')
  assert.deepEqual(LEAN_CONFIGURATION.comments?.blockComment, ['/-', '-/'])
  assert.equal(LEAN_CONFIGURATION.folding?.offSide, true)
})

test('real Monaco tokenizer nests Lean block comments and resumes code', () => {
  // Deterministic grammar contract only: classic tokenization uses no DOM, theme, or LLM.
  const lexer = new MonarchTokenizer({}, {}, 'lean', compile('lean', LEAN_LANGUAGE), {
    getValue: () => Number.MAX_SAFE_INTEGER,
    onDidChangeConfiguration: () => ({ dispose() {} })
  })
  try {
    let state = lexer.getInitialState()
    const types = (line: string): string[] => {
      const result = lexer.tokenize(line, true, state)
      state = result.endState
      return result.tokens
        .map((token: { type: string }) => token.type)
        .filter((type: string) => type !== 'white.lean')
    }

    assert.deepEqual(types('/-- 文档注释 -/'), ['comment.doc.lean'])
    assert.deepEqual(types('/- 外层 /- 内层 -/ 仍在注释里 -/'), ['comment.lean'])
    assert.deepEqual(types('/- 未闭合的第一行'), ['comment.lean'])
    assert.deepEqual(types('第二行 -/ theorem'), ['comment.lean', 'keyword.lean'])
    assert.deepEqual(types('-- 行注释'), ['comment.lean'])
  } finally {
    lexer.dispose()
  }
})

test('real Monaco tokenizer classifies Lean declarations, Unicode and interpolation', () => {
  const lexer = new MonarchTokenizer({}, {}, 'lean', compile('lean', LEAN_LANGUAGE), {
    getValue: () => Number.MAX_SAFE_INTEGER,
    onDidChangeConfiguration: () => ({ dispose() {} })
  })
  try {
    const types = (line: string): string[] =>
      lexer
        .tokenize(line, true, lexer.getInitialState())
        .tokens.map((token: { type: string }) => token.type)
        .filter((type: string) => type !== 'white.lean')

    assert.deepEqual(types('theorem t : True := by sorry'), [
      'keyword.lean', 'identifier.lean', 'operator.lean', 'identifier.lean',
      'operator.lean', 'keyword.lean', 'keyword.lean'
    ])
    assert.deepEqual(types('example : Prop := 0xFF + 1_000 + 1.5e-3'), [
      'keyword.lean', 'operator.lean', 'type.lean', 'operator.lean', 'number.hex.lean',
      'operator.lean', 'number.lean', 'operator.lean', 'number.float.lean'
    ])
    assert.deepEqual(types('#eval ∀ ε > 0, α ≤ β'), [
      'keyword.lean', 'operator.lean', 'identifier.lean', 'operator.lean', 'number.lean',
      'delimiter.lean', 'identifier.lean', 'operator.lean', 'identifier.lean'
    ])
    assert.deepEqual(types('λ x => x'), [
      'keyword.lean', 'identifier.lean', 'operator.lean', 'identifier.lean'
    ])
    assert.deepEqual(types('s"n = {n + 1}"'), [
      'string.quote.lean', 'string.lean', 'delimiter.bracket.lean', 'identifier.lean',
      'operator.lean', 'number.lean', 'delimiter.bracket.lean', 'string.quote.lean'
    ])
    assert.deepEqual(types('"a\\nb"'), [
      'string.quote.lean', 'string.lean', 'string.escape.lean', 'string.lean', 'string.quote.lean'
    ])
    assert.deepEqual(types("'a'"), ['string.lean'])
    assert.deepEqual(types("h₁'"), ['identifier.lean'])
  } finally {
    lexer.dispose()
  }
})
