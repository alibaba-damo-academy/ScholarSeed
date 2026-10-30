import type { OfficeFontCache, OfficeFontCatalog } from './fonts.ts'

export const PDFE_CHANNEL = {
  boot: 'scholarseed:pdfe-boot',
  open: 'scholarseed:pdfe-open',
  reload: 'scholarseed:pdfe-reload',
  hide: 'scholarseed:pdfe-hide',
  dock: 'scholarseed:pdfe-dock',
  dockChanged: 'scholarseed:pdfe-dock-changed',
  resize: 'scholarseed:pdfe-resize',
} as const
export const PDFE_SURFACE_PARAMETER = 'pdfe'
export const PREVIEW_INSTANCE_PARAMETER = 'previewInstance'
export const PREVIEW_SCENE_PARAMETER = 'scene'
export const PREVIEW_PAGE_PARAMETER = 'page'
export const PDFE_SHORTCUT = 'F8'
export const PDFE_CONTROL_SIZE = { width: 420, height: 840, minWidth: 320, minHeight: 520 } as const
export const PDFE_DOCK_STEP = 20
export const PDFE_RESET_PATH = '/__preview/reset'
export const PDFE_REQUEST_TIMEOUT_MS = 10_000
const PDFE_SCHEMA = 1
const PDFE_ID = /^[a-zA-Z0-9_-]{1,96}$/

export type PdfeSurface = 'product' | 'controls'
export type PdfeDock = 'docked' | 'detached'
export interface PdfeTarget {
  pageId: string
  sceneId: string
}
export interface PdfePage {
  id: string
  scenes: string[]
  available: boolean
  components: boolean
}
export interface PdfeManifest {
  schema: 1
  origin: string
  instance: string
  initial: PdfeTarget
  pages: PdfePage[]
}
export interface PdfeNativeBridge {
  kind: PdfeSurface
  platform: string
  systemVersion: string
  version: string
  fullscreen: boolean
  dock: PdfeDock
  openScenario: (target: PdfeTarget) => Promise<void>
  reload: () => Promise<void>
  hideControls: () => Promise<void>
  setDock: (mode: PdfeDock) => Promise<void>
  resizeControls: (width: number) => Promise<void>
  onDockChange: (callback: (mode: PdfeDock) => void) => () => void
  onFullscreenChange: (callback: (value: boolean) => void) => () => void
  requestOfficeFontAccess: () => Promise<boolean>
  listOfficeFonts: () => Promise<OfficeFontCatalog>
  readOfficeFont: (id: string) => Promise<Uint8Array>
  readOfficeFontCache: (fingerprint: string) => Promise<OfficeFontCache | null>
  writeOfficeFontCache: (fingerprint: string, cache: OfficeFontCache) => Promise<void>
}

export function pdfeDockWidth(available: number, requested: unknown): number {
  if (
    !Number.isFinite(available) ||
    available <= 0 ||
    typeof requested !== 'number' ||
    !Number.isFinite(requested)
  )
    throw new Error('Invalid PDFE dock width')
  return Math.round(
    Math.min(Math.floor(available / 2), Math.max(PDFE_CONTROL_SIZE.minWidth, requested))
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function readPdfeTarget(manifest: PdfeManifest, value: unknown): PdfeTarget {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.pageId !== 'string' ||
    typeof value.sceneId !== 'string'
  )
    throw new Error('Invalid PDFE target')
  const page = manifest.pages.find((page) => page.id === value.pageId)
  if (!page?.available || !page.scenes.includes(value.sceneId))
    throw new Error('Unknown PDFE target')
  return { pageId: value.pageId, sceneId: value.sceneId }
}

export function parsePdfeManifest(value: unknown): PdfeManifest {
  if (
    !record(value) ||
    value.schema !== PDFE_SCHEMA ||
    typeof value.origin !== 'string' ||
    typeof value.instance !== 'string' ||
    !PDFE_ID.test(value.instance) ||
    !Array.isArray(value.pages) ||
    !value.pages.length
  )
    throw new Error('Invalid PDFE manifest')
  const origin = new URL(value.origin)
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.origin !== value.origin
  )
    throw new Error('Invalid PDFE origin')
  const pages = value.pages.map((page: unknown): PdfePage => {
    if (
      !record(page) ||
      typeof page.id !== 'string' ||
      !PDFE_ID.test(page.id) ||
      typeof page.available !== 'boolean' ||
      typeof page.components !== 'boolean' ||
      !Array.isArray(page.scenes) ||
      !page.scenes.length ||
      page.scenes.some((scene) => typeof scene !== 'string' || !PDFE_ID.test(scene)) ||
      new Set(page.scenes).size !== page.scenes.length
    )
      throw new Error('Invalid PDFE catalog projection')
    return {
      id: page.id,
      scenes: [...page.scenes] as string[],
      available: page.available,
      components: page.components,
    }
  })
  if (new Set(pages.map((page) => page.id)).size !== pages.length)
    throw new Error('Duplicate PDFE page')
  const manifest: PdfeManifest = {
    schema: PDFE_SCHEMA,
    origin: origin.origin,
    instance: value.instance,
    initial: { pageId: '', sceneId: '' },
    pages,
  }
  manifest.initial = readPdfeTarget(manifest, value.initial)
  return manifest
}

export function pdfeTargetUrl(manifest: PdfeManifest, value: unknown, surface: PdfeSurface): URL {
  const target = readPdfeTarget(manifest, value)
  const url = new URL(manifest.origin)
  url.searchParams.set(PREVIEW_INSTANCE_PARAMETER, manifest.instance)
  url.searchParams.set(PREVIEW_PAGE_PARAMETER, target.pageId)
  url.searchParams.set(PREVIEW_SCENE_PARAMETER, target.sceneId)
  url.searchParams.set(PDFE_SURFACE_PARAMETER, surface)
  if (surface === 'product' && manifest.pages.find((page) => page.id === target.pageId)?.components)
    url.searchParams.set('dev', 'components')
  return url
}

export function isPdfeTargetUrl(
  manifest: PdfeManifest,
  input: string,
  surface: PdfeSurface
): boolean {
  try {
    const url = new URL(input)
    if (url.origin !== manifest.origin || url.username || url.password || url.pathname !== '/')
      return false
    const expected = pdfeTargetUrl(
      manifest,
      {
        pageId: url.searchParams.get(PREVIEW_PAGE_PARAMETER),
        sceneId: url.searchParams.get(PREVIEW_SCENE_PARAMETER),
      },
      surface
    )
    return (
      url.searchParams.size === expected.searchParams.size &&
      [...expected.searchParams].every(([key, value]) => url.searchParams.get(key) === value)
    )
  } catch {
    return false
  }
}
