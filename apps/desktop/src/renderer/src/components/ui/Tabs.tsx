import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, KeyboardEvent, Ref } from 'react'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  tabsClassName,
  tabsContentClassName,
  tabsIndicatorClassName,
  tabsListClassName,
  tabsStyleClassName,
  tabsTriggerClassName,
  type TabsOrientation
} from './classes'
import { cx } from './utils'

export type { TabsOrientation }

interface TabsContextValue {
  activeValue: string | undefined
  baseId: string
  disabled: boolean
  enabledValues: string[]
  orientation: TabsOrientation
  registerTrigger: (value: string, node: HTMLButtonElement | null) => void
  setValue: (value: string, focus?: boolean) => void
  value: string | undefined
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext)
  if (!context) {
    throw new Error(`${component} must be used inside Tabs`)
  }
  return context
}

export interface TabsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange' | 'value'> {
  defaultValue?: string
  disabled?: boolean
  onValueChange?: (value: string) => void
  orientation?: TabsOrientation
  value?: string
}

export interface TabsListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown'> {
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export interface TabsTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

const HORIZONTAL_NEXT_KEYS = new Set(['ArrowRight'])
const HORIZONTAL_PREVIOUS_KEYS = new Set(['ArrowLeft'])
const VERTICAL_NEXT_KEYS = new Set(['ArrowDown'])
const VERTICAL_PREVIOUS_KEYS = new Set(['ArrowUp'])

type TabsTriggerChildRef = { ref?: Ref<HTMLButtonElement> }
type TabsTriggerCloneProps = Partial<TabsTriggerProps> & { ref: Ref<HTMLButtonElement> }

function getTriggerValues(children: TabsListProps['children']): string[] {
  const values: string[] = []

  Children.forEach(children, (child) => {
    if (!isValidElement<TabsTriggerProps>(child)) return
    if (child.props.disabled) return
    values.push(child.props.value)
  })

  return values
}

function getEnabledTriggerValues(children: TabsProps['children']): string[] {
  const values: string[] = []

  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: TabsListProps['children'] }>(child)) return
    Children.forEach(child.props.children, (nestedChild) => {
      if (!isValidElement<TabsTriggerProps>(nestedChild)) return
      if (nestedChild.props.disabled) return
      values.push(nestedChild.props.value)
    })
  })

  return values
}

function getTabId(baseId: string, value: string): string {
  return `${baseId}-trigger-${value}`
}

function getPanelId(baseId: string, value: string): string {
  return `${baseId}-content-${value}`
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(
  (
    {
      children,
      className,
      defaultValue,
      disabled = false,
      onValueChange,
      orientation = 'horizontal',
      value,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
    const currentValue = value ?? uncontrolledValue
    const enabledValues = getEnabledTriggerValues(children)
    const activeValue = currentValue && enabledValues.includes(currentValue) ? currentValue : enabledValues[0]

    const context = useMemo<TabsContextValue>(
      () => ({
        activeValue,
        baseId: generatedId,
        disabled,
        enabledValues,
        orientation,
        registerTrigger: (triggerValue, node) => {
          if (node) triggerRefs.current.set(triggerValue, node)
          else triggerRefs.current.delete(triggerValue)
        },
        setValue: (nextValue, focus = false) => {
          if (disabled || !enabledValues.includes(nextValue)) return
          if (value === undefined) setUncontrolledValue(nextValue)
          onValueChange?.(nextValue)
          if (focus) triggerRefs.current.get(nextValue)?.focus()
        },
        value: currentValue,
      }),
      [activeValue, currentValue, disabled, enabledValues, generatedId, onValueChange, orientation, value]
    )

    return (
      <TabsContext.Provider value={context}>
        <div className={cx(tabsClassName({ className, orientation }), tabsStyleClassName({ orientation }))} ref={ref} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    )
  }
)

Tabs.displayName = 'Tabs'

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ children, className, onKeyDown, ...props }, ref) => {
    const context = useTabsContext('TabsList')
    const listRef = useRef<HTMLDivElement>(null)
    const [indicatorStyle, setIndicatorStyle] = useState<CSSProperties>({
      left: 0,
      opacity: 0,
      transform: 'translateX(0px)',
      width: 0
    })
    const values = getTriggerValues(children)
    const activeValue =
      context.activeValue && values.includes(context.activeValue) ? context.activeValue : values[0]

    useImperativeHandle(ref, () => listRef.current as HTMLDivElement)

    useLayoutEffect(() => {
      const listElement = listRef.current
      if (!listElement || context.orientation !== 'horizontal') return undefined

      const updateIndicator = (): void => {
        const activeTrigger = listElement.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
        if (!activeTrigger) {
          setIndicatorStyle((previousStyle) => ({ ...previousStyle, opacity: 0 }))
          return
        }

        setIndicatorStyle({
          left: 0,
          opacity: 1,
          transform: `translateX(${activeTrigger.offsetLeft}px)`,
          width: activeTrigger.offsetWidth
        })
      }

      updateIndicator()

      const mutationObserver = new MutationObserver(updateIndicator)
      mutationObserver.observe(listElement, {
        attributeFilter: ['data-state'],
        attributes: true,
        subtree: true
      })

      const resizeObserver =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateIndicator)
      resizeObserver?.observe(listElement)
      Array.from(listElement.children).forEach((child) => resizeObserver?.observe(child))

      window.addEventListener('resize', updateIndicator)

      return () => {
        mutationObserver.disconnect()
        resizeObserver?.disconnect()
        window.removeEventListener('resize', updateIndicator)
      }
    }, [activeValue, children, context.orientation])

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || context.disabled || values.length === 0) return

      const nextKeys = context.orientation === 'vertical' ? VERTICAL_NEXT_KEYS : HORIZONTAL_NEXT_KEYS
      const previousKeys = context.orientation === 'vertical' ? VERTICAL_PREVIOUS_KEYS : HORIZONTAL_PREVIOUS_KEYS
      const isNext = nextKeys.has(event.key)
      const isPrevious = previousKeys.has(event.key)

      if (!isNext && !isPrevious) return

      event.preventDefault()
      const currentIndex = values.indexOf(activeValue)
      const offset = isNext ? 1 : -1
      const nextIndex = (currentIndex + offset + values.length) % values.length
      context.setValue(values[nextIndex], true)
    }

    return (
      <div
        aria-orientation={context.orientation}
        className={cx(tabsListClassName, className)}
        ref={listRef}
        role="tablist"
        onKeyDown={handleKeyDown}
        {...props}
      >
        {context.orientation === 'horizontal' ? (
          <span aria-hidden="true" className={tabsIndicatorClassName} style={indicatorStyle} />
        ) : null}
        {Children.map(children, (child) => {
          if (!isValidElement<TabsTriggerProps>(child)) return child
          const childRef = (child as TabsTriggerChildRef).ref
          const triggerProps: TabsTriggerCloneProps = {
            ref: (node: HTMLButtonElement | null) => {
              context.registerTrigger(child.props.value, node)
              if (typeof childRef === 'function') childRef(node)
              else if (childRef && 'current' in childRef) {
                ;(childRef as { current: HTMLButtonElement | null }).current = node
              }
            }
          }

          return cloneElement(child, triggerProps)
        })}
      </div>
    )
  }
)

TabsList.displayName = 'TabsList'

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, disabled, type = 'button', value, onClick, ...props }, ref) => {
    const context = useTabsContext('TabsTrigger')
    const selected = context.activeValue === value
    const isDisabled = context.disabled || disabled

    return (
      <button
        aria-controls={getPanelId(context.baseId, value)}
        aria-disabled={isDisabled || undefined}
        aria-selected={selected}
        className={cx(tabsTriggerClassName, selected && 'vds-tabs__trigger--selected', className)}
        data-state={selected ? 'active' : 'inactive'}
        disabled={isDisabled}
        id={getTabId(context.baseId, value)}
        ref={ref}
        role="tab"
        tabIndex={isDisabled ? undefined : selected ? 0 : -1}
        type={type}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented && !isDisabled) context.setValue(value)
        }}
        {...props}
      />
    )
  }
)

TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, ...props }, ref) => {
    const context = useTabsContext('TabsContent')
    const selected = context.activeValue === value

    return (
      <div
        aria-labelledby={getTabId(context.baseId, value)}
        className={cx(tabsContentClassName, className)}
        hidden={!selected}
        id={getPanelId(context.baseId, value)}
        ref={ref}
        role="tabpanel"
        tabIndex={selected ? 0 : undefined}
        {...props}
      />
    )
  }
)

TabsContent.displayName = 'TabsContent'
