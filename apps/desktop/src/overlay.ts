import { BROWSER_ERROR } from './browser.ts'

export const OVERLAY_CHANNEL = {
  publish: 'scholarseed:overlay-publish', dismiss: 'scholarseed:overlay-dismiss',
  dismissSync: 'scholarseed:overlay-dismiss-sync',
  focus: 'scholarseed:overlay-focus', model: 'scholarseed:overlay-model',
  focusRequest: 'scholarseed:overlay-focus-request',
  event: 'scholarseed:overlay-event', ready: 'scholarseed:overlay-ready', seed: 'scholarseed:overlay-seed'
} as const
export const TOOLTIP_OVERLAY_ARGUMENT = '--scholarseed-tooltip-overlay'
export const TOOLTIP_OVERLAY_CHANNEL = Object.fromEntries(Object.entries(OVERLAY_CHANNEL).map(([key, channel]) => [key, channel.replace('overlay-', 'tooltip-overlay-')])) as { [Key in keyof typeof OVERLAY_CHANNEL]: string }
export const OVERLAY_LIMIT = { items: 100, text: 4096, id: 128, coordinate: 100_000, bytes: 128_000 } as const
export interface OverlayBounds { x: number; y: number; width: number; height: number }
export interface BrowserOverlayModel {
  tooltip?: string
  tooltipBounds?: OverlayBounds
  revision: number
  bounds: OverlayBounds
  theme: 'light' | 'dark'
  language: 'en' | 'zh-CN'
  status: 'loading' | 'ready' | 'empty' | 'error'
  items: { id: string; title: string; detail: string }[]
}
export type BrowserOverlayEvent = { revision: number } & (
  { kind: 'select'; itemId: string } | { kind: 'dismiss' } | { kind: 'focus-return'; target: 'address' | 'next' }
)
export type OverlayReply = { ok: true } | { ok: false; error: string }
export interface BrowserOverlayBridge {
  seed(): Promise<number>
  publish(model: BrowserOverlayModel): Promise<OverlayReply>
  dismiss(): Promise<OverlayReply>
  dismissSync(): void
  focus(): Promise<OverlayReply>
  subscribe(callback: (event: BrowserOverlayEvent) => void): () => void
}
export interface SuggestionsBridge {
  subscribeFocus(callback: (revision: number) => void): () => void
  subscribe(callback: (model: BrowserOverlayModel) => void): () => void
  send(event: BrowserOverlayEvent): Promise<OverlayReply>
}
const THEMES = new Set(['light', 'dark'])
const LANGUAGES = new Set(['en', 'zh-CN'])
const STATUSES = new Set(['loading', 'ready', 'empty', 'error'])
const TARGETS = new Set(['address', 'next'])
function invalid(): never { throw new Error(BROWSER_ERROR.invalidCommand) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !(name in value))) invalid()
}
function text(value: unknown, limit: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > limit || (nonempty && !value.length)) return invalid()
  return value
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid()
  return value
}
export function parseBrowserOverlayModel(value: unknown): BrowserOverlayModel {
  const input = object(value)
  keys(input, ['revision', 'bounds', 'theme', 'language', 'status', 'items', ...('tooltip' in input ? ['tooltip', 'tooltipBounds'] : [])])
  const bounds = object(input.bounds)
  keys(bounds, ['x', 'y', 'width', 'height'])
  for (const [name, coordinate] of Object.entries(bounds)) {
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0
      || coordinate > OVERLAY_LIMIT.coordinate || ((name === 'width' || name === 'height') && coordinate === 0)) invalid()
  }
  if (!THEMES.has(input.theme as string) || !LANGUAGES.has(input.language as string) || !STATUSES.has(input.status as string)) invalid()
  if (!Array.isArray(input.items) || input.items.length > OVERLAY_LIMIT.items) invalid()
  const ids = new Set<string>()
  const items = (input.items as unknown[]).map(value => {
    const item = object(value)
    keys(item, ['id', 'title', 'detail'])
    const id = text(item.id, OVERLAY_LIMIT.id, true)
    if (ids.has(id)) invalid()
    ids.add(id)
    return { id, title: text(item.title, OVERLAY_LIMIT.text), detail: text(item.detail, OVERLAY_LIMIT.text) }
  })
  const model = { revision: revision(input.revision), bounds: { ...bounds } as unknown as OverlayBounds,
    theme: input.theme, language: input.language, status: input.status, items } as BrowserOverlayModel
  if ('tooltip' in input) {
    if (items.length || input.status !== 'ready') invalid()
    model.tooltip = text(input.tooltip, OVERLAY_LIMIT.text, true)
  }
  if ('tooltipBounds' in input) {
    if (!model.tooltip) invalid()
    const content = object(input.tooltipBounds)
    keys(content, ['x', 'y', 'width', 'height'])
    for (const [name, coordinate] of Object.entries(content)) {
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0
        || coordinate > OVERLAY_LIMIT.coordinate || ((name === 'width' || name === 'height') && coordinate === 0)) invalid()
    }
    const tooltipBounds = content as unknown as OverlayBounds
    if (tooltipBounds.x + tooltipBounds.width > model.bounds.width || tooltipBounds.y + tooltipBounds.height > model.bounds.height) invalid()
    model.tooltipBounds = { ...tooltipBounds }
  }
  if (new TextEncoder().encode(JSON.stringify(model)).byteLength > OVERLAY_LIMIT.bytes) invalid()
  return model
}
export function parseBrowserOverlayEvent(value: unknown): BrowserOverlayEvent {
  const input = object(value)
  const current = revision(input.revision)
  if (input.kind === 'select') {
    keys(input, ['kind', 'revision', 'itemId'])
    return { kind: 'select', revision: current, itemId: text(input.itemId, OVERLAY_LIMIT.id, true) }
  }
  if (input.kind === 'dismiss') {
    keys(input, ['kind', 'revision'])
    return { kind: 'dismiss', revision: current }
  }
  if (input.kind === 'focus-return' && TARGETS.has(input.target as string)) {
    keys(input, ['kind', 'revision', 'target'])
    return { kind: 'focus-return', revision: current, target: input.target as 'address' | 'next' }
  }
  return invalid()
}
export function overlayBounds(bounds: OverlayBounds, zoom: number, size: { width: number; height: number }): OverlayBounds {
  if (!Number.isFinite(zoom) || zoom <= 0) return invalid()
  const x = Math.min(size.width, Math.round(bounds.x * zoom))
  const y = Math.min(size.height, Math.round(bounds.y * zoom))
  return { x, y, width: Math.max(0, Math.min(size.width - x, Math.ceil(bounds.width * zoom))),
    height: Math.max(0, Math.min(size.height - y, Math.ceil(bounds.height * zoom))) }
}
