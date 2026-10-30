import { createBrowserBridge } from '../src/renderer/src/app/browser.ts'
import { sanitizeRendererPreferences, type RendererPreferences } from '../src/preferences.ts'
import { PREVIEW_CATALOG, type PreviewScenario } from './catalog.ts'
import { setAccountBase } from '../src/renderer/src/account.ts'
import { previewAccountBase, previewAccountMode, readPreviewAccountBootstrap, type PreviewAccountBootstrap, type PreviewAccountMode } from './accounts.ts'
import { PREVIEW_STORAGE_READ, previewDirectoryPicker, readPreviewStorageBootstrap, type PreviewStorageBootstrap } from './directory.ts'
import { PREVIEW_ROOTS_PATH, PREVIEW_ROOT_MODES, previewRootUpdate } from './roots.ts'
import { PREVIEW_BROWSER } from './browser.ts'
import type { BrowserBridge } from '../src/browser.ts'
import { PREVIEW_INSTANCE_PARAMETER, PREVIEW_SCENE_PARAMETER, PREVIEW_PAGE_PARAMETER, type PdfeNativeBridge } from '../src/pdfe.ts'

export { PREVIEW_INSTANCE_PARAMETER, PREVIEW_SCENE_PARAMETER, PREVIEW_PAGE_PARAMETER } from '../src/pdfe.ts'
export const DEFAULT_PREVIEW_SCENE = 'page-home'
export const PREVIEW_DIAGNOSTIC_EVENT = 'scholarseed-preview-diagnostic'
const PREVIEW_STATE_PATH = '/__preview/state'
const PREVIEW_PLATFORM = 'browser'
const PREVIEW_VERSION = 'preview'
const PREVIEW_DEVICE_LABEL = 'ScholarSeed Preview'
const PREVIEW_DOWNLOAD_UNAVAILABLE = 'preview_download_unavailable'
const PREVIEW_PERMISSIONS_DELAY_MS = 2_000
const PREVIEW_PERMISSIONS_FAILURE = 'preview_permissions_query_failed'
const PREVIEW_ACCOUNT_CREDENTIALS_READONLY = 'preview_account_credentials_readonly'
const BROWSER_ROUTES = { policy: 'policy', history: 'history', clearData: 'data', snapshot: 'snapshot', dispatch: 'command' } as const

export interface PreviewBridgeOptions {
  native?: PdfeNativeBridge
  fonts?: Pick<PdfeNativeBridge, 'requestOfficeFontAccess' | 'listOfficeFonts' | 'readOfficeFont' | 'readOfficeFontCache' | 'writeOfficeFontCache'>
  instance: string
  scene: string
  pageId?: string
  preferences: RendererPreferences
  simulation?: Pick<NonNullable<PreviewScenario['simulation']>, 'permissions' | 'account' | 'browser'>
  account?: PreviewAccountBootstrap
  storage?: PreviewStorageBootstrap
  request: typeof fetch
  diagnostic?: (detail: { kind: string }) => void
}

function previewScenario(scene: string, pageId?: string): PreviewScenario | undefined {
  const page = pageId === undefined
    ? PREVIEW_CATALOG.find(candidate => candidate.id === scene || candidate.scenarios.some(item => item.id === scene))
    : PREVIEW_CATALOG.find(candidate => candidate.id === pageId)
  return page?.scenarios.find(candidate => candidate.id === scene)
    ?? (page?.id === scene ? page.scenarios[0] : undefined)
}

export function previewScenarioSimulation(scene: string, pageId?: string): PreviewScenario['simulation'] {
  return previewScenario(scene, pageId)?.simulation
}

export function previewStatePath(instance: string, scene: string, pageId?: string): string {
  const query = new URLSearchParams({ [PREVIEW_INSTANCE_PARAMETER]: instance, [PREVIEW_SCENE_PARAMETER]: scene })
  if (pageId !== undefined) query.set(PREVIEW_PAGE_PARAMETER, pageId)
  return `${PREVIEW_STATE_PATH}?${query}`
}

async function readPreviewPayload(response: Response): Promise<{ preferences: RendererPreferences; account?: unknown; storage?: unknown }> {
  const state: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = state && typeof state === 'object'
      ? ['code', 'pageId', 'scene'].flatMap(key => key in state && typeof state[key as keyof typeof state] === 'string' ? [state[key as keyof typeof state]] : []).join(' · ')
      : ''
    throw new Error(`Preview request failed: ${response.status}${detail ? ` · ${detail}` : ''}`)
  }
  if (!state || typeof state !== 'object' || !('preferences' in state) || !state.preferences || typeof state.preferences !== 'object') {
    throw new Error('Preview preferences response is invalid')
  }
  return { preferences: sanitizeRendererPreferences(state.preferences), ...('account' in state ? { account: state.account } : {}), ...('storage' in state ? { storage: state.storage } : {}) }
}

export async function readPreviewState(response: Response): Promise<RendererPreferences> {
  return (await readPreviewPayload(response)).preferences
}

export async function readPreviewAccountState(response: Response, instance: string, mode?: PreviewAccountMode): Promise<{ preferences: RendererPreferences; account?: PreviewAccountBootstrap }> {
  const payload = await readPreviewPayload(response)
  return { preferences: payload.preferences, account: readPreviewAccountBootstrap(payload.account, instance, mode) }
}

export function createPreviewBridge(options: PreviewBridgeOptions): ReturnType<typeof createBrowserBridge> {
  const account = readPreviewAccountBootstrap(options.account, options.instance, options.simulation?.account)
  const storage = options.storage ? readPreviewStorageBootstrap(options.storage) : undefined
  let capability = account?.capability ?? ''
  let preferences = sanitizeRendererPreferences(options.preferences)
  const requestPreferences = async (init?: RequestInit): Promise<RendererPreferences> => {
    const response = await options.request(previewStatePath(options.instance, options.scene, options.pageId), init)
    preferences = await readPreviewState(response)
    return preferences
  }
  const synchronize = async (value: unknown): Promise<boolean> => {
    const update = previewRootUpdate(value)
    let accepted = false
    if (update) {
      try {
        const query = new URLSearchParams({ [PREVIEW_INSTANCE_PARAMETER]: options.instance })
        const response = await options.request(`${PREVIEW_ROOTS_PATH}?${query}`, {
          method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update),
        })
        const payload: unknown = await response.json()
        accepted = response.ok && !!payload && typeof payload === 'object' && 'ok' in payload && payload.ok === true
      } catch { accepted = false }
    }
    options.diagnostic?.({ kind: accepted ? 'virtual-roots-synchronized' : 'virtual-roots-rejected' })
    return accepted
  }
  const browser = createBrowserBridge({
    platform: options.native?.platform ?? PREVIEW_PLATFORM,
    version: options.native?.version ?? PREVIEW_VERSION,
    preferences,
    reconcilePreferences: async () => requestPreferences(),
    savePreferences: async (value) => requestPreferences({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences: sanitizeRendererPreferences(value) }),
    }),
    getAuthToken: async () => capability,
    setAuthToken: async (token) => {
      if (token) return { ok: false, error: PREVIEW_ACCOUNT_CREDENTIALS_READONLY }
      capability = ''
      return { ok: true }
    },
    getDeviceInfo: async () => ({ device_id: options.instance, device_label: PREVIEW_DEVICE_LABEL }),
    openExternal: async () => { options.diagnostic?.({ kind: 'external-navigation-blocked' }) },
    saveFileCopy: async () => {
      options.diagnostic?.({ kind: 'download-blocked' })
      return { ok: false, error: PREVIEW_DOWNLOAD_UNAVAILABLE }
    },
    fetch: (input, init) => options.request(input, { ...init, credentials: 'omit' }),
  })
  const browserRequest = async <Key extends keyof typeof BROWSER_ROUTES>(key: Key, value: unknown = {}): Promise<Awaited<ReturnType<BrowserBridge[Key]>>> => {
    const query = new URLSearchParams({ [PREVIEW_INSTANCE_PARAMETER]: options.instance })
    const response = await options.request(`${PREVIEW_BROWSER.path}/${BROWSER_ROUTES[key]}?${query}`, {
      method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    })
    if (!response.ok) throw new Error(`Preview browser request failed: ${response.status}`)
    return response.json()
  }
  return {
    ...browser,
    ...(options.simulation?.browser ? { browser: {
      ...browser.browser,
      policy: value => browserRequest('policy', value),
      history: value => browserRequest('history', value),
      clearData: value => browserRequest('clearData', value),
      ...(options.simulation.browser.surface ? {
        snapshot: () => browserRequest('snapshot'),
        dispatch: value => browserRequest('dispatch', value),
      } : {}),
    } satisfies BrowserBridge } : {}),
    ...(options.native ? {
      systemVersion: options.native.systemVersion,
      fullscreen: options.native.fullscreen,
      onFullscreenChange: options.native.onFullscreenChange,
      requestOfficeFontAccess: options.native.requestOfficeFontAccess,
      listOfficeFonts: options.native.listOfficeFonts,
      readOfficeFont: options.native.readOfficeFont,
      readOfficeFontCache: options.native.readOfficeFontCache,
      writeOfficeFontCache: options.native.writeOfficeFontCache,
    } : options.fonts ?? {}),
    syncAuthorizedRoots: async (scope, roots) => synchronize({ scope, roots, mode: PREVIEW_ROOT_MODES.replace }),
    addAuthorizedRoot: async (scope, root) => synchronize({ scope, roots: [root], mode: PREVIEW_ROOT_MODES.add }),
    storageConfig: async () => {
      if (!storage) return browser.storageConfig()
      const response = await options.request(`${PREVIEW_STORAGE_READ.configPath}?previewInstance=${encodeURIComponent(options.instance)}`, { credentials: 'omit', cache: 'no-store' })
      if (!response.ok) {
        await response.text()
        throw new Error(`Preview storage read failed: ${response.status}`)
      }
      return readPreviewStorageBootstrap({ config: await response.json(), choices: storage.choices }).config
    },
    pickDir: async () => {
      options.diagnostic?.({ kind: 'virtual-directory-picker-opened' })
      const path = storage ? await previewDirectoryPicker.pick(storage.choices) : null
      options.diagnostic?.({ kind: path === null ? 'virtual-directory-picker-cancelled' : 'virtual-directory-picker-selected' })
      return path
    },
    systemPermissions: async () => {
      const mode = options.simulation?.permissions ?? 'normal'
      options.diagnostic?.({ kind: `permissions-${mode}` })
      if (mode === 'failed') throw new Error(PREVIEW_PERMISSIONS_FAILURE)
      if (mode === 'delayed') await new Promise<void>(resolve => setTimeout(resolve, PREVIEW_PERMISSIONS_DELAY_MS))
      return browser.systemPermissions()
    },
  }
}

export async function installPreviewBridge(): Promise<void> {
  const url = new URL(window.location.href)
  const instance = url.searchParams.get(PREVIEW_INSTANCE_PARAMETER) || crypto.randomUUID()
  const scene = url.searchParams.get(PREVIEW_SCENE_PARAMETER) || DEFAULT_PREVIEW_SCENE
  const pageId = url.searchParams.get(PREVIEW_PAGE_PARAMETER) ?? undefined
  url.searchParams.set(PREVIEW_INSTANCE_PARAMETER, instance)
  window.history.replaceState(null, '', url)
  const response = await fetch(previewStatePath(instance, scene, pageId), { credentials: 'omit' })
  const scenario = previewScenario(scene, pageId)
  const payload = await readPreviewPayload(response)
  const mode = previewAccountMode(payload.account, scenario?.simulation?.account, !scenario?.simulation?.account)
  const simulation = mode ? { ...scenario?.simulation, account: mode } : scenario?.simulation
  const preferences = payload.preferences
  const account = readPreviewAccountBootstrap(payload.account, instance, simulation?.account)
  const storage = readPreviewStorageBootstrap(payload.storage)
  window.scholarseed = createPreviewBridge({
    native: window.pdfe,
    instance,
    scene,
    pageId,
    preferences,
    simulation,
    account,
    storage,
    request: (...args) => fetch(...args),
    diagnostic: (detail) => window.dispatchEvent(new CustomEvent(PREVIEW_DIAGNOSTIC_EVENT, { detail })),
  }) as ScholarSeedBridge
  setAccountBase(previewAccountBase(window.location.origin, account))
}
