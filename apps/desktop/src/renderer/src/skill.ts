import type { IconName } from './icons'
import type { SkillInfo } from './api'
import type { TFunction } from 'i18next'
import { isAbsoluteInputPath } from './input.ts'

export type TaskStarterSkillFailure =
  'login_required' | 'missing' | 'disabled' | 'dependencies' | 'path'

export type TaskStarterSkillReference = {
  type: 'skill'
  id: string
  title: string
  path: string
  version?: string
}

export function resolveTaskStarterSkill(
  skills: SkillInfo[],
  name: string
):
  | { reference: TaskStarterSkillReference; failure?: never }
  | { reference?: never; failure: TaskStarterSkillFailure } {
  const skill = skills.find((candidate) => candidate.name === name)
  if (!skill) return { failure: 'missing' }
  if (skill.unavailable_reason === SKILL_LOGIN_REQUIRED) return { failure: 'login_required' }
  if (skill.enabled === false || skill.active === false) return { failure: 'disabled' }
  if (skill.dependency_status && skill.dependency_status !== 'ready') {
    return { failure: 'dependencies' }
  }
  if (!isAbsoluteInputPath(skill.path)) return { failure: 'path' }
  return {
    reference: {
      type: 'skill',
      id: skill.name,
      title: skillName(skill),
      path: skill.path,
      version: skill.version,
    },
  }
}

export function skillUseFailureMessage(
  translate: TFunction<'skills'>,
  failure: TaskStarterSkillFailure,
  name: string
): string {
  return translate(`try.failures.${failure}`, { name })
}

const SKILL_ICONS: Readonly<Record<string, IconName>> = Object.freeze({
  doc: 'doc',
  search: 'search',
  play: 'play',
})

export const SKILL_ICON_FALLBACK: IconName = 'skills'
export const SKILL_LOGIN_REQUIRED = 'login_required'

export function skillCallable(
  skill: {
    enabled: boolean
    active: boolean
    requires_login?: boolean
    dependency_status?: string
  },
  authenticated = true
): boolean {
  return (
    skill.enabled &&
    skill.active &&
    (!skill.requires_login || authenticated) &&
    (!skill.dependency_status || skill.dependency_status === 'ready')
  )
}

export function skillName(skill: { name: string; display_name?: string }): string {
  return skill.display_name || skill.name
}

export function skillDescription(
  skill: { descriptions?: Record<string, string> | null; blurb?: string; description?: string },
  language: string
): string {
  const normalized = language.trim().toLowerCase()
  const base = normalized.split('-')[0] ?? normalized
  return (
    skill.descriptions?.[normalized] ||
    skill.descriptions?.[base] ||
    skill.description ||
    skill.blurb ||
    ''
  )
}

export type ProductSkillGroup = 'scholarseed' | 'user'

export const SKILL_GROUPS: ReadonlyArray<{
  id: ProductSkillGroup
  labelKey: 'groups.scholarseed' | 'groups.user'
}> = Object.freeze([
  { id: 'scholarseed', labelKey: 'groups.scholarseed' },
  { id: 'user', labelKey: 'groups.user' },
])

/** The product catalog has two roots; unknown runtime origins fail closed. */
export function productSkillGroup(group: string | undefined): ProductSkillGroup | null {
  return group === 'scholarseed' || group === 'user' ? group : null
}

export function skillActivationControl(skill: { enabled: boolean; toggleable: boolean }): {
  checked: boolean
  disabled: boolean
} {
  return {
    checked: skill.enabled,
    disabled: !skill.toggleable,
  }
}

/** Resolve only Service-owned icon tokens; never turn arbitrary strings into component names. */
export function skillIcon(token: string | undefined): IconName {
  return token ? (SKILL_ICONS[token] ?? SKILL_ICON_FALLBACK) : SKILL_ICON_FALLBACK
}

/** YAML is metadata, not a Markdown setext heading; its version lives in the detail header. */
export function skillDocumentBody(document: string): string {
  return document.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trimStart()
}

export type SkillInstallNotice =
  | { namespace: 'skills'; key: 'installed' | 'plugin.installedDisabled'; name: string }
  | { namespace: 'skills'; key: 'plugin.uiUpdated' }

const SKILL_FAILURE_KEYS = {
  duplicate_name: { key: 'errors.duplicate', preserveDetail: false },
  invalid_package: { key: 'errors.invalid', preserveDetail: true },
  immutable_skill: { key: 'errors.immutable', preserveDetail: false },
} as const

export interface SkillMutationMessage {
  key:
    | (typeof SKILL_FAILURE_KEYS)[keyof typeof SKILL_FAILURE_KEYS]['key']
    | 'upload.failed'
    | 'deleteFailed'
  detail?: string
}

export function skillMutationMessage(
  code: string | undefined,
  detail: string | undefined,
  fallback: 'upload.failed' | 'deleteFailed'
): SkillMutationMessage {
  if (code && Object.prototype.hasOwnProperty.call(SKILL_FAILURE_KEYS, code)) {
    const failure = SKILL_FAILURE_KEYS[code as keyof typeof SKILL_FAILURE_KEYS]
    return { key: failure.key, ...(failure.preserveDetail && detail ? { detail } : {}) }
  }
  return { key: fallback, ...(detail ? { detail } : {}) }
}
