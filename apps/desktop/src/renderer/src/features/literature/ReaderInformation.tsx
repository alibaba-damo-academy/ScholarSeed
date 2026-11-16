import React from 'react'
import { useTranslation } from 'react-i18next'

import type { DocumentPanelContext, DocumentPanelPresentation } from '../../contracts/features'
import { catalogue } from './catalog'
import { LiteratureDetail } from './LiteratureDetail'
import { literatureIdFromDocument } from './note'

export const LITERATURE_INFORMATION_PANEL_ID = 'literature-information'

export function LiteratureInformationTitle(): React.JSX.Element {
  const { t } = useTranslation('literature')
  return <>{t('information.title')}</>
}

export function LiteratureInformationPanel({
  context,
  presentation,
}: {
  context: DocumentPanelContext
  presentation?: DocumentPanelPresentation
}): React.JSX.Element | null {
  const id = literatureIdFromDocument(context)
  return id ? (
    <LiteratureDetail
      key={id}
      id={id}
      attachmentId={null}
      presentation="reader"
      headerActionsHost={presentation?.headerActionsHost}
      onClose={() => {}}
      onItemUpdated={(item) => catalogue.updateItem(item)}
    />
  ) : null
}
