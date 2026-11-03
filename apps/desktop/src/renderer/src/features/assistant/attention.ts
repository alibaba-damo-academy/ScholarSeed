import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  ATTENTION_PATH,
  attentionSnapshot,
  type AttentionItem,
  type AttentionSnapshot,
} from '../../../../attention'
import { apiFetch } from '../../app/api/client'
import {
  attentionContentLoaded,
  attentionRenderedSequence,
  canReadAttention,
  matchingAttentionAnchors,
} from '../../attention'
import { activeThread, useApp } from '../../store'

const POLL_INTERVAL_MS = 2_000
const REQUEST_TIMEOUT_MS = 10_000
const ANCHOR_SELECTOR =
  '[data-message-item-id], [data-message-turn-id], [data-interaction-request-id], [data-recovery-session-id]'
const EMPTY_SNAPSHOT: AttentionSnapshot = {
  epoch: '',
  revision: 0,
  unread_count: 0,
  by_session: {},
  items: [],
}
let snapshot = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

function publish(next: AttentionSnapshot): void {
  if (next.epoch === snapshot.epoch && next.revision <= snapshot.revision) return
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAttention(): AttentionSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

async function readAttention(ids?: string[]): Promise<void> {
  const current = snapshot
  if (!current.epoch) throw new Error('Attention snapshot unavailable')
  const response = await apiFetch(`${ATTENTION_PATH}/${ids ? 'read' : 'read-all'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      epoch: current.epoch,
      through_revision: current.revision,
      ...(ids ? { ids } : {}),
    }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  if (!response.ok) throw new Error(`Attention read failed: ${response.status}`)
  const next = attentionSnapshot(await response.json())
  if (current.epoch === snapshot.epoch) publish(next)
}

export function markAllAttentionRead(): Promise<void> {
  return readAttention()
}

export async function markInteractionAttentionRead(
  sessionId: string,
  requestId: string
): Promise<void> {
  const response = await apiFetch(ATTENTION_PATH, {
    cache: 'no-store',
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  if (!response.ok) throw new Error(`Attention snapshot failed: ${response.status}`)
  const current = attentionSnapshot(await response.json())
  if (snapshot.epoch && current.epoch !== snapshot.epoch) return
  publish(current)
  const ids = current.items
    .filter((item) => item.session_id === sessionId && item.request_id === requestId)
    .map((item) => item.id)
  if (ids.length) await readAttention(ids)
}

function targetsFor(item: AttentionItem): HTMLElement[] {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR))
  return matchingAttentionAnchors(
    elements.map((element) => ({
      element,
      recoverySessionId: element.dataset.recoverySessionId,
      recoveryIncidentId: element.dataset.recoveryIncidentId,
      interactionRequestId: element.dataset.interactionRequestId,
      messageItemId: element.dataset.messageItemId,
      messageTurnId: element.dataset.messageTurnId,
      messageKind: element.dataset.messageKind,
    })),
    {
      sessionId: item.session_id,
      incidentId: item.incident_id,
      requestId: item.request_id,
      itemId: item.item_id,
      turnId: item.turn_id,
      kind: item.anchor_kind ?? item.kind,
    }
  ).map((anchor) => anchor.element)
}

function contentVisible(target: HTMLElement): boolean {
  const element =
    getComputedStyle(target).display === 'contents' ? target.firstElementChild : target
  if (!(element instanceof HTMLElement) || !element.checkVisibility()) return false
  const bounds = element.getBoundingClientRect()
  const left = Math.max(0, bounds.left)
  const right = Math.min(window.innerWidth, bounds.right)
  const top = Math.max(0, bounds.top)
  const bottom = Math.min(window.innerHeight, bounds.bottom)
  if (right <= left || bottom <= top) return false
  const visible = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
  return Boolean(visible && element.contains(visible))
}

export function useAttentionLifecycle(): void {
  const { state } = useApp()
  const current = useRef({ state })
  current.current = { state }
  const reminders = useAttention()
  const reading = useRef(false)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    publish(EMPTY_SNAPSHOT)
    const poll = async (): Promise<void> => {
      try {
        const response = await apiFetch(ATTENTION_PATH, {
          cache: 'no-store',
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        if (response.ok) {
          const next = attentionSnapshot(await response.json())
          if (!disposed) publish(next)
        }
      } catch (error) {
        if (!disposed) console.warn('[attention] snapshot unavailable', error)
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
      publish(EMPTY_SNAPSHOT)
    }
  }, [state.serviceInstanceId])

  useEffect(() => {
    const inspect = (): void => {
      const latest = current.current.state
      const thread = activeThread(latest)
      if (
        reading.current ||
        !canReadAttention({
          focused: document.hasFocus(),
          visible: document.visibilityState === 'visible',
          loaded: thread.resumeState !== 'pending' && Boolean(thread.sessionId),
          covered: Boolean(latest.accountSettingsPage || latest.capGallery),
        })
      )
        return
      const ids = snapshot.items
        .filter((item) => {
          if (item.session_id !== thread.sessionId) return false
          if (!attentionContentLoaded(attentionRenderedSequence(thread, item), item.source_seq))
            return false
          return targetsFor(item).some(contentVisible)
        })
        .map((item) => item.id)
      if (!ids.length) return
      reading.current = true
      void readAttention(ids)
        .catch((error) => console.warn('[attention] read unavailable', error))
        .finally(() => {
          reading.current = false
        })
    }
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('focus', inspect)
    window.addEventListener('scroll', inspect, true)
    document.addEventListener('visibilitychange', inspect)
    const frame = requestAnimationFrame(inspect)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('focus', inspect)
      window.removeEventListener('scroll', inspect, true)
      document.removeEventListener('visibilitychange', inspect)
    }
  }, [reminders, state.activeSession, state.accountSettingsPage, state.capGallery])
}
