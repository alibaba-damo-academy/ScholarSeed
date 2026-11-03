import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as buildVite } from 'vite'
import { resolveConfig } from 'electron-vite'
import { build as buildScript } from 'esbuild'
import { _electron, expect } from '@playwright/test'
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContentsView,
} from 'electron'
import {
  parseBrowserOverlayModel,
  overlayBounds,
  OVERLAY_CHANNEL,
  TOOLTIP_OVERLAY_CHANNEL,
} from '../overlay.ts'
import { createBrowserOverlay } from './overlay.ts'
import type { BrowserOverlayOwner } from './overlay.ts'

interface OverlayProbe {
  ready: ReturnType<BrowserOverlayOwner['publish']>
  window: BrowserWindow
  owner: BrowserOverlayOwner
  overlayView: WebContentsView
}

const model = {
  revision: 1,
  bounds: { x: 10, y: 20, width: 300, height: 200 },
  theme: 'light',
  language: 'en',
  status: 'ready',
  items: [{ id: 'first', title: 'Example', detail: 'example.test' }],
}

test('overlay accepts bounded display models and clips zoomed geometry', () => {
  assert.deepEqual(parseBrowserOverlayModel(model), model)
  assert.deepEqual(overlayBounds(model.bounds, 2, { width: 500, height: 300 }), {
    x: 20,
    y: 40,
    width: 480,
    height: 260,
  })
})

test('tooltip display models accept plain text without interactive items or markup capabilities', () => {
  const tooltip = {
    ...model,
    items: [],
    tooltip: '<script>not executable</script>',
    tooltipBounds: { x: 0, y: 0, width: 68, height: 30 },
  }
  assert.deepEqual(parseBrowserOverlayModel(tooltip), tooltip)
  assert.throws(() => parseBrowserOverlayModel({ ...tooltip, items: model.items }))
  assert.throws(() => parseBrowserOverlayModel({ ...tooltip, tooltip: 'x'.repeat(4097) }))
  assert.throws(() => parseBrowserOverlayModel({ ...tooltip, html: '<b>unsafe</b>' }))
  assert.throws(() => parseBrowserOverlayModel({ ...tooltip, tooltipBounds: undefined }))
  assert.deepEqual(
    parseBrowserOverlayModel({ ...tooltip, tooltipBounds: { x: 16, y: 14, width: 68, height: 30 } })
      .tooltipBounds,
    { x: 16, y: 14, width: 68, height: 30 }
  )
  assert.throws(() =>
    parseBrowserOverlayModel({ ...tooltip, tooltipBounds: { x: 299, y: 0, width: 68, height: 30 } })
  )
  assert.throws(() =>
    parseBrowserOverlayModel({ ...tooltip, tooltipBounds: { x: -1, y: 0, width: 68, height: 30 } })
  )
})

test('overlay rejects malformed geometry, budgets and duplicate identities', () => {
  for (const width of [NaN, Infinity, -1, 0])
    assert.throws(() => parseBrowserOverlayModel({ ...model, bounds: { ...model.bounds, width } }))
  assert.throws(() =>
    parseBrowserOverlayModel({ ...model, items: Array.from({ length: 101 }, () => model.items[0]) })
  )
  assert.throws(() =>
    parseBrowserOverlayModel({ ...model, items: [model.items[0], model.items[0]] })
  )
  assert.throws(() =>
    parseBrowserOverlayModel({ ...model, items: [{ ...model.items[0], title: 'x'.repeat(4097) }] })
  )
  assert.throws(() => overlayBounds(model.bounds, NaN, { width: 500, height: 300 }))
})

function fixture(context: test.TestContext, tooltip = false) {
  const directory = mkdtempSync(join(tmpdir(), 'overlay-test-'))
  mkdirSync(join(directory, 'assets'))
  writeFileSync(join(directory, 'overlay.html'), '')
  writeFileSync(join(directory, 'assets', 'overlay.js'), '')
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const syncHandlers = new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>()
  const messages: { channel: string; payload: unknown }[] = []
  const ordering: unknown[] = []
  const bounds: unknown[] = []
  const visibility: boolean[] = []
  let visible = false
  let focused = true
  let minimized = false
  let windowVisible = true
  let closed = false
  let resolveLoad!: () => void
  let rejectLoad!: (error: Error) => void
  let requestGuard!: (
    details: { url: string },
    callback: (reply: { cancel: boolean }) => void
  ) => void
  let permissionRequest!: (...args: unknown[]) => void
  let permissionCheck!: () => boolean
  let opening!: () => { action: string }
  const product = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    getZoomFactor: () => 2,
    send: (channel: string, payload: unknown) => messages.push({ channel, payload }),
    focus: () => messages.push({ channel: 'focus-product', payload: null }),
  })
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => closed,
    close: () => {
      closed = true
    },
    send: (channel: string, payload: unknown) => messages.push({ channel, payload }),
    setZoomFactor: () => undefined,
    focus: () => messages.push({ channel: 'focus-overlay', payload: null }),
    setWindowOpenHandler: (handler: typeof opening) => {
      opening = handler
    },
    loadURL: () =>
      new Promise<void>((resolve, reject) => {
        resolveLoad = resolve
        rejectLoad = reject
      }),
  })
  const view = {
    webContents: contents,
    setVisible: (next: boolean) => {
      visible = next
      visibility.push(next)
    },
    getVisible: () => visible,
    setBounds: (next: unknown) => bounds.push(next),
    setBackgroundColor: (color: string) => messages.push({ channel: 'background', payload: color }),
  }
  const isolated = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: (handler: typeof permissionRequest) => {
      permissionRequest = handler
    },
    setPermissionCheckHandler: (handler: typeof permissionCheck) => {
      permissionCheck = handler
    },
    webRequest: {
      onBeforeRequest: (handler: typeof requestGuard) => {
        requestGuard = handler
      },
    },
    clearStorageData: () => Promise.resolve(),
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: product,
    isDestroyed: () => false,
    isFocused: () => focused,
    isVisible: () => windowVisible,
    isMinimized: () => minimized,
    getContentSize: () => [500, 300],
    contentView: {
      addChildView: (child: unknown) => ordering.push(child),
      removeChildView: (child: unknown) => ordering.push({ removed: child }),
    },
  })
  const owner = createBrowserOverlay(window as unknown as BrowserWindow, {
    ...(tooltip ? { tooltip: true, channels: TOOLTIP_OVERLAY_CHANNEL } : {}),
    directory,
    preload: join(directory, 'preload.js'),
    createSession: () => isolated as unknown as Session,
    createView: (preferences) => {
      assert.equal(preferences.sandbox, true)
      assert.equal(preferences.contextIsolation, true)
      assert.equal(preferences.nodeIntegration, false)
      assert.equal(preferences.webviewTag, false)
      assert.equal(preferences.devTools, false)
      assert.ok(requestGuard)
      assert.ok(permissionRequest)
      assert.ok(permissionCheck)
      return view as unknown as WebContentsView
    },
    ipc: {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      },
      removeHandler: (channel) => {
        handlers.delete(channel)
      },
      on: (channel, handler) => {
        syncHandlers.set(channel, handler)
        return {} as never
      },
      removeListener: (channel) => {
        syncHandlers.delete(channel)
        return {} as never
      },
    },
  })
  context.after(() => owner.dispose())
  const invoke = (
    channel: string,
    payload: unknown[] = [],
    sender = product as unknown,
    senderFrame = (sender as { mainFrame: unknown }).mainFrame
  ) => handlers.get(channel)!({ sender, senderFrame } as IpcMainInvokeEvent, ...payload)
  const invokeSync = (
    payload: unknown[] = [],
    sender = product as unknown,
    senderFrame = (sender as { mainFrame: unknown }).mainFrame
  ) => {
    let reply: unknown
    const event = { sender, senderFrame } as IpcMainEvent
    Object.defineProperty(event, 'returnValue', {
      set(value) {
        reply = value
        messages.push({ channel: 'sync-reply', payload: { value, visible } })
      },
    })
    syncHandlers.get('scholarseed:overlay-dismiss-sync')!(event, ...payload)
    return reply
  }
  return {
    owner,
    invoke,
    invokeSync,
    syncHandlers,
    contents,
    product,
    window,
    isolated,
    handlers,
    messages,
    ordering,
    bounds,
    visibility,
    setFocused: (value: boolean) => {
      focused = value
    },
    setMinimized: (value: boolean) => {
      minimized = value
    },
    setWindowVisible: (value: boolean) => {
      windowVisible = value
    },
    visible: () => visible,
    closed: () => closed,
    resolveLoad: () => resolveLoad(),
    rejectLoad: () => rejectLoad(new Error('load failed')),
    ready: () =>
      invoke(tooltip ? TOOLTIP_OVERLAY_CHANNEL.ready : OVERLAY_CHANNEL.ready, [], contents),
    request: (url: string) => {
      let cancel: boolean | undefined
      requestGuard({ url }, (result) => {
        cancel = result.cancel
      })
      return cancel
    },
    permissions: () => {
      let allowed: boolean | undefined
      permissionRequest(contents, 'camera', (result: boolean) => {
        allowed = result
      })
      return [allowed, permissionCheck()]
    },
    opening: () => opening(),
  }
}

test('tooltip owner isolates revisions and refuses focus or interactive events', async (context) => {
  const probe = fixture(context, true)
  const tooltip = {
    ...model,
    tooltip: '文献中心',
    items: [],
    tooltipBounds: { x: 0, y: 0, width: 68, height: 30 },
  }
  const publishing = probe.owner.publish(tooltip)
  probe.ready()
  probe.resolveLoad()
  assert.deepEqual(await publishing, { ok: true })
  assert.equal(probe.visible(), true)
  probe.owner.focus()
  assert.equal(
    probe.messages.some((message) => message.channel === TOOLTIP_OVERLAY_CHANNEL.focusRequest),
    false
  )
  assert.equal(probe.handlers.has(OVERLAY_CHANNEL.publish), false)
  assert.deepEqual(
    probe.invoke(
      TOOLTIP_OVERLAY_CHANNEL.event,
      [{ kind: 'select', revision: 1, itemId: 'first' }],
      probe.contents
    ),
    { ok: false, error: 'invalid_command' }
  )
  assert.deepEqual(await probe.owner.publish({ ...model, revision: 2 }), {
    ok: false,
    error: 'invalid_command',
  })
  assert.equal(probe.visible(), true)
  probe.window.emit('blur')
  assert.equal(probe.visible(), false)
})

test('owner only shows after load and subscription, clips and reorders without touching page', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  assert.equal(probe.visible(), false)
  probe.resolveLoad()
  assert.deepEqual(await pending, { ok: true })
  assert.equal(probe.visible(), true)
  assert.deepEqual(probe.bounds.at(-1), { x: 20, y: 40, width: 480, height: 260 })
  assert.equal(probe.ordering.at(-1), probe.ordering[0])
  probe.owner.focus()
  assert.equal(probe.messages.at(-2)?.channel, 'focus-overlay')
  assert.deepEqual(probe.messages.at(-1), { channel: OVERLAY_CHANNEL.focusRequest, payload: 1 })
})

test('late loading cannot resurrect dismissed or disposed revisions', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.owner.dismiss()
  probe.resolveLoad()
  await pending
  assert.equal(probe.visible(), false)
  assert.deepEqual(await probe.owner.publish(model), { ok: false, error: 'invalid_command' })
  const next = probe.owner.publish({ ...model, revision: 2 })
  await next
  probe.owner.dispose()
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
  assert.equal(probe.handlers.size, 0)
  assert.equal(probe.window.listenerCount('blur'), 0)
  assert.equal(probe.product.listenerCount('did-start-loading'), 0)
})

test('IPC requires exact stored contents and main frame and rejects extra args', async (context) => {
  const probe = fixture(context)
  assert.throws(
    () => probe.invoke(OVERLAY_CHANNEL.publish, [model], { mainFrame: {} }),
    /invalid_sender/
  )
  assert.throws(
    () => probe.invoke(OVERLAY_CHANNEL.publish, [model], probe.product, {}),
    /invalid_sender/
  )
  const pending = probe.owner.publish(model)
  assert.throws(
    () => probe.invoke(OVERLAY_CHANNEL.event, [{ kind: 'select', revision: 1, itemId: 'first' }]),
    /invalid_sender/
  )
  assert.throws(() => probe.invoke(OVERLAY_CHANNEL.event, [], probe.contents, {}), /invalid_sender/)
  probe.ready()
  probe.resolveLoad()
  await pending
  assert.deepEqual(probe.invoke(OVERLAY_CHANNEL.dismiss, [true]), {
    ok: false,
    error: 'invalid_command',
  })
  assert.equal(probe.visible(), true)
})

test('selection accepts only current published IDs and closes before delivering', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.resolveLoad()
  await pending
  for (const response of [
    { kind: 'select', revision: 2, itemId: 'first' },
    { kind: 'select', revision: 1, itemId: 'arbitrary' },
  ]) {
    assert.deepEqual(probe.invoke(OVERLAY_CHANNEL.event, [response], probe.contents), {
      ok: false,
      error: 'invalid_command',
    })
  }
  const selected = { kind: 'select', revision: 1, itemId: 'first' }
  assert.deepEqual(probe.invoke(OVERLAY_CHANNEL.event, [selected], probe.contents), { ok: true })
  assert.equal(probe.visible(), false)
  assert.deepEqual(probe.messages.at(-1), { channel: OVERLAY_CHANNEL.event, payload: selected })
  assert.deepEqual(probe.invoke(OVERLAY_CHANNEL.event, [selected], probe.contents), {
    ok: false,
    error: 'invalid_command',
  })
})

test('security guards deny network, navigation, downloads, windows and permissions', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  assert.equal(probe.request('https://example.test/'), true)
  assert.equal(probe.request('file:///private/credentials'), true)
  assert.deepEqual(probe.permissions(), [false, false])
  assert.deepEqual(probe.opening(), { action: 'deny' })
  for (const name of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview',
  ]) {
    let prevented = false
    probe.contents.emit(name, {
      preventDefault: () => {
        prevented = true
      },
    })
    assert.equal(prevented, true)
  }
  let downloadPrevented = false
  probe.isolated.emit('will-download', {
    preventDefault: () => {
      downloadPrevented = true
    },
  })
  assert.equal(downloadPrevented, true)
  probe.resolveLoad()
  await pending
})

test('window blur, minimize and renderer reload revoke published revision', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.resolveLoad()
  await pending
  let revision = 1
  for (const [emitter, name] of [
    [probe.window, 'blur'],
    [probe.window, 'minimize'],
    [probe.product, 'did-start-loading'],
  ] as const) {
    emitter.emit(name)
    assert.equal(probe.visible(), false)
    assert.equal(probe.messages.at(-1)?.channel, OVERLAY_CHANNEL.event)
    await probe.owner.publish({ ...model, revision: ++revision })
    assert.equal(probe.visible(), true)
  }
})

for (const lifecycle of ['blur', 'minimize', 'hidden'] as const) {
  for (const delayed of [false, true]) {
    test(`inactive ${lifecycle} rejects late revisions quietly with delayed load ${delayed}`, async (context) => {
      const probe = fixture(context)
      const pending = probe.owner.publish(model)
      if (!delayed) {
        probe.ready()
        probe.resolveLoad()
        await pending
      }
      if (lifecycle === 'minimize') probe.setMinimized(true)
      else if (lifecycle === 'hidden') probe.setWindowVisible(false)
      else probe.setFocused(false)
      probe.window.emit(
        lifecycle === 'minimize' ? 'minimize' : lifecycle === 'hidden' ? 'hide' : 'blur'
      )
      const visibilityCount = probe.visibility.length
      const next = probe.owner.publish({ ...model, revision: 2 })
      if (delayed) {
        probe.resolveLoad()
        probe.ready()
        await pending
      }
      assert.deepEqual(await next, { ok: true })
      probe.window.emit('resize')
      probe.owner.focus()
      assert.equal(probe.visible(), false)
      assert.equal(probe.visibility.slice(visibilityCount).includes(true), false)
      assert.equal(
        probe.messages.some((message) => message.channel === OVERLAY_CHANNEL.focusRequest),
        false
      )
      assert.deepEqual(
        probe.messages
          .filter((message) => message.channel === OVERLAY_CHANNEL.event)
          .map((message) => message.payload),
        [
          { kind: 'dismiss', revision: 1 },
          { kind: 'dismiss', revision: 2 },
        ]
      )
      for (const revision of [1, 2])
        assert.deepEqual(
          probe.invoke(
            OVERLAY_CHANNEL.event,
            [{ kind: 'select', revision, itemId: 'first' }],
            probe.contents
          ),
          { ok: false, error: 'invalid_command' }
        )
      assert.equal(probe.invoke(OVERLAY_CHANNEL.seed), 2)
      probe.setFocused(true)
      probe.setMinimized(false)
      probe.setWindowVisible(true)
      probe.window.emit('focus')
      probe.window.emit('resize')
      assert.equal(probe.visible(), false)
      assert.deepEqual(await probe.owner.publish({ ...model, revision: 2 }), {
        ok: false,
        error: 'invalid_command',
      })
      assert.deepEqual(await probe.owner.publish({ ...model, revision: 3 }), { ok: true })
      assert.equal(probe.visible(), true)
      probe.owner.focus()
      assert.deepEqual(probe.messages.at(-1), { channel: OVERLAY_CHANNEL.focusRequest, payload: 3 })
    })
  }
}

test('resize and zoom refresh native geometry without dismissing or focusing', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.resolveLoad()
  await pending
  const count = probe.bounds.length
  probe.window.emit('resize')
  probe.product.emit('zoom-changed')
  assert.equal(probe.visible(), true)
  assert.equal(probe.bounds.length, count + 2)
  assert.equal(
    probe.messages.some(
      (message) => message.channel === OVERLAY_CHANNEL.event || message.channel.startsWith('focus-')
    ),
    false
  )
})

test('loading completion after disposal stays hidden and cannot deliver model', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.owner.dispose()
  probe.resolveLoad()
  await pending
  assert.equal(probe.visible(), false)
  assert.equal(
    probe.messages.some((message) => message.channel === OVERLAY_CHANNEL.model),
    false
  )
})

test('load failure surfaces explicit error and never shows overlay', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.rejectLoad()
  assert.deepEqual(await pending, { ok: false, error: 'operation_failed' })
  assert.equal(probe.visible(), false)
})

test('main high-water handshake permits reload without revision ABA', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.resolveLoad()
  await pending
  probe.product.emit('did-start-loading')
  const highWater = probe.invoke('scholarseed:overlay-seed') as number
  assert.equal(highWater, 1)
  assert.throws(
    () => probe.invoke('scholarseed:overlay-seed', [], probe.contents),
    /invalid_sender/
  )
  await probe.owner.publish({ ...model, revision: highWater + 1 })
  assert.equal(probe.visible(), true)
  assert.deepEqual(
    probe.invoke(
      OVERLAY_CHANNEL.event,
      [{ kind: 'select', revision: 1, itemId: 'first' }],
      probe.contents
    ),
    { ok: false, error: 'invalid_command' }
  )
  assert.equal(probe.visible(), true)
})

test('sync dismissal hides and revokes before returning, without losing future revisions', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.resolveLoad()
  await pending
  assert.deepEqual(probe.invokeSync(), { ok: true })
  assert.deepEqual(probe.messages.at(-1)?.payload, { value: { ok: true }, visible: false })
  assert.deepEqual(
    probe.invoke(
      OVERLAY_CHANNEL.event,
      [{ kind: 'select', revision: 1, itemId: 'first' }],
      probe.contents
    ),
    { ok: false, error: 'invalid_command' }
  )
  await probe.owner.publish({ ...model, revision: 2 })
  assert.equal(probe.visible(), true)
  probe.owner.dispose()
  assert.equal(probe.syncHandlers.size, 0)
})

test('sync dismissal always replies to invalid sender, frame and args without mutating overlay', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.ready()
  probe.resolveLoad()
  await pending
  assert.deepEqual(probe.invokeSync([], { mainFrame: {} }), { ok: false, error: 'invalid_sender' })
  assert.deepEqual(probe.invokeSync([], probe.product, {}), { ok: false, error: 'invalid_sender' })
  assert.deepEqual(probe.invokeSync([], probe.contents), { ok: false, error: 'invalid_sender' })
  assert.deepEqual(probe.invokeSync([true]), { ok: false, error: 'invalid_command' })
  assert.equal(probe.visible(), true)
})

test('explicit focus sends only the current visible revision after native focus', async (context) => {
  const probe = fixture(context)
  const pending = probe.owner.publish(model)
  probe.owner.focus()
  assert.equal(
    probe.messages.some((message) => message.channel === 'scholarseed:overlay-focus-request'),
    false
  )
  probe.ready()
  probe.resolveLoad()
  await pending
  assert.equal(
    probe.messages.some((message) => message.channel === 'scholarseed:overlay-focus-request'),
    false
  )
  probe.owner.focus()
  assert.deepEqual(probe.messages.slice(-2), [
    { channel: 'focus-overlay', payload: null },
    { channel: 'scholarseed:overlay-focus-request', payload: 1 },
  ])
  probe.owner.focus()
  assert.deepEqual(probe.messages.slice(-2), [
    { channel: 'focus-overlay', payload: null },
    { channel: 'scholarseed:overlay-focus-request', payload: 1 },
  ])
  probe.owner.dismiss()
  const dismissedCount = probe.messages.length
  probe.owner.focus()
  assert.equal(probe.messages.length, dismissedCount)
  await probe.owner.publish({ ...model, revision: 2 })
  probe.owner.focus()
  assert.deepEqual(probe.messages.at(-1), {
    channel: 'scholarseed:overlay-focus-request',
    payload: 2,
  })
  probe.owner.dispose()
  const disposedCount = probe.messages.length
  probe.owner.focus()
  assert.equal(probe.messages.length, disposedCount)
})

test('actual preload build emits self-contained sandbox-compatible entry bundles', async () => {
  const directory = fileURLToPath(new URL('../../', import.meta.url))
  const config = await resolveConfig(
    { configFile: join(directory, 'electron.vite.config.ts') },
    'build',
    'production'
  )
  const preloadConfig = config.config?.preload
  assert.ok(preloadConfig)
  const result = await buildVite({
    ...preloadConfig,
    root: directory,
    configFile: false,
    build: { ...preloadConfig.build, write: false, emptyOutDir: false },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const files = outputs.flatMap((output) => ('output' in output ? output.output : []))
  for (const name of ['index.js', 'overlay.js']) {
    const file = files.find((file) => file.fileName === name)
    assert.ok(file, `missing ${name}`)
    const code = file.type === 'chunk' ? file.code : String(file.source)
    if (name === 'index.js') assert.match(code, /sendSync\(OVERLAY_CHANNEL.dismissSync\)/)
    assert.equal(
      /require\(["']\.[^"']*["']\)/.test(code),
      false,
      `${name} has forbidden local sandbox require`
    )
    if (file.type === 'chunk') assert.deepEqual(file.imports, ['electron'])
  }
  const overlay = files.find((file) => file.fileName === 'overlay.js')!
  const code = overlay.type === 'chunk' ? overlay.code : String(overlay.source)
  assert.match(code, /exposeInMainWorld\(["']suggestions["']/)
  assert.doesNotMatch(code, /exposeInMainWorld\(["']scholarseed["']/)
})

test(
  'actual sandboxed Electron overlay exposes only suggestions and completes ready handshake',
  { timeout: 120_000 },
  async () => {
    const directory = fileURLToPath(new URL('../../', import.meta.url))
    const temporary = mkdtempSync(join(tmpdir(), 'overlay-sandbox-'))
    const config = await resolveConfig(
      { configFile: join(directory, 'electron.vite.config.ts') },
      'build',
      'production'
    )
    const preloadConfig = config.config?.preload
    assert.ok(preloadConfig)
    const result = await buildVite({
      ...preloadConfig,
      root: directory,
      configFile: false,
      build: { ...preloadConfig.build, write: false, emptyOutDir: false },
    })
    const outputs = Array.isArray(result) ? result : [result]
    const files = outputs.flatMap((output) => ('output' in output ? output.output : []))
    const preload = files.find((file) => file.fileName === 'overlay.js')!
    const productPreload = files.find((file) => file.fileName === 'index.js')!
    writeFileSync(
      join(temporary, 'index.js'),
      productPreload.type === 'chunk' ? productPreload.code : productPreload.source
    )
    writeFileSync(
      join(temporary, 'overlay.js'),
      preload.type === 'chunk' ? preload.code : preload.source
    )
    mkdirSync(join(temporary, 'assets'))
    writeFileSync(
      join(temporary, 'overlay.html'),
      '<!doctype html><script>window.startSuggestions = () => { window.suggestions.subscribeFocus(revision => { window.focusRevision = revision }); window.suggestions.subscribe(model => { window.receivedModel = model }) }</script>'
    )
    const entry = join(temporary, 'main.cjs')
    await buildScript({
      stdin: {
        contents: `
    import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
    import { createBrowserOverlay } from './src/main/overlay.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessions'))})
    globalThis.ready = app.whenReady().then(async () => {
      ipcMain.on('scholarseed:boot', event => { event.returnValue = { apiBase: '', preferences: {}, browserEnabled: true } })
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, preload: ${JSON.stringify(join(temporary, 'index.js'))} } })
      await window.loadURL('about:blank')
      window.show()
      if (process.platform === 'darwin') app.focus({ steal: true })
      window.focus()
      if (!window.isFocused()) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native window focus unavailable')), 10_000)
        window.once('focus', () => { clearTimeout(timer); resolve() })
      })
      globalThis.window = window
      const owner = createBrowserOverlay(window, {
        ipc: ipcMain, directory: ${JSON.stringify(temporary)}, preload: ${JSON.stringify(join(temporary, 'overlay.js'))},
        createSession: () => session.fromPartition('overlay-sandbox-probe', { cache: false }),
        createView: webPreferences => { const view = new WebContentsView({ webPreferences }); globalThis.overlayView = view; return view }
      })
      globalThis.owner = owner
      return owner.publish(${JSON.stringify(model)})
    })
  `,
        resolveDir: directory,
      },
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      external: ['electron'],
    })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete environment.ELECTRON_RUN_AS_NODE
    const application = await _electron.launch({ args: [entry], env: environment })
    try {
      const beforeReady = await application.evaluate(async () => {
        const state = globalThis as unknown as OverlayProbe
        const reply = await state.ready
        return {
          reply,
          attached: state.window.contentView.children.includes(state.overlayView),
          visible: state.overlayView.getVisible(),
          revision: await state.overlayView.webContents.executeJavaScript(
            'window.receivedModel ?? null'
          ),
        }
      })
      assert.deepEqual(beforeReady, {
        reply: { ok: true },
        attached: false,
        visible: false,
        revision: null,
      })
      await application.evaluate(async () => {
        const state = globalThis as unknown as OverlayProbe
        await state.overlayView.webContents.executeJavaScript('window.startSuggestions()')
      })
      await expect
        .poll(() =>
          application.evaluate(async () => {
            const state = globalThis as unknown as OverlayProbe
            return {
              attached: state.window.contentView.children.includes(state.overlayView),
              visible: state.overlayView.getVisible(),
              revision: await state.overlayView.webContents.executeJavaScript(
                'window.receivedModel?.revision ?? null'
              ),
            }
          })
        )
        .toEqual({ attached: true, visible: true, revision: 1 })
      const automaticFocusRevision = await application.evaluate(() =>
        (globalThis as unknown as OverlayProbe).overlayView.webContents.executeJavaScript(
          'window.focusRevision ?? null'
        )
      )
      await application.evaluate(() => (globalThis as unknown as OverlayProbe).owner.focus())
      await expect
        .poll(() =>
          application.evaluate(() =>
            (globalThis as unknown as OverlayProbe).overlayView.webContents.executeJavaScript(
              'window.focusRevision ?? null'
            )
          )
        )
        .toBe(1)
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as OverlayProbe
        const reply = await state.ready
        const view = state.window.contentView.children.find(
          (child) => 'webContents' in child
        ) as WebContentsView
        const projection = await view.webContents.executeJavaScript(
          `({ keys: Object.keys(window.suggestions), product: typeof window.scholarseed, node: typeof process, revision: window.receivedModel?.revision })`
        )
        const visible = view.getVisible()
        const explicitFocusRevision =
          await view.webContents.executeJavaScript('window.focusRevision')
        const synchronized = await state.window.webContents.executeJavaScript(
          `window.scholarseed.browserOverlay.dismissSync(); 'returned'`
        )
        const revoked = await view.webContents.executeJavaScript(
          `window.suggestions.send({ kind: 'select', revision: 1, itemId: 'first' })`
        )
        return {
          reply,
          visible,
          projection,
          explicitFocusRevision,
          synchronized,
          hiddenAfterReturn: !view.getVisible(),
          revoked,
        }
      })
      assert.deepEqual(
        { ...result, automaticFocusRevision },
        {
          reply: { ok: true },
          visible: true,
          projection: {
            keys: ['subscribeFocus', 'subscribe', 'send'],
            product: 'undefined',
            node: 'undefined',
            revision: 1,
          },
          automaticFocusRevision: null,
          explicitFocusRevision: 1,
          synchronized: 'returned',
          hiddenAfterReturn: true,
          revoked: { ok: false, error: 'invalid_command' },
        }
      )
    } finally {
      await application.close()
      rmSync(temporary, { recursive: true, force: true })
    }
  }
)
