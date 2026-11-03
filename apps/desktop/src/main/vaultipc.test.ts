import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  createVaultIpc,
  protectedDigest,
  verifyProtectedAssets,
  type ProtectedManifest,
} from './vaultipc.ts'
import { VaultOwner, VAULT_FORMAT } from './vault.ts'
import { VAULT_CHANNEL, type VaultStatus } from '../vault.ts'
import type { StorePort } from './vaultstorage.ts'

test('protected input owner implementation exists', () => {
  assert.equal(existsSync(new URL('./vaultipc.ts', import.meta.url)), true)
})

function assetsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vault-ipc-'))
  mkdirSync(join(root, 'renderer'))
  mkdirSync(join(root, 'preload'))
  const files = ['renderer/vault.html', 'preload/vault.js'].map((path) => {
    const bytes = Buffer.from('local protected asset')
    writeFileSync(join(root, path), bytes)
    return { path, bytes: bytes.length, sha256: protectedDigest(bytes) }
  })
  const generation = 'a'.repeat(64)
  const manifest: ProtectedManifest = {
    version: 1,
    generation,
    tools: {},
    sources: [],
    modules: [],
    files,
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  writeFileSync(join(root, 'manifest.json'), bytes)
  return {
    root,
    generation,
    digest: protectedDigest(bytes),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}
test('asset admission rejects missing, extra, changed and mismatched-generation resources', () => {
  const fixture = assetsFixture()
  try {
    assert.equal(
      verifyProtectedAssets(fixture.root, fixture.generation, fixture.digest).resources.size,
      1
    )
    assert.throws(
      () => verifyProtectedAssets(fixture.root, 'b'.repeat(64), fixture.digest),
      /protected_assets_unavailable/
    )
    assert.throws(
      () => verifyProtectedAssets(fixture.root, fixture.generation, 'b'.repeat(64)),
      /protected_assets_unavailable/
    )
    writeFileSync(join(fixture.root, 'renderer/extra.js'), 'extra')
    assert.throws(
      () => verifyProtectedAssets(fixture.root, fixture.generation, fixture.digest),
      /protected_assets_unavailable/
    )
    rmSync(join(fixture.root, 'renderer/extra.js'))
    writeFileSync(join(fixture.root, 'renderer/vault.html'), 'modified')
    assert.throws(
      () => verifyProtectedAssets(fixture.root, fixture.generation, fixture.digest),
      /protected_assets_unavailable/
    )
    rmSync(join(fixture.root, 'preload/vault.js'))
    assert.throws(
      () => verifyProtectedAssets(fixture.root, fixture.generation, fixture.digest),
      /protected_assets_unavailable/
    )
  } finally {
    fixture.dispose()
  }
})
class Contents extends EventEmitter {
  destroyed = false
  focused = true
  url = 'http://localhost:5173/'
  mainFrame = {}
  debugger = { isAttached: () => false }
  isDestroyed() {
    return this.destroyed
  }
  isCrashed() {
    return false
  }
  isDevToolsOpened() {
    return false
  }
  isFocused() {
    return this.focused
  }
  getURL() {
    return this.url
  }
  focus() {
    this.focused = true
    this.emit('focus')
  }
  setWindowOpenHandler(handler: unknown) {
    this.openHandler = handler
  }
  openHandler: unknown
  async loadURL(url: string) {
    this.url = url
  }
  close() {
    this.destroyed = true
    this.emit('blur')
    this.emit('destroyed')
  }
}
async function ipcFixture(derive: () => Promise<Buffer> = async () => randomBytes(32)) {
  const assets = assetsFixture()
  const product = new Contents()
  const window = Object.assign(new EventEmitter(), {
    webContents: product,
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    getContentSize: () => [1000, 700],
    contentView: { addChildView: () => undefined, removeChildView: () => undefined },
  })
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  let view: {
    webContents: Contents
    setVisible(value: boolean): void
    setBounds(value: unknown): void
  } | null = null
  let network: (
    details: { url: string; resourceType: string },
    callback: (result: { cancel: boolean }) => void
  ) => void = () => undefined
  let body: Buffer | null = null
  const port: StorePort = {
    kind: 'vault',
    generation: 1,
    budget: VAULT_FORMAT.fileBytes,
    current: () => true,
    read: async () => ({
      bytes: body ?? Buffer.alloc(0),
      digest: body ? protectedDigest(body) : null,
      token: 'token',
      operationId: 'operation',
      sequence: 1,
    }),
    replace: async (observed, bytes) => {
      body = Buffer.from(bytes)
      return {
        operationId: observed.operationId,
        sequence: observed.sequence,
        verb: 'replace',
        outcome: 'committed',
        resultPresence: 'present',
        result: { digest: protectedDigest(bytes), identity: ['1', '1'] },
        durability: 'namespace-synced',
      }
    },
    removeConfirmed: async () => {
      throw new Error('not used')
    },
    inspect: async () => {
      throw new Error('not used')
    },
  }
  const dependencies = {
    current: () => true,
    debug: () => null,
    publish: (_status: VaultStatus): void => undefined,
    derive,
  }
  const vault = new VaultOwner(dependencies)
  let projectStatus = (status: VaultStatus): VaultStatus => status
  await vault.bindStore(port)
  const isolated = Object.assign(new EventEmitter(), {
    webRequest: {
      onBeforeRequest: (handler: typeof network) => {
        network = handler
      },
    },
    setPermissionCheckHandler: () => undefined,
    setPermissionRequestHandler: () => undefined,
    closeAllConnections: async (): Promise<void> => undefined,
    clearStorageData: async (): Promise<void> => undefined,
  })
  const owner = createVaultIpc(window as never, {
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => {
        handlers.delete(channel)
      },
    },
    vault,
    status: () => projectStatus(vault.status()),
    current: () => true,
    debug: () => null,
    directory: assets.root,
    generation: assets.generation,
    manifestDigest: assets.digest,
    watch: false,
    rendererUrl: 'http://localhost:5173',
    preferences: () => ({ language: 'zh', theme: 'light' }),
    beforeOpen: () => undefined,
    createSession: () => isolated as never,
    createView: () => {
      view = {
        webContents: new Contents(),
        setVisible: () => undefined,
        setBounds: () => undefined,
      }
      return view as never
    },
  })
  const invoke = (
    channel: string,
    contents: Contents,
    value?: unknown,
    frame = contents.mainFrame
  ) =>
    handlers.get(channel)!(
      { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      value
    )
  return {
    product,
    window,
    vault,
    owner,
    isolated,
    dependencies,
    projectStatus: (projection: typeof projectStatus) => {
      projectStatus = projection
    },
    invoke,
    view: () => view!,
    network: (url: string, resourceType: string) => {
      let result = false
      network({ url, resourceType }, (response) => {
        result = response.cancel
      })
      return result
    },
    dispose: () => {
      owner.dispose()
      vault.dispose()
      assets.dispose()
    },
  }
}
test('actual IPC owner checks sender/frame/purpose/replay/focus; controlled success close retains unlocked while window blur revokes', async () => {
  const fixture = await ipcFixture()
  try {
    assert.equal(await fixture.invoke(VAULT_CHANNEL.seed, fixture.product), null)
    assert.equal(
      (
        await fixture.invoke(VAULT_CHANNEL.open, fixture.product, {
          intent: 'create',
          password: 'must reject',
        })
      ).ok,
      false
    )
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' }, {})).ok,
      false
    )
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
      true
    )
    const view = fixture.view().webContents
    assert.equal(await fixture.invoke(VAULT_CHANNEL.seed, view, undefined, {}), null)
    const seed = await fixture.invoke(VAULT_CHANNEL.seed, view)
    assert.ok(seed)
    assert.equal(
      Object.keys(seed).some(
        (key) => /password|secret|cipher|path/.test(key) && key !== 'passwordBytes'
      ),
      false
    )
    const request = {
      sessionId: seed.sessionId,
      generation: seed.generation,
      requestId: 'request',
      kind: 'create',
      password: 'abcdefghijkl',
      confirmation: 'abcdefghijkl',
    }
    assert.equal((await fixture.invoke(VAULT_CHANNEL.submit, fixture.product, request)).ok, false)
    assert.equal(fixture.network('https://example.org/secret', 'xhr'), true)
    assert.equal(fixture.network('ws://localhost:1000/', 'webSocket'), true)
    assert.equal(fixture.network(view.url, 'subFrame'), true)
    assert.equal(fixture.network(view.url, 'mainFrame'), false)
    assert.equal((await fixture.invoke(VAULT_CHANNEL.submit, view, request)).ok, true)
    assert.equal(view.destroyed, true)
    assert.equal(fixture.vault.status().state, 'unlocked')
    assert.equal((await fixture.invoke(VAULT_CHANNEL.submit, view, request)).ok, false)
    fixture.window.emit('blur')
    assert.equal(fixture.vault.status().state, 'locked')
    assert.equal(fixture.vault.listMetadata(), null)
  } finally {
    fixture.dispose()
  }
})

for (const node of [
  'remover',
  'hide',
  'remove',
  'close',
  'request',
  'permissionCheck',
  'permissionRequest',
  'connections',
  'storage',
] as const) {
  test(`custody isolates ${node} failure, retains inventory and denies fresh authority until retry`, async () => {
    const fixture = await ipcFixture()
    try {
      assert.equal(
        (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
        true
      )
      const view = fixture.view()
      const contents = view.webContents
      const target =
        node === 'remover'
          ? contents
          : node === 'hide'
            ? view
            : node === 'remove'
              ? fixture.window.contentView
              : node === 'close'
                ? contents
                : node === 'request'
                  ? fixture.isolated.webRequest
                  : fixture.isolated
      const method = {
        remover: 'removeListener',
        hide: 'setVisible',
        remove: 'removeChildView',
        close: 'close',
        request: 'onBeforeRequest',
        permissionCheck: 'setPermissionCheckHandler',
        permissionRequest: 'setPermissionRequestHandler',
        connections: 'closeAllConnections',
        storage: 'clearStorageData',
      }[node]
      const mutable = target as unknown as Record<string, unknown>
      const original = mutable[method]
      mutable[method] = () => {
        throw new Error('secret must never enter report')
      }
      let later = false
      fixture.vault.onRevoke(() => {
        later = true
      })
      assert.doesNotThrow(() => fixture.owner.lock())
      assert.equal(later, true)
      assert.equal(await fixture.invoke(VAULT_CHANNEL.seed, contents), null)
      assert.equal(fixture.owner.secretCustodyReady(), false)
      if (node === 'close') assert.deepEqual(fixture.owner.protectedContents(), [contents])
      const report = await fixture.owner.cleanupReport()
      assert.notEqual(report.status, 'closed')
      assert.equal(JSON.stringify(report).includes('secret must'), false)
      assert.equal(
        (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
        false
      )
      mutable[method] = original
      fixture.owner.lock()
      assert.equal((await fixture.owner.cleanupReport()).status, 'closed')
      assert.equal(fixture.owner.secretCustodyReady(), true)
      assert.equal(
        (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
        true
      )
    } finally {
      fixture.dispose()
    }
  })
}
test('retired owner retains live contents across dispose; late destroy and session success only restore readiness, not authority', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    const contents = fixture.view().webContents
    contents.close = () => undefined
    let release: () => void = () => undefined
    fixture.isolated.clearStorageData = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    fixture.owner.dispose()
    assert.deepEqual(fixture.owner.protectedContents(), [contents])
    assert.equal(fixture.owner.secretCustodyReady(), false)
    const report = await fixture.owner.cleanupReport()
    assert.equal(report.status, 'containment_failed')
    contents.destroyed = true
    contents.emit('destroyed')
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fixture.owner.secretCustodyReady(), true)
    assert.deepEqual(fixture.owner.protectedContents(), [])
    assert.equal(fixture.vault.listMetadata(), null)
  } finally {
    fixture.dispose()
  }
})
test('session async rejection is caught and retry cannot authorize the old sender', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    const contents = fixture.view().webContents
    fixture.isolated.clearStorageData = async () => {
      throw new Error('private data')
    }
    fixture.owner.lock()
    assert.equal((await fixture.owner.cleanupReport()).status, 'cleanup_failed')
    fixture.isolated.clearStorageData = async () => undefined
    fixture.owner.lock()
    assert.equal((await fixture.owner.cleanupReport()).status, 'closed')
    assert.equal(await fixture.invoke(VAULT_CHANNEL.seed, contents), null)
  } finally {
    fixture.dispose()
  }
})
test('successful KDF with rejected surface cleanup locks the key and never revives on late recovery', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    const contents = fixture.view().webContents
    const seed = await fixture.invoke(VAULT_CHANNEL.seed, contents)
    fixture.isolated.clearStorageData = async () => {
      throw new Error('private')
    }
    const reply = await fixture.invoke(VAULT_CHANNEL.submit, contents, {
      sessionId: seed.sessionId,
      generation: seed.generation,
      requestId: 'submit-cleanup',
      kind: 'create',
      password: 'abcdefghijkl',
      confirmation: 'abcdefghijkl',
    })
    assert.equal(reply.ok, false)
    assert.notEqual(fixture.vault.status().state, 'unlocked')
    await fixture.owner.cleanupReport()
    fixture.isolated.clearStorageData = async () => undefined
    fixture.owner.lock()
    assert.equal((await fixture.owner.cleanupReport()).status, 'closed')
    assert.equal(fixture.vault.listMetadata(), null)
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'unlock' })).ok,
      true
    )
  } finally {
    fixture.dispose()
  }
})
test('actual Main custody helpers retain disposed owner, guard new authority and do not let old success overwrite another failure', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    const contents = fixture.view().webContents
    contents.close = () => undefined
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const helpers = source.slice(
      source.indexOf('const retiredProtectedOwners ='),
      source.indexOf('let browserStorage:')
    )
    const notices: unknown[] = []
    const composition = new Function(
      'browserVaultIpc',
      'browserVault',
      'mainWindow',
      'pushLog',
      'VAULT_CHANNEL',
      'VAULT_ERROR',
      stripTypeScriptTypes(helpers) +
        '; return { retireBrowserVaultIpc, protectedOwners, secretCustodyReady, consumeProtectedCleanupReport, retiredProtectedOwners };'
    )(
      fixture.owner,
      fixture.vault,
      {
        webContents: {
          isDestroyed: () => false,
          send: (_channel: string, value: unknown) => notices.push(value),
        },
      },
      () => undefined,
      VAULT_CHANNEL,
      { unavailable: 'storage_unavailable' }
    )
    fixture.owner.onCleanupReport((report) =>
      composition.consumeProtectedCleanupReport(fixture.owner, report)
    )
    composition.retireBrowserVaultIpc()
    assert.equal(composition.secretCustodyReady(), false)
    assert.equal(composition.retiredProtectedOwners.has(fixture.owner), true)
    assert.deepEqual(
      composition
        .protectedOwners()
        .flatMap((owner: typeof fixture.owner) => owner.protectedContents()),
      [contents]
    )
    assert.ok(notices.length)
    const other = { secretCustodyReady: () => false, protectedContents: () => [] }
    composition.retiredProtectedOwners.add(other)
    contents.destroyed = true
    contents.emit('destroyed')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(composition.retiredProtectedOwners.has(fixture.owner), false)
    assert.equal(composition.secretCustodyReady(), false)
    assert.equal((notices.at(-1) as { error: string }).error, 'storage_unavailable')
  } finally {
    fixture.dispose()
  }
})
test('fixed report consumers throw or reject without skipping later consumers or leaking private errors', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    let later = false
    fixture.owner.onCleanupReport(() => {
      throw new Error('private report')
    })
    fixture.owner.onCleanupReport(async () => {
      throw new Error('private report')
    })
    fixture.owner.onCleanupReport(() => {
      later = true
    })
    fixture.owner.lock()
    await new Promise((resolve) => setImmediate(resolve))
    const report = await fixture.owner.cleanupReport()
    assert.equal(later, true)
    assert.ok(report.codes.includes('report_consumer_failed'))
    assert.equal(JSON.stringify(report).includes('private report'), false)
  } finally {
    fixture.dispose()
  }
})
test('unknown destruction retains custody until a new governed check confirms actual destruction', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    const contents = fixture.view().webContents
    const original = contents.isDestroyed
    contents.isDestroyed = () => {
      throw new Error('unknown')
    }
    fixture.owner.lock()
    assert.equal((await fixture.owner.cleanupReport()).status, 'containment_failed')
    assert.equal(fixture.owner.secretCustodyReady(), false)
    contents.isDestroyed = original
    fixture.owner.lock()
    assert.equal((await fixture.owner.cleanupReport()).status, 'closed')
    assert.equal(fixture.owner.secretCustodyReady(), true)
  } finally {
    fixture.dispose()
  }
})
test('all synchronous cleanup failures survive the final Vault publish and ordinary status read; actual recovery clears only custody error', async () => {
  const fixture = await ipcFixture()
  const retired = await ipcFixture()
  try {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const helpers = source.slice(
      source.indexOf('const retiredProtectedOwners ='),
      source.indexOf('let browserStorage:')
    )
    const notices: VaultStatus[] = []
    const browserWindow = {
      webContents: {
        isDestroyed: () => false,
        send: (_channel: string, status: VaultStatus) => {
          notices.push(status)
        },
      },
    }
    const ownerSource = source.slice(source.indexOf('const vault = new VaultOwner'))
    const publisher = /publish:\s*(\(?status\)?\s*=>[^\n]+)/
      .exec(ownerSource)?.[1]
      .replace(/,\s*$/, '')
    assert.ok(publisher, 'Vault publisher must be present')
    const composition = new Function(
      'browserVaultIpc',
      'browserVault',
      'mainWindow',
      'browserWindow',
      'pushLog',
      'VAULT_CHANNEL',
      'VAULT_ERROR',
      stripTypeScriptTypes(helpers) +
        '; return { retiredProtectedOwners, secretCustodyReady, consumeProtectedCleanupReport, publisher: ' +
        publisher +
        ", projection: typeof projectVaultStatus === 'function' ? projectVaultStatus : status => status };"
    )(fixture.owner, fixture.vault, browserWindow, browserWindow, () => undefined, VAULT_CHANNEL, {
      unavailable: 'unavailable',
    })
    fixture.dependencies.publish = composition.publisher
    fixture.projectStatus(composition.projection)
    fixture.owner.onCleanupReport((report) =>
      composition.consumeProtectedCleanupReport(fixture.owner, report)
    )
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
      true
    )
    assert.equal((await fixture.invoke(VAULT_CHANNEL.status, fixture.product)).error, undefined)
    assert.ok(await fixture.invoke(VAULT_CHANNEL.seed, fixture.view().webContents))
    const contents = fixture.view().webContents
    const close = contents.close
    const connections = fixture.isolated.closeAllConnections
    const storage = fixture.isolated.clearStorageData
    const failed = (): never => {
      throw new Error('private data')
    }
    contents.close = failed
    fixture.isolated.closeAllConnections = failed
    fixture.isolated.clearStorageData = failed
    const locked = await fixture.invoke(VAULT_CHANNEL.lock, fixture.product)
    assert.equal(composition.secretCustodyReady(), false)
    assert.equal(notices.at(-1)?.error, 'unavailable')
    assert.equal(locked.status.error, 'unavailable')
    assert.equal((await fixture.invoke(VAULT_CHANNEL.status, fixture.product)).error, 'unavailable')
    assert.equal(fixture.vault.status().error, undefined)
    await retired.invoke(VAULT_CHANNEL.open, retired.product, { intent: 'create' })
    const retiredStorage = retired.isolated.clearStorageData
    retired.isolated.clearStorageData = failed
    composition.retiredProtectedOwners.add(retired.owner)
    retired.owner.onCleanupReport((report) =>
      composition.consumeProtectedCleanupReport(retired.owner, report)
    )
    retired.owner.dispose()
    await retired.owner.cleanupReport()
    contents.close = close
    fixture.isolated.closeAllConnections = connections
    fixture.isolated.clearStorageData = storage
    fixture.owner.lock()
    await fixture.owner.cleanupReport()
    assert.equal(notices.at(-1)?.error, 'unavailable')
    retired.isolated.clearStorageData = retiredStorage
    retired.owner.lock()
    await retired.owner.cleanupReport()
    assert.equal(composition.retiredProtectedOwners.has(retired.owner), false)
    fixture.owner.lock()
    assert.equal((await fixture.invoke(VAULT_CHANNEL.status, fixture.product)).error, undefined)
    assert.equal(notices.at(-1)?.error, undefined)
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
      true
    )
    const seed = await fixture.invoke(VAULT_CHANNEL.seed, fixture.view().webContents)
    const cancelled = await fixture.invoke(VAULT_CHANNEL.cancel, fixture.view().webContents, {
      sessionId: seed.sessionId,
      generation: seed.generation,
      requestId: 'cancel-projected',
    })
    assert.equal(cancelled.ok, true)
    await fixture.owner.cleanupReport()
    assert.equal((await fixture.invoke(VAULT_CHANNEL.status, fixture.product)).error, undefined)
    assert.equal(notices.at(-1)?.error, undefined)
  } finally {
    fixture.dispose()
    retired.dispose()
  }
})
test('pending trusted view focus loss destroys prompt and cannot revive secrets', async () => {
  const fixture = await ipcFixture()
  try {
    await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })
    const view = fixture.view().webContents
    view.focused = false
    view.emit('blur')
    assert.equal(view.destroyed, true)
    assert.equal(await fixture.invoke(VAULT_CHANNEL.seed, view), null)
    assert.notEqual(fixture.vault.status().state, 'unlocked')
  } finally {
    fixture.dispose()
  }
})
test('protected cancellation remains available during KDF and late callback cannot publish or write', async () => {
  let release: (key: Buffer) => void = () => undefined
  let started: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    started = resolve
  })
  const fixture = await ipcFixture(() => {
    started()
    return new Promise<Buffer>((resolve) => {
      release = resolve
    })
  })
  try {
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
      true
    )
    const view = fixture.view().webContents
    const seed = await fixture.invoke(VAULT_CHANNEL.seed, view)
    const pending = fixture.invoke(VAULT_CHANNEL.submit, view, {
      sessionId: seed.sessionId,
      generation: seed.generation,
      requestId: 'submit-pending',
      kind: 'create',
      password: 'abcdefghijkl',
      confirmation: 'abcdefghijkl',
    })
    await reached
    assert.equal(
      (
        await fixture.invoke(VAULT_CHANNEL.cancel, view, {
          sessionId: seed.sessionId,
          generation: seed.generation,
          requestId: 'cancel-pending',
        })
      ).ok,
      true
    )
    assert.equal(view.destroyed, true)
    const key = Buffer.alloc(32, 9)
    release(key)
    assert.equal((await pending).ok, false)
    assert.equal(
      key.every((byte) => byte === 0),
      true
    )
    assert.notEqual(fixture.vault.status().state, 'unlocked')
    assert.equal(fixture.vault.listMetadata(), null)
    assert.equal(
      (await fixture.invoke(VAULT_CHANNEL.open, fixture.product, { intent: 'create' })).ok,
      true
    )
  } finally {
    fixture.dispose()
  }
})
test('before-quit composition revokes before the existing staged-update early return', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.on('before-quit', (event) => {")
  const block = source.slice(start, source.indexOf("app.on('will-quit'", start))
  assert.ok(block.indexOf('browserVaultIpc?.lock()') < block.indexOf('event.preventDefault()'))
  assert.ok(block.indexOf('browserVault?.lock()') < block.indexOf('event.preventDefault()'))
})
test('Main composition retains previous owners before dispose, consumes fixed reports and gates Vault current with custody', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(source, /retiredProtectedOwners\.add\(previous\)[\s\S]*previous\.dispose\(\)/)
  assert.match(source, /onCleanupReport\(\s*\(?report\)?\s*=>\s*consumeProtectedCleanupReport/)
  assert.match(source, /current:\s*\(\)\s*=>\s*secretCustodyReady\(\)/)
  assert.match(source, /\.flatMap\(\s*\(?owner\)?\s*=>\s*\[\.\.\.owner\.protectedContents\(\)\]\)/)
  assert.match(
    source,
    /previous\s*\.cleanupReport\(\)\s*\.then\(\s*\(?report\)?\s*=>\s*consumeProtectedCleanupReport/
  )
})
