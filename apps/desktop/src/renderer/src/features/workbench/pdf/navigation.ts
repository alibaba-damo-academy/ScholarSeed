export interface PdfOutlineNode {
  title: string
  dest: string | unknown[] | null
  items: PdfOutlineNode[]
}

export interface PdfOutlineItem {
  title: string
  page: number | null
  children: PdfOutlineItem[]
}

export type PdfDestination = string | unknown[]

export interface PdfDestinationTarget {
  page: number
  left: number
  top: number
}

export interface PdfDestinationViewport {
  width: number
  height: number
  convertToViewportPoint: (x: number, y: number) => number[]
}

export interface PdfAnnotationViewport {
  width: number
  height: number
  convertToViewportPoint: (x: number, y: number) => number[]
}

export interface PdfInternalLink {
  id: string
  destination: PdfDestination
  label: string
  rect: number[]
}

interface PdfOutlineResolver {
  namedDestination: (name: string) => Promise<unknown[] | null>
  pageIndex: (reference: unknown) => Promise<number>
}

export interface PdfDestinationResolver extends PdfOutlineResolver {
  pageViewport: (page: number) => Promise<PdfDestinationViewport>
}

interface PdfLinkAnnotation {
  id?: string
  subtype?: string
  rect?: number[]
  dest?: PdfDestination
  overlaidText?: string
}

const DESTINATION_MODE = {
  fitHorizontal: new Set(['FitH', 'FitBH']),
  fitRectangle: 'FitR',
  fitVertical: new Set(['FitV', 'FitBV']),
  point: 'XYZ'
} as const

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function destinationMode(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : ''
}

async function explicitDestination(
  destination: PdfDestination,
  resolver: PdfOutlineResolver
): Promise<unknown[] | null> {
  return typeof destination === 'string'
    ? await resolver.namedDestination(destination)
    : destination
}

async function destinationPageIndex(
  destination: unknown[],
  resolver: PdfOutlineResolver
): Promise<number> {
  const first = destination[0]
  return typeof first === 'number' ? first : await resolver.pageIndex(first)
}

export async function resolveDestination(
  destination: PdfDestination,
  resolver: PdfDestinationResolver
): Promise<PdfDestinationTarget | null> {
  try {
    const explicit = await explicitDestination(destination, resolver)
    if (!explicit?.length) return null
    const page = await destinationPageIndex(explicit, resolver) + 1
    const viewport = await resolver.pageViewport(page)
    const mode = destinationMode(explicit[1])
    const explicitX = finiteNumber(explicit[2])
    const explicitY = finiteNumber(explicit[3])
    let point: number[] = [0, 0]
    if (mode === DESTINATION_MODE.point) {
      point = viewport.convertToViewportPoint(explicitX ?? 0, explicitY ?? viewport.height)
    } else if (DESTINATION_MODE.fitHorizontal.has(mode)) {
      point = viewport.convertToViewportPoint(0, explicitX ?? viewport.height)
    } else if (DESTINATION_MODE.fitVertical.has(mode)) {
      point = [explicitX ?? 0, 0]
    } else if (mode === DESTINATION_MODE.fitRectangle) {
      point = viewport.convertToViewportPoint(
        explicitX ?? 0,
        finiteNumber(explicit[5]) ?? viewport.height
      )
    }
    const left = finiteNumber(point[0])
    const top = finiteNumber(point[1])
    if (left === null || top === null || viewport.width <= 0 || viewport.height <= 0) return null
    return {
      page,
      left: Math.min(1, Math.max(0, left / viewport.width)),
      top: Math.min(1, Math.max(0, top / viewport.height))
    }
  } catch {
    return null
  }
}

export function internalLink(
  annotation: PdfLinkAnnotation,
  viewport: PdfAnnotationViewport
): PdfInternalLink | null {
  if (annotation.subtype !== 'Link' || !annotation.dest || !annotation.rect?.length) return null
  const first = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1])
  const second = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3])
  const rect = [...first, ...second]
  if (rect.length < 4 || viewport.width <= 0 || viewport.height <= 0) return null
  const left = Math.min(rect[0], rect[2]) / viewport.width
  const right = Math.max(rect[0], rect[2]) / viewport.width
  const top = Math.min(rect[1], rect[3]) / viewport.height
  const bottom = Math.max(rect[1], rect[3]) / viewport.height
  if (![left, top, right, bottom].every(Number.isFinite) || left === right || top === bottom) return null
  return {
    id: annotation.id ?? `${left}:${top}:${right}:${bottom}`,
    destination: annotation.dest,
    label: annotation.overlaidText?.trim() || '',
    rect: [left, top, right, bottom]
  }
}

async function destinationPage(
  destination: PdfOutlineNode['dest'],
  resolver: PdfOutlineResolver
): Promise<number | null> {
  if (!destination) return null
  try {
    const explicit = await explicitDestination(destination, resolver)
    if (!explicit?.length) return null
    return await destinationPageIndex(explicit, resolver) + 1
  } catch {
    return null
  }
}

export async function outlineTree(
  nodes: PdfOutlineNode[] | null,
  resolver: PdfOutlineResolver
): Promise<PdfOutlineItem[]> {
  if (!nodes) return []
  const items: PdfOutlineItem[] = []
  for (const node of nodes) {
    items.push({
      title: node.title,
      page: await destinationPage(node.dest, resolver),
      children: await outlineTree(node.items ?? [], resolver)
    })
  }
  return items
}
