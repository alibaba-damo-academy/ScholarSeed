import { useLayoutEffect, useRef, useState } from 'react'
import type { BrowserCommand, BrowserErrorCode, BrowserFrame, BrowserFrameInput } from '../../../../browser'
import { BROWSER_ERROR } from '../../../../browser'
import { createTooltipPresenter, plainTooltip } from './tooltip'

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], aside'
const OBSERVED_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'aria-hidden', 'data-state']
const CLIPPED_OVERFLOW = new Set(['hidden', 'clip', 'auto', 'scroll'])
const TRANSPARENT_BACKGROUND = /^(transparent|rgba\([^)]*,\s*0\))$/
const MOTION_EVENTS = ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel']
const NON_GEOMETRY_ANIMATION_KEYS = new Set(['opacity', 'offset', 'computedOffset', 'easing', 'composite'])
type BoundsCommand = Extract<BrowserCommand, { kind: 'bounds' }>

function portalSurfaces(element: Element): HTMLElement[] {
  if (!(element instanceof HTMLElement)) return []
  const style = getComputedStyle(element)
  if (style.pointerEvents === 'none' && TRANSPARENT_BACKGROUND.test(style.backgroundColor) && style.backgroundImage === 'none' && style.boxShadow === 'none') {
    return [...element.children].flatMap(portalSurfaces)
  }
  return [element]
}

function overlayCandidates(element: HTMLElement): Set<HTMLElement> {
  const candidates = new Set([...document.body.children].filter(child => !child.contains(element)).flatMap(portalSurfaces))
  for (const overlay of document.querySelectorAll(OVERLAY_SELECTOR)) if (overlay instanceof HTMLElement) candidates.add(overlay)
  return candidates
}

function hasGeometryMotion(element: HTMLElement): boolean {
  return element.getAnimations().some(animation => animation.playState !== 'finished' && animation.playState !== 'idle'
    && animation.effect instanceof KeyframeEffect
    && animation.effect.getKeyframes().some(frame => Object.keys(frame).some(key => !NON_GEOMETRY_ANIMATION_KEYS.has(key))))
}

function viewportBounds(element: HTMLElement, tabId: string, candidates: Set<HTMLElement>): BoundsCommand {
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(window.innerWidth, rect.right)
  let bottom = Math.min(window.innerHeight, rect.bottom)
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const bounds = parent.getBoundingClientRect()
    if (CLIPPED_OVERFLOW.has(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right) }
    if (CLIPPED_OVERFLOW.has(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom) }
  }
  const overlays = new Set(document.querySelectorAll(OVERLAY_SELECTOR))
  let occluded = false
  for (const overlay of candidates) {
    if (overlay.contains(element) || element.contains(overlay)) continue
    if (!overlay.checkVisibility({ visibilityProperty: true })) continue
    if (window.scholarseed.browserTooltip && plainTooltip(overlay)) continue
    if (hasGeometryMotion(overlay)) { occluded = true; break }
    if (overlay.getAttribute('aria-modal') === 'true') { occluded = true; break }
    const bounds = overlay.getBoundingClientRect()
    if (!(bounds.width > 0 && bounds.height > 0 && bounds.left < right && bounds.right > left && bounds.top < bottom && bounds.bottom > top)) continue
    if (overlays.has(overlay) || overlay.getAttribute('role') === 'region') { occluded = true; break }
    const free = [
      { left, top, right: Math.max(left, bounds.left), bottom },
      { left: Math.min(right, bounds.right), top, right, bottom },
      { left, top, right, bottom: Math.max(top, bounds.top) },
      { left, top: Math.min(bottom, bounds.bottom), right, bottom }
    ].sort((first, second) => (second.right - second.left) * (second.bottom - second.top) - (first.right - first.left) * (first.bottom - first.top))[0]
    left = free.left
    top = free.top
    right = free.right
    bottom = free.bottom
  }
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  return { kind: 'bounds', tabId, x: left, y: top, width, height,
    visible: !document.hidden && element.checkVisibility() && width > 0 && height > 0 && !occluded }
}

export function useBrowserViewport(tabId: string | undefined, onError: (error: BrowserErrorCode) => void, engine: 'electron-view' | 'chromium-sidecar' = 'electron-view') {
  const viewport = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element || !tabId || engine !== 'electron-view') return
    let previous = ''
    let disposed = false
    let frame: number | undefined
    const tooltip = window.scholarseed.browserTooltip ? createTooltipPresenter(window.scholarseed.browserTooltip, () => onError(BROWSER_ERROR.operationFailed)) : null
    const send = (command: BoundsCommand) => {
      const signature = JSON.stringify(command)
      if (previous === signature) return
      previous = signature
      void window.scholarseed.browser.dispatch(command).then(reply => {
        if (!disposed && !reply.ok && reply.error !== BROWSER_ERROR.targetClosed) onError(reply.error)
      }).catch(() => { if (!disposed) onError(BROWSER_ERROR.operationFailed) })
    }
    const observedOverlays = new Set<HTMLElement>()
    const update = () => {
      frame = undefined
      const candidates = overlayCandidates(element)
      for (const overlay of observedOverlays) if (!candidates.has(overlay)) { resize.unobserve(overlay); observedOverlays.delete(overlay) }
      for (const overlay of candidates) if (!observedOverlays.has(overlay)) { resize.observe(overlay); observedOverlays.add(overlay) }
      const command = viewportBounds(element, tabId, candidates)
      send(command)
      const tip = command.visible ? [...candidates].find(candidate => {
        if (!plainTooltip(candidate) || !candidate.checkVisibility({ visibilityProperty: true })) return false
        const bounds = candidate.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0 && bounds.left < command.x + command.width && bounds.right > command.x
          && bounds.top < command.y + command.height && bounds.bottom > command.y
      }) : undefined
      const bounds = tip?.getBoundingClientRect()
      tooltip?.update(tip ?? null, bounds ? { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: bounds.width, height: bounds.height } : undefined)
    }
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      update()
      frame = requestAnimationFrame(update)
    }
    const resize = new ResizeObserver(schedule)
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) resize.observe(parent)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: OBSERVED_ATTRIBUTES })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    for (const event of MOTION_EVENTS) document.addEventListener(event, schedule, true)
    update()
    return () => {
      disposed = true
      tooltip?.dispose()
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      document.removeEventListener('visibilitychange', schedule)
      for (const event of MOTION_EVENTS) document.removeEventListener(event, schedule, true)
      if (frame !== undefined) cancelAnimationFrame(frame)
      send({ kind: 'bounds', tabId, visible: false, x: 0, y: 0, width: 0, height: 0 })
    }
  }, [tabId, onError, engine])
  return viewport
}

export function useChromiumFrame(tabId: string | undefined, viewport: React.RefObject<HTMLDivElement | null>, enabled: boolean, onError: (error: BrowserErrorCode) => void) {
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const dimensions = useRef({ width: 0, height: 0 })
  useLayoutEffect(() => {
    setFrame(null)
    dimensions.current = { width: 0, height: 0 }
    if (!enabled || !tabId || !window.scholarseed.browser.frames) return
    const bridge = window.scholarseed.browser.frames
    const element = viewport.current
    if (!element) return
    const resize = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect()
      const width = Math.max(1, Math.round(bounds.width))
      const height = Math.max(1, Math.round(bounds.height))
      if (width === dimensions.current.width && height === dimensions.current.height) return
      dimensions.current = { width, height }
      setFrame(null)
      void bridge.resize(tabId, width, height).then(reply => {
        if (!reply.ok) onError(reply.error)
      }).catch(() => onError(BROWSER_ERROR.operationFailed))
    })
    resize.observe(element)
    const unsubscribe = bridge.subscribe(next => {
      if (next.tabId !== tabId) return
      setFrame(previous => previous && previous.sequence >= next.sequence ? previous : next)
    })
    return () => { resize.disconnect(); unsubscribe(); setFrame(null); dimensions.current = { width: 0, height: 0 } }
  }, [tabId, viewport, enabled, onError])
  const input = (value: BrowserFrameInput): void => {
    if (enabled && tabId) void window.scholarseed.browser.frames?.input(tabId, value).then(reply => {
      if (!reply.ok) onError(reply.error)
    }).catch(() => onError(BROWSER_ERROR.operationFailed))
  }
  const acknowledge = (sequence: number): void => {
    if (enabled && tabId) void window.scholarseed.browser.frames?.acknowledge(tabId, sequence).then(reply => {
      if (!reply.ok) onError(reply.error)
    }).catch(() => onError(BROWSER_ERROR.operationFailed))
  }
  return { frame: enabled && frame?.tabId === tabId ? frame : null, dimensions, input, acknowledge }
}
