import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, ReactNode, Ref } from 'react'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useMemo,
  useRef,
  useState
} from 'react'

import {
  toggleClassName,
  toggleGroupClassName,
  toggleGroupStyleClassName,
  toggleStyleClassName,
  type ToggleGroupMode,
  type ToggleGroupOrientation,
  type ToggleSize,
  type ToggleVariant
} from './classes'
import { cx } from './utils'

export type { ToggleGroupMode, ToggleGroupOrientation }

type ToggleGroupValue = string | string[]

interface ToggleGroupContextValue {
  allowEmpty: boolean
  disabled: boolean
  enabledValues: string[]
  mode: ToggleGroupMode
  orientation: ToggleGroupOrientation
  pressedValues: string[]
  registerItem: (value: string, node: HTMLButtonElement | null) => void
  setItemPressed: (value: string, pressed: boolean, focus?: boolean) => void
  size: ToggleSize
  variant: ToggleVariant
}

const ToggleGroupContext = createContext<ToggleGroupContextValue | null>(null)

function useToggleGroupContext(component: string): ToggleGroupContextValue {
  const context = useContext(ToggleGroupContext)
  if (!context) throw new Error(`${component} must be used inside ToggleGroup`)
  return context
}

export interface ToggleGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  children: ReactNode
  allowEmpty?: boolean
  defaultValue?: ToggleGroupValue
  disabled?: boolean
  mode?: ToggleGroupMode
  onValueChange?: (value: ToggleGroupValue) => void
  orientation?: ToggleGroupOrientation
  size?: ToggleSize
  type?: ToggleGroupMode
  value?: ToggleGroupValue
  variant?: ToggleVariant
}

export interface ToggleGroupItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string
}

export type SegmentedControlProps = Omit<ToggleGroupProps, 'allowEmpty' | 'mode'> & {
  allowEmpty?: boolean
}

type ToggleGroupItemChildRef = { ref?: Ref<HTMLButtonElement> }
type ToggleGroupItemCloneProps = Partial<ToggleGroupItemProps> & { ref: Ref<HTMLButtonElement> }

const HORIZONTAL_NEXT_KEYS = new Set(['ArrowRight'])
const HORIZONTAL_PREVIOUS_KEYS = new Set(['ArrowLeft'])
const VERTICAL_NEXT_KEYS = new Set(['ArrowDown'])
const VERTICAL_PREVIOUS_KEYS = new Set(['ArrowUp'])

function toValueArray(value: ToggleGroupValue | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function fromValueArray(values: string[], mode: ToggleGroupMode): ToggleGroupValue {
  return mode === 'multiple' ? values : values[0] ?? ''
}

function getEnabledValues(children: ToggleGroupProps['children']): string[] {
  const values: string[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement<ToggleGroupItemProps>(child)) return
    if (child.props.disabled) return
    values.push(child.props.value)
  })
  return values
}

export const ToggleGroup = forwardRef<HTMLDivElement, ToggleGroupProps>(
  (
    {
      children,
      allowEmpty = true,
      className,
      defaultValue,
      disabled = false,
      mode = 'single',
      onKeyDown,
      onValueChange,
      orientation = 'horizontal',
      size = 'md',
      type,
      value,
      variant = 'secondary',
      ...props
    },
    ref
  ) => {
    const groupMode = type ?? mode
    const itemRefs = useRef(new Map<string, HTMLButtonElement>())
    const [uncontrolledValue, setUncontrolledValue] = useState<ToggleGroupValue | undefined>(defaultValue)
    const currentValue = value ?? uncontrolledValue
    const pressedValues = toValueArray(currentValue)
    const enabledValues = getEnabledValues(children)
    const activeValue =
      pressedValues.find((itemValue) => enabledValues.includes(itemValue)) ?? enabledValues[0]

    const context = useMemo<ToggleGroupContextValue>(
      () => ({
        allowEmpty,
        disabled,
        enabledValues,
        mode: groupMode,
        orientation,
        pressedValues,
        registerItem: (itemValue, node) => {
          if (node) itemRefs.current.set(itemValue, node)
          else itemRefs.current.delete(itemValue)
        },
        setItemPressed: (itemValue, pressed, focus = false) => {
          if (disabled || !enabledValues.includes(itemValue)) return
          const nextValues =
            groupMode === 'multiple'
              ? pressed
                ? Array.from(new Set([...pressedValues, itemValue]))
                : pressedValues.filter((pressedValue) => pressedValue !== itemValue)
              : pressed
                ? [itemValue]
                : allowEmpty
                  ? []
                  : pressedValues
          const nextValue = fromValueArray(nextValues, groupMode)
          if (value === undefined) setUncontrolledValue(nextValue)
          onValueChange?.(nextValue)
          if (focus) itemRefs.current.get(itemValue)?.focus()
        },
        size,
        variant
      }),
      [allowEmpty, disabled, enabledValues, groupMode, onValueChange, orientation, pressedValues, size, value, variant]
    )

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || disabled || enabledValues.length === 0) return

      const nextKeys = orientation === 'vertical' ? VERTICAL_NEXT_KEYS : HORIZONTAL_NEXT_KEYS
      const previousKeys = orientation === 'vertical' ? VERTICAL_PREVIOUS_KEYS : HORIZONTAL_PREVIOUS_KEYS
      const isNext = nextKeys.has(event.key)
      const isPrevious = previousKeys.has(event.key)
      if (!isNext && !isPrevious) return

      event.preventDefault()
      const currentIndex = enabledValues.indexOf(activeValue)
      const offset = isNext ? 1 : -1
      const nextIndex = (currentIndex + offset + enabledValues.length) % enabledValues.length
      const nextValue = enabledValues[nextIndex]
      context.setItemPressed(nextValue, true, true)
    }

    return (
      <ToggleGroupContext.Provider value={context}>
        <div
          aria-disabled={disabled || undefined}
          aria-orientation={orientation}
          className={cx(toggleGroupClassName({ className, orientation }), toggleGroupStyleClassName({ orientation }))}
          ref={ref}
          role="group"
          onKeyDown={handleKeyDown}
          {...props}
        >
          {Children.map(children, (child) => {
            if (!isValidElement<ToggleGroupItemProps>(child)) return child
            const childRef = (child as ToggleGroupItemChildRef).ref
            const itemProps: ToggleGroupItemCloneProps = {
              ref: (node: HTMLButtonElement | null) => {
                context.registerItem(child.props.value, node)
                if (typeof childRef === 'function') childRef(node)
                else if (childRef && 'current' in childRef) {
                  ;(childRef as { current: HTMLButtonElement | null }).current = node
                }
              }
            }
            return cloneElement(child, itemProps)
          })}
        </div>
      </ToggleGroupContext.Provider>
    )
  }
)

ToggleGroup.displayName = 'ToggleGroup'

export const ToggleGroupItem = forwardRef<HTMLButtonElement, ToggleGroupItemProps>(
  ({ children, className, disabled, onClick, type = 'button', value, ...props }, ref) => {
    const context = useToggleGroupContext('ToggleGroupItem')
    const isDisabled = context.disabled || disabled
    const pressed = context.pressedValues.includes(value)
    const activeValue =
      context.pressedValues.find((itemValue) => context.enabledValues.includes(itemValue)) ??
      context.enabledValues[0]

    return (
      <button
        aria-pressed={pressed}
        className={cx(
          toggleClassName({
            className,
            pressed,
            size: context.size,
            variant: context.variant
          }),
          toggleStyleClassName({
            pressed,
            size: context.size,
            variant: context.variant
          })
        )}
        data-state={pressed ? 'on' : 'off'}
        disabled={isDisabled}
        ref={ref}
        tabIndex={isDisabled ? undefined : activeValue === value ? 0 : -1}
        type={type}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented && !isDisabled) context.setItemPressed(value, !pressed)
        }}
        {...props}
      >
        {children}
      </button>
    )
  }
)

ToggleGroupItem.displayName = 'ToggleGroupItem'

export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  ({ allowEmpty = false, ...props }, ref) => <ToggleGroup allowEmpty={allowEmpty} mode="single" ref={ref} {...props} />
)

SegmentedControl.displayName = 'SegmentedControl'
