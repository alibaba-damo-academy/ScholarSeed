import type { ConversationLayout } from '../../../packages/ui/document'

export const PLUGIN_SCHEME = 'scholarseed-plugin'
export const PLUGIN_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: false,
  corsEnabled: true,
} as const
export const PLUGIN_MESSAGE_CHANNEL = 'scholarseed:component'
export const PLUGIN_REVOKED_CHANNEL = 'scholarseed:component-revoked'
export const PLUGIN_NAVIGATION_CHANNEL = 'scholarseed:plugin-navigation'
export const PLUGIN_GESTURE_SECRET_BYTES = 32
export const PLUGIN_GESTURE_TTL_MS = 1000
export const PLUGIN_MAX_PLOT_BYTES = 4 * 1024 * 1024
export const PLUGIN_FRAME_HEIGHT = 320
export const PLUGIN_FRAME_START_TIMEOUT_MS = 15000
export const PLUGIN_FRAME_PHASES = {
  document: 'document',
  ready: 'ready',
  resource: 'resource',
  script: 'script',
} as const
export const PLUGIN_MAX_FRAME_HEIGHT = 1600
export const PLUGIN_REQUEST_TIMEOUT_MS = 60000
export const PLUGIN_MAX_PENDING_REQUESTS = 32
export const PLUGIN_MAX_REQUESTS = 4096
export const PLUGIN_MAX_FRAMES = 64
export const PLUGIN_UI_RESOURCE_PREFIX = '__ui__/'
export const PLUGIN_ANSWER_CAPABILITY = 'interaction.answer'
export const PUBLIC_COMPONENT_PLUGIN = 'host'
export const PUBLIC_QUESTION_SLOT = 'interaction.question'
export const PUBLIC_COMPONENT_FINGERPRINT = 'host-v3-results'
const LEGACY_PUBLIC_COMPONENT_FINGERPRINT = 'host-v3'
export function isPublicComponentFingerprint(fingerprint: string): boolean {
  return (
    fingerprint === PUBLIC_COMPONENT_FINGERPRINT ||
    fingerprint === LEGACY_PUBLIC_COMPONENT_FINGERPRINT
  )
}
export const RETIRED_PUBLIC_COMPONENT_FINGERPRINT = 'host-v1'
export const PUBLIC_COMPONENT_PENDING = 'pending'
export const PLUGIN_DISPLAY_TYPE = 'plugin-component'
export const PLUGIN_RPC_ERRORS = {
  draftUnavailable: 'plugin_draft_unavailable',
  draftFailed: 'plugin_draft_failed',
  copyUnavailable: 'plugin_copy_unavailable',
  copyFailed: 'plugin_copy_failed',
  copyGestureRequired: 'plugin_copy_gesture_required',
  requestLimit: 'plugin_request_limit',
  capabilityUndeclared: 'plugin_capability_undeclared',
  requestFailed: 'plugin_request_failed',
  validationUnavailable: 'component_validation_unavailable',
  plotGestureRequired: 'plot_export_gesture_required',
  plotSaveFailed: 'plot_export_save_failed',
  readOnly: 'plugin_card_read_only',
  plotFailed: 'plot_export_failed',
} as const
export interface PluginComponent {
  id: string
  slot?: string | null
  entry?: string
  openui?: ConversationLayout
  public?: boolean
  workbench?: boolean
  preview: string
  actions: { id: string; capability: string; input_schema?: Record<string, unknown> }[]
  input_schema?: Record<string, unknown>
  output_schema?: Record<string, unknown>
}
export interface PluginRequest {
  requestId: string
  action: string
  values: Record<string, unknown>
}
export interface PluginCopyContent {
  text: string
  markdown?: string
}
export function componentPlotExport(
  value: unknown,
  lease: string
): { requestId: string; revision: number; plot: unknown; copy?: true } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  const copy = 'copyPlot' in message
  const plot = copy ? message.copyPlot : message.exportPlot
  if (
    Object.keys(message).some(
      (key) =>
        !['channel', 'lease', 'requestId', 'revision', copy ? 'copyPlot' : 'exportPlot'].includes(
          key
        )
    ) ||
    message.channel !== PLUGIN_MESSAGE_CHANNEL ||
    message.lease !== lease ||
    typeof message.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId) ||
    !Number.isSafeInteger(message.revision) ||
    Number(message.revision) < 0 ||
    !plot ||
    typeof plot !== 'object' ||
    Array.isArray(plot)
  )
    return null
  try {
    if (new TextEncoder().encode(JSON.stringify(message)).length > PLUGIN_MAX_PLOT_BYTES)
      return null
  } catch {
    return null
  }
  return {
    requestId: message.requestId,
    revision: Number(message.revision),
    plot,
    ...(copy ? { copy: true } : {}),
  }
}
export function createComponentGesture(now: () => number = () => Date.now()): {
  receive: (value: unknown, lease: string, revision: number) => boolean
  consume: (revision: number) => boolean
} {
  let secret: string | undefined
  let sequence = 0
  let grant: { expires: number; revision: number } | undefined
  return {
    receive(value, lease, revision) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const message = value as Record<string, unknown>
      if (message.channel !== PLUGIN_MESSAGE_CHANNEL || message.lease !== lease) return false
      if (message.gesture === 'init') {
        if (
          secret ||
          Object.keys(message).some(
            (key) => !['channel', 'lease', 'gesture', 'secret'].includes(key)
          ) ||
          typeof message.secret !== 'string' ||
          !new RegExp(`^[a-f0-9]{${PLUGIN_GESTURE_SECRET_BYTES * 2}}$`).test(message.secret)
        )
          return false
        secret = message.secret
        return true
      }
      if (
        message.gesture !== 'proof' ||
        !secret ||
        message.secret !== secret ||
        Object.keys(message).some(
          (key) => !['channel', 'lease', 'gesture', 'secret', 'sequence', 'issued'].includes(key)
        ) ||
        !Number.isSafeInteger(message.sequence) ||
        Number(message.sequence) <= sequence ||
        !Number.isSafeInteger(message.issued) ||
        Number(message.issued) > now() ||
        Number(message.issued) + PLUGIN_GESTURE_TTL_MS < now()
      )
        return false
      sequence = Number(message.sequence)
      grant = { expires: Number(message.issued) + PLUGIN_GESTURE_TTL_MS, revision }
      return true
    },
    consume(revision) {
      const current = grant
      grant = undefined
      return Boolean(current && current.revision === revision && current.expires >= now())
    },
  }
}
export function componentCopyText(
  value: unknown,
  lease: string
): { requestId: string; revision: number; text: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { copyText, ...message } = value as Record<string, unknown>
  if (typeof copyText !== 'string' || 'copy' in message) return null
  const copy = componentCopy({ ...message, copy: { text: copyText } }, lease)
  return copy ? { requestId: copy.requestId, revision: copy.revision, text: copyText } : null
}

export function componentRPC(value: unknown, lease: string): PluginRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { requestId, ...message } = value as Record<string, unknown>
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) return null
  if (typeof message.action !== 'string') return null
  const action = componentActionValue(message, lease)
  return action ? { requestId, ...action } : null
}
export function componentCopy(
  value: unknown,
  lease: string
): { requestId: string; revision: number; content: PluginCopyContent } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (
    Object.keys(message).some(
      (key) => !['channel', 'lease', 'requestId', 'revision', 'copy'].includes(key)
    ) ||
    message.channel !== PLUGIN_MESSAGE_CHANNEL ||
    message.lease !== lease ||
    typeof message.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId) ||
    typeof message.revision !== 'number' ||
    !Number.isSafeInteger(message.revision) ||
    message.revision < 0 ||
    !message.copy ||
    typeof message.copy !== 'object' ||
    Array.isArray(message.copy)
  )
    return null
  const content = message.copy as Record<string, unknown>
  if (
    Object.keys(content).some((key) => !['text', 'markdown'].includes(key)) ||
    typeof content.text !== 'string' ||
    !content.text.trim() ||
    (content.markdown !== undefined && typeof content.markdown !== 'string')
  )
    return null
  try {
    JSON.stringify(message)
  } catch {
    return null
  }
  return {
    requestId: message.requestId,
    revision: message.revision,
    content: content as unknown as PluginCopyContent,
  }
}
export type PluginRequestHandler = (
  action: string,
  values: Record<string, unknown>,
  capability: string,
  authorize: () => Promise<void>
) => Promise<unknown>

export function pluginErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { code?: unknown; failure?: { code?: unknown } }
  const code = candidate.failure?.code ?? candidate.code
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(code) ? code : undefined
}

export function componentRequest(
  value: unknown,
  lease: string,
  component: PluginComponent
): PluginRequest | null {
  const request = componentRPC(value, lease)
  return request && component.actions.some((action) => action.id === request.action)
    ? request
    : null
}

export function componentDraft(
  value: unknown,
  lease: string
): { requestId: string; values: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (
    Object.keys(message).some((key) => !['channel', 'lease', 'requestId', 'draft'].includes(key)) ||
    message.channel !== PLUGIN_MESSAGE_CHANNEL ||
    message.lease !== lease ||
    typeof message.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId) ||
    !message.draft ||
    typeof message.draft !== 'object' ||
    Array.isArray(message.draft)
  )
    return null
  try {
    JSON.stringify(message)
  } catch {
    return null
  }
  return { requestId: message.requestId, values: message.draft as Record<string, unknown> }
}

export function componentHeight(value: unknown, lease: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (
    Object.keys(message).some((key) => !['channel', 'lease', 'height'].includes(key)) ||
    message.channel !== PLUGIN_MESSAGE_CHANNEL ||
    message.lease !== lease ||
    typeof message.height !== 'number' ||
    !Number.isFinite(message.height) ||
    message.height <= 0
  )
    return null
  return Math.min(Math.ceil(message.height), PLUGIN_MAX_FRAME_HEIGHT)
}
export interface PluginDescriptor {
  id: string
  version: string
  capabilities: string[]
  components: PluginComponent[]
}
export interface PluginInstallationReceipt {
  name: string
  version: string
  enabled: boolean
  sha256: string
}
export interface PluginReport {
  kind?: 'ui'
  valid: boolean
  update?: boolean
  candidate?: string
  sha256: string
  descriptor: PluginDescriptor | null
  issues: { code: string; path: string; message: string; severity: string }[]
  dependencies: Record<string, unknown>
}
export interface PreviewResponse {
  state: 'resolved' | 'failed' | 'cancelled'
  data: Record<string, unknown>
  set?: Record<string, unknown>
  append?: Record<string, unknown>
}
export interface PluginScenario {
  submissions?: Record<string, Record<string, unknown>[]>
  cases?: {
    label: string
    data?: Record<string, unknown>
    state?: Record<string, unknown>
    responses?: PluginScenario['responses']
    interaction?: PluginScenario['interaction']
  }[]
  data: Record<string, unknown>
  state?: Record<string, unknown>
  responses: Record<string, PreviewResponse & { steps?: PreviewResponse[] }>
  interaction?: {
    respond?: PreviewResponse[]
    interrupt?: PreviewResponse[]
    questions: {
      id: string
      header: string
      question: string
      options: { label: string; description?: string | null }[]
      papers?: { id: string; label: string; description?: string | null }[] | null
      multiSelect?: boolean
    }[]
  } | null
}
export interface PluginSnapshot {
  descriptor: PluginDescriptor
  fingerprint: string
  scenarios: Record<string, PluginScenario>
  files: Record<string, string>
  ui?: PluginUIResource
  interaction?: PluginInteractionState
}
export interface PluginUIIdentity {
  fingerprint: string
  version: string
  compatibility: string
}
export interface PluginUIResource extends PluginUIIdentity {
  runtime: string
  files: Record<string, string>
  exports: string[]
}
export interface PluginInteractionState {
  data: Record<string, unknown>
  state: Record<string, unknown>
  revision: number
  content_revision?: number
  status: string
  session_id: string
  turn_id: string
}
export interface PluginMount {
  descriptor: PluginDescriptor
  fingerprint: string
  scenarios: Record<string, PluginScenario>
  frames: Record<string, { url: string; lease: string }>
  ui?: PluginUIIdentity
  interaction?: PluginInteractionState
}
export interface PluginReference {
  plugin: string
  component: string
  fingerprint: string
  binding?: string
  workbench?: boolean
}
export function componentAction(
  value: unknown,
  lease: string,
  component: PluginComponent
): { action: string; values: Record<string, unknown> } | null {
  const action = componentActionValue(value, lease)
  return action && component.actions.some((candidate) => candidate.id === action.action)
    ? action
    : null
}

function componentActionValue(
  value: unknown,
  lease: string
): { action: string; values: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  try {
    JSON.stringify(message)
  } catch {
    return null
  }
  if (
    Object.keys(message).some((key) => !['channel', 'lease', 'action', 'values'].includes(key)) ||
    message.channel !== PLUGIN_MESSAGE_CHANNEL ||
    message.lease !== lease ||
    typeof message.action !== 'string' ||
    !message.values ||
    typeof message.values !== 'object' ||
    Array.isArray(message.values)
  )
    return null
  return { action: message.action, values: message.values as Record<string, unknown> }
}
