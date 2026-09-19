import React from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, CopyButton, IconButton, Select } from '../../components/ui'
import { writeClipboard } from '../../components/primitive/clipboard'
import type {
  AssistantTranslationLanguage,
  AssistantTranslationTarget
} from '../../contracts/assistant'
import { Icon } from '../../icons'
import { useApp } from '../../store'


function alternateTarget(source: AssistantTranslationLanguage): AssistantTranslationTarget {
  return source === 'zh-CN' ? 'en' : 'zh-CN'
}

export function Translation(): React.JSX.Element | null {
  const { state, act } = useApp()
  const { t } = useTranslation('assistant')
  const translation = state.aiPanel.translation
  if (!translation) return null

  const output = translation.invocation?.output?.text ?? ''
  const errorCode = translation.error ?? translation.invocation?.error?.code ?? ''
  const errorMessages: Record<string, string> = {
    action_runtime_unavailable: t('translation.errors.action_runtime_unavailable'),
    agent_runtime_failed: t('translation.errors.agent_runtime_failed'),
    agent_turn_failed: t('translation.errors.agent_turn_failed'),
    invalid_language_pair: t('translation.errors.invalid_language_pair'),
    project_required: t('translation.errors.project_required'),
    translation_failed: t('translation.errors.translation_failed'),
  }
  const errorText = Object.prototype.hasOwnProperty.call(errorMessages, errorCode)
    ? errorMessages[errorCode]
    : errorCode ? t('translation.errors.unknown', { detail: errorCode }) : ''

  const setSource = (value: string): void => {
    const source = value as AssistantTranslationLanguage
    act.setTranslationLanguages(
      source,
      source === translation.targetLanguage ? alternateTarget(source) : translation.targetLanguage
    )
  }

  return (
    <section className="vds-ai-translation" data-testid="ai-translation">
      <header className="vds-ai-translation__head">
        <span>
          <Icon name="sparkle" size={14} />
          {t('translation.title')}
        </span>
        <IconButton
          label={t('translation.close')}
          icon={<Icon name="close" size={12} />}
          size="sm"
          variant="ghost"
          onClick={act.closeTranslation}
        />
      </header>
      <div className="vds-ai-translation__controls">
        <Select
          aria-label={t('translation.sourceLanguage')}
          size="sm"
          value={translation.sourceLanguage}
          disabled={translation.loading}
          onValueChange={setSource}
        >
          <option value="auto">{t('translation.auto')}</option>
          <option value="en">{t('translation.english')}</option>
          <option value="zh-CN">{t('translation.chinese')}</option>
        </Select>
        <Icon name="chevron-right" size={13} />
        <Select
          aria-label={t('translation.targetLanguage')}
          size="sm"
          value={translation.targetLanguage}
          disabled={translation.loading}
          onValueChange={(value) => {
            const target = value as AssistantTranslationTarget
            act.setTranslationLanguages(
              target === translation.sourceLanguage ? 'auto' : translation.sourceLanguage,
              target
            )
          }}
        >
          <option value="zh-CN">{t('translation.chinese')}</option>
          <option value="en">{t('translation.english')}</option>
        </Select>
        <Button
          data-testid="ai-translation-retry"
          disabled={translation.loading}
          loading={translation.loading}
          size="sm"
          variant="secondary"
          onClick={() => void act.retryTranslation()}
        >
          {translation.invocation ? t('translation.retranslate') : t('translation.retry')}
        </Button>
      </div>
      <div className="vds-ai-translation__source" title={translation.input.label}>
        {translation.input.text}
      </div>
      {translation.loading ? (
        <div className="vds-ai-translation__loading" data-testid="ai-translation-loading">
          <span aria-hidden="true">•••</span>
          {t('translation.loading')}
        </div>
      ) : errorText ? (
        <Alert data-testid="ai-translation-error" description={errorText} tone="error" />
      ) : output ? (
        <div className="vds-ai-translation__result" data-testid="ai-translation-result">
          <p>{output}</p>
          <CopyButton value={output} writeText={writeClipboard} size="sm" variant="ghost" />
        </div>
      ) : null}
    </section>
  )
}
