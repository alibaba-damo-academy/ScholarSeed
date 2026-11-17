import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { Canvas } from '../../../../../../../packages/ui/painter'
import { CanvasMount, CanvasProvider, CanvasTarget, useCanvasLocation } from './Scope'
import { followCanvasSession } from './session'
import { DEFAULT_PROJECT_LAYOUT, type ProjectLayout } from '../../../../layout'
import { workbenchTabVisible, type WorkbenchTab } from '../workbench/tabs'
import { Button } from '../../components/ui'
import { PluginInteraction } from '../../components/business/Frame'
import type { PluginMount } from '../../../../plugins'
import '../../styles.css'

const localization = createLocalization('zh', resources, { report: () => undefined })
const pluginMode = location.search === '?plugin'
if (pluginMode) {
  const guest = `<label><input type="checkbox" checked>引用关系</label>
    <button onclick="this.setAttribute('aria-pressed','true')" aria-pressed="false">选中连线</button>
    <p style="margin-top:180px">图谱末尾</p>`
  const mount: PluginMount = {
    descriptor: {
      id: 'test-graph',
      version: '1.0.0',
      capabilities: [],
      components: [{ id: 'graph', preview: 'preview.json', workbench: true, actions: [] }],
    },
    fingerprint: 'test-graph-revision',
    scenarios: {},
    frames: {
      graph: {
        url: `data:text/html;charset=utf-8,${encodeURIComponent(guest)}`,
        lease: 'test-lease',
      },
    },
  }
  Object.assign(window, {
    scholarseed: {
      onPluginRevoked: () => () => undefined,
      deviceSkills: async () => ({ status: 200, body: JSON.stringify(mount) }),
    },
  })
}
interface State {
  tabs: WorkbenchTab[]
  activeTab: string
  activeSession: string
  homeSelectedProjectId: string
  mainView: string
  aiPanel: { cover: boolean }
  workbenchLayout: ProjectLayout
}
const Store = createContext<{
  state: State
  act: { closeWorkbenchTab: (id: string) => void }
  set: (patch: (current: State) => Partial<State>) => void
}>(null!)
export const useApp = () => useContext(Store)
const description = {
  format: 'html' as const,
  version: 1 as const,
  source:
    '<button id="increment" disabled>增加一次</button><output id="count">0</output><p style="margin-top:450px">画布末尾</p><script>(()=>{let count=0;const increment=document.getElementById("increment");const undo=[];const show=()=>document.getElementById("count").textContent=String(count);increment.onclick=()=>{undo.push(count);count++;show();canvas.save({count})};canvas.register({onRestore(s){count=s.count??0;show();increment.disabled=false},onRollback(){count=undo.pop()??0;show();return {count}},onSubmit(){return {count}}});})();</script>',
  interaction: { actions: ['rollback', 'submit'] as ('rollback' | 'submit')[] },
}

function ScrollConversation(): React.JSX.Element {
  const text = Array.from(
    { length: 24 },
    (_, index) => `TextContent("画布段落 ${index + 1}", "default")`
  )
  return (
    <div data-testid="conversation-scroll" className="h-[400px] overflow-y-auto">
      <div className="h-[200px]">会话前文</div>
      <Canvas
        document={{
          format: 'openui-lang',
          version: 1,
          source: `root = Stack([${text.join(', ')}])`,
        }}
      />
      <div className="h-[500px]">会话后文</div>
    </div>
  )
}

function Runtime(): React.JSX.Element {
  const location = useCanvasLocation()
  return (
    <Canvas
      document={description}
      status="pending"
      full={location.full}
      onOpen={location.open}
      onAction={() => undefined}
    />
  )
}
function Conversation(): React.JSX.Element {
  const { state } = useApp()
  if (pluginMode)
    return (
      <PluginInteraction
        reference={{
          plugin: 'test-graph',
          component: 'graph',
          fingerprint: 'test-graph-revision',
          binding: 'graph-one',
          workbench: true,
        }}
        data={{ title: '论文关系' }}
        status="resolved"
        onAction={() => undefined}
      />
    )
  return (
    <>
      <CanvasMount id={`${state.activeSession}/example`} title="画布">
        <Runtime />
      </CanvasMount>
      <CanvasMount id={`${state.activeSession}/second`} title="另一张画布">
        <Runtime />
      </CanvasMount>
    </>
  )
}
function ReopenedConversation(): React.JSX.Element | null {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    queueMicrotask(() => setReady(true))
  }, [])
  return ready ? <Conversation /> : null
}
function Content(): React.JSX.Element | null {
  const { state, set } = useApp()
  return (
    <>
      <div data-testid="canvas-conversation">
        {state.activeSession !== 'empty' &&
          (pluginMode || state.workbenchLayout.open ? (
            <Conversation key={state.activeSession} />
          ) : (
            <ReopenedConversation key={state.activeSession} />
          ))}
      </div>
      <div
        data-testid="workspace-content"
        hidden={!state.workbenchLayout.open}
        className="h-[500px]"
      >
        <Button
          onClick={() =>
            set((current) => ({ workbenchLayout: { ...current.workbenchLayout, open: false } }))
          }
        >
          收起工作台
        </Button>
        {state.tabs.some(
          (tab) =>
            tab.id === state.activeTab &&
            workbenchTabVisible(tab, state.mainView, state.activeSession)
        ) && <CanvasTarget tabId={state.activeTab} />}
      </div>
    </>
  )
}
function Fixture(): React.JSX.Element {
  const [state, setState] = useState<State>({
    tabs: [],
    activeTab: 'overview',
    activeSession: 'task',
    homeSelectedProjectId: 'project',
    mainView: 'resource',
    aiPanel: { cover: false },
    workbenchLayout: DEFAULT_PROJECT_LAYOUT,
  })
  const set = useCallback(
    (patch: (current: State) => Partial<State>) =>
      setState((current) => {
        const next = { ...current, ...patch(current) }
        return followCanvasSession(current, next)
      }),
    []
  )
  const act = {
    closeWorkbenchTab: (id: string) =>
      set((current) => ({
        tabs: current.tabs.filter((tab) => tab.id !== id),
        activeTab: 'overview',
      })),
  }
  return (
    <I18nextProvider i18n={localization}>
      {location.search === '?scroll' ? (
        <ScrollConversation />
      ) : (
        <Store.Provider value={{ state, set, act }}>
          <Button
            onClick={() => set(() => ({ activeSession: 'empty', tabs: [], activeTab: 'overview' }))}
          >
            切换任务
          </Button>
          {['task', 'other', 'empty'].map((session) => (
            <Button key={session} onClick={() => set(() => ({ activeSession: session }))}>
              {session}
            </Button>
          ))}
          <CanvasProvider>
            <Content />
          </CanvasProvider>
        </Store.Provider>
      )}
    </I18nextProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
