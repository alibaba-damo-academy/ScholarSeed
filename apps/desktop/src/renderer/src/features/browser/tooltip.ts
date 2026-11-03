import type { BrowserOverlayBridge, OverlayBounds } from '../../../../overlay.ts'
import { OVERLAY_LIMIT } from '../../../../overlay.ts'
import { BROWSER_ERROR } from '../../../../browser.ts'

const TOOLTIP_ROLE = 'tooltip'
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]'
const TEXT_WRAPPERS = new Set(['SPAN', 'P'])
const SHADOW_BLUR_PAINT_FACTOR = 1.5
const SHADOW_COLOR = /(?:rgba?|hsla?|color)\([^)]*\)/g
const SHADOW_LENGTH = /-?(?:\d+(?:\.\d+)?|\.\d+)px/g

export function tooltipPaint(bounds: OverlayBounds, shadow: string, viewport: { width: number; height: number }): { bounds: OverlayBounds; tooltipBounds: OverlayBounds } {
  const extent = { left: 0, top: 0, right: 0, bottom: 0 }
  if (shadow !== 'none') {
    const shadows = shadow.split(/,(?![^(]*\))/)
    for (const value of shadows) {
      const lengths = value.replace(SHADOW_COLOR, '').trim()
      if (lengths.includes('inset')) continue
      const matches = lengths.match(SHADOW_LENGTH)
      if (!matches || matches.length < 2 || matches.length > 4 || lengths.replace(SHADOW_LENGTH, '').trim()) throw new Error(BROWSER_ERROR.invalidCommand)
      const [horizontal, vertical, blur = 0, spread = 0] = matches.map(Number.parseFloat)
      if (blur < 0) throw new Error(BROWSER_ERROR.invalidCommand)
      const paint = Math.max(0, blur * SHADOW_BLUR_PAINT_FACTOR + spread)
      extent.left = Math.max(extent.left, paint - horizontal)
      extent.right = Math.max(extent.right, paint + horizontal)
      extent.top = Math.max(extent.top, paint - vertical)
      extent.bottom = Math.max(extent.bottom, paint + vertical)
    }
  }
  const left = Math.max(0, bounds.x - extent.left)
  const top = Math.max(0, bounds.y - extent.top)
  const right = Math.min(viewport.width, bounds.x + bounds.width + extent.right)
  const bottom = Math.min(viewport.height, bounds.y + bounds.height + extent.bottom)
  const tooltipBounds = { x: bounds.x - left, y: bounds.y - top, width: bounds.width, height: bounds.height }
  const paintBounds = { x: left, y: top, width: right - left, height: bottom - top }
  if (tooltipBounds.x < 0 || tooltipBounds.y < 0 || tooltipBounds.x + tooltipBounds.width > paintBounds.width
    || tooltipBounds.y + tooltipBounds.height > paintBounds.height) throw new Error(BROWSER_ERROR.invalidCommand)
  return { bounds: paintBounds, tooltipBounds }
}

export function plainTooltip(element: HTMLElement): boolean {
  return element.getAttribute('role') === TOOLTIP_ROLE && !element.querySelector(INTERACTIVE_SELECTOR)
    && !element.matches(INTERACTIVE_SELECTOR) && element.scrollHeight <= element.clientHeight
    && [...element.querySelectorAll('*')].every(child => TEXT_WRAPPERS.has(child.tagName))
    && Boolean(element.textContent?.trim()) && (element.textContent?.length ?? 0) <= OVERLAY_LIMIT.text
}

export function createTooltipPresenter(bridge: BrowserOverlayBridge, onError: () => void) {
  let revision = 0
  let generation = 0
  let current: HTMLElement | null = null
  let signature = ''
  let originalOpacity = ''
  let disposed = false
  let blocked: HTMLElement | null = null
  let queue = bridge.seed().then(seed => { revision = seed }).catch(onError)
  const restore = (): void => {
    if (current) current.style.opacity = originalOpacity
    current = null
  }
  const dismiss = (): void => {
    generation += 1
    signature = ''
    restore()
    void bridge.dismiss().catch(onError)
  }
  const unsubscribe = bridge.subscribe(event => {
    if (event.kind !== 'dismiss' || event.revision !== revision) return
    blocked = current
    generation += 1
    restore()
    signature = ''
  })
  return {
    update(element: HTMLElement | null, bounds?: OverlayBounds): void {
      if (disposed) return
      if (!element || !bounds) { if (current) dismiss(); blocked = null; return }
      if (element === blocked) return
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
      const language = document.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en'
      const tooltip = element.textContent!.trim()
      let paint: ReturnType<typeof tooltipPaint>
      try { paint = tooltipPaint(bounds, getComputedStyle(element).boxShadow, { width: window.innerWidth, height: window.innerHeight }) }
      catch { console.warn('[browser-tooltip] unsupported paint geometry', JSON.stringify({ bounds, shadow: getComputedStyle(element).boxShadow, viewport: { width: window.innerWidth, height: window.innerHeight } })); dismiss(); blocked = element; onError(); return }
      const next = JSON.stringify({ ...paint, theme, language, tooltip })
      if (current === element && signature === next) return
      restore()
      current = element
      originalOpacity = element.style.opacity
      signature = next
      const publishing = ++generation
      queue = queue.then(async () => {
        if (disposed || publishing !== generation) return
        const reply = await bridge.publish({ revision: ++revision, ...paint, theme, language, tooltip, status: 'ready', items: [] })
        if (disposed || publishing !== generation) return
        if (reply.ok) element.style.opacity = '0'
        else { restore(); blocked = element; onError() }
      }).catch(() => { if (!disposed && publishing === generation) { restore(); blocked = element; onError() } })
    },
    dispose(): void {
      disposed = true
      generation += 1
      restore()
      unsubscribe()
      bridge.dismissSync()
    }
  }
}
