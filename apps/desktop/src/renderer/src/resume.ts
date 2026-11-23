import {
  getHistoryWithTodos,
  listQueuedMessages,
  openSession,
  type HistoryResult,
  type OpenResp,
  type QueuedMessagePayload,
} from './api.ts'
import type { Cognitive, ConvItem, Thread } from './model'
import { mergeQueuedOutbox } from './outbox.ts'
import { queuedMessageFromPayload } from './queue.ts'
import { projectSessionRecovery, recoveredTurnOutcome, sessionResumeStatusItem } from './runtime.ts'
import { openedSessionTitle } from './session.ts'
import { projectPlanSnapshots } from './todo.ts'
import {
  insertTurnRuntimeItem,
  projectHistorySnapshot,
  snapshotTurnActivity,
} from './transcript.ts'

interface SessionResumeSnapshot {
  opened: OpenResp
  history: HistoryResult
  queuedMessages: QueuedMessagePayload[] | null
}

/** Prepare startup history without attaching a product stream or activating a view. */
export async function prepareStartupSession(
  sessionId: string,
  signal: AbortSignal
): Promise<SessionResumeSnapshot | null> {
  if (signal.aborted) return null
  const opened = await openSession({ resumeSessionId: sessionId, signal })
  if (!opened || !('session_id' in opened) || opened.session_id !== sessionId || signal.aborted)
    return null

  const runtimeRoot = opened.runtime_workdir || opened.workdir
  if (runtimeRoot && !(await window.scholarseed.addAuthorizedRoot('session', runtimeRoot)))
    return null
  if (signal.aborted) return null

  // Read history after open captures the cursor. The queue can finish independently.
  const queue = new AbortController()
  let queuedMessages: QueuedMessagePayload[] | null = null
  void listQueuedMessages(sessionId, AbortSignal.any([signal, queue.signal])).then((messages) => {
    queuedMessages = messages
  })
  try {
    const history = await getHistoryWithTodos(sessionId, signal)
    return history && !signal.aborted ? { opened, history, queuedMessages } : null
  } finally {
    queue.abort()
  }
}

export function reportSessionResume(
  thread: Thread,
  sessionId: string,
  text: Extract<ConvItem, { kind: 'status' }>['text'],
  tone: Cognitive,
  actionable = false,
  replaceOnly = false
): Partial<Thread> {
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

export function projectResumedSession(
  thread: Thread,
  {
    opened,
    history,
    queuedMessages,
    serviceInstanceId,
    acknowledgeQueue,
    timestamp,
  }: SessionResumeSnapshot & {
    serviceInstanceId: string | null
    acknowledgeQueue: boolean
    timestamp: number
  }
): Thread {
  const sessionId = opened.session_id
  const artifactSnapshot = opened.artifacts ?? history.artifacts
  const durableTurnActivity = snapshotTurnActivity(history.turn_activity)
  const conversation = projectHistorySnapshot(
    { ...history, artifacts: artifactSnapshot },
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
    todos: opened.todos ?? history.todos,
    todoTurnId: opened.todo_turn_id !== undefined ? opened.todo_turn_id : history.todo_turn_id,
    planSnapshots: projectPlanSnapshots(history.activity_events, thread.planSnapshots),
    turnOutcomes: {
      ...thread.turnOutcomes,
      ...durableTurnActivity.turnOutcomes,
      ...(opened.last_turn_id && opened.last_turn_status
        ? { [opened.last_turn_id]: recoveredTurnOutcome(opened.last_turn_status) }
        : {}),
    },
    turnTimings: { ...thread.turnTimings, ...durableTurnActivity.turnTimings },
    artifacts: artifactSnapshot,
    workdir: opened.runtime_workdir || opened.workdir || thread.workdir,
    projectPath:
      opened.project_path !== undefined ? opened.project_path : (thread.projectPath ?? null),
    runtimeId: opened.runtime_id,
    runtime: opened.runtime,
    readiness: opened.readiness,
    capabilities: opened.capabilities,
    lastSeq: opened.last_seq ?? 0,
    resumeState: 'ready' as const,
    resumeServiceInstanceId: serviceInstanceId ?? undefined,
    resumeMessage: undefined,
    running: Boolean(opened.running),
    recoveryBlocked: opened.recovery_blocked === true,
    recoveryIncidentId: opened.recovery_incident_id ?? null,
    recoverySourceSeq: opened.recovery_source_seq ?? 0,
    recoveryPending: opened.recovery_pending === true,
    resourceFinalizing: opened.resource_finalizing === true,
    interrupting: Boolean(opened.interrupting),
    queuedMessages: mergeQueuedOutbox(
      sessionId,
      queuedMessages?.map(queuedMessageFromPayload) ?? thread.queuedMessages ?? [],
      acknowledgeQueue && queuedMessages !== null,
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
      timestamp,
    }),
  }
}
