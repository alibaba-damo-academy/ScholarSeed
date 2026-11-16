export const PORTAL_URL = 'about:blank'
export const PORTAL_TIMEOUT = 10_000
export const RESIZE_PORTAL_CAPACITY = 2
export const PORTAL_LAYERS = [
  'control',
  'panel',
  'popup',
  'foreground',
  'modal',
  'blocking',
] as const
export const UPDATE_PORTAL: PortalSurface = {
  name: 'scholarseed-update-',
  modal: true,
  layer: 'blocking',
  channels: {
    reserve: 'scholarseed:update-reserve',
    paint: 'scholarseed:update-paint',
    close: 'scholarseed:update-close',
    revoked: 'scholarseed:update-revoked',
  },
}

export interface PortalBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface PortalSurface {
  name: string
  modal: boolean
  layer: (typeof PORTAL_LAYERS)[number]
  channels: {
    reserve: string
    paint: string
    close: string
    revoked: string
    place?: string
  }
}
export type PortalReply = { ok: true } | { ok: false }
export interface PortalBridge {
  reserve(): Promise<{ ok: true; sessionId: string } | { ok: false }>
  paint(sessionId: string): Promise<PortalReply>
  close(sessionId: string): Promise<PortalReply>
  subscribeRevoked(callback: (sessionId: string) => void): () => void
}
export interface FloatingPortalBridge extends PortalBridge {
  place(sessionId: string, bounds: PortalBounds | null): Promise<PortalReply>
}
export interface ResizePortalBridge extends FloatingPortalBridge {
  maxInstances: number
}
export const CONVERSATION_PORTAL: PortalSurface & { channels: { place: string } } = {
  name: 'scholarseed-conversation-',
  modal: false,
  layer: 'panel',
  channels: {
    reserve: 'scholarseed:conversation-reserve',
    paint: 'scholarseed:conversation-paint',
    close: 'scholarseed:conversation-close',
    revoked: 'scholarseed:conversation-revoked',
    place: 'scholarseed:conversation-place',
  },
}
export const FOREGROUND_PORTAL: PortalSurface & { channels: { place: string } } = {
  name: 'scholarseed-foreground-',
  modal: false,
  layer: 'foreground',
  channels: {
    reserve: 'scholarseed:foreground-reserve',
    paint: 'scholarseed:foreground-paint',
    close: 'scholarseed:foreground-close',
    revoked: 'scholarseed:foreground-revoked',
    place: 'scholarseed:foreground-place',
  },
}
export const RESIZE_PORTAL: PortalSurface & { channels: { place: string } } = {
  name: 'scholarseed-resize-',
  modal: false,
  layer: 'control',
  channels: {
    reserve: 'scholarseed:resize-reserve',
    paint: 'scholarseed:resize-paint',
    close: 'scholarseed:resize-close',
    revoked: 'scholarseed:resize-revoked',
    place: 'scholarseed:resize-place',
  },
}

export function parsePortalBounds(value: unknown): PortalBounds | null {
  if (!value || typeof value !== 'object') return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return null
  const keys = ['x', 'y', 'width', 'height'] as const
  if (Reflect.ownKeys(value).length !== keys.length) return null
  const parsed = {} as PortalBounds
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'number' ||
      !Number.isFinite(descriptor.value) ||
      descriptor.value < 0
    )
      return null
    parsed[key] = descriptor.value
  }
  return parsed.width > 0 && parsed.height > 0 ? parsed : null
}
