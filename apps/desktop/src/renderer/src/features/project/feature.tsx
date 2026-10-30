import React from 'react'

import type { FeatureModule } from '../../contracts/features'
import { ProjectCards } from './ProjectCards'
import { ProjectPanel } from './ProjectPanel'
import { ProjectNavigation } from './Navigation'
import { Library } from './Library'
import { Explorer } from './Explorer'
import { NewTab } from './NewTab'

/**
 * 项目 Feature 贡献声明（开发 1 拥有）。
 *
 * Shell 不 import `ProjectPanel`，只消费这里的贡献项（架构文档 §4.3）。
 *
 * 贡献形态与资料库/文献库一致：管理面板占二级侧栏，项目卡片占中区标签。
 * 早期这里贡献的是 0.1 双栏路由，于是点活动栏的项目图标会把整个四区工作台
 * 换成旧双栏布局 —— 同一条活动栏不应该有一个按钮切走一整套布局。
 */
export function projectFeature(): FeatureModule {
  return {
    id: 'project',
    panels: [
      {
        key: 'project-navigation',
        title: (i18n) => i18n.getFixedT(null, 'layout')('tasks'),
        slot: 'navigation',
        render: () => <ProjectNavigation />,
      },
      {
        key: 'project-manage',
        title: (i18n) => i18n.getFixedT(null, 'project')('title'),
        slot: 'module',
        render: () => <ProjectPanel />,
      },
    ],
    viewerPlugins: [
      { kind: 'projects', render: () => <ProjectCards /> },
      { kind: 'new_tab', render: ({ tabId }) => <NewTab tabId={tabId} /> },
      { kind: 'library', render: ({ tabId }) => <Library key={tabId} tabId={tabId} /> },
      { kind: 'explorer', render: ({ tabId }) => <Explorer key={tabId} tabId={tabId} /> },
    ],
  }
}
