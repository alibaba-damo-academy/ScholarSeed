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
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') ?? 'light'
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
const listeners = new Set<(task: ProductTask) => void>()
const source: TaskSourceContribution = {
  id: 'fixture',
  list: async () => [...tasks],
  cancel: async () => task('cancelled'),
  retry: async () => task('queued'),
  present: () => ({ title: '', detail: '', announcement: '', error: '', failures: [] }),
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
