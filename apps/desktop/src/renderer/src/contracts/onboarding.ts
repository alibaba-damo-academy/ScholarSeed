import type { OnboardingGroup } from '../../../onboarding'

export const PROJECT_GUIDE_ANCHORS = {
  switcher: 'project-guide-switcher',
  files: 'project-guide-files',
  filesTab: 'project-guide-files-tab',
  materials: 'project-guide-materials',
  literature: 'project-guide-literature',
  materialsTab: 'project-guide-materials-tab',
  literatureTab: 'project-guide-literature-tab',
  task: 'project-guide-task',
  tasks: 'project-guide-tasks',
  capabilities: 'project-guide-capabilities',
  composer: 'project-guide-composer',
  categories: 'project-guide-categories',
  outputsTab: 'project-guide-outputs-tab',
  workspace: 'project-guide-workspace',
  closeWorkspace: 'project-guide-close-workspace',
} as const

export type OnboardingEvent =
  { type: 'center' } | { type: 'trigger'; group: OnboardingGroup; projectId?: string }
const listeners = new Set<(event: OnboardingEvent) => void>()
/** Small public ingress: existing owners only signal real user events. */
export const Onboarding = {
  openCenter: (): void => {
    listeners.forEach((listener) => listener({ type: 'center' }))
  },
  trigger: (group: OnboardingGroup, projectId?: string): void => {
    listeners.forEach((listener) => listener({ type: 'trigger', group, projectId }))
  },
  subscribe: (listener: (event: OnboardingEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
