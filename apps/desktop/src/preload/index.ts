import { UPDATE_HEALTH_CHANNEL, UPDATE_REPAIR_CHANNEL, PREVIEW_UPDATE_IPC } from '../updates'
import { PLUGIN_NAVIGATION_CHANNEL, PLUGIN_REVOKED_CHANNEL } from '../plugins'
import { PREFERENCES_SAVE_CHANNEL, PREFERENCES_RECONCILE_CHANNEL } from '../preferences'
import type { PreferenceSubmission, PreferenceReceipt } from '../preference-diagnostics'
import { TRAY_CHANNEL, type TrayNavigation, type TrayReply } from '../tray'
import {
  PREFERENCE_SHUTDOWN_CHANNEL,
  PREFERENCE_SHUTDOWN_ERROR,
  type PreferenceShutdownRequest,
  type PreferenceShutdownReply,
} from '../quiescence'
import {
  DELIVERY_PICK_CHANNEL,
  DELIVERY_OPEN_CHANNEL,
  DELIVERY_SAVE_CHANNEL,
  type DeliveryRequest,
  type DeliverySaveRequest,
  type DeliveryNativeReply,
} from '../delivery'
import {
  VAULT_CHANNEL,
  parseVaultOpen,
  VAULT_ERROR,
  type VaultBridge,
  type VaultStatus,
} from '../vault'
import {
  MENU_CHANNEL,
  type MenuBridge,
  type MenuEvent,
  type MenuAck,
  type MenuDismissReason,
  type MenuActionResult,
  type MenuPresentationReply,
} from '../menu'
import {
  OVERLAY_CHANNEL,
  TOOLTIP_OVERLAY_CHANNEL,
  type BrowserOverlayBridge,
  type BrowserOverlayEvent,
  type OverlayReply,
} from '../overlay'
import {
  BROWSER_COMMAND_CHANNEL,
  BROWSER_DATA_CHANNEL,
  BROWSER_DOWNLOAD_CHANNEL,
  BROWSER_FRAME_ACK_CHANNEL,
  BROWSER_FRAME_CHANNEL,
  BROWSER_FRAME_INPUT_CHANNEL,
  BROWSER_FRAME_RESIZE_CHANNEL,
  BROWSER_HISTORY_CHANNEL,
  BROWSER_POLICY_CHANNEL,
  BROWSER_SNAPSHOT_CHANNEL,
} from '../browser'
import {
  BROWSER_PAGE_CHANNEL,
  BROWSER_FIND_CHANNEL,
  BROWSER_REVEAL_CHANNEL,
  type BrowserReveal,
} from '../browser'
import type { BrowserPageTarget } from '../browser'
import type { BrowserBridge, BrowserFrame, BrowserSnapshot } from '../browser'
import {
  BROWSER_APPROVAL_RESPONSE_CHANNEL,
  BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL,
  type BrowserApprovalResponseRequest,
  type BrowserApprovalResponseReply,
  type BrowserHistoryApprovalResponseRequest,
  type BrowserHistoryApprovalResponseReply,
} from '../approval'
import {
  LOGIN_WINDOW_CHANNEL,
  WINDOW_CLOSE_REQUEST_CHANNEL,
  WINDOW_CLOSE_REPLY_CHANNEL,
  WINDOW_FULLSCREEN_CHANNEL,
  type WindowCloseRequest,
  type WindowCloseReply,
} from '../window'
// preload — the only bridge between renderer and main. Exposes the backend API
// base URL (the renderer talks ASP/HTTP/SSE straight to it), backend log stream,
// shoot-scene events, an external-open helper, and the version-update surface.

import type { AuthorizationScope } from '../main/authorization'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopAuthSnapshot } from '../main/handoff'
import type { OfficeClipboardResult } from '../main/clipboard'
import {
  OFFICE_FONT_CATALOG_CHANNEL,
  OFFICE_FONT_READ_CHANNEL,
  OFFICE_FONT_CACHE_READ_CHANNEL,
  OFFICE_FONT_CACHE_WRITE_CHANNEL,
  type OfficeFontCatalog,
  type OfficeFontCache,
} from '../fonts'
import type {
  StartUpdateResult,
  UpdateDiagnosis,
  UpdateSnapshot,
  PreviewUpdatePolicy,
  PreviewUpdateScope,
  PreviewUpdateLine,
} from '../updates'
import type { PreferenceLanguage, RendererPreferences } from '../preferences'
import {
  ATTENTION_CLICK_CHANNEL,
  ATTENTION_READY_CHANNEL,
  type AttentionSnapshot,
} from '../attention'
import {
  ATTENTION_STATE_CHANNEL,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_SYNC_CHANNEL,
  type NotificationFrame,
} from '../notifications'
import type { SystemPermissionId, SystemPermissionsSnapshot } from '../permissions'
import type { CommitDataHomeResult, StorageConfig } from '../storage'
import { OFFICE_IMAGE_CHANNEL, type OfficeImageSource, type OfficeImageResult } from '../images'
import type { ImportPickerTarget } from '../picker'
import { SKILLS_CHANNEL, type DeviceSkillRequest, type DeviceSkillResponse } from '../skills'
import {
  MCP_SETTINGS_CHANNEL,
  type McpSettingsRequest,
  type McpSettingsResponse,
} from '../mcp-settings'
import {
  FEEDBACK_DIAGNOSTICS_CHANNEL,
  FEEDBACK_SUBMIT_CHANNEL,
  type FeedbackSubmissionRequest,
  type FeedbackSubmissionResult,
  FEEDBACK_CAPTURE_CHANNEL,
  FEEDBACK_SHORTCUT_CHANNEL,
  FEEDBACK_CLIPBOARD_IMAGE_CHANNEL,
  type FeedbackClipboardImageResult,
  type FeedbackScreenshotResult,
} from '../feedback'
import {
  CLIPBOARD_PASTE_CHANNEL,
  CLIPBOARD_WRITE_CONTENT_CHANNEL,
  type ClipboardContentPayload,
  type ClipboardContentResult,
} from '../clipboard'

import {
  SUBSCRIPTION_CHANNEL,
  type SubscriptionRequest,
  type SubscriptionReply,
} from '../subscriptions'

import { STARTUP_CHANNEL, STARTUP_RETRY_CHANNEL, type StartupSnapshot } from '../startup'

interface Boot {
  startup: StartupSnapshot
  apiBase: string
  platform: string
  systemVersion: string
  fullscreen: boolean
  shoot: boolean
  backlog: string
  version: string
  buildNumber: string
  channel: string
  developerToolsEnabled: boolean
  browserEnabled: boolean
  feedbackRecorderEnabled: boolean
  preferences: RendererPreferences
}

let startup: StartupSnapshot | undefined
const startupListeners = new Set<(snapshot: StartupSnapshot) => void>()
ipcRenderer.on(STARTUP_CHANNEL, (_event, next: StartupSnapshot) => {
  if (startup && next.revision <= startup.revision) return
  startup = next
  for (const listener of startupListeners) listener(next)
})
const boot = ipcRenderer.sendSync('scholarseed:boot') as Boot
if (!startup || startup.revision < boot.startup.revision) startup = boot.startup

const bridge = {
  getStartup(): StartupSnapshot {
    return startup!
  },
  onStartup(callback: (snapshot: StartupSnapshot) => void): () => void {
    startupListeners.add(callback)
    callback(startup!)
    return () => startupListeners.delete(callback)
  },
  retryStartup(): Promise<boolean> {
    return ipcRenderer.invoke(STARTUP_RETRY_CHANNEL)
  },
  confirmUpdateWorkbenchReady(): Promise<boolean> {
    return ipcRenderer.invoke(UPDATE_HEALTH_CHANNEL)
  },
  menu: {
    refocus: (ack) => ipcRenderer.invoke(MENU_CHANNEL.refocus, ack),
    presentation: () => ipcRenderer.invoke(MENU_CHANNEL.presentation),
    subscribePresentation(callback) {
      const handler = (_event: unknown, reply: MenuPresentationReply) => callback(reply)
      ipcRenderer.on(MENU_CHANNEL.presentation, handler)
      return () => ipcRenderer.removeListener(MENU_CHANNEL.presentation, handler)
    },
    seed: (request) => ipcRenderer.invoke(MENU_CHANNEL.seed, request),
    publish: (model) => ipcRenderer.invoke(MENU_CHANNEL.publish, model),
    dismiss: (reason) => ipcRenderer.invoke(MENU_CHANNEL.dismiss, reason),
    subscribe(callback) {
      const handler = (_event: unknown, event: MenuEvent) => callback(event)
      ipcRenderer.on(MENU_CHANNEL.event, handler)
      return () => ipcRenderer.removeListener(MENU_CHANNEL.event, handler)
    },
    subscribeRevoked(callback) {
      const handler = (_event: unknown, event: MenuAck & { reason: MenuDismissReason }) =>
        callback(event)
      ipcRenderer.on(MENU_CHANNEL.revoked, handler)
      return () => ipcRenderer.removeListener(MENU_CHANNEL.revoked, handler)
    },
    subscribeResult(callback) {
      const handler = (_event: unknown, result: MenuActionResult) => callback(result)
      ipcRenderer.on(MENU_CHANNEL.result, handler)
      return () => ipcRenderer.removeListener(MENU_CHANNEL.result, handler)
    },
  } satisfies MenuBridge,
  ...(boot.browserEnabled === true
    ? {
        browserTooltip: {
          seed: () => ipcRenderer.invoke(TOOLTIP_OVERLAY_CHANNEL.seed),
          publish: (model) => ipcRenderer.invoke(TOOLTIP_OVERLAY_CHANNEL.publish, model),
          dismiss: () => ipcRenderer.invoke(TOOLTIP_OVERLAY_CHANNEL.dismiss),
          dismissSync() {
            const reply = ipcRenderer.sendSync(TOOLTIP_OVERLAY_CHANNEL.dismissSync) as OverlayReply
            if (!reply.ok) throw new Error(reply.error)
          },
          focus: () => ipcRenderer.invoke(TOOLTIP_OVERLAY_CHANNEL.focus),
          subscribe(callback) {
            const handler = (_event: unknown, event: BrowserOverlayEvent) => callback(event)
            ipcRenderer.on(TOOLTIP_OVERLAY_CHANNEL.event, handler)
            return () => ipcRenderer.removeListener(TOOLTIP_OVERLAY_CHANNEL.event, handler)
          },
        } satisfies BrowserOverlayBridge,
        browserOverlay: {
          seed: () => ipcRenderer.invoke(OVERLAY_CHANNEL.seed),
          publish: (model) => ipcRenderer.invoke(OVERLAY_CHANNEL.publish, model),
          dismiss: () => ipcRenderer.invoke(OVERLAY_CHANNEL.dismiss),
          dismissSync() {
            const reply = ipcRenderer.sendSync(OVERLAY_CHANNEL.dismissSync) as OverlayReply
            if (!reply.ok) throw new Error(reply.error)
          },
          focus: () => ipcRenderer.invoke(OVERLAY_CHANNEL.focus),
          subscribe(callback) {
            const handler = (_event: unknown, event: BrowserOverlayEvent) => callback(event)
            ipcRenderer.on(OVERLAY_CHANNEL.event, handler)
            return () => ipcRenderer.removeListener(OVERLAY_CHANNEL.event, handler)
          },
        } satisfies BrowserOverlayBridge,
      }
    : {}),
  respondBrowserApproval(
    request: BrowserApprovalResponseRequest
  ): Promise<BrowserApprovalResponseReply> {
    return ipcRenderer.invoke(BROWSER_APPROVAL_RESPONSE_CHANNEL, request)
  },
  respondBrowserHistoryApproval(
    request: BrowserHistoryApprovalResponseRequest
  ): Promise<BrowserHistoryApprovalResponseReply> {
    return ipcRenderer.invoke(BROWSER_HISTORY_APPROVAL_RESPONSE_CHANNEL, request)
  },
  vault: {
    status: () => ipcRenderer.invoke(VAULT_CHANNEL.status),
    subscribeStatus: (callback: (status: VaultStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: VaultStatus) => callback(status)
      ipcRenderer.on(VAULT_CHANNEL.changed, listener)
      return () => {
        ipcRenderer.removeListener(VAULT_CHANNEL.changed, listener)
      }
    },
    listMetadata: () => ipcRenderer.invoke(VAULT_CHANNEL.metadata),
    open: (value: Parameters<VaultBridge['open']>[0]) =>
      parseVaultOpen(value)
        ? ipcRenderer.invoke(VAULT_CHANNEL.open, value)
        : Promise.resolve({ ok: false, error: VAULT_ERROR.invalidInput }),
    lock: () => ipcRenderer.invoke(VAULT_CHANNEL.lock),
  } satisfies VaultBridge,
  browser: {
    subscribeReveal(callback) {
      const handler = (_event: unknown, request: BrowserReveal) => callback(request)
      ipcRenderer.on(BROWSER_REVEAL_CHANNEL, handler)
      return () => ipcRenderer.removeListener(BROWSER_REVEAL_CHANNEL, handler)
    },
    page: (request) => ipcRenderer.invoke(BROWSER_PAGE_CHANNEL, request),
    subscribeFind(callback) {
      const handler = (_event: unknown, target: BrowserPageTarget) => callback(target)
      ipcRenderer.on(BROWSER_FIND_CHANNEL, handler)
      return () => ipcRenderer.removeListener(BROWSER_FIND_CHANNEL, handler)
    },
    snapshot: () => ipcRenderer.invoke(BROWSER_SNAPSHOT_CHANNEL),
    dispatch: (command) => ipcRenderer.invoke(BROWSER_COMMAND_CHANNEL, command),
    history: (request) => ipcRenderer.invoke(BROWSER_HISTORY_CHANNEL, request),
    clearData: (request) => ipcRenderer.invoke(BROWSER_DATA_CHANNEL, request),
    downloads: (request) => ipcRenderer.invoke(BROWSER_DOWNLOAD_CHANNEL, request),
    policy: (request) => ipcRenderer.invoke(BROWSER_POLICY_CHANNEL, request),
    subscribe(callback) {
      const handler = (_event: unknown, snapshot: BrowserSnapshot) => callback(snapshot)
      ipcRenderer.on(BROWSER_SNAPSHOT_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_SNAPSHOT_CHANNEL, handler)
      }
    },
    frames: {
      subscribe(callback) {
        const handler = (_event: unknown, frame: BrowserFrame) => callback(frame)
        ipcRenderer.on(BROWSER_FRAME_CHANNEL, handler)
        return () => {
          ipcRenderer.removeListener(BROWSER_FRAME_CHANNEL, handler)
        }
      },
      acknowledge: (tabId, sequence) =>
        ipcRenderer.invoke(BROWSER_FRAME_ACK_CHANNEL, { tabId, sequence }),
      resize: (tabId, width, height) =>
        ipcRenderer.invoke(BROWSER_FRAME_RESIZE_CHANNEL, { tabId, width, height }),
      input: (tabId, input) => ipcRenderer.invoke(BROWSER_FRAME_INPUT_CHANNEL, { tabId, input }),
    },
  } satisfies BrowserBridge,
  getWindowCloseRequest(): Promise<WindowCloseRequest> {
    return ipcRenderer.invoke(WINDOW_CLOSE_REQUEST_CHANNEL)
  },
  onTrayRequest(callback: (requestId: number) => void): () => void {
    const handler = (_event: unknown, requestId: number): void => callback(requestId)
    ipcRenderer.on(TRAY_CHANNEL.request, handler)
    return () => ipcRenderer.removeListener(TRAY_CHANNEL.request, handler)
  },
  replyTray(reply: TrayReply): Promise<boolean> {
    return ipcRenderer.invoke(TRAY_CHANNEL.reply, reply)
  },
  onTrayNavigate(callback: (target: TrayNavigation) => void): () => void {
    const handler = (_event: unknown, target: TrayNavigation): void => callback(target)
    ipcRenderer.on(TRAY_CHANNEL.navigate, handler)
    return () => ipcRenderer.removeListener(TRAY_CHANNEL.navigate, handler)
  },
  onWindowCloseRequest(callback: (request: WindowCloseRequest) => void): () => void {
    const handler = (_event: unknown, request: WindowCloseRequest): void => callback(request)
    ipcRenderer.on(WINDOW_CLOSE_REQUEST_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WINDOW_CLOSE_REQUEST_CHANNEL, handler)
  },
  respondWindowClose(reply: WindowCloseReply): Promise<boolean> {
    return ipcRenderer.invoke(WINDOW_CLOSE_REPLY_CHANNEL, reply)
  },
  subscriptionLogin(request: SubscriptionRequest): Promise<SubscriptionReply> {
    return ipcRenderer.invoke(SUBSCRIPTION_CHANNEL, request)
  },
  deviceSkills(request: DeviceSkillRequest): Promise<DeviceSkillResponse> {
    return ipcRenderer.invoke(SKILLS_CHANNEL, request)
  },
  onPluginNavigation(callback: () => void): () => void {
    const handler = (): void => callback()
    ipcRenderer.on(PLUGIN_NAVIGATION_CHANNEL, handler)
    return () => ipcRenderer.removeListener(PLUGIN_NAVIGATION_CHANNEL, handler)
  },
  onPluginRevoked(callback: (lease: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, lease: string): void => callback(lease)
    ipcRenderer.on(PLUGIN_REVOKED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(PLUGIN_REVOKED_CHANNEL, handler)
  },
  mcpSettings(request: McpSettingsRequest): Promise<McpSettingsResponse> {
    return ipcRenderer.invoke(MCP_SETTINGS_CHANNEL, request)
  },
  getApiBase(): string {
    if (!startup?.apiBase) throw new Error('backend_not_ready')
    return startup.apiBase
  },
  platform: boot.platform,
  systemVersion: boot.systemVersion,
  fullscreen: boot.fullscreen,
  onFullscreenChange(callback: (fullscreen: boolean) => void): () => void {
    const handler = (_event: unknown, fullscreen: boolean): void => callback(fullscreen)
    ipcRenderer.on(WINDOW_FULLSCREEN_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WINDOW_FULLSCREEN_CHANNEL, handler)
  },
  shoot: boot.shoot,
  backlog: boot.backlog,
  version: boot.version,
  buildNumber: boot.buildNumber,
  channel: boot.channel,
  developerToolsEnabled: boot.developerToolsEnabled,
  browserEnabled: boot.browserEnabled === true,
  feedbackRecorderEnabled: boot.feedbackRecorderEnabled,
  preferences: boot.preferences,
  async savePreferences(
    preferences: RendererPreferences,
    submission?: PreferenceSubmission
  ): Promise<RendererPreferences> {
    const reply = await ipcRenderer.invoke(PREFERENCES_SAVE_CHANNEL, preferences, submission)
    if (!submission) return reply as RendererPreferences
    const receipt = reply as PreferenceReceipt
    if (receipt.acknowledgedRevision !== submission.submittedRevision)
      throw new Error(PREFERENCE_SHUTDOWN_ERROR.receipt)
    return receipt.preferences
  },
  getPreferenceShutdownRequest(): Promise<PreferenceShutdownRequest> {
    return ipcRenderer.invoke(PREFERENCE_SHUTDOWN_CHANNEL.request)
  },
  onPreferenceShutdownRequest(callback: (request: PreferenceShutdownRequest) => void): () => void {
    const handler = (_event: unknown, request: PreferenceShutdownRequest): void => callback(request)
    ipcRenderer.on(PREFERENCE_SHUTDOWN_CHANNEL.request, handler)
    return () => ipcRenderer.removeListener(PREFERENCE_SHUTDOWN_CHANNEL.request, handler)
  },
  respondPreferenceShutdown(reply: PreferenceShutdownReply): Promise<boolean> {
    return ipcRenderer.invoke(PREFERENCE_SHUTDOWN_CHANNEL.reply, reply)
  },
  reconcilePreferences(): Promise<RendererPreferences> {
    return ipcRenderer.invoke(PREFERENCES_RECONCILE_CHANNEL)
  },
  systemPermissions(): Promise<SystemPermissionsSnapshot> {
    return ipcRenderer.invoke('scholarseed:system-permissions')
  },
  openSystemPermission(id: SystemPermissionId): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:system-permission-open', id)
  },
  onNotificationClick(cb: (attentionId: string) => void): () => void {
    const handler = (_event: unknown, attentionId: string) => cb(attentionId)
    ipcRenderer.on(ATTENTION_CLICK_CHANNEL, handler)
    void ipcRenderer.invoke(ATTENTION_READY_CHANNEL)
    return () => ipcRenderer.removeListener(ATTENTION_CLICK_CHANNEL, handler)
  },
  notifications: {
    onChange(callback: (frame: NotificationFrame) => void): () => void {
      const handler = (_event: unknown, frame: NotificationFrame): void => callback(frame)
      ipcRenderer.on(NOTIFICATION_CHANNEL, handler)
      return () => ipcRenderer.removeListener(NOTIFICATION_CHANNEL, handler)
    },
    onAttention(callback: (snapshot: AttentionSnapshot | null) => void): () => void {
      const handler = (_event: unknown, snapshot: AttentionSnapshot | null): void =>
        callback(snapshot)
      ipcRenderer.on(ATTENTION_STATE_CHANNEL, handler)
      return () => ipcRenderer.removeListener(ATTENTION_STATE_CHANNEL, handler)
    },
    sync(): Promise<void> {
      return ipcRenderer.invoke(NOTIFICATION_SYNC_CHANNEL)
    },
  },
  /** 打开系统废纸篓（恢复入口：用户在那里「放回原处」）。目标由主进程决定。 */
  openTrash(): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('scholarseed:open-trash')
  },
  /** 用一次性令牌把资料移入废纸篓。绝对路径不经渲染层（proposal 47 §6.6）。 */
  trashToken(token: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('scholarseed:trash-token', token)
  },
  syncAuthorizedRoots(scope: AuthorizationScope, roots: string[]): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:authorized-roots-sync', scope, roots)
  },
  addAuthorizedRoot(scope: AuthorizationScope, root: string): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:authorized-root-add', scope, root)
  },
  /** Return the canonical path of a File explicitly selected or dropped in Electron. */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  onBackendLog(cb: (line: string) => void): () => void {
    const h = (_e: unknown, line: string) => cb(line)
    ipcRenderer.on('scholarseed:backend-log', h)
    return () => ipcRenderer.removeListener('scholarseed:backend-log', h)
  },
  onShootScene(cb: (scene: string) => void): () => void {
    const h = (_e: unknown, scene: string) => cb(scene)
    ipcRenderer.on('scholarseed:shoot-scene', h)
    return () => ipcRenderer.removeListener('scholarseed:shoot-scene', h)
  },
  onSay(cb: (msg: string) => void): () => void {
    const h = (_e: unknown, msg: string) => cb(msg)
    ipcRenderer.on('scholarseed:say', h)
    return () => ipcRenderer.removeListener('scholarseed:say', h)
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('scholarseed:open-external', url)
  },
  openPath(path: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('scholarseed:open-path', path)
  },
  revealPath(path: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('scholarseed:reveal-path', path)
  },
  appsForFile(
    filePath: string
  ): Promise<{ name: string; path: string; isDefault: boolean; icon?: string }[]> {
    return ipcRenderer.invoke('scholarseed:apps-for-file', filePath)
  },
  openPathWith(path: string, appPath: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('scholarseed:open-path-with', path, appPath)
  },
  pickDir(): Promise<string | null> {
    return ipcRenderer.invoke('scholarseed:pick-dir')
  },
  pickDeliveryDirectory(request: DeliveryRequest): Promise<DeliveryNativeReply> {
    return ipcRenderer.invoke(DELIVERY_PICK_CHANNEL, request)
  },
  saveDelivery(request: DeliverySaveRequest): Promise<DeliveryNativeReply> {
    return ipcRenderer.invoke(DELIVERY_SAVE_CHANNEL, request)
  },
  openDeliveryDirectory(request: DeliveryRequest): Promise<DeliveryNativeReply> {
    return ipcRenderer.invoke(DELIVERY_OPEN_CHANNEL, request)
  },
  /** 用户触发的 Office 图片选择或剪贴板读取，不接受文件路径。 */
  acquireOfficeImage(source: OfficeImageSource): Promise<OfficeImageResult> {
    return ipcRenderer.invoke(OFFICE_IMAGE_CHANNEL, source)
  },
  /** 写系统剪贴板。不走 navigator.clipboard（它要求文档聚焦，桌面端易失焦被拒）。 */
  writeClipboard(text: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('scholarseed:write-clipboard', text)
  },
  writeClipboardContent(payload: ClipboardContentPayload): Promise<ClipboardContentResult> {
    return ipcRenderer.invoke(CLIPBOARD_WRITE_CONTENT_CHANNEL, payload)
  },
  pasteClipboard(): Promise<boolean> {
    return ipcRenderer.invoke(CLIPBOARD_PASTE_CHANNEL)
  },
  writeClipboardImage(bytes: Uint8Array): Promise<FeedbackClipboardImageResult> {
    return ipcRenderer.invoke(FEEDBACK_CLIPBOARD_IMAGE_CHANNEL, bytes)
  },
  readOfficeClipboard(): Promise<OfficeClipboardResult> {
    return ipcRenderer.invoke('scholarseed:read-office-clipboard')
  },
  /** 资料导入：按指定范围多选本地资料，返回绝对路径数组。 */
  pickImport(target: ImportPickerTarget): Promise<string[]> {
    return ipcRenderer.invoke('scholarseed:pick-import', target)
  },
  pickExecutable(): Promise<string | null> {
    return ipcRenderer.invoke('scholarseed:pick-executable')
  },
  saveFileCopy(payload: {
    suggestedName: string
    bytes: Uint8Array
  }): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('scholarseed:save-copy', payload)
  },
  requestOfficeFontAccess(): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:office-font-access')
  },
  listOfficeFonts(): Promise<OfficeFontCatalog> {
    return ipcRenderer.invoke(OFFICE_FONT_CATALOG_CHANNEL)
  },
  readOfficeFont(id: string): Promise<Uint8Array> {
    return ipcRenderer.invoke(OFFICE_FONT_READ_CHANNEL, id)
  },
  readOfficeFontCache(fingerprint: string): Promise<OfficeFontCache | null> {
    return ipcRenderer.invoke(OFFICE_FONT_CACHE_READ_CHANNEL, fingerprint)
  },
  writeOfficeFontCache(fingerprint: string, cache: OfficeFontCache): Promise<void> {
    return ipcRenderer.invoke(OFFICE_FONT_CACHE_WRITE_CHANNEL, fingerprint, cache)
  },
  syncUpdateDiagnostics(): Promise<void> {
    return ipcRenderer.invoke(FEEDBACK_DIAGNOSTICS_CHANNEL)
  },
  submitFeedback(request: FeedbackSubmissionRequest): Promise<FeedbackSubmissionResult> {
    return ipcRenderer.invoke(FEEDBACK_SUBMIT_CHANNEL, request)
  },
  captureFeedbackScreenshot(): Promise<FeedbackScreenshotResult> {
    return ipcRenderer.invoke(FEEDBACK_CAPTURE_CHANNEL)
  },
  onFeedbackShortcut(callback: () => void): () => void {
    const handler = (): void => callback()
    ipcRenderer.on(FEEDBACK_SHORTCUT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(FEEDBACK_SHORTCUT_CHANNEL, handler)
  },
  setAuthToken(token: string, refreshToken?: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('veda:auth-token-set', token, refreshToken)
  },
  getAuthToken(): Promise<string> {
    return ipcRenderer.invoke('veda:auth-token-get')
  },
  getDeviceInfo(): Promise<{ device_id: string; device_label: string }> {
    return ipcRenderer.invoke('veda:device-info')
  },
  // ── 桌面登录交接（官网浏览器登录 + 深链回跳）──
  desktopLoginStart(language: PreferenceLanguage): Promise<{
    ok: boolean
    error?: string
    applicationFailure?: { code: string; diagnostic?: string }
  }> {
    return ipcRenderer.invoke('scholarseed:desktop-login-start', language)
  },
  desktopLoginCancel(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('scholarseed:desktop-login-cancel')
  },
  desktopAuthState(): Promise<DesktopAuthSnapshot> {
    return ipcRenderer.invoke('scholarseed:desktop-auth-state')
  },
  desktopEnvironment(): Promise<{ elevated: boolean }> {
    return ipcRenderer.invoke('scholarseed:desktop-environment')
  },
  desktopAuthAdoptedAck(id: number, confirmed: boolean): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('scholarseed:desktop-auth-adopted-ack', id, confirmed)
  },
  onDesktopAuth(cb: (snapshot: DesktopAuthSnapshot) => void): () => void {
    const h = (_e: unknown, snapshot: DesktopAuthSnapshot) => cb(snapshot)
    ipcRenderer.on('scholarseed:desktop-auth', h)
    return () => ipcRenderer.removeListener('scholarseed:desktop-auth', h)
  },
  claimLanding(): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:landing-claim')
  },
  setLoginWindowVisible(visible: boolean): Promise<void> {
    return ipcRenderer.invoke(LOGIN_WINDOW_CHANNEL, visible)
  },
  landingDismiss(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('scholarseed:landing-dismiss')
  },
  onLandingReopen(cb: (detail: { error: string }) => void): () => void {
    const h = (_e: unknown, detail: { error: string }) => cb(detail)
    ipcRenderer.on('scholarseed:landing-reopen', h)
    return () => ipcRenderer.removeListener('scholarseed:landing-reopen', h)
  },
  getPreviewUpdatePolicy(): Promise<PreviewUpdatePolicy> {
    return ipcRenderer.invoke(PREVIEW_UPDATE_IPC.get)
  },
  setPreviewUpdateScope(scope: PreviewUpdateScope): Promise<PreviewUpdatePolicy> {
    return ipcRenderer.invoke(PREVIEW_UPDATE_IPC.scope, scope)
  },
  listPreviewUpdateLines(): Promise<PreviewUpdateLine[]> {
    return ipcRenderer.invoke(PREVIEW_UPDATE_IPC.lines)
  },
  selectPreviewUpdateTarget(id: string): Promise<PreviewUpdatePolicy> {
    return ipcRenderer.invoke(PREVIEW_UPDATE_IPC.select, id)
  },
  cancelPreviewUpdateTarget(): Promise<PreviewUpdatePolicy> {
    return ipcRenderer.invoke(PREVIEW_UPDATE_IPC.cancel)
  },
  getUpdateState(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke('scholarseed:update-state-get')
  },
  checkUpdate(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke('scholarseed:update-check')
  },
  // 静默刷新：复用主进程背景检查路径（不进 'checking' 相位），更新表面打开时调用；
  // 结果经快照广播回来，这里没有返回值。
  refreshUpdate(): Promise<void> {
    return ipcRenderer.invoke('scholarseed:update-refresh')
  },
  diagnoseUpdate(): Promise<UpdateDiagnosis> {
    return ipcRenderer.invoke('scholarseed:update-diagnose')
  },
  storageConfig(): Promise<StorageConfig> {
    return ipcRenderer.invoke('scholarseed:storage-config')
  },
  commitDataHome(parent: string): Promise<CommitDataHomeResult> {
    return ipcRenderer.invoke('scholarseed:commit-data-home', parent)
  },
  startUpdate(id: string): Promise<StartUpdateResult> {
    return ipcRenderer.invoke('scholarseed:update-start', id)
  },
  installUpdate(expectedId: string): Promise<StartUpdateResult> {
    return ipcRenderer.invoke('scholarseed:update-install', expectedId)
  },
  repairUpdate(): Promise<StartUpdateResult> {
    return ipcRenderer.invoke(UPDATE_REPAIR_CHANNEL)
  },
  cancelUpdate(): Promise<StartUpdateResult> {
    return ipcRenderer.invoke('scholarseed:update-cancel')
  },
  // 不带参数：要记哪个候选由主进程按当前快照自己算，渲染层不传身份。
  acknowledgeUpdateAnnouncement(): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:update-announce-ack')
  },
  onUpdateState(cb: (state: UpdateSnapshot) => void): () => void {
    const h = (_e: unknown, state: UpdateSnapshot) => cb(state)
    ipcRenderer.on('scholarseed:update-state', h)
    return () => ipcRenderer.removeListener('scholarseed:update-state', h)
  },
}

contextBridge.exposeInMainWorld('scholarseed', bridge)
