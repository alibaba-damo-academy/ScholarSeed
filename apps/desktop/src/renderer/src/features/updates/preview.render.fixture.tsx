import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import type {
  LatestVersionMeta,
  PreviewUpdatePolicy,
  PreviewUpdateScope,
} from '../../../../updates'
import { PreviewUpdates } from './Preview'
import { Dialog, DialogContent, DialogPortal } from '../../components/ui'
import '../../styles.css'

const query = new URLSearchParams(location.search)
const calls: string[] = []
let policy: PreviewUpdatePolicy = { scope: 'current-line' }
const candidate: LatestVersionMeta = {
  id: 'preview-three',
  version: '0.3.0',
  build_number: '202610201400',
  product_id: 'scholarseed',
  bundle_id: 'com.scholarseed.desktop',
  arch_type: 'darwin-arm64',
  channel: 'preview',
  file_size: 100,
  sha512: 'a'.repeat(128),
  release_notes: '版本线更新说明',
}
function record(call: string): void {
  calls.push(call)
  document.getElementById('calls')!.textContent = calls.join(',')
}
Object.assign(window, {
  scholarseed: {
    channel: query.get('channel') ?? 'preview',
    getPreviewUpdatePolicy: async () => {
      record('get')
      return policy
    },
    setPreviewUpdateScope: async (scope: PreviewUpdateScope) => {
      record(`scope:${scope}`)
      if (query.has('fail')) throw new Error('save failed')
      policy = { scope }
      return policy
    },
    listPreviewUpdateLines: async () => {
      record('list')
      if (query.has('empty')) return []
      return [{ line: '0.3', latest: candidate }]
    },
    selectPreviewUpdateTarget: async (id: string) => {
      record(`select:${id}`)
      policy = { ...policy, target: candidate }
      return policy
    },
    cancelPreviewUpdateTarget: async () => {
      record('cancel')
      policy = { scope: policy.scope }
      return policy
    },
  },
})
const localization = createLocalization(query.get('language') === 'en' ? 'en' : 'zh', resources, {
  escapeValue: false,
})
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <Dialog open>
      <DialogPortal>
        <DialogContent
          aria-label="Settings"
          hideCloseButton
          className="!z-[var(--vds-z-modal)]"
          overlayClassName="!z-[var(--vds-z-overlay)]"
        >
          <PreviewUpdates
            state={{
              phase: query.has('installing') ? 'installing' : 'idle',
              currentVersion: '0.2.0',
            }}
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
    <output id="calls" />
  </I18nextProvider>
)
