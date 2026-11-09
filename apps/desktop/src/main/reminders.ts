import { app, BrowserWindow, nativeImage, Notification } from 'electron'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  attentionSnapshot,
  ATTENTION_PATH,
  type AttentionItem,
  type AttentionSnapshot,
} from '../attention.ts'
import { AttentionDelivery, type AttentionCursor } from './attention.ts'
import { badgeBitmap, BADGE_SIZE, watchBadgeRestore } from './badge.ts'
import { desktopStorage } from './storage'
import { desktopDirectoryWriter } from './writer'
import { readRecord, writeJson } from './journal.ts'
import { loadRendererPreferences } from './preferences'
import { mainLocalization } from './localization'
import { notificationAttentionId, type WindowsNotifications } from './notification.ts'
import {
  ATTENTION_STATE_CHANNEL,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_PATH,
  DirtyRefresh,
  NotificationStream,
  type NotificationFrame,
} from '../notifications.ts'

const ATTENTION_CURSOR_FILE = 'attention-cursor.json'
const ATTENTION_CURSOR_MAX_BYTES = 4096
const ATTENTION_GROUP = 'scholarseed-attention'
const ATTENTION_TEXT_LIMIT = 500
const ATTENTION_SCOPE_LENGTH = 16
const MACOS_PLATFORM = 'darwin'
const WINDOWS_PLATFORM = 'win32'

interface ReminderDependencies {
  window(): BrowserWindow | null
  base(): string
  windows: WindowsNotifications | null
  activate(id: string): void
  log(message: string): void
}

export class DesktopReminders {
  private readonly delivery: AttentionDelivery
  private readonly notifications = new Map<string, Notification>()
  private stream: NotificationStream | null = null
  private refresh: DirtyRefresh<AttentionSnapshot> | null = null
  private snapshot: AttentionSnapshot | null = null
  private frame: NotificationFrame | null = null
  private stopped = true
  private lastError = ''
  private lastCount = -1
  private epoch = ''
  private reconciledRevision = -1
  private reconciledEpoch = ''
  private reconciledUnread: ReadonlySet<string> | null = null
  private retireBadgeRestore: (() => void) | null = null
  private readonly group: string

  constructor(private readonly dependencies: ReminderDependencies) {
    const storage = desktopStorage()
    const scope = createHash('sha256')
      .update(JSON.stringify([storage.userData, storage.home]))
      .digest('hex')
      .slice(0, ATTENTION_SCOPE_LENGTH)
    this.group = `${ATTENTION_GROUP}-${scope}`
    dependencies.windows?.setScope(scope)
    this.delivery = new AttentionDelivery({
      persist: (cursor) => this.persist(cursor),
      foreground: () =>
        BrowserWindow.getAllWindows().some(
          (window) =>
            !window.isDestroyed() &&
            window.isVisible() &&
            !window.isMinimized() &&
            window.isFocused()
        ),
      show: (item) => this.show(item),
      reconcile: (snapshot) => this.reconcile(snapshot),
      decision: (item, decision) =>
        dependencies.log(`[attention] id=${item.id} decision=${decision}\n`),
    })
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    const window = this.dependencies.window()
    if (process.platform === WINDOWS_PLATFORM && window) {
      this.retireBadgeRestore = watchBadgeRestore(
        window,
        () => this.lastCount,
        (count) => {
          try {
            this.applyBadge(count)
          } catch (error) {
            this.logError(error)
          }
        }
      )
    }
    try {
      const cursor = JSON.parse(
        readRecord(this.path(), ATTENTION_CURSOR_MAX_BYTES).toString('utf8')
      ) as AttentionCursor
      if (typeof cursor.epoch !== 'string' || !Number.isSafeInteger(cursor.revision))
        throw new Error('Invalid persisted attention cursor')
      this.dependencies.log(
        `[attention] restored delivery revision=${cursor.revision}; cold-start baseline\n`
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logError(error)
    }
    if (process.platform === MACOS_PLATFORM && Notification.isSupported()) {
      try {
        const history = await Notification.getHistory()
        for (const notification of history) {
          if (notification.groupId !== this.group) continue
          this.bind(notification, notification.id)
        }
      } catch (error) {
        this.logError(error)
      }
    }
    if (!this.stopped) this.synchronize()
  }

  stop(): void {
    this.stopped = true
    this.retireBadgeRestore?.()
    this.retireBadgeRestore = null
    this.stream?.stop()
    this.refresh?.stop()
    this.stream = null
    this.refresh = null
  }

  identityChanged(): void {
    this.stream?.stop()
    this.refresh?.stop()
    this.stream = null
    this.refresh = null
    this.delivery.reset()
    this.frame = null
    this.snapshot = null
    const empty: AttentionSnapshot = {
      epoch: '',
      revision: 0,
      unread_count: 0,
      by_session: {},
      items: [],
    }
    this.reconcile(empty)
    this.dependencies.window()?.webContents.send(ATTENTION_STATE_CHANNEL, null)
  }

  synchronize(): void {
    if (this.stopped) return
    if (!this.refresh) this.refresh = this.snapshotRefresh()
    if (!this.stream) {
      this.stream = new NotificationStream(
        (signal) => {
          const window = this.dependencies.window()
          if (!window) return Promise.reject(new Error('Notification window unavailable'))
          return window.webContents.session.fetch(
            `${this.dependencies.base()}${NOTIFICATION_PATH}`,
            { signal }
          )
        },
        (frame) => {
          if (this.frame && frame.instanceId !== this.frame.instanceId) {
            this.refresh?.stop()
            this.refresh = this.snapshotRefresh()
          }
          this.frame = frame
          this.dependencies.window()?.webContents.send(NOTIFICATION_CHANNEL, frame)
          if (frame.reset || frame.changes.some((change) => change.topic === 'attention'))
            this.refresh?.invalidate()
        },
        () => this.identityChanged(),
        (error) => this.logError(error)
      )
      this.stream.start()
    }
    if (this.snapshot)
      this.dependencies.window()?.webContents.send(ATTENTION_STATE_CHANNEL, this.snapshot)
    if (this.frame)
      this.dependencies
        .window()
        ?.webContents.send(NOTIFICATION_CHANNEL, { ...this.frame, reset: true })
  }

  private snapshotRefresh(): DirtyRefresh<AttentionSnapshot> {
    return new DirtyRefresh(
      async (signal) => {
        const window = this.dependencies.window()
        if (!window) throw new Error('Notification window unavailable')
        const response = await window.webContents.session.fetch(
          `${this.dependencies.base()}${ATTENTION_PATH}`,
          {
            signal,
            headers: { 'cache-control': 'no-cache' },
          }
        )
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel()
          this.identityChanged()
          throw new Error('Attention authentication changed')
        }
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`Attention request HTTP ${response.status}`)
        }
        return attentionSnapshot(await response.json())
      },
      (snapshot) => {
        this.delivery.accept(snapshot)
        this.snapshot = snapshot
        this.dependencies.window()?.webContents.send(ATTENTION_STATE_CHANNEL, snapshot)
        this.lastError = ''
      },
      (error) => this.logError(error)
    )
  }

  private path(): string {
    return join(desktopStorage().userData, ATTENTION_CURSOR_FILE)
  }

  private persist(cursor: AttentionCursor): void {
    const path = this.path()
    const writer = desktopDirectoryWriter(dirname(path))
    try {
      writeJson(path, cursor)
    } finally {
      writer.close()
    }
  }

  private reconcile(snapshot: AttentionSnapshot): void {
    const unread = new Set(snapshot.items.map((item) => item.id))
    const unreadChanged =
      !this.reconciledUnread ||
      unread.size !== this.reconciledUnread.size ||
      [...unread].some((id) => !this.reconciledUnread?.has(id))
    if (
      snapshot.revision !== this.reconciledRevision ||
      snapshot.epoch !== this.reconciledEpoch ||
      unreadChanged
    ) {
      try {
        this.dependencies.windows?.retain(unread)
        this.reconciledRevision = snapshot.revision
        this.reconciledEpoch = snapshot.epoch
        this.reconciledUnread = unread
      } catch (error) {
        this.logError(error)
      }
    }
    for (const [id, notification] of this.notifications) {
      if (unread.has(id)) continue
      try {
        notification.close()
        if (process.platform === MACOS_PLATFORM) Notification.remove(id)
      } catch (error) {
        this.logError(error)
      }
      this.notifications.delete(id)
    }
    const count = snapshot.unread_count
    if (this.lastCount === count && this.epoch === snapshot.epoch) return
    this.lastCount = count
    this.epoch = snapshot.epoch
    this.applyBadge(count)
    this.dependencies.log(`[attention] unread=${count} revision=${snapshot.revision}\n`)
  }

  private applyBadge(count: number): void {
    if (process.platform === MACOS_PLATFORM) app.dock?.setBadge(count ? String(count) : '')
    if (process.platform === WINDOWS_PLATFORM) {
      const icon = count
        ? nativeImage.createFromBitmap(badgeBitmap(count), {
            width: BADGE_SIZE,
            height: BADGE_SIZE,
          })
        : null
      const description = mainLocalization().getFixedT(null, 'native')('notifications.badge', {
        count,
      })
      this.dependencies.window()?.setOverlayIcon(icon, description)
    }
  }

  private show(item: AttentionItem): void {
    try {
      const translate = mainLocalization().getFixedT(null, 'native')
      const title = (
        item.title_fallback === 'new_session' || !item.title.trim()
          ? translate('notifications.title')
          : item.title.trim()
      ).slice(0, ATTENTION_TEXT_LIMIT)
      const summary = item.body.trim() || translate('notifications.fallback')
      const body = translate(`notifications.${item.kind}`, {
        summary,
        interpolation: { escapeValue: false },
      }).slice(0, ATTENTION_TEXT_LIMIT)
      const silent = !loadRendererPreferences().soundAlerts
      if (this.dependencies.windows) {
        this.dependencies.windows.show(
          { attentionId: item.id, title, body, silent },
          {
            click: () => this.dependencies.activate(item.id),
            submitted: () =>
              this.dependencies.log(`[attention] id=${item.id} submitted silent=${silent}\n`),
            failed: (error) => this.logError(error),
          }
        )
        return
      }
      if (!Notification.isSupported()) throw new Error('Native notifications unavailable')
      const notification = new Notification({
        id: item.id,
        groupId: this.group,
        title,
        body,
        silent,
      })
      this.bind(notification, item.id)
      notification.on('show', () =>
        this.dependencies.log(`[attention] id=${item.id} shown silent=${silent}\n`)
      )
      notification.on('failed', (_event, error) => this.logError(error))
      notification.show()
      this.dependencies.log(`[attention] id=${item.id} submitted silent=${silent}\n`)
    } catch (error) {
      this.logError(error)
    }
  }

  private bind(notification: Notification, id: string): void {
    if (!notificationAttentionId(`scholarseed://notification/${id}`)) return
    this.notifications.set(id, notification)
    notification.on('click', () => this.dependencies.activate(id))
  }

  private logError(error: unknown): void {
    const message = String(error)
    if (message === this.lastError) return
    this.lastError = message
    this.dependencies.log(`[attention] error=${message}\n`)
  }
}
