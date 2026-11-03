import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EllipsisVertical } from 'lucide-react'
import finderIcon from '../../assets/finder.svg'
import folderIcon from '../../assets/fileIcon/fill-file-folder.webp'

import { artifactVersionGroups, type ArtifactItem } from '../../activity'
import {
  appsForFile,
  downloadSessionArtifact,
  openPathWith,
  revealSystemPath,
  type OpenWithApp,
  type TaskDocument,
} from '../../api'
import { writeClipboard } from '../../components/primitive/clipboard'
import {
  Artifact,
  ArtifactGroup,
  ArtifactMenuItems,
  MENU_CLASS_NAME,
} from '../../components/business/Artifact'
import {
  Button,
  EllipsisText,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  useToast,
} from '../../components/ui'
import type { ArtifactResourceLink } from '../../contracts/assistant'
import type { ResourceLocationRef } from '../../contracts/resources'
import { openByDefault, revealLabelKey } from '../../fileOpen'
import { OverviewActionsContext } from '../../components/business/SessionArtifacts'
import type { SessionArtifact } from '../../model'
import { activeThread, useApp } from '../../store'
import { listLiteratureCollections, type LibraryCollection } from '../literature/api'
import {
  fetchArtifactSha256,
  fetchResourceDirectoryTree,
  importArtifactToLiterature,
  importArtifactToResources,
} from './api'
import { assistantFailureDetail } from './failure'
import { ResourceSaveDialog } from './Save'
import { GeneratedImage, GeneratedImages } from './Images'
import { LiteratureCollections } from './Collections'

const IMPORT_ERROR_TEXT = {
  assistant_project_unavailable: 'artifactEntry.projectUnavailable',
  session_artifact_not_found: 'artifactEntry.notFound',
  session_artifact_path_forbidden: 'artifactEntry.pathForbidden',
  session_artifact_revision_conflict: 'artifactEntry.revisionConflict',
  session_artifact_integrity_mismatch: 'artifactEntry.integrityMismatch',
} as const

type ArtifactError = {
  key:
    | 'artifactEntry.collectionsFailed'
    | 'artifactEntry.copyFailed'
    | 'artifactEntry.importFailed'
    | 'artifactEntry.integrityMismatch'
    | 'artifactEntry.linksFailed'
    | 'artifactEntry.literatureFailed'
    | 'artifactEntry.notFound'
    | 'artifactEntry.pathForbidden'
    | 'artifactEntry.projectUnavailable'
    | 'artifactEntry.readFailed'
    | 'artifactEntry.revisionConflict'
  detail?: string
}

function importError(
  detail: string,
  fallback: 'artifactEntry.importFailed' | 'artifactEntry.literatureFailed'
): ArtifactError {
  const key = Object.prototype.hasOwnProperty.call(IMPORT_ERROR_TEXT, detail)
    ? IMPORT_ERROR_TEXT[detail as keyof typeof IMPORT_ERROR_TEXT]
    : undefined
  return key ? { key } : { key: fallback, detail }
}

const MARKDOWN_MEDIA_TYPES = new Set(['text/markdown', 'text/x-markdown'])
const LITERATURE_SUFFIXES = new Set(['bib', 'bibtex', 'ris', 'pdf'])
const OVERVIEW_ACTION_CLASS =
  'mr-[var(--vds-space-1)] shrink-0 opacity-0 group-hover/overview-file:opacity-[var(--vds-opacity-full)] group-focus-within/overview-file:opacity-[var(--vds-opacity-full)] data-[state=open]:opacity-[var(--vds-opacity-full)]'

export function OverviewLiteratureActions({
  document,
}: {
  document: TaskDocument
}): React.JSX.Element {
  const { t: literatureText } = useTranslation('literature')
  const { t: assistantText } = useTranslation('assistant')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const project = state.projects.find((item) => item.path === thread.projectPath)
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const rowAnchorRef = React.useRef<HTMLElement | null>(null)
  const onActionsOpenChange = React.useContext(OverviewActionsContext)
  React.useEffect(() => {
    if (!open) return
    onActionsOpenChange(true)
    return () => onActionsOpenChange(false)
  }, [open])
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          onClick={(event) => {
            rowAnchorRef.current =
              event.currentTarget.closest<HTMLElement>('.group\\/overview-file')
          }}
          icon={<EllipsisVertical />}
          label={assistantText('artifactEntry.moreActions', { name: document.title })}
          size="sm"
          variant="ghostIcon"
          className={OVERVIEW_ACTION_CLASS}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className={`${MENU_CLASS_NAME} !z-[var(--vds-z-inline-flyout)]`}
        side="left"
        align="start"
        horizontalAnchorRef={rowAnchorRef}
        sideOffset="--vds-space-3"
      >
        <DropdownMenuItem
          disabled={!document.literature_id}
          onSelect={() =>
            void act.openLiteratureAttachment(
              document.literature_id,
              document.attachment_id ?? undefined
            )
          }
        >
          {literatureText('list.rowMenu.viewPdf')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!document.literature_id || !project}
          onSelect={() => {
            if (project) void act.openLiteratureItem(document.literature_id, project.id)
          }}
        >
          {literatureText('list.rowMenu.viewInfo')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!document.title.trim()}
          onSelect={() => {
            void writeClipboard(document.title).then(
              () => toast({ title: literatureText('list.rowMenu.titleCopied'), tone: 'success' }),
              () => toast({ title: literatureText('list.rowMenu.copyTitleFailed'), tone: 'error' })
            )
          }}
        >
          {literatureText('list.rowMenu.copyTitle')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function OverviewFileActions({
  file,
}: {
  file: { name: string; path: string; absolutePath: string; artifact?: SessionArtifact }
  boundaryRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  if (file.artifact)
    return <ArtifactEntry primary={file.artifact} versions={[file.artifact]} mode="overview" />
  return <WorkingFileActions file={file} />
}

function WorkingFileActions({
  file,
}: {
  file: { name: string; absolutePath: string }
}): React.JSX.Element {
  const { t } = useTranslation(['assistant', 'resources'])
  const { state, act } = useApp()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const rowAnchorRef = React.useRef<HTMLElement | null>(null)
  const onActionsOpenChange = React.useContext(OverviewActionsContext)
  const wasOpen = React.useRef(false)
  React.useEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    onActionsOpenChange(open)
  }, [open])
  const [apps, setApps] = useState<OpenWithApp[] | null>(null)
  const [loading, setLoading] = useState(false)
  React.useEffect(() => {
    setApps(null)
  }, [file.absolutePath])
  const result = async (
    action: Promise<{ ok: boolean; error?: string }>,
    title: string
  ): Promise<void> => {
    setOpen(false)
    const response = await action
    if (!response.ok) toast({ title, description: response.error, tone: 'error' })
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          onClick={(event) => {
            rowAnchorRef.current =
              event.currentTarget.closest<HTMLElement>('.group\\/overview-file')
          }}
          icon={<EllipsisVertical />}
          label={t('artifactEntry.moreActions', { name: file.name })}
          size="sm"
          variant="ghostIcon"
          className={OVERVIEW_ACTION_CLASS}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className={`${MENU_CLASS_NAME} !z-[var(--vds-z-inline-flyout)]`}
        side="left"
        align="start"
        horizontalAnchorRef={rowAnchorRef}
        sideOffset="--vds-space-3"
      >
        <ArtifactMenuItems
          kind="dropdown"
          overview
          apps={apps}
          appsLoading={loading}
          canSaveAs={false}
          canUsePath={Boolean(file.absolutePath)}
          downloading={false}
          canImport={Boolean(state.homeSelectedProjectId)}
          onImport={() => {
            setOpen(false)
            void act.importResourceFiles('copy', [file.absolutePath])
          }}
          loadApps={() => {
            if (loading || apps !== null) return
            setLoading(true)
            void appsForFile(file.absolutePath)
              .then(setApps)
              .finally(() => setLoading(false))
          }}
          onCopyPath={() => {
            setOpen(false)
            void writeClipboard(file.absolutePath).then(
              () => toast({ title: t('artifactEntry.pathCopied'), tone: 'success' }),
              () => toast({ title: t('artifactEntry.copyPathFailed'), tone: 'error' })
            )
          }}
          onOpenWith={(app) =>
            void result(
              openPathWith(file.absolutePath, app.path),
              t('artifactEntry.openWithFailed', { app: app.name })
            )
          }
          onReveal={() =>
            void result(revealSystemPath(file.absolutePath), t('artifactEntry.revealFailed'))
          }
          onSaveAs={() => {}}
          revealLabel={t(revealLabelKey())}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function isMarkdownArtifact(artifact: SessionArtifact): boolean {
  const mediaType = (artifact.media_type ?? '').split(';', 1)[0].trim().toLocaleLowerCase()
  const lowerPath = artifact.path.toLocaleLowerCase()
  return (
    lowerPath.endsWith('.md') ||
    lowerPath.endsWith('.markdown') ||
    MARKDOWN_MEDIA_TYPES.has(mediaType)
  )
}

function artifactType(artifact: SessionArtifact, fileLabel: string): string {
  const suffix = artifact.name.split('.').at(-1)?.trim().toLocaleLowerCase()
  if (isMarkdownArtifact(artifact)) return 'Markdown'
  if (suffix === 'py') return 'Python'
  if (suffix) return suffix.toLocaleUpperCase()
  return artifact.media_type?.split(';', 1)[0] || fileLabel
}

function artifactAbsolutePath(artifact: SessionArtifact, workdir?: string): string {
  if (artifact.absolute_path) return artifact.absolute_path
  return workdir
    ? `${workdir.replace(/\/$/, '')}/${artifact.path.replace(/^\//, '')}`
    : artifact.path
}

function fileNameParts(name: string): { base: string; suffix?: string } {
  const separator = name.lastIndexOf('.')
  if (separator <= 0) return { base: name }
  return { base: name.slice(0, separator), suffix: name.slice(separator) }
}

export function ArtifactCard({
  items,
  turnId,
}: {
  items: ArtifactItem[]
  turnId?: string
}): React.JSX.Element {
  const { state } = useApp()
  const thread = activeThread(state)
  const group = (
    <ArtifactGroup>
      {artifactVersionGroups(items).map((versions) => (
        <ArtifactEntry
          key={versions[0].artifact.artifact_id}
          primary={versions[0].artifact}
          versions={versions.map((item) => item.artifact)}
        />
      ))}
    </ArtifactGroup>
  )
  return (
    <section data-testid="turn-artifacts" data-turn-id={turnId} data-message-turn-id={turnId}>
      {thread.sessionId ? (
        <GeneratedImages
          sessionId={thread.sessionId}
          artifacts={artifactVersionGroups(items).map((versions) => versions[0].artifact)}
          renderActions={(artifact) => (
            <ArtifactEntry
              key={artifact.artifact_id + ':' + artifact.sha256}
              primary={artifact}
              versions={[artifact]}
              mode="actions"
            />
          )}
        >
          {group}
        </GeneratedImages>
      ) : (
        group
      )}
    </section>
  )
}

export function ArtifactEntry({
  primary,
  versions,
  mode = 'card',
  context,
}: {
  primary: SessionArtifact
  versions: SessionArtifact[]
  mode?: 'card' | 'actions' | 'overview'
  context?: { sessionId: string | null; projectPath?: string | null; workdir?: string }
}): React.JSX.Element {
  const { state, act, set } = useApp()
  const { t: a } = useTranslation(['assistant', 'resources'])
  const { toast } = useToast()
  const thread = context ?? activeThread(state)
  const [dropdownMenuOpen, setDropdownMenuOpen] = useState(false)
  const rowAnchorRef = React.useRef<HTMLElement | null>(null)
  const onActionsOpenChange = React.useContext(OverviewActionsContext)
  const [openWithApps, setOpenWithApps] = useState<OpenWithApp[] | null>(null)
  const [openWithLoading, setOpenWithLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const actionsWereOpen = React.useRef(false)
  React.useEffect(() => {
    const next = dropdownMenuOpen || dialogOpen
    if (mode !== 'overview' || actionsWereOpen.current === next) return
    actionsWereOpen.current = next
    onActionsOpenChange(next)
  }, [dropdownMenuOpen, dialogOpen])
  const [saving, setSaving] = useState(false)
  const [savingLiterature, setSavingLiterature] = useState(false)
  const [literatureError, setLiteratureError] = useState<ArtifactError | null>(null)
  const [destination, setDestination] = useState<'resources' | 'literature'>('resources')
  const [literatureCollections, setLiteratureCollections] = useState<LibraryCollection[] | null>(
    null
  )
  const [literatureCollection, setLiteratureCollection] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<ArtifactError | null>(null)
  const [location, setLocation] = useState<ResourceLocationRef>({ parent: '', name: '' })
  const [resourceTree, setResourceTree] = useState(state.resource.tree)
  const [error, setError] = useState<ArtifactError | null>(null)
  const [targetProjectId, setTargetProjectId] = useState('')
  const primaryName = fileNameParts(primary.name)
  const absolutePath = artifactAbsolutePath(primary, thread.workdir)
  const canUsePath = Boolean(absolutePath && primary.status !== 'deleted')

  React.useEffect(() => {
    setOpenWithApps(null)
    setOpenWithLoading(false)
  }, [absolutePath])

  const closeMenus = (): void => {
    setDropdownMenuOpen(false)
  }

  const loadOpenWithApps = (): void => {
    if (!canUsePath || openWithLoading || openWithApps !== null) return
    setOpenWithLoading(true)
    void appsForFile(absolutePath)
      .then(setOpenWithApps)
      .finally(() => setOpenWithLoading(false))
  }

  const copyArtifactPath = async (): Promise<void> => {
    closeMenus()
    try {
      await writeClipboard(absolutePath)
      toast({ title: a('artifactEntry.pathCopied'), tone: 'success' })
    } catch {
      toast({ title: a('artifactEntry.copyPathFailed'), tone: 'error' })
    }
  }

  const revealArtifact = async (): Promise<void> => {
    closeMenus()
    const result = await revealSystemPath(absolutePath)
    if (!result.ok) {
      toast({ title: a('artifactEntry.revealFailed'), description: result.error, tone: 'error' })
    }
  }

  const openArtifactWith = async (app: OpenWithApp): Promise<void> => {
    closeMenus()
    const result = await openPathWith(absolutePath, app.path)
    if (!result.ok) {
      toast({
        title: a('artifactEntry.openWithFailed', { app: app.name }),
        description: result.error,
        tone: 'error',
      })
    }
  }

  const preview = (artifact: SessionArtifact): void => {
    const sessionId = thread.sessionId || undefined
    const absolute = artifactAbsolutePath(artifact, thread.workdir)
    void openByDefault(
      { relative: artifact.path, absolute, title: artifact.name },
      {
        openPreview: (target) =>
          act.openFilePreview({
            ...target,
            absolutePath: absolute,
            sessionId,
            artifactId: artifact.artifact_id,
            mediaType: artifact.media_type,
            size: artifact.size,
          }),
        onFailed: (_context, note) =>
          act.openFilePreview({
            path: artifact.path,
            absolutePath: absolute,
            sessionId,
            artifactId: artifact.artifact_id,
            title: artifact.name,
            mediaType: artifact.media_type,
            size: artifact.size,
            content: note,
          }),
      }
    )
  }

  const previewVersion = (artifact: SessionArtifact): void => {
    act.openFilePreview({
      path: artifact.path,
      absolutePath: artifactAbsolutePath(artifact, thread.workdir),
      sessionId: thread.sessionId || undefined,
      artifactId: artifact.artifact_id,
      title: artifact.name,
      mediaType: artifact.media_type,
      size: artifact.size,
    })
  }

  const sessionProject =
    state.projects.find((project) => project.path === thread.projectPath) ?? null
  const currentProject = state.homeSelectedProjectId
    ? (state.projects.find((project) => project.id === state.homeSelectedProjectId) ?? null)
    : null
  const targetProject = state.projects.find((project) => project.id === targetProjectId) ?? null

  const download = async (): Promise<void> => {
    if (!thread.sessionId || downloading) return
    setDownloading(true)
    setDownloadError(null)
    try {
      const file = await downloadSessionArtifact(thread.sessionId, primary.artifact_id)
      if (!file) {
        setDownloadError({ key: 'artifactEntry.readFailed' })
        return
      }
      const result = await window.scholarseed?.saveFileCopy({
        suggestedName: primary.name,
        bytes: file.bytes,
      })
      if (!result?.ok && !result?.canceled) {
        setDownloadError({ key: 'artifactEntry.copyFailed' })
        toast({ title: a('artifactEntry.copyFailed'), tone: 'error' })
      }
    } catch {
      setDownloadError({ key: 'artifactEntry.copyFailed' })
      toast({ title: a('artifactEntry.copyFailed'), tone: 'error' })
    } finally {
      setDownloading(false)
    }
  }

  const openImport = (): void => {
    closeMenus()
    if (saving) return
    const project = currentProject ?? sessionProject ?? state.projects[0]
    if (!project) return
    setTargetProjectId(project.id)
    setLocation({ parent: '', name: primaryName.base })
    setResourceTree(state.homeSelectedProjectId === project.id ? state.resource.tree : [])
    setError(null)
    setDestination('resources')
    setDialogOpen(true)
    void fetchResourceDirectoryTree(project.id).then(setResourceTree)
  }

  const selectTargetProject = (projectId: string): void => {
    setTargetProjectId(projectId)
    setLocation((current) => ({ ...current, parent: '' }))
    setResourceTree([])
    void fetchResourceDirectoryTree(projectId).then(setResourceTree)
  }

  const importArtifact = async (): Promise<void> => {
    if (!targetProject || saving || !thread.sessionId || !location.name.trim()) return
    setSaving(true)
    setError(null)
    const currentSha256 = await fetchArtifactSha256(thread.sessionId, primary.artifact_id)
    if (!currentSha256) {
      setSaving(false)
      setError({ key: 'artifactEntry.readFailed' })
      return
    }
    const result = await importArtifactToResources(thread.sessionId, primary.artifact_id, {
      projectId: targetProject.id,
      expectedSha256: currentSha256,
      location,
    })
    setSaving(false)
    if (!result.ok || !result.node) {
      setError(importError(assistantFailureDetail(result) ?? '', 'artifactEntry.importFailed'))
      return
    }
    await act.reloadArtifactLinks(thread.sessionId)
    setDialogOpen(false)
    if (state.homeSelectedProjectId === targetProject.id) {
      await act.reloadResourceTree()
    }
    const destination = location.parent
      ? `${targetProject.name}/${location.parent}`
      : targetProject.name
    act.noticeResource(
      'ok',
      { key: 'feedback.savedDestination', name: result.node.name, destination },
      { path: result.node.path, projectId: targetProject.id }
    )
  }

  const literatureEligible = LITERATURE_SUFFIXES.has(
    primary.name.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  )
  const literatureLinks =
    state.aiPanel.sessionId === thread.sessionId
      ? state.aiPanel.artifactLinks.filter(
          (link) => link.destination === 'literature' && link.artifact_id === primary.artifact_id
        )
      : []
  const literatureTargets = [
    ...new Map(
      literatureLinks.flatMap((link) =>
        link.destination === 'literature' && link.state === 'completed' && !link.error
          ? link.items.map(
              (item) =>
                [`${link.project_id}:${item.id}`, { ...item, projectId: link.project_id }] as const
            )
          : []
      )
    ).values(),
  ]
  const saveLiterature = async (): Promise<void> => {
    if (!thread.sessionId || !sessionProject || savingLiterature || !literatureCollections) return
    setSavingLiterature(true)
    setLiteratureError(null)
    try {
      const currentSha256 = await fetchArtifactSha256(thread.sessionId, primary.artifact_id)
      if (!currentSha256) {
        setLiteratureError({ key: 'artifactEntry.readFailed' })
        return
      }
      const result = await importArtifactToLiterature(
        thread.sessionId,
        primary.artifact_id,
        currentSha256,
        literatureCollection
      )
      if (!result.ok) {
        setLiteratureError(importError(result.error, 'artifactEntry.literatureFailed'))
        return
      }
      act.invalidateLiterature()
      const refreshed = await act.reloadArtifactLinks(thread.sessionId)
      if (!refreshed.ok) setLiteratureError({ key: 'artifactEntry.linksFailed' })
      else setDialogOpen(false)
    } finally {
      setSavingLiterature(false)
    }
  }
  const openLiteratureImport = async (): Promise<void> => {
    if (!sessionProject || savingLiterature) return
    setDestination('literature')
    setLiteratureError(null)
    setLiteratureCollection('')
    setLiteratureCollections(null)
    try {
      const [globalCollections, projectCollections] = await Promise.all([
        listLiteratureCollections(),
        listLiteratureCollections(sessionProject.id),
      ])
      setLiteratureCollections([...globalCollections, ...projectCollections])
    } catch {
      setLiteratureError({ key: 'artifactEntry.collectionsFailed' })
    }
  }
  /* 副标题只展示文件类型, 不再拼接「· Agent 产物」来源后缀。 */
  const primaryMeta = artifactType(primary, a('artifactEntry.file'))
  const links =
    state.aiPanel.sessionId === thread.sessionId
      ? state.aiPanel.artifactLinks.filter(
          (link): link is ArtifactResourceLink =>
            link.destination === 'resources' && link.artifact_id === primary.artifact_id
        )
      : []
  const linksState =
    state.aiPanel.sessionId === thread.sessionId ? state.aiPanel.artifactLinksState : 'idle'
  const revealLabel = a(revealLabelKey())
  const canImport =
    Boolean(thread.sessionId) && !saving && !savingLiterature && state.projects.length > 0
  const menuProps = {
    apps: openWithApps,
    appsLoading: openWithLoading,
    canSaveAs: Boolean(thread.sessionId),
    canUsePath,
    downloading,
    loadApps: loadOpenWithApps,
    onCopyPath: () => void copyArtifactPath(),
    onOpenWith: (app: OpenWithApp) => void openArtifactWith(app),
    onReveal: () => void revealArtifact(),
    onSaveAs: () => {
      closeMenus()
      void download()
    },
    revealLabel,
    revealIcon: (
      <img
        src={window.scholarseed?.platform === 'darwin' ? finderIcon : folderIcon}
        alt=""
        className="size-[var(--vds-icon-8)] shrink-0"
      />
    ),
  }

  const feedback = (
    <>
      {sessionProject && (linksState === 'idle' || linksState === 'loading') ? (
        <p
          role="status"
          className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]"
        >
          {a('artifactEntry.loadingLinks')}
        </p>
      ) : null}
      {sessionProject && linksState === 'error' ? (
        <div
          role="alert"
          className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]"
        >
          {a('artifactEntry.linksUnknown')}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => thread.sessionId && void act.reloadArtifactLinks(thread.sessionId)}
          >
            {a('artifactEntry.retry')}
          </Button>
        </div>
      ) : null}
      {links
        .filter((link) => link.state === 'pending' || link.error || !link.node)
        .map((link) => (
          <div
            key={link.link_id}
            data-artifact-link={link.link_id}
            className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]"
          >
            {link.state === 'pending'
              ? a('artifactEntry.savePending')
              : a('artifactEntry.targetUnavailable')}
          </div>
        ))}
      {downloadError ? (
        <p role="alert">{a(downloadError.key, { detail: downloadError.detail ?? '' })}</p>
      ) : null}
      {literatureLinks.map((link) =>
        link.destination === 'literature' ? (
          <div
            key={link.link_id}
            data-artifact-link={link.link_id}
            className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]"
          >
            {link.error ? (
              a('artifactEntry.linkUnavailable', { detail: link.error })
            ) : link.state === 'pending' ? (
              a('artifactEntry.literaturePending')
            ) : link.missing_ids.length ? (
              <p>{a('artifactEntry.missing', { count: link.missing_ids.length })}</p>
            ) : null}
          </div>
        ) : null
      )}
      {literatureTargets.length ? (
        <div className="min-w-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]">
          <p>{a('artifactEntry.imported', { count: literatureTargets.length })}</p>
          {literatureTargets.map((item) => (
            <Button
              key={`${item.projectId}:${item.id}`}
              className="min-w-0 max-w-full justify-start text-left"
              variant="ghost"
              size="sm"
              onClick={() => void act.openLiteratureItem(item.id, item.projectId)}
            >
              <EllipsisText tooltipPortalled>
                {a('artifactEntry.openName', { name: item.title })}
              </EllipsisText>
            </Button>
          ))}
        </div>
      ) : null}
      {literatureError ? (
        <p role="alert">{a(literatureError.key, { detail: literatureError.detail ?? '' })}</p>
      ) : null}
    </>
  )
  return (
    <>
      {mode !== 'card' ? (
        <DropdownMenu open={dropdownMenuOpen} onOpenChange={setDropdownMenuOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton
              data-testid={`output-actions-${primary.artifact_id}`}
              onClick={(event) => {
                rowAnchorRef.current =
                  mode === 'overview'
                    ? event.currentTarget.closest<HTMLElement>('.group\\/overview-file')
                    : null
              }}
              icon={<EllipsisVertical />}
              label={a('artifactEntry.moreActions', { name: primary.name })}
              size="sm"
              variant="ghostIcon"
              className={mode === 'overview' ? OVERVIEW_ACTION_CLASS : undefined}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className={`${MENU_CLASS_NAME} ${mode === 'overview' ? '!z-[var(--vds-z-inline-flyout)]' : ''}`}
            side={mode === 'overview' ? 'left' : undefined}
            horizontalAnchorRef={mode === 'overview' ? rowAnchorRef : undefined}
            sideOffset={mode === 'overview' ? '--vds-space-3' : undefined}
          >
            {mode !== 'overview' && (
              <>
                <DropdownMenuItem onSelect={() => void preview(primary)}>
                  {a('artifactEntry.open')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!primary.absolute_path || !canUsePath}
                  onSelect={() => {
                    closeMenus()
                    if (primary.absolute_path)
                      set((current) => ({
                        composerRefs: current.composerRefs.some(
                          (reference) =>
                            reference.type === 'file' && reference.path === primary.absolute_path
                        )
                          ? current.composerRefs
                          : [
                              ...current.composerRefs,
                              {
                                type: 'file',
                                id: primary.absolute_path!,
                                path: primary.absolute_path!,
                                title: primary.name,
                                registrationRequired: true,
                                mediaType: primary.media_type,
                                size: primary.size,
                              },
                            ],
                        aiPanel: { ...current.aiPanel, open: true },
                      }))
                  }}
                >
                  {a('artifactEntry.addToConversation')}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canImport} onSelect={openImport}>
                  {a('artifactEntry.import')}
                </DropdownMenuItem>
              </>
            )}
            <ArtifactMenuItems
              {...menuProps}
              kind="dropdown"
              overview={mode === 'overview'}
              onImport={openImport}
              canImport={canImport}
            />
            <div className="grid min-w-0 gap-[var(--vds-space-2)] whitespace-normal break-words px-[var(--vds-space-2)] text-left [&_p]:m-0">
              {feedback}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Artifact
          primary={primary}
          versions={versions}
          primaryMeta={primaryMeta}
          canImport={canImport}
          menuProps={menuProps}
          preview={preview}
          previewVersion={previewVersion}
          openImport={openImport}
        >
          {thread.sessionId && <GeneratedImage sessionId={thread.sessionId} artifact={primary} />}
          {feedback}
        </Artifact>
      )}
      <ResourceSaveDialog
        description={a('artifactEntry.copyDescription')}
        error={
          destination === 'literature'
            ? literatureError
              ? a(literatureError.key, { detail: literatureError.detail ?? '' })
              : ''
            : error
              ? a(error.key, { detail: error.detail ?? '' })
              : ''
        }
        fixedSuffix={primaryName.suffix}
        location={location}
        onLocationChange={setLocation}
        onOpenChange={(open) => {
          if (!saving && !savingLiterature) setDialogOpen(open)
        }}
        onSubmit={() => void (destination === 'literature' ? saveLiterature() : importArtifact())}
        open={dialogOpen}
        projectName={targetProject?.name ?? a('artifactEntry.currentProject')}
        projectOptions={currentProject ? undefined : state.projects}
        selectedProjectId={targetProjectId}
        onProjectChange={currentProject ? undefined : selectTargetProject}
        saving={saving || savingLiterature}
        submitDisabled={destination === 'literature' && literatureCollections === null}
        rootLabel={a('save.materialsRoot')}
        summary={
          destination === 'literature'
            ? a('artifactEntry.literatureDescription', {
                name: sessionProject?.name ?? a('artifactEntry.currentProject'),
              })
            : a('artifactEntry.copyDescription')
        }
        title={a('artifactEntry.saveResources')}
        tree={resourceTree}
        destination={destination}
        onDestinationChange={
          literatureEligible && sessionProject
            ? (value) => {
                if (value === 'literature') void openLiteratureImport()
                else setDestination(value)
              }
            : undefined
        }
        literatureContent={
          <LiteratureCollections
            collections={literatureCollections}
            projectId={sessionProject?.id}
            projectName={sessionProject?.name ?? a('artifactEntry.currentProject')}
            value={literatureCollection}
            onValueChange={setLiteratureCollection}
            disabled={savingLiterature}
            failed={literatureError?.key === 'artifactEntry.collectionsFailed'}
            onRetry={() => void openLiteratureImport()}
          />
        }
      />
    </>
  )
}
