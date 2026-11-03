import React from 'react'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { getSessionFiles, openSystemPath, type FilesResp, type TaskDocument } from '../../api'
import { openByDefault } from '../../fileOpen'
import { overviewArtifacts, type SessionArtifact } from '../../model'
import { activeThread, useApp } from '../../store'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EllipsisText,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../ui'
import { absoluteSessionFilePath } from '../markdown/links'
import { FileFormatIcon } from '../primitive'

const HEADING_CLASS =
  'flex h-[var(--vds-task-overview-row-height)] w-full min-w-0 items-center justify-start gap-[var(--vds-task-overview-icon-gap)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-2)] text-left [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-visible:shadow-[var(--vds-focus-brand)] [&_svg]:size-[var(--vds-icon-7)] [&_svg]:shrink-0'
export const OVERVIEW_ROW_CLASS =
  'flex h-[var(--vds-task-overview-row-height)] w-full min-w-0 items-center justify-start gap-[var(--vds-task-overview-icon-gap)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-2)] text-left [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-visible:shadow-[var(--vds-focus-brand)] [&_svg]:size-[var(--vds-icon-7)] [&_svg]:shrink-0 [&_span[aria-hidden]]:size-[var(--vds-icon-7)]'
const OVERVIEW_PREVIEW_LIMIT = 5
export const OverviewActionsContext = React.createContext<(open: boolean) => void>(() => {})

export function SessionArtifacts({
  onOpened,
  boundaryRef,
  renderActions,
  renderLiteratureActions,
}: {
  onOpened?: () => void
  boundaryRef?: React.RefObject<HTMLElement | null>
  renderActions?: (file: {
    name: string
    path: string
    absolutePath: string
    artifact?: SessionArtifact
  }) => React.ReactNode
  renderLiteratureActions?: (document: TaskDocument) => React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const [listing, setListing] = React.useState<{ session: string; files: FilesResp } | null>(null)
  React.useEffect(() => {
    let alive = true
    if (thread.sessionId)
      void getSessionFiles(thread.sessionId).then((files) => {
        if (alive && files) setListing({ session: thread.sessionId!, files })
      })
    return () => {
      alive = false
    }
  }, [thread.sessionId, thread.artifacts])
  const current = listing?.session === thread.sessionId ? listing.files : null
  const groups = overviewArtifacts(
    [...(thread.artifacts ?? []), ...(current?.artifacts ?? [])],
    thread.workdir
  )
  const [directoryFailed, setDirectoryFailed] = React.useState(false)
  const documents = current?.literature ?? []
  const indexedPaths = new Set(
    [...(thread.artifacts ?? []), ...(current?.artifacts ?? [])].map(
      (artifact) =>
        artifact.absolute_path ??
        (current ? absoluteSessionFilePath(current.root, artifact.path) : artifact.path)
    )
  )
  const workingFiles =
    current?.items.filter(
      (item) => !item.dir && !indexedPaths.has(absoluteSessionFilePath(current.root, item.name))
    ) ?? []
  const hasArtifacts =
    groups.outputs.length > 0 ||
    groups.process.length > 0 ||
    documents.length > 0 ||
    workingFiles.length > 0

  const preview = (artifact: SessionArtifact): void => {
    const absolute = artifact.absolute_path ?? artifact.path
    const sessionId = thread.sessionId || undefined
    void openByDefault(
      { relative: artifact.path, absolute, title: artifact.name },
      {
        openPreview: (target) =>
          act.openFilePreview({
            ...target,
            absolutePath: absolute,
            sessionId,
            artifactId: artifact.publication_id ? artifact.artifact_id : undefined,
            mediaType: artifact.media_type,
            size: artifact.size,
          }),
        onFailed: (_context, note) =>
          act.openFilePreview({
            path: artifact.path,
            absolutePath: absolute,
            sessionId,
            artifactId: artifact.publication_id ? artifact.artifact_id : undefined,
            title: artifact.name,
            mediaType: artifact.media_type,
            size: artifact.size,
            content: note,
          }),
      }
    )
    onOpened?.()
  }

  const files = (artifacts: SessionArtifact[]): React.ReactElement[] =>
    artifacts.map((artifact) => (
      <div
        key={artifact.artifact_id}
        className="group/overview-file flex min-w-0 items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-within:bg-[var(--vds-bg-white-hover-transparent)]"
      >
        <Button
          key={artifact.artifact_id}
          unstyled
          className={`${OVERVIEW_ROW_CLASS} hover:!bg-transparent`}
          data-testid={`session-artifact-${artifact.artifact_id}`}
          onClick={() => preview(artifact)}
        >
          <FileFormatIcon name={artifact.name} />
          <EllipsisText wrapperClassName="min-w-0 flex-1" tooltip={artifact.path} tooltipPortalled>
            {artifact.name}
          </EllipsisText>
        </Button>
        {renderActions?.({
          name: artifact.name,
          path: artifact.path,
          absolutePath:
            artifact.absolute_path ??
            absoluteSessionFilePath(current?.root ?? thread.workdir ?? '', artifact.path),
          artifact,
        })}
      </div>
    ))
  const process = [
    ...files(groups.process.flatMap((group) => group.artifacts)),
    ...workingFiles.map((item) => (
      <div
        key={'file:' + item.name}
        className="group/overview-file flex min-w-0 items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-within:bg-[var(--vds-bg-white-hover-transparent)]"
      >
        <Button
          key={'file:' + item.name}
          unstyled
          className={`${OVERVIEW_ROW_CLASS} hover:!bg-transparent`}
          onClick={() => {
            if (current)
              act.openFilePreview({
                path: item.name,
                absolutePath: absoluteSessionFilePath(current.root, item.name),
                title: item.name,
                sessionId: thread.sessionId || undefined,
                size: item.size,
              })
            onOpened?.()
          }}
        >
          <FileFormatIcon name={item.name} />
          <EllipsisText wrapperClassName="min-w-0 flex-1" tooltip={item.name} tooltipPortalled>
            {item.name.split('/').at(-1)}
          </EllipsisText>
        </Button>
        {current &&
          renderActions?.({
            name: item.name.split('/').at(-1) ?? item.name,
            path: item.name,
            absolutePath: absoluteSessionFilePath(current.root, item.name),
          })}
      </div>
    )),
    ...documents.map((document) => (
      <div
        key={'literature:' + document.id}
        className="group/overview-file flex min-w-0 items-center rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus-within:bg-[var(--vds-bg-white-hover-transparent)]"
      >
        <Button
          unstyled
          className={`${OVERVIEW_ROW_CLASS} hover:!bg-transparent`}
          disabled={!document.literature_id}
          onClick={() => {
            void act.openLiteratureAttachment(
              document.literature_id,
              document.attachment_id ?? undefined
            )
            onOpened?.()
          }}
        >
          <FileFormatIcon name={document.title} />
          <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
            {document.title}
          </EllipsisText>
        </Button>
        {renderLiteratureActions?.(document)}
      </div>
    )),
  ]

  return (
    <OverviewSection title={t('overview.artifacts')} testId="session-artifacts">
      <div className="grid gap-[var(--vds-space-2)]" data-testid="session-artifacts-body">
        {hasArtifacts && thread.workdir && (
          <Button
            unstyled
            className={`${OVERVIEW_ROW_CLASS} !h-[var(--vds-task-overview-directory-height)]`}
            data-testid="task-overview-directory"
            onClick={() => {
              setDirectoryFailed(false)
              void openSystemPath(thread.workdir!).then((result) => setDirectoryFailed(!result.ok))
            }}
          >
            <Folder aria-hidden />
            <span className="min-w-0 flex-1">
              {t(
                window.scholarseed.platform === 'darwin'
                  ? 'overview.directoryMac'
                  : 'overview.directory'
              )}
            </span>
          </Button>
        )}
        {directoryFailed && (
          <p
            role="alert"
            className="px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-error-text-primary)]"
          >
            {t('overview.directoryFailed')}
          </p>
        )}
        <OverviewGroup
          boundaryRef={boundaryRef}
          title={t('overview.outputs')}
          testId="task-overview-outputs"
          items={files(groups.outputs)}
        />
        <OverviewGroup
          boundaryRef={boundaryRef}
          title={t('overview.process')}
          testId="task-overview-process"
          items={process}
        />
      </div>
    </OverviewSection>
  )
}

export function OverviewGroup({
  title,
  items,
  previewLimit = OVERVIEW_PREVIEW_LIMIT,
  icon,
  testId,
  boundaryRef,
}: {
  title: string
  items: React.ReactElement[]
  previewLimit?: number
  icon?: React.ReactNode
  testId?: string
  boundaryRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: artifactText } = useTranslation('assistant')
  const [open, setOpen] = React.useState(true)
  const [expanded, setExpanded] = React.useState(false)
  const listId = React.useId()
  const [hoverOpen, setHoverOpen] = React.useState(false)
  const actionsOpen = React.useRef(false)
  const onParentActionsOpenChange = React.useContext(OverviewActionsContext)
  if (previewLimit === 0 && items.length === 0) return <></>
  const collapsible = previewLimit > 0 && items.length > 0
  const expandable = items.length > previewLimit
  const sourceGroup = previewLimit === 0
  const empty = (
    <p className="m-0 px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
      {t('overview.empty')}
    </p>
  )
  const label = (
    <>
      {icon}
      <span className="min-w-0 truncate">{title}</span>
      {collapsible &&
        (open ? (
          <ChevronDown aria-hidden className="invisible group-hover/overview-heading:visible" />
        ) : (
          <ChevronRight aria-hidden className="invisible group-hover/overview-heading:visible" />
        ))}
      {sourceGroup && items.length > 0 && (
        <span className="ml-auto font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
          +{items.length}
        </span>
      )}
    </>
  )
  const trigger = (
    <Button
      unstyled
      className={`${HEADING_CLASS} group/overview-heading`}
      data-testid={testId ? `${testId}-trigger` : undefined}
    >
      {label}
    </Button>
  )
  const heading = collapsible ? (
    <CollapsibleTrigger
      asChild
      className="!min-h-0 !justify-start !border-0 !px-[var(--vds-space-2)] !py-0 !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-secondary)] hover:!bg-[var(--vds-bg-white-hover-transparent)]"
    >
      {trigger}
    </CollapsibleTrigger>
  ) : (
    trigger
  )
  return (
    <Collapsible
      open={collapsible ? open : true}
      onOpenChange={setOpen}
      className="!gap-[var(--vds-space-1)]"
      data-testid={testId}
    >
      {sourceGroup ? (
        <OverviewActionsContext.Provider
          value={(next) => {
            actionsOpen.current = next
            setHoverOpen(next)
            onParentActionsOpenChange(next)
          }}
        >
          <HoverCard
            open={hoverOpen}
            onOpenChange={(next) => {
              if (!actionsOpen.current) setHoverOpen(next)
            }}
          >
            <HoverCardTrigger asChild>{heading}</HoverCardTrigger>
            <HoverCardContent
              side="left"
              sideBoundaryRef={boundaryRef}
              aria-label={title}
              data-testid={testId ? `${testId}-all` : undefined}
              className="!z-[var(--vds-z-inline-flyout)] !w-[var(--vds-task-overview-width)] max-h-[var(--vds-task-overview-max-height)] !gap-0 overflow-y-auto border border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] !p-[var(--vds-space-2)] shadow-[var(--vds-shadow-3-center)]"
            >
              {items.length ? items : empty}
            </HoverCardContent>
          </HoverCard>
        </OverviewActionsContext.Provider>
      ) : collapsible ? (
        heading
      ) : (
        <div className={HEADING_CLASS}>{label}</div>
      )}
      {previewLimit > 0 && (
        <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0">
          <div id={listId}>
            <div className="grid gap-[var(--vds-space-1)]">
              {items.length ? items.slice(0, previewLimit) : empty}
            </div>
            {expandable && (
              <Collapsible
                animated
                open={expanded}
                className="!gap-0 [--vds-collapsible-content-gap:var(--vds-space-1)]"
              >
                <CollapsibleContent
                  data-testid={testId ? `${testId}-expansion` : undefined}
                  className="!rounded-none !border-0 !bg-transparent !p-0"
                >
                  <div className="grid gap-[var(--vds-space-1)]">{items.slice(previewLimit)}</div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
          {expandable && (
            <Button
              unstyled
              className={`${OVERVIEW_ROW_CLASS} !text-[var(--vds-text-tertiary)]`}
              data-testid={testId ? `${testId}-more` : undefined}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((previous) => !previous)}
            >
              {expanded
                ? artifactText('overview.showLess')
                : artifactText('overview.showMore', { count: items.length - previewLimit })}
            </Button>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

export function OverviewSection({
  title,
  children,
  testId,
  collapsible = true,
}: {
  title: string
  children: React.ReactNode
  testId?: string
  collapsible?: boolean
}): React.JSX.Element {
  const [open, setOpen] = React.useState(true)
  if (!collapsible)
    return (
      <div className="grid gap-[var(--vds-space-1)]" data-testid={testId}>
        <div className={`${HEADING_CLASS} !font-[var(--vds-fw-medium)]`}>{title}</div>
        {children}
      </div>
    )
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="!gap-[var(--vds-space-1)]"
      data-testid={testId}
    >
      <CollapsibleTrigger
        asChild
        className="!min-h-0 !justify-start !border-0 !px-[var(--vds-space-2)] !py-0 !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !font-[var(--vds-fw-medium)] !text-[var(--vds-text-secondary)] hover:!bg-[var(--vds-bg-white-hover-transparent)]"
      >
        <Button unstyled className={HEADING_CLASS}>
          <EllipsisText className="min-w-0 flex-1" tooltipPortalled>
            {title}
          </EllipsisText>
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
