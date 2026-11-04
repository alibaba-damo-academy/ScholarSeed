import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { buildProtected, protectedWatchPolicy } from './protected.ts'
import { protectedDigest, verifyProtectedAssets } from './src/main/vaultipc.ts'
import { build as compile, type Plugin } from 'vite'
import { resolveConfig } from 'electron-vite'
import { build as compilePreload } from 'esbuild'

test('standalone protected generation builder exists', () => {
  assert.equal(existsSync(new URL('./protected.ts', import.meta.url)), true)
})

const desktop = fileURLToPath(new URL('.', import.meta.url))
const DEPENDENCY_DIRECTORY = 'node_modules'
function isolatedSource() {
  const container = mkdtempSync(join(tmpdir(), 'protected-build-'))
  const root = join(container, 'apps/desktop')
  mkdirSync(root, { recursive: true })
  cpSync(join(desktop, 'src'), join(root, 'src'), {
    recursive: true, filter: source => basename(source) !== DEPENDENCY_DIRECTORY
  })
  for (const file of ['electron.vite.config.ts', 'protected.ts', 'renderer.ts', 'endpoints.ts', 'package-lock.json', 'package.json']) cpSync(join(desktop, file), join(root, file))
  for (const owner of ['runtime', 'scripts', 'native']) cpSync(join(desktop, owner), join(root, owner), { recursive: true })
  mkdirSync(join(container, 'scripts'))
  for (const owner of ['ops-cli.cjs', 'pre', 'dev', 'ci', 'cd', 'shared']) cpSync(join(desktop, '../../scripts', owner), join(container, 'scripts', owner), {
    recursive: true, filter: source => !source.split(/[\\/]/).some(part => ['__tests__', '__pycache__'].includes(part))
  })
  mkdirSync(join(container, 'scripts/vendor/texlive'), { recursive: true })
  cpSync(join(desktop, '../../scripts/vendor/texlive/manifest.json'), join(container, 'scripts/vendor/texlive/manifest.json'))
  // Native compilation verifies every generated security-policy output.
  const security = JSON.parse(readFileSync(join(desktop, 'native/security.outputs.json'), 'utf8'))
  for (const file of Object.keys(security.outputs)) {
    mkdirSync(dirname(join(container, file)), { recursive: true })
    cpSync(join(desktop, '../..', file), join(container, file))
  }
  symlinkSync(join(desktop, DEPENDENCY_DIRECTORY), join(root, DEPENDENCY_DIRECTORY), process.platform === 'win32' ? 'junction' : 'dir')
  for (const name of ['main', 'preload', 'renderer']) {
    mkdirSync(join(root, 'out', name), { recursive: true }); writeFileSync(join(root, 'out', name, 'sentinel'), name)
  }
  return { root, dispose: () => rmSync(container, { recursive: true, force: true }) }
}
test('isolated protected source excludes renderer dependency caches', () => {
  const fixture = isolatedSource()
  try {
    assert.equal(existsSync(join(fixture.root, 'src/renderer/src/node_modules')), false)
  } finally { fixture.dispose() }
})

test('actual standalone serve/build generation includes local fonts and minimal preload, preserves ordinary outputs and NODE_ENV', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  const environment = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'development'
    const serve = await buildProtected({ desktopRoot: fixture.root, command: 'serve', mode: 'development' })
    assert.equal(process.env.NODE_ENV, 'development')
    const manifest = JSON.parse(readFileSync(join(serve.directory, 'manifest.json'), 'utf8'))
    assert.ok(manifest.sources.some((file: { path: string }) => file.path === '../../scripts/shared/python.cjs'))
    assert.ok(manifest.sources.some((file: { path: string }) => file.path === 'scripts/shared/lease.mjs'))
    assert.equal(manifest.sources.some((file: { path: string }) => file.path.includes('/__tests__/')), false)
    assert.ok(manifest.files.some((file: { path: string }) => file.path.endsWith('.woff2')))
    assert.ok(manifest.files.some((file: { path: string }) => file.path.endsWith('.css')))
    assert.equal(manifest.modules.some((name: string) => /src\/renderer\/src\/(?:api|store|app\/policy)\./.test(name)), false)
    assert.equal(readFileSync(join(serve.directory, 'preload/vault.js'), 'utf8').includes('getApiBase'), false)
    assert.ok(verifyProtectedAssets(serve.directory, serve.generation, serve.manifestDigest).resources.size > 1)
    for (const name of ['main', 'preload', 'renderer']) assert.equal(readFileSync(join(fixture.root, 'out', name, 'sentinel'), 'utf8'), name)
    const production = await buildProtected({ desktopRoot: fixture.root, command: 'build', mode: 'production' })
    assert.notEqual(production.generation, serve.generation)
    assert.equal(process.env.NODE_ENV, 'development')
    verifyProtectedAssets(production.directory, production.generation, production.manifestDigest)
    writeFileSync(join(production.directory, 'preload/vault.js'), 'old or modified')
    assert.throws(() => verifyProtectedAssets(production.directory, production.generation, production.manifestDigest), /protected_assets_unavailable/)
  } finally { if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment; fixture.dispose() }
})
test('source mutation during actual local build rejects publication rather than falling back to an old generation', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  let modified = false
  const timer = setTimeout(() => { writeFileSync(join(fixture.root, 'src/vault.ts'), readFileSync(join(fixture.root, 'src/vault.ts'), 'utf8') + '\n'); modified = true }, 100)
  try {
    await assert.rejects(buildProtected({ desktopRoot: fixture.root, command: 'serve', mode: 'development' }), /protected_assets_unavailable/)
    assert.equal(modified, true)
  } finally { clearTimeout(timer); fixture.dispose() }
})
test('watch admission reads merged build.watch, leaving ordinary configuration untouched', () => {
  const plugin = protectedWatchPolicy()
  const hook = plugin.config as (config: { build?: { watch?: object | null } }, environment: unknown) => { define: Record<string, string> }
  const normal = { build: { watch: null } }
  assert.equal(hook(normal, {}).define.__VAULT_PROTECTED_WATCH_UNSUPPORTED__, 'false')
  const watched = { build: { watch: {} } }
  assert.equal(hook(watched, {}).define.__VAULT_PROTECTED_WATCH_UNSUPPORTED__, 'true')
  assert.deepEqual(watched, { build: { watch: {} } })
})
function compilationPlugins(bundle: Awaited<ReturnType<typeof buildProtected>>): Plugin[] {
  return 'compilation' in bundle ? (bundle.compilation as { vitePlugins(): Plugin[] }).vitePlugins() : [protectedWatchPolicy()]
}
async function compileOwner(root: string, bundle: Awaited<ReturnType<typeof buildProtected>>, entry: string, plugins: Plugin[] = []) {
  return compile({ configFile: false, root, logLevel: 'error', plugins: [...plugins, ...compilationPlugins(bundle)],
    build: { ssr: true, target: 'node24', write: false, rollupOptions: { input: join(root, entry), external: ['electron'], output: { format: 'cjs' } } } })
}
test('same snapshot freezes package metadata and rejects mutations', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  try {
    const bundle = await buildProtected({ desktopRoot: fixture.root, command: 'build', mode: 'production' })
    const filename = join(fixture.root, 'package.json')
    const original = readFileSync(filename)
    const manifest = JSON.parse(readFileSync(join(bundle.directory, 'manifest.json'), 'utf8'))
    assert.ok(manifest.sources.some((source: { path: string; sha256: string }) =>
      source.path === 'package.json' && source.sha256 === protectedDigest(original)))
    await compileOwner(fixture.root, bundle, 'src/main/release.ts')
    writeFileSync(filename, JSON.stringify({ ...JSON.parse(original.toString('utf8')), version: '99.0.0' }))
    await assert.rejects(compileOwner(fixture.root, bundle, 'src/main/release.ts'), /protected_assets_unavailable/)
    writeFileSync(filename, original)
    await compileOwner(fixture.root, bundle, 'src/main/release.ts')
    const toolchain = join(fixture.root, '../../scripts/vendor/texlive/manifest.json')
    const toolchainBytes = readFileSync(toolchain)
    assert.ok(manifest.sources.some((source: { path: string; sha256: string }) =>
      source.path === '../../scripts/vendor/texlive/manifest.json' && source.sha256 === protectedDigest(toolchainBytes)))
    writeFileSync(toolchain, '{}')
    await assert.rejects(compileOwner(fixture.root, bundle, 'src/main/release.ts'), /protected_assets_unavailable/)
    writeFileSync(toolchain, toolchainBytes)
  } finally { fixture.dispose() }
})
test('same snapshot rejects protocol and native bridge edits after protected return', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  try {
    const bundle = await buildProtected({ desktopRoot: fixture.root, command: 'serve', mode: 'development' })
    for (const name of ['src/vault.ts', 'native/domains.cjs', 'scripts/shared/lease.mjs']) {
      const filename = join(fixture.root, name)
      const original = readFileSync(filename, 'utf8')
      writeFileSync(filename, original + '\n// changed after source capture\n')
      await assert.rejects(compileOwner(fixture.root, bundle, 'src/main/vault.ts'), /protected_assets_unavailable/)
      writeFileSync(filename, original)
    }
  } finally { fixture.dispose() }
})
test('same snapshot rejects Main-loaded ABA before restored inventory', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  try {
    const bundle = await buildProtected({ desktopRoot: fixture.root, command: 'serve', mode: 'development' })
    const protocol = join(fixture.root, 'src/vault.ts')
    const original = readFileSync(protocol, 'utf8')
    const changed = original.replace("status: 'vault:status'", "status: 'vault:modified-status'")
    let loaded = false
    const aba: Plugin = { name: 'controlled-protocol-load-aba', enforce: 'pre', load(id) {
      if (id.endsWith('/src/vault.ts')) {
        writeFileSync(protocol, changed)
        const code = readFileSync(protocol, 'utf8')
        writeFileSync(protocol, original)
        loaded = true
        return code
      }
      return null
    } }
    await assert.rejects(compileOwner(fixture.root, bundle, 'src/main/vault.ts', [aba]), /protected_assets_unavailable/)
    assert.equal(loaded, true)
    assert.equal(readFileSync(protocol, 'utf8'), original)
  } finally { fixture.dispose() }
})
test(
  'actual Main build references only native assets emitted for its platform',
  { timeout: 60000 },
  async () => {
    const fixture = isolatedSource()
    try {
      const resolved = await resolveConfig(
        { root: fixture.root, configFile: join(fixture.root, 'electron.vite.config.ts') },
        'serve'
      )
      assert.ok(resolved.config?.main)
      const owner = resolved.config.main
      const built = await compile({
        ...owner,
        root: fixture.root,
        configFile: false,
        logLevel: 'error',
        build: { ...owner.build, write: false, watch: null },
      })
      assert.ok(!Array.isArray(built) && 'output' in built)
      const emitted = new Set(built.output.map((item) => item.fileName))
      const nativeImports = new Set<string>()
      for (const item of built.output) {
        if (item.type !== 'chunk') continue
        const ast = ts.createSourceFile(
          item.fileName,
          item.code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS
        )
        const inspect = (node: ts.Node): void => {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'require' &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text.endsWith('.node')
          ) {
            const dependency = posix.normalize(
              posix.join(posix.dirname(item.fileName), node.arguments[0].text)
            )
            assert.ok(
              emitted.has(dependency),
              `missing native asset: ${item.fileName}: ${dependency}`
            )
            nativeImports.add(dependency)
          }
          ts.forEachChild(node, inspect)
        }
        inspect(ast)
      }
      assert.equal(nativeImports.has('notarization.node'), process.platform === 'darwin')
      assert.equal(nativeImports.has('velopack.node'), process.platform === 'win32')
      assert.deepEqual(
        [...nativeImports].sort(),
        [...emitted].filter((name) => name.endsWith('.node')).sort(),
        'native imports and emitted assets must match in both directions'
      )
      assert.equal(nativeImports.has('notification.node'), process.platform === 'win32')
    } finally {
      fixture.dispose()
    }
  }
)

test('actual config Main and ordinary preload compile unchanged closed snapshot', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  try {
    const resolved = await resolveConfig({ root: fixture.root, configFile: join(fixture.root, 'electron.vite.config.ts') }, 'serve')
    assert.ok(resolved.config)
    assert.ok(resolved.config.main)
    assert.ok(resolved.config.preload)
    for (const owner of [resolved.config.main, resolved.config.preload]) {
      await compile({ ...owner, root: fixture.root, configFile: false, logLevel: 'error', build: { ...owner.build, write: false, watch: null } })
    }
  } finally { fixture.dispose() }
})

test('closed snapshot rejects preload, Main and menu source mutations during compilation', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  try {
    const bundle = await buildProtected({ desktopRoot: fixture.root, command: 'build', mode: 'production' })
    const protocol = join(fixture.root, 'src/vault.ts')
    const original = readFileSync(protocol, 'utf8')
    const changed = original.replace("status: 'vault:status'", "status: 'vault:modified-status'")
    const mutation: Plugin = { name: 'controlled-preload-source-mutation', enforce: 'pre', load(id) {
      if (id.endsWith('/src/preload/index.ts')) writeFileSync(protocol, changed)
      return null
    } }
    await assert.rejects(compileOwner(fixture.root, bundle, 'src/preload/index.ts', [mutation]), /protected_assets_unavailable/)
    writeFileSync(protocol, original)
    const vault = join(fixture.root, 'src/main/vault.ts')
    const vaultSource = readFileSync(vault, 'utf8')
    const mainMutation: Plugin = { name: 'controlled-Main-source-mutation', enforce: 'pre', load(id) {
      if (id.endsWith('/src/main/vault.ts')) writeFileSync(vault, vaultSource + '\n')
      return null
    } }
    await assert.rejects(compileOwner(fixture.root, bundle, 'src/main/vault.ts', [mainMutation]), /protected_assets_unavailable/)
    writeFileSync(vault, vaultSource)
    await compilePreload({ absWorkingDir: fixture.root, entryPoints: ['src/preload/menu.ts'], bundle: true, platform: 'node', format: 'cjs',
      write: false, external: ['electron'], plugins: [bundle.compilation.esbuildPlugin(() => false)] })
    const menu = join(fixture.root, 'src/menu.ts')
    writeFileSync(menu, readFileSync(menu, 'utf8') + '\n')
    await assert.rejects(compilePreload({ absWorkingDir: fixture.root, entryPoints: ['src/preload/menu.ts'], bundle: true, platform: 'node', format: 'cjs',
      write: false, external: ['electron'], plugins: [bundle.compilation.esbuildPlugin(() => false)] }), /protected_assets_unavailable/)
  } finally { fixture.dispose() }
})
test('compilation snapshot gates are disabled for ordinary merged watch only', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  try {
    const bundle = await buildProtected({ desktopRoot: fixture.root, command: 'serve', mode: 'development' })
    const plugins = bundle.compilation.vitePlugins()
    const first = plugins[0]
    const configure = first.configResolved as (config: unknown) => void
    configure({ build: { watch: null } })
    const load = first.load as (id: string) => unknown
    assert.throws(() => load(join(fixture.root, 'src/vault.ts') + '?uncontrolled-code'), /protected_assets_unavailable/)
    configure({ build: { watch: {} } })
    const source = join(fixture.root, 'src/vault.ts')
    writeFileSync(source, readFileSync(source, 'utf8') + '\n')
    assert.equal(load(source), null)
    const start = first.buildStart as () => void
    assert.doesNotThrow(start)
  } finally { fixture.dispose() }
})

test('actual Main config compiles installed ws without native loads and preserves binary and UTF-8 paths', { timeout: 60000 }, async () => {
  const fixture = isolatedSource()
  const nativeModules = new Set(['bufferutil', 'utf-8-validate'])
  const probe = join(fixture.root, 'src/main/wsprobe.ts')
  const compiled = join(fixture.root, '../../compiled.cjs')
  const runner = join(fixture.root, '../../runner.cjs')
  try {
    writeFileSync(probe, `import { WebSocket, WebSocketServer } from 'ws'
import buffers from ${JSON.stringify(join(desktop, 'node_modules/ws/lib/buffer-util.js'))}
import validation from ${JSON.stringify(join(desktop, 'node_modules/ws/lib/validation.js'))}
export { WebSocket, WebSocketServer, buffers, validation }
`)
    const resolved = await resolveConfig({ root: fixture.root, configFile: join(fixture.root, 'electron.vite.config.ts') }, 'serve')
    assert.ok(resolved.config)
    assert.ok(resolved.config.main)
    const output = await compile({ ...resolved.config.main, root: fixture.root, configFile: false, logLevel: 'error',
      build: { ...resolved.config.main.build, write: false, watch: null,
        rollupOptions: { ...resolved.config.main.build?.rollupOptions, input: probe, output: { format: 'cjs' } } } })
    assert.ok(!Array.isArray(output) && 'output' in output)
    const chunks = output.output.filter(item => item.type === 'chunk')
    assert.equal(chunks.length, 1)
    const code = chunks[0].code
    const ast = ts.createSourceFile(compiled, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const loads: string[] = []
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require' ||
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require')) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument) && nativeModules.has(argument.text)) loads.push(argument.text)
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) && nativeModules.has(node.moduleSpecifier.text)) loads.push(node.moduleSpecifier.text)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    assert.deepEqual(loads, [], 'compiled installed ws must contain zero optional native module loads')
    writeFileSync(compiled, code)
    writeFileSync(runner, `const assert = require('node:assert/strict')
const buffer = require('node:buffer')
const { once } = require('node:events')
const hostValidator = buffer.isUtf8
const mode = process.argv[3]
let hostCalls = 0
buffer.isUtf8 = mode === 'absent' ? undefined : bytes => { hostCalls++; return hostValidator(bytes) }
const { WebSocket, WebSocketServer, buffers, validation } = require(process.argv[2])
const byteValues = 256
const binaryLength = byteValues * 128
const offset = 7
const sentinel = 191
const mask = Buffer.from([0, 255, 85, 170])
const source = Buffer.from(Array.from({ length: binaryLength }, (_, index) => index % byteValues))
for (const length of [0, 1, 3, 4, 31, 32, 47, 48, byteValues, binaryLength]) {
  const input = source.subarray(0, length)
  const output = Buffer.alloc(length + offset * 2, sentinel)
  buffers.mask(input, mask, output, offset, length)
  assert.ok(output.subarray(0, offset).every(value => value === sentinel))
  assert.ok(output.subarray(offset + length).every(value => value === sentinel))
  for (let index = 0; index < length; index++) assert.equal(output[offset + index], input[index] ^ mask[index % mask.length])
  const masked = output.subarray(offset, offset + length)
  buffers.unmask(masked, mask)
  assert.deepEqual(masked, input)
}
const valid = ['', 'ascii', '汉字 🌱 é', '汉字 🌱 é'.repeat(4096)]
const invalid = [[128], [194], [194, 32], [192, 175], [237, 160, 128], [244, 144, 128, 128], [245, 128, 128, 128], [226, 130]]
for (const text of valid) assert.equal(validation.isValidUTF8(Buffer.from(text)), true)
for (const bytes of invalid) {
  assert.equal(validation.isValidUTF8(Buffer.from(bytes)), false)
  assert.equal(validation.isValidUTF8(Buffer.concat([Buffer.alloc(256, 97), Buffer.from(bytes)])), false)
}
assert.equal(mode === 'absent' ? hostCalls === 0 : hostCalls > 0, true)
async function roundtrip() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let client
  try {
    await once(server, 'listening')
    server.on('connection', socket => socket.on('message', (bytes, binary) => socket.send(bytes, { binary })))
    client = new WebSocket('ws://127.0.0.1:' + server.address().port)
    await once(client, 'open')
    for (const [payload, binary] of [[source, true], [Buffer.from(valid[3]), false]]) {
      const response = once(client, 'message')
      client.send(payload, { binary })
      const [bytes, actualBinary] = await response
      assert.deepEqual(bytes, payload)
      assert.equal(actualBinary, binary)
    }
  } finally {
    if (client) client.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  console.log(JSON.stringify({ mode, nativeLoads: 0, maskLengths: 10, binaryLength, validUtf8: valid.length, invalidUtf8: invalid.length * 2, hostCalls, websocketRoundtrip: true }))
}
roundtrip().catch(error => { console.error(error); process.exitCode = 1 })
`)
    for (const mode of ['present', 'absent']) {
      const result = spawnSync(process.execPath, [runner, compiled, mode], { encoding: 'utf8', timeout: 20000 })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      console.log(result.stdout.trim())
    }
  } finally { fixture.dispose() }
})
