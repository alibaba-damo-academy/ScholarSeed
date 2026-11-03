import { unavailablePermissionRecords } from '../../../permissions.ts'
import { skillRequest } from '../../../skills.ts'
import { mcpSettingsRequest } from '../../../mcp-settings.ts'
import {
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_CLIPBOARD_IMAGE_ERROR,
  feedbackSubmissionForm,
  FEEDBACK_LIMITS,
  FEEDBACK_HTTP_RATE_LIMITED,
} from '../../../feedback.ts'
import { OFFICE_CLIPBOARD_ERROR } from '../../../clipboard.ts'
import { BROWSER_ERROR } from '../../../browser.ts'
import { DELIVERY_NATIVE_UNAVAILABLE } from '../../../delivery.ts'

import type { RendererPreferences } from '../../../preferences.ts'

type BrowserBridge = Omit<
  ScholarSeedBridge,
  | 'writeClipboard'
  | 'writeClipboardContent'
  | 'pasteClipboard'
  | 'pickImport'
  | 'trashToken'
  | 'openTrash'
  | 'acquireOfficeImage'
>
type UpdateState = Awaited<ReturnType<ScholarSeedBridge['getUpdateState']>>

export interface BrowserEnvironment {
  platform: string
  version: string
  preferences: RendererPreferences
  reconcilePreferences: BrowserBridge['reconcilePreferences']
  savePreferences: BrowserBridge['savePreferences']
  setAuthToken: BrowserBridge['setAuthToken']
  getAuthToken: BrowserBridge['getAuthToken']
  getDeviceInfo: BrowserBridge['getDeviceInfo']
  openExternal: BrowserBridge['openExternal']
  saveFileCopy: BrowserBridge['saveFileCopy']
  fetch: typeof fetch
}

const UNSUPPORTED_TEXT = '浏览器模式不支持该原生能力，请使用桌面端。'
const WEB_CHANNEL = 'web'
// 同源：地址前缀留空，请求由 Vite 的 /api 反代转给 serve（SSE 与 cookie 因此免跨源）。
const SAME_ORIGIN_API_BASE = ''
const noop = (): void => undefined
const unsubscribe = (): (() => void) => noop

function upToDate(version: string): UpdateState {
  return { phase: 'up-to-date', currentVersion: version }
}

export function createBrowserBridge(environment: BrowserEnvironment): BrowserBridge {
  return {
    menu: undefined,
    browser: {
      snapshot: async () => ({ ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }),
      dispatch: async () => ({ ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }),
      history: async () => ({ ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }),
      clearData: async () => ({ ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }),
      downloads: async () => ({ ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }),
      policy: async () => ({ ok: false, error: BROWSER_ERROR.policyUnavailable }),
      subscribe: unsubscribe,
    },
    subscriptionLogin: async () => ({ available: false }),
    getApiBase: () => SAME_ORIGIN_API_BASE,
    onPluginRevoked: unsubscribe,
    deviceSkills: async (request) => {
      const { path, init } = skillRequest(request)
      const response = await environment.fetch(`${SAME_ORIGIN_API_BASE}${path}`, {
        ...init,
        credentials: 'include',
      })
      return { status: response.status, body: await response.text() }
    },
    mcpSettings: async (request) => {
      const { path, init } = mcpSettingsRequest(request)
      const response = await environment.fetch(`${SAME_ORIGIN_API_BASE}${path}`, {
        ...init,
        credentials: 'include',
      })
      return { status: response.status, body: await response.text() }
    },
    platform: environment.platform,
    shoot: false,
    backlog: '',
    version: environment.version,
    systemVersion: '',
    buildNumber: '',
    channel: WEB_CHANNEL,
    developerToolsEnabled: false,
    browserEnabled: false,
    feedbackRecorderEnabled: false,
    syncUpdateDiagnostics: async () => {},
    submitFeedback: async (request) => {
      try {
        const response = await environment.fetch(SAME_ORIGIN_API_BASE + '/api/serve/feedback', {
          method: 'POST',
          credentials: 'include',
          body: feedbackSubmissionForm(request),
          signal: AbortSignal.timeout(FEEDBACK_LIMITS.submitTimeoutMs),
        })
        if (!response.ok)
          return {
            ok: false,
            code: 'failed',
            rateLimited: response.status === FEEDBACK_HTTP_RATE_LIMITED,
          }
        const payload = await response.json()
        return payload.ok !== false && typeof payload.id === 'string' && payload.id
          ? { ok: true, id: payload.id }
          : { ok: false, code: 'failed' }
      } catch {
        return { ok: false, code: 'failed' }
      }
    },
    captureFeedbackScreenshot: async () => ({ ok: false, error: FEEDBACK_CAPTURE_ERROR.failed }),
    onFeedbackShortcut: () => () => {},
    writeClipboardImage: async () => ({
      ok: false,
      error: FEEDBACK_CLIPBOARD_IMAGE_ERROR.unavailable,
    }),
    readOfficeClipboard: async () => ({ ok: false, error: OFFICE_CLIPBOARD_ERROR.failed }),
    preferences: environment.preferences,
    reconcilePreferences: environment.reconcilePreferences,
    savePreferences: environment.savePreferences,
    systemPermissions: async () => ({
      platform: environment.platform,
      permissions: unavailablePermissionRecords(),
    }),
    openSystemPermission: async () => false,
    onNotificationClick: unsubscribe,
    // 目录授权是给主进程的原生文件访问兜底的；浏览器里没有那条通路，也就无从「授权失败」，
    // 如实回 true，别把桌面端的权限提示搬到浏览器上误导用户。
    syncAuthorizedRoots: async () => true,
    addAuthorizedRoot: async () => true,
    onBackendLog: unsubscribe,
    onShootScene: unsubscribe,
    onSay: unsubscribe,
    openExternal: environment.openExternal,
    openPath: async () => ({
      ok: false,
      error: UNSUPPORTED_TEXT,
      applicationFailure: { code: 'desktop_bridge_unavailable' },
    }),
    revealPath: async () => ({
      ok: false,
      error: UNSUPPORTED_TEXT,
      applicationFailure: { code: 'desktop_bridge_unavailable' },
    }),
    appsForFile: async () => [],
    openPathWith: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
    pickDir: async () => null,
    pickDeliveryDirectory: async () => ({ ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }),
    openDeliveryDirectory: async () => ({ ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }),
    saveDelivery: async () => ({ ok: false, error: DELIVERY_NATIVE_UNAVAILABLE }),
    pickExecutable: async () => null,
    saveFileCopy: environment.saveFileCopy,
    requestOfficeFontAccess: async () => false,
    listOfficeFonts: async () => {
      throw new Error('Office fonts require Desktop')
    },
    readOfficeFont: async () => {
      throw new Error('Office fonts require Desktop')
    },
    readOfficeFontCache: async () => {
      throw new Error('Office fonts require Desktop')
    },
    writeOfficeFontCache: async () => {
      throw new Error('Office fonts require Desktop')
    },
    setAuthToken: environment.setAuthToken,
    getAuthToken: environment.getAuthToken,
    getDeviceInfo: environment.getDeviceInfo,
    // 桌面登录交接是主进程能力（深链回跳）：浏览器形态没有这条通路。
    // claimLanding 恒 false —— 桌面冷启动首页只属于桌面端。
    desktopLoginStart: async () => ({
      ok: false,
      error: UNSUPPORTED_TEXT,
      applicationFailure: { code: 'native_unavailable' },
    }),
    desktopLoginCancel: async () => ({ ok: true }),
    desktopAuthState: async () => ({ phase: 'idle' as const }),
    desktopEnvironment: async () => ({ elevated: false }),
    desktopAuthAdoptedAck: async () => ({ ok: true }),
    onDesktopAuth: unsubscribe,
    claimLanding: async () => false,
    setLoginWindowVisible: async () => {},
    landingDismiss: async () => ({ ok: true }),
    onLandingReopen: unsubscribe,
    getPreviewUpdatePolicy: async () => {
      throw new Error('Preview updates require the desktop app')
    },
    setPreviewUpdateScope: async () => {
      throw new Error('Preview updates require the desktop app')
    },
    listPreviewUpdateLines: async () => {
      throw new Error('Preview updates require the desktop app')
    },
    selectPreviewUpdateTarget: async () => {
      throw new Error('Preview updates require the desktop app')
    },
    cancelPreviewUpdateTarget: async () => {
      throw new Error('Preview updates require the desktop app')
    },
    getUpdateState: async () => upToDate(environment.version),
    checkUpdate: async () => upToDate(environment.version),
    // 浏览器形态没有更新通路（恒 upToDate、从不带候选包），静默刷新如实无操作。
    refreshUpdate: async () => {},
    // 浏览器形态没有本机数据位置：home 未知、不可配置、不可提交。
    storageConfig: async () => ({
      home: '',
      runtimeStore: null,
      configured: false,
      canChangeDataHome: false,
      firstLaunchEligible: false,
    }),
    commitDataHome: async () => ({ ok: false as const, reason: 'unsupported' as const }),
    diagnoseUpdate: async () => ({
      url: '',
      releaseLane: 'local',
      policy: { productId: '', bundleId: '', expectedTeamId: '', channel: '' },
      server: null,
      mismatches: [],
      error: UNSUPPORTED_TEXT,
    }),
    startUpdate: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
    installUpdate: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
    cancelUpdate: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
    // 浏览器形态恒 upToDate、从不带候选包，没有可确认的弹窗；false 是如实回答。
    acknowledgeUpdateAnnouncement: async () => false,
    onUpdateState: unsubscribe,
  }
}
