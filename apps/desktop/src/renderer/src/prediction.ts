import type { Thread } from './model'

export function predictionTurn(outcomes: Thread['turnOutcomes']): string {
  const entries = Object.entries(outcomes ?? {})
  const latest = entries[entries.length - 1]
  return latest?.[1] === 'completed' ? latest[0] : ''
}

export function acceptsPrediction(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  draft: string,
  suggestion: string
): boolean {
  return Boolean(
    suggestion &&
    !draft &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === 'Tab' || event.key === 'ArrowRight')
  )
}
