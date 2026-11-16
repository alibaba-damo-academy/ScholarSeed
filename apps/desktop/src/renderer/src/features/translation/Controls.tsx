import React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, ArrowUpRight, RefreshCw } from 'lucide-react'
import {
  BadgeDot,
  IconButton,
  EllipsisText,
  Tooltip,
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../components/ui'
import { useApp } from '../../store'
import { useTranslationBackend } from './context'
import {
  AI_ENGINE_PREFIX,
  TRANSLATION_SERVICES,
  engineAvailable,
  supportedLanguages,
  type TranslationChoice,
} from './model'
import { useTranslationText } from './text'

const MODEL_SETTINGS_OPTION = 'model-settings'
const TRANSLATION_SETTINGS_OPTION = 'translation-settings'
const documentSelectWidth = '!w-[var(--vds-layout-pdf-translation-select-width)]'

export function EnginePicker({
  value,
  onChange,
  disabled = false,
  compact = false,
  documentSettings = false,
}: {
  value: string
  onChange: (engine: string) => void
  disabled?: boolean
  compact?: boolean
  documentSettings?: boolean
}): React.JSX.Element {
  const text = useTranslationText()
  const { state, act } = useApp()
  const { backend, settings } = useTranslationBackend()
  const models = state.catalog.models.filter((item) => !item.disabled)
  const model = models.find((item) => AI_ENGINE_PREFIX + item.key === value)
  const service = TRANSLATION_SERVICES.find((item) => item.id === value)
  const label = value.startsWith(AI_ENGINE_PREFIX)
    ? (model?.label ?? text('ai'))
    : service
      ? text(`services.${service.id}`)
      : text('unavailable')
  return (
    <Select
      size="sm"
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === MODEL_SETTINGS_OPTION) act.openSettings('models')
        else if (next === TRANSLATION_SETTINGS_OPTION) act.openSettings('translation')
        else if (next.startsWith(AI_ENGINE_PREFIX) || (settings && engineAvailable(settings, next)))
          onChange(next)
        else {
          backend?.update({ focusService: next })
          act.openSettings('translation')
        }
      }}
    >
      <SelectTrigger
        aria-label={text('chooseEngine')}
        className={
          compact
            ? '!min-w-0 max-w-[var(--vds-layout-pdf-selection-model-min-width)] flex-1 !gap-[var(--vds-space-1)] !px-[var(--vds-space-2)] disabled:!bg-transparent'
            : `${documentSettings ? documentSelectWidth : '!w-auto'} !min-w-0 !px-[var(--vds-space-2)]`
        }
      >
        <SelectValue>
          <EllipsisText
            tooltipPortalled
            wrapperClassName="min-w-0 flex-1"
            className="min-w-0 truncate"
          >
            {label}
          </EllipsisText>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        minWidth={240}
        className="max-h-[var(--vds-layout-pdf-panel-width)] overflow-y-auto whitespace-nowrap [&_.vds-select__item-label]:truncate"
      >
        <SelectGroup>
          <SelectLabel>{text('ai')}</SelectLabel>
          {models.map((item) => (
            <SelectItem key={item.key} value={AI_ENGINE_PREFIX + item.key}>
              {item.label}
            </SelectItem>
          ))}
          {!models.length && (
            <SelectItem value={MODEL_SETTINGS_OPTION}>{text('modelSettings')}</SelectItem>
          )}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>{text('servicesTitle')}</SelectLabel>
          {TRANSLATION_SERVICES.filter((service) => !backend?.live || service.id !== 'offline').map(
            (service) => {
              const name = text(`services.${service.id}`)
              const needsConfiguration = !settings || !engineAvailable(settings, service.id)
              return (
                <SelectItem
                  key={service.id}
                  value={service.id}
                  aria-label={needsConfiguration ? `${name} (${text('configure')})` : undefined}
                  className={
                    needsConfiguration ? 'group [&_.vds-select__item-indicator]:hidden' : undefined
                  }
                >
                  {name}
                  {needsConfiguration && (
                    <ArrowUpRight
                      aria-hidden="true"
                      className="invisible absolute right-[var(--vds-space-2)] top-1/2 size-[var(--vds-icon-7)] -translate-y-1/2 text-[var(--vds-brand-text-primary)] group-hover:visible group-focus-visible:visible"
                    />
                  )}
                </SelectItem>
              )
            }
          )}
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value={TRANSLATION_SETTINGS_OPTION}>{text('title')}</SelectItem>
      </SelectContent>
    </Select>
  )
}

export function TranslationControls({
  value,
  onChange,
  disabled,
  changed,
  appliedTarget,
  onRefresh,
  trailingActions,
  compact = false,
  group = 'all',
}: {
  value: TranslationChoice
  onChange: (choice: TranslationChoice) => void
  disabled?: boolean
  changed?: boolean
  appliedTarget?: string
  onRefresh?: () => void
  trailingActions?: React.ReactNode
  compact?: boolean
  group?: 'all' | 'engine' | 'languages'
}): React.JSX.Element {
  const text = useTranslationText()
  const { t } = useTranslation('components')
  const { settings } = useTranslationBackend()
  const languages = settings ? supportedLanguages(settings, value.engine) : []
  const languagePicker = (source: boolean): React.JSX.Element => (
    <Select
      size="sm"
      value={source ? value.source : value.target}
      disabled={disabled}
      onValueChange={(language) => onChange({ ...value, [source ? 'source' : 'target']: language })}
    >
      <SelectTrigger
        aria-label={text(source ? 'sourceLanguage' : 'targetLanguage')}
        className={`${source && group === 'languages' ? documentSelectWidth : '!w-auto'} !min-w-0 !px-[var(--vds-space-2)] ${compact ? '!gap-[var(--vds-space-1)] disabled:!bg-transparent' : ''}`}
      >
        <SelectValue>{text(`languages.${source ? value.source : value.target}`)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {source && <SelectItem value="auto">{text('languages.auto')}</SelectItem>}
        {languages.map((language) => (
          <SelectItem key={language} value={language}>
            {text(`languages.${language}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  const refresh =
    group !== 'engine' && onRefresh && !(compact && disabled) ? (
      <span className="relative inline-flex shrink-0">
        <Tooltip portalled content={text(changed ? 'changed' : 'refresh')}>
          <IconButton
            size="sm"
            variant="ghost"
            className={compact ? '[&_svg]:!text-[var(--vds-icon-outline-default)]' : undefined}
            label={text('refresh')}
            icon={<RefreshCw />}
            disabled={disabled}
            onClick={onRefresh}
          />
        </Tooltip>
        {changed && (
          <BadgeDot
            data-testid="translation-refresh-pending"
            aria-hidden="true"
            tone="neutral"
            className="pointer-events-none absolute right-0 top-0 text-[var(--vds-brand-bg-default)]"
          />
        )}
      </span>
    ) : null
  return (
    <div
      className={
        compact
          ? 'flex min-w-0 flex-1 flex-wrap items-center gap-[var(--vds-space-2)]'
          : 'flex min-w-0 flex-wrap items-center gap-[var(--vds-space-1)]'
      }
      data-testid="translation-controls"
    >
      <div className={compact ? 'flex min-w-0 items-center gap-[var(--vds-space-2)]' : 'contents'}>
        {group !== 'languages' && (
          <EnginePicker
            compact={compact}
            documentSettings={group === 'engine'}
            value={value.engine}
            onChange={(engine) => onChange({ ...value, engine })}
            disabled={disabled}
          />
        )}
        {group !== 'engine' && (
          <>
            {languagePicker(true)}
            {!(compact && disabled) && (
              <IconButton
                size="sm"
                variant="ghost"
                className={compact ? '!w-[var(--vds-control-height-xs)]' : undefined}
                label={text('swap')}
                icon={<ArrowLeftRight />}
                disabled={
                  disabled ||
                  value.source === 'auto' ||
                  !languages.includes(value.source) ||
                  !languages.includes(value.target)
                }
                onClick={() => onChange({ ...value, source: value.target, target: value.source })}
              />
            )}
            {languagePicker(false)}
          </>
        )}
      </div>
      {group === 'engine' ? null : compact ? (
        <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-half)]">
          {refresh}
          {trailingActions}
        </div>
      ) : (
        <>
          {refresh}
          {trailingActions}
        </>
      )}
      {group !== 'engine' && changed && (
        <span
          role="status"
          className="min-w-0 basis-full text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-placeholder)]"
        >
          {appliedTarget
            ? t('translation.changedTarget', { language: text(`languages.${appliedTarget}`) })
            : text('changed')}
        </span>
      )}
    </div>
  )
}
