import React, { useContext } from 'react'
import { useTranslation } from 'react-i18next'

import type { DisplayCardContribution } from '../../contracts/features'
import type { ConvItem, DisplayCardData } from '../../model'
import { cardArtifactIds } from '../../activity'
import { latestDisplayCardItems } from '../../transcript'
import { Alert, AlertDescription, AlertTitle } from '../ui'
import { DisplayCardsContext } from './displayCardsContext'
import { PublicComponentsContext } from './publicComponents'
import type { PublicComponentContribution } from '../../contracts/components'
import { PLUGIN_DISPLAY_TYPE } from '../../../../plugins'
import { PluginInteraction } from './Frame'

export function DisplayCardProvider({
  children,
  cards, publicComponents = new Map()
}: {
  children: React.ReactNode
  cards: ReadonlyMap<string, DisplayCardContribution>
  publicComponents?: ReadonlyMap<string, PublicComponentContribution>
}): React.JSX.Element {
  return <DisplayCardsContext.Provider value={cards}><PublicComponentsContext.Provider value={publicComponents}>{children}</PublicComponentsContext.Provider></DisplayCardsContext.Provider>
}

export function DisplayCardView({ card, turnId }: { card: DisplayCardData; turnId?: string }): React.JSX.Element {
  const cards = useContext(DisplayCardsContext)
  const { t } = useTranslation('components')
  const contribution = cards.get(card.type)
  if (card.type === PLUGIN_DISPLAY_TYPE && card.component) return <PluginInteraction reference={card.component} data={card.content} status="resolved" onAction={() => undefined} />
  if (!contribution) {
    return (
      <Alert tone="warning">
        <AlertTitle>{t('cards.unsupported')}</AlertTitle>
        <AlertDescription>{t('cards.type', { type: card.type })}</AlertDescription>
      </Alert>
    )
  }
  return <>{contribution.render({ cardId: card.cardId, content: card.content, component: card.component, presentationSource: card.presentationSource, turnId })}</>
}

export function usePostDeliveryCardTypes(): ReadonlySet<string> {
  const cards = useContext(DisplayCardsContext)
  return new Set([...cards.values()].filter(card => card.placement === 'after-artifacts').map(card => card.type))
}

export function useCardArtifacts(items: readonly ConvItem[]): ReadonlySet<string> {
  const cards = useContext(DisplayCardsContext)
  return cardArtifactIds(items, (card) => cards.get(card.type)?.presentedArtifacts?.(card.content) ?? [])
}

export function useLatestDisplayCards(items: readonly ConvItem[]): ConvItem[] {
  const cards = useContext(DisplayCardsContext)
  return latestDisplayCardItems(
    items,
    card => cards.get(card.type)?.supersessionKey?.(card.content) ?? null,
    card => cards.get(card.type)?.supersessionPosition
  )
}
