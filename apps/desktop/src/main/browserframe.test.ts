import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_FRAME_ACK_CHANNEL, BROWSER_FRAME_CHANNEL, BROWSER_FRAME_INPUT_CHANNEL, BROWSER_FRAME_RESIZE_CHANNEL } from '../browser.ts'
import { registerBrowserFrameIpc } from './browserframe.ts'

test('frame bridge delivers only active target and rejects stale or foreign acknowledgements', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const sent: unknown[][] = []
  const calls: unknown[][] = []
  const mainFrame = {}
  const contents = { mainFrame, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
  let listener: (frame: unknown) => void = () => undefined
  const targets = {
    onFrame(callback: (frame: unknown) => void) { listener = callback; return () => undefined },
    acknowledgeFrame: async (...args: unknown[]) => { calls.push(['ack', ...args]) },
    resize: async (...args: unknown[]) => { calls.push(['resize', ...args]) },
    input: async (...args: unknown[]) => { calls.push(['input', ...args]) }
  }
  registerBrowserFrameIpc({ handle: (channel: string, callback: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, callback) } as never, {
    contents: () => contents as never, targets: () => targets as never,
    active: () => ({ tabId: 'tab-a', targetId: 'target-a' })
  })
  const invoke = (channel: string, event: unknown, value: unknown) => handlers.get(channel)!(event, value)
  assert.deepEqual(await invoke(BROWSER_FRAME_RESIZE_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', width: 800, height: 600 }), { ok: true })
  calls.length = 0
  const frame = { targetId: 'target-a', sequence: 4, data: '/9g=', format: 'jpeg', width: 800, height: 600 }
  listener({ ...frame, targetId: 'target-b' })
  assert.equal(sent.length, 0)
  assert.deepEqual(calls, [['ack', 'target-b', 4]])
  calls.length = 0
  listener(frame)
  assert.deepEqual(sent, [[BROWSER_FRAME_CHANNEL, { tabId: 'tab-a', sequence: 4, data: '/9g=', format: 'jpeg', width: 800, height: 600 }]])
  await assert.rejects(invoke(BROWSER_FRAME_ACK_CHANNEL, { sender: contents, senderFrame: {} }, { tabId: 'tab-a', sequence: 4 }), /invalid_sender/)
  assert.deepEqual(await invoke(BROWSER_FRAME_ACK_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', sequence: 3 }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await invoke(BROWSER_FRAME_ACK_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-b', sequence: 4 }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await invoke(BROWSER_FRAME_ACK_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', sequence: 4 }), { ok: true })
  assert.deepEqual(calls, [['ack', 'target-a', 4]])
  assert.deepEqual(await invoke(BROWSER_FRAME_INPUT_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', input: { kind: 'mouse', type: 'mousePressed', x: 50, y: 60, button: 'left' } }), { ok: true })
  assert.deepEqual(await invoke(BROWSER_FRAME_INPUT_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', input: { kind: 'mouse', type: 'mousePressed', x: 800, y: 60, button: 'left' } }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await invoke(BROWSER_FRAME_RESIZE_CHANNEL, { sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', width: 0, height: 600 }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(calls.slice(1), [['input', 'target-a', { kind: 'mouse', type: 'mousePressed', x: 50, y: 60, button: 'left' }]])
  listener({ ...frame, sequence: 5, width: 801 })
  assert.equal(sent.length, 1)
  assert.deepEqual(calls.at(-1), ['ack', 'target-a', 5])
})

test('acknowledging a frame admits the next frame emitted during Chromium acknowledgement', async () => {
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>()
  const sent: unknown[][] = []
  const mainFrame = {}
  const contents = { mainFrame, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
  let listener: (frame: { targetId: string; sequence: number; data: string; format: 'jpeg'; width: number; height: number }) => void = () => undefined
  const targets = {
    onFrame(callback: typeof listener) { listener = callback; return () => undefined },
    acknowledgeFrame: async () => listener({ targetId: 'target-a', sequence: 2, data: '/9g=', format: 'jpeg', width: 800, height: 600 }),
    resize: async () => undefined,
    input: async () => undefined
  }
  registerBrowserFrameIpc({ handle: (channel: string, callback: (event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, callback) } as never, {
    contents: () => contents as never, targets: () => targets as never, active: () => ({ tabId: 'tab-a', targetId: 'target-a' })
  })
  const event = { sender: contents, senderFrame: mainFrame }
  await handlers.get(BROWSER_FRAME_RESIZE_CHANNEL)!(event, { tabId: 'tab-a', width: 800, height: 600 })
  listener({ targetId: 'target-a', sequence: 1, data: '/9g=', format: 'jpeg', width: 800, height: 600 })
  await handlers.get(BROWSER_FRAME_ACK_CHANNEL)!(event, { tabId: 'tab-a', sequence: 1 })
  assert.deepEqual(sent.map(call => (call[1] as { sequence: number }).sequence), [1, 2])
})

test('failed renderer delivery acknowledges the rejected frame instead of blocking screencast', async () => {
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>()
  const acknowledged: number[] = []
  const mainFrame = {}
  const contents = { mainFrame, isDestroyed: () => false, send: () => { throw new Error('renderer gone') } }
  let listener: (frame: { targetId: string; sequence: number; data: string; format: 'jpeg'; width: number; height: number }) => void = () => undefined
  const targets = {
    onFrame(callback: typeof listener) { listener = callback; return () => undefined },
    acknowledgeFrame: async (_targetId: string, sequence: number) => { acknowledged.push(sequence) },
    resize: async () => undefined,
    input: async () => undefined
  }
  registerBrowserFrameIpc({ handle: (channel: string, callback: (event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, callback) } as never, {
    contents: () => contents as never, targets: () => targets as never, active: () => ({ tabId: 'tab-a', targetId: 'target-a' })
  })
  await handlers.get(BROWSER_FRAME_RESIZE_CHANNEL)!({ sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', width: 800, height: 600 })
  listener({ targetId: 'target-a', sequence: 1, data: '/9g=', format: 'jpeg', width: 800, height: 600 })
  assert.deepEqual(acknowledged, [1])
})

test('frame delivery is prepared for synchronous acknowledgement reentry', async () => {
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>()
  const mainFrame = {}
  const acknowledgements: number[] = []
  let reply: Promise<unknown> | undefined
  const contents = { mainFrame, isDestroyed: () => false, send: () => {
    reply = handlers.get(BROWSER_FRAME_ACK_CHANNEL)!({ sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', sequence: 1 })
  } }
  let listener: (frame: { targetId: string; sequence: number; data: string; format: 'jpeg'; width: number; height: number }) => void = () => undefined
  const targets = {
    onFrame(callback: typeof listener) { listener = callback; return () => undefined },
    acknowledgeFrame: async (_targetId: string, sequence: number) => { acknowledgements.push(sequence) },
    resize: async () => undefined, input: async () => undefined
  }
  registerBrowserFrameIpc({ handle: (channel: string, callback: (event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, callback) } as never, {
    contents: () => contents as never, targets: () => targets as never, active: () => ({ tabId: 'tab-a', targetId: 'target-a' })
  })
  await handlers.get(BROWSER_FRAME_RESIZE_CHANNEL)!({ sender: contents, senderFrame: mainFrame }, { tabId: 'tab-a', width: 800, height: 600 })
  listener({ targetId: 'target-a', sequence: 1, data: '/9g=', format: 'jpeg', width: 800, height: 600 })
  assert.deepEqual(await reply, { ok: true })
  assert.deepEqual(acknowledgements, [1])
})

test('late target binding and source replacement acknowledge old frames on their original target manager', async () => {
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>()
  const mainFrame = {}
  const sent: unknown[][] = []
  const contents = { mainFrame, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
  const oldAcks: number[] = []
  const newAcks: number[] = []
  let oldListener: (frame: { targetId: string; sequence: number; data: string; format: 'jpeg'; width: number; height: number }) => void = () => undefined
  const oldTargets = {
    onFrame(callback: typeof oldListener) { oldListener = callback; return () => undefined },
    acknowledgeFrame: async (_targetId: string, sequence: number) => { oldAcks.push(sequence) },
    resize: async () => undefined, input: async () => undefined
  }
  const newTargets = {
    onFrame: (_callback: typeof oldListener) => () => undefined,
    acknowledgeFrame: async (_targetId: string, sequence: number) => { newAcks.push(sequence) },
    resize: async () => undefined, input: async () => undefined
  }
  let targets: typeof oldTargets | null = null
  registerBrowserFrameIpc({ handle: (channel: string, callback: (event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, callback) } as never, {
    contents: () => contents as never, targets: () => targets as never, active: () => ({ tabId: 'tab-a', targetId: 'target-a' })
  })
  const event = { sender: contents, senderFrame: mainFrame }
  targets = oldTargets
  assert.deepEqual(await handlers.get(BROWSER_FRAME_RESIZE_CHANNEL)!(event, { tabId: 'tab-a', width: 800, height: 600 }), { ok: true })
  oldListener({ targetId: 'target-a', sequence: 1, data: '/9g=', format: 'jpeg', width: 800, height: 600 })
  assert.equal(sent.length, 1)
  targets = newTargets
  await handlers.get(BROWSER_FRAME_RESIZE_CHANNEL)!(event, { tabId: 'tab-a', width: 800, height: 600 })
  oldListener({ targetId: 'target-a', sequence: 2, data: '/9g=', format: 'jpeg', width: 800, height: 600 })
  assert.deepEqual(oldAcks, [2])
  assert.deepEqual(newAcks, [])
})
