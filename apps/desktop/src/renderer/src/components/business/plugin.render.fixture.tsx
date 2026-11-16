import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../browser'
import { StoreProvider, useApp } from '../../store'
import { StoreContext } from '../../storeContext'
import { WebNavigationContext } from '../../contracts/navigation'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import zhSkills from '../../../../localization/locales/zh/skills.json'
import zhComponents from '../../../../localization/locales/zh/components.json'
import zhConversation from '../../../../localization/locales/zh/conversation.json'
import { PluginPreview, type PluginPreviewRequest } from './Plugin'
import { ComponentFrame, PluginInteraction } from './Frame'
import { RegisteredContent } from './Declarative'
import { ReplyCopy } from './Copy'
import { CopySessionContext } from './clipboard'
import { PublicComponentsContext } from './publicComponents'
import { literaturePublicComponents } from '../../features/literature/Component'
import { LiteratureComponent } from '../../features/literature/Component'
import { LiteratureAuthorizationCard } from '../../features/literature/Scope'
import { LiteratureCard } from '../../features/literature/Card'
import { LiteratureResultTab } from '../../features/literature/Results'
import reviewScenario from '../../../../../../../skills/community/literature-review/components/review.json'
import { HilCard, type HilController } from './Stream'
import { InteractionPolicyProvider } from './Interactions'
import { preciseFulltextSubsetAuthorization } from '../../features/literature/interaction'
import type { ConvItem, Thread } from '../../model'
import zhLiterature from '../../../../localization/locales/zh/literature.json'
import { Button, Textarea, ToastProvider } from '../ui'
import zhUi from '../../../../localization/locales/zh/ui.json'
import {
  PLUGIN_MESSAGE_CHANNEL,
  PUBLIC_COMPONENT_FINGERPRINT,
  type PluginComponent,
  type PluginMount,
  type PluginReference,
  type PluginReport,
  type PluginCopyContent,
} from '../../../../plugins'

const listeners = new Set<(lease: string) => void>()
const released: string[] = []
const created: string[] = []
const requests: unknown[] = []
let installationStatus = 'pending'
let installationFailure = new URLSearchParams(location.search).has('fail-install')
let validationFailure = new URLSearchParams(location.search).has('fail-validation')
const installationReceipt = {
  name: 'generated-plugin',
  version: '1.0.0',
  enabled: true,
  sha256: 'a'.repeat(64),
}
const installationReport: PluginReport = {
  valid: true,
  candidate: 'candidate',
  sha256: 'a'.repeat(64),
  issues: [],
  dependencies: {},
  descriptor: {
    id: 'generated-plugin',
    version: '1.0.0',
    capabilities: ['interaction.answer'],
    components: [],
  },
}
const pending: (() => void)[] = []
let savedDraft: Record<string, unknown> = {}
let savedRevision = 0
let savedCopy: PluginCopyContent | null = null
const copied: string[] = []
const mode = new URLSearchParams(location.search).get('mode')
if (mode === 'legacy-bound') savedDraft = { selected_paper_ids: ['one'] }
if (mode === 'external-native') savedDraft = { selected_paper_ids: ['one'] }
const lease = 'fixture-lease'
const component: PluginComponent = {
  id: 'selection',
  entry: 'selection.js',
  preview: 'scenario.json',
  actions: [{ id: 'select', capability: 'interaction.answer' }],
}
if (mode === 'installation') installationReport.descriptor!.components = [component]
if (mode === 'readonly') component.actions = []
const mount = {
  descriptor: {
    schema: 2,
    id: 'fixture',
    version: '1.0.0',
    host: '>=0.2.0',
    skill: 'SKILL.md',
    capabilities: ['interaction.answer'],
    components: [component],
  },
  fingerprint: 'fixture',
  scenarios: { selection: { data: {}, responses: { select: { state: 'resolved', data: {} } } } },
  frames: { selection: { lease, url: `/guest.html?lease=${lease}` } },
} as PluginMount
const draftBoundaryData = { fields: [{ id: 'notes', label: '研究约束' }] }
if (mode === 'draft-preview') mount.scenarios.selection.data = draftBoundaryData
if (mode === 'external-public' || mode === 'external-native') {
  component.id = 'literature.selection'
  component.slot = 'literature.selection'
  component.public = true
  mount.descriptor.id = 'host'
  mount.fingerprint = 'ui-release-one'
}
if (mode === 'action-retry') {
  mount.scenarios.selection.responses.select.steps = [
    { state: 'failed', data: { error: 'sample_failure' } },
  ]
}
if (mode === 'action-cancel' || mode === 'action-cancel-retry') {
  mount.scenarios.selection.responses.select = {
    state: 'cancelled',
    data: {},
    ...(mode === 'action-cancel-retry'
      ? { steps: [{ state: 'failed' as const, data: { error: 'sample_failure' } }] }
      : {}),
  }
}
if (mode === 'interaction') {
  component.actions = [{ id: 'choose', capability: 'interaction.answer' }]
  const questions = [
    {
      id: 'direction',
      header: '研究方向',
      question: '选择研究方向',
      options: [{ label: '继续检索' }],
    },
  ]
  mount.scenarios.selection = {
    data: {},
    responses: { choose: { state: 'resolved', data: {} } },
    interaction: { questions },
    cases: [
      {
        label: '失败重试',
        interaction: {
          questions,
          respond: [{ state: 'failed', data: { error: 'sample_failure' } }],
        },
      },
      {
        label: '结果未知',
        interaction: { questions, respond: [{ state: 'failed', data: { outcome: 'unknown' } }] },
      },
      {
        label: '请求过期',
        interaction: { questions, respond: [{ state: 'failed', data: { outcome: 'stale' } }] },
      },
    ],
  }
}
Object.assign(window, {
  scholarseed: {
    ...window.scholarseed,
    async writeClipboard(text: string) {
      if (location.search.includes('clipboard-failed'))
        return { ok: false, error: 'clipboard_write_failed' }
      copied.push(text)
      return { ok: true }
    },
    onPluginRevoked(callback: (value: string) => void) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    async deviceSkills(request: {
      operation: string
      action?: string
      leases?: string[]
      lease?: string
      reference?: PluginReference
      values?: Record<string, unknown>
      expected_revision?: number
      content?: PluginCopyContent
    }) {
      requests.push(request)
      if (request.operation === 'plugin-copy') {
        if (request.content) {
          if (request.expected_revision !== savedRevision) return { status: 409, body: '{}' }
          savedCopy = request.content
        }
        return {
          status: 200,
          body: JSON.stringify({ content: savedCopy, revision: savedRevision }),
        }
      }
      if (request.operation === 'plugin-validate') {
        const failed = validationFailure
        validationFailure = false
        return {
          status: 200,
          body: JSON.stringify(
            failed
              ? {
                  valid: false,
                  authorized: false,
                  error: 'component_value_invalid',
                  detail: { layer: 'component.output_schema', schema_path: ['required'] },
                }
              : { valid: true, authorized: false }
          ),
        }
      }
      if (request.operation === 'plugin-delivery') {
        if (request.action === 'skip') installationStatus = 'skipped'
        return {
          status: 200,
          body: JSON.stringify({
            status: installationStatus,
            ...(installationStatus === 'installed' ? { receipt: installationReceipt } : {}),
            ...(request.action === 'check'
              ? {
                  report: installationReport,
                  preview: {
                    name: 'generated-plugin',
                    description: 'Generated description',
                    document: '---\nname: generated-plugin\n---\n\n# Generated instructions',
                    version: '1.0.0',
                    plugin: true,
                  },
                }
              : {}),
          }),
        }
      }
      if (request.operation === 'plugin-draft') {
        if (request.expected_revision !== savedRevision) return { status: 409, body: '{}' }
        savedDraft = request.values!
        savedCopy = null
        return {
          status: 200,
          body: JSON.stringify({ state: savedDraft, revision: ++savedRevision }),
        }
      }
      if (request.operation === 'plugin-confirm') {
        if (installationFailure) {
          installationFailure = false
          installationStatus = 'failed'
          return { status: 422, body: 'installation_failed' }
        }
        installationStatus = 'installed'
        return {
          status: 200,
          body: JSON.stringify({
            installed: { name: 'generated-plugin' },
            enabled: true,
            receipt: {
              name: 'generated-plugin',
              version: '1.0.0',
              enabled: true,
              sha256: 'a'.repeat(64),
            },
          }),
        }
      }
      if (request.operation.startsWith('plugin-preview') || request.operation === 'plugin-open') {
        const nextLease = `lease-${created.length}`
        created.push(nextLease)
        await new Promise<void>((resolve) => pending.push(resolve))
        if (mode === 'external-public' || mode === 'external-native')
          return {
            status: 200,
            body: JSON.stringify({
              ...mount,
              frames: {
                [component.id]: { lease: nextLease, url: `/guest.html?lease=${nextLease}` },
              },
              interaction: {
                state: savedDraft,
                revision: savedRevision,
                data: {},
                status: 'pending',
                session_id: 'public-session',
                turn_id: 'turn',
              },
            }),
          }
        if (request.reference?.plugin === 'host')
          return {
            status: 200,
            body: JSON.stringify({
              descriptor: {
                id: 'host',
                version: PUBLIC_COMPONENT_FINGERPRINT,
                capabilities: ['interaction.answer'],
                components: [
                  {
                    id: request.reference.component,
                    slot: request.reference.component,
                    public: true,
                    preview: '',
                    actions: [],
                  },
                ],
              },
              fingerprint: PUBLIC_COMPONENT_FINGERPRINT,
              frames: {},
              scenarios: {},
              interaction: {
                state: savedDraft,
                revision: savedRevision,
                data: {},
                status: 'pending',
                session_id: 'public-session',
                turn_id: 'turn',
              },
            }),
          }
        return {
          status: 200,
          body: JSON.stringify({
            ...mount,
            frames: { selection: { lease: nextLease, url: `/guest.html?lease=${nextLease}` } },
            ...(mode === 'copy' || mode === 'draft-boundary' || mode === 'history'
              ? {
                  interaction: {
                    state: savedDraft,
                    revision: savedRevision,
                    data: mode === 'history' ? { title: 'Bound graph' } : {},
                    status: 'pending',
                    session_id: 'copy-session',
                    turn_id: 'turn',
                  },
                }
              : {}),
          }),
        }
      }
      if (request.operation === 'plugin-release') {
        released.push(...request.leases!)
        queueMicrotask(() => {
          for (const value of request.leases!) for (const callback of listeners) callback(value)
        })
      }
      return { status: released.includes(request.lease || lease) ? 410 : 200, body: '{}' }
    },
  },
  fixture: {
    copied,
    released,
    created,
    requests,
    get draft() {
      return structuredClone(savedDraft)
    },
    channel: PLUGIN_MESSAGE_CHANNEL,
    resolve: () => pending.splice(0).forEach((resolve) => resolve()),
    revoke: () => {
      for (const callback of listeners) callback(created.at(-1)!)
    },
  },
})
const localization = createLocalization(
  'zh',
  {
    zh: {
      skills: zhSkills,
      components: zhComponents,
      conversation: zhConversation,
      literature: zhLiterature,
      ui: zhUi,
    },
  },
  { report: () => undefined }
)
const publicComponents = new Map(
  literaturePublicComponents.map((component) => [component.slot, component])
)

function PublicFixture() {
  const fixture = (
    window as unknown as {
      publicFixture: {
        slot: string
        data: Record<string, unknown>
        request: (action: string, values: Record<string, unknown>) => Promise<unknown>
      }
    }
  ).publicFixture
  const [data, setData] = useState(fixture.data)
  return (
    <LiteratureComponent
      slot={fixture.slot}
      data={data}
      status="pending"
      onAction={(_action, values) => setData((current) => ({ ...current, ...values }))}
      onRequest={(action, values) => fixture.request(action, values)}
    />
  )
}

function GenericFixture() {
  const installation: PluginReport = {
    valid: true,
    candidate: 'candidate',
    sha256: 'a'.repeat(64),
    issues: [],
    dependencies: {},
    descriptor: {
      id: 'generated-plugin',
      version: '1.0.0',
      capabilities: ['interaction.answer'],
      components: [component],
    },
  }
  const question =
    mode === 'installation'
      ? { id: 'question', question: 'generated-plugin', options: [], installation }
      : {
          id: 'question',
          question: '科研组件',
          options: [],
          component: {
            plugin: 'fixture',
            component: 'selection',
            fingerprint: 'fixture',
            binding: 'fixed-binding',
          },
          componentData: {},
        }
  const questions =
    mode === 'pagination'
      ? [
          {
            id: 'goal',
            question: '选择阅读目标',
            options: [
              { label: '理解方法', description: '关注假设和方法细节' },
              { label: '复现实验' },
            ],
          },
          {
            id: 'depth',
            question: '选择阅读深度',
            options: [{ label: '深入阅读' }, { label: '快速浏览' }],
          },
        ]
      : mode === 'authorization'
        ? [
            {
              id: 'precise-search-fulltext:fixture',
              header: '精准检索授权',
              question: '是否授权读取所选论文全文？',
              options: [{ label: '一键授权' }, { label: '拒绝' }],
              papers: [
                { id: 'one', label: '论文一' },
                { id: 'two', label: '论文二' },
              ],
            },
          ]
        : [question]
  const [thread, setThread] = useState<Thread>({
    id: 'generic',
    sessionId: 'generic',
    title: '',
    lastSeq: 0,
    conversation: [
      {
        kind: 'hil',
        requestId: 'question',
        sessionId: 'generic',
        hilKind: 'question',
        hilState: 'pending',
        questions,
      },
    ],
  })
  const controller: HilController = {
    sessionId: 'generic',
    threadId: 'generic',
    patchThread: (_id, patch) =>
      setThread((current) => ({
        ...current,
        ...(typeof patch === 'function' ? patch(current) : patch),
      })),
    respond: async (_session, request, body) => {
      requests.push(body)
      return { ok: true, request_id: request }
    },
    interrupt: async () => ({ ok: true }),
  }
  return (
    <InteractionPolicyProvider policies={[preciseFulltextSubsetAuthorization]}>
      <HilCard
        item={thread.conversation[0] as Extract<ConvItem, { kind: 'hil' }>}
        controller={controller}
        presentation={mode === 'pagination' ? 'dock' : undefined}
      />
    </InteractionPolicyProvider>
  )
}

function BoundPublicFixture() {
  const [opened, setOpened] = useState(true)
  const [answers, setAnswers] = useState<string[]>([])
  const [text, setText] = useState('')
  return (
    <>
      <Button
        onClick={() => {
          setOpened((current) => !current)
          setAnswers([])
          setText('')
        }}
      >
        重新挂载
      </Button>
      {opened && (
        <PluginInteraction
          reference={{
            plugin: 'host',
            fingerprint: PUBLIC_COMPONENT_FINGERPRINT,
            component: 'interaction.question',
            binding: 'public-binding',
          }}
          data={{ options: [{ label: '方法一' }, { label: '方法二' }], answers }}
          status="pending"
          onRestore={(values) => {
            setAnswers(values.answers as string[])
            setText(String(values.text ?? ''))
          }}
          onAction={(_action, values) => setAnswers(values.answers as string[])}
          supplement={(save) => (
            <Textarea
              aria-label="说明"
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                void save({ text: event.target.value })
              }}
            />
          )}
        />
      )}
      <p data-testid="public-selection">{answers.join(',')}</p>
    </>
  )
}

function LegacySelectionFixture() {
  const [opened, setOpened] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const bound = mode === 'legacy-bound'
  const reference = {
    plugin: 'host',
    fingerprint: 'host-v1',
    component: 'literature.selection',
    ...(bound ? { binding: 'legacy-binding' } : {}),
  }
  const legacyPreview = {
    descriptor: {
      id: 'host',
      version: 'host-v1',
      capabilities: ['interaction.answer'],
      components: [
        {
          id: 'literature.selection',
          slot: 'literature.selection',
          public: true,
          preview: '',
          actions: [],
        },
      ],
    },
    fingerprint: 'host-v1',
    frames: {},
    scenarios: {},
  } as PluginMount
  return (
    <>
      <Button
        onClick={() => {
          setOpened((value) => !value)
          setSelected([])
        }}
      >
        重新挂载
      </Button>
      {opened && (
        <PluginInteraction
          reference={reference}
          previewMount={bound ? undefined : legacyPreview}
          data={{
            papers: [
              { id: 'one', label: '旧论文一', description: '旧证据说明' },
              { id: 'two', label: '旧论文二' },
            ],
            selected_paper_ids: selected,
          }}
          status="pending"
          onRestore={(values) => setSelected(values.selected_paper_ids as string[])}
          onAction={(_action, values) => setSelected(values.selected_paper_ids as string[])}
        />
      )}
      <p data-testid="legacy-selection">{selected.join(',')}</p>
    </>
  )
}
function ReviewFixture(): React.JSX.Element {
  const app = useApp()
  const [target, setTarget] = useState<Parameters<typeof app.act.openFilePreview>[0] | null>(null)
  const [webTarget, setWebTarget] = useState('')
  const sessionId = reviewScenario.data.session_id
  const tab = app.state.tabs.find((candidate) => candidate.literatureReview)
  const data = {
    ...reviewScenario.data,
    references: {
      ...reviewScenario.data.references,
      rows: reviewScenario.data.references.rows.map((row, index) => ({
        ...row,
        target:
          index === 0
            ? { kind: 'library', item_id: 'review-test-item' }
            : { kind: 'web', url: 'https://example.org/review-paper' },
      })),
    },
  }
  return (
    <StoreContext.Provider value={{ ...app, act: { ...app.act, openFilePreview: setTarget } }}>
      <WebNavigationContext.Provider value={setWebTarget}>
        <Button
          onClick={() =>
            app.set({
              activeSession: sessionId,
              threads: {
                [sessionId]: {
                  id: sessionId,
                  sessionId,
                  title: '综述样例',
                  lastSeq: 0,
                  conversation: [],
                  running: false,
                  status: 'done',
                } as Thread,
              },
            })
          }
        >
          加载原生综述样例
        </Button>
        {app.state.activeSession === sessionId ? (
          <section data-testid="review-inline">
            <LiteratureCard type="literature-review" cardId="review-result" content={data} />
          </section>
        ) : null}
        {tab ? (
          <section data-testid="review-native-detail">
            <LiteratureResultTab tabId={tab.id} />
          </section>
        ) : null}
        <pre data-testid="review-artifact-target">{JSON.stringify(target)}</pre>
        <pre data-testid="review-web-target">{webTarget}</pre>
      </WebNavigationContext.Provider>
    </StoreContext.Provider>
  )
}

function Fixture() {
  const [selected, setSelected] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [scopeValue, setScopeValue] = useState('original')
  const [status, setStatus] = useState('pending')
  const [opened, setOpened] = useState(true)
  const [request] = useState<PluginPreviewRequest>(
    mode === 'candidate'
      ? { operation: 'plugin-preview', candidate: 'candidate', sha256: 'sha' }
      : { operation: 'plugin-preview-installed', name: 'fixture' }
  )
  if (mode === 'state-refresh')
    return (
      <>
        <Button onClick={() => setRefresh((value) => value + 1)}>父级重绘</Button>
        <Button onClick={() => setScopeValue('changed')}>修改业务数据</Button>
        <Button onClick={() => setStatus('resolved')}>更新状态</Button>
        <p data-testid="refresh">{refresh}</p>
        <ComponentFrame
          mount={mount}
          component={component}
          data={{ initial: scopeValue }}
          status={status}
          onAction={(_action, values) => {
            Object.assign(window, { submittedValues: values })
            setSelected(true)
          }}
          onRequest={async (_action, values, _capability, authorize) => {
            await new Promise<void>((resolve) => pending.push(resolve))
            await authorize()
            return values
          }}
        />
        <p data-testid="selected">{String(selected)}</p>
      </>
    )
  if (mode === 'external-public' || mode === 'external-native')
    return (
      <>
        <PluginInteraction
          reference={{
            plugin: 'host',
            component: component.id,
            fingerprint: mount.fingerprint,
            binding: 'fixed-public-binding',
          }}
          data={{}}
          status={status}
          onAction={() => setSelected(true)}
          onRestore={() => undefined}
          renderHosted={
            mode === 'external-native'
              ? (props) => (
                  <LiteratureAuthorizationCard
                    selectable
                    papers={[
                      { id: 'one', label: '旧论文一' },
                      { id: 'two', label: '旧论文二' },
                    ]}
                    selectedPaperIds={(props.data.selected_paper_ids as string[]) ?? []}
                    expanded
                    onExpandedChange={() => undefined}
                    onSelectionChange={(selected) =>
                      props.onAction('select', { selected_paper_ids: selected })
                    }
                    onAllow={() =>
                      props.onAction('authorize', {
                        selected_paper_ids: props.data.selected_paper_ids,
                      })
                    }
                    onDeny={() =>
                      props.onAction('reject', {
                        selected_paper_ids: props.data.selected_paper_ids,
                      })
                    }
                  />
                )
              : undefined
          }
        />
        <p data-testid="external-selection">{String(selected)}</p>
      </>
    )
  if (mode === 'fixed-openui') {
    const definition: PluginComponent = {
      id: 'comparison',
      slot: 'fixed.comparison',
      preview: 'comparison.json',
      actions: [],
      openui: {
        component: 'Conversation',
        args: [
          [
            {
              component: 'Table',
              args: [
                [
                  { component: 'Col', args: ['Previous', { field: 'previous' }] },
                  { component: 'Col', args: ['Current', { field: 'current' }] },
                ],
              ],
            },
          ],
        ],
      },
    }
    return (
      <PluginInteraction
        reference={{ plugin: 'fixed', component: definition.id, fingerprint: 'fixed-v1' }}
        previewMount={{
          descriptor: { ...mount.descriptor, id: 'fixed', components: [definition] },
          fingerprint: 'fixed-v1',
          scenarios: {},
          frames: {},
        }}
        status="resolved"
        data={{
          previous: ['10 days'],
          current: [new URLSearchParams(location.search).get('current')],
        }}
        onAction={() => undefined}
      />
    )
  }
  if (mode === 'declarative') {
    return (
      <RegisteredContent
        slot="conversation.ui"
        data={{
          format: 'openui-lang',
          version: 1,
          source: new URLSearchParams(location.search).get('source'),
        }}
        status="resolved"
        onAction={() => {}}
      />
    )
  }
  if (mode === 'public') return <PublicFixture />
  if (
    mode === 'generic' ||
    mode === 'installation' ||
    mode === 'pagination' ||
    mode === 'authorization'
  )
    return <GenericFixture />
  if (mode === 'public-bound') return <BoundPublicFixture />
  if (mode === 'legacy-bound' || mode === 'legacy-unbound') return <LegacySelectionFixture />
  if (mode === 'copy') {
    const reference = {
      plugin: 'fixture',
      component: 'selection',
      fingerprint: 'fixture',
      binding: 'fixed-binding',
    }
    const items: ConvItem[] = [
      { kind: 'agent', turnId: 'turn', text: '阅读开始' },
      {
        kind: 'display_card',
        turnId: 'turn',
        card: { cardId: 'copy-card', type: 'plugin-component', component: reference, content: {} },
      },
      { kind: 'agent', turnId: 'turn', text: '阅读结论' },
    ]
    return (
      <CopySessionContext.Provider value="copy-session">
        <Button onClick={() => setOpened((value) => !value)}>切换卡片</Button>
        {opened && (
          <PluginInteraction
            reference={reference}
            data={{}}
            status="resolved"
            onAction={() => undefined}
          />
        )}
        <ReplyCopy items={items} turnId="turn" sessionId="copy-session" />
      </CopySessionContext.Provider>
    )
  }
  if (
    mode === 'bound' ||
    mode === 'draft-boundary' ||
    mode === 'history' ||
    mode === 'live-receipt'
  )
    return (
      <PluginInteraction
        reference={{
          plugin: 'fixture',
          component: 'selection',
          fingerprint: 'fixture',
          binding: 'fixed-binding',
        }}
        data={mode === 'draft-boundary' ? draftBoundaryData : {}}
        status={mode === 'history' ? 'resolved' : status}
        submittedValues={
          mode === 'history' || (mode === 'live-receipt' && status === 'resolved')
            ? { edgeId: 'citation-2', visible: false }
            : undefined
        }
        onAction={() => setStatus('resolved')}
      />
    )
  if (mode)
    return (
      <>
        <Button onClick={() => setOpened((value) => !value)}>开关预览</Button>
        {opened && <PluginPreview request={request} />}
      </>
    )
  return (
    <>
      <ComponentFrame
        mount={mount}
        component={component}
        data={{}}
        status={status}
        onAction={() => setSelected(true)}
      />
      <Button disabled={!selected} onClick={() => setStatus('resolved')}>
        确认
      </Button>
      <p data-testid="status">{status}</p>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <PublicComponentsContext.Provider value={publicComponents}>
          <StoreProvider assistantSources={[]}>
            {mode === 'native-review' ? <ReviewFixture /> : <Fixture />}
          </StoreProvider>
        </PublicComponentsContext.Provider>
      </ToastProvider>
    </I18nextProvider>
  </StrictMode>
)
