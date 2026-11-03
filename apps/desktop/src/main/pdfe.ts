import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { type as systemType, tmpdir } from 'node:os'
import {
  PDFE_CHANNEL,
  PDFE_CONTROL_SIZE,
  PDFE_REQUEST_TIMEOUT_MS,
  PDFE_RESET_PATH,
  PDFE_SHORTCUT,
  PREVIEW_INSTANCE_PARAMETER,
  PREVIEW_SCENE_PARAMETER,
  parsePdfeManifest,
  pdfeTargetUrl,
  readPdfeTarget,
  isPdfeTargetUrl,
  pdfeDockWidth,
  type PdfeDock,
  type PdfeSurface,
  type PdfeTarget,
} from '../pdfe'
import {
  OFFICE_FONT_CATALOG_CHANNEL,
  OFFICE_FONT_READ_CHANNEL,
  OFFICE_FONT_CACHE_READ_CHANNEL,
  OFFICE_FONT_CACHE_WRITE_CHANNEL,
  type OfficeFontCache,
  type NativeFontFace,
} from '../fonts'
import { WINDOW_FULLSCREEN_CHANNEL } from '../window'
import { OfficeFontFiles } from './fontfiles'
import { validateFontCache } from './fontcache'
import { createWorkspaceWindowOptions } from './window'
import { installContentSecurityPolicy, mainWindowContentSecurityPolicy } from './csp'
import { formatSystemVersion } from './system'
import { applyMainLanguage, mainLocalization } from './localization'
import zh from '../../preview/locales/zh.json'
import en from '../../preview/locales/en.json'

const MANIFEST_NAME = 'pdfe.json'
const PRELOAD_NAME = 'preload.cjs'
const PROFILE_PREFIX = 'scholarseed-pdfe-'
const FONT_LIBRARY_NAME = './fonts.node'
const PDFE_NAMESPACE = 'preview'
const manifest = parsePdfeManifest(JSON.parse(readFileSync(join(__dirname, MANIFEST_NAME), 'utf8')))
const nativeFonts = require(FONT_LIBRARY_NAME) as {
  enumerateFonts: () => Promise<NativeFontFace[]>
}
const fonts: OfficeFontFiles = new OfficeFontFiles(() => nativeFonts.enumerateFonts())
const caches = new Map<string, OfficeFontCache>()
const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
const windows = new Map<PdfeSurface, BrowserWindow>()
const views = new Map<PdfeSurface, WebContentsView>()
let dock: PdfeDock = 'docked'
let controlsVisible = true
let dockWidth: number = PDFE_CONTROL_SIZE.width
let target: PdfeTarget = manifest.initial
let navigating = false
let quitting = false

app.setName('PDFE')
app.setPath('userData', profile)
app.setPath('sessionData', profile)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
app.commandLine.appendSwitch('remote-debugging-port', '0')

function allowedUrl(input: string, role: PdfeSurface): boolean {
  return isPdfeTargetUrl(manifest, input, role)
}

function sender(event: IpcMainEvent | IpcMainInvokeEvent, expected?: PdfeSurface): PdfeSurface {
  const role = [...views].find(
    ([, view]) => !view.webContents.isDestroyed() && view.webContents === event.sender
  )?.[0]
  if (
    !role ||
    (expected && role !== expected) ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !allowedUrl(event.senderFrame.url, role)
  )
    throw new Error('Invalid PDFE sender')
  return role
}

function layout(): void {
  const product = windows.get('product')
  const controls = windows.get('controls')
  if (!product || !controls || product.isDestroyed() || controls.isDestroyed()) return
  const [width, height] = product.getContentSize()
  const panel = dock === 'docked' && controlsVisible ? pdfeDockWidth(width, dockWidth) : 0
  views.get('product')?.setBounds({ x: 0, y: 0, width: width - panel, height })
  if (dock === 'docked')
    views
      .get('controls')
      ?.setBounds({ x: width - panel, y: 0, width: panel || PDFE_CONTROL_SIZE.width, height })
  else {
    const [width, height] = controls.getContentSize()
    views.get('controls')?.setBounds({ x: 0, y: 0, width, height })
  }
}

function hideControls(): void {
  controlsVisible = false
  if (dock === 'docked') views.get('controls')?.setVisible(false)
  else windows.get('controls')?.hide()
  layout()
  views.get('product')?.webContents.focus()
}

function showControls(): void {
  const controls = windows.get('controls')
  if (!controls || controls.isDestroyed()) return
  controlsVisible = true
  if (dock === 'docked') {
    views.get('controls')?.setVisible(true)
    layout()
    windows.get('product')?.show()
    views.get('controls')?.webContents.focus()
    return
  }
  if (controls.isMinimized()) controls.restore()
  controls.show()
  controls.focus()
  views.get('controls')?.webContents.focus()
}

async function loadTarget(next: PdfeTarget): Promise<void> {
  target = next
  await Promise.all(
    [...views].map(([role, view]) =>
      view.webContents.loadURL(pdfeTargetUrl(manifest, target, role).href)
    )
  )
}

ipcMain.on(PDFE_CHANNEL.boot, (event) => {
  try {
    const role = sender(event)
    const window = windows.get(role)!
    event.returnValue = {
      kind: role,
      platform: process.platform,
      systemVersion: formatSystemVersion(systemType(), process.getSystemVersion(), process.arch),
      version: app.getVersion(),
      fullscreen: window.isFullScreen(),
      dock,
    }
  } catch {
    event.returnValue = null
  }
})
ipcMain.handle(PDFE_CHANNEL.open, async (event, value: unknown) => {
  sender(event, 'controls')
  if (navigating) throw new Error('PDFE navigation already pending')
  const next = readPdfeTarget(manifest, value)
  navigating = true
  try {
    const url = new URL(PDFE_RESET_PATH, manifest.origin)
    url.searchParams.set(PREVIEW_INSTANCE_PARAMETER, manifest.instance)
    url.searchParams.set(PREVIEW_SCENE_PARAMETER, next.sceneId)
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: next.sceneId, pageId: next.pageId }),
      signal: AbortSignal.timeout(PDFE_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('PDFE scenario reset failed')
    await response.body?.cancel()
    await loadTarget(next)
  } finally {
    navigating = false
  }
})
ipcMain.handle(PDFE_CHANNEL.reload, async (event) => {
  sender(event, 'controls')
  await loadTarget(target)
})
ipcMain.handle(PDFE_CHANNEL.hide, (event) => {
  sender(event, 'controls')
  hideControls()
})
ipcMain.handle(PDFE_CHANNEL.dock, (event, mode: unknown) => {
  sender(event, 'controls')
  if (mode !== 'docked' && mode !== 'detached') throw new Error('Invalid PDFE dock mode')
  if (mode === dock) return
  const product = windows.get('product')!
  const controls = windows.get('controls')!
  const view = views.get('controls')!
  const previous = dock === 'docked' ? product : controls
  const next = mode === 'docked' ? product : controls
  previous.contentView.removeChildView(view)
  next.contentView.addChildView(view)
  dock = mode
  view.setVisible(controlsVisible)
  if (dock === 'docked') controls.hide()
  else if (controlsVisible) controls.show()
  layout()
  view.webContents.send(PDFE_CHANNEL.dockChanged, dock)
  if (controlsVisible) view.webContents.focus()
})
ipcMain.handle(PDFE_CHANNEL.resize, (event, width: unknown) => {
  sender(event, 'controls')
  dockWidth = pdfeDockWidth(windows.get('product')!.getContentSize()[0], width)
  layout()
})
ipcMain.handle(OFFICE_FONT_CATALOG_CHANNEL, (event) => {
  sender(event, 'product')
  return fonts.catalog()
})
ipcMain.handle(OFFICE_FONT_READ_CHANNEL, (event, id: unknown) => {
  sender(event, 'product')
  if (typeof id !== 'string') throw new Error('Invalid PDFE font request')
  return fonts.read(id)
})
ipcMain.handle(OFFICE_FONT_CACHE_READ_CHANNEL, (event, fingerprint: unknown) => {
  sender(event, 'product')
  fonts.assertFingerprint(fingerprint)
  return caches.get(fingerprint as string) ?? null
})
ipcMain.handle(OFFICE_FONT_CACHE_WRITE_CHANNEL, (event, fingerprint: unknown, value: unknown) => {
  sender(event, 'product')
  fonts.assertFingerprint(fingerprint)
  caches.set(fingerprint as string, validateFontCache(value))
})

async function start(): Promise<void> {
  await app.whenReady()
  await applyMainLanguage('zh')
  mainLocalization().addResourceBundle('zh', PDFE_NAMESPACE, zh, true, true)
  mainLocalization().addResourceBundle('en', PDFE_NAMESPACE, en, true, true)
  const translate = mainLocalization().getFixedT(null, PDFE_NAMESPACE as never) as unknown as (
    key: keyof typeof zh
  ) => string
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  )
  for (const role of ['product', 'controls'] as const) {
    const options = createWorkspaceWindowOptions({
      platform: process.platform,
      preload: join(__dirname, PRELOAD_NAME),
    })
    const window = new BrowserWindow({
      ...options,
      ...(role === 'controls'
        ? { ...PDFE_CONTROL_SIZE, titleBarStyle: 'default', trafficLightPosition: undefined }
        : {}),
      title: translate(role === 'product' ? 'productWindowTitle' : 'title'),
      webPreferences: {
        ...options.webPreferences,
        preload: undefined,
        partition: 'pdfe-' + manifest.instance + '-' + role + '-shell',
      },
    })
    windows.set(role, window)
    await window.loadURL('about:blank')
    const view = new WebContentsView({
      webPreferences: {
        ...options.webPreferences,
        partition: 'pdfe-' + manifest.instance + '-' + role,
      },
    })
    views.set(role, view)
    if (role === 'controls')
      view.webContents.on('page-title-updated', (_event, title) => {
        if (!window.isDestroyed()) window.setTitle(title)
      })
    const host = role === 'controls' && dock === 'docked' ? windows.get('product')! : window
    host.contentView.addChildView(view)
    window.on('resize', layout)
    installContentSecurityPolicy(view, mainWindowContentSecurityPolicy(''))
    const session = view.webContents.session
    await session.setProxy({ mode: 'direct' })
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const origin = new URL(manifest.origin)
      const allowed =
        (url.protocol === 'http:' || url.protocol === 'ws:') &&
        url.hostname === origin.hostname &&
        url.port === origin.port
      callback({ cancel: !allowed && !['data:', 'blob:', 'about:'].includes(url.protocol) })
    })
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', (event, url) => {
      if (!allowedUrl(url, role)) event.preventDefault()
    })
    view.webContents.on('before-input-event', (event, input) => {
      if (
        input.type !== 'keyDown' ||
        input.key !== PDFE_SHORTCUT ||
        input.alt ||
        input.control ||
        input.meta ||
        input.shift ||
        input.isAutoRepeat
      )
        return
      event.preventDefault()
      showControls()
    })
    window.on('enter-full-screen', () => view.webContents.send(WINDOW_FULLSCREEN_CHANNEL, true))
    window.on('leave-full-screen', () => view.webContents.send(WINDOW_FULLSCREEN_CHANNEL, false))
    if (role === 'controls')
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault()
          hideControls()
        }
      })
    else window.on('closed', () => app.quit())
  }
  await loadTarget(target)
  layout()
  const product = windows.get('product')!
  const controls = windows.get('controls')!
  const bounds = product.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  controls.setPosition(
    Math.min(bounds.x + bounds.width, area.x + area.width - PDFE_CONTROL_SIZE.width),
    Math.max(bounds.y, area.y)
  )
  product.show()
  if (dock === 'detached') controls.show()
  console.log(
    '[pdfe] native-ready ' +
      JSON.stringify({
        pid: process.pid,
        profile,
        origin: manifest.origin,
        instance: manifest.instance,
      })
  )
}

app.on('before-quit', () => {
  quitting = true
  for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
})
app.on('window-all-closed', () => app.quit())
void start().catch((error) => {
  console.error('[pdfe] startup failed', error)
  app.exit(1)
})
