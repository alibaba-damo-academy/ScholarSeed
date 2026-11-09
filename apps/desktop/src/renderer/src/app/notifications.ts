import {
  NOTIFICATION_PATH,
  NotificationStream,
  type NotificationFrame,
  type NotificationTopic,
} from '../../../notifications.ts'
import { apiFetch } from './api/client.ts'

const subscriptions = new Set<{
  topics: readonly NotificationTopic[]
  listener: (reset: boolean, changes: NotificationFrame['changes']) => void
}>()
let detach: (() => void) | undefined
let current: NotificationFrame | undefined

function publish(frame: NotificationFrame): void {
  current = frame
  for (const subscription of subscriptions) {
    if (frame.reset || frame.changes.some((change) => subscription.topics.includes(change.topic)))
      subscription.listener(frame.reset, frame.changes)
  }
}

function connect(): () => void {
  const bridge = window.scholarseed?.notifications
  const stream = bridge
    ? undefined
    : new NotificationStream(
        (signal) => apiFetch(NOTIFICATION_PATH, { signal }),
        publish,
        () => {
          current = undefined
        },
        (error) => console.warn('[notifications] connection unavailable', error)
      )
  const unsubscribe = bridge?.onChange(publish)
  const restore = (): void => {
    if (bridge) void bridge.sync()
    else stream?.start()
  }
  const invalidate = (): void => {
    current = undefined
    stream?.stop()
  }
  window.addEventListener('scholarseed:auth-restored', restore)
  window.addEventListener('scholarseed:auth-required', invalidate)
  restore()
  return () => {
    unsubscribe?.()
    stream?.stop()
    window.removeEventListener('scholarseed:auth-restored', restore)
    window.removeEventListener('scholarseed:auth-required', invalidate)
    current = undefined
  }
}

export function subscribeChanges(
  topics: readonly NotificationTopic[],
  listener: (reset: boolean, changes: NotificationFrame['changes']) => void
): () => void {
  const subscription = { topics, listener }
  subscriptions.add(subscription)
  if (!detach) detach = connect()
  else if (current)
    queueMicrotask(() => {
      if (subscriptions.has(subscription)) listener(true, [])
    })
  return () => {
    subscriptions.delete(subscription)
    if (!subscriptions.size) {
      detach?.()
      detach = undefined
    }
  }
}
