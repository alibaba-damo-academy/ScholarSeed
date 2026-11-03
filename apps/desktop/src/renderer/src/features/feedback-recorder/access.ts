import type { RecorderPhase } from './model.ts'

export function feedbackShortcutAction(
  phase: RecorderPhase,
  internalEnabled: boolean,
  authenticated: boolean
): 'feedback' | 'record' | 'capture' | null {
  if (phase === 'idle') {
    return isFeedbackRecorderAvailable(internalEnabled, authenticated) ? 'record' : 'feedback'
  }
  return phase === 'recording' || phase === 'paused' ? 'capture' : null
}

export function isFeedbackRecorderAvailable(
  internalEnabled: boolean,
  authenticated: boolean
): boolean {
  return internalEnabled && authenticated
}
