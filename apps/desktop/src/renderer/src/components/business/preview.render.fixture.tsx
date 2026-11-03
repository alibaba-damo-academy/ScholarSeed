import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import zhSkills from '../../../../localization/locales/zh/skills.json'
import zhConversation from '../../../../localization/locales/zh/conversation.json'
import zhLiterature from '../../../../localization/locales/zh/literature.json'
import zhUi from '../../../../localization/locales/zh/ui.json'
import type { PluginMount } from '../../../../plugins'
import { PluginPreviewDialog } from './Plugin'
import { PublicComponentsContext } from './publicComponents'
import { literaturePublicComponents } from '../../features/literature/Component'
import { literatureReviewInteraction, literatureRetrievalAuthorization, preciseFulltextSubsetAuthorization } from '../../features/literature/interaction'
import { InteractionPolicyProvider } from './Interactions'
import { ToastProvider } from '../ui'
import '../../styles.css'

const fixture = (
  window as unknown as { previewFixture: { mount: PluginMount; requests: unknown[] } }
).previewFixture
Object.assign(window, {
  scholarseed: {
    onPluginRevoked: () => () => undefined,
    deviceSkills: async (request: { operation: string }) => {
      fixture.requests.push(request)
      if (request.operation === 'plugin-validate') return { status: 200, body: JSON.stringify({ valid: true, authorized: false }) }
      if (request.operation === 'plugin-preview-installed')
        return { status: 200, body: JSON.stringify(fixture.mount) }
      if (request.operation === 'plugin-release' || request.operation === 'plugin-valid')
        return { status: 200, body: '{}' }
      throw new Error(`Unexpected native operation: ${request.operation}`)
    },
  },
})
const localization = createLocalization(
  'zh',
  { zh: { skills: zhSkills, conversation: zhConversation, literature: zhLiterature, ui: zhUi } },
  { report: () => undefined }
)
const request = {
  operation: 'plugin-preview-installed',
  name: fixture.mount.descriptor.id,
} as const
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <PublicComponentsContext.Provider
          value={
            new Map(literaturePublicComponents.map((component) => [component.slot, component]))
          }
        >
          <InteractionPolicyProvider policies={[preciseFulltextSubsetAuthorization, literatureRetrievalAuthorization, literatureReviewInteraction]}>
            <PluginPreviewDialog request={request} onClose={() => undefined} />
          </InteractionPolicyProvider>
        </PublicComponentsContext.Provider>
      </ToastProvider>
    </I18nextProvider>
  </StrictMode>
)
