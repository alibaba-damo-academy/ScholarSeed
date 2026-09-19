import type { TFunction } from 'i18next'
import type { ModelInfo, ModelProviderPreset, PersonalApiFailure } from '../../api'

const PROFILE_ERROR_KEYS = {
  authentication_required: 'request.authentication',
  http_failure: 'request.http',
  network_failure: 'request.network'
} as const

const MODEL_DISABLED_REASON_KEYS = {
  gateway_credential_required: 'models.disabledReasons.gatewayCredentialRequired',
  subscription_connection_required: 'models.disabledReasons.subscriptionConnectionRequired'
} as const

/** Only explicit product codes translate; a matching original reason is still raw text. */
export function modelDisabledReason(model: Pick<ModelInfo, 'disabled_reason' | 'disabled_reason_code'>, t: TFunction<'account'>): string | undefined {
  const code = model.disabled_reason_code
  return code && Object.prototype.hasOwnProperty.call(MODEL_DISABLED_REASON_KEYS, code)
    ? t(MODEL_DISABLED_REASON_KEYS[code as keyof typeof MODEL_DISABLED_REASON_KEYS])
    : model.disabled_reason || code
}

export function profileFailureText(failure: PersonalApiFailure, t: TFunction<'subscription'>): string {
  const message = failure.code ? t(PROFILE_ERROR_KEYS[failure.code], { status: failure.status ?? 0 }) : t('operationFailed')
  return message + (failure.error ? ` (${failure.error})` : '')
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
