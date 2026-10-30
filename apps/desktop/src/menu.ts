import { parseFindQuery, parsePageTarget } from './browser.ts'
import type { BrowserPageTarget, FindQuery, FindState } from './browser.ts'

export const MENU_CHANNEL = { findState: 'scholarseed:menu-find-state', refocus: 'scholarseed:menu-refocus', seed: 'scholarseed:menu-seed', publish: 'scholarseed:menu-publish', dismiss: 'scholarseed:menu-dismiss',
  model: 'scholarseed:menu-model', event: 'scholarseed:menu-event', paintReady: 'scholarseed:menu-paint-ready', revoked: 'scholarseed:menu-revoked', result: 'scholarseed:menu-result', presentation: 'scholarseed:menu-presentation' } as const
export const MENU_ACTION = { find: 'browser.find', print: 'browser.print', zoom: 'browser.zoom', devtools: 'browser.devtools', browserHistory: 'browser.history', browserSettings: 'browser.settings', language: 'account.language', login: 'account.login', logout: 'account.logout',
  settings: 'account.settings', feedback: 'account.feedback', guide: 'account.guide', credits: 'account.credits', profile: 'account.profile', creditsMore: 'account.credits-more' } as const
export const MENU_ACCOUNT_ACTIONS = [MENU_ACTION.login, MENU_ACTION.logout, MENU_ACTION.settings, MENU_ACTION.feedback, MENU_ACTION.guide, MENU_ACTION.credits, MENU_ACTION.profile, MENU_ACTION.creditsMore, MENU_ACTION.language] as const
export type AccountMenuAction = typeof MENU_ACCOUNT_ACTIONS[number]
export interface AccountMenuView {
  alias: string | null
  avatar: string
  credits: { phase: 'loading' | 'ready' | 'error'; value: number | null; unlimited: boolean }
  availableActions: AccountMenuAction[]
  logoutBusy: boolean
  logoutError: string | null
  locale: 'en' | 'zh-CN'
}
export type MenuPresentationReply = { ok: true; revision: number; presentation: 'inline' | 'native' } | { ok: false; revision: number; error: typeof MENU_ERROR[keyof typeof MENU_ERROR] }
export const MENU_LIMIT = { id: 128, text: 4096, items: 100, depth: 4, bytes: 128_000, coordinate: 100_000, requests: 1000, paintTimeout: 10_000, resultLeaseTimeout: 10_000 } as const
export const MENU_ERROR = { invalid: 'invalid_menu', sender: 'invalid_sender', revoked: 'menu_revoked', failed: 'menu_failed', unavailable: 'desktop_bridge_unavailable' } as const
export const MENU_DISMISS_REASONS = ['outside', 'escape', 'blur', 'minimize', 'hide', 'resize', 'navigation', 'target', 'crash', 'invalid', 'replaced', 'action', 'dispose', 'timeout'] as const
export type MenuDismissReason = typeof MENU_DISMISS_REASONS[number]
export type MenuSurface = 'browser-menu' | 'account-menu' | 'browser-find'
export type MenuTarget = ({ kind: 'browser' } & BrowserPageTarget) | { kind: 'browser-empty' } | { kind: 'account'; identityRevision: number }
export type MenuValue = { kind: 'none' } | { kind: 'boolean'; value: boolean } | { kind: 'number'; value: number } | { kind: 'choice'; value: string }
export type MenuItem = { kind: 'action'; id: string; actionId: string; label: string; disabled: boolean; checked: boolean; value: MenuValue }
  | { kind: 'separator'; id: string } | { kind: 'submenu'; id: string; label: string; items: MenuItem[] }
  | { kind: 'zoom'; id: string; label: string; percentage: number; items: MenuItem[] }
export interface MenuAck { sessionId: string; revision: number }
export type MenuActionResult = MenuAck & { requestId: string; actionId: string; outcome: 'succeeded' | 'failed' | 'revoked' }
export interface MenuModel extends MenuAck {
  surface: MenuSurface
  anchor: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  theme: 'light' | 'dark'
  language: 'en' | 'zh-CN'
  target: MenuTarget
  items: MenuItem[]
  account?: AccountMenuView
  find?: { origin: 'page' | 'menu' }
}
export type MenuEvent = MenuAck & ({ kind: 'action'; requestId: string; actionId: string; value: MenuValue } | { kind: 'dismiss'; reason: MenuDismissReason } | ({ kind: 'find'; requestId: string } & FindQuery))
export type MenuReply = { ok: true; ack: MenuAck } | { ok: false; error: typeof MENU_ERROR[keyof typeof MENU_ERROR] }
export type MenuSeedRequest = { surface: 'browser-menu'; tabId: string | null } | { surface: 'account-menu'; identityRevision: number }
  | { surface: 'browser-find'; target: BrowserPageTarget }
export interface MenuSeed extends MenuAck { target: MenuTarget }
export type MenuSeedReply = { ok: true; seed: MenuSeed } | Extract<MenuReply, { ok: false }>
export interface MenuBridge {
  refocus?(ack: MenuAck): Promise<MenuReply>
  presentation(): Promise<MenuPresentationReply>
  subscribePresentation(callback: (reply: MenuPresentationReply) => void): () => void
  seed(request: MenuSeedRequest): Promise<MenuSeedReply>
  publish(model: MenuModel): Promise<MenuReply>
  dismiss(reason: MenuDismissReason): Promise<void>
  subscribe(callback: (event: MenuEvent) => void): () => void
  subscribeRevoked(callback: (event: MenuAck & { reason: MenuDismissReason }) => void): () => void
  subscribeResult(callback: (result: MenuActionResult) => void): () => void
}
export interface MenuViewBridge {
  subscribeFind?(callback: (state: MenuAck & FindState) => void): () => void
  subscribeRefocus?(callback: (ack: MenuAck) => void): () => void
  seed(): Promise<MenuModel | null>
  subscribe(callback: (model: MenuModel) => void): () => void
  send(event: MenuEvent): Promise<MenuReply>
  paintReady(ack: MenuAck): Promise<MenuReply>
}
function invalid(): never { throw new Error(MENU_ERROR.invalid) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !(name in value))) invalid()
}
function text(value: unknown, limit: number = MENU_LIMIT.id): string {
  if (typeof value !== 'string' || !value.length || value.length > limit) return invalid()
  return value
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid()
  return value
}
export function parseAccountMenuView(value: unknown): AccountMenuView {
  const input = object(value)
  keys(input, ['alias', 'avatar', 'credits', 'availableActions', 'logoutBusy', 'logoutError', 'locale'])
  const alias = input.alias === null ? null : text(input.alias, MENU_LIMIT.text)
  const avatar = input.avatar === '' ? '' : text(input.avatar, MENU_LIMIT.id)
  if ([alias, avatar].some(value => value !== null && (/\d{8,}/.test(value) || /\S+@\S+/.test(value)))) invalid()
  const credits = object(input.credits)
  keys(credits, ['phase', 'value', 'unlimited'])
  if (!['loading', 'ready', 'error'].includes(credits.phase as string) || typeof credits.unlimited !== 'boolean'
    || credits.value !== null && (typeof credits.value !== 'number' || !Number.isFinite(credits.value) || credits.value < 0)
    || credits.phase !== 'ready' && (credits.value !== null || credits.unlimited)) invalid()
  if (!Array.isArray(input.availableActions) || new Set(input.availableActions).size !== input.availableActions.length
    || input.availableActions.some(action => !MENU_ACCOUNT_ACTIONS.includes(action as AccountMenuAction))
    || typeof input.logoutBusy !== 'boolean' || !['en', 'zh-CN'].includes(input.locale as string)) invalid()
  return { alias, avatar, credits: { phase: credits.phase as AccountMenuView['credits']['phase'], value: credits.value as number | null, unlimited: credits.unlimited },
    availableActions: [...input.availableActions] as AccountMenuAction[], logoutBusy: input.logoutBusy,
    logoutError: input.logoutError === null ? null : text(input.logoutError, MENU_LIMIT.text), locale: input.locale as AccountMenuView['locale'] }
}
function coordinate(value: unknown, positiveOnly = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MENU_LIMIT.coordinate || positiveOnly && value === 0) return invalid()
  return value
}
export function parseMenuAck(value: unknown): MenuAck {
  const input = object(value)
  keys(input, ['sessionId', 'revision'])
  return { sessionId: text(input.sessionId), revision: positive(input.revision) }
}
export function parseMenuTarget(value: unknown): MenuTarget {
  const input = object(value)
  if (input.kind === 'browser-empty') { keys(input, ['kind']); return { kind: 'browser-empty' } }
  if (input.kind === 'browser') {
    keys(input, ['kind', 'tabId', 'instanceId', 'navigationId'])
    return { kind: 'browser', tabId: text(input.tabId), instanceId: text(input.instanceId), navigationId: positive(input.navigationId) }
  }
  if (input.kind === 'account') {
    keys(input, ['kind', 'identityRevision'])
    return { kind: 'account', identityRevision: positive(input.identityRevision) }
  }
  return invalid()
}
export function parseMenuSeedRequest(value: unknown): MenuSeedRequest {
  const input = object(value)
  if (input.surface === 'browser-find') { keys(input, ['surface', 'target']); return { surface: input.surface, target: parsePageTarget(input.target) } }
  if (input.surface === 'browser-menu') { keys(input, ['surface', 'tabId']); return { surface: input.surface, tabId: input.tabId === null ? null : text(input.tabId) } }
  if (input.surface === 'account-menu') { keys(input, ['surface', 'identityRevision']); return { surface: input.surface, identityRevision: positive(input.identityRevision) } }
  return invalid()
}
export function parseMenuValue(value: unknown): MenuValue {
  const input = object(value)
  if (input.kind === 'none') { keys(input, ['kind']); return { kind: 'none' } }
  keys(input, ['kind', 'value'])
  if (input.kind === 'boolean' && typeof input.value === 'boolean') return { kind: 'boolean', value: input.value }
  if (input.kind === 'number' && typeof input.value === 'number' && Number.isFinite(input.value) && Math.abs(input.value) <= MENU_LIMIT.coordinate) return { kind: 'number', value: input.value }
  if (input.kind === 'choice') return { kind: 'choice', value: text(input.value) }
  return invalid()
}
export function parseMenuReason(value: unknown): MenuDismissReason {
  if (!MENU_DISMISS_REASONS.includes(value as MenuDismissReason)) return invalid()
  return value as MenuDismissReason
}
export function parseMenuEvent(value: unknown): MenuEvent {
  const input = object(value)
  const ack = { sessionId: text(input.sessionId), revision: positive(input.revision) }
  if (input.kind === 'find') {
    keys(input, ['kind', 'sessionId', 'revision', 'requestId', 'querySequence', 'text', 'direction'])
    return { ...ack, kind: 'find', requestId: text(input.requestId), ...parseFindQuery({ text: input.text, direction: input.direction, querySequence: input.querySequence }) }
  }
  if (input.kind === 'dismiss') {
    keys(input, ['kind', 'sessionId', 'revision', 'reason'])
    return { ...ack, kind: 'dismiss', reason: parseMenuReason(input.reason) }
  }
  if (input.kind === 'action') {
    keys(input, ['kind', 'sessionId', 'revision', 'requestId', 'actionId', 'value'])
    return { ...ack, kind: 'action', requestId: text(input.requestId), actionId: text(input.actionId), value: parseMenuValue(input.value) }
  }
  return invalid()
}
export function parseMenuModel(value: unknown): MenuModel {
  const input = object(value)
  keys(input, ['sessionId', 'revision', 'surface', 'anchor', 'viewport', 'theme', 'language', 'target', 'items', ...(input.surface === 'account-menu' ? ['account'] : input.surface === 'browser-find' ? ['find'] : [])])
  const anchor = object(input.anchor)
  keys(anchor, ['x', 'y', 'width', 'height'])
  const viewport = object(input.viewport)
  keys(viewport, ['width', 'height'])
  const target = parseMenuTarget(input.target)
  if (!(input.surface === (target.kind === 'account' ? 'account-menu' : 'browser-menu') || input.surface === 'browser-find' && target.kind === 'browser')
    || !['light', 'dark'].includes(input.theme as string) || !['en', 'zh-CN'].includes(input.language as string)) invalid()
  const ids = new Set<string>()
  const parseItems = (value: unknown, depth: number): MenuItem[] => {
    if (!Array.isArray(value) || depth > MENU_LIMIT.depth) return invalid()
    return value.map(value => {
      const item = object(value)
      const id = text(item.id)
      if (ids.has(id) || ids.size >= MENU_LIMIT.items) invalid()
      ids.add(id)
      if (item.kind === 'separator') { keys(item, ['kind', 'id']); return { kind: 'separator', id } }
      if (item.kind === 'zoom') {
        keys(item, ['kind', 'id', 'label', 'percentage', 'items'])
        if (typeof item.percentage !== 'number' || !Number.isFinite(item.percentage) || item.percentage <= 0 || item.percentage > MENU_LIMIT.coordinate) return invalid()
        const actions = parseItems(item.items, depth + 1)
        if (actions.some(action => action.kind !== 'action' || action.actionId !== MENU_ACTION.zoom) || actions.length !== 3) return invalid()
        return { kind: 'zoom', id, label: text(item.label), percentage: item.percentage, items: actions }
      }
      if (item.kind === 'submenu') {
        keys(item, ['kind', 'id', 'label', 'items'])
        return { kind: 'submenu', id, label: text(item.label, MENU_LIMIT.text), items: parseItems(item.items, depth + 1) }
      }
      keys(item, ['kind', 'id', 'actionId', 'label', 'disabled', 'checked', 'value'])
      if (item.kind !== 'action' || typeof item.disabled !== 'boolean' || typeof item.checked !== 'boolean') return invalid()
      return { kind: 'action', id, actionId: text(item.actionId), label: text(item.label, MENU_LIMIT.text), disabled: item.disabled, checked: item.checked, value: parseMenuValue(item.value) }
    })
  }
  const model: MenuModel = { sessionId: text(input.sessionId), revision: positive(input.revision), surface: input.surface as MenuSurface,
    anchor: { x: coordinate(anchor.x), y: coordinate(anchor.y), width: coordinate(anchor.width, true), height: coordinate(anchor.height, true) },
    viewport: { width: coordinate(viewport.width, true), height: coordinate(viewport.height, true) }, theme: input.theme as MenuModel['theme'],
    language: input.language as MenuModel['language'], target, items: parseItems(input.items, 1),
    ...(input.surface === 'account-menu' ? { account: parseAccountMenuView(input.account) } : {}) }
  if (input.surface === 'browser-find') {
    const find = object(input.find)
    keys(find, ['origin'])
    if (!['page', 'menu'].includes(String(find.origin)) || model.items.length) invalid()
    model.find = { origin: find.origin as 'page' | 'menu' }
  }
  if (model.account && (model.account.locale !== model.language || menuActions(model.items).some(item => !MENU_ACCOUNT_ACTIONS.includes(item.actionId as AccountMenuAction) || !item.disabled && !model.account!.availableActions.includes(item.actionId as AccountMenuAction)
    || item.actionId === MENU_ACTION.logout && model.account!.logoutBusy && !item.disabled))) invalid()
  if (model.anchor.x + model.anchor.width > model.viewport.width || model.anchor.y + model.anchor.height > model.viewport.height
    || new TextEncoder().encode(JSON.stringify(model)).byteLength > MENU_LIMIT.bytes) invalid()
  return model
}
export function menuActions(items: MenuItem[]): Extract<MenuItem, { kind: 'action' }>[] {
  return items.flatMap(item => item.kind === 'action' ? [item] : item.kind === 'submenu' || item.kind === 'zoom' ? menuActions(item.items) : [])
}
export function sameMenuTarget(left: MenuTarget, right: MenuTarget): boolean {
  if (left.kind === 'browser-empty' || right.kind === 'browser-empty') return left.kind === right.kind
  return left.kind === 'browser' && right.kind === 'browser'
    ? left.tabId === right.tabId && left.instanceId === right.instanceId && left.navigationId === right.navigationId
    : left.kind === 'account' && right.kind === 'account' && left.identityRevision === right.identityRevision
}
