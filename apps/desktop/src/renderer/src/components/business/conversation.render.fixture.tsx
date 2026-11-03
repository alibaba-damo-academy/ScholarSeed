import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import '../../browser'
import '../../styles.css'
import { preciseFulltextSubsetAuthorization } from '../../features/literature/interaction'
import type { ConvItem, Thread } from '../../model'
import { StoreProvider, useApp } from '../../store'
import { Button, Textarea, ToastProvider } from '../ui'
import { InteractionPolicyProvider } from './Interactions'
import { ConversationControls, Stream } from './Stream'

const localization = createLocalization('zh', resources, { report: () => undefined })
const SESSION_ID = 'conversation-layout'
const REQUEST_ID = 'precise-search-fulltext:layout'
const HISTORY_COUNT = 24
const LONG_PAPER_COUNT = 24
const COMPACT_HEIGHT = 160
const embedded = new URLSearchParams(location.search).has('embedded')
const compact = new URLSearchParams(location.search).has('compact')
const english = new URLSearchParams(location.search).has('english')
if (english) void localization.changeLanguage('en')
if (new URLSearchParams(location.search).has('dark'))
  document.documentElement.dataset.theme = 'dark'

export function Fixture(): React.JSX.Element {
  const { set } = useApp()
  const openAnswered = (): void => {
    const thread: Thread = {
      id: SESSION_ID,
      title: '已完成回答',
      sessionId: SESSION_ID,
      readOnly: true,
      lastSeq: 0,
      conversation: [
        {
          kind: 'hil',
          requestId: 'answered-questions',
          hilKind: 'question',
          hilState: 'resolved',
          resolved: '已回答',
          questions: [
            {
              id: 'focus',
              question: '希望以哪种研究方向为主？',
              options: [
                { label: '持久化记忆机制（推荐）', description: '研究跨会话的记忆保持。' },
                { label: '长上下文' },
              ],
            },
            {
              header: 'methods',
              question: '选择哪些研究方法？',
              multiSelect: true,
              options: [{ label: '实验' }, { label: '理论' }, { label: '调研' }],
            },
            { question: '补充研究约束', options: [] },
            { id: 'other', question: '其他偏好', options: [{ label: '默认方案' }] },
            { id: 'skipped', question: '可选说明', options: [{ label: '提供' }] },
          ],
          answers: {
            focus: '持久化记忆机制（推荐）',
            methods: '实验, 理论\n补充：保留已有基线',
            补充研究约束: '第一行约束\n第二行约束',
            other: '自定义研究方向',
          },
        },
      ],
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const open = (count: number): void => {
    const history: ConvItem[] = Array.from({ length: HISTORY_COUNT }, (_, index) => ({
      kind: 'user',
      text: `历史消息 ${index + 1}：保留此前的研究背景和讨论内容。`,
    }))
    const interaction: ConvItem = {
      kind: 'hil',
      requestId: REQUEST_ID,
      hilKind: 'question',
      startedAt: Date.now(),
      questions: [
        {
          id: REQUEST_ID,
          header: '精准检索授权',
          question: '是否允许下载、读取并使用已展示文献的全文作为证据？',
          options: [{ label: '一键授权 (Recommended)' }, { label: '拒绝' }],
          papers: Array.from({ length: count }, (_, index) => ({
            id: `paper-${index + 1}`,
            label: `文献 ${index + 1}：Long-Context Language Models and Evidence Retrieval in Research`,
          })),
        },
      ],
    }
    const thread: Thread = {
      id: SESSION_ID,
      title: '长文献确认',
      sessionId: SESSION_ID,
      lastSeq: 0,
      conversation: [...history, interaction],
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const stream = <Stream />
  return (
    <div
      className="flex h-screen min-h-0 flex-col"
      style={compact ? { height: COMPACT_HEIGHT } : undefined}
    >
      <div className={compact ? 'hidden' : 'flex-none'}>
        <Button onClick={() => open(LONG_PAPER_COUNT)}>长文献确认</Button>
        <Button onClick={() => open(1)}>短文献确认</Button>
        <Button onClick={openAnswered}>已完成回答</Button>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="conversation-layout"
      >
        {!compact &&
          (embedded ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{stream}</div>
          ) : (
            stream
          ))}
        <ConversationControls>
          <Textarea aria-label="消息" rows={4} />
          <Button>发送</Button>
        </ConversationControls>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <InteractionPolicyProvider policies={[preciseFulltextSubsetAuthorization]}>
        <StoreProvider assistantSources={[]}>
          <Fixture />
        </StoreProvider>
      </InteractionPolicyProvider>
    </ToastProvider>
  </I18nextProvider>
)
