import React from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import assistant from '../../../../localization/locales/zh/assistant.json'
import ui from '../../../../localization/locales/zh/ui.json'
import { Button, ToastProvider } from '../../components/ui'
import { AttachmentImages, GeneratedImageGallery } from './Images'
import { ImagePreview } from '../../components/primitive'
import '../../styles.css'

const localization = createInstance()
await localization.init({ lng: 'zh', resources: { zh: { assistant, ui } } })
const count = Number(new URLSearchParams(location.search).get('count') ?? 23)
const refs = Array.from({ length: count }, (_, index) => ({
  type: 'file' as const,
  id: String(index),
  title: `image-${index}.png`,
  path: `image-${index}.png`,
}))
function Probe(): React.JSX.Element {
  const [imported, setImported] = React.useState('')
  const [open, setOpen] = React.useState(true)
  const [index, setIndex] = React.useState(0)
  const [copied, setCopied] = React.useState('')
  const [mounted, setMounted] = React.useState(true)
  if (new URLSearchParams(location.search).has('generated'))
    return (
      <>
        <Button onClick={() => setMounted(false)}>Hide generated images</Button>
        {mounted && (
          <GeneratedImageGallery
            sessionId="fixture"
            artifacts={refs.map((ref) => ({
              artifact_id: ref.id,
              name: ref.title,
              path: ref.path,
              media_type: 'image/png',
            }))}
            renderActions={(artifact, preview) => (
              <Button>{`${preview ? 'Preview' : 'Thumbnail'} actions ${artifact.artifact_id}`}</Button>
            )}
            onOpenPdf={() => {
              throw new Error('unexpected_pdf_open')
            }}
          />
        )}
      </>
    )
  if (new URLSearchParams(location.search).has('generic'))
    return (
      <>
        <div className="fixed inset-x-0 top-0 z-[var(--vds-app-shell-drag-region-z-index)] h-[var(--vds-app-shell-drag-region-height)]" />
        <ImagePreview
          images={[
            {
              id: 'standalone',
              name: 'standalone.svg',
              src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="300"%3E%3Crect width="400" height="300" fill="green"/%3E%3C/svg%3E',
            },
            {
              id: 'duplicate',
              name: 'duplicate.svg',
              src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="300"%3E%3Crect width="400" height="300" fill="green"/%3E%3C/svg%3E',
            },
            { id: 'missing', name: 'missing.png', error: true },
          ]}
          open={open}
          index={index}
          onOpenChange={setOpen}
          onIndexChange={setIndex}
          onCopy={(element) => setCopied(`${element.naturalWidth}`)}
          actions={<span>custom action</span>}
        />
        <output data-testid="copied-size">{copied}</output>
      </>
    )
  return (
    <>
      <AttachmentImages
        refs={refs}
        sessionId="fixture"
        sent={!new URLSearchParams(location.search).has('draft')}
        sourceLabel={
          new URLSearchParams(location.search).has('sources')
            ? (ref) => (ref.id === '1' ? '资料' : ref.id === '2' ? '文献' : undefined)
            : undefined
        }
        onRemove={
          new URLSearchParams(location.search).has('draft')
            ? (position) => setImported(String(position))
            : undefined
        }
        onOpen={(target) => setImported(JSON.stringify(target))}
        onImport={(ref) => setImported(ref.id)}
      />
      <output data-testid="imported-image">{imported}</output>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <div style={{ width: 360 }}>
        <Probe />
      </div>
    </ToastProvider>
  </I18nextProvider>
)
