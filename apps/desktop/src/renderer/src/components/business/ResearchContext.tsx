import React from 'react'
import { useTranslation } from 'react-i18next'
import { activeThread, useApp } from '../../store'
import { Button } from '../ui'

const TASK_BLOCK_CLASS_NAME = 'overflow-hidden rounded-none border-0 bg-transparent'
const TASK_BLOCK_HEAD_CLASS_NAME = 'flex w-full cursor-pointer items-center gap-[8px] border-0 bg-transparent px-[4px] pb-[9px] pt-[7px] text-left text-[inherit]'
const TASK_BLOCK_TITLE_CLASS_NAME = 'flex-none text-[12px] font-semibold text-[var(--text-2)]'
const TASK_BLOCK_CURRENT_CLASS_NAME = 'max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-[var(--text-3)]'
const TASK_BLOCK_CARET_CLASS_NAME = 'grid size-[18px] flex-none place-items-center text-[color-mix(in_srgb,var(--text-3)_58%,transparent)]'
const TASK_BLOCK_BODY_CLASS_NAME = 'border-t-0 pt-[var(--vds-space-1)]'

// ResearchContext.tsx — 研究方向条（从旧 TodoPanel 抽出，保留既有能力）。
// 读 activeThread 的 research 上下文通道, 折叠显示当前/可选研究方向。与待办分离,
// 同处任务监控右栏。

export function ResearchContext(): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { state } = useApp()
  const thread = activeThread(state)
  const researchContext = thread.contextChannels?.['research']?.entries[0]?.text || ''
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    setOpen(false)
  }, [thread.sessionId])

  const hasActiveDirections = researchContext.includes('**Session research directions:**')
  const directions = researchContext
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^-\s*/, ''))
    .slice(0, 3)

  if (directions.length === 0) return null

  return (
    <div className={TASK_BLOCK_CLASS_NAME} data-testid="research-context">
      <Button unstyled className={TASK_BLOCK_HEAD_CLASS_NAME} onClick={() => setOpen((v) => !v)}>
        <span className={TASK_BLOCK_TITLE_CLASS_NAME}>{t(hasActiveDirections ? 'research.current' : 'research.options')}</span>
        <span className="flex-1" />
        {!open && <span className={TASK_BLOCK_CURRENT_CLASS_NAME}>{directions.join(' · ')}</span>}
        <span className={TASK_BLOCK_CARET_CLASS_NAME}>{open ? '▾' : '▸'}</span>
      </Button>
      {open && (
        <div className={`${TASK_BLOCK_BODY_CLASS_NAME} whitespace-pre-wrap break-words text-[11px] leading-[1.55] text-[var(--text-2)]`}>
          {researchContext.replace(/^## Research context\s*/m, '').trim()}
        </div>
      )}
    </div>
  )
}
