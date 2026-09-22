/** Narrow device skill operations shared by preload and main. No arbitrary URLs. */
export const SKILLS_CHANNEL = 'scholarseed:device-skills'
export const SKILL_CATALOG_CHANGED_EVENT = 'scholarseed:skill-catalog-changed'
export const SKILLS_PATH = '/api/capabilities/skills'
export const SKILL_SURFACE_CONVERSATION = 'conversation'
export const SKILL_SURFACE_SETTINGS = 'settings'
export type SkillSurface = typeof SKILL_SURFACE_CONVERSATION | typeof SKILL_SURFACE_SETTINGS
export type DeviceSkillRequest =
  | { operation: 'list'; surface?: SkillSurface }
  | { operation: 'document' | 'delete'; name: string }
  | { operation: 'toggle'; name: string; enabled: boolean }
  | { operation: 'upload'; filename: string; bytes: Uint8Array; overwrite: boolean }
export interface DeviceSkillResponse { status: number; body: string }

export function skillRequest(request: DeviceSkillRequest): { path: string; init: RequestInit } {
  switch (request.operation) {
    case 'list': return {
      path: request.surface ? `${SKILLS_PATH}?surface=${encodeURIComponent(request.surface)}` : SKILLS_PATH,
      init: { method: 'GET' }
    }
    case 'document': return { path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}/document`, init: { method: 'GET' } }
    case 'delete': return { path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}`, init: { method: 'DELETE' } }
    case 'toggle': return { path: `${SKILLS_PATH}/${encodeURIComponent(request.name)}/activate`, init: { method: request.enabled ? 'POST' : 'DELETE' } }
    case 'upload': {
      const body = new FormData()
      body.append('file', new Blob([new Uint8Array(request.bytes)]), request.filename)
      body.append('overwrite', String(request.overwrite))
      return { path: `${SKILLS_PATH}/upload`, init: { method: 'POST', body } }
    }
    default: throw new Error('Unsupported device skill operation')
  }
}
