import React from 'react'
import '../../styles.css'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import zh from '../../../../localization/locales/zh/components.json'
import conversation from '../../../../localization/locales/zh/conversation.json'
import assistant from '../../../../localization/locales/zh/assistant.json'
import type { QueuedMessage } from '../../model'
import { ComposerQueue, type ComposerQueueProps } from './Composer'

const params = new URLSearchParams(location.search)
const i18n = createInstance()
await i18n.init({
  lng: 'zh',
  resources: { zh: { components: zh, assistant, conversation } },
  interpolation: { escapeValue: false },
})

function Probe(): React.JSX.Element {
  const [events, setEvents] = React.useState<string[]>([])
  const [followUpMode, setFollowUpMode] = React.useState<'queue' | 'steer'>('queue')
  const record = (action: string, id: string): void =>
    setEvents((current) => [...current, `${action}:${id}`])
  const message: QueuedMessage = {
    queuedMessageId: 'fixture-queue',
    enqueueSeq: 1,
    state: (params.get('state') ?? 'queued') as QueuedMessage['state'],
    submissionMode: 'queued',
    text: params.has('attachmentOnly') ? '' : 'Fixture queued message',
    input: [
      { type: 'file', name: 'report.pdf', reference_id: 'fixture-file' },
      { type: 'skill', name: 'paper-search', path: '/skills/paper-search' },
    ],
    assistantReferences: [
      { kind: 'note', label: '回答注释' },
      { kind: 'pdf_comment', label: 'PDF 注释', anchor: {} },
      { kind: 'selection', label: '旧版划词' },
      { kind: 'literature', label: '文献划词', anchor: {} },
      { kind: 'session', label: '前序任务' },
    ],
    serverPresent: true,
    retryBlockedErrorCode: params.has('openUnknown') ? 'runtime_session_open_unknown' : undefined,
    safeErrorCode: params.has('openUnknown') ? 'windows_sandbox_setup_cancelled' : undefined,
  }
  const callbacks: Partial<ComposerQueueProps> =
    params.get('callbacks') === 'yes'
      ? {
          editQueued: (item) => record('edit', item.queuedMessageId),
          retractQueuedMessage: (id) => record('withdraw', id),
          steerQueued: (item) => record('steer', item.queuedMessageId),
          reconcileQueued: (id) => record('check', id),
          sendQueued: (id) => record('send', id),
          confirmQueuedUnknown: (item) => record('confirm', item.queuedMessageId),
        }
      : {}
  return (
    <I18nextProvider i18n={i18n}>
      <ComposerQueue
        followUpMode={followUpMode}
        toggleFollowUp={
          params.has('followUp')
            ? () => {
                const mode = followUpMode === 'queue' ? 'steer' : 'queue'
                setFollowUpMode(mode)
                record('mode', mode)
              }
            : undefined
        }
        followUpPending={params.has('savingPreference')}
        messages={[message]}
        skillTitle={(name) => (name === 'paper-search' ? '论文检索' : undefined)}
        running
        activeTurnId="fixture-turn"
        recoveryAvailable={!params.has('noRecovery')}
        waiting={params.has('waiting')}
        creditBlocked={params.has('creditBlocked')}
        queuedActionId={params.has('busy') ? message.queuedMessageId : null}
        {...callbacks}
      />
      <output data-testid="queue-events">{events.join('|')}</output>
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
