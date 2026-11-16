import type * as React from 'react'
import { type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { Portal, usePortalOverlay } from './portal'

import { popoverContentClassName } from './classes'
import {
  createOpenContext,
  renderTrigger,
  useFloatingContentStyle,
  type FloatingAlign,
  type FloatingSide,
  type FloatingPosition,
  type OpenRootProps,
} from './floating'
import { cxWithOverrides } from './utils'
import { useFocusScope } from './focus'

const popoverContext = createOpenContext('Popover')

export type PopoverProps = OpenRootProps

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  hosted?: boolean
  horizontalAnchorRef?: RefObject<HTMLElement | null>
  position?: FloatingPosition
  autoFocus?: boolean
  trapFocus?: boolean
  /** 相对触发器的水平对齐；默认与触发器左缘对齐。 */
  align?: FloatingAlign
  /** 展开方向；默认按可用空间自动选择上/下。 */
  side?: FloatingSide
}

export function Popover(props: PopoverProps): React.JSX.Element {
  return <popoverContext.Provider {...props} />
}

export function PopoverTrigger(
  props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }
): React.JSX.Element {
  return renderTrigger(popoverContext.useOpenContext(), props)
}

export function PopoverContent({
  hosted = false,
  ...props
}: PopoverContentProps): React.JSX.Element | null {
  const renderOverlay = usePortalOverlay()
  const { open } = popoverContext.useOpenContext()
  if (!open) return null
  const content = <PopoverContentView {...props} />
  return <>{hosted && renderOverlay ? renderOverlay(content) : content}</>
}

function PopoverContentView({
  align = 'start',
  className,
  side = 'auto',
  style,
  position,
  autoFocus = true,
  trapFocus = false,
  horizontalAnchorRef,
  ...props
}: PopoverContentProps): React.JSX.Element | null {
  const context = popoverContext.useOpenContext()
  const { contentId, contentRef, open } = context
  const positionedStyle = useFloatingContentStyle(
    { ...context, position: position ?? context.position },
    style,
    side,
    align,
    horizontalAnchorRef
  )
  useFocusScope(
    contentRef,
    open && positionedStyle?.visibility !== 'hidden',
    trapFocus,
    autoFocus,
    context.anchorRef
  )
  if (!open) return null
  return (
    <Portal>
      <div
        tabIndex={-1}
        className={cxWithOverrides(popoverContentClassName, className)}
        id={contentId}
        ref={contentRef}
        role="region"
        style={positionedStyle}
        {...props}
      />
    </Portal>
  )
}

export const PopoverAnchor = ({ children }: { children?: ReactNode }): React.JSX.Element => (
  <>{children}</>
)
