import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import type { BrowserBridge, BrowserSnapshot } from '../browser.ts'
import {
  BROWSER_APPROVAL_RESPONSE_CHANNEL,
  type BrowserApprovalResponseRequest,
} from '../approval.ts'
import {
  BROWSER_COMMAND_CHANNEL,
  BROWSER_DOWNLOAD_CHANNEL,
  BROWSER_FIND_CHANNEL,
  BROWSER_PAGE_CHANNEL,
  BROWSER_FRAME_ACK_CHANNEL,
  BROWSER_FRAME_CHANNEL,
  BROWSER_FRAME_INPUT_CHANNEL,
  BROWSER_FRAME_RESIZE_CHANNEL,
  BROWSER_POLICY_CHANNEL,
  BROWSER_REVEAL_CHANNEL,
  BROWSER_SNAPSHOT_CHANNEL,
} from '../browser.ts'
import {
  MENU_CHANNEL,
  type MenuActionResult,
  type MenuBridge,
  type MenuViewBridge,
} from '../menu.ts'

test('preload exposes exact browser methods and removes only its snapshot subscription', async () => {
  const result = await build({
    entryPoints: ['src/preload/index.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  const calls: unknown[][] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let bridge:
    | {
        browser: BrowserBridge
        menu: MenuBridge
        respondBrowserApproval(request: BrowserApprovalResponseRequest): Promise<unknown>
      }
    | undefined
  const ipcRenderer = {
    sendSync: () => ({ apiBase: '', preferences: {}, browserEnabled: true }),
    invoke: async (...args: unknown[]) => {
      calls.push(args)
      return { ok: true }
    },
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(callback)
    },
    removeListener: (channel: string, callback: (...args: unknown[]) => void) =>
      listeners.get(channel)?.delete(callback),
  }
  runInNewContext(result.outputFiles[0].text, {
    require: () => ({
      ipcRenderer,
      contextBridge: {
        exposeInMainWorld: (_name: string, value: typeof bridge) => {
          bridge = value
        },
      },
    }),
    process: { platform: 'darwin' },
    TextEncoder,
    TextDecoder,
  })
  assert.deepEqual(Object.keys(bridge!.browser).sort(), [
    'clearData',
    'dispatch',
    'downloads',
    'frames',
    'history',
    'page',
    'policy',
    'snapshot',
    'subscribe',
    'subscribeFind',
    'subscribeReveal',
  ])
  const target = { tabId: 'page', instanceId: 'instance', navigationId: 1 }
  await bridge!.browser.page!({ kind: 'print', target })
  assert.deepEqual(calls.splice(0), [[BROWSER_PAGE_CHANNEL, { kind: 'print', target }]])
  const findTargets: unknown[] = []
  const stopFind = bridge!.browser.subscribeFind!((value) => findTargets.push(value))
  for (const callback of listeners.get(BROWSER_FIND_CHANNEL)!)
    callback({ untrustedEvent: true }, target)
  assert.deepEqual(findTargets, [target])
  stopFind()
  assert.equal(listeners.get(BROWSER_FIND_CHANNEL)!.size, 0)
  const revealed: unknown[] = []
  const stopReveal = bridge!.browser.subscribeReveal!((value) => revealed.push(value))
  const stopOtherReveal = bridge!.browser.subscribeReveal!((value) => revealed.push(value))
  stopReveal()
  const reveal = { sessionId: 'session', target }
  for (const callback of listeners.get(BROWSER_REVEAL_CHANNEL)!) callback({ untrustedEvent: true }, reveal)
  assert.deepEqual(revealed, [reveal])
  stopOtherReveal()
  assert.equal(listeners.get(BROWSER_REVEAL_CHANNEL)!.size, 0)
  const frames: unknown[] = []
  const stopFrames = bridge!.browser.frames!.subscribe((frame) => frames.push(frame))
  for (const callback of listeners.get(BROWSER_FRAME_CHANNEL)!)
    callback({}, { tabId: 'tab-a', sequence: 1, data: '/9g=', format: 'jpeg', width: 8, height: 6 })
  assert.equal(frames.length, 1)
  stopFrames()
  assert.equal(listeners.get(BROWSER_FRAME_CHANNEL)!.size, 0)
  await bridge!.browser.frames!.acknowledge('tab-a', 1)
  await bridge!.browser.frames!.resize('tab-a', 800, 600)
  await bridge!.browser.frames!.input('tab-a', { kind: 'text', text: 'hi' })
  assert.deepEqual(JSON.parse(JSON.stringify(calls.splice(0))), [
    [BROWSER_FRAME_ACK_CHANNEL, { tabId: 'tab-a', sequence: 1 }],
    [BROWSER_FRAME_RESIZE_CHANNEL, { tabId: 'tab-a', width: 800, height: 600 }],
    [BROWSER_FRAME_INPUT_CHANNEL, { tabId: 'tab-a', input: { kind: 'text', text: 'hi' } }],
  ])
  await bridge!.browser.snapshot()
  await bridge!.browser.dispatch({ kind: 'copy-endpoint' })
  await bridge!.browser.downloads({ kind: 'read' })
  await bridge!.browser.policy({ kind: 'read' })
  assert.deepEqual(calls, [
    [BROWSER_SNAPSHOT_CHANNEL],
    [BROWSER_COMMAND_CHANNEL, { kind: 'copy-endpoint' }],
    [BROWSER_DOWNLOAD_CHANNEL, { kind: 'read' }],
    [BROWSER_POLICY_CHANNEL, { kind: 'read' }],
  ])
  const approval: BrowserApprovalResponseRequest = {
    sessionId: 'session',
    requestId: 'request',
    proofId: 'main-proof',
    turnId: 'turn',
    tabId: 'tab',
    targetInstanceId: 'instance',
    targetGeneration: 3,
    origin: 'https://example.org',
    action: 'read',
    intent: 'Read page',
    expiresAt: 2_000_000_000_000,
    decision: 'deny',
  }
  await bridge!.respondBrowserApproval(approval)
  assert.deepEqual(calls.at(-1), [BROWSER_APPROVAL_RESPONSE_CHANNEL, approval])
  const received: BrowserSnapshot[] = []
  const stop = bridge!.browser.subscribe((snapshot) => received.push(snapshot))
  const stopOther = bridge!.browser.subscribe((snapshot) => received.push(snapshot))
  const snapshot: BrowserSnapshot = {
    tabs: [],
    activeTabId: null,
    automation: { enabled: true, port: 1234 },
  }
  stop()
  for (const callback of listeners.get(BROWSER_SNAPSHOT_CHANNEL)!)
    callback({ untrustedEvent: true }, snapshot)
  assert.deepEqual(received, [snapshot])
  stopOther()
  assert.equal(listeners.get(BROWSER_SNAPSHOT_CHANNEL)!.size, 0)
  assert.deepEqual(Object.keys(bridge!.menu).sort(), [
    'dismiss',
    'presentation',
    'publish',
    'refocus',
    'seed',
    'subscribe',
    'subscribePresentation',
    'subscribeResult',
    'subscribeRevoked',
  ])
  const ack = { sessionId: 'find', revision: 1 }
  await bridge!.menu.refocus!(ack)
  assert.deepEqual(calls.at(-1), [MENU_CHANNEL.refocus, ack])
  const results: MenuActionResult[] = []
  const stopResult = bridge!.menu.subscribeResult((result) => results.push(result))
  const stopOtherResult = bridge!.menu.subscribeResult((result) => results.push(result))
  stopResult()
  const actionResult: MenuActionResult = {
    sessionId: 'menu-session',
    revision: 1,
    requestId: 'request',
    actionId: 'browser.devtools',
    outcome: 'failed',
  }
  for (const callback of listeners.get(MENU_CHANNEL.result)!)
    callback({ untrustedEvent: true }, actionResult)
  assert.deepEqual(results, [actionResult])
  stopOtherResult()
  assert.equal(listeners.get(MENU_CHANNEL.result)!.size, 0)
})

test('web mode browser methods return desktop_bridge_unavailable without native side effects', async () => {
  const result = await build({
    entryPoints: ['src/renderer/src/browser.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { __SCHOLARSEED_WEB_VERSION__: '"test"' },
  })
  const window = {
    localStorage: { getItem: () => null },
    scholarseed: undefined as { browser: BrowserBridge } | undefined,
  }
  runInNewContext(result.outputFiles[0].text, {
    window,
    navigator: { platform: 'browser', languages: ['en'], language: 'en' },
    Intl,
  })
  const bridge = window.scholarseed!.browser
  assert.equal((await bridge.snapshot()).ok, false)
  assert.equal(
    ((await bridge.dispatch({ kind: 'open' })) as { error: string }).error,
    'desktop_bridge_unavailable'
  )
  assert.equal(((await bridge.snapshot()) as { error: string }).error, 'desktop_bridge_unavailable')
  assert.equal(
    ((await bridge.policy({ kind: 'read' })) as { error: string }).error,
    'browser_policy_io_unavailable'
  )
  const unsubscribe = bridge.subscribe(() =>
    assert.fail('web mode cannot publish native snapshots')
  )
  unsubscribe()
})

test('native scene preload exposes only sealed menu/find messages and releases individual subscriptions', async () => {
  const result = await build({
    entryPoints: ['src/preload/menu.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const names: string[] = []
  let bridge!: MenuViewBridge
  const ipcRenderer = {
    invoke: async () => ({ ok: true }),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(callback)
    },
    removeListener: (channel: string, callback: (...args: unknown[]) => void) =>
      listeners.get(channel)?.delete(callback),
  }
  runInNewContext(result.outputFiles[0].text, {
    require: () => ({
      ipcRenderer,
      contextBridge: {
        exposeInMainWorld: (name: string, value: MenuViewBridge) => {
          names.push(name)
          bridge = value
        },
      },
    }),
  })
  assert.deepEqual(names, ['menu'])
  assert.deepEqual(Object.keys(bridge).sort(), [
    'paintReady',
    'seed',
    'send',
    'subscribe',
    'subscribeFind',
    'subscribeRefocus',
  ])
  const states: unknown[] = []
  const removeFirst = bridge.subscribeFind!((state) => states.push(state))
  const removeSecond = bridge.subscribeFind!((state) => states.push(state))
  removeFirst()
  const state = {
    sessionId: 'find',
    revision: 1,
    querySequence: 1,
    requestId: 1,
    phase: 'ready',
    ordinal: 0,
    count: 0,
    final: true,
  }
  for (const callback of listeners.get(MENU_CHANNEL.findState)!)
    callback({ secretEvent: true }, state)
  assert.deepEqual(states, [state])
  removeSecond()
  assert.equal(listeners.get(MENU_CHANNEL.findState)!.size, 0)
  const acknowledgements: unknown[] = []
  const removeFocus = bridge.subscribeRefocus!((ack) => acknowledgements.push(ack))
  const ack = { sessionId: 'find', revision: 1 }
  for (const callback of listeners.get(MENU_CHANNEL.refocus)!) callback({ secretEvent: true }, ack)
  assert.deepEqual(acknowledgements, [ack])
  removeFocus()
  assert.equal(listeners.get(MENU_CHANNEL.refocus)!.size, 0)
})
