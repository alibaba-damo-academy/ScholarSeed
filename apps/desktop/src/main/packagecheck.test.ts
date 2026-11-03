// Contract fixtures exercise observation serialization; real installed acceptance
// remains the package verifier's backend/renderer/native probes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./packagecheck.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function observe(platform: string, sharedObjects?: unknown) {
  const appPath = path.resolve('installed/current/resources/app.asar')
  const app = { isPackaged: true, getVersion: () => '0.2.0', getAppPath: () => appPath }
  const host = {
    platform,
    arch: 'x64',
    execPath: path.resolve('installed/runtime/electron/version/ScholarSeedEngine.exe'),
    resourcesPath: path.resolve('installed/runtime/electron/version/resources'),
    versions: { electron: '44.3.0', node: '24.15.0', modules: '145', napi: '10' },
    report: {
      getReport: () => {
        assert.equal(platform, 'win32', 'macOS must not request engine diagnostics')
        return { sharedObjects: sharedObjects ?? [path.join(appPath + '.unpacked', 'out/main/lease.node'), 'C:/Windows/System32/kernel32.dll'] }
      },
    },
  }
  const files = new Map<string, string | Buffer>()
  const dependencies: Record<string, unknown> = {
    crypto: { randomUUID: () => 'fixture' },
    fs: {
      writeFileSync: (filename: string, value: string | Buffer) => files.set(filename, value),
      renameSync: (from: string, to: string) => {
        files.set(to, files.get(from)!)
        files.delete(from)
      },
    },
    path,
    electron: { app },
    './resources.ts': {
      applicationResources: () => path.dirname(appPath),
      applicationExecutable: () => path.resolve('installed/current/ScholarSeed.exe'),
    },
    './workspace-ready': { workspaceReady: async () => true },
  }
  const load = (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected import: ${name}`)
    return dependencies[name]
  }
  const exports: Record<string, unknown> = {}
  runInNewContext(compiled, {
    exports,
    process: host,
    require: load,
    AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, stack: 'runtime' }) }),
    setTimeout: (callback: () => void) => callback(),
  })
  const run = exports.runPackageCheck as (
    window: unknown,
    base: string,
    filename: string
  ) => Promise<boolean>
  const passed = await run(
    {
      showInactive() {},
      webContents: {
        executeJavaScript: async () => true,
        capturePage: async () => ({ toPNG: () => Buffer.from('contract-fixture') }),
      },
    },
    'http://127.0.0.1:1',
    'result.json'
  )
  return { passed, result: JSON.parse(String(files.get('result.json'))), host, appPath }
}

test('Windows package check records observed engine identity and loaded native module paths', async () => {
  const { passed, result, host, appPath } = await observe('win32')
  assert.equal(passed, true)
  assert.equal(result.ok, true)
  assert.deepEqual(result.engine, {
    version: host.versions.electron,
    node: host.versions.node,
    modules: host.versions.modules,
    napi: host.versions.napi,
    packaged: true,
    appVersion: '0.2.0',
    appPath,
    executable: host.execPath,
    resources: host.resourcesPath,
    applicationResources: path.dirname(appPath),
    launcher: path.resolve('installed/current/ScholarSeed.exe'),
    nativeModules: [
      {
        path: path.join(appPath + '.unpacked', 'out/main/lease.node'),
        loaded: true,
      },
    ],
  })
})

test('macOS package check preserves the existing result contract', async () => {
  const { passed, result } = await observe('darwin')
  assert.equal(passed, true)
  assert.equal(result.platform, 'darwin')
  assert.equal(Object.hasOwn(result, 'engine'), false)
})

test('Windows package check fails closed on an invalid native observation', async () => {
  await assert.rejects(observe('win32', 'invalid'), /shared object inventory/)
  await assert.rejects(observe('win32', [42]), /shared object inventory/)
})
