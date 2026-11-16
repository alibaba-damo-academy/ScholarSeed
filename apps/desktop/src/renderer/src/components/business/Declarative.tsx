import React, { useContext, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ConversationSurface } from '../../../../../../../packages/ui/renderer'
import { conversationLibrary } from '../../../../../../../packages/ui/library'
import {
  chartDataset,
  ConversationChartContext,
  type ConversationChartProps,
} from '../../../../../../../packages/ui/charts'
import { OPENUI_SLOT, type ConversationDocument } from '../../../../../../../packages/ui/document'
import { validateEnvelope } from '../../../../../../../packages/ui/validation'
import type { PublicComponentProps } from '../../contracts/components'
import { conversationTheme, useConversationMode } from '../../design/conversation'
import { PublicComponentsContext } from './publicComponents'
import { PlotFrame } from '../primitive/Plot'
import { writeClipboard } from '../primitive/clipboard'

export const registeredConversationLibrary = conversationLibrary

function ConversationChart(props: ConversationChartProps): React.JSX.Element {
  const { t } = useTranslation('ui')
  const dataset = chartDataset(
    props.data,
    { category: t('chart.category'), value: t('chart.value'), series: t('chart.series') },
    props.horizontal
  )
  return (
    <PlotFrame dataset={dataset} title={props.title || t('chart.label')} onCopy={writeClipboard}>
      {props.children}
    </PlotFrame>
  )
}

function DeclarativeContent(props: PublicComponentProps): React.JSX.Element {
  const { t } = useTranslation('skills')
  const mode = useConversationMode()
  const errorLabel = t('plugin.conversationContentFailed')
  const description = useMemo<ConversationDocument | null>(() => {
    try {
      return validateEnvelope(props.data.document ?? props.data)
    } catch {
      return null
    }
  }, [props.data])
  if (!description) return <p role="alert">{errorLabel}</p>
  return (
    <ConversationChartContext.Provider value={ConversationChart}>
      <ConversationSurface
        document={description}
        library={registeredConversationLibrary}
        mode={mode}
        theme={conversationTheme}
        loadingLabel={t('plugin.loading')}
        errorLabel={errorLabel}
        onError={(code) => console.info('[conversation-ui]', { code })}
      />
    </ConversationChartContext.Provider>
  )
}

export function RegisteredContent(props: PublicComponentProps): React.JSX.Element {
  const { t } = useTranslation('skills')
  const registered = useContext(PublicComponentsContext)
  if (props.slot === OPENUI_SLOT) return <DeclarativeContent {...props} />
  const component = registered.get(props.slot)
  return component ? (
    <>{component.render({ ...props, data: { ...props.data, ...props.draft } })}</>
  ) : (
    <p role="alert">{t('plugin.unavailable')}</p>
  )
}
