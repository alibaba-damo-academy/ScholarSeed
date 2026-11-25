import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { after, before, test as nodeTest, type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'
import { zipSync } from 'fflate'
import { MACOS_UPDATE_ZIP } from '../updates.ts'
import { assertSquirrelArchiveSize } from './archive.ts'
import { InstallationProgress } from './installation.ts'
import { PreparedArchive } from './prepared.ts'
import { samePreviewArtifact } from './preview.ts'
import { setupPreviewCache, updaterFunctions } from './previewcache.fixture.ts'
import { updateArtifactKind } from './staging.ts'
import { gzipSync } from 'node:zlib'
import { rebuildMacUpdateZip } from './maccomponents.ts'
import { macComponentDiagnostic } from './maccomponentfailure.ts'
import { reclaimMacComponentCache, type MacCacheNative } from './maccomponentcache.ts'

const test = process.platform === 'darwin' ? nodeTest : nodeTest.skip
let nativeLibrary: string

if (process.platform === 'darwin') {
  let buildRoot: string | undefined
  after(async () => {
    if (buildRoot) await rm(buildRoot, { recursive: true, force: true })
  })
  before(async () => {
    nativeLibrary = process.env.SCHOLARSEED_LEASE_LIBRARY ?? ''
    if (nativeLibrary) return
    buildRoot = await mkdtemp(join(await realpath(tmpdir()), 'maccomponents-native-'))
    const directory = join(buildRoot, 'native')
    const { compileNative } = createRequire(import.meta.url)('../../scripts/shared/native.cjs')
    await compileNative({ directory })
    nativeLibrary = join(directory, 'lease.node')
  })
}

const digest = (data: Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(data).digest('hex')
function record(text: string | Buffer, index: number, offset = 0, length = 0): Buffer {
  const header = Buffer.alloc(25)
  header.writeBigUInt64LE(BigInt(Buffer.byteLength(text)))
  header[8] = index
  header.writeBigUInt64LE(BigInt(offset), 9)
  header.writeBigUInt64LE(BigInt(length), 17)
  return Buffer.concat([header, typeof text === 'string' ? Buffer.from(text) : text])
}
const magic = Buffer.from('SSZIP1\0')

function release(version: string, layoutOverride?: Buffer) {
  const app = Buffer.from(version)
  const python = Buffer.from('python')
  const member = Buffer.concat([python.subarray(2), app, python.subarray(0, 2)])
  const payload = Buffer.from(
    zipSync(
      {
        'ScholarSeed.app/': new Uint8Array(),
        'ScholarSeed.app/Contents/Info.plist': member,
      },
      { level: 0 }
    )
  )
  const start = payload.indexOf(member)
  assert.ok(start >= 0)
  const layout = gzipSync(
    layoutOverride ??
      Buffer.concat([
        magic,
        record(payload.subarray(0, start), 1, 2, 4),
        record('', 0, 0, app.length),
        record('', 1, 0, 2),
        record(payload.subarray(start + member.length), 255),
      ])
  )
  const versions = { app, python, layout }
  const blobs = new Map<string, Buffer>()
  const objects = Object.fromEntries(
    Object.entries(versions).map(([name, data]) => {
      const sha256 = digest(data)
      const url = `https://updates.example/${sha256}?signature=ephemeral`
      blobs.set(url, data)
      return [name, { bytes: data.length, sha256, url }]
    })
  )
  const sha512 = digest(payload, 'sha512')
  return {
    blobs,
    payload,
    components: {
      version: 1,
      component_order: ['app', 'python'],
      zip_bytes: payload.length,
      zip_sha512: sha512,
      objects,
    },
    expected: { file_size: payload.length, sha512 },
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'maccomponents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cacheDirectory = join(root, 'objects')
  const destination = join(root, 'release.zip')
  const requests: string[] = []
  const available = new Map<string, Buffer>()
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(init.redirect, 'error')
    requests.push(url.href)
    const data = available.get(url.href)
    return data
      ? new Response(new Uint8Array(data), { headers: { 'content-length': String(data.length) } })
      : new Response(null, { status: 404 })
  })
  function prepare(version: string, layout?: Buffer) {
    const build = release(version, layout)
    for (const [url, blob] of build.blobs) available.set(url, blob)
    const native = createRequire(import.meta.url)(nativeLibrary) as MacCacheNative
    return {
      ...build,
      destination,
      cacheDirectory,
      native,
      downloadUrl: 'https://updates.example/release.zip',
    }
  }
  return { prepare, requests, available, root, destination, cacheDirectory }
}

test('cold and warm builds pin exact ranges and retain only the latest verified objects', async (t) => {
  const ctx = await fixture(t)
  const first = ctx.prepare('one')
  const progress: number[] = []
  const cold = await rebuildMacUpdateZip({
    ...first,
    onProgress: (percent) => progress.push(percent),
  })
  assert.equal(cold.reusedBytes, 0)
  assert.equal(
    cold.downloadedBytes,
    [...first.blobs.values()].reduce((sum, obj) => sum + obj.length, 0)
  )
  assert.equal(progress.at(-1), 100)
  assert.deepEqual(
    progress,
    [...progress].sort((a, b) => a - b)
  )
  assert.deepEqual(await readFile(ctx.destination), first.payload)
  ctx.requests.length = 0
  const target = ctx.prepare('new-version')
  const { objects } = target.components
  const warm = await rebuildMacUpdateZip(target)
  assert.deepEqual(ctx.requests.sort(), [objects.app.url, objects.layout.url].sort())
  assert.equal(warm.reusedBytes, objects.python.bytes)
  assert.equal(warm.downloadedBytes, objects.app.bytes + objects.layout.bytes)
  assert.deepEqual(await readFile(ctx.destination), target.payload)
  assert.deepEqual(
    (await readdir(ctx.cacheDirectory)).sort(),
    Object.values(objects)
      .map((obj) => obj.sha256)
      .sort()
  )
  ctx.requests.length = 0
  assert.equal((await rebuildMacUpdateZip(target)).downloadedBytes, 0)
  assert.deepEqual(ctx.requests, [])
})

test('repair a damaged retained object and reject a corrupt response without touching a resumable ZIP', async (t) => {
  const ctx = await fixture(t)
  const build = ctx.prepare('same')
  await rebuildMacUpdateZip(build)
  const obj = build.components.objects.python
  await writeFile(join(ctx.cacheDirectory, obj.sha256), Buffer.alloc(obj.bytes))
  ctx.requests.length = 0
  await rebuildMacUpdateZip(build)
  assert.deepEqual(ctx.requests, [obj.url])
  const bad = ctx.prepare('next')
  ctx.available.set(bad.components.objects.app.url, Buffer.from('oops'))
  await writeFile(ctx.destination, 'resumable')
  await assert.rejects(rebuildMacUpdateZip(bad), /differs from release object/)
  assert.equal(await readFile(ctx.destination, 'utf8'), 'resumable')
  assert.deepEqual(
    (await readdir(ctx.cacheDirectory)).sort(),
    Object.values(build.components.objects)
      .map((obj) => obj.sha256)
      .sort()
  )
})

test('validate manifest identity, bounded sizes, component order and HTTPS before transfer', async (t) => {
  const ctx = await fixture(t)
  const build = ctx.prepare('checks')
  const c = build.components
  for (const invalid of [
    { ...c, version: 2 },
    { ...c, zip_sha512: '0'.repeat(128) },
    { ...c, zip_bytes: 1 },
    { ...c, component_order: ['python', 'app'] },
    { ...c, component_order: ['app', 'app'] },
    { ...c, component_order: ['app', 'unknown'] },
    { ...c, objects: { ...c.objects, extra: c.objects.app } },
    ...[
      { bytes: -1 },
      { bytes: c.zip_bytes + 1 },
      { url: 'http://example.test/file' },
      { url: 'https://other.example/signature' },
      { url: 'https://updates.example:8443/object' },
      { sha256: '../x' },
      { url: 'https://u:p@example.test/' },
    ].map((patch) => ({ ...c, objects: { ...c.objects, app: { ...c.objects.app, ...patch } } })),
    { ...c, objects: { ...c.objects, layout: { ...c.objects.layout, bytes: 64 * 1024 ** 2 + 1 } } },
  ])
    await assert.rejects(rebuildMacUpdateZip({ ...build, components: invalid }))
  await assert.rejects(
    rebuildMacUpdateZip({ ...build, downloadUrl: 'http://updates.example/release.zip' })
  )
  assert.deepEqual(ctx.requests, [])
})

test('component failures distinguish HTTP, integrity, cache and manifest errors without logging signed URLs', async (t) => {
  const ctx = await fixture(t)
  const build = ctx.prepare('diagnostic')
  const app = build.components.objects.app
  async function check(operation: Promise<unknown>, expected: object) {
    await assert.rejects(operation, (error) => {
      // Match the same JSON fields persisted by logUpdateEvent.
      assert.deepEqual(JSON.parse(JSON.stringify(macComponentDiagnostic(error))), expected)
      return true
    })
  }
  await check(rebuildMacUpdateZip({ ...build, downloadUrl: 'bad URL?signature=secret' }), {
    stage: 'manifest',
    errorCode: 'invalid-manifest',
  })
  await mkdir(ctx.cacheDirectory)
  await chmod(ctx.cacheDirectory, 0o755)
  await check(rebuildMacUpdateZip(build), { stage: 'cache', errorCode: 'unsafe-cache' })
  await rm(ctx.cacheDirectory, { recursive: true })
  ctx.available.delete(app.url)
  await check(rebuildMacUpdateZip(build), {
    stage: 'download',
    errorCode: 'http-status',
    httpStatus: 404,
  })
  ctx.available.set(app.url, Buffer.alloc(app.bytes))
  await check(rebuildMacUpdateZip(build), { stage: 'download', errorCode: 'integrity-mismatch' })
  const wrong = '0'.repeat(128)
  const next = ctx.prepare('diagnostic')
  await check(
    rebuildMacUpdateZip({
      ...next,
      expected: { ...next.expected, sha512: wrong },
      components: { ...next.components, zip_sha512: wrong },
    }),
    { stage: 'assembly', errorCode: 'integrity-mismatch' }
  )
  await check(rebuildMacUpdateZip(ctx.prepare('diagnostic', Buffer.from('invalid layout'))), {
    stage: 'assembly',
    errorCode: 'invalid-layout',
  })
})

test('reject invalid layouts and final SHA-512 even when each object verifies', async (t) => {
  const ctx = await fixture(t)
  await writeFile(ctx.destination, 'part of full ZIP')
  for (const layout of [
    Buffer.from('bad magic'),
    Buffer.concat([magic, record('', 0, 4, 22)]),
    Buffer.concat([magic, record('', 3, 0, 1)]),
    Buffer.concat([magic, record('', 255), Buffer.from('extra')]),
    Buffer.concat([magic, record('', 255, 1)]),
    Buffer.concat([magic, record('literal', 255).subarray(0, 26)]),
    Buffer.concat([magic, record('short', 255)]),
    Buffer.concat([magic, record('', 255).subarray(0, 9)]),
    Buffer.concat([magic, record('X'.repeat(100), 255)]),
  ])
    await assert.rejects(rebuildMacUpdateZip(ctx.prepare('layout', layout)))
  const build = ctx.prepare('identity')
  const wrong = '1'.repeat(128)
  await assert.rejects(
    rebuildMacUpdateZip({
      ...build,
      components: { ...build.components, zip_sha512: wrong },
      expected: { ...build.expected, sha512: wrong },
    }),
    /differs from release metadata/
  )
  assert.equal(await readFile(ctx.destination, 'utf8'), 'part of full ZIP')
  assert.deepEqual(await readdir(ctx.cacheDirectory), [])
})

test('abort cleans staging while retaining the previous cache and ZIP', async (t) => {
  const ctx = await fixture(t)
  const first = ctx.prepare('source')
  await rebuildMacUpdateZip(first)
  const controller = new AbortController()
  const reason = new Error('candidate superseded')
  const target = ctx.prepare('target')
  await assert.rejects(
    rebuildMacUpdateZip({
      ...target,
      signal: controller.signal,
      onProgress: (_percent, received) => {
        if (received > target.components.objects.python.bytes) controller.abort(reason)
      },
    }),
    (error) => error === reason
  )
  assert.deepEqual(await readFile(ctx.destination), first.payload)
  assert.deepEqual(
    (await readdir(ctx.cacheDirectory)).sort(),
    Object.values(first.components.objects)
      .map((obj) => obj.sha256)
      .sort()
  )
})

test('reject symlinked cache directories and entries', async (t) => {
  const ctx = await fixture(t)
  const build = ctx.prepare('unsafe')
  const other = join(ctx.root, 'other')
  await mkdir(other, { mode: 0o700 })
  await symlink(other, ctx.cacheDirectory)
  await assert.rejects(rebuildMacUpdateZip(build), /Unsafe/)
  await rm(ctx.cacheDirectory)
  await mkdir(ctx.cacheDirectory, { mode: 0o700 })
  const target = join(other, 'unrelated')
  await writeFile(target, 'untouched')
  await symlink(target, join(ctx.cacheDirectory, build.components.objects.app.sha256))
  await assert.rejects(rebuildMacUpdateZip(build))
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  assert.deepEqual(ctx.requests, [])
})

test('reclaim only component bytes under the cache lock and preserve the resumable full ZIP', async (t) => {
  const ctx = await fixture(t)
  const build = ctx.prepare('reclaim')
  const reclaim = (signal: AbortSignal) =>
    reclaimMacComponentCache(build.native, ctx.cacheDirectory, signal)
  const signal = new AbortController().signal
  await reclaim(signal)
  assert.deepEqual(await readdir(ctx.root), [])
  await rebuildMacUpdateZip(build)
  await writeFile(ctx.destination, 'partial ZIP')
  await mkdir(join(ctx.cacheDirectory, 'staging'), { mode: 0o700 })
  await writeFile(join(ctx.cacheDirectory, 'staging', 'assembled.zip'), 'partial assembly')
  await writeFile(join(ctx.cacheDirectory, 'unrelated'), 'keep')
  const pin = build.native.pin(ctx.cacheDirectory, false)
  const lock = build.native.lockDirectoryAt!(pin)
  try {
    await assert.rejects(reclaim(AbortSignal.timeout(50)), /abort|timeout/i)
    assert.equal(
      await readFile(join(ctx.cacheDirectory, 'staging', 'assembled.zip'), 'utf8'),
      'partial assembly'
    )
  } finally {
    build.native.release(lock)
    build.native.release(pin)
  }
  await reclaim(signal)
  assert.deepEqual(await readdir(ctx.cacheDirectory), ['unrelated'])
  assert.equal(await readFile(ctx.destination, 'utf8'), 'partial ZIP')
})

test('recover space in the sibling lane before giving up on a warm component build', async (t) => {
  const ctx = await fixture(t)
  const source = ctx.prepare('source')
  const cacheDirectory = join(ctx.root, 'mac-components')
  await rebuildMacUpdateZip({ ...source, cacheDirectory })
  await rm(ctx.destination)
  const build = ctx.prepare('target')
  const siblingCache = join(ctx.root, 'preview', 'mac-components')
  await mkdir(siblingCache, { recursive: true, mode: 0o700 })
  const object = join(siblingCache, 'a'.repeat(64))
  await writeFile(object, 'previous channel')
  const space = t.mock.method(fs, 'statfsSync', () => ({
    bavail: existsSync(object) ? 0n : 8192n,
    bsize: 4096n,
  }))
  syncBuiltinESMExports()
  t.after(() => {
    space.mock.restore()
    syncBuiltinESMExports()
  })
  ctx.requests.length = 0
  const candidate = { id: 'zip', artifact_kind: MACOS_UPDATE_ZIP, ...build.expected }
  const events: { event: string; reusedBytes?: number }[] = []
  const stage = runInNewContext(
    updaterFunctions([
      'stageUpdate',
      'ensureMacUpdateSpace',
      'inactiveMacCache',
      'downloadResumable',
    ]) + '\nstageUpdate',
    {
      exports: {},
      process,
      AbortController,
      MACOS_PLATFORM: 'darwin',
      MACOS_UPDATE_ZIP,
      PREVIEW_CANDIDATE_DIRNAME: 'preview',
      macPrepared: null,
      activeReadyAlternate: false,
      readReadyState: () => null,
      macHandoffCommitted: () => false,
      getDownloadInfo: () => ({
        ...candidate,
        download_url: build.downloadUrl,
        macos_zip_components: build.components,
      }),
      samePreviewArtifact,
      assertSquirrelArchiveSize,
      basename,
      dirname,
      join,
      stagedInstallerPath: () => ctx.destination,
      preparedApplicationDirectory: () => ctx.destination + '.prepared',
      discardPreparedApplications() {},
      pruneInactiveMacCache() {},
      pruneUpdateArtifacts() {},
      updateCacheRoot: () => ctx.root,
      existsSync,
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: fs.realpathSync,
      readdirSync: fs.readdirSync,
      updateArtifactKind,
      desktopDirectoryNative: () => build.native,
      rebuildMacUpdateZip,
      reclaimMacComponentCache,
      macComponentDiagnostic,
      PreparedArchive,
      InstallationProgress,
      assertDownloadSpace() {
        assert.fail('unexpected fallback to full ZIP')
      },
      logTiming() {},
      writeReadyState() {},
      logUpdateEvent(_log: unknown, fields: { event: string }) {
        events.push(fields)
      },
    }
  )
  const result = await stage(
    candidate,
    () => {},
    () => {},
    new AbortController().signal
  )
  assert.equal(result.ok, true, result.error)
  assert.equal(result.ready.archive.sha512, candidate.sha512)
  assert.equal(existsSync(object), false)
  assert.equal(
    events.find((row) => row.event === 'zip-components')?.reusedBytes,
    build.components.objects.python.bytes
  )
  assert.deepEqual(
    ctx.requests.sort(),
    [build.components.objects.app.url, build.components.objects.layout.url].sort()
  )
  assert.deepEqual(await readFile(ctx.destination), build.payload)
})

test('disk pressure uses either safe, idle lane and preserves the original space error', async (t) => {
  const native = createRequire(import.meta.url)(nativeLibrary) as MacCacheNative
  const active = setupPreviewCache(t, false, false, 'primary', undefined, native)
  const sibling = setupPreviewCache(t, true, false, 'primary', active.root, native)
  const paths = [active, sibling].map((lane) => join(lane.cache, 'mac-components'))
  const [current, idle] = paths.map((directory) => join(directory, 'c'.repeat(64)))
  for (const directory of paths) await mkdir(directory, { mode: 0o700 })
  const pressure = Object.assign(new Error('download is out of space'), { code: 'ENOSPC' })
  const check = () => {
    if (existsSync(current) && existsSync(idle)) throw pressure
  }
  for (const unsafeActive of [false, true]) {
    await writeFile(current, 'keep')
    await writeFile(idle, 'reclaim first')
    await chmod(paths[0], unsafeActive ? 0o755 : 0o700)
    await active.ensureSpace(check)
    assert.equal(existsSync(current), true)
    assert.equal(existsSync(idle), false)
  }
  await writeFile(idle, 'keep')
  await chmod(paths[1], 0o755)
  await assert.rejects(active.ensureSpace(check), (error) => error === pressure)
  await chmod(paths[0], 0o700)
  await active.ensureSpace(check)
  assert.equal(existsSync(current), false)
  assert.equal(existsSync(idle), true)

  await writeFile(current, 'reclaim second')
  await chmod(paths[1], 0o700)
  const pin = native.pin(paths[1], false)
  const lock = native.lockDirectoryAt!(pin)
  try {
    await active.ensureSpace(check)
    assert.equal(existsSync(current), false)
    assert.equal(existsSync(idle), true)
    await writeFile(current, 'in use')
    const activePin = native.pin(paths[0], false)
    const activeLock = native.lockDirectoryAt!(activePin)
    try {
      await assert.rejects(active.ensureSpace(check), (error) => error === pressure)
      assert.equal(existsSync(current), true)
      assert.equal(existsSync(idle), true)
    } finally {
      native.release(activeLock)
      native.release(activePin)
    }
  } finally {
    native.release(lock)
    native.release(pin)
  }
})

test('retiring a displaced cache never clears staging in its replacement', async (t) => {
  const ctx = await fixture(t)
  let replaced = false
  await assert.rejects(
    rebuildMacUpdateZip({
      ...ctx.prepare('displaced'),
      onProgress() {
        if (replaced) return
        replaced = true
        renameSync(ctx.cacheDirectory, join(ctx.root, 'old-cache'))
        mkdirSync(join(ctx.cacheDirectory, 'staging'), { recursive: true, mode: 0o700 })
        writeFileSync(join(ctx.cacheDirectory, 'staging', '0'), 'other owner')
      },
    }),
    /replaced/
  )
  assert.equal(await readFile(join(ctx.cacheDirectory, 'staging', '0'), 'utf8'), 'other owner')
})

test(
  'a live process owns staging exclusively and a crashed owner releases it',
  { timeout: 15_000 },
  async (t) => {
    const ctx = await fixture(t)
    const build = ctx.prepare('contended')
    await mkdir(ctx.cacheDirectory, { mode: 0o700 })
    const worker = spawn(
      process.execPath,
      [
        '-e',
        `
    const fs = require('node:fs')
    const path = require('node:path')
    const native = require(process.argv[1])
    const dir = process.argv[2]
    const pin = native.pin(dir, false)
    global.heldLock = [pin, native.lockDirectoryAt(pin)]
    fs.mkdirSync(path.join(dir, 'staging'), { mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'staging', '0'), 'active')
    process.send('locked')
    setInterval(() => {}, 1000)
  `,
        nativeLibrary,
        ctx.cacheDirectory,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
    )
    t.after(() => {
      worker.kill('SIGKILL')
    })
    await once(worker, 'message')
    const controller = new AbortController()
    const waiting = rebuildMacUpdateZip({ ...build, signal: controller.signal })
    const abort = setTimeout(() => controller.abort(), 100)
    try {
      await assert.rejects(waiting, /abort/i)
    } finally {
      clearTimeout(abort)
    }
    assert.equal(await readFile(join(ctx.cacheDirectory, 'staging', '0'), 'utf8'), 'active')
    assert.deepEqual(ctx.requests, [])
    const afterCrash = rebuildMacUpdateZip(build)
    worker.kill('SIGKILL')
    await afterCrash
    assert.deepEqual(await readFile(ctx.destination), build.payload)
    assert.deepEqual(
      (await readdir(ctx.cacheDirectory)).sort(),
      Object.values(build.components.objects)
        .map((obj) => obj.sha256)
        .sort()
    )
  }
)

for (const preview of [true, false]) {
  const lane = preview ? 'preview' : 'release'
  test(`the ${lane} lane expires and reclaims only idle components in its sibling lane`, async (t) => {
    const native = createRequire(import.meta.url)(nativeLibrary) as MacCacheNative
    const active = setupPreviewCache(t, preview, false, 'primary', undefined, native)
    const sibling = setupPreviewCache(t, !preview, false, 'primary', active.root)
    const otherProfile = setupPreviewCache(t, !preview, false, 'other-profile', active.root)
    const makeObject = (parent: string) => {
      const directory = join(parent, 'mac-components')
      mkdirSync(directory, { mode: 0o700 })
      const object = join(directory, 'c'.repeat(64))
      writeFileSync(object, 'cached component')
      return object
    }
    const activeObject = makeObject(active.cache)
    const siblingObject = makeObject(sibling.cache)
    const unrelatedObject = makeObject(otherProfile.cache)
    const directory = dirname(siblingObject)
    const unrelated = join(directory, 'notes')
    writeFileSync(unrelated, 'keep')
    await active.pruneInactive()
    assert.ok(existsSync(siblingObject))

    utimesSync(directory, 0, 0)
    utimesSync(dirname(activeObject), 0, 0)
    utimesSync(dirname(unrelatedObject), 0, 0)
    const pin = native.pin(directory, false)
    const lock = native.lockDirectoryAt!(pin)
    const check = () => {
      if (existsSync(siblingObject)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    }
    try {
      await active.pruneInactive()
      assert.ok(existsSync(siblingObject))
      await assert.rejects(active.ensureSpace(check), { code: 'ENOSPC' })
    } finally {
      native.release(lock)
      native.release(pin)
    }
    writeFileSync(activeObject, 'active component')
    await active.pruneInactive()
    assert.equal(existsSync(siblingObject), false)
    assert.ok(existsSync(activeObject))
    writeFileSync(siblingObject, 'recently cached component')

    const mount = join(sibling.cache, 'mount-active')
    mkdirSync(mount)
    writeFileSync(join(mount, 'mounted'), 'keep')
    await assert.rejects(active.ensureSpace(check), { code: 'ENOSPC' })
    rmSync(mount, { recursive: true })
    const committed = setupPreviewCache(t, preview, true, 'primary', active.root, native)
    await assert.rejects(committed.ensureSpace(check), { code: 'ENOSPC' })
    assert.ok(existsSync(siblingObject))
    await active.ensureSpace(check)
    assert.equal(existsSync(siblingObject), false)
    for (const path of [unrelated, unrelatedObject, sibling.partial]) assert.ok(existsSync(path))
  })
}
