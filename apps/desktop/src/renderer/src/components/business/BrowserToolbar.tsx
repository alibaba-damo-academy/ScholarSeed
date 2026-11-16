import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react'
import { IconButton } from '../ui'

export function BrowserToolbar({
  children,
  onSubmit,
  back,
  forward,
  reload,
  stopLoading,
  backDisabled = true,
  forwardDisabled = true,
  reloadDisabled = false,
}: {
  children: ReactNode
  onSubmit?: () => void
  back?: () => void
  forward?: () => void
  reload: () => void
  stopLoading?: () => void
  backDisabled?: boolean
  forwardDisabled?: boolean
  reloadDisabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('browser')
  return (
    <form
      aria-label={t('navigation')}
      className="flex shrink-0 items-center gap-[var(--vds-space-1)] px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[var(--vds-icon-outline-default)] [&_button]:!text-inherit [&_button:disabled]:!text-[var(--vds-text-disabled)]"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit?.()
      }}
    >
      <IconButton
        label={t('back')}
        variant="ghost"
        icon={<ArrowLeft />}
        disabled={backDisabled}
        onClick={back}
      />
      <IconButton
        label={t('forward')}
        variant="ghost"
        icon={<ArrowRight />}
        disabled={forwardDisabled}
        onClick={forward}
      />
      <IconButton
        label={stopLoading ? t('stopLoading') : t('reload')}
        variant="ghost"
        icon={stopLoading ? <X /> : <RotateCw />}
        disabled={!stopLoading && reloadDisabled}
        onClick={stopLoading ?? reload}
      />
      {children}
    </form>
  )
}
