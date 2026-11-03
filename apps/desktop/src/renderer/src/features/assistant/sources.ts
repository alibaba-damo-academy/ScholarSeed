import type { ConvItem, MessageReference } from '../../model.ts'
import { submittedReferences } from '../../model.ts'

const PROJECT_SOURCE_BASE = 'https://project.invalid'
const RESOURCE_SOURCE_ROUTE = '/api/resource/raw'
const LITERATURE_SOURCE_ROUTE = '/api/v1/literatures/'
const SOURCE_LINE_FRAGMENT = /#L[1-9]\d*(?:-L?[1-9]\d*)?$/i
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//i
const WINDOWS_PATH_SEPARATOR = /\\/g

export function projectSource(
  href: string,
  projectId: string
): { kind: 'resource'; path: string } | { kind: 'literature'; id: string } | null {
  if (!href.startsWith('/api/')) return null
  try {
    const url = new URL(href, PROJECT_SOURCE_BASE)
    if (url.hash) return null
    if (url.pathname === RESOURCE_SOURCE_ROUTE) {
      const path = url.searchParams.get('path')
      if (
        url.searchParams.getAll('project').length !== 1 ||
        url.searchParams.get('project') !== projectId ||
        url.searchParams.getAll('path').length !== 1 ||
        !path ||
        /[\\\u0000-\u001f\u007f]/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        /^[a-z]:/i.test(path)
      )
        return null
      return { kind: 'resource', path }
    }
    if (url.pathname.startsWith(LITERATURE_SOURCE_ROUTE)) {
      const id = decodeURIComponent(url.pathname.slice(LITERATURE_SOURCE_ROUTE.length))
      if (
        url.searchParams.getAll('project_id').length !== 1 ||
        url.searchParams.get('project_id') !== projectId ||
        !id ||
        /[/\\\u0000-\u001f\u007f]/.test(id) ||
        id === '.' ||
        id === '..'
      )
        return null
      return { kind: 'literature', id }
    }
  } catch {
    return null
  }
  return null
}
export type TaskSourceKind = 'file' | 'external-resource' | 'tool' | 'web'
type SourceTool = Extract<ConvItem, { kind: 'tool' }>

export interface TaskSource {
  id: string
  kind: TaskSourceKind
  title: string
  reference?: MessageReference
  url?: string
  tools?: SourceTool[]
}

const toolPayloads = new WeakMap<
  SourceTool,
  { result: SourceTool['result']; payload: Record<string, unknown> | null }
>()
const sourceSnapshots = new WeakMap<ConvItem[], Map<string, readonly TaskSource[]>>()

export function sharedTaskSources(
  conversation: ConvItem[],
  projectId: string
): readonly TaskSource[] {
  let projects = sourceSnapshots.get(conversation)
  if (!projects) {
    projects = new Map()
    sourceSnapshots.set(conversation, projects)
  }
  let sources = projects.get(projectId)
  if (!sources) {
    sources = taskSources(conversation, projectId)
    projects.set(projectId, sources)
  }
  return sources
}

export function answerProjectSource(
  href: string,
  project: { id: string; path: string },
  sources: readonly TaskSource[]
): ReturnType<typeof projectSource> {
  const target = href.replace(SOURCE_LINE_FRAGMENT, '')
  const linked = projectSource(target, project.id)
  if (linked) return linked
  let path: string
  try {
    path = decodeURIComponent(target).replace(WINDOWS_PATH_SEPARATOR, '/')
  } catch {
    return null
  }
  if (/[#?\u0000-\u001f\u007f]/.test(path)) return null
  const root = project.path.replace(WINDOWS_PATH_SEPARATOR, '/').replace(/\/$/, '')
  const windows = WINDOWS_ABSOLUTE_PATH.test(root)
  const identity = (value: string): string => (windows ? value.toLowerCase() : value)
  if (path.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(path)) {
    if (!identity(path).startsWith(`${identity(root)}/`)) return null
    path = path.slice(root.length + 1)
  }
  path = path.replace(/^\.\//, '')
  if (path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..'))
    return null
  const resource = sources.find((source) => {
    const reference = source.reference
    return (
      reference?.kind === 'resource' &&
      identity(reference.sourceId ?? reference.path ?? reference.id) === identity(path)
    )
  })?.reference
  return resource
    ? { kind: 'resource', path: resource.sourceId ?? resource.path ?? resource.id }
    : null
}

function httpSource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

function sourcePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return sourcePayload(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        const payload = sourcePayload(block.text)
        if (payload) return payload
      }
    }
    return null
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function toolSourcePayload(tool: SourceTool): Record<string, unknown> | null {
  const cached = toolPayloads.get(tool)
  if (cached && cached.result === tool.result) return cached.payload
  const payload = sourcePayload(tool.result)
  toolPayloads.set(tool, { result: tool.result, payload })
  return payload
}

export function taskSources(conversation: ConvItem[], projectId: string): TaskSource[] {
  const sources = new Map<string, TaskSource>()
  const add = (source: TaskSource): void => {
    const previous = sources.get(source.id)
    sources.set(source.id, {
      ...previous,
      ...source,
      ...(source.tools ? { tools: [...(previous?.tools ?? []), ...source.tools] } : {}),
    })
  }
  const referenceSource = (reference: MessageReference): void => {
    const identity = reference.sourceId ?? reference.path ?? reference.id
    const kind = ['literature', 'literature_collection', 'session'].includes(reference.kind ?? '')
      ? 'external-resource'
      : 'file'
    const category =
      kind === 'file'
        ? reference.type === 'assistant_context'
          ? 'resource'
          : 'upload'
        : reference.kind
    add({ id: `${category}:${identity}`, kind, title: reference.title, reference })
  }
  const urlSource = (
    value: unknown,
    title?: string,
    kind: TaskSourceKind = 'external-resource'
  ): void => {
    const url = httpSource(value)
    if (url) add({ id: url, kind, title: title || url, url })
  }
  submittedReferences(conversation).forEach(referenceSource)
  for (const item of conversation) {
    if (item.kind === 'user' && !item.cancelled) {
      for (const match of item.text.matchAll(/https?:\/\/[^\s<>[\]()]+/g)) {
        urlSource(match[0])
      }
    }
    if (item.kind === 'web_search' && item.status === 'done') {
      item.results.forEach((result) => urlSource(result.url, result.title, 'web'))
    }
    if (item.kind === 'agent') {
      for (const source of item.answerSources ?? []) {
        if (source.kind === 'searched') urlSource(source.url, source.title, 'web')
      }
    }
    if (item.kind !== 'tool' || item.status !== 'done') continue
    const output = toolSourcePayload(item)
    if (item.exitCode || output?.ok === false) continue
    const mcp = /^mcp__(.+?)__(.+)$/.exec(item.name)
    if (mcp) {
      add({ id: `tool:${mcp[1]}`, kind: 'tool', title: mcp[1], tools: [item] })
    }
    if (typeof output?.source_url !== 'string') continue
    const source = projectSource(output.source_url, projectId)
    if (source?.kind === 'resource') {
      referenceSource({
        id: source.path,
        type: 'assistant_context',
        kind: 'resource',
        sourceId: source.path,
        title: source.path.split('/').at(-1) ?? source.path,
      })
    } else if (source?.kind === 'literature') {
      const title = sourcePayload(output.item)?.title
      referenceSource({
        id: source.id,
        type: 'assistant_context',
        kind: 'literature',
        sourceId: source.id,
        title: typeof title === 'string' ? title : source.id,
      })
    } else {
      urlSource(output.source_url, typeof output.title === 'string' ? output.title : undefined)
    }
  }
  return [...sources.values()]
}
