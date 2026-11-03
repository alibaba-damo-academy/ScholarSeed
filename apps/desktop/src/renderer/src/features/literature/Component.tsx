import React from 'react'
import type { i18n } from 'i18next'
import type { PublicComponentProps, PublicComponentContribution } from '../../contracts/components'
import { LiteratureReferences } from './References'
import { LiteratureResults } from './Summary'
import { LiteratureDownloads } from './Downloads'
import { LiteratureDeliveryCard } from './Delivery'
import { LiteratureReviewCard } from './Review'
import { LiteratureChoices, type ChoiceData } from './Choices'
import { LiteratureDetails } from './Details'
import { CARD_CAPABILITIES, cardPorts, type LiteratureCardPorts } from './ports'
import { literatureCopy } from './copy'
import { requestConversationSearch, requestDownloadCard, requestLiteratureDelivery } from './api'
import { parseDownloadCard } from './admission'

const VIEWS: Record<
  string,
  React.ComponentType<{
    content: Record<string, unknown>
    cardId: string
    ports: LiteratureCardPorts
  }>
> = {
  'display.literature-search': LiteratureResults,
  'display.literature-references': LiteratureReferences,
  'display.literature-downloads': LiteratureDownloads,
  'display.literature-delivery': LiteratureDeliveryCard,
  'display.literature-review': LiteratureReviewCard,
  'preview.literature-results': LiteratureDetails,
}
const CHOICES = ['interaction.question', 'literature.authorization']
const LEGACY_SELECTION = 'literature.selection'
const OUTLINE = 'literature.outline'
const PUBLIC_SLOTS = [
  ...Object.keys(VIEWS).filter((slot) => slot !== 'display.literature-review'),
  ...CHOICES,
]
const HOST_AUTHORIZATION = async (): Promise<void> => undefined

export function LiteratureComponent({
  slot,
  data,
  status,
  onAction,
  onRequest,
}: PublicComponentProps): React.JSX.Element {
  const context = data.context as
    Pick<LiteratureCardPorts, 'projectId' | 'projectName' | 'projects'> | undefined
  const ports = cardPorts(
    async <Result,>(action: string, values: Record<string, unknown> = {}): Promise<Result> => {
      if (!onRequest || !CARD_CAPABILITIES[action]) throw new Error('plugin_capability_undeclared')
      return (await onRequest(
        action,
        values,
        CARD_CAPABILITIES[action],
        HOST_AUTHORIZATION
      )) as Result
    },
    context ?? {}
  )
  const View = VIEWS[slot]
  if (View) return <View content={data} cardId={slot} ports={ports} />
  return (
    <>
      {slot === OUTLINE && <LiteratureReviewCard content={data} ports={ports} />}
      <LiteratureChoices data={data as ChoiceData} status={status} slot={slot} submit={onAction} />
    </>
  )
}

export const literaturePublicComponents: PublicComponentContribution[] = [
  ...PUBLIC_SLOTS.map((slot) => ({
    slot,
    hosted: slot === 'display.literature-delivery',
    copy: async (
      data: Record<string, unknown>,
      localization: i18n,
      context?: { cardId?: string }
    ) => {
      const translate = localization.getFixedT(null, 'literature')
      if (slot === 'display.literature-downloads') {
        const card = parseDownloadCard(data)
        if (card?.omitted_papers) {
          const complete = await requestDownloadCard(card)
          return literatureCopy(slot, { ...data, ...complete }, translate)
        }
      }
      if (
        slot === 'display.literature-search' &&
        context?.cardId &&
        typeof data.session_id === 'string'
      ) {
        const result = await requestConversationSearch(data.session_id, context.cardId)
        return literatureCopy(slot, { ...data, ...result }, translate)
      }
      if (
        slot === 'display.literature-delivery' &&
        typeof data.session_id === 'string' &&
        typeof data.delivery_id === 'string'
      ) {
        const batch = await requestLiteratureDelivery(data.session_id, data.delivery_id)
        return literatureCopy(slot, { ...data, ...batch }, translate)
      }
      return literatureCopy(slot, data, translate)
    },
    render: (props: PublicComponentProps) => <LiteratureComponent {...props} />,
  })),
  {
    slot: LEGACY_SELECTION,
    legacyOnly: true,
    copy: (data, localization) =>
      literatureCopy(LEGACY_SELECTION, data, localization.getFixedT(null, 'literature')),
    render: (props) => <LiteratureComponent {...props} />,
  },
]
