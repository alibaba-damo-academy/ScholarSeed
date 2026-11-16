import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import {
  OPENUI_FORMAT,
  OPENUI_SLOT,
  OPENUI_VERSION,
} from '../../../../../../../packages/ui/document'
import { RegisteredContent } from './Declarative'
import { PluginInteraction } from './Frame'
import { PublicComponentsContext } from './publicComponents'
import { literaturePublicComponents } from '../../features/literature/Component'
import type { PluginMount } from '../../../../plugins'
import { Button } from '../ui'
import outline from '../../../../../../../skills/community/literature-review/components/outline.json'
import '../../styles.css'

const localization = createLocalization('zh', resources, { report: () => undefined })
const ANSWER =
  'root = Conversation([TextContent("研究结果"), BarChart(["A", "B"], [Series("得分", [3, 5])]), Table([Col("方法", ["A", "B"]), Col("得分", [3, 5], "number")]), TextContent("结果解释")])'
const RESOURCE = 'root = Conversation([Artifact("artifact", "已发布文件")])'
const MOUNT: PluginMount = {
  descriptor: {
    id: 'host',
    version: 'host-v3',
    capabilities: [],
    components: [{ id: OPENUI_SLOT, slot: OPENUI_SLOT, preview: '', actions: [] }],
  },
  fingerprint: 'host-v3',
  scenarios: {},
  frames: {},
  interaction: {
    session_id: 'session',
    turn_id: 'client-turn',
    data: {},
    state: {},
    revision: 0,
    status: 'resolved',
  },
}
const NATIVE = new Map(literaturePublicComponents.map((component) => [component.slot, component]))

function Fixture(): React.JSX.Element {
  const [source, setSource] = useState(ANSWER)
  const [visible, setVisible] = useState(true)
  const [mode, setMode] = useState('display')
  const [submissions, setSubmissions] = useState<unknown[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [resolved, setResolved] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  return (
    <I18nextProvider i18n={localization}>
      <Button onClick={() => setSource(ANSWER.replaceAll('[3, 5]', '[3, 7]'))}>更新描述</Button>
      <Button onClick={() => setMode('resource')}>资源入口</Button>
      <Button onClick={() => setMode('native')}>原生澄清</Button>
      <Button onClick={() => setMode('outline')}>原生提纲确认</Button>
      <Button onClick={() => setMode('selection')}>原生文献选择</Button>
      <Button onClick={() => setResolved(true)}>终态</Button>
      <Button onClick={() => setSource('root = Conversation([Form("removed", null, [])])')}>
        移除的表单
      </Button>
      {['CodeBlock("text", "removed")', 'Separator()', 'Citation("source", "removed")'].map(
        (component) => (
          <Button key={component} onClick={() => setSource(`root = Conversation([${component}])`)}>
            {component.split('(')[0]}
          </Button>
        )
      )}
      <Button onClick={() => setSource('root = Conversation([Unknown("no")])')}>非法描述</Button>
      <Button onClick={() => setVisible((value) => !value)}>切换视图</Button>
      <Button
        onClick={() => {
          document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
        }}
      >
        切换主题
      </Button>
      <output data-testid="submissions">{JSON.stringify(submissions)}</output>
      {mode === 'resource' ? (
        <PluginInteraction
          reference={{ plugin: 'host', fingerprint: 'host-v3', component: OPENUI_SLOT }}
          previewMount={MOUNT}
          status="resolved"
          onAction={() => undefined}
          data={{ format: OPENUI_FORMAT, version: OPENUI_VERSION, source: RESOURCE }}
        />
      ) : mode === 'selection' ? (
        <PublicComponentsContext.Provider value={NATIVE}>
          <RegisteredContent
            slot="literature.selection"
            data={{
              papers: [
                { id: 'one', label: '论文一', description: '证据说明一' },
                { id: 'two', label: '论文二', description: '证据说明二' },
              ],
              selected_paper_ids: selected,
            }}
            status={resolved ? 'resolved' : 'pending'}
            onAction={(action, values) => {
              setSelected(values.selected_paper_ids as string[])
              setSubmissions((current) => [...current, { action, values }])
            }}
          />
        </PublicComponentsContext.Provider>
      ) : mode === 'native' || mode === 'outline' ? (
        <PublicComponentsContext.Provider value={NATIVE}>
          <RegisteredContent
            slot={mode === 'outline' ? 'literature.outline' : 'interaction.question'}
            data={
              mode === 'outline'
                ? { ...outline.data, options: outline.interaction.questions[0].options, answers }
                : {
                    options: [{ label: '继续', description: '原生选项' }, { label: '暂停' }],
                    answers,
                  }
            }
            status={resolved ? 'resolved' : 'pending'}
            onAction={(action, values) => {
              setAnswers(values.answers as string[])
              setSubmissions((current) => [...current, { action, values }])
            }}
          />
        </PublicComponentsContext.Provider>
      ) : (
        visible && (
          <RegisteredContent
            slot={OPENUI_SLOT}
            data={{ format: OPENUI_FORMAT, version: OPENUI_VERSION, source }}
            status="resolved"
            onAction={() => {
              throw new Error('display_must_not_submit')
            }}
          />
        )
      )}
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
