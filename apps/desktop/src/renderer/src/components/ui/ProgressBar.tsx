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

function normalizeProgressValue(value: number): number {
  return Math.min(MAX_PROGRESS, Math.max(MIN_PROGRESS, value))
}

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  indeterminate?: boolean
  label?: string
  value?: number
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
  ({ className, indeterminate = false, label, style, value = MIN_PROGRESS, ...props }, ref) => {
    const labelId = useId()
    const normalizedValue = normalizeProgressValue(value)
    const rootStyle: CSSProperties | undefined = indeterminate
      ? style
      : { ...style, '--vds-progress-value': normalizedValue / MAX_PROGRESS } as CSSProperties

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
