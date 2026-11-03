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
  viewportClassName?: string
  viewportProps?: ScrollAreaViewportProps
  viewportRef?: Ref<HTMLDivElement>
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  (
    {
      children,
      className,
      orientation = 'vertical',
      shadow = false,
      overlay = false,
      viewportClassName,
      viewportProps,
      viewportRef,
      ...props
    },
    ref
  ) => {
    const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
    const [edges, setEdges] = useState({ top: false, bottom: false })
    useImperativeHandle(viewportRef, () => viewport!, [viewport])
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
          scrollAreaStyleClassName({ shadow: !!shadow })
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
  id,
  ...props
}: ScrollAreaViewportProps & {
  viewportRef?: Ref<HTMLDivElement>
  orientation: ScrollAreaOrientation
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
        <OverlayBar viewport={viewport} orientation="vertical" />
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
}: {
  viewport: HTMLDivElement
  orientation: 'vertical' | 'horizontal'
}): React.JSX.Element | null {
  const vertical = orientation === 'vertical'
  const [metrics, setMetrics] = useState({ size: 0, total: 0, position: 0, minimum: 0 })
  const drag = useRef<{ pointer: number; position: number } | null>(null)
  useLayoutEffect(() => {
    const measure = (): void => {
      setMetrics({
        size: vertical ? viewport.clientHeight : viewport.clientWidth,
        total: vertical ? viewport.scrollHeight : viewport.scrollWidth,
        position: vertical ? viewport.scrollTop : viewport.scrollLeft,
        minimum: parseFloat(
          getComputedStyle(viewport).getPropertyValue('--vds-scrollbar-thumb-min-size')
        ),
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    viewport.addEventListener('scroll', measure, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', measure)
    }
  }, [viewport, vertical])
  const maximum = metrics.total - metrics.size
  if (maximum <= 0 || metrics.size <= 0) return null
  const thumbSize = Math.min(
    metrics.size,
    Math.max(metrics.minimum, (metrics.size * metrics.size) / metrics.total)
  )
  const travel = metrics.size - thumbSize
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
      className={cx(
        'absolute z-[var(--vds-z-local-control)] touch-none select-none rounded-[var(--vds-scrollbar-radius)] focus-visible:outline focus-visible:outline-[var(--vds-border-default)]',
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
