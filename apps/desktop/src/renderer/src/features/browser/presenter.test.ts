import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserOverlayBridge, BrowserOverlayModel } from '../../../../overlay.ts'
import { createSuggestions } from './presenter.ts'
import { OVERLAY_LIMIT, parseBrowserOverlayModel } from '../../../../overlay.ts'

const model = {
  bounds: { x: 10, y: 20, width: 300, height: 120 },
  theme: 'light',
  language: 'en',
  status: 'ready',
  items: [{ id: 'paper', title: 'Paper', detail: 'example.org' }],
} as const

for (const length of [OVERLAY_LIMIT.text, OVERLAY_LIMIT.text + 1]) {
  test(`suggestion display bounds ${length} characters without changing navigation`, async () => {
    let published!: BrowserOverlayModel
    const bridge = {
      seed: async () => 0,
      publish: async (value: BrowserOverlayModel) => {
        published = parseBrowserOverlayModel(value)
        return { ok: true as const }
      },
      dismiss: async () => ({ ok: true as const }),
      dismissSync() {},
      focus: async () => ({ ok: true as const }),
      subscribe: () => () => undefined,
    } satisfies BrowserOverlayBridge
    const controller = createSuggestions(bridge)
    const url = 'https://example.org/'.padEnd(length, 'a')
    const title = 'x'.repeat(length)
    await controller.publish(
      { ...model, items: [{ id: 'paper', title, detail: url }] },
      new Map([['paper', url]])
    )
    assert.equal(published.items[0].detail.length, OVERLAY_LIMIT.text)
    assert.equal(published.items[0].title.length, OVERLAY_LIMIT.text)
    assert.equal(published.items[0].detail.endsWith('…'), length > OVERLAY_LIMIT.text)
    assert.equal(
      controller.select({ kind: 'select', revision: published.revision, itemId: 'paper' }),
      url
    )
    assert.equal(url.length, length)
  })
}

test('suggestions respect UTF-8 payload and item budgets without splitting Unicode', async () => {
  let published!: BrowserOverlayModel
  const bridge = {
    seed: async () => 0,
    publish: async (value: BrowserOverlayModel) => {
      published = parseBrowserOverlayModel(value)
      return { ok: true as const }
    },
    dismiss: async () => ({ ok: true as const }),
    dismissSync() {},
    focus: async () => ({ ok: true as const }),
    subscribe: () => () => undefined,
  } satisfies BrowserOverlayBridge
  const controller = createSuggestions(bridge)
  const items = Array.from({ length: OVERLAY_LIMIT.items + 1 }, (_, index) => ({
    id: String(index),
    title: '界'.repeat(OVERLAY_LIMIT.text),
    detail: 'a'.repeat(OVERLAY_LIMIT.text - 2) + '😀tail',
  }))
  const targets = new Map(items.map((item) => [item.id, `https://example.org/${item.id}`]))
  await controller.publish({ ...model, items }, targets)
  assert.ok(published.items.length > 0)
  assert.ok(published.items.length < items.length)
  assert.ok(new TextEncoder().encode(JSON.stringify(published)).byteLength <= OVERLAY_LIMIT.bytes)
  assert.equal(published.items[0].detail, 'a'.repeat(OVERLAY_LIMIT.text - 2) + '…')
  assert.equal(
    controller.select({ kind: 'select', revision: published.revision, itemId: items.at(-1)!.id }),
    null
  )
  await controller.publish(
    { ...model, items: items.map((item) => ({ ...item, title: 'short', detail: 'short' })) },
    targets
  )
  assert.equal(published.items.length, OVERLAY_LIMIT.items)
})

test('suggestions await owner highwater and increase revision for each model', async () => {
  let finish!: (revision: number) => void
  const published: BrowserOverlayModel[] = []
  const bridge = {
    seed: () =>
      new Promise<number>((resolve) => {
        finish = resolve
      }),
    publish: async (value: BrowserOverlayModel) => {
      published.push(value)
      return { ok: true }
    },
    dismiss: async () => ({ ok: true }),
    dismissSync() {},
    focus: async () => ({ ok: true }),
    subscribe: () => () => undefined,
  } satisfies BrowserOverlayBridge
  const controller = createSuggestions(bridge)
  const pending = controller.publish(
    { ...model, items: [...model.items] },
    new Map([['paper', 'https://example.org/']])
  )
  assert.equal(published.length, 0)
  finish(41)
  await pending
  await controller.publish(
    { ...model, items: [...model.items] },
    new Map([['paper', 'https://example.org/']])
  )
  assert.deepEqual(
    published.map((value) => value.revision),
    [42, 43]
  )
  assert.equal(controller.select({ kind: 'select', revision: 42, itemId: 'paper' }), null)
  assert.equal(controller.select({ kind: 'select', revision: 43, itemId: 'other' }), null)
  assert.equal(
    controller.select({ kind: 'select', revision: 43, itemId: 'paper' }),
    'https://example.org/'
  )
})

test('dismiss before seed resolves cancels queued models and invalidates selection', async () => {
  let finish!: (revision: number) => void
  const published: BrowserOverlayModel[] = []
  const bridge = {
    seed: () =>
      new Promise<number>((resolve) => {
        finish = resolve
      }),
    publish: async (value: BrowserOverlayModel) => {
      published.push(value)
      return { ok: true }
    },
    dismiss: async () => ({ ok: true }),
    dismissSync() {},
    focus: async () => ({ ok: true }),
    subscribe: () => () => undefined,
  } satisfies BrowserOverlayBridge
  const controller = createSuggestions(bridge)
  const pending = controller.publish(
    { ...model, items: [...model.items] },
    new Map([['paper', 'https://example.org/']])
  )
  await controller.dismiss()
  finish(77)
  await pending
  assert.equal(published.length, 0)
  await controller.publish(
    { ...model, items: [...model.items] },
    new Map([['paper', 'https://example.org/']])
  )
  assert.equal(published[0].revision, 78)
  await controller.dismiss()
  assert.equal(controller.select({ kind: 'select', revision: 78, itemId: 'paper' }), null)
})

test('new query invalidates selection immediately before its publication', async () => {
  const bridge = {
    seed: async () => 0,
    publish: async () => ({ ok: true }),
    dismiss: async () => ({ ok: true }),
    dismissSync() {},
    focus: async () => ({ ok: true }),
    subscribe: () => () => undefined,
  } satisfies BrowserOverlayBridge
  const controller = createSuggestions(bridge)
  await controller.publish(
    { ...model, items: [...model.items] },
    new Map([['paper', 'https://example.org/']])
  )
  controller.invalidate()
  assert.equal(controller.select({ kind: 'select', revision: 1, itemId: 'paper' }), null)
})

test('seed failure is exposed on publish and focus failures remain explicit', async () => {
  const bridge = {
    seed: async () => {
      throw new Error('seed unavailable')
    },
    publish: async () => ({ ok: true }),
    dismiss: async () => ({ ok: true }),
    dismissSync() {},
    focus: async () => ({ ok: false, error: 'operation_failed' }),
    subscribe: () => () => undefined,
  } satisfies BrowserOverlayBridge
  const controller = createSuggestions(bridge)
  await assert.rejects(
    controller.publish({ ...model, items: [...model.items] }, new Map()),
    /seed unavailable/
  )
  await assert.rejects(controller.focus(), /operation_failed/)
})
