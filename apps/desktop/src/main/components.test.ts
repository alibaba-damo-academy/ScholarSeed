import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import {
  componentArchivePath,
  componentDownloadUrl,
  downloadRuntimeComponents,
  installedRuntimeManifest,
  reusableComponent,
  verifyComponentPaths,
  verifyRuntimeEnvelope,
} from './components.ts'
import type { RuntimeComponent, RuntimeManifest } from '../../runtime/components.cjs'
import type { DirectoryPinRole } from '../../native/domains.cjs'

const pair = generateKeyPairSync('ed25519')
const keys = {
  release: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
}
const payload = Buffer.from('runtime archive bytes')
const critical = Buffer.from('entry executable')
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function component(kind = 'python', version = '3.13.2-r1'): RuntimeComponent {
  return {
    kind,
    version,
    contentId: digest(kind),
    archive: `${kind}.zip`,
    archiveSha256: digest(payload),
    archiveBytes: payload.length,
    expandedBytes: critical.length,
    fileCount: 1,
    entry: 'bin/entry.exe',
    files: [{ path: 'bin/entry.exe', size: critical.length, sha256: digest(critical) }],
  }
}
function manifest(components = [component()]): RuntimeManifest {
  return {
    schema: 1,
    domain: 'scholarseed.runtime-components',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    app_id: 'scholarseed',
    target: 'win32-x86_64',
    components,
  }
}
function envelope(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value))
  return {
    schema: 1,
    key_id: 'release',
    manifest: bytes.toString('base64'),
    signature: sign(null, bytes, pair.privateKey).toString('base64'),
  }
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'components-')))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
async function prepare(root: string, item: RuntimeComponent) {
  const directory = join(root, 'runtime', item.kind, item.version)
  await mkdir(join(directory, 'bin'), { recursive: true })
  await writeFile(join(directory, item.entry), critical)
  await writeFile(
    join(directory, '.scholarseed-component.json'),
    JSON.stringify({
      schema: 1,
      product_id: 'scholarseed',
      kind: item.kind,
      version: item.version,
      contentId: item.contentId,
      archiveSha256: item.archiveSha256,
      inventorySha256: digest(JSON.stringify(item.files)),
      ...(['python', 'texlive', 'powershell'].includes(item.kind)
        ? {
            accessPolicy: 1,
            principalSid: 'S-1-5-21-123-456-789-1001',
            rootIdentity: '1234abcd:0000000000000123',
          }
        : {}),
    })
  )
}
function options(root: string, value = manifest()) {
  return {
    root,
    baseUrl: 'https://updates.example.test',
    manifest: value,
    native: {
      pin(path: string, _create: boolean, _role?: DirectoryPinRole) {
        return path
      },
      pinChild(parent: unknown, name: string) {
        return join(parent as string, name)
      },
      createChild(parent: unknown, name: string) {
        const child = join(parent as string, name)
        mkdirSync(child, { recursive: true })
        return child
      },
      release(_pin: unknown) {},
    },
  }
}

test('runtime envelope authenticates exact bytes, trusted key and manifest identity before use', () => {
  const signed = envelope(manifest())
  assert.deepEqual(verifyRuntimeEnvelope(signed, keys), manifest())
  assert.throws(() => verifyRuntimeEnvelope(signed, {}), /trusted/)
  assert.throws(
    () =>
      verifyRuntimeEnvelope({ ...signed, signature: Buffer.alloc(64).toString('base64') }, keys),
    /signature/
  )
  assert.throws(
    () => verifyRuntimeEnvelope(envelope({ ...manifest(), product_id: 'other' }), keys),
    /manifest/
  )
  assert.throws(
    () =>
      verifyRuntimeEnvelope(
        envelope(manifest([{ ...component(), archive: '../python.zip' }])),
        keys
      ),
    /manifest/
  )
  assert.throws(
    () =>
      verifyRuntimeEnvelope(
        envelope(manifest([component('a-b', '1-r1'), component('a', 'b-1-r1')])),
        keys
      ),
    /manifest|collide/
  )
})

test('initial installation reads the exact embedded signed manifest and rejects altered bytes', async () =>
  fixture(async (root) => {
    const directory = join(root, 'current', 'resources', 'components')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'runtime.json'), JSON.stringify(envelope(manifest())))
    assert.deepEqual(await installedRuntimeManifest(join(root, 'current'), keys), manifest())
    const altered = envelope(manifest())
    altered.manifest = Buffer.from(JSON.stringify(manifest([component('office')]))).toString(
      'base64'
    )
    await writeFile(join(directory, 'runtime.json'), JSON.stringify(altered))
    await assert.rejects(installedRuntimeManifest(join(root, 'current'), keys), /signature/)
  }))

test('unchanged component works offline without touching an archive or creating archive storage', async (t) =>
  fixture(async (root) => {
    await prepare(root, component())
    const network = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('must not download')
    })
    await downloadRuntimeComponents(options(root))
    assert.equal(network.mock.callCount(), 0)
    assert.deepEqual(await readdir(join(root, 'runtime')), ['python'])
  }))

test('cross-version program full still downloads only the changed component, including a new registered kind', async (t) =>
  fixture(async (root) => {
    await prepare(root, component())
    const urls: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: URL) => {
      urls.push(url.href)
      return new Response(payload)
    })
    const browser = component('browser', '1.0-r2')
    await downloadRuntimeComponents(options(root, manifest([component(), browser])))
    assert.deepEqual(urls, [componentDownloadUrl(options(root).baseUrl, manifest(), browser).href])
    assert.deepEqual(await readFile(componentArchivePath(root, browser)), payload)
    assert.deepEqual(await readdir(join(root, 'runtime', '.archives')), ['browser-1.0-r2.zip'])
    // A later retry consumes authenticated downloaded bytes without another request.
    await downloadRuntimeComponents(options(root, manifest([component(), browser])))
    assert.equal(urls.length, 1)
  }))

test('receipt identity and critical-entry corruption reject without overwriting a runtime or network fallback', async (t) =>
  fixture(async (root) => {
    const item = component()
    await prepare(root, item)
    const network = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('must not download')
    })
    await assert.rejects(
      downloadRuntimeComponents(options(root, manifest([{ ...item, contentId: 'a'.repeat(64) }]))),
      /identity/
    )
    await writeFile(
      join(root, 'runtime', item.kind, item.version, item.entry),
      Buffer.from('tampered')
    )
    await assert.rejects(downloadRuntimeComponents(options(root)), /size|changed/)
    assert.equal(network.mock.callCount(), 0)
  }))

test('component download rejects short, oversized and wrong-hash responses and removes its partial file', async (t) =>
  fixture(async (root) => {
    for (const bytes of [
      payload.subarray(1),
      Buffer.concat([payload, Buffer.from('!')]),
      Buffer.alloc(payload.length),
    ]) {
      const mock = t.mock.method(globalThis, 'fetch', async () => new Response(bytes))
      await assert.rejects(downloadRuntimeComponents(options(root)), /signed size|digest/)
      assert.deepEqual(await readdir(join(root, 'runtime', '.archives')), [])
      mock.mock.restore()
    }
  }))

test('cancellation cleans partial bytes and a later retry can complete', async (t) =>
  fixture(async (root) => {
    const controller = new AbortController()
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(payload.subarray(0, 3))
              stream.enqueue(payload.subarray(3))
              stream.close()
            },
          })
        )
    )
    await assert.rejects(
      downloadRuntimeComponents({
        ...options(root),
        signal: controller.signal,
        onProgress: (state) => {
          if (state.phase === 'downloading') controller.abort()
        },
      }),
      /abort/i
    )
    assert.deepEqual(await readdir(join(root, 'runtime', '.archives')), [])
    await downloadRuntimeComponents(options(root))
    assert.deepEqual(await readFile(componentArchivePath(root, component())), payload)
  }))

test('redirects are bounded and refuse downgrade before issuing an HTTP request', async (t) =>
  fixture(async (root) => {
    const downgrade = t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://unsafe.test/data' } })
    )
    await assert.rejects(downloadRuntimeComponents(options(root)), /HTTPS/)
    assert.equal(downgrade.mock.callCount(), 1)
    downgrade.mock.restore()
    const loop = t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/data' } })
    )
    await assert.rejects(downloadRuntimeComponents(options(root)), /redirect limit/)
    assert.equal(loop.mock.callCount(), 4)
  }))

test('HTTPS object redirect retains immutable requested identity and verifies response length', async (t) =>
  fixture(async (root) => {
    const requests: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: URL) => {
      requests.push(url.href)
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.test/fixed/python.zip?token=signed' },
          })
        : new Response(payload, { headers: { 'content-length': String(payload.length) } })
    })
    await downloadRuntimeComponents(options(root))
    assert.match(requests[0], new RegExp(`/win32-x86_64/python/3.13.2-r1/${digest(payload)}$`))
    assert.equal(requests.length, 2)
  }))

test('path and linked-directory failures occur before creating or downloading component data', async (t) =>
  fixture(async (root) => {
    assert.throws(
      () => verifyComponentPaths(join(root, 'x'.repeat(240)), manifest()),
      /path exceeds/
    )
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(root, 'runtime'), 'junction')
    const network = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('must not download')
    })
    await assert.rejects(downloadRuntimeComponents(options(root)), /link/)
    assert.equal(network.mock.callCount(), 0)
    assert.deepEqual(await readdir(outside), [])
  }))

test('directory entry reuses the first signed critical member', async () =>
  fixture(async (root) => {
    const item = component('texlive')
    item.entry = 'bin'
    await prepare(root, component('texlive'))
    assert.equal(await reusableComponent(root, manifest([item]), item), true)
  }))

test('only exact frozen local initial metadata permits an unsigned envelope', async () =>
  fixture(async (root) => {
    const directory = join(root, 'current', 'resources', 'components')
    await mkdir(directory, { recursive: true })
    const unsigned = { ...envelope(manifest()), key_id: '', signature: '' }
    const raw = JSON.stringify(unsigned) + '\n'
    await writeFile(join(directory, 'runtime.json'), raw)
    const policy = { releaseLane: 'local', runtimeManifestSha256: digest(raw) }
    assert.deepEqual(await installedRuntimeManifest(join(root, 'current'), {}, policy), manifest())
    await assert.rejects(
      installedRuntimeManifest(
        join(root, 'current'),
        {},
        { ...policy, releaseLane: 'distribution' }
      ),
      /trusted/
    )
    await assert.rejects(
      installedRuntimeManifest(join(root, 'current'), {}, { releaseLane: 'local' }),
      /trusted/
    )
    await assert.rejects(
      installedRuntimeManifest(
        join(root, 'current'),
        {},
        { ...policy, runtimeManifestSha256: 'a'.repeat(64) }
      ),
      /frozen/
    )
    assert.throws(() => verifyRuntimeEnvelope(unsigned, {}), /trusted/)
  }))

test('native directory pins outlive network writes and partial cleanup', async (t) =>
  fixture(async (root) => {
    const delivery = options(root)
    const held = new Set<unknown>()
    const operations: string[] = []
    delivery.native.pin = (path) => {
      held.add(path)
      operations.push(`pin:${path}`)
      return path
    }
    const create = delivery.native.createChild
    delivery.native.createChild = (parent, name) => {
      assert.ok(held.has(parent))
      operations.push(`create:${name}`)
      return create(parent, name)
    }
    delivery.native.release = (pin) => {
      held.delete(pin)
      operations.push(`release:${pin}`)
    }
    t.mock.method(globalThis, 'fetch', async () => {
      assert.equal(held.size, 3)
      return new Response(Buffer.alloc(payload.length))
    })
    await assert.rejects(downloadRuntimeComponents(delivery), /digest/)
    assert.equal(held.size, 0)
    assert.deepEqual(await readdir(join(root, 'runtime', '.archives')), [])
    assert.match(operations[0], /^pin:/)
    assert.equal(operations[1], 'create:runtime')
    assert.equal(operations[3], 'create:.archives')
    assert.ok(operations.slice(-3).every((value) => value.startsWith('release:')))
  }))

test('Windows downloads derive child pins without reopening private ancestry', async (t) =>
  fixture(async (root) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    t.after(() => Object.defineProperty(process, 'platform', platform))
    const delivery = options(root)
    const held: unknown[] = []
    const operations: unknown[][] = []
    t.mock.method(
      delivery.native,
      'pin',
      (path: string, create: boolean, role?: DirectoryPinRole) => {
        assert.equal(path, root)
        assert.equal(create, false)
        assert.equal(role, 'installation')
        operations.push(['root', path, role])
        held.push(path)
        return path
      }
    )
    t.mock.method(delivery.native, 'createChild', (parent: unknown, name: string) => {
      assert.equal(parent, held.at(-1))
      operations.push(['create', name])
      mkdirSync(join(parent as string, name))
      return join(parent as string, name)
    })
    t.mock.method(delivery.native, 'pinChild', (parent: unknown, name: string) => {
      assert.equal(parent, held.at(-1))
      const child = join(parent as string, name)
      held.push(child)
      operations.push(['child', name])
      return child
    })
    t.mock.method(delivery.native, 'release', (pin: unknown) => assert.equal(pin, held.pop()))
    t.mock.method(globalThis, 'fetch', async () => {
      assert.equal(held.length, 3)
      return new Response(payload)
    })
    await downloadRuntimeComponents(delivery)
    assert.deepEqual(operations, [
      ['root', root, 'installation'],
      ['create', 'runtime'],
      ['child', 'runtime'],
      ['create', '.archives'],
      ['child', '.archives'],
    ])
    assert.equal(held.length, 0)
  }))

test('Windows child pin failure releases only held ancestors before any download', async (t) =>
  fixture(async (root) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    t.after(() => Object.defineProperty(process, 'platform', platform))
    const delivery = options(root)
    const released: unknown[] = []
    t.mock.method(delivery.native, 'pinChild', () => {
      throw Object.assign(new Error('unsafe child'), { code: 'ERR_LEASE_PERMISSION' })
    })
    t.mock.method(delivery.native, 'release', (pin: unknown) => released.push(pin))
    const network = t.mock.method(globalThis, 'fetch', async () => new Response(payload))
    await assert.rejects(downloadRuntimeComponents(delivery), { code: 'ERR_LEASE_PERMISSION' })
    assert.deepEqual(released, [root])
    assert.equal(network.mock.callCount(), 0)
  }))

test('Windows delivery never falls back when native child pin support is missing', async (t) =>
  fixture(async (root) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    t.after(() => Object.defineProperty(process, 'platform', platform))
    const delivery = options(root)
    const { pinChild: _pinChild, ...native } = delivery.native
    const pin = t.mock.method(native, 'pin')
    const network = t.mock.method(globalThis, 'fetch', async () => new Response(payload))
    await assert.rejects(
      downloadRuntimeComponents({ ...delivery, native }),
      /requires native child directory pins/
    )
    assert.equal(pin.mock.callCount(), 0)
    assert.equal(network.mock.callCount(), 0)
  }))

test('Windows release uncertainty stops cleanup before releasing parent capabilities', async (t) =>
  fixture(async (root) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    t.after(() => Object.defineProperty(process, 'platform', platform))
    const delivery = options(root)
    const released: unknown[] = []
    t.mock.method(delivery.native, 'release', (pin: unknown) => {
      released.push(pin)
      throw Object.assign(new Error('uncertain child close'), { code: 'ERR_LEASE_NATIVE' })
    })
    t.mock.method(globalThis, 'fetch', async () => new Response(payload))
    await assert.rejects(downloadRuntimeComponents(delivery), { code: 'ERR_LEASE_NATIVE' })
    assert.deepEqual(released, [join(root, 'runtime', '.archives')])
  }))

test('retry disk budget counts retained archive once and reserves only missing expansion', async (t) =>
  fixture(async (root) => {
    const item = component()
    await mkdir(join(root, 'runtime', '.archives'), { recursive: true })
    await writeFile(componentArchivePath(root, item), payload)
    const available = BigInt(64 * 1024 ** 2 + critical.length)
    const filesystem = t.mock.method(fsPromises, 'statfs', async () => ({
      type: 0n,
      bsize: 1n,
      blocks: available,
      bfree: available,
      bavail: available,
      files: 0n,
      ffree: 0n,
    }))
    syncBuiltinESMExports()
    const network = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('retained archive must not download')
    })
    try {
      await downloadRuntimeComponents(options(root))
      assert.equal(network.mock.callCount(), 0)
    } finally {
      filesystem.mock.restore()
      syncBuiltinESMExports()
    }
  }))

test('a local temporary-file open failure cancels the acquired HTTP body', async (t) =>
  fixture(async (root) => {
    let cancelled = false
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          })
        )
    )
    const realOpen = fsPromises.open
    const fileOpen = t.mock.method(
      fsPromises,
      'open',
      async (...[path, flags, mode]: Parameters<typeof fsPromises.open>) => {
        if (String(path).includes('.part-'))
          throw Object.assign(new Error('disk unavailable'), { code: 'ENOSPC' })
        return realOpen(path, flags, mode)
      }
    )
    syncBuiltinESMExports()
    try {
      await assert.rejects(downloadRuntimeComponents(options(root)), /disk unavailable/)
      assert.equal(cancelled, true)
      assert.deepEqual(await readdir(join(root, 'runtime', '.archives')), [])
    } finally {
      fileOpen.mock.restore()
      syncBuiltinESMExports()
    }
  }))

test('component diagnostics distinguish download, retained archive, and installed reuse', async (t) =>
  fixture(async (root) => {
    const logs: string[] = []
    const delivery = { ...options(root), log: (line: string) => logs.push(line) }
    const network = t.mock.method(globalThis, 'fetch', async () => new Response(payload))
    const events = () => logs.map((line) => JSON.parse(line.slice('[component-timing] '.length)))
    await downloadRuntimeComponents(delivery)
    const cold = events().find((event) => event.operation === 'download')
    assert.equal(cold.status, 'passed')
    assert.equal(cold.bytes, payload.length)
    for (const phase of ['headers', 'read', 'write', 'hash', 'sync', 'publish']) {
      assert.ok(cold.metrics[phase].calls > 0, phase)
      assert.ok(cold.metrics[phase].elapsed_ms >= 0, phase)
    }
    logs.length = 0
    await downloadRuntimeComponents(delivery)
    assert.equal(network.mock.callCount(), 1)
    assert.ok(
      events().some((event) => event.operation === 'archive' && event.status === 'retained')
    )
    assert.ok(events().every((event) => event.operation !== 'download'))
    await prepare(root, component())
    logs.length = 0
    await downloadRuntimeComponents(delivery)
    assert.equal(network.mock.callCount(), 1)
    const reuse = events().find((event) => event.operation === 'reuse')
    assert.equal(reuse.status, 'reused')
    for (const phase of ['lineage', 'receipt', 'inventory', 'entry', 'open', 'read', 'hash']) {
      assert.ok(reuse.metrics[phase].calls > 0, phase)
    }
    assert.ok(events().some((event) => event.operation === 'paths'))
  }))

test('failed download retains diagnostics and never publishes unauthenticated bytes', async (t) =>
  fixture(async (root) => {
    const logs: string[] = []
    t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(payload.length)))
    await assert.rejects(
      downloadRuntimeComponents({ ...options(root), log: (line) => logs.push(line) }),
      /digest/
    )
    const event = JSON.parse(logs.at(-1)!.slice('[component-timing] '.length))
    assert.equal(event.operation, 'download')
    assert.equal(event.status, 'failed')
    assert.equal(event.metrics.publish, undefined)
    assert.deepEqual(await readdir(join(componentArchivePath(root, component()), '..')), [])
  }))
