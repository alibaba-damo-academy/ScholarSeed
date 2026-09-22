import type { ReactNode } from 'react'

import { Button } from '../ui'
import { Icon } from '../../icons'
import { useApp } from '../../store'

export function PromptSettingsGuide({
  className,
  linkLabel,
  linkPrefix,
  prefix,
  suffix
}: {
  className?: string
  linkLabel: string
  linkPrefix?: ReactNode
  prefix: ReactNode
  suffix?: ReactNode
}): React.JSX.Element {
  const { act } = useApp()

  return (
    <div className={`flex flex-wrap items-center gap-x-1 text-xs leading-5 text-[var(--vds-text-tertiary)]${className ? ` ${className}` : ''}`}>
      <span className="whitespace-nowrap">{prefix}</span>
      <span className="inline-flex whitespace-nowrap items-center gap-x-1">
        {linkPrefix ? <span>{linkPrefix}</span> : null}
        <Button
          aria-label={linkLabel}
          className="gap-1 text-xs leading-5"
          size="content"
          variant="link"
          onClick={() => act.openSettings('prompts')}
        >
          {linkLabel}
          <Icon name="external" size={12} />
        </Button>
        {suffix ? <span>{suffix}</span> : null}
      </span>
    </div>
  )
}
