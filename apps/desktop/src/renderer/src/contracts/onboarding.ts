import type { OnboardingGroup } from '../../../onboarding'

export type OnboardingEvent = { type: 'center' } | { type: 'trigger'; group: OnboardingGroup; projectId?: string }
const listeners = new Set<(event: OnboardingEvent) => void>()
/** Small public ingress: existing owners only signal real user events. */
export const Onboarding = {
  openCenter: (): void => { listeners.forEach(listener => listener({ type: 'center' })) },
  trigger: (group: OnboardingGroup, projectId?: string): void => {
    listeners.forEach(listener => listener({ type: 'trigger', group, projectId }))
  },
  subscribe: (listener: (event: OnboardingEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
}
