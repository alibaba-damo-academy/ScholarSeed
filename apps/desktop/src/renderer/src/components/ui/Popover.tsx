import { type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { popoverContentClassName } from './classes'
import {
  createOpenContext,
  renderTrigger,
  useFloatingContentStyle,
  type FloatingAlign,
  type FloatingSide,
  type OpenRootProps
} from './floating'
import { cxWithOverrides } from './utils'
import { useFocusScope } from './focus'

const popoverContext = createOpenContext('Popover')

export type PopoverProps = OpenRootProps

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  /** 相对触发器的水平对齐；默认与触发器左缘对齐。 */
  align?: FloatingAlign
  /** 展开方向；默认按可用空间自动选择上/下。 */
  side?: FloatingSide
}

export function Popover(props: PopoverProps): JSX.Element {
  return <popoverContext.Provider {...props} />
}

export function PopoverTrigger(props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }): JSX.Element {
  return renderTrigger(popoverContext.useOpenContext(), props)
}

export function PopoverContent({ align = 'start', className, side = 'auto', style, ...props }: PopoverContentProps): JSX.Element | null {
  const context = popoverContext.useOpenContext()
  const { contentId, contentRef, open } = context
  const positionedStyle = useFloatingContentStyle(context, style, side, align)
  useFocusScope(contentRef, open && positionedStyle?.visibility !== 'hidden', false, true)
  if (!open) return null
  return createPortal(
    <div tabIndex={-1} className={cxWithOverrides(popoverContentClassName, className)} id={contentId} ref={contentRef} role="region" style={positionedStyle} {...props} />,
    document.body
  )
}

export const PopoverAnchor = ({ children }: { children?: ReactNode }): JSX.Element => <>{children}</>
