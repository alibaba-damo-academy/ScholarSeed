import type { SelectionLocator } from '../../contracts/workbench'

export function selectionLocator(value: unknown): SelectionLocator | undefined {
  if (!value || typeof value !== 'object') return undefined
  const locator = value as Record<string, unknown>
  const integer = (key: string): boolean =>
    Number.isSafeInteger(locator[key]) && Number(locator[key]) >= 0
  if (
    locator.kind === 'markdown' &&
    integer('start') &&
    integer('end') &&
    Number(locator.end) > Number(locator.start) &&
    typeof locator.source_map_version === 'string'
  )
    return locator as unknown as SelectionLocator
  if (
    locator.kind === 'text' &&
    ['start_line', 'start_column', 'end_line', 'end_column'].every(integer)
  )
    return locator as unknown as SelectionLocator
  if (
    locator.kind === 'pdf' &&
    integer('page') &&
    Number(locator.page) > 0 &&
    Array.isArray(locator.quads) &&
    locator.quads.length &&
    locator.quads.every(
      (quad) => Array.isArray(quad) && quad.length === 4 && quad.every(Number.isFinite)
    )
  )
    return locator as unknown as SelectionLocator
  if (
    locator.kind === 'writer' &&
    (locator.format === undefined || ['doc', 'docx'].includes(String(locator.format))) &&
    typeof locator.paragraph === 'string' &&
    integer('start') &&
    integer('end')
  )
    return locator as unknown as SelectionLocator
  if (
    locator.kind === 'calc' &&
    typeof locator.sheet === 'string' &&
    typeof locator.range === 'string'
  )
    return locator as unknown as SelectionLocator
  if (
    locator.kind === 'impress' &&
    integer('slide') &&
    Number(locator.slide) > 0 &&
    typeof locator.shape === 'string' &&
    integer('start') &&
    integer('end')
  )
    return locator as unknown as SelectionLocator
  return undefined
}

export function textSelectionRange(locator: Extract<SelectionLocator, { kind: 'text' }>) {
  return {
    startLineNumber: locator.start_line + 1,
    startColumn: locator.start_column + 1,
    endLineNumber: locator.end_line + 1,
    endColumn: locator.end_column + 1,
  }
}

export function flashSelection(
  document: Document,
  rectangles: readonly Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>[]
): () => void {
  const overlays: HTMLElement[] = []
  const animations: Animation[] = []
  const duration = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--vds-selection-reveal-duration')
  )
  const opacity = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--vds-selection-reveal-opacity')
  )
  const reduced = document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches
  for (const rect of rectangles) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const overlay = document.createElement('div')
    overlay.className =
      'pointer-events-none fixed z-[var(--vds-z-local-control)] rounded-[var(--vds-radius-2)] bg-[var(--vds-pdf-citation-highlight)]'
    overlay.setAttribute('aria-hidden', 'true')
    overlay.dataset.slot = 'selection-reveal-highlight'
    Object.assign(overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
    document.body.append(overlay)
    overlays.push(overlay)
    const animation = overlay.animate(
      reduced
        ? [{ opacity }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity }, { opacity: 0 }, { opacity }, { opacity: 0 }],
      { duration }
    )
    animations.push(animation)
    void animation.finished.then(
      () => overlay.remove(),
      () => overlay.remove()
    )
  }
  const cleanup = (): void => {
    animations.forEach((animation) => animation.cancel())
    overlays.forEach((overlay) => overlay.remove())
  }
  const scrollFrame = document.defaultView?.requestAnimationFrame(() => {
    document.addEventListener('scroll', cleanup, { capture: true, once: true })
  })
  return () => {
    if (scrollFrame !== undefined) document.defaultView?.cancelAnimationFrame(scrollFrame)
    document.removeEventListener('scroll', cleanup, true)
    cleanup()
  }
}
