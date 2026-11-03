import React from 'react'
import { CircleX, Clock3, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionNode } from '../../model'
import { BadgeDot, Tooltip, cx } from '../ui'

export function TaskPausedIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <Clock3
      aria-hidden="true"
      strokeWidth={1.5}
      className={cx('size-[var(--vds-icon-8)] text-[var(--vds-warning-bg-default)]', className)}
    />
  )
}

export function TaskStatus({
  node,
  unread,
  variant = 'inline',
  className,
  fallback = null,
}: {
  node: SessionNode
  unread: boolean
  variant?: 'inline' | 'badge'
  className?: string
  fallback?: React.JSX.Element | null
}): React.JSX.Element | null {
  const { t } = useTranslation('layout')
  if (node.status === 'abandon') return fallback
  const key =
    node.status === 'running'
      ? 'running'
      : node.status === 'waiting'
        ? 'waiting'
        : node.status === 'failed'
          ? 'failed'
          : 'completed'
  if (key === 'completed' && !unread) return fallback
  const label =
    key === 'completed' ? `${t(key)} · ${t(unread ? 'taskUnread' : 'taskViewed')}` : t(key)
  return (
    <Tooltip content={label} portalled>
      <span
        aria-label={label}
        className={cx(
          'inline-flex size-[var(--vds-icon-8)] shrink-0 items-center justify-center',
          variant === 'badge'
            ? 'rounded-[var(--vds-radius-circle)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] [&>svg]:size-[var(--vds-icon-6)]'
            : '[&>svg]:size-[var(--vds-icon-8)]',
          className
        )}
      >
        {node.status === 'running' ? (
          <LoaderCircle className="animate-spin text-[var(--vds-text-tertiary)]" />
        ) : node.status === 'waiting' ? (
          <TaskPausedIcon />
        ) : node.status === 'failed' ? (
          <CircleX className="text-[var(--vds-error-bg-default)]" />
        ) : (
          <BadgeDot tone="neutral" className="text-[var(--vds-success-bg-default)]" />
        )}
      </span>
    </Tooltip>
  )
}
