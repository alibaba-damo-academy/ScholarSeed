import type { HTMLAttributes, Ref } from 'react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { IconButton } from './IconButton'
import {
  scrollAreaBarClassName,
  scrollAreaClassName,
  scrollAreaStyleClassName,
  scrollAreaViewportClassName,
  type ScrollAreaOrientation,
} from './classes'
import { cx } from './utils'

export type { ScrollAreaOrientation }

export type ScrollAreaViewportProps = HTMLAttributes<HTMLDivElement> & {
  [key: `data-${string}`]: boolean | number | string | undefined
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ScrollAreaOrientation
  shadow?: boolean | 'auto'
  overlay?: boolean
  overlayScrollOnly?: boolean
  overlayVerticalInsetSelector?: string
  viewportClassName?: string
  viewportProps?: ScrollAreaViewportProps
  viewportRef?: Ref<HTMLDivElement>
  horizontalControls?: {
    previous: string
    next: string
    hoverOnly?: boolean
    variant?: 'default' | 'image'
    scrollBy?: 'page' | 'items'
  }
}

const SCROLL_EDGE_TOLERANCE = 1
const OVERLAY_SCROLLBAR_IDLE_MS = 800
const HORIZONTAL_CONTROL_CLASS =
  'box-border !size-[var(--vds-icon-9)] !min-h-0 !min-w-0 !rounded-[var(--vds-radius-3)] !border !border-solid !border-[var(--vds-divider-default)] !bg-[var(--vds-bg-white-default)] !p-0 !text-[var(--vds-text-secondary)] !shadow-none [--vds-icon-button-glyph:var(--vds-icon-6)] pointer-events-auto'
const IMAGE_CONTROL_CLASS =
  'pointer-events-auto !size-[var(--vds-image-strip-control-size)] !min-h-0 !min-w-0 !rounded-[var(--vds-radius-3)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-bg-white-default)] !p-0 !text-[var(--vds-text-secondary)] shadow-[var(--vds-shadow-1-center)]'

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  (
    {
      children,
      className,
      orientation = 'vertical',
      shadow = false,
      overlay = false,
      overlayScrollOnly = false,
      overlayVerticalInsetSelector,
      viewportClassName,
      viewportProps,
      viewportRef,
      horizontalControls,
      ...props
    },
    ref
  ) => {
    const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
    const [scrolling, setScrolling] = useState(false)
    useEffect(() => {
      if (!overlay || !overlayScrollOnly || !viewport) return
      let timer: number | undefined
      const show = (): void => {
        window.clearTimeout(timer)
        setScrolling(true)
        timer = window.setTimeout(() => setScrolling(false), OVERLAY_SCROLLBAR_IDLE_MS)
      }
      viewport.addEventListener('scroll', show, { passive: true })
      return () => {
        viewport.removeEventListener('scroll', show)
        window.clearTimeout(timer)
        setScrolling(false)
      }
    }, [overlay, overlayScrollOnly, viewport])
    const [edges, setEdges] = useState({ top: false, bottom: false })
    const [horizontalEdges, setHorizontalEdges] = useState({ left: false, right: false })
    useImperativeHandle(viewportRef, () => viewport!, [viewport])
    useEffect(() => {
      if (!horizontalControls || !viewport || orientation === 'vertical') return
      const update = (): void => {
        const left = viewport.scrollLeft > SCROLL_EDGE_TOLERANCE
        const right =
          viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > SCROLL_EDGE_TOLERANCE
        setHorizontalEdges((previous) =>
          previous.left === left && previous.right === right ? previous : { left, right }
        )
      }
      const resize = new ResizeObserver(update)
      const observe = (): void => {
        resize.disconnect()
        resize.observe(viewport)
        for (const child of viewport.children) resize.observe(child)
        update()
      }
      const mutation = new MutationObserver(observe)
      mutation.observe(viewport, { childList: true, subtree: true })
      viewport.addEventListener('scroll', update, { passive: true })
      observe()
      return () => {
        resize.disconnect()
        mutation.disconnect()
        viewport.removeEventListener('scroll', update)
      }
    }, [Boolean(horizontalControls), orientation, viewport])
    const scrollHorizontal = (direction: number): void => {
      if (!viewport) return
      let distance = viewport.clientWidth
      if (horizontalControls?.scrollBy === 'items') {
        const content = viewport.firstElementChild
        const first = content?.firstElementChild
        if (!content || !first) return
        const stride =
          first.getBoundingClientRect().width +
          (Number.parseFloat(getComputedStyle(content).columnGap) || 0)
        if (stride <= 0) return
        distance = Math.max(1, Math.floor(viewport.clientWidth / stride)) * stride
      }
      viewport?.scrollBy({
        left: direction * distance,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      })
    }
    useEffect(() => {
      if (shadow !== 'auto' || !viewport) return
      const update = (): void => {
        const top = viewport.scrollTop > 0
        const bottom = Math.ceil(viewport.scrollTop + viewport.clientHeight) < viewport.scrollHeight
        setEdges((previous) =>
          previous.top === top && previous.bottom === bottom ? previous : { top, bottom }
        )
      }
      const resize = new ResizeObserver(update)
      const observe = (): void => {
        resize.disconnect()
        resize.observe(viewport)
        for (const child of viewport.children) resize.observe(child)
        update()
      }
      const mutation = new MutationObserver(observe)
      mutation.observe(viewport, { childList: true })
      viewport.addEventListener('scroll', update, { passive: true })
      observe()
      return () => {
        resize.disconnect()
        mutation.disconnect()
        viewport.removeEventListener('scroll', update)
      }
    }, [shadow, viewport])
    const { className: viewportPropsClassName, ...restViewportProps } = viewportProps ?? {}
    const viewportClasses = scrollAreaViewportClassName({
      className: cx(viewportClassName, viewportPropsClassName),
      orientation,
    })

    return (
      <div
        className={cx(
          scrollAreaClassName({ className, orientation, shadow: !!shadow }),
          scrollAreaStyleClassName({ shadow: !!shadow }),
          overlay && overlayScrollOnly && !scrolling && '[&>[role=scrollbar]]:invisible',
          horizontalControls?.hoverOnly && 'group/scroll-area'
        )}
        data-orientation={orientation}
        data-fade-top={shadow === true || (shadow === 'auto' && edges.top)}
        data-fade-bottom={shadow === true || (shadow === 'auto' && edges.bottom)}
        ref={ref}
        {...props}
      >
        {overlay ? (
          <OverlayViewport
            orientation={orientation}
            verticalInsetSelector={overlayVerticalInsetSelector}
            className={viewportClasses}
            viewportRef={setViewport}
            {...restViewportProps}
          >
            {children}
          </OverlayViewport>
        ) : (
          <div className={viewportClasses} ref={setViewport} {...restViewportProps}>
            {children}
          </div>
        )}
        {horizontalControls && orientation !== 'vertical' && horizontalEdges.left && (
          <div
            className={cx(
              'pointer-events-none absolute inset-y-0 left-0 z-[var(--vds-z-local-control)] flex w-[var(--vds-space-8)] items-center justify-start bg-gradient-to-r from-[var(--vds-scroll-area-horizontal-fade,var(--vds-fill-2))] to-transparent'
            )}
          >
            <IconButton
              label={horizontalControls.previous}
              icon={<ChevronLeft />}
              className={cx(
                horizontalControls.variant === 'image'
                  ? IMAGE_CONTROL_CLASS
                  : HORIZONTAL_CONTROL_CLASS,
                horizontalControls.hoverOnly &&
                  'opacity-0 transition-opacity group-hover/scroll-area:opacity-[var(--vds-opacity-full)] group-focus-within/scroll-area:opacity-[var(--vds-opacity-full)] motion-reduce:transition-none'
              )}
              onClick={() => scrollHorizontal(-1)}
            />
          </div>
        )}
        {horizontalControls && orientation !== 'vertical' && horizontalEdges.right && (
          <div
            className={cx(
              'pointer-events-none absolute inset-y-0 right-0 z-[var(--vds-z-local-control)] flex w-[var(--vds-space-8)] items-center justify-end bg-gradient-to-l from-[var(--vds-scroll-area-horizontal-fade,var(--vds-fill-2))] to-transparent'
            )}
          >
            <IconButton
              label={horizontalControls.next}
              icon={<ChevronRight />}
              className={cx(
                horizontalControls.variant === 'image'
                  ? IMAGE_CONTROL_CLASS
                  : HORIZONTAL_CONTROL_CLASS,
                horizontalControls.hoverOnly &&
                  'opacity-0 transition-opacity group-hover/scroll-area:opacity-[var(--vds-opacity-full)] group-focus-within/scroll-area:opacity-[var(--vds-opacity-full)] motion-reduce:transition-none'
              )}
              onClick={() => scrollHorizontal(1)}
            />
          </div>
        )}
      </div>
    )
  }
)

ScrollArea.displayName = 'ScrollArea'

function OverlayViewport({
  children,
  className,
  viewportRef,
  orientation,
  verticalInsetSelector,
  id,
  ...props
}: ScrollAreaViewportProps & {
  viewportRef?: Ref<HTMLDivElement>
  orientation: ScrollAreaOrientation
  verticalInsetSelector?: string
}): React.JSX.Element {
  const generatedId = useId()
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      setViewport(element)
      if (typeof viewportRef === 'function') viewportRef(element)
      else if (viewportRef) (viewportRef as { current: HTMLDivElement | null }).current = element
    },
    [viewportRef]
  )
  const viewportId = id ?? generatedId
  return (
    <>
      <div
        tabIndex={0}
        {...props}
        id={viewportId}
        ref={attach}
        className={cx(className, '![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden')}
      >
        <div
          className={cx(
            'grid min-h-full min-w-0',
            orientation !== 'vertical' && 'w-max min-w-full'
          )}
        >
          {children}
        </div>
      </div>
      {viewport && orientation !== 'horizontal' && (
        <OverlayBar
          viewport={viewport}
          orientation="vertical"
          insetSelector={verticalInsetSelector}
        />
      )}
      {viewport && orientation !== 'vertical' && (
        <OverlayBar viewport={viewport} orientation="horizontal" />
      )}
    </>
  )
}

function OverlayBar({
  viewport,
  orientation,
  insetSelector,
}: {
  viewport: HTMLDivElement
  orientation: 'vertical' | 'horizontal'
  insetSelector?: string
}): React.JSX.Element | null {
  const vertical = orientation === 'vertical'
  const [metrics, setMetrics] = useState({ size: 0, total: 0, position: 0, minimum: 0, inset: 0 })
  const drag = useRef<{ pointer: number; position: number } | null>(null)
  useLayoutEffect(() => {
    let insetElement: Element | null = null
    const measure = (): void => {
      setMetrics({
        size: vertical ? viewport.clientHeight : viewport.clientWidth,
        total: vertical ? viewport.scrollHeight : viewport.scrollWidth,
        position: vertical ? viewport.scrollTop : viewport.scrollLeft,
        inset: insetElement?.getBoundingClientRect().height ?? 0,
        minimum: parseFloat(
          getComputedStyle(viewport).getPropertyValue('--vds-scrollbar-thumb-min-size')
        ),
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    const observeInset = (): void => {
      const next = insetSelector ? viewport.querySelector(insetSelector) : null
      if (next !== insetElement) {
        if (insetElement) observer.unobserve(insetElement)
        insetElement = next
        if (insetElement) observer.observe(insetElement)
      }
      measure()
    }
    const mutation = insetSelector ? new MutationObserver(observeInset) : null
    mutation?.observe(viewport, { childList: true, subtree: true })
    viewport.addEventListener('scroll', measure, { passive: true })
    observeInset()
    return () => {
      observer.disconnect()
      mutation?.disconnect()
      viewport.removeEventListener('scroll', measure)
    }
  }, [viewport, vertical, insetSelector])
  const maximum = metrics.total - metrics.size
  const trackSize = metrics.size - metrics.inset
  if (maximum <= 0 || trackSize <= 0) return null
  const thumbSize = Math.min(
    trackSize,
    Math.max(metrics.minimum, (trackSize * trackSize) / (metrics.total - metrics.inset))
  )
  const travel = trackSize - thumbSize
  const offset = (metrics.position / maximum) * travel
  const scrollTo = (position: number): void => {
    if (vertical) viewport.scrollTop = position
    else viewport.scrollLeft = position
  }
  return (
    <div
      role="scrollbar"
      aria-controls={viewport.id}
      aria-label={viewport.getAttribute('aria-label') ?? undefined}
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(metrics.position)}
      tabIndex={0}
      style={vertical ? { top: metrics.inset } : undefined}
      className={cx(
        'absolute z-[var(--vds-z-local-control)] touch-none select-none rounded-[var(--vds-scrollbar-radius)]',
        insetSelector
          ? 'focus-visible:outline-none focus-visible:[&>[data-scroll-thumb]]:bg-[var(--vds-text-tertiary)]'
          : 'focus-visible:outline focus-visible:outline-[var(--vds-border-default)]',
        vertical
          ? 'inset-y-0 right-0 w-[var(--vds-overlay-scrollbar-size)]'
          : 'inset-x-0 bottom-0 h-[var(--vds-overlay-scrollbar-size)]'
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        const coordinate = vertical ? event.clientY : event.clientX
        if (travel > 0 && !(event.target as HTMLElement).hasAttribute('data-scroll-thumb')) {
          const bounds = event.currentTarget.getBoundingClientRect()
          scrollTo(
            ((coordinate - (vertical ? bounds.top : bounds.left) - thumbSize / 2) / travel) *
              maximum
          )
        }
        drag.current = {
          pointer: coordinate,
          position: vertical ? viewport.scrollTop : viewport.scrollLeft,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current || travel <= 0) return
        scrollTo(
          drag.current.position +
            (((vertical ? event.clientY : event.clientX) - drag.current.pointer) / travel) * maximum
        )
      }}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onPointerUp={(event) => {
        drag.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onKeyDown={(event) => {
        const step =
          parseFloat(getComputedStyle(viewport).lineHeight) ||
          parseFloat(getComputedStyle(viewport).fontSize)
        const positions: Record<string, number> = {
          Home: 0,
          End: maximum,
          PageUp: metrics.position - metrics.size,
          PageDown: metrics.position + metrics.size,
          [vertical ? 'ArrowUp' : 'ArrowLeft']: metrics.position - step,
          [vertical ? 'ArrowDown' : 'ArrowRight']: metrics.position + step,
        }
        if (!(event.key in positions)) return
        event.preventDefault()
        scrollTo(positions[event.key])
      }}
    >
      <div
        data-scroll-thumb=""
        className="absolute rounded-[var(--vds-scrollbar-radius)] bg-[var(--vds-scrollbar-thumb)]"
        style={
          vertical
            ? { top: offset, height: thumbSize, width: '100%' }
            : { left: offset, width: thumbSize, height: '100%' }
        }
      />
    </div>
  )
}

export interface ScrollBarProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: Exclude<ScrollAreaOrientation, 'both'>
}

export const ScrollBar = forwardRef<HTMLDivElement, ScrollBarProps>(
  ({ className, orientation = 'vertical', ...props }, ref) => (
    <div
      aria-hidden="true"
      className={scrollAreaBarClassName({ className, orientation })}
      data-orientation={orientation}
      ref={ref}
      {...props}
    />
  )
)

ScrollBar.displayName = 'ScrollBar'
