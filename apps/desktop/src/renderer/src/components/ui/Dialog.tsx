import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import {
  cloneElement,
  createContext,
  useContext,
  isValidElement,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { Button } from './Button'
import {
  dialogCloseClassName,
  dialogContentClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogTitleClassName
} from './classes'
import { createOpenContext, renderTrigger, type OpenRootProps } from './floating'
import { cx } from './utils'
import { useFocusScope } from './focus'

const dialogContext = createOpenContext('Dialog', { dismissOutside: false })
const ModalContext = createContext(true)

export interface DialogProps extends OpenRootProps {
  modal?: boolean
}

export function Dialog({ modal = true, ...props }: DialogProps): JSX.Element {
  return <ModalContext.Provider value={modal}><dialogContext.Provider {...props} /></ModalContext.Provider>
}

export function DialogTrigger(props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }): JSX.Element {
  return renderTrigger(dialogContext.useOpenContext(), props)
}

export function DialogClose({
  asChild = false,
  children,
  className,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }): JSX.Element {
  const { setOpen } = dialogContext.useOpenContext()
  const closeProps = {
    ...props,
    className,
    onClick: (event: MouseEvent<HTMLElement>) => {
      onClick?.(event as MouseEvent<HTMLButtonElement>)
      if (!event.defaultPrevented) setOpen(false)
    }
  }
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLElement>>
    return cloneElement(child, {
      ...closeProps,
      className: cx(child.props.className, closeProps.className),
      onClick: (event: MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event)
        if (!event.defaultPrevented) closeProps.onClick(event)
      }
    })
  }
  return <Button {...closeProps} type="button" variant="secondary">{children}</Button>
}

export function DialogOverlay({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element | null {
  const { open } = dialogContext.useOpenContext()
  const modal = useContext(ModalContext)
  if (!open || !modal) return null
  return <div className={cx(dialogOverlayClassName, className)} {...props} />
}

export interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  closeButtonClassName?: string
  hideCloseButton?: boolean
  overlayClassName?: string
  overlayProps?: HTMLAttributes<HTMLDivElement> & {
    [key: `data-${string}`]: boolean | number | string | undefined
  }
}

export function DialogContent({
  children,
  className,
  closeButtonClassName,
  hideCloseButton = false,
  onPointerDown,
  overlayClassName,
  overlayProps,
  ...props
}: DialogContentProps): JSX.Element | null {
  const { t } = useTranslation('ui')
  const { contentId, contentRef, open, setOpen } = dialogContext.useOpenContext()
  const modal = useContext(ModalContext)
  useFocusScope(contentRef, open, modal)
  if (!open) return null
  return (
    <>
      <DialogOverlay className={overlayClassName} {...overlayProps} />
      <div
        aria-modal={modal ? true : undefined}
        ref={contentRef}
        tabIndex={-1}
        className={cx(dialogContentClassName, className)}
        id={contentId}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          onPointerDown?.(event)
          if (!event.defaultPrevented) event.stopPropagation()
        }}
        role="dialog"
        {...props}
      >
        {children}
        {!hideCloseButton ? (
          <Button
            aria-label={t('close')}
            className={cx(dialogCloseClassName, closeButtonClassName)}
            icon={<X size={14} strokeWidth={1.6} />}
            type="button"
            variant="ghostIcon"
            onClick={() => setOpen(false)}
          />
        ) : null}
      </div>
    </>
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cx(dialogHeaderClassName, className)} {...props} />
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cx(dialogFooterClassName, className)} {...props} />
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h2 className={cx(dialogTitleClassName, className)} {...props} />
}

export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cx(dialogDescriptionClassName, className)} {...props} />
}

export const DialogPortal = ({ children }: { children?: ReactNode }): JSX.Element => {
  if (typeof document === 'undefined') return <>{children}</>
  return createPortal(children, document.body)
}
