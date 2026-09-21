import type { HTMLAttributes, MutableRefObject, ReactNode } from 'react'
import { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react'

import { Tooltip, type TooltipAlign, type TooltipSide } from './Tooltip'
import { cx } from './utils'

export interface EllipsisTextProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode
  tooltip?: ReactNode
  tooltipContentClassName?: string
  tooltipAlign?: TooltipAlign
  tooltipOffset?: number
  tooltipPortalled?: boolean
  tooltipSide?: TooltipSide
  wrapperClassName?: string
}

export const EllipsisText = forwardRef<HTMLSpanElement, EllipsisTextProps>(
  (
    {
      children,
      className,
      tooltip,
      tooltipContentClassName,
      tooltipAlign = 'center',
      tooltipOffset,
      tooltipPortalled = false,
      tooltipSide = 'top',
      wrapperClassName,
      ...props
    },
    ref
  ) => {
    const textRef = useRef<HTMLSpanElement | null>(null)
    const [overflowing, setOverflowing] = useState(false)
    const updateOverflowing = useCallback((): void => {
      const text = textRef.current
      if (!text) return
      setOverflowing(text.scrollWidth > text.clientWidth)
    }, [])
    const setTextRef = (node: HTMLSpanElement | null): void => {
      textRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ;(ref as MutableRefObject<HTMLSpanElement | null>).current = node
      }
    }

    useLayoutEffect(() => {
      updateOverflowing()
      const text = textRef.current
      if (!text || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(updateOverflowing)
      observer.observe(text)
      return () => observer.disconnect()
    }, [children, updateOverflowing])

    return (
      <Tooltip
        align={tooltipAlign}
        anchorRef={textRef}
        className={cx('min-w-0', wrapperClassName)}
        content={tooltip ?? children}
        contentClassName={tooltipContentClassName}
        disabled={!overflowing}
        offset={tooltipOffset}
        portalled={tooltipPortalled}
        side={tooltipSide}
      >
        <span className={cx('block min-w-0 truncate', className)} data-slot="ellipsis-text" ref={setTextRef} {...props}>
          {children}
        </span>
      </Tooltip>
    )
  }
)

EllipsisText.displayName = 'EllipsisText'
