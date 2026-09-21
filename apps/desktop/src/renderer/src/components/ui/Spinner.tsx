import { useTranslation } from 'react-i18next'
import type { HTMLAttributes } from 'react'

import { spinnerClassName, spinnerStyleClassName, type ComponentSize } from './classes'
import { cx } from './utils'

export type SpinnerSize = ComponentSize

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  imageSrc?: string
  size?: SpinnerSize
}

export function Spinner({ children, className, imageSrc, size = 'md', ...props }: SpinnerProps): JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <span
      aria-label={t('loading')}
      className={cx(spinnerClassName({ className, size }), spinnerStyleClassName({ image: Boolean(imageSrc), size }))}
      role="status"
      {...props}
    >
      {imageSrc ? <img src={imageSrc} alt="" aria-hidden="true" className="block size-full object-contain" /> : children}
    </span>
  )
}

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  height?: number | string
  width?: number | string
}

export function Skeleton({ className, height = 16, style, width = '100%', ...props }: SkeletonProps): JSX.Element {
  return (
    <span
      className={cx(
        'vds-skeleton relative block overflow-hidden [border-radius:var(--vds-radius-3)] [background:var(--vds-other-overlay-2)] after:absolute after:[inset:0] after:[background:linear-gradient(90deg,transparent,var(--vds-other-white-overlay-1),transparent)] after:content-[""] after:animate-[vds-skeleton-shimmer_1.4s_var(--vds-ease-standard)_infinite]',
        className
      )}
      style={{ height, width, ...style }}
      {...props}
    />
  )
}
