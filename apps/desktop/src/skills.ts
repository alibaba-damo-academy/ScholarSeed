/** Narrow device skill operations shared by preload and main. No arbitrary URLs. */
export const SKILLS_CHANNEL = 'scholarseed:device-skills'
export const SKILL_CATALOG_CHANGED_EVENT = 'scholarseed:skill-catalog-changed'
export const SKILLS_PATH = '/api/capabilities/skills'
export const SKILL_SURFACE_CONVERSATION = 'conversation'
export const SKILL_SURFACE_SETTINGS = 'settings'
export type SkillSurface = typeof SKILL_SURFACE_CONVERSATION | typeof SKILL_SURFACE_SETTINGS
export type DeviceSkillRequest =
  | { operation: 'list'; surface?: SkillSurface; locale?: string }
  | { operation: 'document' | 'delete'; name: string }
  | { operation: 'toggle'; name: string; enabled: boolean }
  | {
      operation: 'upload' | 'upload-preview'
      filename: string
      bytes: Uint8Array
      overwrite?: boolean
    }
  | { operation: 'marketplace'; query: string; cursor: string; label?: string; locale?: string }
  | { operation: 'marketplace-labels'; locale: string }
  | { operation: 'marketplace-detail'; slug: string; version: string; locale?: string }
  | { operation: 'marketplace-install'; slug: string; version: string; enabled?: boolean }
  | { operation: 'marketplace-update'; name: string; version: string; expectedVersion: string }
export interface DeviceSkillResponse {
  status: number
  body: string
}

export function skillRequest(request: DeviceSkillRequest): { path: string; init: RequestInit } {
  switch (request.operation) {
    case 'marketplace-update':
      return {
        path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}/update`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: request.version,
            expectedVersion: request.expectedVersion,
          }),
        },
      }
    case 'marketplace-labels':
      return {
        path: `${SKILLS_PATH}/marketplace/labels?${new URLSearchParams({ locale: request.locale })}`,
        init: { method: 'GET' },
      }
    case 'marketplace':
      return {
        path: `${SKILLS_PATH}/marketplace?${new URLSearchParams({ query: request.query, cursor: request.cursor, ...(request.label ? { label: request.label } : {}), ...(request.locale ? { locale: request.locale } : {}) })}`,
        init: { method: 'GET' },
      }
    case 'marketplace-detail':
      return {
        path: `${SKILLS_PATH}/marketplace/items/${encodeURIComponent(request.slug)}?${new URLSearchParams({ version: request.version, ...(request.locale ? { locale: request.locale } : {}) })}`,
        init: { method: 'GET' },
      }
    case 'marketplace-install':
      return {
        path: `${SKILLS_PATH}/marketplace/items/${encodeURIComponent(request.slug)}/install`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: request.version,
            ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
          }),
        },
      }
    case 'list':
      return {
        path:
          request.surface || request.locale
            ? `${SKILLS_PATH}?${new URLSearchParams({ ...(request.surface ? { surface: request.surface } : {}), ...(request.locale ? { locale: request.locale } : {}) })}`
            : SKILLS_PATH,
        init: { method: 'GET' },
      }
    case 'document':
      return {
        path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}/document`,
        init: { method: 'GET' },
      }
    case 'delete':
      return {
        path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}`,
        init: { method: 'DELETE' },
      }
    case 'toggle':
      return {
        path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}/activate`,
        init: { method: request.enabled ? 'POST' : 'DELETE' },
      }
    case 'upload':
    case 'upload-preview': {
      const body = new FormData()
      body.append('file', new Blob([new Uint8Array(request.bytes)]), request.filename)
      return {
        path: `${SKILLS_PATH}/upload${request.operation === 'upload-preview' ? '/preview' : ''}`,
        init: { method: 'POST', body },
      }
    }
    default:
      throw new Error('Unsupported device skill operation')
  }
}
