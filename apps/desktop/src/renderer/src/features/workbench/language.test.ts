import assert from 'node:assert/strict'
import test from 'node:test'
// Monaco's internal tokenizer has no declarations; used only by this grammar contract.
// @ts-expect-error upstream JavaScript-only module
import { compile } from 'monaco-editor/editor/standalone/common/monarch/monarchCompile'
// @ts-expect-error upstream JavaScript-only module
import { MonarchTokenizer } from 'monaco-editor/editor/standalone/common/monarch/monarchLexer'

import { languageFor, TOML_LANGUAGE } from './language.ts'

const formats: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', py: 'python', r: 'r', js: 'javascript',
  jsx: 'javascript', ts: 'typescript', tsx: 'typescript', java: 'java', c: 'c',
  cpp: 'cpp', h: 'cpp', sh: 'shell', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', xml: 'xml', txt: 'plaintext', log: 'plaintext'
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
