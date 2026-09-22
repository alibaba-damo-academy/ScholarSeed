import React from 'react'

import brandMark from '../../assets/scholarseed-logo-mark.png'
import { Button } from '../ui'

export type ProgressSurface = 'screen' | 'workspace' | 'conversation'

const PROGRESS_BASE_CLASS_NAME = [
  'progress-transition relative isolate grid flex-auto min-w-0 min-h-0 place-items-center overflow-hidden p-8',
  'bg-[radial-gradient(circle_at_50%_42%,color-mix(in_oklch,var(--accent-soft)_62%,transparent)_0,transparent_34%),linear-gradient(145deg,color-mix(in_oklch,var(--paper)_96%,var(--bg-2)),var(--paper))]',
  'animate-[progress-surface-in_240ms_ease-out_both]',
  'motion-reduce:animate-none'
].join(' ')
const PROGRESS_SURFACE_CLASS_NAMES: Record<ProgressSurface, string> = {
  screen: [
    'absolute inset-0 z-[300] animate-none',
    'before:absolute before:-z-[1] before:right-[-8%] before:top-[-24%] before:size-[min(38vw,520px)]',
    'before:rounded-full before:border before:border-[color-mix(in_oklch,var(--accent)_15%,transparent)] before:content-[""]',
    'after:absolute after:-z-[1] after:bottom-[-28%] after:left-[-10%] after:size-[min(38vw,520px)]',
    'after:rounded-full after:border after:border-[color-mix(in_oklch,var(--accent)_15%,transparent)] after:content-[""]'
  ].join(' '),
  workspace: 'pt-[max(46px,8vh)]',
  conversation: 'bg-[var(--paper)]'
}
const PROGRESS_CARD_BASE_CLASS_NAME = [
  'progress-transition-card flex w-[min(440px,84vw)] flex-col items-center rounded-[20px]',
  'border border-[color-mix(in_oklch,var(--border-soft)_86%,var(--accent))] px-[34px] pb-7 pt-[30px]',
  'bg-[color-mix(in_oklch,var(--bg-2)_92%,transparent)] shadow-[0_24px_64px_rgb(35_53_44_/_0.08),inset_0_1px_0_rgb(255_255_255_/_0.46)]',
  'backdrop-saturate-[1.04] animate-[progress-card-in_360ms_cubic-bezier(0.2,0.8,0.2,1)_both]',
  'motion-reduce:animate-none'
].join(' ')
const PROGRESS_CARD_SURFACE_CLASS_NAMES: Partial<Record<ProgressSurface, string>> = {
  conversation: 'w-[min(390px,82%)] border-transparent bg-transparent shadow-none backdrop-saturate-100'
}
const PROGRESS_ORBIT_CLASS_NAME = 'progress-transition-orbit relative mb-[19px] size-[68px] flex-none'
const PROGRESS_RING_CLASS_NAME = [
  'progress-transition-ring absolute inset-0.5 rounded-full border border-[color-mix(in_oklch,var(--brand-ink)_22%,transparent)]',
  'border-t-[color-mix(in_oklch,var(--brand-ink)_82%,var(--accent))]',
  'border-r-[color-mix(in_oklch,var(--brand-spark)_82%,var(--accent))]',
  'animate-[progress-orbit_1.75s_cubic-bezier(0.58,0.1,0.42,0.9)_infinite]',
  'motion-reduce:animate-none'
].join(' ')
const PROGRESS_ERROR_RING_CLASS_NAME = 'animate-none border-[color-mix(in_oklch,var(--c-tension)_66%,var(--border))]'
const PROGRESS_CORE_CLASS_NAME = [
  'progress-transition-core absolute inset-3 grid place-items-center overflow-hidden rounded-[14px]',
  'border border-[color-mix(in_oklch,var(--accent)_22%,var(--border-soft))] bg-[var(--bg-2)]',
  'shadow-[0_7px_18px_rgb(34_69_58_/_0.12)] animate-[progress-core-breathe_2.2s_ease-in-out_infinite]',
  'motion-reduce:animate-none'
].join(' ')
const PROGRESS_SPARK_CLASS_NAME = [
  'progress-transition-spark absolute left-[calc(50%_-_3.5px)] top-[3px] size-[7px] rounded-full border-2 border-[var(--paper)]',
  'bg-[var(--brand-spark)] shadow-[0_0_12px_color-mix(in_oklch,var(--brand-spark)_74%,transparent)]',
  '[transform-origin:50%_31px] animate-[progress-spark_1.75s_cubic-bezier(0.58,0.1,0.42,0.9)_infinite]',
  'motion-reduce:animate-none'
].join(' ')
const PROGRESS_ERROR_SPARK_CLASS_NAME = 'animate-none bg-[var(--c-tension)]'
const PROGRESS_COPY_CLASS_NAME = 'progress-transition-copy grid justify-items-center gap-[7px] text-center'
const PROGRESS_TITLE_CLASS_NAME = 'font-[var(--serif-display)] text-lg font-bold tracking-[0.015em] text-[var(--text)]'
const PROGRESS_DETAIL_CLASS_NAME = 'text-[11.5px] leading-[1.6] text-[var(--text-3)]'
const PROGRESS_TRACK_CLASS_NAME = 'progress-transition-track relative mt-5 h-0.5 w-[min(224px,72%)] overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--brand-ink)_10%,var(--border-soft))]'
const PROGRESS_TRACK_VALUE_CLASS_NAME = [
  'absolute inset-y-0 left-[-45%] w-[45%] rounded-[inherit]',
  'bg-[linear-gradient(90deg,transparent,var(--brand-ink)_58%,var(--brand-spark))]',
  'animate-[progress-track_1.35s_cubic-bezier(0.42,0,0.34,1)_infinite]',
  'motion-reduce:animate-none'
].join(' ')
const PROGRESS_SKELETON_CLASS_NAME = [
  'progress-transition-skeleton mt-[22px] grid w-[min(300px,100%)] gap-[9px]',
  '[&>span]:relative [&>span]:block [&>span]:h-2 [&>span]:overflow-hidden [&>span]:rounded-full',
  '[&>span]:bg-[color-mix(in_oklch,var(--bg-3)_78%,var(--border-soft))]',
  '[&>span:nth-child(2)]:w-[78%] [&>span:nth-child(3)]:w-[54%]',
  '[&>span::after]:absolute [&>span::after]:inset-0',
  '[&>span::after]:bg-[linear-gradient(100deg,transparent_20%,color-mix(in_oklch,var(--paper)_72%,transparent)_50%,transparent_80%)]',
  '[&>span::after]:content-[""] [&>span::after]:[transform:translateX(-100%)]',
  '[&>span::after]:animate-[progress-shimmer_1.65s_ease-in-out_infinite]',
  'motion-reduce:[&>span::after]:animate-none'
].join(' ')
const PROGRESS_ACTION_CLASS_NAME = 'progress-transition-action mt-[21px] min-w-[108px]'
const INLINE_PROGRESS_CLASS_NAME = [
  'inline-progress size-[15px] rounded-full border-[1.7px] border-[rgb(255_255_255_/_0.34)] border-t-white',
  'animate-[progress-orbit_720ms_linear_infinite] motion-reduce:animate-none'
].join(' ')

export function Progress({
  title,
  detail,
  surface = 'conversation',
  error = false,
  actionLabel,
  onAction
}: {
  title: string
  detail: string
  surface?: ProgressSurface
  error?: boolean
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div
      className={`${PROGRESS_BASE_CLASS_NAME} ${PROGRESS_SURFACE_CLASS_NAMES[surface]} is-${surface}${error ? ' is-error' : ''}`}
      data-testid={`progress-${surface}`}
      role="status"
      aria-live="polite"
      aria-busy={!error}
    >
      <div className={`${PROGRESS_CARD_BASE_CLASS_NAME} ${PROGRESS_CARD_SURFACE_CLASS_NAMES[surface] ?? ''}`}>
        <div className={PROGRESS_ORBIT_CLASS_NAME} aria-hidden>
          <span className={`${PROGRESS_RING_CLASS_NAME} ${error ? PROGRESS_ERROR_RING_CLASS_NAME : ''}`} />
          <span className={PROGRESS_CORE_CLASS_NAME}><img className="block size-full object-cover" src={brandMark} alt="" /></span>
          <span className={`${PROGRESS_SPARK_CLASS_NAME} ${error ? PROGRESS_ERROR_SPARK_CLASS_NAME : ''}`} />
        </div>
        <div className={PROGRESS_COPY_CLASS_NAME}>
          <strong className={PROGRESS_TITLE_CLASS_NAME}>{title}</strong>
          <span className={PROGRESS_DETAIL_CLASS_NAME}>{detail}</span>
        </div>
        {!error && (
          <>
            <div className={PROGRESS_TRACK_CLASS_NAME} aria-hidden><span className={PROGRESS_TRACK_VALUE_CLASS_NAME} /></div>
            <div className={PROGRESS_SKELETON_CLASS_NAME} aria-hidden>
              <span />
              <span />
              <span />
            </div>
          </>
        )}
        {error && actionLabel && onAction && (
          <Button className={PROGRESS_ACTION_CLASS_NAME} onClick={onAction} size="sm">
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

export function InlineProgress(): React.JSX.Element {
  return <span className={INLINE_PROGRESS_CLASS_NAME} aria-hidden />
}
