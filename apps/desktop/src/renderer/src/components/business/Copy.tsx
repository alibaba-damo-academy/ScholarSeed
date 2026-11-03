import React, { useContext } from 'react'
import { Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PUBLIC_COMPONENT_PLUGIN } from '../../../../plugins'
import type { ConvItem } from '../../model'
import { CopyButton } from '../ui'
import { writeClipboard } from '../primitive/clipboard'
import { hasCopyCard, readCardCopy, replyCopyText } from './copying'
import { AnswerCopyContext, CopyItemsContext, CopySessionContext } from './clipboard'
import { PublicComponentsContext } from './publicComponents'

export function ReplyCopy({
  items,
  turnId,
  sessionId,
}: {
  items: readonly ConvItem[]
  turnId: string
  sessionId: string
}): React.JSX.Element {
  const publicComponents = useContext(PublicComponentsContext)
  const copyAnswer = useContext(AnswerCopyContext)
  const { t, i18n } = useTranslation('skills')
  const { t: components } = useTranslation('components')
  return (
    <CopyButton
      iconOnly
      icon={<Copy />}
      copiedIcon={<Check />}
      size="xs"
      variant="ghostIcon"
      idleLabel={components('stream.copyReply')}
      writeText={writeClipboard}
      getValue={() =>
        replyCopyText(
          items,
          turnId,
          (reference, data, cardId) =>
            readCardCopy(
              reference,
              sessionId,
              reference.plugin === PUBLIC_COMPONENT_PLUGIN
                ? (value) =>
                    publicComponents.get(reference.component)?.copy?.(value, i18n, { cardId }) ??
                    null
                : undefined,
              data
            ),
          t('plugin.copyMissing'),
          (item) => copyAnswer(item, sessionId)
        )
      }
      data-testid="reply-copy-with-cards"
    />
  )
}

export function CardOnlyReplyCopy({ item }: { item: ConvItem }): React.JSX.Element | null {
  const items = useContext(CopyItemsContext)
  const sessionId = useContext(CopySessionContext)
  if (
    !item.turnId ||
    items.some(
      (candidate) =>
        candidate.turnId === item.turnId && candidate.kind === 'agent' && candidate.text
    )
  )
    return null
  const cards = items.filter(
    (candidate) => candidate.turnId === item.turnId && hasCopyCard(candidate)
  )
  const last = cards.at(-1)
  if (
    last !== item &&
    !(
      item.kind === 'interaction_reply' &&
      last?.kind === 'hil' &&
      last.requestId === item.requestId
    )
  )
    return null
  return (
    <div className="flex justify-start">
      <ReplyCopy items={items} turnId={item.turnId} sessionId={sessionId} />
    </div>
  )
}
