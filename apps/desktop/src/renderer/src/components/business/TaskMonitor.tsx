import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { Button } from '../ui'
import { ResearchContext } from './ResearchContext'
import { TodoPanel } from './TodoPanel'

// TaskMonitor.tsx — 对话页右侧「任务监控」栏 (PRD 2.1.4)。
// 产品侧仅展示 Codex 计划待办；产物索引继续在后台维护，不进入 MVP 任务监控 UI。

export function TaskMonitor({ onToggle }: { onToggle: () => void }): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <aside className="relative z-[var(--vds-z-surface-panel)] flex w-[288px] flex-none flex-col border-l border-[var(--border-soft)] bg-[var(--paper)]" data-testid="task-monitor">
      <div className="flex min-h-[48px] flex-none items-center gap-[8px] border-b border-[var(--border-soft)] px-[14px] [-webkit-app-region:drag]">
        <span className="flex-none text-[12px] font-[650] text-[var(--text)]">{t('todo.monitor')}</span>
        <span className="min-w-0 flex-1" />
        <Button
          unstyled
          className="no-drag relative grid size-[30px] flex-none place-items-center rounded-[6px] border-0 bg-[var(--active-bg)] p-[0] text-[var(--active-text)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)] focus-visible:outline-none disabled:cursor-default disabled:opacity-50"
          data-testid="task-monitor-toggle"
          onClick={onToggle}
          title={t('todo.hide')}
          aria-label={t('todo.hide')}
          aria-pressed
        >
          <Icon name="panel-right" size={16} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[8px] overflow-y-auto px-[12px] py-[10px]">
        <ResearchContext />
        <TodoPanel />
      </div>
    </aside>
  )
}
