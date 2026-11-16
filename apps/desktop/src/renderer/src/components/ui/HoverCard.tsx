import type * as React from 'react'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react'
import { Portal, usePortalOverlay } from './portal'

import { hoverCardContentClassName, popoverContentClassName } from './classes'
import {
  createOpenContext,
  renderTrigger,
  useFloatingContentPosition,
  type FloatingSide,
  type OpenRootProps,
} from './floating'
import { cx } from './utils'

const hoverCardContext = createOpenContext('HoverCard')
const HOVER_CARD_EXIT_MS = 120

interface HoverCardInteractionValue {
  cancelClose: () => void
  scheduleClose: () => void
  schedulePointerClose: (event: MouseEvent<HTMLElement>) => void
  horizontalAnchorRef: MutableRefObject<HTMLElement | null>
  sideOffsetRef: MutableRefObject<number | undefined>
}

const HoverCardInteractionContext = createContext<HoverCardInteractionValue | null>(null)

function HoverCardInteractionProvider({ children }: { children?: ReactNode }): React.JSX.Element {
  const { anchorRef, contentRef, open, setOpen } = hoverCardContext.useOpenContext()
  const closeTimer = useRef<number | null>(null)
  const pointerTracking = useRef<AbortController | null>(null)
  const horizontalAnchorRef = useRef<HTMLElement | null>(null)
  const sideOffsetRef = useRef<number | undefined>(undefined)

  const cancelClose = (): void => {
    pointerTracking.current?.abort()
    pointerTracking.current = null
    if (closeTimer.current === null) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, HOVER_CARD_EXIT_MS)
  }

  const schedulePointerClose = (event: MouseEvent<HTMLElement>): void => {
    const anchor = anchorRef.current
    const content = contentRef.current
    const ownerDocument = event.currentTarget.ownerDocument
    const inGap = (clientX: number, clientY: number): boolean => {
      if (!anchor?.isConnected || !content?.isConnected || content.dataset.state !== 'open')
        return false
      const anchorBox = anchor.getBoundingClientRect()
      const contentBox = content.getBoundingClientRect()
      const [upper, lower] =
        anchorBox.top < contentBox.top ? [anchorBox, contentBox] : [contentBox, anchorBox]
      return (
        clientX >= Math.max(upper.left, lower.left) &&
        clientX <= Math.min(upper.right, lower.right) &&
        clientY >= upper.bottom &&
        clientY <= lower.top
      )
    }
    if (!inGap(event.clientX, event.clientY)) {
      scheduleClose()
      return
    }
    cancelClose()
    const controller = new AbortController()
    pointerTracking.current = controller
    const options = { signal: controller.signal, capture: true }
    ownerDocument.addEventListener(
      'mousemove',
      (move) => {
        if (!inGap(move.clientX, move.clientY)) scheduleClose()
      },
      options
    )
    ownerDocument.documentElement.addEventListener('mouseleave', scheduleClose, {
      signal: controller.signal,
    })
    ownerDocument.defaultView?.addEventListener('blur', scheduleClose, options)
  }

  useEffect(() => cancelClose, [])
  useEffect(() => {
    if (!open) cancelClose()
  }, [open])

  return (
    <HoverCardInteractionContext.Provider
      value={{
        cancelClose,
        scheduleClose,
        schedulePointerClose,
        horizontalAnchorRef,
        sideOffsetRef,
      }}
    >
      {children}
    </HoverCardInteractionContext.Provider>
  )
}

function useHoverCardInteraction(): HoverCardInteractionValue {
  const context = useContext(HoverCardInteractionContext)
  if (!context) throw new Error('HoverCard parts must be used inside HoverCard')
  return context
}

export type HoverCardProps = OpenRootProps

export function HoverCard({ children, ...props }: HoverCardProps): React.JSX.Element {
  return (
    <hoverCardContext.Provider {...props}>
      <HoverCardInteractionProvider>{children}</HoverCardInteractionProvider>
    </hoverCardContext.Provider>
  )
}

export function HoverCardTrigger({
  positionAnchorRef: alignmentRef,
  sideOffset,
  ...props
}: HTMLAttributes<HTMLElement> & {
  asChild?: boolean
  children?: ReactNode
  positionAnchorRef?: RefObject<HTMLElement | null>
  sideOffset?: number
}): React.JSX.Element {
  const context = hoverCardContext.useOpenContext()
  const { cancelClose, scheduleClose, schedulePointerClose, horizontalAnchorRef, sideOffsetRef } =
    useHoverCardInteraction()
  const handleFocus = (event: FocusEvent<HTMLElement>): void => {
    props.onFocus?.(event)
    if (event.defaultPrevented) return
    cancelClose()
    horizontalAnchorRef.current = alignmentRef?.current ?? null
    sideOffsetRef.current = sideOffset
    const rect = event.currentTarget.getBoundingClientRect()
    context.setPosition({
      bottom: rect.bottom,
      kind: 'anchor',
      left: rect.left,
      top: rect.top,
      width: rect.width,
    })
    context.setOpen(true)
  }
  const handleBlur = (event: FocusEvent<HTMLElement>): void => {
    props.onBlur?.(event)
    if (event.defaultPrevented) return
    const nextTarget = event.relatedTarget as Node | null
    if (
      nextTarget &&
      (event.currentTarget.contains(nextTarget) || context.contentRef.current?.contains(nextTarget))
    )
      return
    scheduleClose()
  }
  const handleMouseEnter = (event: MouseEvent<HTMLElement>): void => {
    cancelClose()
    horizontalAnchorRef.current = alignmentRef?.current ?? null
    sideOffsetRef.current = sideOffset
    props.onMouseEnter?.(event)
  }
  const handleMouseLeave = (event: MouseEvent<HTMLElement>): void => {
    props.onMouseLeave?.(event)
    if (event.defaultPrevented) return
    schedulePointerClose(event)
    event.preventDefault()
  }

  return renderTrigger(
    context,
    {
      ...props,
      onBlur: handleBlur,
      onFocus: handleFocus,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
    },
    'onMouseEnter'
  )
}

export interface HoverCardContentProps extends HTMLAttributes<HTMLDivElement> {
  hosted?: boolean
  side?: FloatingSide
  sideBoundaryRef?: RefObject<HTMLElement | null>
}

export function HoverCardContent({
  hosted = false,
  ...props
}: HoverCardContentProps): React.JSX.Element | null {
  const renderOverlay = usePortalOverlay()
  const { open } = hoverCardContext.useOpenContext()
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) {
      setPresent(true)
      return undefined
    }
    const timeout = window.setTimeout(() => setPresent(false), HOVER_CARD_EXIT_MS)
    return () => window.clearTimeout(timeout)
  }, [open])
  if (!present) return null
  const content = <HoverCardContentView {...props} />
  return <>{hosted && renderOverlay ? renderOverlay(content) : content}</>
}

function HoverCardContentView({
  className,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  side = 'auto',
  sideBoundaryRef,
  style,
  ...props
}: HoverCardContentProps): React.JSX.Element | null {
  const context = hoverCardContext.useOpenContext()
  const { cancelClose, scheduleClose, schedulePointerClose, horizontalAnchorRef, sideOffsetRef } =
    useHoverCardInteraction()
  const { contentId, contentRef, open } = context
  const positionedStyle = useFloatingContentPosition(
    context,
    true,
    style,
    side,
    'start',
    sideBoundaryRef,
    horizontalAnchorRef,
    sideOffsetRef.current
  )

  const content = (
    <div
      className={cx(popoverContentClassName, hoverCardContentClassName, className)}
      data-state={open ? 'open' : 'closed'}
      id={contentId}
      ref={contentRef}
      role="region"
      tabIndex={-1}
      style={positionedStyle}
      onBlur={(event) => {
        onBlur?.(event)
        if (
          event.defaultPrevented ||
          event.currentTarget.contains(event.relatedTarget as Node | null)
        )
          return
        if (!event.relatedTarget && event.target.matches(':disabled')) {
          event.currentTarget.focus({ preventScroll: true })
          return
        }
        scheduleClose()
      }}
      onFocus={(event) => {
        cancelClose()
        onFocus?.(event)
      }}
      onMouseEnter={(event) => {
        cancelClose()
        onMouseEnter?.(event)
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event)
        if (!event.defaultPrevented) schedulePointerClose(event)
      }}
      {...props}
    />
  )
  return <Portal>{content}</Portal>
}
