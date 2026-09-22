import type { HTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { floatingToolbarActionsClassName, floatingToolbarClassName } from './classes'

export interface FloatingToolbarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  actions: ReactNode
  children?: ReactNode
  expanded?: boolean
  label: string
}

/**
 * Opaque, elevated shell for contextual actions anchored over product content.
 * Positioning and business state remain owned by the consuming feature.
 */
export const FloatingToolbar = forwardRef<HTMLDivElement, FloatingToolbarProps>(
  ({ actions, children, className, expanded = false, label, ...props }, ref) => (
    <div
      className={floatingToolbarClassName({ className, expanded })}
      data-state={expanded ? 'expanded' : 'collapsed'}
      ref={ref}
      {...props}
    >
      <div aria-label={label} className={floatingToolbarActionsClassName} role="toolbar">
        {actions}
      </div>
      {children}
    </div>
  )
)

FloatingToolbar.displayName = 'FloatingToolbar'
