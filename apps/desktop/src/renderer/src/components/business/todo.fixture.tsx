import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import '../../browser'
import '../../styles.css'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import type { Thread } from '../../model'
import type { Store } from '../../store'
import { StoreContext } from '../../storeContext'
import { TodoPanel } from './TodoPanel'

const parameters = new URLSearchParams(window.location.search)
const language = parameters.get('language') === 'en' ? 'en' : 'zh'
const duration = Number(parameters.get('duration') ?? 10_488_000)
const width = Number(parameters.get('width') ?? 228)
const completed = parameters.get('completed') === 'true'
const recovered = parameters.get('recovered') === 'true'
const interrupted = parameters.get('interrupted') === 'true'
const planTurnId = recovered ? 'recovery-plan' : 'plan'
const outcome = interrupted ? 'interrupted' : completed ? 'completed' : 'running'
const localization = createLocalization(language, resources, { report: () => undefined })
const thread: Thread = {
  id: 'layout',
  sessionId: 'layout',
  title: 'Layout regression',
  conversation: recovered
    ? [
        { kind: 'user', text: 'Original task', turnId: 'original' },
        { kind: 'status', text: '', turnId: planTurnId, turnBoundary: true },
      ]
    : [],
  lastSeq: 0,
  todoTurnId: planTurnId,
  todos: Array.from({ length: 9 }, (_, index) => ({
    id: `step-${index}`,
    content:
      index === 0 && parameters.has('longStep')
        ? 'LongUnbrokenPlanStep'.repeat(12)
        : `Step ${index + 1}`,
    status: completed || index < 7 ? 'completed' : index === 7 ? 'in_progress' : 'pending',
  })),
  running: outcome === 'running',
  status: interrupted ? 'abandon' : completed ? 'done' : 'running',
  turnOutcomes: { [planTurnId]: outcome },
  turnTimings: { [planTurnId]: { startedAt: Date.now() - duration } },
}
if (outcome !== 'running') thread.turnTimings![planTurnId].completedAt = Date.now()
const issue = parameters.get('issue')
if (parameters.has('subplan')) {
  thread.todos?.push({
    id: 'child-step',
    parent_id: 'step-7',
    content: 'Sub-agent detail',
    status: issue === 'failed' || issue === 'blocked' ? issue : 'in_progress',
  })
}
if (parameters.has('estimate')) {
  thread.conversation.push({
    kind: 'skill',
    skillId: 'review',
    name: 'Review',
    path: '',
    status: 'running',
    nativeStatus: 'running',
    turnId: planTurnId,
    estimate: {
      lowerSeconds: 1800,
      upperSeconds: 2700,
      sampleCount: 0,
      confidence: 'low',
      basis: 'product_baseline',
    },
  })
}
if (parameters.has('noPlan')) {
  thread.todoTurnId = undefined
  thread.todos = []
}
const store = {
  state: { activeSession: 'layout', threads: { layout: thread } },
} as unknown as Store
document.documentElement.dataset.theme = parameters.get('theme') ?? 'light'

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <StoreContext.Provider value={store}>
      <div style={{ width, maxWidth: '100%', left: 48, position: 'absolute', bottom: '20%' }}>
        <TodoPanel
          compact
          currentTurnOnly={recovered}
          continueDisabled={parameters.get('continueDisabled') === 'true'}
          onContinue={async () => {
            document.documentElement.dataset.continueRequests = String(
              Number(document.documentElement.dataset.continueRequests ?? 0) + 1
            )
            if (parameters.get('holdContinue') === 'true') {
              await new Promise<void>((resolve) => {
                ;(
                  window as Window & { releaseTodoContinuation?: () => void }
                ).releaseTodoContinuation = resolve
              })
            }
            document.documentElement.dataset.continued = 'true'
            return true
          }}
        />
      </div>
    </StoreContext.Provider>
  </I18nextProvider>
)
