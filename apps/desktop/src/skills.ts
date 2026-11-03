import type { PluginComponent, PluginReference, PluginCopyContent } from './plugins'
/** Narrow device skill operations shared by preload and main. No arbitrary URLs. */
export const SKILLS_CHANNEL = 'scholarseed:device-skills'
export const SKILL_CATALOG_CHANGED_EVENT = 'scholarseed:skill-catalog-changed'
export const SKILLS_PATH = '/api/capabilities/skills'
export const SKILL_SURFACE_CONVERSATION = 'conversation'
export const SKILL_SURFACE_SETTINGS = 'settings'
export type SkillSurface = typeof SKILL_SURFACE_CONVERSATION | typeof SKILL_SURFACE_SETTINGS
export type DeviceSkillRequest =
  | {
      operation: 'plugin-validate'
      component: PluginComponent
      action: string
      values: Record<string, unknown>
    }
  | {
      operation: 'plugin-delivery'
      session: string
      request: string
      action: 'status' | 'check' | 'skip' | 'directory'
    }
  | { operation: 'plugin-answer'; session: string; request: string; body: Record<string, unknown> }
  | { operation: 'plugin-release'; leases: string[] }
  | { operation: 'plugin-valid'; lease: string }
  | { operation: 'list'; surface?: SkillSurface; locale?: string }
  | { operation: 'document' | 'delete'; name: string }
  | { operation: 'toggle'; name: string; enabled: boolean }
  | {
      operation: 'upload' | 'upload-preview'
      filename: string
      bytes: Uint8Array
      overwrite?: boolean
    }
  | { operation: 'plugin-check'; filename: string; bytes: Uint8Array }
  | { operation: 'plugin-preview'; candidate: string; sha256: string }
  | {
      operation: 'plugin-confirm'
      candidate: string
      sha256: string
      grants: string[]
      confirmed: true
      enable?: boolean
      update?: boolean
    }
  | { operation: 'plugin-open'; reference: PluginReference }
  | {
      operation: 'plugin-copy'
      reference: PluginReference
      session_id: string
      content?: PluginCopyContent
      expected_revision?: number
    }
  | {
      operation: 'plugin-draft'
      reference: PluginReference
      session_id: string
      values: Record<string, unknown>
      expected_revision: number
    }
  | {
      operation: 'plugin-call'
      reference: PluginReference
      action: string
      values: Record<string, unknown>
    }
  | { operation: 'plugin-preview-installed'; name: string }
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
    case 'plugin-validate':
      return {
        path: `${SKILLS_PATH}/plugins/validate`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      }
    case 'plugin-delivery':
      return {
        path: `${SKILLS_PATH}/plugins/delivery`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      }
    case 'plugin-answer':
      return {
        path: `/api/serve/sessions/${encodeURIComponent(request.session)}/hil/${encodeURIComponent(request.request)}`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        },
      }
    case 'plugin-valid':
    case 'plugin-release':
      throw new Error('Component lifecycle is owned by the desktop host')
    case 'plugin-open':
      return {
        path: `${SKILLS_PATH}/plugins/binding`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference: request.reference }),
        },
      }
    case 'plugin-call':
      return {
        path: `${SKILLS_PATH}/plugins/action`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference: request.reference,
            action: request.action,
            values: request.values,
          }),
        },
      }
    case 'plugin-copy':
      return {
        path: `${SKILLS_PATH}/plugins/copy`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      }
    case 'plugin-draft':
      return {
        path: `${SKILLS_PATH}/plugins/draft`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference: request.reference,
            session_id: request.session_id,
            values: request.values,
            expected_revision: request.expected_revision,
          }),
        },
      }
    case 'plugin-preview-installed':
      return {
        path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}/plugin`,
        init: { method: 'GET' },
      }
    case 'plugin-preview':
    case 'plugin-confirm':
      return {
        path: `${SKILLS_PATH}/plugins/${request.operation === 'plugin-preview' ? 'preview' : 'confirm'}`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      }
    case 'plugin-check': {
      const body = new FormData()
      body.append('file', new Blob([new Uint8Array(request.bytes)]), request.filename)
      return { path: `${SKILLS_PATH}/plugins/check`, init: { method: 'POST', body } }
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
