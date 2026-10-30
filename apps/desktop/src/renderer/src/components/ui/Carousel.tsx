import { useTranslation } from 'react-i18next'
import {
  Children,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'

import { Button, type ButtonProps } from './Button'
import { cx } from './utils'

interface CarouselContextValue {
  activeIndex: number
  autoPlayIntervalMs: number
  autoPlayPaused: boolean
  canScrollNext: boolean
  canScrollPrev: boolean
  count: number
  direction: CarouselDirection
  loop: boolean
  orientation: CarouselOrientation
  scrollNext: () => void
  scrollPrev: () => void
  setActiveIndex: (index: number) => void
  setAutoPlayPaused: (paused: boolean) => void
  visibleItems: number
}

const CarouselContext = createContext<CarouselContextValue | null>(null)

function useCarousel(component: string): CarouselContextValue {
  const context = useContext(CarouselContext)
  if (!context) throw new Error(`${component} must be used inside Carousel`)
  return context
}

export type CarouselApi = Pick<
  CarouselContextValue,
  'activeIndex' | 'canScrollNext' | 'canScrollPrev' | 'count' | 'scrollNext' | 'scrollPrev'
>
export type CarouselDirection = 'next' | 'prev'
export type CarouselOrientation = 'horizontal' | 'vertical'

export interface CarouselProps extends HTMLAttributes<HTMLDivElement> {
  autoPlay?: boolean
  autoPlayIntervalMs?: number
  defaultIndex?: number
  opts?: { align?: 'center' | 'end' | 'start'; axis?: 'x' | 'y'; loop?: boolean }
  orientation?: CarouselOrientation
  plugins?: unknown[]
  setApi?: (api: CarouselApi) => void
  visibleItems?: number
}

function boundedIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0))
}

function boundedVisibleItems(visibleItems: number, count: number): number {
  if (!Number.isFinite(visibleItems)) return 1
  return Math.min(Math.max(Math.trunc(visibleItems), 1), Math.max(count, 1))
}

const CAROUSEL_CLASS_NAME = 'vds-carousel relative w-[min(420px,100%)]'
const CAROUSEL_VERTICAL_CLASS_NAME = 'vds-carousel--vertical w-[min(320px,100%)]'
const CAROUSEL_VIEWPORT_CLASS_NAME =
  'vds-carousel__viewport overflow-hidden rounded-[var(--vds-radius-4)]'
const CAROUSEL_CONTENT_CLASS_NAME =
  'vds-carousel__content flex gap-[var(--vds-space-4)] transition-transform duration-[var(--vds-carousel-transition-duration)] ease-[var(--vds-carousel-transition-ease)] will-change-transform motion-reduce:transition-none'
const CAROUSEL_CONTENT_VERTICAL_CLASS_NAME =
  'vds-carousel__content--vertical flex-col h-[calc(96px*var(--vds-carousel-visible-items,1)+var(--vds-space-4)*(var(--vds-carousel-visible-items,1)-1))]'
const CAROUSEL_ITEM_CLASS_NAME =
  'vds-carousel__item grid min-h-60 min-w-0 flex-[0_0_calc((100%-var(--vds-space-4)*(var(--vds-carousel-visible-items,1)-1))/var(--vds-carousel-visible-items,1))] place-items-center rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)]'
const CAROUSEL_ITEM_VERTICAL_CLASS_NAME = 'vds-carousel__item--vertical h-24 min-h-0 basis-[96px]'
const CAROUSEL_CONTROL_CLASS_NAME =
  'vds-carousel__control absolute z-[var(--vds-z-local-raised)] rounded-full'
const CAROUSEL_PREVIOUS_CLASS_NAME =
  'vds-carousel__control--previous top-1/2 left-[var(--vds-space-2)] -translate-y-1/2'
const CAROUSEL_NEXT_CLASS_NAME =
  'vds-carousel__control--next top-1/2 right-[var(--vds-space-2)] -translate-y-1/2'
const CAROUSEL_PREVIOUS_VERTICAL_CLASS_NAME =
  'vds-carousel__control--vertical top-[var(--vds-space-2)] left-1/2 -translate-x-1/2 translate-y-0 rotate-90'
const CAROUSEL_NEXT_VERTICAL_CLASS_NAME =
  'vds-carousel__control--vertical top-auto right-auto bottom-[var(--vds-space-2)] left-1/2 -translate-x-1/2 translate-y-0 rotate-90'
const CAROUSEL_CONTROL_ICON_CLASS_NAME =
  'vds-carousel__control-icon inline-grid place-items-center text-[length:var(--vds-font-subhead)] leading-none'
const CAROUSEL_INDICATORS_CLASS_NAME =
  'vds-carousel__indicators mt-[var(--vds-space-4)] flex items-center justify-center gap-[var(--vds-carousel-indicator-gap)]'
const CAROUSEL_INDICATOR_CLASS_NAME =
  'vds-carousel__indicator relative h-[var(--vds-carousel-indicator-height)] w-[var(--vds-carousel-indicator-width)] overflow-hidden rounded-[var(--vds-radius-pill)] border-0 bg-[var(--vds-carousel-indicator-track)] p-0 [appearance:none] transition-[background-color,width] duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)] data-[active=true]:w-[var(--vds-carousel-indicator-active-width)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)]'
const CAROUSEL_INDICATOR_PROGRESS_CLASS_NAME =
  'vds-carousel__indicator-progress absolute inset-y-0 left-0 w-full origin-left rounded-[var(--vds-radius-pill)] bg-[var(--vds-carousel-indicator-value)]'
const DEFAULT_AUTO_PLAY_INTERVAL_MS = 4000
const MILLISECONDS_PER_SECOND = 1000
const INERT_ATTRIBUTE = { inert: '' } as const

function carouselTransform(
  index: number,
  orientation: CarouselOrientation,
  visibleItems: number
): string {
  const offset =
    orientation === 'vertical'
      ? `calc(-${index} * (96px + var(--vds-space-4)))`
      : `calc(-${index} * ((100% + var(--vds-space-4)) / ${visibleItems}))`
  return orientation === 'vertical' ? `translateY(${offset})` : `translateX(${offset})`
}

function normalizedIntervalMs(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs)) return DEFAULT_AUTO_PLAY_INTERVAL_MS
  return Math.max(Math.trunc(intervalMs), 1)
}

export const Carousel = forwardRef<HTMLDivElement, CarouselProps>(
  (
    {
      children,
      autoPlay = false,
      autoPlayIntervalMs,
      className,
      defaultIndex = 0,
      opts,
      orientation: orientationProp,
      plugins: _plugins,
      setApi,
      visibleItems = 1,
      onKeyDownCapture,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const count = Math.max(
      ...Children.toArray(children).map((child) => {
        const props = (child as { props?: { children?: unknown } }).props
        return Children.count(props?.children)
      }),
      1
    )
    const loop = opts?.loop ?? autoPlay
    const orientation = orientationProp ?? (opts?.axis === 'y' ? 'vertical' : 'horizontal')
    const visibleCount = boundedVisibleItems(visibleItems, count)
    const maxIndex = Math.max(count - visibleCount, 0)
    const [activeIndex, setActiveIndexState] = useState(() =>
      boundedIndex(defaultIndex, maxIndex + 1)
    )
    const [autoPlayPaused, setAutoPlayPaused] = useState(false)
    const [direction, setDirection] = useState<CarouselDirection>('next')
    const canScrollPrev = loop || activeIndex > 0
    const canScrollNext = loop || activeIndex < maxIndex
    const normalizedAutoPlayIntervalMs = normalizedIntervalMs(autoPlayIntervalMs)

    const setActiveIndex = useCallback(
      (index: number) => {
        setActiveIndexState((current) => {
          const nextIndex = boundedIndex(index, maxIndex + 1)
          setDirection(nextIndex < current ? 'prev' : 'next')
          return nextIndex
        })
      },
      [maxIndex]
    )
    const scrollPrev = useCallback(() => {
      setDirection('prev')
      setActiveIndexState((current) => (current > 0 ? current - 1 : loop ? maxIndex : current))
    }, [loop, maxIndex])
    const scrollNext = useCallback(() => {
      setDirection('next')
      setActiveIndexState((current) => (current < maxIndex ? current + 1 : loop ? 0 : current))
    }, [loop, maxIndex])
    const api = useMemo(
      () => ({ activeIndex, canScrollNext, canScrollPrev, count, scrollNext, scrollPrev }),
      [activeIndex, canScrollNext, canScrollPrev, count, scrollNext, scrollPrev]
    )

    useEffect(() => {
      setApi?.(api)
    }, [api, setApi])

    useEffect(() => {
      if (!autoPlay || autoPlayPaused || count <= visibleCount || orientation === 'vertical')
        return undefined
      const timeout = window.setTimeout(scrollNext, normalizedAutoPlayIntervalMs)
      return () => window.clearTimeout(timeout)
    }, [
      activeIndex,
      autoPlay,
      autoPlayPaused,
      count,
      normalizedAutoPlayIntervalMs,
      orientation,
      scrollNext,
      visibleCount,
    ])

    const handleKeyDownCapture = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDownCapture?.(event)
        if (event.defaultPrevented) return
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          scrollPrev()
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          scrollNext()
        }
      },
      [onKeyDownCapture, scrollNext, scrollPrev]
    )

    return (
      <CarouselContext.Provider
        value={{
          activeIndex,
          autoPlayIntervalMs: normalizedAutoPlayIntervalMs,
          autoPlayPaused,
          canScrollNext,
          canScrollPrev,
          count,
          direction,
          loop,
          orientation,
          scrollNext,
          scrollPrev,
          setActiveIndex,
          setAutoPlayPaused,
          visibleItems: visibleCount,
        }}
      >
        <div
          aria-roledescription={t('carousel.role')}
          className={cx(
            CAROUSEL_CLASS_NAME,
            orientation === 'vertical' && CAROUSEL_VERTICAL_CLASS_NAME,
            className
          )}
          onKeyDownCapture={handleKeyDownCapture}
          ref={ref}
          role="region"
          {...props}
        >
          {children}
        </div>
      </CarouselContext.Provider>
    )
  }
)

Carousel.displayName = 'Carousel'

export const CarouselContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ children, className, onMouseEnter, onMouseLeave, style, ...props }, ref) => {
    const { activeIndex, direction, loop, orientation, setAutoPlayPaused, visibleItems } =
      useCarousel('CarouselContent')
    const items = Children.toArray(children)
    const maxIndex = Math.max(items.length - visibleItems, 0)
    const cloneCount = loop && maxIndex > 0 ? visibleItems : 0
    const contentRef = useRef<HTMLDivElement>(null)
    const previousIndex = useRef(activeIndex)
    useImperativeHandle(ref, () => contentRef.current!, [])

    useLayoutEffect(() => {
      const previous = previousIndex.current
      previousIndex.current = activeIndex
      const content = contentRef.current
      if (!content || !cloneCount || previous === activeIndex) return
      const wrapsNext = direction === 'next' && previous === maxIndex && activeIndex === 0
      const wrapsPrev = direction === 'prev' && previous === 0 && activeIndex === maxIndex
      if (!wrapsNext && !wrapsPrev) return

      const computedStyle = window.getComputedStyle(content)
      const duration =
        computedStyle.transitionProperty === 'none'
          ? 0
          : Number.parseFloat(computedStyle.transitionDuration) * MILLISECONDS_PER_SECOND
      const easing = computedStyle.transitionTimingFunction
      const transitionProperty = content.style.transitionProperty
      content.style.transitionProperty = 'none'
      const animation = content.animate(
        [
          { transform: carouselTransform(previous + cloneCount, orientation, visibleItems) },
          {
            transform: carouselTransform(
              wrapsNext ? items.length + cloneCount : 0,
              orientation,
              visibleItems
            ),
          },
        ],
        { duration, easing }
      )
      let cancelled = false
      void animation.finished.then(
        () => {
          if (!cancelled) content.style.transitionProperty = transitionProperty
        },
        () => undefined
      )
      return () => {
        cancelled = true
        animation.cancel()
        content.style.transitionProperty = transitionProperty
      }
    }, [activeIndex, cloneCount, direction, items.length, maxIndex, orientation, visibleItems])
    return (
      <div
        className={CAROUSEL_VIEWPORT_CLASS_NAME}
        onMouseEnter={(event) => {
          setAutoPlayPaused(true)
          onMouseEnter?.(event)
        }}
        onMouseLeave={(event) => {
          setAutoPlayPaused(false)
          onMouseLeave?.(event)
        }}
      >
        <div
          className={cx(
            CAROUSEL_CONTENT_CLASS_NAME,
            orientation === 'vertical' && CAROUSEL_CONTENT_VERTICAL_CLASS_NAME,
            className
          )}
          ref={contentRef}
          style={
            {
              ...style,
              '--vds-carousel-visible-items': String(visibleItems),
              transform: carouselTransform(activeIndex + cloneCount, orientation, visibleItems),
            } as CSSProperties
          }
          {...props}
        >
          {cloneCount > 0 && (
            <div className="contents" aria-hidden="true" {...INERT_ATTRIBUTE}>
              {items.slice(-cloneCount)}
            </div>
          )}
          {children}
          {cloneCount > 0 && (
            <div className="contents" aria-hidden="true" {...INERT_ATTRIBUTE}>
              {items.slice(0, cloneCount)}
            </div>
          )}
        </div>
      </div>
    )
  }
)

CarouselContent.displayName = 'CarouselContent'

export const CarouselItem = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ children, className, ...props }, ref) => {
    const { t } = useTranslation('ui')
    const { orientation } = useCarousel('CarouselItem')
    return (
      <div
        aria-roledescription={t('carousel.slide')}
        className={cx(
          CAROUSEL_ITEM_CLASS_NAME,
          orientation === 'vertical' && CAROUSEL_ITEM_VERTICAL_CLASS_NAME,
          className
        )}
        ref={ref}
        role="group"
        {...props}
      >
        {children}
      </div>
    )
  }
)

CarouselItem.displayName = 'CarouselItem'

export const CarouselPrevious = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { children = '‹', className, disabled, onClick, size = 'icon', variant = 'outline', ...props },
    ref
  ) => {
    const { canScrollPrev, orientation, scrollPrev } = useCarousel('CarouselPrevious')
    return (
      <Button
        className={cx(
          CAROUSEL_CONTROL_CLASS_NAME,
          CAROUSEL_PREVIOUS_CLASS_NAME,
          orientation === 'vertical' && CAROUSEL_PREVIOUS_VERTICAL_CLASS_NAME,
          className
        )}
        disabled={disabled ?? !canScrollPrev}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented) scrollPrev()
        }}
        ref={ref}
        size={size}
        type="button"
        variant={variant}
        {...props}
      >
        <span className={CAROUSEL_CONTROL_ICON_CLASS_NAME}>{children}</span>
      </Button>
    )
  }
)

CarouselPrevious.displayName = 'CarouselPrevious'

export const CarouselNext = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { children = '›', className, disabled, onClick, size = 'icon', variant = 'outline', ...props },
    ref
  ) => {
    const { canScrollNext, orientation, scrollNext } = useCarousel('CarouselNext')
    return (
      <Button
        className={cx(
          CAROUSEL_CONTROL_CLASS_NAME,
          CAROUSEL_NEXT_CLASS_NAME,
          orientation === 'vertical' && CAROUSEL_NEXT_VERTICAL_CLASS_NAME,
          className
        )}
        disabled={disabled ?? !canScrollNext}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented) scrollNext()
        }}
        ref={ref}
        size={size}
        type="button"
        variant={variant}
        {...props}
      >
        <span className={CAROUSEL_CONTROL_ICON_CLASS_NAME}>{children}</span>
      </Button>
    )
  }
)

CarouselNext.displayName = 'CarouselNext'

export interface CarouselIndicatorsProps extends HTMLAttributes<HTMLDivElement> {
  getLabel?: (index: number) => string
}

export const CarouselIndicators = forwardRef<HTMLDivElement, CarouselIndicatorsProps>(
  ({ className, getLabel, ...props }, ref) => {
    const { t } = useTranslation('ui')
    const {
      activeIndex,
      autoPlayIntervalMs,
      autoPlayPaused,
      count,
      orientation,
      setActiveIndex,
      setAutoPlayPaused,
      visibleItems,
    } = useCarousel('CarouselIndicators')
    const itemCount = Math.max(count - visibleItems + 1, 1)
    if (orientation === 'vertical' || itemCount <= 1) return null
    return (
      <div className={cx(CAROUSEL_INDICATORS_CLASS_NAME, className)} ref={ref} {...props}>
        {Array.from({ length: itemCount }).map((_, index) => {
          const active = index === activeIndex
          const label = getLabel?.(index) ?? t('carousel.goto', { position: index + 1 })
          const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
            event.preventDefault()
            setActiveIndex(index)
          }
          return (
            <button
              aria-current={active ? 'true' : undefined}
              aria-label={label}
              className={CAROUSEL_INDICATOR_CLASS_NAME}
              data-active={active ? 'true' : undefined}
              key={index}
              onClick={handleClick}
              onMouseEnter={() => {
                if (active) setAutoPlayPaused(true)
              }}
              onMouseLeave={() => {
                if (active) setAutoPlayPaused(false)
              }}
              type="button"
            >
              <span
                className={CAROUSEL_INDICATOR_PROGRESS_CLASS_NAME}
                key={active ? `${index}-${autoPlayIntervalMs}` : index}
                style={{
                  animation: active
                    ? `vds-carousel-indicator-progress ${autoPlayIntervalMs}ms linear forwards`
                    : undefined,
                  animationPlayState: active && autoPlayPaused ? 'paused' : undefined,
                  transform: active ? undefined : 'scaleX(0)',
                }}
              />
            </button>
          )
        })}
      </div>
    )
  }
)

CarouselIndicators.displayName = 'CarouselIndicators'
