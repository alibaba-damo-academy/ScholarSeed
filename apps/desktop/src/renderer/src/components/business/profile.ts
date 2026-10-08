import type { TFunction } from 'i18next'
import type { ModelInfo, ModelProviderPreset, PersonalApiFailure, PersonalApiProbeResult } from '../../api'

const PROFILE_ERROR_KEYS = {
  authentication_required: 'request.authentication',
  http_failure: 'request.http',
  network_failure: 'request.network'
} as const

const MODEL_DISABLED_REASON_KEYS = {
  gateway_credential_required: 'models.disabledReasons.gatewayCredentialRequired',
  subscription_connection_required: 'models.disabledReasons.subscriptionConnectionRequired'
} as const

// 置灰行名字后的灰色短 tag: 只有登记的产品码给 tag, 其余保持无 tag。
const MODEL_DISABLED_TAG_KEYS = {
  gateway_credential_required: 'models.disabledTags.gatewayCredentialRequired'
} as const

/** Only explicit product codes translate; a matching original reason is still raw text. */
export function modelDisabledReason(model: Pick<ModelInfo, 'disabled_reason' | 'disabled_reason_code'>, t: TFunction<'account'>): string | undefined {
  const code = model.disabled_reason_code
  return code && Object.prototype.hasOwnProperty.call(MODEL_DISABLED_REASON_KEYS, code)
    ? t(MODEL_DISABLED_REASON_KEYS[code as keyof typeof MODEL_DISABLED_REASON_KEYS])
    : model.disabled_reason || code
}

/** 置灰行名字后的灰色短 tag; 未登记的产品码不给 tag。 */
export function modelDisabledTag(model: Pick<ModelInfo, 'disabled_reason_code'>, t: TFunction<'account'>): string | undefined {
  const code = model.disabled_reason_code
  return code && Object.prototype.hasOwnProperty.call(MODEL_DISABLED_TAG_KEYS, code)
    ? t(MODEL_DISABLED_TAG_KEYS[code as keyof typeof MODEL_DISABLED_TAG_KEYS])
    : undefined
}

export function profileFailureText(failure: PersonalApiFailure, t: TFunction<'subscription'>): string {
  const message = failure.code ? t(PROFILE_ERROR_KEYS[failure.code], { status: failure.status ?? 0 }) : t('operationFailed')
  return message + (failure.error ? ` (${failure.error})` : '')
}

const PROBE_HTTP_STATUS_PREFIX = 'http_status_'
const PROBE_BASE_URL_REQUIRED = 'base_url_required'
const PROBE_UNSUPPORTED_PROTOCOL = 'unsupported_wire_api'
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
  | 'generic'

export interface ProbeFailureDetail {
  kind: ProbeFailureKind
  params?: { status: number }
}

/** 触发失败弹窗的动作; 决定标题文案（测试连接 vs 保存/刷新连接）。 */
export type ProbeFailureTitle = 'test' | 'connection'

export const PROBE_TITLE_KEYS = {
  test: 'accountPanel.modelsPage.probeResultTitle',
  connection: 'accountPanel.modelsPage.connectionFailTitle'
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
  generic: 'accountPanel.modelsPage.probeReasonGeneric'
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
  generic: 'accountPanel.modelsPage.probeSuggestionGeneric'
} as const

function probeHttpStatusDetail(status: number): ProbeFailureDetail {
  if (PROBE_AUTH_STATUSES.has(status)) return { kind: 'auth' }
  if (status === 404) return { kind: 'notFound' }
  return { kind: 'status', params: { status } }
}

/** 按后端返回的结构化错误码分类连接测试失败; 不透传上游原文给弹窗。 */
export function probeFailureDetail(
  failure: PersonalApiFailure | PersonalApiProbeResult
): ProbeFailureDetail {
  if ('message' in failure) {
    const errorClass = failure.error_class ?? ''
    if (errorClass === PROBE_BASE_URL_REQUIRED) return { kind: 'baseUrl' }
    if (errorClass === PROBE_UNSUPPORTED_PROTOCOL) return { kind: 'protocol' }
    if (errorClass.startsWith(PROBE_HTTP_STATUS_PREFIX)) {
      const status = Number(errorClass.slice(PROBE_HTTP_STATUS_PREFIX.length))
      if (Number.isInteger(status)) return probeHttpStatusDetail(status)
    }
    // 非 HTTP 状态的 error_class 是 httpx 报的网络层异常名。
    if (errorClass) return { kind: 'network' }
    // 无 error_class 且失败: 端点可达但返回空模型列表 (ok=bool(models))。
    if (failure.models.length === 0) return { kind: 'noModels' }
    return { kind: 'generic' }
  }
  if (failure.code === 'network_failure') return { kind: 'network' }
  if (failure.code === 'http_failure' && typeof failure.status === 'number') {
    return probeHttpStatusDetail(failure.status)
  }
  return { kind: 'generic' }
}

const PROVIDER_PRESENTATION_KEYS = {
  dashscope: { labelKey: 'providerPresets.dashscope.label', credentialHintKey: 'providerPresets.dashscope.credentialHint' },
  'dashscope-token-plan': { labelKey: 'models.tokenPlanPersonal', credentialHintKey: 'providerPresets.dashscope.credentialHint' },
  'dashscope-token-plan-team': { labelKey: 'models.tokenPlanTeam', credentialHintKey: 'providerPresets.dashscope.credentialHint' },
  openai: { labelKey: 'providerPresets.openai.label', noteKey: 'providerPresets.openai.note', credentialHintKey: 'providerPresets.openai.credentialHint' },
  google: { labelKey: 'providerPresets.google.label', noteKey: 'providerPresets.google.note', credentialHintKey: 'providerPresets.google.credentialHint' },
  deepseek: { labelKey: 'providerPresets.deepseek.label', credentialHintKey: 'providerPresets.deepseek.credentialHint' },
  moonshot: { labelKey: 'providerPresets.moonshot.label', credentialHintKey: 'providerPresets.moonshot.credentialHint' },
  zhipu: { labelKey: 'providerPresets.zhipu.label', credentialHintKey: 'providerPresets.zhipu.credentialHint' },
  openrouter: { labelKey: 'providerPresets.openrouter.label', noteKey: 'providerPresets.openrouter.note', credentialHintKey: 'providerPresets.openrouter.credentialHint' },
  ollama: { labelKey: 'providerPresets.ollama.label', noteKey: 'providerPresets.ollama.note', credentialHintKey: 'providerPresets.ollama.credentialHint' },
} as const

/** Translate application presets by identity; unknown provider metadata stays intact. */
export function providerPresetText(preset: ModelProviderPreset | undefined, t: TFunction<'account'>) {
  const keys = presetPresentationKeys(preset?.id)
  return {
    label: keys ? t(keys.labelKey) : preset?.label || '',
    note: keys && 'noteKey' in keys ? t(keys.noteKey) : preset?.note || '',
    credentialHint: keys ? t(keys.credentialHintKey) : preset?.credential_hint || ''
  }
}

function presetPresentationKeys(presetId: string | undefined) {
  return presetId && Object.prototype.hasOwnProperty.call(PROVIDER_PRESENTATION_KEYS, presetId)
    ? PROVIDER_PRESENTATION_KEYS[presetId as keyof typeof PROVIDER_PRESENTATION_KEYS]
    : undefined
}

export function modelProviderLabel(presetId: string | undefined, original: string, t: TFunction<'account'>): string {
  const keys = presetPresentationKeys(presetId)
  return keys ? t(keys.labelKey) : original
}

export function modelDisplayLabels(model: ModelInfo, t: TFunction<'account'>) {
  if (model.source === 'builtin') return { label: model.model_label || model.label, providerLabel: t('modelSettings.builtin') }
  const keys = presetPresentationKeys(model.provider_preset_id)
  if (keys && typeof model.model_label === 'string') {
    // Model identity stays intact; the provider has its own display column.
    return { label: model.model_label, providerLabel: t(keys.labelKey) }
  }
  return { label: model.label, providerLabel: model.provider_label || '' }
}
