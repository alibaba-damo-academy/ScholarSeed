/** User-level onboarding preferences; no project or document content is stored. */
export const ONBOARDING_GROUPS = ['home', 'project', 'globalLib', 'pdf'] as const
export type OnboardingGroup = typeof ONBOARDING_GROUPS[number]
export interface OnboardingPreferences {
  seen: Partial<Record<OnboardingGroup, true>>
  recentProjectId?: string
}
export function sanitizeOnboarding(value: unknown): OnboardingPreferences {
  const input = value && typeof value === 'object' ? value as Partial<OnboardingPreferences> : {}
  return {
    seen: Object.fromEntries(ONBOARDING_GROUPS.filter(key => input.seen?.[key] === true).map(key => [key, true])),
    ...(typeof input.recentProjectId === 'string' ? { recentProjectId: input.recentProjectId } : {})
  }
}
export function onboardingEqual(left: unknown, right: unknown): boolean {
  const a = sanitizeOnboarding(left), b = sanitizeOnboarding(right)
  return a.recentProjectId === b.recentProjectId && ONBOARDING_GROUPS.every(key => a.seen[key] === b.seen[key])
}
