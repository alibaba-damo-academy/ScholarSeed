import type {
  ConvItem,
  DisplayCardData,
  SubagentProgress,
  TurnOutcome,
  WebSearchAction,
  WebSearchResult,
} from './model'
import { artifactIsOutput } from './model.ts'
import { commandOutcome } from './command.ts'

export type ActivityItem = Extract<
  ConvItem,
  {
    kind: 'thinking' | 'tool' | 'web_search' | 'paper_search' | 'skill' | 'native_activity'
  }
>
export type ArtifactItem = Extract<ConvItem, { kind: 'artifact' }>

export const WEB_SEARCH_PRESENTATION = { previewCount: 3 } as const

export function webSearchPresentation(
  item: { query?: string; action: WebSearchAction; results: WebSearchResult[] },
  expanded: boolean,
  previewCount: number = WEB_SEARCH_PRESENTATION.previewCount
): { queries: string[]; results: WebSearchResult[]; hiddenCount: number; total: number } {
  const submitted = item.action.queries
  const queries =
    Array.isArray(submitted) && submitted.length
      ? submitted.filter(
          (query): query is string => typeof query === 'string' && Boolean(query.trim())
        )
      : [item.action.query || item.query || ''].filter(Boolean)
  const results = item.results.filter((result) => Boolean(result.title || result.url))
  const visible = expanded ? results : results.slice(0, Math.max(0, previewCount))
  return {
    queries,
    results: visible,
    hiddenCount: results.length - visible.length,
    total: results.length,
  }
}

type NativeActivity = Extract<ConvItem, { kind: 'native_activity' }>

const EXTERNAL_RESULT_PROTOCOLS = new Set(['http:', 'https:'])

export function externalResultUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return EXTERNAL_RESULT_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export function webSearchQuery(item: Extract<ConvItem, { kind: 'web_search' }>): string {
  if (item.query) return item.query
  if (typeof item.action.query === 'string') return item.action.query
  if (Array.isArray(item.action.queries)) return item.action.queries.join(' · ')
  if (typeof item.action.url === 'string') return item.action.url
  return ''
}

export function webSearchRecordData(item: Extract<ConvItem, { kind: 'web_search' }>) {
  const query = webSearchQuery(item)
  const url = typeof item.action.url === 'string' ? item.action.url : ''
  const actualQueries = Array.isArray(item.action.queries)
    ? item.action.queries.filter(
        (value): value is string => typeof value === 'string' && Boolean(value)
      )
    : []
  return {
    queries: actualQueries.length ? actualQueries : query ? [query] : [],
    page: url && url !== query ? url : undefined,
    pattern: typeof item.action.pattern === 'string' ? item.action.pattern : undefined,
    results: item.results
      .filter((result) => Boolean(result.title || result.url))
      .map((result, index) => {
        const externalUrl = externalResultUrl(result.url)
        return {
          id: JSON.stringify([result.url, index]),
          title: result.title || result.url || '',
          url: externalUrl ?? undefined,
          site:
            (typeof result.site_name === 'string' && result.site_name.trim()) ||
            (externalUrl ? new URL(externalUrl).hostname : undefined),
          publishedDate:
            typeof result.published_date === 'string'
              ? result.published_date.trim() || undefined
              : undefined,
          contentType:
            typeof result.content_type === 'string'
              ? result.content_type.trim() || undefined
              : undefined,
        }
      }),
  }
}

const COLLABORATION_OPERATIONS = {
  spawn_agent: 'spawn',
  spawnAgent: 'spawn',
  wait: 'wait',
  wait_agent: 'wait',
  waitAgent: 'wait',
} as const

export function collaborationStatusKey(item: NativeActivity) {
  if (item.activityType !== 'agent_collaboration') return undefined
  if (item.status === 'error') return 'subagent.call.failed' as const
  const operation = String(item.details.operation ?? '')
  const kind = COLLABORATION_OPERATIONS[operation as keyof typeof COLLABORATION_OPERATIONS]
  if (item.status === 'running') {
    if (kind === 'spawn') return 'subagent.call.spawning' as const
    if (kind === 'wait') return 'subagent.call.waiting' as const
    return 'subagent.call.running' as const
  }
  if (kind === 'spawn') return 'subagent.call.spawned' as const
  if (kind === 'wait') return 'subagent.call.waited' as const
  return 'subagent.call.ended' as const
}

export function subagentIdentities(items: readonly ConvItem[]): Map<string, string | number> {
  const identities = new Map<string, string | number>()
  const agents = items.filter(
    (item): item is NativeActivity =>
      item.kind === 'native_activity' && item.activityType === 'subagent_activity'
  )
  for (const item of agents) {
    if (!identities.has(item.activityId)) identities.set(item.activityId, identities.size + 1)
    const name = [item.details.display_name, item.details.agent_path].find(
      (value): value is string =>
        typeof value === 'string' &&
        Boolean(value.trim()) &&
        value.trim().toLowerCase() !== 'subagent'
    )
    if (name) identities.set(item.activityId, name.trim())
  }
  return identities
}

export function subagentActivityItem(
  progress: SubagentProgress,
  parent: Extract<ConvItem, { kind: 'native_activity' }>
): ActivityItem | null {
  const completed = progress.phase === 'completed'
  const settled = parent.status !== 'running'
  const ownership = {
    itemId: `${parent.activityId}:${progress.itemId}`,
    turnId: parent.turnId,
    startedAt: progress.startedAt ?? progress.observedAt,
    completedAt: progress.completedAt ?? (settled ? parent.completedAt : undefined),
    eventSeq: progress.eventSeq,
  }
  if (progress.activity === 'reasoning' && progress.summary) {
    return {
      ...ownership,
      kind: 'thinking',
      text: progress.summary,
      completed: completed || settled,
    }
  }
  if (!progress.tool) return null
  const tool = progress.tool
  const status = completed
    ? tool.status === 'cancelled' || tool.status === 'interrupted'
      ? 'cancelled'
      : tool.ok === true
        ? 'done'
        : 'error'
    : settled
      ? 'cancelled'
      : 'running'
  return {
    ...ownership,
    kind: 'tool',
    toolId: ownership.itemId,
    name: tool.name,
    input: tool.input,
    result: tool.output,
    status,
  }
}

export type ActivityRow =
  | { kind: 'item'; item: ConvItem; key: string }
  | { kind: 'activity'; items: ActivityItem[]; turnId?: string; tail: boolean; key: string }
  | { kind: 'artifacts'; items: ArtifactItem[]; turnId?: string; key: string }

export type ActivityRunState = 'running' | 'completed' | 'failed' | 'interrupted'

export interface ExecutionProcess {
  turnId: string
  indices: number[]
  rows: ActivityRow[]
}

export function fallbackDurationRows(rows: readonly ActivityRow[]): ReadonlySet<number> {
  const answered = new Set<string>()
  const lastRows = new Map<string, number>()
  rows.forEach((row, index) => {
    const turnId = rowTurnId(row)
    if (!turnId) return
    lastRows.set(turnId, index)
    if (row.kind === 'item' && row.item.kind === 'agent' && row.item.text.trim())
      answered.add(turnId)
  })
  return new Set([...lastRows].flatMap(([turnId, index]) => (answered.has(turnId) ? [] : [index])))
}

export function executionProcesses(rows: readonly ActivityRow[]): ExecutionProcess[] {
  const processes = new Map<string, ExecutionProcess>()
  rows.forEach((row, index) => {
    const included =
      row.kind === 'activity' ||
      (row.kind === 'item' && row.item.kind === 'thinking' && row.item.commentary === true)
    const turnId = rowTurnId(row)
    if (!included || !turnId) return
    const process = processes.get(turnId) ?? { turnId, indices: [], rows: [] }
    process.indices.push(index)
    process.rows.push(row)
    processes.set(turnId, process)
  })
  return [...processes.values()]
}

export function executionDisclosureOpen(userExpanded: boolean | null, running: boolean): boolean {
  return running || userExpanded === true
}

export function executionFailures(
  items: readonly ConvItem[],
  turnId: string | undefined
): Extract<ConvItem, { kind: 'tool' }>[] {
  if (!turnId) return []
  const resolved = new Set(
    items.flatMap((item) =>
      item.kind === 'tool' && item.turnId === turnId && item.status === 'done' && item.retryOf
        ? [item.retryOf]
        : []
    )
  )
  const failures = items.filter(
    (item): item is Extract<ConvItem, { kind: 'tool' }> =>
      item.kind === 'tool' &&
      item.turnId === turnId &&
      item.status === 'error' &&
      commandOutcome(item) !== 'noMatches' &&
      !(
        item.recoveredBy &&
        items.some(
          (recovery) =>
            recovery.kind === 'tool' &&
            recovery.toolId === item.recoveredBy &&
            recovery.turnId === item.turnId &&
            recovery.status === 'done'
        )
      ) &&
      !resolved.has(item.retryOf || item.toolId)
  )
  return [...new Map(failures.map((item) => [item.retryOf || item.toolId, item])).values()]
}

export type ProcessRow =
  | { kind: 'row'; row: ActivityRow; index: number; key: string }
  | {
      kind: 'process'
      entries: { row: ActivityRow; index: number }[]
      turnId: string
      key: string
      statusOwner: boolean
    }

export function processRows(rows: readonly ActivityRow[]): ProcessRow[] {
  const projected: ProcessRow[] = []
  const latest = new Map<string, Extract<ProcessRow, { kind: 'process' }>>()
  const candidate = (row: ActivityRow): boolean =>
    row.kind === 'activity' ||
    (row.kind === 'item' && row.item.kind === 'thinking' && row.item.commentary === true)
  for (let index = 0; index < rows.length;) {
    const first = rows[index]
    const turnId = rowTurnId(first)
    if (!turnId || !candidate(first)) {
      projected.push({ kind: 'row', row: first, index, key: first.key })
      index += 1
      continue
    }
    const entries: { row: ActivityRow; index: number }[] = []
    while (index < rows.length && rowTurnId(rows[index]) === turnId && candidate(rows[index])) {
      entries.push({ row: rows[index], index })
      index += 1
    }
    if (entries.some((entry) => entry.row.kind === 'activity')) {
      const previous = latest.get(turnId)
      if (previous) previous.statusOwner = false
      const section: Extract<ProcessRow, { kind: 'process' }> = {
        kind: 'process',
        entries,
        turnId,
        key: `process:${turnId}:${first.key}`,
        statusOwner: true,
      }
      latest.set(turnId, section)
      projected.push(section)
    } else {
      projected.push(
        ...entries.map((entry) => ({ kind: 'row' as const, ...entry, key: entry.row.key }))
      )
    }
  }
  return projected
}

export function cardArtifactIds(
  items: readonly ConvItem[],
  presentedArtifacts: (card: DisplayCardData) => readonly string[]
): ReadonlySet<string> {
  return new Set(
    items.flatMap((item) => (item.kind === 'display_card' ? presentedArtifacts(item.card) : []))
  )
}

export function visibleThinkingItem(
  items: ActivityItem[],
  running: boolean,
  tail: boolean
): Extract<ActivityItem, { kind: 'thinking' }> | undefined {
  const latest = items.at(-1)
  return running && tail && latest?.kind === 'thinking' ? latest : undefined
}

export function activityDisclosureOpen(userExpanded: boolean | null, autoExpand: boolean): boolean {
  return userExpanded ?? autoExpand
}

const LEGACY_TURN_IDENTITY = 'legacy'

export interface AnswerInteractionCapabilities {
  citationEnabled: boolean
  forkEnabled: boolean
  selectionEnabled: boolean
}

/**
 * Answer selection validates the chosen quote against the durable product text,
 * including during a running turn. Citation navigation still needs settled evidence.
 */
export function answerInteractionCapabilities(
  outcome: TurnOutcome | undefined
): AnswerInteractionCapabilities {
  return {
    citationEnabled: outcome !== 'running',
    forkEnabled: outcome === 'completed',
    selectionEnabled: true,
  }
}

export function artifactCardVisible(artifact: ArtifactItem['artifact']): boolean {
  return artifactIsOutput(artifact)
}

/** Resolve the card from turn truth; individual tool errors never fail a turn. */
export function activityRunState(
  outcome: TurnOutcome | undefined,
  itemRunning: boolean,
  itemCompleted = false,
  turnTail = true
): ActivityRunState {
  if (outcome === 'running') {
    // A running turn keeps exactly one live group: the tail that new activity
    // items still join, or any group whose own item is still running. Earlier
    // groups settled, so they freeze on their own result and clock instead of
    // inheriting the turn's elapsed time.
    return itemRunning || turnTail ? 'running' : 'completed'
  }
  // A terminal turn describes the unfinished tail of the turn. Activity groups
  // that already produced successful results keep their own completed state.
  if (itemCompleted && !itemRunning) return 'completed'
  if (outcome === 'failed' || outcome === 'unknown') return 'failed'
  if (outcome === 'interrupted') return 'interrupted'
  if (outcome === 'completed') return 'completed'
  return itemRunning ? 'running' : 'completed'
}

export function hasVisibleTurnProgress(rows: readonly ActivityRow[], turnId?: string): boolean {
  if (!turnId) return false
  if (
    rows.some(
      (row) =>
        (row.kind === 'item' &&
          row.item.turnId === turnId &&
          row.item.kind === 'status' &&
          row.item.compactionPhase === 'started') ||
        (row.kind === 'activity' &&
          row.turnId === turnId &&
          (row.tail || row.items.some((item) => 'status' in item && item.status === 'running')))
    )
  )
    return true
  const tail = rows.filter((row) => row.kind !== 'artifacts' && rowTurnId(row) === turnId).at(-1)
  return (
    tail?.kind === 'item' &&
    (tail.item.kind === 'agent' ||
      (tail.item.kind === 'thinking' && tail.item.commentary === true && !tail.item.completed)) &&
    Boolean(tail.item.text.trim())
  )
}

/** Admission and native execution share one user-facing working indicator. */
export function workingIndicatorVisible(
  busy: boolean,
  admitting: boolean,
  pendingHilCount: number,
  hasVisibleProgress = false,
  recoveryBlocked = false
): boolean {
  return !recoveryBlocked && (busy || admitting) && pendingHilCount === 0 && !hasVisibleProgress
}

function isGroupedActivity(item: ConvItem): item is ActivityItem {
  return (
    (item.kind === 'thinking' && item.commentary !== true) ||
    item.kind === 'tool' ||
    item.kind === 'web_search' ||
    item.kind === 'paper_search' ||
    item.kind === 'skill' ||
    item.kind === 'native_activity'
  )
}

export function activityIdentity(item: ActivityItem, fallback: number): string | number {
  if (item.itemId) return item.itemId
  if (item.kind === 'thinking') return item.eventSeq ?? fallback
  if (item.kind === 'tool') return item.toolId
  if (item.kind === 'web_search' || item.kind === 'paper_search') return item.searchId
  if (item.kind === 'skill') return item.skillId
  if (item.kind === 'native_activity') return item.activityId
  return fallback
}

export function rowTurnId(row: ActivityRow): string | undefined {
  return row.kind === 'item' ? row.item.turnId : row.turnId
}

function artifactDisplayIdentity(item: ArtifactItem): string {
  const path = item.artifact.saved_to || item.artifact.path
  const normalized = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
  return item.artifact.sha256
    ? `${normalized}\u0000${item.artifact.sha256}`
    : item.artifact.artifact_id
}

function artifactOrder(item: ArtifactItem): number {
  return item.artifact.source_event_seq ?? item.artifact.updated_at ?? 0
}

/** Keep publication snapshots intact; only collapse their presentation within a turn. */
export function artifactVersionGroups(items: readonly ArtifactItem[]): ArtifactItem[][] {
  const groups = new Map<string, ArtifactItem[]>()
  for (const item of items) {
    const path = item.artifact.path
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/{2,}/g, '/')
    const key = JSON.stringify(
      item.turnId && path ? [item.turnId, path] : [item.turnId, path, item.artifact.artifact_id]
    )
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const ordered = group
      .map((item, index) => ({ item, index }))
      .sort((a, b) => artifactOrder(b.item) - artifactOrder(a.item) || b.index - a.index)
    const seen = new Set<string>()
    return ordered.flatMap(({ item }) => {
      const revision = item.artifact.sha256 || item.artifact.artifact_id
      if (seen.has(revision)) return []
      seen.add(revision)
      return [item]
    })
  })
}

export function activityRows(
  items: ConvItem[],
  outcomes?: Record<string, TurnOutcome>,
  postDeliveryCardTypes: ReadonlySet<string> = new Set()
): ActivityRow[] {
  const postDeliveryCard = (item: ConvItem): boolean =>
    item.kind === 'display_card' && postDeliveryCardTypes.has(item.card.type)
  const artifactDeferred = (item: ArtifactItem): boolean =>
    Boolean(item.turnId && outcomes?.[item.turnId] === 'running')
  const reviewPaths = new Map<string, Set<string>>()
  for (const item of items) {
    if (item.kind !== 'review' || !item.turnId) continue
    const paths = reviewPaths.get(item.turnId) ?? new Set<string>()
    item.review.paths.forEach((path) => paths.add(path))
    reviewPaths.set(item.turnId, paths)
  }
  const reviewedArtifact = (item: ArtifactItem): boolean =>
    Boolean(
      item.turnId &&
      (item.artifact.saved_to || item.artifact.path) &&
      reviewPaths.get(item.turnId)?.has(item.artifact.saved_to || item.artifact.path)
    )
  const artifacts = new Map<string, Map<string, ArtifactItem>>()
  for (const item of items) {
    if (
      item.kind === 'artifact' &&
      !artifactDeferred(item) &&
      artifactCardVisible(item.artifact) &&
      item.turnId &&
      !reviewedArtifact(item) &&
      item.artifact.status !== 'deleted' &&
      item.artifact.change !== 'delete'
    ) {
      const group = artifacts.get(item.turnId) ?? new Map<string, ArtifactItem>()
      const identity = artifactDisplayIdentity(item)
      const current = group.get(identity)
      if (!current || artifactOrder(item) >= artifactOrder(current)) group.set(identity, item)
      artifacts.set(item.turnId, group)
    }
  }

  const emittedArtifacts = new Set<string>()
  const rows: ActivityRow[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'status' && item.turnBoundary && !item.text && !item.displayMessage) continue
    if (postDeliveryCard(item) && (!item.turnId || outcomes?.[item.turnId] !== 'completed'))
      continue
    if (item.kind === 'artifact' && artifactDeferred(item)) continue
    if (item.kind === 'artifact' && (!artifactCardVisible(item.artifact) || reviewedArtifact(item)))
      continue
    if (
      item.kind === 'artifact' &&
      (item.artifact.status === 'deleted' || item.artifact.change === 'delete')
    )
      continue
    if (item.kind === 'artifact' && item.turnId) {
      if (emittedArtifacts.has(item.turnId)) continue
      emittedArtifacts.add(item.turnId)
      rows.push({
        kind: 'artifacts',
        items: [...(artifacts.get(item.turnId)?.values() ?? [item])],
        turnId: item.turnId,
        key: `artifacts-${item.turnId}`,
      })
      continue
    }
    if (!isGroupedActivity(item)) {
      const identity =
        item.kind === 'hil' || item.kind === 'interaction_reply'
          ? `interaction-${item.requestId}`
          : `item-${item.itemId || index}`
      rows.push({ kind: 'item', item, key: identity })
      continue
    }

    const segment: ActivityItem[] = [item]
    let batchId = item.batchId
    while (
      index + 1 < items.length &&
      isGroupedActivity(items[index + 1]) &&
      items[index + 1].turnId === item.turnId &&
      (!batchId || !items[index + 1].batchId || items[index + 1].batchId === batchId)
    ) {
      index += 1
      segment.push(items[index] as ActivityItem)
      batchId ||= items[index].batchId
    }
    const identity = activityIdentity(item, index)
    rows.push({
      kind: 'activity',
      items: segment,
      turnId: item.turnId,
      tail: false,
      key: `activity-${item.turnId ?? LEGACY_TURN_IDENTITY}-${identity}`,
    })
  }
  // Keep every turn's files after that turn's content, independent of outcome.
  for (const [turnId] of artifacts) {
    const previous = rows.findIndex((row) => row.kind === 'artifacts' && row.turnId === turnId)
    if (previous < 0) continue
    const [artifactRow] = rows.splice(previous, 1)
    if (artifactRow.kind === 'artifacts') {
      artifactRow.items.sort((left, right) => artifactOrder(left) - artifactOrder(right))
    }
    let insertion = -1
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index]
      if (
        rowTurnId(candidate) === turnId &&
        !(candidate.kind === 'item' && candidate.item.kind === 'review')
      ) {
        insertion = index
        break
      }
    }
    rows.splice(insertion < 0 ? previous : insertion + 1, 0, artifactRow)
  }
  // Completion suggestions follow the entire delivery, including its file cards.
  // Keep them inside their own turn when replay includes later user messages.
  const postDeliveryRows = rows.filter((row) => row.kind === 'item' && postDeliveryCard(row.item))
  for (const row of postDeliveryRows) rows.splice(rows.indexOf(row), 1)
  for (const row of postDeliveryRows) {
    const turnId = rowTurnId(row)
    let anchor = -1
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rowTurnId(rows[index]) === turnId) {
        anchor = index
        break
      }
    }
    if (anchor >= 0) rows.splice(anchor + 1, 0, row)
    else {
      // A card-only turn has no delivery anchor; preserve its chronological position.
      const sourceIndex = row.kind === 'item' ? items.indexOf(row.item) : -1
      const following = rows.findIndex(
        (candidate) => candidate.kind === 'item' && items.indexOf(candidate.item) > sourceIndex
      )
      rows.splice(following < 0 ? rows.length : following, 0, row)
    }
  }
  // A terminal failure is the turn's bottom-line outcome. Retry diagnostics can
  // reach the renderer before the last reasoning/activity rows, but their event
  // arrival order must not place the outcome above the work it summarizes.
  for (const [turnId, outcome] of Object.entries(outcomes ?? {})) {
    if (outcome !== 'failed' && outcome !== 'unknown') continue
    const failures = rows.filter(
      (row) => row.kind === 'item' && row.item.kind === 'error' && row.item.turnId === turnId
    )
    if (failures.length === 0) continue
    const firstFailure = rows.findIndex((row) => failures.includes(row))
    const withoutFailures = rows.filter((row) => !failures.includes(row))
    let lastOwned = -1
    for (let index = withoutFailures.length - 1; index >= 0; index -= 1) {
      if (rowTurnId(withoutFailures[index]) === turnId) {
        lastOwned = index
        break
      }
    }
    withoutFailures.splice(lastOwned < 0 ? firstFailure : lastOwned + 1, 0, ...failures)
    rows.splice(0, rows.length, ...withoutFailures)
  }
  // Only a turn's last content group can still receive new activity items, so
  // it is the only group a running turn may keep in the live state. Artifacts
  // rows are a relocated display bucket and never host activity items.
  const liveTails = new Set<string>()
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.kind === 'artifacts') continue
    const turnId = rowTurnId(row) ?? LEGACY_TURN_IDENTITY
    if (liveTails.has(turnId)) continue
    liveTails.add(turnId)
    if (row.kind === 'activity') row.tail = true
  }
  return rows
}
