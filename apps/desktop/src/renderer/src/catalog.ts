import type { ModelInfo } from './api'
import type { SessionNode, Thread } from './model'

/**
 * Whether the catalogue still offers a model the user may pick.
 *
 * An empty catalogue and an all-greyed catalogue are the same product state:
 * nothing can be selected, so the composer must admit nothing. Not logged in
 * with no personal connection lands exactly here — the server projects both
 * built-in and subscription rows as disabled with a readable reason.
 */
export function hasSelectableModel(
  models: ReadonlyArray<Pick<ModelInfo, 'disabled'>>
): boolean {
  return models.some((model) => !model.disabled)
}

/**
 * Resolve the executable model after an identity-driven catalogue refresh.
 *
 * Signing out disables built-in gateway entries without deleting the user's
 * configured personal connections. The server deliberately preserves the saved
 * default, so `current_model` may still name a disabled built-in row. Requests must
 * not keep sending that unusable key when an enabled personal entry offers the same
 * underlying model (or another enabled fallback is available).
 */
export function selectableCatalogModelKey(
  requested: string,
  models: ReadonlyArray<Pick<ModelInfo, 'key' | 'disabled' | 'model_id'>>,
  previous = ''
): string {
  const enabled = models.filter((model) => !model.disabled)
  if (enabled.some((model) => model.key === requested)) return requested
  if (enabled.some((model) => model.key === previous)) return previous

  const requestedModelId = personalModelId(requested) || requested
  const equivalent = enabled.find((model) =>
    model.model_id === requestedModelId || personalModelId(model.key) === requestedModelId
  )
  return equivalent?.key ?? enabled[0]?.key ?? (requested || previous)
}

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
 * Resolve the model key a session surface must act on.
 *
 * A session opened before signing out keeps its durable built-in selection, which
 * the gated catalogue projects as disabled. Surfaces must neither keep sending that
 * key nor refuse to work while the catalogue still offers enabled models: fall back
 * through the same policy as the default-model recovery. A key that is *missing*
 * from the catalogue keeps its honest "unavailable" treatment — that transition is
 * the user's decision, not an automatic switch.
 */
export function effectiveSessionModelKey(
  models: ReadonlyArray<Pick<ModelInfo, 'key' | 'disabled'>>,
  defaultModel: string,
  activeSession: string | null,
  threads: Record<string, Thread>
): string {
  const sessionKey = selectedSessionModelKey(defaultModel, activeSession, threads)
  const row = models.find((model) => model.key === sessionKey)
  if (!row?.disabled) return sessionKey || defaultModel
  return selectableCatalogModelKey(sessionKey, models, defaultModel)
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
  models: ReadonlyArray<Pick<ModelInfo, 'key' | 'disabled'>>,
  defaultModel: string,
  activeSession: string | null,
  threads: Record<string, Thread>
): string {
  return (
    effectiveSessionModelKey(models, defaultModel, activeSession, threads) || defaultModel
  )
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
