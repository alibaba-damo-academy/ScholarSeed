import React from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import assistant from '../../../../localization/locales/zh/assistant.json'
import ui from '../../../../localization/locales/zh/ui.json'
import workbench from '../../../../localization/locales/zh/workbench.json'
import { GeneratedPdf } from './PdfPreview'
import { GeneratedImageGallery } from './Images'
import '../../styles.css'

const localization = createInstance()
await localization.init({ lng: 'zh', resources: { zh: { assistant, ui, workbench } } })
const parameters = new URLSearchParams(location.search)
const artifact = {
  artifact_id: 'document',
  name: parameters.has('misnamed') ? 'report.png' : 'document.pdf',
  path: parameters.has('misnamed') ? 'report.png' : 'document.pdf',
  media_type: 'application/pdf',
  sha256: parameters.get('sha256') ?? undefined,
}
function Probe(): React.JSX.Element {
  const [opened, setOpened] = React.useState(false)
  return (
    <>
      {parameters.has('mixed') ? (
        <GeneratedImageGallery
          sessionId="fixture"
          artifacts={[
            {
              artifact_id: 'first',
              name: parameters.has('misnamed') ? 'plot.pdf' : 'first.png',
              path: parameters.has('misnamed') ? 'plot.pdf' : 'first.png',
              media_type: 'image/png',
            },
            artifact,
            { artifact_id: 'last', name: 'last.png', path: 'last.png' },
          ]}
          onOpenPdf={() => setOpened(true)}
          renderActions={() => null}
        />
      ) : (
        <GeneratedPdf sessionId="fixture" artifact={artifact} onOpen={() => setOpened(true)} />
      )}
      <output data-testid="opened">{String(opened)}</output>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <Probe />
  </I18nextProvider>
)
