import {
  LITERATURE_REVIEW_TASK_TYPE,
  PRECISE_SEARCH_TASK_TYPE,
  RESEARCH_IDEA_TASK_TYPE,
  type ProductTaskType,
  type SkillInfo
} from '../../api.ts'
import { isAbsoluteInputPath } from '../../input.ts'
import { SKILL_LOGIN_REQUIRED } from '../../skill.ts'

export const AI_TASK_STARTERS = Object.freeze([
  {
    titleKey: 'panel.searchTitle',
    descriptionKey: 'panel.searchDescription',
    promptKey: 'panel.searchPrompt',
    skillName: 'precise-literature-search',
    taskType: PRECISE_SEARCH_TASK_TYPE
  },
  {
    titleKey: 'panel.reviewTitle',
    descriptionKey: 'panel.reviewDescription',
    promptKey: 'panel.reviewPrompt',
    skillName: 'literature-review',
    taskType: LITERATURE_REVIEW_TASK_TYPE
  },
  {
    titleKey: 'panel.ideasTitle',
    descriptionKey: 'panel.ideasDescription',
    promptKey: 'panel.ideasPrompt',
    skillName: 'research-idea-partner',
    taskType: RESEARCH_IDEA_TASK_TYPE
  }
] as const satisfies ReadonlyArray<{
  titleKey: string
  descriptionKey: string
  promptKey: string
  skillName: string
  taskType?: ProductTaskType
}>)

export const AI_TASK_STARTER_SKILL_NAMES: ReadonlySet<string> = new Set(
  AI_TASK_STARTERS.map((starter) => starter.skillName)
)

export type TaskStarterSkillFailure =
  | 'login_required'
  | 'missing'
  | 'disabled'
  | 'dependencies'
  | 'path'

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
): { reference: TaskStarterSkillReference; failure?: never }
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
      title: skill.name,
      path: skill.path,
      version: skill.version
    }
  }
}
