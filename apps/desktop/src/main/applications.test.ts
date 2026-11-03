import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { AppCandidate } from './appsForFile.ts'

const source = readFileSync(new URL('./appsForFile.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function discovery(candidates: AppCandidate[], unavailable = false) {
  const calls: Array<{ executable: string; args: string[] }> = []
  const exports: { appsForFile?: (filePath: string) => Promise<AppCandidate[]> } = {}
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (name === 'path') return { basename }
      assert.equal(name, 'child_process')
      return {
        spawn: (executable: string, args: string[]) => {
          calls.push({ executable, args: Array.from(args) })
          const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() })
          queueMicrotask(() => {
            if (unavailable) {
              child.emit('error', new Error('osascript unavailable'))
              return
            }
            child.stdout.emit('data', JSON.stringify({ default: null, apps: candidates }))
            child.emit('close', 0)
          })
          return child
        }
      }
    }
  })
  return {
    appsForFile: async (filePath: string): Promise<AppCandidate[]> =>
      JSON.parse(JSON.stringify(await exports.appsForFile!(filePath))),
    calls
  }
}

function application(path: string, isDefault = false, name = path.split('/').at(-1)!): AppCandidate {
  return { name, path, isDefault }
}

test('discovery excludes installing bundles while keeping the formal application', async () => {
  const formal = application('/Applications/WorkBuddy.app')
  const staged = application('/Applications/.WorkBuddy.app.installing.5.8.3.413', false,
    '.WorkBuddy.app.installing.5.8.3.413')
  const result = await discovery([staged, formal]).appsForFile('/workspace/document.docx')
  assert.deepEqual(Array.from(result), [formal])
})

test('discovery excludes any dot-prefixed bundle or display name without relying on installing', async () => {
  const candidates = [
    application('/Applications/.Editor.app.installing'),
    application('/Applications/.Editor.APP.INSTALLING.2'),
    application('/Applications/.Hidden.app', false, 'Visible Editor'),
    application('/Users/测试/Applications/.隐藏应用.app'),
    application('/Applications/Editor.app', false, '.Hidden Editor')
  ]
  assert.equal((await discovery(candidates).appsForFile('/workspace/document.docx')).length, 0)
})

test('non-hidden applications remain available regardless of installing text or hidden parent directories', async () => {
  const candidates = [
    application('/Users/installing/Applications/Editor.app', false, 'Installing Editor'),
    application('/Applications/Installing Notes.app'),
    application('/Applications/Tools.app.installing-notes.app'),
    application('/Applications/Editor.app.installing.2'),
    application('/Users/测试/.cache/Editor.app'),
    application('/Users/测试/Applications/.Editor.app.installing.1.2/Editor.app'),
    application('/Applications/Dot.Editor.app'),
    application('/Applications/ChatGPT.app'),
    application('/Users/测试/Applications/My Office.app')
  ]
  const result = await discovery(candidates).appsForFile('/workspace/document.docx')
  assert.deepEqual(new Set(result.map(entry => entry.path)), new Set(candidates.map(entry => entry.path)))
})

test('a hidden bundle is excluded even when registered as the system default', async () => {
  const formal = application('/Applications/WorkBuddy.app')
  const staged = application('/Applications/.WorkBuddy.app', true)
  assert.deepEqual(Array.from(await discovery([staged, formal]).appsForFile('/workspace/document.docx')), [formal])
})

test('hidden entries do not consume the ten-application limit', async () => {
  const staged = Array.from({ length: 12 }, (_, index) =>
    application(`/Applications/.Editor${index}.app`))
  const formal = Array.from({ length: 12 }, (_, index) =>
    application(`/Applications/Editor${index.toString().padStart(2, '0')}.app`))
  const result = await discovery([...staged, ...formal]).appsForFile('/workspace/document.docx')
  assert.deepEqual(Array.from(result), formal.slice(0, 10))
})

test('valid default ordering, icons and argv isolation remain unchanged', async () => {
  const preferred = { ...application('/Applications/Word.app', true), icon: 'data:image/png;base64,icon' }
  const alternate = application('/Applications/Alpha.app')
  const fixture = discovery([alternate, preferred])
  const target = '/workspace/测试 file;$(touch unexpected).docx'
  assert.deepEqual(Array.from(await fixture.appsForFile(target)), [preferred, alternate])
  assert.equal(fixture.calls[0].executable, '/usr/bin/osascript')
  assert.deepEqual(fixture.calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.equal(fixture.calls[0].args.at(-1), target)
})

test('missing paths and an unavailable macOS enumerator retain the empty-list behavior', async () => {
  const fixture = discovery([], true)
  assert.equal((await fixture.appsForFile('')).length, 0)
  assert.equal(fixture.calls.length, 0)
  assert.equal((await fixture.appsForFile('C:\\workspace\\document.docx')).length, 0)
})
