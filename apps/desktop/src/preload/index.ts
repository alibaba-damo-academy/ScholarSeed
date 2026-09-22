import { PREFERENCES_SAVE_CHANNEL, PREFERENCES_RECONCILE_CHANNEL } from '../preferences'
import { LOGIN_WINDOW_CHANNEL, WINDOW_CLOSE_REQUEST_CHANNEL, WINDOW_CLOSE_REPLY_CHANNEL, type WindowCloseRequest, type WindowCloseReply } from '../window'
// preload — the only bridge between renderer and main. Exposes the backend API
// base URL (the renderer talks ASP/HTTP/SSE straight to it), backend log stream,
// shoot-scene events, an external-open helper, and the version-update surface.

import type { AuthorizationScope } from '../main/authorization'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopAuthSnapshot } from '../main/handoff'
import type { OfficeClipboardResult } from '../main/clipboard'
import type { StartUpdateResult, UpdateDiagnosis, UpdateSnapshot } from '../updates'
import type { PreferenceLanguage, RendererPreferences } from '../preferences'
import type { DesktopNotificationInput, DesktopNotificationResult } from '../notifications'
import type { SystemPermissionId, SystemPermissionsSnapshot } from '../permissions'
import { OFFICE_IMAGE_CHANNEL, type OfficeImageSource, type OfficeImageResult } from '../images'
import type { ImportPickerTarget } from '../picker'
import { SKILLS_CHANNEL, type DeviceSkillRequest, type DeviceSkillResponse } from '../skills'
import {
  FEEDBACK_CAPTURE_CHANNEL,
  FEEDBACK_CLIPBOARD_IMAGE_CHANNEL,
  type FeedbackClipboardImageResult,
  type FeedbackScreenshotResult
} from '../feedback'
import {
  CLIPBOARD_PASTE_CHANNEL,
  CLIPBOARD_WRITE_CONTENT_CHANNEL,
  type ClipboardContentPayload,
  type ClipboardContentResult
} from '../clipboard'

import { SUBSCRIPTION_CHANNEL, type SubscriptionRequest, type SubscriptionReply } from '../subscriptions'

interface Boot {
  apiBase: string
  platform: string
  shoot: boolean
  backlog: string
  version: string
  buildNumber: string
  channel: string
  developerToolsEnabled: boolean
  feedbackRecorderEnabled: boolean
  preferences: RendererPreferences
}

const boot = ipcRenderer.sendSync('scholarseed:boot') as Boot
let apiBase = boot.apiBase

const bridge = {
  getWindowCloseRequest(): Promise<WindowCloseRequest> {
    return ipcRenderer.invoke(WINDOW_CLOSE_REQUEST_CHANNEL)
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
  getApiBase(): string {
    return apiBase
  },
  platform: boot.platform,
  shoot: boot.shoot,
  backlog: boot.backlog,
  version: boot.version,
  buildNumber: boot.buildNumber,
  channel: boot.channel,
  developerToolsEnabled: boot.developerToolsEnabled,
  feedbackRecorderEnabled: boot.feedbackRecorderEnabled,
  preferences: boot.preferences,
  savePreferences(preferences: RendererPreferences): Promise<RendererPreferences> {
    return ipcRenderer.invoke(PREFERENCES_SAVE_CHANNEL, preferences)
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
  showNotification(payload: DesktopNotificationInput): Promise<DesktopNotificationResult> {
    return ipcRenderer.invoke('scholarseed:notification-show', payload)
  },
  playAlertSound(): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:alert-sound')
  },
  onNotificationClick(cb: (sessionId: string) => void): () => void {
    const h = (_e: unknown, sessionId: string) => cb(sessionId)
    ipcRenderer.on('scholarseed:notification-click', h)
    return () => ipcRenderer.removeListener('scholarseed:notification-click', h)
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
  appsForFile(filePath: string): Promise<{ name: string; path: string; isDefault: boolean; icon?: string }[]> {
    return ipcRenderer.invoke('scholarseed:apps-for-file', filePath)
  },
  openPathWith(path: string, appPath: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('scholarseed:open-path-with', path, appPath)
  },
  pickDir(): Promise<string | null> {
    return ipcRenderer.invoke('scholarseed:pick-dir')
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
  saveFileCopy(payload: { suggestedName: string; bytes: Uint8Array }): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('scholarseed:save-copy', payload)
  },
  requestOfficeFontAccess(): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:office-font-access')
  },
  captureFeedbackScreenshot(): Promise<FeedbackScreenshotResult> {
    return ipcRenderer.invoke(FEEDBACK_CAPTURE_CHANNEL)
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
  desktopLoginStart(language: PreferenceLanguage): Promise<{ ok: boolean; error?: string; applicationFailure?: { code: string; diagnostic?: string } }> {
    return ipcRenderer.invoke('scholarseed:desktop-login-start', language)
  },
  desktopLoginCancel(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('scholarseed:desktop-login-cancel')
  },
  desktopAuthState(): Promise<DesktopAuthSnapshot> {
    return ipcRenderer.invoke('scholarseed:desktop-auth-state')
  },
  desktopAuthAdoptedAck(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('scholarseed:desktop-auth-adopted-ack')
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
  runtimeStorePath(): Promise<string | null> {
    return ipcRenderer.invoke('scholarseed:runtime-store-path')
  },
  startUpdate(id: string): Promise<StartUpdateResult> {
    return ipcRenderer.invoke('scholarseed:update-start', id)
  },
  installUpdate(): Promise<StartUpdateResult> {
    return ipcRenderer.invoke('scholarseed:update-install')
  },
  // 不带参数：要记哪个候选由主进程按当前快照自己算，渲染层不传身份。
  acknowledgeUpdateAnnouncement(): Promise<boolean> {
    return ipcRenderer.invoke('scholarseed:update-announce-ack')
  },
  onUpdateState(cb: (state: UpdateSnapshot) => void): () => void {
    const h = (_e: unknown, state: UpdateSnapshot) => cb(state)
    ipcRenderer.on('scholarseed:update-state', h)
    return () => ipcRenderer.removeListener('scholarseed:update-state', h)
  }
}

ipcRenderer.on('scholarseed:backend-base', (_e, nextApiBase: string) => {
  apiBase = nextApiBase
})

contextBridge.exposeInMainWorld('scholarseed', bridge)
