import type { AttentionSnapshot } from './attention'

export interface DesktopNotificationInput {
  attentionId: string
  title: string
  body: string
  silent: boolean
}

export const NOTIFICATION_PATH = '/api/serve/notifications/events'
export const NOTIFICATION_CHANNEL = 'scholarseed:notification-state'
export const NOTIFICATION_SYNC_CHANNEL = 'scholarseed:notification-sync'
export const ATTENTION_STATE_CHANNEL = 'scholarseed:attention-state'
export const NOTIFICATION_TOPICS = [
  'attention',
  'sessions',
  'projects',
  'records',
  'literature',
  'resources',
] as const
export const NOTIFICATION_RETRY_MS = 500
export const NOTIFICATION_MAX_RETRY_MS = 30_000
export const NOTIFICATION_IDLE_MS = 45_000
export const NOTIFICATION_REQUEST_MS = 10_000
const MAX_FRAME_BYTES = 1_048_576
export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]
export interface NotificationFrame {
  instanceId: string
  reset: boolean
  changes: Array<{ topic: NotificationTopic; subject: string }>
}
export interface NotificationBridge {
  onChange(callback: (frame: NotificationFrame) => void): () => void
  onAttention(callback: (snapshot: AttentionSnapshot | null) => void): () => void
  sync(): Promise<void>
}

export function notificationFrame(event: string, value: unknown): NotificationFrame {
  const data = value as { instance_id?: unknown; changes?: unknown }
  if (
    !data ||
    typeof data.instance_id !== 'string' ||
    !data.instance_id ||
    !Array.isArray(data.changes) ||
    !['ready', 'changed'].includes(event)
  )
    throw new Error('Invalid notification frame')
  const changes = data.changes.map((entry: unknown) => {
    const item = entry as { topic?: NotificationTopic; subject?: unknown }
    if (
      !item ||
      !NOTIFICATION_TOPICS.includes(item.topic as NotificationTopic) ||
      typeof item.subject !== 'string'
    )
      throw new Error('Invalid notification change')
    return { topic: item.topic as NotificationTopic, subject: item.subject }
  })
  return { instanceId: data.instance_id, reset: event === 'ready', changes }
}

export class DirtyRefresh<Value> {
  private generation = 0
  private applied = 0
  private attempt = 0
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private request: AbortController | undefined

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<Value>,
    private readonly accept: (value: Value) => void,
    private readonly failure: (error: unknown) => void = () => undefined
  ) {}

  invalidate(reset = false): void {
    if (this.stopped) return
    if (reset) this.request?.abort()
    this.generation++
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.request?.abort()
  }

  private schedule(delay: number): void {
    if (this.stopped || this.request || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, delay)
  }

  private async run(): Promise<void> {
    if (this.stopped || this.generation === this.applied) return
    const generation = this.generation
    const request = new AbortController()
    this.request = request
    const timeout = setTimeout(() => request.abort(), NOTIFICATION_REQUEST_MS)
    try {
      const result = await this.load(request.signal)
      if (this.stopped || request.signal.aborted) return
      this.accept(result)
      this.applied = generation
      this.attempt = 0
    } catch (error) {
      if (!this.stopped) {
        this.attempt++
        this.failure(error)
      }
    } finally {
      clearTimeout(timeout)
      this.request = undefined
      if (this.generation !== this.applied) {
        this.schedule(
          this.attempt
            ? Math.min(
                NOTIFICATION_MAX_RETRY_MS,
                NOTIFICATION_RETRY_MS * 2 ** Math.min(this.attempt - 1, 10)
              )
            : 0
        )
      }
    }
  }
}

export class NotificationStream {
  private request: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private attempt = 0
  private stopped = true

  constructor(
    private readonly fetch: (signal: AbortSignal) => Promise<Response>,
    private readonly accept: (frame: NotificationFrame) => void,
    private readonly unauthorized: () => void,
    private readonly failure: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.connect(++this.generation)
  }

  stop(): void {
    this.stopped = true
    this.generation++
    clearTimeout(this.timer)
    this.request?.abort()
  }

  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return
    const request = new AbortController()
    this.request = request
    let idle = setTimeout(() => request.abort(), NOTIFICATION_IDLE_MS)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await this.fetch(request.signal)
      if (this.stopped || generation !== this.generation) return
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        this.stop()
        this.unauthorized()
        return
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`Notification stream HTTP ${response.status}`)
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!this.stopped && generation === this.generation) {
        const chunk = await reader.read()
        if (chunk.done) break
        clearTimeout(idle)
        idle = setTimeout(() => request.abort(), NOTIFICATION_IDLE_MS)
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, '')
        if (buffer.length > MAX_FRAME_BYTES) throw new Error('Notification frame exceeds limit')
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const lines = frame.split('\n')
          const event = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim()
          if (!event) continue
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (generation !== this.generation || this.stopped) return
          this.accept(notificationFrame(event, JSON.parse(data)))
          this.attempt = 0
        }
      }
    } catch (error) {
      if (!this.stopped && generation === this.generation) this.failure(error)
    } finally {
      clearTimeout(idle)
      request.abort()
      await reader?.cancel().catch(() => undefined)
      reader?.releaseLock()
      if (!this.stopped && generation === this.generation) {
        const delay = Math.min(
          NOTIFICATION_MAX_RETRY_MS,
          NOTIFICATION_RETRY_MS * 2 ** Math.min(this.attempt++, 10)
        )
        this.timer = setTimeout(() => void this.connect(generation), delay)
      }
    }
  }
}
