import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react'
import { cloneElement, createContext, forwardRef, isValidElement, useContext, useId, useMemo, useState } from 'react'

import {
  collapsibleClassName,
  collapsibleContentClassName,
  collapsibleStyleClassName,
  collapsibleTriggerClassName
} from './classes'
import { cx } from './utils'

interface CollapsibleContextValue {
  contentId: string
  disabled: boolean
  open: boolean
  setOpen: (open: boolean) => void
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null)

function useCollapsibleContext(component: string): CollapsibleContextValue {
  const context = useContext(CollapsibleContext)
  if (!context) {
    throw new Error(`${component} must be used inside Collapsible`)
  }
  return context
}

export interface CollapsibleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onToggle'> {
  children: ReactNode
  defaultOpen?: boolean
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  open?: boolean
}

export interface CollapsibleTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
}
export type CollapsibleContentProps = HTMLAttributes<HTMLDivElement>

export const Collapsible = forwardRef<HTMLDivElement, CollapsibleProps>(
  (
    { children, className, defaultOpen = false, disabled = false, onOpenChange, open, ...props },
    ref
  ) => {
    const generatedId = useId()
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
    const currentOpen = open ?? uncontrolledOpen

    const context = useMemo<CollapsibleContextValue>(
      () => ({
        contentId: `${generatedId}-content`,
        disabled,
        open: currentOpen,
        setOpen: (nextOpen: boolean) => {
          if (disabled) return
          if (open === undefined) setUncontrolledOpen(nextOpen)
          onOpenChange?.(nextOpen)
        }
      }),
      [currentOpen, disabled, generatedId, onOpenChange, open]
    )

    return (
      <CollapsibleContext.Provider value={context}>
        <div
          className={cx(collapsibleClassName({ className, open: currentOpen }), collapsibleStyleClassName())}
          data-state={currentOpen ? 'open' : 'closed'}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      </CollapsibleContext.Provider>
    )
  }
)

Collapsible.displayName = 'Collapsible'

export const CollapsibleTrigger = forwardRef<HTMLButtonElement, CollapsibleTriggerProps>(
  ({ asChild = false, children, className, disabled, onClick, onKeyDown, type = 'button', ...props }, ref) => {
    const context = useCollapsibleContext('CollapsibleTrigger')
    const isDisabled = context.disabled || disabled

    const toggle = (): void => {
      if (!isDisabled) context.setOpen(!context.open)
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    }

    const triggerStateProps = {
      'aria-controls': context.contentId,
      'aria-expanded': context.open,
      className: cx(collapsibleTriggerClassName, className),
      'data-state': context.open ? 'open' : 'closed',
      disabled: isDisabled,
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (!event.defaultPrevented) toggle()
      },
      onKeyDown: handleKeyDown,
      ...props
    }

    if (asChild && isValidElement(children)) {
      const child = children as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>
      return cloneElement(child, {
        ...triggerStateProps,
        className: cx(child.props.className, triggerStateProps.className),
        disabled: child.props.disabled || triggerStateProps.disabled
      })
    }

    return <button ref={ref} type={type} {...triggerStateProps}>{children}</button>
  }
)

CollapsibleTrigger.displayName = 'CollapsibleTrigger'

export const CollapsibleContent = forwardRef<HTMLDivElement, CollapsibleContentProps>(
  ({ className, ...props }, ref) => {
    const context = useCollapsibleContext('CollapsibleContent')

    return (
      <div
        className={cx(collapsibleContentClassName, className)}
        data-state={context.open ? 'open' : 'closed'}
        hidden={!context.open}
        id={context.contentId}
        ref={ref}
        {...props}
      />
    )
  }
)

CollapsibleContent.displayName = 'CollapsibleContent'
