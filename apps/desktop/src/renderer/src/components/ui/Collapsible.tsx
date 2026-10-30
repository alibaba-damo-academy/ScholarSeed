import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
} from 'react'
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'

import {
  collapsibleClassName,
  collapsibleContentClassName,
  collapsibleStyleClassName,
  collapsibleTriggerClassName,
} from './classes'
import { cx } from './utils'

interface CollapsibleContextValue {
  animated: boolean
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
  animated?: boolean
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
    {
      animated = false,
      children,
      className,
      defaultOpen = false,
      disabled = false,
      onOpenChange,
      open,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
    const currentOpen = open ?? uncontrolledOpen

    const context = useMemo<CollapsibleContextValue>(
      () => ({
        animated,
        contentId: `${generatedId}-content`,
        disabled,
        open: currentOpen,
        setOpen: (nextOpen: boolean) => {
          if (disabled) return
          if (open === undefined) setUncontrolledOpen(nextOpen)
          onOpenChange?.(nextOpen)
        },
      }),
      [animated, currentOpen, disabled, generatedId, onOpenChange, open]
    )

    return (
      <CollapsibleContext.Provider value={context}>
        <div
          className={cx(
            collapsibleClassName({ className, open: currentOpen }),
            collapsibleStyleClassName(),
            animated && '!gap-0'
          )}
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
  (
    {
      asChild = false,
      children,
      className,
      disabled,
      onClick,
      onKeyDown,
      type = 'button',
      ...props
    },
    ref
  ) => {
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
      ...props,
    }

    if (asChild && isValidElement(children)) {
      const child = children as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>
      return cloneElement(child, {
        ...triggerStateProps,
        className: cx(child.props.className, triggerStateProps.className),
        disabled: child.props.disabled || triggerStateProps.disabled,
      })
    }

    return (
      <button ref={ref} type={type} {...triggerStateProps}>
        {children}
      </button>
    )
  }
)

CollapsibleTrigger.displayName = 'CollapsibleTrigger'

export const CollapsibleContent = forwardRef<HTMLDivElement, CollapsibleContentProps>(
  ({ children, className, ...props }, ref) => {
    const context = useCollapsibleContext('CollapsibleContent')
    const [expanded, setExpanded] = useState(false)
    const contentRef = useCallback(
      (element: HTMLDivElement | null) => {
        if (element) {
          if (!context.open && element.contains(document.activeElement)) {
            element.parentElement
              ?.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(context.contentId)}"]`)
              ?.focus()
          }
          element.inert = !context.open
        }
        if (typeof ref === 'function') ref(element)
        else if (ref) ref.current = element
      },
      [context.contentId, context.open, ref]
    )

    useEffect(() => {
      if (!context.animated) return
      const frame = requestAnimationFrame(() => setExpanded(context.open))
      return () => cancelAnimationFrame(frame)
    }, [context.animated, context.open])

    if (context.animated) {
      return (
        <div
          {...props}
          className={cx(
            'grid min-w-0 transition-[grid-template-rows,opacity] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none',
            expanded
              ? 'grid-rows-[1fr] opacity-[var(--vds-opacity-full)]'
              : 'grid-rows-[0fr] opacity-0'
          )}
          data-state={context.open ? 'open' : 'closed'}
          aria-hidden={!context.open}
          id={context.contentId}
          ref={contentRef}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pt-[var(--vds-collapsible-content-gap,var(--vds-space-2))]">
              <div className={cx(collapsibleContentClassName, '!animate-none', className)}>
                {children}
              </div>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div
        className={cx(collapsibleContentClassName, className)}
        data-state={context.open ? 'open' : 'closed'}
        hidden={!context.open}
        id={context.contentId}
        ref={ref}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CollapsibleContent.displayName = 'CollapsibleContent'
