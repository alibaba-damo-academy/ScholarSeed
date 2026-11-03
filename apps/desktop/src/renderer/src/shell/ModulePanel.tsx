import React from 'react'

import { useApp } from '../store'
import { modulePanelForView } from './panels'

/**
 * 第二栏宿主：渲染当前视图对应的模块面板。
 *
 * 改造前这里是一串 `state.mainView === ...` 分支。现在只按视图键查
 * `featureRegistry.panels` —— 架构文档 §4.3 要求 Shell 不含业务分支，
 * 新增视图靠 Feature 增加贡献项完成，不必再改本文件。
 */

export function ModulePanel(): React.JSX.Element | null {
  const { state } = useApp()
  const panel = modulePanelForView(state.mainView)
  if (!panel) return null

  return <div className="vds-module-panel">{panel.render()}</div>
}
