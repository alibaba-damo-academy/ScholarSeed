import React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArchiveRestore, Trash2, X } from 'lucide-react'
import {
  deleteSession,
  getHistoryWithTodos,
  listAllSessions,
  listProjects,
  setSessionArchived,
  type HistoryResult,
  type Project,
  type ServeSession,
} from '../../api'
import { useApp } from '../../store'
import { documentWorkspaces } from '../../features/workbench/workspace'
import { sessionDisplayTitle, sessionProjectName } from '../../session'
import { isUserHistoryTurn } from '../../transcript'
import { createArchiveReader, type ArchiveReader } from './archives'
import { Markdown } from '../primitive/Markdown'
import {
  Alert,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  Card,
  EllipsisText,
  EmptyState,
  IconButton,
  Spinner,
  Textarea,
} from '../ui'
import { SettingsPage } from './Settings'

export function ArchiveDialog(): React.JSX.Element {
  const { state, set, act } = useApp()
  const { t } = useTranslation('components')
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const target = state.sessionArchive!
  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    const result = await setSessionArchived(target.sessionId, true)
    setBusy(false)
    if (!result.ok) {
      setFailed(true)
      return
    }
    act.removeSession(target.sessionId, 'assistant')
    set((current) => ({
      sessionArchive: null,
      sessionCatalogRevision: current.sessionCatalogRevision + 1,
    }))
    window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) set({ sessionArchive: null })
      }}
    >
      <AlertDialogPortal>
        <AlertDialogContent data-testid="task-archive-confirm">
          <AlertDialogHeader>
            <div className="flex items-start justify-between gap-[var(--vds-space-2)]">
              <AlertDialogTitle>{t('taskArchive.confirmTitle')}</AlertDialogTitle>
              <IconButton
                variant="ghost"
                icon={<X />}
                label={t('taskArchive.cancel')}
                disabled={busy}
                onClick={() => set({ sessionArchive: null })}
              />
            </div>
            <AlertDialogDescription>
              {t('taskArchive.confirmDescription', { title: target.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {failed && <Alert tone="error" description={t('taskArchive.failed')} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('taskArchive.cancel')}</AlertDialogCancel>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void confirm()}
              data-testid="task-archive-submit"
            >
              {t('taskArchive.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  )
}

export function ArchivedMessages({
  history,
  conversation = false,
}: {
  history: HistoryResult
  conversation?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const turns = history.turns.filter((turn) => turn.kind !== 'thinking')
  return (
    <div
      className={
        conversation
          ? 'grid min-w-0 gap-[var(--vds-space-6)]'
          : 'grid min-w-0 gap-[var(--vds-space-3)]'
      }
      data-testid="archived-task-history"
    >
      {turns.map((turn, index) => {
        const Surface = conversation ? 'div' : Card
        return (
          <Surface
            key={`${turn.turn_id ?? ''}-${turn.item_id ?? ''}-${index}`}
            className={
              conversation && isUserHistoryTurn(turn)
                ? 'ml-auto max-w-full rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]'
                : 'min-w-0'
            }
          >
            <p
              className={
                conversation
                  ? 'sr-only'
                  : 'text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]'
              }
            >
              {isUserHistoryTurn(turn)
                ? t('taskArchive.user')
                : turn.kind === 'tool'
                  ? t('taskArchive.tool')
                  : t('taskArchive.assistant')}
            </p>
            {turn.kind === 'tool' && <p>{turn.tool ?? turn.name}</p>}
            {turn.text && <Markdown text={turn.text} />}
            {turn.output && <Markdown text={turn.output} />}
            {turn.refs?.map((reference) => (
              <p key={`${reference.type}-${reference.id}`}>{reference.title || reference.path}</p>
            ))}
            {turn.preview?.title && <p>{turn.preview.title}</p>}
          </Surface>
        )
      })}
      {!turns.length && <EmptyState title={t('taskArchive.emptyHistory')} />}
    </div>
  )
}

export function ArchivedTasksPage(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { state, set, act } = useApp()
  const [rows, setRows] = React.useState<ServeSession[] | null>(null)
  const [projects, setProjects] = React.useState<Project[]>([])
  const [failed, setFailed] = React.useState(false)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [revision, setRevision] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [selected, setSelected] = React.useState<ServeSession | null>(null)
  const [history, setHistory] = React.useState<HistoryResult | null>(null)
  const [historyFailed, setHistoryFailed] = React.useState(false)
  const [removing, setRemoving] = React.useState<ServeSession | null>(null)
  const reader = React.useRef<ArchiveReader | null>(null)
  const catalogRevision = React.useRef(state.sessionCatalogRevision)
  React.useEffect(() => {
    setFailed(false)
    setLoadFailed(false)
    setRows(null)
    const current = createArchiveReader(
      (active) => Promise.all([listAllSessions({ archived: true }, active), listProjects(true)]),
      ([result, projectCatalog]) => {
        if (result !== null) setRows(result)
        if (projectCatalog) setProjects(projectCatalog.projects)
        setLoadFailed(result === null)
      },
      () => setLoadFailed(true)
    )
    reader.current = current
    current.request()
    return () => {
      current.dispose()
      if (reader.current === current) reader.current = null
    }
  }, [revision])
  React.useEffect(() => {
    if (catalogRevision.current === state.sessionCatalogRevision) return
    catalogRevision.current = state.sessionCatalogRevision
    reader.current?.request()
  }, [state.sessionCatalogRevision])
  React.useEffect(() => {
    let alive = true
    setHistory(null)
    setHistoryFailed(false)
    if (selected)
      void getHistoryWithTodos(selected.session_id).then((result) => {
        if (!alive) return
        setHistory(result)
        setHistoryFailed(result === null)
      })
    return () => {
      alive = false
    }
  }, [selected, revision])
  const projectLabel = (row: ServeSession): string =>
    t('taskArchive.project', {
      name: sessionProjectName(row, projects, t('taskArchive.unassignedProject')),
    })
  const restore = async (row: ServeSession): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    const result = await setSessionArchived(row.session_id, false)
    setBusy(false)
    if (!result.ok) {
      setFailed(true)
      return
    }
    setSelected(null)
    setRevision((value) => value + 1)
    if (state.archivedSession?.session_id === row.session_id) act.openSession(row.session_id)
    set((current) => ({ sessionCatalogRevision: current.sessionCatalogRevision + 1 }))
    window.dispatchEvent(new Event('scholarseed:refresh-session-list'))
  }
  const remove = async (): Promise<void> => {
    if (!removing || busy) return
    setBusy(true)
    const result = await deleteSession(removing.session_id)
    setBusy(false)
    if (!result.ok) {
      setFailed(true)
      return
    }
    documentWorkspaces.discardTaskDocuments(removing.session_id)
    act.removeSession(removing.session_id)
    if (selected?.session_id === removing.session_id) setSelected(null)
    setRemoving(null)
    setRevision((value) => value + 1)
  }
  return (
    <SettingsPage
      title={selected ? sessionDisplayTitle(selected, assistantText) : t('taskArchive.title')}
      description={selected ? projectLabel(selected) : t('taskArchive.description')}
      data-testid="account-settings-archived-tasks"
    >
      {(failed || loadFailed) && <Alert tone="error" description={t('taskArchive.loadFailed')} />}
      {selected ? (
        <div className="grid min-w-0 gap-[var(--vds-space-3)]">
          <div className="flex flex-wrap gap-[var(--vds-space-2)]">
            <Button variant="outline" onClick={() => setSelected(null)}>
              <ArrowLeft />
              {t('taskArchive.back')}
            </Button>
            <Button disabled={busy} onClick={() => void restore(selected)}>
              {t('taskArchive.restore')}
            </Button>
          </div>
          {historyFailed ? (
            <Button onClick={() => setRevision((value) => value + 1)}>
              {t('taskArchive.loadFailed')}
            </Button>
          ) : !history ? (
            <Spinner />
          ) : (
            <ArchivedMessages history={history} />
          )}
          <Textarea
            disabled
            value=""
            placeholder={t('taskArchive.readonly')}
            aria-label={t('taskArchive.readonly')}
          />
          <Button disabled>{t('taskArchive.send')}</Button>
        </div>
      ) : (
        <div className="grid gap-[var(--vds-space-2)]">
          {!rows && !failed && !loadFailed && <Spinner />}
          {(failed || loadFailed) && (
            <Button onClick={() => setRevision((value) => value + 1)}>
              {t('taskArchive.retry')}
            </Button>
          )}
          {rows?.length === 0 && <EmptyState title={t('taskArchive.empty')} />}
          {rows && (
            <p className="text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]">
              {t('taskArchive.count', { count: rows.length })}
            </p>
          )}
          {rows?.map((row) => (
            <Card
              key={row.session_id}
              className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]"
              data-testid={`archived-task-${row.session_id}`}
            >
              <Button
                variant="ghost"
                size="content"
                className="min-w-0 flex-1 !justify-start"
                onClick={() => setSelected(row)}
              >
                <span className="grid min-w-0 gap-[var(--vds-space-1)] text-left">
                  <EllipsisText>{sessionDisplayTitle(row, assistantText)}</EllipsisText>
                  <EllipsisText
                    className="text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
                    title={row.project_path ?? undefined}
                  >
                    {projectLabel(row)}
                  </EllipsisText>
                </span>
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void restore(row)}>
                <ArchiveRestore />
                {t('taskArchive.restore')}
              </Button>
              <IconButton
                variant="ghost"
                label={t('taskArchive.delete')}
                icon={<Trash2 />}
                disabled={busy}
                onClick={() => {
                  setFailed(false)
                  setRemoving(row)
                }}
              />
            </Card>
          ))}
        </div>
      )}
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent
            className="!z-[var(--vds-z-modal-nested)]"
            overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{t('taskArchive.delete')}</AlertDialogTitle>
              <AlertDialogDescription>{t('taskArchive.deleteDescription')}</AlertDialogDescription>
            </AlertDialogHeader>
            {failed && <Alert tone="error" description={t('taskArchive.loadFailed')} />}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{t('taskArchive.cancel')}</AlertDialogCancel>
              <Button variant="danger" loading={busy} onClick={() => void remove()}>
                {t('taskArchive.delete')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </SettingsPage>
  )
}
