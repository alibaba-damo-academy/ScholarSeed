import { createRoot } from 'react-dom/client'
import '../../styles.css'
import { Menu } from './Menu'
import type { MenuEvent, MenuModel, MenuViewBridge } from '../../../../menu'
import type { FindState } from '../../../../browser'

const events: MenuEvent[] = []
const paints: Array<{ sessionId: string; revision: number }> = []
const initial: MenuModel = { sessionId: 'fixture', revision: 1, surface: 'browser-menu', anchor: { x: 1100, y: 40, width: 32, height: 32 },
  viewport: { width: innerWidth, height: innerHeight }, theme: 'light', language: 'en', target: { kind: 'browser', tabId: 'first', instanceId: 'instance', navigationId: 1 },
  items: [
    { kind: 'action', id: 'disabled', actionId: 'browser.devtools', label: 'Disabled page action', disabled: true, checked: false, value: { kind: 'boolean', value: true } },
    { kind: 'submenu', id: 'tools', label: 'Tools', items: [{ kind: 'action', id: 'devtools', actionId: 'browser.devtools', label: 'Developer tools', disabled: false, checked: true, value: { kind: 'boolean', value: false } }] },
    { kind: 'action', id: 'settings', actionId: 'browser.settings', label: 'Browser settings', disabled: false, checked: false, value: { kind: 'none' } }
  ] }
let listener: (model: MenuModel) => void = () => undefined
let found: (state: FindState & { sessionId: string; revision: number }) => void = () => undefined
const findScene = new URLSearchParams(location.search).has('find')
if (findScene) { initial.surface = 'browser-find'; initial.find = { origin: 'page' }; initial.items = [] }
const bridge: MenuViewBridge = {
  seed: async () => initial,
  subscribe(callback) { listener = callback; return () => { listener = () => undefined } },
  subscribeFind(callback) { found = callback; return () => { found = () => undefined } },
  send: async event => { events.push(event); return { ok: true, ack: { sessionId: event.sessionId, revision: event.revision } } },
  paintReady: async ack => { paints.push(ack); return { ok: true, ack } }
}
Object.assign(window, { presentMenu: (model: MenuModel) => listener({ ...model, sessionId: initial.sessionId }), menuEvents: events, menuPaints: paints, emitFound: (state: FindState, revision = 1) => found({ sessionId: initial.sessionId, revision, ...state }), updateMenu: (revision: number) => listener({ ...initial, revision,
  items: initial.items.map(item => item.id === 'settings' ? { ...item, label: `Browser settings ${revision}` } : item) }) })
createRoot(document.getElementById('root')!).render(<Menu bridge={bridge} />)
