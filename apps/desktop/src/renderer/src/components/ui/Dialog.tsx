import type * as React from 'react'
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
import { IconFont } from '../primitive/Iconfont'
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
export type DialogTone = 'default' | 'info' | 'danger' | 'warning'
export const ToneContext = createContext<DialogTone>('default')
const FEEDBACK_ICONS = {
  info: 'fill-status-tips',
  danger: 'fill-status-warning',
  warning: 'fill-status-warning',
} as const
const FEEDBACK_COLORS = {
  info: 'text-[var(--vds-notice-bg-default)]',
  danger: 'text-[var(--vds-error-bg-default)]',
  warning: 'text-[var(--vds-warning-bg-default)]',
} as const

export interface DialogProps extends OpenRootProps {
  modal?: boolean
}

export function Dialog({ modal = true, ...props }: DialogProps): React.JSX.Element {
  return (
    <ModalContext.Provider value={modal}>
      <dialogContext.Provider {...props} />
    </ModalContext.Provider>
  )
}

export function DialogTrigger(
  props: HTMLAttributes<HTMLElement> & { asChild?: boolean; children?: ReactNode }
): React.JSX.Element {
  return renderTrigger(dialogContext.useOpenContext(), props)
}

export function DialogClose({
  asChild = false,
  children,
  className,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }): React.JSX.Element {
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
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element | null {
  const { open } = dialogContext.useOpenContext()
  const modal = useContext(ModalContext)
  if (!open || !modal) return null
  return <div className={cx(dialogOverlayClassName, className)} {...props} />
}

export interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  portalClassName?: string
  tone?: DialogTone
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
}): React.JSX.Element {
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
  tone = 'default',
  hideCloseButton = false,
  onPointerDown,
  overlayClassName,
  overlayProps,
  portalClassName,
  ...props
}: DialogContentProps): React.JSX.Element | null {
  const { contentId, contentRef, open, setOpen } = dialogContext.useOpenContext()
  const modal = useContext(ModalContext)
  useFocusScope(contentRef, open, modal)
  if (!open) return null
  return (
    <ToneContext.Provider value={tone}>
      <DialogOverlay className={overlayClassName} {...overlayProps} />
      <div
        aria-modal={modal ? true : undefined}
        ref={contentRef}
        tabIndex={-1}
        className={cx(
          dialogContentClassName,
          headerLayout === 'aligned' &&
            '!px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] [&_[data-slot=dialog-header]]:!gap-[var(--vds-space-1)] [&_[data-slot=dialog-header]]:pr-[calc(var(--vds-control-height-md)+var(--vds-space-1)+var(--vds-space-2)-var(--vds-space-5))] [&_[data-slot=dialog-title]]:flex [&_[data-slot=dialog-title]]:min-h-[var(--vds-control-height-md)] [&_[data-slot=dialog-title]]:items-center [&_[data-slot=dialog-title]]:!text-[length:var(--vds-font-subhead)] [&_[data-slot=dialog-title]]:!leading-[var(--vds-lh-subhead)] [&_[data-slot=dialog-title]]:!font-[var(--vds-fw-medium)]',
          className
        )}
        id={contentId}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          onPointerDown?.(event)
          if (!event.defaultPrevented) event.stopPropagation()
        }}
        role="dialog"
        data-tone={tone}
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
    </ToneContext.Provider>
  )
}

export function DialogHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div data-slot="dialog-header" className={cx(dialogHeaderClassName, className)} {...props} />
  )
}

export function DialogFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cx(dialogFooterClassName, className)} {...props} />
}

export function DialogTitle({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  const tone = useContext(ToneContext)
  return (
    <h2
      data-slot="dialog-title"
      className={cx(
        dialogTitleClassName,
        tone !== 'default' && 'flex items-start gap-[var(--vds-space-2)]',
        className
      )}
      {...props}
    >
      {tone !== 'default' ? (
        <span
          aria-hidden="true"
          data-slot="dialog-tone-icon"
          className={cx(
            'inline-flex h-[var(--vds-lh-subhead)] w-[var(--vds-icon-10)] shrink-0 items-center',
            FEEDBACK_COLORS[tone]
          )}
        >
          <IconFont type={FEEDBACK_ICONS[tone]} className="!text-[length:var(--vds-icon-10)]" />
        </span>
      ) : null}
      {tone === 'default' ? children : <span className="min-w-0">{children}</span>}
    </h2>
  )
}

export function DialogDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  const tone = useContext(ToneContext)
  return (
    <p
      className={cx(
        dialogDescriptionClassName,
        tone !== 'default' && 'pl-[calc(var(--vds-icon-10)+var(--vds-space-2))]',
        className
      )}
      {...props}
    />
  )
}

export const DialogPortal = ({ children }: { children?: ReactNode }): React.JSX.Element => {
  return <Portal>{children}</Portal>
}
