import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import type { ProductTask } from '../../contracts/tasks'
import type { TaskSourceContribution } from '../../contracts/features'
import '../../styles.css'
import { TaskCenter, TaskCenterProvider } from './Tasks'

const localization = createLocalization('zh', resources)
const options = new URLSearchParams(location.search)
document.documentElement.dataset.theme = options.get('theme') ?? 'light'
const longName = 'Satellite_Ground_Optical_Turbulence_Student_Library_DEMO_'.repeat(5) + '.pdf'
const task = (status: ProductTask['status']): ProductTask => ({
  id: status,
  sourceId: 'fixture',
  projectId: 'project',
  operation: 'copy',
  title: longName,
  detail: '',
  sourceNames: [longName],
  status,
  phase: 'copying',
  outcome: { available: true, total: 1, succeeded: 1, failed: 0, cancelled: 0, results: [] },
  discoveredItems: 1,
  completedItems: 1,
  totalItems: 1,
  completedBytes: 1,
  totalBytes: 1,
  versionDiscoveredItems: 0,
  versionCompletedItems: 0,
  versionTotalItems: 0,
  eventSeq: 1,
  error: '',
  createdAt: 1,
  updatedAt: 1,
})

const tasks = [task('completed'), task('running'), task('failed')]
const papers = ['第一篇论文', longName]
const isLiteratureScenario = options.get('scenario') === 'literature'
if (isLiteratureScenario) {
  tasks.splice(
    0,
    tasks.length,
    ...(['partial', 'running'] as const).map((status) => ({
      ...task(status),
      title: { key: 'title.literatureJoin' as const, names: [] },
      sourceNames: papers,
    }))
  )
}
const listeners = new Set<(task: ProductTask) => void>()
const source: TaskSourceContribution = {
  id: 'fixture',
  list: async () => [...tasks],
  ...(isLiteratureScenario
    ? {}
    : { cancel: async () => task('cancelled'), retry: async () => task('queued') }),
  present: (entry) => ({
    title: '',
    detail: '',
    announcement: '',
    error: '',
    failures: [],
    ...(entry.operation === 'copy' && typeof entry.title !== 'string'
      ? {
          row: {
            summary: '已加入 2/2 篇 · 全文成功 1 篇，失败 1 篇',
            context: '元信息及开放全文 · 目标：我的文献库 / 验收分类',
            sourceListLabel: '论文清单（2 篇）',
          },
          progress: { determinate: true, label: '已处理全文 1/2 篇', value: 50 },
        }
      : {}),
  }),
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
Object.assign(window, {
  taskSourceProbe: {
    upload() {
      const uploaded = { ...task('completed'), id: `upload-${tasks.length}` }
      tasks.push(uploaded)
      for (const listener of listeners) listener(uploaded)
    },
  },
})

function Fixture(): React.JSX.Element {
  return (
    <I18nextProvider i18n={localization}>
      <TaskCenterProvider sources={[source]}>
        <div className="relative z-[var(--vds-z-update-entry-panel)]">
          <TaskCenter />
        </div>
      </TaskCenterProvider>
    </I18nextProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
