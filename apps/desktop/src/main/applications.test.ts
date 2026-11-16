import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import type { AppCandidate } from './appsForFile.ts'

const source = readFileSync(new URL('./appsForFile.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function discovery(
  candidates: AppCandidate[],
  unavailable = false,
  defaultPath: string | null = candidates.find((candidate) => candidate.isDefault)?.path ?? null
) {
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
          const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() })
          queueMicrotask(() => {
            if (unavailable) {
              child.emit('error', new Error('osascript unavailable'))
              return
            }
            child.stdout.end(JSON.stringify({ default: defaultPath, apps: candidates }))
            child.emit('close', 0)
          })
          return child
        },
      }
    },
  })
  return {
    appsForFile: async (filePath: string): Promise<AppCandidate[]> =>
      JSON.parse(JSON.stringify(await exports.appsForFile!(filePath))),
    calls,
  }
}

function application(
  path: string,
  isDefault = false,
  name = path.split('/').at(-1)!
): AppCandidate {
  return { name, path, isDefault }
}

test('discovery excludes installing bundles while keeping the formal application', async () => {
  const formal = application('/Applications/WorkBuddy.app')
  const staged = application(
    '/Applications/.WorkBuddy.app.installing.5.8.3.413',
    false,
    '.WorkBuddy.app.installing.5.8.3.413'
  )
  const result = await discovery([staged, formal]).appsForFile('/workspace/document.docx')
  assert.deepEqual(Array.from(result), [formal])
})

test('discovery excludes any dot-prefixed bundle or display name without relying on installing', async () => {
  const candidates = [
    application('/Applications/.Editor.app.installing'),
    application('/Applications/.Editor.APP.INSTALLING.2'),
    application('/Applications/.Hidden.app', false, 'Visible Editor'),
    application('/Users/测试/Applications/.隐藏应用.app'),
    application('/Applications/Editor.app', false, '.Hidden Editor'),
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
    application('/Users/测试/Applications/My Office.app'),
  ]
  const result = await discovery(candidates).appsForFile('/workspace/document.docx')
  assert.deepEqual(
    new Set(result.map((entry) => entry.path)),
    new Set(candidates.map((entry) => entry.path))
  )
})

test('a hidden bundle is excluded even when registered as the system default', async () => {
  const formal = application('/Applications/WorkBuddy.app')
  const staged = application('/Applications/.WorkBuddy.app', true)
  assert.deepEqual(
    Array.from(await discovery([staged, formal]).appsForFile('/workspace/document.docx')),
    [formal]
  )
})

test('hidden entries do not consume the ten-application limit', async () => {
  const staged = Array.from({ length: 12 }, (_, index) =>
    application(`/Applications/.Editor${index}.app`)
  )
  const formal = Array.from({ length: 12 }, (_, index) =>
    application(`/Applications/Editor${index.toString().padStart(2, '0')}.app`)
  )
  const result = await discovery([...staged, ...formal]).appsForFile('/workspace/document.docx')
  assert.deepEqual(Array.from(result), formal.slice(0, 10))
})

test('valid default ordering, icons and argv isolation remain unchanged', async () => {
  const preferred = {
    ...application('/Applications/Word.app', true),
    icon: 'data:image/png;base64,icon',
  }
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

const testingIdentity = {
  bundleId: 'com.google.chrome.for.testing',
  bundleName: 'Google Chrome for Testing',
  executable: 'Google Chrome for Testing',
}

function versioned(path: string, version?: string, build?: string) {
  return {
    ...application(path, false, 'Google Chrome for Testing'),
    ...testingIdentity,
    version,
    build,
  }
}

test('software versions collapse before the cap using bundle versions, not directory numbers', async () => {
  const newest = versioned('/chromium-1208/Testing.app', '156.0.8078.4', '8078.4')
  const candidates = [
    ...Array.from({ length: 12 }, (_, index) =>
      versioned(`/chromium-${1234 + index}/Testing.app`, '151.0.7922.34', '7922.34')
    ),
    versioned('/chromium-9999/Testing.app', '147.0.7727.15', '7727.15'),
    newest,
    application('/Applications/Other.app'),
  ]
  const result = await discovery(candidates).appsForFile('/sample.png')
  assert.deepEqual(
    result.map((candidate) => candidate.path).sort(),
    [newest.path, '/Applications/Other.app'].sort()
  )
  assert.deepEqual(
    result.find((candidate) => candidate.path === newest.path),
    application(newest.path, false, newest.name)
  )
})

test('the exact system default wins over newer versions and remains ahead of the cap', async () => {
  const preferred = versioned('/Z/Testing.app', '147.0.7727.15')
  const newer = versioned('/A/Testing.app', '156.0.8078.4')
  const others = Array.from({ length: 12 }, (_, index) =>
    application(`/Applications/A${index}.app`)
  )
  const result = await discovery([...others, newer, preferred], false, preferred.path).appsForFile(
    '/sample.png'
  )
  assert.equal(result.length, 10)
  assert.deepEqual(result[0], application(preferred.path, true, preferred.name))
  assert.equal(
    result.some((candidate) => candidate.path === newer.path),
    false
  )
})

test('equal short versions compare build facts and equal builds select a stable actual path', async () => {
  const candidates = [
    versioned('/Z/Testing.app', '156.0.0.0', '100.10'),
    versioned('/A/Testing.app', '156.0', '100.10.0'),
    versioned('/B/Testing.app', '156.0.0', '100.9'),
  ]
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const result = await discovery(ordered).appsForFile('/sample.png')
    assert.deepEqual(
      result.map((candidate) => candidate.path),
      ['/A/Testing.app']
    )
  }
})

test('missing, nonnumeric and prerelease versions fall back stably without guessing latest', async () => {
  for (const unknown of [undefined, '', 'latest', '156.0.0-beta.1', '26.8.0.0.alpha0']) {
    const candidates = [versioned('/Z/Testing.app', '999.0'), versioned('/A/Testing.app', unknown)]
    for (const ordered of [candidates, [...candidates].reverse()]) {
      assert.deepEqual(
        (await discovery(ordered).appsForFile('/sample.png')).map((candidate) => candidate.path),
        ['/A/Testing.app']
      )
    }
  }
  const builds = [
    versioned('/Z/Testing.app', '1.0', '200'),
    versioned('/A/Testing.app', '1.0', 'alpha0'),
  ]
  assert.deepEqual(
    (await discovery(builds).appsForFile('/sample.png')).map((candidate) => candidate.path),
    ['/A/Testing.app']
  )
})

test('same names, shared bundle identifiers and unknown identities do not merge different products', async () => {
  const candidates = [
    versioned('/Testing.app', '156.0'),
    { ...versioned('/Chrome.app', '157.0'), bundleId: 'com.google.Chrome' },
    {
      ...versioned('/LibreOffice.app', '25.0'),
      bundleId: 'org.libreoffice.script',
      bundleName: 'LibreOffice',
      executable: 'soffice',
    },
    {
      ...versioned('/LibreOfficeDev.app', '26.0'),
      bundleId: 'org.libreoffice.script',
      bundleName: 'LibreOfficeDev',
      executable: 'soffice',
    },
    { ...versioned('/Other.app', '157.0'), executable: 'other' },
    { ...versioned('/Edition.app', '157.0'), bundleDisplayName: 'Testing Dev' },
    { ...versioned('/Unknown.app', '157.0'), bundleName: undefined },
    { ...versioned('/Unknown2.app', '157.0'), bundleId: undefined },
  ]
  const result = await discovery([...candidates, candidates[0]]).appsForFile('/sample.png')
  assert.deepEqual(
    result.map((candidate) => candidate.path).sort(),
    candidates.map((candidate) => candidate.path).sort()
  )
})
