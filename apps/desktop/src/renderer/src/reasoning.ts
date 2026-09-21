import type { TFunction } from 'i18next'

import type { ModelInfo } from './api'

export const DEFAULT_REASONING_EFFORT = ''
const REASONING_KEYS = {
  none: 'reasoning.none', minimal: 'reasoning.minimal', low: 'reasoning.low',
  medium: 'reasoning.medium', high: 'reasoning.high', xhigh: 'reasoning.xhigh',
  max: 'reasoning.max', ultra: 'reasoning.ultra'
} as const

export function reasoningLabel(value: string, t: TFunction<'conversation'>, compact = false): string {
  if (value === DEFAULT_REASONING_EFFORT) return t('reasoning.default')
  return Object.prototype.hasOwnProperty.call(REASONING_KEYS, value)
    ? t(compact ? `${REASONING_KEYS[value as keyof typeof REASONING_KEYS]}Short` : REASONING_KEYS[value as keyof typeof REASONING_KEYS])
    : value
}

export function reasoningPreference(model: ModelInfo | undefined, preferences: Record<string, string>): string {
  if (!model) return DEFAULT_REASONING_EFFORT
  const effort = preferences[model.key] ?? DEFAULT_REASONING_EFFORT
  return model.reasoning_efforts?.includes(effort) ? effort : DEFAULT_REASONING_EFFORT
}
