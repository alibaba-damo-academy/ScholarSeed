import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { hoverCardContentClassName, popoverContentClassName } from './classes'
import {
  createOpenContext,
  renderTrigger,
  useFloatingContentPosition,
  type FloatingSide,
  type OpenRootProps
} from './floating'
import { cx } from './utils'

const hoverCardContext = createOpenContext('HoverCard')
const HOVER_CARD_EXIT_MS = 120

interface HoverCardInteractionValue {
  cancelClose: () => void
  scheduleClose: () => void
}

const HoverCardInteractionContext = createContext<HoverCardInteractionValue | null>(null)

function HoverCardInteractionProvider({ children }: { children?: ReactNode }): JSX.Element {
  const { setOpen } = hoverCardContext.useOpenContext()
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
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

  useEffect(() => cancelClose, [])

  return (
    <HoverCardInteractionContext.Provider value={{ cancelClose, scheduleClose }}>
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

export function HoverCard({ children, ...props }: HoverCardProps): JSX.Element {
  return (
    <hoverCardContext.Provider {...props}>
      <HoverCardInteractionProvider>{children}</HoverCardInteractionProvider>
    </hoverCardContext.Provider>
  )
}

export function HoverCardTrigger(props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }): JSX.Element {
  const context = hoverCardContext.useOpenContext()
  const { cancelClose, scheduleClose } = useHoverCardInteraction()
  const handleFocus = (event: FocusEvent<HTMLElement>): void => {
    props.onFocus?.(event)
    if (event.defaultPrevented) return
    cancelClose()
    const rect = event.currentTarget.getBoundingClientRect()
    context.setPosition({ bottom: rect.bottom, kind: 'anchor', left: rect.left, top: rect.top, width: rect.width })
    context.setOpen(true)
  }
  const handleBlur = (event: FocusEvent<HTMLElement>): void => {
    props.onBlur?.(event)
    if (event.defaultPrevented) return
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && (event.currentTarget.contains(nextTarget) || context.contentRef.current?.contains(nextTarget))) return
    scheduleClose()
  }
  const handleMouseEnter = (event: MouseEvent<HTMLElement>): void => {
    cancelClose()
    props.onMouseEnter?.(event)
  }
  const handleMouseLeave = (event: MouseEvent<HTMLElement>): void => {
    props.onMouseLeave?.(event)
    if (event.defaultPrevented) return
    scheduleClose()
    event.preventDefault()
  }

  return renderTrigger(context, {
    ...props,
    onBlur: handleBlur,
    onFocus: handleFocus,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave
  }, 'onMouseEnter')
}

export interface HoverCardContentProps extends HTMLAttributes<HTMLDivElement> {
  side?: FloatingSide
}

export function HoverCardContent({ className, onBlur, onFocus, onMouseEnter, onMouseLeave, side = 'auto', style, ...props }: HoverCardContentProps): JSX.Element | null {
  const context = hoverCardContext.useOpenContext()
  const { cancelClose, scheduleClose } = useHoverCardInteraction()
  const { contentId, contentRef, open } = context
  const [present, setPresent] = useState(open)
  const positionedStyle = useFloatingContentPosition(context, present, style, side)

  useEffect(() => {
    if (open) {
      setPresent(true)
      return undefined
    }

    const timeout = window.setTimeout(() => setPresent(false), HOVER_CARD_EXIT_MS)
    return () => window.clearTimeout(timeout)
  }, [open])

  if (!present) return null
  const content = (
    <div
      className={cx(popoverContentClassName, hoverCardContentClassName, className)}
      data-state={open ? 'open' : 'closed'}
      id={contentId}
      ref={contentRef}
      role="region"
      style={positionedStyle}
      onBlur={(event) => {
        onBlur?.(event)
        if (event.defaultPrevented || event.currentTarget.contains(event.relatedTarget as Node | null)) return
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
        if (!event.defaultPrevented) scheduleClose()
      }}
      {...props}
    />
  )
  return createPortal(content, document.body)
}
