import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { applicationResources } from './resources.ts'

const source = readFileSync(new URL('./velopack.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function startup(platform: string, packaged: boolean) {
  const root = path.resolve('installed ScholarSeed 书深')
  const current = path.join(root, 'current')
  const host = {
    platform,
    execPath: path.join(root, 'runtime', 'electron', '44.3.0-r1', 'ScholarSeedEngine.exe'),
    resourcesPath: path.join(root, 'runtime', 'electron', '44.3.0-r1', 'resources'),
  }
  const app = {
    isPackaged: packaged,
    getAppPath: () => path.join(current, 'resources', 'app.asar'),
  }
  const calls: Array<{ name: string; value?: unknown }> = []
  const builder = {
    setAutoApplyOnStartup(value: boolean) {
      calls.push({ name: 'auto', value })
      return builder
    },
    setLocator(value: unknown) {
      calls.push({ name: 'locator', value })
      return builder
    },
    run() {
      calls.push({ name: 'run' })
    },
  }
  const dependencies: Record<string, unknown> = {
    velopack: {
      VelopackApp: {
        build() {
          calls.push({ name: 'build' })
          return builder
        },
      },
    },
    electron: { app },
    'node:crypto': {},
    'node:fs': { realpathSync: (value: string) => value },
    'node:fs/promises': {},
    'node:path': path,
    'node:os': {},
    './resources.ts': { applicationResources: () => applicationResources(app, host) },
    './transfer.ts': {},
    './components.ts': {},
    '../../runtime/components.cjs': {},
    './nupkg.ts': {},
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(compiled, {
    exports,
    process: host,
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected import: ${name}`)
      return dependencies[name]
    },
  })
  return { root, current, calls, initialize: exports.initializeWindowsVelopack as () => void }
}

test('Velopack startup uses the installed current identity instead of the engine component', () => {
  const result = startup('win32', true)
  assert.deepEqual(
    result.calls.map((call) => call.name),
    ['build', 'auto', 'locator', 'run']
  )
  assert.equal(result.calls[1].value, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result.calls[2].value)), {
    RootAppDir: result.root,
    CurrentBinaryDir: result.current,
    PackagesDir: path.join(result.root, 'packages'),
    UpdateExePath: path.join(result.root, 'Update.exe'),
    ManifestPath: path.join(result.current, 'sq.version'),
    IsPortable: false,
  })
  result.initialize()
  assert.equal(result.calls.length, 4)
})
test('macOS does not invoke Velopack and Windows development keeps automatic locator behavior', () => {
  assert.deepEqual(startup('darwin', true).calls, [])
  const development = startup('win32', false)
  assert.deepEqual(
    development.calls.map((call) => call.name),
    ['build', 'auto', 'run']
  )
  assert.equal(development.calls[1].value, false)
})
