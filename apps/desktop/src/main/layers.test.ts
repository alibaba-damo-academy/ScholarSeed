import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerNativeLayer, raiseNativeLayers, isFrontmostNativeLayer } from './layers.ts'

test('native layer ordering preserves open popups above newly created panels and modal input surfaces', () => {
  const children: unknown[] = []
  let changes = 0
  const window = {
    isDestroyed: () => false,
    contentView: {
      children,
      addChildView(view: unknown) {
        const previous = children.indexOf(view)
        if (previous >= 0) children.splice(previous, 1)
        children.push(view)
        changes++
      },
    },
  }
  const create = () => ({
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false }),
    getVisible: () => true,
  })
  const popup = create()
  const panel = create()
  const modal = create()
  const control = create()
  for (const [view, layer] of [
    [popup, 'popup'],
    [panel, 'panel'],
    [modal, 'modal'],
    [control, 'control'],
  ] as const) {
    children.push(view)
    registerNativeLayer(window as never, view as never, layer)
    raiseNativeLayers(window as never)
  }
  assert.deepEqual(children, [control, panel, popup, modal])
  const count = changes
  raiseNativeLayers(window as never)
  assert.equal(changes, count)
  children.splice(children.indexOf(modal), 1)
  modal.webContents.emit('destroyed')
  raiseNativeLayers(window as never)
  assert.deepEqual(children, [control, panel, popup])
  const newerPopup = create()
  children.push(newerPopup)
  registerNativeLayer(window as never, newerPopup as never, 'popup')
  raiseNativeLayers(window as never)
  window.contentView.addChildView(popup)
  raiseNativeLayers(window as never)
  assert.deepEqual(children, [control, panel, newerPopup, popup])
  const update = create()
  children.push(update)
  registerNativeLayer(window as never, update as never, 'blocking')
  const settings = create()
  children.push(settings)
  registerNativeLayer(window as never, settings as never, 'modal')
  raiseNativeLayers(window as never)
  assert.deepEqual(children, [control, panel, newerPopup, popup, settings, update])
  assert.equal(isFrontmostNativeLayer(window as never, update as never), true)
  assert.equal(isFrontmostNativeLayer(window as never, settings as never), false)
  children.splice(children.indexOf(update), 1)
  update.webContents.emit('destroyed')
  assert.equal(isFrontmostNativeLayer(window as never, settings as never), true)
})
