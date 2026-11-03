import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContentsView } from 'electron'
import { createMenuOwner, MenuActionRegistry } from './menuhost.ts'
import { MENU_CHANNEL, parseMenuEvent, parseMenuModel } from '../menu.ts'
import type { MenuActionResult } from '../menu.ts'
import type { FindState } from '../browser.ts'

type IpcHandler = Parameters<IpcMain['handle']>[1]

const model = {
  sessionId: 'session',
  revision: 1,
  surface: 'browser-menu',
  anchor: { x: 10, y: 10, width: 20, height: 20 },
  viewport: { width: 500, height: 300 },
  theme: 'light',
  language: 'en',
  target: { kind: 'browser', tabId: 'tab', instanceId: 'instance', navigationId: 1 },
  items: [
    {
      kind: 'action',
      id: 'devtools',
      actionId: 'browser.devtools',
      label: 'Developer tools',
      disabled: false,
      checked: false,
      value: { kind: 'boolean', value: true },
    },
  ],
}
const rendererUrl = 'http://127.0.0.1:8123/'
const accountModel = {
  ...model,
  surface: 'account-menu',
  target: { kind: 'account', identityRevision: 1 },
  account: {
    alias: null,
    avatar: '',
    credits: { phase: 'error', value: null, unlimited: false },
    availableActions: ['account.settings'],
    logoutBusy: false,
    logoutError: null,
    locale: 'en',
  },
  items: [
    {
      kind: 'action',
      id: 'account.settings',
      actionId: 'account.settings',
      label: 'Settings',
      disabled: false,
      checked: false,
      value: { kind: 'none' },
    },
  ],
}

test('menu diagnostics record lifecycle and validation without model content', async (context) => {
  const host = await fixture(context)
  await host.show()
  host.owner.dismiss('escape')
  const entries = host.diagnostics.map((line) => JSON.parse(line.slice('[menu] '.length)))
  for (const stage of ['accepted', 'loaded', 'paint', 'focused', 'dismissed'])
    assert.ok(
      entries.some((entry) => entry.stage === stage),
      stage
    )
  assert.ok(entries.some((entry) => entry.reason === 'escape' && entry.shown === true))
  assert.equal(host.diagnostics.join('').includes('Developer tools'), false)
  assert.equal(host.diagnostics.join('').includes(rendererUrl), false)
  host.setSize([600, 300])
  await host.owner.publish({ ...model, revision: 2 })
  const rejected = JSON.parse(host.diagnostics.at(-1)!.slice('[menu] '.length))
  assert.equal(rejected.stage, 'validation-rejected')
  assert.equal(rejected.geometry, false)
})

test('menu construction failure is diagnostic without exposing exception text', async (context) => {
  const host = await fixture(context, true)
  assert.equal((await host.owner.publish(model)).ok, false)
  assert.ok(
    host.diagnostics.some(
      (line) => JSON.parse(line.slice('[menu] '.length)).stage === 'create-failed'
    )
  )
  assert.equal(host.diagnostics.join('').includes('native construction failed'), false)
})

test('menu timeout keeps its deadline and records loading state', async (context) => {
  const host = await fixture(context)
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = host.owner.publish(model)
  context.mock.timers.tick(9_999)
  assert.equal(
    host.diagnostics.some((line) => line.includes('"reason":"timeout"')),
    false
  )
  context.mock.timers.tick(1)
  assert.equal((await pending).ok, false)
  const timeout = host.diagnostics
    .map((line) => JSON.parse(line.slice('[menu] '.length)))
    .find((entry) => entry.reason === 'timeout')
  assert.equal(timeout.loaded, false)
  assert.equal(timeout.painted, false)
  assert.equal(timeout.shown, false)
})

test('unfocused account seed is eligible without relaxing browser menu presentation', async (context) => {
  const host = await fixture(context)
  host.window.isFocused = () => false
  assert.equal(
    (await host.invoke('seed', [{ surface: 'account-menu', identityRevision: 1 }], host.product))
      .ok,
    true
  )
  const entries = host.diagnostics.map((line) => JSON.parse(line.slice('[menu] '.length)))
  assert.ok(entries.some((entry) => entry.stage === 'seed-requested' && entry.eligible === true))
  assert.equal((await host.owner.publish(model)).ok, false)
})

for (const native of [false, true])
  test(`account presentation ignores focus transitions with native=${native}`, async (context) => {
    const probe = await fixture(context, false, false, !native)
    const original = await probe.invoke('presentation', [], probe.product)
    assert.equal(original.ok, true)
    assert.equal(original.presentation, native ? 'native' : 'inline')
    for (const focused of [false, true, false, true]) {
      probe.window.isFocused = () => focused
      probe.window.emit(focused ? 'focus' : 'blur')
      assert.deepEqual(await probe.invoke('presentation', [], probe.product), original)
    }
    const presentations = probe.messages.filter(
      (message) => message.channel === MENU_CHANNEL.presentation
    )
    assert.equal(presentations.length, 1)
  })

for (const state of ['hidden', 'minimized', 'destroyed', 'crashed'] as const)
  test(`account focus exemption retains ${state} rejection`, async (context) => {
    const probe = await fixture(context)
    probe.window.isFocused = () => false
    if (state === 'hidden') probe.window.isVisible = () => false
    if (state === 'minimized') probe.window.isMinimized = () => true
    if (state === 'destroyed') probe.window.isDestroyed = () => true
    if (state === 'crashed') probe.product.isCrashed = () => true
    assert.equal((await probe.invoke('presentation', [], probe.product)).ok, false)
    assert.equal(
      (
        await probe.invoke(
          'seed',
          [{ surface: 'account-menu', identityRevision: 1 }],
          probe.product
        )
      ).ok,
      false
    )
    assert.equal((await probe.owner.publish(accountModel)).ok, false)
    assert.equal(probe.operations.includes('show'), false)
  })

test('native account can open without window focus but cannot execute a background action', async (context) => {
  const probe = await fixture(context)
  probe.window.isFocused = () => false
  assert.deepEqual(await probe.show(accountModel), {
    ok: true,
    ack: { sessionId: 'session', revision: 1 },
  })
  assert.equal(probe.visible(), true)
  assert.equal(
    (await probe.action({ actionId: 'account.settings', value: { kind: 'none' } })).ok,
    false
  )
  assert.equal(probe.actions.length, 0)
  assert.equal(probe.visible(), false)
})

test('native account opened before focus accepts an action after focus returns', async (context) => {
  const probe = await fixture(context)
  probe.window.isFocused = () => false
  assert.equal((await probe.show(accountModel)).ok, true)
  probe.window.isFocused = () => true
  probe.window.emit('focus')
  assert.equal(
    (await probe.action({ actionId: 'account.settings', value: { kind: 'none' } })).ok,
    true
  )
  assert.equal(probe.actions.length, 1)
})

test('unfocused browser find remains rejected', async (context) => {
  const probe = await fixture(context)
  probe.window.isFocused = () => false
  assert.equal(
    (
      await probe.owner.publish({
        ...model,
        surface: 'browser-find',
        items: [],
        find: { origin: 'page' },
      })
    ).ok,
    false
  )
  assert.equal(probe.operations.includes('show'), false)
})

test('window blur still dismisses an open account menu without revoking its presentation capability', async (context) => {
  const probe = await fixture(context)
  const original = await probe.invoke('presentation', [], probe.product)
  assert.equal((await probe.show(accountModel)).ok, true)
  probe.window.isFocused = () => false
  probe.window.emit('blur')
  assert.equal(probe.visible(), false)
  assert.deepEqual(await probe.invoke('presentation', [], probe.product), original)
  assert.equal(probe.operations.includes('product-focus'), false)
})

async function fixture(
  context: test.TestContext,
  failCreate = false,
  keepOpen = false,
  initialEmpty = false,
  actionTask?: Promise<void>,
  canonicalUrl = rendererUrl,
  onBeforeInput?: (event: Electron.Event, input: Electron.Input) => void
) {
  const directory = mkdtempSync(join(tmpdir(), 'menu-owner-'))
  mkdirSync(join(directory, 'assets'))
  writeFileSync(join(directory, 'menu.html'), '')
  writeFileSync(join(directory, 'assets', 'menu.js'), '')
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const handlers = new Map<string, IpcHandler>()
  const messages: { channel: string; payload: unknown }[] = []
  const operations: string[] = []
  const diagnostics: string[] = []
  let visible = false
  let closed = false
  let navigationId = 1
  let hasPage = !initialEmpty
  let size = [500, 300]
  let resolveLoad!: () => void
  let rejectLoad!: (error: Error) => void
  let guard!: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void
  let cleared = 0
  let menuFocused = false
  const product = Object.assign(new EventEmitter(), {
    mainFrame: { url: canonicalUrl, processId: 1, routingId: 1 },
    getURL: () => product.mainFrame.url,
    isDestroyed: () => false,
    isCrashed: (): boolean => false,
    getZoomFactor: () => 1,
    send: (channel: string, payload: unknown) => messages.push({ channel, payload }),
    focus: (): void => {
      assert.equal(closed, true)
      assert.equal(messages.at(-1)?.channel, MENU_CHANNEL.revoked)
      operations.push('product-focus')
    },
  })
  let contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => closed,
    close: () => {
      closed = true
    },
    send: (channel: string, payload: unknown) => messages.push({ channel, payload }),
    isFocused: () => menuFocused,
    focus: (): void => {
      operations.push('focus')
      menuFocused = true
      product.emit('blur')
      contents.emit('focus')
    },
    setZoomFactor: () => undefined,
    setBackgroundThrottling: (allowed: boolean) => {
      assert.equal(allowed, false)
      operations.push('painting')
    },
    setWindowOpenHandler: () => undefined,
    loadURL: () =>
      new Promise<void>((resolve, reject) => {
        resolveLoad = resolve
        rejectLoad = reject
      }),
  })
  const view = {
    get webContents() {
      return contents
    },
    getVisible: () => visible,
    setVisible: (value: boolean) => {
      visible = value
      operations.push(value ? 'show' : 'hide')
    },
    setBounds: (bounds: unknown) => {
      assert.deepEqual(bounds, { x: 0, y: 0, width: 500, height: 300 })
      operations.push('bounds')
    },
    setBackgroundColor: () => undefined,
  }
  const isolated = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    webRequest: {
      onBeforeRequest: (handler: typeof guard) => {
        guard = handler
      },
    },
    clearStorageData: () => {
      cleared += 1
      return Promise.resolve()
    },
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: product,
    isDestroyed: (): boolean => false,
    isFocused: (): boolean => true,
    isVisible: (): boolean => true,
    isMinimized: (): boolean => false,
    getContentSize: () => size,
    contentView: {
      addChildView: () => operations.push('reorder'),
      removeChildView: () => operations.push('remove'),
    },
  })
  const actions: unknown[] = []
  const findQueries: unknown[] = []
  let found: ((state: FindState) => void) | null = null
  const registry = new MenuActionRegistry()
  registry.register('browser.devtools', {
    surface: 'browser-menu',
    close: keepOpen ? 'keep-open' : 'before',
    validateValue: (value) => value.kind === 'boolean',
    validateTarget: (target) => target.kind === 'browser',
    execute: (event: unknown) => {
      actions.push(event)
      return actionTask
    },
  })
  registry.register('browser.settings', {
    surface: 'browser-menu',
    close: 'before',
    validateValue: (value) => value.kind === 'none',
    execute: (event) => {
      actions.push(event)
    },
  })
  registry.register('account.settings', {
    surface: 'account-menu',
    close: 'before',
    validateValue: (value) => value.kind === 'none',
    execute: (event) => {
      actions.push(event)
    },
  })
  const owner = createMenuOwner(window as unknown as BrowserWindow, {
    log: (line: string) => diagnostics.push(line),
    rendererUrl: canonicalUrl,
    directory,
    preload: join(directory, 'menu.js'),
    registry,
    onBeforeInput,
    find: {
      query: (_target, query, publish) => {
        findQueries.push(query)
        found = publish
      },
      stop: () => {
        operations.push('stop-find')
      },
      focus: () => {
        operations.push('page-focus')
      },
    },
    target: (request) =>
      request.surface === 'account-menu'
        ? { kind: 'account', identityRevision: request.identityRevision }
        : hasPage
          ? { kind: 'browser', tabId: 'tab', instanceId: 'instance', navigationId }
          : { kind: 'browser-empty' },
    nativeVisible: () => hasPage,
    createSession: () => isolated as unknown as Session,
    createView: () => {
      if (failCreate) throw new Error('native construction failed')
      if (closed) {
        contents = Object.assign(new EventEmitter(), contents, { mainFrame: {} })
        contents.removeAllListeners()
        closed = false
        menuFocused = false
      }
      return view as unknown as WebContentsView
    },
    ipc: {
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
  })
  context.after(() => owner.dispose())
  const invoke = (
    channel: string,
    args: unknown[] = [],
    sender: unknown = contents,
    senderFrame: unknown = (sender as { mainFrame?: unknown }).mainFrame
  ) =>
    handlers.get(`scholarseed:menu-${channel}`)!(
      { sender, senderFrame } as unknown as IpcMainInvokeEvent,
      ...args
    )
  const paint = () => invoke('paint-ready', [{ sessionId: 'session', revision: 1 }])
  const action = (overrides = {}) =>
    invoke('event', [
      {
        kind: 'action',
        sessionId: 'session',
        revision: 1,
        requestId: 'request',
        actionId: 'browser.devtools',
        value: { kind: 'boolean', value: true },
        ...overrides,
      },
    ])
  const show = async (value: unknown = model) => {
    const pending = owner.publish(value)
    await Promise.resolve()
    assert.equal(
      typeof resolveLoad,
      'function',
      'accepted scene starts the isolated native document'
    )
    resolveLoad()
    await Promise.resolve()
    await paint()
    return pending
  }
  return {
    owner,
    diagnostics,
    invoke,
    paint,
    action,
    show,
    get contents() {
      return contents
    },
    window,
    product,
    actions,
    operations,
    messages,
    handlers,
    findQueries,
    found: (state: FindState) => found?.(state),
    visible: () => visible,
    closed: () => closed,
    resolveLoad: () => resolveLoad(),
    rejectLoad: () => rejectLoad(new Error('load failed')),
    cleared: () => cleared,
    setNavigation: (value: number) => {
      navigationId = value
    },
    setSize: (value: number[]) => {
      size = value
    },
    setHasPage: (value: boolean) => {
      hasPage = value
    },
    setMenuFocused: (value: boolean) => {
      menuFocused = value
    },
    request: (url: string) => {
      let result: unknown
      guard({ url }, (reply) => {
        result = reply
      })
      return result
    },
  }
}

test('native menu forwards application keyboard commands without closing or refocusing', async (context) => {
  const received: unknown[] = []
  const probe = await fixture(
    context,
    false,
    false,
    false,
    undefined,
    rendererUrl,
    (_event, input) => received.push(input)
  )
  await probe.show()
  const input = { type: 'keyDown', code: 'Digit7', key: '&', meta: true, shift: true }
  probe.contents.emit('before-input-event', {}, input)
  assert.deepEqual(received, [input])
  assert.equal(probe.visible(), true)
  assert.equal(probe.closed(), false)
  probe.owner.dispose()
  probe.contents.emit('before-input-event', {}, input)
  assert.equal(received.length, 1)
})

test('native find has a separate query grammar, paint lease and original-page focus return', async (context) => {
  const probe = await fixture(context)
  const scene = { ...model, surface: 'browser-find', items: [], find: { origin: 'page' } }
  assert.deepEqual(await probe.show(scene), {
    ok: true,
    ack: { sessionId: 'session', revision: 1 },
  })
  const query = {
    kind: 'find',
    sessionId: 'session',
    revision: 1,
    requestId: 'first',
    querySequence: 1,
    text: 'needle',
    direction: 'forward',
  }
  assert.equal((await probe.invoke('event', [query], probe.contents, {})).ok, false)
  assert.equal((await probe.invoke('event', [query])).ok, true)
  assert.equal(probe.findQueries.length, 1)
  assert.equal((await probe.invoke('event', [query])).ok, false)
  probe.found({ querySequence: 1, requestId: 1, phase: 'ready', ordinal: 1, count: 2, final: true })
  assert.equal(probe.messages.at(-1)?.channel, MENU_CHANNEL.findState)
  probe.owner.dismiss('escape')
  assert.ok(probe.operations.includes('stop-find'))
  assert.ok(probe.operations.includes('page-focus'))
  const count = probe.messages.length
  probe.found({ querySequence: 1, requestId: 1, phase: 'ready', ordinal: 2, count: 2, final: true })
  assert.equal(probe.messages.length, count)
})

test('find result during theme repaint is retained until the new paint and focus ACK', async (context) => {
  const probe = await fixture(context)
  const scene = { ...model, surface: 'browser-find', items: [], find: { origin: 'menu' } }
  await probe.show(scene)
  await probe.invoke('event', [
    {
      kind: 'find',
      sessionId: 'session',
      revision: 1,
      requestId: 'first',
      querySequence: 1,
      text: 'needle',
      direction: 'forward',
    },
  ])
  const updating = probe.owner.publish({ ...scene, revision: 2, theme: 'dark' })
  const state: FindState = {
    querySequence: 1,
    requestId: 1,
    phase: 'ready',
    ordinal: 1,
    count: 2,
    final: true,
  }
  probe.found(state)
  assert.notEqual(probe.messages.at(-1)?.channel, MENU_CHANNEL.findState)
  await probe.invoke('paint-ready', [{ sessionId: 'session', revision: 2 }])
  await updating
  assert.deepEqual(
    [...probe.messages].reverse().find((message) => message.channel === MENU_CHANNEL.findState)
      ?.payload,
    { ...state, sessionId: 'session', revision: 2 }
  )
})

test('presentation derives actual native visibility and never turns hidden window rejection into inline eligibility', async (context) => {
  const probe = await fixture(context)
  assert.ok(probe.handlers.has('scholarseed:menu-presentation'))
  assert.deepEqual(await probe.invoke('presentation', [], probe.product), {
    ok: true,
    revision: 1,
    presentation: 'native',
  })
  probe.setHasPage(false)
  probe.owner.refreshPresentation()
  assert.deepEqual(await probe.invoke('presentation', [], probe.product), {
    ok: true,
    revision: 2,
    presentation: 'inline',
  })
  probe.window.isFocused = () => false
  probe.window.isVisible = () => false
  probe.owner.refreshPresentation()
  assert.deepEqual(await probe.invoke('presentation', [], probe.product), {
    ok: false,
    revision: 3,
    error: 'menu_revoked',
  })
  assert.equal((await probe.invoke('presentation')).ok, false)
  assert.equal(probe.operations.filter((operation) => operation === 'bounds').length, 0)
})

test('account native presentation is rejected without actual visible page instead of CSS fallback', async (context) => {
  const probe = await fixture(context, false, false, true)
  const pending = probe.owner.publish(accountModel)
  await Promise.resolve()
  assert.equal(probe.operations.includes('bounds'), false)
  assert.equal((await pending).ok, false)
  assert.equal(
    (await probe.invoke('seed', [{ surface: 'account-menu', identityRevision: 1 }], probe.product))
      .ok,
    false
  )
})

for (const owned of [false, true])
  test(`Escape returns native product focus only after revoking the currently owned menu ${owned}`, async (context) => {
    const probe = await fixture(context)
    await probe.show()
    probe.setMenuFocused(owned)
    probe.owner.dismiss('escape')
    assert.equal(probe.visible(), false)
    assert.equal(probe.closed(), true)
    assert.equal(
      probe.operations.filter((operation) => operation === 'product-focus').length,
      Number(owned)
    )
  })

for (const reason of ['outside', 'blur', 'target', 'replaced', 'minimize'] as const)
  test(`lifecycle ${reason} never claims Escape focus restoration`, async (context) => {
    const probe = await fixture(context)
    await probe.show()
    probe.owner.dismiss(reason)
    assert.equal(probe.operations.includes('product-focus'), false)
  })

test('Escape cannot return focus into an unfocused product window', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  probe.window.isFocused = () => false
  probe.owner.dismiss('escape')
  assert.equal(probe.operations.includes('product-focus'), false)
})

test('rejects_unknown_or_disabled_action', async (context) => {
  const probe = await fixture(context)
  assert.deepEqual(await probe.show(), { ok: true, ack: { sessionId: 'session', revision: 1 } })
  assert.equal((await probe.action({ actionId: 'browser.arbitrary' })).ok, false)
  assert.equal(probe.actions.length, 0)
  const disabled = await fixture(context)
  await disabled.show({ ...model, items: [{ ...model.items[0], disabled: true }] })
  assert.equal((await disabled.action()).ok, false)
  assert.equal(disabled.actions.length, 0)
})

test('pending_native_menu_remains_hidden_without_paint_permission_and_is_removed_on_failure', async (context) => {
  const probe = await fixture(context)
  const publishing = probe.owner.publish(model)
  await Promise.resolve()
  assert.equal(probe.operations.includes('reorder'), false)
  assert.equal(probe.visible(), false)
  assert.equal((await probe.action()).ok, false)
  probe.rejectLoad()
  assert.equal((await publishing).ok, false)
  assert.ok(probe.operations.includes('remove'))
  assert.equal(probe.closed(), true)
  assert.equal(probe.cleared(), 1)
})

test('loaded_hidden_menu_explicitly_requests_background_paint_without_authorizing_actions', async (context) => {
  const probe = await fixture(context)
  const publishing = probe.owner.publish(model)
  probe.resolveLoad()
  await Promise.resolve()
  assert.ok(probe.operations.includes('painting'))
  assert.ok(probe.operations.includes('reorder'))
  assert.ok(probe.operations.indexOf('reorder') < probe.operations.indexOf('painting'))
  assert.equal(probe.operations.includes('focus'), false)
  assert.equal(probe.visible(), false)
  assert.equal((await probe.action()).ok, false)
  await probe.paint()
  assert.equal((await publishing).ok, true)
})

test('hidden menu attachment is removed when native paint preparation fails', async (context) => {
  const probe = await fixture(context)
  probe.contents.setBackgroundThrottling = () => {
    throw new Error('controlled native paint preparation failure')
  }
  const publishing = probe.owner.publish(model)
  probe.resolveLoad()
  assert.equal((await publishing).ok, false)
  assert.ok(probe.operations.includes('reorder'))
  assert.ok(probe.operations.includes('remove'))
  assert.equal(probe.operations.includes('show'), false)
  assert.equal(probe.operations.includes('focus'), false)
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
  assert.equal(probe.cleared(), 1)
  assert.equal(probe.actions.length, 0)
})

test('empty_browser_displays_only_registered_disabled_page_actions_without_execution_permission', async (context) => {
  const probe = await fixture(context, false, false, true)
  const empty = {
    ...model,
    target: { kind: 'browser-empty' },
    items: [{ ...model.items[0], disabled: true }],
  }
  const pending = probe.owner.publish(empty)
  await Promise.resolve()
  assert.ok(
    probe.operations.includes('bounds'),
    'registered disabled action must reach native presentation'
  )
  probe.resolveLoad()
  await Promise.resolve()
  await probe.paint()
  assert.equal((await pending).ok, true)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 0)
  for (const item of [
    { ...empty.items[0], disabled: false },
    { ...empty.items[0], actionId: 'browser.unknown' },
    { ...empty.items[0], value: { kind: 'none' } },
    { ...empty.items[0], actionId: 'account.settings' },
  ])
    assert.equal((await probe.owner.publish({ ...empty, revision: 2, items: [item] })).ok, false)
  assert.equal(probe.actions.length, 0)
})

test('close_before_failure_reports_typed_result_to_original_product_after_native_layer_is_revoked', async (context) => {
  let rejectAction!: (error: Error) => void
  const task = new Promise<void>((_resolve, reject) => {
    rejectAction = reject
  })
  const probe = await fixture(context, false, false, false, task)
  await probe.show()
  const acting = probe.action()
  assert.equal(probe.closed(), true)
  rejectAction(new Error('real_dispatch_failed'))
  assert.equal((await acting).ok, false)
  assert.deepEqual(
    probe.messages
      .filter((message) => message.channel === 'scholarseed:menu-result')
      .map((message) => message.payload),
    [
      {
        sessionId: 'session',
        revision: 1,
        requestId: 'request',
        actionId: 'browser.devtools',
        outcome: 'failed',
      },
    ]
  )
})

for (const outcome of ['succeeded', 'failed'] as const)
  for (const lifecycle of ['target', 'replaced', 'crash'] as const)
    test(`close_before_late_${outcome}_after_${lifecycle}_does_not_restore_authority`, async (context) => {
      let resolveAction!: () => void
      let rejectAction!: (error: Error) => void
      const task = new Promise<void>((resolve, reject) => {
        resolveAction = resolve
        rejectAction = reject
      })
      const probe = await fixture(context, false, false, false, task)
      await probe.show()
      const acting = probe.action()
      if (lifecycle === 'target') {
        probe.setNavigation(2)
        probe.owner.dismiss('target')
      }
      if (lifecycle === 'replaced')
        await probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)
      if (lifecycle === 'crash') probe.product.emit('render-process-gone')
      if (outcome === 'succeeded') resolveAction()
      else rejectAction(new Error('delayed_failure'))
      await acting
      assert.equal(probe.visible(), false)
      assert.equal(probe.closed(), true)
      const results = probe.messages.filter(
        (message) => message.channel === 'scholarseed:menu-result'
      )
      assert.deepEqual(
        results.map((message) => (message.payload as MenuActionResult).outcome),
        lifecycle === 'crash' ? [] : ['revoked']
      )
    })

test('current_revision_outside_dismiss_during_visible_repaint_revokes_immediately', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  const pending = probe.owner.publish({ ...model, revision: 2 })
  assert.equal(probe.visible(), true)
  assert.equal((await probe.action({ revision: 2 })).ok, false)
  assert.equal(
    (
      await probe.invoke('event', [
        { kind: 'dismiss', sessionId: 'session', revision: 1, reason: 'outside' },
      ])
    ).ok,
    false
  )
  assert.equal(
    (
      await probe.invoke(
        'event',
        [{ kind: 'dismiss', sessionId: 'session', revision: 2, reason: 'outside' }],
        {}
      )
    ).ok,
    false
  )
  assert.equal(probe.visible(), true)
  assert.equal(
    (
      await probe.invoke('event', [
        { kind: 'dismiss', sessionId: 'session', revision: 2, reason: 'outside' },
      ])
    ).ok,
    true
  )
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
  assert.ok(probe.operations.includes('remove'))
  assert.equal((await pending).ok, false)
  assert.equal(
    (await probe.invoke('paint-ready', [{ sessionId: 'session', revision: 2 }])).ok,
    false
  )
  probe.contents.emit('focus')
  assert.equal(probe.visible(), false)
  assert.equal(probe.actions.length, 0)
})

test('main_canonical_renderer_reload_rearms_new_lease_not_old_frame_or_generation', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  const oldContents = probe.contents
  const oldFrame = probe.product.mainFrame
  probe.product.emit('render-process-gone')
  const seed = () =>
    probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)
  probe.product.emit('did-finish-load')
  probe.product.emit('did-frame-finish-load', {}, true, 1, 1)
  assert.equal((await seed()).ok, false)
  const start = (url = rendererUrl, frame = probe.product.mainFrame, sameDocument = false) =>
    probe.product.emit('did-start-navigation', {
      url,
      frame,
      isMainFrame: true,
      isSameDocument: sameDocument,
    })
  const commit = (url = rendererUrl, status = 200, processId = probe.product.mainFrame.processId) =>
    probe.product.emit(
      'did-frame-navigate',
      {},
      url,
      status,
      '',
      true,
      processId,
      probe.product.mainFrame.routingId
    )
  const finish = (processId = probe.product.mainFrame.processId) =>
    probe.product.emit(
      'did-frame-finish-load',
      {},
      true,
      processId,
      probe.product.mainFrame.routingId
    )
  start(rendererUrl, oldFrame, true)
  commit()
  finish()
  assert.equal((await seed()).ok, false)
  start(rendererUrl + 'other')
  commit(rendererUrl + 'other')
  finish()
  assert.equal((await seed()).ok, false)
  start()
  commit(rendererUrl, 500)
  finish()
  assert.equal((await seed()).ok, false)
  start()
  probe.product.mainFrame = { url: rendererUrl, processId: 2, routingId: 2 }
  commit(rendererUrl, 200, 1)
  finish(1)
  assert.equal((await seed()).ok, false)
  start()
  commit()
  probe.product.emit('render-process-gone')
  finish()
  assert.equal((await seed()).ok, false)
  start()
  commit()
  finish()
  const approved = await seed()
  assert.equal(approved.ok, true)
  assert.notEqual(approved.seed.sessionId, 'session')
  assert.equal(
    (
      await probe.invoke(
        'seed',
        [{ surface: 'browser-menu', tabId: 'tab' }],
        probe.product,
        oldFrame
      )
    ).ok,
    false
  )
  assert.equal(
    (await probe.invoke('publish', [{ ...model, revision: 2 }], probe.product)).ok,
    false
  )
  assert.equal((await probe.action()).ok, false)
  const fresh = { ...model, ...approved.seed }
  const pending = probe.invoke('publish', [fresh], probe.product)
  await Promise.resolve()
  probe.resolveLoad()
  await Promise.resolve()
  assert.equal(
    (await probe.invoke('paint-ready', [{ sessionId: fresh.sessionId, revision: fresh.revision }]))
      .ok,
    true
  )
  assert.equal((await pending).ok, true)
  assert.notEqual(probe.contents, oldContents)
  assert.equal(
    (
      await probe.invoke(
        'event',
        [
          {
            kind: 'action',
            sessionId: fresh.sessionId,
            revision: fresh.revision,
            requestId: 'old-sender',
            actionId: 'browser.devtools',
            value: { kind: 'boolean', value: true },
          },
        ],
        oldContents
      )
    ).ok,
    false
  )
  assert.equal(probe.visible(), true)
  assert.equal(probe.actions.length, 0)
})

test('destroyed_product_contents_cannot_rearm_on_canonical_load_events', async (context) => {
  const probe = await fixture(context)
  probe.product.emit('destroyed')
  probe.product.emit('did-start-navigation', {
    url: rendererUrl,
    frame: probe.product.mainFrame,
    isMainFrame: true,
    isSameDocument: false,
  })
  probe.product.emit('did-frame-navigate', {}, rendererUrl, 200, '', true, 1, 1)
  probe.product.emit('did-frame-finish-load', {}, true, 1, 1)
  assert.equal(
    (await probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)).ok,
    false
  )
  assert.equal(probe.visible(), false)
  assert.equal(probe.actions.length, 0)
})

test('file_product_reload_uses_successful_commit_finish_not_http_status_and_rejects_failed_load', async (context) => {
  const canonical = 'file:///product/renderer/index.html'
  const probe = await fixture(context, false, false, false, undefined, canonical)
  probe.product.emit('render-process-gone')
  const seed = () =>
    probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)
  const start = () =>
    probe.product.emit('did-start-navigation', {
      url: canonical,
      frame: probe.product.mainFrame,
      isMainFrame: true,
      isSameDocument: false,
    })
  const commit = (code: number) =>
    probe.product.emit('did-frame-navigate', {}, canonical, code, '', true, 1, 1)
  const finish = () => probe.product.emit('did-frame-finish-load', {}, true, 1, 1)
  start()
  finish()
  assert.equal((await seed()).ok, false)
  start()
  commit(-1)
  probe.product.emit('did-fail-load', {}, -2, 'failed', canonical, true)
  finish()
  assert.equal((await seed()).ok, false)
  start()
  commit(200)
  finish()
  assert.equal((await seed()).ok, true)
})

test('old_async_action_cannot_ack_after_canonical_product_recovery', async (context) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const probe = await fixture(context, false, false, false, gate)
  await probe.show()
  const oldContents = probe.contents
  const pending = probe.action()
  probe.product.emit('render-process-gone')
  probe.product.emit('did-start-navigation', {
    url: rendererUrl,
    frame: probe.product.mainFrame,
    isMainFrame: true,
    isSameDocument: false,
  })
  probe.product.emit('did-frame-navigate', {}, rendererUrl, 200, '', true, 1, 1)
  probe.product.emit('did-frame-finish-load', {}, true, 1, 1)
  assert.equal(
    (await probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)).ok,
    true
  )
  release()
  assert.equal((await pending).ok, false)
  assert.equal(
    (await probe.invoke('paint-ready', [{ sessionId: 'session', revision: 1 }], oldContents)).ok,
    false
  )
  assert.equal(probe.visible(), false)
  assert.equal(probe.actions.length, 1)
})

test('rejects_stale_target_and_duplicate_request', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  probe.setNavigation(2)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 0)
  const next = await fixture(context)
  await next.show()
  assert.equal((await next.action()).ok, true)
  assert.equal((await next.action()).ok, false)
  assert.equal(next.actions.length, 1)
})

test('ack_requires_paint_and_native_show', async (context) => {
  const probe = await fixture(context)
  let settled = false
  const pending = probe.owner.publish(model).then((reply) => {
    settled = true
    return reply
  })
  await Promise.resolve()
  probe.resolveLoad()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(probe.visible(), false)
  assert.ok(
    probe.operations.includes('bounds'),
    'hidden native surface needs full viewport geometry before renderer paint'
  )
  await probe.paint()
  assert.deepEqual(await pending, { ok: true, ack: { sessionId: 'session', revision: 1 } })
  assert.ok(probe.operations.indexOf('reorder') < probe.operations.indexOf('show'))
  assert.equal(probe.visible(), true)
})

test('crash_and_invalid_bounds_revoke_ack', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  probe.contents.emit('render-process-gone')
  assert.equal(probe.visible(), false)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 0)
  const next = await fixture(context)
  await next.show()
  next.setSize([0, 0])
  next.window.emit('resize')
  assert.equal(next.visible(), false)
  assert.equal((await next.action()).ok, false)
})

test('dismiss_during_load_cannot_resurrect', async (context) => {
  const probe = await fixture(context)
  const pending = probe.owner.publish(model)
  await Promise.resolve()
  probe.owner.dismiss('outside')
  probe.resolveLoad()
  assert.equal((await pending).ok, false)
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
  assert.equal(probe.actions.length, 0)
})

test('native_construction_failure_releases_isolated_session', async (context) => {
  const probe = await fixture(context, true)
  assert.equal((await probe.owner.publish(model)).ok, false)
  assert.equal(probe.cleared(), 1)
  assert.equal(probe.visible(), false)
})

test('malformed_product_publish_revokes_previous_ack', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  const malformed = { ...model, revision: 2, viewport: { width: 0, height: 300 } }
  assert.equal((await probe.invoke('publish', [malformed], probe.product)).ok, false)
  assert.equal(probe.visible(), false)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 0)
})

test('stale_paint_ack_cannot_show_or_settle_new_revision', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  let settled = false
  const pending = probe.owner.publish({ ...model, revision: 2 }).then((reply) => {
    settled = true
    return reply
  })
  await Promise.resolve()
  assert.equal((await probe.paint()).ok, false)
  assert.equal(settled, false)
  assert.equal(probe.visible(), true)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 0)
  await probe.invoke('paint-ready', [{ sessionId: 'session', revision: 2 }])
  assert.deepEqual(await pending, { ok: true, ack: { sessionId: 'session', revision: 2 } })
})

test('keep_open_duplicate_request_executes_once_and_invalid_sender_cannot_revoke', async (context) => {
  const probe = await fixture(context, false, true)
  await probe.show()
  assert.equal((await probe.action()).ok, true)
  assert.equal(probe.visible(), true)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 1)
  assert.equal(
    (await probe.invoke('dismiss', ['outside'], probe.product, {})).error,
    'invalid_sender'
  )
  assert.equal(probe.visible(), true)
})

test('menu_models_are_bounded_plain_discriminated_data', () => {
  assert.deepEqual(parseMenuModel(model), model)
  for (const input of [
    { ...model, html: '<script>unsafe</script>' },
    { ...model, target: { ...model.target, path: '/tmp/private' } },
    { ...model, items: [...model.items, model.items[0]] },
    { ...model, items: [{ ...model.items[0], label: 'x'.repeat(4097) }] },
    { ...model, anchor: { ...model.anchor, x: Infinity } },
    { ...model, viewport: { width: 0, height: 300 } },
  ])
    assert.throws(() => parseMenuModel(input))
  assert.throws(() =>
    parseMenuEvent({
      kind: 'action',
      sessionId: 'session',
      revision: 1,
      requestId: 'request',
      actionId: 'browser.devtools',
      value: { kind: 'boolean', value: 'true' },
    })
  )
})

test('sender_frame_action_parameters_and_unissued_session_cannot_expand_capabilities', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  assert.equal(
    (await probe.invoke('paint-ready', [{ sessionId: 'session', revision: 1 }], probe.contents, {}))
      .error,
    'invalid_sender'
  )
  assert.equal((await probe.invoke('publish', [model], probe.contents)).error, 'invalid_sender')
  assert.equal((await probe.action({ value: { kind: 'boolean', value: false } })).ok, false)
  assert.equal((await probe.action({ sessionId: 'foreign' })).ok, false)
  assert.equal(probe.actions.length, 0)
  assert.equal(probe.visible(), true)
  assert.equal(
    (
      await probe.invoke(
        'publish',
        [{ ...model, sessionId: 'foreign', revision: 2 }],
        probe.product
      )
    ).ok,
    false
  )
  const seed = await probe.invoke(
    'seed',
    [{ surface: 'browser-menu', tabId: 'tab' }],
    probe.product
  )
  assert.equal(seed.ok, true)
  assert.deepEqual(seed.seed.target, {
    kind: 'browser',
    tabId: 'tab',
    instanceId: 'instance',
    navigationId: 1,
  })
  assert.notEqual(seed.seed.sessionId, 'session')
  assert.equal(probe.visible(), false)
})

test('load_failure_disposes_hit_layer_and_window_disposal_unregisters_channels', async (context) => {
  const probe = await fixture(context)
  const pending = probe.owner.publish(model)
  await Promise.resolve()
  probe.rejectLoad()
  assert.deepEqual(await pending, { ok: false, error: 'menu_failed' })
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
  assert.equal(probe.cleared(), 1)
  probe.owner.dispose()
  assert.equal(probe.handlers.size, 0)
})

test('empty_browser_authorizes_only_management_and_new_tab_revokes_old_action', async (context) => {
  const probe = await fixture(context, false, false, true)
  const empty = {
    ...model,
    target: { kind: 'browser-empty' },
    items: [{ ...model.items[0], actionId: 'browser.settings', value: { kind: 'none' } }],
  }
  assert.equal((await probe.show(empty)).ok, true)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.actions.length, 0)
  probe.setHasPage(true)
  assert.equal(
    (await probe.action({ actionId: 'browser.settings', value: { kind: 'none' } })).ok,
    false
  )
  assert.equal(probe.visible(), false)
  assert.equal(probe.actions.length, 0)
  const allowed = await fixture(context, false, false, true)
  await allowed.show(empty)
  assert.equal(
    (await allowed.action({ actionId: 'browser.settings', value: { kind: 'none' } })).ok,
    true
  )
  assert.equal(allowed.actions.length, 1)
})

test('late_keep_open_result_cannot_acknowledge_a_navigated_target', async (context) => {
  let release!: () => void
  const actionTask = new Promise<void>((resolve) => {
    release = resolve
  })
  const probe = await fixture(context, false, true, false, actionTask)
  await probe.show()
  const pending = probe.action()
  assert.equal(probe.actions.length, 1)
  probe.setNavigation(2)
  release()
  assert.equal((await pending).ok, false)
})

test('native_focus_lifecycle_revocation_wins_over_show_ack', async (context) => {
  const probe = await fixture(context)
  probe.contents.focus = () => {
    probe.window.emit('blur')
  }
  assert.equal((await probe.show()).ok, false)
  assert.equal(probe.visible(), false)
})

test('menu_contents_blur_revokes_hit_layer_sender_and_previous_lease', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  probe.setMenuFocused(false)
  probe.contents.emit('blur')
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
  assert.ok(probe.operations.includes('remove'))
  assert.equal((await probe.action()).ok, false)
  assert.equal((await probe.paint()).ok, false)
  assert.equal(
    (await probe.invoke('publish', [{ ...model, revision: 2 }], probe.product)).ok,
    false
  )
  assert.equal(probe.actions.length, 0)
})

for (const eventName of ['render-process-gone', 'destroyed'])
  test(`product_${eventName}_revokes_menu_and_requires_owner_reassembly`, async (context) => {
    const probe = await fixture(context)
    await probe.show()
    probe.product.emit(eventName)
    assert.equal(probe.visible(), false)
    assert.equal(probe.closed(), true)
    assert.ok(probe.operations.includes('remove'))
    assert.equal((await probe.action()).ok, false)
    assert.equal(
      (await probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)).ok,
      false
    )
    assert.equal((await probe.owner.publish({ ...model, revision: 2 })).ok, false)
    probe.product.emit('did-finish-load')
    assert.equal(
      (await probe.invoke('seed', [{ surface: 'browser-menu', tabId: 'tab' }], probe.product)).ok,
      false
    )
    assert.equal(probe.actions.length, 0)
  })

test('product_crash_revokes_unpainted_product_lease', async (context) => {
  const probe = await fixture(context)
  const seeded = await probe.invoke(
    'seed',
    [{ surface: 'browser-menu', tabId: 'tab' }],
    probe.product
  )
  probe.product.emit('render-process-gone')
  assert.equal(
    (await probe.invoke('publish', [{ ...model, ...seeded.seed }], probe.product)).ok,
    false
  )
  assert.equal(probe.visible(), false)
  assert.equal(probe.actions.length, 0)
})

test('void_focus_and_unconfirmed_focus_event_cannot_ack_until_actual_focus_state', async (context) => {
  const probe = await fixture(context)
  probe.contents.focus = () => undefined
  let settled = false
  const pending = probe.owner.publish(model).then((reply) => {
    settled = true
    return reply
  })
  await Promise.resolve()
  probe.resolveLoad()
  await Promise.resolve()
  const painting = probe.paint()
  await Promise.resolve()
  assert.equal(settled, false)
  probe.contents.emit('focus')
  await Promise.resolve()
  assert.equal(settled, false)
  probe.setMenuFocused(true)
  probe.contents.emit('focus')
  assert.deepEqual(await pending, { ok: true, ack: { sessionId: 'session', revision: 1 } })
  assert.equal((await painting).ok, true)
})

test('normal_product_to_menu_focus_transfer_does_not_revoke', async (context) => {
  const probe = await fixture(context)
  assert.equal((await probe.show()).ok, true)
  assert.equal(probe.contents.isFocused(), true)
  assert.equal(probe.visible(), true)
  assert.equal(
    probe.messages.some((message) => message.channel === 'scholarseed:menu-revoked'),
    false
  )
})

test('focus_state_without_blur_event_rejects_action', async (context) => {
  const probe = await fixture(context)
  await probe.show()
  probe.setMenuFocused(false)
  assert.equal((await probe.action()).ok, false)
  assert.equal(probe.visible(), false)
  assert.equal(probe.actions.length, 0)
})

test('product_crash_during_async_action_cannot_ack_or_revive', async (context) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const probe = await fixture(context, false, true, false, gate)
  await probe.show()
  const pending = probe.action()
  assert.equal(probe.actions.length, 1)
  probe.product.emit('render-process-gone')
  release()
  assert.equal((await pending).ok, false)
  assert.equal(probe.visible(), false)
  assert.equal(probe.closed(), true)
})
