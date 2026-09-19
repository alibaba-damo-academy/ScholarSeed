import type { HTMLAttributes } from 'react'
import { forwardRef } from 'react'

import { dividerClassName, dividerStyleClassName, type DividerOrientation } from './classes'
import { cx } from './utils'

export type { DividerOrientation }

export interface DividerProps extends HTMLAttributes<HTMLHRElement> {
  orientation?: DividerOrientation
}

export const Divider = forwardRef<HTMLHRElement, DividerProps>(
  ({ className, orientation = 'horizontal', ...props }, ref) => (
    <hr
      aria-orientation={orientation}
      className={cx(dividerClassName({ className, orientation }), dividerStyleClassName({ orientation }))}
      ref={ref}
      {...props}
    />
  )
)

Divider.displayName = 'Divider'

export const Separator = Divider
export type SeparatorProps = DividerProps
export type SeparatorOrientation = DividerOrientation

Separator.displayName = 'Separator'
