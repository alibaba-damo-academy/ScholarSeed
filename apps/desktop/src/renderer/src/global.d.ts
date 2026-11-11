import type { SubscriptionRequest, SubscriptionReply } from '../../subscriptions'
import type { DeliveryRequest, DeliverySaveRequest, DeliveryNativeReply } from '../../delivery'
import type { BrowserBridge } from '../../browser'
import type { VaultBridge, VaultViewBridge } from '../../vault'
import type { MenuBridge, MenuViewBridge } from '../../menu'
import type { BrowserOverlayBridge, SuggestionsBridge } from '../../overlay'
import type {
  BrowserApprovalResponseRequest,
  BrowserApprovalResponseReply,
  BrowserHistoryApprovalResponseRequest,
  BrowserHistoryApprovalResponseReply,
} from '../../approval'
import type { WindowCloseRequest, WindowCloseReply } from '../../window'
import type { PdfeNativeBridge } from '../../pdfe'
import type { TrayNavigation, TrayReply } from '../../tray'
import type { PreferenceLanguage, RendererPreferences } from '../../preferences'
import type { PreferenceSubmission } from '../../preference-diagnostics'
import type { PreferenceShutdownRequest, PreferenceShutdownReply } from '../../quiescence'
import type { SystemPermissionId, SystemPermissionsSnapshot } from '../../permissions'
import type { CommitDataHomeResult, StorageConfig } from '../../storage'
import type { OfficeImageResult, OfficeImageSource } from '../../images'
import type { OfficeClipboardResult } from '../../main/clipboard'
import type { OfficeFontCatalog, OfficeFontCache } from '../../fonts'
import type { ClipboardContentPayload, ClipboardContentResult } from '../../clipboard'
import type { ImportPickerTarget } from '../../picker'
import type { DeviceSkillRequest, DeviceSkillResponse } from '../../skills'
import type { McpSettingsRequest, McpSettingsResponse } from '../../mcp-settings'
import type {
  FeedbackClipboardImageResult,
  FeedbackScreenshotResult,
  FeedbackSubmissionRequest,
  FeedbackSubmissionResult,
} from '../../feedback'
// 更新服务的线上契约只在 src/updates.ts 定义一份，它同时被 web 与 node 两个
// tsconfig 项目包含。这里手抄的副本已经漂移过一次（缺 version_built_at）。
// 仅类型导入，不给 renderer 任何 Node/Electron 运行能力。
import type {
  StartUpdateResult,
  UpdateDiagnosis,
  UpdateSnapshot,
  PreviewUpdatePolicy,
  PreviewUpdateScope,
  PreviewUpdateLine,
} from '../../updates'

export {}

/**
 * OS 级动作的授权档位（与主进程 `main/authorization.ts` 的 AUTHORIZATION_SCOPES 对齐）。
 *
 * `external` 是产品显式授权的项目外根：关联导入的资料物理上在项目外，废纸篓、
 * 访达、指定应用打开都要能对它生效。撤销授权后整档摘除，OS 级动作即时失效。
 */
type AuthorizationScope = 'workspace' | 'session' | 'external'

/** 桌面登录交接相位快照（与 main/handoff.ts 的 DesktopAuthSnapshot 对齐）。 */
interface DesktopAuthSnapshot {
  confirmationId?: number
  phase: 'idle' | 'waiting' | 'exchanging' | 'adopted' | 'failed'
  error?: string
  /** 这次 failed 是不是终结型（state 已被清掉）。只在客户端可观测：服务端唯一信号
   *  `consumed` 对终结型与可重试型完全同形，网页推不出这个区分。 */
  terminal?: boolean
}

import type { StartupSnapshot } from '../../startup'
import type { NotificationBridge } from '../../notifications'

declare global {
  interface ScholarSeedBridge {
    confirmUpdateWorkbenchReady?: () => Promise<boolean>
    vault?: VaultBridge
    menu?: MenuBridge
    browserOverlay?: BrowserOverlayBridge
    browserTooltip?: BrowserOverlayBridge
    browser: BrowserBridge
    respondBrowserApproval?: (
      request: BrowserApprovalResponseRequest
    ) => Promise<BrowserApprovalResponseReply>
    respondBrowserHistoryApproval?: (
      request: BrowserHistoryApprovalResponseRequest
    ) => Promise<BrowserHistoryApprovalResponseReply>
    getWindowCloseRequest?: () => Promise<WindowCloseRequest>
    onWindowCloseRequest?: (callback: (request: WindowCloseRequest) => void) => () => void
    onTrayRequest?: (callback: (requestId: number) => void) => () => void
    replyTray?: (reply: TrayReply) => Promise<boolean>
    onTrayNavigate?: (callback: (target: TrayNavigation) => void) => () => void
    respondWindowClose?: (reply: WindowCloseReply) => Promise<boolean>
    deviceSkills: (request: DeviceSkillRequest) => Promise<DeviceSkillResponse>
    onPluginNavigation?: (callback: () => void) => () => void
    onPluginRevoked: (callback: (lease: string) => void) => () => void
    mcpSettings: (request: McpSettingsRequest) => Promise<McpSettingsResponse>
    getStartup?: () => StartupSnapshot
    onStartup?: (callback: (snapshot: StartupSnapshot) => void) => () => void
    retryStartup?: () => Promise<boolean>
    getApiBase: () => string
    platform: string
    systemVersion: string
    fullscreen?: boolean
    onFullscreenChange?: (callback: (fullscreen: boolean) => void) => () => void
    shoot: boolean
    backlog: string
    version: string
    buildNumber: string
    channel: string
    developerToolsEnabled: boolean
    browserEnabled: boolean
    feedbackRecorderEnabled: boolean
    preferences: RendererPreferences
    reconcilePreferences: () => Promise<RendererPreferences>
    savePreferences: (
      preferences: RendererPreferences,
      submission?: PreferenceSubmission
    ) => Promise<RendererPreferences>
    getPreferenceShutdownRequest?: () => Promise<PreferenceShutdownRequest>
    onPreferenceShutdownRequest?: (
      callback: (request: PreferenceShutdownRequest) => void
    ) => () => void
    respondPreferenceShutdown?: (reply: PreferenceShutdownReply) => Promise<boolean>
    systemPermissions: () => Promise<SystemPermissionsSnapshot>
    openSystemPermission: (id: SystemPermissionId) => Promise<boolean>
    onNotificationClick: (cb: (attentionId: string) => void) => () => void
    notifications?: NotificationBridge
    openTrash: () => Promise<{ ok: boolean; path?: string; error?: string }>
    trashToken: (token: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    syncAuthorizedRoots: (scope: AuthorizationScope, roots: string[]) => Promise<boolean>
    addAuthorizedRoot: (scope: AuthorizationScope, root: string) => Promise<boolean>
    /** Electron-only path for a File explicitly selected or dropped by the user. */
    pathForFile?: (file: File) => string
    onBackendLog: (cb: (line: string) => void) => () => void
    onShootScene: (cb: (scene: string) => void) => () => void
    onSay: (cb: (msg: string) => void) => () => void
    subscriptionLogin: (request: SubscriptionRequest) => Promise<SubscriptionReply>
    openExternal: (url: string) => Promise<void>
    openPath: (
      path: string,
      workspaceRoot?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    revealPath: (
      path: string,
      workspaceRoot?: string
    ) => Promise<{ ok: boolean; path?: string; error?: string }>
    appsForFile: (
      filePath: string,
      workspaceRoot?: string
    ) => Promise<{ name: string; path: string; isDefault: boolean; icon?: string }[]>
    openPathWith: (
      path: string,
      appPath: string,
      workspaceRoot?: string
    ) => Promise<{ ok: boolean; error?: string }>
    pickDir: () => Promise<string | null>
    pickDeliveryDirectory: (request: DeliveryRequest) => Promise<DeliveryNativeReply>
    saveDelivery: (request: DeliverySaveRequest) => Promise<DeliveryNativeReply>
    openDeliveryDirectory: (request: DeliveryRequest) => Promise<DeliveryNativeReply>
    /** 写系统剪贴板。不走 navigator.clipboard（要求文档聚焦，桌面端易失焦被拒）。 */
    acquireOfficeImage: (source: OfficeImageSource) => Promise<OfficeImageResult>
    writeClipboard: (text: string) => Promise<{ ok: boolean; error?: string }>
    writeClipboardContent: (payload: ClipboardContentPayload) => Promise<ClipboardContentResult>
    pasteClipboard: () => Promise<boolean>
    writeClipboardImage: (bytes: Uint8Array) => Promise<FeedbackClipboardImageResult>
    readOfficeClipboard: () => Promise<OfficeClipboardResult>
    /** 资料导入：按指定范围多选本地资料，取消返回空数组。 */
    pickImport: (target: ImportPickerTarget) => Promise<string[]>
    pickExecutable: () => Promise<string | null>
    saveFileCopy: (payload: {
      suggestedName: string
      bytes: Uint8Array
    }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
    requestOfficeFontAccess: () => Promise<boolean>
    listOfficeFonts: () => Promise<OfficeFontCatalog>
    readOfficeFont: (id: string) => Promise<Uint8Array>
    readOfficeFontCache: (fingerprint: string) => Promise<OfficeFontCache | null>
    writeOfficeFontCache: (fingerprint: string, cache: OfficeFontCache) => Promise<void>
    syncUpdateDiagnostics: () => Promise<void>
    submitFeedback: (request: FeedbackSubmissionRequest) => Promise<FeedbackSubmissionResult>
    captureFeedbackScreenshot: () => Promise<FeedbackScreenshotResult>
    onFeedbackShortcut: (callback: () => void) => () => void
    /** 把账号服务签发的双令牌交给主进程: access 写 session cookie, refresh 加密落盘供续期; 空 token = 登出。 */
    setAuthToken: (token: string, refreshToken?: string) => Promise<{ ok: boolean; error?: string }>
    /** 从 session cookie 取回当前令牌 (直连账号服务的受保护端点时当 bearer)。 */
    getAuthToken: () => Promise<string>
    getDeviceInfo: () => Promise<{ device_id: string; device_label: string }>
    /** 发起官网浏览器登录（主进程生成 state 并开系统浏览器）。 */
    desktopLoginStart: (language: PreferenceLanguage) => Promise<{
      ok: boolean
      error?: string
      applicationFailure?: { code: string; diagnostic?: string }
    }>
    desktopLoginCancel: () => Promise<{ ok: boolean }>
    /** 挂载时 claim 当前交接快照（深链早于渲染层到达时相位不丢）。 */
    desktopAuthState: () => Promise<DesktopAuthSnapshot>
    /** 只读环境事实：Windows 提权运行时为 true，登录等待态据此提示回调送达风险。 */
    desktopEnvironment: () => Promise<{ elevated: boolean }>
    /** 采纳后置链路跑完后把 adopted 收回 idle。 */
    desktopAuthAdoptedAck: (id: number, confirmed: boolean) => Promise<{ ok: boolean }>
    onDesktopAuth: (cb: (snapshot: DesktopAuthSnapshot) => void) => () => void
    /** 冷启动首页认领：未 dismissed 前每次挂载都可认领，harness 恒 false。 */
    claimLanding: () => Promise<boolean>
    setLoginWindowVisible: (visible: boolean) => Promise<void>
    /** 首页被关闭（跳过 / 登录采纳）后回报主进程，本进程内不再重新认领。 */
    landingDismiss: () => Promise<{ ok: boolean }>
    /** 终结型交接失败时主进程主动把首页推回来（proposal 73 §6.4）。与 claimLanding 的
     *  区别：那是冷启动的 pull，这条是失败驱动的 push，且走放宽的前置 —— 不查
     *  getAuthMe，因为 adopt_failed 那条路上本地可能已存 refresh token 且设过 cookie，
     *  「本地看起来已登录」恰恰是要展示给用户的问题本身。 */
    onLandingReopen: (cb: (detail: { error: string }) => void) => () => void
    getPreviewUpdatePolicy: () => Promise<PreviewUpdatePolicy>
    setPreviewUpdateScope: (scope: PreviewUpdateScope) => Promise<PreviewUpdatePolicy>
    listPreviewUpdateLines: () => Promise<PreviewUpdateLine[]>
    selectPreviewUpdateTarget: (id: string) => Promise<PreviewUpdatePolicy>
    cancelPreviewUpdateTarget: () => Promise<PreviewUpdatePolicy>
    getUpdateState: () => Promise<UpdateSnapshot>
    checkUpdate: () => Promise<UpdateSnapshot>
    /** 静默刷新：与背景检查同一条路径（不进 'checking' 相位）；更新表面打开时刷新状态。 */
    refreshUpdate: () => Promise<void>
    diagnoseUpdate: () => Promise<UpdateDiagnosis>
    /** 数据位置只读概览（home / 组件仓库 / 是否已配置）。 */
    storageConfig: () => Promise<StorageConfig>
    /** mac「高级」/ dev 提交数据父目录 P；写 userData 指针，下次启动生效。 */
    commitDataHome: (parent: string) => Promise<CommitDataHomeResult>
    startUpdate: (id: string) => Promise<StartUpdateResult>
    installUpdate: (expectedId: string) => Promise<StartUpdateResult>
    repairUpdate: () => Promise<StartUpdateResult>
    cancelUpdate: () => Promise<StartUpdateResult>
    /** 收起「发现新版本」弹窗；确认由主进程落盘，跨客户端重启有效。false = 当前没有候选包。 */
    acknowledgeUpdateAnnouncement: () => Promise<boolean>
    onUpdateState: (cb: (state: UpdateSnapshot) => void) => () => void
  }
  interface Window {
    pdfe?: PdfeNativeBridge
    vault?: VaultViewBridge
    menu?: MenuViewBridge
    suggestions?: SuggestionsBridge
    scholarseed: ScholarSeedBridge
    __scholarseedLiveTurnStatus?: () => {
      activeSession: string | null
      runtimeId: string | null
      running: boolean
      status: string | null
      lastSeq: number
      conversationLength: number
      todoCount: number
      artifactCount: number
      hilPending: boolean
      runtimeReadinessKnown: boolean
      runtimeReady: boolean
    }
    __scholarseedSubmitMessage?: (message: string) => Promise<boolean>
  }
}
