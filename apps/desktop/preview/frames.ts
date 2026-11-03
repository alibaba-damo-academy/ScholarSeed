import { isOfficeFrameToken, type OfficeFrameFactory } from '../src/renderer/src/features/workbench/office/transport.ts'

export const PREVIEW_OFFICE_FRAME_PATH = '/__preview/office-frame'
const FRAME_TOKEN_PARAMETER = 'token'
const FRAME_LOCALE_PARAMETER = 'locale'
const FRAME_PARAMETERS = new Set([FRAME_TOKEN_PARAMETER, FRAME_LOCALE_PARAMETER])

export interface PreviewOfficeFrameParameters {
  token: string
  locale: 'zh' | 'en'
}

export function previewOfficeFrameParameters(url: URL): PreviewOfficeFrameParameters {
  const token = url.searchParams.get(FRAME_TOKEN_PARAMETER) ?? ''
  const locale = url.searchParams.get(FRAME_LOCALE_PARAMETER)
  if (url.pathname !== PREVIEW_OFFICE_FRAME_PATH || !isOfficeFrameToken(token)
    || (locale !== 'zh' && locale !== 'en') || url.searchParams.size !== FRAME_PARAMETERS.size
    || [...url.searchParams.keys()].some(key => !FRAME_PARAMETERS.has(key)) || url.hash) {
    throw new Error('Invalid preview Office frame request')
  }
  return { token, locale }
}

export function previewOfficeFrameUrl(origin: string, parameters: PreviewOfficeFrameParameters): URL {
  const url = new URL(PREVIEW_OFFICE_FRAME_PATH, origin)
  url.searchParams.set(FRAME_TOKEN_PARAMETER, parameters.token)
  url.searchParams.set(FRAME_LOCALE_PARAMETER, parameters.locale)
  previewOfficeFrameParameters(url)
  return url
}

export const previewOfficeFrameFactory: OfficeFrameFactory = request => {
  const token = crypto.randomUUID()
  return { kind: 'url', token, src: previewOfficeFrameUrl(window.location.origin, { token, locale: request.language }).href, dispose() {} }
}

export function attachPreviewOfficeCleanup(target: Window, parentWindow: Window, token: string, dispose: () => void): () => void {
  let disposed = false
  const close = (): void => {
    if (disposed) return
    disposed = true
    target.removeEventListener('message', receive)
    target.removeEventListener('pagehide', close)
    dispose()
  }
  const receive = (event: MessageEvent): void => {
    if (event.source === parentWindow && event.origin === target.location.origin
      && event.data?.kind === 'scholarseed-office-control' && event.data?.token === token
      && event.data?.type === 'dispose') close()
  }
  target.addEventListener('message', receive)
  target.addEventListener('pagehide', close, { once: true })
  return close
}
