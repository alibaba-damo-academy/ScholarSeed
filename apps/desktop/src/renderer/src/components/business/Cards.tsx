import React, { useContext } from 'react'
import { useTranslation } from 'react-i18next'

import type { DisplayCardContribution } from '../../contracts/features'
import type { ConvItem, DisplayCardData } from '../../model'
import { latestDisplayCardItems } from '../../transcript'
import { Alert, AlertDescription, AlertTitle } from '../ui'
import { DisplayCardsContext } from './displayCardsContext'

export function DisplayCardProvider({
  children,
  cards
}: {
  children: React.ReactNode
  cards: ReadonlyMap<string, DisplayCardContribution>
}): React.JSX.Element {
  return <DisplayCardsContext.Provider value={cards}>{children}</DisplayCardsContext.Provider>
}

export function DisplayCardView({ card }: { card: DisplayCardData }): React.JSX.Element {
  const cards = useContext(DisplayCardsContext)
  const { t } = useTranslation('components')
  const contribution = cards.get(card.type)
  if (!contribution) {
    return (
      <Alert tone="warning">
        <AlertTitle>{t('cards.unsupported')}</AlertTitle>
        <AlertDescription>{t('cards.type', { type: card.type })}</AlertDescription>
      </Alert>
    )
  }
  return <>{contribution.render({ cardId: card.cardId, content: card.content })}</>
}

export function useCardArtifacts(items: readonly ConvItem[]): ReadonlySet<string> {
  const cards = useContext(DisplayCardsContext)
  return new Set(items.flatMap(item => item.kind === 'display_card'
    ? cards.get(item.card.type)?.presentedArtifacts?.(item.card.content) ?? [] : []))
}

export function useLatestDisplayCards(items: readonly ConvItem[]): ConvItem[] {
  const cards = useContext(DisplayCardsContext)
  return latestDisplayCardItems(
    items,
    card => cards.get(card.type)?.supersessionKey?.(card.content) ?? null,
    card => cards.get(card.type)?.supersessionPosition
  )
}
