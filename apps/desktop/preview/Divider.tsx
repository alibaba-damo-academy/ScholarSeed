import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Separator } from '../src/renderer/src/components/ui'
import { PDFE_DOCK_STEP } from '../src/pdfe.ts'

export function PdfeDivider({ label, onResize, onError }: {
  label: string
  onResize: (width: number) => Promise<void>
  onError: () => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const frame = useRef<number | null>(null)
  const queued = useRef<number | null>(null)
  const element = useRef<HTMLHRElement>(null)
  const callbacks = useRef({ onResize, onError })
  callbacks.current = { onResize, onError }
  const flush = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const width = queued.current
    queued.current = null
    if (width !== null) void callbacks.current.onResize(width).catch(() => callbacks.current.onError())
  }, [])
  const schedule = (width: number): void => {
    queued.current = width
    if (frame.current === null) frame.current = requestAnimationFrame(flush)
  }
  const finish = useCallback((): void => {
    const current = drag.current
    drag.current = null
    flush()
    setDragging(false)
    if (current && element.current?.hasPointerCapture(current.pointerId)) element.current.releasePointerCapture(current.pointerId)
  }, [flush])
  useEffect(() => {
    if (!dragging) return
    const root = document.documentElement
    const added = ['cursor-col-resize', 'select-none'].filter(name => !root.classList.contains(name))
    root.classList.add(...added)
    const cancel = (): void => finish()
    window.addEventListener('blur', cancel)
    return () => {
      root.classList.remove(...added)
      window.removeEventListener('blur', cancel)
    }
  }, [dragging, finish])
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    queued.current = null
    drag.current = null
  }, [])
  return <Separator ref={element} orientation="vertical" tabIndex={0} aria-label={label} data-testid="preview-dock-divider" data-dragging={dragging} className="absolute inset-y-0 left-0 z-[var(--vds-z-local-control)] !m-0 !h-full !w-[var(--vds-space-2)] !border-0 !bg-transparent !outline-none !shadow-none cursor-col-resize touch-none select-none after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:w-[var(--vds-border-width-1)] after:bg-[var(--vds-border-default)] after:content-[''] after:transition-colors after:duration-[var(--vds-duration-fast)] hover:after:w-[var(--vds-border-width-2)] hover:after:bg-[var(--vds-border-brand)] focus-visible:after:w-[var(--vds-border-width-2)] focus-visible:after:bg-[var(--vds-border-brand)] data-[dragging=true]:after:w-[var(--vds-border-width-2)] data-[dragging=true]:after:bg-[var(--vds-border-brand)] [-webkit-app-region:no-drag]" onPointerDown={event => {
    if (event.button !== 0 || drag.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, x: event.screenX, width: window.innerWidth }
    setDragging(true)
  }} onPointerMove={event => {
    const current = drag.current
    if (current?.pointerId === event.pointerId) schedule(current.width + current.x - event.screenX)
  }} onPointerUp={event => {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    queued.current = current.width + current.x - event.screenX
    finish()
  }} onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish() }} onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish() }} onKeyDown={event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    queued.current = window.innerWidth + (event.key === 'ArrowLeft' ? PDFE_DOCK_STEP : -PDFE_DOCK_STEP)
    flush()
  }} />
}
