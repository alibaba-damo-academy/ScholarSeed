import { useTranslation } from 'react-i18next'
import type { AnchorHTMLAttributes, HTMLAttributes, LiHTMLAttributes } from 'react'
import { forwardRef } from 'react'

import {
  breadcrumbClassName,
  breadcrumbEllipsisClassName,
  breadcrumbItemClassName,
  breadcrumbLinkClassName,
  breadcrumbListClassName,
  breadcrumbPageClassName,
  breadcrumbSeparatorClassName,
  breadcrumbStyleClassName
} from './classes'
import { cx, cxWithOverrides } from './utils'

export interface BreadcrumbProps extends HTMLAttributes<HTMLElement> {
  label?: string
}

export type BreadcrumbListProps = HTMLAttributes<HTMLOListElement>
export type BreadcrumbItemProps = LiHTMLAttributes<HTMLLIElement>
export type BreadcrumbLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>
export type BreadcrumbPageProps = HTMLAttributes<HTMLSpanElement>
export type BreadcrumbSeparatorProps = HTMLAttributes<HTMLSpanElement>
export interface BreadcrumbEllipsisProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string
}

export const Breadcrumb = forwardRef<HTMLElement, BreadcrumbProps>(
  ({ className, label, ...props }, ref) => {
    const { t } = useTranslation('ui')
    return (
    <nav aria-label={label ?? t('breadcrumb.label')} className={cx(breadcrumbClassName({ className }), breadcrumbStyleClassName())} ref={ref} {...props} />
    )
  }
)

Breadcrumb.displayName = 'Breadcrumb'

export const BreadcrumbList = forwardRef<HTMLOListElement, BreadcrumbListProps>(
  ({ className, ...props }, ref) => (
    <ol className={cxWithOverrides(breadcrumbListClassName, className)} ref={ref} {...props} />
  )
)

BreadcrumbList.displayName = 'BreadcrumbList'

export const BreadcrumbItem = forwardRef<HTMLLIElement, BreadcrumbItemProps>(
  ({ className, ...props }, ref) => (
    <li className={cx(breadcrumbItemClassName, className)} ref={ref} {...props} />
  )
)

BreadcrumbItem.displayName = 'BreadcrumbItem'

export const BreadcrumbLink = forwardRef<HTMLAnchorElement, BreadcrumbLinkProps>(
  ({ className, ...props }, ref) => (
    <a className={cx(breadcrumbLinkClassName, className)} ref={ref} {...props} />
  )
)

BreadcrumbLink.displayName = 'BreadcrumbLink'

export const BreadcrumbPage = forwardRef<HTMLSpanElement, BreadcrumbPageProps>(
  ({ className, ...props }, ref) => (
    <span aria-current="page" className={cx(breadcrumbPageClassName, className)} ref={ref} {...props} />
  )
)

BreadcrumbPage.displayName = 'BreadcrumbPage'

export const BreadcrumbSeparator = forwardRef<HTMLSpanElement, BreadcrumbSeparatorProps>(
  ({ children = '/', className, ...props }, ref) => (
    <span aria-hidden="true" className={cx(breadcrumbSeparatorClassName, className)} ref={ref} {...props}>
      {children}
    </span>
  )
)

BreadcrumbSeparator.displayName = 'BreadcrumbSeparator'

export const BreadcrumbEllipsis = forwardRef<HTMLSpanElement, BreadcrumbEllipsisProps>(
  ({ className, label, ...props }, ref) => {
    const { t } = useTranslation('ui')
    return (
    <span
      aria-label={label ?? t('breadcrumb.more')}
      className={cx(breadcrumbEllipsisClassName, className)}
      ref={ref}
      role="img"
      {...props}
    >
      ...
    </span>
    )
  }
)

BreadcrumbEllipsis.displayName = 'BreadcrumbEllipsis'
