import type { CSSProperties, HTMLAttributes } from 'react'
import { forwardRef, useId } from 'react'

import {
  progressBarClassName,
  progressBarStyleClassName,
  progressCardClassName,
  progressCardStyleClassName
} from './classes'
import { cx } from './utils'

const MIN_PROGRESS = 0
const MAX_PROGRESS = 100
const RING_SIZE = 100
const RING_CENTER = RING_SIZE / 2
const RING_RADIUS = 42
const RING_STROKE_WIDTH = 8

function normalizeProgressValue(value: number): number {
  return Math.min(MAX_PROGRESS, Math.max(MIN_PROGRESS, value))
}

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  indeterminate?: boolean
  label?: string
  value?: number
  shape?: 'line' | 'circle'
}

export interface ProgressProps extends Omit<ProgressBarProps, 'color'> {
  color?: 'error' | 'info' | 'primary' | 'success' | 'warning'
  progressClassName?: string
  progressColor?: string
  showPercentage?: boolean
  size?: 'lg' | 'md' | 'sm'
  subtitle?: string
  title?: string
  type?: 'error' | 'normal' | 'success' | 'warning'
}

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ className, indeterminate = false, label, shape = 'line', style, value = MIN_PROGRESS, ...props }, ref) => {
    const labelId = useId()
    const normalizedValue = normalizeProgressValue(value)
    const rootStyle: CSSProperties | undefined = indeterminate
      ? style
      : { ...style, '--vds-progress-value': normalizedValue / MAX_PROGRESS } as CSSProperties

    if (shape === 'circle') {
      return (
        <div
          {...props}
          ref={ref}
          style={style}
          className={cx('inline-flex aspect-square items-center justify-center', className)}
          role="progressbar"
          aria-label={label}
          aria-valuemin={MIN_PROGRESS}
          aria-valuemax={MAX_PROGRESS}
          aria-valuenow={indeterminate ? undefined : normalizedValue}
        >
          <svg aria-hidden="true" viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className={cx('size-full -rotate-90', indeterminate && 'animate-spin motion-reduce:animate-none')}>
            <circle cx={RING_CENTER} cy={RING_CENTER} r={RING_RADIUS} fill="none" stroke="var(--vds-other-overlay-2)" strokeWidth={RING_STROKE_WIDTH} />
            {(indeterminate || normalizedValue > MIN_PROGRESS) && (
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                stroke="var(--vds-brand-bg-default)"
                strokeWidth={RING_STROKE_WIDTH}
                strokeLinecap="round"
                pathLength={MAX_PROGRESS}
                strokeDasharray={`${MAX_PROGRESS} ${MAX_PROGRESS}`}
                strokeDashoffset={MAX_PROGRESS - (indeterminate ? MAX_PROGRESS / 4 : normalizedValue)}
                className="transition-[stroke-dashoffset] duration-[var(--vds-duration-fast)] ease-linear motion-reduce:transition-none"
              />
            )}
          </svg>
        </div>
      )
    }

    return (
      <div
        className={cx(progressBarClassName({ className, indeterminate }), progressBarStyleClassName())}
        ref={ref}
        style={rootStyle}
        {...props}
      >
        {label ? (
          <span
            className="vds-progress-bar__label [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
            id={labelId}
          >
            {label}
          </span>
        ) : null}
        <span
          aria-labelledby={label ? labelId : undefined}
          aria-valuemax={MAX_PROGRESS}
          aria-valuemin={MIN_PROGRESS}
          aria-valuenow={indeterminate ? undefined : normalizedValue}
          className="vds-progress-bar__track block h-[var(--vds-progress-height)] overflow-hidden rounded-[var(--vds-radius-10)] bg-[var(--vds-progress-track)]"
          role="progressbar"
        >
          <span
            className={cx(
              'vds-progress-bar__value block h-full origin-left rounded-[inherit] bg-[var(--vds-progress-value-color)] [background-image:var(--vds-progress-value-image)] transition-transform duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
              indeterminate
                ? 'w-[var(--vds-progress-indeterminate-width)] animate-[vds-progress-indeterminate_var(--vds-progress-indeterminate-duration)_var(--vds-ease-standard)_infinite] [transform:translateX(var(--vds-progress-indeterminate-start))]'
                : 'w-full [transform:scaleX(var(--vds-progress-value))]'
            )}
          />
        </span>
      </div>
    )
  }
)

ProgressBar.displayName = 'ProgressBar'

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(
  (
    {
      className,
      color = 'primary',
      progressClassName,
      progressColor,
      showPercentage = true,
      size = 'sm',
      style,
      subtitle,
      title,
      type,
      value = MIN_PROGRESS,
      ...props
    },
    ref
  ) => {
    const normalizedValue = normalizeProgressValue(value)
    const tone = type === 'normal' || !type ? color : type

    if (!title && !subtitle && !showPercentage) {
      return (
        <ProgressBar
          className={cx(`vds-progress--${size}`, progressClassName, className)}
          ref={ref}
          style={{ ...style, '--vds-progress-value-color': progressColor } as CSSProperties}
          value={normalizedValue}
          {...props}
        />
      )
    }

    return (
      <div className={cx(progressCardClassName({ className }), progressCardStyleClassName())} data-tone={tone}>
        <div className="vds-progress-card__header flex items-start justify-between gap-[var(--vds-space-3)]">
          <div className="vds-progress-card__copy min-w-0">
            {title ? (
              <h3 className="vds-progress-card__title m-0 text-[length:var(--vds-font-body-lv2)] font-medium leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                {title}
              </h3>
            ) : null}
            {subtitle ? (
              <p className="vds-progress-card__subtitle m-0 overflow-hidden truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                {subtitle}
              </p>
            ) : null}
          </div>
          {showPercentage ? (
            <span className="vds-progress-card__percent shrink-0 rounded-[var(--vds-radius-2)] bg-[var(--vds-brand-light-bg-default)] px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-brand-text-primary)]">
              {Math.round(normalizedValue)}%
            </span>
          ) : null}
        </div>
        <ProgressBar
          className={cx(`vds-progress--${size}`, progressClassName)}
          ref={ref}
          style={{ ...style, '--vds-progress-value-color': progressColor } as CSSProperties}
          value={normalizedValue}
          {...props}
        />
      </div>
    )
  }
)

Progress.displayName = 'Progress'
