
export const PREVIEW_VIEWPORT = {
  parameter: 'previewSurface',
  value: 'renderer',
  frameId: 'scholarseed-preview-viewport',
  messageType: 'scholarseed-preview-viewport',
  shortcut: 'F8',
} as const

export type PreviewViewportMessage =
  | { type: typeof PREVIEW_VIEWPORT.messageType; instance: string; action: 'open-controls' }
  | { type: typeof PREVIEW_VIEWPORT.messageType; instance: string; action: 'diagnostic'; detail: { kind: string; protocol?: string; origin?: string } }

export function previewViewportUrl(current: URL): URL {
  const target = new URL(current.href)
  target.searchParams.set(PREVIEW_VIEWPORT.parameter, PREVIEW_VIEWPORT.value)
  return target
}

export function readPreviewViewportMessage(value: unknown, instance: string): PreviewViewportMessage | null {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== PREVIEW_VIEWPORT.messageType || !('instance' in value) || value.instance !== instance || !('action' in value)) return null
  if (value.action === 'open-controls') return { type: PREVIEW_VIEWPORT.messageType, instance, action: value.action }
  if (value.action !== 'diagnostic' || !('detail' in value) || !value.detail || typeof value.detail !== 'object' || !('kind' in value.detail) || typeof value.detail.kind !== 'string') return null
  const kind = value.detail.kind
  const detail = value.detail
  return {
    type: PREVIEW_VIEWPORT.messageType,
    instance,
    action: value.action,
    detail: {
      kind,
      ...('protocol' in detail && typeof detail.protocol === 'string' ? { protocol: detail.protocol } : {}),
      ...('origin' in detail && typeof detail.origin === 'string' ? { origin: detail.origin } : {}),
    },
  }
}
