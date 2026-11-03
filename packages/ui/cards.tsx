import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { LiteratureChoices } from '../../apps/desktop/src/renderer/src/features/literature/Choices'
import { LiteratureResults } from '../../apps/desktop/src/renderer/src/features/literature/Summary'
import { LiteratureDetails } from '../../apps/desktop/src/renderer/src/features/literature/Details'
import { LiteratureReferences } from '../../apps/desktop/src/renderer/src/features/literature/References'
import { LiteratureDownloads } from '../../apps/desktop/src/renderer/src/features/literature/Downloads'
import { LiteratureDeliveryCard } from '../../apps/desktop/src/renderer/src/features/literature/Delivery'
import { LiteratureReviewCard } from '../../apps/desktop/src/renderer/src/features/literature/Review'
import {
  literatureCopy,
  reviewCopy
} from '../../apps/desktop/src/renderer/src/features/literature/copy'
import type { LiteratureDeliveryBatch } from '../../apps/desktop/src/renderer/src/contracts/literature'
import { useCopyContent } from './copying'
import { MarkdownContent } from '../../apps/desktop/src/renderer/src/components/primitive/Markdown'
import { Message as MessageView } from '../../apps/desktop/src/renderer/src/components/primitive/Message'
import { Code as CodeView } from '../../apps/desktop/src/renderer/src/components/primitive/Code'
import { Formula as FormulaView } from '../../apps/desktop/src/renderer/src/components/primitive/Formula'
import { Tabulation as TabulationView } from '../../apps/desktop/src/renderer/src/components/primitive/Tabulation'
import { Artifact as ArtifactView } from '../../apps/desktop/src/renderer/src/components/business/Artifact'
import { artifactText } from '../../apps/desktop/src/renderer/src/components/business/representation'
import { visibleMarkdownText } from '../../apps/desktop/src/renderer/src/components/markdown/source'

function card<Props extends object>(
  View: React.ComponentType<Props>,
  content: (props: Props, translate: TFunction<'literature'>) => string | null
): React.ComponentType<Props> {
  return function Card(props: Props): React.JSX.Element {
    const { t: translate } = useTranslation('literature')
    useCopyContent(content(props, translate))
    return <View {...props} />
  }
}

export const Results = card(
  LiteratureResults,
  (props, translate) =>
    literatureCopy('display.literature-search', props.content, translate)?.text ?? null
)
export const Details = card(
  LiteratureDetails,
  (props, translate) =>
    literatureCopy('preview.literature-results', props.content, translate)?.text ?? null
)
export const References = card(
  LiteratureReferences,
  (props, translate) =>
    literatureCopy('display.literature-references', props.content, translate)?.text ?? null
)
export const Downloads = card(
  LiteratureDownloads,
  (props, translate) =>
    literatureCopy('display.literature-downloads', props.content, translate)?.text ?? null
)
export const Markdown = card(MarkdownContent, (props) =>
  visibleMarkdownText(props.text)
)
export const Message = card(MessageView, (props) => props.text)
export const Code = card(CodeView, (props) => props.code)
export const Formula = card(FormulaView, (props) =>
  [props.source, props.caption, props.notes].filter(Boolean).join('\n')
)
export const Tabulation = card(TabulationView, (props) =>
  props.invalidSource || props.copyText
    ? [props.caption, props.invalidSource || props.copyText, props.notes]
        .filter(Boolean)
        .join('\n')
    : null
)
export const Artifact = card(ArtifactView, (props) =>
  [artifactText(props.primary), props.primaryMeta].filter(Boolean).join('\n')
)

export function Choices(
  props: React.ComponentProps<typeof LiteratureChoices>
): React.JSX.Element {
  const { t: translate } = useTranslation('literature')
  useCopyContent(
    literatureCopy(
      props.slot === 'literature.outline' ? 'interaction.question' : props.slot,
      props.data as Record<string, unknown>,
      translate
    )?.text ?? null
  )
  return <LiteratureChoices {...props} />
}

export function Review(
  props: React.ComponentProps<typeof LiteratureReviewCard>
): React.JSX.Element {
  const { t: translate } = useTranslation('literature')
  useCopyContent(reviewCopy(props.content, translate)?.text ?? null)
  return <LiteratureReviewCard {...props} />
}

export function Delivery(
  props: React.ComponentProps<typeof LiteratureDeliveryCard>
): React.JSX.Element {
  const { t: translate } = useTranslation('literature')
  const [batch, setBatch] = useState<LiteratureDeliveryBatch | null>(null)
  const onCopyContent = useCallback(
    (value: LiteratureDeliveryBatch) => setBatch(value),
    []
  )
  useCopyContent(
    batch
      ? (literatureCopy('display.literature-delivery', {
          ...props.content,
          ...batch
        }, translate)?.text ?? null)
      : null
  )
  return <LiteratureDeliveryCard {...props} onCopyContent={onCopyContent} />
}
