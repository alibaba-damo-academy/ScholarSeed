import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Info, RotateCw } from 'lucide-react'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  IconButton,
  PageSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  Tooltip,
} from '../../components/ui'
import { SettingsField, SettingsGroup, SettingsPage } from '../../components/business/Settings'
import { useApp } from '../../store'
import { defaultSelectionPrompts, MAX_SELECTION_PROMPT_CHARS } from '../../../../prompts'
import { PUBLIC_SERVICE_FIELDS, TRANSLATION_LANGUAGES, TRANSLATION_SERVICES } from './model'
import { useTranslationBackend } from './context'
import { EnginePicker } from './Controls'
import { useTranslationText } from './text'
import { translationError } from './live'
import { useTranslationNotice } from './Notice'
import { TranslationPreferenceStatus } from './Preferences'

function ServiceConfiguration({
  service,
}: {
  service: (typeof TRANSLATION_SERVICES)[number]
}): React.JSX.Element {
  const text = useTranslationText()
  const notice = useTranslationNotice()
  const { backend, settings } = useTranslationBackend()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const section = useRef<HTMLDivElement>(null)
  const status = settings?.services[service.id] ?? 'unconfigured'
  const busy = status === 'pending'
  const fields = { ...settings?.configuration[service.id], ...draft }
  useEffect(() => {
    if (settings?.focusService !== service.id) return
    setOpen(true)
    section.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    backend?.update({ focusService: null })
  }, [settings?.focusService, service.id])
  const save = async (): Promise<void> => {
    if (!backend || busy) return
    if (service.fields.some((field) => !fields[field]?.trim())) {
      setError(text('required'))
      return
    }
    setError('')
    try {
      if (!(await backend.verify(service.id, fields, () => notice('recovered'))))
        setError(text('verificationFailed'))
      else if (backend.live) setDraft({})
    } catch (cause) {
      if (translationError(cause) === 'rate_limited') notice('rate_limited')
      setError(backend.live ? text(`errors.${translationError(cause)}`) : text('saveFailed'))
    }
  }
  return (
    <div ref={section} data-testid={`translation-service-${service.id}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="h-auto! w-full !justify-between !rounded-none p-[var(--vds-space-4)] !text-left"
              aria-label={text(`services.${service.id}`)}
            >
              <span className="font-[var(--vds-fw-regular)]">{text(`services.${service.id}`)}</span>
              <span className="inline-flex items-center gap-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
                <span
                  className={
                    status === 'configured' ? 'text-[var(--vds-brand-text-primary)]' : undefined
                  }
                >
                  {text(`serviceStatus.${status}`)}
                </span>
                {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="m-[var(--vds-space-3)] !bg-[var(--vds-bg-gray-light-default)] !p-0">
            <div className="grid gap-[var(--vds-space-3)] p-[var(--vds-space-3)]">
              {service.fields.map((field) => (
                <Input
                  key={field}
                  label={text(`fields.${field}`)}
                  aria-label={`${text(`services.${service.id}`)} ${text(`fields.${field}`)}`}
                  type={PUBLIC_SERVICE_FIELDS.includes(field) ? 'text' : 'password'}
                  autoComplete="off"
                  size="standard"
                  value={fields[field] ?? ''}
                  disabled={busy}
                  onChange={(event) => {
                    setDraft((previous) => ({
                      ...settings?.configuration[service.id],
                      ...previous,
                      [field]: event.target.value,
                    }))
                    setError('')
                    backend?.invalidate(service.id)
                  }}
                />
              ))}
              <div className="flex flex-wrap items-center gap-[var(--vds-space-3)]">
                <Button
                  data-testid={`translation-save-${service.id}`}
                  disabled={!backend || busy}
                  loading={busy}
                  onClick={() => void save()}
                >
                  {text('save')}
                </Button>
                <span role="status" className="text-[var(--vds-text-secondary)]">
                  {error ||
                    (status === 'configured'
                      ? text(backend?.live ? 'verified' : 'verificationSuccess')
                      : '')}
                </span>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}

function OfflineLanguages(): React.JSX.Element {
  const text = useTranslationText()
  const { backend, settings } = useTranslationBackend()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(settings?.focusService === 'offline')
  useEffect(() => {
    if (settings?.focusService !== 'offline') return
    setOpen(true)
    backend?.update({ focusService: null })
  }, [settings?.focusService])
  const packages = settings?.packages ?? {}
  const installed = TRANSLATION_LANGUAGES.filter(
    (language) => packages[language] === 'installed'
  ).length
  const languages = TRANSLATION_LANGUAGES.filter((language) => {
    const matches = `${text(`languages.${language}`)} ${language}`
      .toLowerCase()
      .includes(query.toLowerCase().trim())
    return (
      matches &&
      (filter === 'all' || (packages[language] === 'installed') === (filter === 'installed'))
    )
  })
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div>
        <div className="flex items-center gap-[var(--vds-space-2)] p-[var(--vds-space-4)]">
          <Tooltip portalled content={text('offlineHelp')}>
            <span tabIndex={0} aria-label={text('offlineHelp')}>
              <Info aria-hidden="true" />
            </span>
          </Tooltip>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="h-auto! min-w-0 flex-1 !justify-between"
              aria-label={text('services.offline')}
            >
              <span className="font-[var(--vds-fw-regular)]">{text('services.offline')}</span>
              <span className="inline-flex items-center gap-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
                {text('builtIn')}
                {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="grid gap-[var(--vds-space-3)] border-t border-[var(--vds-border-default)] p-[var(--vds-space-4)]">
            <div className="flex flex-wrap gap-[var(--vds-space-2)]">
              <Input
                className="min-w-0 flex-1"
                aria-label={text('searchLanguage')}
                placeholder={text('searchLanguage')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger aria-label={text('filterLanguages')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['all', 'installed', 'missing'].map((value) => (
                    <SelectItem key={value} value={value}>
                      {text(`filter.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-[var(--vds-text-secondary)]">
              {text('installedCount')} {installed} / {TRANSLATION_LANGUAGES.length}
            </span>
            <div
              className="max-h-[var(--vds-layout-pdf-panel-width)] overflow-y-auto rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] px-[var(--vds-space-3)]"
              data-testid="translation-language-list"
            >
              {languages.map((language) => (
                <div
                  key={language}
                  className="flex items-center justify-between gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] py-[var(--vds-space-3)]"
                >
                  <span>{text(`languages.${language}`)}</span>
                  {packages[language] === 'installed' ? (
                    <span className="text-[var(--vds-brand-text-primary)]">
                      {text('packageStatus.installed')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!backend || packages[language] === 'installing'}
                      loading={packages[language] === 'installing'}
                      onClick={() => {
                        setError('')
                        void backend?.install(language).catch(() => setError(text('saveFailed')))
                      }}
                    >
                      {text(`packageStatus.${packages[language] ?? 'missing'}`)}
                    </Button>
                  )}
                </div>
              ))}
              {!languages.length && <p>{text('noLanguages')}</p>}
            </div>
            <p role="status" className="m-0 text-[var(--vds-text-secondary)]">
              {error || text('offlineDemo')}
            </p>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function TranslationSettings(): React.JSX.Element {
  const text = useTranslationText()
  const { state, act } = useApp()
  const defaults = defaultSelectionPrompts(state.lang)
  const { backend, settings } = useTranslationBackend()
  const [prompt, setPrompt] = useState(state.selectionPrompts.translate)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const prompts = useRef(state.selectionPrompts)
  const sequence = useRef(0)
  prompts.current = state.selectionPrompts
  const savePrompt = (value: string): void => {
    setPrompt(value)
    if (!value.trim()) {
      setError(text('promptRequired'))
      return
    }
    setError('')
    setSaving(true)
    const current = ++sequence.current
    void act
      .saveSelectionPrompts({ ...prompts.current, translate: value })
      .catch(() => {
        if (sequence.current === current) setError(text('saveFailed'))
      })
      .finally(() => {
        if (sequence.current === current) setSaving(false)
      })
  }
  return (
    <SettingsPage
      title={text('title')}
      description={text('description')}
      data-testid="account-settings-translation"
      className="gap-[var(--vds-space-5)] [&>[data-slot=page-body]]:gap-[var(--vds-space-5)]"
    >
      <PageSection title={text('defaultService')}>
        <SettingsGroup>
          {backend && settings && (
            <SettingsField title={text('defaultService')}>
              <EnginePicker
                value={settings.defaultEngine}
                onChange={(defaultEngine) => backend.update({ defaultEngine })}
              />
            </SettingsField>
          )}
          <SettingsField
            title={text('selectionAutomatic')}
            description={text(settings?.toolbar ? 'selectionHelp' : 'enableToolbar')}
          >
            <Tooltip
              portalled
              content={settings?.toolbar ? text('selectionHelp') : text('enableToolbar')}
            >
              <span>
                <Switch
                  data-testid="translation-selection-automatic"
                  label={text('selectionAutomatic')}
                  checked={settings?.selectionAutomatic ?? false}
                  disabled={
                    !backend ||
                    !settings?.toolbar ||
                    settings?.preferencesReady === false ||
                    settings?.preferencesSaving
                  }
                  onCheckedChange={(selectionAutomatic) => backend?.update({ selectionAutomatic })}
                />
              </span>
            </Tooltip>
          </SettingsField>
        </SettingsGroup>
        <TranslationPreferenceStatus />
      </PageSection>
      <PageSection>
        <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
          <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
            {text('prompt')}
          </span>
          <Tooltip portalled={false} content={text('restore')}>
            <span className="inline-flex">
              <IconButton
                size="sm"
                variant="ghost"
                icon={<RotateCw />}
                title={undefined}
                label={text('restore')}
                disabled={prompt === defaults.translate}
                onClick={() => savePrompt(defaults.translate)}
              />
            </span>
          </Tooltip>
        </div>
        <div className="relative">
          <Textarea
            rows={5}
            aria-label={text('prompt')}
            value={prompt}
            maxLength={MAX_SELECTION_PROMPT_CHARS}
            onChange={(event) => savePrompt(event.target.value)}
            data-testid="translation-prompt"
            className="h-[var(--vds-settings-prompt-height)] rounded-[var(--vds-settings-prompt-radius)] pb-[var(--vds-space-7)] font-[var(--vds-fw-regular)]"
          />
          <span className="pointer-events-none absolute bottom-[var(--vds-space-2)] right-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-placeholder)]">
            {prompt.length} / {MAX_SELECTION_PROMPT_CHARS}
          </span>
        </div>
        <div className="flex justify-between gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
          <span role="status">
            {error ||
              (saving
                ? text('saving')
                : prompt === state.selectionPrompts.translate
                  ? text('saved')
                  : text('autoSave'))}
          </span>
        </div>
      </PageSection>
      <PageSection title={text('servicesTitle')} description={text('servicesHelp')}>
        {settings?.loadError && <p role="alert">{text(`errors.${settings.loadError}`)}</p>}
        {!backend ? (
          <p role="status">{text('unavailable')}</p>
        ) : (
          <>
            <p className="m-0 text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
              {text(backend.live ? 'credentialsHelp' : 'demo')}
            </p>
            <SettingsGroup>
              {!backend.live && <OfflineLanguages />}
              {TRANSLATION_SERVICES.filter((service) => service.id !== 'offline').map((service) => (
                <ServiceConfiguration key={service.id} service={service} />
              ))}
            </SettingsGroup>
          </>
        )}
      </PageSection>
    </SettingsPage>
  )
}
