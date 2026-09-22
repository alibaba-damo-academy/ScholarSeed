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
  type RefObject
} from 'react'

import { cx } from './utils'
import { inFocusScope, visibleContent } from './focus'

export interface OpenRootProps {
  children?: ReactNode
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  open?: boolean
}

export interface OpenContextValue {
  anchorRef: MutableRefObject<HTMLElement | null>
  contentId: string
  contentRef: RefObject<HTMLDivElement>
  open: boolean
  position: FloatingPosition | null
  setOpen: (open: boolean) => void
  setPosition: (position: FloatingPosition | null) => void
}

type FloatingPosition =
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

const openContents = new Set<RefObject<HTMLDivElement>>()
const FLOATING_OFFSET = 6
const FLOATING_VIEWPORT_PADDING = 8
const CLIPPING_OVERFLOW_VALUES = new Set(['auto', 'clip', 'hidden', 'scroll'])

function elementClipsContent(element: Element): boolean {
  const style = getComputedStyle(element)
  return CLIPPING_OVERFLOW_VALUES.has(style.overflowX) || CLIPPING_OVERFLOW_VALUES.has(style.overflowY)
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
  const alignedLeft = align === 'end'
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
  const alignedTop = align === 'end'
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
  contentSize: { height: number; width: number },
  side: FloatingSide = 'auto',
  align: FloatingAlign = 'start'
): CSSProperties {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  if (position.kind === 'point') {
    const left = clampFloatingLeft(position.x, contentSize.width, viewportWidth)
    return {
      left,
      position: 'fixed',
      top: clampFloatingTop(position.y, contentSize.height, viewportHeight)
    }
  }

  // left/right 侧：主轴贴在锚点左/右缘外侧，交叉轴（垂直）由 align 决定。
  // 显式指定的 side 一律只做视口夹取、不翻转，与 top/bottom 的既有口径一致。
  if (side === 'left' || side === 'right') {
    const rawLeft = side === 'right'
      ? position.left + position.width + FLOATING_OFFSET
      : position.left - contentSize.width - FLOATING_OFFSET
    return {
      left: clampFloatingLeft(rawLeft, contentSize.width, viewportWidth),
      position: 'fixed',
      top: anchorAlignedTop(position, contentSize.height, viewportHeight, align)
    }
  }

  const left = anchorAlignedLeft(position, contentSize.width, viewportWidth, align)
  const belowTop = position.bottom + FLOATING_OFFSET
  const aboveTop = position.top - contentSize.height - FLOATING_OFFSET
  const fitsBelow =
    belowTop + contentSize.height <= viewportHeight - FLOATING_VIEWPORT_PADDING
  const fitsAbove = aboveTop >= FLOATING_VIEWPORT_PADDING
  const rawTop = side === 'top'
    ? aboveTop
    : side === 'bottom'
      ? belowTop
      : fitsBelow || !fitsAbove ? belowTop : aboveTop
  return {
    left,
    position: 'fixed',
    top: clampFloatingTop(rawTop, contentSize.height, viewportHeight)
  }
}

function anchorIntersectsVisibleArea(anchor: HTMLElement, rect: DOMRect): boolean {
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

  return rect.width > 0 && rect.height > 0 && rect.right > visibleLeft && rect.left < visibleRight &&
    rect.bottom > visibleTop && rect.top < visibleBottom
}

export function createOpenContext(name: string, { dismissOutside = true }: { dismissOutside?: boolean } = {}): {
  Provider: (props: OpenRootProps) => JSX.Element
  useOpenContext: () => OpenContextValue
} {
  const Context = createContext<OpenContextValue | null>(null)

  function Provider({ children, defaultOpen = false, onOpenChange, open }: OpenRootProps): JSX.Element {
    const anchorRef = useRef<HTMLElement>(null)
    const contentId = useId()
    const contentRef = useRef<HTMLDivElement>(null)
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
    const [position, setPosition] = useState<FloatingPosition | null>(null)
    const currentOpen = open ?? uncontrolledOpen

    const setOpen = useCallback((nextOpen: boolean): void => {
      if (open === undefined) {
        setUncontrolledOpen(nextOpen)
      }
      onOpenChange?.(nextOpen)
    }, [onOpenChange, open])

    useEffect(() => {
      if (!currentOpen) return undefined

      openContents.add(contentRef)
      const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.defaultPrevented || event.key !== 'Escape' || !visibleContent(contentRef.current) || !inFocusScope(contentRef.current, document.activeElement) && document.activeElement?.getAttribute('aria-controls') !== contentId) return
        const content = contentRef.current
        if ([...openContents].some((ref) => ref !== contentRef && visibleContent(ref.current) &&
          inFocusScope(content, ref.current) && inFocusScope(ref.current, document.activeElement))) return
        event.preventDefault()
        setOpen(false)
      }

      document.addEventListener('keydown', handleKeyDown)
      return () => {
        openContents.delete(contentRef)
        document.removeEventListener('keydown', handleKeyDown)
      }
    }, [currentOpen, setOpen])

    useEffect(() => {
      if (!currentOpen) return undefined

      const handlePointerDown = (event: PointerEvent): void => {
        if (!dismissOutside) return
        if (!visibleContent(contentRef.current) || inFocusScope(contentRef.current, event.target)) return
        setOpen(false)
      }

      document.addEventListener('pointerdown', handlePointerDown)
      return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [currentOpen, setOpen])

    return <Context.Provider value={{ anchorRef, contentId, contentRef, open: currentOpen, position, setOpen, setPosition }}>{children}</Context.Provider>
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
  const hoverProps = eventName === 'onMouseEnter'
    ? {
        onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => {
          props.onMouseLeave?.(event)
          if (event.defaultPrevented) return
          context.setOpen(false)
        }
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
        context.setPosition({ bottom: rect.bottom, kind: 'anchor', left: rect.left, top: rect.top, width: rect.width })
      }
      context.setOpen(eventName === 'onClick' ? !context.open : true)
    }
  }
}

export function renderTrigger(
  context: OpenContextValue,
  props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode },
  eventName: 'onClick' | 'onContextMenu' | 'onMouseEnter' = 'onClick'
): JSX.Element {
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
      }
    })
  }
  return <button type="button" {...nextProps}>{children}</button>
}

function useTrackedFloatingStyle(
  context: OpenContextValue,
  active: boolean,
  side: FloatingSide,
  align: FloatingAlign = 'start'
): CSSProperties | undefined {
  const { anchorRef, contentRef, position, setOpen } = context
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    if (!active || !position || !contentRef.current) {
      setFloatingStyle(undefined)
      return
    }

    const update = (): void => {
      if (!contentRef.current) return
      const anchorRect = position.kind === 'anchor' ? anchorRef.current?.getBoundingClientRect() : undefined
      const currentPosition = anchorRect
        ? { bottom: anchorRect.bottom, kind: 'anchor' as const, left: anchorRect.left, top: anchorRect.top, width: anchorRect.width }
        : position
      setFloatingStyle(floatingPositionStyle(currentPosition, {
        height: contentRef.current.offsetHeight,
        width: contentRef.current.offsetWidth
      }, side, align))
    }

    const handleScroll = (event: Event): void => {
      const anchor = position.kind === 'anchor' ? anchorRef.current : null
      const anchorRect = anchor?.getBoundingClientRect()
      const scrollContainer = event.target instanceof Element ? event.target : null
      if (anchor && anchorRect && scrollContainer?.contains(anchor) && elementClipsContent(scrollContainer) &&
        !anchorIntersectsVisibleArea(anchor, anchorRect)) {
        setFloatingStyle(undefined)
        setOpen(false)
        return
      }
      update()
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', handleScroll, true)
    const observer = new ResizeObserver(update)
    observer.observe(contentRef.current)
    if (anchorRef.current) observer.observe(anchorRef.current)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', handleScroll, true)
      observer.disconnect()
    }
  }, [active, align, anchorRef, contentRef, position, setOpen, side])

  return floatingStyle
}

export function useFloatingContentStyle(
  context: OpenContextValue,
  style?: CSSProperties,
  side: FloatingSide = 'auto',
  align: FloatingAlign = 'start'
): CSSProperties | undefined {
  const { open, position } = context
  const floatingStyle = useTrackedFloatingStyle(context, open, side, align)

  if (!position) return style
  return {
    visibility: floatingStyle ? 'visible' : 'hidden',
    ...floatingStyle,
    ...style
  }
}

export function useFloatingContentPosition(
  context: OpenContextValue,
  active: boolean,
  style?: CSSProperties,
  side: FloatingSide = 'auto',
  align: FloatingAlign = 'start'
): CSSProperties | undefined {
  const { position } = context
  const floatingStyle = useTrackedFloatingStyle(context, active, side, align)

  if (!position) return style
  return {
    visibility: floatingStyle ? 'visible' : 'hidden',
    ...floatingStyle,
    ...style
  }
}
