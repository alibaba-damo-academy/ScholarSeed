import type { PreviewPage, PreviewScenario } from './catalog.ts'
import { PREVIEW_CATALOG } from './catalog.ts'
import zh from './locales/zh.json' with { type: 'json' }

export type PdfeTranslate = (key: keyof typeof zh, values?: Record<string, number>) => string

export function pdfeTitle(value: { title: string; titleKey?: keyof typeof zh; home?: PreviewScenario['home'] }, translate: PdfeTranslate): string {
  return value.titleKey ? translate(value.titleKey, value.home ? { projects: value.home.projects, tasks: value.home.tasks } : undefined) : value.title
}

export function pdfeStateLabel(state: string, translate: PdfeTranslate): string {
  const key = 'state_' + state
  return key in zh ? translate(key as keyof typeof zh) : state
}

export function pdfeGuidance(page: PreviewPage, scene: PreviewScenario, translate: PdfeTranslate) {
  return {
    entry: page.entryInstructionKeys?.map(key => translate(key)) ?? page.entryInstructions ?? [],
    expected: scene.expectedKeys?.map(key => translate(key)) ?? scene.expected,
    limitations: scene.limitationKeys?.map(key => translate(key)) ?? scene.limitations,
  }
}

export function pdfeScenarioMatches(scene: PreviewScenario, query: string, translate?: PdfeTranslate): boolean {
  const term = query.trim().toLocaleLowerCase()
  return !term || [scene.id, scene.title, ...scene.states, ...(translate ? [pdfeTitle(scene, translate), ...scene.states.map(state => pdfeStateLabel(state, translate)), ...(scene.capabilityKeys ?? []).map(key => translate(key)), ...(scene.group ? [translate(scene.group)] : []), ...(scene.section ? [translate(scene.section)] : [])] : [])].some(value => value.toLocaleLowerCase().includes(term))
}

export function pdfeNavigationScenarios(page: PreviewPage, activePage: string, scene: string, query: string, translate: PdfeTranslate): readonly PreviewScenario[] {
  const identity = pdfePageIdentityMatches(page, query, translate)
  const matches = page.scenarios.filter(candidate => identity || pdfeScenarioMatches(candidate, query, translate))
  const currentAlias = activePage === page.id ? matches.find(candidate => candidate.id === scene && candidate.aliasOf) : undefined
  return matches.filter(candidate => candidate.aliasOf
    ? candidate === currentAlias || (!identity && !matches.some(other => other.id === candidate.aliasOf))
    : candidate.id !== currentAlias?.aliasOf)
}

export function pdfeNavigationPages(pages: readonly PreviewPage[], query: string, translate: PdfeTranslate): readonly PreviewPage[] {
  const available = pages.filter(page => page.navigation !== 'hidden' && page.launch?.kind !== 'components')
  const matches = available.filter(page => pdfePageMatches(page, query, 'all', translate))
  return available.filter(page => matches.includes(page) || matches.some(child => typeof child.navigation === 'object' && child.navigation.parentPage === page.id))
}

export function pdfePageIdentityMatches(page: PreviewPage, query: string, translate?: PdfeTranslate): boolean {
  const term = query.trim().toLocaleLowerCase()
  return !term || [page.id, page.title, page.owner, page.category, ...(translate ? [pdfeTitle(page, translate)] : [])].some(value => value.toLocaleLowerCase().includes(term))
}

export const PDFE_ROLES = [
  {
    id: 'product', title: 'roleProduct', focus: 'roleProductFocus',
    knowledge: [
      { title: 'knowledgeRequirements', path: 'docs/index.md' },
      { title: 'knowledgeScenarios', path: 'apps/desktop/preview/catalog.ts' },
    ],
  },
  {
    id: 'design', title: 'roleDesign', focus: 'roleDesignFocus',
    knowledge: [
      { title: 'knowledgeDesign', path: 'apps/desktop/DESIGN.md' },
      { title: 'knowledgeDesignMap', path: 'apps/desktop/docs/architecture/design-map.md' },
      { title: 'knowledgeComponents', path: 'apps/desktop/docs/design/components.md' },
      { title: 'knowledgeInteraction', path: 'apps/desktop/docs/design/interaction.md' },
    ],
  },
  {
    id: 'frontend', title: 'roleFrontend', focus: 'roleFrontendFocus',
    knowledge: [
      { title: 'knowledgeRenderer', path: 'apps/desktop/docs/architecture/renderer.md' },
      { title: 'knowledgeOwnership', path: 'apps/desktop/docs/architecture/ownership.md' },
      { title: 'knowledgeContracts', path: 'apps/desktop/docs/work/preview-contracts.md' },
      { title: 'knowledgeValidation', path: 'apps/desktop/docs/quality/testing.md' },
    ],
  },
] as const

export const PDFE_TASK_SCOPES = [
  { id: 'mock', title: 'scopeMock', description: 'scopeMockDescription' },
  { id: 'presentation', title: 'scopePresentation', description: 'scopePresentationDescription' },
] as const

export const PDFE_ROLE_KNOWLEDGE = 'apps/desktop/docs/work/pdfe.md'
const PDFE_TASK_SCHEMA = 'pdfe-task-context/v1'
const PDFE_SCOPE_REVIEW = ['api-contract', 'host', 'persistence', 'security', 'mock-engine', 'global-components-and-tokens', 'dependencies-build-release'] as const
const PDFE_MOCK_CANDIDATES = ['apps/desktop/preview/catalog.ts', 'apps/desktop/preview/fixtures/'] as const

export type PdfeRole = typeof PDFE_ROLES[number]['id']
export type PdfeTaskScope = typeof PDFE_TASK_SCOPES[number]['id']

export function pdfeFeatureTarget(serialized: string | null) {
  let value: unknown
  try { value = serialized === null ? null : JSON.parse(serialized) }
  catch (error) { if (!(error instanceof SyntaxError)) throw error }
  const target = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const page = PREVIEW_CATALOG.find(page => page.id === target?.pageId && page.launch?.kind !== 'components' && Boolean(page.target || page.host))
  const scene = page?.scenarios.find(scene => scene.id === target?.sceneId)
  if (page && scene) return { pageId: page.id, sceneId: scene.id }
  const fallback = PREVIEW_CATALOG.find(page => page.launch?.kind !== 'components' && Boolean(page.target || page.host))!
  return { pageId: fallback.id, sceneId: fallback.scenarios[0].id }
}

export function pdfeTaskContext(role: PdfeRole, scope: PdfeTaskScope, task: string, page: PreviewPage, scene: PreviewScenario) {
  const profile = PDFE_ROLES.find(candidate => candidate.id === role)!
  return {
    schema: PDFE_TASK_SCHEMA,
    role,
    scope,
    task: task.trim(),
    pageId: page.id,
    sceneId: scene.id,
    candidateFiles: scope === 'mock' ? [...PDFE_MOCK_CANDIDATES] : page.implementation === 'surface' ? [`apps/desktop/${page.source}`] : [],
    knowledge: [PDFE_ROLE_KNOWLEDGE, ...profile.knowledge.map(entry => entry.path)],
    requirementSource: page.requirementSource,
    expected: [...scene.expected],
    limitations: [...scene.limitations],
    requiresScopeReview: [...PDFE_SCOPE_REVIEW],
    authorization: 'not-granted-by-context',
    sourceBaseline: 'capture-before-edit',
    requiresSemanticReview: true,
  }
}

export function pdfePageMatches(page: PreviewPage, query: string, category: PreviewPage['category'] | 'all' = 'all', translate?: PdfeTranslate): boolean {
  if (category !== 'all' && page.category !== category) return false
  return pdfePageIdentityMatches(page, query, translate) || page.scenarios.some(scene => pdfeScenarioMatches(scene, query, translate))
}
