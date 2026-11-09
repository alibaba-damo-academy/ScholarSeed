import { startupSnapshot } from './app/connection'
import { ExclusiveSubscription } from './subscriptions'
import { subscribeChanges } from './app/notifications'
import { DirtyRefresh } from '../../notifications'
import { STARTUP_PHASE } from '../../startup'
import {
  RECONFIGURATION_POLL_MS,
  RECONFIGURATION_RECOVERY,
  reconfigurationRecovery,
} from '../../reconfiguration'
import { mergedSessionTitle, openedSessionTitle, sessionTitleFallback } from './session'
import { feedback } from './contracts/feedback'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef } from 'react'

import type { AspEnvelope, ServeSession } from './api'
import {
  BACKEND_FAILURE_EVENT,
  BACKEND_ADMISSION_FAILURE,
  PRODUCT_DATA_SCOPE_LITERATURE,
  PRODUCT_DATA_SCOPE_RESOURCES,
  type BackendFailureDetail,
  classifySessionResumeFailure,
  getSharedRuntimeReconfiguration,
  requestFailureFeedback,
  getHistoryWithTodos,
  getModels,
  loadSessionCatalog,
  loadSessionStatus,
  listQueuedMessages,
  listProjects,
  openSession,
  type SessionResumeFailure,
  streamEvents,
} from './api'
import {
  projectCatalogFailure,
  pruneMissingCatalogThreads,
  retainCatalogThread,
  sessionCatalogRetryDelay,
  sessionCatalogNeedsRefresh,
  sameSessionCatalog,
  sessionSummaryNeedsCatalog,
} from './catalog'
import { markCreditsExhausted } from './account'
import { DirectiveStreamHarness } from './directive'
import { describeTurnFailure, sameTurnFailureMessage } from './failures'
import { turnAdmissionFeedback } from './input'
import {
  browserApprovalResolution,
  browserHistoryApprovalResolution,
  projectHilCard,
  hilEventResolution,
  settlePendingHil,
  hilResolvedRunState,
  hilRequestedRunState,
} from './hil'
import type {
  Cognitive,
  ConvItem,
  ModelRun,
  SessionArtifact,
  SessionNode,
  SessionStatus,
  Thread,
} from './model'
import { artifactBelongsToResources, RELEASED_PLAN_SOURCE } from './model'
import { queuedMessageFromPayload, upsertQueuedMessage } from './queue'
import { mergeQueuedOutbox, releaseQueuedOutbox } from './outbox'
import { useApp } from './store'
import { projectPlanSnapshots } from './todo'
import {
  insertTurnRuntimeItem,
  resolveHilItem,
  settleInterruptedActivities,
  projectTurnInterruption,
  projectArtifactSnapshot,
  projectAnswerSources,
  projectArtifactFailure,
  projectDisplayCardEvent,
  projectHistorySnapshot,
  snapshotTurnActivity,
  projectNativeActivityEvent,
  projectPaperSearchEvent,
  projectReviewReadyEvent,
  placeFinalAssistantLast,
  projectSkillActivityEvent,
  projectSubagentActivity,
  projectStreamDelta,
  projectReasoningEvent,
  projectWebSearchEvent,
  streamItemIdentity,
  upsertUserMessageEvent,
  upsertConversationArtifact,
} from './transcript'
import { findSessionNode, serveSessionNode, sessionTone, upsertSessionNode } from './tree'
import {
  applyRuntimeIncident,
  catalogRunStateIsCurrent,
  projectSessionRecovery,
  projectSessionState,
  reportOperationState,
  reportTransportState,
  reportTurnUnknown,
  reportTurnReconciled,
  sessionResumeStatusItem,
  SESSION_RESUME_REQUEST_EVENT,
  shouldRetrySessionResume,
  projectResumeRunState,
  recoveredTurnOutcome,
  type SessionResumeRequestDetail,
} from './runtime'

// The renderer consumes only ScholarSeed product events. Codex JSON-RPC method names
// and DamoAgent Harness event names stop at the Service projector boundary.
const BACKGROUND_SESSION_REFRESH_INTERVAL_MS = 2_000
const SESSION_CATALOG_APPEARANCE_GRACE_SECONDS = 5
const SESSION_RESUME_INITIAL_DELAY_MS = 1_000
const SESSION_RESUME_MAX_DELAY_MS = 30_000
const SESSION_RESUME_MAX_ATTEMPTS = 5
const SESSION_CATALOG_RECOVERY_NOTICE = feedback('shell', 'workspaceLoading.retrying')
const SESSION_CATALOG_UNAVAILABLE_NOTICE = feedback('shell', 'workspaceLoading.unavailable')
const SESSION_HISTORY_UNAVAILABLE = '历史记录未能加载'
const PRODUCT_EVENT_SECONDS_TO_MILLISECONDS = 1000
const directiveStream = new DirectiveStreamHarness()

type Patch = Parameters<ReturnType<typeof useApp>['set']>[0]
type ThreadPatch = Parameters<ReturnType<typeof useApp>['patchThread']>[1]
type ThreadUpdate = Partial<Thread>
type TurnFailure = Extract<ConvItem, { kind: 'error' }>

const LEGACY_RUNTIME_NOTICE_PREFIX = 'Agent 运行时提示：'
// Canonical control text; runtimeNotice carries language-independent display provenance.
const LEGACY_RUNTIME_NOTICE_EMPTY = 'Agent 运行时报告了一个非终态事件。'

function turnOutcomes(
  thread: Thread,
  turnId: string | undefined,
  outcome: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
): Thread['turnOutcomes'] {
  return turnId ? { ...thread.turnOutcomes, [turnId]: outcome } : thread.turnOutcomes
}

function productEventTime(timestamp: number): number {
  return timestamp * PRODUCT_EVENT_SECONDS_TO_MILLISECONDS
}

function turnTimings(
  thread: Thread,
  turnId: string | undefined,
  timestamp: number,
  completed = false
): Thread['turnTimings'] {
  if (!turnId) return thread.turnTimings
  const current = thread.turnTimings?.[turnId]
  return {
    ...thread.turnTimings,
    [turnId]: {
      startedAt: Math.min(current?.startedAt ?? timestamp, timestamp),
      completedAt: completed ? timestamp : current?.completedAt,
    },
  }
}

function bindTurnTiming(
  thread: Thread,
  turnId: string | undefined,
  clientTurnId: string,
  timestamp: number
): Thread['turnTimings'] {
  if (!turnId) return thread.turnTimings
  const current = { ...thread.turnTimings }
  const clientTiming = current[clientTurnId]
  const turnTiming = current[turnId]
  current[turnId] = {
    startedAt: Math.min(
      clientTiming?.startedAt ?? timestamp,
      turnTiming?.startedAt ?? timestamp,
      timestamp
    ),
    completedAt: turnTiming?.completedAt ?? clientTiming?.completedAt,
  }
  if (clientTurnId && clientTurnId !== turnId) delete current[clientTurnId]
  return current
}

function bindTurnOutcome(
  thread: Thread,
  turnId: string | undefined,
  clientTurnId: string
): Thread['turnOutcomes'] {
  if (!turnId || !clientTurnId || clientTurnId === turnId) return thread.turnOutcomes
  const current = { ...thread.turnOutcomes }
  if (current[turnId] === undefined && current[clientTurnId] !== undefined) {
    current[turnId] = current[clientTurnId]
  }
  delete current[clientTurnId]
  return current
}

function failThread(
  thread: Thread,
  failure: TurnFailure,
  turnId: string | undefined,
  completedAt: number
): ThreadUpdate {
  const ownedFailure: TurnFailure = { ...failure, turnId }
  const duplicate = thread.conversation.some(
    (item) =>
      item.kind === 'error' && item.turnId === turnId && sameTurnFailureMessage(item, failure)
  )
  const conversation = settleInterruptedActivities(
    settlePendingHil(thread.conversation, turnId, 'stale'),
    turnId,
    completedAt
  )
  return {
    running: false,
    interrupting: false,
    status: 'failed',
    turnOutcomes: turnOutcomes(thread, turnId, 'failed'),
    turnTimings: turnTimings(thread, turnId, completedAt, true),
    conversation: duplicate ? conversation : insertTurnRuntimeItem(conversation, ownedFailure),
  }
}

function reportLegacyRuntimeNotice(
  thread: Thread,
  message: string,
  turnId: string | undefined
): ThreadUpdate {
  const notice: ConvItem = {
    kind: 'status',
    text: `${LEGACY_RUNTIME_NOTICE_PREFIX}${LEGACY_RUNTIME_NOTICE_EMPTY}`,
    runtimeNotice: { diagnostic: message || undefined },
    tone: 'inference',
    turnId,
  }
  const previous = thread.conversation[thread.conversation.length - 1]
  return {
    conversation:
      previous?.kind === 'status' &&
      previous.turnId === turnId &&
      typeof previous.text === 'string' &&
      previous.text.startsWith(LEGACY_RUNTIME_NOTICE_PREFIX)
        ? [...thread.conversation.slice(0, -1), notice]
        : insertTurnRuntimeItem(thread.conversation, notice),
  }
}

function reportSessionResume(
  thread: Thread,
  sessionId: string,
  text: Extract<ConvItem, { kind: 'status' }>['text'],
  tone: Cognitive,
  actionable = false,
  replaceOnly = false
): ThreadUpdate {
  const notice = sessionResumeStatusItem(sessionId, text, tone, actionable)
  const incidentId = notice.incidentId
  const index = thread.conversation.findIndex(
    (item) => item.kind === 'status' && item.incidentId === incidentId
  )
  if (index < 0) {
    return replaceOnly ? {} : { conversation: insertTurnRuntimeItem(thread.conversation, notice) }
  }
  const conversation = [...thread.conversation]
  conversation[index] = notice
  return { conversation }
}

function appendDelta(
  threadId: string,
  kind: 'agent' | 'thinking',
  delta: string,
  turnId: string | undefined,
  itemId: string | undefined,
  eventSeq: number,
  timestamp: number,
  patchThread: (id: string | null, patch: ThreadPatch) => void,
  messageStream: boolean = kind === 'agent',
  modelRun?: ModelRun
): void {
  // React StrictMode may invoke functional state updaters more than once in
  // development. Keep the directive accumulator outside the updater so one
  // product delta is consumed exactly once.
  const streamIdentity = streamItemIdentity(threadId, kind, turnId, itemId)
  const visible = messageStream ? directiveStream.append(streamIdentity, delta, true) : delta
  patchThread(threadId, (thread) => {
    return {
      conversation: projectStreamDelta(
        thread.conversation,
        kind,
        visible,
        turnId,
        itemId,
        messageStream,
        eventSeq,
        modelRun,
        timestamp
      ),
      running: true,
      status: 'running',
      turnOutcomes: turnOutcomes(thread, turnId, 'running'),
      turnTimings: turnTimings(thread, turnId, timestamp),
    }
  })
}

function upsertArtifact(items: SessionArtifact[], artifact: SessionArtifact): SessionArtifact[] {
  const index = items.findIndex((item) => item.artifact_id === artifact.artifact_id)
  if (index < 0) return [...items, artifact]
  const next = [...items]
  next[index] = artifact
  return next
}

export function onEvent(
  threadId: string,
  event: AspEnvelope,
  patchThread: (id: string | null, patch: ThreadPatch) => void,
  set: (patch: Patch) => void,
  liveIndex: React.MutableRefObject<Record<string, number | null>>,
  refreshMeta: React.MutableRefObject<() => void>,
  invalidateResources: () => void,
  invalidateScopes: (scopes: string[]) => void,
  refreshAssistantContext: (sessionId: string) => void,
  refreshArtifactLinks: (sessionId: string) => void,
  acknowledgeOutbox: boolean
): void {
  switch (event.type) {
    case 'session_state': {
      const runtimeState = projectSessionState(event.data)
      const status = runtimeState.status ?? 'dormant'
      patchThread(threadId, (thread) => ({
        ...runtimeState,
        recoveryIncidentId: event.data.recovery_blocked ? (event.data.incident_id ?? null) : null,
        recoverySourceSeq: event.data.recovery_blocked ? event.seq : 0,
        terminated: event.data.state === 'closed' ? true : thread.terminated,
        conversation:
          event.data.state === 'closed'
            ? [
                ...thread.conversation,
                {
                  kind: 'status' as const,
                  text: { key: 'runtime.closed' as const },
                  tone: 'experience' as const,
                  retainOnHistoryRefresh: true,
                },
              ]
            : thread.conversation,
        turnTimings:
          event.data.state === 'running'
            ? turnTimings(thread, event.turn_id, productEventTime(event.ts))
            : thread.turnTimings,
      }))
      set({
        petOverride:
          status === 'waiting'
            ? 'waiting'
            : status === 'running'
              ? 'running'
              : status === 'failed'
                ? 'error'
                : 'done',
      })
      // Product finalization may outlive the runtime terminal. Invalidate any
      // earlier catalog request that still observed that execution as running.
      if (!runtimeState.running) refreshMeta.current()
      return
    }
    case 'session_title_updated':
      patchThread(threadId, {
        title: event.data.title,
        title_fallback: sessionTitleFallback(event.data.title_fallback),
      })
      refreshMeta.current()
      return
    case 'user_message':
      if (event.data.binding === 'cancelled') {
        patchThread(threadId, (thread) => ({
          conversation: upsertUserMessageEvent(thread.conversation, event),
        }))
        return
      }
      patchThread(threadId, (thread) => ({
        conversation: upsertUserMessageEvent(thread.conversation, event),
        turnTimings: bindTurnTiming(
          thread,
          event.turn_id,
          event.data.client_turn_id,
          productEventTime(event.ts)
        ),
        turnOutcomes: bindTurnOutcome(thread, event.turn_id, event.data.client_turn_id),
      }))
      return
    case 'message_delta':
      appendDelta(
        threadId,
        event.data.phase === 'commentary' ? 'thinking' : 'agent',
        event.data.delta,
        event.turn_id,
        event.item_id,
        event.seq,
        productEventTime(event.ts),
        patchThread,
        true,
        event.data.model_run
      )
      set({ petOverride: 'running' })
      return
    case 'reasoning_delta':
    case 'reasoning_completed':
      patchThread(threadId, (thread) => {
        const outcome = event.turn_id ? thread.turnOutcomes?.[event.turn_id] : undefined
        if (outcome && outcome !== 'running') return {}
        const conversation = projectReasoningEvent(thread.conversation, event)
        if (conversation === thread.conversation) return {}
        return {
          conversation,
          ...(event.type === 'reasoning_delta'
            ? {
                running: true,
                status: 'running' as const,
                turnOutcomes: turnOutcomes(thread, event.turn_id, 'running'),
                turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts)),
              }
            : {}),
        }
      })
      return
    case 'plan_snapshot':
      patchThread(threadId, (thread) => ({
        planSnapshots: projectPlanSnapshots([event], thread.planSnapshots),
        todos: event.data.items.map((item) => ({ ...item })),
        todoTurnId: event.turn_id ?? null,
        turnOutcomes:
          event.data.plan?.source === RELEASED_PLAN_SOURCE
            ? thread.turnOutcomes
            : turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings:
          event.data.plan?.source === RELEASED_PLAN_SOURCE
            ? thread.turnTimings
            : turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      return
    case 'tool_started':
      patchThread(threadId, (thread) => ({
        running: true,
        status: 'running',
        conversation: thread.conversation.some(
          (item) =>
            item.kind === 'tool' &&
            item.toolId === event.data.tool_id &&
            item.turnId === event.turn_id
        )
          ? thread.conversation
          : [
              ...thread.conversation,
              {
                kind: 'tool',
                toolId: event.data.tool_id,
                name: event.data.name,
                input: event.data.input,
                status: 'running',
                turnId: event.turn_id,
                itemId: event.item_id,
                eventSeq: event.seq,
                startedAt: productEventTime(event.ts),
              },
            ],
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      liveIndex.current[threadId] = null
      return
    case 'tool_output_delta':
      patchThread(threadId, (thread) => ({
        conversation: thread.conversation.map((item) =>
          item.kind === 'tool' &&
          item.toolId === event.data.tool_id &&
          item.turnId === event.turn_id
            ? { ...item, result: `${item.result ?? ''}${event.data.delta}` }
            : item
        ),
      }))
      return
    case 'tool_completed':
      patchThread(threadId, (thread) => ({
        conversation: thread.conversation.map((item) =>
          item.kind === 'tool' &&
          item.toolId === event.data.tool_id &&
          item.turnId === event.turn_id
            ? {
                ...item,
                name: event.data.name || item.name,
                result: event.data.output ?? item.result,
                exitCode: event.data.exit_code ?? item.exitCode,
                status: event.data.success ? 'done' : 'error',
                completedAt: productEventTime(event.ts),
              }
            : item
        ),
      }))
      return
    case 'web_search_started':
      patchThread(threadId, (thread) => ({
        running: true,
        status: 'running',
        conversation: projectWebSearchEvent(thread.conversation, event, 'live'),
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      liveIndex.current[threadId] = null
      set({ petOverride: 'running' })
      return
    case 'answer_sources':
      patchThread(threadId, (thread) => ({
        conversation: projectAnswerSources(thread.conversation, event),
      }))
      return
    case 'web_search_completed':
      patchThread(threadId, (thread) => ({
        conversation: projectWebSearchEvent(thread.conversation, event, 'live'),
      }))
      return
    case 'paper_search_started':
      patchThread(threadId, (thread) => ({
        running: true,
        status: 'running',
        conversation: projectPaperSearchEvent(thread.conversation, event, 'live'),
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      liveIndex.current[threadId] = null
      set({ petOverride: 'running' })
      return
    case 'paper_search_completed':
      patchThread(threadId, (thread) => ({
        conversation: projectPaperSearchEvent(thread.conversation, event, 'live'),
      }))
      return
    case 'skill_started':
      patchThread(threadId, (thread) => ({
        running: true,
        status: 'running',
        conversation: projectSkillActivityEvent(thread.conversation, event, 'live'),
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      liveIndex.current[threadId] = null
      set({ petOverride: 'running' })
      return
    case 'skill_completed':
      patchThread(threadId, (thread) => ({
        conversation: projectSkillActivityEvent(thread.conversation, event, 'live'),
      }))
      return
    case 'native_activity_started':
      patchThread(threadId, (thread) => ({
        running: true,
        status: 'running',
        conversation: projectNativeActivityEvent(thread.conversation, event, 'live'),
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      liveIndex.current[threadId] = null
      set({ petOverride: 'running' })
      return
    case 'native_activity_completed':
      patchThread(threadId, (thread) => ({
        conversation: projectNativeActivityEvent(thread.conversation, event, 'live'),
      }))
      return
    case 'message_queued':
    case 'message_updated':
    case 'send_now_submitted':
    case 'send_now_rejected':
    case 'send_now_outcome_unknown':
      if (
        acknowledgeOutbox &&
        (event.type === 'message_queued' || event.type === 'message_updated')
      ) {
        releaseQueuedOutbox(event.session_id, event.data.queued_message_id)
      }
      patchThread(threadId, (thread) => {
        return {
          queuedMessages: upsertQueuedMessage(
            thread.queuedMessages ?? [],
            queuedMessageFromPayload(event.data)
          ),
        }
      })
      return
    case 'message_removed':
    case 'send_now_accepted':
      if (acknowledgeOutbox) releaseQueuedOutbox(event.session_id, event.data.queued_message_id)
      patchThread(threadId, (thread) => ({
        queuedMessages: (thread.queuedMessages ?? []).filter(
          (item) => item.queuedMessageId !== event.data.queued_message_id
        ),
      }))
      if (event.type === 'message_removed') {
        refreshAssistantContext(event.session_id)
      }
      return
    case 'subagent_spawned':
    case 'subagent_started':
    case 'subagent_status_changed':
    case 'subagent_completed':
    case 'subagent_failed':
    case 'subagent_interrupted': {
      const completed = ['subagent_completed', 'subagent_failed', 'subagent_interrupted'].includes(
        event.type
      )
      const projected = projectSubagentActivity(event)
      patchThread(threadId, (thread) => ({
        running: completed ? thread.running : true,
        status: completed ? thread.status : 'running',
        conversation: projectNativeActivityEvent(thread.conversation, projected, 'live'),
      }))
      return
    }
    case 'file_changed':
      if (event.data.artifact) {
        patchThread(threadId, (thread) => ({
          artifacts: upsertArtifact(thread.artifacts ?? [], event.data.artifact as SessionArtifact),
          conversation: upsertConversationArtifact(
            thread.conversation,
            event.data.artifact as SessionArtifact
          ),
        }))
      }
      // 仅当产物真的落进资料库才失效资源账本；语义见 artifactBelongsToResources。
      if (artifactBelongsToResources(event.data.artifact)) invalidateResources()
      return
    // AI 经 bridge 改了产品数据: 按数据域整片重取, 不在这里解析具体条目。粗失效的
    // 取舍见 api.ts 的 PRODUCT_DATA_SCOPE_* 与 serve 的 chat/service/invalidation.py。
    case 'product_data_changed':
      invalidateScopes(event.data.scopes)
      return
    case 'artifact_library_linked':
      refreshArtifactLinks(event.session_id)
      invalidateResources()
      return
    case 'artifact_changed':
      patchThread(threadId, (thread) => {
        if (event.data.op === 'snapshot') {
          const artifacts = event.data.artifacts ?? []
          return {
            artifacts,
            conversation: projectArtifactSnapshot(thread.conversation, artifacts),
          }
        }
        if (event.data.op === 'remove' && event.data.artifact) {
          return {
            artifacts: (thread.artifacts ?? []).filter(
              (item) => item.artifact_id !== event.data.artifact?.artifact_id
            ),
            conversation: thread.conversation.filter(
              (item) =>
                item.kind !== 'artifact' ||
                item.artifact.artifact_id !== event.data.artifact?.artifact_id
            ),
          }
        }
        return event.data.artifact
          ? {
              artifacts: upsertArtifact(thread.artifacts ?? [], event.data.artifact),
              conversation: upsertConversationArtifact(thread.conversation, event.data.artifact),
            }
          : {}
      })
      return
    case 'display_card':
      patchThread(threadId, (thread) => ({
        conversation: projectDisplayCardEvent(thread.conversation, event, 'live'),
      }))
      return
    case 'review_ready':
      patchThread(threadId, (thread) => ({
        conversation: projectReviewReadyEvent(thread.conversation, event),
      }))
      invalidateResources()
      return
    case 'hil_requested': {
      if (!event.data.request_id) {
        patchThread(threadId, (thread) => ({
          conversation: insertTurnRuntimeItem(thread.conversation, {
            kind: 'notice',
            text: '收到缺少 request_id 的请求，已安全拒绝。',
            message: { key: 'hil.invalidRequest' },
            turnId: event.turn_id,
            itemId: event.item_id,
          }),
        }))
        return
      }
      patchThread(threadId, (thread) => ({
        ...hilRequestedRunState(thread, event.data),
        conversation: thread.conversation.some(
          (item) => item.kind === 'hil' && item.requestId === event.data.request_id
        )
          ? thread.conversation.map((item) =>
              item.kind === 'hil' && item.requestId === event.data.request_id
                ? {
                    ...item,
                    turnId: item.turnId ?? event.turn_id,
                    itemId: item.itemId ?? event.item_id,
                    eventSeq: item.eventSeq ?? event.seq,
                  }
                : item
            )
          : insertTurnRuntimeItem(
              thread.conversation,
              projectHilCard(event.data, event.ts, event.turn_id, event.item_id, event.seq)
            ),
        turnOutcomes:
          event.data.lifetime === 'session'
            ? thread.turnOutcomes
            : turnOutcomes(thread, event.turn_id, 'running'),
        turnTimings:
          event.data.lifetime === 'session'
            ? thread.turnTimings
            : turnTimings(thread, event.turn_id, productEventTime(event.ts)),
      }))
      liveIndex.current[threadId] = null
      set({ petOverride: 'waiting' })
      window.dispatchEvent(new CustomEvent('scholarseed:refresh-interactions'))
      return
    }
    case 'hil_resolved':
      patchThread(threadId, (thread) => ({
        // A declined permission resolves only this tool request; Codex still
        // owns the active turn and may continue with a failure result.  Turn
        // terminal events are the sole authority allowed to mark the session
        // done.  A stale HIL similarly leaves the current run state intact.
        ...(event.data.state === 'stale' ? {} : hilResolvedRunState(thread, event.turn_id)),
        conversation: resolveHilItem(
          thread.conversation,
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
        ),
      }))
      window.dispatchEvent(new CustomEvent('scholarseed:refresh-interactions'))
      return
    case 'usage_updated':
      set((state) => ({
        usage: {
          ...state.usage,
          inputTokens: event.data.input_tokens ?? state.usage.inputTokens,
          outputTokens: event.data.output_tokens ?? state.usage.outputTokens,
          cacheReadTokens: event.data.cache_read_tokens ?? state.usage.cacheReadTokens,
          cacheCreationTokens: event.data.cache_creation_tokens ?? state.usage.cacheCreationTokens,
        },
      }))
      return
    case 'context_compacted':
      patchThread(threadId, (thread) => ({
        conversation: [
          ...thread.conversation,
          {
            kind: 'status',
            text: event.data.message || {
              key: event.data.phase === 'completed' ? 'context.compacted' : 'context.compacting',
            },
            tone: event.data.phase === 'failed' ? 'tension' : 'inference',
            turnId: event.turn_id,
            itemId: event.item_id,
          },
        ],
      }))
      return
    case 'turn_completed':
      directiveStream.clearPrefix(threadId)
      liveIndex.current[threadId] = null
      patchThread(threadId, (thread) => ({
        running: false,
        interrupting: false,
        status: 'done',
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'completed'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts), true),
        conversation: placeFinalAssistantLast(
          settlePendingHil(thread.conversation, event.turn_id, 'stale', true),
          [event.turn_id]
        ),
      }))
      set({ petOverride: 'done' })
      invalidateResources()
      refreshMeta.current()
      return
    case 'turn_interrupted':
      directiveStream.clearPrefix(threadId)
      liveIndex.current[threadId] = null
      patchThread(threadId, (thread) => ({
        running: false,
        interrupting: false,
        status: 'abandon',
        turnOutcomes: turnOutcomes(thread, event.turn_id, 'interrupted'),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts), true),
        conversation: projectTurnInterruption(
          settlePendingHil(thread.conversation, event.turn_id, 'stale'),
          event
        ),
      }))
      set({ petOverride: 'done' })
      refreshMeta.current()
      return
    case 'turn_unknown':
      directiveStream.clearPrefix(threadId)
      liveIndex.current[threadId] = null
      if (event.data.confirmed === true) {
        patchThread(threadId, (thread) => ({
          ...reportTurnReconciled(thread, event.turn_id ?? '', productEventTime(event.ts)),
          turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts), true),
        }))
        refreshMeta.current()
        return
      }
      patchThread(threadId, (thread) => ({
        ...reportTurnUnknown(thread, {
          sessionId: event.session_id,
          turnId: event.turn_id ?? '',
          itemId: event.item_id,
          incidentId: event.data.incident_id,
          message: event.data.message,
          completedAt: productEventTime(event.ts),
        }),
        turnTimings: turnTimings(thread, event.turn_id, productEventTime(event.ts), true),
      }))
      set({ petOverride: 'error' })
      refreshMeta.current()
      return
    case 'turn_reconciled':
      patchThread(threadId, (thread) =>
        reportTurnReconciled(
          thread,
          event.data.turn_id || event.turn_id || '',
          productEventTime(event.ts)
        )
      )
      set({ petOverride: 'done' })
      refreshMeta.current()
      return
    case 'turn_failed': {
      directiveStream.clearPrefix(threadId)
      liveIndex.current[threadId] = null
      const failure = describeTurnFailure(event.data)
      patchThread(threadId, (thread) =>
        failThread(thread, failure, event.turn_id, productEventTime(event.ts))
      )
      set((current) => ({
        petOverride: 'error',
        ...(failure.failure?.kind === 'credits'
          ? { credits: markCreditsExhausted(current.credits) }
          : {}),
      }))
      refreshMeta.current()
      return
    }
    case 'operation_state':
      patchThread(threadId, (thread) =>
        reportOperationState(thread, event.data, event.turn_id, event.item_id)
      )
      return
    case 'runtime_incident':
      // 进程事件只属于它自己的会话；写回全局 readiness 会让别的会话一起被拦。
      set((state) => applyRuntimeIncident(state, threadId, event))
      if (event.data.state === 'failed') set({ petOverride: 'error' })
      return
    case 'artifact_failed':
      patchThread(threadId, (thread) => ({
        conversation: projectArtifactFailure(thread.conversation, event),
      }))
      return
    case 'runtime_error':
      if (event.data.recoverable) {
        patchThread(threadId, (thread) =>
          reportLegacyRuntimeNotice(thread, event.data.message || '', event.turn_id)
        )
        return
      }
      directiveStream.clearPrefix(threadId)
      liveIndex.current[threadId] = null
      patchThread(threadId, (thread) =>
        failThread(
          thread,
          describeTurnFailure(event.data),
          event.turn_id,
          productEventTime(event.ts)
        )
      )
      set({
        petOverride: 'error',
        foregroundError: event.data.message,
        runtimeReadiness: {
          ready: false,
          code: event.data.code,
          message: event.data.message,
          action: 'configure',
        },
      })
  }
}

function mergeLocalThreads(
  nodes: SessionNode[],
  threads: Record<string, Thread>,
  activeSession: string | null
): SessionNode[] {
  let merged = nodes
  for (const thread of Object.values(threads)) {
    if (thread.readOnly || thread.surface === 'workbench') continue
    const id = thread.sessionId ?? thread.id
    if (!id) continue
    const existing = findSessionNode(merged, id)
    const active = id === activeSession || thread.id === activeSession
    if (!active && !thread.running && !existing) continue
    const runtimeStatus = thread.status ?? (thread.running ? 'running' : undefined)
    const status: SessionStatus =
      runtimeStatus === 'waiting'
        ? 'waiting'
        : runtimeStatus === 'running'
          ? 'running'
          : runtimeStatus === 'failed' || runtimeStatus === 'abandon'
            ? runtimeStatus
            : active
              ? 'dormant'
              : (existing?.status ?? (runtimeStatus === 'done' ? 'done' : 'dormant'))
    merged = upsertSessionNode(merged, {
      ...(existing ?? {}),
      id,
      ...mergedSessionTitle(existing, thread, id),
      status,
      tone: sessionTone(status),
      meta: thread.runtime?.model_id || existing?.meta || 'Codex',
      workdir: thread.workdir ?? existing?.workdir,
      projectPath:
        thread.projectPath !== undefined ? thread.projectPath : (existing?.projectPath ?? null),
      runtimeId: thread.runtimeId ?? existing?.runtimeId,
      pulse: status === 'running' || status === 'waiting' ? (existing?.pulse ?? 1.6) : undefined,
    })
  }
  return merged
}

function reconcileThreadRuntime(
  threads: Record<string, Thread>,
  sessions: ServeSession[]
): Record<string, Thread> {
  const byId = new Map(sessions.map((session) => [session.session_id, session]))
  let next = threads
  for (const [id, thread] of Object.entries(threads)) {
    if (thread.readOnly) continue
    const session = byId.get(thread.sessionId ?? thread.id)
    if (!session) continue
    const stateCurrent = catalogRunStateIsCurrent(session, thread)
    const running = stateCurrent ? session.running === true : thread.running
    const status: SessionStatus = !stateCurrent
      ? (thread.status ?? (thread.running ? 'running' : 'done'))
      : session.recovery_blocked
        ? 'failed'
        : session.waiting
          ? 'waiting'
          : running
            ? 'running'
            : session.last_turn_status === 'failed'
              ? 'failed'
              : session.last_turn_status === 'interrupted'
                ? 'abandon'
                : thread.status === 'failed' || thread.status === 'abandon'
                  ? thread.status
                  : 'done'
    if (next === threads) next = { ...threads }
    next[id] = {
      ...thread,
      ...openedSessionTitle(session),
      running,
      recoveryBlocked: stateCurrent ? session.recovery_blocked === true : thread.recoveryBlocked,
      recoveryIncidentId: stateCurrent
        ? (session.recovery_incident_id ?? null)
        : thread.recoveryIncidentId,
      recoverySourceSeq: stateCurrent
        ? (session.recovery_source_seq ?? 0)
        : thread.recoverySourceSeq,
      recoveryPending: stateCurrent ? session.recovery_pending === true : thread.recoveryPending,
      status,
      workdir: session.runtime_workdir || session.workdir || thread.workdir,
      projectPath:
        session.project_path !== undefined ? session.project_path : (thread.projectPath ?? null),
      runtimeId: session.runtime_id,
      runtime: session.runtime,
      readiness: session.readiness ?? thread.readiness,
      capabilities: session.capabilities,
    }
  }
  return next
}

export function useLiveSession(): void {
  const { t } = useTranslation('components')
  const { state, set, patchThread, act } = useApp()
  const stateRef = useRef(state)
  // detachers 是「该线程已有活流」的唯一真相; resumeInFlight 只做并发保护。
  // 两者都不能兼职当「不要再恢复」的闸: 那种闸一旦活过一次选中就会把恢复态钉死。
  const resumeInFlight = useRef<Map<string, object>>(new Map())
  const subscriptions = useRef(new ExclusiveSubscription())
  const detachers = useRef<Record<string, () => void>>({})
  const liveIndex = useRef<Record<string, number | null>>({})
  const refreshMetaRef = useRef<() => void>(() => undefined)
  const resumeAttempts = useRef<Map<string, number>>(new Map())
  const resumeRetryTimers = useRef<Record<string, number>>({})
  const resumeStopped = useRef<Set<string>>(new Set())
  const serviceInstance = useRef<string | null>(null)
  const metadataRequest = useRef(0)
  const metadataPollInFlight = useRef<{ dirty: boolean } | null>(null)
  const summarySequences = useRef(new Map<string, number>())
  const bodySequences = useRef(new Map<string, number>())
  const metadataSessions = useRef<ServeSession[] | null>(null)
  const metadataRetryAttempt = useRef(0)
  const metadataRetryTimer = useRef<number | null>(null)
  const disposed = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const report = (event: Event): void => {
      const detail = (event as CustomEvent<BackendFailureDetail>).detail
      if (detail?.scope === BACKEND_ADMISSION_FAILURE) {
        set({
          foregroundError: detail.applicationFailure
            ? requestFailureFeedback(detail.applicationFailure)
            : turnAdmissionFeedback(detail),
        })
        return
      }
      const sessionId = String(detail?.sessionId ?? '')
      const threadId = Object.entries(stateRef.current.threads).find(
        ([, thread]) => thread.sessionId === sessionId
      )?.[0]
      if (!threadId) {
        set({
          foregroundError: detail?.applicationFailure
            ? requestFailureFeedback(detail.applicationFailure)
            : detail?.message != null
              ? String(detail.message)
              : feedback('components', 'composer.backendUnavailable'),
          petOverride: 'error',
        })
        return
      }
      liveIndex.current[threadId] = null
      patchThread(threadId, (thread) =>
        failThread(
          thread,
          {
            ...describeTurnFailure({ message: String(detail?.message ?? ''), code: detail?.code }),
            ...(detail?.applicationFailure
              ? { applicationFailure: detail.applicationFailure }
              : {}),
          },
          undefined,
          Date.now()
        )
      )
      set({ petOverride: 'error' })
    }
    window.addEventListener(BACKEND_FAILURE_EVENT, report)
    return () => window.removeEventListener(BACKEND_FAILURE_EVENT, report)
  }, [patchThread, set, t])

  const ensure = useCallback(
    async (threadId: string, sessionId: string | undefined, refreshSnapshot = false) => {
      if (!stateRef.current.workbenchReady || stateRef.current.runtimeQuiescing) return
      if (stateRef.current.activeSession !== threadId) return
      if (stateRef.current.threads[threadId]?.readOnly) return
      if (resumeInFlight.current.has(threadId)) return
      if (detachers.current[threadId] || resumeStopped.current.has(threadId)) return
      if (!sessionId) {
        // 没有 sessionId 的线程恢复不了; 标停才不会被 threads 变更反复重入。
        resumeStopped.current.add(threadId)
        patchThread(threadId, { resumeState: 'failed', resumeMessage: undefined })
        return
      }

      const reportFailure = (failure: SessionResumeFailure, recoveryBlocked = false): void => {
        const attempt = (resumeAttempts.current.get(sessionId) ?? 0) + 1
        resumeAttempts.current.set(sessionId, attempt)
        const canRetry =
          !recoveryBlocked &&
          shouldRetrySessionResume(failure, attempt, SESSION_RESUME_MAX_ATTEMPTS)
        const delay = Math.min(
          SESSION_RESUME_MAX_DELAY_MS,
          SESSION_RESUME_INITIAL_DELAY_MS * 2 ** (attempt - 1)
        )
        console.info(
          '[session-recovery]',
          JSON.stringify({
            stage: 'retry-decision',
            sessionId,
            threadId,
            attempt,
            retry: canRetry,
            delayMs: delay,
            status: failure.status,
            recoveryBlocked,
          })
        )
        patchThread(threadId, (thread) => ({
          ...projectResumeRunState(thread),
          resumeState: canRetry ? 'pending' : 'failed',
          resumeMessage: canRetry
            ? { key: 'resume.retry', attempt, maximum: SESSION_RESUME_MAX_ATTEMPTS }
            : undefined,
          ...reportSessionResume(
            thread,
            sessionId,
            canRetry
              ? {
                  key: 'resume.retrying',
                  attempt,
                  maximum: SESSION_RESUME_MAX_ATTEMPTS,
                  reason: failure.applicationFailure ?? failure.message,
                }
              : { key: 'resume.stopped', reason: failure.applicationFailure ?? failure.message },
            canRetry ? 'inference' : 'tension',
            !canRetry
          ),
        }))
        if (resumeRetryTimers.current[threadId] !== undefined) {
          window.clearTimeout(resumeRetryTimers.current[threadId])
          delete resumeRetryTimers.current[threadId]
        }
        if (!canRetry) {
          resumeStopped.current.add(threadId)
          return
        }
        resumeRetryTimers.current[threadId] = window.setTimeout(() => {
          delete resumeRetryTimers.current[threadId]
          void ensure(threadId, sessionId)
        }, delay)
      }

      const attempt = {}
      const lease = subscriptions.current.claim(threadId)
      resumeInFlight.current.set(threadId, attempt)
      const startedAt = Date.now()
      const generation = startupSnapshot().generation
      const instance = stateRef.current.serviceInstanceId
      const current = (): boolean => {
        const snapshot = stateRef.current
        const thread = snapshot.threads[threadId]
        return (
          !disposed.current &&
          lease.current() &&
          startupSnapshot().generation === generation &&
          startupSnapshot().phase === STARTUP_PHASE.ready &&
          snapshot.backendReady &&
          !snapshot.runtimeQuiescing &&
          snapshot.workbenchReady &&
          snapshot.serviceInstanceId === instance &&
          thread?.sessionId === sessionId &&
          !thread.readOnly &&
          snapshot.activeSession === threadId
        )
      }
      const diagnostic = (stage: string, detail: Record<string, unknown> = {}): void => {
        console.info(
          '[session-recovery]',
          JSON.stringify({
            stage,
            sessionId,
            threadId,
            serviceInstanceId: instance,
            elapsedMs: Date.now() - startedAt,
            ...detail,
          })
        )
      }
      diagnostic('started')
      const waitForReconfiguration = async (): Promise<boolean> => {
        const pause = (): boolean => {
          diagnostic('reconfiguration-wait')
          patchThread(threadId, {
            resumeState: 'pending',
            resumeMessage: { key: 'resume.runtimeSwitch', serviceInstanceId: instance },
          })
          if (resumeRetryTimers.current[threadId] !== undefined) {
            window.clearTimeout(resumeRetryTimers.current[threadId])
          }
          resumeRetryTimers.current[threadId] = window.setTimeout(() => {
            delete resumeRetryTimers.current[threadId]
            void ensure(threadId, sessionId)
          }, RECONFIGURATION_POLL_MS)
          return true
        }
        try {
          const shared = await getSharedRuntimeReconfiguration()
          if (!current()) return true
          if (shared.service_instance_id !== instance) {
            diagnostic('superseded-instance')
            return true
          }
          const decision = reconfigurationRecovery(shared.state, false)
          if (decision === RECONFIGURATION_RECOVERY.wait) return pause()
          if (decision === RECONFIGURATION_RECOVERY.blocked) {
            patchThread(threadId, {
              resumeState: 'failed',
              resumeMessage: { key: 'resume.runtimeSwitchBlocked' },
            })
            resumeStopped.current.add(threadId)
            return true
          }
          return false
        } catch {
          if (!current()) return true
          diagnostic('reconfiguration-status-unavailable')
          const waiting = stateRef.current.threads[threadId]?.resumeMessage
          const knownWaiting =
            waiting?.key === 'resume.runtimeSwitch' && waiting.serviceInstanceId === instance
          if (reconfigurationRecovery(undefined, knownWaiting) === RECONFIGURATION_RECOVERY.wait) {
            return pause()
          }
          return false
        }
      }
      const attach = (fromSeq: number): void => {
        lease.attach(() => {
          detachers.current[threadId] = streamEvents(
            sessionId,
            fromSeq,
            (event) => {
              if (!current()) return
              onEvent(
                threadId,
                event,
                patchThread,
                set,
                liveIndex,
                refreshMetaRef,
                act.invalidateResources,
                (scopes) => {
                  // 数据域 → 失效动作。新增一个域只要这张表加一行, 界面组件不需要声明
                  // 自己读的是哪个实体; 没登记的域直接忽略 (旧界面收到新版本才有的域名)。
                  const invalidators: Record<string, () => void> = {
                    [PRODUCT_DATA_SCOPE_LITERATURE]: act.invalidateLiterature,
                    [PRODUCT_DATA_SCOPE_RESOURCES]: act.invalidateResources,
                  }
                  for (const scope of scopes) invalidators[scope]?.()
                },
                (activeSessionId) => {
                  if (stateRef.current.activeSession === activeSessionId) {
                    void act.loadAiContext(activeSessionId)
                  }
                },
                (activeSessionId) => {
                  if (stateRef.current.activeSession === activeSessionId) {
                    void act.reloadArtifactLinks(activeSessionId)
                  }
                },
                stateRef.current.workbenchReady
              )
              bodySequences.current.set(sessionId, event.seq)
              patchThread(threadId, { lastSeq: event.seq })
            },
            (connectionState) => {
              if (current())
                patchThread(threadId, (thread) => reportTransportState(thread, connectionState))
            },
            (reason) => {
              diagnostic('requested', { reason })
              detachers.current[threadId]?.()
              delete detachers.current[threadId]
              delete liveIndex.current[threadId]
              if (current())
                queueMicrotask(() => {
                  if (current())
                    void ensure(threadId, sessionId, reason === 'gap' || reason === 'projection')
                })
            }
          )
          return detachers.current[threadId]
        })
      }
      try {
        const cached = stateRef.current.threads[threadId]
        if (
          current() &&
          !refreshSnapshot &&
          cached.resumeServiceInstanceId === instance &&
          cached.resumeState !== 'failed'
        ) {
          attach(Math.max(cached.lastSeq ?? 0, bodySequences.current.get(sessionId) ?? 0))
          patchThread(threadId, { resumeState: 'ready', resumeMessage: undefined })
          return
        }
        if (await waitForReconfiguration()) return
        patchThread(threadId, {
          resumeState: 'pending',
          resumeMessage: { key: 'resume.agent' },
        })
        const opened = await openSession({ resumeSessionId: sessionId })
        if (!current()) {
          diagnostic('superseded')
          return
        }
        if (!opened || !('session_id' in opened) || !opened.session_id) {
          if (await waitForReconfiguration()) return
          const history = await getHistoryWithTodos(sessionId)
          if (!current()) {
            diagnostic('superseded')
            return
          }
          if (history) {
            patchThread(threadId, (thread) => ({
              conversation: projectHistorySnapshot(history, thread.conversation),
              todos: history.todos,
              todoTurnId: history.todo_turn_id,
              planSnapshots: projectPlanSnapshots(history.activity_events),
              artifacts: history.artifacts,
              recoveryBlocked: history.recovery_blocked === true,
              recoveryIncidentId: history.recovery_incident_id ?? null,
              recoverySourceSeq: history.recovery_source_seq ?? 0,
              recoveryPending: history.recovery_pending === true,
            }))
          }
          reportFailure(classifySessionResumeFailure(opened), history?.recovery_blocked === true)
          return
        }

        const runtimeRoot = opened.runtime_workdir || opened.workdir
        if (runtimeRoot) {
          const authorized = await window.scholarseed
            .addAuthorizedRoot('session', runtimeRoot)
            .catch(() => false)
          if (!current()) {
            diagnostic('superseded')
            return
          }
          if (!authorized) {
            // 目录授权要用户处理, 重试无意义; 标停后由重新连接或重新选中会话再触发。
            resumeStopped.current.add(threadId)
            patchThread(threadId, {
              resumeState: 'failed',
              resumeMessage: undefined,
            })
            set({ foregroundError: feedback('shell', 'foreground.workspaceAuthorization') })
            return
          }
        }

        const [history, queuedMessages] = await Promise.all([
          getHistoryWithTodos(sessionId),
          listQueuedMessages(sessionId),
        ])
        if (!current()) {
          diagnostic('superseded')
          return
        }
        if (!history || queuedMessages === null) {
          diagnostic('snapshot-unavailable', {
            historyAvailable: Boolean(history),
            queueAvailable: queuedMessages !== null,
          })
          reportFailure({
            message: SESSION_HISTORY_UNAVAILABLE,
            applicationFailure: { key: 'request.historyUnavailable' },
            status: 0,
            terminal: false,
          })
          return
        }
        resumeAttempts.current.delete(sessionId)
        resumeStopped.current.delete(threadId)
        if (resumeRetryTimers.current[threadId] !== undefined) {
          window.clearTimeout(resumeRetryTimers.current[threadId])
          delete resumeRetryTimers.current[threadId]
        }
        const {
          todos,
          todo_turn_id: historyTodoTurnId,
          artifacts,
          turn_activity: turnActivity,
        } = history
        const durableTurnActivity = snapshotTurnActivity(turnActivity)
        const fromSeq = opened.last_seq ?? 0
        patchThread(threadId, (thread) => {
          const artifactSnapshot = opened.artifacts ?? artifacts
          const conversation = projectHistorySnapshot(
            {
              ...history,
              artifacts: artifactSnapshot,
            },
            thread.conversation
          )
          const recovered = reportSessionResume(
            { ...thread, conversation },
            sessionId,
            { key: 'resume.reconnected' },
            'experience',
            false,
            true
          )
          const base = {
            ...thread,
            ...openedSessionTitle(opened),
            conversation: recovered.conversation ?? conversation,
            todos: opened.todos ?? todos,
            todoTurnId: opened.todo_turn_id !== undefined ? opened.todo_turn_id : historyTodoTurnId,
            planSnapshots: projectPlanSnapshots(history.activity_events, thread.planSnapshots),
            turnOutcomes:
              opened.last_turn_id && opened.last_turn_status
                ? {
                    ...thread.turnOutcomes,
                    ...durableTurnActivity.turnOutcomes,
                    [opened.last_turn_id]: recoveredTurnOutcome(opened.last_turn_status),
                  }
                : {
                    ...thread.turnOutcomes,
                    ...durableTurnActivity.turnOutcomes,
                  },
            turnTimings: {
              ...thread.turnTimings,
              ...durableTurnActivity.turnTimings,
            },
            artifacts: artifactSnapshot,
            workdir: opened.runtime_workdir || opened.workdir || thread.workdir,
            projectPath:
              opened.project_path !== undefined
                ? opened.project_path
                : (thread.projectPath ?? null),
            runtimeId: opened.runtime_id,
            runtime: opened.runtime,
            readiness: opened.readiness,
            capabilities: opened.capabilities,
            lastSeq: fromSeq,
            resumeState: 'ready' as const,
            resumeServiceInstanceId: instance ?? undefined,
            resumeMessage: undefined,
            running: Boolean(opened.running),
            recoveryBlocked: opened.recovery_blocked === true,
            recoveryIncidentId: opened.recovery_incident_id ?? null,
            recoverySourceSeq: opened.recovery_source_seq ?? 0,
            recoveryPending: opened.recovery_pending === true,
            interrupting: Boolean(opened.interrupting),
            queuedMessages: mergeQueuedOutbox(
              sessionId,
              (queuedMessages ?? []).map(queuedMessageFromPayload),
              stateRef.current.workbenchReady,
              thread.queuedMessages ?? []
            ),
            status: opened.running
              ? ('running' as const)
              : opened.last_turn_status === 'failed'
                ? ('failed' as const)
                : opened.last_turn_status === 'interrupted'
                  ? ('abandon' as const)
                  : ('done' as const),
          }
          return {
            ...base,
            ...projectSessionRecovery(base, {
              sessionId,
              running: Boolean(opened.running),
              activeTurnId: opened.active_turn_id,
              unknownOutcome: opened.unknown_outcome,
              pendingHil: opened.pending_hil ?? [],
              uncertainOperations: opened.uncertain_operations,
              timestamp: Date.now(),
            }),
          }
        })

        bodySequences.current.set(sessionId, fromSeq)
        attach(fromSeq)
        diagnostic('restored', {
          sequence: fromSeq,
          running: Boolean(opened.running),
          queuedCount: queuedMessages.length,
          planCount: (opened.todos ?? todos).length,
          previousSequence: stateRef.current.threads[threadId]?.lastSeq,
        })
      } catch (error) {
        diagnostic('failed', { errorName: error instanceof Error ? error.name : 'unknown' })
        if (current())
          reportFailure({
            message: SESSION_HISTORY_UNAVAILABLE,
            applicationFailure: { key: 'request.historyUnavailable' },
            status: 0,
            terminal: false,
          })
      } finally {
        const ownsAttempt = resumeInFlight.current.get(threadId) === attempt
        if (ownsAttempt) resumeInFlight.current.delete(threadId)
        const snapshot = stateRef.current
        const thread = snapshot.threads[threadId]
        if (
          ownsAttempt &&
          startupSnapshot().generation === generation &&
          !current() &&
          !disposed.current &&
          snapshot.backendReady &&
          !snapshot.runtimeQuiescing &&
          thread &&
          !thread.readOnly &&
          snapshot.activeSession === threadId &&
          !detachers.current[threadId]
        ) {
          patchThread(threadId, { resumeState: 'pending' })
        }
      }
    },
    [
      act.invalidateLiterature,
      act.invalidateResources,
      act.loadAiContext,
      act.reloadArtifactLinks,
      patchThread,
      set,
    ]
  )

  useEffect(() => {
    const reconnect = (event: Event): void => {
      const sessionId = String(
        (event as CustomEvent<SessionResumeRequestDetail>).detail?.sessionId ?? ''
      )
      const entry = Object.entries(stateRef.current.threads).find(
        ([, thread]) => thread.sessionId === sessionId
      )
      if (!sessionId || !entry) return
      const [threadId] = entry
      if (!resumeStopped.current.has(threadId)) return
      if (resumeRetryTimers.current[threadId] !== undefined) {
        window.clearTimeout(resumeRetryTimers.current[threadId])
        delete resumeRetryTimers.current[threadId]
      }
      resumeStopped.current.delete(threadId)
      resumeAttempts.current.delete(sessionId)
      patchThread(threadId, (thread) => ({
        resumeState: 'pending',
        resumeMessage: { key: 'resume.reconnect' },
        ...reportSessionResume(thread, sessionId, { key: 'resume.reconnect' }, 'inference'),
      }))
      void ensure(threadId, sessionId)
    }
    window.addEventListener(SESSION_RESUME_REQUEST_EVENT, reconnect)
    return () => window.removeEventListener(SESSION_RESUME_REQUEST_EVENT, reconnect)
  }, [ensure, patchThread])

  const cancelMetadataRetry = useCallback(() => {
    if (metadataRetryTimer.current !== null) {
      window.clearTimeout(metadataRetryTimer.current)
      metadataRetryTimer.current = null
    }
  }, [])

  const scheduleMetadataRetry = useCallback(() => {
    if (metadataRetryTimer.current !== null) return
    const delay = sessionCatalogRetryDelay(metadataRetryAttempt.current)
    metadataRetryAttempt.current += 1
    metadataRetryTimer.current = window.setTimeout(() => {
      metadataRetryTimer.current = null
      refreshMetaRef.current()
    }, delay)
  }, [])

  const refreshMeta = useCallback(async () => {
    const startup = startupSnapshot()
    if (startup.phase !== STARTUP_PHASE.ready || stateRef.current.runtimeQuiescing) return
    if (metadataPollInFlight.current) {
      metadataPollInFlight.current.dirty = true
      return
    }
    const marker = { dirty: false }
    metadataPollInFlight.current = marker
    try {
      const request = ++metadataRequest.current
      if (stateRef.current.workspaceLoadState !== 'ready') {
        set({ workspaceLoadState: 'loading' })
      }
      const [projects, sessionCatalog] = await Promise.all([
        listProjects(),
        loadSessionCatalog({ limit: 60, scope: 'all' }),
      ])
      if (
        request !== metadataRequest.current ||
        stateRef.current.runtimeQuiescing ||
        startupSnapshot().generation !== startup.generation ||
        startupSnapshot().phase !== STARTUP_PHASE.ready
      )
        return
      if (!sessionCatalog.ok) {
        const projection = projectCatalogFailure(
          stateRef.current.workspaceLoadState,
          sessionCatalog.failure.retryable
        )
        if (projection.retry) {
          scheduleMetadataRetry()
        } else {
          cancelMetadataRetry()
          metadataRetryAttempt.current = 0
        }
        set(() => ({
          workspaceLoadState: projection.workspaceLoadState,
          ...(projection.workspaceLoadState === 'ready'
            ? {
                foregroundError: sessionCatalog.failure.retryable
                  ? SESSION_CATALOG_RECOVERY_NOTICE
                  : SESSION_CATALOG_UNAVAILABLE_NOTICE,
              }
            : {}),
        }))
        return
      }
      cancelMetadataRetry()
      metadataRetryAttempt.current = 0
      if (!projects) scheduleMetadataRetry()
      const sessions = sessionCatalog.catalog.sessions
      const catalogChanged = !sameSessionCatalog(metadataSessions.current, sessions)
      metadataSessions.current = sessions
      const catalogSessionIds = new Set(sessions.map((session) => session.session_id))
      const currentSnapshot = stateRef.current
      const nowSeconds = Date.now() / 1_000
      Object.entries(detachers.current).forEach(([threadId, detach]) => {
        const thread = currentSnapshot.threads[threadId]
        const sessionId = thread?.sessionId
        if (
          !thread ||
          !sessionId ||
          retainCatalogThread(
            threadId,
            thread,
            currentSnapshot.sessions,
            catalogSessionIds,
            currentSnapshot.activeSession,
            nowSeconds,
            SESSION_CATALOG_APPEARANCE_GRACE_SECONDS
          )
        )
          return
        detach()
        delete detachers.current[threadId]
        resumeStopped.current.delete(threadId)
        resumeAttempts.current.delete(sessionId)
        if (resumeRetryTimers.current[threadId] !== undefined) {
          window.clearTimeout(resumeRetryTimers.current[threadId])
          delete resumeRetryTimers.current[threadId]
        }
        delete liveIndex.current[threadId]
      })
      set((current) => {
        let sessionActivitySeen = current.sessionActivitySeen
        const visibleSessions = sessions.filter(
          (session) => current.threads[session.session_id]?.surface !== 'workbench'
        )
        const markSeen = (sessionId: string, activityAt: number): void => {
          if (sessionActivitySeen[sessionId] === activityAt) return
          if (sessionActivitySeen === current.sessionActivitySeen) {
            sessionActivitySeen = { ...sessionActivitySeen }
          }
          sessionActivitySeen[sessionId] = activityAt
        }
        if (!current.sessionActivityInitialized) {
          visibleSessions.forEach((session) =>
            markSeen(session.session_id, session.mtime ?? session.created_at ?? 0)
          )
        }
        visibleSessions.forEach((session) => {
          if (
            session.session_id === current.activeSession &&
            !session.running &&
            !session.waiting
          ) {
            markSeen(session.session_id, session.mtime ?? session.created_at ?? 0)
          }
        })
        const threads = reconcileThreadRuntime(
          pruneMissingCatalogThreads(
            current.threads,
            current.sessions,
            catalogSessionIds,
            current.activeSession,
            nowSeconds,
            SESSION_CATALOG_APPEARANCE_GRACE_SECONDS
          ),
          sessions
        )
        const activeSession =
          current.activeSession &&
          threads[current.activeSession]?.surface !== 'workbench' &&
          (catalogSessionIds.has(current.activeSession) || Boolean(threads[current.activeSession]))
            ? current.activeSession
            : null
        return {
          ...(projects
            ? {
                projects: projects.projects,
                projectsLoaded: true,
                defaultWorkspacePath: projects.default || current.defaultWorkspacePath,
              }
            : {}),
          sessionActivityInitialized: true,
          sessionCatalogRevision: current.sessionCatalogRevision + Number(catalogChanged),
          workspaceLoadState: projects || current.projectsLoaded ? 'ready' : 'error',
          foregroundError:
            current.foregroundError === SESSION_CATALOG_RECOVERY_NOTICE ||
            current.foregroundError === SESSION_CATALOG_UNAVAILABLE_NOTICE
              ? null
              : current.foregroundError,
          sessionActivitySeen,
          activeSession,
          threads,
          sessions: mergeLocalThreads(
            visibleSessions.map((session) =>
              serveSessionNode(session, sessionActivitySeen, activeSession)
            ),
            threads,
            activeSession
          ),
        }
      })
    } finally {
      if (metadataPollInFlight.current === marker) {
        metadataPollInFlight.current = null
        if (marker.dirty) refreshMetaRef.current()
      }
    }
  }, [cancelMetadataRetry, scheduleMetadataRetry, set])

  refreshMetaRef.current = () => void refreshMeta()

  const pollMetadata = useCallback(() => void refreshMeta(), [refreshMeta])

  useEffect(() => cancelMetadataRetry, [cancelMetadataRetry])

  useEffect(() => {
    if (!state.backendReady || state.runtimeQuiescing) {
      subscriptions.current.clear()
      metadataRequest.current += 1
      cancelMetadataRetry()
      metadataRetryAttempt.current = 0
      metadataPollInFlight.current = null
      Object.values(detachers.current).forEach((detach) => detach())
      Object.keys(detachers.current).forEach((threadId) => delete detachers.current[threadId])
      Object.values(resumeRetryTimers.current).forEach((timer) => window.clearTimeout(timer))
      Object.keys(resumeRetryTimers.current).forEach(
        (threadId) => delete resumeRetryTimers.current[threadId]
      )
      resumeInFlight.current.clear()
    }
  }, [cancelMetadataRetry, state.backendReady, state.runtimeQuiescing])

  useEffect(() => {
    const next = state.serviceInstanceId
    const previous = serviceInstance.current
    if (!next) return
    serviceInstance.current = next
    if (!previous || previous === next) return
    subscriptions.current.clear()
    bodySequences.current.clear()
    resumeInFlight.current.clear()
    Object.values(detachers.current).forEach((detach) => detach())
    Object.keys(detachers.current).forEach((threadId) => delete detachers.current[threadId])
    resumeAttempts.current.clear()
    resumeStopped.current.clear()
    Object.values(resumeRetryTimers.current).forEach((timer) => window.clearTimeout(timer))
    Object.keys(resumeRetryTimers.current).forEach(
      (threadId) => delete resumeRetryTimers.current[threadId]
    )
    cancelMetadataRetry()
    metadataRetryAttempt.current = 0
    const active = stateRef.current.activeSession
    const thread = active ? stateRef.current.threads[active] : undefined
    if (active && thread) void ensure(active, thread.sessionId ?? undefined)
    void refreshMeta()
  }, [cancelMetadataRetry, ensure, refreshMeta, state.serviceInstanceId])

  useEffect(() => {
    if (state.backendReady && !state.runtimeQuiescing) void refreshMeta()
  }, [refreshMeta, state.backendReady, state.runtimeQuiescing])

  useEffect(() => {
    // The HTTP listener is available before activation admits model operations.
    // Reload on workbench admission and service replacement, not listener health.
    if (!state.backendReady || !state.workbenchReady || state.runtimeQuiescing) return
    let revision = 0
    const reloadCatalog = (): void => {
      const request = ++revision
      void getModels().then((catalog) => {
        if (request === revision) act.applyModelCatalog(catalog)
      })
    }
    reloadCatalog()
    window.addEventListener('scholarseed:auth-restored', reloadCatalog)
    window.addEventListener('scholarseed:auth-required', reloadCatalog)
    return () => {
      revision += 1
      window.removeEventListener('scholarseed:auth-restored', reloadCatalog)
      window.removeEventListener('scholarseed:auth-required', reloadCatalog)
    }
  }, [
    act,
    state.backendReady,
    state.workbenchReady,
    state.serviceInstanceId,
    state.runtimeQuiescing,
  ])

  useEffect(() => {
    const refresh = (): void => void refreshMeta()
    window.addEventListener('scholarseed:refresh-session-list', refresh)
    return () => window.removeEventListener('scholarseed:refresh-session-list', refresh)
  }, [refreshMeta])

  const catalogRefreshNeeded =
    state.mainView === 'home' ||
    sessionCatalogNeedsRefresh(state.sessions, state.activeSession, state.threads)
  useEffect(() => {
    if (!state.backendReady || state.runtimeQuiescing || !catalogRefreshNeeded) return
    if (window.scholarseed?.notifications) return
    const timer = window.setInterval(() => pollMetadata(), BACKGROUND_SESSION_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [pollMetadata, state.backendReady, state.runtimeQuiescing, catalogRefreshNeeded])

  useEffect(() => {
    if (!state.backendReady || !state.workbenchReady || state.runtimeQuiescing) return
    summarySequences.current.clear()
    const refresh = new DirtyRefresh(
      async (signal) => {
        const threads = Object.values(stateRef.current.threads).filter(
          (thread) => thread.sessionId && !thread.readOnly
        )
        const sessionIds = threads.map((thread) => thread.sessionId!)
        const snapshots = await loadSessionStatus(
          sessionIds,
          Object.fromEntries(
            threads.map((thread) => [
              thread.sessionId!,
              (thread.queuedMessages ?? []).map((message) => message.queuedMessageId),
            ])
          ),
          signal
        )
        return { sessionIds, snapshots }
      },
      ({ sessionIds, snapshots }) => {
        let catalogInvalidated = sessionIds.some(
          (sessionId) => !snapshots.some((snapshot) => snapshot.session_id === sessionId)
        )
        for (const snapshot of snapshots) {
          if (snapshot.summary_seq < (summarySequences.current.get(snapshot.session_id) ?? 0))
            continue
          summarySequences.current.set(snapshot.session_id, snapshot.summary_seq)
          catalogInvalidated ||= sessionSummaryNeedsCatalog(
            metadataSessions.current?.find((session) => session.session_id === snapshot.session_id),
            snapshot
          )
          for (const identity of snapshot.acknowledged_queue_ids)
            releaseQueuedOutbox(snapshot.session_id, identity)
          const entry = Object.entries(stateRef.current.threads).find(
            ([, thread]) => thread.sessionId === snapshot.session_id
          )
          if (!entry || entry[0] === stateRef.current.activeSession) continue
          const threadId = entry[0]
          patchThread(threadId, (thread) => {
            if (snapshot.summary_seq < (thread.lastSeq ?? 0)) return thread
            const projected = reconcileThreadRuntime({ [threadId]: thread }, [
              { ...snapshot, last_seq: snapshot.summary_seq },
            ])[threadId]
            return {
              ...projected,
              ...projectSessionRecovery(projected, {
                sessionId: snapshot.session_id,
                running: Boolean(snapshot.running),
                activeTurnId: snapshot.active_turn_id,
                unknownOutcome: snapshot.unknown_outcome,
                pendingHil: snapshot.pending_hil ?? [],
                uncertainOperations: snapshot.uncertain_operations,
                timestamp: Date.now(),
              }),
              interrupting: Boolean(snapshot.interrupting),
              queuedMessages: mergeQueuedOutbox(
                snapshot.session_id,
                snapshot.queued_messages.map(queuedMessageFromPayload),
                stateRef.current.workbenchReady,
                thread.queuedMessages ?? []
              ),
              turnOutcomes:
                snapshot.last_turn_id && snapshot.last_turn_status
                  ? {
                      ...thread.turnOutcomes,
                      [snapshot.last_turn_id]: recoveredTurnOutcome(snapshot.last_turn_status),
                    }
                  : thread.turnOutcomes,
            }
          })
        }
        if (catalogInvalidated) pollMetadata()
      },
      (error) => console.warn('[session-status] refresh unavailable', error)
    )
    const unsubscribe = subscribeChanges(['sessions', 'projects'], (reset, changes) => {
      if (
        reset ||
        changes.some(
          (change) =>
            change.topic === 'projects' ||
            (change.topic === 'sessions' &&
              !Object.values(stateRef.current.threads).some(
                (thread) => thread.sessionId === change.subject && !thread.readOnly
              ))
        )
      )
        pollMetadata()
      refresh.invalidate(reset)
    })
    const resources = subscribeChanges(['resources'], act.invalidateResources)
    const literature = subscribeChanges(['literature'], act.invalidateLiterature)
    refresh.invalidate()
    return () => {
      refresh.stop()
      unsubscribe()
      resources()
      literature()
    }
  }, [
    state.backendReady,
    state.workbenchReady,
    state.runtimeQuiescing,
    state.serviceInstanceId,
    pollMetadata,
    patchThread,
    act.invalidateResources,
    act.invalidateLiterature,
  ])

  useEffect(() => {
    if (!state.backendReady || !state.workbenchReady || state.runtimeQuiescing) return
    const targets = new Set<string>()
    if (state.activeSession && !state.threads[state.activeSession]?.readOnly)
      targets.add(state.activeSession)
    subscriptions.current.retain(state.activeSession)
    for (const threadId of resumeInFlight.current.keys()) {
      if (!targets.has(threadId)) resumeInFlight.current.delete(threadId)
    }
    for (const [threadId, timer] of Object.entries(resumeRetryTimers.current)) {
      if (!targets.has(threadId)) {
        window.clearTimeout(timer)
        delete resumeRetryTimers.current[threadId]
      }
    }

    targets.forEach((threadId) => {
      const thread = state.threads[threadId]
      if (!thread) return
      if (resumeInFlight.current.has(threadId) || resumeRetryTimers.current[threadId] !== undefined)
        return
      if (detachers.current[threadId]) {
        // 已有活流: 选中时 store 写下的 pending 没有别的写入方, 必须在这里落回, 否则
        // 界面会停在「正在恢复对话」而背后其实一直在直播。
        if (thread.resumeState === 'pending') {
          patchThread(threadId, { resumeState: 'ready', resumeMessage: undefined })
        }
        return
      }
      if (thread.resumeState === 'pending') {
        // 用户主动选中会话就是一次显式重连意图, 等价于点了「重新连接」。
        resumeStopped.current.delete(threadId)
        if (thread.sessionId) resumeAttempts.current.delete(thread.sessionId)
      }
      void ensure(threadId, thread.sessionId ?? undefined)
    })

    Object.entries(detachers.current).forEach(([threadId, detach]) => {
      if (targets.has(threadId)) return
      detach()
      delete detachers.current[threadId]
      resumeStopped.current.delete(threadId)
      delete liveIndex.current[threadId]
    })
  }, [
    ensure,
    patchThread,
    state.activeSession,
    state.backendReady,
    state.runtimeQuiescing,
    state.workbenchReady,
    state.threads,
  ])

  useEffect(() => {
    const current = detachers.current
    const timers = resumeRetryTimers.current
    disposed.current = false
    return () => {
      disposed.current = true
      subscriptions.current.clear()
      Object.values(current).forEach((detach) => detach())
      Object.values(timers).forEach((timer) => window.clearTimeout(timer))
    }
  }, [])
}
