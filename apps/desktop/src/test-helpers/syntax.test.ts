import assert from 'node:assert/strict'
import test from 'node:test'

import { expressions } from './syntax.ts'

test('expression contracts ignore only formatting, comments and literal quote spelling', () => {
  const contains = expressions(`
    const task = callback(
      (open: boolean): void => {
        if (open) update({ panel: false, title: "a", });
      },
      [update],
    );
  `)
  contains("(open: boolean): void => { if (open) update({ panel: false, title: 'a' }) }", 'task')
  contains('[update]', 'task')
  contains("update({ /* retained values */ panel: false, title: 'a' })", 'task')
})

test('expression contracts reject changed values, operators, arguments, order and member identity', () => {
  const contains = expressions("const task = () => { port.run('first', 2); close(); clear(null) }")
  for (const expected of [
    "port.run('first', 3)",
    "port.run(2, 'first')",
    "other.run('first', 2)",
    "port.run('first')",
    "() => { port.run('first', 2); clear(null); close() }",
    '() => { close(); clear(null) }',
  ]) {
    assert.throws(() => contains(expected, 'task'), /missing expression/)
  }
  assert.throws(
    () => expressions('const value = left || right')('left && right'),
    /missing expression/
  )
})

test('expression contracts retain parentheses that change optional chain semantics', () => {
  const contains = expressions('const value = (port?.run)()')
  contains('(port?.run)()', 'value')
  assert.throws(() => contains('port?.run()', 'value'), /missing expression/)
})

test('expression contracts cannot satisfy one owner from a different variable', () => {
  const contains = expressions('const first = [firstPort]; const second = [secondPort]')
  contains('[secondPort]')
  assert.throws(() => contains('[secondPort]', 'first'), /missing expression/)
  assert.throws(() => contains('[firstPort]', 'absent'), /expected one owner/)
  assert.throws(
    () =>
      expressions('const duplicate = 1; function nested() { const duplicate = 2 }')(
        '1',
        'duplicate'
      ),
    /expected one owner/
  )
  assert.throws(() => expressions('let empty')('1', 'empty'), /missing initializer/)
})

test('expression contracts preserve JSX attribute ownership and reject swapped handlers', () => {
  const contains = expressions(
    '<Widget onExplain={() => explain()} onTranslate={() => translate()} />'
  )
  contains('() => explain()', { attribute: 'onExplain' })
  contains('() => translate()', { attribute: 'onTranslate' })
  assert.throws(
    () => contains('() => translate()', { attribute: 'onExplain' }),
    /missing expression/
  )
  assert.throws(() => contains('() => explain()', { attribute: 'absent' }), /expected one owner/)
  assert.throws(
    () =>
      expressions('<><Widget onExplain={first} /><Widget onExplain={second} /></>')('first', {
        attribute: 'onExplain',
      }),
    /expected one owner/
  )
  assert.throws(
    () => expressions('<Widget enabled />')('true', { attribute: 'enabled' }),
    /missing initializer/
  )
})

test('expression contracts reject invalid source and invalid expected expressions', () => {
  assert.throws(() => expressions('const broken = call('), /syntactically valid input/)
  const contains = expressions('const valid = call()')
  assert.throws(() => contains('call('), /syntactically valid input/)
  assert.throws(() => contains(''), /expected exactly one expression/)
  assert.throws(() => contains('call(); other()'), /expected exactly one expression/)
  assert.throws(() => contains('const declared = call()'), /expected an expression/)
})
