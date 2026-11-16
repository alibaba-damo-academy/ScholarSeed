const PDF_MIME = 'application/pdf'
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'
const PDF_VIEWER_DOCUMENT = `${PDF_VIEWER_ORIGIN}/index.html`
const PDF_EMBEDDER_STYLESHEET = `${PDF_VIEWER_ORIGIN}/pdf_embedder.css`
const CHROMIUM_RESOURCES = 'chrome://resources/'
const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const HTTP_OK_MIN = 200
const HTTP_OK_LIMIT = 300
const GET_METHOD = 'GET'

interface PdfFrame {
  url: string
  frameTreeNodeId: number
  detached: boolean
  parent: PdfFrame | null
  top: PdfFrame | null
}

interface PdfRequest {
  url: string
  method: string
  resourceType: string
  frame?: PdfFrame | null
}

interface PdfResponse extends PdfRequest {
  statusCode: number
  responseHeaders?: Record<string, string[]>
}

function documentUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (!WEB_PROTOCOLS.has(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function viewerResource(input: string): boolean {
  return input.startsWith(`${PDF_VIEWER_ORIGIN}/`) || input.startsWith(CHROMIUM_RESOURCES)
}

export function createPdfViewerPolicy() {
  let document: { url: string; frameId: number } | null = null
  const currentFrame = (frame: PdfFrame | null | undefined): frame is PdfFrame =>
    Boolean(
      document &&
      frame &&
      !frame.detached &&
      frame.top &&
      !frame.top.detached &&
      frame.top.frameTreeNodeId === document.frameId &&
      frame.top.url &&
      documentUrl(frame.top.url) === document.url
    )
  const viewerFrame = (frame: PdfFrame): boolean =>
    frame.url === PDF_VIEWER_DOCUMENT && frame.parent?.frameTreeNodeId === document?.frameId
  return {
    reset() {
      document = null
    },
    response(details: PdfResponse) {
      if (details.resourceType !== 'mainFrame') return
      document = null
      const headers = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {}).map(([name, values]) => [
          name.toLowerCase(),
          values.join(';'),
        ])
      )
      const url = documentUrl(details.url)
      if (
        url &&
        details.frame &&
        !details.frame.detached &&
        details.method === GET_METHOD &&
        details.statusCode >= HTTP_OK_MIN &&
        details.statusCode < HTTP_OK_LIMIT &&
        headers['content-type']?.split(';')[0].trim().toLowerCase() === PDF_MIME &&
        headers['content-disposition']?.split(';')[0].trim().toLowerCase() !== 'attachment'
      )
        document = { url, frameId: details.frame.frameTreeNodeId }
    },
    allows(details: PdfRequest): boolean {
      const frame = details.frame
      if (details.method !== GET_METHOD || !currentFrame(frame)) return false
      if (details.resourceType === 'mainFrame') return false
      if (frame.frameTreeNodeId === document!.frameId)
        return details.resourceType === 'stylesheet' && details.url === PDF_EMBEDDER_STYLESHEET
      if (details.resourceType === 'subFrame')
        return (
          frame.parent?.frameTreeNodeId === document!.frameId && details.url === PDF_VIEWER_DOCUMENT
        )
      return viewerFrame(frame) && (viewerResource(details.url) || details.url === document!.url)
    },
    viewerFailure(details: PdfRequest): boolean {
      return currentFrame(details.frame) && viewerResource(details.url)
    },
  }
}
