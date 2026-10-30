import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMainInvokeEvent } from 'electron'
import { BROWSER_COMMAND_CHANNEL, BROWSER_DATA_CHANNEL, BROWSER_DOWNLOAD_CHANNEL, BROWSER_HISTORY_CHANNEL, BROWSER_POLICY_CHANNEL, BROWSER_SNAPSHOT_CHANNEL } from '../browser.ts'
import type { BrowserDataRequest, BrowserHistoryQuery, BrowserPageCommand } from '../browser.ts'
import { registerBrowserIpc } from './browseripc.ts'
import { BROWSER_PAGE_CHANNEL } from '../browser.ts'

test('CDP toggles persist only successful effects and fail closed on preference errors', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const contents = { mainFrame: {} }
  let enabled = false
  let failWrite = false
  let failStart = false
  const persisted: boolean[] = []
  const host = {
    snapshot: () => ({ tabs: [], activeTabId: null, automation: { enabled, port: enabled ? 1234 : null } }),
    automation: {
      start: async () => { if (failStart) throw Error('start'); enabled = true },
      stop: async () => { enabled = false },
    },
  }
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true, contents: () => contents as never, host: () => host as never,
    saveAutomationEnabled: value => { if (failWrite) throw Error('disk'); persisted.push(value) },
  })
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  const command = handlers.get(BROWSER_COMMAND_CHANNEL)!
  await command(event, { kind: 'automation', enabled: true })
  await command(event, { kind: 'automation', enabled: false })
  assert.deepEqual(persisted, [true, false])
  failWrite = true
  assert.deepEqual(await command(event, { kind: 'automation', enabled: true }), { ok: false, error: 'operation_failed' })
  assert.equal(enabled, false)
  enabled = true
  assert.deepEqual(await command(event, { kind: 'automation', enabled: false }), { ok: false, error: 'operation_failed' })
  assert.equal(enabled, false)
  failWrite = false
  failStart = true
  assert.deepEqual(await command(event, { kind: 'automation', enabled: true }), { ok: false, error: 'operation_failed' })
  assert.deepEqual(persisted, [true, false])
})

test('page IPC binds exact main-frame sender and host across async results', async () => {
  const handlers = new Map<string, Function>()
  const contents = { mainFrame: {} }
  let finish!: (value: unknown) => void
  const target = { tabId: 'tab', instanceId: 'instance', navigationId: 1 }
  let host: unknown = { ui: { page: () => new Promise(resolve => { finish = resolve }) } }
  registerBrowserIpc({ handle: (name, callback) => { handlers.set(name, callback) } }, { enabled: () => true, contents: () => contents as never, host: () => host as never })
  const handler = handlers.get(BROWSER_PAGE_CHANNEL)
  assert.equal(typeof handler, 'function')
  const event = { sender: contents, senderFrame: contents.mainFrame }
  assert.equal((await handler!({ ...event, senderFrame: {} }, { kind: 'print', target })).ok, false)
  assert.equal((await handler!(event, { kind: 'print', target, path: '/anything' })).ok, false)
  const pending = handler!(event, { kind: 'print', target })
  host = null
  finish({ ok: true, target, print: { status: 'success' } })
  assert.deepEqual(await pending, { ok: false, error: 'desktop_bridge_unavailable' })
})

test('disabled browser rejects every IPC before parsing or reading owners', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const contents = { mainFrame: {} }
  const calls: string[] = []
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => false,
    contents: () => contents as never,
    host: () => { calls.push('host'); throw new Error('must not read host') },
    policy: () => { calls.push('policy'); throw new Error('must not read policy') }
  })
  const event = { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent
  for (const handler of handlers.values()) {
    assert.deepEqual(await handler(event, { kind: 'automation', enabled: true }), { ok: false, error: 'desktop_bridge_unavailable' })
  }
  assert.deepEqual(calls, [])
})

test('browser IPC validates main-frame ownership and exact commands before touching native capabilities', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  const contents = { mainFrame: frame }
  const snapshot = { tabs: [], activeTabId: null, automation: { enabled: false, port: null } }
  const actions: unknown[] = []
  const host = { snapshot: () => snapshot, ui: { dispatch: async (command: BrowserPageCommand) => { actions.push(command); return snapshot },
    queryHistory: (query: BrowserHistoryQuery) => { actions.push(query); return { items: [], total: 0 } }, deleteHistory: async (id: string) => { actions.push(id); return true },
    reopenHistory: async (id: string) => { actions.push(`reopen:${id}`); return snapshot }, clearData: async (request: BrowserDataRequest) => { actions.push(request); return 2 },
    downloadSettings: () => ({ directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: true, automaticAvailable: true }),
    chooseDownloadDirectory: async () => ({ directory: '/chosen', isDefault: false, directoryAvailable: true, askEveryTime: true, automaticAvailable: true }),
    resetDownloadDirectory: () => ({ directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: true, automaticAvailable: true }),
    setAskEveryTime: (enabled: boolean) => ({ directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: enabled, automaticAvailable: true }) },
  automation: { start: async () => { actions.push('start'); return { port: 1234 } }, stop: async () => { actions.push('stop') }, copyEndpoint: () => { actions.push('copy') } } }
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never,
    host: () => host as never
  })
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const command = handlers.get(BROWSER_COMMAND_CHANNEL)!
  const read = handlers.get(BROWSER_SNAPSHOT_CHANNEL)!
  assert.equal(handlers.size, 7)
  assert.equal(typeof handlers.get(BROWSER_PAGE_CHANNEL), 'function')
  for (const invalid of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }, { sender: contents, senderFrame: null }]) {
    await assert.rejects(async () => command(invalid as IpcMainInvokeEvent, { kind: 'open' }), /invalid_sender/)
    await assert.rejects(async () => read(invalid as IpcMainInvokeEvent), /invalid_sender/)
  }
  for (const payload of [null, [], {}, { kind: 'executeJavaScript', script: 'secret' }, { kind: 'close', tabId: '' }, { kind: 'open', webContentsId: 1 }, { kind: 'bounds', tabId: 'page', visible: true, x: 0, y: 0, width: -1, height: 1 }, { kind: 'bounds', tabId: 'page', visible: true, x: NaN, y: 0, width: 1, height: 1 }]) {
    assert.deepEqual(await command(event, payload), { ok: false, error: 'invalid_command' })
  }
  assert.deepEqual(actions, [])
  assert.deepEqual(await read(event), { ok: true, snapshot })
  assert.deepEqual(await read(event, {}), { ok: false, error: 'invalid_command' })
  await command(event, { kind: 'devtools', tabId: 'page', open: true })
  await command(event, { kind: 'automation', enabled: true })
  await command(event, { kind: 'copy-endpoint' })
  await command(event, { kind: 'automation', enabled: false })
  assert.deepEqual(actions, [{ kind: 'devtools', tabId: 'page', open: true }, 'start', 'copy', 'stop'])
  const history = handlers.get(BROWSER_HISTORY_CHANNEL)!
  const data = handlers.get(BROWSER_DATA_CHANNEL)!
  assert.deepEqual(await history(event, { kind: 'query', query: { offset: 0, limit: 10 } }), { ok: true, page: { items: [], total: 0 } })
  assert.deepEqual(await data(event, { kind: 'clear-site-data', origin: 'https://example.org' }), { ok: true, deleted: 2 })
  assert.deepEqual(await data(event, { kind: 'clear-selected', types: ['cookies', 'cache'] }), { ok: true, deleted: 2 })
  const actionsBeforeInvalidData = actions.length
  for (const payload of [
    { kind: 'clear-site-data' },
    { kind: 'clear-site-data', origin: undefined },
    { kind: 'clear-selected', types: [] },
    { kind: 'clear-selected', types: ['cookies', 'cookies'] },
    { kind: 'clear-selected', types: ['downloads'] },
    { kind: 'clear-selected', types: ['cookies'], since: Date.now() },
    { kind: 'clear-selected', types: ['cookies'], origin: 'https://example.org' }
  ]) assert.deepEqual(await data(event, payload), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await data(event, { kind: 'clear-site-data', origin: 'file:///etc' }), { ok: false, error: 'invalid_command' })
  assert.equal(actions.length, actionsBeforeInvalidData)
  const downloads = handlers.get(BROWSER_DOWNLOAD_CHANNEL)!
  assert.deepEqual(await downloads(event, { kind: 'choose-directory', path: '/tmp/attacker' }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await downloads(event, { kind: 'read' }), { ok: true, settings: { directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: true, automaticAvailable: true } })
  assert.deepEqual(await downloads(event, { kind: 'choose-directory' }), { ok: true, settings: { directory: '/chosen', isDefault: false, directoryAvailable: true, askEveryTime: true, automaticAvailable: true } })
  assert.deepEqual(await downloads(event, { kind: 'set-ask-every-time', enabled: false }), { ok: true, settings: { directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: false, automaticAvailable: true } })
  assert.deepEqual(await downloads(event, { kind: 'set-ask-every-time', enabled: 'false' }), { ok: false, error: 'invalid_command' })
})

test('clearing data rejects browser commands and automation until CDP has stopped and the Session sweep completes', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  const contents = { mainFrame: frame }
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const actions: string[] = []
  let finishStop!: () => void
  const stop = new Promise<void>(resolve => { finishStop = resolve })
  const snapshot = { tabs: [], activeTabId: null, automation: { enabled: false, port: null } }
  const host = { snapshot: () => snapshot, ui: { dispatch: async () => snapshot,
    queryHistory: () => ({ items: [], total: 0 }), deleteHistory: async () => false, reopenHistory: async () => snapshot,
    clearData: async (_request: BrowserDataRequest, stopAutomation?: () => Promise<void>) => { actions.push('clear-start'); await stopAutomation?.(); actions.push('clear-done'); return 0 },
    downloadSettings: () => ({ directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: true, automaticAvailable: false }),
    chooseDownloadDirectory: async () => ({ directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: true, automaticAvailable: false }),
    resetDownloadDirectory: () => ({ directory: '/default', isDefault: true, directoryAvailable: true, askEveryTime: true, automaticAvailable: false }),
    setAskEveryTime: () => { throw new Error('automatic_download_unavailable') } },
  automation: { start: async () => { actions.push('start'); return { port: 1234 } },
    stop: async () => { actions.push('stop'); await stop }, copyEndpoint: () => undefined } }
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never,
    host: () => host as never
  })
  const clearing = handlers.get(BROWSER_DATA_CHANNEL)!(event, { kind: 'clear-all' })
  assert.deepEqual(await handlers.get(BROWSER_COMMAND_CHANNEL)!(event, { kind: 'automation', enabled: true }), { ok: false, error: 'cdp_busy' })
  assert.deepEqual(await handlers.get(BROWSER_COMMAND_CHANNEL)!(event, { kind: 'open' }), { ok: false, error: 'cdp_busy' })
  finishStop()
  assert.deepEqual(await clearing, { ok: true, deleted: 0 })
  assert.deepEqual(actions, ['clear-start', 'stop', 'clear-done'])
})

test('an in-flight browser command never returns a replacement host snapshot', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  const contents = { mainFrame: frame }
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  let finishCommand!: () => void
  const pending = new Promise<void>(resolve => { finishCommand = resolve })
  const oldSnapshot = { tabs: [], activeTabId: null, automation: { enabled: false, port: null } }
  const newSnapshot = { tabs: [{ tabId: 'new' }], activeTabId: 'new', automation: { enabled: false, port: null } }
  const oldHost = { snapshot: () => oldSnapshot, ui: { dispatch: async () => { await pending; return oldSnapshot } },
    automation: { start: async () => ({ port: 1 }), stop: async () => undefined, copyEndpoint: () => undefined } }
  let activeHost: unknown = oldHost
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never, host: () => activeHost as never
  })
  const command = Promise.resolve(handlers.get(BROWSER_COMMAND_CHANNEL)!(event, { kind: 'open' }))
  activeHost = { snapshot: () => newSnapshot }
  finishCommand()
  assert.deepEqual(await command, { ok: false, error: 'desktop_bridge_unavailable' })
})

test('queued automation cannot start a retired browser host', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  const contents = { mainFrame: frame }
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const actions: string[] = []
  let releaseStop!: () => void
  const pendingStop = new Promise<void>(resolve => { releaseStop = resolve })
  const oldHost = { snapshot: () => ({ tabs: [], activeTabId: null, automation: { enabled: false, port: null } }),
    automation: { stop: async () => { actions.push('stop'); await pendingStop },
      start: async () => { actions.push('start'); return { port: 1234 } }, copyEndpoint: () => {} } }
  let activeHost: unknown = oldHost
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never, host: () => activeHost as never
  })
  const invoke = handlers.get(BROWSER_COMMAND_CHANNEL)!
  const stopping = Promise.resolve(invoke(event, { kind: 'automation', enabled: false }))
  await Promise.resolve()
  const starting = Promise.resolve(invoke(event, { kind: 'automation', enabled: true }))
  activeHost = null
  releaseStop()
  await stopping
  assert.deepEqual(await starting, { ok: false, error: 'desktop_bridge_unavailable' })
  assert.deepEqual(actions, ['stop'])
})

test('agent site policy IPC rejects web frames and invalid grants, then returns authoritative revisions', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  let rendererUrl = 'http://127.0.0.1:5173/'
  const contents = { mainFrame: frame, getURL: () => rendererUrl }
  const sites = new Map<string, { read: 'ask' | 'allow' | 'block'; interact: 'ask' | 'allow' | 'block' }>()
  let revision = 0
  let agentBrowserUseEnabled = false
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    policy: () => ({
      revision: () => revision,
      sites: () => [...sites].map(([origin, rule]) => ({ origin, ...rule })),
      snapshot: () => ({ revision, agentBrowserUseEnabled, sites: [...sites].map(([origin, rule]) => ({ origin, ...rule })) }),
      setAgentBrowserUse: enabled => { agentBrowserUseEnabled = enabled; revision += 1 },
      set: (origin, action, decision) => { sites.set(origin, { ...sites.get(origin) ?? { read: 'ask', interact: 'ask' }, [action]: decision }); revision += 1 },
      remove: origin => { sites.delete(origin); revision += 1 }
    }),
    host: () => null
  })
  const invoke = handlers.get(BROWSER_POLICY_CHANNEL)!
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  assert.deepEqual(await invoke({ sender: contents, senderFrame: {} } as IpcMainInvokeEvent, { kind: 'read' }), { ok: false, error: 'invalid_sender' })
  assert.deepEqual(await invoke({ sender: contents, senderFrame: {} } as IpcMainInvokeEvent, { kind: 'set-agent-use', enabled: true }), { ok: false, error: 'invalid_sender' })
  rendererUrl = 'https://attacker.example/'
  assert.deepEqual(await invoke(event, { kind: 'read' }), { ok: false, error: 'invalid_sender' })
  rendererUrl = 'http://127.0.0.1:5173/'
  assert.deepEqual(await invoke(event, { kind: 'set', origin: 'https://example.org/path', action: 'read', decision: 'allow' }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await invoke(event, { kind: 'set', origin: 'https://example.org', action: 'submit', decision: 'allow' }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await invoke(event, { kind: 'set-agent-use', enabled: 'true' }), { ok: false, error: 'invalid_command' })
  assert.deepEqual(await invoke(event, { kind: 'set-agent-use', enabled: true, secret: 'injected' }), { ok: false, error: 'invalid_command' })
  assert.equal(sites.size, 0)
  assert.deepEqual(await invoke(event, { kind: 'set-agent-use', enabled: true }), { ok: true, policy: { revision: 1, agentBrowserUseEnabled: true, sites: [] } })
  assert.deepEqual(await invoke(event, { kind: 'set', origin: 'https://example.org', action: 'read', decision: 'allow' }), {
    ok: true, policy: { revision: 2, agentBrowserUseEnabled: true, sites: [{ origin: 'https://example.org', read: 'allow', interact: 'ask' }] }
  })
  assert.deepEqual(await invoke(event, { kind: 'remove', origin: 'https://example.org' }), { ok: true, policy: { revision: 3, agentBrowserUseEnabled: true, sites: [] } })
})

test('disabling Agent Browser Use waits for history delivery and blocks re-enable meanwhile', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  const contents = { mainFrame: frame, getURL: () => 'http://127.0.0.1:5173/' }
  let enabled = true
  let release!: () => void
  const delivery = new Promise<void>(resolve => { release = resolve })
  const host = { historyAgent: { waitForLeases: () => delivery, revokeAll: () => {} } }
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    policy: () => ({ snapshot: () => ({ revision: 1, agentBrowserUseEnabled: enabled, sites: [] }),
      setAgentBrowserUse: next => { enabled = next }, set: () => {}, remove: () => {} }),
    host: () => host as never
  })
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  const invoke = handlers.get(BROWSER_POLICY_CHANNEL)!
  let settled = false
  const disabling = Promise.resolve(invoke(event, { kind: 'set-agent-use', enabled: false }))
    .then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(enabled, false)
  assert.equal(settled, false)
  assert.deepEqual(await invoke(event, { kind: 'set-agent-use', enabled: true }),
    { ok: false, error: 'browser_history_delivery_pending' })
  assert.equal(enabled, false)
  release()
  assert.deepEqual(await disabling, { ok: true, policy: { revision: 1, agentBrowserUseEnabled: false, sites: [] } })
  assert.deepEqual(await invoke(event, { kind: 'set-agent-use', enabled: true }),
    { ok: true, policy: { revision: 1, agentBrowserUseEnabled: true, sites: [] } })
})

test('unavailable Agent site policy fails closed instead of returning an editable empty list', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const frame = {}
  const contents = { mainFrame: frame, getURL: () => 'http://127.0.0.1:5173/' }
  registerBrowserIpc({ handle(channel, handler) { handlers.set(channel, handler) } }, {
    enabled: () => true,
    contents: () => contents as never,
    rendererOrigin: () => 'http://127.0.0.1:5173',
    policy: () => ({ snapshot: () => { throw new Error('browser_policy_io_unavailable') }, set: () => { throw new Error('browser_policy_io_unavailable') }, remove: () => { throw new Error('browser_policy_io_unavailable') }, setAgentBrowserUse: () => { throw new Error('browser_policy_io_unavailable') } }),
    host: () => null
  })
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent
  assert.deepEqual(await handlers.get(BROWSER_POLICY_CHANNEL)!(event, { kind: 'read' }), { ok: false, error: 'browser_policy_io_unavailable' })
  assert.deepEqual(await handlers.get(BROWSER_POLICY_CHANNEL)!(event, { kind: 'set', origin: 'https://example.org', action: 'read', decision: 'allow' }), { ok: false, error: 'browser_policy_io_unavailable' })
})
