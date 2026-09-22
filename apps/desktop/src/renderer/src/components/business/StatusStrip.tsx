import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeThread, useApp } from '../../store'
import { Button } from '../ui'

// StatusStrip.tsx — Live Status Strip (proposal 65 v10 + 37/58). Composer 输入框上方的一条细
// 状态条, 完全由 store 里已有的真实 live state 驱动
// (thread.running / thread.contextChannels / backgroundTasks) —— 不发明任何假计数器。
// 后台任务跟随 background_task_event 帧展示生命周期。

// 任务状态 → 颜色 (跟随生命周期: 运行=事实蓝, 完成=经验绿, 失败/丢失=张力红, 取消=灰)
const STATUS_DOT: Record<string, string> = {
  running: 'var(--c-fact)',
  pending: 'var(--c-fact)',
  succeeded: 'var(--c-experience)',
  done: 'var(--c-experience)',
  failed: 'var(--c-tension)',
  lost: 'var(--c-tension)',
  timed_out: 'var(--c-tension)',
  cancelled: 'var(--text-3)'
}
const KIND_KEYS = {
  bash: 'strip.kind.bash',
  task: 'strip.kind.task',
  shell: 'strip.kind.shell',
  subagent: 'strip.kind.subagent',
  workflow: 'strip.kind.workflow',
  monitor: 'strip.kind.monitor'
} as const
const STATUS_KEYS = {
  running: 'strip.status.running',
  pending: 'strip.status.pending',
  succeeded: 'strip.status.succeeded',
  done: 'strip.status.done',
  failed: 'strip.status.failed',
  lost: 'strip.status.lost',
  timed_out: 'strip.status.timedOut',
  cancelled: 'strip.status.cancelled'
} as const
const STATUS_STRIP_CLASS_NAME = 'flex items-center gap-[14px] px-[2px] pb-[7px] text-[10px] text-[var(--text-3)]'
const STATUS_INLINE_CLASS_NAME = 'flex items-center gap-[5px]'
const STATUS_DOT_CLASS_NAME = 'size-[6px] flex-none rounded-full'
const STATUS_DOT_PULSE_CLASS_NAME = 'animate-[softPulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none'
const BACKGROUND_WRAP_CLASS_NAME = 'relative flex'
const BACKGROUND_BUTTON_CLASS_NAME = 'flex cursor-pointer items-center gap-[5px] border-0 bg-transparent [padding:0] font-[inherit] text-[inherit] shadow-none'
const BACKGROUND_CARET_CLASS_NAME = 'text-[8px]'
const BACKGROUND_MENU_CLASS_NAME = 'absolute bottom-[150%] left-[var(--vds-space-0)] z-[var(--vds-z-inline-flyout)] min-w-[240px] max-w-[360px] rounded-[9px] border border-[var(--border)] bg-[var(--bg-2)] py-[7px] shadow-[0_6px_24px_rgba(10,9,6,0.18)]'
const BACKGROUND_ROW_CLASS_NAME = 'flex items-center gap-[7px] px-[11px] py-[4px]'
const BACKGROUND_KIND_CLASS_NAME = 'flex-none text-[10.5px] text-[var(--text-2)]'
const BACKGROUND_LABEL_CLASS_NAME = 'overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--text-3)]'
const BACKGROUND_STATUS_CLASS_NAME = 'ml-auto flex-none text-[9.5px]'
const MEMORY_LABEL_CLASS_NAME = 'text-[var(--c-experience)]'
const CONSTRAINT_LABEL_CLASS_NAME = 'text-[var(--c-opinion)]'

function Dot({ color, pulse = false }: { color: string; pulse?: boolean }): React.JSX.Element {
  return <span className={`${STATUS_DOT_CLASS_NAME} ${pulse ? STATUS_DOT_PULSE_CLASS_NAME : ''}`} style={{ background: color }} />
}

export function StatusStrip(): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { state } = useApp()
  const thread = activeThread(state)
  const running = Boolean(thread.running)
  const [bgOpen, setBgOpen] = useState(false)

  const channels = thread.contextChannels ?? {}
  const mem = channels['memory']
  const memCards = mem?.entries.length ?? 0
  const memApplied = mem?.lastDelta?.added.length ?? 0
  const conCards = channels['constraints']?.entries.length ?? 0

  // MVP v0.1 不展示费用/token: usage token 仍由 SSE 帧在 store.usage 聚合, 本状态条不渲染。

  // 每会话独立: 读 activeThread.backgroundTasks (不是全局 state) —— 切 session 不串显其它会话的后台任务。
  const bgTasks = Object.values(thread.backgroundTasks || {}).sort((a, b) => b.ts - a.ts)
  const bgActive = bgTasks.filter((t) => !t.terminal)

  const showForegroundStatus = false

  // 全无可显示 → 不渲染 (避免空条占位)
  if (!showForegroundStatus && memCards === 0 && conCards === 0 && bgTasks.length === 0) return null

  return (
    <div className={STATUS_STRIP_CLASS_NAME}>
      {/* 前台运行状态 */}
      {showForegroundStatus && (
        <span className={STATUS_INLINE_CLASS_NAME}>
          <Dot color={running ? 'var(--c-fact)' : 'var(--c-experience)'} pulse={running} />
          {running ? t('strip.status.running') : t('strip.ready')}
        </span>
      )}

      {/* 后台任务 (bash/task/shell/subagent/workflow) — 点击展开生命周期列表 */}
      {bgTasks.length > 0 && (
        <span className={BACKGROUND_WRAP_CLASS_NAME}>
          <Button
            unstyled
            onClick={() => setBgOpen((o) => !o)}
            title={t('strip.backgroundHint')}
            className={BACKGROUND_BUTTON_CLASS_NAME}
          >
            <Dot color={bgActive.length ? 'var(--c-fact)' : 'var(--c-experience)'} pulse={bgActive.length > 0} />
            {bgActive.length > 0 ? t('strip.backgroundRunning', { count: bgActive.length }) : t('strip.backgroundDone')}
            <span className={BACKGROUND_CARET_CLASS_NAME}>{bgOpen ? '▾' : '▸'}</span>
          </Button>
          {bgOpen && (
            <div className={BACKGROUND_MENU_CLASS_NAME}>
              {bgTasks.map((task) => {
                const kindKey = KIND_KEYS[task.kind as keyof typeof KIND_KEYS]
                const status = task.status || task.event
                const statusKey = STATUS_KEYS[status as keyof typeof STATUS_KEYS]
                return (
                  <div key={task.id} className={BACKGROUND_ROW_CLASS_NAME}>
                    <Dot color={STATUS_DOT[task.status] || STATUS_DOT[task.event] || 'var(--text-3)'} pulse={!task.terminal} />
                    <span className={BACKGROUND_KIND_CLASS_NAME}>{kindKey ? t(kindKey) : task.kind || t('strip.kind.task')}</span>
                    <span className={BACKGROUND_LABEL_CLASS_NAME}>{task.label || task.id}</span>
                    <span className={BACKGROUND_STATUS_CLASS_NAME} style={{ color: STATUS_DOT[task.status] || 'var(--text-3)' }}>{statusKey ? t(statusKey) : status}</span>
                  </div>
                )
              })}
            </div>
          )}
        </span>
      )}

      {/* 记忆命中 / 应用 (memory context channel live 态) */}
      {memCards > 0 && (
        <span className={STATUS_INLINE_CLASS_NAME} title={t('strip.memoryHint')}>
          <span className={MEMORY_LABEL_CLASS_NAME}>{t('strip.memory')}</span>
          {memApplied > 0 ? t('strip.memoryApplied', { count: memCards, applied: memApplied }) : t('strip.memoryHits', { count: memCards })}
        </span>
      )}

      {/* 约束 (constraints context channel) */}
      {conCards > 0 && (
        <span className={STATUS_INLINE_CLASS_NAME} title={t('strip.constraintsHint')}>
          <span className={CONSTRAINT_LABEL_CLASS_NAME}>{t('strip.constraints')}</span>
          {conCards}
        </span>
      )}

      <span className="flex-1" />
    </div>
  )
}
