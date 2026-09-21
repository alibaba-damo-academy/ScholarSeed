export const LOCAL_FONTS_PERMISSION = 'local-fonts'
export const CLIPBOARD_READ_PERMISSION = 'clipboard-read'
export const CLIPBOARD_WRITE_PERMISSION = 'clipboard-sanitized-write'
const OFFICE_CLIPBOARD_PERMISSIONS = new Set([
  CLIPBOARD_READ_PERMISSION,
  CLIPBOARD_WRITE_PERMISSION
])
const OFFICE_FRAME_URL = 'about:srcdoc'
// A check handler replaces Chromium's defaults, so re-grant the main frame's clipboard write.
const RENDERER_CLIPBOARD_WRITE_PERMISSIONS = new Set([CLIPBOARD_WRITE_PERMISSION])

export interface PermissionDetails {
  embeddingOrigin?: string
  requestingUrl?: string
  isMainFrame?: boolean
}

type PermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: PermissionDetails
) => boolean

type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: PermissionDetails
) => void

export interface PermissionSession {
  setPermissionCheckHandler(handler: PermissionCheckHandler): void
  setPermissionRequestHandler(handler: PermissionRequestHandler): void
}

export interface OfficeFontPermission {
  requestAccess(): Promise<boolean>
}

function originOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function isOfficeFrame(
  webContents: unknown,
  expectedContents: unknown,
  details: PermissionDetails
): boolean {
  return webContents === expectedContents
    && details.isMainFrame === false
    && details.requestingUrl === OFFICE_FRAME_URL
}

function isRendererMainFrame(
  webContents: unknown,
  expectedContents: unknown,
  requestingOrigin: string,
  rendererOrigin: string | null,
  details: PermissionDetails
): boolean {
  return Boolean(rendererOrigin)
    && webContents === expectedContents
    && details.isMainFrame === true
    && originOf(requestingOrigin) === rendererOrigin
}

export function installOfficeFontPermission(
  session: PermissionSession,
  webContents: unknown,
  rendererUrl: string
): OfficeFontPermission {
  const rendererOrigin = originOf(rendererUrl)

  session.setPermissionCheckHandler((requester, permission, requestingOrigin, details) => {
    if (
      RENDERER_CLIPBOARD_WRITE_PERMISSIONS.has(permission)
      && isRendererMainFrame(requester, webContents, requestingOrigin, rendererOrigin, details)
    ) return true
    const embeddingOrigin = originOf(details.embeddingOrigin)
    if (
      !rendererOrigin
      || !isOfficeFrame(requester, webContents, details)
      || originOf(requestingOrigin) !== rendererOrigin
      || (embeddingOrigin && embeddingOrigin !== rendererOrigin)
    ) return false
    if (OFFICE_CLIPBOARD_PERMISSIONS.has(permission)) return true
    return permission === LOCAL_FONTS_PERMISSION
  })

  const requestAccess = async (): Promise<boolean> => true

  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    if (
      RENDERER_CLIPBOARD_WRITE_PERMISSIONS.has(permission)
      && isRendererMainFrame(requester, webContents, details.requestingUrl ?? '', rendererOrigin, details)
    ) {
      callback(true)
      return
    }
    const embeddingOrigin = originOf(details.embeddingOrigin)
    if (
      !rendererOrigin
      || !isOfficeFrame(requester, webContents, details)
      || (embeddingOrigin && embeddingOrigin !== rendererOrigin)
    ) {
      callback(false)
      return
    }
    if (OFFICE_CLIPBOARD_PERMISSIONS.has(permission)) {
      callback(true)
      return
    }
    if (permission !== LOCAL_FONTS_PERMISSION) {
      callback(false)
      return
    }
    void requestAccess().then(callback)
  })

  return { requestAccess }
}
