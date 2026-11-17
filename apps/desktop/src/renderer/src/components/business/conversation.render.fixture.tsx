import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { PUBLIC_COMPONENT_FINGERPRINT, PUBLIC_COMPONENT_PLUGIN } from '../../../../plugins'
import { SKILL_CATALOG_CHANGED_EVENT } from '../../../../skills'
import '../../browser'
import '../../styles.css'
import { literatureFeature } from '../../features/literature/feature'
import { literaturePublicComponents } from '../../features/literature/Component'
import { fileRecovery, saveRecovery } from '../../features/assistant/recovery'
import { documentWorkspaces, DocumentWorkspaceContext } from '../../features/workbench/workspace'
import type { ConvItem, Thread, TurnOutcome } from '../../model'
import { describeTurnFailure } from '../../failures'
import { StoreProvider, useApp } from '../../store'
import { Button, Textarea, ToastProvider } from '../ui'
import { InteractionPolicyProvider } from './Interactions'
import { WebSearchRecord } from './Retrieval'
import { ProjectSourceLink } from '../../features/assistant/Links'
import { ConversationControls, Stream } from './Stream'
import { PublicComponentsContext } from './publicComponents'
import { DisplayCardProvider } from './Cards'

const localization = createLocalization('zh', resources, {
  report: () => undefined,
  escapeValue: false,
})
const SESSION_ID = 'conversation-layout'
const REQUEST_ID = 'precise-search-fulltext:layout'
const INSTALLATION_REQUEST_ID = 'generated-skill:layout'
const HISTORY_COUNT = 24
const LONG_PAPER_COUNT = 24
const COMPACT_HEIGHT = 160
const embedded = new URLSearchParams(location.search).has('embedded')
const compact = new URLSearchParams(location.search).has('compact')
const english = new URLSearchParams(location.search).has('english')
const attachmentOnly = new URLSearchParams(location.search).has('attachmentOnly')
const mixedReferences = new URLSearchParams(location.search).has('mixedReferences')
const structuredPlan = new URLSearchParams(location.search).has('structuredPlan')
const pluginQuestion = new URLSearchParams(location.search).has('pluginQuestion')
const copyCollapse = new URLSearchParams(location.search).get('copyCollapse')
const cancelledQuestion = new URLSearchParams(location.search).get('cancelledQuestion')
const batchTiming = new URLSearchParams(location.search).get('batchTiming')
const publicComponents = new Map(
  literaturePublicComponents.map((component) => [component.slot, component])
)
if (english) void localization.changeLanguage('en')
if (new URLSearchParams(location.search).has('dark'))
  document.documentElement.dataset.theme = 'dark'

export function Fixture(): React.JSX.Element {
  const { set, patchThread } = useApp()
  const [streamRevision, setStreamRevision] = useState(0)
  const [scrollControlTarget, setScrollControlTarget] = useState<HTMLDivElement | null>(null)
  const scrollControlScenario = new URLSearchParams(location.search).has('scrollControl')
  const pdfReferences = new URLSearchParams(location.search).has('pdfReferences')
  const openGeometry = (): void => {
    const conversation: ConvItem[] = Array.from({ length: 20 }, (_, index) => [
      {
        kind: 'user' as const,
        text: `公开问题 ${index}`,
        itemId: `user-${index}`,
        turnId: `turn-${index}`,
      },
      {
        kind: 'agent' as const,
        text: `公开历史 ${index} ` + '宽度变化下的长历史。'.repeat(80),
        itemId: `agent-${index}`,
        turnId: `turn-${index}`,
      },
      {
        kind: 'tool' as const,
        toolId: `tool-${index}`,
        name: 'Read',
        status: 'done' as const,
        turnId: `turn-${index}`,
      },
    ]).flat()
    conversation.push({
      kind: 'agent',
      text: '正在整理公开结果。',
      itemId: 'tail',
      turnId: 'active',
    })
    set({
      activeSession: SESSION_ID,
      threads: {
        [SESSION_ID]: {
          id: SESSION_ID,
          sessionId: SESSION_ID,
          title: '组合几何',
          lastSeq: 1,
          running: true,
          status: 'running',
          turnOutcomes: { active: 'running' },
          conversation,
        },
      },
    })
  }
  const openSkillReferences = (): void => {
    set({
      backendReady: true,
      activeSession: SESSION_ID,
      threads: {
        [SESSION_ID]: {
          id: SESSION_ID,
          sessionId: SESSION_ID,
          title: '技能引用',
          lastSeq: 0,
          conversation: [
            {
              kind: 'user',
              text: '技能名称验收',
              refs: [
                {
                  type: 'skill',
                  id: 'precise-literature-search',
                  title: 'precise-literature-search',
                },
                { type: 'skill', id: 'literature-review', title: 'literature-review' },
                { type: 'skill', id: 'external-skill', title: '自定义历史标题' },
                { type: 'file', id: 'precise-literature-search', title: '原始文件标题' },
                ...(pdfReferences
                  ? [
                      {
                        type: 'assistant_context',
                        kind: 'pdf_comment',
                        id: 'pdf-comment',
                        sourceId: 'pdf-comment:v1:WyJkZW1vIl0',
                        title: 'PDF · 1',
                      },
                      {
                        type: 'assistant_context',
                        kind: 'pdf_comment',
                        id: 'untitled-comment',
                        sourceId: 'pdf-comment:v1:WyJ0ZXN0Il0',
                        title: '',
                      },
                      {
                        type: 'assistant_context',
                        kind: 'resource',
                        id: 'pdf-file',
                        sourceId: 'resources/demo.pdf',
                        title: 'Resource title',
                      },
                    ]
                  : []),
                ...(mixedReferences
                  ? [
                      {
                        type: 'assistant_context',
                        kind: 'session',
                        id: 'mixed-session',
                        sourceId: 'source-task',
                        title: 'Source task for mixed references',
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      },
    })
  }
  const openInstallation = (): void => {
    const turnId = 'installation-turn'
    const conversation: ConvItem[] = [
      { kind: 'user', text: '生成一个技能', turnId },
      ...Array.from({ length: HISTORY_COUNT }, (_, index): ConvItem => ({
        kind: 'agent',
        text: `安装前日志 ${index + 1}`,
        turnId,
      })),
      {
        kind: 'hil',
        hilKind: 'question',
        hilState: 'pending',
        requestId: INSTALLATION_REQUEST_ID,
        blocking: false,
        turnId,
        questions: [
          {
            id: INSTALLATION_REQUEST_ID,
            question: 'generated-skill',
            options: [],
            installation: {
              valid: true,
              sha256: 'a'.repeat(64),
              issues: [],
              dependencies: {},
              descriptor: {
                id: 'generated-skill',
                version: '0.1.0',
                capabilities: [],
                components: [],
              },
            },
          },
        ],
      },
    ]
    const thread: Thread = {
      id: SESSION_ID,
      sessionId: SESSION_ID,
      title: '技能安装',
      lastSeq: 0,
      running: true,
      status: 'running',
      turnOutcomes: { [turnId]: 'running' },
      conversation,
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const openProcesses = (outcome: TurnOutcome | undefined, waiting = false): void => {
    const turnId = 'process-turn'
    const conversation: ConvItem[] = [
      {
        kind: 'tool',
        toolId: 'before',
        name: 'Read',
        status: 'done',
        turnId,
        input: { command: 'cat research.md' },
        result: 'Research evidence\n'.repeat(80),
        startedAt: batchTiming === 'missing' ? undefined : 1000,
        completedAt: batchTiming === 'missing' ? undefined : batchTiming ? 41000 : 2000,
      },
      { kind: 'thinking', text: '隐藏的思考详情', completed: true, turnId },
      {
        kind: 'tool',
        toolId: 'failed-step',
        name: 'Command',
        status: 'error',
        exitCode: 2,
        result: 'Failed command',
        turnId,
        ...(batchTiming && batchTiming !== 'missing'
          ? {
              startedAt: batchTiming === 'serial' ? 61000 : 11000,
              completedAt: batchTiming === 'serial' ? 91000 : 61000,
            }
          : {}),
      },
      { kind: 'thinking', text: '工具外说明', commentary: true, completed: true, turnId },
      {
        kind: 'hil',
        requestId: 'start-confirmation',
        hilKind: 'question',
        hilState: 'resolved',
        resolved: '开始',
        turnId,
        questions: [{ id: 'start', question: '是否开始？', options: [{ label: '开始' }] }],
        answers: { start: '开始' },
      },
      { kind: 'tool', toolId: 'after', name: 'Search', status: 'done', turnId },
      { kind: 'agent', text: '已发布候选结果。', turnId },
      {
        kind: 'tool',
        toolId: 'read-fulltext',
        name: 'Read',
        status:
          !batchTiming || outcome === 'completed'
            ? 'done'
            : outcome === 'running'
              ? 'running'
              : 'cancelled',
        turnId,
        ...(batchTiming && batchTiming !== 'missing'
          ? { startedAt: 91000, ...(outcome === 'running' ? {} : { completedAt: 101000 }) }
          : {}),
      },
    ]
    if (waiting)
      conversation.push({
        kind: 'hil',
        requestId: 'fulltext-confirmation',
        hilKind: 'question',
        hilState: 'pending',
        turnId,
        questions: [
          structuredPlan
            ? {
                id: 'plan-review:fixture',
                header: '综述执行方案',
                question: '旧客户端使用的完整方案文本',
                presentation: {
                  kind: 'question-fields',
                  title: '综述执行方案',
                  summary: '综述 AI 智能体在科研工作流中的应用。',
                  fields: [
                    { label: '交付格式', value: 'Markdown' },
                    { label: '发表区间', value: '2023–2026' },
                  ],
                  notice: '五分钟未回复将按已展示方案执行。',
                },
                options: [{ label: '按此方案执行' }],
              }
            : {
                id: 'read',
                ...(pluginQuestion
                  ? {
                      component: {
                        plugin: PUBLIC_COMPONENT_PLUGIN,
                        component: 'interaction.question',
                        fingerprint: PUBLIC_COMPONENT_FINGERPRINT,
                      },
                    }
                  : {}),
                question: '是否读取？',
                options: [{ label: '允许' }, { label: '拒绝' }],
              },
        ],
      })
    set({
      activeSession: SESSION_ID,
      threads: {
        [SESSION_ID]: {
          id: SESSION_ID,
          sessionId: SESSION_ID,
          title: '执行状态',
          lastSeq: 0,
          conversation,
          running: outcome === 'running',
          status: waiting ? 'waiting' : outcome === 'running' ? 'running' : 'done',
          turnOutcomes: outcome ? { [turnId]: outcome } : {},
          planSnapshots: [
            {
              sequence: 1,
              turnId,
              timestamp: 1000,
              released: false,
              items: [{ content: '保留未勾步骤', status: 'pending' }],
            },
          ],
          turnTimings: {
            [turnId]: {
              startedAt: 1000,
              ...(outcome === 'running' || outcome === undefined ? {} : { completedAt: 126000 }),
            },
          },
        },
      },
    })
  }
  const openPermission = (): void => {
    const thread: Thread = {
      id: SESSION_ID,
      title: '权限确认',
      sessionId: SESSION_ID,
      lastSeq: 0,
      conversation: [
        {
          kind: 'hil',
          requestId: 'command-permission',
          hilKind: 'command_approval',
          command: 'echo authorization-preview',
          reason: '验证命令授权',
          options: [
            { id: 'accept', label: 'Allow' },
            { id: 'acceptForSession', label: 'Session' },
            { id: 'decline', label: 'Deny' },
          ],
        },
      ],
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const openRecovery = (writing: boolean): void => {
    const thread: Thread = {
      id: SESSION_ID,
      title: '文件恢复',
      sessionId: SESSION_ID,
      lastSeq: 0,
      conversation: [
        {
          kind: 'hil',
          requestId: 'file-recovery:fixture',
          hilKind: 'question',
          hilState: 'pending',
          questions: [
            {
              id: 'file-recovery:fixture',
              header: writing ? 'file_write_denied' : 'file_read_failed',
              question: writing ? '组会材料' : 'resources/broken.pdf',
              options: [
                { label: 'retry_file' },
                { label: writing ? 'cancel_save' : 'remove_file' },
              ],
            },
          ],
        },
      ],
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const openAnswered = (componentHistory = false, expired = false): void => {
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
          hilState: expired ? 'stale' : 'resolved',
          resolved: expired ? undefined : '已回答',
          questions: [
            {
              id: 'focus',
              ...(componentHistory
                ? {
                    component: {
                      plugin: 'fixture-history',
                      component: 'history',
                      fingerprint: 'history',
                      binding: 'history',
                    },
                  }
                : english || copyCollapse
                  ? {
                      component: {
                        plugin: PUBLIC_COMPONENT_PLUGIN,
                        component: 'interaction.question',
                        fingerprint: PUBLIC_COMPONENT_FINGERPRINT,
                        ...(copyCollapse ? {} : { binding: 'native-question' }),
                      },
                    }
                  : {}),
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
          answers: expired
            ? undefined
            : {
                focus: componentHistory
                  ? '持久化记忆机制（推荐）'
                  : '持久化记忆机制（推荐）\n聚焦跨会话',
                methods: '实验, 理论\n补充：保留已有基线',
                补充研究约束: '第一行约束\n第二行约束',
                other: '自定义研究方向',
              },
          answerDetails:
            !expired && !componentHistory
              ? {
                  focus: { option_indices: [0], text: '聚焦跨会话' },
                  methods: { option_indices: [0, 1], text: '补充：保留已有基线' },
                }
              : undefined,
        },
      ],
    }
    if (copyCollapse) {
      const turnId = 'answered-turn'
      const question = thread.conversation[0]
      question.turnId = turnId
      thread.turnOutcomes = {
        [turnId]:
          copyCollapse === 'running'
            ? 'running'
            : copyCollapse === 'interrupted'
              ? 'interrupted'
              : 'completed',
      }
      thread.running = copyCollapse === 'running'
      if (copyCollapse === 'mixed')
        thread.conversation.push({ kind: 'agent', turnId, text: '保留普通回答正文。' })
      if (copyCollapse === 'multi' && question.kind === 'hil')
        thread.conversation.push({ ...question, requestId: 'second-answered-questions' })
      if (copyCollapse === 'other')
        thread.conversation.push({
          kind: 'review',
          turnId,
          review: {
            batchId: 'copy-review',
            projectId: '',
            fileIds: [],
            reviewIds: [],
            paths: ['output/report.md'],
          },
        })
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const open = (count: number, showInteraction = true): void => {
    const history: ConvItem[] = Array.from({ length: HISTORY_COUNT }, (_, index) => ({
      kind: 'user',
      text: `历史消息 ${index + 1}：保留此前的研究背景和讨论内容。`,
    }))
    if (attachmentOnly) {
      history.push({
        kind: 'user',
        text: ' \n ',
        refs: [
          { type: 'file', id: 'attachment-only', path: '/tmp/report.docx', title: 'report.docx' },
        ],
      })
    }
    const interaction: ConvItem = {
      kind: 'hil',
      requestId: REQUEST_ID,
      hilKind: 'question',
      ...(cancelledQuestion
        ? { hilState: 'cancelled' as const, resolved: '不读取全文，并停止本次全文处理。' }
        : {}),
      startedAt: Date.now(),
      questions: [
        {
          id: REQUEST_ID,
          ...(cancelledQuestion === 'authorization'
            ? {
                component: {
                  plugin: PUBLIC_COMPONENT_PLUGIN,
                  component: 'literature.authorization',
                  fingerprint: PUBLIC_COMPONENT_FINGERPRINT,
                  binding: 'cancelled-authorization',
                },
              }
            : {}),
          header: cancelledQuestion === 'generic' ? '普通问题' : '精准检索授权',
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
      conversation: showInteraction ? [...history, interaction] : history,
    }
    set({ activeSession: SESSION_ID, threads: { [SESSION_ID]: thread } })
  }
  const stream = (
    <DocumentWorkspaceContext.Provider value={documentWorkspaces.forProject(SESSION_ID)}>
      <DisplayCardProvider
        cards={new Map(literatureFeature().displayCards?.map((card) => [card.type, card]))}
        publicComponents={publicComponents}
      >
        <Stream key={streamRevision} scrollControlTarget={scrollControlTarget} />
      </DisplayCardProvider>
    </DocumentWorkspaceContext.Provider>
  )
  return (
    <div
      className="flex h-screen min-h-0 flex-col"
      style={compact ? { height: COMPACT_HEIGHT } : undefined}
    >
      <div className={compact ? 'hidden' : 'flex-none'}>
        {new URLSearchParams(location.search).has('runtimeFailure') && (
          <Button
            onClick={() => {
              const notice: ConvItem = {
                kind: 'status',
                text: { key: 'runtime.failed' },
                incidentId: 'provider',
                turnId: 'failed-turn',
              }
              const mode = new URLSearchParams(location.search).get('runtimeFailure')
              const card: ConvItem = {
                ...describeTurnFailure({
                  message: 'provider failed',
                  incident_id: mode === 'independent' ? 'other' : 'provider',
                  retryable: true,
                }),
                turnId: 'failed-turn',
              }
              set({
                activeSession: SESSION_ID,
                threads: {
                  [SESSION_ID]: {
                    id: SESSION_ID,
                    title: 'Runtime failure',
                    sessionId: SESSION_ID,
                    lastSeq: 0,
                    running: false,
                    status: 'failed',
                    turnOutcomes: { 'failed-turn': 'failed' },
                    conversation:
                      mode === 'alone'
                        ? [notice]
                        : mode === 'reversed'
                          ? [card, notice]
                          : [notice, card],
                  },
                },
              })
            }}
          >
            Runtime failure
          </Button>
        )}
        {new URLSearchParams(location.search).has('geometry') && (
          <>
            <Button onClick={openGeometry}>组合历史</Button>
            <Button
              onClick={() =>
                set((current) => ({
                  aiPanel: {
                    ...current.aiPanel,
                    messageFocus: { sessionId: SESSION_ID, itemId: 'tail' },
                  },
                }))
              }
            >
              聚焦末条
            </Button>
            <Button
              onClick={() =>
                patchThread(SESSION_ID, (thread) => ({
                  conversation: [
                    ...thread.conversation,
                    {
                      kind: 'tool',
                      toolId: 'active-tool',
                      name: 'Read',
                      status: 'running',
                      turnId: 'active',
                    },
                  ],
                }))
              }
            >
              新增运行工具
            </Button>
            <Button
              onClick={() =>
                patchThread(SESSION_ID, (thread) => ({
                  conversation: [
                    ...thread.conversation,
                    {
                      kind: 'display_card',
                      itemId: 'geometry-card',
                      turnId: 'active',
                      card: {
                        cardId: 'geometry-card',
                        type: 'literature-search',
                        content: {
                          schema_version: '1.0',
                          session_id: SESSION_ID,
                          status: 'success',
                          papers: [{ id: 'public-paper', title: 'Public geometry result' }],
                          criteria: [],
                          sources: [],
                          warnings: [],
                          retained: 1,
                        },
                      },
                    },
                  ],
                }))
              }
            >
              新增结果卡
            </Button>
          </>
        )}
        <Button onClick={() => open(LONG_PAPER_COUNT)}>长文献确认</Button>
        <Button onClick={() => open(1)}>短文献确认</Button>
        {scrollControlScenario && <Button onClick={() => open(1, false)}>滚动历史</Button>}
        <Button onClick={() => openAnswered()}>已完成回答</Button>
        <Button onClick={() => openAnswered(true)}>组件历史回答</Button>
        <Button onClick={() => openAnswered(true, true)}>过期澄清</Button>
        <Button onClick={openPermission}>权限确认</Button>
        <Button onClick={() => openRecovery(false)}>文件无法读取</Button>
        <Button onClick={() => openRecovery(true)}>没有文件夹权限</Button>
        <Button onClick={() => openProcesses('running')}>分段执行</Button>
        <Button
          onClick={() =>
            set({
              activeSession: SESSION_ID,
              threads: {
                [SESSION_ID]: {
                  id: SESSION_ID,
                  sessionId: SESSION_ID,
                  title: '无计划工具间隙',
                  lastSeq: 0,
                  running: true,
                  status: 'running',
                  turnOutcomes: { gap: 'running' },
                  conversation: [
                    {
                      kind: 'tool',
                      toolId: 'settled',
                      name: 'Read',
                      status: 'done',
                      turnId: 'gap',
                    },
                    {
                      kind: 'thinking',
                      commentary: true,
                      completed: true,
                      text: '准备完成',
                      turnId: 'gap',
                    },
                  ],
                },
              },
            })
          }
        >
          无计划工具间隙
        </Button>
        <Button onClick={() => openProcesses('running', true)}>等待确认</Button>
        <Button onClick={() => openProcesses('completed')}>执行完成</Button>
        <Button onClick={() => openProcesses('failed')}>执行失败</Button>
        <Button onClick={() => openProcesses('interrupted')}>执行中断</Button>
        <Button onClick={() => openProcesses('unknown')}>结果未知</Button>
        <Button onClick={() => openProcesses(undefined)}>历史加载</Button>
        <Button onClick={openInstallation}>技能安装</Button>
        <Button onClick={openSkillReferences}>技能引用</Button>
        <Button onClick={() => set({ activeSession: null, threads: {} })}>切换新任务</Button>
        <Button onClick={() => setStreamRevision((revision) => revision + 1)}>重建消息流</Button>
        <Button onClick={() => window.dispatchEvent(new Event(SKILL_CATALOG_CHANGED_EVENT))}>
          更新技能目录
        </Button>
        <Button
          onClick={() =>
            void localization.changeLanguage(localization.language === 'zh' ? 'en' : 'zh')
          }
        >
          切换界面语言
        </Button>
        <Button
          onClick={() =>
            patchThread(SESSION_ID, (thread) => ({
              conversation: [
                ...thread.conversation,
                { kind: 'agent', text: '安装后日志', turnId: 'installation-turn' },
              ],
            }))
          }
        >
          追加日志
        </Button>
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
          {scrollControlScenario && (
            <div className="relative mx-auto w-full max-w-[760px]" ref={setScrollControlTarget}>
              <Button data-testid="todo-toggle">执行步骤 7 / 7 · 32 分 40 秒</Button>
            </div>
          )}
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
      <InteractionPolicyProvider
        policies={[...(literatureFeature().interactionPolicies ?? []), fileRecovery, saveRecovery]}
      >
        <PublicComponentsContext.Provider value={publicComponents}>
          <StoreProvider assistantSources={[]}>
            {new URLSearchParams(location.search).has('project-source') ? (
              <div className="max-w-[var(--vds-assistant-citation-panel-width)]">
                <ProjectSourceLink
                  name="TH167-甲-完整的原始无页码文本与复核记录-长文件名.txt"
                  onOpen={() => {
                    document.body.dataset.openedSource = 'first'
                  }}
                />
                <ProjectSourceLink
                  name="TH167-乙-复核记录.pdf"
                  onOpen={() => {
                    document.body.dataset.openedSource = 'second'
                  }}
                />
              </div>
            ) : new URLSearchParams(location.search).has('retrieval') ? (
              <WebSearchRecord
                title="网页检索"
                queries={[
                  'Experimental evidence on the productivity effects of generative artificial intelligence.pdf',
                  'generative AI productivity writing customer support',
                ]}
                results={Array.from(
                  { length: Number(new URLSearchParams(location.search).get('resultCount') ?? 16) },
                  (_, index) => ({
                    id: String(index),
                    title:
                      'Experimental evidence on the productivity effects of generative artificial intelligence.pdf',
                    url: `https://example.org/${index}`,
                    site: 'MIT News',
                  })
                )}
                onOpenResult={() => {
                  throw new Error('Unavailable')
                }}
              />
            ) : (
              <Fixture />
            )}
          </StoreProvider>
        </PublicComponentsContext.Provider>
      </InteractionPolicyProvider>
    </ToastProvider>
  </I18nextProvider>
)
