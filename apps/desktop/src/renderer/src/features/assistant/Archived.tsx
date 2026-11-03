import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getHistoryWithTodos } from '../../api'
import { Button, EllipsisText, Spinner } from '../../components/ui'
import { sessionDisplayTitle, type ArchivedTask } from '../../session'
import { useApp } from '../../store'
import { projectPlanSnapshots } from '../../todo'
import { projectHistorySnapshot, snapshotTurnActivity } from '../../transcript'
import { AiPanel } from './AiPanel'

export function ArchivedConversation({
  task,
  ...props
}: { task: ArchivedTask } & React.ComponentProps<typeof AiPanel>): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { set } = useApp()
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setLoaded(false)
    setFailed(false)
    void getHistoryWithTodos(task.session_id).then((history) => {
      if (!alive) return
      if (!history) {
        setFailed(true)
        return
      }
      set((current) =>
        current.archivedSession?.session_id === task.session_id
          ? {
              threads: {
                ...current.threads,
                [task.session_id]: {
                  ...current.threads[task.session_id],
                  id: task.session_id,
                  title: task.title,
                  title_fallback: task.title_fallback,
                  sessionId: task.session_id,
                  projectPath: task.project_path,
                  lastSeq: current.threads[task.session_id]?.lastSeq ?? 0,
                  conversation: projectHistorySnapshot(history, []),
                  todos: history.todos,
                  todoTurnId: history.todo_turn_id,
                  planSnapshots: projectPlanSnapshots(history.activity_events),
                  artifacts: history.artifacts,
                  ...snapshotTurnActivity(history.turn_activity),
                  readOnly: true,
                  running: false,
                  interrupting: false,
                  activeTurnId: null,
                  queuedMessages: [],
                  resumeState: 'ready',
                  resumeMessage: undefined,
                  recoveryPending: false,
                  recoveryBlocked: false,
                  status: 'done',
                },
              },
            }
          : {}
      )
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [task.session_id, task.title, task.title_fallback, task.project_path, revision, set])
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" data-testid="archived-conversation">
      {loaded ? (
        <AiPanel {...props} />
      ) : (
        <>
          <header
            style={props.hideHeader ? { display: 'none' } : undefined}
            className="flex h-[var(--vds-workbench-header-height)] shrink-0 items-center border-b border-[var(--vds-divider-default)] px-[var(--vds-space-4)]"
          >
            <EllipsisText>{sessionDisplayTitle(task, assistantText)}</EllipsisText>
          </header>
          <div className="grid min-h-0 flex-1 place-items-center">
            {failed ? (
              <Button onClick={() => setRevision((value) => value + 1)}>
                {t('taskArchive.retry')}
              </Button>
            ) : (
              <Spinner />
            )}
          </div>
        </>
      )}
    </section>
  )
}
