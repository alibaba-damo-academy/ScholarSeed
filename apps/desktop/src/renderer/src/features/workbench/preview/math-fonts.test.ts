import assert from 'node:assert/strict'
import test from 'node:test'

import { mathFontText } from './math-fonts.ts'

test('mathematical font glyphs preserve every Latin letter and digit identity', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (const family of ['script', 'fraktur', 'double-struck', 'sans-serif', 'monospace']) {
    const output = mathFontText(alphabet, family)
    assert.equal(output.normalize('NFKD'), alphabet)
    assert.equal(Array.from(output).length, alphabet.length)
  }
})

test('legacy font exceptions and already encoded mathematical characters are retained', () => {
  assert.equal(mathFontText('BFEeg', 'script'), 'ℬℱℰℯℊ')
  assert.equal(mathFontText('CHIRZ', 'fraktur'), 'ℭℌℑℜℨ')
  assert.equal(mathFontText('CHNPQRZ', 'double-struck'), 'ℂℍℕℙℚℝℤ')
  assert.equal(mathFontText('α + ℝ', 'script'), 'α + ℝ')
  assert.equal(mathFontText('plain text', null), 'plain text')
})
