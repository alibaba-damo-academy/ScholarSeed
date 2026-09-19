import type { SessionNode, Thread } from './model'

/** Resolve the picker label from the active session before the new-session default. */
export function selectedSessionModelKey(
  defaultModel: string,
  activeSession: string | null,
  threads: Record<string, Thread>
): string {
  if (!activeSession) return defaultModel
  return threads[activeSession]?.runtime?.model_id || ''
}

/**
 * Resolve the model key to send with a request, never an empty one.
 *
 * The picker above reports the active session's *true* runtime and yields '' while a
 * thread has no `model_id` (workbench surfaces such as the PDF reading pane never get
 * one). That blank is honest for display but invalid on the wire: the backend matches
 * the key against its catalogue and rejects a miss outright, which surfaced as
 * "无法准备阅读任务". Requests therefore fall back to the configured default model.
 */
export function requestModelKey(
  defaultModel: string,
  activeSession: string | null,
  threads: Record<string, Thread>
): string {
  return selectedSessionModelKey(defaultModel, activeSession, threads) || defaultModel
}

/** Personal catalogue keys are `personal-<uuid>:<model id>`; see `connections.py`. */
const PERSONAL_MODEL_KEY_PREFIX = 'personal-'
const PERSONAL_MODEL_KEY_SEPARATOR = ':'

/**
 * Read the model segment of a personal catalogue key, or '' when it is not one.
 *
 * Splitting on the *first* separator is mandatory and mirrors
 * `parse_personal_model_key` in `apps/serve/service/settings/connections.py`: a model
 * id may itself contain one (`org/exact-model:version`), so splitting on the last one
 * — or on all of them — truncates the model name.
 */
export function personalModelId(key: string): string {
  if (!key.startsWith(PERSONAL_MODEL_KEY_PREFIX)) return ''
  const cut = key.indexOf(PERSONAL_MODEL_KEY_SEPARATOR)
  return cut > 0 ? key.slice(cut + 1) : ''
}

function findCreatedAt(nodes: SessionNode[], id: string): number {
  for (const node of nodes) {
    if (node.id === id) return node.createdAt ?? 0
    const nested = findCreatedAt(node.children ?? [], id)
    if (nested > 0) return nested
  }
  return 0
}

/**
 * Whether a renderer thread must survive one authoritative catalog refresh.
 *
 * A newly opened session can briefly be absent while Service commits its
 * catalog row.  More importantly, the conversation the user is currently
 * looking at must never disappear merely because a background list refresh is
 * stale.  Explicit navigation, deletion and typed resume failures own that
 * transition instead.
 */
export function retainCatalogThread(
  threadId: string,
  thread: Thread,
  nodes: SessionNode[],
  catalogSessionIds: ReadonlySet<string>,
  activeSession: string | null,
  nowSeconds: number,
  appearanceGraceSeconds: number
): boolean {
  const sessionId = thread.sessionId
  if (!sessionId || catalogSessionIds.has(sessionId)) return true
  if (thread.surface === 'workbench') return true
  if (threadId === activeSession || sessionId === activeSession) return true
  const createdAt = findCreatedAt(nodes, sessionId)
  return createdAt > 0 && nowSeconds - createdAt < appearanceGraceSeconds
}

export function pruneMissingCatalogThreads(
  threads: Record<string, Thread>,
  nodes: SessionNode[],
  catalogSessionIds: ReadonlySet<string>,
  activeSession: string | null,
  nowSeconds: number,
  appearanceGraceSeconds: number
): Record<string, Thread> {
  let next = threads
  for (const [threadId, thread] of Object.entries(threads)) {
    if (retainCatalogThread(
      threadId,
      thread,
      nodes,
      catalogSessionIds,
      activeSession,
      nowSeconds,
      appearanceGraceSeconds
    )) continue
    if (next === threads) next = { ...threads }
    delete next[threadId]
  }
  return next
}
