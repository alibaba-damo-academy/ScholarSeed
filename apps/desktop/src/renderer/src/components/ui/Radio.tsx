import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, Ref } from 'react'
import { Children, cloneElement, forwardRef, isValidElement, useRef, useState } from 'react'

import {
  controlLabelClassName,
  radioClassName,
  radioDotClassName,
  radioGroupClassName,
  radioGroupStyleClassName,
  radioStyleClassName,
  type RadioGroupOrientation
} from './classes'
import { cx } from './utils'

export interface RadioProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked?: boolean
  label?: string
  onCheckedChange?: (checked: boolean) => void
  value?: string
}

export const Radio = forwardRef<HTMLButtonElement, RadioProps>(
  ({ checked = false, children, className, disabled, label, onCheckedChange, type = 'button', ...props }, ref) => (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cx(radioClassName({ checked, className }), radioStyleClassName())}
      disabled={disabled}
      ref={ref}
      role="radio"
      type={type}
      onClick={() => {
        if (!disabled && !checked) onCheckedChange?.(true)
      }}
      {...props}
    >
      <span aria-hidden="true" className={radioDotClassName} />
      {children || label ? <span className={cx('vds-radio__label', controlLabelClassName)}>{children ?? label}</span> : null}
    </button>
  )
)

Radio.displayName = 'Radio'
export const RadioGroupItem = Radio

export type { RadioGroupOrientation }

export interface RadioGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'disabled' | 'onChange' | 'role' | 'value'> {
  defaultValue?: string
  disabled?: boolean
  name?: string
  onValueChange?: (value: string) => void
  orientation?: RadioGroupOrientation
  value?: string
}

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight'])
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp'])
type RadioChildRef = { ref?: Ref<HTMLButtonElement> }
type RadioCloneProps = Partial<RadioProps> & { ref: Ref<HTMLButtonElement> }

function getEnabledValues(children: RadioGroupProps['children']): string[] {
  const values: string[] = []

  Children.forEach(children, (child) => {
    if (!isValidElement<RadioProps>(child)) return
    if (child.props.disabled) return
    if (!child.props.value) return
    values.push(child.props.value)
  })

  return values
}

export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(
  (
    {
      children,
      className,
      defaultValue,
      disabled = false,
      name,
      onKeyDown,
      onValueChange,
      orientation = 'vertical',
      value,
      ...props
    },
    ref
  ) => {
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
    const itemRefs = useRef(new Map<string, HTMLButtonElement>())
    const selectedValue = value ?? uncontrolledValue
    const enabledValues = getEnabledValues(children)
    const focusableValue = selectedValue && enabledValues.includes(selectedValue) ? selectedValue : enabledValues[0]

    const selectValue = (nextValue: string, focus = false): void => {
      if (disabled) return
      if (value === undefined) setUncontrolledValue(nextValue)
      onValueChange?.(nextValue)
      if (focus) itemRefs.current.get(nextValue)?.focus()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || disabled) return
      if (!NEXT_KEYS.has(event.key) && !PREVIOUS_KEYS.has(event.key)) return
      if (enabledValues.length === 0) return

      event.preventDefault()
      const currentIndex = enabledValues.indexOf(selectedValue ?? '')
      const fallbackIndex = NEXT_KEYS.has(event.key) ? -1 : 0
      const baseIndex = currentIndex >= 0 ? currentIndex : fallbackIndex
      const offset = NEXT_KEYS.has(event.key) ? 1 : -1
      const nextIndex = (baseIndex + offset + enabledValues.length) % enabledValues.length
      selectValue(enabledValues[nextIndex], true)
    }

    return (
      <div
        aria-disabled={disabled || undefined}
        aria-orientation={orientation}
        className={cx(radioGroupClassName({ className, orientation }), radioGroupStyleClassName({ orientation }))}
        data-name={name}
        ref={ref}
        role="radiogroup"
        onKeyDown={handleKeyDown}
        {...props}
      >
        {Children.map(children, (child) => {
          if (!isValidElement<RadioProps>(child)) return child
          const itemValue = child.props.value
          const itemDisabled = disabled || child.props.disabled
          const childRef = (child as RadioChildRef).ref

          const radioProps: RadioCloneProps = {
            checked: itemValue !== undefined ? itemValue === selectedValue : child.props.checked,
            disabled: itemDisabled,
            name,
            ref: (node: HTMLButtonElement | null) => {
              if (itemValue !== undefined) {
                if (node) itemRefs.current.set(itemValue, node)
                else itemRefs.current.delete(itemValue)
              }
              if (typeof childRef === 'function') childRef(node)
              else if (childRef && 'current' in childRef) {
                ;(childRef as { current: HTMLButtonElement | null }).current = node
              }
            },
            tabIndex: itemDisabled ? undefined : itemValue === focusableValue ? 0 : -1,
            onCheckedChange: (checked: boolean) => {
              child.props.onCheckedChange?.(checked)
              if (checked && itemValue !== undefined) selectValue(itemValue)
            }
          }

          return cloneElement(child, radioProps)
        })}
      </div>
    )
  }
)

RadioGroup.displayName = 'RadioGroup'
