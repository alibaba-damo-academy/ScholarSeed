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
import {
  systemRendererPreferences,
  persistedRendererPreferences,
  sanitizeRendererPreferences,
  SYSTEM_LANGUAGE_MODE,
} from '../../preferences'
import type { RendererPreferences } from '../../preferences'
import { createBrowserBridge } from './app/browser'

// 由 vite.web.config.ts 的 define 注入；electron-vite 的 renderer dev 地址被普通浏览器
// 直接访问时没有该 define，但仍需要浏览器桥兜底。
declare const __SCHOLARSEED_WEB_VERSION__: string

/** 桌面独有能力不在浏览器实现，交回 renderer 既有的降级分支。 */
const PLATFORM_FALLBACK = 'browser'
// 同源：地址前缀留空，请求由 Vite 的 /api 反代转给 serve（SSE 与 cookie 因此免跨源）。
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

function platform(): string {
  return navigator.platform || PLATFORM_FALLBACK
}

/** 浏览器形态自采 locale 信号：这里没有主进程那条通路，但时区与语言都是纯 Web API。 */
function localeSignals(): LocaleSignals {
  const preferred = navigator.languages
  return {
    timeZone: readTimeZone(),
    languages: preferred.length ? preferred : [navigator.language],
  }
}

/** 与主进程同口径：检测结果只在 localStorage 没存着合法语言时才被采纳。 */
function readPreferences(): RendererPreferences {
  const detected = detectPreferenceLanguage(localeSignals())
  const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
  if (!raw) return systemRendererPreferences(detected)
  try {
    return sanitizeRendererPreferences(JSON.parse(raw), detected)
  } catch {
    return systemRendererPreferences(detected)
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

if (!window.scholarseed) {
  let currentPreferences = readPreferences()
  window.scholarseed = createBrowserBridge({
    platform: platform(),
    version: WEB_VERSION,
    preferences: currentPreferences,
    reconcilePreferences: async () => {
      const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
      const detected = detectPreferenceLanguage(localeSignals())
      currentPreferences =
        raw === null
          ? systemRendererPreferences(detected)
          : sanitizeRendererPreferences(JSON.parse(raw), detected)
      return currentPreferences
    },
    savePreferences: async (preferences) => {
      const language =
        currentPreferences.languageMode === SYSTEM_LANGUAGE_MODE
          ? preferences.language
          : detectPreferenceLanguage(localeSignals())
      const sanitized = sanitizeRendererPreferences(preferences, language)
      window.localStorage.setItem(
        PREFERENCES_STORAGE_KEY,
        JSON.stringify(persistedRendererPreferences(sanitized))
      )
      currentPreferences = sanitized
      return sanitized
    },
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    saveFileCopy: async ({ suggestedName, bytes }) => {
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
    setAuthToken: async (token) => {
      document.cookie = token
        ? `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}; Path=${AUTH_COOKIE_PATH}; SameSite=Lax`
        : `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=${AUTH_COOKIE_PATH}`
      return { ok: true }
    },
    getAuthToken: async () => readCookie(AUTH_COOKIE_NAME),
    getDeviceInfo: async () => deviceInfo(),
    fetch: (...args) => fetch(...args),
  }) as ScholarSeedBridge
}
