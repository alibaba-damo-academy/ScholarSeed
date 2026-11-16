import type { JSX } from 'react'
import { Divider } from '../../components/ui'

export function SessionDropIndicator({
  nested = false,
  after = false,
  label,
}: {
  nested?: boolean
  after?: boolean
  label?: string
}): JSX.Element {
  return (
    <div
      aria-hidden={label ? undefined : true}
      className={`pointer-events-none absolute right-0 z-[var(--vds-z-local-control)] h-0 ${nested ? 'left-[calc(var(--vds-space-10)+var(--vds-space-2))]' : 'left-0'} ${after ? 'bottom-0' : 'top-0'}`}
    >
      <Divider
        aria-hidden="true"
        className="[--vds-divider-color:var(--vds-border-brand)] [--vds-divider-margin-horizontal:0]"
      />
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 size-[var(--vds-space-1)] -translate-y-1/2 rounded-full bg-[var(--vds-border-brand)]"
      />
      {label && (
        <span
          role="status"
          className="absolute bottom-[var(--vds-space-half)] right-0 max-w-full rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-2)] py-[var(--vds-space-half)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-1-center)]"
        >
          {label}
        </span>
      )}
    </div>
  )
}
