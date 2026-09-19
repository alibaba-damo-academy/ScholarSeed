import type { HTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { cx } from './utils'
import { cardClassName, cardStyleClassName, type CardPadding, type CardVariant } from './classes'

export type { CardPadding, CardVariant }

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  padding?: CardPadding
  variant?: CardVariant
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ children, className, padding = 'md', variant = 'bordered', ...props }, ref) => (
    <div className={cx(cardClassName({ className, padding, variant }), cardStyleClassName({ padding, variant }))} ref={ref} {...props}>
      {children}
    </div>
  )
)

Card.displayName = 'Card'

export type CardHeaderProps = HTMLAttributes<HTMLDivElement>
export type CardContentProps = HTMLAttributes<HTMLDivElement>
export type CardFooterProps = HTMLAttributes<HTMLDivElement>
export type CardTitleProps = HTMLAttributes<HTMLHeadingElement>
export type CardDescriptionProps = HTMLAttributes<HTMLParagraphElement>

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(({ className, ...props }, ref) => (
  <div className={cx('vds-card__header grid min-w-0 gap-[var(--vds-space-1)] [margin-block-end:var(--vds-space-3)]', className)} ref={ref} {...props} />
))

CardHeader.displayName = 'CardHeader'

export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(({ className, ...props }, ref) => (
  <div className={cx('vds-card__content min-w-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]', className)} ref={ref} {...props} />
))

CardContent.displayName = 'CardContent'

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(({ className, ...props }, ref) => (
  <div className={cx('vds-card__footer flex min-w-0 flex-wrap items-center justify-end gap-[var(--vds-space-2)] [margin-block-start:var(--vds-space-4)]', className)} ref={ref} {...props} />
))

CardFooter.displayName = 'CardFooter'

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, ...props }, ref) => (
    <h3 className={cx('vds-card__title m-0 min-w-0 text-[length:var(--vds-font-subhead)] font-medium leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]', className)} ref={ref} {...props} />
  )
)

CardTitle.displayName = 'CardTitle'

export const CardDescription = forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  ({ className, ...props }, ref) => (
    <p className={cx('vds-card__description m-0 min-w-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]', className)} ref={ref} {...props} />
  )
)

CardDescription.displayName = 'CardDescription'
