import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { applicationResources } from './resources.ts'
import type { prepareWindowsVelopack } from './velopack.ts'
import updateTimeouts from '../../updater/handoff/timeouts.json' with { type: 'json' }

const source = readFileSync(new URL('./velopack.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText

function startup(
  platform: string,
  packaged: boolean,
  overrides: Record<string, unknown> = {},
  fetchResponse: (url: URL) => Promise<Response> = async () => new Response('{}')
) {
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
    './redaction.ts': { redactDiagnosticError: (error: unknown) => error },
    '../../updater/handoff/timeouts.json': updateTimeouts,
    ...overrides,
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(compiled, {
    exports,
    AbortSignal,
    Buffer,
    URL,
    fetch: fetchResponse,
    process: host,
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected import: ${name}`)
      return dependencies[name]
    },
  })
  return {
    root,
    current,
    calls,
    initialize: exports.initializeWindowsVelopack as () => void,
    prepare: exports.prepareWindowsVelopack as typeof prepareWindowsVelopack,
  }
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

test('Windows preparation reports cleanup separately and preserves the original component failure', async () => {
  const componentFailure = new Error('runtime archive rejected')
  const cleanupFailure = Object.assign(new Error('temporary directory busy'), { code: 'EBUSY' })
  const manifest = { assets: [{ Type: 'Full', FileName: 'full.nupkg' }], app_id: 'test' }
  const stages: string[] = []
  const cleanupErrors: unknown[] = []
  const log = () => undefined
  let failComponents = true
  const { prepare } = startup('win32', false, {
    velopack: {
      VelopackApp: { build: () => ({ setAutoApplyOnStartup: () => ({ run() {} }) }) },
      FileSource: class {},
      UpdateManager: class {
        getAppId() {
          return 'test'
        }
        getCurrentVersion() {
          return '1.0.0'
        }
      },
    },
    'node:crypto': { randomUUID: () => 'receipt' },
    'node:os': { tmpdir: () => path.resolve('os-temp') },
    'node:fs/promises': {
      mkdir: async () => undefined,
      copyFile: async () => undefined,
      mkdtemp: async (prefix: string) => `${prefix}attempt`,
      writeFile: async () => undefined,
      rename: async () => undefined,
      rm: async (_path: string, options: { recursive?: boolean }) => {
        if (options.recursive) throw cleanupFailure
      },
    },
    './nupkg.ts': {
      VELOPACK_POLICY: { manifestBytes: 1024 },
      updateCacheDirectory: (root: string) => path.join(root, 'packages'),
      patchDirectory: () => path.resolve('patch'),
      verifyPackageEnvelope: () => manifest,
      verifyApplicationPaths() {},
      assertWindowsPath() {},
      assertNewerPackage() {},
      verifyPackageInventory: async () => undefined,
      readPackageMember: async () => Buffer.from('{}'),
    },
    './components.ts': {
      COMPONENT_DELIVERY: { packageManifest: 'runtime.json' },
      verifyRuntimeEnvelope: () => ({}),
      downloadRuntimeComponents: async (options: { log: unknown }) => {
        assert.equal(options.log, log)
        if (failComponents) throw componentFailure
      },
    },
  })
  const options: Parameters<typeof prepare>[0] = {
    baseUrl: 'https://example.test/velopack',
    componentBaseUrl: 'https://example.test',
    candidate: {} as Parameters<typeof prepare>[0]['candidate'],
    native: { pin: () => ({}), release: () => {}, createChild: () => '' },
    keys: {},
    appId: 'test',
    diagnosticFile: 'native-update.log',
    onStage: (stage) => stages.push(stage),
    onCleanupError: (error) => cleanupErrors.push(error),
    log,
  }

  await assert.rejects(prepare(options), (error) => error === componentFailure)
  assert.equal(stages.at(-1), 'runtime-components')
  assert.deepEqual(cleanupErrors, [cleanupFailure])

  failComponents = false
  await assert.rejects(prepare(options), (error) => error === cleanupFailure)
  assert.equal(stages.at(-1), 'cleanup')
  assert.deepEqual(cleanupErrors, [cleanupFailure])
})

test('Windows preparation retries the release receipt after a transient cache-hit rename failure', async () => {
  const events: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  const external = new AbortController()
  const manifest = { assets: [{ Type: 'Full', FileName: 'full.nupkg', Size: 2 }], app_id: 'test' }
  const { prepare } = startup(
    'win32',
    false,
    {
      velopack: {
        VelopackApp: { build: () => ({ setAutoApplyOnStartup: () => ({ run() {} }) }) },
        FileSource: class {},
        UpdateManager: class {
          getAppId() {
            return 'test'
          }
          getCurrentVersion() {
            return '1.0.0'
          }
          async downloadUpdateAsync() {
            events.push('fallback')
          }
        },
      },
      'node:crypto': { randomUUID: () => 'receipt' },
      'node:os': { tmpdir: () => path.resolve('os-temp') },
      'node:fs/promises': {
        mkdir: async () => undefined,
        copyFile: async () => undefined,
        mkdtemp: async (prefix: string) => prefix + 'attempt',
        writeFile: async () => undefined,
        rename: async () => {
          if (!events.includes('receipt-busy')) {
            events.push('receipt-busy')
            throw Object.assign(new Error('receipt occupied'), { code: 'EBUSY' })
          }
          events.push('receipt-written')
        },
        rm: async (filename: string) => {
          if (path.basename(filename) === 'full.nupkg') events.push('discard-cache')
        },
        open: async () => ({
          write: async (_bytes: Buffer, _offset: number, length: number) => ({
            bytesWritten: length,
          }),
          close: async () => undefined,
        }),
      },
      './nupkg.ts': {
        VELOPACK_POLICY: { manifestBytes: 1024 },
        updateCacheDirectory: (root: string) => path.join(root, 'packages'),
        patchDirectory: () => path.resolve('patch'),
        verifyPackageEnvelope: () => manifest,
        verifyApplicationPaths() {},
        assertWindowsPath() {},
        assertNewerPackage() {},
        verifyPackageAsset: async () => events.push('verify-download'),
        verifyPackageInventory: async (
          _filename: string,
          _manifest: unknown,
          _roots: unknown,
          signal?: AbortSignal
        ) => {
          signals.push(signal)
          events.push('verify-cache')
        },
        readPackageMember: async () => Buffer.from('{}'),
      },
      './components.ts': {
        COMPONENT_DELIVERY: { packageManifest: 'runtime.json' },
        verifyRuntimeEnvelope: () => ({}),
        requireUpdateDiskSpace: async () => undefined,
        downloadRuntimeComponents: async () => events.push('components'),
      },
    },
    async (url: URL) => {
      const response = new Response('{}')
      Object.defineProperty(response, 'url', { value: url.href })
      return response
    }
  )

  const result = await prepare({
    baseUrl: 'https://example.test/velopack',
    componentBaseUrl: 'https://example.test',
    candidate: {} as Parameters<typeof prepare>[0]['candidate'],
    native: { pin: () => ({}), release: () => {}, createChild: () => '' },
    keys: {},
    appId: 'test',
    diagnosticFile: 'native-update.log',
    signal: external.signal,
    onStage: (stage) => {
      if (stage === 'release-receipt') events.push(stage)
    },
  })

  assert.equal(path.basename(result.packagePath), 'full.nupkg')
  assert.deepEqual(events, [
    'verify-cache',
    'release-receipt',
    'receipt-busy',
    'discard-cache',
    'verify-download',
    'fallback',
    'verify-cache',
    'release-receipt',
    'receipt-written',
    'components',
  ])
  assert.ok(signals[0])
  assert.notEqual(signals[0], external.signal)
  assert.equal(signals[0], signals[1])
  await result.verify()
  assert.equal(signals[2], external.signal)
  const install = new AbortController()
  await result.verify(install.signal)
  assert.equal(signals[3], install.signal)
})
