import { Archive, EllipsisVertical, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ServeSession } from '../../api'
import { sessionNeedsAttention } from '../../attention'
import { SessionTitleEditor } from '../../components/business/SessionTitle'
import { TaskStatus } from '../../components/business/TaskStatus'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EllipsisText,
  IconButton,
} from '../../components/ui'
import { sessionDisplayTitle } from '../../session'
import { useApp } from '../../store'
import { findSessionNode, serveSessionNode } from '../../tree'
import { useAttention } from '../assistant/attention'

interface TasksProps {
  rows: ServeSession[]
  pending: Set<string>
  onPin: (row: ServeSession) => void
  registerAction: (id: string, button: HTMLButtonElement | null) => void
}

export function Tasks({ rows, pending, onPin, registerAction }: TasksProps): JSX.Element {
  const { state, set, act } = useApp()
  const reminders = useAttention()
  const { t } = useTranslation('layout')
  const { t: assistantText } = useTranslation('assistant')
  const remove = (row: ServeSession): void =>
    set({
      confirmDelete: {
        label: row.title,
        title_fallback: row.title_fallback,
        sessionId: row.session_id,
        surface: 'assistant',
      },
    })
  return (
    <>
      {rows.map((row) => (
        <div
          key={row.session_id}
          data-testid={`project-task-${row.session_id}`}
          className="group/project-task flex h-[var(--vds-project-task-height)] shrink-0 min-w-0 items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-surface-hover)] [&:has([aria-current=true])]:bg-[var(--vds-surface-hover)]"
        >
          {state.sessionRename?.mode !== 'dialog' &&
          state.sessionRename?.sessionId === row.session_id ? (
            <SessionTitleEditor
              node={serveSessionNode(row, state.sessionActivitySeen, state.activeSession)}
            />
          ) : (
            <Button
              unstyled
              className="flex h-full min-w-0 flex-1 items-center gap-[var(--vds-space-2)] px-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)] focus-visible:shadow-[var(--vds-focus-brand)]"
              aria-current={!state.archivedSession && state.activeSession === row.session_id}
              onClick={() => act.openSession(row.session_id, undefined, 'task')}
            >
              <EllipsisText
                wrapperClassName="min-w-0"
                className="min-w-0"
                tooltipPortalled
                tooltipSide="right"
                tooltipAlign="start"
              >
                {sessionDisplayTitle(row, assistantText)}
              </EllipsisText>
            </Button>
          )}
          {(state.sessionRename?.mode === 'dialog' ||
            state.sessionRename?.sessionId !== row.session_id) && (
            <div className="relative mr-[var(--vds-space-1)] flex shrink-0 items-center">
              <div className="flex items-center justify-center group-hover/project-task:hidden group-focus-within/project-task:hidden group-has-[[aria-expanded=true]]/project-task:hidden">
                <TaskStatus
                  node={
                    findSessionNode(state.sessions, row.session_id) ??
                    serveSessionNode(row, state.sessionActivitySeen, state.activeSession)
                  }
                  unread={sessionNeedsAttention(reminders.by_session[row.session_id] ?? 0)}
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    ref={(button) => registerAction(row.session_id, button)}
                    variant="ghostIcon"
                    size="xs"
                    className="pointer-events-none absolute right-0 opacity-0 group-hover/project-task:static group-hover/project-task:pointer-events-auto group-hover/project-task:opacity-[var(--vds-opacity-full)] group-focus-within/project-task:static group-focus-within/project-task:pointer-events-auto group-focus-within/project-task:opacity-[var(--vds-opacity-full)] aria-expanded:static aria-expanded:pointer-events-auto aria-expanded:opacity-[var(--vds-opacity-full)]"
                    label={t('taskActions')}
                    icon={<EllipsisVertical />}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    disabled={pending.has(row.session_id)}
                    onSelect={() => onPin(row)}
                  >
                    {row.pinned ? <PinOff /> : <Pin />}
                    {t(row.pinned ? 'unpin' : 'pin')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      set({
                        sessionRename: { sessionId: row.session_id, originalTitle: row.title },
                      })
                    }
                  >
                    <Pencil />
                    {assistantText('panel.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      set({
                        sessionArchive: {
                          sessionId: row.session_id,
                          title: sessionDisplayTitle(row, assistantText),
                        },
                      })
                    }
                    data-testid="project-task-archive"
                  >
                    <Archive />
                    {t('archiveTask')}
                  </DropdownMenuItem>
                  <DropdownMenuItem destructive onSelect={() => remove(row)}>
                    <Trash2 />
                    {assistantText('panel.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      ))}
    </>
  )
}
