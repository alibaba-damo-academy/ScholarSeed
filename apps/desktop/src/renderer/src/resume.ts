import { getHistoryWithTodos, openSession, type HistoryResult, type OpenResp } from './api.ts'
import type { HistoryProjectionCaller } from './app/api/timing.ts'
import type { Cognitive, ConvItem, SessionStatus, Thread } from './model'
import { mergeQueuedOutbox } from './outbox.ts'
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
  if (runtimeRoot) {
    const authorized = await window.scholarseed
      .addAuthorizedRoot('session', runtimeRoot)
      .catch(() => false)
    if (signal.aborted) return null
    if (!authorized) {
      console.warn(
        '[session-recovery]',
        JSON.stringify({ stage: 'startup-root-denied', sessionId, runtimeRoot })
      )
      return null
    }
  }

  // Read history after open captures the cursor. The live status refresh owns the sequenced queue.
  const history = await getHistoryWithTodos(sessionId, 'startup_resume', signal)
  return history && !signal.aborted ? { opened, history } : null
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

function resumedSessionStatus(opened: OpenResp): SessionStatus {
  if (opened.running) return 'running'
  if (opened.last_turn_status === 'failed') return 'failed'
  if (opened.last_turn_status === 'interrupted') return 'abandon'
  return 'done'
}

export function projectResumedSession(
  thread: Thread,
  {
    opened,
    history,
    serviceInstanceId,
    timestamp,
    caller = 'startup_resume',
  }: SessionResumeSnapshot & {
    serviceInstanceId: string | null
    timestamp: number
    caller?: Extract<HistoryProjectionCaller, 'startup_resume' | 'resume'>
  }
): Thread {
  const sessionId = opened.session_id
  const artifactSnapshot = opened.artifacts ?? history.artifacts
  const durableTurnActivity = snapshotTurnActivity(history.turn_activity)
  const conversation = projectHistorySnapshot(
    { ...history, artifacts: artifactSnapshot },
    thread.conversation,
    caller
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
    queueSnapshotSeq:
      thread.resumeServiceInstanceId === serviceInstanceId ? thread.queueSnapshotSeq : undefined,
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
      thread.queuedMessages ?? [],
      false,
      thread.queuedMessages
    ),
    status: resumedSessionStatus(opened),
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
