import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmationCard } from '../primitive/Confirmation'
import { LiteratureAuthorizationCard } from '../../features/literature/Scope'
import { Button } from '../ui'

const CONFIRMATION_VARIANTS = [
  { value: 'selection', labelKey: 'confirmation.selection' },
  { value: 'normal', labelKey: 'confirmation.normal' },
  { value: 'high', labelKey: 'confirmation.high' },
  { value: 'custom', labelKey: 'confirmation.custom' },
] as const
type ConfirmationVariant = (typeof CONFIRMATION_VARIANTS)[number]['value']
const SAMPLE_PAPERS = ['paper-a', 'paper-b', 'paper-c'] as const
const SAMPLE_PATH = '~/Documents/组会材料/研究简报.md'

export function ConfirmationExample(): JSX.Element {
  const { t } = useTranslation('examples')
  const [variant, setVariant] = useState<ConfirmationVariant>('selection')
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string[]>([...SAMPLE_PAPERS])
  const reset = (): void => {
    setOpen(true)
    setExpanded(false)
    setSelected([...SAMPLE_PAPERS])
  }
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-4)]">
      <div
        className="flex flex-wrap items-center gap-[var(--vds-space-2)]"
        role="group"
        aria-label={t('confirmation.variants')}
      >
        {CONFIRMATION_VARIANTS.map(({ value, labelKey }) => (
          <Button
            key={value}
            size="sm"
            variant={variant === value ? 'primary' : 'outline'}
            aria-pressed={variant === value}
            onClick={() => {
              setVariant(value)
              reset()
            }}
          >
            {t(labelKey)}
          </Button>
        ))}
        <Button className="ml-auto w-fit shrink-0" size="sm" variant="outline" onClick={reset}>
          {t('authorization.reset')}
        </Button>
      </div>
      <p className="m-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
        {t('confirmation.description')}
      </p>
      <div className="grid min-w-0 rounded-[var(--vds-radius-4)] border border-[var(--vds-divider-default)] bg-[var(--vds-bg-page)] p-[var(--vds-space-4)]">
        {open && variant === 'selection' && (
          <LiteratureAuthorizationCard
            selectable
            papers={SAMPLE_PAPERS.map((id, index) => ({
              id,
              label: t('confirmation.paper', { index: index + 1 }),
            }))}
            selectedPaperIds={selected}
            expanded={expanded}
            onExpandedChange={setExpanded}
            onSelectionChange={setSelected}
            onAllow={() => setOpen(false)}
            onDeny={() => setOpen(false)}
          />
        )}
        {variant !== 'selection' && (
          <ConfirmationCard
            compact={variant === 'custom'}
            title={t(variant === 'custom' ? 'confirmation.fileTitle' : 'authorization.title')}
            description={
              variant === 'custom'
                ? t('confirmation.fileDescription')
                : t('authorization.command', { command: 'echo preview' })
            }
            risk={variant === 'normal' ? 'normal' : 'high'}
            open={open}
            allowLabel={t(variant === 'custom' ? 'confirmation.fileAllow' : 'authorization.allow')}
            denyLabel={t('authorization.deny')}
            details={
              variant === 'custom'
                ? [
                    {
                      id: 'path',
                      label: t('confirmation.path'),
                      value: SAMPLE_PATH,
                      highlighted: true,
                    },
                    {
                      id: 'operation',
                      label: t('confirmation.operation'),
                      value: t('confirmation.write'),
                    },
                    {
                      id: 'scope',
                      label: t('confirmation.scope'),
                      value: t('confirmation.currentScope'),
                    },
                  ]
                : undefined
            }
            onAllow={() => setOpen(false)}
            onDeny={() => setOpen(false)}
          />
        )}
        {!open && (
          <p
            role="status"
            className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
          >
            {t('confirmation.finished')}
          </p>
        )}
      </div>
    </div>
  )
}
