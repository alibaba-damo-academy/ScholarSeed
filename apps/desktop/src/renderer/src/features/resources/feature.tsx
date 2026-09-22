import React from 'react'

import type { FeatureModule } from '../../contracts/features'
import {
  cancelResourceImportTask,
  listResourceImportTasks,
  presentResourceImportTask,
  retryResourceImportTask,
  subscribeResourceImportTasks,
  watchResourceImportTask
} from './imports'
import { ResourceAgentOriginAction } from './Origin'
import { ResourcePanel } from './ResourcePanel'
import { WebSearchTab } from './WebSearchTab'
import { ResourceFailure } from './Feedback'
import { resourceErrorMessage } from './error'

const ReviewBatch = React.lazy(() => import('./ReviewBatch')
  .then((module) => ({ default: module.ReviewBatch })))

/**
 * 资料库 Feature 贡献声明（开发 2 拥有）。
 *
 * 架构文档 §4.3 要求每个 Feature 提供统一公开入口。本文件是资料库对 Shell
 * 的唯一暴露面：Shell 不 import `ResourcePanel`，只消费这里的贡献项。
 */
export function resourcesFeature(): FeatureModule {
  return {
    id: 'resources',
    taskSources: [
      {
        id: 'resource-imports',
        renderError: (error) => <ResourceFailure message={resourceErrorMessage(error)} />,
        list: listResourceImportTasks,
        cancel: cancelResourceImportTask,
        retry: retryResourceImportTask,
        present: presentResourceImportTask,
        watch: watchResourceImportTask,
        subscribe: subscribeResourceImportTasks
      }
    ],
    activityItems: [
      {
        key: 'resource',
        label: (i18n) => i18n.getFixedT(null, 'resources')('panel.title'),
        icon: 'inbox',
        order: 20,
        hiddenIn: ['literature'],
        requiresProject: true
      }
    ],
    documentToolbarItems: [
      {
        id: 'resource-agent-origin',
        render: ({ path, projectId, sourceKind }) => (
          sourceKind === 'project' && projectId
            ? <ResourceAgentOriginAction path={path} projectId={projectId} />
            : null
        )
      }
    ],
    viewerPlugins: [
      {
        kind: 'review',
        toolbar: 'viewer',
        render: ({ tabId, path }) => <ReviewBatch tabId={tabId ?? path} />
      },
      {
        kind: 'web_search',
        render: ({ tabId, path }) => <WebSearchTab tabId={tabId ?? path} />
      }
    ],
    panels: [
      {
        key: 'resource-tree',
        title: (i18n) => i18n.getFixedT(null, 'resources')('panel.title'),
        slot: 'module',
        render: () => <ResourcePanel />
      }
    ]
  }
}
