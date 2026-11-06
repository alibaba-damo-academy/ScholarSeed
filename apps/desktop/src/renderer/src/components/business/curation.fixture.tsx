import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { StoreProvider, useApp } from '../../store'
import { projectHilCard } from '../../hil'
import type { ConvItem, Thread } from '../../model'
import {
  literatureCurationInteraction,
  literatureOutlineConfirmation,
} from '../../features/literature/interaction'
import { InteractionPolicyProvider } from './Interactions'
import { HilCard, Stream, type HilController } from './Stream'
import { ToastProvider } from '../ui'
import '../../browser'
import '../../styles.css'

const outline = new URLSearchParams(location.search).has('outline')
const QUESTION_ID = outline ? 'outline-review:fixture' : 'literature-curation-fixture'
const RESOLVED_ANSWER = outline ? '按当前方案开始撰写' : '取消'
const requests: unknown[] = []
const localization = createLocalization('en', resources, {
  report: () => undefined,
  escapeValue: false,
})
await i18next.init({ lng: 'zh', resources })
const question = outline
  ? {
      id: QUESTION_ID,
      header: '大纲与输出设置确认',
      question: '是否按上述大纲和以下输出设置开始撰写？',
      options: [{ label: '按当前方案开始撰写', description: '使用当前大纲和输出设置。' }],
      presentation: {
        kind: 'literature-outline-confirmation',
        format: 'PDF: English typesetting',
        citation_style: 'Numbered references',
        timeout_seconds: null,
      },
    }
  : {
      id: QUESTION_ID,
      header: '文献库操作确认',
      question: 'AI 请求执行破坏性操作 delete, 影响 1 条: 用户标题。是否允许?',
      options: [
        { label: '确认执行', description: '立即执行, 不可撤销。' },
        { label: '取消', description: '拒绝本次操作, 库保持不变。' },
      ],
      presentation: {
        kind: 'literature-curation',
        operation: 'delete',
        count: 1,
        titles: ['用户标题'],
      },
    }
const history = new URLSearchParams(location.search).has('history')
const initial = projectHilCard(
  { request_id: QUESTION_ID, kind: 'question', questions: [question] },
  Date.now(),
  'turn'
)
const thread: Thread = {
  id: 'curation',
  sessionId: 'curation',
  title: '',
  lastSeq: 0,
  conversation: [
    {
      ...initial,
      ...(history
        ? {
            hilState: 'resolved',
            resolved: RESOLVED_ANSWER,
            answers: { [QUESTION_ID]: RESOLVED_ANSWER },
          }
        : {}),
    },
  ],
}

function History(): React.JSX.Element {
  const { set } = useApp()
  useEffect(() => {
    set({ activeSession: thread.id, threads: { [thread.id]: thread } })
  }, [set])
  return <Stream />
}

function Fixture(): React.JSX.Element {
  const [current, setCurrent] = useState(thread)
  const controller: HilController = {
    sessionId: thread.id,
    threadId: thread.id,
    patchThread: (_identity, patch) =>
      setCurrent((value) => ({
        ...value,
        ...(typeof patch === 'function' ? patch(value) : patch),
      })),
    respond: async (_session, request, body) => {
      requests.push(body)
      return { ok: true, request_id: request }
    },
    interrupt: async () => ({ ok: true }),
  }
  Object.assign(window, {
    curationFixture: {
      requests,
      language: (language: 'en' | 'zh') => localization.changeLanguage(language),
      snapshot: () => current.conversation,
    },
  })
  return history ? (
    <History />
  ) : (
    <HilCard
      item={current.conversation[0] as Extract<ConvItem, { kind: 'hil' }>}
      controller={controller}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <InteractionPolicyProvider
        policies={[literatureCurationInteraction, literatureOutlineConfirmation]}
      >
        <StoreProvider assistantSources={[]}>
          <Fixture />
        </StoreProvider>
      </InteractionPolicyProvider>
    </ToastProvider>
  </I18nextProvider>
)
