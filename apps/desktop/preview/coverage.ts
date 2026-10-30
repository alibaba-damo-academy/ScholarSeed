import { PREVIEW_CATALOG } from './catalog.ts'

export const PREVIEW_CONSUMPTION_ANNOTATION = 'preview-consumption'

export interface PreviewConsumption {
  readonly pageId: string
  readonly sceneId: string
  readonly states: readonly string[]
}

export interface PreviewConsumer {
  readonly file: string
  readonly title: string
  readonly project: string
  readonly states: readonly string[]
}

export interface PreviewCoverage extends PreviewConsumption {
  readonly owner: string
  readonly source: string
  readonly expected: readonly string[]
  readonly limitations: readonly string[]
  readonly status: 'has-tests' | 'partial' | 'unmapped' | 'excluded'
  readonly reason?: string
  readonly coveredStates: readonly string[]
  readonly missingStates: readonly string[]
  readonly consumers: readonly PreviewConsumer[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function consumption(value: unknown): PreviewConsumption {
  if (!record(value) || typeof value.pageId !== 'string' || typeof value.sceneId !== 'string' || !Array.isArray(value.states) || !value.states.length || value.states.some(state => typeof state !== 'string')) throw new Error('Invalid preview consumption annotation: pageId, sceneId and nonempty states are required')
  const page = PREVIEW_CATALOG.find(page => page.id === value.pageId)
  const scene = page?.scenarios.find(scene => scene.id === value.sceneId)
  if (!page || !scene) throw new Error(`Unknown preview page/scene: ${value.pageId}/${value.sceneId}`)
  const states = value.states as string[]
  for (const state of states) if (!scene.states.includes(state)) throw new Error(`Unknown preview state: ${page.id}/${scene.id}/${state}`)
  return { pageId: page.id, sceneId: scene.id, states: [...new Set(states)] }
}

export function previewConsumption(pageId: string, sceneId: string, states: readonly string[]): { type: string; description: string } {
  return { type: PREVIEW_CONSUMPTION_ANNOTATION, description: JSON.stringify(consumption({ pageId, sceneId, states })) }
}

export function previewCoverage(report: unknown): PreviewCoverage[] {
  if (!record(report) || !Array.isArray(report.suites)) throw new Error('Invalid Playwright report: suites are required')
  if (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length)) throw new Error('Playwright report has collection errors')
  const consumers = new Map<string, PreviewConsumer[]>()
  const visit = (suite: unknown): void => {
    if (!record(suite)) throw new Error('Invalid Playwright suite')
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!record(spec)) throw new Error('Invalid Playwright spec')
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!record(test)) throw new Error('Invalid Playwright test')
        for (const annotation of Array.isArray(test.annotations) ? test.annotations : []) {
          if (!record(annotation) || annotation.type !== PREVIEW_CONSUMPTION_ANNOTATION) continue
          if (typeof annotation.description !== 'string') throw new Error('Invalid preview consumption annotation description')
          let parsed: unknown
          try { parsed = JSON.parse(annotation.description) }
          catch { throw new Error('Invalid preview consumption annotation JSON') }
          const declared = consumption(parsed)
          if (typeof spec.file !== 'string' || typeof spec.title !== 'string' || typeof test.projectName !== 'string') throw new Error('Invalid annotated Playwright test identity')
          const key = JSON.stringify([declared.pageId, declared.sceneId])
          const entries = consumers.get(key) ?? []
          entries.push({ file: spec.file, title: spec.title, project: test.projectName, states: declared.states })
          consumers.set(key, entries)
        }
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child)
  }
  visit(report)
  return PREVIEW_CATALOG.flatMap(page => page.scenarios.map(scene => {
    const entries = consumers.get(JSON.stringify([page.id, scene.id])) ?? []
    const asserted = new Set(entries.flatMap(entry => entry.states))
    const coveredStates = scene.states.filter(state => asserted.has(state))
    const missingStates = scene.states.filter(state => !asserted.has(state))
    const exclusion = page.implementation === 'alias' ? `Compatibility alias of ${page.aliasOf}`
      : page.implementation === 'placeholder' ? 'Historical navigation placeholder without an implemented independent surface' : undefined
    const reason = exclusion ?? (page.availability === 'native-only' ? 'Native execution requires a real Desktop host; shared renderer controls and shells remain required and are not excluded' : undefined)
    const status = exclusion ? 'excluded' : !entries.length ? 'unmapped' : missingStates.length ? 'partial' : 'has-tests'
    return { pageId: page.id, sceneId: scene.id, owner: page.owner, source: page.source, expected: scene.expected, limitations: scene.limitations, states: scene.states, status, ...(reason ? { reason } : {}), coveredStates, missingStates, consumers: entries } satisfies PreviewCoverage
  }))
}
