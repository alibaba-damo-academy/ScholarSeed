import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import { updateCandidateKey, type UpdateSnapshot } from '../../../updates'
import { UpdateEntry } from './business/UpdateEntry'
import { UpdateOverlay } from './business/UpdateOverlay'
import { AccountPanel } from './business/AccountPanel'
import { StoreProvider } from '../store'
import { Button, Dialog, DialogContent, DialogPortal, ToastProvider } from './ui'
import '../browser'
import '../styles.css'

let snapshot: UpdateSnapshot = {
  phase: 'available',
  currentVersion: '0.2.0',
  candidate: {
    id: 'render-update',
    version: '0.2.1',
    build_number: '1',
    product_id: 'scholarseed',
    bundle_id: 'com.scholarseed.desktop',
    arch_type: 'darwin-arm64',
    channel: 'release',
    file_size: 100,
    sha512: 'a'.repeat(128),
    release_notes: '更新入口状态验证\n文献检索优化\n资料管理优化\n完整更新说明',
  },
}
const listeners = new Set<(state: UpdateSnapshot) => void>()
const actions: string[] = []
function recordAction(action: string): void {
  actions.push(action)
  document.getElementById('update-actions')!.textContent = actions.join(',')
}
function publish(next: UpdateSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener(snapshot)
}
Object.assign(window, {
  scholarseed: {
    ...window.scholarseed,
    version: '0.2.0',
    buildNumber: '202610301118',
    getUpdateState: async () => snapshot,
    onUpdateState: (listener: (state: UpdateSnapshot) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    acknowledgeUpdateAnnouncement: async () => {
      publish({ ...snapshot, announcedKey: updateCandidateKey(snapshot.candidate) ?? undefined })
    },
    cancelUpdate: async () => {
      if (snapshot.installation)
        publish({ ...snapshot, installation: { ...snapshot.installation, cancelling: true } })
      return { ok: true }
    },
    refreshUpdate: async () => snapshot,
    startUpdate: async (candidateId: string) => {
      recordAction(`download:${candidateId}`)
      publish({ ...snapshot, phase: 'downloading', percent: 40, errorFallback: undefined })
    },
    installUpdate: async () => {
      recordAction('install')
      publish({ ...snapshot, phase: 'installing', errorFallback: undefined })
    },
  },
})
const localization = createLocalization('zh', resources, { escapeValue: false })
Object.assign(window, {
  updateFixture: {
    publish: (next: Partial<UpdateSnapshot>) => publish({ ...snapshot, ...next }),
    language: (language: 'zh' | 'en') => localization.changeLanguage(language),
  },
})
function SettingsFixture(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Settings</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogContent
            aria-label="Settings"
            className="!z-[var(--vds-z-modal)]"
            overlayClassName="!z-[var(--vds-z-overlay)]"
          >
            <Button
              onClick={() =>
                publish({
                  ...snapshot,
                  phase: 'available',
                  candidate: { ...snapshot.candidate!, build_number: '2' },
                })
              }
            >
              Check for update
            </Button>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    {new URLSearchParams(location.search).has('about') ? (
      <ToastProvider>
        <StoreProvider assistantSources={[]}>
          <AccountPanel
            embedded
            page="about"
            onPage={() => undefined}
            onClose={() => undefined}
            onLogin={() => undefined}
            onLogout={async () => ({ ok: true, data: { local_cleared: true } })}
          />
        </StoreProvider>
      </ToastProvider>
    ) : (
      <>
        <UpdateOverlay />
        <div style={{ padding: 32, paddingTop: 480 }}>
          <UpdateEntry />
        </div>
        <Button onClick={() => publish({ ...snapshot, phase: 'downloading', percent: 40 })}>
          Downloading
        </Button>
        <Button
          onClick={() => publish({ ...snapshot, phase: 'ready', errorFallback: 'install_failed' })}
        >
          Failure
        </Button>
        <Button onClick={() => publish({ ...snapshot, phase: 'ready', errorFallback: undefined })}>
          Ready
        </Button>
        <Button
          onClick={() =>
            publish({
              ...snapshot,
              phase: 'available',
              candidate: { ...snapshot.candidate!, build_number: '2' },
            })
          }
        >
          New build
        </Button>
        <output id="update-actions" data-testid="update-actions" />
        <SettingsFixture />
      </>
    )}
  </I18nextProvider>
)
