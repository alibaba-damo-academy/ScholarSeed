import type { DesktopNotificationInput } from '../notifications.ts'
import { WINDOWS_NOTIFICATION_ID } from './identity.ts'

export interface ToastNative {
  show(
    aumid: string,
    xml: string,
    callback: (event: string, error: number) => void,
    id: string
  ): unknown
  close(handle: unknown): void
  detach(handle: unknown): void
  history(aumid: string): string[]
  remove(aumid: string, id: string): void
}
export interface NotificationCallbacks {
  click(): void
  failed(error: string): void
  submitted(): void
}
const LIVE_NOTIFICATION_LIMIT = 32
const NOTIFICATION_SETTING_EVENT = 'setting'
const NOTIFICATION_SETTING_UNAVAILABLE_EVENT = 'setting-unavailable'
const NOTIFICATION_SETTING_UNKNOWN = -1
const HRESULT_HEX_WIDTH = 8
const DIAGNOSTIC_STAGE_LIMIT = 100
const NOTIFICATION_URL_PREFIX = 'scholarseed://notification/'
const NOTIFICATION_URL =
  /^scholarseed:\/\/notification\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export function findNotificationUrl(args: readonly string[]): string | undefined {
  return args
    .map((arg) => (arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg))
    .find((arg) => NOTIFICATION_URL.test(arg))
}
interface NotificationEntry {
  handle?: unknown
  closed: boolean
  url: string
  click(): void
}
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}
export function notificationXml(
  input: Pick<DesktopNotificationInput, 'title' | 'body' | 'silent'>,
  activationUrl: string
): string {
  // XML 1.0 does not permit control characters, even inside escaped text.
  const escape = (value: string) =>
    value
      // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these code points.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/[&<>"']/g, (character) => XML_ESCAPES[character])
  return `<toast activationType="protocol" launch="${escape(activationUrl)}"><visual><binding template="ToastGeneric"><text>${escape(input.title)}</text><text>${escape(input.body)}</text></binding></visual>${input.silent === false ? '' : '<audio silent="true"/>'}</toast>`
}

export class WindowsNotifications {
  private readonly active = new Map<string, NotificationEntry>()
  private scope = ''
  constructor(
    private readonly native: ToastNative,
    private readonly log?: (line: string) => void
  ) {}

  private diagnostic(
    entry: NotificationEntry,
    event: string,
    details: {
      stage?: string
      hresult?: number
      setting?: number
    } = {}
  ): void {
    try {
      this.log?.(
        `[notification] ${JSON.stringify({
          event,
          aumid: WINDOWS_NOTIFICATION_ID,
          id: entry.url.slice(NOTIFICATION_URL_PREFIX.length),
          stage: details.stage,
          hresult:
            details.hresult === undefined
              ? undefined
              : `0x${(details.hresult >>> 0).toString(16).padStart(HRESULT_HEX_WIDTH, '0')}`,
          setting: details.setting,
        })}\n`
      )
    } catch {
      console.warn('[notification] diagnostic write failed')
    }
  }

  setScope(scope: string): void {
    this.scope = scope
  }

  private group(id: string): string {
    return this.scope ? `${this.scope}.${id}` : id
  }

  show(input: DesktopNotificationInput, callbacks: NotificationCallbacks): void {
    if (this.active.size >= LIVE_NOTIFICATION_LIMIT)
      this.close(this.active.values().next().value!, true)
    const entry: NotificationEntry = {
      closed: false,
      url: NOTIFICATION_URL_PREFIX + input.attentionId,
      click: callbacks.click,
    }
    if (!NOTIFICATION_URL.test(entry.url)) throw new Error('Invalid attention identity')
    const previous = this.active.get(entry.url)
    if (previous) this.close(previous)
    this.active.set(entry.url, entry)
    try {
      this.diagnostic(entry, 'attempt')
      entry.handle = this.native.show(
        WINDOWS_NOTIFICATION_ID,
        notificationXml(input, entry.url),
        (event, code) => {
          if (event === NOTIFICATION_SETTING_UNAVAILABLE_EVENT) {
            this.diagnostic(entry, 'setting-unavailable', {
              stage: 'get_Setting',
              hresult: code,
              setting: NOTIFICATION_SETTING_UNKNOWN,
            })
            return
          }
          if (event === NOTIFICATION_SETTING_EVENT) {
            this.diagnostic(entry, 'setting', { stage: 'get_Setting', setting: code })
            return
          }
          if (entry.closed) return
          // A timed-out toast remains clickable in Action Center.
          if (event === 'timeout') return
          if (event === 'click') this.activate(entry.url)
          else if (event === 'failed') {
            this.diagnostic(entry, 'failed', { stage: 'ToastFailed', hresult: code })
            this.close(entry)
            callbacks.failed(`Windows toast HRESULT 0x${(code >>> 0).toString(16)}`)
          } else {
            // Dismissal can precede OS protocol activation. Retain only its bounded
            // one-shot route, while releasing the native presentation handle.
            this.hide(entry)
          }
        },
        this.group(entry.url.slice(NOTIFICATION_URL_PREFIX.length))
      )
      if (entry.closed) this.native.close(entry.handle)
      this.diagnostic(entry, 'submitted', { stage: 'Show' })
      callbacks.submitted()
    } catch (error) {
      const nativeError =
        error && typeof error === 'object'
          ? (error as { stage?: unknown; hresult?: unknown; setting?: unknown })
          : {}
      this.diagnostic(entry, 'failed', {
        stage:
          typeof nativeError.stage === 'string' &&
          nativeError.stage.length <= DIAGNOSTIC_STAGE_LIMIT &&
          /^[\w.]+$/.test(nativeError.stage)
            ? nativeError.stage
            : 'native.show',
        hresult:
          typeof nativeError.hresult === 'number' && Number.isInteger(nativeError.hresult)
            ? nativeError.hresult
            : undefined,
        setting:
          typeof nativeError.setting === 'number' && Number.isInteger(nativeError.setting)
            ? nativeError.setting
            : undefined,
      })
      this.close(entry)
      throw error
    }
  }

  activate(url: string): boolean {
    const entry = this.active.get(url)
    if (!entry) return false
    this.close(entry)
    entry.click()
    return true
  }

  retain(ids: ReadonlySet<string>): void {
    for (const entry of this.active.values()) {
      if (!ids.has(entry.url.slice(NOTIFICATION_URL_PREFIX.length))) this.close(entry)
    }
    for (const group of this.native.history(WINDOWS_NOTIFICATION_ID)) {
      const prefix = this.scope ? `${this.scope}.` : ''
      if (!group.startsWith(prefix)) continue
      const id = group.slice(prefix.length)
      if (!ids.has(id)) this.native.remove(WINDOWS_NOTIFICATION_ID, group)
    }
  }

  private close(entry: NotificationEntry, preserve = false): void {
    this.active.delete(entry.url)
    this.hide(entry, preserve)
  }

  private hide(entry: NotificationEntry, preserve = false): void {
    if (entry.closed) return
    entry.closed = true
    if (entry.handle !== undefined) {
      if (preserve) this.native.detach(entry.handle)
      else this.native.close(entry.handle)
    }
  }

  dispose(preserve = false): void {
    for (const entry of this.active.values()) this.close(entry, preserve)
  }
}

export function notificationAttentionId(url: string): string | undefined {
  return NOTIFICATION_URL.test(url) ? url.slice(NOTIFICATION_URL_PREFIX.length) : undefined
}

export function notificationLaunchAttentionId(launchInfo: unknown): string | undefined {
  if (!launchInfo || typeof launchInfo !== 'object' || Array.isArray(launchInfo)) return undefined
  const { identifier } = launchInfo as { identifier?: unknown }
  return typeof identifier === 'string'
    ? notificationAttentionId(NOTIFICATION_URL_PREFIX + identifier)
    : undefined
}
