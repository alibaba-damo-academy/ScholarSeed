import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ArtifactItem } from '../../activity'
import { appsForFile, downloadSessionArtifact, openPathWith, revealSystemPath, type OpenWithApp } from '../../api'
import { writeClipboard } from '../../components/primitive/clipboard'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import {
  Button,
  Card,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EllipsisText,
  IconButton,
  Select,
  useToast
} from '../../components/ui'
import type { ArtifactResourceLink } from '../../contracts/assistant'
import type { ResourceLocationRef } from '../../contracts/resources'
import { openByDefault, revealLabelKey } from '../../fileOpen'
import { Icon } from '../../icons'
import type { SessionArtifact } from '../../model'
import { activeThread, useApp } from '../../store'
import { fetchLiterature } from '../literature/api'
import { UNFILED_COLLECTION } from '../literature/state'
import { fetchArtifactSha256, fetchResourceDirectoryTree, importArtifactToLiterature, importArtifactToResources, listArtifactResourceLinks } from './api'
import { assistantFailureDetail } from './failure'
import { ResourceSaveDialog } from './Save'

const IMPORT_ERROR_TEXT = {
  assistant_project_unavailable: 'artifactEntry.projectUnavailable',
  session_artifact_not_found: 'artifactEntry.notFound',
  session_artifact_path_forbidden: 'artifactEntry.pathForbidden',
  session_artifact_revision_conflict: 'artifactEntry.revisionConflict',
  session_artifact_integrity_mismatch: 'artifactEntry.integrityMismatch'
} as const

type ArtifactError = { key: 'artifactEntry.collectionsFailed' | 'artifactEntry.copyFailed' | 'artifactEntry.importFailed' | 'artifactEntry.integrityMismatch' | 'artifactEntry.linksFailed' | 'artifactEntry.literatureFailed' | 'artifactEntry.notFound' | 'artifactEntry.pathForbidden' | 'artifactEntry.projectUnavailable' | 'artifactEntry.readFailed' | 'artifactEntry.revisionConflict'; detail?: string }

function importError(detail: string, fallback: 'artifactEntry.importFailed' | 'artifactEntry.literatureFailed'): ArtifactError {
  const key = Object.prototype.hasOwnProperty.call(IMPORT_ERROR_TEXT, detail)
    ? IMPORT_ERROR_TEXT[detail as keyof typeof IMPORT_ERROR_TEXT]
    : undefined
  return key ? { key } : { key: fallback, detail }
}

const MARKDOWN_MEDIA_TYPES = new Set(['text/markdown', 'text/x-markdown'])
const LITERATURE_SUFFIXES = new Set(['bib', 'bibtex', 'ris', 'pdf'])
const EXTRA_ARTIFACT_ACTIONS_VISIBLE = false
const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} text-[length:var(--vds-font-body-lv2)]`
const SUBMENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} max-w-[var(--vds-model-menu-max-width)] overflow-y-auto text-[length:var(--vds-font-body-lv2)]`
const MENU_HINT_CLASS_NAME = 'px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'

type ArtifactMenuKind = 'context' | 'dropdown'

interface ArtifactMenuItemsProps {
  apps: OpenWithApp[] | null
  appsLoading: boolean
  canImport: boolean
  canSaveAs: boolean
  canUsePath: boolean
  downloading: boolean
  kind: ArtifactMenuKind
  loadApps: () => void
  onCopyPath: () => void
  onImport: () => void
  onOpenWith: (app: OpenWithApp) => void
  onReveal: () => void
  onSaveAs: () => void
  revealLabel: string
}

function ArtifactMenuItems({
  apps,
  appsLoading,
  canImport,
  canSaveAs,
  canUsePath,
  downloading,
  kind,
  loadApps,
  onCopyPath,
  onImport,
  onOpenWith,
  onReveal,
  onSaveAs,
  revealLabel
}: ArtifactMenuItemsProps): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Separator = kind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator
  const Sub = kind === 'context' ? ContextMenuSub : DropdownMenuSub
  const SubContent = kind === 'context' ? ContextMenuSubContent : DropdownMenuSubContent
  const SubTrigger = kind === 'context' ? ContextMenuSubTrigger : DropdownMenuSubTrigger

  return (
    <>
      <Item data-testid={`artifact-${kind}-import`} disabled={!canImport} onSelect={onImport}>
        {t('artifactEntry.import')}
      </Item>
      <Sub>
        <SubTrigger
          data-testid={`artifact-${kind}-open-with`}
          disabled={!canUsePath}
          onClick={loadApps}
          onMouseEnter={loadApps}
        >
          {t('artifactEntry.openWith')}
        </SubTrigger>
        <SubContent className={SUBMENU_CLASS_NAME}>
          {appsLoading && <div className={MENU_HINT_CLASS_NAME}>{t('artifactEntry.loadingApps')}</div>}
          {!appsLoading && apps !== null && apps.length === 0 && (
            <div className={MENU_HINT_CLASS_NAME}>{t('artifactEntry.noApps')}</div>
          )}
          {!appsLoading && apps?.map((app) => (
            <Item key={app.path} onSelect={() => onOpenWith(app)}>
              <span className="min-w-0 flex-1 truncate">{app.name}</span>
              {app.isDefault && (
                <span className="ml-auto text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                  {t('artifactEntry.defaultApp')}
                </span>
              )}
            </Item>
          ))}
        </SubContent>
      </Sub>
      <Separator />
      <Item data-testid={`artifact-${kind}-save-as`} disabled={!canSaveAs || downloading} onSelect={onSaveAs}>
        {t('artifactEntry.saveAs')}
      </Item>
      <Item data-testid={`artifact-${kind}-copy-path`} disabled={!canUsePath} onSelect={onCopyPath}>
        {t('artifactEntry.copyPath')}
      </Item>
      <Item data-testid={`artifact-${kind}-reveal`} disabled={!canUsePath} onSelect={onReveal}>
        {revealLabel}
      </Item>
    </>
  )
}

function isMarkdownArtifact(artifact: SessionArtifact): boolean {
  const mediaType = (artifact.media_type ?? '').split(';', 1)[0].trim().toLocaleLowerCase()
  const lowerPath = artifact.path.toLocaleLowerCase()
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')
    || MARKDOWN_MEDIA_TYPES.has(mediaType)
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
  turnId
}: {
  items: ArtifactItem[]
  turnId?: string
}): React.JSX.Element {
  return (
    <section data-testid="turn-artifacts" data-turn-id={turnId} data-message-turn-id={turnId}>
      {items.map(({ artifact }) => (
        <ArtifactEntry key={artifact.artifact_id} primary={artifact} />
      ))}
    </section>
  )
}

function ArtifactEntry({ primary }: { primary: SessionArtifact }): React.JSX.Element {
  const { state, act } = useApp()
  const { t: a } = useTranslation('assistant')
  const { toast } = useToast()
  const thread = activeThread(state)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [dropdownMenuOpen, setDropdownMenuOpen] = useState(false)
  const [openWithApps, setOpenWithApps] = useState<OpenWithApp[] | null>(null)
  const [openWithLoading, setOpenWithLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingLiterature, setSavingLiterature] = useState(false)
  const [literatureError, setLiteratureError] = useState<ArtifactError | null>(null)
  const [literatureDialogOpen, setLiteratureDialogOpen] = useState(false)
  const [literatureCollections, setLiteratureCollections] = useState<string[] | null>(null)
  const [literatureCollection, setLiteratureCollection] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [downloadError, setDownloadError] = useState<ArtifactError | null>(null)
  const [location, setLocation] = useState<ResourceLocationRef>({ parent: '', name: '' })
  const [resourceTree, setResourceTree] = useState(state.resource.tree)
  const [error, setError] = useState<ArtifactError | null>(null)
  const [targetProjectId, setTargetProjectId] = useState('')
  const previewScope = React.useRef({ sessionId: thread.sessionId, projectId: state.homeSelectedProjectId })
  previewScope.current = { sessionId: thread.sessionId, projectId: state.homeSelectedProjectId }
  const primaryName = fileNameParts(primary.name)
  const absolutePath = artifactAbsolutePath(primary, thread.workdir)
  const canUsePath = Boolean(absolutePath && primary.status !== 'deleted')

  React.useEffect(() => {
    setOpenWithApps(null)
    setOpenWithLoading(false)
  }, [absolutePath])

  const closeMenus = (): void => {
    setContextMenuOpen(false)
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
      toast({ title: a('artifactEntry.openWithFailed', { app: app.name }), description: result.error, tone: 'error' })
    }
  }

  const preview = async (artifact: SessionArtifact): Promise<void> => {
    if (opening) return
    const sessionId = thread.sessionId || undefined
    const projectId = state.homeSelectedProjectId
    if (sessionId && projectId) {
      setOpening(true)
      const result = await listArtifactResourceLinks(sessionId)
      setOpening(false)
      if (previewScope.current.sessionId !== sessionId || previewScope.current.projectId !== projectId) return
      if (!result.ok) {
        toast({ title: a('artifactEntry.linksUnknown'), tone: 'error' })
        return
      }
      const resource = result.links.find((link) => link.artifact_id === artifact.artifact_id
        && link.project_id === projectId && link.state === 'completed' && !link.error && link.node)
      if (resource?.node) {
        act.openResourceFile(resource.node.path, resource.project_id)
        return
      }
      if (links.some((link) => link.project_id === projectId && link.state === 'completed' && link.node)) {
        void act.reloadArtifactLinks(sessionId)
      }
    }
    const absolute = artifactAbsolutePath(artifact, thread.workdir)
    void openByDefault(
      { relative: artifact.path, absolute, title: artifact.name },
      {
        openPreview: (target) => act.openFilePreview({
          ...target,
          absolutePath: absolute,
          sessionId,
          artifactId: artifact.artifact_id,
          mediaType: artifact.media_type,
          size: artifact.size
        }),
        onFailed: (_context, note) => act.openFilePreview({
          path: artifact.path,
          absolutePath: absolute,
          sessionId,
          artifactId: artifact.artifact_id,
          title: artifact.name,
          mediaType: artifact.media_type,
          size: artifact.size,
          content: note
        })
      }
    )
  }

  const sessionProject = state.projects.find((project) => project.path === thread.projectPath) ?? null
  const currentProject = state.homeSelectedProjectId
    ? state.projects.find((project) => project.id === state.homeSelectedProjectId) ?? null
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
        bytes: file.bytes
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
    setResourceTree(
      state.homeSelectedProjectId === project.id ? state.resource.tree : []
    )
    setError(null)
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
    const result = await importArtifactToResources(
      thread.sessionId,
      primary.artifact_id,
      {
        projectId: targetProject.id,
        expectedSha256: currentSha256,
        location
      }
    )
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
    const destination = location.parent ? `${targetProject.name}/${location.parent}` : targetProject.name
    act.noticeResource(
      'ok',
      { key: 'feedback.savedDestination', name: result.node.name, destination },
      { path: result.node.path, projectId: targetProject.id }
    )
  }

  const literatureEligible = LITERATURE_SUFFIXES.has(primary.name.split('.').at(-1)?.toLocaleLowerCase() ?? '')
  const literatureLinks = state.aiPanel.sessionId === thread.sessionId
    ? state.aiPanel.artifactLinks.filter((link) => link.destination === 'literature'
      && link.artifact_id === primary.artifact_id)
    : []
  const literatureTargets = [...new Map(literatureLinks.flatMap((link) =>
    link.destination === 'literature' && link.state === 'completed' && !link.error
      ? link.items.map((item) => [`${link.project_id}:${item.id}`, { ...item, projectId: link.project_id }] as const)
      : []
  )).values()]
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
      const result = await importArtifactToLiterature(thread.sessionId, primary.artifact_id, currentSha256, literatureCollection)
      if (!result.ok) {
        setLiteratureError(importError(result.error, 'artifactEntry.literatureFailed'))
        return
      }
      const refreshed = await act.reloadArtifactLinks(thread.sessionId)
      if (!refreshed.ok) setLiteratureError({ key: 'artifactEntry.linksFailed' })
      else setLiteratureDialogOpen(false)
      if (state.homeSelectedProjectId === sessionProject.id) await act.reloadLiterature()
    } finally {
      setSavingLiterature(false)
    }
  }
  const openLiteratureImport = async (): Promise<void> => {
    if (!sessionProject || savingLiterature) return
    setLiteratureDialogOpen(true)
    setLiteratureError(null)
    setLiteratureCollection('')
    setLiteratureCollections(null)
    const view = await fetchLiterature({}, sessionProject.id)
    if (!view) {
      setLiteratureError({ key: 'artifactEntry.collectionsFailed' })
      return
    }
    setLiteratureCollections(view.collections.map((collection) => collection.name).filter((name) => name !== UNFILED_COLLECTION))
  }
  /* 副标题只展示文件类型, 不再拼接「· Agent 产物」来源后缀。 */
  const primaryMeta = artifactType(primary, a('artifactEntry.file'))
  const links = state.aiPanel.sessionId === thread.sessionId
    ? state.aiPanel.artifactLinks.filter((link): link is ArtifactResourceLink => link.destination === 'resources' && link.artifact_id === primary.artifact_id)
    : []
  const linksState = state.aiPanel.sessionId === thread.sessionId
    ? state.aiPanel.artifactLinksState : 'idle'
  const projectName = sessionProject?.name ?? a('artifactEntry.unlinked')
  const revealLabel = a(revealLabelKey())
  const menuProps = {
    apps: openWithApps,
    appsLoading: openWithLoading,
    canImport: Boolean(thread.sessionId) && !saving && state.projects.length > 0,
    canSaveAs: Boolean(thread.sessionId),
    canUsePath,
    downloading,
    loadApps: loadOpenWithApps,
    onCopyPath: () => void copyArtifactPath(),
    onImport: openImport,
    onOpenWith: (app: OpenWithApp) => void openArtifactWith(app),
    onReveal: () => void revealArtifact(),
    onSaveAs: () => { closeMenus(); void download() },
    revealLabel
  }

  return (
    <>
      <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
        <ContextMenuTrigger asChild>
          {/* 与执行计划卡片一致: bordered 背景/边框 + 12px 圆角 + 无阴影。 */}
          <Card className="mt-[var(--vds-space-3)] grid gap-[var(--vds-space-3)] !shadow-none [--vds-card-radius:var(--vds-radius-6)]" padding="sm" data-artifact-role={primary.role}>
            <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]" data-testid={`turn-artifact-${primary.artifact_id}`}>
              <span className="grid size-8 shrink-0 place-items-center rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-muted)] text-[var(--vds-text-secondary)]"><Icon name="doc" size={20} sw={1.8} /></span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <EllipsisText
                  className="text-[length:var(--vds-font-body-lv2)] font-medium leading-relaxed text-[var(--vds-text-primary)]"
                  tooltip={`${primary.title || primary.name}\n${primary.path}`}
                  tooltipContentClassName="whitespace-pre-wrap"
                  tooltipPortalled
                >
                  {primary.title || primary.name}
                </EllipsisText>
                <EllipsisText className="text-xs font-normal text-[var(--vds-text-secondary)]" tooltipPortalled>
                  {primaryMeta}
                </EllipsisText>
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)]">
                <DropdownMenu open={dropdownMenuOpen} onOpenChange={setDropdownMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      data-testid="artifact-more-actions"
                      icon={<Icon name="more-horizontal" size={16} />}
                      label={a('artifactEntry.moreActions', { name: primary.title || primary.name })}
                      size="sm"
                      variant="ghostIcon"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className={MENU_CLASS_NAME} data-testid="artifact-dropdown-menu">
                    <ArtifactMenuItems {...menuProps} kind="dropdown" />
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  aria-label={a('artifactEntry.openName', { name: primary.name })}
                  disabled={opening}
                  loading={opening}
                  onClick={() => void preview(primary)}
                  title={a('artifactEntry.openName', { name: primary.name })}
                  size="sm"
                  variant="outline"
                >
                  {a('artifactEntry.open')}
                </Button>
                {EXTRA_ARTIFACT_ACTIONS_VISIBLE && literatureEligible ? (
                  <Button data-testid="artifact-import-literature" size="sm" variant="secondary"
                    disabled={!sessionProject || savingLiterature} loading={savingLiterature}
                    onClick={() => void openLiteratureImport()}>
                    {a('artifactEntry.importLiterature')}
                  </Button>
                ) : null}
              </div>
            </div>
            {sessionProject && (linksState === 'idle' || linksState === 'loading')
              ? <p role="status" className="text-xs text-[var(--vds-text-secondary)]">{a('artifactEntry.loadingLinks')}</p> : null}
            {sessionProject && linksState === 'error' ? (
              <div role="alert" className="text-xs text-[var(--vds-text-secondary)]">
                {a('artifactEntry.linksUnknown')}
                <Button variant="ghost" size="sm" onClick={() => thread.sessionId && void act.reloadArtifactLinks(thread.sessionId)}>{a('artifactEntry.retry')}</Button>
              </div>
            ) : null}
            {links.filter((link) => link.state === 'pending' || link.error || !link.node).map((link) => (
              <div key={link.link_id} data-artifact-link={link.link_id} className="text-xs text-[var(--vds-text-secondary)]">
                {link.state === 'pending' ? a('artifactEntry.savePending')
                  : a('artifactEntry.targetUnavailable')}
              </div>
            ))}
            {downloadError ? <p role="alert">{a(downloadError.key, { detail: downloadError.detail ?? '' })}</p> : null}
            {literatureLinks.map((link) => link.destination === 'literature' ? (
              <div key={link.link_id} data-artifact-link={link.link_id} className="text-xs text-[var(--vds-text-secondary)]">
                {link.error ? a('artifactEntry.linkUnavailable', { detail: link.error })
                  : link.state === 'pending' ? a('artifactEntry.literaturePending')
                    : link.missing_ids.length ? <p>{a('artifactEntry.missing', { count: link.missing_ids.length })}</p> : null}
              </div>
            ) : null)}
            {literatureTargets.length ? <div className="text-xs text-[var(--vds-text-secondary)]">
              <p>{a('artifactEntry.imported', { count: literatureTargets.length })}</p>
              {literatureTargets.map((item) => <Button key={`${item.projectId}:${item.id}`} variant="ghost" size="sm"
                onClick={() => void act.openLiteratureItem(item.id, item.projectId)}>
                {a('artifactEntry.openName', { name: item.title })}
              </Button>)}
            </div> : null}
            {literatureError ? <p role="alert">{a(literatureError.key, { detail: literatureError.detail ?? '' })}</p> : null}
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent className={MENU_CLASS_NAME} data-testid="artifact-context-menu">
          <ArtifactMenuItems {...menuProps} kind="context" />
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={literatureDialogOpen} onOpenChange={(open) => { if (!savingLiterature) setLiteratureDialogOpen(open) }}>
        <DialogPortal>
          <DialogContent aria-label={a('artifactEntry.importLiterature')}>
            <DialogHeader>
              <DialogTitle>{a('artifactEntry.importLiterature')}</DialogTitle>
              <DialogDescription>{a('artifactEntry.literatureDescription', { name: projectName })}</DialogDescription>
            </DialogHeader>
            <Select label={a('artifactEntry.collection')} value={literatureCollection} onValueChange={setLiteratureCollection}
              disabled={savingLiterature || literatureCollections === null}>
              <option value="">{a('artifactEntry.unfiled')}</option>
              {(literatureCollections ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
            </Select>
            {literatureError ? <p role="alert">{a(literatureError.key, { detail: literatureError.detail ?? '' })}</p> : null}
            <DialogFooter>
              <Button variant="ghost" disabled={savingLiterature} onClick={() => setLiteratureDialogOpen(false)}>{a('artifactEntry.cancel')}</Button>
              <Button loading={savingLiterature} disabled={savingLiterature || literatureCollections === null}
                onClick={() => void saveLiterature()}>{a('artifactEntry.confirm')}</Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <ResourceSaveDialog
        description={a('artifactEntry.copyDescription')}
        error={error ? a(error.key, { detail: error.detail ?? '' }) : ''}
        fixedSuffix={primaryName.suffix}
        location={location}
        onLocationChange={setLocation}
        onOpenChange={setDialogOpen}
        onSubmit={() => void importArtifact()}
        open={dialogOpen}
        projectName={targetProject?.name ?? a('artifactEntry.currentProject')}
        projectOptions={currentProject ? undefined : state.projects}
        selectedProjectId={targetProjectId}
        onProjectChange={currentProject ? undefined : selectTargetProject}
        saving={saving}
        summary={a('artifactEntry.copyDescription')}
        title={a('artifactEntry.saveResources')}
        tree={resourceTree}
      />
    </>
  )
}
