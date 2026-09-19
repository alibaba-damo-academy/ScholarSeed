import React from 'react'
import { useTranslation } from 'react-i18next'

import { featureRegistry } from '../app/composition'
import { useApp } from '../store'
import { Pending } from './Pending'

/**
 * 第二栏宿主：渲染当前视图对应的模块面板。
 *
 * 改造前这里是一串 `state.mainView === ...` 分支。现在只按视图键查
 * `featureRegistry.panels` —— 架构文档 §4.3 要求 Shell 不含业务分支，
 * 新增视图靠 Feature 增加贡献项完成，不必再改本文件。
 */

/**
 * 视图键 → 该视图在二级侧栏使用的面板 key。
 *
 * 这张表是"布局归属"而非业务判断：哪个面板出现在哪个视图属于 Shell 的
 * 排版职责（开发 7），面板内容则完全由各 Feature 决定。
 */
const PANEL_BY_VIEW: Record<string, string> = {
  projects: 'project-manage',
  resource: 'resource-tree',
  literature: 'literature-filters'
}

export function ModulePanel(): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const { state } = useApp()
  if (!state.modulePanelOpen) return null

  const panelKey = PANEL_BY_VIEW[state.mainView]
  const panel = panelKey
    ? featureRegistry.panels.find((entry) => entry.key === panelKey && entry.slot === 'module')
    : undefined

  return (
    <div className="vds-module-panel">
      {panel ? (
        panel.render()
      ) : (
        <Pending
          feature={state.mainView === 'writing' ? t('unavailable.writing') : t('unavailable.panel')}
          owner={state.mainView === 'writing' ? t('unavailable.writingOwner') : t('unavailable.workbench')}
          detail={
            state.mainView === 'writing'
              ? t('unavailable.writingDetail')
              : t('unavailable.panelDetail')
          }
        />
      )}
    </div>
  )
}
