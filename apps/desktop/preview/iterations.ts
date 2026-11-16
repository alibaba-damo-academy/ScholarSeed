export interface PdfeFeature {
  readonly id: string
  readonly introducedIn: string | null
  readonly changes: readonly { readonly version: string; readonly summary: string }[]
}

export const PDFE_FEATURES = [
  { id: 'project-browse', introducedIn: null, changes: [] },
] as const satisfies readonly PdfeFeature[]

export type PdfeFeatureId = (typeof PDFE_FEATURES)[number]['id']
export const PDFE_ITERATION_SCOPES = ['any', 'added', 'updated'] as const
export interface PdfeIterationFilter {
  readonly version: string
  readonly scope: (typeof PDFE_ITERATION_SCOPES)[number]
}
export const PDFE_ITERATION_DEFAULT: PdfeIterationFilter = { version: 'all', scope: 'any' }
export const PDFE_ITERATION_STORAGE = 'pdfe-iteration:'
const ITERATION_VERSION = /^\d+(?:\.\d+){1,3}$/

function compareIterations(left: string, right: string): number {
  const first = left.split('.').map(Number)
  const second = right.split('.').map(Number)
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

interface VersionedScenario {
  readonly id: string
  readonly feature?: PdfeFeatureId
  readonly aliasOf?: string
}

export function pdfeFeature(scenario: VersionedScenario, scenarios: readonly VersionedScenario[] = []): PdfeFeature | undefined {
  const identity = scenario.feature ?? scenarios.find(candidate => candidate.id === scenario.aliasOf)?.feature
  return PDFE_FEATURES.find(feature => feature.id === identity)
}

export function pdfeFeatureMatches(feature: PdfeFeature | undefined, filter: PdfeIterationFilter): boolean {
  if (filter.version === 'all' && filter.scope === 'any') return true
  if (!feature) return false
  if (filter.version === 'unconfirmed') return filter.scope === 'any' && feature.introducedIn === null
  const added = feature.introducedIn === filter.version
  const updated = feature.changes.some(change => change.version === filter.version)
  return filter.scope === 'added' ? added : filter.scope === 'updated' ? updated : added || updated
}

export function pdfeIterations(features: readonly PdfeFeature[] = PDFE_FEATURES): readonly string[] {
  for (const feature of features) {
    const versions = [...(feature.introducedIn === null ? [] : [feature.introducedIn]), ...feature.changes.map(change => change.version)]
    if (versions.some(version => !ITERATION_VERSION.test(version))) throw new Error('Invalid PDFE iteration version: ' + feature.id)
    if (feature.introducedIn !== null && feature.changes.some(change => compareIterations(change.version, feature.introducedIn!) < 0)) throw new Error('PDFE update predates introduction: ' + feature.id)
  }
  const versions = [...new Set(features.flatMap(feature => [
    ...(feature.introducedIn === null ? [] : [feature.introducedIn]),
    ...feature.changes.map(change => change.version),
  ]))]
  return versions.sort((left, right) => compareIterations(right, left))
}

export function readIterationFilter(value: string | null): PdfeIterationFilter {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return PDFE_ITERATION_DEFAULT
    const filter = parsed as Partial<PdfeIterationFilter>
    if (typeof filter.version !== 'string' || !['all', 'unconfirmed', ...pdfeIterations()].includes(filter.version) || !PDFE_ITERATION_SCOPES.includes(filter.scope!)) return PDFE_ITERATION_DEFAULT
    return { version: filter.version, scope: ['all', 'unconfirmed'].includes(filter.version) ? 'any' : filter.scope! }
  } catch {
    return PDFE_ITERATION_DEFAULT
  }
}
