// transcript.ts — server history projection shared by session resume and rewind.

import type {
  HistoryMessageReference,
  HistoryResult,
  HistoryTurn,
  ProductEvent,
  TurnActivitySnapshot,
} from './api'
import {
  isTurnBoundary,
  type ConvItem,
  type ModelRun,
  type DisplayCardData,
  type MessageReference,
  type SessionArtifact,
  type SubagentProgress,
  type TurnOwned,
  type Thread,
} from './model.ts'
import { pendingAssistantContextRefs, type AssistantContextRef } from './contracts/assistant.ts'
import type { DisplayCardSupersessionPosition } from './contracts/features'
import { feedback } from './contracts/feedback.ts'
import { describeTurnFailure, sameTurnFailureMessage } from './failures.ts'
import {
  browserApprovalResolution,
  browserHistoryApprovalResolution,
  projectHilCard,
  hilEventResolution,
  hilTimestamp,
  isQuestionHil,
  type HilItem,
} from './hil.ts'

const LEGACY_PREVIEW_DELIVERY_ID_PREFIX = 'legacy-preview'
const STREAM_IDENTITY_SEPARATOR = '::'
const EVENT_SECONDS_TO_MILLISECONDS = 1000
const USER_INTERRUPTED_PRESENTATION = {
  tone: 'experience' as const,
  hideIcon: true,
  displayMessage: feedback('components', 'stream.stopped'),
}
const TURN_INTERRUPTED_PRESENTATIONS: Record<
  string,
  Pick<Extract<ConvItem, { kind: 'status' }>, 'tone' | 'hideIcon' | 'displayMessage'>
> = {
  process_exit: {
    tone: 'tension',
    hideIcon: false,
    displayMessage: feedback('components', 'stream.runtimeInterrupted'),
  },
}
const ARTIFACT_FAILURE_KEYS = {
  artifact_publish_file_not_found: 'artifactFailure.missing',
  artifact_snapshot_source_changed: 'artifactFailure.changed',
  artifact_declaration_conflict: 'artifactFailure.conflict',
} as const

export function projectArtifactFailure(
  items: ConvItem[],
  event: Extract<ProductEvent, { type: 'artifact_failed' }>
): ConvItem[] {
  if (items.some((item) => item.kind === 'status' && item.eventSeq === event.seq)) return items
  return insertTurnRuntimeItem(items, {
    kind: 'status',
    text: {
      key: Object.prototype.hasOwnProperty.call(ARTIFACT_FAILURE_KEYS, event.data.code)
        ? ARTIFACT_FAILURE_KEYS[event.data.code as keyof typeof ARTIFACT_FAILURE_KEYS]
        : 'artifactFailure.invalid',
    },
    tone: 'tension',
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
  })
}
const STEER_MESSAGE_LABEL = '已用于当前任务'

function recoveryStatus(
  identity: TurnOwned,
  cancelled: boolean
): Extract<ConvItem, { kind: 'status' }> {
  return {
    kind: 'status',
    turnBoundary: true,
    text: '',
    tone: 'experience',
    displayMessage: feedback(
      'components',
      cancelled ? 'stream.automaticRecoveryCancelled' : 'stream.automaticRecovery'
    ),
    retainOnHistoryRefresh: true,
    ...identity,
  }
}

function eventTimestampMs(event: ProductEvent): number {
  return event.ts * EVENT_SECONDS_TO_MILLISECONDS
}

type StreamItemKind = Extract<ConvItem, { kind: 'agent' | 'thinking' }>['kind']

type ReasoningEvent = Extract<ProductEvent, { type: 'reasoning_delta' | 'reasoning_completed' }>
const REASONING_PART_SEPARATOR = '\n\n'

export function projectReasoningEvent(items: ConvItem[], event: ReasoningEvent): ConvItem[] {
  const current = items.find(
    (item) =>
      item.kind === 'thinking' && item.turnId === event.turn_id && item.itemId === event.item_id
  )
  if (
    current?.kind === 'thinking' &&
    (current.completed || (current.reasoningSeq ?? -1) >= event.seq)
  )
    return items
  if (event.type === 'reasoning_completed') {
    return items.map((item) =>
      item === current && item.kind === 'thinking'
        ? {
            ...item,
            completed: true,
            completedAt: eventTimestampMs(event),
            reasoningSeq: event.seq,
          }
        : item
    )
  }
  if (!event.data.delta) return items
  const summaryIndex = event.data.summary_index
  const separator =
    current?.kind === 'thinking' &&
    current.text &&
    summaryIndex !== undefined &&
    current.summaryIndex !== undefined &&
    summaryIndex !== current.summaryIndex
      ? REASONING_PART_SEPARATOR
      : ''
  const projected = projectStreamDelta(
    items,
    'thinking',
    separator + event.data.delta,
    event.turn_id,
    event.item_id,
    false,
    event.seq,
    undefined,
    eventTimestampMs(event)
  ).map((item) =>
    item.kind === 'thinking' && item.turnId === event.turn_id && item.itemId === event.item_id
      ? { ...item, summaryIndex, reasoningSeq: event.seq }
      : item
  )
  if (!current) {
    const created = projected.find(
      (item) =>
        item.kind === 'thinking' && item.turnId === event.turn_id && item.itemId === event.item_id
    )
    if (created) return insertTurnRuntimeItem(items, created)
  }
  return projected
}

/** Keep directive buffers isolated for every native stream item in one turn. */
export function streamItemIdentity(
  threadId: string,
  kind: StreamItemKind,
  turnId: string | undefined,
  itemId: string | undefined
): string {
  return [threadId, kind, turnId ?? '', itemId ?? ''].join(STREAM_IDENTITY_SEPARATOR)
}

/** Project one live text delta without merging distinct native items in the same turn. */
export function projectStreamDelta(
  items: ConvItem[],
  kind: StreamItemKind,
  text: string,
  turnId: string | undefined,
  itemId: string | undefined,
  replace: boolean = kind === 'agent',
  eventSeq?: number,
  modelRun?: ModelRun,
  timestamp?: number
): ConvItem[] {
  const conversation = [...items]
  const stableIndexes = itemId
    ? conversation.flatMap((candidate, index) =>
        (candidate.kind === 'agent' || candidate.kind === 'thinking') &&
        candidate.turnId === turnId &&
        candidate.itemId === itemId
          ? [index]
          : []
      )
    : []
  let index = stableIndexes[0] ?? -1
  if (!itemId) {
    index = conversation.length - 1
    while (index >= 0) {
      const candidate = conversation[index]
      const sameIdentity = candidate?.itemId === undefined && candidate?.turnId === turnId
      if (candidate?.kind === kind && candidate.turnId === turnId && sameIdentity) break
      index -= 1
    }
  }
  const candidate = conversation[index]
  if (index >= 0 && candidate?.kind === kind) {
    conversation[index] = {
      ...candidate,
      ...(kind === 'agent' && modelRun ? { modelRun } : {}),
      text: replace ? text : candidate.text + text,
      ...(candidate.eventSeq !== undefined || eventSeq !== undefined
        ? { eventSeq: candidate.eventSeq ?? eventSeq }
        : {}),
      ...(kind === 'thinking' && replace ? { commentary: true as const } : {}),
      ...(kind === 'thinking' && timestamp !== undefined ? { completedAt: timestamp } : {}),
    }
    for (const duplicateIndex of stableIndexes.slice(1).reverse())
      conversation.splice(duplicateIndex, 1)
    return conversation
  }
  if (index >= 0 && (candidate?.kind === 'agent' || candidate?.kind === 'thinking')) {
    conversation[index] =
      kind === 'thinking'
        ? {
            kind,
            text,
            turnId,
            itemId,
            ...(candidate.eventSeq !== undefined || eventSeq !== undefined
              ? { eventSeq: candidate.eventSeq ?? eventSeq }
              : {}),
            ...(timestamp !== undefined ? { startedAt: timestamp, completedAt: timestamp } : {}),
            ...(replace ? { commentary: true as const } : {}),
          }
        : {
            kind,
            text,
            turnId,
            itemId,
            ...(modelRun ? { modelRun } : {}),
            ...(candidate.eventSeq !== undefined || eventSeq !== undefined
              ? { eventSeq: candidate.eventSeq ?? eventSeq }
              : {}),
          }
    for (const duplicateIndex of stableIndexes.slice(1).reverse())
      conversation.splice(duplicateIndex, 1)
    return conversation
  }
  if (!text) return conversation

  const item: ConvItem =
    kind === 'thinking'
      ? {
          kind,
          text,
          turnId,
          itemId,
          ...(eventSeq !== undefined ? { eventSeq } : {}),
          ...(timestamp !== undefined ? { startedAt: timestamp, completedAt: timestamp } : {}),
          ...(replace ? { commentary: true as const } : {}),
        }
      : {
          kind,
          text,
          turnId,
          itemId,
          ...(modelRun ? { modelRun } : {}),
          ...(eventSeq !== undefined ? { eventSeq } : {}),
        }
  const artifactIndex =
    kind === 'agent'
      ? conversation.findIndex((row) => row.kind === 'artifact' && row.turnId === turnId)
      : -1
  if (artifactIndex >= 0) conversation.splice(artifactIndex, 0, item)
  else conversation.push(item)
  return conversation
}

/** Convert the durable Delivery payload once for both history restoration and SSE. */
export function projectDelivery(
  delivery: NonNullable<HistoryTurn['delivery']>
): Extract<ConvItem, { kind: 'delivery' }> {
  return {
    kind: 'delivery',
    delivery: {
      deliveryId: delivery.delivery_id ?? '',
      label: delivery.label ?? '',
      ...(delivery.label == null ? { labelFallback: 'current' as const } : {}),
      status: delivery.status ?? 'published',
      previousDeliveryId: delivery.previous_delivery_id ?? null,
      members: (delivery.members ?? []).map((member) => ({
        materialId: member.material_id ?? '',
        title: member.title ?? '',
        ...(member.title == null ? { titleFallback: true as const } : {}),
        workspacePath: member.workspace_path ?? '',
        mediaType: member.media_type ?? 'text/plain',
        previewAvailable: member.preview_available,
        previewUrl: member.preview_url,
        revision: member.revision ?? '',
        versionId: member.version_id ?? '',
        previousRevision: member.previous_revision ?? null,
        primary: Boolean(member.is_primary),
      })),
    },
  }
}

/** Project pre-Delivery snapshots through the only material-card presentation. */
function projectLegacyPreview(
  preview: NonNullable<HistoryTurn['preview']>
): Extract<ConvItem, { kind: 'delivery' }> {
  const title = preview.title ?? preview.path ?? ''
  const titleFallback = preview.title == null && preview.path == null
  const revision = preview.revision_id ?? ''
  const identity =
    preview.material_id || preview.path || revision || (titleFallback ? '未命名产物' : title)
  return {
    kind: 'delivery',
    delivery: {
      deliveryId: `${LEGACY_PREVIEW_DELIVERY_ID_PREFIX}:${identity}:${revision}`,
      label: '',
      labelFallback: 'legacy',
      status: 'legacy_preview',
      members: [
        {
          materialId: preview.material_id ?? '',
          title,
          ...(titleFallback ? { titleFallback: true as const } : {}),
          workspacePath: preview.path ?? '',
          mediaType: preview.media_type ?? 'text/plain',
          previewAvailable: Boolean(preview.path && revision),
          revision,
          versionId: revision,
          primary: true,
        },
      ],
    },
  }
}

function historyToolStatus(turn: HistoryTurn): 'running' | 'done' | 'error' | 'cancelled' {
  if (turn.status === 'cancelled') return 'cancelled'
  if (turn.status === 'error' || turn.ok === false) return 'error'
  if (turn.status === 'done') return 'done'
  if (turn.status === 'pending') return 'running'
  // 旧 history 没有显式 status。只有真实 output 才能证明旧工具轮已返回；
  // `ok=true + output 缺失` 也是旧版对悬空 tool_use 的错误默认值，必须按 pending 恢复。
  return turn.ok === true && turn.output != null ? 'done' : 'running'
}

function turnIdentity(turn: HistoryTurn): TurnOwned {
  return {
    turnId: turn.turn_id || undefined,
    itemId: turn.item_id || undefined,
  }
}

function projectMessageReferences(
  references: HistoryMessageReference[] | undefined
): MessageReference[] | undefined {
  if (!references?.length) return undefined
  return references.map((reference) => ({
    type: reference.type,
    id: reference.id,
    title: reference.title,
    ...(reference.selection_source_label !== undefined
      ? { selection_source_label: reference.selection_source_label }
      : {}),
    ...(reference.label_fallback !== undefined ? { label_fallback: reference.label_fallback } : {}),
    status: reference.status,
    path: reference.path,
    mediaType: reference.media_type,
    sha256: reference.sha256,
    size: reference.size,
    ...(reference.kind ? { kind: reference.kind } : {}),
    ...(reference.source_id ? { sourceId: reference.source_id } : {}),
    ...(reference.snapshot_id ? { snapshotId: reference.snapshot_id } : {}),
    ...(reference.source_revision !== undefined
      ? { sourceRevision: reference.source_revision }
      : {}),
    ...(reference.estimate
      ? {
          estimate: {
            lowerSeconds: reference.estimate.lower_seconds,
            upperSeconds: reference.estimate.upper_seconds,
            sampleCount: reference.estimate.sample_count,
            confidence: reference.estimate.confidence,
            basis: reference.estimate.basis,
            modelId: reference.model_id,
            reasoningEffort: reference.reasoning_effort,
          },
        }
      : {}),
    ...(reference.anchor
      ? {
          anchor: {
            ...(reference.anchor.document_id ? { documentId: reference.anchor.document_id } : {}),
            previewText: reference.anchor.preview_text,
            locator: reference.anchor.locator,
          },
        }
      : {}),
  }))
}

/** Client-side projection of panel context refs for the optimistic user bubble. */
export function projectAssistantContextRefs(
  refs: readonly AssistantContextRef[],
  submittedRefIds: readonly string[]
): MessageReference[] {
  return pendingAssistantContextRefs(refs, submittedRefIds).map((ref): MessageReference => ({
    type: 'assistant_context',
    id: ref.ref_id,
    title: ref.label,
    kind: ref.kind,
    sourceId: ref.source_id,
    ...(ref.label_fallback ? { label_fallback: ref.label_fallback } : {}),
    ...(ref.selection_source_label != null
      ? { selection_source_label: ref.selection_source_label }
      : {}),
    ...(ref.source_revision != null ? { sourceRevision: ref.source_revision } : {}),
    ...(ref.anchor
      ? {
          anchor: {
            ...(ref.anchor.document_id ? { documentId: ref.anchor.document_id } : {}),
            previewText: ref.anchor.preview_text,
            locator: ref.anchor.locator,
          },
        }
      : {}),
  }))
}

export function isUserHistoryTurn(turn: Pick<HistoryTurn, 'kind' | 'role'>): boolean {
  return turn.kind === 'user' || (turn.kind === 'text' && turn.role === 'user')
}

/** Rebuild server transcript turns into Desktop conversation items. */
export function projectHistory(turns: HistoryTurn[]): ConvItem[] {
  const out: ConvItem[] = []
  let toolIndex = 0
  for (const turn of turns) {
    const text = turn.text ?? ''
    const identity = turnIdentity(turn)
    if (turn.kind === 'thinking') {
      out.push({
        kind: 'thinking',
        text,
        ...(turn.phase === 'commentary' ? { commentary: true as const } : {}),
        ...identity,
      })
    } else if (turn.kind === 'preview' && turn.preview) {
      out.push({ ...projectLegacyPreview(turn.preview), ...identity })
    } else if (turn.kind === 'delivery' && turn.delivery) {
      out.push({ ...projectDelivery(turn.delivery), ...identity })
    } else if (turn.kind === 'tool') {
      out.push({
        kind: 'tool',
        toolId: turn.item_id || `hist-${toolIndex++}-${turn.tool ?? 'tool'}`,
        name: turn.tool ?? 'tool',
        status: historyToolStatus(turn),
        input: turn.input,
        result: turn.output ?? undefined,
        exitCode: turn.exit_code,
        ...identity,
      })
    } else if (isUserHistoryTurn(turn)) {
      if (turn.origin === 'recovery') {
        out.push(recoveryStatus(identity, turn.status === 'cancelled'))
        continue
      }
      out.push({
        kind: 'user',
        text,
        ...(turn.status === 'cancelled' ? { cancelled: true as const } : {}),
        rewindAnchor: turn.rewind_anchor,
        refs: projectMessageReferences(turn.refs),
        ...(turn.origin === 'steer'
          ? { steer: true as const, steerLabel: STEER_MESSAGE_LABEL }
          : {}),
        ...identity,
      })
    } else if (turn.kind === 'text') {
      const evidence = turn.evidence?.length ? turn.evidence : undefined
      const evidenceNotice = turn.evidence_notice || undefined
      out.push(
        turn.name
          ? {
              kind: 'agent',
              text,
              who: turn.name,
              evidence,
              evidenceNotice,
              modelRun: turn.model_run,
              ...identity,
            }
          : { kind: 'agent', text, evidence, evidenceNotice, modelRun: turn.model_run, ...identity }
      )
    }
  }
  return out
}

/** Keep the completed turn's final assistant reply below every owned card.
 *
 * Native App Server activity can finish publishing after the final assistant
 * item has already arrived. Product event sequence remains authoritative for
 * technical activity, but presentation semantics require the last assistant
 * item of a completed turn to remain the user's bottom-line conclusion. Only
 * explicitly completed turns are passed here, so running, failed and
 * interrupted timelines retain their exact live order.
 */
export function placeFinalAssistantLast(
  items: ConvItem[],
  completedTurnIds: Iterable<string | undefined>
): ConvItem[] {
  const projected = [...items]
  for (const turnId of completedTurnIds) {
    if (!turnId) continue
    let finalIndex = -1
    let lastOwnedIndex = -1
    for (let index = 0; index < projected.length; index += 1) {
      const item = projected[index]
      if (item.turnId !== turnId) continue
      lastOwnedIndex = index
      if (item.kind === 'agent') finalIndex = index
    }
    if (finalIndex >= 0 && finalIndex !== lastOwnedIndex) {
      const [finalAssistant] = projected.splice(finalIndex, 1)
      lastOwnedIndex = -1
      for (let index = 0; index < projected.length; index += 1) {
        if (projected[index].turnId === turnId) {
          lastOwnedIndex = index
        }
      }
      projected.splice(lastOwnedIndex + 1, 0, finalAssistant)
    }
  }
  return projected
}

/** Reconcile a durable user-message event with the optimistic user bubble. */
export function upsertUserMessageEvent(
  items: ConvItem[],
  event: Extract<ProductEvent, { type: 'user_message' }>
): ConvItem[] {
  if (event.data.origin === 'recovery') {
    const itemId = event.item_id || event.data.client_turn_id
    const status = recoveryStatus(
      {
        itemId,
        turnId: event.turn_id || event.data.client_turn_id,
        eventSeq: event.seq,
      },
      event.data.binding === 'cancelled'
    )
    const index = items.findIndex((item) => item.itemId === itemId)
    if (index < 0) return insertTurnRuntimeItem(items, { ...status, bindingSeq: event.seq })
    const previous = items[index]
    if (previous.kind !== 'status') return items
    if ((previous.bindingSeq ?? previous.eventSeq ?? -1) > event.seq) return items
    return items.map((item, position) =>
      position === index
        ? { ...status, eventSeq: previous.eventSeq ?? event.seq, bindingSeq: event.seq }
        : item
    )
  }
  const refs = projectMessageReferences(event.data.refs)
  const index = items.findIndex(
    (item) =>
      item.kind === 'user' &&
      (item.turnId === event.data.client_turn_id ||
        (Boolean(event.turn_id) && item.turnId === event.turn_id) ||
        item.itemId === event.data.client_turn_id ||
        (Boolean(event.item_id) && item.itemId === event.item_id))
  )
  let fallback = index
  if (fallback < 0) {
    for (let candidate = items.length - 1; candidate >= 0; candidate -= 1) {
      const item = items[candidate]
      if (item.kind === 'user' && !item.turnId && item.text === event.data.text) {
        fallback = candidate
        break
      }
    }
  }
  if (fallback >= 0) {
    const current = items[fallback]
    if (current.kind !== 'user') return items
    const reconciled = {
      ...current,
      text: event.data.text,
      refs,
      ...(event.data.binding === 'cancelled' ? { cancelled: true as const } : {}),
      ...(event.data.origin === 'steer'
        ? { steer: true as const, steerLabel: STEER_MESSAGE_LABEL }
        : {}),
      turnId:
        event.turn_id ||
        (event.data.binding === 'cancelled' ? event.data.client_turn_id : current.turnId),
      itemId: event.item_id || current.itemId,
    }
    return items.flatMap((item, itemIndex) => {
      if (itemIndex === fallback) return [reconciled]
      if (item.kind === 'user' && reconciled.itemId && item.itemId === reconciled.itemId) return []
      return [item]
    })
  }
  return [
    ...items,
    {
      kind: 'user',
      text: event.data.text,
      refs,
      ...(event.data.binding === 'cancelled' ? { cancelled: true as const } : {}),
      ...(event.data.origin === 'steer'
        ? { steer: true as const, steerLabel: STEER_MESSAGE_LABEL }
        : {}),
      turnId:
        event.turn_id ||
        (event.data.binding === 'cancelled' ? event.data.client_turn_id : undefined),
      itemId:
        event.item_id ||
        (event.data.binding === 'cancelled' ? event.data.client_turn_id : undefined),
    },
  ]
}

/** Add one local user bubble before the durable user-message event arrives. */
export function appendOptimisticUserMessage(
  items: ConvItem[],
  message: Extract<ConvItem, { kind: 'user' }>
): ConvItem[] {
  if (
    message.itemId &&
    items.some((item) => item.kind === 'user' && item.itemId === message.itemId)
  )
    return items
  return [...items, message]
}

/** Roll back only an unbound local bubble after the server proves it was not applied. */
export function removeOptimisticUserMessage(
  items: ConvItem[],
  clientUserMessageId: string
): ConvItem[] {
  return items.filter(
    (item) => !(item.kind === 'user' && item.itemId === clientUserMessageId && !item.turnId)
  )
}

export function resolveHilItem(
  items: ConvItem[],
  requestId: string,
  patch: Partial<HilItem>,
  eventSeq?: number
): ConvItem[] {
  const previous = items.find(
    (item): item is HilItem => item.kind === 'hil' && item.requestId === requestId
  )
  if (!previous) return items
  const resolved = { ...previous, ...patch }
  const hasAnswer =
    isQuestionHil(resolved) &&
    resolved.hilState === 'resolved' &&
    Object.keys(resolved.answers ?? {}).length > 0
  if (!hasAnswer || (eventSeq === undefined && previous.hilState === 'resolved')) {
    return items.map((item) => (item === previous ? resolved : item))
  }
  const remaining = items.filter((item) => item !== previous)
  const positioned = { ...resolved, eventSeq }
  return eventSeq === undefined
    ? [...remaining, positioned]
    : insertTurnRuntimeItem(remaining, positioned)
}

export function insertTurnRuntimeItem(items: ConvItem[], runtimeItem: ConvItem): ConvItem[] {
  if (runtimeItem.kind === 'status' && runtimeItem.turnBoundary && runtimeItem.turnId) {
    const ownedIndex = items.findIndex((item) => item.turnId === runtimeItem.turnId)
    if (ownedIndex >= 0)
      return [...items.slice(0, ownedIndex), runtimeItem, ...items.slice(ownedIndex)]
  }
  if (runtimeItem.eventSeq !== undefined) {
    let nextIndex = items.findIndex(
      (item) => item.eventSeq !== undefined && item.eventSeq > runtimeItem.eventSeq!
    )
    if (nextIndex >= 0) {
      const ownedIndex = runtimeItem.turnId
        ? items.findIndex((item) => item.turnId === runtimeItem.turnId)
        : -1
      if (ownedIndex >= 0) {
        const ownBoundaryIndex = items.findIndex(
          (item) => item.turnId === runtimeItem.turnId && isTurnBoundary(item)
        )
        const boundaryIndex = items.findIndex(
          (item, index) =>
            index > ownedIndex && item.turnId !== runtimeItem.turnId && isTurnBoundary(item)
        )
        if (boundaryIndex >= 0) nextIndex = Math.min(nextIndex, boundaryIndex)
        if (ownBoundaryIndex >= 0 && !(runtimeItem.kind === 'status' && runtimeItem.turnBoundary)) {
          nextIndex = Math.max(nextIndex, ownBoundaryIndex + 1)
        }
      }
      return [...items.slice(0, nextIndex), runtimeItem, ...items.slice(nextIndex)]
    }
  }
  if (!runtimeItem.turnId) return [...items, runtimeItem]

  if (runtimeItem.eventSeq !== undefined) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.turnId === runtimeItem.turnId && item.eventSeq !== undefined) {
        return [...items.slice(0, index + 1), runtimeItem, ...items.slice(index + 1)]
      }
    }
  }

  if (
    runtimeItem.kind === 'hil' ||
    runtimeItem.kind === 'thinking' ||
    runtimeItem.kind === 'tool' ||
    runtimeItem.kind === 'web_search' ||
    runtimeItem.kind === 'paper_search' ||
    runtimeItem.kind === 'skill' ||
    runtimeItem.kind === 'native_activity'
  ) {
    // Replayed HIL and technical activity belong before the turn's final
    // assistant reply, while preserving same-turn runtime ordering.
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.turnId === runtimeItem.turnId && item.kind === 'agent') {
        return [...items.slice(0, index), runtimeItem, ...items.slice(index)]
      }
    }
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].turnId === runtimeItem.turnId) {
      return [...items.slice(0, index + 1), runtimeItem, ...items.slice(index + 1)]
    }
  }
  // Legacy or partially migrated history has no matching anchor. Append the
  // row as unassociated runtime state; never assign it to a neighbouring turn.
  return [...items, runtimeItem]
}

type WebSearchEvent = Extract<
  ProductEvent,
  {
    type: 'web_search_started' | 'web_search_completed'
  }
>
type WebSearchPlacement = 'history' | 'live'
type PaperSearchEvent = Extract<
  ProductEvent,
  {
    type: 'paper_search_started' | 'paper_search_completed'
  }
>
type PaperSearchPlacement = 'history' | 'live'
export type NativeActivityEvent = Extract<
  ProductEvent,
  {
    type: 'native_activity_started' | 'native_activity_completed'
  }
>
type SubagentActivityEvent = Extract<
  ProductEvent,
  {
    type:
      | 'subagent_spawned'
      | 'subagent_started'
      | 'subagent_status_changed'
      | 'subagent_completed'
      | 'subagent_failed'
      | 'subagent_interrupted'
  }
>
type NativeActivityPlacement = 'history' | 'live'
type SkillActivityEvent = Extract<
  ProductEvent,
  {
    type: 'skill_started' | 'skill_completed'
  }
>
type SkillActivityPlacement = 'history' | 'live'

/** Normalize every lifecycle update for one subagent onto one stable activity identity. */
export function projectSubagentActivity(event: SubagentActivityEvent): NativeActivityEvent {
  const completed =
    event.type === 'subagent_completed' ||
    event.type === 'subagent_failed' ||
    event.type === 'subagent_interrupted'
  return {
    ...event,
    type: completed ? 'native_activity_completed' : 'native_activity_started',
    data: {
      activity_id: event.data.subagent_id,
      activity_type: 'subagent_activity',
      category: 'collaboration',
      status: event.data.status || event.type.replace('subagent_', ''),
      success: event.type === 'subagent_completed',
      details: {
        ...(event.data.details ?? {}),
        last_observed_at: eventTimestampMs(event),
        agent_path: event.data.agent_path,
        display_name: event.data.display_name,
        parent_agent_id: event.data.parent_agent_id,
        native_agent_session_id: event.data.native_agent_session_id,
      },
    },
  }
}

/** Upsert one native Codex web-search item at its live or durable-history position. */
export function projectWebSearchEvent(
  items: ConvItem[],
  event: WebSearchEvent,
  placement: WebSearchPlacement = 'history'
): ConvItem[] {
  const index = items.findIndex(
    (item) =>
      item.kind === 'web_search' &&
      item.searchId === event.data.search_id &&
      item.turnId === event.turn_id
  )
  if (index >= 0) {
    const current = items[index]
    if (current.kind !== 'web_search') return items
    const next = [...items]
    next[index] = {
      ...current,
      query: event.data.query || current.query,
      action: event.data.action ?? current.action,
      status: event.type === 'web_search_completed' ? 'done' : current.status,
      results: event.type === 'web_search_completed' ? (event.data.results ?? []) : current.results,
      resultCount:
        event.type === 'web_search_completed' ? event.data.result_count : current.resultCount,
      eventSeq: current.eventSeq ?? event.seq,
      startedAt: current.startedAt ?? eventTimestampMs(event),
      completedAt:
        event.type === 'web_search_completed' ? eventTimestampMs(event) : current.completedAt,
    }
    return next
  }
  const searchItem: ConvItem = {
    kind: 'web_search',
    searchId: event.data.search_id,
    status: event.type === 'web_search_completed' ? 'done' : 'running',
    query: event.data.query,
    action: event.data.action ?? {},
    results: event.type === 'web_search_completed' ? (event.data.results ?? []) : [],
    resultCount: event.type === 'web_search_completed' ? event.data.result_count : undefined,
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
    startedAt: eventTimestampMs(event),
    completedAt: event.type === 'web_search_completed' ? eventTimestampMs(event) : undefined,
  }
  return placement === 'live' ? [...items, searchItem] : insertTurnRuntimeItem(items, searchItem)
}

/** Bind a Serve-verified source projection to its completed answer item. */
export function projectAnswerSources(
  items: ConvItem[],
  event: Extract<ProductEvent, { type: 'answer_sources' }>
): ConvItem[] {
  let target = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'agent' || item.turnId !== event.turn_id) continue
    if (event.item_id && item.itemId !== event.item_id) continue
    target = index
    break
  }
  if (target < 0) return items
  return items.map((item, index) =>
    index === target && item.kind === 'agent'
      ? {
          ...item,
          answerSources: event.data.sources,
          searchSources: event.data.search_sources,
          answerCoverage: event.data.coverage,
        }
      : item
  )
}

/** Upsert one native PaperSearch notification pair without treating it as WebSearch. */
export function projectPaperSearchEvent(
  items: ConvItem[],
  event: PaperSearchEvent,
  placement: PaperSearchPlacement = 'history'
): ConvItem[] {
  const index = items.findIndex(
    (item) =>
      item.kind === 'paper_search' &&
      item.searchId === event.data.search_id &&
      item.turnId === event.turn_id
  )
  if (index >= 0) {
    const current = items[index]
    if (current.kind !== 'paper_search') return items
    const next = [...items]
    next[index] = {
      ...current,
      query: event.data.query || current.query,
      status: event.type === 'paper_search_completed' ? 'done' : current.status,
      eventSeq: current.eventSeq ?? event.seq,
      startedAt: current.startedAt ?? eventTimestampMs(event),
      completedAt:
        event.type === 'paper_search_completed' ? eventTimestampMs(event) : current.completedAt,
    }
    return next
  }
  const searchItem: ConvItem = {
    kind: 'paper_search',
    searchId: event.data.search_id,
    status: event.type === 'paper_search_completed' ? 'done' : 'running',
    query: event.data.query,
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
    startedAt: eventTimestampMs(event),
    completedAt: event.type === 'paper_search_completed' ? eventTimestampMs(event) : undefined,
  }
  return placement === 'live' ? [...items, searchItem] : insertTurnRuntimeItem(items, searchItem)
}

/** Keep selected Skill activation separate from the shell command used by Codex internally. */
export function projectSkillActivityEvent(
  items: ConvItem[],
  event: SkillActivityEvent,
  placement: SkillActivityPlacement = 'history'
): ConvItem[] {
  const index = items.findIndex(
    (item) =>
      item.kind === 'skill' && item.skillId === event.data.skill_id && item.turnId === event.turn_id
  )
  const completed = event.type === 'skill_completed'
  const status = completed ? (event.data.success === false ? 'error' : 'done') : 'running'
  const estimate = event.data.estimate
    ? ({
        lowerSeconds: event.data.estimate.lower_seconds,
        upperSeconds: event.data.estimate.upper_seconds,
        sampleCount: event.data.estimate.sample_count,
        confidence: event.data.estimate.confidence,
        basis: event.data.estimate.basis,
        modelId: event.data.model_id,
        reasoningEffort: event.data.reasoning_effort,
      } as const)
    : undefined
  if (index >= 0) {
    const current = items[index]
    if (current.kind !== 'skill') return items
    const next = [...items]
    next[index] = {
      ...current,
      name: event.data.skill || current.name,
      path: event.data.path || current.path,
      nativeStatus: event.data.status || current.nativeStatus,
      estimate: estimate ?? current.estimate,
      status,
      eventSeq: current.eventSeq ?? event.seq,
      startedAt: current.startedAt ?? eventTimestampMs(event),
      completedAt: completed ? eventTimestampMs(event) : current.completedAt,
    }
    return next
  }
  const skill: ConvItem = {
    kind: 'skill',
    skillId: event.data.skill_id,
    name: event.data.skill,
    path: event.data.path,
    status,
    nativeStatus: event.data.status,
    estimate,
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
    startedAt: eventTimestampMs(event),
    completedAt: completed ? eventTimestampMs(event) : undefined,
  }
  return placement === 'live' ? [...items, skill] : insertTurnRuntimeItem(items, skill)
}

/** Upsert one native App Server item without conflating it with tool-call semantics. */
export function projectNativeActivityEvent(
  items: ConvItem[],
  event: NativeActivityEvent,
  placement: NativeActivityPlacement = 'history'
): ConvItem[] {
  const index = items.findIndex(
    (item) =>
      item.kind === 'native_activity' &&
      item.activityId === event.data.activity_id &&
      item.turnId === event.turn_id
  )
  const completed = event.type === 'native_activity_completed'
  const status = completed ? (event.data.success === false ? 'error' : 'done') : 'running'
  const progress = subagentProgressFromEvent(event)
  if (index >= 0) {
    const current = items[index]
    if (current.kind !== 'native_activity') return items
    const terminal = current.status === 'done' || current.status === 'error'
    const next = [...items]
    next[index] = {
      ...current,
      activityType: event.data.activity_type || current.activityType,
      category: event.data.category,
      details: { ...current.details, ...event.data.details },
      progress: progress
        ? upsertSubagentProgress(current.progress ?? [], progress)
        : current.progress,
      nativeStatus: terminal ? current.nativeStatus : event.data.status || current.nativeStatus,
      status: terminal ? current.status : status,
      eventSeq: current.eventSeq ?? event.seq,
      startedAt: current.startedAt ?? eventTimestampMs(event),
      completedAt: terminal
        ? current.completedAt
        : completed
          ? eventTimestampMs(event)
          : current.completedAt,
    }
    return next
  }
  const activity: ConvItem = {
    kind: 'native_activity',
    activityId: event.data.activity_id,
    activityType: event.data.activity_type,
    category: event.data.category,
    status,
    nativeStatus: event.data.status,
    details: event.data.details,
    progress: progress ? [progress] : undefined,
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
    startedAt: eventTimestampMs(event),
    completedAt: completed ? eventTimestampMs(event) : undefined,
  }
  return placement === 'live' ? [...items, activity] : insertTurnRuntimeItem(items, activity)
}

function subagentProgressFromEvent(event: NativeActivityEvent): SubagentProgress | null {
  if (event.data.activity_type !== 'subagent_activity') return null
  const details = event.data.details ?? {}
  if (typeof details.recent_activity !== 'string') return null
  const rawTool = details.tool
  const tool =
    rawTool && typeof rawTool === 'object' && !Array.isArray(rawTool)
      ? (rawTool as Record<string, unknown>)
      : undefined
  const observedAt = eventTimestampMs(event)
  return {
    itemId:
      typeof details.activity_item_id === 'string' && details.activity_item_id
        ? details.activity_item_id
        : `event:${event.seq}`,
    activity: details.recent_activity,
    phase: typeof details.activity_phase === 'string' ? details.activity_phase : '',
    summary: typeof details.public_summary === 'string' ? details.public_summary : undefined,
    tool:
      tool && typeof tool.name === 'string'
        ? {
            name: tool.name,
            input: tool.input,
            output: typeof tool.output === 'string' ? tool.output : undefined,
            ok: typeof tool.ok === 'boolean' ? tool.ok : undefined,
            status: typeof tool.status === 'string' ? tool.status : undefined,
          }
        : undefined,
    startedAt: observedAt,
    completedAt: details.activity_phase === 'completed' ? observedAt : undefined,
    observedAt,
    eventSeq: event.seq,
  }
}

function upsertSubagentProgress(
  progress: SubagentProgress[],
  update: SubagentProgress
): SubagentProgress[] {
  const index = progress.findIndex((step) => step.itemId === update.itemId)
  if (index < 0) return [...progress, update]
  if (progress[index].eventSeq >= update.eventSeq) return progress
  if (progress[index].completedAt !== undefined) return progress
  return progress.map((step, stepIndex) =>
    stepIndex === index
      ? {
          ...update,
          phase: step.completedAt !== undefined ? step.phase : update.phase,
          summary: update.summary ?? step.summary,
          tool: update.tool ? { ...step.tool, ...update.tool } : step.tool,
          startedAt: step.startedAt ?? step.observedAt,
          completedAt: step.completedAt ?? update.completedAt,
        }
      : step
  )
}

/** Project the durable session artifact index into the owning turn's visible timeline. */
export function projectArtifact(
  artifact: SessionArtifact
): Extract<ConvItem, { kind: 'artifact' }> {
  return {
    kind: 'artifact',
    artifact,
    turnId: artifact.vendor_turn_id || undefined,
    itemId: artifact.vendor_item_id || undefined,
  }
}

export function projectReviewReadyEvent(
  items: ConvItem[],
  event: Extract<ProductEvent, { type: 'review_ready' }>
): ConvItem[] {
  const existing = items.findIndex(
    (item) => item.kind === 'review' && item.review.batchId === event.data.batch_id
  )
  const review: Extract<ConvItem, { kind: 'review' }> = {
    kind: 'review',
    review: {
      batchId: event.data.batch_id,
      projectId: event.data.project_id,
      fileIds: event.data.file_ids,
      reviewIds: event.data.review_ids,
      paths: event.data.paths,
    },
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
  }
  if (existing >= 0) {
    const next = [...items]
    next[existing] = review
    return next
  }
  return insertTurnRuntimeItem(items, review)
}

/** Upsert one artifact without moving it to a neighbouring turn or duplicating SSE replays. */
export function upsertConversationArtifact(
  items: ConvItem[],
  artifact: SessionArtifact
): ConvItem[] {
  const withoutCurrent = items.filter(
    (item) => item.kind !== 'artifact' || item.artifact.artifact_id !== artifact.artifact_id
  )
  if (artifact.status === 'deleted' || artifact.change === 'delete') return withoutCurrent
  return insertTurnRuntimeItem(withoutCurrent, projectArtifact(artifact))
}

/** Replace the inline artifact projection from one authoritative history snapshot. */
export function projectArtifactSnapshot(
  items: ConvItem[],
  artifacts: SessionArtifact[]
): ConvItem[] {
  const withoutArtifacts: ConvItem[] = items.filter((item) => item.kind !== 'artifact')
  return artifacts.reduce<ConvItem[]>(
    (projected, artifact) => upsertConversationArtifact(projected, artifact),
    withoutArtifacts
  )
}

type AssistantSequenceAnchor = {
  modelRun?: ModelRun
  kind: StreamItemKind
  phaseKnown: boolean
  itemId: string
  eventSeq: number
  text: string
}

function assistantSequenceAnchors(events: ProductEvent[]): Map<string, AssistantSequenceAnchor[]> {
  const anchors = new Map<string, AssistantSequenceAnchor[]>()
  const anchorsByItem = new Map<string, Map<string, AssistantSequenceAnchor>>()
  for (const event of events) {
    if (event.type !== 'message_delta' || !event.turn_id || !event.item_id) continue
    let byItem = anchorsByItem.get(event.turn_id)
    if (!byItem) {
      byItem = new Map<string, AssistantSequenceAnchor>()
      anchorsByItem.set(event.turn_id, byItem)
    }
    const current = byItem.get(event.item_id)
    if (current) {
      // Agent message deltas are cumulative snapshots on the ScholarSeed surface.
      current.text = event.data.delta
      current.modelRun = event.data.model_run ?? current.modelRun
      if (event.data.phase) {
        current.kind = event.data.phase === 'commentary' ? 'thinking' : 'agent'
        current.phaseKnown = true
      }
      continue
    }
    const anchor = {
      kind: event.data.phase === 'commentary' ? ('thinking' as const) : ('agent' as const),
      phaseKnown: Boolean(event.data.phase),
      itemId: event.item_id,
      eventSeq: event.seq,
      text: event.data.delta,
      modelRun: event.data.model_run,
    }
    byItem.set(event.item_id, anchor)
    const turnAnchors = anchors.get(event.turn_id) ?? []
    turnAnchors.push(anchor)
    anchors.set(event.turn_id, turnAnchors)
  }
  return anchors
}

function anchorAssistantSequence(items: ConvItem[], events: ProductEvent[]): ConvItem[] {
  const anchors = assistantSequenceAnchors(events)
  const used = new Set<AssistantSequenceAnchor>()
  let projected = [...items]

  const bind = (index: number, anchor: AssistantSequenceAnchor): void => {
    const item = projected[index]
    projected[index] = {
      ...item,
      itemId: anchor.itemId,
      eventSeq: anchor.eventSeq,
      ...(item.kind === 'agent' && anchor.modelRun ? { modelRun: anchor.modelRun } : {}),
    }
    used.add(anchor)
  }

  // Some App Server versions preserve native item ids across resume. Prefer
  // that strongest identity whenever it is available.
  projected.forEach((item, index) => {
    if ((item.kind !== 'agent' && item.kind !== 'thinking') || !item.turnId || !item.itemId) return
    const anchor = anchors
      .get(item.turnId)
      ?.find(
        (candidate) =>
          !used.has(candidate) &&
          candidate.itemId === item.itemId &&
          (!candidate.phaseKnown || candidate.kind === item.kind)
      )
    if (anchor) bind(index, anchor)
  })

  // Codex may rebuild transcript ids (for example msg_* becomes item-*). The
  // complete message text plus its owning turn is then the durable identity.
  projected.forEach((item, index) => {
    if (
      (item.kind !== 'agent' && item.kind !== 'thinking') ||
      !item.turnId ||
      item.eventSeq !== undefined
    )
      return
    const anchor = anchors
      .get(item.turnId)
      ?.find(
        (candidate) =>
          !used.has(candidate) &&
          candidate.text === item.text &&
          (!candidate.phaseKnown || candidate.kind === item.kind)
      )
    if (anchor) bind(index, anchor)
  })

  // If text normalization changed but both sources contain the same number of
  // still-unmatched assistant items, their within-turn order is authoritative.
  for (const [turnId, turnAnchors] of anchors) {
    const remainingAnchors = turnAnchors.filter((anchor) => !used.has(anchor))
    const remainingItems = projected.flatMap((item, index) =>
      (item.kind === 'agent' || item.kind === 'thinking') &&
      item.turnId === turnId &&
      item.eventSeq === undefined
        ? [index]
        : []
    )
    if (
      remainingItems.length !== remainingAnchors.length ||
      !remainingItems.every(
        (index, offset) =>
          !remainingAnchors[offset].phaseKnown ||
          projected[index].kind === remainingAnchors[offset].kind
      )
    )
      continue
    remainingItems.forEach((index, offset) => bind(index, remainingAnchors[offset]))
  }

  // Codex resume history may omit interim commentary even though the product
  // event store durably owns it. Recreate any unbound phased message from that
  // authoritative event instead of dropping it or presenting it as an answer.
  for (const [turnId, turnAnchors] of anchors) {
    for (const anchor of turnAnchors) {
      if (used.has(anchor)) continue
      projected = insertTurnRuntimeItem(projected, {
        kind: anchor.kind,
        text: anchor.text,
        ...(anchor.kind === 'thinking'
          ? { commentary: true as const }
          : { modelRun: anchor.modelRun }),
        turnId,
        itemId: anchor.itemId,
        eventSeq: anchor.eventSeq,
      })
      used.add(anchor)
    }
  }
  return projected
}

type ReplayedActivityIdentity = {
  kind: ConvItem['kind']
  turnId?: string
  id?: string
}

function replayedActivityIdentities(events: ProductEvent[]): ReplayedActivityIdentity[] {
  return events.reduce<ReplayedActivityIdentity[]>((identities, event) => {
    if (event.type === 'reasoning_delta') {
      identities.push({ kind: 'thinking', turnId: event.turn_id, id: event.item_id })
    } else if (
      event.type === 'tool_started' ||
      event.type === 'tool_output_delta' ||
      event.type === 'tool_completed'
    ) {
      identities.push({ kind: 'tool', turnId: event.turn_id, id: event.data.tool_id })
    } else if (event.type === 'web_search_started' || event.type === 'web_search_completed') {
      identities.push({ kind: 'web_search', turnId: event.turn_id, id: event.data.search_id })
    } else if (event.type === 'paper_search_started' || event.type === 'paper_search_completed') {
      identities.push({ kind: 'paper_search', turnId: event.turn_id, id: event.data.search_id })
    } else if (event.type === 'skill_started' || event.type === 'skill_completed') {
      identities.push({ kind: 'skill', turnId: event.turn_id, id: event.data.skill_id })
    } else if (
      event.type === 'native_activity_started' ||
      event.type === 'native_activity_completed'
    ) {
      identities.push({
        kind: 'native_activity',
        turnId: event.turn_id,
        id: event.data.activity_id,
      })
    } else if (
      event.type === 'subagent_spawned' ||
      event.type === 'subagent_started' ||
      event.type === 'subagent_status_changed' ||
      event.type === 'subagent_completed' ||
      event.type === 'subagent_failed' ||
      event.type === 'subagent_interrupted'
    ) {
      identities.push({
        kind: 'native_activity',
        turnId: event.turn_id,
        id: event.data.subagent_id,
      })
    }
    return identities
  }, [])
}

function activityIdentity(item: ConvItem): string | undefined {
  if (item.kind === 'thinking') return item.itemId
  if (item.kind === 'tool') return item.toolId
  if (item.kind === 'web_search' || item.kind === 'paper_search') return item.searchId
  if (item.kind === 'skill') return item.skillId
  if (item.kind === 'native_activity') return item.activityId
  return undefined
}

export function settleInterruptedActivities(
  items: ConvItem[],
  turnId: string | undefined,
  completedAt: number
): ConvItem[] {
  if (!turnId) return items
  return items.map((item) => {
    if (item.turnId !== turnId) return item
    if (item.kind !== 'tool' && item.kind !== 'native_activity') return item
    if (item.status !== 'running') return item
    if (item.kind === 'tool') return { ...item, status: 'cancelled', completedAt }
    if (item.kind === 'native_activity') return { ...item, status: 'error', completedAt }
    return item
  })
}

export function projectTurnInterruption(
  items: ConvItem[],
  event: Extract<ProductEvent, { type: 'turn_interrupted' }>
): ConvItem[] {
  const settled = settleInterruptedActivities(items, event.turn_id, eventTimestampMs(event))
  if (
    settled.some(
      (item) =>
        item.kind === 'status' && item.turnId === event.turn_id && item.eventSeq === event.seq
    )
  )
    return settled
  const reason = event.data.reason ?? ''
  const presentation = Object.prototype.hasOwnProperty.call(TURN_INTERRUPTED_PRESENTATIONS, reason)
    ? TURN_INTERRUPTED_PRESENTATIONS[reason]
    : USER_INTERRUPTED_PRESENTATION
  return insertTurnRuntimeItem(settled, {
    kind: 'status',
    text: '',
    ...presentation,
    retainOnHistoryRefresh: true,
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
  })
}

/** Restore message and activity items in the durable product-event order. */
export function projectActivityEvents(items: ConvItem[], events: ProductEvent[]): ConvItem[] {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const replayed = replayedActivityIdentities(ordered)
  const durableItems = items.filter((item) => {
    const id = activityIdentity(item)
    if (!id) return true
    return !replayed.some(
      (identity) =>
        identity.kind === item.kind && identity.turnId === item.turnId && identity.id === id
    )
  })
  return ordered.reduce<ConvItem[]>(
    (conversation, event) => {
      if (event.type === 'hil_requested') {
        if (!event.data.request_id) return conversation
        const existing = conversation.find(
          (item) => item.kind === 'hil' && item.requestId === event.data.request_id
        )
        return insertTurnRuntimeItem(
          conversation.filter((item) => item !== existing),
          existing?.kind === 'hil'
            ? {
                ...existing,
                turnId: existing.turnId ?? event.turn_id,
                itemId: existing.itemId ?? event.item_id,
                eventSeq: event.seq,
                requestedAt: hilTimestamp(event.data.requested_at ?? event.ts),
              }
            : projectHilCard(event.data, event.ts, event.turn_id, event.item_id, event.seq)
        )
      }
      if (event.type === 'hil_resolved') {
        return resolveHilItem(
          conversation,
          event.data.request_id,
          {
            ...hilEventResolution(
              event.data.answer,
              event.data.state,
              event.data.resolved_at ?? event.ts
            ),
            ...(event.data.kind === 'browser_approval'
              ? {
                  resolvedMessage: browserApprovalResolution(
                    event.data.decision,
                    event.data.reason
                  ),
                }
              : event.data.kind === 'browser_history_approval'
                ? {
                    resolvedMessage: browserHistoryApprovalResolution(
                      event.data.decision,
                      event.data.reason
                    ),
                  }
                : {}),
            answers: event.data.answers,
            decisionScope: event.data.decision_scope,
            hilState: event.data.state,
          },
          event.seq
        )
      }
      if (event.type === 'turn_interrupted') {
        return projectTurnInterruption(conversation, event)
      }
      if (event.type === 'turn_unknown' || event.type === 'turn_reconciled') {
        return settleInterruptedActivities(
          conversation,
          event.type === 'turn_reconciled' ? event.data.turn_id || event.turn_id : event.turn_id,
          eventTimestampMs(event)
        )
      }
      if (event.type === 'turn_failed') {
        const failure = describeTurnFailure(event.data)
        const settled = settleInterruptedActivities(
          conversation,
          event.turn_id,
          eventTimestampMs(event)
        )
        const existingIndex = settled.findIndex(
          (item) =>
            item.kind === 'error' &&
            item.turnId === event.turn_id &&
            sameTurnFailureMessage(item, failure)
        )
        if (existingIndex >= 0) {
          const existing = settled[existingIndex]
          if (existing.kind === 'error' && failure.failure?.kind === 'auth') {
            const updated = [...settled]
            updated[existingIndex] = {
              ...existing,
              ...failure,
              actionState: existing.actionState ?? failure.actionState,
            }
            return updated
          }
          return settled
        }
        return insertTurnRuntimeItem(settled, {
          ...failure,
          turnId: event.turn_id,
          eventSeq: event.seq,
        })
      }
      if (event.type === 'artifact_failed') return projectArtifactFailure(conversation, event)
      if (event.type === 'review_ready') return projectReviewReadyEvent(conversation, event)
      if (event.type === 'answer_sources') return projectAnswerSources(conversation, event)
      if (event.type === 'message_delta') return conversation
      if (event.type === 'reasoning_delta' || event.type === 'reasoning_completed')
        return projectReasoningEvent(conversation, event)
      if (event.type === 'tool_started') {
        if (
          conversation.some(
            (item) =>
              item.kind === 'tool' &&
              item.toolId === event.data.tool_id &&
              item.turnId === event.turn_id
          )
        )
          return conversation
        return insertTurnRuntimeItem(conversation, {
          kind: 'tool',
          toolId: event.data.tool_id,
          name: event.data.name,
          input: event.data.input,
          status: 'running',
          turnId: event.turn_id,
          itemId: event.item_id,
          eventSeq: event.seq,
          startedAt: eventTimestampMs(event),
        })
      }
      if (event.type === 'tool_output_delta') {
        return conversation.map((item) =>
          item.kind === 'tool' &&
          item.toolId === event.data.tool_id &&
          item.turnId === event.turn_id
            ? { ...item, result: `${item.result ?? ''}${event.data.delta}` }
            : item
        )
      }
      if (event.type === 'tool_completed') {
        return conversation.map((item) =>
          item.kind === 'tool' &&
          item.toolId === event.data.tool_id &&
          item.turnId === event.turn_id
            ? {
                ...item,
                name: event.data.name || item.name,
                result: event.data.output ?? item.result,
                exitCode: event.data.exit_code ?? item.exitCode,
                status: event.data.success ? 'done' : 'error',
                completedAt: eventTimestampMs(event),
              }
            : item
        )
      }
      if (event.type === 'web_search_started' || event.type === 'web_search_completed') {
        return projectWebSearchEvent(conversation, event)
      }
      if (event.type === 'paper_search_started' || event.type === 'paper_search_completed') {
        return projectPaperSearchEvent(conversation, event)
      }
      if (event.type === 'skill_started' || event.type === 'skill_completed') {
        return projectSkillActivityEvent(conversation, event)
      }
      if (event.type === 'native_activity_started' || event.type === 'native_activity_completed') {
        return projectNativeActivityEvent(conversation, event)
      }
      if (
        event.type === 'subagent_spawned' ||
        event.type === 'subagent_started' ||
        event.type === 'subagent_status_changed' ||
        event.type === 'subagent_completed' ||
        event.type === 'subagent_failed' ||
        event.type === 'subagent_interrupted'
      ) {
        return projectNativeActivityEvent(conversation, projectSubagentActivity(event))
      }
      if (event.type === 'display_card') {
        return projectDisplayCardEvent(conversation, event)
      }
      return conversation
    },
    anchorAssistantSequence(durableItems, ordered)
  )
}

type DisplayCardEvent = Extract<ProductEvent, { type: 'display_card' }>

export function projectDisplayCardEvent(
  items: ConvItem[],
  event: DisplayCardEvent,
  presentationSource: 'live' | 'history' = 'history'
): ConvItem[] {
  const projected: ConvItem = {
    kind: 'display_card',
    card: {
      cardId: event.data.card_id,
      component: event.data.component,
      type: event.data.type,
      content: event.data.content,
      presentationSource,
    },
    turnId: event.turn_id,
    itemId: event.item_id,
    eventSeq: event.seq,
    startedAt: eventTimestampMs(event),
  }
  const current = items.findIndex(
    (item) => item.kind === 'display_card' && item.card.cardId === event.data.card_id
  )
  if (current < 0) return insertTurnRuntimeItem(items, projected)
  const next = [...items]
  next[current] = projected
  return next
}

/** Keep durable card history while projecting only the latest snapshot for a feature-owned key. */
export function latestDisplayCardItems(
  items: readonly ConvItem[],
  keyFor: (card: DisplayCardData) => string | null,
  positionFor?: (card: DisplayCardData) => DisplayCardSupersessionPosition | undefined
): ConvItem[] {
  const groups = new Map<string, { anchor: number; latest: number }>()
  const identities = items.map((item, index) => {
    if (item.kind !== 'display_card') return null
    const key = keyFor(item.card)
    if (!key) return null
    const identity = `${item.card.type}\0${key}`
    const existing = groups.get(identity)
    groups.set(identity, {
      anchor: positionFor?.(item.card) === 'first' ? (existing?.anchor ?? index) : index,
      latest: index,
    })
    return identity
  })
  return items.flatMap((item, index): ConvItem[] => {
    const identity = identities[index]
    if (identity === null) return [item]
    const group = groups.get(identity)!
    if (index !== group.anchor) return []
    const latest = items[group.latest]
    // Anchor metadata belongs to the display row; card identity still addresses the latest receipt.
    return item.kind === 'display_card' && latest.kind === 'display_card'
      ? [{ ...item, card: latest.card }]
      : [item]
  })
}

/** Bind the causally matched POST /turns response to its optimistic user bubble. */
export function bindSubmittedTurn(
  items: ConvItem[],
  turnId: string,
  clientUserMessageId?: string
): ConvItem[] {
  if (items.some((item) => item.kind === 'user' && item.turnId === turnId)) return items
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'user' || item.turnId) continue
    if (clientUserMessageId && item.itemId !== clientUserMessageId) continue
    const next = [...items]
    next[index] = { ...item, turnId }
    return next
  }
  return items
}

function isRuntimeTranscriptItem(item: ConvItem): boolean {
  return (
    (item.kind === 'user' && Boolean(item.itemId) && !item.turnId) ||
    item.kind === 'thinking' ||
    item.kind === 'tool' ||
    item.kind === 'web_search' ||
    item.kind === 'paper_search' ||
    item.kind === 'skill' ||
    item.kind === 'native_activity' ||
    item.kind === 'artifact' ||
    item.kind === 'review' ||
    item.kind === 'display_card' ||
    item.kind === 'error' ||
    item.kind === 'hil' ||
    (item.kind === 'status' && item.retainOnHistoryRefresh === true)
  )
}

function sameDurableAnchor(left: ConvItem, right: ConvItem): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'artifact' && right.kind === 'artifact') {
    return left.artifact.artifact_id === right.artifact.artifact_id
  }
  if (left.kind === 'display_card' && right.kind === 'display_card') {
    return left.card.cardId === right.card.cardId
  }
  if (left.kind === 'review' && right.kind === 'review') {
    return left.review.batchId === right.review.batchId
  }
  if (
    left.kind === 'thinking' &&
    right.kind === 'thinking' &&
    left.commentary === true &&
    right.commentary === true
  ) {
    return left.turnId === right.turnId && left.text === right.text
  }
  if (left.itemId && right.itemId) return left.itemId === right.itemId
  if (left.turnId && right.turnId && left.turnId !== right.turnId) return false
  if (
    (left.kind === 'user' || left.kind === 'agent') &&
    (right.kind === 'user' || right.kind === 'agent')
  ) {
    return left.text === right.text
  }
  return Boolean(left.turnId && left.turnId === right.turnId)
}

function insertBeforeDurableAnchor(
  items: ConvItem[],
  runtimeItem: ConvItem,
  anchor: ConvItem | undefined
): ConvItem[] {
  if (items.some((item) => sameDurableAnchor(item, runtimeItem))) return items
  if (
    (runtimeItem.eventSeq !== undefined &&
      items.some((item) => item.eventSeq !== undefined && item.eventSeq > runtimeItem.eventSeq!)) ||
    (runtimeItem.turnId && items.some((item) => item.turnId === runtimeItem.turnId))
  )
    return insertTurnRuntimeItem(items, runtimeItem)
  if (anchor) {
    const index = items.findIndex((item) => sameDurableAnchor(item, anchor))
    if (index >= 0) return [...items.slice(0, index), runtimeItem, ...items.slice(index)]
  }
  return insertTurnRuntimeItem(items, runtimeItem)
}

function preservesEveryLiveAssistantItem(projected: ConvItem[], current: ConvItem[]): boolean {
  return current.every(
    (item) =>
      item.kind !== 'agent' ||
      !item.itemId ||
      projected.some((candidate) => sameDurableAnchor(candidate, item))
  )
}

function refreshKnownDurableRows(projected: ConvItem[], current: ConvItem[]): ConvItem[] {
  return current.map((item) => {
    if (item.kind !== 'user' && item.kind !== 'agent') return item
    return projected.find((candidate) => sameDurableAnchor(candidate, item)) ?? item
  })
}

/** Merge durable transcript truth without erasing live-only control outcomes.
 *
 * Runtime activity, errors and HIL cards are not durable transcript messages. Replacing the
 * conversation with ``projectHistory`` as soon as a run becomes idle used to
 * make a terminal error flash and disappear. Keep these typed control items
 * until the user explicitly rewinds or opens a different session.
 */
export function projectHistoryWithRuntime(turns: HistoryTurn[], current: ConvItem[]): ConvItem[] {
  const runtimeRows = current.flatMap((item, index) => {
    if (!isRuntimeTranscriptItem(item)) return []
    const nextDurable = current
      .slice(index + 1)
      .find((candidate) => !isRuntimeTranscriptItem(candidate) || isTurnBoundary(candidate))
    return [{ item, nextDurable }]
  })
  const projected = projectHistory(turns).map((item) => {
    if (item.kind !== 'status' || !item.turnBoundary) return item
    const previous = current.find((candidate) => sameDurableAnchor(candidate, item))
    return previous?.eventSeq === undefined
      ? item
      : {
          ...item,
          eventSeq: previous.eventSeq,
          ...(previous.kind === 'status' ? { bindingSeq: previous.bindingSeq } : {}),
        }
  })
  // The idle refresh can race App Server's durable thread snapshot. Product
  // events are already ordered and item-addressed, so a snapshot that omits an
  // assistant item seen live is older evidence and must never delete it. A
  // later resume can still replace every matching durable row with richer
  // server metadata once the snapshot has caught up.
  if (!preservesEveryLiveAssistantItem(projected, current)) {
    return refreshKnownDurableRows(projected, current)
  }
  const cancelledTurns = new Set(
    runtimeRows.flatMap(({ item }) =>
      item.kind === 'hil' && item.hilState === 'cancelled' && item.turnId ? [item.turnId] : []
    )
  )
  if (cancelledTurns.size > 0) {
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      const item = projected[index]
      if (
        item.kind === 'tool' &&
        item.status === 'error' &&
        item.turnId &&
        cancelledTurns.has(item.turnId)
      ) {
        projected[index] = { ...item, status: 'cancelled' }
        cancelledTurns.delete(item.turnId)
        if (cancelledTurns.size === 0) break
      }
    }
  }
  return runtimeRows.reduce(
    (items, row) => insertBeforeDurableAnchor(items, row.item, row.nextDurable),
    projected
  )
}

export function snapshotTurnActivity(
  snapshots: TurnActivitySnapshot[]
): Pick<Thread, 'turnOutcomes' | 'turnTimings'> {
  const turnOutcomes: NonNullable<Thread['turnOutcomes']> = {}
  const turnTimings: NonNullable<Thread['turnTimings']> = {}
  for (const snapshot of snapshots) {
    if (!snapshot.turn_id || !Number.isFinite(snapshot.started_at)) continue
    turnTimings[snapshot.turn_id] = {
      startedAt: snapshot.started_at * EVENT_SECONDS_TO_MILLISECONDS,
      completedAt: Number.isFinite(snapshot.completed_at)
        ? (snapshot.completed_at as number) * EVENT_SECONDS_TO_MILLISECONDS
        : undefined,
    }
    if (snapshot.outcome) {
      turnOutcomes[snapshot.turn_id] =
        snapshot.outcome === 'unknown_outcome' ? 'unknown' : snapshot.outcome
    }
  }
  return { turnOutcomes, turnTimings }
}

/** Project one authoritative history response for both initial display and resume refresh. */
export function projectHistorySnapshot(history: HistoryResult, current: ConvItem[]): ConvItem[] {
  const completedTurnIds = history.turn_activity.flatMap((turn) =>
    turn.outcome === 'completed' ? [turn.turn_id] : []
  )
  const conversation = history.turns.length
    ? projectHistoryWithRuntime(history.turns, current)
    : current
  const activities = projectActivityEvents(conversation, history.activity_events)
  const settled = history.turn_activity.reduce(
    (items, turn) =>
      turn.outcome === 'unknown_outcome' ||
      turn.outcome === 'interrupted' ||
      turn.outcome === 'failed'
        ? settleInterruptedActivities(
            items,
            turn.turn_id,
            (turn.completed_at ?? turn.started_at) * EVENT_SECONDS_TO_MILLISECONDS
          )
        : items,
    activities
  )
  return placeFinalAssistantLast(
    projectArtifactSnapshot(settled, history.artifacts),
    completedTurnIds
  )
}
