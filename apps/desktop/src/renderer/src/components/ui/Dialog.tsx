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
  type ReactNode,
} from 'react'
import { Portal, PortalScope } from './portal'

import { Button } from './Button'
import {
  dialogCloseClassName,
  dialogContentClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
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
  return (
    <ModalContext.Provider value={modal}>
      <dialogContext.Provider {...props} />
    </ModalContext.Provider>
  )
}

export function DialogTrigger(
  props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }
): JSX.Element {
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
    },
  }
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<HTMLAttributes<HTMLElement>>
    return cloneElement(child, {
      ...closeProps,
      className: cx(child.props.className, closeProps.className),
      onClick: (event: MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event)
        if (!event.defaultPrevented) closeProps.onClick(event)
      },
    })
  }
  return (
    <Button {...closeProps} type="button" variant="outline">
      {children}
    </Button>
  )
}

export function DialogOverlay({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element | null {
  const { open } = dialogContext.useOpenContext()
  const modal = useContext(ModalContext)
  if (!open || !modal) return null
  return <div className={cx(dialogOverlayClassName, className)} {...props} />
}

export interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  portalClassName?: string
  headerLayout?: 'default' | 'aligned'
  closeButtonClassName?: string
  hideCloseButton?: boolean
  overlayClassName?: string
  overlayProps?: HTMLAttributes<HTMLDivElement> & {
    [key: `data-${string}`]: boolean | number | string | undefined
  }
}

export function DialogDismissButton({
  className,
  onClose,
}: {
  className?: string
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <Button
      aria-label={t('close')}
      className={cx(dialogCloseClassName, className)}
      icon={<X size={14} strokeWidth={1.6} />}
      type="button"
      variant="ghostIcon"
      onClick={onClose}
    />
  )
}

export function DialogContent({
  children,
  className,
  closeButtonClassName,
  headerLayout = 'default',
  hideCloseButton = false,
  onPointerDown,
  overlayClassName,
  overlayProps,
  portalClassName,
  ...props
}: DialogContentProps): JSX.Element | null {
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
        className={cx(
          dialogContentClassName,
          headerLayout === 'aligned' &&
            '!px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] [&_[data-slot=dialog-header]]:!gap-[var(--vds-space-1)] [&_[data-slot=dialog-header]]:pr-[calc(var(--vds-control-height-md)+var(--vds-space-1)+var(--vds-space-2)-var(--vds-space-5))] [&_[data-slot=dialog-title]]:flex [&_[data-slot=dialog-title]]:min-h-[var(--vds-control-height-md)] [&_[data-slot=dialog-title]]:items-center [&_[data-slot=dialog-title]]:!text-[length:var(--vds-font-subhead)] [&_[data-slot=dialog-title]]:!leading-[var(--vds-lh-subhead)] [&_[data-slot=dialog-title]]:!font-[var(--vds-fw-regular)]',
          className
        )}
        id={contentId}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          onPointerDown?.(event)
          if (!event.defaultPrevented) event.stopPropagation()
        }}
        role="dialog"
        {...props}
      >
        <PortalScope className={portalClassName}>{children}</PortalScope>
        {!hideCloseButton ? (
          <DialogDismissButton
            className={cx(
              headerLayout === 'aligned' &&
                '!top-[var(--vds-space-3)] !right-[var(--vds-space-2)] !p-0',
              closeButtonClassName
            )}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
    </>
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div data-slot="dialog-header" className={cx(dialogHeaderClassName, className)} {...props} />
  )
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cx(dialogFooterClassName, className)} {...props} />
}

export function DialogTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h2 data-slot="dialog-title" className={cx(dialogTitleClassName, className)} {...props} />
}

export function DialogDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cx(dialogDescriptionClassName, className)} {...props} />
}

export const DialogPortal = ({ children }: { children?: ReactNode }): JSX.Element => {
  return <Portal>{children}</Portal>
}
