import React from 'react'

export const FLOATING_EDGE_MARGIN_PX = 0
export const FLOATING_PANEL_MARGIN_PX = 16
const DRAG_THRESHOLD_PX = 4
const RECORDER_DRAG_BLOCKED_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'a',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="listbox"]',
  '[role="option"]',
  '[data-floating-drag-ignore]'
].join(',')

interface ClosestTarget extends EventTarget {
  closest: (selector: string) => unknown
}

export function isRecorderDragBlockedTarget(
  target: EventTarget | null,
  surface?: EventTarget | null
): boolean {
  if (!target || typeof (target as Partial<ClosestTarget>).closest !== 'function') return false
  const interactiveOwner = (target as ClosestTarget).closest(RECORDER_DRAG_BLOCKED_SELECTOR)
  return Boolean(interactiveOwner && interactiveOwner !== surface)
}

export interface FloatingOffset {
  x: number
  y: number
}

interface FloatingBounds {
  baseLeft: number
  baseTop: number
  width: number
  height: number
}

interface ViewportSize {
  width: number
  height: number
}

export function clampFloatingOffset(
  bounds: FloatingBounds,
  desired: FloatingOffset,
  viewport: ViewportSize,
  margin = FLOATING_PANEL_MARGIN_PX
): FloatingOffset {
  const minX = margin - bounds.baseLeft
  const maxX = viewport.width - margin - bounds.baseLeft - bounds.width
  const minY = margin - bounds.baseTop
  const maxY = viewport.height - margin - bounds.baseTop - bounds.height
  return {
    x: Math.min(Math.max(desired.x, Math.min(minX, maxX)), Math.max(minX, maxX)),
    y: Math.min(Math.max(desired.y, Math.min(minY, maxY)), Math.max(minY, maxY))
  }
}

export interface FloatingSurfaceBinding {
  consumeSuppressedClick: () => boolean
  handleProps: {
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
  }
  setSurface: (node: HTMLElement | null) => void
  style: React.CSSProperties
}

export function useFloatingSurface(
  layoutKey: string,
  margin = FLOATING_PANEL_MARGIN_PX
): FloatingSurfaceBinding {
  const surfaceRef = React.useRef<HTMLElement | null>(null)
  const [surfaceNode, setSurfaceNode] = React.useState<HTMLElement | null>(null)
  const dragRef = React.useRef<{
    bounds: FloatingBounds
    origin: FloatingOffset
    pointerId: number
    pointerX: number
    pointerY: number
  }>()
  const suppressedClickRef = React.useRef(false)
  const [offset, setOffset] = React.useState<FloatingOffset>({ x: 0, y: 0 })

  const setSurface = React.useCallback((node: HTMLElement | null): void => {
    surfaceRef.current = node
    setSurfaceNode(node)
  }, [])

  const keepVisible = React.useCallback((): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    setOffset((current) => {
      const correctionX = rect.left < margin
        ? margin - rect.left
        : rect.right > window.innerWidth - margin
          ? window.innerWidth - margin - rect.right
          : 0
      const correctionY = rect.top < margin
        ? margin - rect.top
        : rect.bottom > window.innerHeight - margin
          ? window.innerHeight - margin - rect.bottom
          : 0
      if (!correctionX && !correctionY) return current
      return { x: current.x + correctionX, y: current.y + correctionY }
    })
  }, [margin])

  React.useLayoutEffect(() => keepVisible(), [keepVisible, layoutKey, surfaceNode])
  React.useLayoutEffect(() => {
    if (!surfaceNode || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(keepVisible)
    observer.observe(surfaceNode)
    return () => observer.disconnect()
  }, [keepVisible, surfaceNode])
  React.useEffect(() => {
    window.addEventListener('resize', keepVisible)
    return () => window.removeEventListener('resize', keepVisible)
  }, [keepVisible])

  const finish = (event: React.PointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return {
    consumeSuppressedClick: () => {
      const suppressed = suppressedClickRef.current
      suppressedClickRef.current = false
      return suppressed
    },
    handleProps: {
      onLostPointerCapture: finish,
      onPointerCancel: finish,
      onPointerDown: (event) => {
        const surface = surfaceRef.current
        if (
          !surface
          || event.button !== 0
          || event.defaultPrevented
          || isRecorderDragBlockedTarget(event.target, surface)
        ) return
        const rect = surface.getBoundingClientRect()
        dragRef.current = {
          bounds: {
            baseLeft: rect.left - offset.x,
            baseTop: rect.top - offset.y,
            width: rect.width,
            height: rect.height
          },
          origin: offset,
          pointerId: event.pointerId,
          pointerX: event.clientX,
          pointerY: event.clientY
        }
        suppressedClickRef.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        const deltaX = event.clientX - drag.pointerX
        const deltaY = event.clientY - drag.pointerY
        if (Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD_PX) suppressedClickRef.current = true
        setOffset(clampFloatingOffset(
          drag.bounds,
          { x: drag.origin.x + deltaX, y: drag.origin.y + deltaY },
          { width: window.innerWidth, height: window.innerHeight },
          margin
        ))
      },
      onPointerUp: finish
    },
    setSurface,
    style: { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }
  }
}
