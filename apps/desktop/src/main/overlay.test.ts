import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContentsView,
} from 'electron'
import {
  parseBrowserOverlayModel,
  parseBrowserOverlayEvent,
  overlayBounds,
  OVERLAY_CHANNEL,
  TOOLTIP_OVERLAY_CHANNEL,
} from '../overlay.ts'
import { createBrowserOverlay } from './overlay.ts'
import { model } from './overlay.fixture.ts'

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

test('toast projections only carry bounded plain text and fixed close or pause events', () => {
  const toast = {
    ...model,
    items: [],
    toast: { title: 'Operation failed', tone: 'error', closeLabel: 'Close' },
    toastBounds: { x: 0, y: 0, width: 300, height: 66 },
  }
  assert.deepEqual(parseBrowserOverlayModel(toast), toast)
  for (const invalid of [
    { ...toast, items: model.items },
    { ...toast, tooltip: 'Mixed', tooltipBounds: toast.toastBounds },
    { ...toast, toast: { ...toast.toast, tone: 'unknown' } },
    { ...toast, toastBounds: { ...toast.toastBounds, width: 301 } },
  ])
    assert.throws(() => parseBrowserOverlayModel(invalid))
  assert.deepEqual(parseBrowserOverlayEvent({ kind: 'toast-close', revision: 1 }), {
    kind: 'toast-close',
    revision: 1,
  })
  assert.deepEqual(parseBrowserOverlayEvent({ kind: 'toast-hover', revision: 1, paused: true }), {
    kind: 'toast-hover',
    revision: 1,
    paused: true,
  })
  assert.throws(() =>
    parseBrowserOverlayEvent({ kind: 'toast-hover', revision: 1, paused: 'true' })
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
  const diagnostics: string[] = []
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
      children: [] as unknown[],
      addChildView(child: unknown) {
        this.children = this.children.filter((candidate) => candidate !== child)
        this.children.push(child)
        ordering.push(child)
      },
      removeChildView(child: unknown) {
        this.children = this.children.filter((candidate) => candidate !== child)
        ordering.push({ removed: child })
      },
    },
  })
  const owner = createBrowserOverlay(window as unknown as BrowserWindow, {
    log: (line: string) => diagnostics.push(line),
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
    diagnostics,
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

test('native toast only forwards current close and pause events without page capabilities', async (context) => {
  const probe = fixture(context, true)
  const toast = {
    ...model,
    items: [],
    toast: { title: 'Operation failed', tone: 'error', closeLabel: 'Close' },
    toastBounds: { x: 0, y: 0, width: 300, height: 66 },
  }
  const publishing = probe.owner.publish(toast)
  probe.ready()
  probe.resolveLoad()
  assert.deepEqual(await publishing, { ok: true })
  for (const event of [
    { kind: 'select', revision: 1, itemId: 'first' },
    { kind: 'toast-close', revision: 2 },
  ])
    assert.deepEqual(probe.invoke(TOOLTIP_OVERLAY_CHANNEL.event, [event], probe.contents), {
      ok: false,
      error: 'invalid_command',
    })
  assert.deepEqual(
    probe.invoke(
      TOOLTIP_OVERLAY_CHANNEL.event,
      [{ kind: 'toast-hover', revision: 1, paused: true }],
      probe.contents
    ),
    { ok: true }
  )
  assert.equal(probe.visible(), true)
  assert.deepEqual(
    probe.invoke(
      TOOLTIP_OVERLAY_CHANNEL.event,
      [{ kind: 'toast-close', revision: 1 }],
      probe.contents
    ),
    { ok: true }
  )
  assert.equal(probe.visible(), false)
})

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
      [{ kind: 'tooltip-hover', revision: 1, paused: true }],
      probe.contents
    ),
    { ok: true }
  )
  assert.equal(probe.visible(), true)
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
  assert.equal(probe.diagnostics.length, 1)
  assert.match(probe.diagnostics[0], /"source":"overlay"/)
  assert.match(probe.diagnostics[0], /"operation":"publish"/)
  assert.match(probe.diagnostics[0], /"revision":1/)
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
