interface PdfLinkAnnotation {
  subtype?: unknown
  url?: unknown
  rect?: unknown
}

interface PdfLinkViewport {
  convertToViewportPoint(x: number, y: number): number[]
}

export interface ExternalPdfLink {
  url: string
  left: number
  top: number
  width: number
  height: number
}

const LINK_ANNOTATION_SUBTYPE = 'Link'
const SUPPORTED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])
export const PDF_ANNOTATION_INTENT = 'display'

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return SUPPORTED_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function annotationRectangle(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) return null
  return value
}

export function externalPdfLinks(annotations: object[], viewport: PdfLinkViewport): ExternalPdfLink[] {
  return annotations.flatMap(annotation => {
    const candidate = annotation as PdfLinkAnnotation
    if (candidate.subtype !== LINK_ANNOTATION_SUBTYPE) return []
    const url = safeExternalUrl(candidate.url)
    const rectangle = annotationRectangle(candidate.rect)
    if (!url || !rectangle) return []
    const [firstX, firstY] = viewport.convertToViewportPoint(rectangle[0], rectangle[1])
    const [secondX, secondY] = viewport.convertToViewportPoint(rectangle[2], rectangle[3])
    const left = Math.min(firstX, secondX)
    const top = Math.min(firstY, secondY)
    return [{ url, left, top, width: Math.abs(secondX - firstX), height: Math.abs(secondY - firstY) }]
  })
}
