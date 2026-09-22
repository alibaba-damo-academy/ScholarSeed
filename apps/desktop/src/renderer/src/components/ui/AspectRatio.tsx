import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { aspectRatioClassName } from './classes'
import { cx } from './utils'

const DEFAULT_ASPECT_RATIO = 16 / 9

export interface AspectRatioProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
  ratio?: number
}

export const AspectRatio = forwardRef<HTMLDivElement, AspectRatioProps>(
  ({ children, className, ratio = DEFAULT_ASPECT_RATIO, style, ...props }, ref) => {
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_ASPECT_RATIO
    const ratioStyle = {
      ...style,
      '--vds-aspect-ratio': String(safeRatio)
    } as CSSProperties

    return (
      <div
        className={cx(
          aspectRatioClassName({ className }),
          'relative w-full overflow-hidden rounded-[inherit] [aspect-ratio:var(--vds-aspect-ratio)]'
        )}
        ref={ref}
        style={ratioStyle}
        {...props}
      >
        <div className="vds-aspect-ratio__content absolute inset-0 min-h-0 min-w-0 overflow-hidden [&>*]:size-full">
          {children}
        </div>
      </div>
    )
  }
)

AspectRatio.displayName = 'AspectRatio'
