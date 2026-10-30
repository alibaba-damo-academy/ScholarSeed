import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { checkMessageCalls, checkProjectCalls } from '../calls.mjs'

function check(code) {
  const file = '/virtual/calls.ts'
  const source = `interface Translate { $TFunctionBrand: 'foundation'; (key: string, options?: object): string }; declare const t: Translate; ${code}`
  const host = ts.createCompilerHost({})
  const original = host.getSourceFile
  host.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([file], { noEmit: true, strict: true }, host)
  return checkMessageCalls(program, { zh: { foundation: { hello: 'Hello {{name}}' } } })
}
test('checks required interpolation even when the library options argument is optional', () => {
  assert.equal(check(`t('hello', { name: 'Ada' })`).length, 0)
  assert.match(check(`t('hello')`).join(), /parameter name/)
  assert.match(check(`t('hello', { wrong: 'Ada' })`).join(), /parameter name/)
  assert.match(check(`t('unknown')`).join(), /Unknown message/)
  assert.match(check(`declare const key: string; t(key)`).join(), /finite literal/)
})

test('Trans aliases use explicit keys and checked values', () => {
  const file = '/virtual/trans.tsx'
  function checkTrans(code) {
    const host = ts.createCompilerHost({})
    const original = host.getSourceFile
    const source = `import React, { createElement as element } from 'react'; import { Trans as Message } from 'react-i18next'; ${code}`
    host.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TSX) : original(name, version, ...rest)
    return checkMessageCalls(ts.createProgram([file], { noEmit: true, jsx: ts.JsxEmit.ReactJSX }, host), { zh: { foundation: { hello: 'Hello {{name}}' } } })
  }
  assert.deepEqual(checkTrans(`const View = <Message i18nKey="hello" values={{name:'Ada'}} />`), [])
  assert.match(checkTrans(`const View = <Message i18nKey="hello" />`).join(), /Trans parameter name/)
  assert.match(checkTrans(`const View = <Message i18nKey="absent" />`).join(), /Unknown Trans/)
  assert.deepEqual(checkTrans(`const View = React.createElement(Message, {i18nKey:'hello', values:{name:'Ada'}})`), [])
  assert.match(checkTrans(`const View = element(Message, {i18nKey:'hello'})`).join(), /Trans parameter name/)
  assert.match(checkTrans(`const View = React.createElement(Message, {i18nKey:'absent'})`).join(), /Unknown Trans/)
})

test('project call checks consume all solution references without a parallel project list', () => {
  const desktop = mkdtempSync(join(tmpdir(), 'desktop-message-projects-'))
  const resources = { zh: { foundation: { hello: 'Hello {{name}}' } } }
  try {
    mkdirSync(join(desktop, 'configs'))
    writeFileSync(join(desktop, 'tsconfig.json'), JSON.stringify({ references: [{ path: './configs/custom.json' }] }))
    writeFileSync(join(desktop, 'configs/custom.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, files: ['../messages.ts'] }))
    writeFileSync(join(desktop, 'messages.ts'), "interface Translate { $TFunctionBrand: 'foundation'; (key: string, options?: object): string }; declare const t: Translate; t('hello')")
    assert.match(checkProjectCalls(resources, { desktop }).join(), /parameter name/)
    writeFileSync(join(desktop, 'messages.ts'), "interface Translate { $TFunctionBrand: 'foundation'; (key: string, options?: object): string }; declare const t: Translate; t('hello', {name:'Ada'})")
    assert.deepEqual(checkProjectCalls(resources, { desktop }), [])
    writeFileSync(join(desktop, 'configs/custom.json'), '{')
    assert.throws(() => checkProjectCalls(resources, { desktop }), /expected/)
  } finally {
    rmSync(desktop, { recursive: true, force: true })
  }
})
