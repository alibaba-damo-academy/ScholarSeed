import type { ConvItem, DisplayCardData, SubagentProgress, TurnOutcome } from './model'

export type ActivityItem = Extract<
  ConvItem,
  {
    kind: 'thinking' | 'tool' | 'web_search' | 'paper_search' | 'skill' | 'native_activity'
  }
>
export type ArtifactItem = Extract<ConvItem, { kind: 'artifact' }>

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
    selectionEnabled: true,
  }
}

/**
 * User-facing published file kinds admitted to the generic Agent artifact card.
 *
 * Working files, runtime state, typed-card payloads and unknown machine formats
 * remain available in the durable artifact index but do not become conversation
 * UI merely because the Agent wrote a file.
 */
export const ARTIFACT_CARD_SUFFIXES: ReadonlySet<string> = new Set([
  'c',
  'cpp',
  'csv',
  'doc',
  'docx',
  'gif',
  'h',
  'java',
  'jpeg',
  'jpg',
  'js',
  'markdown',
  'md',
  'pdf',
  'png',
  'py',
  'r',
  'sh',
  'svg',
  'ts',
  'tsx',
  'txt',
  'webp',
  'xls',
  'xlsx',
])

export function artifactCardVisible(artifact: ArtifactItem['artifact']): boolean {
  if (!artifact.publication_id) return false
  if (artifact.role !== 'final' && artifact.role !== 'supporting') return false
  // Empty files (e.g. redirected stderr of a quiet subprocess) carry no result to open.
  if (artifact.size === 0) return false
  const name = artifact.name.split(/[\\/]/).pop() ?? ''
  const separator = name.lastIndexOf('.')
  if (separator < 0 || separator === name.length - 1) return false
  return ARTIFACT_CARD_SUFFIXES.has(name.slice(separator + 1).toLocaleLowerCase())
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
        row.kind === 'activity' &&
        row.turnId === turnId &&
        (row.tail || row.items.some((item) => 'status' in item && item.status === 'running'))
    )
  )
    return true
  const tail = rows.filter((row) => row.kind !== 'artifacts' && rowTurnId(row) === turnId).at(-1)
  return (
    tail?.kind === 'item' &&
    (tail.item.kind === 'agent' ||
      (tail.item.kind === 'thinking' && tail.item.commentary === true)) &&
    Boolean(tail.item.text.trim())
  )
}

/** Admission and native execution share one user-facing working indicator. */
export function workingIndicatorVisible(
  busy: boolean,
  admitting: boolean,
  pendingHilCount: number,
  hasVisibleProgress = false
): boolean {
  return (busy || admitting) && pendingHilCount === 0 && !hasVisibleProgress
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

function rowTurnId(row: ActivityRow): string | undefined {
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

export function activityRows(
  items: ConvItem[],
  outcomes?: Record<string, TurnOutcome>
): ActivityRow[] {
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
      rows.push({ kind: 'item', item, key: `item-${item.itemId || index}` })
      continue
    }

    const segment: ActivityItem[] = [item]
    while (
      index + 1 < items.length &&
      isGroupedActivity(items[index + 1]) &&
      items[index + 1].turnId === item.turnId
    ) {
      index += 1
      segment.push(items[index] as ActivityItem)
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
