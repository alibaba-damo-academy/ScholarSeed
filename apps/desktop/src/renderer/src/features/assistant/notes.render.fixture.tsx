import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import assistant from '../../../../localization/locales/zh/assistant.json'
import ui from '../../../../localization/locales/zh/ui.json'
import { AnnotationBadgeNote } from './Notes'
import '../../styles.css'

const localization = createInstance()
await localization.init({ lng: 'zh', resources: { zh: { assistant, ui } } })

function Probe(): React.JSX.Element {
  const [comment, setComment] = useState('原有注释')
  return (
    <div className="p-[var(--vds-space-10)]">
      <AnnotationBadgeNote
        annotation={{ id: 'note', previewText: '选区原文', comment }}
        ariaLabel="编辑注释"
        noteText={comment}
        number={1}
        onRemove={async () => true}
        onSave={async (_annotationId, value) => {
          setComment(value)
          return true
        }}
      />
      <output data-testid="saved-comment">{comment}</output>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <Probe />
  </I18nextProvider>
)
