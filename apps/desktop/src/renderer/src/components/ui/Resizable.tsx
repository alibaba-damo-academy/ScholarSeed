import { useTranslation } from 'react-i18next'
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  Ref,
} from 'react'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  resizableClassName,
  resizableHandleClassName,
  resizablePanelClassName,
  resizableSplitClassName,
  resizableSplitHandleClassName,
  resizableSplitMobileClassName,
  resizableSplitMobilePanelClassName,
  resizableSplitPanelClassName,
  resizableStyleClassName,
  type ResizableDirection,
} from './classes'
import { cx } from './utils'

export type { ResizableDirection }

interface PanelConfig {
  defaultSize?: number
  max: number
  min: number
}

interface ResizableContextValue {
  disabled: boolean
  direction: ResizableDirection
  getPanelSize: (index: number) => number
  panelConfigs: PanelConfig[]
  registerPanel: (index: number, config: PanelConfig) => void
  resizeHandle: (index: number, delta: number) => void
  sizes: number[]
}

const ResizableContext = createContext<ResizableContextValue | null>(null)

function useResizableContext(component: string): ResizableContextValue {
  const context = useContext(ResizableContext)
  if (!context) throw new Error(`${component} must be used inside ResizablePanelGroup`)
  return context
}

export interface ResizablePanelGroupProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'defaultValue' | 'onChange'
> {
  children: ReactNode
  defaultSizes?: number[]
  direction?: ResizableDirection
  disabled?: boolean
  onSizesChange?: (sizes: number[]) => void
  sizes?: number[]
}

export interface ResizablePanelProps extends HTMLAttributes<HTMLDivElement> {
  animated?: boolean
  defaultSize?: number
  defaultRightWidth?: string
  isCollapsed?: boolean
  isLeftCollapsed?: boolean
  isMobile?: boolean
  resizeEnabled?: boolean
  reversed?: boolean
  leftPanel?: ReactNode
  leftWidth?: string
  leftWidthStep?: number
  maxSize?: number
  maxLeftWidth?: number
  minSize?: number
  minLeftWidth?: number
  maxRightWidth?: number
  minRightWidth?: number
  onToggleCollapse?: () => void
  onRightWidthChange?: (width: string) => void
  onRightWidthChangeEnd?: (width: string) => void
  onWidthChange?: (width: string) => void
  onWidthChangeEnd?: (width: string) => void
  rightPanel?: ReactNode
  rightWidth?: string
  value?: number
  __index?: number
}

export interface ResizableHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown'> {
  appearance?: 'default' | 'invisible'
  __index?: number
  disabled?: boolean
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onOffsetChange?: (offset: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
}

type ResizablePanelChildRef = { ref?: Ref<HTMLDivElement> }
type ResizableHandleChildRef = { ref?: Ref<HTMLDivElement> }
type ResizableChildProps = Partial<ResizablePanelProps & ResizableHandleProps> & {
  ref?: Ref<HTMLDivElement>
}

const DEFAULT_PANEL_SIZE = 50
const DEFAULT_MIN_SIZE = 10
const DEFAULT_MAX_SIZE = 90
const KEYBOARD_STEP = 5
const POINTER_MIN_DELTA = 0
const PRIMARY_POINTER_BUTTON = 0
const PRIMARY_POINTER_BUTTON_MASK = 1
const PERCENTAGE_TOTAL = 100
const NORMALIZE_MAX_PASSES = 4
const FLOAT_EPSILON = 0.0001
const DEFAULT_LEFT_WIDTH = '445px'
const RIGHT_WIDTH_PROPERTY = '--vds-resizable-right-width'
const LEFT_WIDTH_PROPERTY = '--vds-resizable-left-width'
const SPLIT_MIN_PANEL_WIDTH = 120
const PIXEL_BOUNDARY_THRESHOLD = 100
const GRIP_DOT_COUNT = 4
const GRIP_DOTS = Array.from({ length: GRIP_DOT_COUNT }, (_, index) => index)
const GRIP_DOT_CLASS_NAME =
  'block size-[var(--vds-resizable-handle-active-dot-size)] rounded-full bg-[var(--vds-resizable-handle-current-dot-color)]'
const GRIP_DOT_STACK_CLASS_NAME =
  'pointer-events-none absolute left-1/2 top-1/2 z-[var(--vds-z-local-raised)] hidden -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-[3px] group-hover/resizable-handle:flex group-focus-visible/resizable-handle:flex group-data-[resizing=true]/resizable-handle:flex'
const GRIP_DOT_ROW_CLASS_NAME =
  'pointer-events-none absolute left-1/2 top-1/2 z-[var(--vds-z-local-raised)] hidden -translate-x-1/2 -translate-y-1/2 items-center gap-[3px] group-hover/resizable-handle:flex group-focus-visible/resizable-handle:flex group-data-[resizing=true]/resizable-handle:flex'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function useResizePointer(onFinish: () => void, enabled = true) {
  const [isResizing, setIsResizing] = useState(false)
  const activePointerRef = useRef<number | null>(null)
  const cleanupRef = useRef<((notify: boolean) => void) | null>(null)
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish

  useEffect(() => () => cleanupRef.current?.(false), [])
  useEffect(() => {
    if (!enabled) cleanupRef.current?.(true)
  }, [enabled])

  const start = (event: PointerEvent<HTMLElement>): boolean => {
    if (!enabled || event.button !== PRIMARY_POINTER_BUTTON || activePointerRef.current !== null)
      return false
    const target = event.currentTarget
    const pointerId = event.pointerId
    const ownerDocument = target.ownerDocument
    const ownerWindow = ownerDocument.defaultView
    target.setPointerCapture(pointerId)
    activePointerRef.current = pointerId

    const finish = (notify: boolean): void => {
      if (activePointerRef.current !== pointerId) return
      activePointerRef.current = null
      cleanupRef.current = null
      ownerDocument.removeEventListener('pointerup', handleEnd, true)
      ownerDocument.removeEventListener('pointercancel', handleEnd, true)
      ownerDocument.removeEventListener('pointermove', handleMove, true)
      ownerDocument.removeEventListener('visibilitychange', handleVisibility)
      ownerWindow?.removeEventListener('blur', handleBlur)
      target.removeEventListener('lostpointercapture', handleEnd)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      if (notify) {
        setIsResizing(false)
        onFinishRef.current()
      }
    }
    const handleEnd = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId === pointerId) finish(true)
    }
    const handleMove = (pointerEvent: globalThis.PointerEvent): void => {
      if (
        pointerEvent.pointerId === pointerId &&
        !(pointerEvent.buttons & PRIMARY_POINTER_BUTTON_MASK)
      )
        finish(true)
    }
    const handleBlur = (): void => finish(true)
    const handleVisibility = (): void => {
      if (ownerDocument.hidden) finish(true)
    }
    cleanupRef.current = finish
    ownerDocument.addEventListener('pointerup', handleEnd, true)
    ownerDocument.addEventListener('pointercancel', handleEnd, true)
    ownerDocument.addEventListener('pointermove', handleMove, true)
    ownerDocument.addEventListener('visibilitychange', handleVisibility)
    ownerWindow?.addEventListener('blur', handleBlur)
    target.addEventListener('lostpointercapture', handleEnd)
    setIsResizing(true)
    return true
  }

  const ownsPointer = (event: PointerEvent<HTMLElement>): boolean =>
    activePointerRef.current === event.pointerId

  return { isResizing, ownsPointer, start }
}

function parsePercentage(width: string): number | undefined {
  const match = width.trim().match(/^(\d+(?:\.\d+)?)%$/)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function widthToPixels(width: string, hostWidth: number): number {
  const percentage = parsePercentage(width)
  if (percentage !== undefined) return (hostWidth * percentage) / PERCENTAGE_TOTAL
  const pixels = Number(width.trim().replace(/px$/, ''))
  return Number.isFinite(pixels) ? pixels : hostWidth / 2
}

function ResizableGripDots({
  direction = 'horizontal',
}: {
  direction?: ResizableDirection
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={direction === 'horizontal' ? GRIP_DOT_STACK_CLASS_NAME : GRIP_DOT_ROW_CLASS_NAME}
    >
      {GRIP_DOTS.map((dot) => (
        <span className={GRIP_DOT_CLASS_NAME} key={dot} />
      ))}
    </span>
  )
}

function splitBoundaryToPixels(value: number, hostWidth: number): number {
  if (value <= PIXEL_BOUNDARY_THRESHOLD) return (hostWidth * value) / PERCENTAGE_TOTAL
  return value
}

function splitBoundaryToCss(value: number): string {
  return value <= PIXEL_BOUNDARY_THRESHOLD ? `${value}%` : `${value}px`
}

function getPanelConfigs(children: ReactNode): PanelConfig[] {
  const configs: PanelConfig[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement<ResizablePanelProps>(child)) return
    if ((child.type as { displayName?: string }).displayName !== 'ResizablePanel') return
    configs.push({
      defaultSize: child.props.defaultSize,
      max: child.props.maxSize ?? DEFAULT_MAX_SIZE,
      min: child.props.minSize ?? DEFAULT_MIN_SIZE,
    })
  })
  return configs
}

function normalizeSizes(sizes: number[], configs: PanelConfig[]): number[] {
  const panelCount = configs.length
  if (panelCount <= 0) return []
  const fallback = PERCENTAGE_TOTAL / panelCount
  const nextSizes = Array.from(
    { length: panelCount },
    (_, index) => sizes[index] ?? configs[index]?.defaultSize ?? fallback
  )
  const total = nextSizes.reduce((sum, size) => sum + Math.max(size, 0), 0)
  const scaledSizes =
    total <= 0
      ? Array.from({ length: panelCount }, () => fallback)
      : nextSizes.map((size) => (Math.max(size, 0) / total) * PERCENTAGE_TOTAL)

  let constrainedSizes = scaledSizes
  const lockedIndexes = new Set<number>()

  for (let pass = 0; pass < NORMALIZE_MAX_PASSES; pass += 1) {
    let changed = false
    constrainedSizes = constrainedSizes.map((size, index) => {
      if (lockedIndexes.has(index)) return size
      const config = configs[index] ?? { max: DEFAULT_MAX_SIZE, min: DEFAULT_MIN_SIZE }
      const nextSize = clamp(size, config.min, config.max)
      if (nextSize !== size) {
        lockedIndexes.add(index)
        changed = true
      }
      return nextSize
    })

    const flexibleIndexes = constrainedSizes
      .map((_, index) => index)
      .filter((index) => !lockedIndexes.has(index))
    if (!changed || flexibleIndexes.length === 0) break

    const lockedTotal = constrainedSizes.reduce(
      (sum, size, index) => sum + (lockedIndexes.has(index) ? size : 0),
      0
    )
    const remaining = Math.max(PERCENTAGE_TOTAL - lockedTotal, 0)
    const flexibleTotal = flexibleIndexes.reduce(
      (sum, index) => sum + Math.max(constrainedSizes[index], 0),
      0
    )
    flexibleIndexes.forEach((index) => {
      constrainedSizes[index] =
        flexibleTotal > 0
          ? (Math.max(constrainedSizes[index], 0) / flexibleTotal) * remaining
          : remaining / flexibleIndexes.length
    })
  }

  return rebalanceTotal(constrainedSizes, configs)
}

function rebalanceTotal(sizes: number[], configs: PanelConfig[]): number[] {
  const nextSizes = [...sizes]
  let total = nextSizes.reduce((sum, size) => sum + size, 0)

  for (
    let pass = 0;
    pass < NORMALIZE_MAX_PASSES && Math.abs(total - PERCENTAGE_TOTAL) > FLOAT_EPSILON;
    pass += 1
  ) {
    const excess = total - PERCENTAGE_TOTAL
    const shrinking = excess > 0
    const adjustableIndexes = nextSizes
      .map((_, index) => index)
      .filter((index) => {
        const config = configs[index] ?? { max: DEFAULT_MAX_SIZE, min: DEFAULT_MIN_SIZE }
        return shrinking ? nextSizes[index] > config.min : nextSizes[index] < config.max
      })

    if (adjustableIndexes.length === 0) break

    const capacity = adjustableIndexes.reduce((sum, index) => {
      const config = configs[index] ?? { max: DEFAULT_MAX_SIZE, min: DEFAULT_MIN_SIZE }
      return sum + (shrinking ? nextSizes[index] - config.min : config.max - nextSizes[index])
    }, 0)

    if (capacity <= 0) break

    adjustableIndexes.forEach((index) => {
      const config = configs[index] ?? { max: DEFAULT_MAX_SIZE, min: DEFAULT_MIN_SIZE }
      const itemCapacity = shrinking ? nextSizes[index] - config.min : config.max - nextSizes[index]
      const share = (Math.abs(excess) * itemCapacity) / capacity
      nextSizes[index] = shrinking
        ? Math.max(config.min, nextSizes[index] - share)
        : Math.min(config.max, nextSizes[index] + share)
    })
    total = nextSizes.reduce((sum, size) => sum + size, 0)
  }

  return nextSizes
}

function resizePair(
  sizes: number[],
  configs: PanelConfig[],
  handleIndex: number,
  delta: number
): number[] {
  const beforeIndex = handleIndex
  const afterIndex = handleIndex + 1
  const before = sizes[beforeIndex]
  const after = sizes[afterIndex]
  if (before === undefined || after === undefined) return sizes

  const beforeConfig = configs[beforeIndex] ?? { min: DEFAULT_MIN_SIZE, max: DEFAULT_MAX_SIZE }
  const afterConfig = configs[afterIndex] ?? { min: DEFAULT_MIN_SIZE, max: DEFAULT_MAX_SIZE }
  const boundedDelta = clamp(delta, beforeConfig.min - before, beforeConfig.max - before)
  const nextAfter = clamp(after - boundedDelta, afterConfig.min, afterConfig.max)
  const actualDelta = after - nextAfter
  const nextBefore = clamp(before + actualDelta, beforeConfig.min, beforeConfig.max)
  const finalDelta = nextBefore - before
  const nextSizes = [...sizes]
  nextSizes[beforeIndex] = before + finalDelta
  nextSizes[afterIndex] = after - finalDelta
  return nextSizes
}

export const ResizablePanelGroup = forwardRef<HTMLDivElement, ResizablePanelGroupProps>(
  (
    {
      children,
      className,
      defaultSizes,
      direction = 'horizontal',
      disabled = false,
      onSizesChange,
      sizes,
      ...props
    },
    ref
  ) => {
    const panelConfigs = getPanelConfigs(children)
    const panelConfigsRef = useRef<PanelConfig[]>(panelConfigs)
    const [uncontrolledSizes, setUncontrolledSizes] = useState(() =>
      normalizeSizes(defaultSizes ?? [], panelConfigs)
    )
    panelConfigsRef.current = panelConfigs
    const currentSizes = normalizeSizes(sizes ?? uncontrolledSizes, panelConfigs)

    const commitSizes = (nextSizes: number[]): void => {
      if (disabled) return
      const normalizedSizes = normalizeSizes(nextSizes, panelConfigsRef.current)
      if (sizes === undefined) setUncontrolledSizes(normalizedSizes)
      onSizesChange?.(normalizedSizes)
    }

    const context = useMemo<ResizableContextValue>(
      () => ({
        disabled,
        direction,
        getPanelSize: (index) => currentSizes[index] ?? DEFAULT_PANEL_SIZE,
        panelConfigs: panelConfigsRef.current,
        registerPanel: (index, config) => {
          panelConfigsRef.current[index] = config
        },
        resizeHandle: (index, delta) => {
          commitSizes(resizePair(currentSizes, panelConfigsRef.current, index, delta))
        },
        sizes: currentSizes,
      }),
      [currentSizes, direction, disabled, onSizesChange, panelConfigs, sizes]
    )

    let panelIndex = 0
    let handleIndex = 0

    return (
      <ResizableContext.Provider value={context}>
        <div
          data-resize-disabled={disabled || undefined}
          className={cx(
            resizableClassName({ className, direction, disabled }),
            resizableStyleClassName({ direction, disabled })
          )}
          data-direction={direction}
          ref={ref}
          {...props}
        >
          {Children.map(children, (child) => {
            if (!isValidElement<ResizableChildProps>(child)) return child
            const displayName = (child.type as { displayName?: string }).displayName
            const childRef = (child as ResizablePanelChildRef | ResizableHandleChildRef).ref

            if (displayName === 'ResizablePanel') {
              const currentIndex = panelIndex
              panelIndex += 1
              return cloneElement(child as ReactElement<ResizableChildProps>, {
                __index: currentIndex,
                ref: childRef,
              })
            }

            if (displayName === 'ResizableHandle') {
              const currentIndex = handleIndex
              handleIndex += 1
              return cloneElement(child as ReactElement<ResizableChildProps>, {
                __index: currentIndex,
                ref: childRef,
              })
            }

            return child
          })}
        </div>
      </ResizableContext.Provider>
    )
  }
)

ResizablePanelGroup.displayName = 'ResizablePanelGroup'

export const ResizablePanel = forwardRef<HTMLDivElement, ResizablePanelProps>(
  (
    {
      __index = 0,
      animated = false,
      children,
      className,
      defaultSize,
      defaultRightWidth,
      isCollapsed,
      isLeftCollapsed = false,
      isMobile = false,
      resizeEnabled = true,
      reversed = false,
      leftPanel,
      leftWidth = DEFAULT_LEFT_WIDTH,
      leftWidthStep,
      maxSize = DEFAULT_MAX_SIZE,
      maxLeftWidth = DEFAULT_MAX_SIZE,
      maxRightWidth = DEFAULT_MAX_SIZE,
      minSize = DEFAULT_MIN_SIZE,
      minLeftWidth = DEFAULT_MIN_SIZE,
      minRightWidth = DEFAULT_MIN_SIZE,
      onToggleCollapse,
      onRightWidthChange,
      onRightWidthChangeEnd,
      onWidthChange,
      onWidthChangeEnd,
      rightPanel,
      rightWidth,
      style,
      value,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const hostRef = useRef<HTMLDivElement | null>(null)
    const pointerStartRef = useRef<number | null>(null)
    const widthStartRef = useRef(0)
    // 拖动开始时缓存的容器宽度：move 内不再 getBoundingClientRect，避免每步强制同步布局
    const hostWidthRef = useRef(0)
    const [currentLeftWidth, setCurrentLeftWidth] = useState(leftWidth)
    const latestLeftWidthRef = useRef(leftWidth)
    const [uncontrolledRightWidth, setUncontrolledRightWidth] = useState(
      rightWidth ?? defaultRightWidth
    )
    const latestRightWidthRef = useRef(rightWidth ?? defaultRightWidth)
    useEffect(() => {
      latestLeftWidthRef.current = leftWidth
      setCurrentLeftWidth(leftWidth)
    }, [leftWidth])
    const setRefs = (node: HTMLDivElement | null): void => {
      hostRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) {
        ;(ref as { current: HTMLDivElement | null }).current = node
      }
    }
    const commitSplitWidth = (nextPixels: number): void => {
      const hostWidth = hostWidthRef.current
      if (hostWidth <= 0) return
      const safeMinPixels = Math.max(
        splitBoundaryToPixels(minLeftWidth, hostWidth),
        SPLIT_MIN_PANEL_WIDTH
      )
      const safeMaxPixels = Math.max(
        safeMinPixels,
        Math.min(
          splitBoundaryToPixels(maxLeftWidth, hostWidth),
          hostWidth -
            Math.max(splitBoundaryToPixels(minRightWidth, hostWidth), SPLIT_MIN_PANEL_WIDTH)
        )
      )
      const constrainedPixels = clamp(nextPixels, safeMinPixels, safeMaxPixels)
      const steppedPixels =
        leftWidthStep && leftWidthStep > 0
          ? Math.round(constrainedPixels / leftWidthStep) * leftWidthStep
          : constrainedPixels
      const nextWidth = `${clamp(steppedPixels, safeMinPixels, safeMaxPixels)}px`
      latestLeftWidthRef.current = nextWidth
      hostRef.current?.style.setProperty(LEFT_WIDTH_PROPERTY, nextWidth)
      onWidthChange?.(nextWidth)
    }
    const commitRightSplitWidth = (nextPixels: number): void => {
      const hostWidth = hostWidthRef.current
      if (hostWidth <= 0) return
      const safeMinPixels = Math.max(
        splitBoundaryToPixels(minRightWidth, hostWidth),
        SPLIT_MIN_PANEL_WIDTH
      )
      const leftMinPixels = Math.max(
        splitBoundaryToPixels(minLeftWidth, hostWidth),
        SPLIT_MIN_PANEL_WIDTH
      )
      const safeMaxPixels = Math.max(
        safeMinPixels,
        Math.min(splitBoundaryToPixels(maxRightWidth, hostWidth), hostWidth - leftMinPixels)
      )
      const nextWidth = `${clamp(nextPixels, safeMinPixels, safeMaxPixels)}px`
      latestRightWidthRef.current = nextWidth
      // Keep pointer moves on the browser's layout path. The custom property is
      // deliberately outside React state, so unrelated parent renders cannot restore
      // a stale width midway through a drag and the content tree need not re-render.
      hostRef.current?.style.setProperty(RIGHT_WIDTH_PROPERTY, nextWidth)
      onRightWidthChange?.(nextWidth)
    }
    const finishRightSplitResize = (): void => {
      const nextWidth = latestRightWidthRef.current
      if (rightWidth === undefined && nextWidth !== undefined) {
        setUncontrolledRightWidth(nextWidth)
      }
      if (nextWidth !== undefined) onRightWidthChangeEnd?.(nextWidth)
    }
    const splitPointer = useResizePointer(
      () => {
        pointerStartRef.current = null
        if ((rightWidth ?? uncontrolledRightWidth) !== undefined) finishRightSplitResize()
        else {
          setCurrentLeftWidth(latestLeftWidthRef.current)
          onWidthChangeEnd?.(latestLeftWidthRef.current)
        }
      },
      resizeEnabled && !isMobile && !isLeftCollapsed && !(isCollapsed ?? !rightPanel)
    )

    if (leftPanel !== undefined || rightPanel !== undefined) {
      const currentRightWidth = rightWidth ?? uncontrolledRightWidth
      const animateSplit = animated && !isMobile
      const collapsed = isCollapsed ?? !rightPanel
      const parsedWidth = parsePercentage(currentLeftWidth)
      const percentageMinWidth = minLeftWidth > PERCENTAGE_TOTAL ? 0 : Math.max(minLeftWidth, 0)
      const percentageMaxWidth = Math.min(
        Math.max(maxLeftWidth, percentageMinWidth),
        PERCENTAGE_TOTAL
      )
      const constrainedWidth =
        parsedWidth === undefined
          ? currentLeftWidth
          : `${clamp(parsedWidth, percentageMinWidth, percentageMaxWidth)}%`
      const rightSized = currentRightWidth !== undefined
      const parsedRightWidth =
        currentRightWidth === undefined ? undefined : parsePercentage(currentRightWidth)
      const percentageMinRightWidth =
        minRightWidth > PERCENTAGE_TOTAL ? 0 : Math.max(minRightWidth, 0)
      const percentageMaxRightWidth = Math.min(
        Math.max(maxRightWidth, percentageMinRightWidth),
        PERCENTAGE_TOTAL
      )
      const constrainedRightWidth =
        parsedRightWidth === undefined
          ? (currentRightWidth ?? '')
          : `${clamp(parsedRightWidth, percentageMinRightWidth, percentageMaxRightWidth)}%`
      const leftPanelWidth = rightSized ? 'auto' : `var(${LEFT_WIDTH_PROPERTY})`
      const rightPanelWidth = rightSized
        ? constrainedRightWidth
        : `calc(100% - var(${LEFT_WIDTH_PROPERTY}))`
      const splitStyle = rightSized
        ? ({ ...style, [RIGHT_WIDTH_PROPERTY]: rightPanelWidth } as CSSProperties)
        : ({ ...style, [LEFT_WIDTH_PROPERTY]: constrainedWidth } as CSSProperties)

      return (
        <div
          className={cx(
            resizableSplitClassName,
            'group',
            isMobile && resizableSplitMobileClassName,
            reversed && !isMobile && '!flex-row-reverse',
            className
          )}
          data-resizing={splitPointer.isResizing || undefined}
          ref={setRefs}
          style={splitStyle}
          {...props}
        >
          <div
            className={cx(
              resizableSplitPanelClassName,
              resizableSplitMobilePanelClassName,
              'vds-resizable-split__panel--left',
              animateSplit &&
                !splitPointer.isResizing &&
                'transition-[width] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none',
              animateSplit && 'overflow-hidden'
            )}
            hidden={!animateSplit && isLeftCollapsed}
            aria-hidden={isLeftCollapsed || undefined}
            ref={(element) => {
              if (element) element.inert = isLeftCollapsed
            }}
            style={{
              flex:
                animateSplit && !rightSized
                  ? '0 0 auto'
                  : !collapsed && !isLeftCollapsed
                    ? rightSized
                      ? '1 1 auto'
                      : '0 0 auto'
                    : undefined,
              minWidth: animateSplit
                ? 0
                : !collapsed && !isLeftCollapsed
                  ? splitBoundaryToCss(minLeftWidth)
                  : undefined,
              maxWidth:
                !animateSplit && !rightSized && !collapsed && !isLeftCollapsed
                  ? `min(${splitBoundaryToCss(maxLeftWidth)}, calc(100% - ${splitBoundaryToCss(minRightWidth)}))`
                  : undefined,
              width: isLeftCollapsed
                ? '0%'
                : collapsed
                  ? '100%'
                  : animateSplit && !rightSized
                    ? `clamp(${splitBoundaryToCss(minLeftWidth)}, ${leftPanelWidth}, min(${splitBoundaryToCss(maxLeftWidth)}, calc(100% - ${splitBoundaryToCss(minRightWidth)})))`
                    : leftPanelWidth,
            }}
          >
            {leftPanel}
          </div>
          {resizeEnabled && !collapsed && !isLeftCollapsed && !isMobile ? (
            <button
              aria-label={t('resize.action')}
              className={cx(
                resizableSplitHandleClassName,
                'group/resizable-handle after:![background-image:none]'
              )}
              data-resizing={splitPointer.isResizing || undefined}
              type="button"
              onPointerDown={(event) => {
                if (!splitPointer.start(event)) return
                pointerStartRef.current = event.clientX
                const hostWidth =
                  event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
                hostWidthRef.current = hostWidth
                const renderedRightWidth =
                  event.currentTarget.nextElementSibling?.getBoundingClientRect().width
                widthStartRef.current =
                  rightSized && renderedRightWidth !== undefined
                    ? renderedRightWidth
                    : widthToPixels(constrainedWidth, hostWidth)
                if (!rightSized) latestLeftWidthRef.current = `${widthStartRef.current}px`
                if (rightSized) latestRightWidthRef.current = `${widthStartRef.current}px`
              }}
              onPointerMove={(event) => {
                if (!splitPointer.ownsPointer(event) || pointerStartRef.current === null) return
                const delta = (event.clientX - pointerStartRef.current) * (reversed ? -1 : 1)
                if (rightSized) commitRightSplitWidth(widthStartRef.current - delta)
                else commitSplitWidth(widthStartRef.current + delta)
              }}
              onDoubleClick={() => {
                if (rightSized && rightWidth !== undefined) {
                  onRightWidthChange?.(rightWidth)
                } else {
                  latestLeftWidthRef.current = leftWidth
                  hostRef.current?.style.setProperty(LEFT_WIDTH_PROPERTY, leftWidth)
                  setCurrentLeftWidth(leftWidth)
                  onWidthChange?.(leftWidth)
                  onWidthChangeEnd?.(leftWidth)
                }
                onToggleCollapse?.()
              }}
            >
              <ResizableGripDots />
            </button>
          ) : null}
          <div
            className={cx(
              resizableSplitPanelClassName,
              resizableSplitMobilePanelClassName,
              'vds-resizable-split__panel--right',
              animateSplit &&
                !splitPointer.isResizing &&
                'transition-[width] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none',
              animateSplit && 'overflow-hidden'
            )}
            hidden={!animateSplit && collapsed}
            aria-hidden={collapsed || undefined}
            ref={(element) => {
              if (element) element.inert = collapsed
            }}
            style={{
              // 宽度由 --vds-resizable-right-width 唯一决定：禁用 flex 收缩，否则相邻
              // 面板出现宽内容（如文献宽表）时 basis 变大，本面板会被 flex 挤窄，
              // 表现为「切换视图后面板宽度变了」，而宽度变量本身没动。
              flex: rightSized ? '0 0 auto' : isMobile ? undefined : '1 1 0%',
              maxWidth: rightSized
                ? `min(${splitBoundaryToCss(maxRightWidth)}, calc(100% - ${splitBoundaryToCss(minLeftWidth)}))`
                : undefined,
              minWidth: animateSplit
                ? 0
                : rightSized
                  ? splitBoundaryToCss(minRightWidth)
                  : undefined,
              width: collapsed
                ? '0%'
                : isLeftCollapsed
                  ? '100%'
                  : rightSized
                    ? animateSplit
                      ? `clamp(${splitBoundaryToCss(minRightWidth)}, var(${RIGHT_WIDTH_PROPERTY}), min(${splitBoundaryToCss(maxRightWidth)}, calc(100% - ${splitBoundaryToCss(minLeftWidth)})))`
                      : `var(${RIGHT_WIDTH_PROPERTY})`
                    : rightPanelWidth,
            }}
          >
            {rightPanel}
          </div>
        </div>
      )
    }

    const context = useResizableContext('ResizablePanel')
    const panelSize = value ?? context.getPanelSize(__index) ?? defaultSize ?? DEFAULT_PANEL_SIZE
    context.registerPanel(__index, { defaultSize, max: maxSize, min: minSize })

    return (
      <div
        aria-label={props['aria-label'] ?? t('resize.panel', { position: __index + 1 })}
        className={cx(resizablePanelClassName, className)}
        data-panel-size={String(panelSize)}
        ref={ref}
        role="group"
        style={{ ...style, flexBasis: `${panelSize}%` }}
        {...props}
      >
        {children}
      </div>
    )
  }
)

ResizablePanel.displayName = 'ResizablePanel'

export const ResizableHandle = forwardRef<HTMLDivElement, ResizableHandleProps>(
  (
    {
      __index = 0,
      appearance = 'default',
      className,
      disabled,
      onKeyDown,
      onPointerCancel,
      onPointerDown,
      onPointerUp,
      onOffsetChange,
      onResizeStart,
      onResizeEnd,
      ...props
    },
    ref
  ) => {
    const context = useContext(ResizableContext)
    if (!context && !onOffsetChange)
      throw new Error('ResizableHandle requires a panel group or onOffsetChange')
    const direction = context?.direction ?? 'horizontal'
    const isDisabled = context?.disabled || disabled
    const pointerStartRef = useRef<number | null>(null)
    const sizeStartRef = useRef<number[]>([])
    const pointer = useResizePointer(() => {
      pointerStartRef.current = null
      sizeStartRef.current = []
      onResizeEnd?.()
    }, !isDisabled)
    const beforeSize = context?.sizes[__index] ?? DEFAULT_PANEL_SIZE
    const afterSize = context?.sizes[__index + 1] ?? DEFAULT_PANEL_SIZE
    const beforeConfig = context?.panelConfigs[__index] ?? {
      max: DEFAULT_MAX_SIZE,
      min: DEFAULT_MIN_SIZE,
    }
    const afterConfig = context?.panelConfigs[__index + 1] ?? {
      max: DEFAULT_MAX_SIZE,
      min: DEFAULT_MIN_SIZE,
    }
    const valueMin = beforeConfig.min
    const valueMax = Math.min(beforeConfig.max, beforeSize + afterSize - afterConfig.min)

    const commitPointerDelta = (event: PointerEvent<HTMLDivElement>): void => {
      const pointerStart = pointerStartRef.current
      if (pointerStart === null) return

      const pointerCurrent = direction === 'horizontal' ? event.clientX : event.clientY
      if (!context) {
        onOffsetChange?.(pointerCurrent - pointerStart)
        return
      }
      const hostSize =
        context.direction === 'horizontal'
          ? event.currentTarget.parentElement?.getBoundingClientRect().width
          : event.currentTarget.parentElement?.getBoundingClientRect().height
      if (!hostSize || hostSize <= POINTER_MIN_DELTA) return

      const delta = ((pointerCurrent - pointerStart) / hostSize) * PERCENTAGE_TOTAL
      const sourceSizes = sizeStartRef.current.length > 0 ? sizeStartRef.current : context.sizes
      context.resizeHandle(__index, delta + sourceSizes[__index] - context.sizes[__index])
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || isDisabled) return

      const keyDelta: Record<string, number | undefined> = {
        ArrowDown: direction === 'vertical' ? KEYBOARD_STEP : undefined,
        ArrowLeft: direction === 'horizontal' ? -KEYBOARD_STEP : undefined,
        ArrowRight: direction === 'horizontal' ? KEYBOARD_STEP : undefined,
        ArrowUp: direction === 'vertical' ? -KEYBOARD_STEP : undefined,
        End: context ? PERCENTAGE_TOTAL : undefined,
        Home: context ? -PERCENTAGE_TOTAL : undefined,
      }
      const delta = keyDelta[event.key]
      if (delta === undefined) return

      event.preventDefault()
      if (context) context.resizeHandle(__index, delta)
      else {
        onResizeStart?.()
        onOffsetChange?.(delta)
        onResizeEnd?.()
      }
    }

    return (
      <div
        aria-disabled={isDisabled || undefined}
        aria-orientation={context ? direction : 'vertical'}
        aria-valuemax={context ? valueMax : undefined}
        aria-valuemin={context ? valueMin : undefined}
        aria-valuenow={context ? beforeSize : undefined}
        className={cx(
          appearance === 'invisible'
            ? 'cursor-ew-resize touch-none select-none'
            : cx(resizableHandleClassName, 'group/resizable-handle after:![background-image:none]'),
          className
        )}
        data-resizing={pointer.isResizing || undefined}
        ref={ref}
        role="separator"
        tabIndex={isDisabled ? undefined : 0}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          onPointerDown?.(event)
          if (event.defaultPrevented || !pointer.start(event)) return
          onResizeStart?.()
          pointerStartRef.current = direction === 'horizontal' ? event.clientX : event.clientY
          sizeStartRef.current = context?.sizes ?? []
        }}
        onPointerMove={(event) => {
          if (isDisabled || !pointer.ownsPointer(event)) return
          commitPointerDelta(event)
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        {...props}
      >
        {appearance !== 'invisible' && <ResizableGripDots direction={direction} />}
      </div>
    )
  }
)

ResizableHandle.displayName = 'ResizableHandle'

export default ResizablePanel
