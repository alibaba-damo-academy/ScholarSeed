import type { CSSProperties, InputHTMLAttributes, KeyboardEvent, PointerEvent } from 'react'
import { forwardRef, useId, useState } from 'react'

import {
  sliderClassName,
  sliderControlClassName,
  sliderInputClassName,
  sliderLabelClassName,
  sliderRangeClassName,
  sliderStyleClassName,
  sliderThumbClassName,
  sliderTrackClassName,
  type SliderOrientation
} from './classes'
import { cx } from './utils'

export type { SliderOrientation }

interface SliderBaseProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'defaultValue' | 'disabled' | 'max' | 'min' | 'onChange' | 'orientation' | 'step' | 'type' | 'value'
  > {
  disabled?: boolean
  label?: string
  max?: number
  min?: number
  orientation?: SliderOrientation
  step?: number
}

export interface SliderSingleProps extends SliderBaseProps {
  defaultValue?: number
  onValueChange?: (value: number) => void
  value?: number
}

export interface SliderRangeProps extends SliderBaseProps {
  defaultValue?: number[]
  onValueChange?: (value: number[]) => void
  value?: number[]
}

export type SliderProps = SliderSingleProps | SliderRangeProps

const DEFAULT_MIN = 0
const DEFAULT_MAX = 100
const DEFAULT_STEP = 1
const PAGE_STEP_COUNT = 10

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function alignToStep(value: number, min: number, step: number): number {
  const steps = Math.round((value - min) / step)
  return min + steps * step
}

function normalizeValue(value: number, min: number, max: number, step: number): number {
  return clamp(alignToStep(value, min, step), min, max)
}

function toValueArray(value: number | number[] | undefined, fallback: number): number[] {
  if (Array.isArray(value)) return value.length ? value : [fallback]
  if (value === undefined) return [fallback]
  return [value]
}

function normalizeValues(values: number[], min: number, max: number, step: number): number[] {
  return values.map((item) => normalizeValue(item, min, max, step)).sort((left, right) => left - right)
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      className,
      defaultValue,
      disabled = false,
      id,
      label,
      max = DEFAULT_MAX,
      min = DEFAULT_MIN,
      onKeyDown,
      onValueChange,
      orientation = 'horizontal',
      step = DEFAULT_STEP,
      value,
      ...props
    },
    ref
  ) => {
    const handleValueChange = onValueChange as ((nextValue: number | number[]) => void) | undefined
    const generatedId = useId()
    const sliderId = id ?? generatedId
    const safeStep = step > 0 ? step : DEFAULT_STEP
    const safeMax = Math.max(max, min)
    const isArrayValue = Array.isArray(value) || Array.isArray(defaultValue)
    const fallbackValue = defaultValue ?? min
    const [uncontrolledValue, setUncontrolledValue] = useState<number[]>(() =>
      normalizeValues(toValueArray(fallbackValue, min), min, safeMax, safeStep)
    )
    const [draggingThumbIndex, setDraggingThumbIndex] = useState<number | null>(null)
    const currentValues = normalizeValues(toValueArray(value, min), min, safeMax, safeStep)
    const sliderValues = value === undefined ? uncontrolledValue : currentValues
    const rangeStart = sliderValues.length > 1 ? sliderValues[0] : min
    const rangeEnd = sliderValues[sliderValues.length - 1] ?? rangeStart
    const startPercentage = safeMax === min ? 0 : ((rangeStart - min) / (safeMax - min)) * 100
    const endPercentage = safeMax === min ? 0 : ((rangeEnd - min) / (safeMax - min)) * 100
    const thumbPercentages = sliderValues.map((sliderValue) =>
      safeMax === min ? 0 : ((sliderValue - min) / (safeMax - min)) * 100
    )

    const commitValues = (nextValues: number[]): void => {
      if (disabled) return
      const normalizedValues = normalizeValues(nextValues, min, safeMax, safeStep)
      if (value === undefined) setUncontrolledValue(normalizedValues)
      handleValueChange?.(isArrayValue ? normalizedValues : normalizedValues[0])
    }

    const commitThumbValue = (thumbIndex: number, nextValue: number): void => {
      const nextValues = [...sliderValues]
      nextValues[thumbIndex] = nextValue
      commitValues(nextValues)
    }

    const getValueFromPointer = (event: PointerEvent<HTMLDivElement>): number => {
      const rect = event.currentTarget.getBoundingClientRect()
      const ratio =
        orientation === 'vertical'
          ? (rect.bottom - event.clientY) / rect.height
          : (event.clientX - rect.left) / rect.width
      return min + clamp(ratio, 0, 1) * (safeMax - min)
    }

    const handleControlPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
      if (disabled) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const nextValue = getValueFromPointer(event)
      const nearestThumbIndex = sliderValues.reduce((nearestIndex, item, index) => {
        const nearestDistance = Math.abs(sliderValues[nearestIndex] - nextValue)
        return Math.abs(item - nextValue) < nearestDistance ? index : nearestIndex
      }, 0)
      setDraggingThumbIndex(nearestThumbIndex)
      commitThumbValue(nearestThumbIndex, nextValue)
    }

    const handleControlPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
      if (disabled || draggingThumbIndex === null) return
      event.preventDefault()
      commitThumbValue(draggingThumbIndex, getValueFromPointer(event))
    }

    const handleControlPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setDraggingThumbIndex(null)
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, thumbIndex: number): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || disabled) return

      const currentValue = sliderValues[thumbIndex] ?? min
      const direction = orientation === 'vertical' ? -1 : 1
      const keyHandlers: Record<string, number | undefined> = {
        ArrowDown: currentValue - safeStep,
        ArrowLeft: currentValue - safeStep * direction,
        ArrowRight: currentValue + safeStep * direction,
        ArrowUp: currentValue + safeStep,
        End: safeMax,
        Home: min,
        PageDown: currentValue - safeStep * PAGE_STEP_COUNT,
        PageUp: currentValue + safeStep * PAGE_STEP_COUNT
      }
      const nextValue = keyHandlers[event.key]

      if (nextValue === undefined) return
      event.preventDefault()
      commitThumbValue(thumbIndex, nextValue)
    }

    return (
      <div className={cx(sliderClassName({ className, disabled, orientation }), sliderStyleClassName({ disabled, orientation }))}>
        {label ? (
          <label className={sliderLabelClassName} htmlFor={sliderId}>
            {label}
          </label>
        ) : null}
        <div
          className={sliderControlClassName}
          style={{
            '--vds-slider-range-end': `${endPercentage}%`,
            '--vds-slider-range-start': `${startPercentage}%`
          } as CSSProperties}
          onPointerDown={handleControlPointerDown}
          onPointerCancel={handleControlPointerEnd}
          onPointerMove={handleControlPointerMove}
          onPointerUp={handleControlPointerEnd}
          onLostPointerCapture={() => setDraggingThumbIndex(null)}
        >
          <span className={sliderTrackClassName} />
          <span className={sliderRangeClassName} />
          {thumbPercentages.map((thumbPercentage, index) => (
            <span
              aria-hidden="true"
              className={sliderThumbClassName}
              key={`thumb-${index}`}
              style={{ '--vds-slider-thumb-position': `${thumbPercentage}%` } as CSSProperties}
            />
          ))}
          {sliderValues.map((sliderValue, index) => (
            <input
              aria-label={label && sliderValues.length > 1 ? `${label} ${index + 1}` : label}
              aria-orientation={orientation}
              aria-valuemax={safeMax}
              aria-valuemin={min}
              aria-valuenow={sliderValue}
              className={sliderInputClassName}
              disabled={disabled}
              id={index === 0 ? sliderId : `${sliderId}-${index}`}
              key={index}
              max={safeMax}
              min={min}
              ref={index === 0 ? ref : undefined}
              step={safeStep}
              type="range"
              value={sliderValue}
              onChange={(event) => commitThumbValue(index, Number(event.currentTarget.value))}
              onKeyDown={(event) => handleKeyDown(event, index)}
              {...props}
            />
          ))}
        </div>
      </div>
    )
  }
)

Slider.displayName = 'Slider'
