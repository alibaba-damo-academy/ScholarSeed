import { useTranslation } from 'react-i18next'
import type {
  ChangeEvent,
  ClipboardEvent,
  CompositionEvent,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent
} from 'react'
import { createContext, forwardRef, useContext, useId, useRef, useState } from 'react'

import {
  inputOtpClassName,
  inputOtpDescriptionClassName,
  inputOtpErrorClassName,
  inputOtpLabelClassName,
  inputOtpSeparatorClassName,
  inputOtpSlotClassName,
  inputOtpSlotsClassName,
  inputOtpSlotWrapClassName,
  inputOtpStyleClassName
} from './classes'
import { cx } from './utils'

export type InputOtpMode = 'numeric' | 'text'

export interface InputOTPProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange' | 'onComplete'> {
  containerClassName?: string
  defaultValue?: string
  description?: string
  disabled?: boolean
  error?: string
  inputMode?: InputOtpMode
  invalid?: boolean
  label?: string
  length?: number
  maxLength?: number
  onChange?: (value: string) => void
  onComplete?: (value: string) => void
  onSlotsChange?: (slots: string[]) => void
  onValueChange?: (value: string) => void
  separator?: React.ReactNode
  separatorEvery?: number
  slots?: readonly string[]
  slotProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'aria-describedby' | 'aria-invalid' | 'disabled' | 'inputMode' | 'maxLength' | 'onChange' | 'onKeyDown' | 'onPaste' | 'value'
  >
  value?: string
}

const DEFAULT_LENGTH = 6
const DEFAULT_SEPARATOR_EVERY = 3
const DIGIT_PATTERN = /\d/g

const InputOTPContext = createContext<{ slots: string[] }>({ slots: [] })

function sanitizeValue(value: string, mode: InputOtpMode, length: number): string {
  const source = mode === 'numeric' ? Array.from(value.matchAll(DIGIT_PATTERN), (match) => match[0]).join('') : value
  return Array.from(source).slice(0, length).join('')
}

function valueToSlots(value: string, mode: InputOtpMode, length: number): string[] {
  const chars = Array.from(sanitizeValue(value, mode, length))
  return Array.from({ length }, (_, index) => chars[index] ?? '')
}

function normalizeSlots(slots: readonly string[], mode: InputOtpMode, length: number): string[] {
  return Array.from({ length }, (_, index) => sanitizeValue(slots[index] ?? '', mode, 1))
}

function slotsToValue(slots: readonly string[]): string {
  return slots.join('')
}

function replaceSlot(slots: string[], index: number, replacement: string): string[] {
  return slots.map((slot, slotIndex) => (slotIndex === index ? replacement : slot))
}

export const InputOTP = forwardRef<HTMLDivElement, InputOTPProps>(
  (
    {
      className,
      children,
      containerClassName,
      defaultValue = '',
      description,
      disabled = false,
      error,
      id,
      inputMode = 'numeric',
      invalid = false,
      label,
      length = DEFAULT_LENGTH,
      maxLength,
      onChange,
      onComplete,
      onSlotsChange,
      onValueChange,
      separator = '-',
      separatorEvery = DEFAULT_SEPARATOR_EVERY,
      slots: controlledSlots,
      slotProps,
      value,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const generatedId = useId()
    const rootId = id ?? generatedId
    const safeLength = Math.max(1, Math.floor(maxLength ?? length))
    const [uncontrolledSlots, setUncontrolledSlots] = useState(() => valueToSlots(defaultValue, inputMode, safeLength))
    const inputRefs = useRef<Array<HTMLInputElement | null>>([])
    const composingSlots = useRef(new Set<number>())
    const slots =
      controlledSlots !== undefined
        ? normalizeSlots(controlledSlots, inputMode, safeLength)
        : value === undefined
          ? normalizeSlots(uncontrolledSlots, inputMode, safeLength)
          : valueToSlots(value, inputMode, safeLength)
    const hasError = invalid || Boolean(error)
    const descriptionId = description ? `${rootId}-description` : undefined
    const errorId = error ? `${rootId}-error` : undefined
    const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined

    const commitSlots = (nextSlots: string[]): void => {
      if (disabled) return
      const normalizedSlots = normalizeSlots(nextSlots, inputMode, safeLength)
      const normalizedValue = slotsToValue(normalizedSlots)
      if (controlledSlots === undefined && value === undefined) setUncontrolledSlots(normalizedSlots)
      onSlotsChange?.(normalizedSlots)
      onChange?.(normalizedValue)
      onValueChange?.(normalizedValue)
      if (normalizedSlots.every(Boolean)) onComplete?.(normalizedValue)
    }

    const focusSlot = (index: number): void => {
      inputRefs.current[clampIndex(index, safeLength)]?.focus()
    }

    const handleInput = (event: ChangeEvent<HTMLInputElement>, index: number): void => {
      if (composingSlots.current.has(index)) return
      const nextChar = sanitizeValue(event.currentTarget.value, inputMode, 1)
      if (!nextChar) {
        commitSlots(replaceSlot(slots, index, ''))
        return
      }
      commitSlots(replaceSlot(slots, index, nextChar))
      if (index < safeLength - 1) focusSlot(index + 1)
    }

    const handleCompositionStart = (event: CompositionEvent<HTMLInputElement>, index: number): void => {
      composingSlots.current.add(index)
      slotProps?.onCompositionStart?.(event)
    }

    const handleCompositionEnd = (event: CompositionEvent<HTMLInputElement>, index: number): void => {
      composingSlots.current.delete(index)
      slotProps?.onCompositionEnd?.(event)
      const nextChar = sanitizeValue(event.currentTarget.value, inputMode, 1)
      if (!nextChar) {
        commitSlots(replaceSlot(slots, index, ''))
        return
      }
      commitSlots(replaceSlot(slots, index, nextChar))
      if (index < safeLength - 1) focusSlot(index + 1)
    }

    const handlePaste = (event: ClipboardEvent<HTMLInputElement>, index: number): void => {
      event.preventDefault()
      const pastedValue = sanitizeValue(event.clipboardData.getData('text'), inputMode, safeLength - index)
      if (!pastedValue) return
      const nextSlots = [...slots]
      Array.from(pastedValue).forEach((char, offset) => {
        nextSlots[index + offset] = char
      })
      commitSlots(nextSlots)
      focusSlot(index + pastedValue.length >= safeLength ? safeLength - 1 : index + pastedValue.length)
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number): void => {
      if (event.key === 'Backspace' && slots[index]) {
        event.preventDefault()
        commitSlots(replaceSlot(slots, index, ''))
        return
      }
      if (event.key === 'Backspace' && !slots[index] && index > 0) {
        event.preventDefault()
        commitSlots(replaceSlot(slots, index - 1, ''))
        focusSlot(index - 1)
        return
      }
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        focusSlot(index - 1)
      }
      if (event.key === 'ArrowRight' && index < safeLength - 1) {
        event.preventDefault()
        focusSlot(index + 1)
      }
    }

    return (
      <div
        aria-disabled={disabled || undefined}
        className={cx(
          inputOtpClassName({ className: cx(containerClassName, className), disabled, invalid: hasError }),
          inputOtpStyleClassName({ disabled })
        )}
        id={rootId}
        ref={ref}
        {...props}
      >
        {label ? (
          <span className={inputOtpLabelClassName} id={`${rootId}-label`}>
            {label}
          </span>
        ) : null}
        {description ? (
          <span className={inputOtpDescriptionClassName} id={descriptionId}>
            {description}
          </span>
        ) : null}
        {children ? (
          <InputOTPContext.Provider value={{ slots }}>{children}</InputOTPContext.Provider>
        ) : (
          <div aria-labelledby={label ? `${rootId}-label` : undefined} className={inputOtpSlotsClassName} role="group">
            {slots.map((slotValue, index) => (
              <span className={inputOtpSlotWrapClassName} key={`${rootId}-${index}`}>
                <input
                  {...slotProps}
                  aria-describedby={describedBy}
                  aria-invalid={hasError || undefined}
                  aria-label={label ? `${label} ${index + 1}` : t('otp.slot', { position: index + 1 })}
                  className={cx(inputOtpSlotClassName, slotProps?.className)}
                  disabled={disabled}
                  inputMode={inputMode === 'numeric' ? 'numeric' : 'text'}
                  maxLength={1}
                  ref={(node) => {
                    inputRefs.current[index] = node
                  }}
                  type="text"
                  value={slotValue}
                  onChange={(event) => handleInput(event, index)}
                  onCompositionEnd={(event) => handleCompositionEnd(event, index)}
                  onCompositionStart={(event) => handleCompositionStart(event, index)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                  onPaste={(event) => handlePaste(event, index)}
                />
                {separatorEvery > 0 && index < safeLength - 1 && (index + 1) % separatorEvery === 0 ? (
                  <span aria-hidden="true" className={inputOtpSeparatorClassName}>
                    {separator}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        )}
        {error ? (
          <span className={inputOtpErrorClassName} id={errorId}>
            {error}
          </span>
        ) : null}
      </div>
    )
  }
)

InputOTP.displayName = 'InputOTP'

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1)
}

export type InputOTPGroupProps = HTMLAttributes<HTMLDivElement>

export const InputOTPGroup = forwardRef<HTMLDivElement, InputOTPGroupProps>(({ className, ...props }, ref) => (
  <div className={cx(inputOtpSlotsClassName, className)} ref={ref} role="group" {...props} />
))

InputOTPGroup.displayName = 'InputOTPGroup'

export interface InputOTPSlotProps extends HTMLAttributes<HTMLSpanElement> {
  index: number
}

export const InputOTPSlot = forwardRef<HTMLSpanElement, InputOTPSlotProps>(
  ({ children, className, index, ...props }, ref) => {
    const { t } = useTranslation('ui')
    const context = useContext(InputOTPContext)

    return (
      <span
        aria-label={t('otp.slot', { position: index + 1 })}
        className={cx(inputOtpSlotClassName, className)}
        data-index={index}
        ref={ref}
        {...props}
      >
        {children ?? context.slots[index]}
      </span>
    )
  }
)

InputOTPSlot.displayName = 'InputOTPSlot'

export type InputOTPSeparatorProps = HTMLAttributes<HTMLSpanElement>

export const InputOTPSeparator = forwardRef<HTMLSpanElement, InputOTPSeparatorProps>(
  ({ children = '-', className, ...props }, ref) => (
    <span aria-hidden="true" className={cx(inputOtpSeparatorClassName, className)} ref={ref} {...props}>
      {children}
    </span>
  )
)

InputOTPSeparator.displayName = 'InputOTPSeparator'
