import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Button, type ButtonVariant } from './Button'
import { dialogContentClassName, dialogOverlayClassName } from './classes'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './Dialog'
import { createOpenContext, renderTrigger, type OpenRootProps } from './floating'
import { cx } from './utils'
import { useFocusScope } from './focus'

const alertDialogContext = createOpenContext('AlertDialog', { dismissOutside: false })

export type AlertDialogProps = OpenRootProps

export function AlertDialog(props: AlertDialogProps): JSX.Element {
  return <alertDialogContext.Provider {...props} />
}

export function AlertDialogTrigger(props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }): JSX.Element {
  return renderTrigger(alertDialogContext.useOpenContext(), props)
}

export interface AlertDialogContentProps extends HTMLAttributes<HTMLDivElement> {
  overlayClassName?: string
}

export function AlertDialogContent({
  children,
  className,
  overlayClassName,
  ...props
}: AlertDialogContentProps): JSX.Element | null {
  const { contentId, contentRef, open } = alertDialogContext.useOpenContext()
  useFocusScope(contentRef, open, true)
  if (!open) return null
  return (
    <>
      <div className={cx(dialogOverlayClassName, overlayClassName)} />
      <div tabIndex={-1} aria-modal="true" className={cx(dialogContentClassName, className)} id={contentId} ref={contentRef} role="alertdialog" {...props}>
        {children}
      </div>
    </>
  )
}

export function AlertDialogCancel({ children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const { setOpen } = alertDialogContext.useOpenContext()
  return (
    <Button
      {...props}
      className={className}
      onClick={(event) => {
        props.onClick?.(event)
        if (!event.defaultPrevented) setOpen(false)
      }}
      type="button"
      variant="outline"
    >
      {children}
    </Button>
  )
}

export function AlertDialogAction({ children, className, variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): JSX.Element {
  const { setOpen } = alertDialogContext.useOpenContext()
  return (
    <Button
      {...props}
      className={className}
      onClick={(event) => {
        props.onClick?.(event)
        if (!event.defaultPrevented) setOpen(false)
      }}
      type="button"
      variant={variant}
    >
      {children}
    </Button>
  )
}

export const AlertDialogHeader = DialogHeader
export const AlertDialogFooter = DialogFooter
export const AlertDialogTitle = DialogTitle
export const AlertDialogDescription = DialogDescription
export function AlertDialogOverlay({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element | null {
  const { open } = alertDialogContext.useOpenContext()
  if (!open) return null
  return <div className={cx(dialogOverlayClassName, className)} {...props} />
}
export const AlertDialogPortal = ({ children }: { children?: ReactNode }): JSX.Element => {
  if (typeof document === 'undefined') return <>{children}</>
  return createPortal(children, document.body)
}
