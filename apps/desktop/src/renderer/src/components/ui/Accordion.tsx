import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, ReactNode, Ref } from 'react'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  accordionClassName,
  accordionContentClassName,
  accordionContentInnerClassName,
  accordionItemClassName,
  accordionStyleClassName,
  accordionTriggerClassName,
  type AccordionMode
} from './classes'
import { cx } from './utils'

export type { AccordionMode }

type AccordionValue = string | string[]

interface AccordionContextValue {
  baseId: string
  disabled: boolean
  mode: AccordionMode
  openValues: string[]
  registerTrigger: (value: string, node: HTMLButtonElement | null) => void
  setItemOpen: (value: string, open: boolean) => void
  triggerValues: string[]
}

interface AccordionItemContextValue {
  contentId: string
  disabled: boolean
  open: boolean
  triggerId: string
  value: string
}

const AccordionContext = createContext<AccordionContextValue | null>(null)
const AccordionItemContext = createContext<AccordionItemContextValue | null>(null)

function useAccordionContext(component: string): AccordionContextValue {
  const context = useContext(AccordionContext)
  if (!context) throw new Error(`${component} must be used inside Accordion`)
  return context
}

function useAccordionItemContext(component: string): AccordionItemContextValue {
  const context = useContext(AccordionItemContext)
  if (!context) throw new Error(`${component} must be used inside AccordionItem`)
  return context
}

export interface AccordionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  children: ReactNode
  defaultValue?: AccordionValue
  disabled?: boolean
  mode?: AccordionMode
  onValueChange?: (value: AccordionValue) => void
  value?: AccordionValue
}

export interface AccordionItemProps extends HTMLAttributes<HTMLDivElement> {
  disabled?: boolean
  value: string
}

export type AccordionTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>
export type AccordionContentProps = HTMLAttributes<HTMLDivElement>

type AccordionItemChildRef = { ref?: Ref<HTMLDivElement> }
type AccordionItemCloneProps = Partial<AccordionItemProps> & { ref?: Ref<HTMLDivElement> }

function toValueArray(value: AccordionValue | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function fromValueArray(values: string[], mode: AccordionMode): AccordionValue {
  return mode === 'multiple' ? values : values[0] ?? ''
}

function getAccordionTriggerId(baseId: string, value: string): string {
  return `${baseId}-trigger-${value}`
}

function getAccordionContentId(baseId: string, value: string): string {
  return `${baseId}-content-${value}`
}

export const Accordion = forwardRef<HTMLDivElement, AccordionProps>(
  (
    {
      children,
      className,
      defaultValue,
      disabled = false,
      mode = 'single',
      onKeyDown,
      onValueChange,
      value,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
    const [uncontrolledValue, setUncontrolledValue] = useState<AccordionValue | undefined>(defaultValue)
    const currentValue = value ?? uncontrolledValue
    const openValues = toValueArray(currentValue)
    const triggerValues: string[] = []

    Children.forEach(children, (child) => {
      if (!isValidElement<AccordionItemProps>(child)) return
      if (child.props.disabled) return
      triggerValues.push(child.props.value)
    })

    const context = useMemo<AccordionContextValue>(
      () => ({
        baseId: generatedId,
        disabled,
        mode,
        openValues,
        registerTrigger: (itemValue, node) => {
          if (node) triggerRefs.current.set(itemValue, node)
          else triggerRefs.current.delete(itemValue)
        },
        setItemOpen: (itemValue, open) => {
          if (disabled) return
          const nextValues =
            mode === 'multiple'
              ? open
                ? Array.from(new Set([...openValues, itemValue]))
                : openValues.filter((openValue) => openValue !== itemValue)
              : open
                ? [itemValue]
                : openValues.filter((openValue) => openValue !== itemValue)
          const nextValue = fromValueArray(nextValues, mode)
          if (value === undefined) setUncontrolledValue(nextValue)
          onValueChange?.(nextValue)
        },
        triggerValues
      }),
      [disabled, generatedId, mode, onValueChange, openValues, triggerValues, value]
    )

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || disabled || triggerValues.length === 0) return
      const activeElement = event.currentTarget.ownerDocument.activeElement
      const currentIndex = triggerValues.findIndex((itemValue) => triggerRefs.current.get(itemValue) === activeElement)
      if (currentIndex < 0) return

      let nextIndex: number | undefined
      if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % triggerValues.length
      if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + triggerValues.length) % triggerValues.length
      if (event.key === 'Home') nextIndex = 0
      if (event.key === 'End') nextIndex = triggerValues.length - 1
      if (nextIndex === undefined) return

      event.preventDefault()
      triggerRefs.current.get(triggerValues[nextIndex])?.focus()
    }

    return (
      <AccordionContext.Provider value={context}>
        <div
          className={cx(accordionClassName({ className, mode }), accordionStyleClassName())}
          data-mode={mode}
          ref={ref}
          onKeyDown={handleKeyDown}
          {...props}
        >
          {Children.map(children, (child) => {
            if (!isValidElement<AccordionItemProps>(child)) return child
            const childRef = (child as AccordionItemChildRef).ref
            const cloneProps: AccordionItemCloneProps = {
              ref: childRef
            }
            return cloneElement(child, cloneProps)
          })}
        </div>
      </AccordionContext.Provider>
    )
  }
)

Accordion.displayName = 'Accordion'

export const AccordionItem = forwardRef<HTMLDivElement, AccordionItemProps>(
  ({ children, className, disabled = false, value, ...props }, ref) => {
    const context = useAccordionContext('AccordionItem')
    const isDisabled = context.disabled || disabled
    const open = context.openValues.includes(value)
    const itemContext = useMemo<AccordionItemContextValue>(
      () => ({
        contentId: getAccordionContentId(context.baseId, value),
        disabled: isDisabled,
        open,
        triggerId: getAccordionTriggerId(context.baseId, value),
        value
      }),
      [context.baseId, isDisabled, open, value]
    )

    return (
      <AccordionItemContext.Provider value={itemContext}>
        <div
          className={cx(accordionItemClassName, open && 'vds-accordion__item--open', className)}
          data-disabled={isDisabled ? 'true' : undefined}
          data-state={open ? 'open' : 'closed'}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      </AccordionItemContext.Provider>
    )
  }
)

AccordionItem.displayName = 'AccordionItem'

export const AccordionTrigger = forwardRef<HTMLButtonElement, AccordionTriggerProps>(
  ({ className, disabled, onClick, type = 'button', ...props }, ref) => {
    const context = useAccordionContext('AccordionTrigger')
    const item = useAccordionItemContext('AccordionTrigger')
    const isDisabled = item.disabled || disabled

    const toggle = (): void => {
      if (!isDisabled) context.setItemOpen(item.value, !item.open)
    }

    return (
      <button
        aria-controls={item.contentId}
        aria-expanded={item.open}
        className={cx(accordionTriggerClassName, className)}
        data-state={item.open ? 'open' : 'closed'}
        disabled={isDisabled}
        id={item.triggerId}
        ref={(node) => {
          context.registerTrigger(item.value, node)
          if (typeof ref === 'function') ref(node)
          else if (ref) {
            ;(ref as { current: HTMLButtonElement | null }).current = node
          }
        }}
        type={type}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented) toggle()
        }}
        {...props}
      />
    )
  }
)

AccordionTrigger.displayName = 'AccordionTrigger'

export const AccordionContent = forwardRef<HTMLDivElement, AccordionContentProps>(
  ({ children, className, ...props }, ref) => {
    const item = useAccordionItemContext('AccordionContent')

    return (
      <div
        aria-hidden={!item.open}
        aria-labelledby={item.triggerId}
        className={cx(accordionContentClassName, className)}
        data-state={item.open ? 'open' : 'closed'}
        id={item.contentId}
        ref={ref}
        role="region"
        {...props}
      >
        <div className={accordionContentInnerClassName}>{children}</div>
      </div>
    )
  }
)

AccordionContent.displayName = 'AccordionContent'
