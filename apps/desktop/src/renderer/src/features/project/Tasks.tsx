import type * as React from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { SESSION_ORDER_PLACEMENTS, type ServeSession, type SessionOrderPlacement } from '../../api'
import { sessionNeedsAttention } from '../../attention'
import { SessionTitleEditor } from '../../components/business/SessionTitle'
import { SessionForkMenuItem } from '../../components/business/SessionContextMenu'
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
import { findSessionNode, projectSessionNodes, serveSessionNode } from '../../tree'
import { useAttention } from '../assistant/attention'
import {
  canDetachSession,
  canDragSession,
  canOrderSession,
  canRestoreSession,
  isSessionRestorePosition,
  SESSION_DRAG_TYPE,
  SESSION_DROP_KINDS,
  sessionDropPlacement,
  type SessionDropTarget,
} from './drag'
import { SessionDropIndicator } from './Indicator'

interface TasksProps {
  rows: ServeSession[]
  pending: Set<string>
  onPin: (row: ServeSession) => void
  registerAction: (id: string, button: HTMLButtonElement | null) => void
  projectPath?: string
  onDragStart?: (row: ServeSession, event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
  onDetach?: (row: ServeSession) => void
  detaching?: string | null
  draggedSession?: ServeSession | null
  dropTarget?: SessionDropTarget | null
  onDropTargetChange?: (target: SessionDropTarget | null) => void
  onOrder?: (row: ServeSession, target: ServeSession, placement: SessionOrderPlacement) => void
  onRestore?: (row: ServeSession, parent: ServeSession) => void
}

export function Tasks({
  rows,
  pending,
  onPin,
  registerAction,
  projectPath,
  onDragStart,
  onDragEnd,
  onDetach,
  detaching,
  draggedSession,
  dropTarget,
  onDropTargetChange,
  onOrder,
  onRestore,
}: TasksProps): React.JSX.Element {
  const { state, set, act } = useApp()
  const reminders = useAttention()
  const { t } = useTranslation('layout')
  const { t: assistantText } = useTranslation('assistant')
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null)
  const orderDropTarget = dropTarget?.kind === SESSION_DROP_KINDS.order ? dropTarget : null
  const byId = new Map(rows.map((row) => [row.session_id, row]))
  const groups = projectSessionNodes(
    rows.map((row) => serveSessionNode(row, state.sessionActivitySeen, state.activeSession))
  )
  const visibleRows = groups.flatMap((node) => [
    { row: byId.get(node.id)!, child: false, childCount: node.children?.length ?? 0 },
    ...(!state.collapsedSessionIds[node.id]
      ? (node.children ?? []).map((child) => ({
          row: byId.get(child.id)!,
          child: true,
          childCount: 0,
        }))
      : []),
  ])
  const groupEnds = new Map(
    groups.map((node) => [
      node.id,
      !state.collapsedSessionIds[node.id] && node.children?.length
        ? node.children[node.children.length - 1].id
        : node.id,
    ])
  )
  const markerRowId =
    orderDropTarget?.placement === SESSION_ORDER_PLACEMENTS.after
      ? (groupEnds.get(orderDropTarget.id) ?? orderDropTarget.id)
      : orderDropTarget?.id
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
      {visibleRows.map(({ row, child, childCount }) => {
        const hasChildren = childCount > 0
        const orderTarget =
          draggedSession && !draggedSession.display_parent_session_id && child
            ? (byId.get(row.display_parent_session_id ?? '') ?? row)
            : row
        const canDrop = Boolean(
          onOrder &&
          draggedSession &&
          !detaching &&
          canOrderSession(draggedSession, orderTarget, projectPath, rows)
        )
        const detachesAt = (event: DragEvent<HTMLDivElement>): boolean => {
          if (
            !onDetach ||
            !draggedSession ||
            detaching ||
            !canDetachSession(draggedSession, projectPath) ||
            !canDragSession(row, projectPath)
          )
            return false
          if (!child) return true
          const disclosure = event.currentTarget.querySelector<HTMLElement>(
            '[data-session-disclosure-slot]'
          )
          return Boolean(
            disclosure &&
            event.clientX >= event.currentTarget.getBoundingClientRect().left &&
            event.clientX < disclosure.getBoundingClientRect().left
          )
        }
        const restoresAt = (event: DragEvent<HTMLDivElement>): boolean =>
          Boolean(
            onRestore &&
            draggedSession &&
            !detaching &&
            !child &&
            canRestoreSession(draggedSession, row, projectPath, rows) &&
            isSessionRestorePosition(event.clientY, event.currentTarget.getBoundingClientRect())
          )
        const restoreActive =
          dropTarget?.kind === SESSION_DROP_KINDS.restore && dropTarget.id === row.session_id
        return (
          <div
            key={row.session_id}
            data-testid={`project-task-${row.session_id}`}
            draggable={Boolean(
              onDragStart &&
              canDragSession(row, projectPath) &&
              !detaching &&
              !pending.has(row.session_id) &&
              state.sessionRename?.sessionId !== row.session_id
            )}
            onDragStart={(event) => onDragStart?.(row, event)}
            onDragEnd={() => {
              onDropTargetChange?.(null)
              onDragEnd?.()
            }}
            onDragOver={(event) => {
              const detaches = detachesAt(event)
              const restores = restoresAt(event)
              if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return
              if (!canDrop && !detaches && !restores) {
                event.dataTransfer.dropEffect = 'none'
                onDropTargetChange?.(null)
                return
              }
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              if (restores) {
                onDropTargetChange?.({ kind: SESSION_DROP_KINDS.restore, id: row.session_id })
                return
              }
              if (detaches) {
                onDropTargetChange?.({ kind: SESSION_DROP_KINDS.detach })
                return
              }
              onDropTargetChange?.({
                kind: SESSION_DROP_KINDS.order,
                id: orderTarget.session_id,
                placement:
                  orderTarget !== row
                    ? SESSION_ORDER_PLACEMENTS.after
                    : sessionDropPlacement(
                        event.clientY,
                        event.currentTarget.getBoundingClientRect()
                      ),
              })
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                onDropTargetChange?.(null)
            }}
            onDrop={(event) => {
              if (
                !draggedSession ||
                event.dataTransfer.getData(SESSION_DRAG_TYPE) !== draggedSession.session_id
              )
                return
              if (restoresAt(event)) {
                event.preventDefault()
                event.stopPropagation()
                onDropTargetChange?.(null)
                onRestore?.(draggedSession, row)
                return
              }
              if (detachesAt(event)) {
                event.preventDefault()
                event.stopPropagation()
                onDropTargetChange?.(null)
                onDetach?.(draggedSession)
                return
              }
              if (!canDrop) return
              event.preventDefault()
              event.stopPropagation()
              const placement =
                orderTarget !== row
                  ? SESSION_ORDER_PLACEMENTS.after
                  : sessionDropPlacement(event.clientY, event.currentTarget.getBoundingClientRect())
              onDropTargetChange?.(null)
              onOrder?.(draggedSession, orderTarget, placement)
            }}
            data-session-child={child || undefined}
            className={`relative min-w-0 shrink-0 data-[session-child=true]:pl-[calc(var(--vds-space-10)+var(--vds-space-2))] data-[session-child=true]:before:pointer-events-none data-[session-child=true]:before:absolute data-[session-child=true]:before:inset-y-[var(--vds-space-2)] [&[data-session-child]+[data-session-child]]:before:top-[calc(-1*var(--vds-space-half))] [&[data-session-child]:has(+[data-session-child])]:before:bottom-0 data-[session-child=true]:before:left-[var(--vds-space-10)] data-[session-child=true]:before:border-l data-[session-child=true]:before:border-[var(--vds-divider-default)] [&[data-session-child]+[data-session-child]]:mt-[calc(-1*var(--vds-space-half))] ${restoreActive ? 'bg-[var(--vds-surface-active)] ring-1 ring-inset ring-[var(--vds-border-brand)]' : ''}`}
          >
            {draggedSession && !detaching && orderDropTarget && markerRowId === row.session_id && (
              <SessionDropIndicator
                nested={Boolean(draggedSession.display_parent_session_id)}
                after={orderDropTarget.placement === SESSION_ORDER_PLACEMENTS.after}
              />
            )}
            <div className="group/project-task relative flex h-[var(--vds-project-task-height)] min-w-0 items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-surface-hover)] [&:has([aria-current=true])]:bg-[var(--vds-surface-hover)]">
              {(hasChildren || child) && (
                <span
                  data-session-disclosure-slot
                  className={
                    child
                      ? 'absolute left-0'
                      : 'ml-[var(--vds-space-1)] flex size-[var(--vds-control-height-xs)] shrink-0 items-center justify-center'
                  }
                >
                  {hasChildren && (
                    <IconButton
                      size="xs"
                      variant="ghostIcon"
                      label={t(
                        state.collapsedSessionIds[row.session_id]
                          ? 'expandChildren'
                          : 'collapseChildren'
                      )}
                      aria-expanded={!state.collapsedSessionIds[row.session_id]}
                      icon={
                        state.collapsedSessionIds[row.session_id] ? (
                          <ChevronRight />
                        ) : (
                          <ChevronDown />
                        )
                      }
                      onClick={() => act.toggleSessionChildren(row.session_id)}
                    />
                  )}
                </span>
              )}
              {state.sessionRename?.mode !== 'dialog' &&
              state.sessionRename?.sessionId === row.session_id ? (
                <SessionTitleEditor
                  node={serveSessionNode(row, state.sessionActivitySeen, state.activeSession)}
                />
              ) : (
                <Button
                  unstyled
                  className={`flex h-full min-w-0 flex-1 items-center gap-[var(--vds-space-2)] pr-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)] focus-visible:shadow-[var(--vds-focus-brand)] ${hasChildren ? 'pl-[calc(var(--vds-space-2)/2+var(--vds-space-half))]' : child ? 'pl-[var(--vds-space-2)]' : 'pl-[var(--vds-space-3)]'}`}
                  aria-current={!state.archivedSession && state.activeSession === row.session_id}
                  onClick={() => act.openSession(row.session_id, undefined, 'switchTask')}
                >
                  {!child && !hasChildren && (
                    <MessageCircle
                      aria-hidden="true"
                      strokeWidth="var(--vds-icon-stroke-width)"
                      className="size-[var(--vds-icon-7)] shrink-0 text-[var(--vds-text-tertiary)]"
                    />
                  )}
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
                <div className="relative mr-[var(--vds-space-2)] flex shrink-0 items-center">
                  <div
                    data-session-status
                    className="flex items-center justify-center gap-[var(--vds-space-1)] group-hover/project-task:hidden group-focus-within/project-task:hidden group-has-[[data-session-actions][aria-expanded=true]]/project-task:hidden"
                  >
                    <TaskStatus
                      node={
                        findSessionNode(state.sessions, row.session_id) ??
                        serveSessionNode(row, state.sessionActivitySeen, state.activeSession)
                      }
                      unread={sessionNeedsAttention(reminders.by_session[row.session_id] ?? 0)}
                    />
                    {hasChildren && (
                      <span className="min-w-[var(--vds-control-height-xs)] text-center text-[length:var(--vds-font-body-lv1)] tabular-nums text-[var(--vds-text-tertiary)]">
                        {childCount}
                      </span>
                    )}
                  </div>
                  <DropdownMenu
                    open={menuSessionId === row.session_id}
                    onOpenChange={(open) =>
                      setMenuSessionId((current) =>
                        open ? row.session_id : current === row.session_id ? null : current
                      )
                    }
                  >
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        data-session-actions
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
                      <SessionForkMenuItem
                        sessionId={row.session_id}
                        Item={DropdownMenuItem}
                        onForked={() => setMenuSessionId(null)}
                      />
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
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => remove(row)}>
                        <Trash2 />
                        {assistantText('panel.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
