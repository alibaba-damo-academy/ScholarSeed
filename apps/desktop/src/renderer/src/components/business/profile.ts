import type { TFunction } from 'i18next'
import type {
  ModelInfo,
  ModelProviderPreset,
  PersonalApiFailure,
  PersonalApiProbeResult,
} from '../../api'

export const SAVED_API_KEY_MASK = '••••••••'

export interface ModelApiKeyDraft {
  value: string
  saved: boolean
  touched: boolean
}

export function initialModelApiKeyDraft(saved: boolean): ModelApiKeyDraft {
  return { value: '', saved, touched: false }
}

export function editModelApiKeyDraft(draft: ModelApiKeyDraft, value: string): ModelApiKeyDraft {
  return { ...draft, value, touched: true }
}

export function modelApiKeyNeedsReplacement(draft: ModelApiKeyDraft): boolean {
  return draft.saved && draft.touched && !draft.value.trim()
}

export function modelApiKeyShowsSavedMask(draft: ModelApiKeyDraft): boolean {
  return draft.saved && !draft.touched
}

const PROFILE_ERROR_KEYS = {
  authentication_required: 'request.authentication',
  http_failure: 'request.http',
  network_failure: 'request.network',
} as const

const MODEL_DISABLED_REASON_KEYS = {
  gateway_credential_required: 'models.disabledReasons.gatewayCredentialRequired',
  oauth_storage_unavailable: 'models.disabledReasons.subscriptionStorageUnavailable',
  subscription_connection_required: 'models.disabledReasons.subscriptionConnectionRequired',
} as const

// 置灰行名字后的灰色短 tag: 只有登记的产品码给 tag, 其余保持无 tag。
const MODEL_DISABLED_TAG_KEYS = {
  gateway_credential_required: 'models.disabledTags.gatewayCredentialRequired',
} as const

/** Only explicit product codes translate; a matching original reason is still raw text. */
export function modelDisabledReason(
  model: Pick<ModelInfo, 'disabled_reason' | 'disabled_reason_code'>,
  t: TFunction<'account'>
): string | undefined {
  const code = model.disabled_reason_code
  return code && Object.prototype.hasOwnProperty.call(MODEL_DISABLED_REASON_KEYS, code)
    ? t(MODEL_DISABLED_REASON_KEYS[code as keyof typeof MODEL_DISABLED_REASON_KEYS])
    : model.disabled_reason || code
}

/** 置灰行名字后的灰色短 tag; 未登记的产品码不给 tag。 */
export function modelDisabledTag(
  model: Pick<ModelInfo, 'disabled_reason_code'>,
  t: TFunction<'account'>
): string | undefined {
  const code = model.disabled_reason_code
  return code && Object.prototype.hasOwnProperty.call(MODEL_DISABLED_TAG_KEYS, code)
    ? t(MODEL_DISABLED_TAG_KEYS[code as keyof typeof MODEL_DISABLED_TAG_KEYS])
    : undefined
}

export function profileFailureText(
  failure: PersonalApiFailure,
  t: TFunction<'subscription'>
): string {
  const message = failure.code
    ? t(PROFILE_ERROR_KEYS[failure.code], { status: failure.status ?? 0 })
    : t('operationFailed')
  return message + (failure.error ? ` (${failure.error})` : '')
}

const PROBE_HTTP_STATUS_PREFIX = 'http_status_'
const PROBE_BASE_URL_REQUIRED = 'base_url_required'
const PROBE_UNSUPPORTED_PROTOCOL = 'unsupported_wire_api'
// 与后端 settings.py 的 CONNECTION_VALIDATION_FAILED_CODE 同值: 保存校验失败的结构化标记。
const CONNECTION_VALIDATION_FAILED = 'connection_validation_failed'
const PROBE_AUTH_STATUSES = new Set([401, 403])

/** 连接测试失败的分类; 弹窗按类给中文原因与建议, key 映射见 PROBE_*_KEYS。 */
export type ProbeFailureKind =
  | 'missingKey'
  | 'auth'
  | 'notFound'
  | 'status'
  | 'network'
  | 'protocol'
  | 'baseUrl'
  | 'noModels'
  | 'modelRejected'
  | 'generic'

export interface ProbeFailureDetail {
  kind: ProbeFailureKind
  params?: { status?: number; model?: string; upstream?: string }
}

/** 触发失败弹窗的动作; 决定标题文案（测试连接 vs 保存/刷新连接）。 */
export type ProbeFailureTitle = 'test' | 'connection'

export const PROBE_TITLE_KEYS = {
  test: 'accountPanel.modelsPage.probeResultTitle',
  connection: 'accountPanel.modelsPage.connectionFailTitle',
} as const

export const PROBE_REASON_KEYS = {
  missingKey: 'accountPanel.modelsPage.probeReasonMissingKey',
  auth: 'accountPanel.modelsPage.probeReasonAuth',
  notFound: 'accountPanel.modelsPage.probeReasonNotFound',
  status: 'accountPanel.modelsPage.probeReasonStatus',
  network: 'accountPanel.modelsPage.probeReasonNetwork',
  protocol: 'accountPanel.modelsPage.probeReasonProtocol',
  baseUrl: 'accountPanel.modelsPage.probeReasonBaseUrl',
  noModels: 'accountPanel.modelsPage.probeReasonNoModels',
  modelRejected: 'accountPanel.modelsPage.probeReasonModelRejected',
  generic: 'accountPanel.modelsPage.probeReasonGeneric',
} as const

export const PROBE_SUGGESTION_KEYS = {
  missingKey: 'accountPanel.modelsPage.probeSuggestionMissingKey',
  auth: 'accountPanel.modelsPage.probeSuggestionAuth',
  notFound: 'accountPanel.modelsPage.probeSuggestionNotFound',
  status: 'accountPanel.modelsPage.probeSuggestionStatus',
  network: 'accountPanel.modelsPage.probeSuggestionNetwork',
  protocol: 'accountPanel.modelsPage.probeSuggestionProtocol',
  baseUrl: 'accountPanel.modelsPage.probeSuggestionBaseUrl',
  noModels: 'accountPanel.modelsPage.probeSuggestionNoModels',
  modelRejected: 'accountPanel.modelsPage.probeSuggestionModelRejected',
  generic: 'accountPanel.modelsPage.probeSuggestionGeneric',
} as const

function probeHttpStatusDetail(status: number): ProbeFailureDetail {
  if (PROBE_AUTH_STATUSES.has(status)) return { kind: 'auth' }
  if (status === 404) return { kind: 'notFound' }
  return { kind: 'status', params: { status } }
}

/** 按后端 error_class 分类; 空串（无从归类）返回 undefined, 由调用方兜底。 */
function classifyErrorClass(errorClass: string): ProbeFailureDetail | undefined {
  if (errorClass === PROBE_BASE_URL_REQUIRED) return { kind: 'baseUrl' }
  if (errorClass === PROBE_UNSUPPORTED_PROTOCOL) return { kind: 'protocol' }
  if (errorClass.startsWith(PROBE_HTTP_STATUS_PREFIX)) {
    const status = Number(errorClass.slice(PROBE_HTTP_STATUS_PREFIX.length))
    if (Number.isInteger(status)) return probeHttpStatusDetail(status)
  }
  // 非 HTTP 状态的 error_class 是 httpx 报的网络层异常名。
  if (errorClass) return { kind: 'network' }
  return undefined
}

/** 按后端返回的结构化错误码分类连接失败; modelRejected 额外带上失败模型与上游原文。 */
export function probeFailureDetail(
  failure: PersonalApiFailure | PersonalApiProbeResult
): ProbeFailureDetail {
  if ('message' in failure) {
    const classified = classifyErrorClass(failure.error_class ?? '')
    if (classified) return classified
    // 无 error_class 且失败: 端点可达但返回空模型列表 (ok=bool(models))。
    if (failure.models.length === 0) return { kind: 'noModels' }
    return { kind: 'generic' }
  }
  if (failure.code === 'network_failure') return { kind: 'network' }
  const detail = failure.detail
  if (detail?.code === CONNECTION_VALIDATION_FAILED) {
    const byClass = classifyErrorClass(detail.error_class ?? '')
    // 真的调用了某个已选模型、且上游返回的是非鉴权错误状态: 指名模型并带上游原文, 让用户
    // 知道是「这个模型在这个端点上不行」, 而不是被引导去查本就正确的地址和 Key。鉴权失败
    // (401/403) 仍归 auth —— 那时真正的问题是凭据, 指名模型反而会把用户带偏。
    if (detail.model && (byClass?.kind === 'status' || byClass?.kind === 'notFound')) {
      return {
        kind: 'modelRejected',
        params: { model: detail.model, upstream: detail.upstream ?? '' },
      }
    }
    // 没有已选模型（保存时只读目录就失败）或鉴权/网络类失败: 按 error_class 复用既有分类。
    return byClass ?? { kind: 'generic' }
  }
  if (failure.code === 'http_failure' && typeof failure.status === 'number') {
    return probeHttpStatusDetail(failure.status)
  }
  return { kind: 'generic' }
}

const PROVIDER_PRESENTATION_KEYS = {
  dashscope: {
    labelKey: 'providerPresets.dashscope.label',
    credentialHintKey: 'providerPresets.dashscope.credentialHint',
  },
  'dashscope-token-plan': {
    labelKey: 'models.tokenPlanPersonal',
    credentialHintKey: 'providerPresets.dashscope.credentialHint',
  },
  'dashscope-token-plan-team': {
    labelKey: 'models.tokenPlanTeam',
    credentialHintKey: 'providerPresets.dashscope.credentialHint',
  },
  openai: {
    labelKey: 'providerPresets.openai.label',
    noteKey: 'providerPresets.openai.note',
    credentialHintKey: 'providerPresets.openai.credentialHint',
  },
  google: {
    labelKey: 'providerPresets.google.label',
    noteKey: 'providerPresets.google.note',
    credentialHintKey: 'providerPresets.google.credentialHint',
  },
  deepseek: {
    labelKey: 'providerPresets.deepseek.label',
    credentialHintKey: 'providerPresets.deepseek.credentialHint',
  },
  moonshot: {
    labelKey: 'providerPresets.moonshot.label',
    credentialHintKey: 'providerPresets.moonshot.credentialHint',
  },
  zhipu: {
    labelKey: 'providerPresets.zhipu.label',
    credentialHintKey: 'providerPresets.zhipu.credentialHint',
  },
  openrouter: {
    labelKey: 'providerPresets.openrouter.label',
    noteKey: 'providerPresets.openrouter.note',
    credentialHintKey: 'providerPresets.openrouter.credentialHint',
  },
  ollama: {
    labelKey: 'providerPresets.ollama.label',
    noteKey: 'providerPresets.ollama.note',
    credentialHintKey: 'providerPresets.ollama.credentialHint',
  },
} as const

/** Translate application presets by identity; unknown provider metadata stays intact. */
export function providerPresetText(
  preset: ModelProviderPreset | undefined,
  t: TFunction<'account'>
) {
  const keys = presetPresentationKeys(preset?.id)
  return {
    label: keys ? t(keys.labelKey) : preset?.label || '',
    note: keys && 'noteKey' in keys ? t(keys.noteKey) : preset?.note || '',
    credentialHint: keys ? t(keys.credentialHintKey) : preset?.credential_hint || '',
  }
}

function presetPresentationKeys(presetId: string | undefined) {
  return presetId && Object.prototype.hasOwnProperty.call(PROVIDER_PRESENTATION_KEYS, presetId)
    ? PROVIDER_PRESENTATION_KEYS[presetId as keyof typeof PROVIDER_PRESENTATION_KEYS]
    : undefined
}

export function modelProviderLabel(
  presetId: string | undefined,
  original: string,
  t: TFunction<'account'>
): string {
  const keys = presetPresentationKeys(presetId)
  return keys ? t(keys.labelKey) : original
}

export function modelDisplayLabels(model: ModelInfo, t: TFunction<'account'>) {
  if (model.source === 'builtin')
    return { label: model.model_label || model.label, providerLabel: t('modelSettings.builtin') }
  const keys = presetPresentationKeys(model.provider_preset_id)
  if (keys && typeof model.model_label === 'string') {
    // Model identity stays intact; the provider has its own display column.
    return { label: model.model_label, providerLabel: t(keys.labelKey) }
  }
  return { label: model.label, providerLabel: model.provider_label || '' }
}
