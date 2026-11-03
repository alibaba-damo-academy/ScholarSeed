import type { AnimationEvent as ReactAnimationEvent, ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { Children, createContext, forwardRef, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  buttonClassName,
  buttonStyleClassName,
  sheetClassName,
  sheetCloseClassName,
  sheetDescriptionClassName,
  sheetFooterClassName,
  sheetHeaderClassName,
  sheetOverlayClassName,
  sheetPortalClassName,
  sheetStyleClassName,
  sheetTitleClassName,
  type SheetSide
} from './classes'
import { cx } from './utils'
import { inFocusScope, visibleContent, useFocusScope } from './focus'

interface SheetContextValue {
  contentRef: RefObject<HTMLDivElement>
  close: () => void
  descriptionId: string
  finishClose: () => void
  open: boolean
  present: boolean
  restoreFocusRef: RefObject<HTMLElement | null>
  setOpen: (open: boolean) => void
  titleId: string
}

const SheetContext = createContext<SheetContextValue | null>(null)

function childOverlayHandlesEscape(content: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const activeModal = target.closest('[aria-modal="true"]')
  if (activeModal && activeModal !== content && !activeModal.contains(content)) return true
  if (!content.contains(target) && inFocusScope(content, target)) return true
  const trigger = target.closest('[aria-haspopup][aria-expanded="true"][aria-controls]')
  return (trigger?.getAttribute('aria-controls') ?? '').split(/\s+/).some(id => {
    const popup = content.ownerDocument.getElementById(id)
    return visibleContent(popup) && popup !== content && !popup.contains(content)
  })
}

function useSheetContext(component: string): SheetContextValue {
  const context = useContext(SheetContext)
  if (!context) {
    throw new Error(`${component} must be used inside Sheet`)
  }
  return context
}

export interface SheetProps {
  children: ReactNode
  onOpenChange?: (open: boolean) => void
  open?: boolean
}

export interface SheetOverlayProps extends HTMLAttributes<HTMLDivElement> {
  closeOnClick?: boolean
}

export interface SheetContentProps extends HTMLAttributes<HTMLDivElement> {
  ariaModal?: boolean
  modal?: boolean
  side?: SheetSide
}

export type SheetHeaderProps = HTMLAttributes<HTMLDivElement>
export type SheetFooterProps = HTMLAttributes<HTMLDivElement>
export type SheetTitleProps = HTMLAttributes<HTMLHeadingElement>
export type SheetDescriptionProps = HTMLAttributes<HTMLParagraphElement>
export type SheetCloseProps = ButtonHTMLAttributes<HTMLButtonElement>
export type SheetPortalProps = HTMLAttributes<HTMLDivElement>
export type SheetTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>
export type { SheetSide }

export function Sheet({ children, onOpenChange, open }: SheetProps): JSX.Element | null {
  const generatedId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const currentOpen = open ?? uncontrolledOpen
  const [present, setPresent] = useState(currentOpen)
  const setOpen = useCallback((nextOpen: boolean): void => {
    if (open === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [onOpenChange, open])
  const context = useMemo<SheetContextValue>(
    () => ({
      contentRef,
      close: () => setOpen(false),
      descriptionId: `${generatedId}-description`,
      finishClose: () => {
        if (currentOpen) return
        setPresent(false)
      },
      open: currentOpen,
      present,
      restoreFocusRef,
      setOpen,
      titleId: `${generatedId}-title`
    }),
    [currentOpen, generatedId, present, setOpen]
  )

  useEffect(() => {
    if (currentOpen) {
      setPresent(true)
      return
    }
    if (present && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false)
    }
  }, [currentOpen, present])

  useEffect(() => {
    if (!currentOpen && !present) {
      const target = restoreFocusRef.current
      if (target?.isConnected) target.focus({ preventScroll: true })
    }
  }, [currentOpen, present, restoreFocusRef])

  useEffect(() => {
    if (!currentOpen) return undefined
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent): void => {
      const content = contentRef.current
      if (event.defaultPrevented || event.key !== 'Escape' || !visibleContent(content)) return
      if (childOverlayHandlesEscape(content, document.activeElement)) return
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('keydown', handleDocumentKeyDown)
    return () => document.removeEventListener('keydown', handleDocumentKeyDown)
  }, [currentOpen, setOpen])

  const visibleChildren = currentOpen || present
    ? children
    : Children.map(children, (child) => (
      isValidElement(child) && (child.type === SheetTrigger || child.type === SheetPortal) ? child : null
    ))

  return <SheetContext.Provider value={context}>{visibleChildren}</SheetContext.Provider>
}

export const SheetPortal = forwardRef<HTMLDivElement, SheetPortalProps>(({ className, ...props }, ref) => {
  const context = useSheetContext('SheetPortal')
  if (!context.present) return null
  return <div className={cx(sheetPortalClassName, className)} ref={ref} {...props} />
})

SheetPortal.displayName = 'SheetPortal'

export const SheetTrigger = forwardRef<HTMLButtonElement, SheetTriggerProps>(
  ({ className, onClick, type = 'button', ...props }, ref) => {
    const context = useSheetContext('SheetTrigger')

    return (
      <button
        className={cx(
          buttonClassName({ className, size: 'md', variant: 'secondary' }),
          buttonStyleClassName({ size: 'md', variant: 'secondary' })
        )}
        ref={(element) => {
          ;(context.restoreFocusRef as { current: HTMLElement | null }).current = element
          if (typeof ref === 'function') ref(element)
          else if (ref) ref.current = element
        }}
        type={type}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented) {
            ;(context.restoreFocusRef as { current: HTMLElement | null }).current = event.currentTarget
            context.setOpen(true)
          }
        }}
        {...props}
      />
    )
  }
)

SheetTrigger.displayName = 'SheetTrigger'

export const SheetOverlay = forwardRef<HTMLDivElement, SheetOverlayProps>(
  ({ className, closeOnClick = true, onClick, ...props }, ref) => {
    const context = useSheetContext('SheetOverlay')

    return (
      <div
        aria-hidden="true"
        className={cx(sheetOverlayClassName, className)}
        data-state={context.open ? 'open' : 'closed'}
        ref={ref}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented && closeOnClick) context.close()
        }}
        {...props}
      />
    )
  }
)

SheetOverlay.displayName = 'SheetOverlay'

export const SheetContent = forwardRef<HTMLDivElement, SheetContentProps>(
  (
    {
      'aria-describedby': ariaDescribedBy,
      'aria-labelledby': ariaLabelledBy,
      ariaModal,
      className,
      modal = false,
      onAnimationEnd,
      onKeyDown,
      role = 'dialog',
      side = 'right',
      tabIndex = -1,
      ...props
    },
    ref
  ) => {
    const context = useSheetContext('SheetContent')

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || event.key !== 'Escape') return
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return
      if (childOverlayHandlesEscape(event.currentTarget, event.target)) return
      event.preventDefault()
      context.close()
    }
    const modalValue = ariaModal ?? modal
    useFocusScope(context.contentRef, context.open, modalValue, modalValue, context.restoreFocusRef)

    const handleAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>): void => {
      onAnimationEnd?.(event)
      if (!event.defaultPrevented && event.currentTarget === event.target && !context.open) {
        context.finishClose()
      }
    }

    return (
      <div
        aria-describedby={ariaDescribedBy ?? context.descriptionId}
        aria-labelledby={ariaLabelledBy ?? context.titleId}
        aria-modal={modalValue ? true : undefined}
        className={cx(sheetClassName({ className, side }), sheetStyleClassName({ side }))}
        data-side={side}
        data-state={context.open ? 'open' : 'closed'}
        ref={(element) => {
          (context.contentRef as { current: HTMLDivElement | null }).current = element
          if (typeof ref === 'function') ref(element)
          else if (ref) ref.current = element
        }}
        role={role}
        tabIndex={tabIndex}
        onAnimationEnd={handleAnimationEnd}
        onKeyDown={handleKeyDown}
        {...props}
      />
    )
  }
)

SheetContent.displayName = 'SheetContent'

export const SheetHeader = forwardRef<HTMLDivElement, SheetHeaderProps>(({ className, ...props }, ref) => (
  <div className={cx(sheetHeaderClassName, className)} ref={ref} {...props} />
))

SheetHeader.displayName = 'SheetHeader'

export const SheetFooter = forwardRef<HTMLDivElement, SheetFooterProps>(({ className, ...props }, ref) => (
  <div className={cx(sheetFooterClassName, className)} ref={ref} {...props} />
))

SheetFooter.displayName = 'SheetFooter'

export const SheetTitle = forwardRef<HTMLHeadingElement, SheetTitleProps>(({ className, id, ...props }, ref) => {
  const context = useSheetContext('SheetTitle')

  return <h2 className={cx(sheetTitleClassName, className)} id={id ?? context.titleId} ref={ref} {...props} />
})

SheetTitle.displayName = 'SheetTitle'

export const SheetDescription = forwardRef<HTMLParagraphElement, SheetDescriptionProps>(
  ({ className, id, ...props }, ref) => {
    const context = useSheetContext('SheetDescription')

    return <p className={cx(sheetDescriptionClassName, className)} id={id ?? context.descriptionId} ref={ref} {...props} />
  }
)

SheetDescription.displayName = 'SheetDescription'

export const SheetClose = forwardRef<HTMLButtonElement, SheetCloseProps>(
  ({ className, onClick, type = 'button', ...props }, ref) => {
    const context = useSheetContext('SheetClose')

    return (
      <button
        className={cx(sheetCloseClassName, className)}
        ref={ref}
        type={type}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented) context.close()
        }}
        {...props}
      />
    )
  }
)

SheetClose.displayName = 'SheetClose'
