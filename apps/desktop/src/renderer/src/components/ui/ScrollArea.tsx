import type { HTMLAttributes, Ref } from 'react'
import { forwardRef } from 'react'

import {
  scrollAreaBarClassName,
  scrollAreaClassName,
  scrollAreaStyleClassName,
  scrollAreaViewportClassName,
  type ScrollAreaOrientation
} from './classes'
import { cx } from './utils'

export type { ScrollAreaOrientation }

export type ScrollAreaViewportProps = HTMLAttributes<HTMLDivElement> & {
  [key: `data-${string}`]: boolean | number | string | undefined
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ScrollAreaOrientation
  shadow?: boolean
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
      viewportClassName,
      viewportProps,
      viewportRef,
      ...props
    },
    ref
  ) => {
    const { className: viewportPropsClassName, ...restViewportProps } = viewportProps ?? {}
    const viewportClasses = scrollAreaViewportClassName({
      className: cx(viewportClassName, viewportPropsClassName),
      orientation
    })

    return (
      <div
        className={cx(scrollAreaClassName({ className, orientation, shadow }), scrollAreaStyleClassName({ shadow }))}
        data-orientation={orientation}
        ref={ref}
        {...props}
      >
        <div className={viewportClasses} ref={viewportRef} {...restViewportProps}>
          {children}
        </div>
      </div>
    )
  }
)

ScrollArea.displayName = 'ScrollArea'

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
