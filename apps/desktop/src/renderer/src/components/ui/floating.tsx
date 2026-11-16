import type * as React from 'react'
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react'

import { cx } from './utils'
import { inFocusScope, visibleContent } from './focus'
import { usePortalDocument } from './portal'

export interface OpenRootProps {
  children?: ReactNode
  defaultOpen?: boolean
  dismissOnEscape?: boolean
  dismissOnOutsidePointerDown?: boolean
  onOpenChange?: (open: boolean) => void
  open?: boolean
}

export interface OpenContextValue {
  anchorRef: MutableRefObject<HTMLElement | null>
  contentId: string
  contentRef: RefObject<HTMLDivElement | null>
  open: boolean
  position: FloatingPosition | null
  setOpen: (open: boolean) => void
  setContentDocument: (document: Document | null) => void
  setPosition: (position: FloatingPosition | null) => void
}

export type FloatingPosition =
  | { kind: 'point'; x: number; y: number }
  | { bottom: number; kind: 'anchor'; left: number; top: number; width: number }

export type FloatingSide = 'auto' | 'bottom' | 'left' | 'right' | 'top'

/**
 * 浮层相对锚点在**交叉轴**上的对齐；语义与 Menu 的 align 一致，避免各业务自己算偏移。
 *
 * side 为 top/bottom 时交叉轴是水平的（start=左对齐、end=右对齐）；side 为 left/right
 * 时交叉轴是垂直的（start=顶对齐、end=底对齐）。同 Tooltip 的 side/align 组合口径。
 */
export type FloatingAlign = 'center' | 'end' | 'start'

const openContents = new Set<RefObject<HTMLDivElement | null>>()
const FLOATING_OFFSET = 6
const FLOATING_VIEWPORT_PADDING = 8
const FLOATING_ANCHOR_WIDTH = '--floating-anchor-width'
const FLOATING_AVAILABLE_HEIGHT = '--floating-available-height'
type FloatingContentStyle = CSSProperties &
  Partial<Record<typeof FLOATING_AVAILABLE_HEIGHT | typeof FLOATING_ANCHOR_WIDTH, string>>
const CLIPPING_OVERFLOW_VALUES = new Set(['auto', 'clip', 'hidden', 'scroll'])

function elementClipsContent(element: Element): boolean {
  const style = getComputedStyle(element)
  return (
    CLIPPING_OVERFLOW_VALUES.has(style.overflowX) || CLIPPING_OVERFLOW_VALUES.has(style.overflowY)
  )
}

function clampFloatingLeft(rawLeft: number, contentWidth: number, viewportWidth: number): number {
  const maxLeft = Math.max(
    FLOATING_VIEWPORT_PADDING,
    viewportWidth - contentWidth - FLOATING_VIEWPORT_PADDING
  )
  return Math.min(Math.max(rawLeft, FLOATING_VIEWPORT_PADDING), maxLeft)
}

function clampFloatingTop(rawTop: number, contentHeight: number, viewportHeight: number): number {
  const maxTop = Math.max(
    FLOATING_VIEWPORT_PADDING,
    viewportHeight - contentHeight - FLOATING_VIEWPORT_PADDING
  )
  return Math.min(Math.max(rawTop, FLOATING_VIEWPORT_PADDING), maxTop)
}

function anchorAlignedLeft(
  position: Extract<FloatingPosition, { kind: 'anchor' }>,
  contentWidth: number,
  viewportWidth: number,
  align: FloatingAlign = 'start'
): number {
  const alignedLeft =
    align === 'end'
      ? position.left + position.width - contentWidth
      : align === 'center'
        ? position.left + (position.width - contentWidth) / 2
        : position.left
  const fitsAligned =
    alignedLeft >= FLOATING_VIEWPORT_PADDING &&
    alignedLeft + contentWidth <= viewportWidth - FLOATING_VIEWPORT_PADDING
  if (fitsAligned) return alignedLeft
  return clampFloatingLeft(alignedLeft, contentWidth, viewportWidth)
}

/** anchorAlignedTop 的垂直版：left/right 侧浮层沿锚点高度对齐，越界时夹回视口。 */
function anchorAlignedTop(
  position: Extract<FloatingPosition, { kind: 'anchor' }>,
  contentHeight: number,
  viewportHeight: number,
  align: FloatingAlign = 'start'
): number {
  const alignedTop =
    align === 'end'
      ? position.bottom - contentHeight
      : align === 'center'
        ? position.top + (position.bottom - position.top - contentHeight) / 2
        : position.top
  const fitsAligned =
    alignedTop >= FLOATING_VIEWPORT_PADDING &&
    alignedTop + contentHeight <= viewportHeight - FLOATING_VIEWPORT_PADDING
  if (fitsAligned) return alignedTop
  return clampFloatingTop(alignedTop, contentHeight, viewportHeight)
}

function floatingPositionStyle(
  position: FloatingPosition,
  contentSize: { height: number; width: number; verticalChrome: number },
  side: FloatingSide = 'auto',
  align: FloatingAlign = 'start',
  window: Pick<Window, 'innerWidth' | 'innerHeight'> = globalThis.window,
  sideOffset = FLOATING_OFFSET
): FloatingContentStyle {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  if (position.kind === 'point') {
    const left = clampFloatingLeft(position.x, contentSize.width, viewportWidth)
    return {
      left,
      position: 'fixed',
      top: clampFloatingTop(position.y, contentSize.height, viewportHeight),
    }
  }

  // left/right 侧：主轴贴在锚点左/右缘外侧，交叉轴（垂直）由 align 决定。
  // 显式指定的 side 一律只做视口夹取、不翻转，与 top/bottom 的既有口径一致。
  if (side === 'left' || side === 'right') {
    const rawLeft =
      side === 'right'
        ? position.left + position.width + sideOffset
        : position.left - contentSize.width - sideOffset
    return {
      left: clampFloatingLeft(rawLeft, contentSize.width, viewportWidth),
      position: 'fixed',
      top: anchorAlignedTop(position, contentSize.height, viewportHeight, align),
    }
  }

  const left = anchorAlignedLeft(position, contentSize.width, viewportWidth, align)
  const belowTop = position.bottom + sideOffset
  const aboveTop = position.top - contentSize.height - sideOffset
  const fitsBelow = belowTop + contentSize.height <= viewportHeight - FLOATING_VIEWPORT_PADDING
  const fitsAbove = aboveTop >= FLOATING_VIEWPORT_PADDING
  const resolvedSide = side === 'auto' ? (fitsBelow || !fitsAbove ? 'bottom' : 'top') : side
  const rawTop = resolvedSide === 'top' ? aboveTop : belowTop
  const availableHeight = Math.max(
    0,
    (resolvedSide === 'top'
      ? position.top - sideOffset - FLOATING_VIEWPORT_PADDING
      : viewportHeight - belowTop - FLOATING_VIEWPORT_PADDING) - contentSize.verticalChrome
  )
  return {
    ...(align === 'end' ? { right: viewportWidth - left - contentSize.width } : { left }),
    [FLOATING_AVAILABLE_HEIGHT]: `${availableHeight}px`,
    position: 'fixed',
    top: clampFloatingTop(rawTop, contentSize.height, viewportHeight),
  }
}

function anchorIntersectsVisibleArea(anchor: HTMLElement, rect: DOMRect): boolean {
  const window = anchor.ownerDocument.defaultView ?? globalThis.window
  let visibleBottom = window.innerHeight
  let visibleLeft = 0
  let visibleRight = window.innerWidth
  let visibleTop = 0

  for (let ancestor = anchor.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    const clipsX = CLIPPING_OVERFLOW_VALUES.has(style.overflowX)
    const clipsY = CLIPPING_OVERFLOW_VALUES.has(style.overflowY)
    if (!clipsX && !clipsY) continue
    const bounds = ancestor.getBoundingClientRect()
    if (clipsX) {
      visibleLeft = Math.max(visibleLeft, bounds.left)
      visibleRight = Math.min(visibleRight, bounds.right)
    }
    if (clipsY) {
      visibleTop = Math.max(visibleTop, bounds.top)
      visibleBottom = Math.min(visibleBottom, bounds.bottom)
    }
  }

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > visibleLeft &&
    rect.left < visibleRight &&
    rect.bottom > visibleTop &&
    rect.top < visibleBottom
  )
}

export function createOpenContext(
  name: string,
  { dismissOutside = true }: { dismissOutside?: boolean } = {}
): {
  Provider: (props: OpenRootProps) => React.JSX.Element
  useOpenContext: () => OpenContextValue
} {
  const Context = createContext<OpenContextValue | null>(null)

  function Provider({
    children,
    defaultOpen = false,
    dismissOnEscape = true,
    dismissOnOutsidePointerDown = true,
    onOpenChange,
    open,
  }: OpenRootProps): React.JSX.Element {
    const document = usePortalDocument()
    const anchorRef = useRef<HTMLElement | null>(null)
    const contentId = useId()
    const contentRef = useRef<HTMLDivElement>(null)
    const [contentDocument, setContentDocument] = useState<Document | null>(null)
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
    const [position, setPosition] = useState<FloatingPosition | null>(null)
    const currentOpen = open ?? uncontrolledOpen

    const setOpen = useCallback(
      (nextOpen: boolean): void => {
        if (open === undefined) {
          setUncontrolledOpen(nextOpen)
        }
        onOpenChange?.(nextOpen)
      },
      [onOpenChange, open]
    )

    useLayoutEffect(() => {
      if (!currentOpen || position) return
      const anchor =
        anchorRef.current ??
        document.querySelector<HTMLElement>(`[aria-controls~="${CSS.escape(contentId)}"]`)
      if (!anchor) return
      anchorRef.current = anchor
      const rect = anchor.getBoundingClientRect()
      setPosition({
        bottom: rect.bottom,
        kind: 'anchor',
        left: rect.left,
        top: rect.top,
        width: rect.width,
      })
    }, [contentId, currentOpen, position, document])

    useEffect(() => {
      if (!currentOpen) return undefined

      openContents.add(contentRef)
      const handleKeyDown = (event: KeyboardEvent): void => {
        const eventDocument = event.currentTarget as Document
        if (
          event.defaultPrevented ||
          !dismissOnEscape ||
          event.key !== 'Escape' ||
          !visibleContent(contentRef.current) ||
          (!inFocusScope(contentRef.current, eventDocument.activeElement) &&
            eventDocument.activeElement?.getAttribute('aria-controls') !== contentId)
        )
          return
        const content = contentRef.current
        if (
          [...openContents].some(
            (ref) =>
              ref !== contentRef &&
              visibleContent(ref.current) &&
              inFocusScope(content, ref.current) &&
              (inFocusScope(ref.current, eventDocument.activeElement) ||
                eventDocument.activeElement?.getAttribute('aria-controls') === ref.current.id)
          )
        )
          return
        event.preventDefault()
        setOpen(false)
      }

      const documents = new Set(
        [document, contentDocument].filter((target): target is Document => Boolean(target))
      )
      for (const target of documents) target.addEventListener('keydown', handleKeyDown)
      return () => {
        openContents.delete(contentRef)
        for (const target of documents) target.removeEventListener('keydown', handleKeyDown)
      }
    }, [contentId, currentOpen, dismissOnEscape, setOpen, document, contentDocument])

    useEffect(() => {
      if (!currentOpen) return undefined

      const handlePointerDown = (event: PointerEvent): void => {
        if (!dismissOutside || !dismissOnOutsidePointerDown) return
        if (
          event.target instanceof document.defaultView!.Node &&
          anchorRef.current?.contains(event.target)
        )
          return
        if (!visibleContent(contentRef.current) || inFocusScope(contentRef.current, event.target))
          return
        setOpen(false)
      }

      const documents = new Set(
        [document, contentDocument].filter((target): target is Document => Boolean(target))
      )
      for (const target of documents) target.addEventListener('pointerdown', handlePointerDown)
      return () => {
        for (const target of documents) target.removeEventListener('pointerdown', handlePointerDown)
      }
    }, [currentOpen, dismissOnOutsidePointerDown, setOpen, document, contentDocument])

    return (
      <Context.Provider
        value={{
          anchorRef,
          contentId,
          contentRef,
          open: currentOpen,
          position,
          setOpen,
          setContentDocument,
          setPosition,
        }}
      >
        {children}
      </Context.Provider>
    )
  }

  function useOpenContext(): OpenContextValue {
    const context = useContext(Context)
    if (!context) throw new Error(`${name} must be used inside ${name} root`)
    return context
  }

  return { Provider, useOpenContext }
}

export function triggerProps(
  context: OpenContextValue,
  props: HTMLAttributes<HTMLElement> & { children?: ReactNode },
  eventName: 'onClick' | 'onContextMenu' | 'onMouseEnter'
): HTMLAttributes<HTMLElement> {
  const hoverProps =
    eventName === 'onMouseEnter'
      ? {
          onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
            props.onMouseLeave?.(event)
            if (event.defaultPrevented) return
            context.setOpen(false)
          },
        }
      : undefined

  return {
    ...props,
    ...hoverProps,
    'aria-controls': context.contentId,
    'aria-expanded': context.open,
    [eventName]: (event: ReactMouseEvent<HTMLElement>) => {
      props[eventName]?.(event)
      if (event.defaultPrevented) return
      if (eventName === 'onContextMenu') {
        event.preventDefault()
        context.anchorRef.current = null
        context.setPosition({ kind: 'point', x: event.clientX, y: event.clientY })
      } else {
        context.anchorRef.current = event.currentTarget
        const rect = event.currentTarget.getBoundingClientRect()
        context.setPosition({
          bottom: rect.bottom,
          kind: 'anchor',
          left: rect.left,
          top: rect.top,
          width: rect.width,
        })
      }
      context.setOpen(eventName === 'onClick' ? !context.open : true)
    },
  }
}

export function renderTrigger(
  context: OpenContextValue,
  props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode },
  eventName: 'onClick' | 'onContextMenu' | 'onMouseEnter' = 'onClick'
): React.JSX.Element {
  const { asChild, children, ...rest } = props
  const nextProps = triggerProps(context, rest, eventName)
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLElement>>
    return cloneElement(child, {
      ...nextProps,
      className: cx(child.props.className, nextProps.className),
      [eventName]: (event: ReactMouseEvent<HTMLElement>) => {
        child.props[eventName]?.(event)
        nextProps[eventName]?.(event as never)
      },
    })
  }
  return (
    <button type="button" {...nextProps}>
      {children}
    </button>
  )
}

function useTrackedFloatingStyle(
  context: OpenContextValue,
  active: boolean,
  side: FloatingSide,
  align: FloatingAlign = 'start',
  sideBoundaryRef?: RefObject<HTMLElement | null>,
  horizontalAnchorRef?: RefObject<HTMLElement | null>,
  sideOffset = FLOATING_OFFSET
): CSSProperties | undefined {
  const { anchorRef, contentRef, position, setOpen, setContentDocument } = context
  const document = usePortalDocument()
  const window = document.defaultView ?? globalThis.window
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    setContentDocument(document)
    return () => setContentDocument(null)
  }, [document, setContentDocument])

  useLayoutEffect(() => {
    if (!active || !position || !contentRef.current) {
      setFloatingStyle(undefined)
      return
    }

    const update = (): void => {
      if (!contentRef.current) return
      const anchorRect =
        position.kind === 'anchor' ? anchorRef.current?.getBoundingClientRect() : undefined
      const triggerPosition = anchorRect
        ? {
            bottom: anchorRect.bottom,
            kind: 'anchor' as const,
            left: anchorRect.left,
            top: anchorRect.top,
            width: anchorRect.width,
          }
        : position
      const horizontalAnchor = horizontalAnchorRef?.current?.getBoundingClientRect()
      const currentPosition =
        horizontalAnchor && triggerPosition.kind === 'anchor'
          ? { ...triggerPosition, left: horizontalAnchor.left, width: horizontalAnchor.width }
          : triggerPosition
      const boundary = sideBoundaryRef?.current?.getBoundingClientRect()
      const horizontal = side === 'left' || side === 'right'
      const boundaryPosition =
        boundary && horizontal && currentPosition.kind === 'anchor'
          ? { ...currentPosition, left: boundary.left, width: boundary.width }
          : currentPosition
      const leftSpace = boundary ? boundary.left - FLOATING_VIEWPORT_PADDING - FLOATING_OFFSET : 0
      const rightSpace = boundary
        ? window.innerWidth - boundary.right - FLOATING_VIEWPORT_PADDING - FLOATING_OFFSET
        : 0
      const resolvedSide =
        boundary && horizontal
          ? (side === 'left' ? leftSpace : rightSpace) >= contentRef.current.offsetWidth
            ? side
            : leftSpace >= rightSpace
              ? 'left'
              : 'right'
          : side
      const maxWidth =
        boundary && horizontal
          ? Math.max(0, resolvedSide === 'left' ? leftSpace : rightSpace)
          : undefined
      const width =
        maxWidth === undefined
          ? contentRef.current.offsetWidth
          : Math.min(contentRef.current.offsetWidth, maxWidth)
      const contentStyle = window.getComputedStyle(contentRef.current)
      const verticalChrome =
        parseFloat(contentStyle.paddingTop) +
        parseFloat(contentStyle.paddingBottom) +
        parseFloat(contentStyle.borderTopWidth) +
        parseFloat(contentStyle.borderBottomWidth)
      setFloatingStyle({
        ...floatingPositionStyle(
          boundaryPosition,
          {
            height: contentRef.current.offsetHeight,
            width,
            verticalChrome,
          },
          resolvedSide,
          align,
          window,
          sideOffset
        ),
        ...(maxWidth === undefined ? {} : { maxWidth }),
        ...(horizontalAnchor ? { [FLOATING_ANCHOR_WIDTH]: `${horizontalAnchor.width}px` } : {}),
      })
    }

    const handleScroll = (event: Event): void => {
      const anchor = position.kind === 'anchor' ? anchorRef.current : null
      const anchorRect = anchor?.getBoundingClientRect()
      const anchorWindow = anchor?.ownerDocument.defaultView ?? window
      const scrollContainer = event.target instanceof anchorWindow.Element ? event.target : null
      if (
        anchor &&
        anchorRect &&
        scrollContainer?.contains(anchor) &&
        elementClipsContent(scrollContainer) &&
        !anchorIntersectsVisibleArea(anchor, anchorRect)
      ) {
        setFloatingStyle(undefined)
        setOpen(false)
        return
      }
      update()
    }

    update()
    const windows = new Set([window, anchorRef.current?.ownerDocument.defaultView ?? window])
    for (const target of windows) {
      target.addEventListener('resize', update)
      target.addEventListener('scroll', handleScroll, true)
    }
    const observer = new ResizeObserver(update)
    observer.observe(contentRef.current)
    if (anchorRef.current) observer.observe(anchorRef.current)
    if (horizontalAnchorRef?.current) observer.observe(horizontalAnchorRef.current)
    if (sideBoundaryRef?.current) observer.observe(sideBoundaryRef.current)
    return () => {
      for (const target of windows) {
        target.removeEventListener('resize', update)
        target.removeEventListener('scroll', handleScroll, true)
      }
      observer.disconnect()
    }
  }, [
    active,
    window,
    align,
    anchorRef,
    contentRef,
    horizontalAnchorRef,
    position,
    setOpen,
    side,
    sideBoundaryRef,
    sideOffset,
  ])

  return floatingStyle
}

export function useFloatingContentStyle(
  context: OpenContextValue,
  style?: CSSProperties,
  side: FloatingSide = 'auto',
  align: FloatingAlign = 'start',
  horizontalAnchorRef?: RefObject<HTMLElement | null>
): CSSProperties | undefined {
  const { open, position } = context
  const floatingStyle = useTrackedFloatingStyle(
    context,
    open,
    side,
    align,
    undefined,
    horizontalAnchorRef
  )

  if (!position) return { visibility: 'hidden', ...style }
  return {
    visibility: floatingStyle ? 'visible' : 'hidden',
    ...floatingStyle,
    ...style,
  }
}

export function useFloatingContentPosition(
  context: OpenContextValue,
  active: boolean,
  style?: CSSProperties,
  side: FloatingSide = 'auto',
  align: FloatingAlign = 'start',
  sideBoundaryRef?: RefObject<HTMLElement | null>,
  positionAnchorRef?: RefObject<HTMLElement | null>,
  sideOffset?: number
): CSSProperties | undefined {
  const { position } = context
  const floatingStyle = useTrackedFloatingStyle(
    positionAnchorRef?.current ? { ...context, anchorRef: positionAnchorRef } : context,
    active,
    side,
    align,
    sideBoundaryRef,
    undefined,
    sideOffset
  )

  if (!position) return style
  return {
    visibility: floatingStyle ? 'visible' : 'hidden',
    ...floatingStyle,
    ...style,
  }
}
