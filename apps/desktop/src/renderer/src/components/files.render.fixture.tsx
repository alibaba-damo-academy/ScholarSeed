import { useState } from 'react'
import { TextSelect } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import { documentWorkspaces, DocumentWorkspaceContext } from '../features/workbench/workspace'
import type { ComposerReference } from '../store'
import { applyTheme } from '../theme'
import { AttachmentFiles } from '../features/assistant/Local'
import { DraftAttachments } from '../features/assistant/Images'
import { DocumentFallbackActions } from '../features/workbench/External'
import type { DocumentSession } from '../features/workbench/workspace'
import { ComposerAttachments } from './primitive/Attachments'
import { ReferenceAttachment, SentReferenceAttachment } from './primitive/Attachment'
import { Button, IconButton, ScrollArea, ToastProvider, Toaster } from './ui'
import '../styles.css'

const localization = createLocalization('zh', resources, { escapeValue: false })
const references: ComposerReference[] = [
  { type: 'directory', id: 'folder', title: '实验资料.v2', path: '/experiment' },
  ...Array.from({ length: 40 }, (_, index) => ({
    type: 'file' as const,
    id: String(index),
    title:
      index === 2
        ? 'notes#hash?.txt'
        : index === 0
          ? '很长的中文实验数据和方法说明'.repeat(8) + '.results.csv'
          : `experiment-${index}.pdf`,
    path: `/experiment/${index}.pdf`,
  })),
]
let report = (_value: string): void => {}
let unavailable = false
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = String(input)
  if (!url.includes('/file-references/location')) return originalFetch(input, init)
  if (url.includes('/sessions/delayed/')) return originalFetch(input, init)
  const id = new URL(url, window.location.href).searchParams.get('reference_id')
  const folder = id === 'folder'
  return Response.json(
    unavailable || url.includes('/sessions/missing/')
      ? { ok: false, error: 'session_attachment_not_found' }
      : {
          ok: true,
          path: url.includes('/sessions/mismatch/')
            ? '/other.pdf'
            : folder
              ? '/experiment'
              : '/experiment/1.pdf',
          kind: url.includes('/sessions/wrong-kind/') ? 'directory' : folder ? 'directory' : 'file',
        },
    { status: unavailable ? 404 : 200 }
  )
}
Object.assign(window, {
  scholarseed: {
    platform: 'darwin',
    getApiBase: () => '',
    addAuthorizedRoot: async () => true,
    openPath: async (path: string) => {
      report(`open:${path}`)
      return { ok: true }
    },
    revealPath: async (path: string) => {
      report(`reveal:${path}`)
      return { ok: true }
    },
    appsForFile: async () => [{ name: 'Preview', path: '/Preview.app', isDefault: true }],
    openPathWith: async (path: string) => {
      report(`application:${path}`)
      return { ok: true }
    },
    writeClipboard: async (path: string) => {
      report(`copy:${path}`)
      return { ok: true }
    },
    saveFileCopy: async () => {
      report('canceled')
      return { ok: false, canceled: true }
    },
  },
})

function Fixture(): React.JSX.Element {
  const [refs, setRefs] = useState(references)
  const [draftSession, setDraftSession] = useState('valid')
  const [draftRefs, setDraftRefs] = useState([references[2]])
  const [opened, setOpened] = useState('')
  const freshClipboard = (): ComposerReference[] => [
    {
      type: 'file',
      id: 'clip-text',
      title: 'clipboard.txt',
      path: '',
      localSource: { file: new File(['current text'], 'clipboard.txt', { type: 'text/plain' }) },
    },
    {
      type: 'file',
      id: 'clip-image',
      title: 'clipboard.svg',
      path: '',
      mediaType: 'image/svg+xml',
      localSource: {
        file: new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'],
          'clipboard.svg',
          { type: 'image/svg+xml' }
        ),
      },
    },
  ]
  const [clipboard, setClipboard] = useState(freshClipboard)
  report = setOpened
  return (
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <DocumentWorkspaceContext.Provider
          value={documentWorkspaces.forProject('attachment-fixture')}
        >
          <div data-testid="clipboard-draft">
            <DraftAttachments
              refs={clipboard}
              onRemove={(index) =>
                setClipboard((items) => items.filter((_, itemIndex) => itemIndex !== index))
              }
            />
            <Button
              onClick={() =>
                setClipboard((items) => items.map((item) => ({ ...item, localSource: {} })))
              }
            >
              Restore clipboard metadata
            </Button>
            <Button onClick={() => setClipboard(freshClipboard())}>Readd clipboard files</Button>
          </div>
          <div data-testid="draft-validation">
            <DraftAttachments
              refs={draftRefs}
              sessionId={draftSession}
              onRemove={() => setDraftRefs([])}
              onOpen={(target) => setOpened(target.path)}
            />
            {['valid', 'missing', 'mismatch', 'wrong-kind', 'delayed'].map((session) => (
              <Button key={session} onClick={() => setDraftSession(session)}>
                {session} draft
              </Button>
            ))}
            <Button onClick={() => setDraftRefs([references[2]])}>Readd draft</Button>
          </div>
          <div
            data-testid="draft-alignment"
            className="flex items-center gap-[var(--vds-composer-attachment-gap)]"
          >
            <DraftAttachments refs={[references[2]]} onRemove={() => {}} />
            <ReferenceAttachment
              label="Annotation"
              description="Annotation preview"
              variant="annotation"
            />
            <ReferenceAttachment
              icon={<TextSelect />}
              label="Selection"
              description="Selection source"
            />
            <SentReferenceAttachment
              variant="annotation"
              label="Sent annotation"
              description="Sent annotation preview"
            />
            <SentReferenceAttachment
              icon={<TextSelect />}
              label="Sent selection"
              description="Sent selection source"
            />
          </div>
          <div style={{ width: 320, maxWidth: '100%' }}>
            <ScrollArea orientation="horizontal" data-testid="sent-files">
              <ComposerAttachments
                refs={references}
                presentation="inline"
                onOpen={(target) => setOpened(target.path)}
                onOpenDirectory={(ref) => setOpened(ref.path)}
              />
            </ScrollArea>
          </div>
          <div data-testid="resource-files">
            <DraftAttachments refs={[references[2]]} sourceLabel={() => '资料'} />
          </div>
          <div data-testid="local-files">
            <DraftAttachments refs={[references[2]]} />
          </div>
          <div data-testid="literature-files">
            <DraftAttachments
              refs={[
                {
                  type: 'file',
                  id: 'literature',
                  path: 'literature-id',
                  title: 'A paper without an extension',
                  fileName: 'paper.pdf',
                },
              ]}
              sourceLabel="文献"
            />
          </div>
          <div style={{ width: 320, maxWidth: '100%' }} data-testid="files">
            <ComposerAttachments
              refs={refs}
              onRemove={(index) =>
                setRefs((current) => current.filter((_, position) => position !== index))
              }
              onOpen={(target) => setOpened(target.path)}
              onOpenDirectory={(ref) => setOpened(ref.path)}
              renderActions={(ref) => (
                <IconButton
                  size="mini"
                  label={`Menu ${ref.id}`}
                  icon="⋯"
                  onClick={() => setOpened(`menu:${ref.id}`)}
                />
              )}
            />
          </div>
          <div data-testid="menus">
            <AttachmentFiles
              importable={(ref) => ref.type === 'directory'}
              refs={[references[0], references[2]]}
              presentation="inline"
              sessionId="session"
              onImport={(ref) => setOpened(`import:${ref.id}`)}
              onOpen={(target) => setOpened(target.path)}
            />
          </div>
          <div data-testid="fallback">
            <DocumentFallbackActions
              session={
                {
                  title: 'file.bin',
                  source: { kind: 'session-file', sessionId: 'session', path: '/experiment/1.pdf' },
                } as DocumentSession
              }
            />
          </div>
          <Button
            onClick={() => {
              unavailable = true
            }}
          >
            Unavailable
          </Button>
          <Button onClick={() => applyTheme('dark')}>Dark</Button>
          <output data-testid="opened">{opened}</output>
          <Toaster />
        </DocumentWorkspaceContext.Provider>
      </ToastProvider>
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
