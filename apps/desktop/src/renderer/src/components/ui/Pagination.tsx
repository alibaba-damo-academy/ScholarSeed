import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import { forwardRef } from 'react'

import {
  getPaginationItems,
  paginationClassName,
  paginationEllipsisClassName,
  paginationItemActiveClassName,
  paginationItemClassName,
  paginationStyleClassName
} from './classes'
import { cx } from './utils'

export interface PaginationProps extends HTMLAttributes<HTMLElement> {
  page: number
  pageCount: number
  fullPageLimit?: number
  onPageChange: (page: number) => void
  disabled?: boolean
  ariaLabel?: string
}

function PaginationButton({
  active = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }): JSX.Element {
  return (
    <button
      className={cx(paginationItemClassName, active && paginationItemActiveClassName, className)}
      type="button"
      {...props}
    />
  )
}

export const Pagination = forwardRef<HTMLElement, PaginationProps>(function Pagination(
  {
    ariaLabel,
    className,
    disabled = false,
    onPageChange,
    page,
    pageCount,
    fullPageLimit,
    ...props
  },
  ref
): JSX.Element {
  const { t } = useTranslation('ui')
  const safePageCount = Math.max(pageCount, 1)
  const currentPage = Math.min(Math.max(page, 1), safePageCount)
  const canGoPrevious = currentPage > 1 && !disabled
  const canGoNext = currentPage < safePageCount && !disabled

  function requestPage(nextPage: number): void {
    if (disabled || nextPage === currentPage || nextPage < 1 || nextPage > safePageCount) {
      return
    }
    onPageChange(nextPage)
  }

  return (
    <nav aria-label={ariaLabel ?? t('pagination.label')} className={cx(paginationClassName({ className }), paginationStyleClassName())} ref={ref} {...props}>
      <PaginationButton
        aria-label={t('pagination.previous')}
        disabled={!canGoPrevious}
        onClick={() => requestPage(currentPage - 1)}
      >
        ‹
      </PaginationButton>
      {getPaginationItems(currentPage, safePageCount, fullPageLimit).map((item) =>
        typeof item === 'number' ? (
          <PaginationButton
            active={item === currentPage}
            aria-current={item === currentPage ? 'page' : undefined}
            aria-label={t('pagination.page', { page: item })}
            disabled={disabled}
            key={item}
            onClick={() => requestPage(item)}
          >
            {item}
          </PaginationButton>
        ) : (
          <span aria-hidden="true" className={paginationEllipsisClassName} key={item}>
            …
          </span>
        )
      )}
      <PaginationButton
        aria-label={t('pagination.next')}
        disabled={!canGoNext}
        onClick={() => requestPage(currentPage + 1)}
      >
        ›
      </PaginationButton>
    </nav>
  )
})

Pagination.displayName = 'Pagination'
