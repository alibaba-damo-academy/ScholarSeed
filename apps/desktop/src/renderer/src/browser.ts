/**
 * 浏览器模式下的 `window.scholarseed` 桥 —— 只在没有 Electron preload 时装载。
 *
 * `npm run dev:web` 用它在普通浏览器里跑真实 renderer + 真实 `scholarseed serve`：
 * HTTP/SSE 走 Vite 的 /api 同源反代，账号令牌落同源 cookie（与桌面端 session
 * cookie 同名，serve 的鉴权因此照常生效），原生能力（打开文件 / 废纸篓 / 系统权限 /
 * 自动更新）按「不支持」如实返回，不假装成功。
 *
 * 桌面端独有的入口（writeClipboard / pickImport）故意不实现：renderer 对
 * 这两个是「有则用、无则降级」的存在性判断，缺席正好走到浏览器自身的降级路径。
 */

import { detectPreferenceLanguage, readTimeZone } from '../../locale'
import type { LocaleSignals } from '../../locale'
import { defaultRendererPreferences, sanitizeRendererPreferences } from '../../preferences'
import type { RendererPreferences } from '../../preferences'
import { unavailablePermissionRecords } from '../../permissions'
import { skillRequest } from '../../skills'
import { FEEDBACK_CAPTURE_ERROR } from '../../feedback'

// 由 vite.web.config.ts 的 define 注入；electron-vite 的 renderer dev 地址被普通浏览器
// 直接访问时没有该 define，但仍需要浏览器桥兜底。
declare const __SCHOLARSEED_WEB_VERSION__: string

/** 桌面独有能力不在浏览器实现，交回 renderer 既有的降级分支。 */
type BrowserBridge = Omit<
  ScholarSeedBridge,
  'writeClipboard' | 'writeClipboardContent' | 'pasteClipboard' | 'pickImport' | 'trashToken' | 'openTrash' | 'acquireOfficeImage'
>
type UpdateState = Awaited<ReturnType<ScholarSeedBridge['getUpdateState']>>

const UNSUPPORTED_TEXT = '浏览器模式不支持该原生能力，请使用桌面端。'
const PLATFORM_FALLBACK = 'browser'
const WEB_CHANNEL = 'web'
// 同源：地址前缀留空，请求由 Vite 的 /api 反代转给 serve（SSE 与 cookie 因此免跨源）。
const SAME_ORIGIN_API_BASE = ''
const PREFERENCES_STORAGE_KEY = 'scholarseed.web.preferences'
const DEVICE_STORAGE_KEY = 'scholarseed.web.device'
const DEVICE_LABEL = 'ScholarSeed Web'
const AUTH_COOKIE_NAME = 'scholarseed_token'
const AUTH_COOKIE_PATH = '/'
const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 3600
const COOKIE_SEPARATOR = '; '
const COOKIE_ASSIGN = '='
const WEB_VERSION =
  typeof __SCHOLARSEED_WEB_VERSION__ === 'string' ? __SCHOLARSEED_WEB_VERSION__ : 'dev'

const noop = (): void => undefined
const unsubscribe = (): (() => void) => noop

function platform(): string {
  return navigator.platform || PLATFORM_FALLBACK
}

/** 浏览器形态自采 locale 信号：这里没有主进程那条通路，但时区与语言都是纯 Web API。 */
function localeSignals(): LocaleSignals {
  const preferred = navigator.languages
  return {
    timeZone: readTimeZone(),
    languages: preferred.length ? preferred : [navigator.language]
  }
}

/** 与主进程同口径：检测结果只在 localStorage 没存着合法语言时才被采纳。 */
function readPreferences(): RendererPreferences {
  const detected = detectPreferenceLanguage(localeSignals())
  const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
  if (!raw) return defaultRendererPreferences(detected)
  try {
    return sanitizeRendererPreferences(JSON.parse(raw), detected)
  } catch {
    return defaultRendererPreferences(detected)
  }
}

function readCookie(name: string): string {
  const entry = document.cookie
    .split(COOKIE_SEPARATOR)
    .find((item) => item.startsWith(name + COOKIE_ASSIGN))
  return entry ? decodeURIComponent(entry.slice(name.length + COOKIE_ASSIGN.length)) : ''
}

function deviceInfo(): { device_id: string; device_label: string } {
  const stored = window.localStorage.getItem(DEVICE_STORAGE_KEY)
  if (stored) return { device_id: stored, device_label: DEVICE_LABEL }
  const created = crypto.randomUUID()
  window.localStorage.setItem(DEVICE_STORAGE_KEY, created)
  return { device_id: created, device_label: DEVICE_LABEL }
}

function upToDate(): UpdateState {
  return { phase: 'up-to-date', currentVersion: __SCHOLARSEED_WEB_VERSION__ }
}

const bridge: BrowserBridge = {
  subscriptionLogin: async () => ({ available: false }),
  getApiBase: () => SAME_ORIGIN_API_BASE,
  deviceSkills: async (request) => {
    const { path, init } = skillRequest(request)
    const response = await fetch(`${SAME_ORIGIN_API_BASE}${path}`, { ...init, credentials: 'include' })
    return { status: response.status, body: await response.text() }
  },
  platform: platform(),
  shoot: false,
  backlog: '',
  version: WEB_VERSION,
  buildNumber: '',
  channel: WEB_CHANNEL,
  developerToolsEnabled: false,
  feedbackRecorderEnabled: false,
  captureFeedbackScreenshot: async () => ({ ok: false, error: FEEDBACK_CAPTURE_ERROR.failed }),
  writeClipboardImage: async () => ({ ok: false, error: 'clipboard_image_write_unavailable' }),
  readOfficeClipboard: async () => ({ ok: false, error: 'clipboard_failed' }),
  preferences: readPreferences(),
  reconcilePreferences: async () => {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    const detected = detectPreferenceLanguage(localeSignals())
    return raw === null ? defaultRendererPreferences(detected) : sanitizeRendererPreferences(JSON.parse(raw), detected)
  },
  savePreferences: async (preferences) => {
    const sanitized = sanitizeRendererPreferences(preferences)
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(sanitized))
    return sanitized
  },
  systemPermissions: async () => ({
    platform: platform(),
    permissions: unavailablePermissionRecords()
  }),
  openSystemPermission: async () => false,
  showNotification: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
  playAlertSound: async () => false,
  onNotificationClick: unsubscribe,
  // 目录授权是给主进程的原生文件访问兜底的；浏览器里没有那条通路，也就无从「授权失败」，
  // 如实回 true，别把桌面端的权限提示搬到浏览器上误导用户。
  syncAuthorizedRoots: async () => true,
  addAuthorizedRoot: async () => true,
  onBackendLog: unsubscribe,
  onShootScene: unsubscribe,
  onSay: unsubscribe,
  openExternal: async (url) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  openPath: async () => ({ ok: false, error: UNSUPPORTED_TEXT, applicationFailure: { code: 'desktop_bridge_unavailable' } }),
  revealPath: async () => ({ ok: false, error: UNSUPPORTED_TEXT, applicationFailure: { code: 'desktop_bridge_unavailable' } }),
  appsForFile: async () => [],
  openPathWith: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
  pickDir: async () => null,
  pickExecutable: async () => null,
  /** 浏览器里「另存副本」就是一次下载：交给浏览器的下载目录，不碰用户磁盘路径。 */
  saveFileCopy: async ({ suggestedName, bytes }) => {
    // 复制一份再包 Blob：入参可能是带偏移的视图，直接交 buffer 会把整块底层内存写下去。
    const payload = new Uint8Array(bytes.byteLength)
    payload.set(bytes)
    const url = URL.createObjectURL(new Blob([payload.buffer]))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = suggestedName
    anchor.click()
    URL.revokeObjectURL(url)
    return { ok: true, path: suggestedName }
  },
  requestOfficeFontAccess: async () => false,
  /** access 落同源 cookie 供 serve 的 fetch/SSE 鉴权；refresh 无处安全落盘，浏览器模式不做静默续期。 */
  setAuthToken: async (token) => {
    document.cookie = token
      ? `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}; Path=${AUTH_COOKIE_PATH}; SameSite=Lax`
      : `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=${AUTH_COOKIE_PATH}`
    return { ok: true }
  },
  getAuthToken: async () => readCookie(AUTH_COOKIE_NAME),
  getDeviceInfo: async () => deviceInfo(),
  // 桌面登录交接是主进程能力（深链回跳）：浏览器形态没有这条通路。
  // claimLanding 恒 false —— 桌面冷启动首页只属于桌面端。
  desktopLoginStart: async () => ({ ok: false, error: UNSUPPORTED_TEXT, applicationFailure: { code: 'native_unavailable' } }),
  desktopLoginCancel: async () => ({ ok: true }),
  desktopAuthState: async () => ({ phase: 'idle' as const }),
  desktopAuthAdoptedAck: async () => ({ ok: true }),
  onDesktopAuth: unsubscribe,
  claimLanding: async () => false,
  setLoginWindowVisible: async () => {},
  landingDismiss: async () => ({ ok: true }),
  onLandingReopen: unsubscribe,
  getUpdateState: async () => upToDate(),
  checkUpdate: async () => upToDate(),
  // 浏览器形态没有更新通路（恒 upToDate、从不带候选包），静默刷新如实无操作。
  refreshUpdate: async () => {},
  // 浏览器形态没有组件 store（Windows 组件化载荷专属），如实返回 null。
  runtimeStorePath: async () => null,
  diagnoseUpdate: async () => ({
    url: '',
    releaseLane: 'local',
    policy: { productId: '', bundleId: '', expectedTeamId: '', channel: '' },
    server: null,
    mismatches: [],
    error: UNSUPPORTED_TEXT
  }),
  startUpdate: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
  installUpdate: async () => ({ ok: false, error: UNSUPPORTED_TEXT }),
  // 浏览器形态恒 upToDate、从不带候选包，没有可确认的弹窗；false 是如实回答。
  acknowledgeUpdateAnnouncement: async () => false,
  onUpdateState: unsubscribe
}

if (!window.scholarseed) window.scholarseed = bridge as ScholarSeedBridge
