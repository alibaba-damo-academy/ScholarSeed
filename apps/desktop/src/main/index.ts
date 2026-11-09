import { sourceBaseline } from './source.ts'
import { TRAY_CHANNEL } from '../tray'
import {
  DEVELOPMENT_CONTROL_ARGUMENT,
  DEVELOPMENT_CONTROL_TIMEOUT_MS,
  startDevelopmentControl,
} from './development.ts'
import { FeedbackSubmissionService, feedbackResponseBytes } from './submission'
import {
  applicationResources,
  applicationRenderer,
  applicationExecutable,
  applicationInstallation,
  applicationIcon,
} from './resources.ts'
import { prepareWindowsVelopack, type PreparedWindowsVelopack } from './velopack.ts'
import { installationFailure } from './family.ts'
import { restoreUpdateDebugPort, updateDebugArguments } from './debuglaunch.ts'
import { ComponentTimer, COMPONENT_TIMING } from './timing.ts'
import { downloadRuntimeComponents, installedRuntimeManifest } from './components.ts'
import {
  inspectWindowsRuntime,
  prepareWindowsRuntime,
  WindowsHandoffCancelled,
  NATIVE_UPDATE_LOG_FILE,
  WindowsHandoffExitUnconfirmed,
} from './transfer.ts'
import { desktopDirectoryWriter } from './writer'
import { createPluginHost } from './plugins'
import { validatePluginBinding } from './skills'
import {
  PLUGIN_SCHEME,
  PLUGIN_SCHEME_PRIVILEGES,
  PLUGIN_NAVIGATION_CHANNEL,
  type PluginSnapshot,
} from '../plugins'
import { CoordinationReclamation } from './reclamation'
import { uncertainRelease, type ReclamationNative } from '../../native/reclamation.cjs'
import { serveAssets, type AssetServer } from './assets'
import { bundledWindowsRuntime } from '../../runtime/components.cjs'
import { STARTUP_CHANNEL, STARTUP_RETRY_CHANNEL, STARTUP_PHASE, StartupState } from '../startup'
import { resolveStartupAccountBase } from './backend'
import { OfficeFontFiles } from './fontfiles'
import {
  OFFICE_FONT_CATALOG_CHANNEL,
  OFFICE_FONT_READ_CHANNEL,
  OFFICE_FONT_CACHE_READ_CHANNEL,
  OFFICE_FONT_CACHE_WRITE_CHANNEL,
  OFFICE_FONT_CACHE_DIRECTORY,
  type NativeFontFace,
} from '../fonts'
import { OfficeFontCacheStore } from './fontcache'
import officeManifest from '../renderer/public/office/zeta-20250513/manifest.json'
import officeFontManifest from '../renderer/public/fonts/sources.json'
import { userInfo } from 'node:os'
import {
  applicationBundle,
  explicitUpdateProfile,
  persistUpdateLaunch,
  observeUpdateLaunch,
  restoreUpdateLaunch,
} from './relaunch.ts'
import { SCHOLARSEED_HOME_ENV } from './storage'
import { DEFAULT_LANGUAGE } from '../localization/catalog'
import { type as systemType } from 'node:os'
import { formatSystemVersion } from './system'
import type { CredentialProfile } from './product'
import { configureNotificationIdentity } from './identity.ts'
import {
  WindowsNotifications,
  findNotificationUrl,
  notificationAttentionId,
  notificationLaunchAttentionId,
  type ToastNative,
} from './notification.ts'
import { DesktopReminders } from './reminders.ts'
import { ATTENTION_CLICK_CHANNEL, ATTENTION_READY_CHANNEL } from '../attention.ts'
import { NOTIFICATION_SYNC_CHANNEL } from '../notifications.ts'
import { cleanupNotificationShortcut } from './shortcut.ts'
import { migrateLegacyHome } from './legacy.ts'
import { WorkbenchHealth } from './health.ts'
import {
  confirmLegacyMacUpdate,
  pendingLegacyMacUpdateToken,
  watchResourceDirectory,
} from './legacy-mac-update.ts'
import type { DomainNative } from '../../native/domains.cjs'
import { PREFERENCES_SAVE_CHANNEL, PREFERENCES_RECONCILE_CHANNEL } from '../preferences'
import { PreferenceDiagnostics, parsePreferenceSubmission } from '../preference-diagnostics.ts'
import { PreferenceQuiescence, PREFERENCE_SHUTDOWN_CHANNEL } from '../quiescence.ts'
import {
  LOGIN_WINDOW_CHANNEL,
  WINDOW_CLOSE_REQUEST_CHANNEL,
  WINDOW_CLOSE_REPLY_CHANNEL,
  WINDOW_FULLSCREEN_CHANNEL,
} from '../window'
import {
  createLoginWindowSizing,
  createStartupWindowHandoff,
  createWindowHiding,
  createWorkspaceWindowOptions,
  WINDOWS_PLATFORM,
} from './window'
import {
  BROWSER_FIND_CHANNEL,
  BROWSER_SNAPSHOT_CHANNEL,
  BROWSER_REVEAL_CHANNEL,
  PAGE_ZOOM_FACTORS,
} from '../browser'
import { createBrowserRegistry } from './browser'
import { TOOLTIP_OVERLAY_CHANNEL } from '../overlay'
import { createBrowserOverlay, type BrowserOverlayOwner } from './overlay'
import {
  MENU_ACCOUNT_ACTIONS,
  MENU_ACTION,
  MENU_CHANNEL,
  MENU_ERROR,
  sameMenuTarget,
} from '../menu'
import { createMenuOwner, MenuActionRegistry, type MenuOwner } from './menuhost'
import { registerBrowserIpc } from './browseripc'
import { registerDeliveryIpc } from './delivery'
import { createBrowserPolicy } from './policy'
import { createBrowserReadGrants, type BrowserReadScope } from './grant'
import { runBrowserSearch } from './search'
import { agentFailureCode, createAgentBrowserController } from './agent'
import { registerBrowserApprovalIpc, registerBrowserHistoryApprovalIpc } from './approval'
import { createLegacyBrowserHost, type ActiveBrowserHost } from './browserhost'
import { createCdpBroker } from './cdp'
import { createStorageConsumer, FixedStorageHelper } from './vaultstorage'
import { url as inspectorUrl } from 'node:inspector'
import { VaultOwner } from './vault'
import { createVaultDebugPolicy } from './vaultdebug'
import { createVaultIpc, PROTECTED_ASSETS, type ProtectedCleanupReport } from './vaultipc'
import { VAULT_CHANNEL, VAULT_ERROR, type VaultStatus } from '../vault'
// index.ts — Electron main entry.
//

import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  protocol,
  shell,
  session,
  WebContentsView,
  type OpenDialogOptions,
} from 'electron'
import {
  SKILLS_CHANNEL,
  skillRequest,
  type DeviceSkillRequest,
  type DeviceSkillResponse,
} from '../skills'
import {
  MCP_SETTINGS_CHANNEL,
  mcpSettingsRequest,
  type McpSettingsRequest,
  type McpSettingsResponse,
} from '../mcp-settings'
import {
  SUBSCRIPTION_CHANNEL,
  subscriptionLoginPath,
  subscriptionAuthorizationUrl,
  type SubscriptionRequest,
  type SubscriptionReply,
} from '../subscriptions'
import { PREVIEW_UPDATE_IPC } from '../updates.ts'
import type { PreviewUpdatePolicy } from '../updates.ts'
import { previewScope } from './preview.ts'
import { randomUUID } from 'crypto'
import { existsSync, realpathSync } from 'fs'
import { resolveDeviceIdentity } from './device'
import { writeFile } from 'fs/promises'
import { homedir, hostname, platform as osPlatform } from 'os'
import { dirname, join, resolve } from 'path'
import type { BackendHandle } from './backend'
import { BackendMaintenanceRejected } from './backend-control.ts'
import {
  startBackend,
  stopBackend,
  requireCleanBackendStop,
  type BackendStopResult,
  runtimeStoreRoot,
  LOGS_DIRNAME,
  resolveProductConfig,
  waitForHealth,
  backendHostProcessKey,
  writeBackendDiagnostic,
  backendUpdateControl,
  HOST_PROCESS_HEADER,
} from './backend'
import {
  FEEDBACK_DIAGNOSTICS_CHANNEL,
  FEEDBACK_SUBMIT_CHANNEL,
  FEEDBACK_BUNDLE_PATH,
  FEEDBACK_LIMITS,
  feedbackSubmissionForm,
  FEEDBACK_CAPTURE_CHANNEL,
  FEEDBACK_SHORTCUT_CHANNEL,
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_CLIPBOARD_IMAGE_CHANNEL,
  FEEDBACK_CLIPBOARD_IMAGE_ERROR,
  FEEDBACK_SCREENSHOT_MIME_TYPE,
} from '../feedback'
import {
  captureFeedbackScreenshot,
  matchesFeedbackShortcut,
  isFeedbackCaptureSender,
  writeFeedbackClipboardImage,
} from './feedback'
import {
  REFRESH_AHEAD_SECONDS,
  REFRESH_CHECK_INTERVAL_MS,
  accessExpSeconds,
  loadRefreshToken,
  refreshTokens,
  revokeRefreshFamily,
  saveRefreshToken,
} from './auth-refresh'
import { runShoot, runLiveTurn, runModeCheck } from './shoot'
import { appsForFile, openPathWith } from './appsForFile'
import { runDrive } from './drive'
import { runWorkbenchCheck } from './workbench'
import { runPackageCheck } from './packagecheck'
import { installContentSecurityPolicy, mainWindowContentSecurityPolicy } from './csp'
import { finishHeadlessCheck } from './headless'
import {
  loadRendererPreferences,
  commitRendererPreferences,
  reconcileRendererPreferences,
  saveBrowserAutomationPreference,
} from './preferences'
import {
  applyMainLanguage,
  mainLocalization,
  startupFailureTitle,
  storageFailureMessage,
} from './localization'
import { backendFailureMessage, updateInstallFailure, type BackendFailure } from './failure'
import { resolveStartupBudgetMs } from './startupmarker'
import {
  coordinationRoot,
  selectStorage,
  publishStorage,
  desktopStorage,
  desktopHome,
  commitDataHome,
  canCommitDataHome,
  StorageConfigError,
} from './storage'
import { DesktopHandoff, type AdoptOutcome, type DesktopAuthSnapshot } from './handoff'
import {
  drainInbox,
  INBOX_DRAIN_INTERVAL_MS,
  parkCallbackUrl,
  type HandoffInboxDependencies,
} from './handoff-inbox'
import { reportReceipt } from './receipt'
import { createHandoffCoordinator } from './handoff-local'
import { findCallbackUrl, handoffFingerprint, parseCallbackUrl } from './handoff-url'
import { callbackTimingLine, findCallbackTiming } from './handoff-timing'
import { processIntegrityLevel } from './integrity'
import { showStartupScreen, type StartupScreen } from './startup'
import { MacStartupAdmissionError, recoverStartupAdmission } from './admission'
import * as updater from './updater'
import { STARTUP_BUILD_NUMBER, clientVersion, isNewerRelease } from './version'
import type {
  StartUpdateResult,
  LatestVersionMeta,
  UpdateCheckResult,
  UpdateProgress,
  UpdateSnapshot,
} from '../updates'
import { LOCAL_LANE_UPDATE_REASON, UPDATE_HEALTH_CHANNEL, updateCandidateKey } from '../updates'
import { PathAuthorizer, isAuthorizationScope } from './authorization'
import { saveFileCopy } from './save'
import { blocksRendererReload, prepareRendererLoad } from './reload'
import { installOfficeFontPermission } from './fonts'
import { acquireOfficeImage } from './images'
import { OFFICE_IMAGE_CHANNEL, type OfficeImageSource, type OfficeImageResult } from '../images'
import {
  protocolClientArguments,
  requiresSingleInstanceLock,
  resolveDeveloperToolsEnabled,
} from './environment'
import { readOfficeClipboard, writeClipboardContent } from './clipboard'
import { canCopySelection, SELECTION_COPY_ROLE } from './contextmenu'
import { openSystemPermission, readSystemPermissions } from './permissions'
import type { SystemPermissionId } from '../permissions'
import { externalWebUrl } from './external'
import { DEFAULT_SERVE_URL } from '../../endpoints'
import { installApplicationMenu } from './menu'
import { createWindowController } from './tray'
import { DiagnosticLog, RotatingFileLog, isRendererDiagnostic } from './logfile'
import { backgroundPreparationPolicy, UpdatePreparation } from './preparation.ts'
import { nextUpdateCheckAt, UpdateChecks } from './checks.ts'
import {
  IMPORT_PICKER_TARGET,
  isImportPickerTarget,
  supportsImportPickerTarget,
  type ImportPickerTarget,
} from '../picker'
import { TRASH_NOT_COMPLETED_ERROR, waitForTrashCompletion } from './trash'
import {
  CLIPBOARD_PASTE_CHANNEL,
  CLIPBOARD_WRITE_CONTENT_CHANNEL,
  type ClipboardContentPayload,
} from '../clipboard'

protocol.registerSchemesAsPrivileged([
  { scheme: PLUGIN_SCHEME, privileges: PLUGIN_SCHEME_PRIVILEGES },
])
const FAILURE_CODES = {
  clipboardForbidden: 'clipboard_forbidden',
} as const
// Synchronize Electron's notification identity with the installed shortcut before windows exist.
configureNotificationIdentity(app, process.platform)

const storageNative = require('./lease.node') as DomainNative
const coordinationReclamation = new CoordinationReclamation(
  storageNative as ReclamationNative,
  coordinationRoot,
  pushLog
)
// The native bundle closure verifies this literal CommonJS load before packaging.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nativeFonts = require('./fonts.node') as { enumerateFonts: () => Promise<NativeFontFace[]> }

let completeUpdateLaunch: (() => void) | undefined

let backend: BackendHandle | null = null
let lastBackendFailure: BackendFailure | null = null
let mainWindow: BrowserWindow | null = null
let desktopReminders: DesktopReminders | null = null
let attentionRendererReady = false
let pendingAttentionId: string | null = null
let mainWindowHiding: ReturnType<typeof createWindowHiding> | null = null
const toastNative =
  process.platform === 'win32'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the native platform binding only on Windows.
      (require('./notification.node') as ToastNative & {
        programs(): string
        shortcutId(path: string): string
      })
    : null
const windowsNotifications = toastNative
  ? new WindowsNotifications(toastNative, logWindowLifecycle)
  : null
let browserHost: ActiveBrowserHost | null = null
declare const __VAULT_PROTECTED_WATCH_UNSUPPORTED__: boolean
declare const __VAULT_PROTECTED_BINDING__: string
const VAULT_COMPILED_BINDING = __VAULT_PROTECTED_BINDING__
const [, VAULT_COMPILED_GENERATION, VAULT_COMPILED_MANIFEST_DIGEST] =
  VAULT_COMPILED_BINDING.split(':')
let browserVault: VaultOwner | null = null
let browserVaultIpc: ReturnType<typeof createVaultIpc> | null = null
const retiredProtectedOwners = new Set<ReturnType<typeof createVaultIpc>>()
const protectedCleanupTasks = new Map<ReturnType<typeof createVaultIpc>, Promise<void>>()
const protectedCleanupReports = new Map<ReturnType<typeof createVaultIpc>, ProtectedCleanupReport>()
function protectedOwners(): ReturnType<typeof createVaultIpc>[] {
  return [...retiredProtectedOwners, ...(browserVaultIpc ? [browserVaultIpc] : [])]
}
function secretCustodyReady(): boolean {
  return protectedOwners().every((owner) => owner.secretCustodyReady())
}
function projectVaultStatus(status: VaultStatus): VaultStatus {
  return secretCustodyReady() ? status : { ...status, error: VAULT_ERROR.unavailable }
}
function publishVaultStatus(window: BrowserWindow, status: VaultStatus): void {
  try {
    if (!window.webContents.isDestroyed())
      window.webContents.send(VAULT_CHANNEL.changed, projectVaultStatus(status))
  } catch {
    protectedCleanupDiagnostic('status_publish_failed')
  }
}
function protectedCleanupDiagnostic(code: string): void {
  try {
    pushLog(`[vault-cleanup] code=${code}\n`)
  } catch {}
}
function consumeProtectedCleanupReport(
  owner: ReturnType<typeof createVaultIpc>,
  report: ProtectedCleanupReport
): void {
  if ((protectedCleanupReports.get(owner)?.revision ?? -1) > report.revision) return
  protectedCleanupReports.set(owner, report)
  if (report.status === 'pending') ownProtectedCleanupReport(owner)
  protectedCleanupDiagnostic(
    `${report.owner}:${report.revokeId}:${report.status}:${report.codes.join(',')}`
  )
  if (
    report.status === 'closed' &&
    owner.secretCustodyReady() &&
    retiredProtectedOwners.delete(owner)
  )
    protectedCleanupReports.delete(owner)
  if (browserVault && mainWindow) publishVaultStatus(mainWindow, browserVault.status())
}
function ownProtectedCleanupReport(previous: ReturnType<typeof createVaultIpc>): void {
  if (protectedCleanupTasks.has(previous)) return
  const task = previous
    .cleanupReport()
    .then((report) => consumeProtectedCleanupReport(previous, report))
    .catch(() => protectedCleanupDiagnostic('report_consumer_failed'))
    .finally(() => {
      protectedCleanupTasks.delete(previous)
    })
  protectedCleanupTasks.set(previous, task)
}
function retireBrowserVaultIpc(): void {
  const previous = browserVaultIpc
  if (!previous) return
  retiredProtectedOwners.add(previous)
  previous.dispose()
  ownProtectedCleanupReport(previous)
  browserVaultIpc = null
}
let browserStorage: ReturnType<typeof createStorageConsumer> | null = null
const browserStorageOwners = new Set<ReturnType<typeof createStorageConsumer>>()
function retireBrowserStorage(): void {
  const previous = browserStorage
  browserStorage = null
  if (!previous) return
  previous.close()
  void previous.drain().then(
    () => {
      browserStorageOwners.delete(previous)
    },
    (error) => pushLog(`[browser] storage helper drain failed: ${String(error)}\n`)
  )
}
let browserStorageWindowGeneration = 0
const BROWSER_OVERLAY_PARTITION_PREFIX = 'browser-overlay-'
let browserOverlay: BrowserOverlayOwner | null = null
let browserTooltip: BrowserOverlayOwner | null = null
const BROWSER_MENU_PARTITION_PREFIX = 'browser-menu-'
let browserMenu: MenuOwner | null = null
let browserMenuTargetSubscription: (() => void) | null = null
let browserPolicy: ReturnType<typeof createBrowserPolicy> | null = null
let browserGrants: ReturnType<typeof createBrowserReadGrants> | null = null
let browserAgentController: ReturnType<typeof createAgentBrowserController> | null = null
const browserActionFence = new Set<string>()
let browserGrantPolicySubscription: (() => void) | null = null
let browserGrantTargetSubscription: (() => void) | null = null
let browserGrantScopeSubscription: (() => void) | null = null
let setLoginWindowVisible: ReturnType<typeof createLoginWindowSizing> | null = null
let runtimePreparation: AbortController | null = null
let startupScreen: StartupScreen | null = null
let startupScreenStartedAt: number | null = null
let windowLifecycleLog: RotatingFileLog | null = null
let windowDiagnostics: DiagnosticLog | null = null
const WINDOW_LIFECYCLE_LOG_FILENAME = 'window.log'
const windowController = createWindowController({
  requestSnapshot: (requestId) => sendToMainWindow(TRAY_CHANNEL.request, requestId),
  navigate: (target) => {
    sendToMainWindow(TRAY_CHANNEL.navigate, target)
  },
  localizer: mainLocalization,
  revealWindow: (reason) => revealMainWindow(reason),
  markQuitting: () => {
    appQuitting = true
  },
  log: logWindowLifecycle,
})
const SCHOLARSEED_DEFAULT_WORKSPACE_ENV = 'SCHOLARSEED_DEFAULT_WORKSPACE'
const SCHOLARSEED_DEVTOOLS_ENV = 'SCHOLARSEED_DEVTOOLS'
const MAIN_DEVTOOLS_DOCK_MODE = 'right'
const MACOS_PLATFORM = 'darwin'
const MOCK_KEYCHAIN_SWITCH = 'use-mock-keychain'
const DEFAULT_API_BASE = DEFAULT_SERVE_URL
const ROOT_ROUTE = '/'
const BACKEND_RESTART_BASE_DELAY_MS = 1000
const BACKEND_RESTART_MAX_DELAY_MS = 15_000
const BACKEND_PORT_REUSE_ATTEMPTS = 2
// 安装进行中拦截退出的上限（bug 87253073）：准备链每一步都有超时，但最坏情况累加仍可能到
// 十几分钟；期间 before-quit 一律 preventDefault 会把用户锁在应用里（遮罩还承诺「即将关闭」）。
// 超过这个时长仍没结束，放行退出：残留挂载由下一次启动的 stale-mount 清扫回收。
const UPDATE_INSTALL_QUIT_BLOCK_CAP_MS = 300_000
// 取消 IPC 在没有进行中安装时的机器可读错误：不进 UI 文案，故不走 locale（i18n 门禁同口径）。
const NO_INSTALL_IN_PROGRESS = 'no installation in progress'
const BROKEN_STREAM_ERROR_CODES = new Set(['EPIPE', 'EIO'])
// macOS supports a unified file/directory panel. Windows and Linux resolve the
// mixed property set as directory-only, so the renderer offers separate targets there.
const IMPORT_PICKER_DIALOGS: Record<
  ImportPickerTarget,
  {
    titleKey: 'dialogs.importResource' | 'dialogs.importFile' | 'dialogs.importDirectory'
    options: OpenDialogOptions
  }
> = {
  [IMPORT_PICKER_TARGET.RESOURCE]: {
    titleKey: 'dialogs.importResource',
    options: { properties: ['openFile', 'openDirectory', 'multiSelections'] },
  },
  [IMPORT_PICKER_TARGET.FILE]: {
    titleKey: 'dialogs.importFile',
    options: { properties: ['openFile', 'multiSelections'] },
  },
  [IMPORT_PICKER_TARGET.DIRECTORY]: {
    titleKey: 'dialogs.importDirectory',
    options: { properties: ['openDirectory', 'multiSelections'] },
  },
}
const isShoot = process.argv.includes('--shoot')
const isModeCheck = process.argv.includes('--mode-check')
const sayIdx = process.argv.indexOf('--say')
const sayMessage = sayIdx >= 0 ? process.argv[sayIdx + 1] : null
const driveIdx = process.argv.indexOf('--drive')
const driveDir = driveIdx >= 0 ? process.argv[driveIdx + 1] : null
// MVP 0.2 工作台产品流程验收: 在真实渲染进程里点真实 DOM, 每步回读后端核对落盘。
const isWorkbenchCheck = process.argv.includes('--workbench-check')
const packageCheckIndex = process.argv.indexOf('--package-check')
const packageCheckResult = packageCheckIndex >= 0 ? process.argv[packageCheckIndex + 1] : null
const headless =
  isShoot ||
  isModeCheck ||
  Boolean(sayMessage) ||
  Boolean(driveDir) ||
  isWorkbenchCheck ||
  Boolean(packageCheckResult)
let apiBase = DEFAULT_API_BASE
let assetServer: AssetServer | null = null
let rendererBase = ''
let launchAccountBase = ''
let windowServices: BrowserWindow | null = null
let startupFinalized = false
const startupState = new StartupState((snapshot) => sendToMainWindow(STARTUP_CHANNEL, snapshot))
let backendManaged = false
let mainRendererOrigin: string | null = null
let mainRendererNavigationEpoch = 0
let appQuitting = false
let startupFailureReports = 0
let startupAdmissionResolved = process.platform !== MACOS_PLATFORM || !app.isPackaged
let backendRestartAttempts = 0
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null
let backendStart: Promise<boolean> | null = null
let lastBackendPort: number | undefined
let ipcHandlersRegistered = false
let requestOfficeFontAccess: (() => Promise<boolean>) | null = null
let updateInstallationInProgress = false
let updateRestartRequested = false
// 进行中安装的取消信号与拦截起点（bug 87253073）：遮罩的「取消安装」靠它 abort 准备链，
// before-quit 的拦截靠它算已拦截时长、到上限放行。
let updateInstallAbort: AbortController | null = null
let updateInstallBlockingSince: number | null = null
let updateSnapshot: UpdateSnapshot | null = null
let macStartupDecision: updater.MacStartupAdmission | undefined
let pendingUpdateLaunch: ReturnType<typeof observeUpdateLaunch> = null
let previewPolicyChanging = false
// 弹窗收起确认。主进程是唯一权威：渲染层 origin 含后端随机端口，写在那边的确认跨不了重启。
let updateAnnouncedKey: string | null = null
let refreshNamespace = 'distribution'
// 深链早于主窗口到达（macOS open-url 冷启动）时暂存，createWindow 后消费。
let pendingProtocolUrl: string | null = null
// 首页认领闸：本进程内首页一旦被关闭（登录采纳成功或显式跳过）就不再弹；在此之前
// 渲染层每次挂载都能认领 —— dev 链路上 Vite 依赖优化会在启动后整页 reload 一次，
// 「每进程只认领一次」会被那次 reload 吃掉，用户只看到 401 失败屏而不是首页。
let landingResolved = false
const pathAuthorizer = new PathAuthorizer()
const allowedOpenWithApps = new Set<string>()

const logBuffer: string[] = []
let stdoutUnavailable = false

function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    BROKEN_STREAM_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code))
  )
}

// Electron can be launched by a shell or a test runner whose stdout pipe closes
// before the app and its backend do. Logging must never take down the main process.
process.stdout.on('error', (error) => {
  if (isBrokenPipe(error)) stdoutUnavailable = true
})
process.stderr.on('error', (error) => {
  if (isBrokenPipe(error)) stdoutUnavailable = true
})

function writeStdout(line: string): void {
  if (stdoutUnavailable || process.stdout.destroyed || !process.stdout.writable) return
  try {
    process.stdout.write(line, (error) => {
      if (error && isBrokenPipe(error)) stdoutUnavailable = true
    })
  } catch (error) {
    if (isBrokenPipe(error)) stdoutUnavailable = true
  }
}

function pushLog(line: string): void {
  logBuffer.push(line)
  while (logBuffer.length > 800) logBuffer.shift()
  writeStdout(line)
  sendToMainWindow('scholarseed:backend-log', line)
}

function handleFeedbackShortcut(event: Electron.Event, input: Electron.Input): void {
  const window = aliveMainWindow()
  if (!window || !window.isFocused() || !matchesFeedbackShortcut(input, process.platform)) return
  event.preventDefault()
  window.webContents.send(FEEDBACK_SHORTCUT_CHANNEL)
}

function aliveMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null
  return mainWindow
}

function sendToMainWindow(channel: string, ...args: unknown[]): boolean {
  const win = aliveMainWindow()
  if (!win) return false
  win.webContents.send(channel, ...args)
  return true
}

function isMainWindowSender(
  sender: Electron.WebContents,
  senderFrame?: Electron.WebFrameMain | null
): boolean {
  const win = aliveMainWindow()
  if (!win || sender !== win.webContents) return false
  return senderFrame === undefined || senderFrame === win.webContents.mainFrame
}

function logWindowLifecycle(line: string): void {
  windowLifecycleLog ??= new RotatingFileLog(
    join(desktopHome(), LOGS_DIRNAME, WINDOW_LIFECYCLE_LOG_FILENAME),
    { acquireWriter: () => desktopDirectoryWriter(join(desktopHome(), LOGS_DIRNAME)) }
  )
  windowDiagnostics ??= new DiagnosticLog(windowLifecycleLog, (entry) =>
    writeBackendDiagnostic(backend, entry)
  )
  windowDiagnostics.write(`${new Date().toISOString()} pid=${process.pid} ${line}`)
  pushLog(line)
}

function logPreferenceDiagnostic(line: string): void {
  console.info(line)
  logWindowLifecycle(`${line}\n`)
}

function configureCredentialProvider(profile: CredentialProfile, sessionData: string): void {
  refreshNamespace = profile.refreshNamespace
  app.setPath('sessionData', sessionData)
  if (profile.keyProvider === 'mock_keychain') {
    app.commandLine.appendSwitch(MOCK_KEYCHAIN_SWITCH)
    pushLog('[shell] local credential profile enabled without macOS Keychain access\n')
    return
  }
  if (app.commandLine.hasSwitch(MOCK_KEYCHAIN_SWITCH)) {
    throw new Error('distribution credential profile rejects use-mock-keychain')
  }
}

/**
 * 把主进程持有的弹窗收起确认盖到快照上。
 *
 * 每个出口都要过这一道：部分发布点是新构造的对象而不是展开当前快照，漏盖就等于把用户
 * 的确认丢掉，「更新内容」弹窗下次启动会重新自动弹。
 */
function withAnnouncedKey(snapshot: UpdateSnapshot): UpdateSnapshot {
  return updateAnnouncedKey ? { ...snapshot, announcedKey: updateAnnouncedKey } : snapshot
}

const preparationPolicy = backgroundPreparationPolicy(process.platform)
let latestUpdateCandidate: LatestVersionMeta | null = null
let lastPreparationDeferral: string | null = null

function publishUpdateSnapshot(next: UpdateSnapshot): UpdateSnapshot {
  const stamped = withAnnouncedKey({
    ...next,
    latestCandidate:
      preparationPolicy &&
      next.candidate &&
      latestUpdateCandidate &&
      isNewerRelease(
        { version: next.candidate.version, buildNumber: next.candidate.build_number },
        { version: latestUpdateCandidate.version, buildNumber: latestUpdateCandidate.build_number }
      ) === true
        ? latestUpdateCandidate
        : undefined,
    restartPending: updateInstallAbort !== null && !updateInstallAbort.signal.aborted,
  })
  updateSnapshot = stamped
  sendToMainWindow('scholarseed:update-state', stamped)
  return stamped
}

// 安装进行中标记的唯一写入口：同时维护 before-quit 拦截的起点时刻。拦截不设上限就会把
// 用户锁死在应用里（bug 87253073），起点时刻是上限判定的唯一依据，不能和标记分开写。
function setUpdateInstallationInProgress(active: boolean): void {
  updateInstallationInProgress = active
  updateInstallBlockingSince = active ? (updateInstallBlockingSince ?? Date.now()) : null
}

// 下载与安装两段共用同一个进度出口：把进度并进权威快照后广播。渲染层只读快照，
// 不再另开一条并行的进度通道 —— 两个通道必然各说一套。
function publishUpdateProgress(progress: UpdateProgress): void {
  if (progress.phase === 'installing') setUpdateInstallationInProgress(true)
  publishUpdateSnapshot({
    ...currentUpdateSnapshot(),
    phase: progress.phase,
    percent: progress.percent,
    receivedBytes: progress.receivedBytes,
    installStage: progress.install_stage,
    installation: progress.installation,
    error: undefined,
    errorFallback: undefined,
    errorOrigin: undefined,
    resumable: undefined,
  })
}

function currentUpdateSnapshot(): UpdateSnapshot {
  if (!updateSnapshot) {
    updateAnnouncedKey = updater.readAnnouncedKey()
    updateSnapshot = withAnnouncedKey(
      updater.updateLaneUnsupported(pushLog)
        ? {
            phase: 'unsupported',
            currentVersion: app.getVersion(),
            reason: LOCAL_LANE_UPDATE_REASON,
          }
        : process.platform === WINDOWS_PLATFORM
          ? { phase: 'idle', currentVersion: app.getVersion() }
          : updater.initialUpdateSnapshot(pushLog, macStartupDecision)
    )
  }
  return updateSnapshot
}

// Candidate replacement stays active during download/preparation. Once installation
// owns the staged application, later publications belong to the next update.
const updateChecks = new UpdateChecks(async () => {
  const result = await updater.checkForUpdate(pushLog)
  if (
    result.previewRevision !== undefined &&
    updater.isCurrentPreviewResult(result) &&
    !previewPolicyChanging &&
    !updateInstallAbort &&
    !updateRestartRequested &&
    !updateInstallationInProgress &&
    !macMaintenanceUncertain &&
    !updater.macHandoffCommitted() &&
    currentUpdateSnapshot().errorFallback !== 'activation_recovery_required'
  ) {
    const candidate = currentUpdateSnapshot().candidate
    if (
      !result.has_update ||
      (candidate &&
        (!updater.previewCandidateAllowed(candidate, pushLog) ||
          (result.latest &&
            candidate.id !== result.latest.id &&
            isNewerRelease(
              { version: candidate.version, buildNumber: candidate.build_number },
              { version: result.latest.version, buildNumber: result.latest.build_number }
            ) !== true)))
    ) {
      previewPolicyChanging = true
      try {
        await resetPreviewCandidates()
      } finally {
        previewPolicyChanging = false
      }
    }
  }
  return result
})
const PREPARATION_RETRY_DELAY_MS = 60_000
let nextPreparationRetryAt = 0
let windowsPrepared: { candidate: LatestVersionMeta; update: PreparedWindowsVelopack } | null = null
let windowsUpdateMaintenanceActive = false

function requirePreviewSender(event: Electron.IpcMainInvokeEvent): void {
  if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame))
    throw new Error('Invalid preview policy sender')
}

function requirePreviewPolicyChange(): void {
  requireDesktopWorkbench()
  if (!updater.previewUpdatesEnabled(pushLog))
    throw new Error('Preview update controls are unavailable')
  if (
    previewPolicyChanging ||
    updateInstallAbort ||
    updateInstallationInProgress ||
    updateRestartRequested ||
    macMaintenanceUncertain ||
    updater.macHandoffCommitted() ||
    currentUpdateSnapshot().errorFallback === 'activation_recovery_required'
  )
    throw new Error('Update installation is busy')
}

async function resetPreviewCandidates(): Promise<void> {
  await updatePreparation.reset()
  if (windowsPrepared) await windowsPrepared.update.close()
  windowsPrepared = null
  updater.discardPreviewPreparation(pushLog)
  latestUpdateCandidate = null
  lastPreparationDeferral = null
  nextPreparationRetryAt = 0
  publishUpdateSnapshot({ phase: 'idle', currentVersion: app.getVersion() })
}

async function changePreviewPolicy(next: PreviewUpdatePolicy): Promise<PreviewUpdatePolicy> {
  requirePreviewPolicyChange()
  previewPolicyChanging = true
  try {
    // Persist intent before draining old work. A crash can never restore its old permission.
    updater.writePreviewUpdatePolicy(next, pushLog)
    updateChecks.invalidate()
    await resetPreviewCandidates()
    if (next.target) {
      try {
        await updater.validatePreviewCandidate(next.target, pushLog)
      } catch (error) {
        updater.writePreviewUpdatePolicy({ scope: next.scope }, pushLog)
        throw error
      }
    }
  } finally {
    previewPolicyChanging = false
    armBackgroundUpdateCheck()
  }
  if (next.target) {
    publishUpdateSnapshot({
      phase: 'available',
      currentVersion: app.getVersion(),
      candidate: next.target,
    })
    updatePreparation.request(next.target)
  } else runBackgroundUpdateCheck()
  return updater.getPreviewUpdatePolicy(pushLog)
}

/** Called only after the installation attempt has released its native/maintenance locks. */
async function recoverUpdateConflict(): Promise<void> {
  updateChecks.invalidate()
  publishUpdateSnapshot({
    phase: 'failed',
    currentVersion: app.getVersion(),
    errorOrigin: 'check',
    errorFallback: 'activation_candidate_changed',
  })
  await updatePreparation.reset()
  windowsPrepared = null
  latestUpdateCandidate = null
  lastPreparationDeferral = null
  nextPreparationRetryAt = 0
  runBackgroundUpdateCheck()
}

function retainedUpdateReady(): ReturnType<typeof updater.readReadyState> {
  const ready = updater.readReadyState()
  return ready &&
    (process.platform !== MACOS_PLATFORM || updater.macPreparationReady(ready.meta)) &&
    updater.previewCandidateValidated(ready.meta, pushLog)
    ? ready
    : null
}

function publishUpdateCheckResult(result: UpdateCheckResult): UpdateSnapshot {
  if (
    previewPolicyChanging ||
    !updateChecks.isCurrent(result) ||
    !updater.isCurrentPreviewResult(result)
  )
    return currentUpdateSnapshot()
  if (!desktopWorkbenchReady()) {
    backgroundUpdateCheckDeferred = true
    return currentUpdateSnapshot()
  }
  const snapshot = currentUpdateSnapshot()
  if (
    updateInstallAbort ||
    updateInstallationInProgress ||
    updateRestartRequested ||
    macMaintenanceUncertain ||
    updater.macHandoffCommitted() ||
    snapshot.phase === 'manual' ||
    snapshot.errorFallback === 'activation_recovery_required'
  )
    return snapshot
  const latest = result.has_update ? result.latest : null
  if (latest) {
    // Installation requires an explicit retry. Periodic checks may discover a
    // newer candidate but must not consume/reprepare this failed handoff.
    if (snapshot.errorOrigin === 'install' && snapshot.candidate?.id === latest.id)
      return publishUpdateSnapshot({
        ...snapshot,
        checkedAt: Date.now(),
        nextBackgroundPreparationAt: undefined,
      })
    const candidate = snapshot.latestCandidate ?? snapshot.candidate
    // A delayed check must never replace a newer in-memory or restored candidate.
    if (
      candidate &&
      candidate.id !== latest.id &&
      isNewerRelease(
        { version: candidate.version, buildNumber: candidate.build_number },
        { version: latest.version, buildNumber: latest.build_number }
      ) !== true
    )
      return snapshot
    if (preparationPolicy) {
      if (snapshot.phase === 'ready' && snapshot.candidate)
        updatePreparation.adopt(snapshot.candidate)
      updatePreparation.observe(latest)
      latestUpdateCandidate = updatePreparation.latest
      const enabled = loadRendererPreferences().autoDownloadUpdates
      const started = updatePreparation.background(enabled)
      const current = currentUpdateSnapshot()
      const nextBackgroundPreparationAt = updatePreparation.nextBackgroundAt
      const decision = updatePreparation.decision(enabled)
      if (!started && !updatePreparation.running) {
        const key = `${latest.id}:${decision.reason}:${nextBackgroundPreparationAt}`
        if (lastPreparationDeferral !== key) {
          lastPreparationDeferral = key
          updater.logUpdateEvent(pushLog, {
            phase: 'preparation',
            event: 'deferred',
            updateId: latest.id,
            result: decision.reason,
            nextAttemptAt: nextBackgroundPreparationAt,
          })
        }
      }
      return publishUpdateSnapshot({
        ...current,
        ...(current.phase === 'ready' || updatePreparation.running
          ? {}
          : {
              phase:
                current.phase === 'failed' && current.candidate?.id === latest.id
                  ? 'failed'
                  : 'available',
              candidate: latest,
            }),
        checkedAt: Date.now(),
        nextBackgroundPreparationAt: decision.at,
      })
    }
    const restoreMacPreparation =
      process.platform === 'darwin' &&
      snapshot.phase === 'ready' &&
      snapshot.candidate?.id === latest.id &&
      !updater.macPreparationReady(latest)
    if (
      !restoreMacPreparation &&
      !loadRendererPreferences().autoDownloadUpdates &&
      !updatePreparation.running &&
      !updateInstallAbort
    ) {
      if (snapshot.phase === 'ready' && snapshot.candidate?.id === latest.id) return snapshot
      return publishUpdateSnapshot({
        phase: 'available',
        currentVersion: app.getVersion(),
        candidate: latest,
        checkedAt: Date.now(),
      })
    }
    if (
      !restoreMacPreparation &&
      snapshot.phase === 'ready' &&
      snapshot.candidate?.id === latest.id
    )
      updatePreparation.adopt(latest)
    updatePreparation.offer(latest)
    if (updatePreparation.candidate?.id === latest.id) {
      updatePreparation.resume()
      if (restoreMacPreparation && !updatePreparation.running) updatePreparation.retry()
    }
    if (
      snapshot.phase === 'failed' &&
      snapshot.candidate?.id === latest.id &&
      Date.now() >= nextPreparationRetryAt
    ) {
      updatePreparation.retry()
    }
    return currentUpdateSnapshot()
  }
  if (snapshot.candidate || updatePreparation.running) return snapshot
  if (result.previewRevision !== undefined && updater.getPreviewUpdatePolicy(pushLog).target)
    return publishUpdateSnapshot({
      phase: 'failed',
      currentVersion: app.getVersion(),
      checkedAt: Date.now(),
      errorOrigin: 'check',
      reason: 'preview-target-unavailable',
    })
  return publishUpdateSnapshot({
    phase: 'up-to-date',
    currentVersion: app.getVersion(),
    checkedAt: Date.now(),
  })
}

function assertWindowsInstallationIdle(): void {
  const native = storageNative as DomainNative & {
    assertUpdateInstallationIdle(root: string, executable: string): void
  }
  const installation = applicationInstallation(app)
  const root = realpathSync.native(installation.root)
  for (const executable of installation.executables) {
    native.assertUpdateInstallationIdle(root, executable)
  }
}

async function installWindowsPreparedUpdate(): Promise<StartUpdateResult> {
  const controller = new AbortController()
  updateInstallAbort = controller
  const receipt = windowsPrepared
  const source = backend
  let maintenance: ReturnType<typeof backendUpdateControl> | null = null
  let generation: string | null = null
  let drained = false
  let maintenanceAttempted = false
  let recoveryFailed = false
  let candidateChanged = false
  let handoffClosed = false
  let preferencesRequested = false
  try {
    if (
      !receipt ||
      currentUpdateSnapshot().candidate?.id !== receipt.candidate.id ||
      desktopHandoff.isBusy()
    )
      throw new Error('Windows update preparation changed')
    await receipt.update.lock(
      [`--user-data-dir=${desktopStorage().userData}`, ...updateDebugArguments(process.argv)],
      controller.signal
    )
    await receipt.update.verify()
    assertWindowsInstallationIdle()
    controller.signal.throwIfAborted()
    // Freeze and persist renderer state while the workbench can still accept writes.
    // before-quit must reuse this receipt after the backend has been drained.
    setUpdateInstallationInProgress(true)
    preferencesRequested = true
    await preferenceQuiescence.prepare(undefined, 'maintenance')
    controller.signal.throwIfAborted()
    if (windowsPrepared !== receipt || backend !== source || desktopHandoff.isBusy())
      throw new Error('Workbench changed while saving preferences for Windows update')
    maintenance = backendUpdateControl(source)
    windowsUpdateMaintenanceActive = true
    clearBackendRestart()
    maintenanceAttempted = true
    generation = await maintenance.prepareUpdate()
    controller.signal.throwIfAborted()
    if (windowsPrepared !== receipt || backend !== source || desktopHandoff.isBusy())
      throw new Error('Workbench changed before Windows update')
    publishUpdateSnapshot({
      ...currentUpdateSnapshot(),
      phase: 'installing',
      installStage: 'preparing',
    })
    const stopped = await drainManagedBackend()
    drained = true
    requireCleanBackendStop(stopped)
    await receipt.update.verify()
    assertWindowsInstallationIdle()
    controller.signal.throwIfAborted()
    await receipt.update.apply(async () => {
      controller.signal.throwIfAborted()
      assertWindowsInstallationIdle()
      const authorize = await updater.authorizeActivation(
        receipt.candidate,
        pushLog,
        controller.signal
      )
      return () => {
        controller.signal.throwIfAborted()
        if (windowsPrepared !== receipt || backend !== null || desktopHandoff.isBusy())
          throw new Error('Workbench changed before Windows update')
        assertWindowsInstallationIdle()
        authorize()
      }
    })
    windowsPrepared = null
    updateRestartRequested = true
    publishUpdateSnapshot({
      ...currentUpdateSnapshot(),
      phase: 'restarting',
      installStage: 'restarting',
    })
    appQuitting = true
    app.quit()
    return { ok: true, mode: 'auto' }
  } catch (error) {
    pushLog(`[update] Windows handoff failed: ${String(error)}\n`)
    // Release the uncommitted helper (including an elevated worker) before recovery.
    try {
      await receipt?.update.close()
      // lock() can fail before its transfer handle is assigned. An empty close
      // cannot confirm the exit of the coordinator reported by that failure.
      handoffClosed = !(error instanceof WindowsHandoffExitUnconfirmed)
      if (!handoffClosed) recoveryFailed = true
    } catch (recovery) {
      pushLog(`[update] handoff cleanup failed: ${String(recovery)}\n`)
      recoveryFailed = true
    }
    candidateChanged = error instanceof updater.ActivationCandidateChanged
    if (candidateChanged && receipt) {
      try {
        updater.discardRejectedUpdate(receipt.candidate, pushLog)
      } catch (recovery) {
        recoveryFailed = true
        pushLog(`[update] candidate revocation failed: ${String(recovery)}\n`)
      }
    }
    try {
      if (!handoffClosed)
        throw new Error('Windows handoff cleanup is unconfirmed', { cause: error })
      if (maintenanceAttempted && !generation && !(error instanceof BackendMaintenanceRejected)) {
        // A lost preparation response cannot be resumed by guessing its generation.
        // Stop this owned family, then restart the same installed application.
        await drainManagedBackend()
        drained = true
      } else if (source?.stopping && !drained) {
        // Product storage cleanup can fail after process exit. Independently join
        // the process-family barrier before considering a same-version restart.
        await stopBackend(source)
        if (backend === source) backend = null
        drained = true
      }
      if (drained) {
        windowsUpdateMaintenanceActive = false
        backendManaged = true
        const pending = startManagedBackend(source?.port)
        const recoveryGeneration = startupState.snapshot().generation
        const expectedBackend = backend
        if (!(await pending)) {
          backendManaged = false
          throw new Error('Runtime restart failed', { cause: error })
        }
        const win = aliveMainWindow()
        if (!win || !currentStartup(recoveryGeneration, expectedBackend, win))
          throw new Error('Workbench changed during update recovery')
        await initializeWindowServices(
          win,
          process.env.ELECTRON_RENDERER_URL || rendererBase + ROOT_ROUTE,
          process.env.ELECTRON_RENDERER_URL,
          browserStorageWindowGeneration
        )
        if (!currentStartup(recoveryGeneration, expectedBackend, win))
          throw new Error('Workbench changed during update recovery')
        startupState.complete(recoveryGeneration, apiBase)
        finalizeStartup('')
      } else if (generation && maintenance && source && !source.stopping) {
        await maintenance.resume(generation)
      } else if (source?.stopping) {
        throw new Error('Runtime exit is not confirmed', { cause: error })
      }
    } catch (recovery) {
      recoveryFailed = true
      pushLog(`[update] runtime recovery failed: ${String(recovery)}\n`)
    }
    const errorFallback = recoveryFailed
      ? 'activation_recovery_required'
      : candidateChanged
        ? 'activation_candidate_changed'
        : installationFailure(error)
    const result: StartUpdateResult =
      controller.signal.aborted || error instanceof WindowsHandoffCancelled
        ? { ok: false, cancelled: true }
        : errorFallback
          ? { ok: false, errorFallback }
          : { ok: false, error: String(error) }
    publishUpdateSnapshot({
      ...currentUpdateSnapshot(),
      phase: recoveryFailed || candidateChanged ? 'failed' : 'ready',
      ...(candidateChanged ? { candidate: undefined, latestCandidate: undefined } : {}),
      error: errorFallback ? undefined : String(error),
      errorOrigin: 'install',
      installStage: undefined,
      errorFallback,
    })
    return result
  } finally {
    updateInstallAbort = null
    if (!updateRestartRequested) {
      windowsUpdateMaintenanceActive = recoveryFailed
      setUpdateInstallationInProgress(false)
      if (!recoveryFailed) {
        if (preferencesRequested) preferenceQuiescence.resume()
        updatePreparation.release()
        if (candidateChanged) await recoverUpdateConflict()
      }
      publishUpdateSnapshot(currentUpdateSnapshot())
    }
  }
}

const updatePreparation = new UpdatePreparation(
  async (attempt) => {
    requireDesktopWorkbench()
    const { candidate, signal, isCurrent } = attempt
    const updateId = `${candidate.id}-${attempt.generation}`
    const record = (event: string, result?: string): void =>
      updater.logUpdateEvent(pushLog, {
        phase: 'preparation',
        event,
        result,
        updateId,
        generation: attempt.generation,
        fromVersion: `${app.getVersion()}-${updater.resolveDesktopConfig(pushLog).buildNumber}`,
        toVersion: `${candidate.version}-${candidate.build_number}`,
      })
    record('start')
    updater.logUpdateEvent(pushLog, {
      phase: 'preparation',
      event: 'origin',
      result: attempt.origin,
      updateId,
    })
    if (!preparationPolicy) nextPreparationRetryAt = Date.now() + PREPARATION_RETRY_DELAY_MS
    let errorOrigin: 'download' | 'preparation' = 'download'
    const progress = (next: UpdateProgress): void => {
      if (next.phase === 'preparing') errorOrigin = 'preparation'
      if (isCurrent()) publishUpdateProgress(next)
    }
    try {
      await updater.validatePreviewCandidate(candidate, pushLog, signal)
      if (!isCurrent()) return false
      if (process.platform === WINDOWS_PLATFORM) {
        windowsPrepared = null
        const config = resolveProductConfig(pushLog)
        publishUpdateSnapshot({ phase: 'downloading', currentVersion: app.getVersion(), candidate })
        const update = await prepareWindowsVelopack({
          baseUrl: `${config.updateBaseUrl}/api/v1/updates/packages/${encodeURIComponent(candidate.id)}/velopack`,
          componentBaseUrl: config.updateBaseUrl,
          native: storageNative,
          candidate,
          keys: config.updatePackageKeys ?? {},
          appId: config.productId,
          diagnosticFile: join(desktopHome(), LOGS_DIRNAME, NATIVE_UPDATE_LOG_FILE),
          signal,
          onProgress: (percent) => progress({ phase: 'downloading', percent }),
        })
        if (!isCurrent()) return false
        windowsPrepared = { candidate, update }
        record('finish', 'velopack-prepared')
        publishUpdateSnapshot({
          phase: 'ready',
          currentVersion: app.getVersion(),
          candidate,
          percent: 100,
        })
        runBackgroundUpdateCheck()
        return true
      }
      if (!preparationPolicy) updater.supersedeStagedUpdate(candidate, pushLog)
      publishUpdateSnapshot({ phase: 'downloading', currentVersion: app.getVersion(), candidate })
      const staged = await updater.stageUpdate(candidate.id, progress, pushLog, signal)
      if (!isCurrent()) {
        record('finish', 'interrupted')
        return false
      }
      if (!staged.ok) {
        record('finish', 'failed')
        const retained = preparationPolicy ? retainedUpdateReady() : null
        publishUpdateSnapshot({
          ...currentUpdateSnapshot(),
          phase: retained ? 'ready' : 'failed',
          candidate: retained?.meta ?? candidate,
          error: staged.error,
          errorFallback: staged.errorFallback,
          errorOrigin: staged.errorOrigin,
          resumable: staged.resumable,
        })
        return false
      }
      record('finish', 'ready')
      publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: 'ready',
        candidate: staged.ready.meta,
        percent: 100,
        receivedBytes: staged.ready.meta.file_size,
        error: undefined,
        errorFallback: undefined,
        installation: undefined,
      })
      runBackgroundUpdateCheck()
      return true
    } catch (error) {
      record('finish', isCurrent() ? 'failed' : 'interrupted')
      if (isCurrent()) {
        const retained = preparationPolicy ? retainedUpdateReady() : null
        publishUpdateSnapshot({
          ...currentUpdateSnapshot(),
          phase: retained ? 'ready' : 'failed',
          candidate: retained?.meta ?? candidate,
          error: String(error),
          errorFallback: undefined,
          errorOrigin,
        })
      }
      return false
    }
  },
  {
    load: () => {
      const checkpoint = updater.readPreparationCheckpoint()
      try {
        return checkpoint &&
          updater.previewUpdatesEnabled(pushLog) &&
          !updater.previewCandidateAllowed(checkpoint.desiredRelease, pushLog)
          ? null
          : checkpoint
      } catch (error) {
        // A damaged preview record blocks updates, never application startup.
        pushLog(`[update] preview preparation restore unavailable: ${String(error)}\n`)
        return null
      }
    },
    save: updater.writePreparationCheckpoint,
    failed: (error) => {
      pushLog(`[update] preparation checkpoint failed: ${String(error)}\n`)
      const retained = preparationPolicy ? retainedUpdateReady() : null
      publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: retained ? 'ready' : 'failed',
        candidate: retained?.meta ?? currentUpdateSnapshot().candidate,
        error: String(error),
        errorFallback: undefined,
        errorOrigin: 'preparation',
      })
    },
  },
  preparationPolicy,
  Date.now,
  Math.random,
  () => queueMicrotask(armBackgroundUpdateCheck)
)

function reportStartupFailure(title: string, message: string): void {
  pushLog(`[shell] ${title}: ${message}\n`)
  if (headless) {
    void finishApplicationShutdown().then(
      () => app.exit(1),
      (error: unknown) => {
        pushLog(`[startup] failed to drain headless runtime: ${String(error)}\n`)
        app.exit(1)
      }
    )
    return
  }
  if (appQuitting) return
  startupFailureReports += 1
  void app
    .whenReady()
    .then(async () => {
      if (headless || appQuitting || preferenceQuiescence.isPreparing()) return
      if (startupScreen?.isClosing()) await closeStartupScreen()
      if (!windowPresentationAllowed()) return
      const parent = aliveMainWindow()
      if (!startupScreen && parent?.isVisible() && !parent.isMinimized()) {
        await dialog.showMessageBox(parent, { type: 'error', title, message })
        return
      }
      try {
        mainLocalization()
      } catch {
        await applyMainLanguage(DEFAULT_LANGUAGE)
      }
      if (!windowPresentationAllowed()) return
      openStartupScreen()
      if (!startupScreen?.fail(title, message)) {
        await closeStartupScreen()
        if (!windowPresentationAllowed()) return
        openStartupScreen()
        startupScreen?.fail(title, message)
      }
    })
    .catch((error: unknown) => {
      pushLog(`[startup] failure surface unavailable: ${String(error)}\n`)
      app.exit(1)
    })
    .finally(() => {
      startupFailureReports -= 1
    })
}

function openStartupScreen(): void {
  if (!windowPresentationAllowed() || startupScreen) return
  startupScreen = showStartupScreen(
    () => {
      if (startupScreenStartedAt !== null) {
        pushLog(
          `[startup] electron startup screen visible elapsedMs=${Date.now() - startupScreenStartedAt}\n`
        )
      }
    },
    () => {
      runtimePreparation?.abort()
      app.quit()
    },
    (line) => {
      if (windowLifecycleLog) logWindowLifecycle(line)
      else pushLog(line)
    },
    windowPresentationAllowed
  )
  startupScreenStartedAt = Date.now()
  pushLog('[startup] electron startup screen created\n')
}

function setStartupStatus(status: string, fraction?: number): void {
  startupScreen?.setStatus(status, fraction)
}

async function closeStartupScreen(): Promise<void> {
  const current = startupScreen
  if (startupScreenStartedAt !== null) {
    pushLog(
      `[startup] electron startup screen closing elapsedMs=${Date.now() - startupScreenStartedAt}\n`
    )
    startupScreenStartedAt = null
  }
  await current?.close()
  if (startupScreen === current) startupScreen = null
}

async function revealStartupWorkbench(
  window: BrowserWindow,
  usable: () => boolean = () => true
): Promise<boolean> {
  if (
    !usable() ||
    !windowPresentationAllowed() ||
    startupFailureReports > 0 ||
    window.isDestroyed() ||
    startupScreen?.failed()
  )
    return false
  await closeStartupScreen()
  if (
    !usable() ||
    !windowPresentationAllowed() ||
    startupFailureReports > 0 ||
    window.isDestroyed() ||
    startupScreen
  )
    return false
  setLoginWindowVisible?.flush()
  window.show()
  deliverAttentionActivation()
  return true
}

function windowPresentationAllowed(): boolean {
  return (
    !headless && !appQuitting && !preferenceQuiescence.isPreparing() && !startupScreen?.isClosing()
  )
}

function clearBackendRestart(): void {
  if (backendRestartTimer != null) clearTimeout(backendRestartTimer)
  backendRestartTimer = null
}

let finalShutdown: Promise<BackendStopResult> | null = null
const preferenceQuiescence = new PreferenceQuiescence((request) => {
  sendToMainWindow(PREFERENCE_SHUTDOWN_CHANNEL.request, request)
})
let backendQuitFinished = false
let macMaintenanceUncertain = false
let macUpdateMaintenanceActive = false
let developmentControl: Awaited<ReturnType<typeof startDevelopmentControl>> = null

async function connectDevelopmentControl(): Promise<void> {
  let source: typeof backend = null
  let maintenance: ReturnType<typeof backendUpdateControl> | null = null
  developmentControl = await startDevelopmentControl({
    enabled:
      !app.isPackaged &&
      !headless &&
      Boolean(process.env.ELECTRON_RENDERER_URL) &&
      process.argv.includes(DEVELOPMENT_CONTROL_ARGUMENT),
    input: process.stdin,
    timeoutMs: DEVELOPMENT_CONTROL_TIMEOUT_MS,
    quiesceIfIdle: async () => {
      if (
        !backend ||
        appQuitting ||
        desktopHandoff.isBusy() ||
        updateInstallationInProgress ||
        windowsUpdateMaintenanceActive ||
        macUpdateMaintenanceActive
      )
        return null
      const current = backend
      const control = backendUpdateControl(current)
      let generation: string
      try {
        generation = await control.quiesceIfIdle()
      } catch (error) {
        if (error instanceof BackendMaintenanceRejected) return null
        throw error
      }
      try {
        await preferenceQuiescence.prepare()
      } catch {
        await control.resume(generation)
        preferenceQuiescence.resume()
        return null
      }
      if (backend !== current) throw new Error('development backend changed during maintenance')
      source = current
      maintenance = control
      return generation
    },
    resume: async (generation) => {
      if (!maintenance || backend !== source) throw new Error('development maintenance unavailable')
      await maintenance.resume(generation)
      preferenceQuiescence.resume()
      source = null
      maintenance = null
    },
    prepareExit: async () => {
      if (!maintenance || backend !== source) throw new Error('development maintenance unavailable')
      requireCleanBackendStop(await finishApplicationShutdown())
    },
    exit: () => app.quit(),
  })
  if (developmentControl) pushLog('[dev] private development control connected\n')
}

async function finishApplicationShutdown(): Promise<BackendStopResult> {
  if (finalShutdown) return finalShutdown
  appQuitting = true
  browserVaultIpc?.lock()
  browserVault?.lock()
  finalShutdown = drainManagedBackend()
    .then(async (result) => {
      await assetServer?.close()
      backendQuitFinished = true
      return result
    })
    .catch((error) => {
      finalShutdown = null
      throw error
    })
  return finalShutdown
}

async function stopManagedBackend(): Promise<void> {
  await preferenceQuiescence.prepare()
  requireCleanBackendStop(await drainManagedBackend())
}

async function drainManagedBackend(): Promise<BackendStopResult> {
  browserStorage?.revoke()
  const retiringGrants = browserGrants
  browserGrants?.revokeAll()
  revokeAgentBrowserLeases()
  browserGrantScopeSubscription?.()
  browserGrantScopeSubscription = null
  backendManaged = false
  clearBackendRestart()
  const current = backend
  if (current) {
    logWindowLifecycle(
      `[shell] backend stop requested pid=${current.proc?.pid ?? null} port=${current.port} quitting=${appQuitting} installing=${updateInstallationInProgress} restarting=${updateRestartRequested}\n`
    )
  }
  const result = await stopBackend(current)
  if (appQuitting) {
    browserStorage?.close()
    await browserHost?.dispose()
  }
  const storageResults = await Promise.allSettled(
    [...browserStorageOwners].map((owner) => owner.drain())
  )
  const storageFailures = storageResults.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (storageFailures.length)
    throw new AggregateError(
      storageFailures.map((result) => result.reason),
      'Browser storage did not drain'
    )
  for (const owner of browserStorageOwners)
    if (owner !== browserStorage) browserStorageOwners.delete(owner)
  retiringGrants?.retireTransport()
  if (backend === current) backend = null
  return result
}

function restartDelayMs(attempt: number): number {
  return Math.min(BACKEND_RESTART_BASE_DELAY_MS * 2 ** attempt, BACKEND_RESTART_MAX_DELAY_MS)
}

function superviseBackend(handle: BackendHandle): void {
  void handle.exited.then((exit) => {
    if (handle.stopping || !backendManaged || appQuitting || backend !== handle) return
    browserStorage?.revoke()
    const retiringGrants = browserGrants
    browserGrants?.revokeAll()
    browserHost?.historyAgent.revokeAll()
    revokeAgentBrowserLeases()
    browserGrantScopeSubscription?.()
    browserGrantScopeSubscription = null
    backend = null
    startupState.begin()
    lastBackendPort = handle.port
    logWindowLifecycle(
      `[shell] backend stopped unexpectedly pid=${handle.proc?.pid ?? null} port=${handle.port} code=${exit.code} signal=${exit.signal}; draining before recovery\n`
    )
    if (process.platform !== WINDOWS_PLATFORM) {
      void (handle.agentTransport?.close() ?? Promise.resolve()).then(() => {
        retiringGrants?.retireTransport()
      })
      scheduleBackendRestart(handle.port)
      return
    }
    void stopBackend(handle)
      .then(() => {
        retiringGrants?.retireTransport()
        scheduleBackendRestart(handle.port)
      })
      .catch((error: unknown) => {
        logWindowLifecycle(
          `[shell] runtime family drain failed; recovery withheld: ${String(error)}\n`
        )
        reportStartupFailure(startupFailureTitle(), String(error))
      })
  })
}

let preparedToolPrincipal: string | undefined

async function prepareManagedRuntime(onReused: () => void): Promise<boolean> {
  if (process.platform !== WINDOWS_PLATFORM || !app.isPackaged) {
    onReused()
    return true
  }
  const application = dirname(applicationResources(app))
  const config = resolveProductConfig(pushLog)
  const t = mainLocalization().getFixedT(null, 'native')
  runtimePreparation = new AbortController()
  let preparedComponents = false
  try {
    for (;;) {
      const timing = new ComponentTimer(
        { kind: COMPONENT_TIMING.runtime, version: app.getVersion() },
        COMPONENT_TIMING.startup,
        logWindowLifecycle
      )
      try {
        let end = timing.start(COMPONENT_TIMING.inspect)
        preparedToolPrincipal = await inspectWindowsRuntime(
          application,
          logWindowLifecycle,
          runtimePreparation.signal
        )
        end()
        if (preparedToolPrincipal) {
          timing.finish(false)
          if (!preparedComponents) onReused()
          break
        }
        preparedComponents = true
        end = timing.start(COMPONENT_TIMING.manifest)
        const manifest = await installedRuntimeManifest(
          application,
          config.updatePackageKeys ?? {},
          config
        )
        end()
        end = timing.start(COMPONENT_TIMING.download)
        await downloadRuntimeComponents({
          log: logWindowLifecycle,
          root: dirname(application),
          native: storageNative,
          baseUrl: config.updateBaseUrl,
          manifest,
          signal: runtimePreparation.signal,
          onProgress: (state) =>
            setStartupStatus(
              state.phase === 'downloading'
                ? t('startup.componentDownloading', {
                    name: state.kind,
                    percent: Math.floor((state.received / state.total) * 100),
                  })
                : t('startup.componentChecking', { name: state.kind }),
              state.phase === 'downloading' && state.total > 0
                ? state.received / state.total
                : undefined
            ),
        })
        end()
        setStartupStatus(t('startup.stages.components'))
        end = timing.start(COMPONENT_TIMING.helper)
        preparedToolPrincipal = await prepareWindowsRuntime(
          application,
          logWindowLifecycle,
          runtimePreparation.signal,
          (progress) => {
            const options = {
              name: progress.kind,
              count: progress.files,
              total: progress.totalFiles,
              percent:
                progress.totalBytes > 0
                  ? Math.floor((progress.bytes / progress.totalBytes) * 100)
                  : 0,
            }
            setStartupStatus(
              progress.phase === 'extracting'
                ? t('startup.componentExtracting', options)
                : progress.phase === 'publishing'
                  ? t('startup.componentPublishing', options)
                  : progress.phase === 'complete' || progress.phase === 'reused'
                    ? t('startup.componentReady', options)
                    : t('startup.componentChecking', options),
              progress.phase === 'extracting' && progress.totalBytes > 0
                ? progress.bytes / progress.totalBytes
                : undefined
            )
          }
        )
        end()
        timing.finish(false)
        break
      } catch (error) {
        timing.finish(true)
        pushLog(`[runtime] component preparation failed: ${String(error)}\n`)
        if (runtimePreparation.signal.aborted || appQuitting) return false
        if (headless) throw error
        const result = await dialog.showMessageBox({
          type: 'error',
          title: t('startup.title'),
          message: t('startup.componentFailed'),
          detail: String(error),
          buttons: [t('startup.retry'), t('startup.exit')],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        if (result.response !== 0) {
          app.quit()
          return false
        }
      }
    }
  } catch (error) {
    reportStartupFailure(t('startup.title'), `${t('startup.componentFailed')}\n${String(error)}`)
    return false
  } finally {
    runtimePreparation = null
  }
  if (appQuitting) return false
  if (assetServer) {
    const officeRoot = bundledWindowsRuntime(dirname(applicationResources(app))).office
    await assetServer.setOfficeRoot(officeRoot)
  }
  return true
}

async function startPreparedBackend(onReused: () => void = () => {}): Promise<boolean> {
  const generation = startupState.begin()
  const timing = new ComponentTimer(
    { kind: COMPONENT_TIMING.desktop, version: app.getVersion() },
    COMPONENT_TIMING.startup,
    logWindowLifecycle
  )
  let ready = false
  try {
    let end = timing.start(COMPONENT_TIMING.runtimePreparation)
    if (!(await prepareManagedRuntime(onReused))) {
      startupState.fail(generation, 'startupFailed', false)
      return false
    }
    end()
    end = timing.start(COMPONENT_TIMING.backendReady)
    ready = await startManagedBackend(undefined, generation)
    if (ready) end()
    return ready
  } catch (error) {
    startupState.fail(generation, 'startupFailed', false)
    pushLog(`[shell] runtime preparation failed: ${String(error)}\n`)
    return false
  } finally {
    timing.finish(!ready)
  }
}

async function startManagedBackend(
  preferredPort?: number,
  preparedGeneration?: number
): Promise<boolean> {
  if (appQuitting) return false
  if (macUpdateMaintenanceActive || windowsUpdateMaintenanceActive || updater.macHandoffCommitted())
    return false
  if (backendStart) return backendStart
  lastBackendFailure = null
  const generation = preparedGeneration ?? startupState.begin()
  const historyOwner = {}
  const next = startBackend(pushLog, {
    defaultProjectName: mainLocalization().t('project:defaultName'),
    ...(preferredPort == null ? {} : { port: preferredPort }),
    testHarness: headless,
    toolPrincipal: preparedToolPrincipal,
    accountBaseUrl: launchAccountBase,
    lifecycleLog: logWindowLifecycle,
    browserList: () => {
      if (!browserPolicy?.agentUseEnabled()) throw new Error('browser_agent_use_disabled')
      return (browserHost?.snapshot().tabs ?? []).map((tab) => ({
        tab_id: tab.tabId,
        origin: (() => {
          try {
            return new URL(tab.url).origin
          } catch {
            return ''
          }
        })(),
        title: tab.title.slice(0, 256),
      }))
    },
    browserListAuthority: () => browserPolicy?.agentUseRevision() ?? null,
    browserSearchAction: (input) => {
      if (!browserHost || !browserGrants || !browserAgentController)
        return Promise.reject(new Error('browser_unavailable'))
      return runBrowserSearch(input, {
        registry: browserHost.search,
        grants: browserGrants,
        controller: browserAgentController,
        enabled: () => browserPolicy?.agentUseEnabled() === true,
        onStage: (stage, tabId) =>
          pushLog(
            `[browser-search] ${JSON.stringify({
              requestId: input.requestId,
              sessionId: input.scope.sessionId,
              tabId,
              stage,
            })}\n`
          ),
        onFailure: (stage, code, tabId) =>
          pushLog(
            `[browser-search] failed ${JSON.stringify({
              requestId: input.requestId,
              sessionId: input.scope.sessionId,
              tabId,
              stage,
              code,
            })}\n`
          ),
      })
    },
    browserPrepareRead: (input) => {
      if (!browserGrants) throw new Error('browser_grant_unavailable')
      return browserGrants.prepareRead({
        sessionId: input.scope.sessionId,
        turnId: input.scope.turnId,
        requestId: input.requestId,
        tabId: input.tabId,
        intent: input.intent,
      })
    },
    browserReadActions: {
      snapshot: async (input) => {
        const grants = browserGrants
        const controller = browserAgentController
        if (!grants || !controller) throw new Error('browser_unavailable')
        const onAbort = (): void => {
          grants.cancelSnapshot(input.grantRequestId)
          controller.revoke(input.tabId)
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        try {
          const authority = await grants.acquireSnapshot({
            scope: input.scope,
            requestId: input.grantRequestId,
            proofId: input.proofId,
            tabId: input.tabId,
          })
          if (input.signal.aborted) throw new Error('request_expired')
          const snapshot = await controller.snapshot(authority)
          if (input.signal.aborted) throw new Error('request_expired')
          grants.finishSnapshot(authority, snapshot.snapshotId)
          return snapshot
        } catch (error) {
          grants.cancelSnapshot(input.grantRequestId)
          controller.revoke(input.tabId)
          throw error
        } finally {
          input.signal.removeEventListener('abort', onAbort)
        }
      },
      read: async (input) => {
        const grants = browserGrants
        const controller = browserAgentController
        if (!grants || !controller) throw new Error('browser_unavailable')
        const authority = grants.readAuthority({
          scope: input.scope,
          tabId: input.tabId,
          snapshotId: input.snapshotId,
        })
        const onAbort = (): void => {
          grants.cancelSnapshot(authority.grantRequestId)
          controller.revoke(input.tabId)
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (input.signal.aborted) throw new Error('request_expired')
          const element = await controller.read({
            ...authority,
            snapshotId: input.snapshotId,
            elementRef: input.elementRef,
          })
          if (input.signal.aborted) throw new Error('request_expired')
          return element
        } finally {
          input.signal.removeEventListener('abort', onAbort)
        }
      },
      cancel: (input) => {
        const grants = browserGrants
        if (!grants) throw new Error('browser_unavailable')
        if (
          grants.cancelRead({
            scope: input.scope,
            requestId: input.grantRequestId,
            tabId: input.tabId,
          })
        ) {
          browserAgentController?.revoke(input.tabId)
        }
      },
    },
    browserNavigateActions: {
      close: (input) => {
        const host = browserHost
        if (!host || input.signal.aborted || !browserPolicy?.agentUseEnabled())
          throw new Error('browser_unavailable')
        host.agent.closeAgentTarget(input.scope.sessionId, input.tabId)
      },
      open: async (input) => {
        const host = browserHost
        if (!host || input.signal.aborted || !browserPolicy?.agentUseEnabled())
          throw new Error('browser_unavailable')
        const target = await host.agent.createAgentTarget(input.scope.sessionId)
        if (input.signal.aborted || browserHost !== host || !browserPolicy?.agentUseEnabled()) {
          target.close()
          throw new Error('browser_unavailable')
        }
        return target
      },
      prepare: (input) => {
        const grants = browserGrants
        const controller = browserAgentController
        if (!grants || !controller || !browserPolicy?.agentUseEnabled())
          throw new Error('browser_unavailable')
        const proof = grants.prepareNavigate({
          sessionId: input.scope.sessionId,
          turnId: input.scope.turnId,
          requestId: input.requestId,
          tabId: input.tabId,
          url: input.url,
          intent: input.intent,
        })
        try {
          controller.prepareNavigate(proof)
        } catch (error) {
          grants.cancelNavigate({
            scope: input.scope,
            requestId: input.requestId,
            tabId: input.tabId,
          })
          throw error
        }
        return proof
      },
      execute: async (input) => {
        const grants = browserGrants
        const controller = browserAgentController
        if (!grants || !controller || !browserPolicy?.agentUseEnabled())
          throw new Error('browser_unavailable')
        const onAbort = (): void => {
          try {
            const revokedTabId = grants.cancelNavigate({
              scope: input.scope,
              requestId: input.grantRequestId,
              tabId: input.tabId,
            })
            if (revokedTabId) controller.cancelNavigate(input.grantRequestId, revokedTabId)
          } catch {}
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (input.signal.aborted) throw new Error('request_expired')
          const grant = await grants
            .acquireNavigate({
              scope: input.scope,
              requestId: input.grantRequestId,
              proofId: input.proofId,
              tabId: input.tabId,
            })
            .catch((error) => {
              pushLog(
                `[browser-navigation] acquire failed request=${input.requestId} error=${error instanceof Error ? error.message : 'unknown'}\n`
              )
              throw error
            })
          if (input.signal.aborted || !browserPolicy?.agentUseEnabled())
            throw new Error('request_expired')
          await controller.executeNavigate(grant).catch((error) => {
            pushLog(
              `[browser-navigation] execute failed request=${input.requestId} error=${error instanceof Error ? error.message : 'unknown'}\n`
            )
            throw error
          })
          if (input.signal.aborted) throw new Error('request_expired')
          const host = browserHost
          if (host && host.snapshot().activeTabId !== input.tabId) return
          const page = await host?.ui.page({ kind: 'target', tabId: input.tabId })
          if (input.signal.aborted || browserHost !== host || !browserPolicy?.agentUseEnabled())
            throw new Error('request_expired')
          if (page?.ok)
            sendToMainWindow(BROWSER_REVEAL_CHANNEL, {
              sessionId: input.scope.sessionId,
              target: page.target,
            })
        } finally {
          input.signal.removeEventListener('abort', onAbort)
        }
      },
      cancel: (input) => {
        const revokedTabId = browserGrants?.cancelNavigate({
          scope: input.scope,
          requestId: input.grantRequestId,
          tabId: input.tabId,
        })
        if (revokedTabId) browserAgentController?.cancelNavigate(input.grantRequestId, revokedTabId)
      },
    },
    browserActionActions: {
      captureLifecycle: () => {
        const owner = browserAgentController
        return () => owner !== null && owner === browserAgentController && owner.isAvailable()
      },
      prepare: async (input) => {
        const controller = browserAgentController
        const grants = browserGrants
        if (!controller || !grants || !browserPolicy?.agentUseEnabled())
          throw new Error('browser_action_unavailable')
        let proof: ReturnType<typeof controller.prepareAction> | null = null
        let stage = 'prepare'
        try {
          if (input.readGrant) {
            stage = 'acquire-read'
            const authority = await grants.acquireSnapshot({
              scope: input.scope,
              requestId: input.readGrant.requestId,
              proofId: input.readGrant.proofId,
              tabId: input.tabId,
            })
            if (
              controller !== browserAgentController ||
              grants !== browserGrants ||
              input.signal.aborted
            )
              throw new Error('stale_grant')
            stage = 'revalidate-observation'
            proof = await controller.prepareObservedAction({ ...input, ...authority })
            if (
              controller !== browserAgentController ||
              grants !== browserGrants ||
              input.signal.aborted
            )
              throw new Error('stale_grant')
            stage = 'bind-observation'
            grants.finishActionObservation(authority, input.snapshotId)
          } else proof = controller.prepareAction(input)
          stage = 'extend-grant'
          grants.extendActionLease(
            {
              scope: proof.scope,
              tabId: proof.tabId,
              grantId: proof.grantId,
              grantRequestId: proof.grantRequestId,
              grantRevision: proof.grantRevision,
            },
            proof.snapshotId,
            proof.expiresAt
          )
          stage = 'extend-action'
          controller.extendActionLease(proof.requestId, proof.proofId)
          return proof
        } catch (error) {
          console.info(
            '[browser-agent] action preparation failed',
            JSON.stringify({
              stage,
              code: agentFailureCode(error),
              errorType:
                error instanceof TypeError
                  ? 'type'
                  : error instanceof ReferenceError
                    ? 'reference'
                    : 'operation',
            })
          )
          if (proof) controller.cancelAction(proof.requestId, proof.tabId)
          if (input.readGrant) grants.cancelSnapshot(input.readGrant.requestId)
          throw error
        }
      },
      execute: async (input) => {
        const controller = browserAgentController
        if (!controller || !browserPolicy?.agentUseEnabled())
          throw new Error('browser_action_unavailable')
        const onAbort = (): void => {
          controller.revoke(input.tabId)
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (input.signal.aborted) throw new Error('request_expired')
          await controller.executeApprovedAction({
            scope: input.scope,
            requestId: input.grantRequestId,
            proofId: input.proofId,
            tabId: input.tabId,
          })
          if (input.signal.aborted) throw new Error('action_outcome_unknown')
        } finally {
          input.signal.removeEventListener('abort', onAbort)
        }
      },
      cancel: (input) => {
        browserAgentController?.cancelAction(input.grantRequestId, input.tabId)
      },
      waitForEffects: (scope, signal) => {
        if (!browserAgentController) throw new Error('browser_unavailable')
        return browserAgentController.waitForEffects(scope, signal)
      },
    },
    browserHistoryActions: {
      prepare: (input) => {
        const authority = browserHost?.historyAgent
        if (!authority) throw new Error('browser_unavailable')
        return authority.prepare(input)
      },
      execute: (input) => {
        const authority = browserHost?.historyAgent
        if (!authority) throw new Error('browser_unavailable')
        authority.watchOwner(historyOwner, next.exited)
        return authority.execute({
          scope: input.scope,
          requestId: input.grantRequestId,
          proofId: input.proofId,
          owner: historyOwner,
          signal: input.signal,
        })
      },
      cancel: (input) => {
        browserHost?.historyAgent.cancel({
          scope: input.scope,
          requestId: input.grantRequestId,
          proofId: input.proofId,
        })
      },
      complete: (input) => {
        const authority = browserHost?.historyAgent
        if (!authority) throw new Error('browser_unavailable')
        authority.complete({
          scope: input.scope,
          requestId: input.grantRequestId,
          proofId: input.proofId,
        })
      },
      waitForLeases: (scope, signal) =>
        browserHost?.historyAgent.waitForLeases(scope, signal) ?? Promise.resolve(),
    },
  })
  backend = next
  const start = (async (): Promise<boolean> => {
    let ready = false
    try {
      ready = await next.ready
    } catch (e) {
      next.error = { kind: 'startupFailed', detail: String(e) }
    }
    if (appQuitting || next.stopping || backend !== next) return false
    if (!ready) {
      lastBackendFailure = next.error
      logWindowLifecycle(
        `[shell] backend startup failed pid=${next.proc?.pid ?? null} port=${next.port} failure=${next.error?.kind ?? null}\n`
      )
      await stopBackend(next)
      if (backend === next) backend = null
      startupState.fail(generation, next.error?.kind ?? 'startupFailed')
      return false
    }
    apiBase = next.baseUrl || apiBase
    bindBrowserGrantScope()
    await browserHost?.setApiBase(apiBase)
    lastBackendPort = next.port
    logWindowLifecycle(`[shell] backend ready pid=${next.proc?.pid ?? null} port=${next.port}\n`)
    superviseBackend(next)
    if (backend === next && !next.stopping && !appQuitting) void browserStorage?.activate()
    return true
  })()
  backendStart = start
  try {
    return await start
  } finally {
    if (backendStart === start) backendStart = null
  }
}

function bindBrowserGrantScope(): void {
  browserGrantScopeSubscription?.()
  browserGrantScopeSubscription =
    backend?.agentTransport?.onScopeEnd((scope) => {
      browserGrants?.revokeScope(scope)
      browserHost?.historyAgent.revokeScope(scope)
      revokeAgentBrowserLeases(scope)
    }) ?? null
}

function revokeAgentBrowserLeases(scope?: BrowserReadScope): void {
  for (const tab of browserHost?.snapshot().tabs ?? [])
    browserAgentController?.revoke(tab.tabId, scope)
}

function scheduleBackendRestart(previousPort?: number): void {
  if (macUpdateMaintenanceActive || windowsUpdateMaintenanceActive || updater.macHandoffCommitted())
    return
  if (!backendManaged || appQuitting || backendRestartTimer != null) return
  const attempt = backendRestartAttempts
  const delay = restartDelayMs(attempt)
  const reusePort = attempt < BACKEND_PORT_REUSE_ATTEMPTS ? previousPort : undefined
  backendRestartAttempts += 1
  logWindowLifecycle(
    `[shell] backend recovery attempt ${backendRestartAttempts} in ${delay}ms${reusePort ? ` (reuse port ${reusePort})` : ''}\n`
  )
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null
    void (async () => {
      const pending = startManagedBackend(reusePort)
      const generation = startupState.snapshot().generation
      const expectedBackend = backend
      const ready = await pending
      if (!ready) {
        logWindowLifecycle('[shell] backend recovery failed\n')
        scheduleBackendRestart(previousPort)
        return
      }
      const win = aliveMainWindow()
      if (win && currentStartup(generation, expectedBackend, win)) {
        await initializeWindowServices(
          win,
          process.env.ELECTRON_RENDERER_URL || rendererBase + ROOT_ROUTE,
          process.env.ELECTRON_RENDERER_URL,
          browserStorageWindowGeneration
        )
        if (!currentStartup(generation, expectedBackend, win)) return
        startupState.complete(generation, apiBase)
        finalizeStartup('')
      }
      backendRestartAttempts = 0
      logWindowLifecycle(
        `[shell] backend recovered pid=${backend?.proc?.pid ?? null} port=${backend?.port ?? null}\n`
      )
    })().catch((error: unknown) => {
      logWindowLifecycle(`[shell] backend recovery failed: ${String(error)}\n`)
      reportStartupFailure(startupFailureTitle(), String(error))
    })
  }, delay)
}

async function ensureBackendForWindow(): Promise<boolean> {
  if (!backendManaged || backend) return true
  clearBackendRestart()
  const ready = await startManagedBackend(lastBackendPort)
  if (!ready) scheduleBackendRestart(lastBackendPort)
  return ready
}

const configuredWorkspace = process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV]
if (configuredWorkspace) pathAuthorizer.add('workspace', configuredWorkspace)

function pathAuthorizerForApplication(path: string): string {
  return realpathSync.native(resolve(path))
}

// ---------------------------------------------------------------------------
// 凭据 cookie 与设备身份
// ---------------------------------------------------------------------------

const AUTH_STATUS_REQUEST_TIMEOUT_MS = 5000
const AUTH_COOKIE_NAME = 'scholarseed_token'
const AUTH_COOKIE_TTL_SECONDS = 30 * 24 * 3600
// 采纳结果回报（proposal 73 §6.3）：把最后一公里也变成网页可见。用刚换到的 access
// token 做 Bearer，所以 exchange 失败的两类根本回报不了 —— 那两种情况下没有 token。
// 终结型交接失败时主进程主动把首页推回渲染层。认领原本是 pull-only（渲染层挂载时拉
// 一次），而失败发生时渲染层早就挂载完了，不会再拉一次 —— 所以需要这条推送边。
const LANDING_REOPEN_CHANNEL = 'scholarseed:landing-reopen'
// 本机协调的进程实例 id（proposal 74 §7.4）。刻意不用 pid：pid 会被复用，重启后的新
// 进程可能拿到同一个 pid，从而意外接管前身的 claim —— 那恰好违反「重启后重新登录」。
const HANDOFF_INSTANCE_ID = randomUUID()
// 设备身份落产品家目录: 账号服务的设备列表/远程登出靠这个 id 认机器, 所以它必须
// 跳重启稳定 (不能每次启动新生一个, 否则后台设备列表会无限膨胀)。

function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const isLocalhost = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    return u.protocol === 'https:' || (u.protocol === 'http:' && !isLocalhost)
  } catch {
    return false
  }
}

function revealMainWindow(reason: string): boolean {
  if (!windowPresentationAllowed() || startupFailureReports > 0) return false
  if (startupScreen?.failed()) {
    startupScreen.reveal()
    return false
  }
  if (startupScreen && startupState.snapshot().phase !== STARTUP_PHASE.failed) {
    logWindowLifecycle(`[shell] reveal deferred until startup completes; ${reason}\n`)
    return false
  }
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    logWindowLifecycle(`[shell] reveal unavailable; ${reason}\n`)
    return false
  }
  mainWindowHiding?.cancel()
  setLoginWindowVisible?.flush()
  logWindowLifecycle(
    `[shell] reveal window=${win.id} visible=${win.isVisible()} minimized=${win.isMinimized()} enabled=${win.isEnabled()}; ${reason}\n`
  )
  if (win.isMinimized()) win.restore()
  win.show()
  if (process.platform === MACOS_PLATFORM) app.focus({ steal: true })
  win.focus()
  logWindowLifecycle(
    `[shell] main window shown visible=${win.isVisible()} focused=${win.isFocused()}; ${reason}\n`
  )
  return true
}

function activateAttention(id: string): void {
  pendingAttentionId = id
  revealMainWindow('notification activation')
  deliverAttentionActivation()
}

function deliverAttentionActivation(): void {
  const window = aliveMainWindow()
  if (!attentionRendererReady || !window || !pendingAttentionId) return
  if (!revealMainWindow('notification route ready')) return
  const id = pendingAttentionId
  pendingAttentionId = null
  window.webContents.send(ATTENTION_CLICK_CHANNEL, id)
  pushLog(`[attention] id=${id} activated\n`)
}

// A shared session cookie authenticates both renderer fetch and EventSource,
// which cannot supply an Authorization header.
async function setAuthCookie(win: BrowserWindow, token: string): Promise<void> {
  const url = apiBase + ROOT_ROUTE
  if (!token) {
    await win.webContents.session.cookies.remove(url, AUTH_COOKIE_NAME)
    return
  }
  await win.webContents.session.cookies.set({
    url,
    name: AUTH_COOKIE_NAME,
    value: token,
    path: ROOT_ROUTE,
    httpOnly: true,
    // dev 期 renderer 在 Vite 源 (localhost:5173)、后端在 127.0.0.1:<port>: 不同主机即
    // 跨站。SameSite=Lax 只放行顶层导航, 不会跟着 XHR/SSE 发出去 —— 表现成「登录
    // 看上去成功进了主页, 但每个数据请求都 401」这种最难查的假成功。
    // SameSite=None 必须配 Secure; localhost/127.0.0.1 是 Chromium 认定的可信源,
    // http 下也接受 Secure cookie。
    sameSite: 'no_restriction',
    secure: true,
    expirationDate: Date.now() / 1000 + AUTH_COOKIE_TTL_SECONDS,
  })
}

async function readAuthCookie(win: BrowserWindow): Promise<string> {
  const found = await win.webContents.session.cookies.get({ name: AUTH_COOKIE_NAME })
  return found.length > 0 ? found[0].value : ''
}

// ---------------------------------------------------------------------------
// 双 token 续期 — access 快到期时拿 safeStorage 里的 refresh 静默换新（轮转）。
// ---------------------------------------------------------------------------

/** 账号服务地址从 serve 的 /api/auth/status 取（与渲染层同源，不自带配置）。 */
async function accountBaseUrlFromServe(signal?: AbortSignal): Promise<string> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), AUTH_STATUS_REQUEST_TIMEOUT_MS)
  try {
    const r = await fetch(`${apiBase}/api/auth/status`, {
      signal: signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal,
    })
    const status = (await r.json()) as { account_base_url?: string }
    return String(status.account_base_url || '').replace(/\/+$/, '')
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

// 单飞闸: 启动触发与每小时定时可能撞在一起, 并发轮转会让第二个请求出示已轮转的
// 旧 refresh, 被服务端判成重放把整个会话族掐断 —— 用户会因为自己的客户端打架被登出。
let refreshInflight: Promise<void> | null = null
let refreshTimerRegistered = false

function ensureFreshAuth(): void {
  // Token rotation changes both remote and local credentials. Native candidates
  // must first commit their current workbench; a timer cannot start this write
  // during warmup or inherit readiness from an earlier backend/document.
  if (!desktopWorkbenchReady()) return
  if (refreshInflight) return
  refreshInflight = (async () => {
    try {
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      const access = await readAuthCookie(win)
      if (!access) return
      const exp = accessExpSeconds(access)
      // Tokens without a JWT expiry do not participate in account refresh.
      if (exp == null) return
      if (exp - Date.now() / 1000 > REFRESH_AHEAD_SECONDS) return
      const refreshToken = loadRefreshToken(refreshNamespace)
      // 存量单 token 登录没有 refresh 文件: 续不了, 到期重登一次即进入新体系
      if (!refreshToken) return
      const accountBase = await accountBaseUrlFromServe()
      if (!accountBase) return
      const outcome = await refreshTokens(accountBase, refreshToken)
      if (outcome.ok) {
        await setAuthCookie(win, outcome.data.token)
        saveRefreshToken(outcome.data.refresh_token, refreshNamespace, pushLog)
        pushLog('[shell] access token renewed via refresh rotation\n')
      } else if (outcome.rejected) {
        // 服务端明确拒绝 = 族已不可信（吊销/重放/超出宽限期的旧 refresh）: 清凭据。
        // 登录不是门禁, 清完不会把用户踢去登录页 —— 应用退回未登录态, 界面上的身份
        // 随随后的 401 清空, 要登录由用户自己从账户菜单打开。
        // 网络抖动（rejected=false）不清, 等下个检查周期重试 —— 服务端有宽限窗口，
        // 「上次轮转成功但响应丢了」这种重试会被判成重试而不是重放。
        saveRefreshToken('', refreshNamespace, pushLog)
        await setAuthCookie(win, '')
        pushLog(`[shell] token refresh rejected (${outcome.error}); credentials cleared\n`)
      } else {
        pushLog(`[shell] token refresh deferred (${outcome.error})\n`)
      }
    } catch (e) {
      pushLog(`[shell] WARN token refresh error: ${String(e)}\n`)
    } finally {
      refreshInflight = null
    }
  })()
}

function registerRefreshTimer(): void {
  if (refreshTimerRegistered) return
  refreshTimerRegistered = true
  setInterval(() => ensureFreshAuth(), REFRESH_CHECK_INTERVAL_MS)
}

/** 登出后台腿: 通知账号服务吊销整族。永不 await —— 本地凭据已经清掉, 这一步失败
 *  只意味着服务端那条族要等 refresh 自然过期, 不该让用户为它等一次网络超时。 */
async function revokeFamilyInBackground(refreshToken: string): Promise<void> {
  try {
    const accountBase = await accountBaseUrlFromServe()
    if (!accountBase) return
    await revokeRefreshFamily(accountBase, refreshToken)
    pushLog('[shell] refresh family revoked on account service\n')
  } catch (e) {
    pushLog(`[shell] WARN remote logout failed: ${String(e)}\n`)
  }
}

/** 读/建设备身份 (账号服务的登录上报用它填 devices 表)。 */
function resolveDeviceInfo(): { device_id: string; device_label: string } {
  const home = desktopHome()
  return resolveDeviceIdentity(home, `${osPlatform()} ${hostname()}`, {
    beforeCreate: requireDesktopWorkbench,
    acquireWriter: () => desktopDirectoryWriter(home),
    log: pushLog,
  })
}

// 拦截主窗口跳向外链：在系统浏览器打开，避免渲染层离开本机应用。
function installExternalNavigationGuard(win: BrowserWindow): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (isExternalUrl(url)) {
      event.preventDefault()
      pushLog(`[shell] intercepted external navigation, opening in browser: ${url}\n`)
      shell.openExternal(url)
    }
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
}

// ---------------------------------------------------------------------------
// 桌面登录交接 — 官网浏览器登录 + scholarseed:// 深链一次性 code 交换
// ---------------------------------------------------------------------------

/** 凭据采纳的单一实现：access 写窗口 session cookie（fetch 与 SSE 共用），refresh 交
 *  safeStorage 加密落盘供续期。应用内登录（veda:auth-token-set）与深链交接共用它 ——
 *  两处各写一份存储就会出现「一条登录线续不上期」的漂移。空 token = 登出语义。 */
async function adoptAuthTokens(
  win: BrowserWindow,
  token: string,
  refreshToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    requireDesktopWorkbench()
    const stored = token ? '' : loadRefreshToken(refreshNamespace)
    // 登出: 本地凭据先清干净再通知服务端吊销整族。反过来写的话, 账号服务不可达时
    // 用户点「退出登录」要干等十几秒 (两段 HTTP 超时), 期间进程被杀则本地凭据根本
    // 没清掉 —— 而整族吊销只需要上面已经读出的那个 refresh 值, 与清理顺序无关。
    saveRefreshToken(token ? refreshToken : '', refreshNamespace, pushLog)
    desktopReminders?.identityChanged()
    await setAuthCookie(win, token)
    if (token) desktopReminders?.synchronize()
    if (stored) void revokeFamilyInBackground(stored)
    // 首页只在 renderer 验通本地会话并回执后关闭；写入凭据不等于登录成功。
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 采纳结果回报（proposal 73 §6.3）。

只有 renderer 验证本地会话通过后才回报 adopted。网页在 consumed 阶段继续等待；
回报失败不能推翻本地验证结果，网页等待超时后提示检查客户端。 */
async function reportHandoffOutcome(
  state: string,
  outcome: AdoptOutcome,
  token: string,
  isCurrent: () => boolean
): Promise<void> {
  await reportReceipt(state, outcome, token, isCurrent, {
    base: accountBaseUrlFromServe,
    request: fetch,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: logWindowLifecycle,
  })
}

/** 终结型交接失败驱动的首页重新认领（proposal 73 §6.4）。

首页被关掉之后 failed 本来无处可见，用户只能对着一个没有任何错误的界面猜。可重试型
不弹 —— 那种情况成功页再点一次真能救回来，弹首页只会打断它。

复位 `landingResolved` 是必须的：它是单向布尔闸（采纳成功或显式跳过后置位），原本
没有复位入口，所以本进程内首页一旦关掉就再也不弹。 */
function reopenLandingForFailure(error?: string): void {
  if (headless) return
  landingResolved = false
  const win = aliveMainWindow()
  if (!win) return
  revealMainWindow('desktop handoff failed')
  win.webContents.send(LANDING_REOPEN_CHANNEL, { error: error || '' })
}

function publishDesktopAuth(snapshot: DesktopAuthSnapshot): void {
  sendToMainWindow('scholarseed:desktop-auth', snapshot)
  // 顺序要紧：先把快照（带错误码）送到渲染层，再让它开首页，否则首页开出来时还没有
  // 错误可显示。
  if (snapshot.phase === 'failed' && snapshot.terminal) reopenLandingForFailure(snapshot.error)
}

const desktopHandoff = new DesktopHandoff({
  onLoginStarted: () => updateInstallAbort?.abort(),
  log: logWindowLifecycle,
  accountBaseUrl: accountBaseUrlFromServe,
  deviceFields: resolveDeviceInfo,
  adoptTokens: async (token, refreshToken) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return false
    return (await adoptAuthTokens(win, token, refreshToken)).ok
  },
  publish: publishDesktopAuth,
  revealWindow: (reason) => revealMainWindow(reason),
  openExternal: (url) => shell.openExternal(url),
  // 87515374：orphaned/失败相位落身份账（实例 id / app 路径 / home），下次同类反馈能直接
  // 判定「哪份副本、哪个 home 收到深链」。SCHOLARSEED_PROTOCOL 在闭包调用时才求值，
  // 不受其 const 声明位置（文件后部）的 TDZ 影响。
  identity: () => `instance=${HANDOFF_INSTANCE_ID} app=${app.getAppPath()} home=${desktopHome()}`,
  isDefaultProtocolHandler: () => app.isDefaultProtocolClient(SCHOLARSEED_PROTOCOL),
  // 本机协调腿（proposal 74）。宿主头在这里拼好整张表传进去，于是 handoff-local.ts
  // 不必认识头名、也就不必 import 带 electron 的 backend.ts —— 那条链要被 node --test
  // 直接加载，正是 handoff-url.ts 当初被拆出来的同一个理由。
  local: createHandoffCoordinator({
    log: pushLog,
    baseUrl: () => apiBase,
    instanceId: HANDOFF_INSTANCE_ID,
    hostHeaders: () => ({ [HOST_PROCESS_HEADER]: backendHostProcessKey() }),
  }),
  reportOutcome: reportHandoffOutcome,
})

/** 首页被关闭（跳过或登录采纳）后，本进程内不再重新认领。 */
function dismissLanding(): void {
  landingResolved = true
}

const workbenchHealth = new WorkbenchHealth()
let backgroundUpdateCheckDeferred = false

function desktopWorkbenchReady(): boolean {
  // Velopack has no health-commit gate. A same-version runtime restart must not
  // wait for a renderer receipt that was already sent for this document.
  return (
    process.platform !== WINDOWS_PLATFORM ||
    Boolean(
      backendManaged &&
      backend &&
      !backend.stopping &&
      !backend.error &&
      backend.proc &&
      backend.proc.exitCode === null &&
      backend.proc.signalCode === null
    )
  )
}

function workbenchObservation(event: Electron.IpcMainInvokeEvent) {
  const sender = event.sender
  const frame = event.senderFrame
  const currentBackend = backend
  const isCurrent = () =>
    !!frame &&
    isMainWindowSender(sender, frame) &&
    !sender.isLoadingMainFrame() &&
    backendManaged &&
    backend === currentBackend &&
    !!currentBackend &&
    !appQuitting &&
    !currentBackend.stopping &&
    !currentBackend.error &&
    !!currentBackend.proc &&
    currentBackend.proc.exitCode === null &&
    currentBackend.proc.signalCode === null &&
    !currentBackend.proc.killed
  return { currentBackend, isCurrent }
}

function requireDesktopWorkbench(): void {
  if (!desktopWorkbenchReady()) {
    throw new Error('ERR_WORKBENCH_NOT_READY')
  }
}

function deliverDesktopCallback(url: string): void {
  if (!aliveMainWindow() || !desktopWorkbenchReady()) {
    pendingProtocolUrl = url
    return
  }
  void desktopHandoff.handleCallback(url)
}

function registerIpcHandlers(developerToolsEnabled: boolean): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true
  const pluginRevisions = new Map<string, number>()
  const plugins = createPluginHost()
  const feedbackConfig = resolveProductConfig(pushLog)
  const feedbackSubmission = new FeedbackSubmissionService({
    baseUrl: feedbackConfig.feedbackBaseUrl,
    accountBaseUrl: resolveStartupAccountBase(pushLog),
    version: clientVersion(app.getVersion(), feedbackConfig.buildNumber),
    platform: process.platform,
    arch: process.arch,
    readToken: async () => {
      const window = aliveMainWindow()
      return window ? readAuthCookie(window) : ''
    },
    isCurrent: () => Boolean(aliveMainWindow()) && !appQuitting,
    sourceBaseline,
    hostDiagnostics: () => logBuffer.join(''),
    fetch,
    collectBundle: async (request, token) => {
      await updater.syncMacUpdateDiagnostics(pushLog).catch(() => undefined)
      const response = await fetch(apiBase + FEEDBACK_BUNDLE_PATH, {
        method: 'POST',
        body: feedbackSubmissionForm(request, false),
        redirect: 'error',
        signal: AbortSignal.timeout(FEEDBACK_LIMITS.collectionTimeoutMs),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/zip'))
        throw new Error('feedback_collection_unavailable')
      return feedbackResponseBytes(response, FEEDBACK_LIMITS.bundleBytes)
    },
  })
  ipcMain.handle(FEEDBACK_SUBMIT_CHANNEL, async (event, request: unknown) => {
    const window = aliveMainWindow()
    const frame = event.senderFrame
    if (!window || !frame || !isMainWindowSender(event.sender, frame))
      return { ok: false, code: 'invalid_sender' }
    let current = true
    const invalidate = () => {
      current = false
    }
    window.webContents.once('did-start-navigation', invalidate)
    try {
      const result = await feedbackSubmission.submit(
        request,
        () => current && !appQuitting && isMainWindowSender(event.sender, frame)
      )
      pushLog(
        `[feedback] transport=main status=${result.ok ? 'submitted' : result.code} ticket=${result.id ?? ''} diagnostics=${result.diagnostics ?? ''}\n`
      )
      return result
    } finally {
      if (!window.webContents.isDestroyed())
        window.webContents.removeListener('did-start-navigation', invalidate)
    }
  })
  registerBrowserIpc(ipcMain, {
    enabled: () => resolveProductConfig(pushLog).features.browser,

    contents: () => mainWindow?.webContents ?? null,
    rendererOrigin: () => mainRendererOrigin,
    policy: () => browserPolicy,
    host: () => browserHost,
    saveAutomationEnabled: (enabled) => {
      saveBrowserAutomationPreference(enabled)
    },
  })
  registerBrowserApprovalIpc(ipcMain, {
    enabled: () => resolveProductConfig(pushLog).features.browser,

    contents: () => mainWindow?.webContents ?? null,
    rendererOrigin: () => mainRendererOrigin,
    rendererNavigationEpoch: () => mainRendererNavigationEpoch,
    backendBase: () => (backendManaged ? apiBase : null),
    browserTarget: (tabId) => browserHost?.agent.agentTarget(tabId) ?? null,
    browserNavigateTarget: (tabId) => {
      try {
        return browserHost?.agent.agentNavigationTarget(tabId) ?? null
      } catch {
        return null
      }
    },
    activeScope: (sessionId, turnId) =>
      backend?.agentTransport?.activeScope(sessionId, turnId) ?? null,
    readProof: (requestId, proofId) => {
      if (!browserGrants) throw new Error('browser_grant_unavailable')
      return browserGrants.readProof(requestId, proofId)
    },
    grantRead: (request) => {
      if (!browserGrants) throw new Error('browser_grant_unavailable')
      browserGrants.issueApproved({
        sessionId: request.sessionId,
        turnId: request.turnId,
        requestId: request.requestId,
        proofId: request.proofId,
        tabId: request.tabId,
        origin: request.origin,
        targetInstanceId: request.targetInstanceId,
        targetGeneration: request.targetGeneration,
        intent: request.intent,
        expiresAt: request.expiresAt,
      })
    },
    navigateProof: (requestId, proofId) => {
      if (!browserGrants) throw new Error('browser_grant_unavailable')
      return browserGrants.navigateProof(requestId, proofId)
    },
    grantNavigate: (request) => {
      if (
        !browserGrants ||
        request.action !== 'navigate' ||
        request.destinationUrl === undefined ||
        request.destinationOrigin === undefined ||
        request.sourceOrigin === undefined
      )
        throw new Error('browser_grant_unavailable')
      browserGrants.issueNavigateApproved({
        sessionId: request.sessionId,
        turnId: request.turnId,
        requestId: request.requestId,
        proofId: request.proofId,
        tabId: request.tabId,
        sourceInstanceId: request.targetInstanceId,
        sourceGeneration: request.targetGeneration,
        sourceOrigin: request.sourceOrigin,
        url: request.destinationUrl,
        destinationOrigin: request.destinationOrigin,
        intent: request.intent,
        expiresAt: request.expiresAt,
      })
    },
    actionProof: (requestId, proofId) => {
      if (!browserAgentController) throw new Error('browser_action_unavailable')
      return browserAgentController.actionProof(requestId, proofId)
    },
    grantAction: (request) => {
      if (!browserAgentController || !browserPolicy?.agentUseEnabled())
        throw new Error('browser_action_unavailable')
      browserAgentController.approveAction(request.requestId, request.proofId)
    },
    hostHeader: () => ({ [HOST_PROCESS_HEADER]: backendHostProcessKey() }),
    fetch: (url, init) => {
      const win = mainWindow
      if (!win || win.isDestroyed()) throw new Error('Browser approval window unavailable')
      return win.webContents.session.fetch(url, init)
    },
  })
  registerBrowserHistoryApprovalIpc(ipcMain, {
    enabled: () => resolveProductConfig(pushLog).features.browser,

    contents: () => mainWindow?.webContents ?? null,
    rendererOrigin: () => mainRendererOrigin,
    rendererNavigationEpoch: () => mainRendererNavigationEpoch,
    backendBase: () => (backendManaged ? apiBase : null),
    activeScope: (sessionId, turnId) =>
      backend?.agentTransport?.activeScope(sessionId, turnId) ?? null,
    historyProof: (requestId, proofId) => {
      const authority = browserHost?.historyAgent
      if (!authority) throw new Error('browser_unavailable')
      return authority.proof(requestId, proofId)
    },
    grantHistory: (request, scope) => {
      const authority = browserHost?.historyAgent
      if (!authority) throw new Error('browser_unavailable')
      authority.grant({
        scope,
        requestId: request.requestId,
        proofId: request.proofId,
        queryDigest: request.queryDigest,
        historyRevision: request.historyRevision,
        expiresAt: request.expiresAt,
      })
    },
    hostHeader: () => ({ [HOST_PROCESS_HEADER]: backendHostProcessKey() }),
    fetch: (url, init) => {
      const win = mainWindow
      if (!win || win.isDestroyed()) throw new Error('Browser approval window unavailable')
      return win.webContents.session.fetch(url, init)
    },
  })
  ipcMain.handle(WINDOW_CLOSE_REQUEST_CHANNEL, (event) => {
    const win = aliveMainWindow()
    if (!win || !isMainWindowSender(event.sender)) return null
    return windowController.currentRequest(win)
  })
  ipcMain.handle(WINDOW_CLOSE_REPLY_CHANNEL, (event, reply: unknown) => {
    const win = aliveMainWindow()
    if (!win || !isMainWindowSender(event.sender)) return false
    return windowController.respond(win, reply)
  })
  ipcMain.handle(TRAY_CHANNEL.reply, (event, reply: unknown) => {
    const win = aliveMainWindow()
    if (!win || !isMainWindowSender(event.sender, event.senderFrame)) return false
    return windowController.respondTray(win, reply)
  })
  ipcMain.handle(LOGIN_WINDOW_CHANNEL, (event, visible: unknown) => {
    if (!isMainWindowSender(event.sender) || typeof visible !== 'boolean') return
    setLoginWindowVisible?.(visible)
  })

  ipcMain.handle(UPDATE_HEALTH_CHANNEL, async (event) => {
    const { currentBackend, isCurrent } = workbenchObservation(event)
    if (!currentBackend || !isCurrent()) return false
    try {
      const confirmed = await workbenchHealth.confirm(
        currentBackend,
        isCurrent,
        async (stillCurrent) => {
          if (!stillCurrent()) throw new Error('Workbench changed during readiness confirmation')
          const updateId = updater.pendingUpdateId()
          if (updateId) updater.logUpdateLifecycleEvent('health-confirmed', updateId, pushLog)
          completeUpdateLaunch?.()
          completeUpdateLaunch = undefined
          pushLog('[update] workbench readiness confirmed by the main renderer\n')
        }
      )
      if (confirmed) {
        // Also runs after the updated application confirms readiness. Busy
        // domains remain untouched; startup provides the interrupted-pass retry.
        coordinationReclamation.run('ready')
        updater.startMacDeferredCleanup(pushLog)
        ensureFreshAuth()
        if (backgroundUpdateCheckDeferred) {
          backgroundUpdateCheckDeferred = false
          runBackgroundUpdateCheck()
        }
        if (pendingProtocolUrl) {
          const deferred = pendingProtocolUrl
          pendingProtocolUrl = null
          deliverDesktopCallback(deferred)
        }
      }
      return confirmed
    } catch (error) {
      pushLog(`[update] health confirmation unavailable: ${String(error)}\n`)
      if (uncertainRelease(error)) {
        // No readiness retry may resume IO after an indeterminate native close.
        // Drain only our own backend; held native capabilities live until exit.
        void finishApplicationShutdown().then(
          () => app.exit(1),
          () => app.exit(1)
        )
      }
      return false
    }
  })

  ipcMain.handle(STARTUP_RETRY_CHANNEL, async (event) => {
    if (
      !isMainWindowSender(event.sender, event.senderFrame) ||
      startupState.snapshot().phase !== STARTUP_PHASE.failed ||
      !startupState.snapshot().retryable ||
      !backendManaged ||
      appQuitting
    )
      return false
    if (backend) return false
    const pending = startManagedBackend(lastBackendPort)
    const generation = startupState.snapshot().generation
    const expectedBackend = backend
    const ready = await pending
    const win = aliveMainWindow()
    if (!ready || !win || !currentStartup(generation, expectedBackend, win)) return false
    try {
      await initializeWindowServices(
        win,
        process.env.ELECTRON_RENDERER_URL || rendererBase + ROOT_ROUTE,
        process.env.ELECTRON_RENDERER_URL,
        browserStorageWindowGeneration
      )
      if (!currentStartup(generation, expectedBackend, win)) return false
      startupState.complete(generation, apiBase)
      finalizeStartup('')
      return true
    } catch (error) {
      startupState.fail(generation, 'startupFailed', false)
      pushLog(`[shell] window service initialization failed: ${String(error)}\n`)
      return false
    }
  })
  ipcMain.on('scholarseed:boot', (e) => {
    const desktopConfig = updater.resolveDesktopConfig(pushLog)
    const productConfig = resolveProductConfig(pushLog)
    e.returnValue = {
      apiBase,
      startup: startupState.snapshot(),
      platform: process.platform,
      fullscreen: mainWindow?.isFullScreen() ?? false,
      systemVersion: formatSystemVersion(systemType(), process.getSystemVersion(), process.arch),
      shoot: isShoot,
      backlog: logBuffer.join(''),
      version: app.getVersion(),
      buildNumber: desktopConfig.buildNumber || STARTUP_BUILD_NUMBER,
      channel: desktopConfig.channel,
      developerToolsEnabled,
      browserEnabled: productConfig.features.browser,
      feedbackRecorderEnabled: productConfig.features.feedbackRecorder,
      preferences: loadRendererPreferences(),
    }
  })
  ipcMain.handle(FEEDBACK_DIAGNOSTICS_CHANNEL, async (event) => {
    if (!isMainWindowSender(event.sender, event.senderFrame)) return
    await updater.syncMacUpdateDiagnostics(pushLog)
  })
  ipcMain.handle(FEEDBACK_CAPTURE_CHANNEL, (event) => {
    const win = aliveMainWindow()
    if (!win || !isFeedbackCaptureSender(event.sender, event.senderFrame, win.webContents)) {
      return { ok: false, error: FEEDBACK_CAPTURE_ERROR.invalidSender }
    }
    const [width, height] = win.getContentSize()
    const layers = win.contentView.children
      .filter(
        (view): view is WebContentsView =>
          view instanceof WebContentsView && view.getVisible() && view.webContents !== event.sender
      )
      .map((view) => ({
        capturePage: () => view.webContents.capturePage(),
        bounds: view.getBounds(),
      }))
    return captureFeedbackScreenshot(event.sender, { viewport: { width, height }, layers })
  })
  ipcMain.handle(
    SUBSCRIPTION_CHANNEL,
    async (event, request: SubscriptionRequest): Promise<SubscriptionReply> => {
      if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame)) {
        throw new Error('Subscription login requires the main application window')
      }
      const endpoint = new URL(apiBase)
      const available =
        backendManaged && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'
      if (request.action === 'available') return { available }
      if (!available) return { available: false, errorCode: 'local_service_required' }
      if (request.action !== 'login') throw new Error('Unsupported subscription action')
      requireDesktopWorkbench()
      const base = apiBase
      const loginSession = event.sender.session
      const path = subscriptionLoginPath(request.connectionId)
      const response = await loginSession.fetch(`${base}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: { [HOST_PROCESS_HEADER]: backendHostProcessKey() },
      })
      const payload = (await response.json()) as Record<string, unknown>
      if (!response.ok)
        return {
          available,
          errorCode: 'login_failed',
          error: payload.detail ? String(payload.detail) : undefined,
        }
      const cancel = async (): Promise<void> => {
        await loginSession.fetch(
          `${base}${path}/${encodeURIComponent(String(payload.transaction_id))}`,
          { method: 'DELETE', redirect: 'error' }
        )
      }
      if (event.sender.isDestroyed()) {
        await cancel()
        return { available, errorCode: 'window_closed' }
      }
      try {
        await shell.openExternal(subscriptionAuthorizationUrl(payload.authorization_url))
      } catch (error) {
        await cancel()
        return {
          available,
          errorCode: 'authorization_open_failed',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (event.sender.isDestroyed()) {
        await cancel()
        return { available, errorCode: 'window_closed' }
      }
      return {
        available,
        login: {
          transaction_id: String(payload.transaction_id),
          state: String(payload.state),
          expires_at: Number(payload.expires_at),
          error: String(payload.error || ''),
        },
      }
    }
  )
  ipcMain.handle(
    SKILLS_CHANNEL,
    async (event, request: DeviceSkillRequest): Promise<DeviceSkillResponse> => {
      if (!isMainWindowSender(event.sender, event.senderFrame)) {
        throw new Error('Device skills require the main application window')
      }
      const endpoint = new URL(apiBase)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
        throw new Error('Device skills require the local desktop backend')
      }
      if (request.operation === 'plugin-valid') {
        if (!plugins.valid(event.sender, request.lease)) return { status: 410, body: '{}' }
        const reference = plugins.reference(event.sender, request.lease)
        if (!reference) return { status: 200, body: '{}' }
        const status = await validatePluginBinding(event.sender.session, apiBase, reference, {
          [HOST_PROCESS_HEADER]: backendHostProcessKey(),
        })
        return {
          status: plugins.valid(event.sender, request.lease) ? status : 410,
          body: '{}',
        }
      }
      if (request.operation === 'plugin-release') {
        if (
          !Array.isArray(request.leases) ||
          request.leases.some((lease) => typeof lease !== 'string')
        )
          throw new Error('plugin_release_invalid')
        plugins.release(event.sender, request.leases)
        return { status: 200, body: '{}' }
      }
      const { path, init } = skillRequest(request)
      const pluginName = request.operation === 'plugin-preview-installed' ? request.name : null
      const revision = pluginName ? pluginRevisions.get(pluginName) : undefined
      const current = (): boolean => !pluginName || revision === pluginRevisions.get(pluginName)
      const headers = new Headers(init.headers)
      headers.set(HOST_PROCESS_HEADER, backendHostProcessKey())
      const response = await event.sender.session.fetch(`${apiBase}${path}`, {
        ...init,
        redirect: 'error',
        headers,
      })
      const body = await response.text()
      if (
        response.ok &&
        request.operation === 'plugin-delivery' &&
        request.action === 'directory'
      ) {
        const result = JSON.parse(body) as { directory: string }
        const error = await shell.openPath(result.directory)
        if (error) return { status: 422, body: JSON.stringify({ error }) }
      }
      if (response.ok && request.operation === 'plugin-call') {
        const result = JSON.parse(body) as { navigation?: unknown }
        if (result.navigation === 'skills' && !event.sender.isDestroyed())
          event.sender.send(PLUGIN_NAVIGATION_CHANNEL)
      }
      if (
        response.ok &&
        (request.operation === 'plugin-preview' ||
          request.operation === 'plugin-open' ||
          request.operation === 'plugin-preview-installed')
      ) {
        const mount = await plugins.open(
          event.sender,
          JSON.parse(body) as PluginSnapshot,
          request.operation !== 'plugin-open',
          current,
          request.operation === 'plugin-open' ? request.reference : undefined
        )
        return { status: response.status, body: JSON.stringify(mount) }
      }
      if (
        response.ok &&
        (request.operation === 'delete' || (request.operation === 'toggle' && !request.enabled))
      ) {
        pluginRevisions.set(request.name, (pluginRevisions.get(request.name) || 0) + 1)
      }
      return { status: response.status, body }
    }
  )
  ipcMain.handle(
    MCP_SETTINGS_CHANNEL,
    async (event, request: McpSettingsRequest): Promise<McpSettingsResponse> => {
      if (!isMainWindowSender(event.sender, event.senderFrame)) {
        throw new Error('MCP settings require the main application window')
      }
      const endpoint = new URL(apiBase)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
        throw new Error('MCP settings require the local desktop backend')
      }
      const { path, init } = mcpSettingsRequest(request)
      const response = await event.sender.session.fetch(`${apiBase}${path}`, {
        ...init,
        redirect: 'error',
        headers: { [HOST_PROCESS_HEADER]: backendHostProcessKey() },
      })
      return { status: response.status, body: await response.text() }
    }
  )
  ipcMain.handle(PREFERENCE_SHUTDOWN_CHANNEL.request, (event) => {
    if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame))
      throw new Error('Invalid preference sender')
    return preferenceQuiescence.register()
  })
  ipcMain.handle(PREFERENCE_SHUTDOWN_CHANNEL.reply, (event, reply: unknown) => {
    if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame)) return false
    return preferenceQuiescence.accept(reply)
  })
  ipcMain.handle(
    PREFERENCES_SAVE_CHANNEL,
    async (event, preferences: unknown, metadata: unknown) => {
      if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame))
        throw new Error('Invalid preference sender')
      const submission = parsePreferenceSubmission(metadata)
      const diagnostics = new PreferenceDiagnostics(
        'main',
        logPreferenceDiagnostic,
        submission,
        submission ? preferenceQuiescence.acknowledged(submission.writerId) : 0
      )
      const result = await diagnostics.run('ipc-save', () =>
        preferenceQuiescence.save(submission, async () => {
          if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame))
            throw new Error('Invalid preference sender')
          requireDesktopWorkbench()
          const before = loadRendererPreferences().autoDownloadUpdates
          const saved = await commitRendererPreferences(preferences, diagnostics)
          if (
            before !== saved.autoDownloadUpdates &&
            !previewPolicyChanging &&
            !updateInstallAbort &&
            !updateRestartRequested
          ) {
            if (!saved.autoDownloadUpdates) {
              await updatePreparation.pause()
              const retained = preparationPolicy ? retainedUpdateReady() : null
              if (retained) {
                updatePreparation.adopt(retained.meta)
                publishUpdateSnapshot({
                  phase: 'ready',
                  currentVersion: app.getVersion(),
                  candidate: retained.meta,
                })
              }
              if (currentUpdateSnapshot().candidate && currentUpdateSnapshot().phase !== 'ready')
                publishUpdateSnapshot({
                  ...currentUpdateSnapshot(),
                  phase: 'available',
                  installation: undefined,
                })
            } else {
              runBackgroundUpdateCheck()
            }
            armBackgroundUpdateCheck()
          }
          return saved
        })
      )
      if (submission) diagnostics.acknowledge(submission.submittedRevision)
      diagnostics.completed('ipc-save')
      return submission
        ? { preferences: result, acknowledgedRevision: submission.submittedRevision }
        : result
    }
  )
  ipcMain.handle(PREFERENCES_RECONCILE_CHANNEL, async (event) => {
    const diagnostics = new PreferenceDiagnostics('main', logPreferenceDiagnostic)
    const result = await diagnostics.run('ipc-reconcile', async () => {
      if (!event.senderFrame || !isMainWindowSender(event.sender, event.senderFrame))
        throw new Error('Invalid preference sender')
      return reconcileRendererPreferences(diagnostics)
    })
    diagnostics.completed('ipc-reconcile')
    return result
  })
  ipcMain.handle('scholarseed:office-font-access', (event) =>
    isMainWindowSender(event.sender) ? (requestOfficeFontAccess?.() ?? false) : false
  )
  const officeFonts: OfficeFontFiles = new OfficeFontFiles(() => nativeFonts.enumerateFonts())
  const officeFontCache = new OfficeFontCacheStore(
    join(desktopStorage().userData, OFFICE_FONT_CACHE_DIRECTORY),
    JSON.stringify([officeManifest, officeFontManifest])
  )
  ipcMain.handle(OFFICE_FONT_CACHE_READ_CHANNEL, (event, fingerprint: unknown) => {
    if (!isMainWindowSender(event.sender, event.senderFrame))
      throw new Error('Invalid Office cache sender')
    officeFonts.assertFingerprint(fingerprint)
    return officeFontCache.load(fingerprint)
  })
  ipcMain.handle(OFFICE_FONT_CACHE_WRITE_CHANNEL, (event, fingerprint: unknown, cache: unknown) => {
    if (!isMainWindowSender(event.sender, event.senderFrame))
      throw new Error('Invalid Office cache sender')
    officeFonts.assertFingerprint(fingerprint)
    officeFontCache.save(fingerprint, cache)
  })
  ipcMain.handle(OFFICE_FONT_CATALOG_CHANNEL, (event) => {
    if (!isMainWindowSender(event.sender, event.senderFrame))
      throw new Error('Invalid Office font sender')
    return officeFonts.catalog()
  })
  ipcMain.handle(OFFICE_FONT_READ_CHANNEL, (event, id: unknown) => {
    if (!isMainWindowSender(event.sender, event.senderFrame) || typeof id !== 'string')
      throw new Error('Invalid Office font request')
    return officeFonts.read(id)
  })
  ipcMain.handle('scholarseed:system-permissions', () => readSystemPermissions())
  ipcMain.handle('scholarseed:system-permission-open', (event, id: SystemPermissionId) => {
    if (!isMainWindowSender(event.sender, event.senderFrame)) return false
    return openSystemPermission(id)
  })
  ipcMain.handle(ATTENTION_READY_CHANNEL, (event) => {
    if (!isMainWindowSender(event.sender, event.senderFrame)) return false
    attentionRendererReady = true
    deliverAttentionActivation()
    return true
  })
  ipcMain.handle(NOTIFICATION_SYNC_CHANNEL, (event) => {
    if (!isMainWindowSender(event.sender, event.senderFrame))
      throw new Error('Invalid notification sender')
    desktopReminders?.synchronize()
  })
  ipcMain.handle('scholarseed:authorized-roots-sync', (_event, scope: unknown, roots: unknown) => {
    // 档位校验走 authorization.ts 导出的集合：字面量在两处各写一遍时，新增
    // 档位会静默失效（类型通过、运行时被拒）。
    if (!isAuthorizationScope(scope)) return false
    if (!Array.isArray(roots) || !roots.every((root) => typeof root === 'string')) return false
    pathAuthorizer.replace(scope, roots)
    return true
  })
  ipcMain.handle('scholarseed:authorized-root-add', (_event, scope: unknown, root: unknown) => {
    if (!isAuthorizationScope(scope)) return false
    if (typeof root !== 'string') return false
    pathAuthorizer.add(scope, root)
    return true
  })
  ipcMain.handle('scholarseed:open-external', (_e, url: unknown) => {
    requireDesktopWorkbench()
    const externalUrl = externalWebUrl(url)
    return externalUrl ? shell.openExternal(externalUrl) : undefined
  })
  ipcMain.handle('scholarseed:open-path', async (_e, target: string) => {
    requireDesktopWorkbench()
    const canonical = pathAuthorizer.resolveAuthorized(String(target || ''))
    if (!canonical) return { ok: false, error: 'target is outside the authorized workspace roots' }
    const error = await shell.openPath(canonical)
    return error ? { ok: false, error } : { ok: true, path: canonical }
  })
  // 打开系统废纸篓 (proposal 47 §7 阶段四的恢复入口)。
  //
  // 为什么不做产品内的一键回迁: `shell.trashItem` 按设计不告诉调用方文件被放到了
  // 哪里, 想做「一键恢复」就必须换成我们自己的回收站目录 —— 那等于把保留策略、
  // 垃圾回收、磁盘占用一并接过来自己维护。系统废纸篓本身就有「放回原处」,
  // 产品这边给出原位置与入口即可。
  //
  // 目标路径由主进程算, 渲染层一个字符都不传: 因此这里不需要过 PathAuthorizer,
  // 也不存在「渲染层指使主进程打开任意目录」的口子。
  ipcMain.handle('scholarseed:open-trash', async () => {
    const target =
      process.platform === MACOS_PLATFORM
        ? join(homedir(), '.Trash')
        : join(homedir(), '.local', 'share', 'Trash', 'files')
    if (process.platform === WINDOWS_PLATFORM) {
      await shell.openExternal('shell:RecycleBinFolder')
      return { ok: true, path: 'shell:RecycleBinFolder' }
    }
    if (!existsSync(target)) return { ok: false, error: `trash folder not found: ${target}` }
    const error = await shell.openPath(target)
    return error ? { ok: false, error } : { ok: true, path: target }
  })

  ipcMain.handle('scholarseed:reveal-path', async (_e, target: string) => {
    const canonical = pathAuthorizer.resolveAuthorized(String(target || ''))
    if (!canonical) return { ok: false, error: 'target is outside the authorized workspace roots' }
    shell.showItemInFolder(canonical)
    return { ok: true, path: canonical }
  })

  // 「打开方式」: 问系统哪些应用能打开这个文件 (按真实路径, 走 NSWorkspace)。
  ipcMain.handle('scholarseed:apps-for-file', async (_e, target: string) => {
    const canonical = pathAuthorizer.resolveAuthorized(String(target || ''))
    if (!canonical) return []
    try {
      const candidates = await appsForFile(canonical)
      const apps = await Promise.all(
        candidates.map(async (application) => {
          if (application.icon) return application
          try {
            const icon = await app.getFileIcon(application.path, { size: 'small' })
            return { ...application, icon: icon.toDataURL() }
          } catch {
            return application
          }
        })
      )
      for (const application of apps) {
        try {
          allowedOpenWithApps.add(pathAuthorizerForApplication(application.path))
        } catch {
          // Ignore an application that disappeared between discovery and canonicalization.
        }
      }
      return apps
    } catch {
      return []
    }
  })
  // 用指定应用打开工作区内文件。
  ipcMain.handle('scholarseed:open-path-with', async (_e, target: string, appPath: string) => {
    requireDesktopWorkbench()
    const canonical = pathAuthorizer.resolveAuthorized(String(target || ''))
    if (!canonical) return { ok: false, error: 'target is outside the authorized workspace roots' }
    let canonicalApp = ''
    try {
      canonicalApp = pathAuthorizerForApplication(String(appPath || ''))
    } catch {
      return { ok: false, error: 'application is unavailable' }
    }
    if (!allowedOpenWithApps.has(canonicalApp))
      return { ok: false, error: 'application was not offered for this file' }
    return openPathWith(canonical, canonicalApp)
  })

  // native folder picker for "open / new workspace" (returns absolute path or null)
  ipcMain.handle('scholarseed:pick-dir', async () => {
    const win = aliveMainWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: mainLocalization().getFixedT(null, 'native')('dialogs.workspace'),
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  registerDeliveryIpc(ipcMain, {
    window: aliveMainWindow,
    base: () => (backendManaged ? apiBase : null),
    headers: () => ({ [HOST_PROCESS_HEADER]: backendHostProcessKey() }),
    sender: (event) => isMainWindowSender(event.sender, event.senderFrame),
    title: () => mainLocalization().getFixedT(null, 'native')('dialogs.literatureDelivery'),
  })

  // 写系统剪贴板 (PRD「复制路径」)。
  //
  // 不用渲染层的 `navigator.clipboard.writeText`: 它要求 document 处于聚焦态,
  // 而桌面端用户很容易在点菜单/切窗口时失焦, 那时写入会直接被拒绝。
  // 主进程的 clipboard 不受聚焦限制, 是桌面端应该走的路径。
  ipcMain.handle(OFFICE_IMAGE_CHANNEL, (event, source: OfficeImageSource) => {
    const win = aliveMainWindow()
    if (!win || !isMainWindowSender(event.sender, event.senderFrame)) {
      return { status: 'error', code: 'invalid_sender' } satisfies OfficeImageResult
    }
    return acquireOfficeImage(win, source)
  })
  ipcMain.handle('scholarseed:write-clipboard', async (_e, text: string) => {
    try {
      await clipboard.writeText(String(text ?? ''))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(
    CLIPBOARD_WRITE_CONTENT_CHANNEL,
    async (event, payload: ClipboardContentPayload) => {
      if (!isMainWindowSender(event.sender, event.senderFrame)) {
        return { ok: false, error: FAILURE_CODES.clipboardForbidden }
      }
      const text = String(payload?.text ?? '')
      const html = String(payload?.html ?? '')
      const item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })
      return writeClipboardContent(clipboard, item)
    }
  )
  ipcMain.handle(CLIPBOARD_PASTE_CHANNEL, (event) => {
    if (!isMainWindowSender(event.sender, event.senderFrame)) {
      return false
    }
    event.sender.paste()
    return true
  })
  ipcMain.handle(FEEDBACK_CLIPBOARD_IMAGE_CHANNEL, async (_e, bytes: Uint8Array) => {
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(bytes))
      if (image.isEmpty()) return { ok: false, error: FEEDBACK_CLIPBOARD_IMAGE_ERROR.empty }
      const item = new ClipboardItem({
        [FEEDBACK_SCREENSHOT_MIME_TYPE]: new Blob([bytes], { type: FEEDBACK_SCREENSHOT_MIME_TYPE }),
      })
      return await writeFeedbackClipboardImage(clipboard, item)
    } catch {
      return { ok: false, error: FEEDBACK_CLIPBOARD_IMAGE_ERROR.failed }
    }
  })

  ipcMain.handle('scholarseed:read-office-clipboard', async (event) => {
    if (!isMainWindowSender(event.sender)) {
      return { ok: false, error: FAILURE_CODES.clipboardForbidden }
    }
    const items = await clipboard.read()
    const readType = async (mime: string): Promise<string> => {
      const item = items.find((candidate) => candidate.types.includes(mime))
      if (!item) return ''
      const value = await item.getType(mime)
      return value instanceof Blob ? value.text() : ''
    }
    return readOfficeClipboard({
      readHTML: () => readType('text/html'),
      readRTF: () => readType('text/rtf'),
      readText: () => clipboard.readText(),
    })
  })

  // 资料导入用的多选文件/文件夹选择器。资料库使用统一入口，
  // 项目设置和文献库仍可通过 target 限定为目录或文件。
  // 返回绝对路径数组; 用户取消返回空数组。
  ipcMain.handle('scholarseed:pick-import', async (_e, target: unknown) => {
    const win = aliveMainWindow()
    if (
      !win ||
      !isImportPickerTarget(target) ||
      !supportsImportPickerTarget(process.platform, target)
    )
      return []
    const r = await dialog.showOpenDialog(win, {
      ...IMPORT_PICKER_DIALOGS[target].options,
      title: mainLocalization().getFixedT(null, 'native')(IMPORT_PICKER_DIALOGS[target].titleKey),
    })
    return r.canceled ? [] : r.filePaths
  })

  // 令牌换路径 + 移入废纸篓（proposal 47 §6.6）。
  //
  // 渲染层只拿到一次性令牌，绝对路径从不经过它；兑换只有主进程能做（密钥随后端
  // 启动生成、只在主进程内），兑换回的路径再过一次 PathAuthorizer——两层都在。
  ipcMain.handle('scholarseed:trash-token', async (_e, token: unknown) => {
    requireDesktopWorkbench()
    const value = String(token || '')
    if (!value) return { ok: false, error: 'missing trash token' }
    const win = mainWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'window unavailable' }
    let absolute = ''
    try {
      // Redemption needs both the account cookie and the host-only capability.
      // Node fetch has no access to the authenticated Chromium session.
      const response = await win.webContents.session.fetch(
        `${apiBase}/api/content/trash-token/redeem`,
        {
          method: 'POST',
          credentials: 'include',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            [HOST_PROCESS_HEADER]: backendHostProcessKey(),
          },
          body: JSON.stringify({ token: value }),
        }
      )
      const payload = (await response.json().catch(() => null)) as {
        absolute?: string
        detail?: string
      } | null
      if (!response.ok || !payload?.absolute) {
        return { ok: false, error: payload?.detail ?? `http_${response.status}` }
      }
      absolute = payload.absolute
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const canonical = pathAuthorizer.resolveAuthorized(absolute)
    if (!canonical) return { ok: false, error: 'target is outside the authorized roots' }
    try {
      await shell.trashItem(canonical)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    try {
      // Completion is part of the authenticated product request, so it must use the
      // same Chromium session as redemption. Node's global fetch has no account cookie.
      const completed = await waitForTrashCompletion(async () => {
        const response = await win.webContents.session.fetch(
          `${apiBase}/api/content/trash-token/complete`,
          {
            method: 'POST',
            credentials: 'include',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              [HOST_PROCESS_HEADER]: backendHostProcessKey(),
            },
            body: JSON.stringify({ token: value }),
          }
        )
        if (response.ok) return { ok: true }
        const payload = (await response.json().catch(() => null)) as { detail?: string } | null
        const error = payload?.detail ?? `trash_receipt_http_${response.status}`
        return {
          ok: false,
          retryable: error === TRASH_NOT_COMPLETED_ERROR,
          error,
        }
      })
      if (!completed.ok) return { ok: false, path: canonical, error: completed.error }
      return { ok: true, path: canonical }
    } catch (e) {
      return {
        ok: true,
        path: canonical,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  })

  ipcMain.handle('scholarseed:pick-executable', async () => {
    const win = aliveMainWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: mainLocalization().getFixedT(null, 'native')('dialogs.codex'),
      properties: ['openFile'],
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('scholarseed:save-copy', async (_event, payload: unknown) => {
    requireDesktopWorkbench()
    const win = aliveMainWindow()
    if (!win) return { ok: false, error: 'window unavailable' }
    return saveFileCopy(
      payload,
      async (suggestedName) => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return null
        const selection = await dialog.showSaveDialog(win, {
          title: mainLocalization().getFixedT(null, 'native')('dialogs.saveCopy'),
          defaultPath: suggestedName,
        })
        return selection.canceled ? null : selection.filePath || null
      },
      (path, bytes) => writeFile(path, bytes)
    )
  })

  // 账号服务线的凭据转交: renderer 直连账号服务拿到双 token 后交给主进程 —— access 写
  // cookie, refresh 走 safeStorage 加密落盘 (续期循环用)。空 token = 登出。get 供 renderer
  // 重启后取回 bearer 去请求账号服务自己的受保护端点 (账号页) —— cookie 是 httpOnly,
  // 渲染层读不到。
  ipcMain.handle('veda:auth-token-set', async (_e, token: string, refreshToken?: string) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'window unavailable' }
    desktopHandoff.cancel()
    return adoptAuthTokens(win, String(token || ''), String(refreshToken || ''))
  })
  ipcMain.handle('veda:auth-token-get', async () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return ''
    try {
      return await readAuthCookie(win)
    } catch {
      return ''
    }
  })
  ipcMain.handle('veda:device-info', () => resolveDeviceInfo())

  // ── 桌面登录交接（官网浏览器登录 + 深链回跳）──
  ipcMain.handle('scholarseed:desktop-login-start', (_event, language: unknown) => {
    requireDesktopWorkbench()
    return desktopHandoff.start(language === 'en' ? 'en' : 'zh')
  })
  ipcMain.handle('scholarseed:desktop-login-cancel', () => {
    desktopHandoff.cancel()
    return { ok: true }
  })
  // 渲染层挂载时 claim 当前快照：深链早于渲染层到达时相位不丢。
  ipcMain.handle('scholarseed:desktop-auth-state', () => desktopHandoff.current())
  // 登录等待态要不要提示提权风险，由渲染层按这个只读事实决定（87498884）。
  ipcMain.handle('scholarseed:desktop-environment', () => ({
    elevated: processIntegrityLevel() === 'high',
  }))
  ipcMain.handle(
    'scholarseed:desktop-auth-adopted-ack',
    (event, id: unknown, confirmed: unknown) => {
      if (
        !event.senderFrame ||
        !isMainWindowSender(event.sender, event.senderFrame) ||
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        typeof confirmed !== 'boolean'
      )
        return { ok: false }
      const ok = desktopHandoff.resetAfterAdopted(id, confirmed)
      if (ok && confirmed) landingResolved = true
      return { ok }
    }
  )

  // 首页关闭（跳过 / 登录采纳）由渲染层回报，本进程内不再重新认领。
  ipcMain.handle('scholarseed:landing-dismiss', () => {
    dismissLanding()
    return { ok: true }
  })
  // 首页认领：未 dismissed 前每次挂载都可认领；会话中登出不触发挂载，故不弹。
  ipcMain.handle('scholarseed:landing-claim', () => !headless && !landingResolved)

  // Version update: the main process owns one authoritative snapshot. Renderer
  // surfaces subscribe to the same state instead of reconstructing it locally.
  ipcMain.handle(PREVIEW_UPDATE_IPC.get, (event) => {
    requirePreviewSender(event)
    return updater.getPreviewUpdatePolicy(pushLog)
  })
  ipcMain.handle(PREVIEW_UPDATE_IPC.lines, async (event) => {
    requirePreviewSender(event)
    requirePreviewPolicyChange()
    return updater.listPreviewUpdateLines(pushLog)
  })
  ipcMain.handle(PREVIEW_UPDATE_IPC.scope, async (event, scope: unknown) => {
    requirePreviewSender(event)
    return changePreviewPolicy({ scope: previewScope(scope) })
  })
  ipcMain.handle(PREVIEW_UPDATE_IPC.select, async (event, id: unknown) => {
    requirePreviewSender(event)
    return changePreviewPolicy({
      ...updater.getPreviewUpdatePolicy(pushLog),
      target: updater.previewTarget(id, pushLog),
    })
  })
  ipcMain.handle(PREVIEW_UPDATE_IPC.cancel, async (event) => {
    requirePreviewSender(event)
    return changePreviewPolicy({ scope: updater.getPreviewUpdatePolicy(pushLog).scope })
  })
  ipcMain.handle('scholarseed:update-state-get', () => currentUpdateSnapshot())
  ipcMain.handle('scholarseed:update-diagnose', async () => updater.diagnoseUpdate(pushLog))
  // proposal 112：数据位置运行期只读概览；mac 首启一次性「高级」经 commit-data-home 写指针。
  ipcMain.handle('scholarseed:storage-config', () => {
    const storageStartup = desktopStorage()
    return {
      home: desktopHome(),
      runtimeStore: runtimeStoreRoot(),
      configured: storageStartup.configured,
      canChangeDataHome: process.platform !== 'win32',
      firstLaunchEligible: canCommitDataHome(storageNative),
    }
  })
  ipcMain.handle('scholarseed:commit-data-home', (_event, parent: unknown) => {
    requireDesktopWorkbench()
    return commitDataHome(typeof parent === 'string' ? parent : '', process.platform, storageNative)
  })
  ipcMain.handle('scholarseed:update-check', async () => {
    if (previewPolicyChanging || updateInstallAbort || updateRestartRequested)
      return currentUpdateSnapshot()
    if (!desktopWorkbenchReady()) {
      backgroundUpdateCheckDeferred = true
      return currentUpdateSnapshot()
    }
    if (updater.updateLaneUnsupported(pushLog)) {
      return publishUpdateSnapshot({
        phase: 'unsupported',
        currentVersion: app.getVersion(),
        reason: LOCAL_LANE_UPDATE_REASON,
      })
    }
    if (!currentUpdateSnapshot().candidate)
      publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: 'checking',
        error: undefined,
        errorFallback: undefined,
        errorOrigin: undefined,
        percent: undefined,
        installStage: undefined,
        installation: undefined,
      })
    const policyRevision = updater.previewPolicyRevision()
    try {
      const result = await updateChecks.run()
      return publishUpdateCheckResult(result)
    } catch (error) {
      if (
        previewPolicyChanging ||
        policyRevision !== updater.previewPolicyRevision() ||
        updateInstallAbort ||
        updateRestartRequested ||
        currentUpdateSnapshot().errorOrigin === 'install'
      )
        return currentUpdateSnapshot()
      return publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: currentUpdateSnapshot().candidate ? currentUpdateSnapshot().phase : 'failed',
        currentVersion: app.getVersion(),
        checkedAt: Date.now(),
        error: error instanceof updater.ActivationCandidateChanged ? undefined : String(error),
        errorFallback:
          error instanceof updater.ActivationCandidateChanged
            ? 'activation_candidate_changed'
            : undefined,
        errorOrigin: 'check',
      })
    }
  })
  // Surface refresh and periodic checks share latest-candidate preparation.
  ipcMain.handle('scholarseed:update-refresh', (): void => {
    runBackgroundUpdateCheck()
  })
  // 下载：从「发现新版本」和「下载失败」都能发起 —— 失败态的「重试下载」走的是同一条
  // 路，能不能真从断点续传由 updater 依据磁盘上留下的部分文件自行判定。
  ipcMain.handle('scholarseed:update-start', async (_e, id: string): Promise<StartUpdateResult> => {
    requireDesktopWorkbench()
    const snapshot = currentUpdateSnapshot()
    const requestedCandidate =
      snapshot.latestCandidate?.id === id
        ? snapshot.latestCandidate
        : snapshot.candidate?.id === id
          ? snapshot.candidate
          : null
    if (
      previewPolicyChanging ||
      snapshot.errorFallback === 'activation_recovery_required' ||
      !requestedCandidate ||
      !['available', 'failed', 'ready'].includes(snapshot.phase) ||
      (snapshot.phase === 'ready' && requestedCandidate.id === snapshot.candidate?.id) ||
      updateInstallAbort ||
      updateInstallationInProgress ||
      updateRestartRequested
    ) {
      return { ok: false, error: 'update candidate is no longer active' }
    }
    if (!updatePreparation.request(requestedCandidate)) return { ok: false }
    await updatePreparation.settled()
    const prepared = currentUpdateSnapshot()
    return { ok: prepared.phase === 'ready' && prepared.candidate?.id === id }
  })

  // 安装并重启：只在「已就绪」可发起。换掉正在运行的客户端必然中断用户手头的活，所以
  // 这一步等用户自己挑时间，不由下载完成自动触发。
  ipcMain.handle(
    'scholarseed:update-install',
    async (_event, expectedId: string): Promise<StartUpdateResult> => {
      requireDesktopWorkbench()
      if (
        previewPolicyChanging ||
        currentUpdateSnapshot().phase !== 'ready' ||
        currentUpdateSnapshot().errorFallback === 'activation_recovery_required' ||
        updateInstallAbort ||
        updateRestartRequested
      ) {
        return { ok: false, error: updater.NO_STAGED_UPDATE }
      }
      const candidate = currentUpdateSnapshot().candidate
      if (!candidate || candidate.id !== expectedId || !updatePreparation.claim(candidate))
        return { ok: false, error: updater.NO_STAGED_UPDATE }
      if (process.platform === WINDOWS_PLATFORM) return installWindowsPreparedUpdate()
      const controller = new AbortController()
      updateInstallAbort = controller
      publishUpdateSnapshot(currentUpdateSnapshot())
      let result: StartUpdateResult
      const maintenanceBackend = backend
      let maintenance: ReturnType<typeof backendUpdateControl> | null = null
      let maintenanceGeneration: string | null = null
      let preferencesRequested = false
      const resumeMaintenance = async (): Promise<void> => {
        if (!maintenance || !maintenanceGeneration) return
        try {
          await maintenance.resume(maintenanceGeneration)
          maintenanceGeneration = null
          macUpdateMaintenanceActive = false
        } catch (error) {
          macMaintenanceUncertain = true
          throw error
        }
      }
      try {
        if (process.platform === MACOS_PLATFORM)
          maintenance = backendUpdateControl(maintenanceBackend)
        const authorize = async (candidate: LatestVersionMeta): Promise<() => void> => {
          if (candidate.id !== expectedId) throw new Error('prepared update identity changed')
          controller.signal.throwIfAborted()
          if (desktopHandoff.isBusy()) controller.abort()
          controller.signal.throwIfAborted()
          if (maintenance && !maintenanceGeneration) {
            preferencesRequested = true
            await preferenceQuiescence.prepare(undefined, 'maintenance')
            controller.signal.throwIfAborted()
            macMaintenanceUncertain = true
            macUpdateMaintenanceActive = true
            clearBackendRestart()
            try {
              maintenanceGeneration = await maintenance.prepareUpdate()
              macMaintenanceUncertain = false
            } catch (error) {
              if (error instanceof BackendMaintenanceRejected) {
                macMaintenanceUncertain = false
                macUpdateMaintenanceActive = false
              }
              throw error
            }
          }
          controller.signal.throwIfAborted()
          const guard = await updater.authorizeActivation(candidate, pushLog, controller.signal)
          return () => {
            controller.signal.throwIfAborted()
            if (desktopHandoff.isBusy()) controller.abort()
            controller.signal.throwIfAborted()
            if (
              maintenance &&
              (backend !== maintenanceBackend ||
                !backend ||
                backend.stopping ||
                backend.proc?.exitCode !== null ||
                backend.proc?.signalCode !== null)
            )
              throw new Error('Backend changed during update maintenance')
            guard()
          }
        }
        result = await updater.installStagedUpdate(
          publishUpdateProgress,
          pushLog,
          controller.signal,
          authorize,
          (candidate) =>
            persistUpdateLaunch(
              storageNative,
              coordinationRoot(),
              {
                uid: userInfo().uid,
                application: applicationBundle(app.getPath('exe')),
                bundleId: resolveProductConfig(pushLog).bundleId,
                build: resolveProductConfig(pushLog).buildNumber,
              },
              desktopStorage(),
              candidate.build_number,
              candidate.id
            )
        )
      } catch (error) {
        result = controller.signal.aborted
          ? { ok: false, cancelled: true }
          : { ok: false, error: String(error) }
      } finally {
        updateInstallAbort = null
      }
      if ((!result.ok || result.mode !== 'auto') && !updater.macHandoffCommitted()) {
        try {
          await resumeMaintenance()
        } catch (error) {
          result = { ok: false, error: String(error) }
        }
        if (!macMaintenanceUncertain) {
          if (preferencesRequested) preferenceQuiescence.resume()
          updatePreparation.release()
        }
      }
      if ((updater.macHandoffCommitted() && !result.ok) || macMaintenanceUncertain) {
        setUpdateInstallationInProgress(false)
        publishUpdateSnapshot({
          ...currentUpdateSnapshot(),
          phase: 'failed',
          installation: undefined,
          installStage: undefined,
          errorFallback: 'activation_recovery_required',
          errorOrigin: 'install',
        })
        return { ok: false, errorFallback: 'activation_recovery_required' }
      }
      if (result.errorFallback === 'activation_candidate_changed') {
        setUpdateInstallationInProgress(false)
        await recoverUpdateConflict()
        return result
      }
      if (result.errorFallback === 'activation_recovery_required') {
        setUpdateInstallationInProgress(false)
        publishUpdateSnapshot({
          phase: 'failed',
          currentVersion: app.getVersion(),
          errorFallback: result.errorFallback,
          errorOrigin: 'install',
        })
        return result
      }
      if (result.ok && result.mode === 'auto') {
        updateRestartRequested = true
        // Keep the durable handoff until a subsequent process observes the installed build.
        publishUpdateSnapshot({
          ...currentUpdateSnapshot(),
          phase: 'restarting',
          percent: 100,
          installStage: 'restarting',
        })
        if (process.platform === MACOS_PLATFORM) {
          try {
            // Electron closes windows before before-quit during quitAndInstall.
            // Finish async product cleanup before handing it that synchronous action.
            await preferenceQuiescence.prepare()
            requireCleanBackendStop(await finishApplicationShutdown())
            updater.quitMacUpdate()
          } catch (error) {
            // Keep the saved receipt fenced while exposing the failure/recovery UI.
            preferenceQuiescence.allowInteraction()
            updater.logUpdateEvent(pushLog, {
              phase: 'macos-install',
              event: 'shutdown-failed',
              result: 'failed',
              updateId: currentUpdateSnapshot().candidate?.id,
            })
            publishUpdateSnapshot({
              ...currentUpdateSnapshot(),
              phase: 'failed',
              installation: undefined,
              installStage: undefined,
              errorFallback: 'activation_recovery_required',
              errorOrigin: 'install',
            })
            return {
              ok: false,
              error: String(error),
              errorFallback: 'activation_recovery_required',
            }
          }
        } else {
          appQuitting = true
          app.quit()
        }
      } else if (result.ok && result.mode === 'manual') {
        setUpdateInstallationInProgress(false)
        publishUpdateSnapshot({
          ...currentUpdateSnapshot(),
          phase: 'manual',
          installation: undefined,
          installStage: undefined,
        })
      } else {
        setUpdateInstallationInProgress(false)
        // 暂存包还在 → 留在「已就绪」并带上错误，用户重试的是安装这一步；暂存包已经没了
        // （校验不过被删掉）→ 退回失败态，下一次重试是重新下载。
        const stillStaged = updater.readReadyState() !== null
        if (updatePreparation.running) {
          publishUpdateSnapshot(currentUpdateSnapshot())
          return result
        }
        publishUpdateSnapshot({
          ...currentUpdateSnapshot(),
          phase: stillStaged ? 'ready' : 'failed',
          percent: stillStaged ? 100 : undefined,
          installation: undefined,
          installStage: undefined,
          ...(result.cancelled
            ? { error: undefined, errorFallback: undefined, errorOrigin: undefined }
            : updateInstallFailure(result)),
          resumable: stillStaged ? undefined : false,
        })
      }
      return result
    }
  )

  // 取消进行中的安装准备（bug 87253073）：只 abort 信号，收尾交给 install handler 的失败分支
  // （回 ready/failed 可重试态）。这里不直接改快照，避免和进行中的安装各写一套状态。
  ipcMain.handle('scholarseed:update-cancel', async (): Promise<StartUpdateResult> => {
    const controller = updateInstallAbort
    if (
      !controller ||
      updater.macHandoffCommitted() ||
      currentUpdateSnapshot().installStage === 'restarting'
    ) {
      return { ok: false, error: NO_INSTALL_IN_PROGRESS }
    }
    pushLog('[update] install cancellation requested by user\n')
    controller.abort()
    return { ok: true }
  })

  // 弹窗收起确认。身份由主进程按当前候选自己算，不接受渲染层传来的字符串 —— 那等于把
  // 「往更新状态目录写任意内容」的授权交出去。落盘后重发快照，两个入口表面同时生效。
  ipcMain.handle('scholarseed:update-announce-ack', (): boolean => {
    if (!desktopWorkbenchReady()) return false
    const key = updateCandidateKey(currentUpdateSnapshot().candidate)
    if (!key) return false
    updater.writeAnnouncedKey(key)
    updateAnnouncedKey = key
    publishUpdateSnapshot(currentUpdateSnapshot())
    return true
  })
}

async function createWindow(
  backendReady: Promise<boolean> = Promise.resolve(!backendManaged || Boolean(backend)),
  componentsReused: Promise<boolean> = Promise.resolve(false)
): Promise<void> {
  const generation = startupState.snapshot().generation
  retireBrowserVaultIpc()
  browserVault?.dispose()
  browserVault = null
  browserStorageWindowGeneration++
  const storageWindowGeneration = browserStorageWindowGeneration
  retireBrowserStorage()
  browserMenu?.dispose()
  browserMenu = null
  browserMenuTargetSubscription?.()
  browserMenuTargetSubscription = null
  browserOverlay?.dispose()
  browserOverlay = null
  browserTooltip?.dispose()
  browserTooltip = null
  browserGrants?.revokeAll()
  browserAgentController?.dispose()
  browserAgentController = null
  browserGrantPolicySubscription?.()
  browserGrantTargetSubscription?.()
  browserGrantScopeSubscription?.()
  browserGrantPolicySubscription = null
  browserGrantTargetSubscription = null
  browserGrantScopeSubscription = null
  const previousBrowserHost = browserHost
  browserHost = null
  await previousBrowserHost?.dispose()
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const developerToolsEnabled = resolveDeveloperToolsEnabled(
    app.isPackaged ? undefined : devUrl,
    headless,
    process.env[SCHOLARSEED_DEVTOOLS_ENV]
  )
  registerIpcHandlers(developerToolsEnabled)
  const rendererUrl = devUrl || rendererBase + ROOT_ROUTE
  mainRendererOrigin = new URL(rendererUrl).origin
  mainWindow = new BrowserWindow(
    createWorkspaceWindowOptions({
      platform: process.platform,
      preload: join(__dirname, '../preload/index.js'),
      ...(process.platform === WINDOWS_PLATFORM ? { icon: applicationIcon(app) } : {}),
    })
  )
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) mainRendererNavigationEpoch += 1
  })
  const browserWindow = mainWindow
  if (!headless) windowController.ensureTray(browserWindow)
  const windowCurrent = (): boolean =>
    aliveMainWindow() === browserWindow && startupState.snapshot().generation === generation
  const windowHiding = createWindowHiding(
    browserWindow,
    () => !appQuitting && !headless && !preferenceQuiescence.isPreparing(),
    () => pushLog('[shell] main window hidden; renderer session remains attached\n')
  )
  mainWindowHiding = windowHiding
  mainWindow.on('enter-full-screen', () => {
    sendToMainWindow(WINDOW_FULLSCREEN_CHANNEL, true)
  })
  mainWindow.on('leave-full-screen', () => {
    sendToMainWindow(WINDOW_FULLSCREEN_CHANNEL, false)
  })
  setLoginWindowVisible = createLoginWindowSizing(
    mainWindow,
    () => windowPresentationAllowed() && !startupScreen
  )
  if (process.platform === WINDOWS_PLATFORM) mainWindow.setMenuBarVisibility(false)

  requestOfficeFontAccess = installOfficeFontPermission(
    mainWindow.webContents.session,
    mainWindow.webContents,
    rendererUrl
  ).requestAccess

  // open target=_blank / external links in the system browser, not a new window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    handleFeedbackShortcut(event, input)
    if (blocksRendererReload(input)) event.preventDefault()
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (
      !mainWindow ||
      !canCopySelection({ selectionText: params.selectionText, canCopy: params.editFlags.canCopy })
    )
      return
    Menu.buildFromTemplate([{ role: SELECTION_COPY_ROLE }]).popup({ window: mainWindow })
  })

  // Prevent the main window from navigating away to external login URLs;
  // instead open them in the system browser.
  installExternalNavigationGuard(mainWindow)
  installContentSecurityPolicy(mainWindow, mainWindowContentSecurityPolicy(launchAccountBase))

  const handoff = createStartupWindowHandoff(
    () =>
      !headless &&
      !appQuitting &&
      aliveMainWindow() === browserWindow &&
      startupState.snapshot().generation === generation,
    () => {
      void revealStartupWorkbench(browserWindow, windowCurrent)
        .then((visible) => {
          if (visible)
            logWindowLifecycle(
              `[startup] main window visible backendPhase=${startupState.snapshot().phase}\n`
            )
        })
        .catch((error) => {
          pushLog(`[startup] workbench handoff failed: ${String(error)}\n`)
        })
    }
  )
  const windowVisible = new Promise<void>((resolve) => {
    browserWindow.once('ready-to-show', () => {
      handoff.painted()
      resolve()
    })
  })
  void componentsReused.then((reused) => {
    if (reused) handoff.reused()
  })

  workbenchHealth.invalidate()
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) workbenchHealth.invalidate()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    workbenchHealth.invalidate()
    pushLog(
      `[shell] renderer process gone reason=${details.reason} exit-code=${details.exitCode}\n`
    )
  })
  mainWindow.webContents.on('console-message', (details) => {
    if (isRendererDiagnostic(details.message)) {
      logWindowLifecycle(`[renderer] level=${details.level} ${details.message}\n`)
      return
    }
    if (details.level !== 'warning' && details.level !== 'error') return
    pushLog(
      `[renderer] level=${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})\n`
    )
  })

  // The macOS close button hides the product surface; it must not destroy the
  // renderer that owns the active session/SSE/HIL projection.  Cmd+Q still
  // reaches before-quit first and is allowed to destroy the window normally.
  mainWindow.on('close', (event) => {
    if (preferenceQuiescence.isPreparing()) {
      event.preventDefault()
      return
    }
    if (process.platform !== MACOS_PLATFORM || appQuitting || headless) return
    event.preventDefault()
    logWindowLifecycle(
      `[shell] main window close requested fullscreen=${browserWindow.isFullScreen()}\n`
    )
    windowHiding.hide()
  })
  mainWindow.on('close', (event) => {
    if (appQuitting || headless) return
    if (mainWindow) windowController.handleClose(mainWindow, event)
  })

  mainWindow.on('closed', () => {
    desktopReminders?.stop()
    desktopReminders = null
    attentionRendererReady = false
    workbenchHealth.invalidate()
    if (storageWindowGeneration === browserStorageWindowGeneration) {
      retireBrowserVaultIpc()
      browserVault?.dispose()
      browserVault = null
      retireBrowserStorage()
    }
    browserGrants?.revokeAll()
    browserAgentController?.dispose()
    browserAgentController = null
    logWindowLifecycle(`[shell] main window destroyed quitting=${appQuitting}\n`)
    mainWindow = null
    mainWindowHiding = null
    setLoginWindowVisible = null
  })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) attentionRendererReady = false
  })
  if (devUrl) {
    const rendererSession = mainWindow.webContents.session
    await prepareRendererLoad(devUrl, () => rendererSession.clearCache())
    await mainWindow.loadURL(devUrl)
    if (developerToolsEnabled) {
      browserVaultIpc?.lock()
      mainWindow.webContents.openDevTools({ mode: MAIN_DEVTOOLS_DOCK_MODE })
    }
  } else {
    await mainWindow.loadURL(rendererUrl)
  }

  if (!(await backendReady)) {
    await windowVisible
    handoff.settled()
    return
  }
  const expectedBackend = backend
  if (!currentStartup(generation, expectedBackend, browserWindow)) return
  await initializeWindowServices(browserWindow, rendererUrl, devUrl, storageWindowGeneration)
  if (currentStartup(generation, expectedBackend, browserWindow)) {
    startupState.complete(generation, apiBase)
    await windowVisible
    if (currentStartup(generation, expectedBackend, browserWindow)) handoff.settled()
  }
}

function currentStartup(
  generation: number,
  expectedBackend: BackendHandle | null,
  win: BrowserWindow
): boolean {
  return (
    !appQuitting &&
    aliveMainWindow() === win &&
    startupState.snapshot().generation === generation &&
    backend === expectedBackend &&
    (!backendManaged ||
      (expectedBackend !== null &&
        !expectedBackend.stopping &&
        expectedBackend.proc !== null &&
        expectedBackend.proc.exitCode === null))
  )
}

async function initializeWindowServices(
  browserWindow: BrowserWindow,
  rendererUrl: string,
  devUrl: string | undefined,
  storageWindowGeneration: number
): Promise<void> {
  if (windowServices === browserWindow) return
  if (appQuitting || aliveMainWindow() !== browserWindow) return
  const browserEnabled = resolveProductConfig(pushLog).features.browser
  browserPolicy = browserEnabled
    ? createBrowserPolicy(desktopHome(), backend?.python ?? null)
    : null
  if (browserEnabled === true && storageWindowGeneration === browserStorageWindowGeneration) {
    const vaultDebug = createVaultDebugPolicy({
      trustedStartup: process.type === 'browser' && app.isReady(),
      argv: process.argv,
      execArgv: process.execArgv,
      nodeOptions: process.env.NODE_OPTIONS,
      commandLine: app.commandLine,
      inspectorUrl,
      contents: () => [
        browserWindow.webContents,
        ...protectedOwners().flatMap((owner) => [...owner.protectedContents()]),
      ],
    })
    const vault = new VaultOwner({
      current: () =>
        secretCustodyReady() &&
        storageWindowGeneration === browserStorageWindowGeneration &&
        mainWindow === browserWindow &&
        !appQuitting &&
        !browserWindow.isDestroyed() &&
        browserWindow.isFocused() &&
        browserWindow.isVisible() &&
        !browserWindow.isMinimized(),
      debug: vaultDebug,
      revokeFailure: protectedCleanupDiagnostic,
      publish: (status) => publishVaultStatus(browserWindow, status),
    })
    browserVault = vault
    browserVaultIpc = createVaultIpc(browserWindow, {
      ipc: ipcMain,
      vault,
      status: () => projectVaultStatus(vault.status()),
      current: () =>
        mainWindow === browserWindow &&
        storageWindowGeneration === browserStorageWindowGeneration &&
        !appQuitting,
      debug: vaultDebug,
      directory: join(__dirname, '../protected', VAULT_COMPILED_GENERATION),
      generation: VAULT_COMPILED_GENERATION,
      manifestDigest: VAULT_COMPILED_MANIFEST_DIGEST,
      watch: __VAULT_PROTECTED_WATCH_UNSUPPORTED__,
      rendererUrl,
      preferences: () => {
        const preferences = loadRendererPreferences()
        return { language: preferences.language, theme: preferences.theme }
      },
      beforeOpen: () => {
        browserMenu?.dismiss('target')
        browserOverlay?.dismiss()
        browserTooltip?.dismiss()
      },
      createSession: () =>
        session.fromPartition(`${PROTECTED_ASSETS.partition}${randomUUID()}`, { cache: false }),
      createView: (webPreferences) => new WebContentsView({ webPreferences }),
    })
    const protectedOwner = browserVaultIpc
    protectedOwner.onCleanupReport((report) =>
      consumeProtectedCleanupReport(protectedOwner, report)
    )
    browserStorage = createStorageConsumer({
      enabled: browserEnabled,
      current: () =>
        storageWindowGeneration === browserStorageWindowGeneration &&
        mainWindow === browserWindow &&
        !browserWindow.isDestroyed() &&
        !appQuitting,
      ensureBackend: ensureBackendForWindow,
      backend: () => backend,
      createHelper: (projection) => new FixedStorageHelper(projection),
      publish: (available) => {
        pushLog(`[browser-storage] ${available ? 'ready' : 'desktop_bridge_unavailable'}\n`)
        void vault.bindStore(available ? (browserStorage?.bind('vault') ?? null) : null)
      },
    })
    browserStorageOwners.add(browserStorage)
    void browserStorage.activate()
  }
  const windowOverlay = browserEnabled
    ? createBrowserOverlay(browserWindow, {
        ipc: ipcMain,
        directory: applicationRenderer(app),
        preload: join(__dirname, '../preload/overlay.js'),
        createSession: () =>
          session.fromPartition(`${BROWSER_OVERLAY_PARTITION_PREFIX}${randomUUID()}`, {
            cache: false,
          }),
        createView: (webPreferences) => new WebContentsView({ webPreferences }),
      })
    : null
  browserOverlay = windowOverlay
  browserTooltip = browserEnabled
    ? createBrowserOverlay(browserWindow, {
        channels: TOOLTIP_OVERLAY_CHANNEL,
        tooltip: true,
        ipc: ipcMain,
        directory: applicationRenderer(app),
        preload: join(__dirname, '../preload/overlay.js'),
        createSession: () =>
          session.fromPartition(`${BROWSER_OVERLAY_PARTITION_PREFIX}${randomUUID()}`, {
            cache: false,
          }),
        createView: (webPreferences) => new WebContentsView({ webPreferences }),
      })
    : null
  let overlayActiveTabId: string | null = null
  let nextBrowserHost: ActiveBrowserHost | null = null
  let automationStatus: ReturnType<ActiveBrowserHost['snapshot']>['automation'] = {
    enabled: false,
    port: null,
  }
  const nextRegistry = browserEnabled
    ? createBrowserRegistry(browserWindow, {
        onFind: (target) => {
          if (!browserWindow.webContents.isDestroyed())
            browserWindow.webContents.send(BROWSER_FIND_CHANNEL, target)
        },
        onPageFocus: () => {
          windowOverlay?.dismiss()
          browserMenu?.dismiss('target')
        },
        onVisibilityChanged: () => browserMenu?.refreshPresentation(),
        apiBase,
        python: backend?.python ?? null,
        historyAgentUseRevision: () => browserPolicy?.agentUseRevision() ?? null,
        publish: (snapshot) => {
          if (snapshot.activeTabId !== overlayActiveTabId) {
            windowOverlay?.dismiss()
            browserMenu?.dismiss('target')
          }
          overlayActiveTabId = snapshot.activeTabId
          void nextBrowserHost?.automation
            .syncTargets()
            .catch(() => pushLog('[browser-cdp] target synchronization failed\n'))
          if (!browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed()) {
            browserWindow.webContents.send(BROWSER_SNAPSHOT_CHANNEL, {
              ...snapshot,
              automation: automationStatus,
            })
          }
        },
        log: (message) => pushLog(`${message}\n`),
      })
    : null
  const menuActions = new MenuActionRegistry()
  if (nextRegistry) {
    for (const actionId of [MENU_ACTION.find, MENU_ACTION.print])
      menuActions.register(actionId, {
        surface: 'browser-menu',
        close: 'before',
        validateValue: (value) => value.kind === 'none',
        validateTarget: (target) => {
          if (target.kind !== 'browser') return false
          try {
            return sameMenuTarget(nextRegistry.menuTarget(target.tabId), target)
          } catch {
            return false
          }
        },
        execute: (event) => browserWindow.webContents.send(MENU_CHANNEL.event, event),
      })
    menuActions.register(MENU_ACTION.zoom, {
      surface: 'browser-menu',
      close: 'keep-open',
      validateValue: (value) =>
        value.kind === 'number' && PAGE_ZOOM_FACTORS.some((factor) => factor === value.value),
      validateTarget: (target) => {
        if (target.kind !== 'browser') return false
        try {
          return sameMenuTarget(nextRegistry.menuTarget(target.tabId), target)
        } catch {
          return false
        }
      },
      execute: async (event, target) => {
        if (target.kind !== 'browser' || event.value.kind !== 'number')
          throw new Error(MENU_ERROR.invalid)
        const reply = await nextRegistry.page({
          kind: 'zoom',
          target: {
            tabId: target.tabId,
            instanceId: target.instanceId,
            navigationId: target.navigationId,
          },
          factor: event.value.value,
        })
        if (!reply.ok) throw new Error(reply.error)
      },
    })
    menuActions.register(MENU_ACTION.devtools, {
      surface: 'browser-menu',
      close: 'before',
      validateValue: (value) => value.kind === 'boolean',
      validateTarget: (target) => {
        if (target.kind !== 'browser') return false
        try {
          return sameMenuTarget(nextRegistry.menuTarget(target.tabId), target)
        } catch {
          return false
        }
      },
      execute: async (event, target) => {
        if (
          target.kind !== 'browser' ||
          event.value.kind !== 'boolean' ||
          !sameMenuTarget(nextRegistry.menuTarget(target.tabId), target)
        )
          throw new Error(MENU_ERROR.invalid)
        const reply = await nextRegistry.page({
          kind: 'devtools',
          target: {
            tabId: target.tabId,
            instanceId: target.instanceId,
            navigationId: target.navigationId,
          },
          open: event.value.value,
        })
        if (!reply.ok) throw new Error(reply.error)
      },
    })
    for (const actionId of [MENU_ACTION.browserSettings, MENU_ACTION.browserHistory])
      menuActions.register(actionId, {
        surface: 'browser-menu',
        close: 'before',
        validateValue: (value) => value.kind === 'none',
        execute: (event) => browserWindow.webContents.send(MENU_CHANNEL.event, event),
      })
  }
  for (const actionId of MENU_ACCOUNT_ACTIONS.filter((action) => action !== MENU_ACTION.language))
    menuActions.register(actionId, {
      surface: 'account-menu',
      close: actionId === MENU_ACTION.logout ? 'keep-open' : 'before',
      validateValue: (value) => value.kind === 'none',
      execute: (event) => browserWindow.webContents.send(MENU_CHANNEL.event, event),
    })
  menuActions.register(MENU_ACTION.language, {
    surface: 'account-menu',
    close: 'keep-open',
    validateValue: (value) =>
      value.kind === 'choice' && (value.value === 'en' || value.value === 'zh-CN'),
    execute: (event) => browserWindow.webContents.send(MENU_CHANNEL.event, event),
  })
  const menuPartition = `${BROWSER_MENU_PARTITION_PREFIX}${randomUUID()}`
  browserMenu = createMenuOwner(browserWindow, {
    log: logWindowLifecycle,
    rendererUrl,
    ipc: ipcMain,
    registry: menuActions,
    directory: applicationRenderer(app),
    preload: join(__dirname, '../preload/menu.js'),
    createSession: () => session.fromPartition(menuPartition, { cache: false }),
    createView: (webPreferences) => new WebContentsView({ webPreferences }),
    onBeforeInput: handleFeedbackShortcut,
    nativeVisible: () => nextRegistry?.nativeVisible() === true,
    find: nextRegistry
      ? {
          query: (target, query, publish) => nextRegistry.find(target, query, publish),
          stop: (target) => nextRegistry.stopFind(target),
          focus: (target) => nextRegistry.focusPage(target),
        }
      : undefined,
    target: (request) => {
      if (request.surface === 'account-menu')
        return { kind: 'account', identityRevision: request.identityRevision }
      if (!nextRegistry) return null
      if (request.surface === 'browser-find') {
        const target = nextRegistry.menuTarget(request.target.tabId)
        return sameMenuTarget(target, { kind: 'browser', ...request.target }) ? target : null
      }
      if (request.tabId !== null) return nextRegistry.menuTarget(request.tabId)
      return nextRegistry.snapshot().activeTabId === null ? { kind: 'browser-empty' } : null
    },
  })
  browserMenuTargetSubscription =
    nextRegistry?.onAgentTargetInvalidated(() => browserMenu?.dismiss('target')) ?? null
  if (nextRegistry && browserPolicy) {
    const nextBroker = createCdpBroker(nextRegistry, {
      publish: (automation) => {
        automationStatus = automation
        if (!browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed()) {
          browserWindow.webContents.send(
            BROWSER_SNAPSHOT_CHANNEL,
            nextBrowserHost?.snapshot() ?? { ...nextRegistry.snapshot(), automation }
          )
        }
      },
      log: (message) => pushLog(`${message}\n`),
    })
    nextBrowserHost = createLegacyBrowserHost(nextRegistry, nextBroker, () => automationStatus)
    browserHost = nextBrowserHost
    const grantRegistry = nextBrowserHost.agent
    const grantPolicy = browserPolicy
    const grantOwners: Parameters<typeof createBrowserReadGrants>[0] = {
      scope: (sessionId, turnId) => backend?.agentTransport?.activeScope(sessionId, turnId) ?? null,
      target: (tabId) => {
        try {
          const target = grantRegistry.agentTarget(tabId)
          return {
            instanceId: target.instanceId,
            generation: target.generation,
            origin: target.origin,
          }
        } catch {
          return null
        }
      },
      navigateTarget: (tabId) => {
        try {
          const target = grantRegistry.agentNavigationTarget(tabId)
          return target.origin === null && target.url !== 'about:blank'
            ? null
            : {
                instanceId: target.instanceId,
                generation: target.generation,
                origin: target.origin,
              }
        } catch {
          return null
        }
      },
      policy: (origin) => grantPolicy.inspect(origin, 'read'),
      navigatePolicy: (origin) => grantPolicy.inspect(origin, 'interact'),
    }
    if (browserGrants) browserGrants.rebind(grantOwners)
    else browserGrants = createBrowserReadGrants(grantOwners)
    browserAgentController = createAgentBrowserController(grantRegistry, {
      validateAuthority: (authority) => browserGrants?.validateAuthority(authority) ?? false,
      actionFence: browserActionFence,
      validateActionPolicy: (authority, origin) => {
        try {
          return (
            grantPolicy.agentUseEnabled() &&
            grantPolicy.revision() === authority.grantRevision &&
            grantPolicy.effectiveDecision(origin, 'interact') !== 'block'
          )
        } catch {
          return false
        }
      },
    })
    const grantController = browserAgentController
    browserGrantPolicySubscription = grantPolicy.onChange(() => {
      browserGrants?.revokeAll()
      browserHost?.historyAgent.revokeAll()
      revokeAgentBrowserLeases()
    })
    browserGrantTargetSubscription = grantRegistry.onAgentTargetInvalidated(
      (tabId, kind, reason) => {
        browserGrants?.revokeTab(tabId, kind === 'target' && reason === 'navigation')
        if (kind === 'external') {
          if (reason === 'navigation') grantController.invalidateTarget(tabId)
          else queueMicrotask(() => grantController.revoke(tabId))
        }
      }
    )
    bindBrowserGrantScope()
    const windowAutomation = nextBrowserHost.automation
    browserWindow.once('closed', () => {
      void windowAutomation.stop().catch(() => pushLog('[browser-cdp] shutdown failed\n'))
    })
    if (loadRendererPreferences().browserAutomationEnabled) {
      void windowAutomation
        .start()
        .catch((error) => pushLog(`[browser-cdp] startup failed: ${String(error)}\n`))
    }
  }
  if (appQuitting || aliveMainWindow() !== browserWindow) return
  windowServices = browserWindow
  desktopReminders?.stop()
  desktopReminders = new DesktopReminders({
    window: aliveMainWindow,
    base: () => apiBase,
    windows: windowsNotifications,
    activate: activateAttention,
    log: pushLog,
  })
  void desktopReminders.start()
  registerRefreshTimer()
  void ensureFreshAuth()
}

async function runStartupHarness(): Promise<void> {
  if (isShoot && mainWindow) {
    const shootWindow = mainWindow
    await finishHeadlessCheck(
      () => runShoot(shootWindow, pushLog),
      stopManagedBackend,
      (code) => {
        if (code === 0) app.quit()
        else app.exit(code)
      }
    )
  } else if (isModeCheck && mainWindow) {
    await runModeCheck(mainWindow, pushLog)
  } else if (sayMessage && mainWindow) {
    await runLiveTurn(mainWindow, sayMessage, pushLog)
  } else if (driveDir && mainWindow) {
    await runDrive(mainWindow, driveDir, apiBase, pushLog)
  } else if (isWorkbenchCheck && mainWindow) {
    const workbenchWindow = mainWindow
    await finishHeadlessCheck(
      () => runWorkbenchCheck(workbenchWindow, pushLog),
      stopManagedBackend,
      (code) => app.exit(code)
    )
  } else if (packageCheckResult && mainWindow) {
    const packageCheckWindow = mainWindow
    await finishHeadlessCheck(
      async () => {
        return (await runPackageCheck(packageCheckWindow, apiBase, packageCheckResult)) ? 0 : 1
      },
      stopManagedBackend,
      (code) => {
        if (code === 0) app.quit()
        else app.exit(code)
      }
    )
  }
}

const STARTUP_UPDATE_CHECK_DELAY_MS = 4000
// 运行期周期复查间隔：长时间不重启的会话也能发现新发布的构建。
const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000
const ACTIVE_UPDATE_CHECK_INTERVAL_MS = 60_000
const UPDATE_CHECK_JITTER = 0.1
let backgroundUpdateTimer: ReturnType<typeof setTimeout> | null = null
let backgroundUpdateTimerStarted = false
let backgroundUpdateTimerStopped = false
let nextPeriodicUpdateCheckAt = 0
let updateCheckRetryAt = 0

function armBackgroundUpdateCheck(): void {
  if (backgroundUpdateTimer) clearTimeout(backgroundUpdateTimer)
  backgroundUpdateTimer = null
  if (!backgroundUpdateTimerStarted || backgroundUpdateTimerStopped) return
  if (currentUpdateSnapshot().candidate)
    nextPeriodicUpdateCheckAt = Math.min(
      nextPeriodicUpdateCheckAt,
      Date.now() + ACTIVE_UPDATE_CHECK_INTERVAL_MS
    )
  const blocked =
    updateInstallAbort ||
    updateInstallationInProgress ||
    updateRestartRequested ||
    macMaintenanceUncertain ||
    updater.macHandoffCommitted()
  if (blocked) return
  const decision = preparationPolicy
    ? updatePreparation.decision(loadRendererPreferences().autoDownloadUpdates)
    : undefined
  const at = nextUpdateCheckAt({
    now: Date.now(),
    periodicAt: nextPeriodicUpdateCheckAt,
    preparationAt: currentUpdateSnapshot().errorOrigin === 'install' ? undefined : decision?.at,
    retryAt: updateCheckRetryAt,
  })
  backgroundUpdateTimer = setTimeout(
    () => {
      backgroundUpdateTimer = null
      runBackgroundUpdateCheck()
    },
    Math.max(0, at - Date.now())
  )
  backgroundUpdateTimer.unref()
}

// 背景更新检查：启动后与运行期周期复查共用同一条路径，每次都直接打服务器查最新。
// local lane 短路；结果的投影一律交 publishUpdateCheckResult，与手动「检查更新」同一份判定。
// in-flight 判定放在结果回来之后，因为用户可能正好在这几秒里点了下载，覆盖掉就等于把
// 进行中的更新退回原点。
function runBackgroundUpdateCheck(): void {
  if (
    backgroundUpdateTimerStopped ||
    previewPolicyChanging ||
    updateInstallAbort ||
    updateRestartRequested
  )
    return
  const active = currentUpdateSnapshot().candidate !== undefined
  nextPeriodicUpdateCheckAt =
    Date.now() +
    (active
      ? ACTIVE_UPDATE_CHECK_INTERVAL_MS * (1 + Math.random() * UPDATE_CHECK_JITTER)
      : PERIODIC_UPDATE_CHECK_INTERVAL_MS)
  if (!desktopWorkbenchReady()) {
    backgroundUpdateCheckDeferred = true
    updateCheckRetryAt = Date.now() + ACTIVE_UPDATE_CHECK_INTERVAL_MS
    armBackgroundUpdateCheck()
    return
  }
  if (updater.updateLaneUnsupported(pushLog)) return
  updateCheckRetryAt = Date.now() + ACTIVE_UPDATE_CHECK_INTERVAL_MS
  void updateChecks
    .run()
    .then((result) => {
      publishUpdateCheckResult(result)
      const decision = preparationPolicy
        ? updatePreparation.decision(loadRendererPreferences().autoDownloadUpdates)
        : undefined
      if (decision?.at === undefined || decision.at > Date.now()) updateCheckRetryAt = 0
    })
    .catch((error) => {
      updateCheckRetryAt = Date.now() + ACTIVE_UPDATE_CHECK_INTERVAL_MS
      pushLog(`[update] background check unavailable: ${String(error)}\n`)
    })
    .finally(armBackgroundUpdateCheck)
}

// A few seconds after the window is up, silently ask the server if a newer
// published build exists; push a non-blocking notice to the renderer if so.
// Then re-check on a fixed interval so long-running sessions still pick up new builds.
function scheduleStartupUpdateCheck(): void {
  backgroundUpdateTimerStarted = true
  nextPeriodicUpdateCheckAt = Date.now() + STARTUP_UPDATE_CHECK_DELAY_MS
  armBackgroundUpdateCheck()
  powerMonitor.on('resume', runBackgroundUpdateCheck)
}

function finalizeStartup(attachUrl: string): void {
  if (startupFinalized || appQuitting || startupState.snapshot().phase !== STARTUP_PHASE.ready)
    return
  // The installer shipped by older macOS builds waits for this exact file.
  // Backend health and window creation match that installer's confirmation
  // contract; the current Squirrel workbench confirmation remains separate.
  if (process.platform === 'darwin' && app.isPackaged) {
    const token = pendingLegacyMacUpdateToken(process.argv)
    if (token) {
      if (!backendManaged || !backend || attachUrl)
        throw new Error('Legacy macOS update has no managed healthy backend')
      confirmLegacyMacUpdate(desktopHome(), token, app.getVersion())
      pushLog('[update] legacy macOS installer health confirmed\n')
    }
  }
  publishUpdateSnapshot(currentUpdateSnapshot())
  if (pendingProtocolUrl) {
    const deferred = pendingProtocolUrl
    pendingProtocolUrl = null
    deliverDesktopCallback(deferred)
  }
  if (!headless && !backgroundUpdateTimerStarted) scheduleStartupUpdateCheck()
  startupFinalized = true
}

async function bootstrap(): Promise<void> {
  await applyMainLanguage(loadRendererPreferences().language)
  // Resolve durable installation state before any backend can begin product writes.
  currentUpdateSnapshot()
  await updater.syncMacUpdateDiagnostics(pushLog)
  try {
    await updater.completeMacStartupAdmission(pushLog, macStartupDecision, pendingUpdateLaunch)
  } catch (error) {
    startupAdmissionResolved = false
    throw error
  }
  if (macStartupDecision?.admission === 'failed' && pendingUpdateLaunch)
    completeUpdateLaunch = pendingUpdateLaunch.complete
  if (updater.macHandoffCommitted()) {
    const status = await updater.macStartupStatus(pushLog)
    const t = mainLocalization().getFixedT(null, 'account')
    if (status === 'failed') {
      reportStartupFailure(startupFailureTitle(), t('update.installationFailed'))
    } else {
      app.exit(0)
    }
    return
  }
  app.on('activate', () => {
    if (!windowPresentationAllowed() || startupFailureReports > 0) return
    if (startupScreen) {
      startupScreen.reveal()
      return
    }
    if (aliveMainWindow()) {
      revealMainWindow('renderer session preserved')
      return
    }
    void (async () => {
      if (!(await ensureBackendForWindow())) {
        reportStartupFailure(
          mainLocalization().getFixedT(null, 'foundation')('startup.backendUnavailable'),
          backendFailureMessage(
            mainLocalization().getFixedT(null, 'foundation'),
            backend?.error ?? lastBackendFailure,
            'recovering'
          )
        )
        return
      }
      if (windowPresentationAllowed() && startupFailureReports === 0 && !startupScreen)
        await createWindow()
    })().catch((e) =>
      reportStartupFailure(
        mainLocalization().getFixedT(null, 'foundation')('startup.interfaceFailed'),
        String(e)
      )
    )
  })

  launchAccountBase = resolveStartupAccountBase(pushLog)
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) rendererBase = devUrl
  else {
    assetServer = await serveAssets(applicationRenderer(app))
    if (appQuitting) {
      await assetServer.close()
      return
    }
    rendererBase = assetServer.url
  }
  if (appQuitting) return
  const attachUrl = (process.env.SCHOLARSEED_SERVE_URL || '').replace(/\/+$/, '')
  backendManaged = !attachUrl
  openStartupScreen()
  let resolveComponentsReused!: (reused: boolean) => void
  const componentsReused = new Promise<boolean>((resolve) => {
    resolveComponentsReused = resolve
  })
  const backendReady = attachUrl
    ? (async () => {
        const generation = startupState.begin()
        try {
          if (
            !(await waitForHealth(
              attachUrl,
              resolveStartupBudgetMs(false, false),
              pushLog,
              'attach'
            ))
          )
            throw new Error('backend health timeout')
          if (appQuitting) return false
          apiBase = attachUrl
          const accountBase = await accountBaseUrlFromServe()
          if (accountBase !== launchAccountBase) throw new Error('attached account policy mismatch')
          return true
        } catch (error) {
          startupState.fail(generation, 'startupFailed', false)
          pushLog(`[shell] external serve unavailable: ${String(error)}\n`)
          return false
        }
      })()
    : startPreparedBackend(() => resolveComponentsReused(true))
  void backendReady.then(
    () => resolveComponentsReused(false),
    () => resolveComponentsReused(false)
  )
  try {
    // Process startup is distinct from health, which requires the renderer's
    // restored workspace and backend readiness acknowledgement over the typed IPC.
    const relaunchedUpdateId = updater.pendingUpdateId()
    if (relaunchedUpdateId) {
      updater.logUpdateLifecycleEvent('app-started', relaunchedUpdateId, pushLog)
    }
    await createWindow(backendReady, componentsReused)
    if (appQuitting) return
    if (!(await backendReady)) {
      if (headless) {
        await finishApplicationShutdown()
        app.exit(1)
      }
      return
    }
    await runStartupHarness()
    finalizeStartup(attachUrl)
  } catch (e) {
    reportStartupFailure(
      mainLocalization().getFixedT(null, 'foundation')('startup.interfaceFailed'),
      String(e)
    )
    return
  }
}

// ---------------------------------------------------------------------------
// scholarseed:// Custom URL Scheme — complete the hosted-account desktop handoff.
// ---------------------------------------------------------------------------

const SCHOLARSEED_PROTOCOL = 'scholarseed'

async function startDesktop(): Promise<void> {
  let updateLaunchContext: ReturnType<typeof observeUpdateLaunch> = null
  if (process.platform === 'darwin' && app.isPackaged) {
    // The old installer may rename the live candidate during rollback. Its
    // absolute resource paths then point at the restored old App, so leave
    // the process family as soon as the resources directory identity changes.
    const stopWatchingResources = watchResourceDirectory(process.resourcesPath, () => {
      pushLog('[update] application resources directory changed; stopping candidate\n')
      mainWindow?.hide()
      void finishApplicationShutdown().then(
        () => app.exit(1),
        (error) => {
          pushLog(`[update] candidate shutdown failed: ${String(error)}\n`)
          app.exit(1)
        }
      )
    })
    app.once('quit', stopWatchingResources)
    const config = resolveProductConfig(pushLog)
    const identity = {
      uid: userInfo().uid,
      application: applicationBundle(app.getPath('exe')),
      bundleId: config.bundleId,
      build: config.buildNumber,
    }
    let observed: ReturnType<typeof observeUpdateLaunch>
    try {
      observed = observeUpdateLaunch(storageNative, coordinationRoot(), identity)
    } catch (error) {
      throw new MacStartupAdmissionError('unconfirmed', error)
    }
    updateLaunchContext = observed
    pendingUpdateLaunch = observed
    let supersededAdmission: 'superseded' | undefined
    if (observed) {
      const decision = await updater.macStartupAdmission(
        observed.context.home,
        pushLog,
        observed.context
      )
      const { admission } = decision
      if (admission === 'superseded') supersededAdmission = admission
      if (admission === 'exit') {
        throw new MacStartupAdmissionError(decision.status ?? 'unconfirmed', decision.cause)
      }
    }
    const restored = observed
      ? restoreUpdateLaunch(
          storageNative,
          coordinationRoot(),
          {
            uid: userInfo().uid,
            application: applicationBundle(app.getPath('exe')),
            bundleId: config.bundleId,
            build: config.buildNumber,
          },
          {
            home: process.env[SCHOLARSEED_HOME_ENV],
            userData: explicitUpdateProfile(process.argv),
            workspace: process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV],
          },
          observed,
          supersededAdmission
        )
      : null
    if (restored) {
      restoreUpdateDebugPort(app.commandLine, restored.context)
      app.setPath('userData', restored.context.userData)
      process.env[SCHOLARSEED_HOME_ENV] = restored.context.home
      process.env[SCHOLARSEED_DEFAULT_WORKSPACE_ENV] = restored.context.workspace
      completeUpdateLaunch = restored.complete
    }
  }
  // proposal 112：home 注入必须是主进程第一条副作用，早于任何 desktopHome() 消费者
  // （logWindowLifecycle/resolveDeviceInfo/isFirstRun/resolveBackendPaths）。Windows 上
  // HKCU\Environment\SCHOLARSEED_HOME 已环境化进 process.env，参与这次启动的一次选择；
  // mac/dev 走 userData 指针，必须在此解析并钉进 env，否则后续消费者读到默认 home。
  const credentialProfile = resolveProductConfig(pushLog).credentialProfile
  const storageSelection = selectStorage(credentialProfile.sessionNamespace, storageNative)
  if (updateLaunchContext && storageSelection.home !== updateLaunchContext.context.home)
    throw new Error('Mac update storage selection changed before admission')
  macStartupDecision = await updater.macStartupAdmission(
    storageSelection.home,
    pushLog,
    updateLaunchContext?.context
  )
  if (macStartupDecision.admission === 'exit') {
    throw new MacStartupAdmissionError(
      macStartupDecision.status ?? 'unconfirmed',
      macStartupDecision.cause
    )
  }
  startupAdmissionResolved = true
  coordinationReclamation.run('startup')
  publishStorage(storageSelection)
  configureCredentialProvider(credentialProfile, storageSelection.sessionData)

  function handleProtocolUrl(url: string): void {
    if (windowsNotifications?.activate(url)) return
    const attentionId = notificationAttentionId(url)
    if (attentionId) {
      activateAttention(attentionId)
      return
    }
    // Defer a valid account callback until the main window is available.
    if (parseCallbackUrl(url)) {
      deliverDesktopCallback(url)
      return
    }
  }

  const initialNotificationUrl = findNotificationUrl(process.argv)
  if (initialNotificationUrl)
    pendingAttentionId = notificationAttentionId(initialNotificationUrl) ?? null
  const initialProtocolUrl = findCallbackUrl(process.argv)
  const initialCallbackTiming = findCallbackTiming(process.argv, initialProtocolUrl)
  if (initialProtocolUrl)
    logWindowLifecycle(callbackTimingLine(initialProtocolUrl, 'argv', initialCallbackTiming))
  if (initialProtocolUrl) pendingProtocolUrl = initialProtocolUrl

  function callbackStateOf(url: string): string {
    return handoffFingerprint(parseCallbackUrl(url)?.state ?? '')
  }

  function handoffInboxDeps(): HandoffInboxDependencies {
    return { home: () => storageSelection.home, log: logWindowLifecycle }
  }

  const notificationInboxDeps: HandoffInboxDependencies = {
    home: () => storageSelection.userData,
    log: logWindowLifecycle,
  }

  /** 主实例定时消费收件箱：二次实例停进来的回调在这里回到正常深链路径。 */
  function startHandoffInboxDrain(): void {
    const timer = setInterval(() => {
      drainInbox(handoffInboxDeps(), (url, timing) => {
        logWindowLifecycle(callbackTimingLine(url, 'inbox', timing))
        handleProtocolUrl(url)
      })
      if (windowsNotifications)
        drainInbox(notificationInboxDeps, (url) => {
          handleProtocolUrl(url)
        })
    }, INBOX_DRAIN_INTERVAL_MS)
    timer.unref()
  }

  // 注册为 scholarseed:// 协议的默认处理程序 (需要在 ready 之前请求单例锁)
  // Interactive development uses isolated userData profiles, not a lock bypass.
  // OS callbacks lack the Vite environment and must reach the existing profile's
  // process before attempting a standalone renderer/backend bootstrap.
  const singleInstanceLockRequired = requiresSingleInstanceLock(headless)
  const gotTheLock = !singleInstanceLockRequired || app.requestSingleInstanceLock()
  if (!gotTheLock) {
    // 87498884：取锁失败不等于这次登录可以静默作废。Windows 提权主实例 + UIPI 会让
    // second-instance 永不触发，argv 里的回调此前随 app.quit() 一起消失且零痕迹。
    // 退出前把回调停进 home 级收件箱，由持锁主实例取回；停不进去也要留下账。
    if (initialNotificationUrl && windowsNotifications) {
      const parked = parkCallbackUrl(notificationInboxDeps, initialNotificationUrl)
      logWindowLifecycle(`[notification] activation ${parked} for current profile\n`)
    }
    if (initialProtocolUrl) {
      const parked = parkCallbackUrl(handoffInboxDeps(), initialProtocolUrl, initialCallbackTiming)
      logWindowLifecycle(
        `[shell] single-instance lock held by another instance; callback ` +
          `${parked === 'parked' ? 'parked in handoff inbox' : 'NOT parked, inbox unavailable'}` +
          ` (state=${callbackStateOf(initialProtocolUrl)})\n`
      )
    } else if (!initialNotificationUrl) {
      logWindowLifecycle(
        '[shell] single-instance lock held by another instance; no callback in argv\n'
      )
    }
    app.quit()
    return
  } else {
    // Windows/Linux: 第二实例携带 URL Scheme 参数
    if (singleInstanceLockRequired) {
      app.on('second-instance', (_event, argv) => {
        const notificationUrl = findNotificationUrl(argv)
        if (notificationUrl) {
          handleProtocolUrl(notificationUrl)
          return
        }
        const url = findCallbackUrl(argv)
        if (url) {
          logWindowLifecycle(
            callbackTimingLine(url, 'second_instance', findCallbackTiming(argv, url))
          )
          handleProtocolUrl(url)
        } else {
          revealMainWindow('second instance')
        }
      })
    }

    // macOS: 应用已运行时收到 URL Scheme 调用
    app.on('open-url', (event, url) => {
      event.preventDefault()
      if (parseCallbackUrl(url)) logWindowLifecycle(callbackTimingLine(url, 'open_url', null))
      handleProtocolUrl(url)
    })

    if (storageSelection.legacyHome) {
      const transferred = await migrateLegacyHome(
        storageNative,
        coordinationRoot(),
        storageSelection.legacyHome,
        storageSelection.home
      )
      if (transferred)
        pushLog(
          `[shell] legacy transfer committed files=${transferred.files} resumed=${transferred.resumed}; legacy source retired=${transferred.retired}\n`
        )
    }
    const storageStartup = desktopStorage()

    app
      .whenReady()
      .then(() => {
        if (toastNative && app.isPackaged) {
          try {
            const result = cleanupNotificationShortcut(
              toastNative.programs(),
              applicationExecutable(app),
              {
                readShortcutLink: (path) => ({
                  ...shell.readShortcutLink(path),
                  appUserModelId: toastNative.shortcutId(path),
                }),
              }
            )
            pushLog(`[notification] legacy shortcut ${result}`)
          } catch (error) {
            pushLog(`[notification] legacy shortcut cleanup failed: ${String(error)}`)
          }
        }
        installApplicationMenu(Boolean(process.env['ELECTRON_RENDERER_URL']) && !headless)
        // 注册 scholarseed:// 协议
        let protocolRegistered: boolean
        let protocolDefault: boolean
        if (process.defaultApp || process.platform === WINDOWS_PLATFORM) {
          // 开发模式需要传递脚本路径
          const executable = applicationExecutable(app)
          const arguments_ = protocolClientArguments(
            process.platform,
            Boolean(process.defaultApp),
            app.getAppPath(),
            storageStartup.userData
          )
          protocolRegistered = app.setAsDefaultProtocolClient(
            SCHOLARSEED_PROTOCOL,
            executable,
            arguments_
          )
          protocolDefault =
            process.platform === WINDOWS_PLATFORM && app.isPackaged
              ? app.isDefaultProtocolClient(SCHOLARSEED_PROTOCOL, executable, arguments_)
              : app.isDefaultProtocolClient(SCHOLARSEED_PROTOCOL)
        } else {
          protocolRegistered = app.setAsDefaultProtocolClient(SCHOLARSEED_PROTOCOL)
          protocolDefault = app.isDefaultProtocolClient(SCHOLARSEED_PROTOCOL)
        }
        logWindowLifecycle(
          `[shell] protocol ${SCHOLARSEED_PROTOCOL} registration=${protocolRegistered} default=${protocolDefault} executable=${applicationExecutable(app)}\n`
        )
        logWindowLifecycle(`[shell] process integrity=${processIntegrityLevel()}\n`)
        return bootstrap().then(() => {
          if (!appQuitting) startHandoffInboxDrain()
          void connectDevelopmentControl().catch(() =>
            pushLog('[dev] private development control unavailable\n')
          )
        })
      })
      .catch((e) => {
        if (!startupAdmissionResolved)
          return recoverStartupAdmission(e, headless, pushLog, pendingUpdateLaunch !== null)
        reportStartupFailure(startupFailureTitle(), String(e))
      })
  }

  app.on('window-all-closed', () => {
    logWindowLifecycle(`[shell] all windows closed quitting=${appQuitting}\n`)
    // On macOS the process stays resident after the last window closes.  Keeping
    // its owned backend alive lets a later Dock activation reopen the same app
    // instead of pointing a fresh window at the dead old localhost port.
    if (process.platform !== MACOS_PLATFORM) app.quit()
  })

  let backendQuitPending = false
  let logsQuitPending = false
  let logsQuitFinished = false
  const PREPARATION_QUIT_TIMEOUT_MS = 15_000
  autoUpdater.on('error', () => {
    if (!updater.macHandoffCommitted()) return
    setUpdateInstallationInProgress(false)
    publishUpdateSnapshot({
      ...currentUpdateSnapshot(),
      phase: 'failed',
      installation: undefined,
      installStage: undefined,
      errorFallback: 'activation_recovery_required',
      errorOrigin: 'install',
    })
    if (updateRestartRequested)
      reportStartupFailure(
        startupFailureTitle(),
        mainLocalization().getFixedT(null, 'account')('update.activationRecoveryRequired')
      )
  })
  autoUpdater.on('before-quit-for-update', () => {
    // No asynchronous work can be delayed by this non-cancellable notification.
    appQuitting = true
    browserVaultIpc?.lock()
    browserVault?.lock()
  })
  app.on('before-quit', (event) => {
    runtimePreparation?.abort()
    browserVaultIpc?.lock()
    browserVault?.lock()
    const blockedMs =
      updateInstallBlockingSince === null ? 0 : Date.now() - updateInstallBlockingSince
    logWindowLifecycle(
      `[shell] before quit installing=${updateInstallationInProgress} restarting=${updateRestartRequested} blockedMs=${blockedMs}\n`
    )
    if (
      updateInstallationInProgress &&
      !updateRestartRequested &&
      blockedMs < UPDATE_INSTALL_QUIT_BLOCK_CAP_MS
    ) {
      event.preventDefault()
      mainWindow?.hide()
      pushLog('[update] close requested during staged installation; continuing in background\n')
      return
    }
    if (updateInstallationInProgress && !updateRestartRequested) {
      pushLog('[update] quit block cap reached; allowing quit despite staged installation\n')
    }
    if (!backendQuitFinished) {
      event.preventDefault()
      appQuitting = true
      if (!backendQuitPending) {
        backendQuitPending = true
        const updatesWereStopped = backgroundUpdateTimerStopped
        void preferenceQuiescence
          .prepare()
          .then(async () => {
            if (!updateRestartRequested && updatePreparation.running) {
              backgroundUpdateTimerStopped = true
              if (backgroundUpdateTimer) clearTimeout(backgroundUpdateTimer)
              backgroundUpdateTimer = null
              let timer: ReturnType<typeof setTimeout> | undefined
              const deadline = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, PREPARATION_QUIT_TIMEOUT_MS)
              })
              try {
                await Promise.race([updatePreparation.stop(), deadline])
              } finally {
                clearTimeout(timer)
              }
            }
            return finishApplicationShutdown()
          })
          .then(
            () => {
              backendQuitFinished = true
              setImmediate(() => app.quit())
            },
            (error: unknown) => {
              backendQuitPending = false
              appQuitting = false
              if (windowsUpdateMaintenanceActive || macUpdateMaintenanceActive) {
                preferenceQuiescence.allowInteraction()
                publishUpdateSnapshot({
                  ...currentUpdateSnapshot(),
                  phase: 'failed',
                  installation: undefined,
                  installStage: undefined,
                  errorFallback: 'activation_recovery_required',
                  errorOrigin: 'install',
                })
              } else {
                preferenceQuiescence.resume()
              }
              backgroundUpdateTimerStopped = updatesWereStopped
              armBackgroundUpdateCheck()
              if (!startupScreen) revealMainWindow('shutdown preparation failed')
              logWindowLifecycle(
                `[shell] shutdown preparation failed; quit withheld: ${String(error)}\n`
              )
              reportStartupFailure(
                mainLocalization().getFixedT(null, 'foundation')('preferences.quitFailed'),
                mainLocalization().getFixedT(null, 'foundation')('preferences.quitRecovery')
              )
            }
          )
      }
    }
  })

  app.on('will-quit', (event) => {
    developmentControl?.close()
    backgroundUpdateTimerStopped = true
    if (backgroundUpdateTimer) clearTimeout(backgroundUpdateTimer)
    backgroundUpdateTimer = null
    if (logsQuitFinished) return
    event.preventDefault()
    if (logsQuitPending) return
    logsQuitPending = true
    logWindowLifecycle('[shell] will quit; draining log writes\n')
    void Promise.all([
      windowDiagnostics?.end() ?? windowLifecycleLog?.end(),
      updater.closeUpdateLog(),
    ]).then(() => {
      logsQuitFinished = true
      // Let Electron finish processing the cancelled will-quit event first.
      // An already settled log drain can otherwise re-enter quit too early.
      setImmediate(() => app.quit())
    })
  })
}

void startDesktop().catch((error) => {
  if (!startupAdmissionResolved) {
    void recoverStartupAdmission(error, headless, pushLog, pendingUpdateLaunch !== null)
    return
  }
  reportStartupFailure(
    startupFailureTitle(),
    error instanceof StorageConfigError ? storageFailureMessage(error.path) : String(error)
  )
})

app.on('ready', (_event, launchInfo) => {
  if (process.platform === MACOS_PLATFORM) {
    const attentionId = notificationLaunchAttentionId(launchInfo)
    if (attentionId) pendingAttentionId = attentionId
  }
  const revoke = () => {
    browserVaultIpc?.lock()
    browserVault?.lock()
  }
  powerMonitor.on('lock-screen', revoke)
  powerMonitor.on('suspend', revoke)
  powerMonitor.on('user-did-resign-active', revoke)
})

app.on('will-quit', () => {
  desktopReminders?.stop()
  windowsNotifications?.dispose(true)
})
