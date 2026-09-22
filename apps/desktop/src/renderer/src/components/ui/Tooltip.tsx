import type { ButtonHTMLAttributes, CSSProperties, FocusEvent, HTMLAttributes, MouseEvent, MutableRefObject, ReactElement, ReactNode } from 'react'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

import {
  tooltipClassName,
  tooltipContentClassName,
  tooltipContentSideClassNames,
  tooltipStyleClassName,
  tooltipTriggerClassName,
  type TooltipSide
} from './classes'
import { cx } from './utils'
import { visibleContent } from './focus'
import type { LocalizationMetadata } from './metadata'

interface TooltipContextValue {
  align: TooltipAlign
  anchorRef?: { current: HTMLElement | null }
  cancelScheduledClose: () => void
  contentId: string
  contentScrollable: boolean
  disabled: boolean
  offset: number
  open: boolean
  portalled: boolean
  rootRef: { current: HTMLSpanElement | null }
  scheduleClose: () => void
  setContentId: (id: string) => void
  setContentScrollable: (scrollable: boolean) => void
  setOpen: (open: boolean) => void
  side: TooltipSide
}

const TooltipContext = createContext<TooltipContextValue | null>(null)

function useTooltipContext(component: string): TooltipContextValue {
  const context = useContext(TooltipContext)
  if (!context) {
    throw new Error(`${component} must be used inside Tooltip`)
  }
  return context
}

function composeEventHandlers<E>(
  externalHandler: ((event: E) => void) | undefined,
  internalHandler: (event: E) => void
): (event: E) => void {
  return (event) => {
    externalHandler?.(event)
    internalHandler(event)
  }
}

function mergeDescribedBy(...values: Array<string | undefined>): string | undefined {
  const ids = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? [])
  if (ids.length === 0) return undefined
  return Array.from(new Set(ids)).join(' ')
}

function normalizeTooltipContentChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ className?: string }>(child) || child.type !== 'p') return child
    return cloneElement(child, { className: cx('[margin:0]', child.props.className) })
  })
}

type TriggerElement = ReactElement<{
  'aria-describedby'?: string
  className?: string
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void
}>

type TooltipContentElement = ReactElement<{
  children?: ReactNode
  id?: string
}>

function getExplicitContentId(children: ReactNode): string | undefined {
  let contentId: string | undefined

  Children.forEach(children, (child) => {
    if (contentId || !isValidElement(child)) return

    if (child.type === TooltipContent) {
      contentId = (child as TooltipContentElement).props.id
      return
    }

    contentId = getExplicitContentId((child as TooltipContentElement).props.children)
  })

  return contentId
}

export type TooltipAlign = 'center' | 'start'

export interface TooltipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'content'>, LocalizationMetadata {
  align?: TooltipAlign
  anchorRef?: { current: HTMLElement | null }
  children: ReactNode
  content?: ReactNode
  contentClassName?: string
  defaultOpen?: boolean
  disabled?: boolean
  offset?: number
  onOpenChange?: (open: boolean) => void
  open?: boolean
  portalled?: boolean
  side?: TooltipSide
}

export interface TooltipTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
  children?: ReactNode
}

export interface TooltipContentProps extends HTMLAttributes<HTMLSpanElement> {
  side?: TooltipSide
}
export interface TooltipProviderProps {
  children: ReactNode
}

export type { TooltipSide }

export function TooltipProvider({ children }: TooltipProviderProps): JSX.Element {
  return <>{children}</>
}

export const Tooltip = forwardRef<HTMLSpanElement, TooltipProps>(
  (
    {
      align = 'center',
      anchorRef,
      children,
      className,
      content,
      contentClassName,
      defaultOpen = false,
      disabled = false,
      offset = TOOLTIP_PORTAL_OFFSET,
      onOpenChange,
      open,
      portalled = false,
      side = 'top',
      ...props
    },
    ref
  ) => {
    const rootRef = useRef<HTMLSpanElement | null>(null)
    const generatedId = useId()
    const generatedContentId = `${generatedId}-content`
    const [contentId, setContentId] = useState(generatedContentId)
    const [contentScrollable, setContentScrollable] = useState(false)
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
    const closeTimerRef = useRef<number | null>(null)
    const explicitContentId = content === undefined ? getExplicitContentId(children) : undefined
    const describedContentId = explicitContentId ?? contentId
    const currentOpen = !disabled && (open ?? uncontrolledOpen)
    const requestedOpenRef = useRef(currentOpen)

    useEffect(() => {
      requestedOpenRef.current = currentOpen
    }, [currentOpen])

    const cancelScheduledClose = useCallback((): void => {
      if (closeTimerRef.current === null) return
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }, [])
    const setOpen = useCallback(
      (nextOpen: boolean) => {
        cancelScheduledClose()
        if (disabled && nextOpen) return
        if (!nextOpen && open === undefined) setUncontrolledOpen(false)
        if (nextOpen === requestedOpenRef.current) return
        requestedOpenRef.current = nextOpen
        if (open === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
      },
      [cancelScheduledClose, disabled, onOpenChange, open]
    )
    const scheduleClose = useCallback((): void => {
      cancelScheduledClose()
      closeTimerRef.current = window.setTimeout(() => setOpen(false), TOOLTIP_POINTER_TRANSITION_DELAY_MS)
    }, [cancelScheduledClose, setOpen])

    useEffect(() => cancelScheduledClose, [cancelScheduledClose])

    useEffect(() => {
      if (!disabled) return
      cancelScheduledClose()
      requestedOpenRef.current = false
      setUncontrolledOpen(false)
    }, [cancelScheduledClose, disabled])

    useEffect(() => {
      if (!currentOpen) return
      const dismiss = (event: KeyboardEvent): void => {
        const content = document.getElementById(describedContentId)
        if (event.key !== 'Escape' || event.defaultPrevented || !visibleContent(content) || !content.parentElement?.matches(':hover, :focus-within')) return
        event.preventDefault()
        setOpen(false)
      }
      document.addEventListener('keydown', dismiss, true)
      return () => document.removeEventListener('keydown', dismiss, true)
    }, [currentOpen, describedContentId, setOpen])

    const context = useMemo<TooltipContextValue>(
      () => ({
        align,
        anchorRef,
        cancelScheduledClose,
        contentId: describedContentId,
        contentScrollable,
        disabled,
        offset,
        open: currentOpen,
        portalled,
        rootRef,
        scheduleClose,
        setContentId,
        setContentScrollable,
        setOpen,
        side
      }),
      [align, anchorRef, cancelScheduledClose, contentScrollable, describedContentId, currentOpen, disabled, offset, portalled, scheduleClose, setOpen, side]
    )

    const contentSource = import.meta.env.DEV ? props['data-i18n-content'] : undefined
    const shortcutContent = content === undefined
      ? null
      : <TooltipContent className={contentClassName} {...(contentSource ? { 'data-i18n-text': contentSource } : {})}>{content}</TooltipContent>
    const setRootRef = (node: HTMLSpanElement | null): void => {
      rootRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ; (ref as MutableRefObject<HTMLSpanElement | null>).current = node
      }
    }

    return (
      <TooltipContext.Provider value={context}>
        <span
          className={cx(tooltipStyleClassName(), tooltipClassName({ className, disabled, open: currentOpen, side }))}
          data-side={side}
          data-state={currentOpen ? 'open' : 'closed'}
          ref={setRootRef}
          {...props}
        >
          {content === undefined ? children : <TooltipTrigger asChild>{children}</TooltipTrigger>}
          {shortcutContent}
        </span>
      </TooltipContext.Provider>
    )
  }
)

Tooltip.displayName = 'Tooltip'

export const TooltipTrigger = forwardRef<HTMLButtonElement, TooltipTriggerProps>(
  (
    {
      'aria-describedby': ariaDescribedBy,
      asChild = false,
      children,
      className,
      onBlur,
      onFocus,
      onMouseEnter,
      onMouseLeave,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const context = useTooltipContext('TooltipTrigger')
    const tooltipDescribedBy = context.open && !context.disabled ? context.contentId : undefined

    const show = (): void => context.setOpen(true)
    const hide = (): void => context.setOpen(false)
    const hideAfterPointerLeave = (): void => {
      if (context.contentScrollable) {
        context.scheduleClose()
        return
      }
      hide()
    }

    if (asChild) {
      if (!isValidElement(children)) {
        throw new Error('TooltipTrigger with asChild expects a single React element')
      }
      const child = children as TriggerElement
      const describedBy = mergeDescribedBy(ariaDescribedBy, child.props['aria-describedby'], tooltipDescribedBy)

      return cloneElement(child, {
        'aria-describedby': describedBy,
        className: cx(child.props.className, className),
        onBlur: composeEventHandlers(child.props.onBlur, hide),
        onFocus: composeEventHandlers(child.props.onFocus, show),
        onMouseEnter: composeEventHandlers(child.props.onMouseEnter, show),
        onMouseLeave: composeEventHandlers(child.props.onMouseLeave, hideAfterPointerLeave)
      })
    }

    return (
      <button
        aria-describedby={mergeDescribedBy(ariaDescribedBy, tooltipDescribedBy)}
        className={cx(tooltipTriggerClassName, className)}
        ref={ref}
        type={type}
        onBlur={composeEventHandlers(onBlur, hide)}
        onFocus={composeEventHandlers(onFocus, show)}
        onMouseEnter={composeEventHandlers(onMouseEnter, show)}
        onMouseLeave={composeEventHandlers(onMouseLeave, hideAfterPointerLeave)}
        {...props}
      >
        {children}
      </button>
    )
  }
)

TooltipTrigger.displayName = 'TooltipTrigger'

const TOOLTIP_POINTER_TRANSITION_DELAY_MS = 100
const TOOLTIP_PORTAL_OFFSET = 8
const TOOLTIP_PORTAL_VIEWPORT_MARGIN = 8

function clampTooltipCoordinate(value: number, size: number, limit: number): number {
  return Math.max(
    TOOLTIP_PORTAL_VIEWPORT_MARGIN,
    Math.min(value, limit - size - TOOLTIP_PORTAL_VIEWPORT_MARGIN)
  )
}

function portalledTooltipStyle(
  anchor: DOMRect,
  content: DOMRect,
  side: TooltipSide,
  align: TooltipAlign,
  offset: number
): CSSProperties {
  if (side === 'right') {
    return {
      left: clampTooltipCoordinate(anchor.right + offset, content.width, window.innerWidth),
      position: 'fixed',
      top: clampTooltipCoordinate(align === 'start' ? anchor.top : anchor.top + (anchor.height - content.height) / 2, content.height, window.innerHeight)
    }
  }
  if (side === 'bottom') {
    return {
      left: clampTooltipCoordinate(align === 'start' ? anchor.left : anchor.left + (anchor.width - content.width) / 2, content.width, window.innerWidth),
      position: 'fixed',
      top: clampTooltipCoordinate(anchor.bottom + offset, content.height, window.innerHeight)
    }
  }
  if (side === 'left') {
    return {
      left: clampTooltipCoordinate(anchor.left - content.width - offset, content.width, window.innerWidth),
      position: 'fixed',
      top: clampTooltipCoordinate(align === 'start' ? anchor.top : anchor.top + (anchor.height - content.height) / 2, content.height, window.innerHeight)
    }
  }
  return {
    left: clampTooltipCoordinate(align === 'start' ? anchor.left : anchor.left + (anchor.width - content.width) / 2, content.width, window.innerWidth),
    position: 'fixed',
    top: clampTooltipCoordinate(anchor.top - content.height - offset, content.height, window.innerHeight)
  }
}

function initialPortalledTooltipStyle(
  anchor: DOMRect,
  side: TooltipSide,
  align: TooltipAlign,
  offset: number
): CSSProperties {
  if (side === 'right') {
    return {
      left: anchor.right + offset,
      position: 'fixed',
      top: align === 'start' ? anchor.top : anchor.top + anchor.height / 2
    }
  }
  if (side === 'bottom') {
    return {
      left: align === 'start' ? anchor.left : anchor.left + anchor.width / 2,
      position: 'fixed',
      top: anchor.bottom + offset
    }
  }
  if (side === 'left') {
    return {
      left: anchor.left - offset,
      position: 'fixed',
      top: align === 'start' ? anchor.top : anchor.top + anchor.height / 2
    }
  }
  return {
    left: align === 'start' ? anchor.left : anchor.left + anchor.width / 2,
    position: 'fixed',
    top: anchor.top - offset
  }
}

function sameTooltipStyle(left: unknown, right: CSSProperties): boolean {
  if (!left || typeof left !== 'object') return false
  const value = left as CSSProperties
  return value.left === right.left && value.position === right.position && value.top === right.top
}

export const TooltipContent = forwardRef<HTMLSpanElement, TooltipContentProps>(
  ({ children, className, id, onMouseEnter, onMouseLeave, side, style, ...props }, ref) => {
    const context = useTooltipContext('TooltipContent')
    const currentSide = side ?? context.side
    const contentId = id ?? context.contentId
    const contentRef = useRef<HTMLSpanElement | null>(null)
    const [portalledStyle, setPortalledStyle] = useState<CSSProperties | null>(null)
    const [scrollable, setScrollable] = useState(false)
    const updatePortalledStyle = useCallback((): void => {
      if (!context.open || context.disabled || !context.portalled) return
      const anchor = context.anchorRef?.current ?? context.rootRef.current
      const content = contentRef.current
      if (!anchor || !content) return
      const nextStyle = portalledTooltipStyle(anchor.getBoundingClientRect(), content.getBoundingClientRect(), currentSide, context.align, context.offset)
      setPortalledStyle((previousStyle) => sameTooltipStyle(previousStyle, nextStyle) ? previousStyle : nextStyle)
    }, [context.align, context.anchorRef, context.disabled, context.offset, context.open, context.portalled, context.rootRef, currentSide])

    useEffect(() => {
      context.setContentId(contentId)
    }, [contentId, context])

    useLayoutEffect(() => {
      if (!context.open || context.disabled) return
      const content = contentRef.current
      if (!content) return
      const measureScrollable = (): void => {
        const nextScrollable = content.scrollHeight > content.clientHeight
        setScrollable(nextScrollable)
        context.setContentScrollable(nextScrollable)
      }
      measureScrollable()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(measureScrollable)
      observer.observe(content)
      return () => {
        observer.disconnect()
        context.setContentScrollable(false)
      }
    }, [children, context.disabled, context.open, context.setContentScrollable])

    useLayoutEffect(() => {
      if (!context.open || context.disabled || !context.portalled) return
      updatePortalledStyle()
      window.addEventListener('resize', updatePortalledStyle)
      window.addEventListener('scroll', updatePortalledStyle, true)
      return () => {
        window.removeEventListener('resize', updatePortalledStyle)
        window.removeEventListener('scroll', updatePortalledStyle, true)
      }
    }, [context.disabled, context.open, context.portalled, updatePortalledStyle])

    if (!context.open || context.disabled) return null
    const anchor = context.anchorRef?.current ?? context.rootRef.current
    const fallbackPortalledStyle = context.portalled && anchor
      ? initialPortalledTooltipStyle(anchor.getBoundingClientRect(), currentSide, context.align, context.offset)
      : null

    const setContentRef = (node: HTMLSpanElement | null): void => {
      contentRef.current = node
      if (node) window.requestAnimationFrame(updatePortalledStyle)
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ; (ref as MutableRefObject<HTMLSpanElement | null>).current = node
      }
    }
    const content = (
      <span
        className={cx(
          tooltipContentClassName,
          scrollable ? 'pointer-events-auto' : 'pointer-events-none',
          !context.portalled && tooltipContentSideClassNames[currentSide],
          `vds-tooltip--${currentSide}`,
          className
        )}
        data-side={currentSide}
        id={contentId}
        onMouseEnter={composeEventHandlers(onMouseEnter, () => {
          context.cancelScheduledClose()
          context.setOpen(true)
        })}
        onMouseLeave={composeEventHandlers(onMouseLeave, context.scheduleClose)}
        ref={setContentRef}
        role="tooltip"
        style={context.portalled ? { ...fallbackPortalledStyle, ...portalledStyle, ...style } : style}
        {...props}
      >
        {normalizeTooltipContentChildren(children)}
      </span>
    )

    return context.portalled ? createPortal(content, document.body) : content
  }
)

TooltipContent.displayName = 'TooltipContent'
