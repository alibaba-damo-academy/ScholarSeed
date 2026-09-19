import { useTranslation } from 'react-i18next'
import { type ButtonHTMLAttributes, type HTMLAttributes } from 'react'

import { cx } from './utils'

const CALENDAR_DAYS = Array.from({ length: 31 }, (_, index) => index + 1)
const CALENDAR_CLASS_NAME =
  'vds-calendar grid w-[280px] gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]'
const CALENDAR_CAPTION_CLASS_NAME = 'vds-calendar__caption text-center [font-weight:var(--vds-fw-medium)]'
const CALENDAR_GRID_CLASS_NAME = 'vds-calendar__grid grid grid-cols-7 gap-[var(--vds-space-1)]'
const CALENDAR_DAY_CLASS_NAME =
  'vds-calendar__day aspect-square rounded-[var(--vds-radius-3)] border-0 [background:transparent] text-[var(--vds-text-primary)] cursor-pointer hover:bg-[var(--vds-brand-6)] hover:text-[var(--vds-static-white)] aria-pressed:bg-[var(--vds-brand-6)] aria-pressed:text-[var(--vds-static-white)]'
const CALENDAR_SELECTED_DAY_CLASS_NAME = 'vds-calendar__day--selected'

export interface CalendarProps extends HTMLAttributes<HTMLDivElement> {
  onSelectDay?: (day: number) => void
  selectedDay?: number
}

export function Calendar({ className, onSelectDay, selectedDay = 0, ...props }: CalendarProps): JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <div className={cx(CALENDAR_CLASS_NAME, className)} {...props}>
      <div className={CALENDAR_CAPTION_CLASS_NAME}>{t('calendar.caption')}</div>
      <div className={CALENDAR_GRID_CLASS_NAME}>
        {CALENDAR_DAYS.map((day) => (
          <button
            aria-pressed={selectedDay === day}
            className={cx(CALENDAR_DAY_CLASS_NAME, selectedDay === day && CALENDAR_SELECTED_DAY_CLASS_NAME)}
            key={day}
            onClick={() => onSelectDay?.(day)}
            type="button"
          >
            {day}
          </button>
        ))}
      </div>
    </div>
  )
}

export type CalendarDayButtonProps = ButtonHTMLAttributes<HTMLButtonElement>
export const CalendarDayButton = (props: CalendarDayButtonProps): JSX.Element => <button type="button" {...props} />
