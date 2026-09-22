import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  Button,
  CopyButton,
  IconButton
} from '../../components/ui'
import { TranslationTargetPicker } from '../../components/business/Language'
import { writeClipboard } from '../../components/primitive/clipboard'
import { Icon } from '../../icons'
import { useApp } from '../../store'

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
        <TranslationTargetPicker
          value={translation.targetLanguage}
          disabled={translation.loading}
          onChange={act.setTranslationTarget}
        />
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
