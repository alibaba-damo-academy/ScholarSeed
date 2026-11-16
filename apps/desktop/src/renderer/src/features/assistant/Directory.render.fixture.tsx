import React from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import assistant from '../../../../localization/locales/zh/assistant.json'
import ui from '../../../../localization/locales/zh/ui.json'
import type { FilePreviewTarget } from '../../model'
import { ArtifactDirectory } from './Directory'
import '../../styles.css'

const localization = createInstance()
await localization.init({ lng: 'zh', resources: { zh: { assistant, ui } } })
function Probe(): React.JSX.Element {
  const [open, setOpen] = React.useState(true)
  const [target, setTarget] = React.useState<FilePreviewTarget | null>(null)
  return (
    <>
      {open && (
        <ArtifactDirectory
          artifact={{
            artifact_id: 'directory',
            kind: 'directory',
            path: 'source',
            name: '目录快照',
          }}
          sessionId="fixture"
          onClose={() => setOpen(false)}
          onOpen={setTarget}
        />
      )}
      <output data-testid="opened">{JSON.stringify(target)}</output>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <Probe />
  </I18nextProvider>
)
