import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as journal from './journal.ts'
import * as resources from './resources.ts'
import * as storageRecord from './storage-record.ts'
import * as preferencesContract from '../preferences.ts'
import * as preferenceDiagnostics from '../preference-diagnostics.ts'
import * as preferencesRecord from './preferences-record.ts'
import * as windowRecord from './window-record.ts'
import * as windowContract from '../window.ts'
import * as trayContract from '../tray.ts'
import type * as Storage from './storage'
import type * as Preferences from './preferences'
import type * as Tray from './tray'

function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-storage-consumers-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = path.join(root, 'original')
  const replacement = path.join(root, 'replacement')
  fs.mkdirSync(original)
  fs.mkdirSync(replacement)
  let userData = original
  const environment = { SCHOLARSEED_HOME: path.join(root, 'home') }
  const dependencies: Record<string, unknown> = {
    fs,
    'node:buffer': { Buffer },
    'node:child_process': {
      execFileSync: () => {
        throw new Error('storage consumers must not execute system commands')
      },
    },
    './journal.ts': journal,
    './resources.ts': resources,
    './storage-record.ts': storageRecord,
    './preferences-record.ts': preferencesRecord,
    './window-record.ts': windowRecord,
    './writer': { desktopDirectoryWriter: () => ({ close() {} }) },
    path,
    os: { homedir: () => root },
    electron: {
      app: {
        getName: () => 'ScholarSeed',
        getPath: (key: string) => {
          if (key === 'userData') return userData
          if (key === 'appData') return root
          throw new Error(`unexpected Electron path: ${key}`)
        },
        getAppPath: () => path.join(root, 'repo', 'apps', 'desktop'),
        isPackaged: false,
      },
    },
    '../preferences': preferencesContract,
    '../preference-diagnostics.ts': preferenceDiagnostics,
    '../window': windowContract,
    '../tray.ts': trayContract,
    './locale': { detectRendererLanguage: () => 'en' },
    './localization': { applyMainLanguage: async () => {} },
    ...overrides,
  }
  function load<T>(name: string): T {
    const exports = {}
    const source = fs.readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8')
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        require: (id: string) => {
          assert.ok(Object.hasOwn(dependencies, id), `unexpected import ${id}`)
          return dependencies[id]
        },
        process: { env: environment, platform: process.platform },
      }
    )
    return exports as T
  }
  const storage = load<typeof Storage>('storage')
  dependencies['./storage'] = storage
  return {
    storage,
    preferences: load<typeof Preferences>('preferences'),
    tray: load<typeof Tray>('tray').windowCloseStateStore(),
    original,
    replacement,
    drift: () => {
      userData = replacement
    },
  }
}

for (const owner of ['preferences', 'tray'] as const) {
  test(`${owner} refuses filesystem access before startup selection`, (t) => {
    const fx = fixture(t)
    const read =
      owner === 'preferences'
        ? () => fx.preferences.loadRendererPreferences()
        : () => fx.tray.load()
    const write =
      owner === 'preferences'
        ? () => fx.preferences.saveRendererPreferences({ language: 'en' })
        : () => fx.tray.save({ askOnClose: false })
    assert.throws(read, /storage must be initialized/)
    assert.throws(write, /storage must be initialized/)
    assert.deepEqual(fs.readdirSync(fx.original), [])
    assert.deepEqual(fs.readdirSync(fx.replacement), [])
  })

  test(`${owner} reads and writes only the frozen userData after Electron path drift`, async (t) => {
    const fx = fixture(t)
    fx.storage.publishStorage(
      fx.storage.selectStorage('contract', {
        pin: () => {
          throw new Error('explicit home must not read pointer')
        },
        readAt: () => {
          throw new Error('unexpected read')
        },
        release: () => {
          throw new Error('unexpected release')
        },
      })
    )
    const filename =
      owner === 'preferences' ? 'renderer-preferences.json' : 'window-close-state.json'
    const originalValue = owner === 'preferences' ? { language: 'en' } : { askOnClose: true }
    const replacementValue = owner === 'preferences' ? { language: 'zh' } : { askOnClose: false }
    const sentinel = JSON.stringify(replacementValue)
    fs.writeFileSync(path.join(fx.original, filename), JSON.stringify(originalValue))
    fs.writeFileSync(path.join(fx.replacement, filename), sentinel)
    fx.drift()
    if (owner === 'preferences') {
      assert.equal(fx.preferences.loadRendererPreferences().language, 'en')
      assert.equal((await fx.preferences.reconcileRendererPreferences()).language, 'en')
      await fx.preferences.commitRendererPreferences({ language: 'zh' })
      assert.equal(fx.preferences.loadRendererPreferences().language, 'zh')
    } else {
      assert.equal(fx.tray.load().askOnClose, true)
      fx.tray.save({ askOnClose: false })
      assert.equal(fx.tray.load().askOnClose, false)
    }
    const saved = JSON.parse(fs.readFileSync(path.join(fx.original, filename), 'utf8'))
    assert.equal(
      saved[owner === 'preferences' ? 'language' : 'askOnClose'],
      owner === 'preferences' ? 'zh' : false
    )
    assert.equal(fs.readFileSync(path.join(fx.replacement, filename), 'utf8'), sentinel)
    assert.deepEqual(fs.readdirSync(fx.replacement), [filename])
    assert.deepEqual(fs.readdirSync(fx.original), [filename], 'temporary write file was consumed')
  })
}

test('protocol registration retains the selected profile on the next invocation', () => {
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /protocolClientArguments\(\s*process\.platform,\s*Boolean\(process\.defaultApp\),\s*app\.getAppPath\(\),\s*storageStartup\.userData/
  )
  assert.doesNotMatch(source, /app\.getPath\('userData'\)/)
})

for (const stage of ['read', 'acquire', 'write', 'release', 'main-apply'] as const) {
  test(`preference main diagnostics identify ${stage} without hiding the original error`, async (context) => {
    const error = Object.assign(Error('private failure'), {
      code: 'ERR_LEASE_NATIVE',
      systemCode: 5,
    })
    const fail = () => {
      throw error
    }
    const fx = fixture(context, {
      './journal.ts': {
        ...journal,
        ...(stage === 'read' ? { readRecord: fail } : {}),
        ...(stage === 'write' ? { writeJson: fail } : {}),
      },
      './writer': {
        desktopDirectoryWriter:
          stage === 'acquire'
            ? fail
            : () => ({
                close: stage === 'release' ? fail : () => {},
              }),
      },
      './localization': { applyMainLanguage: stage === 'main-apply' ? fail : async () => {} },
    })
    fx.storage.publishStorage(
      fx.storage.selectStorage('contract', {
        pin: () => {
          throw Error('unexpected pointer')
        },
        readAt: () => {
          throw Error('unexpected read')
        },
        release: () => {
          throw Error('unexpected release')
        },
      })
    )
    const lines: string[] = []
    const diagnostics = new preferenceDiagnostics.PreferenceDiagnostics('main', (line) =>
      lines.push(line)
    )
    await assert.rejects(
      fx.preferences.commitRendererPreferences({ language: 'zh' }, diagnostics),
      (caught) => caught === error
    )
    const records = lines.map((line) =>
      JSON.parse(line.slice(preferenceDiagnostics.PREFERENCE_DIAGNOSTIC_PREFIX.length))
    )
    assert.ok(records.some((record) => record.stage === stage && record.error.systemCode === 5))
    assert.doesNotMatch(lines.join(''), /private failure/)
  })
}
