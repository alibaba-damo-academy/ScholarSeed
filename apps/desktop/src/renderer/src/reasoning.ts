import type { TFunction } from 'i18next'

import type { ModelInfo, SessionModelSnapshot } from './api'

export const DEFAULT_REASONING_EFFORT = ''
const REASONING_KEYS = {
  none: { key: 'reasoning.none', compactKey: 'reasoning.noneShort' },
  minimal: { key: 'reasoning.minimal', compactKey: 'reasoning.minimalShort' },
  low: { key: 'reasoning.low', compactKey: 'reasoning.lowShort' },
  medium: { key: 'reasoning.medium', compactKey: 'reasoning.mediumShort' },
  high: { key: 'reasoning.high', compactKey: 'reasoning.highShort' },
  xhigh: { key: 'reasoning.xhigh', compactKey: 'reasoning.xhighShort' },
  max: { key: 'reasoning.max', compactKey: 'reasoning.maxShort' },
  ultra: { key: 'reasoning.ultra', compactKey: 'reasoning.ultraShort' },
} as const
/**
 * Strength order used to pick the lowest declared level. Mirrors the backend's
 * REASONING_EFFORT_LEVELS (service/inference/reasoning.py) — one order, both ends.
 */
const EFFORT_STRENGTH_ORDER = Object.keys(REASONING_KEYS)

export function reasoningLabel(
  value: string,
  t: TFunction<'conversation'>,
  compact = false
): string {
  if (value === DEFAULT_REASONING_EFFORT) return t('reasoning.default')
  if (!Object.prototype.hasOwnProperty.call(REASONING_KEYS, value)) return value
  const keys = REASONING_KEYS[value as keyof typeof REASONING_KEYS]
  return t(compact ? keys.compactKey : keys.key)
}

export function declaredEffortValues(model: ModelInfo | undefined): string[] {
  if (model?.reasoning_efforts?.length) return model.reasoning_efforts
  const option = (model?.reasoning_options ?? []).find((entry) => entry.kind === 'effort')
  return option?.values ?? []
}

/**
 * The model's definite default level: the `default` declared in the model
 * definition, or the lowest declared level when none is declared. The
 * "follow the provider default" pseudo-level has been removed from the product,
 * so every model with declared efforts resolves to a concrete level here.
 * Returns '' only when the model declares no effort levels at all.
 */
export function modelDefaultEffort(model: ModelInfo | undefined): string {
  if (!model) return DEFAULT_REASONING_EFFORT
  const values = declaredEffortValues(model)
  if (!values.length) return DEFAULT_REASONING_EFFORT
  const option = (model.reasoning_options ?? []).find((entry) => entry.kind === 'effort')
  const declared = (option?.default ?? '').trim().toLowerCase()
  if (declared && values.includes(declared)) return declared
  const lowest = EFFORT_STRENGTH_ORDER.find((level) => values.includes(level))
  return lowest ?? values[0]
}

export function reasoningPreference(
  model: ModelInfo | undefined,
  preferences: Record<string, string>
): string {
  if (!model) return DEFAULT_REASONING_EFFORT
  const effort = preferences[model.key] ?? DEFAULT_REASONING_EFFORT
  if (declaredEffortValues(model).includes(effort)) return effort
  return modelDefaultEffort(model)
}

export function confirmedReasoningSelection(
  snapshot: SessionModelSnapshot | null | undefined,
  sessionId: string,
  modelKey: string,
  effort: string
): boolean {
  return (
    snapshot?.session_id === sessionId &&
    snapshot.model_id === modelKey &&
    (snapshot.reasoning_effort ?? DEFAULT_REASONING_EFFORT) === effort &&
    snapshot.runtime?.model_id === modelKey &&
    (snapshot.runtime.reasoning_effort ?? DEFAULT_REASONING_EFFORT) === effort
  )
}
