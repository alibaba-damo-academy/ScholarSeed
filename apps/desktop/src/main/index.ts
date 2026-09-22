import { PREFERENCES_SAVE_CHANNEL, PREFERENCES_RECONCILE_CHANNEL } from '../preferences'
import { LOGIN_WINDOW_CHANNEL, WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM } from '../window'
import { createLoginWindowSizing } from './window'
// index.ts — Electron main entry.
//
// Lifecycle: app ready → start backend (pick port, spawn, await /api/healthz) →
// create the 1280×840 native-titlebar window → load the renderer (Vite dev URL
// in development; the backend-served same-origin dist in production). On quit we
// tear the backend down. A `--shoot` flag puts us in screenshot-capture mode
// (M6 fills in the capture script).

import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  shell,
  type OpenDialogOptions
} from 'electron'
import { SKILLS_CHANNEL, skillRequest, type DeviceSkillRequest, type DeviceSkillResponse } from '../skills'
import { SUBSCRIPTION_CHANNEL, subscriptionLoginPath, subscriptionAuthorizationUrl, type SubscriptionRequest, type SubscriptionReply } from '../subscriptions'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { homedir, hostname, platform as osPlatform } from 'os'
import { join, resolve } from 'path'
import {
  startBackend,
  stopBackend,
  desktopHome,
  BackendHandle,
  resolveProductConfig,
  backendHostProcessKey,
  HOST_PROCESS_HEADER
} from './backend'
import {
  FEEDBACK_CAPTURE_CHANNEL,
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_CLIPBOARD_IMAGE_CHANNEL,
  FEEDBACK_CLIPBOARD_IMAGE_ERROR,
  FEEDBACK_SCREENSHOT_MIME_TYPE
} from '../feedback'
import { captureFeedbackScreenshot, isFeedbackCaptureSender, writeFeedbackClipboardImage } from './feedback'
import {
  REFRESH_AHEAD_SECONDS,
  REFRESH_CHECK_INTERVAL_MS,
  accessExpSeconds,
  loadRefreshToken,
  refreshTokens,
  revokeRefreshFamily,
  saveRefreshToken
} from './auth-refresh'
import { runShoot, runLiveTurn, runModeCheck } from './shoot'
import { appsForFile, openPathWith } from './appsForFile'
import { runDrive } from './drive'
import { runWorkbenchCheck } from './workbench'
import { runPackageCheck } from './packagecheck'
import { finishHeadlessCheck } from './headless'
import { loadRendererPreferences, commitRendererPreferences, reconcileRendererPreferences } from './preferences'
import { applyMainLanguage, mainLocalization, startupFailureTitle } from './localization'
import { backendFailureMessage, updateInstallFailure, type BackendFailure } from './failure'
import { isFirstRun } from './startupmarker'
import {
  DesktopHandoff,
  type AdoptOutcome,
  type DesktopAuthSnapshot
} from './handoff'
import { createHandoffCoordinator } from './handoff-local'
import { findCallbackUrl, parseCallbackUrl } from './handoff-url'
import { showStartupScreen, type StartupScreen } from './startup'
import * as updater from './updater'
import { startupBuildNumber } from './version'
import type { StartUpdateResult, UpdateCheckResult, UpdatePhase, UpdateProgress, UpdateSnapshot } from '../updates'
import { LOCAL_LANE_UPDATE_REASON, updateCandidateKey } from '../updates'
import { AuthorizationScope, PathAuthorizer, isAuthorizationScope } from './authorization'
import { saveFileCopy } from './save'
import {
  blocksRendererReload,
  prepareRendererLoad
} from './reload'
import { installOfficeFontPermission } from './fonts'
import { acquireOfficeImage } from './images'
import { OFFICE_IMAGE_CHANNEL, type OfficeImageSource, type OfficeImageResult } from '../images'
import { requiresSingleInstanceLock, resolveDeveloperToolsEnabled } from './environment'
import { readOfficeClipboard, writeClipboardContent } from './clipboard'
import { canCopySelection, SELECTION_COPY_ROLE } from './contextmenu'
import { openSystemPermission, readSystemPermissions } from './permissions'
import type { SystemPermissionId } from '../permissions'
import { sanitizeDesktopNotification } from '../notifications'
import { externalWebUrl } from './external'
import { DEFAULT_SERVE_URL } from '../../endpoints'
import { installApplicationMenu } from './menu'
import {
  IMPORT_PICKER_TARGET,
  isImportPickerTarget,
  supportsImportPickerTarget,
  type ImportPickerTarget
} from '../picker'
import { TRASH_NOT_COMPLETED_ERROR, waitForTrashCompletion } from './trash'
import {
  CLIPBOARD_PASTE_CHANNEL,
  CLIPBOARD_WRITE_CONTENT_CHANNEL,
  type ClipboardContentPayload
} from '../clipboard'

const STARTUP_BUILD_NUMBER = startupBuildNumber(new Date())

let backend: BackendHandle | null = null
let lastBackendFailure: BackendFailure | null = null
let mainWindow: BrowserWindow | null = null
let setLoginWindowVisible: ((visible: boolean) => void) | null = null
let startupScreen: StartupScreen | null = null
const SCHOLARSEED_DEFAULT_WORKSPACE_ENV = 'SCHOLARSEED_DEFAULT_WORKSPACE'
const SCHOLARSEED_DEVTOOLS_ENV = 'SCHOLARSEED_DEVTOOLS'
const MACOS_PLATFORM = 'darwin'
const WINDOWS_PLATFORM = 'win32'
const MOCK_KEYCHAIN_SWITCH = 'use-mock-keychain'
const SESSION_DATA_PREFIX = 'scholarseed-desktop-session'
const DEFAULT_API_BASE = DEFAULT_SERVE_URL
const ROOT_ROUTE = '/'
const BACKEND_RESTART_BASE_DELAY_MS = 1000
const BACKEND_RESTART_MAX_DELAY_MS = 15_000
const BACKEND_PORT_REUSE_ATTEMPTS = 2
// 退出前让「即将关闭并在后台安装」遮罩停留到能被读完：安装是独立进程、期间没有窗口，
// 用户没读到这句就会把随后的黑屏当成卡死。800ms 一闪而过，2500ms 才够读完两行。
// 仅用于 macOS 更新重启路径（安装脚本等 app 退出上限 30s，安全）；Windows 走 ready 握手，
// commit 后立即退出、安装器等退出上限 60s，不用这个延迟（提案 108 §5.2）。
const UPDATE_QUIT_DELAY_MS = 2500
// 一次更新正在推进时，检查结果必须丢弃：覆盖上去等于把用户点「重启完成更新」时的状态
// 换回「发现新版本」，正在跑的下载/安装也就无从收尾。
//
// `ready` **不在**其中：它是「包已下好、等用户挑时间重启」的等待态，而等待期间线上还会继续
// 发布。把 ready 当成进行中，界面就被钉死在当初暂存的那一个包上，用户永远拿不到更新的构建
// （只能装完一级再等下一级）。ready 下能不能推进由 updater.supersedeStagedUpdate 判定。
const UPDATE_IN_FLIGHT_PHASES = new Set<UpdatePhase>([
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'manual'
])
const BROKEN_STREAM_ERROR_CODES = new Set(['EPIPE', 'EIO'])
// macOS supports a unified file/directory panel. Windows and Linux resolve the
// mixed property set as directory-only, so the renderer offers separate targets there.
const IMPORT_PICKER_DIALOGS: Record<ImportPickerTarget, {
  titleKey: 'dialogs.importResource' | 'dialogs.importFile' | 'dialogs.importDirectory'
  options: OpenDialogOptions
}> = {
  [IMPORT_PICKER_TARGET.RESOURCE]: {
    titleKey: 'dialogs.importResource',
    options: { properties: ['openFile', 'openDirectory', 'multiSelections'] }
  },
  [IMPORT_PICKER_TARGET.FILE]: {
    titleKey: 'dialogs.importFile',
    options: { properties: ['openFile', 'multiSelections'] }
  },
  [IMPORT_PICKER_TARGET.DIRECTORY]: {
    titleKey: 'dialogs.importDirectory',
    options: { properties: ['openDirectory', 'multiSelections'] }
  }
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
  isShoot || isModeCheck || Boolean(sayMessage) || Boolean(driveDir) || isWorkbenchCheck
  || Boolean(packageCheckResult)
let apiBase = DEFAULT_API_BASE
let backendManaged = false
let appQuitting = false
let backendRestartAttempts = 0
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null
let backendStart: Promise<boolean> | null = null
let lastBackendPort: number | undefined
let ipcHandlersRegistered = false
let requestOfficeFontAccess: (() => Promise<boolean>) | null = null
let updateInstallationInProgress = false
let updateRestartRequested = false
let updateSnapshot: UpdateSnapshot | null = null
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
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('scholarseed:backend-log', line)
  }
}

function configureCredentialProvider(): void {
  const profile = resolveProductConfig(pushLog).credentialProfile
  refreshNamespace = profile.refreshNamespace
  app.setPath(
    'sessionData',
    join(app.getPath('appData'), `${SESSION_DATA_PREFIX}-${profile.sessionNamespace}`)
  )
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

function publishUpdateSnapshot(next: UpdateSnapshot): UpdateSnapshot {
  const stamped = withAnnouncedKey(next)
  updateSnapshot = stamped
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scholarseed:update-state', stamped)
  }
  return stamped
}

// 下载与安装两段共用同一个进度出口：把进度并进权威快照后广播。渲染层只读快照，
// 不再另开一条并行的进度通道 —— 两个通道必然各说一套。
function publishUpdateProgress(progress: UpdateProgress): void {
  if (progress.phase === 'installing') updateInstallationInProgress = true
  publishUpdateSnapshot({
    ...currentUpdateSnapshot(),
    phase: progress.phase,
    percent: progress.percent,
    receivedBytes: progress.receivedBytes,
    installStage: progress.install_stage,
    error: undefined,
    errorFallback: undefined,
    errorOrigin: undefined,
    resumable: undefined
  })
}

function currentUpdateSnapshot(): UpdateSnapshot {
  if (!updateSnapshot) {
    updateAnnouncedKey = updater.readAnnouncedKey()
    updateSnapshot = withAnnouncedKey(updater.updateLaneUnsupported(pushLog)
      ? {
          phase: 'unsupported',
          currentVersion: app.getVersion(),
          reason: LOCAL_LANE_UPDATE_REASON
        }
      : updater.initialUpdateSnapshot(pushLog))
  }
  return updateSnapshot
}

/**
 * 把一次检查结果投影成权威快照。启动期检查、运行期周期复查与手动「检查更新」共用这一份，
 * 三个入口才不会一个能推进暂存包、另一个不能。
 *
 * 三条判定，顺序即优先级：
 * 1. 更新正在推进（下载/校验/安装/重启/手动兜底）→ 丢弃结果，别把进行中的状态换掉。
 * 2. 已暂存待装（ready）→ 只有线上候选**严格新于**暂存包时才推进：回收旧包、退回
 *    「发现新版本」。候选不比它新（或压根没有候选）就原地不动，用户点「重启完成更新」
 *    装的仍是那个已校验的包，安装失败留在这一相位上的结果表面也不会被抹掉。
 * 3. 其余相位 → 如实发布 available / up-to-date。
 */
function publishUpdateCheckResult(result: UpdateCheckResult): UpdateSnapshot {
  const snapshot = currentUpdateSnapshot()
  if (UPDATE_IN_FLIGHT_PHASES.has(snapshot.phase)) return snapshot
  const latest = result.has_update ? result.latest : null
  if (snapshot.phase === 'ready') {
    // 安装失败会把相位留在 ready 并带上错误（bug 86968393）：那是这次失败唯一的结果表面，
    // 背景检查不能用「发现新版本」把它悄悄换掉。用户重试、或重启客户端（错误只在内存里，
    // 重启即清空）之后才继续走推进判定。
    if (snapshot.error || snapshot.errorFallback) return snapshot
    if (!updater.supersedeStagedUpdate(latest, pushLog)) return snapshot
  }
  return publishUpdateSnapshot(latest
    ? {
        phase: 'available',
        currentVersion: app.getVersion(),
        checkedAt: Date.now(),
        candidate: latest
      }
    : {
        phase: 'up-to-date',
        currentVersion: app.getVersion(),
        checkedAt: Date.now()
      })
}

function reportStartupFailure(title: string, message: string): void {
  closeStartupScreen()
  pushLog(`[shell] ${title}: ${message}\n`)
  if (!headless) dialog.showErrorBox(title, message)
}

function openStartupScreen(): void {
  if (headless || startupScreen) return
  startupScreen = showStartupScreen()
}

function setStartupStatus(status: string): void {
  startupScreen?.setStatus(status)
}

function closeStartupScreen(): void {
  startupScreen?.close()
  startupScreen = null
}

function clearBackendRestart(): void {
  if (backendRestartTimer != null) clearTimeout(backendRestartTimer)
  backendRestartTimer = null
}

function stopManagedBackend(): void {
  backendManaged = false
  clearBackendRestart()
  const current = backend
  backend = null
  stopBackend(current)
}

function restartDelayMs(attempt: number): number {
  return Math.min(BACKEND_RESTART_BASE_DELAY_MS * (2 ** attempt), BACKEND_RESTART_MAX_DELAY_MS)
}

function superviseBackend(handle: BackendHandle): void {
  void handle.exited.then((exit) => {
    if (handle.stopping || !backendManaged || appQuitting || backend !== handle) return
    backend = null
    lastBackendPort = handle.port
    pushLog(`[shell] backend stopped unexpectedly (code=${exit.code} signal=${exit.signal}); scheduling recovery\n`)
    scheduleBackendRestart(handle.port)
  })
}

async function startManagedBackend(preferredPort?: number): Promise<boolean> {
  if (backendStart) return backendStart
  lastBackendFailure = null
  const next = startBackend(pushLog, {
    ...(preferredPort == null ? {} : { port: preferredPort }),
    testHarness: headless
  })
  backend = next
  const start = (async (): Promise<boolean> => {
    let ready = false
    try {
      ready = await next.ready
    } catch (e) {
      next.error = { kind: 'startupFailed', detail: String(e) }
    }
    if (!ready) {
      lastBackendFailure = next.error
      if (backend === next) backend = null
      stopBackend(next)
      return false
    }
    apiBase = next.baseUrl || apiBase
    lastBackendPort = next.port
    superviseBackend(next)
    return true
  })()
  backendStart = start
  try {
    return await start
  } finally {
    if (backendStart === start) backendStart = null
  }
}

function scheduleBackendRestart(previousPort?: number): void {
  if (!backendManaged || appQuitting || backendRestartTimer != null) return
  const attempt = backendRestartAttempts
  const delay = restartDelayMs(attempt)
  const reusePort = attempt < BACKEND_PORT_REUSE_ATTEMPTS ? previousPort : undefined
  backendRestartAttempts += 1
  pushLog(`[shell] backend recovery attempt ${backendRestartAttempts} in ${delay}ms${reusePort ? ` (reuse port ${reusePort})` : ''}\n`)
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null
    void (async () => {
      const oldApiBase = apiBase
      const ready = await startManagedBackend(reusePort)
      if (!ready) {
        pushLog('[shell] backend recovery failed\n')
        scheduleBackendRestart(previousPort)
        return
      }
      backendRestartAttempts = 0
      pushLog(`[shell] backend recovered at ${apiBase}\n`)
      if (oldApiBase !== apiBase && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scholarseed:backend-base', apiBase)
      }
    })()
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
const DESKTOP_ADOPTED_PATH = '/api/desktop/adopted'
const ADOPT_REPORT_TIMEOUT_MS = 5000
// 终结型交接失败时主进程主动把首页推回渲染层。认领原本是 pull-only（渲染层挂载时拉
// 一次），而失败发生时渲染层早就挂载完了，不会再拉一次 —— 所以需要这条推送边。
const LANDING_REOPEN_CHANNEL = 'scholarseed:landing-reopen'
// 本机协调的进程实例 id（proposal 74 §7.4）。刻意不用 pid：pid 会被复用，重启后的新
// 进程可能拿到同一个 pid，从而意外接管前身的 claim —— 那恰好违反「重启后重新登录」。
const HANDOFF_INSTANCE_ID = randomUUID()
// 设备身份落产品家目录: 账号服务的设备列表/远程登出靠这个 id 认机器, 所以它必须
// 跳重启稳定 (不能每次启动新生一个, 否则后台设备列表会无限膨胀)。
const DEVICE_FILE = 'device.json'

function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const isLocalhost = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    return u.protocol === 'https:' || (u.protocol === 'http:' && !isLocalhost)
  } catch { return false }
}

function revealMainWindow(reason: string): boolean {
  const win = mainWindow
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  if (process.platform === MACOS_PLATFORM) app.focus({ steal: true })
  win.focus()
  pushLog(`[shell] main window shown; ${reason}\n`)
  return true
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
    // http 下也接受 Secure cookie。打包版同源, 这两个属性对它无影响。
    sameSite: 'no_restriction',
    secure: true,
    expirationDate: Date.now() / 1000 + AUTH_COOKIE_TTL_SECONDS
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
async function accountBaseUrlFromServe(): Promise<string> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), AUTH_STATUS_REQUEST_TIMEOUT_MS)
    const r = await fetch(`${apiBase}/api/auth/status`, { signal: ctl.signal })
    clearTimeout(t)
    const status = (await r.json()) as { account_base_url?: string }
    return String(status.account_base_url || '').replace(/\/+$/, '')
  } catch {
    return ''
  }
}

// 单飞闸: 启动触发与每小时定时可能撞在一起, 并发轮转会让第二个请求出示已轮转的
// 旧 refresh, 被服务端判成重放把整个会话族掐断 —— 用户会因为自己的客户端打架被登出。
let refreshInflight: Promise<void> | null = null
let refreshTimerRegistered = false

function ensureFreshAuth(): void {
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
  const label = `${osPlatform()} ${hostname()}`
  const path = join(desktopHome(), DEVICE_FILE)
  try {
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf-8')) as { device_id?: string }
      if (saved.device_id) return { device_id: saved.device_id, device_label: label }
    }
  } catch {
    // 文件坏了就重建: 设备标识不是凭据, 重建的代价只是后台多一行设备记录。
    pushLog(`[shell] device file unreadable, regenerating: ${path}\n`)
  }
  const deviceId = randomUUID()
  try {
    mkdirSync(desktopHome(), { recursive: true })
    writeFileSync(path, JSON.stringify({ device_id: deviceId }, null, 2))
  } catch (e) {
    // 写不下也不能拦住登录: 退化成本次会话级设备 id。
    pushLog(`[shell] WARN cannot persist device id: ${String(e)}\n`)
  }
  return { device_id: deviceId, device_label: label }
}

// 拦截主窗口跳向外链：在系统浏览器打开，避免渲染层离开本机应用。
function installExternalNavigationGuard(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (event, url) => {
    if (isExternalUrl(url)) {
      event.preventDefault()
      pushLog(`[shell] intercepted external navigation, opening in browser: ${url}\n`)
      shell.openExternal(url)
    }
  })
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
    const stored = token ? '' : loadRefreshToken(refreshNamespace)
    // 登出: 本地凭据先清干净再通知服务端吊销整族。反过来写的话, 账号服务不可达时
    // 用户点「退出登录」要干等十几秒 (两段 HTTP 超时), 期间进程被杀则本地凭据根本
    // 没清掉 —— 而整族吊销只需要上面已经读出的那个 refresh 值, 与清理顺序无关。
    saveRefreshToken(token ? refreshToken : '', refreshNamespace, pushLog)
    await setAuthCookie(win, token)
    if (stored) void revokeFamilyInBackground(stored)
    // 登录态采纳成功 = 首页使命结束；登出（空 token）不置位，但登出不触发渲染层挂载，
    // 首页也不会因此重弹（认领只发生在挂载时）。
    if (token) landingResolved = true
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 采纳结果回报（proposal 73 §6.3）。

回报只是**增强**网页的可见性，不承担判据：网页在没有 outcome 时按「只到 consumed」
渲染成功态。所以这里吞掉一切错误，绝不让回报失败改相位或打断登录。 */
async function reportHandoffOutcome(
  state: string,
  outcome: AdoptOutcome,
  token: string
): Promise<void> {
  const base = await accountBaseUrlFromServe()
  if (!base) {
    pushLog('[shell] WARN handoff outcome report skipped: account base unavailable\n')
    return
  }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ADOPT_REPORT_TIMEOUT_MS)
    const resp = await fetch(base + DESKTOP_ADOPTED_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ state, outcome }),
      signal: ctl.signal
    })
    clearTimeout(timer)
    if (!resp.ok) pushLog(`[shell] WARN handoff outcome report rejected: http_${resp.status}\n`)
  } catch (e) {
    pushLog(`[shell] WARN handoff outcome report failed: ${String(e)}\n`)
  }
}

/** 终结型交接失败驱动的首页重新认领（proposal 73 §6.4）。

首页被关掉之后 failed 本来无处可见，用户只能对着一个没有任何错误的界面猜。可重试型
不弹 —— 那种情况成功页再点一次真能救回来，弹首页只会打断它。

复位 `landingResolved` 是必须的：它是单向布尔闸（采纳成功或显式跳过后置位），原本
没有复位入口，所以本进程内首页一旦关掉就再也不弹。 */
function reopenLandingForFailure(error?: string): void {
  if (headless) return
  landingResolved = false
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  revealMainWindow('desktop handoff failed')
  win.webContents.send(LANDING_REOPEN_CHANNEL, { error: error || '' })
}

function publishDesktopAuth(snapshot: DesktopAuthSnapshot): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scholarseed:desktop-auth', snapshot)
  }
  // 顺序要紧：先把快照（带错误码）送到渲染层，再让它开首页，否则首页开出来时还没有
  // 错误可显示。
  if (snapshot.phase === 'failed' && snapshot.terminal) reopenLandingForFailure(snapshot.error)
}

const desktopHandoff = new DesktopHandoff({
  log: pushLog,
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
  // 本机协调腿（proposal 74）。宿主头在这里拼好整张表传进去，于是 handoff-local.ts
  // 不必认识头名、也就不必 import 带 electron 的 backend.ts —— 那条链要被 node --test
  // 直接加载，正是 handoff-url.ts 当初被拆出来的同一个理由。
  local: createHandoffCoordinator({
    log: pushLog,
    baseUrl: () => apiBase,
    instanceId: HANDOFF_INSTANCE_ID,
    hostHeaders: () => ({ [HOST_PROCESS_HEADER]: backendHostProcessKey() })
  }),
  reportOutcome: reportHandoffOutcome
})

/** 首页被关闭（跳过或登录采纳）后，本进程内不再重新认领。 */
function dismissLanding(): void {
  landingResolved = true
}

function registerIpcHandlers(developerToolsEnabled: boolean): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true
  ipcMain.handle(LOGIN_WINDOW_CHANNEL, (event, visible: unknown) => {
    if (event.sender !== mainWindow?.webContents || typeof visible !== 'boolean') return
    setLoginWindowVisible?.(visible)
  })

  ipcMain.on('scholarseed:boot', (e) => {
    const desktopConfig = updater.resolveDesktopConfig(pushLog)
    const productConfig = resolveProductConfig(pushLog)
    e.returnValue = {
      apiBase,
      platform: process.platform,
      shoot: isShoot,
      backlog: logBuffer.join(''),
      version: app.getVersion(),
      buildNumber: desktopConfig.buildNumber || STARTUP_BUILD_NUMBER,
      channel: desktopConfig.channel,
      developerToolsEnabled,
      feedbackRecorderEnabled: productConfig.features.feedbackRecorder,
      preferences: loadRendererPreferences()
    }
  })
  ipcMain.handle(FEEDBACK_CAPTURE_CHANNEL, (event) => {
    if (!isFeedbackCaptureSender(event.sender, event.senderFrame, mainWindow?.webContents)) {
      return { ok: false, error: FEEDBACK_CAPTURE_ERROR.invalidSender }
    }
    return captureFeedbackScreenshot(event.sender)
  })
  ipcMain.handle(SUBSCRIPTION_CHANNEL, async (event, request: SubscriptionRequest): Promise<SubscriptionReply> => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Subscription login requires the main application window')
    }
    const endpoint = new URL(apiBase)
    const available = backendManaged && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'
    if (request.action === 'available') return { available }
    if (!available) return { available: false, errorCode: 'local_service_required' }
    if (request.action !== 'login') throw new Error('Unsupported subscription action')
    const base = apiBase
    const loginSession = event.sender.session
    const path = subscriptionLoginPath(request.connectionId)
    const response = await loginSession.fetch(`${base}${path}`, {
      method: 'POST', redirect: 'error', headers: { [HOST_PROCESS_HEADER]: backendHostProcessKey() }
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) return { available, errorCode: 'login_failed', error: payload.detail ? String(payload.detail) : undefined }
    const cancel = async (): Promise<void> => {
      await loginSession.fetch(`${base}${path}/${encodeURIComponent(String(payload.transaction_id))}`, { method: 'DELETE', redirect: 'error' })
    }
    if (event.sender.isDestroyed()) { await cancel(); return { available, errorCode: 'window_closed' } }
    try {
      await shell.openExternal(subscriptionAuthorizationUrl(payload.authorization_url))
    } catch (error) {
      await cancel()
      return { available, errorCode: 'authorization_open_failed', error: error instanceof Error ? error.message : String(error) }
    }
    if (event.sender.isDestroyed()) { await cancel(); return { available, errorCode: 'window_closed' } }
    return { available, login: {
      transaction_id: String(payload.transaction_id), state: String(payload.state),
      expires_at: Number(payload.expires_at), error: String(payload.error || '')
    } }
  })
  ipcMain.handle(SKILLS_CHANNEL, async (event, request: DeviceSkillRequest): Promise<DeviceSkillResponse> => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Device skills require the main application window')
    }
    const endpoint = new URL(apiBase)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
      throw new Error('Device skills require the local desktop backend')
    }
    const { path, init } = skillRequest(request)
    const response = await event.sender.session.fetch(`${apiBase}${path}`, {
      ...init,
      redirect: 'error',
      headers: { [HOST_PROCESS_HEADER]: backendHostProcessKey() }
    })
    return { status: response.status, body: await response.text() }
  })
  ipcMain.handle(PREFERENCES_SAVE_CHANNEL, (event, preferences: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid preference sender')
    return commitRendererPreferences(preferences)
  })
  ipcMain.handle(PREFERENCES_RECONCILE_CHANNEL, (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid preference sender')
    return reconcileRendererPreferences()
  })
  ipcMain.handle('scholarseed:office-font-access', (event) => (
    event.sender === mainWindow?.webContents
      ? requestOfficeFontAccess?.() ?? false
      : false
  ))
  ipcMain.handle('scholarseed:system-permissions', () => readSystemPermissions())
  ipcMain.handle('scholarseed:system-permission-open', (_event, id: SystemPermissionId) => (
    openSystemPermission(id)
  ))
  ipcMain.handle('scholarseed:notification-show', (_event, payload: unknown) => {
    if (!Notification.isSupported()) return { ok: false, error: 'notification_unsupported' }
    const input = sanitizeDesktopNotification(payload)
    if (!input) return { ok: false, error: 'invalid_notification' }
    const notification = new Notification({ title: input.title, body: input.body, silent: true })
    notification.on('click', () => {
      mainWindow?.show()
      mainWindow?.focus()
      mainWindow?.webContents.send('scholarseed:notification-click', input.sessionId)
    })
    notification.on('failed', (_event, error) => pushLog(`[notification] failed: ${error}`))
    notification.show()
    return { ok: true }
  })
  ipcMain.handle('scholarseed:alert-sound', () => {
    shell.beep()
    return true
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
    const externalUrl = externalWebUrl(url)
    return externalUrl ? shell.openExternal(externalUrl) : undefined
  })
  ipcMain.handle('scholarseed:open-path', async (_e, target: string) => {
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
      const apps = await Promise.all(candidates.map(async (application) => {
        if (application.icon) return application
        try {
          const icon = await app.getFileIcon(application.path, { size: 'small' })
          return { ...application, icon: icon.toDataURL() }
        } catch {
          return application
        }
      }))
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
    const canonical = pathAuthorizer.resolveAuthorized(String(target || ''))
    if (!canonical) return { ok: false, error: 'target is outside the authorized workspace roots' }
    let canonicalApp = ''
    try {
      canonicalApp = pathAuthorizerForApplication(String(appPath || ''))
    } catch {
      return { ok: false, error: 'application is unavailable' }
    }
    if (!allowedOpenWithApps.has(canonicalApp)) return { ok: false, error: 'application was not offered for this file' }
    return openPathWith(canonical, canonicalApp)
  })

  // native folder picker for "open / new workspace" (returns absolute path or null)
  ipcMain.handle('scholarseed:pick-dir', async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      title: mainLocalization().getFixedT(null, 'native')('dialogs.workspace'),
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // 写系统剪贴板 (PRD「复制路径」)。
  //
  // 不用渲染层的 `navigator.clipboard.writeText`: 它要求 document 处于聚焦态,
  // 而桌面端用户很容易在点菜单/切窗口时失焦, 那时写入会直接被拒绝。
  // 主进程的 clipboard 不受聚焦限制, 是桌面端应该走的路径。
  ipcMain.handle(OFFICE_IMAGE_CHANNEL, (event, source: OfficeImageSource) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { status: 'error', code: 'invalid_sender' } satisfies OfficeImageResult
    }
    return acquireOfficeImage(mainWindow, source)
  })
  ipcMain.handle('scholarseed:write-clipboard', async (_e, text: string) => {
    try {
      await clipboard.writeText(String(text ?? ''))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(CLIPBOARD_WRITE_CONTENT_CHANNEL, async (event, payload: ClipboardContentPayload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { ok: false, error: 'clipboard_forbidden' }
    }
    const text = String(payload?.text ?? '')
    const html = String(payload?.html ?? '')
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' })
    })
    return writeClipboardContent(clipboard, item)
  })
  ipcMain.handle(CLIPBOARD_PASTE_CHANNEL, (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
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
        [FEEDBACK_SCREENSHOT_MIME_TYPE]: new Blob([bytes], { type: FEEDBACK_SCREENSHOT_MIME_TYPE })
      })
      return await writeFeedbackClipboardImage(clipboard, item)
    } catch {
      return { ok: false, error: FEEDBACK_CLIPBOARD_IMAGE_ERROR.failed }
    }
  })

  ipcMain.handle('scholarseed:read-office-clipboard', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false, error: 'clipboard_forbidden' }
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
      readText: () => clipboard.readText()
    })
  })

  // 资料导入用的多选文件/文件夹选择器。资料库使用统一入口，
  // 项目设置和文献库仍可通过 target 限定为目录或文件。
  // 返回绝对路径数组; 用户取消返回空数组。
  ipcMain.handle('scholarseed:pick-import', async (_e, target: unknown) => {
    if (
      !mainWindow
      || !isImportPickerTarget(target)
      || !supportsImportPickerTarget(process.platform, target)
    ) return []
    const r = await dialog.showOpenDialog(mainWindow, { ...IMPORT_PICKER_DIALOGS[target].options, title: mainLocalization().getFixedT(null, 'native')(IMPORT_PICKER_DIALOGS[target].titleKey) })
    return r.canceled ? [] : r.filePaths
  })

  // 令牌换路径 + 移入废纸篓（proposal 47 §6.6）。
  //
  // 渲染层只拿到一次性令牌，绝对路径从不经过它；兑换只有主进程能做（密钥随后端
  // 启动生成、只在主进程内），兑换回的路径再过一次 PathAuthorizer——两层都在。
  ipcMain.handle('scholarseed:trash-token', async (_e, token: unknown) => {
    const value = String(token || '')
    if (!value) return { ok: false, error: 'missing trash token' }
    const win = mainWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'window unavailable' }
    let absolute = ''
    try {
      // Redemption needs both the account cookie and the host-only capability.
      // Node fetch has no access to the authenticated Chromium session.
      const response = await win.webContents.session.fetch(`${apiBase}/api/content/trash-token/redeem`, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          [HOST_PROCESS_HEADER]: backendHostProcessKey()
        },
        body: JSON.stringify({ token: value })
      })
      const payload = (await response.json().catch(() => null)) as
        | { absolute?: string; detail?: string }
        | null
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
              [HOST_PROCESS_HEADER]: backendHostProcessKey()
            },
            body: JSON.stringify({ token: value })
          }
        )
        if (response.ok) return { ok: true }
        const payload = (await response.json().catch(() => null)) as
          | { detail?: string }
          | null
        const error = payload?.detail ?? `trash_receipt_http_${response.status}`
        return {
          ok: false,
          retryable: error === TRASH_NOT_COMPLETED_ERROR,
          error
        }
      })
      if (!completed.ok) return { ok: false, path: canonical, error: completed.error }
      return { ok: true, path: canonical }
    } catch (e) {
      return {
        ok: true,
        path: canonical,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle('scholarseed:pick-executable', async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      title: mainLocalization().getFixedT(null, 'native')('dialogs.codex'),
      properties: ['openFile']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('scholarseed:save-copy', async (_event, payload: unknown) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return { ok: false, error: 'window unavailable' }
    return saveFileCopy(
      payload,
      async (suggestedName) => {
        const selection = await dialog.showSaveDialog(win, {
          title: mainLocalization().getFixedT(null, 'native')('dialogs.saveCopy'),
          defaultPath: suggestedName
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
  ipcMain.handle('scholarseed:desktop-login-start', (_event, language: unknown) =>
    desktopHandoff.start(language === 'en' ? 'en' : 'zh'))
  ipcMain.handle('scholarseed:desktop-login-cancel', () => {
    desktopHandoff.cancel()
    return { ok: true }
  })
  // 渲染层挂载时 claim 当前快照：深链早于渲染层到达时相位不丢。
  ipcMain.handle('scholarseed:desktop-auth-state', () => desktopHandoff.current())
  ipcMain.handle('scholarseed:desktop-auth-adopted-ack', () => {
    desktopHandoff.resetAfterAdopted()
    return { ok: true }
  })

  // 首页关闭（跳过 / 登录采纳）由渲染层回报，本进程内不再重新认领。
  ipcMain.handle('scholarseed:landing-dismiss', () => {
    dismissLanding()
    return { ok: true }
  })
  // 首页认领：未 dismissed 前每次挂载都可认领；会话中登出不触发挂载，故不弹。
  ipcMain.handle('scholarseed:landing-claim', () => !headless && !landingResolved)

  // Version update: the main process owns one authoritative snapshot. Renderer
  // surfaces subscribe to the same state instead of reconstructing it locally.
  ipcMain.handle('scholarseed:update-state-get', () => currentUpdateSnapshot())
  ipcMain.handle('scholarseed:update-diagnose', async () => updater.diagnoseUpdate(pushLog))
  ipcMain.handle('scholarseed:update-check', async () => {
    if (updater.updateLaneUnsupported(pushLog)) {
      return publishUpdateSnapshot({
        phase: 'unsupported',
        currentVersion: app.getVersion(),
        reason: LOCAL_LANE_UPDATE_REASON
      })
    }
    publishUpdateSnapshot({
      ...currentUpdateSnapshot(),
      phase: 'checking',
      error: undefined,
      errorFallback: undefined,
      errorOrigin: undefined,
      percent: undefined,
      installStage: undefined
    })
    try {
      const result = await updater.checkForUpdate(pushLog)
      return publishUpdateCheckResult(result)
    } catch (error) {
      return publishUpdateSnapshot({
        phase: 'failed',
        currentVersion: app.getVersion(),
        checkedAt: Date.now(),
        error: String(error),
        errorOrigin: 'check'
      })
    }
  })
  // 静默刷新：更新表面（更新卡浮窗、关于书页）打开时调用，复用背景检查同一条路径。
  // 收敛 87009973 修复后的残留窗口 —— 上一次检查之后、用户点「重启完成更新」之前发布的
  // 新包：打开表面这一刻 supersede 已把面板推进到最新构建，安装点击本身保持秒级、
  // 不阻塞在版本复查上。不能复用手动 update-check：它先设 'checking' 相位，ready 下
  // 安装按钮会当场消失再出现。投影仍是 publishUpdateCheckResult 那一份，in-flight 闸、
  // 安装失败结果保护与 announcedKey 保留全部生效。
  ipcMain.handle('scholarseed:update-refresh', (): void => {
    runBackgroundUpdateCheck()
  })
  // 下载：从「发现新版本」和「下载失败」都能发起 —— 失败态的「重试下载」走的是同一条
  // 路，能不能真从断点续传由 updater 依据磁盘上留下的部分文件自行判定。
  ipcMain.handle('scholarseed:update-start', async (_e, id: string): Promise<StartUpdateResult> => {
    const snapshot = currentUpdateSnapshot()
    const startable = snapshot.phase === 'available' || snapshot.phase === 'failed'
    if (!startable || snapshot.candidate?.id !== id) {
      return { ok: false, error: 'update candidate is no longer active' }
    }
    // 取下载地址本身是一次网络请求。不先发布相位，界面就会有一段仍停在「发现新版本」
    // 的空窗 —— 这段过去靠渲染层写乐观状态盖住，现在状态只有一个来源，由主进程如实发布。
    publishUpdateSnapshot({
      ...snapshot,
      phase: 'downloading',
      percent: 0,
      receivedBytes: 0,
      error: undefined,
      errorFallback: undefined,
      errorOrigin: undefined,
      resumable: undefined
    })
    const staged = await updater.stageUpdate(id, publishUpdateProgress, pushLog)
    if (staged.ok) {
      publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: 'ready',
        candidate: staged.ready.meta,
        percent: 100,
        receivedBytes: staged.ready.meta.file_size,
        error: undefined,
        errorFallback: undefined,
        errorOrigin: undefined,
        resumable: undefined
      })
      return { ok: true }
    }
    publishUpdateSnapshot({
      ...currentUpdateSnapshot(),
      phase: 'failed',
      error: staged.error,
      errorFallback: undefined,
      errorOrigin: 'download',
      resumable: staged.resumable
    })
    return { ok: false, error: staged.error }
  })

  // 安装并重启：只在「已就绪」可发起。换掉正在运行的客户端必然中断用户手头的活，所以
  // 这一步等用户自己挑时间，不由下载完成自动触发。
  ipcMain.handle('scholarseed:update-install', async (): Promise<StartUpdateResult> => {
    if (currentUpdateSnapshot().phase !== 'ready') {
      return { ok: false, error: updater.NO_STAGED_UPDATE }
    }
    let result: StartUpdateResult
    try {
      result = await updater.installStagedUpdate(publishUpdateProgress, pushLog)
    } catch (error) {
      updateInstallationInProgress = false
      throw error
    }
    if (result.ok && result.mode === 'auto') {
      updateRestartRequested = true
      // 不在这里清暂存态：安装器只是被拉起来，结果还没确认（Windows 侧拿不到退出码，
      // macOS 侧要等新进程回写 confirm）。清了之后一旦安装失败，用户面对的是一个既没有
      // 「已就绪」也没有错误的界面。收口交给下一次启动：装成了 → 暂存包不再比运行版本新，
      // initialUpdateSnapshot 连记录带包体一起回收；没装成 → 记录与包都还在，可直接重试。
      publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: 'restarting',
        percent: 100,
        installStage: 'restarting'
      })
      // Quit so the detached installer can swap the now-idle bundle and relaunch.
      if (process.platform === WINDOWS_PLATFORM) {
        // Windows：installWindows 在 commit 发布后才返回，安装器正在 customInit 里等本进程
        // 退出（≤60s，超时即中止、绝不强杀），立即退出直接缩短不可用窗口；握手等待期间
        // 界面一直停留在「准备中」，不再需要靠延迟让遮罩被读完（提案 108 §5.2 第 5 条）。
        appQuitting = true
        app.quit()
      } else {
        setTimeout(() => {
          appQuitting = true
          app.quit()
        }, UPDATE_QUIT_DELAY_MS)
      }
    } else if (result.ok && result.mode === 'manual') {
      updateInstallationInProgress = false
      publishUpdateSnapshot({ ...currentUpdateSnapshot(), phase: 'manual' })
    } else {
      updateInstallationInProgress = false
      // 暂存包还在 → 留在「已就绪」并带上错误，用户重试的是安装这一步；暂存包已经没了
      // （校验不过被删掉）→ 退回失败态，下一次重试是重新下载。
      const stillStaged = updater.readReadyState() !== null
      publishUpdateSnapshot({
        ...currentUpdateSnapshot(),
        phase: stillStaged ? 'ready' : 'failed',
        percent: stillStaged ? 100 : undefined,
        ...updateInstallFailure(result),
        resumable: stillStaged ? undefined : false
      })
    }
    return result
  })

  // 弹窗收起确认。身份由主进程按当前候选自己算，不接受渲染层传来的字符串 —— 那等于把
  // 「往更新状态目录写任意内容」的授权交出去。落盘后重发快照，两个入口表面同时生效。
  ipcMain.handle('scholarseed:update-announce-ack', (): boolean => {
    const key = updateCandidateKey(currentUpdateSnapshot().candidate)
    if (!key) return false
    updater.writeAnnouncedKey(key)
    updateAnnouncedKey = key
    publishUpdateSnapshot(currentUpdateSnapshot())
    return true
  })
}

async function createWindow(): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const developerToolsEnabled = resolveDeveloperToolsEnabled(
    devUrl,
    headless,
    process.env[SCHOLARSEED_DEVTOOLS_ENV]
  )
  registerIpcHandlers(developerToolsEnabled)
  const rendererUrl = devUrl || apiBase + ROOT_ROUTE
  mainWindow = new BrowserWindow({
    ...WORKSPACE_WINDOW_SIZE,
    useContentSize: true,
    minWidth: WORKSPACE_WINDOW_MINIMUM.width,
    minHeight: WORKSPACE_WINDOW_MINIMUM.height,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#F8F8F5',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // keep the pet's RAF loop alive when hidden (shoot mode)
    }
  })
  setLoginWindowVisible = createLoginWindowSizing(mainWindow)
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
    if (blocksRendererReload(input)) event.preventDefault()
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!mainWindow || !canCopySelection({ selectionText: params.selectionText, canCopy: params.editFlags.canCopy })) return
    Menu.buildFromTemplate([{ role: SELECTION_COPY_ROLE }]).popup({ window: mainWindow })
  })

  // Prevent the main window from navigating away to external login URLs;
  // instead open them in the system browser.
  installExternalNavigationGuard(mainWindow)

  mainWindow.once('ready-to-show', () => {
    if (!headless) {
      mainWindow?.show()
      closeStartupScreen()
    }
    // 跨重启续期: 启动即检查一次 access 是否临近过期（配合每小时定时）
    registerRefreshTimer()
    ensureFreshAuth()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    pushLog(`[shell] renderer process gone reason=${details.reason} exit-code=${details.exitCode}\n`)
  })
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    pushLog(`[renderer] level=${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})\n`)
  })

  // The macOS close button hides the product surface; it must not destroy the
  // renderer that owns the active session/SSE/HIL projection.  Cmd+Q still
  // reaches before-quit first and is allowed to destroy the window normally.
  mainWindow.on('close', (event) => {
    if (process.platform !== MACOS_PLATFORM || appQuitting || headless) return
    event.preventDefault()
    mainWindow?.hide()
    pushLog('[shell] main window hidden; renderer session remains attached\n')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    setLoginWindowVisible = null
  })
  if (devUrl) {
    const rendererSession = mainWindow.webContents.session
    await prepareRendererLoad(devUrl, () => rendererSession.clearCache())
    await mainWindow.loadURL(devUrl)
    // DevTools is opt-in (SCHOLARSEED_DEVTOOLS=1): its frontend floods the terminal with
    // Autofill.enable / VE-context CDP noise, so keep the default dev run clean.
    if (developerToolsEnabled) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    // packaged OR unpackaged-no-dev (shoot / --say): the backend serves the
    // built renderer at its root → same-origin, live, CORS-free.
    await mainWindow.loadURL(apiBase + ROOT_ROUTE)
  }

  if (isShoot && mainWindow) {
    await runShoot(mainWindow, pushLog)
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
    await runPackageCheck(mainWindow, apiBase, packageCheckResult)
    appQuitting = true
    app.quit()
  }
}

const STARTUP_UPDATE_CHECK_DELAY_MS = 4000
// 运行期周期复查间隔：长时间不重启的会话也能发现新发布的构建。
const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

// 背景更新检查：启动后与运行期周期复查共用同一条路径，每次都直接打服务器查最新。
// local lane 短路；结果的投影一律交 publishUpdateCheckResult，与手动「检查更新」同一份判定。
// in-flight 判定放在结果回来之后，因为用户可能正好在这几秒里点了下载，覆盖掉就等于把
// 进行中的更新退回原点。
function runBackgroundUpdateCheck(): void {
  if (updater.updateLaneUnsupported(pushLog)) return
  void updater.checkForUpdate(pushLog).then((result) => {
    publishUpdateCheckResult(result)
  }).catch((error) => {
    pushLog(`[update] background check unavailable: ${String(error)}\n`)
  })
}

// A few seconds after the window is up, silently ask the server if a newer
// published build exists; push a non-blocking notice to the renderer if so.
// Then re-check on a fixed interval so long-running sessions still pick up new builds.
function scheduleStartupUpdateCheck(): void {
  setTimeout(() => {
    runBackgroundUpdateCheck()
    setInterval(runBackgroundUpdateCheck, PERIODIC_UPDATE_CHECK_INTERVAL_MS)
  }, STARTUP_UPDATE_CHECK_DELAY_MS)
}

async function bootstrap(): Promise<void> {
  await applyMainLanguage(loadRendererPreferences().language)
  openStartupScreen()
  // SCHOLARSEED_SERVE_URL: 附着到一个**已在跑的 serve** (不自起后端) —— 用于观察/调试一个外部
  // 测试会话 (该 serve 需用 --renderer-dist 托管本 app 的 renderer)。否则照常自起后端。
  const attachUrl = (process.env.SCHOLARSEED_SERVE_URL || '').replace(/\/+$/, '')
  if (attachUrl) {
    setStartupStatus(mainLocalization().getFixedT(null, 'foundation')('startup.connecting'))
    apiBase = attachUrl
    pushLog(`[shell] attaching to external serve ${apiBase} (no spawn)\n`)
  } else {
    backendManaged = true
    const firstRun = isFirstRun(desktopHome(), app.getVersion())
    setStartupStatus(mainLocalization().getFixedT(null, 'foundation')(
      firstRun ? 'startup.startingBackendFirstRun' : 'startup.startingBackend'))
    const ready = await startManagedBackend()
    if (!ready) {
      reportStartupFailure(mainLocalization().getFixedT(null, 'foundation')('startup.backendFailed'), backendFailureMessage(mainLocalization().getFixedT(null, 'foundation'), backend?.error ?? lastBackendFailure, 'notReady'))
      stopManagedBackend()
      app.quit()
      return
    }
  }

  try {
    setStartupStatus(mainLocalization().getFixedT(null, 'foundation')('startup.opening'))
    await createWindow()
    const token = updater.pendingUpdateToken()
    if (token) updater.confirmInstalledUpdate(token, pushLog)
    // 更新拉起的新实例把启动闭环绑回本轮 updateId：走到这里时 bootstrap 已等到
    // /api/healthz 且窗口已创建（见上方注释的顺序说明），app-started 与 health-confirmed
    // 各有事实依据，不是同一事件的两份拷贝（提案 108 §5.2）。
    const relaunchedUpdateId = updater.pendingUpdateId()
    if (relaunchedUpdateId) {
      updater.logUpdateLifecycleEvent('app-started', relaunchedUpdateId, pushLog)
      updater.logUpdateLifecycleEvent('health-confirmed', relaunchedUpdateId, pushLog)
    }
    publishUpdateSnapshot(currentUpdateSnapshot())
    // 冷启动时深链可能早于主窗口到达（macOS open-url）：窗口就绪后补消费。
    // 这里的暂存**已经**等价于 proposal 74 §8.4 要的「serve 就绪后再投递」：bootstrap
    // 的顺序是 startManagedBackend（等 /api/healthz 并设好 apiBase）→ createWindow →
    // 才走到这一行，所以被 OS 冷启动的接管方投递时 serve 必然已就绪。真投不出去由
    // handoff-local 的重试耗尽后显式记账，不静默丢弃。
    if (pendingProtocolUrl) {
      const deferred = pendingProtocolUrl
      pendingProtocolUrl = null
      void desktopHandoff.handleCallback(deferred)
    }
  } catch (e) {
    reportStartupFailure(mainLocalization().getFixedT(null, 'foundation')('startup.interfaceFailed'), String(e))
    stopManagedBackend()
    app.quit()
    return
  }

  if (!headless) scheduleStartupUpdateCheck()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      revealMainWindow('renderer session preserved')
      return
    }
    void (async () => {
      if (!(await ensureBackendForWindow())) {
        reportStartupFailure(mainLocalization().getFixedT(null, 'foundation')('startup.backendUnavailable'), backendFailureMessage(mainLocalization().getFixedT(null, 'foundation'), backend?.error ?? lastBackendFailure, 'recovering'))
        return
      }
      await createWindow()
    })().catch((e) => reportStartupFailure(mainLocalization().getFixedT(null, 'foundation')('startup.interfaceFailed'), String(e)))
  })
}

// ---------------------------------------------------------------------------
// scholarseed:// Custom URL Scheme — complete the hosted-account desktop handoff.
// ---------------------------------------------------------------------------

const SCHOLARSEED_PROTOCOL = 'scholarseed'

configureCredentialProvider()

function handleProtocolUrl(url: string): void {
  // Defer a valid account callback until the main window is available.
  if (parseCallbackUrl(url)) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      pendingProtocolUrl = url
      return
    }
    void desktopHandoff.handleCallback(url)
    return
  }
}

const initialProtocolUrl = findCallbackUrl(process.argv)
if (initialProtocolUrl) pendingProtocolUrl = initialProtocolUrl

// 注册为 scholarseed:// 协议的默认处理程序 (需要在 ready 之前请求单例锁)
// Headless acceptance and electron-vite development runs stay isolated; packaged
// launches share one process so the OS callback can be delivered reliably.
const singleInstanceLockRequired = requiresSingleInstanceLock(
  process.env['ELECTRON_RENDERER_URL'],
  headless
)
const gotTheLock = !singleInstanceLockRequired || app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  // Windows/Linux: 第二实例携带 URL Scheme 参数
  if (singleInstanceLockRequired) {
    app.on('second-instance', (_event, argv) => {
      const url = findCallbackUrl(argv)
      if (url) handleProtocolUrl(url)
      else if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  }

  // macOS: 应用已运行时收到 URL Scheme 调用
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url)
  })

  app.whenReady().then(() => {
    installApplicationMenu(Boolean(process.env['ELECTRON_RENDERER_URL']) && !headless)
    // 注册 scholarseed:// 协议
    let protocolRegistered: boolean
    if (process.defaultApp) {
      // 开发模式需要传递脚本路径
      protocolRegistered = app.setAsDefaultProtocolClient(SCHOLARSEED_PROTOCOL, process.execPath, [app.getAppPath()])
    } else {
      protocolRegistered = app.setAsDefaultProtocolClient(SCHOLARSEED_PROTOCOL)
    }
    pushLog(`[shell] protocol ${SCHOLARSEED_PROTOCOL} registration=${protocolRegistered} default=${app.isDefaultProtocolClient(SCHOLARSEED_PROTOCOL)} executable=${process.execPath}\n`)
    return bootstrap()
  }).catch((e) => {
    reportStartupFailure(startupFailureTitle(), String(e))
    stopManagedBackend()
    app.quit()
  })
}

app.on('window-all-closed', () => {
  // On macOS the process stays resident after the last window closes.  Keeping
  // its owned backend alive lets a later Dock activation reopen the same app
  // instead of pointing a fresh window at the dead old localhost port.
  if (process.platform !== MACOS_PLATFORM) app.quit()
})

app.on('before-quit', (event) => {
  if (updateInstallationInProgress && !updateRestartRequested) {
    event.preventDefault()
    mainWindow?.hide()
    pushLog('[update] close requested during staged installation; continuing in background\n')
    return
  }
  appQuitting = true
  stopManagedBackend()
})
