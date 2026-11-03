import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { SKILL_CATALOG_CHANGED_EVENT } from '../../../../skills'
import '../../browser'
import { StoreProvider } from '../../store'
import { ToastProvider } from '../ui'
import { Skills, SkillAdd } from './Skills'

const localization = createLocalization('zh', resources, { report: () => undefined })
const initialReport = new URLSearchParams(location.search).has('uiReport')
  ? {
      kind: 'ui' as const,
      valid: true,
      candidate: 'candidate-ui',
      sha256: 'digest',
      descriptor: null,
      dependencies: {},
      issues: [],
    }
  : undefined
let result = { status: 503, body: '{}' }
const requests: unknown[] = []
const completed: unknown[] = []
Object.assign(window.scholarseed, {
  preferences: { ...window.scholarseed.preferences, language: 'zh' },
  deviceSkills: async (request: unknown) => {
    requests.push(request)
    return result
  },
})
Object.assign(window, {
  catalogFixture: {
    requests,
    completed,
    respond(next: typeof result) {
      result = next
    },
    refresh() {
      window.dispatchEvent(new Event(SKILL_CATALOG_CHANGED_EVENT))
    },
  },
})
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <StoreProvider assistantSources={[]}>
          {initialReport ? (
            <SkillAdd
              initialReport={initialReport}
              onClose={() => undefined}
              onDone={async (notice) => {
                completed.push(notice)
              }}
            />
          ) : (
            <Skills />
          )}
        </StoreProvider>
      </ToastProvider>
    </I18nextProvider>
  </StrictMode>
)
