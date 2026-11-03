import React from 'react'
import { ListTodo } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import {
  OverviewActionsContext,
  SessionArtifacts,
} from '../../components/business/SessionArtifacts'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Tooltip,
} from '../../components/ui'
import { activeThread, useApp } from '../../store'
import { OverviewReferences } from './References'
import { OverviewFileActions, OverviewLiteratureActions } from './Artifacts'

const OverviewLayoutContext = React.createContext<{
  reserveSpace: boolean
  target: HTMLDivElement | null
  setTarget: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
} | null>(null)

export function TaskOverviewLayout({
  reserveSpace,
  children,
}: {
  reserveSpace: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null)
  const [open, setOpen] = React.useState(false)
  return (
    <OverviewLayoutContext.Provider value={{ reserveSpace, target, setTarget, open, setOpen }}>
      {children}
    </OverviewLayoutContext.Provider>
  )
}

export function TaskOverviewBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  const host = React.useContext(OverviewLayoutContext)
  if (!host?.reserveSpace) return <>{children}</>
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="task-overview-conversation"
      >
        {children}
      </div>
      <div
        ref={host.setTarget}
        hidden={!host.open}
        className="h-full min-h-0 w-[calc(var(--vds-task-overview-width)+var(--vds-space-8))] shrink-0 px-[var(--vds-space-4)] pb-[var(--vds-space-3)] pt-[var(--vds-space-4)]"
        data-testid="task-overview-dock"
      />
    </div>
  )
}

export function TaskOverview({ menuItem = false }: { menuItem?: boolean }): React.JSX.Element {
  const { state } = useApp()
  return <Overview key={activeThread(state).id} menuItem={menuItem} />
}

function Overview({ menuItem }: { menuItem: boolean }): React.JSX.Element {
  const { t } = useTranslation('components')
  const [open, setOpen] = React.useState(false)
  const host = React.useContext(OverviewLayoutContext)
  const reserved = Boolean(host?.reserveSpace && host.target && !menuItem)
  const setHostOpen = host?.setOpen
  const panelId = React.useId()
  React.useLayoutEffect(() => {
    setHostOpen?.(open)
    return () => setHostOpen?.(false)
  }, [open, setHostOpen])
  const boundaryRef = React.useRef<HTMLElement | null>(null)
  const horizontalAnchorRef = React.useRef<HTMLElement | null>(null)
  const toolbarRef = React.useRef<HTMLElement | null>(null)
  const [anchorBottom, setAnchorBottom] = React.useState<number | undefined>(undefined)
  const [rightOffset, setRightOffset] = React.useState(0)
  const [anchorPosition, setAnchorPosition] =
    React.useState<React.ComponentProps<typeof PopoverContent>['position']>()
  const bindTrigger = React.useCallback((element: HTMLButtonElement | null): void => {
    toolbarRef.current = element?.closest<HTMLElement>('.vds-ai-head-actions') ?? null
    horizontalAnchorRef.current =
      element?.closest<HTMLElement>('[data-testid="workspace-conversation"]') ?? toolbarRef.current
  }, [])
  const bindBoundary = React.useCallback((element: HTMLDivElement | null): void => {
    boundaryRef.current = element?.parentElement ?? null
  }, [])
  React.useLayoutEffect(() => {
    const anchor = toolbarRef.current
    if (!open || !anchor) return
    const update = (): void => {
      const rect = anchor.getBoundingClientRect()
      setAnchorBottom(rect.bottom)
      setRightOffset(
        Math.max(
          0,
          window.innerWidth -
            (horizontalAnchorRef.current?.getBoundingClientRect().right ?? rect.right)
        )
      )
      setAnchorPosition((previous) =>
        previous?.kind === 'anchor' &&
        previous.top === rect.top &&
        previous.bottom === rect.bottom &&
        previous.left === rect.left &&
        previous.width === rect.width
          ? previous
          : {
              kind: 'anchor',
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
            }
      )
    }
    // Pane transitions can move the toolbar without resizing it.
    let frame = 0
    const follow = (): void => {
      update()
      frame = requestAnimationFrame(follow)
    }
    const observer = new ResizeObserver(update)
    observer.observe(anchor)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    update()
    if (!reserved) frame = requestAnimationFrame(follow)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, reserved])
  const actionsOpen = React.useRef(false)
  const changeOpen = (next: boolean): void => {
    if (!actionsOpen.current) setOpen(next)
  }
  const contentClassName =
    'group/task-overview max-h-[var(--vds-task-overview-max-height)] w-[var(--vds-task-overview-width)] max-w-[var(--vds-popover-available-width)] gap-0 overflow-hidden border border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] !p-0 text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-3-center)]'
  const content = (
    <OverviewActionsContext.Provider
      value={(next) => {
        actionsOpen.current = next
      }}
    >
      <ScrollArea
        shadow="auto"
        className={reserved ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'max-h-[inherit]'}
        viewportClassName={`${reserved ? 'min-h-0 max-h-none flex-1 ' : ''}![scrollbar-color:transparent_transparent] group-hover/task-overview:![scrollbar-color:var(--vds-scrollbar-thumb)_transparent] [&::-webkit-scrollbar-thumb]:!bg-transparent group-hover/task-overview:[&::-webkit-scrollbar-thumb]:!bg-[var(--vds-scrollbar-thumb)]`}
        viewportProps={{ 'data-testid': 'task-overview-scroll' }}
      >
        <div ref={bindBoundary} className="px-[var(--vds-space-2)] py-[var(--vds-space-3)]">
          <SessionArtifacts
            boundaryRef={boundaryRef}
            onOpened={menuItem ? () => setOpen(false) : undefined}
            renderActions={(file) => <OverviewFileActions file={file} boundaryRef={boundaryRef} />}
            renderLiteratureActions={(document) => (
              <OverviewLiteratureActions document={document} />
            )}
          />
          <div
            aria-hidden
            className="mx-[var(--vds-space-2)] my-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)]"
          />
          <section className="!gap-0" data-testid="task-overview-references">
            <OverviewReferences
              boundaryRef={boundaryRef}
              onOpened={() => {
                if (menuItem) setOpen(false)
              }}
            />
          </section>
        </div>
      </ScrollArea>
    </OverviewActionsContext.Provider>
  )
  if (reserved)
    return (
      <>
        <Tooltip content={t('overview.title')} side="bottom">
          <IconButton
            ref={bindTrigger}
            variant="ghostIcon"
            size="md"
            label={t('overview.title')}
            title={undefined}
            icon={<ListTodo />}
            aria-pressed={open}
            aria-expanded={open}
            aria-controls={panelId}
            data-testid="task-overview-toggle"
            onClick={() => setOpen((previous) => !previous)}
          />
        </Tooltip>
        {open &&
          createPortal(
            <section
              id={panelId}
              aria-label={t('overview.panel')}
              data-testid="task-overview"
              data-presentation="reserved"
              className={`flex !max-h-full flex-col rounded-[var(--vds-radius-6)] ${contentClassName}`}
            >
              {content}
            </section>,
            host!.target!
          )}
      </>
    )
  if (menuItem)
    return (
      <DropdownMenuSub open={open} onOpenChange={changeOpen}>
        <DropdownMenuSubTrigger data-testid="task-overview-toggle">
          <ListTodo />
          {t('overview.title')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          aria-label={t('overview.panel')}
          data-testid="task-overview"
          className={contentClassName}
        >
          {content}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      dismissOnEscape={false}
      dismissOnOutsidePointerDown={false}
    >
      <Tooltip content={t('overview.title')} side="bottom">
        <PopoverTrigger asChild>
          <IconButton
            ref={bindTrigger}
            variant="ghostIcon"
            size="md"
            title={undefined}
            label={t('overview.title')}
            icon={<ListTodo />}
            aria-pressed={open}
            data-testid="task-overview-toggle"
          />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        position={anchorPosition}
        horizontalAnchorRef={horizontalAnchorRef}
        align="end"
        side="bottom"
        aria-label={t('overview.panel')}
        data-testid="task-overview"
        // Measured toolbar geometry keeps the expanded panel below its trigger.
        style={
          {
            '--vds-task-overview-right-offset': `${rightOffset}px`,
            ...(anchorBottom === undefined
              ? {}
              : {
                  '--vds-task-overview-max-height': `calc(100dvh - ${anchorBottom}px - var(--vds-space-6) - var(--vds-space-2))`,
                }),
          } as React.CSSProperties
        }
        className={`!z-[var(--vds-z-inline-flyout)] !right-[calc(var(--vds-task-overview-right-offset)+var(--vds-space-4))] mt-[var(--vds-space-4)] ${contentClassName}`}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
