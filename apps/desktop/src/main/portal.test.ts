import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createPortalHost, createPortalGroup } from './portal.ts'
import { raiseNativeLayers, registerNativeLayer } from './layers.ts'
import { SETTINGS_PORTAL_CHANNEL, SETTINGS_PORTAL_NAME, SETTINGS_PORTAL } from '../settings.ts'
import {
  PORTAL_URL as SETTINGS_PORTAL_URL,
  CONVERSATION_PORTAL,
  FOREGROUND_PORTAL,
  RESIZE_PORTAL,
  UPDATE_PORTAL,
} from '../portal.ts'

function fixture(surface = SETTINGS_PORTAL, factory = createPortalHost) {
  const handlers = new Map<string, Function>()
  const mainFrame = {}
  const product = Object.assign(new EventEmitter(), {
    mainFrame,
    isDestroyed: () => false,
    isCrashed: () => false,
    getZoomFactor: () => 1,
    focus() {},
    send() {},
  })
  const children: unknown[] = []
  const window = Object.assign(new EventEmitter(), {
    webContents: product,
    isDestroyed: () => false,
    isFocused: () => true,
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 840 }),
    contentView: {
      children,
      addChildView(view: unknown) {
        const previous = children.indexOf(view)
        if (previous >= 0) children.splice(previous, 1)
        children.push(view)
      },
      removeChildView(view: unknown) {
        children.splice(children.indexOf(view), 1)
      },
    },
  })
  let visible = false
  let destroyed = false
  let bounds: unknown
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    close() {
      destroyed = true
      contents.emit('destroyed')
    },
    focus() {},
    setWindowOpenHandler() {},
    isFocused: () => false,
    setZoomFactor() {},
  })
  const view = {
    webContents: contents,
    setBackgroundColor() {},
    setVisible(value: boolean) {
      visible = value
    },
    getVisible: () => visible,
    setBounds(value: unknown) {
      bounds = value
    },
  }
  const owner = factory(window as never, {
    surface,
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    preload: '/owned/settings.js',
    createView: () => view as never,
  })
  const event = { sender: product, senderFrame: mainFrame }
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return {
    owner,
    window,
    product,
    contents,
    view,
    children,
    handlers,
    invoke,
    visible: () => visible,
    destroyed: () => destroyed,
    bounds: () => bounds,
  }
}

test('two resize reservations stay independent and unknown senders cannot consume a slot', async () => {
  const probe = fixture(RESIZE_PORTAL, (window, options) =>
    createPortalGroup(window, { ...options, capacity: 2 })
  )
  assert.deepEqual(
    await probe.handlers.get(RESIZE_PORTAL.channels.reserve)!({ sender: {}, senderFrame: {} }),
    { ok: false }
  )
  const first = await probe.invoke(RESIZE_PORTAL.channels.reserve)
  const second = await probe.invoke(RESIZE_PORTAL.channels.reserve)
  for (const session of [first, second])
    assert.equal(
      probe.owner.windowOpen({
        url: SETTINGS_PORTAL_URL,
        frameName: RESIZE_PORTAL.name + session.sessionId,
      })?.action,
      'allow'
    )
  assert.deepEqual(await probe.invoke(RESIZE_PORTAL.channels.reserve), { ok: false })
  assert.deepEqual(await probe.invoke(RESIZE_PORTAL.channels.close, first.sessionId), { ok: true })
  assert.equal(
    probe.owner.windowOpen({
      url: SETTINGS_PORTAL_URL,
      frameName: RESIZE_PORTAL.name + second.sessionId,
    })?.action,
    'allow'
  )
  assert.equal((await probe.invoke(RESIZE_PORTAL.channels.reserve)).ok, true)
  probe.owner.dispose()
  assert.equal(probe.handlers.size, 0)
})

test('foreground error stays above browser suggestions in either creation order', () => {
  for (const alertFirst of [true, false]) {
    const probe = fixture(FOREGROUND_PORTAL)
    const createView = () => ({
      webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false }),
    })
    const alert = createView()
    const suggestions = createView()
    const modal = createView()
    for (const view of alertFirst ? [alert, suggestions] : [suggestions, alert])
      probe.window.contentView.addChildView(view as never)
    probe.window.contentView.addChildView(modal as never)
    registerNativeLayer(probe.window as never, alert as never, FOREGROUND_PORTAL.layer)
    registerNativeLayer(probe.window as never, suggestions as never, 'popup')
    registerNativeLayer(probe.window as never, modal as never, 'modal')
    raiseNativeLayers(probe.window as never)
    assert.equal(probe.children.length, 3)
    assert.equal(probe.children[0], suggestions)
    assert.equal(probe.children[1], alert)
    assert.equal(probe.children[2], modal)
    probe.owner.dispose()
  }
})

test('stable portal stack does not reorder native children on geometry updates', async () => {
  const probe = fixture(RESIZE_PORTAL)
  const reserved = await probe.invoke(RESIZE_PORTAL.channels.reserve)
  const admission = probe.owner.windowOpen({
    url: SETTINGS_PORTAL_URL,
    frameName: RESIZE_PORTAL.name + reserved.sessionId,
  })!
  const construct = (admission as unknown as { createWindow(options: unknown): unknown })
    .createWindow
  construct({})
  let reordered = 0
  const add = probe.window.contentView.addChildView.bind(probe.window.contentView)
  probe.window.contentView.addChildView = (view) => {
    reordered++
    add(view)
  }
  for (let index = 0; index < 20; index++) {
    await probe.invoke(RESIZE_PORTAL.channels.place, reserved.sessionId, {
      x: index,
      y: 0,
      width: 12,
      height: 100,
    })
    raiseNativeLayers(probe.window as never)
  }
  assert.equal(reordered, 0)
  probe.owner.dispose()
})

for (const surface of [SETTINGS_PORTAL, UPDATE_PORTAL]) {
  test(`${surface.name} requires a product-main-frame reservation and blocks input until matching paint`, async () => {
    const probe = fixture(surface)
    const SETTINGS_PORTAL_CHANNEL = surface.channels
    const SETTINGS_PORTAL_NAME = surface.name
    assert.equal(
      probe.owner.windowOpen({ url: SETTINGS_PORTAL_URL, frameName: 'unreserved' } as never),
      null
    )
    assert.deepEqual(
      await probe.handlers.get(SETTINGS_PORTAL_CHANNEL.reserve)!({ sender: {}, senderFrame: {} }),
      { ok: false }
    )
    const reserved = await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve)
    assert.equal(reserved.ok, true)
    const admission = probe.owner.windowOpen({
      url: SETTINGS_PORTAL_URL,
      frameName: SETTINGS_PORTAL_NAME + reserved.sessionId,
    } as never)!
    assert.equal(admission.action, 'allow')
    admission.createWindow!({})
    assert.equal(probe.visible(), true)
    let prevented = false
    probe.contents.emit(
      'before-input-event',
      {
        preventDefault: () => {
          prevented = true
        },
      },
      { type: 'keyDown', key: 'a', code: 'KeyA' }
    )
    assert.equal(prevented, true)
    probe.contents.emit(
      'before-input-event',
      { preventDefault() {} },
      { type: 'keyUp', key: 'a', code: 'KeyA' }
    )
    assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, 'stale'), { ok: false })
    assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, reserved.sessionId), {
      ok: true,
    })
    assert.equal(probe.visible(), true)
    assert.deepEqual(probe.bounds(), { x: 0, y: 0, width: 1280, height: 840 })
    const replacementPage = {}
    probe.children.push(replacementPage)
    probe.owner.raise()
    assert.deepEqual(probe.children, [replacementPage, probe.view])
    probe.owner.raise()
    assert.equal(probe.children.length, 2)
    assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.close, reserved.sessionId), {
      ok: true,
    })
    assert.equal(probe.destroyed(), true)
    probe.owner.dispose()
  })
}

test('a lower modal cannot reclaim focus or receive input beneath a blocking update screen', async () => {
  const probe = fixture()
  const reserved = await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve)
  probe.owner.windowOpen({
    url: SETTINGS_PORTAL_URL,
    frameName: SETTINGS_PORTAL_NAME + reserved.sessionId,
  })!.createWindow!({})
  await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, reserved.sessionId)
  let focusCount = 0
  probe.contents.focus = () => {
    focusCount++
  }
  const update = {
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false }),
    getVisible: () => true,
  }
  probe.children.push(update)
  registerNativeLayer(probe.window as never, update as never, UPDATE_PORTAL.layer)
  probe.window.emit('focus')
  assert.equal(focusCount, 0)
  let prevented = false
  probe.contents.emit(
    'before-input-event',
    {
      preventDefault: () => {
        prevented = true
      },
    },
    {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
    }
  )
  assert.equal(prevented, true)
  probe.children.splice(probe.children.indexOf(update), 1)
  update.webContents.emit('destroyed')
  probe.window.emit('focus')
  assert.equal(focusCount, 1)
  probe.owner.dispose()
})

for (const surface of [CONVERSATION_PORTAL, RESIZE_PORTAL, FOREGROUND_PORTAL]) {
  test(`${surface.name} portal validates bounded placement and never blocks product input`, async () => {
    const probe = fixture(surface)
    const channels = surface.channels
    const reserved = await probe.invoke(channels.reserve)
    probe.owner.windowOpen({
      url: SETTINGS_PORTAL_URL,
      frameName: surface.name + reserved.sessionId,
    })!.createWindow!({})
    assert.deepEqual(
      await probe.invoke(channels.place, reserved.sessionId, {
        x: 900,
        y: 700,
        width: 380,
        height: 56,
      }),
      { ok: true }
    )
    await probe.invoke(channels.paint, reserved.sessionId)
    assert.deepEqual(probe.bounds(), { x: 900, y: 700, width: 380, height: 56 })
    let prevented = false
    probe.product.emit('before-input-event', {
      preventDefault: () => {
        prevented = true
      },
    })
    assert.equal(prevented, false)
    assert.deepEqual(
      await probe.invoke(channels.place, reserved.sessionId, {
        x: 0,
        y: 0,
        width: Infinity,
        height: 1,
      }),
      { ok: false }
    )
    assert.deepEqual(await probe.invoke(channels.place, 'stale', null), { ok: false })
    assert.deepEqual(await probe.invoke(channels.place, reserved.sessionId, null), { ok: true })
    assert.equal(probe.visible(), false)
    assert.deepEqual(await probe.invoke(channels.close, reserved.sessionId), { ok: true })
    assert.equal(probe.destroyed(), true)
    probe.owner.dispose()
  })
}

test('closing settings drains held keys instead of delivering their release to the webpage', async () => {
  const probe = fixture()
  const reserved = await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve)
  probe.owner.windowOpen({
    url: SETTINGS_PORTAL_URL,
    frameName: SETTINGS_PORTAL_NAME + reserved.sessionId,
  } as never)!.createWindow!({})
  await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, reserved.sessionId)
  probe.contents.emit(
    'before-input-event',
    { preventDefault() {} },
    { type: 'keyDown', code: 'Escape', key: 'Escape' }
  )
  const closing = probe.invoke(SETTINGS_PORTAL_CHANNEL.close, reserved.sessionId)
  assert.equal(probe.destroyed(), false)
  assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve), { ok: false })
  probe.contents.emit(
    'before-input-event',
    { preventDefault() {} },
    { type: 'keyUp', code: 'Escape', key: 'Escape' }
  )
  assert.deepEqual(await closing, { ok: true })
  assert.equal(probe.destroyed(), true)
  probe.owner.dispose()
})

test('navigation revokes native settings without changing browser views or admitting stale paint', async () => {
  const probe = fixture()
  const reserved = await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve)
  probe.owner.windowOpen({
    url: SETTINGS_PORTAL_URL,
    frameName: SETTINGS_PORTAL_NAME + reserved.sessionId,
  } as never)!.createWindow!({})
  probe.product.emit('did-start-navigation', {}, 'http://owned/', false, true)
  assert.equal(probe.destroyed(), true)
  assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, reserved.sessionId), {
    ok: false,
  })
  assert.equal(probe.children.length, 0)
  probe.owner.dispose()
  assert.equal(probe.handlers.size, 0)
})

test('settings rejects extra arguments, wrong frames, unrelated popups and duplicate children', async () => {
  const probe = fixture()
  assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve, {}), { ok: false })
  assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, undefined), { ok: false })
  assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.close, undefined), { ok: false })
  const reservation = await probe.invoke(SETTINGS_PORTAL_CHANNEL.reserve)
  assert.deepEqual(
    probe.owner.windowOpen({
      url: 'https://example.com/',
      frameName: SETTINGS_PORTAL_NAME + reservation.sessionId,
    } as never),
    { action: 'deny' }
  )
  assert.deepEqual(
    await probe.handlers.get(SETTINGS_PORTAL_CHANNEL.paint)!(
      { sender: probe.product, senderFrame: {} },
      reservation.sessionId
    ),
    { ok: false }
  )
  const details = {
    url: SETTINGS_PORTAL_URL,
    frameName: SETTINGS_PORTAL_NAME + reservation.sessionId,
  }
  probe.owner.windowOpen(details as never)!.createWindow!({})
  assert.deepEqual(probe.owner.windowOpen(details as never), { action: 'deny' })
  assert.deepEqual(await probe.invoke(SETTINGS_PORTAL_CHANNEL.paint, reservation.sessionId, {}), {
    ok: false,
  })
  probe.owner.dispose()
})
