import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DestinationTree, type DestinationNode } from '../../components/business/Destination'
import { fileIconForName } from '../../components/primitive'
import {
  Alert, AlertTitle, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogPortal, EllipsisText, Input, ScrollArea, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner,
  Tabs, TabsList, TabsTrigger, useToast
} from '../../components/ui'
import type { LiteratureAttachmentSummary, LiteratureFacet } from '../../contracts/literature'
import { Icon } from '../../icons'
import { selectedProject, useApp } from '../../store'
import { fetchResourceTree, mutateResourceNode } from '../resources/api'
import { resourceDefaultName } from '../resources/lifecycle'
import {
  importLiteratureAttachment, LiteratureApiError, previewAttachmentImport,
  type AttachmentImportOptions, type AttachmentImportPreview
} from './api'
import { claimSubmission } from './submission'

const ACTION = { create: 'create', replace: 'replace' } as const
type ImportFailure = { kind: 'operation' | 'partial' | 'tree' | 'folder'; code?: string; path?: string }

function ImportToastMessage({ name }: { name: string }): React.JSX.Element {
  const { t } = useTranslation('literature')
  return <>{t('import.saved', { name })}</>
}

const PDF_MEDIA_TYPE = 'application/pdf'
const IMPORT_DIALOG_CLASS = '!w-[min(672px,calc(100vw-var(--vds-space-6)))] !max-w-2xl max-h-[calc(100dvh-var(--vds-space-6))] !flex !flex-col min-w-0 overflow-hidden'
const ERROR_KEYS = {
  import_plan_stale: 'import.errors.stale', revision_conflict: 'import.errors.stale',
  source_record_revision_conflict: 'import.errors.stale', target_record_revision_conflict: 'import.errors.stale',
  source_revision_conflict: 'import.errors.stale', prepared_content_conflict: 'import.errors.stale',
  replace_not_supported: 'import.errors.replace', version_management_disabled: 'import.errors.management',
  file_too_large: 'import.errors.size', mount_conflict: 'import.errors.name', root_exists: 'import.errors.name',
  name_exists: 'import.errors.name', source_inside_project: 'import.errors.inside',
  source_not_found: 'import.errors.missing', literature_pdf_missing: 'import.errors.missing',
  literature_attachment_missing: 'import.errors.missing', literature_attachment_unreadable: 'import.errors.missing',
  attachment_records_unsupported: 'import.errors.records',
  invalid_name: 'import.errors.name', invalid_mount: 'import.errors.name',
  idempotency_conflict: 'import.errors.retry'
} as const

function fileSuffix(name: string): string {
  const offset = name.lastIndexOf('.')
  return offset > 0 ? name.slice(offset).toLowerCase() : ''
}

function mergeChildren(nodes: DestinationNode[], path: string, children: DestinationNode[]): DestinationNode[] {
  return nodes.map((node) => node.path === path ? { ...node, children } : {
    ...node, ...(node.children ? { children: mergeChildren(node.children, path, children) } : {})
  })
}

export function AttachmentImportDialog({
  open, onOpenChange, itemId, attachment, projects, initialProject
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  itemId: string
  attachment: LiteratureAttachmentSummary
  projects: LiteratureFacet[]
  initialProject: string
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: resourceText } = useTranslation('resources')
  const { act, state } = useApp()
  const { toast } = useToast()
  const titleId = useId()
  const descriptionId = useId()
  const [project, setProject] = useState(initialProject)
  const [action, setAction] = useState<string>(ACTION.create)
  const [parent, setParent] = useState('')
  const [root, setRoot] = useState('')
  const [name, setName] = useState(attachment.name)
  const [target, setTarget] = useState('')
  const [nodes, setNodes] = useState<DestinationNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [remaining, setRemaining] = useState<Record<string, number>>({})
  const [offsets, setOffsets] = useState<Record<string, number>>({})
  const supportsRecords = attachment.media_type === PDF_MEDIA_TYPE
  const AttachmentIcon = fileIconForName(attachment.name)
  const sourceSuffix = fileSuffix(attachment.name)
  const [copyRecords, setCopyRecords] = useState(supportsRecords)
  const [confirmedRecords, setConfirmedRecords] = useState(false)
  const [newFolder, setNewFolder] = useState<{ parent: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [treeBusy, setTreeBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [preview, setPreview] = useState<AttachmentImportPreview | null>(null)
  const key = useRef(crypto.randomUUID())
  const submitting = useRef(false)
  const generation = useRef(0)
  const replacing = action === ACTION.replace
  // 附件导入只有"拷贝进项目"这一种取向: 文献附件是文献自己独占的文件, 把它链接
  // 进项目会让项目资源指着文献库里的路径, 文献一删就悬空。
  const options: AttachmentImportOptions = {
    project, parent, name: name.trim(),
    ...(replacing ? { replace_path: target } : {}),
    copy_records: supportsRecords && copyRecords,
    replace_records: supportsRecords && replacing && copyRecords && confirmedRecords
  }
  const failureDescription = (failure: ImportFailure): string => {
    const errorKey = ERROR_KEYS[failure.code as keyof typeof ERROR_KEYS] ?? 'import.failed'
    return failure.kind === 'partial'
      ? t('import.partial', { path: failure.path ?? '' })
      : failure.kind === 'tree'
        ? t('import.treeFailed')
        : failure.kind === 'folder'
          ? t('import.folderFailed')
          : t(errorKey)
  }
  const showImportFailure = (failure: ImportFailure): void => {
    toast({
      tone: 'error',
      title: t('import.failed'),
      description: failureDescription(failure)
    })
  }
  const showFailure = (reason: unknown): void => {
    const code = reason instanceof LiteratureApiError ? reason.failure.code : ''
    const path = reason instanceof LiteratureApiError ? reason.failure.fields?.path : undefined
    showImportFailure(path ? { kind: 'partial', path } : { kind: 'operation', code })
  }

  useEffect(() => {
    const current = ++generation.current
    setNodes([]); setRoot(''); setParent(''); setTarget(''); setExpanded({})
    setRemaining({}); setOffsets({}); setPreview(null); setNewFolder(null)
    if (!open || !project) return
    setTreeBusy(true)
    void fetchResourceTree(project).then((page) => {
      if (current !== generation.current) return
      if (!page) { showImportFailure({ kind: 'tree' }); return }
      setRoot(''); setParent(''); setNodes(page.nodes)
      setRemaining({ ['']: page.total - page.nodes.length })
      setOffsets({ ['']: page.nodes.length })
    }).finally(() => { if (current === generation.current) setTreeBusy(false) })
    return () => { generation.current++ }
  }, [open, project])

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    key.current = crypto.randomUUID()
    if (!open || !project || !name.trim() || treeBusy || (replacing && !target) ||
      (replacing && copyRecords && !confirmedRecords)) { setPreparing(false); return }
    setPreparing(true)
    void previewAttachmentImport(itemId, attachment.id, options)
      .then((value) => { if (!cancelled) setPreview(value) })
      .catch((reason: unknown) => { if (!cancelled) showFailure(reason) })
      .finally(() => { if (!cancelled) setPreparing(false) })
    return () => { cancelled = true }
  }, [open, project, parent, name, action, target, copyRecords, confirmedRecords, treeBusy, itemId, attachment.id])

  const loadDirectory = async (path: string, more = false): Promise<void> => {
    const current = generation.current
    setTreeBusy(true)
    const page = await fetchResourceTree(project, path, more ? offsets[path] ?? 0 : 0)
    if (current !== generation.current) return
    setTreeBusy(false)
    if (!page) { showImportFailure({ kind: 'tree' }); return }
    setNodes((currentNodes) => {
      const find = (items: DestinationNode[]): DestinationNode | undefined => {
        for (const node of items) {
          if (node.path === path) return node
          const child = node.children && find(node.children)
          if (child) return child
        }
        return undefined
      }
      const old = path === root ? currentNodes : find(currentNodes)?.children ?? []
      const children = more ? [...old, ...page.nodes] : page.nodes
      return path === root ? children : mergeChildren(currentNodes, path, children)
    })
    const nextOffset = page.offset + page.nodes.length
    setOffsets((values) => ({ ...values, [path]: nextOffset }))
    setRemaining((values) => ({ ...values, [path]: page.total - nextOffset }))
  }
  const toggle = (path: string): void => {
    setNewFolder(null)
    if (!expanded[path]) void loadDirectory(path)
    setExpanded((values) => ({ ...values, [path]: !values[path] }))
  }
  const changeAction = (value: string): void => {
    setAction(value); setTarget(''); setConfirmedRecords(false); setNewFolder(null)
    setCopyRecords(supportsRecords && value === ACTION.create)
  }
  const submit = async (): Promise<void> => {
    if (newFolder || !preview || preview.conflict && !replacing || busy || treeBusy) return
    if (!claimSubmission(submitting)) return
    setBusy(true)
    try {
      const receipt = await importLiteratureAttachment(itemId, attachment.id, options, preview, key.current)
      toast({ title: <ImportToastMessage name={name.trim()} />, tone: 'success' })
      onOpenChange(false)
      if (selectedProject(state)?.id === receipt.project) void act.reloadResourceTree()
    } catch (reason) { showFailure(reason) } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const beginFolder = async (): Promise<void> => {
    const current = generation.current
    await loadDirectory(parent)
    if (current !== generation.current) return
    setExpanded((values) => ({ ...values, [parent]: true }))
    setNewFolder({ parent, name: resourceDefaultName('create_folder', resourceText) })
  }
  const createFolder = async (): Promise<void> => {
    if (!newFolder?.name.trim() || busy || treeBusy) return
    setBusy(true)
    try {
      const result = await mutateResourceNode('create_folder', { parent: newFolder.parent, name: newFolder.name.trim() }, project)
      if (!result.ok || !result.node) { showImportFailure({ kind: 'folder' }); return }
      await loadDirectory(newFolder.parent)
      setExpanded((values) => ({ ...values, [newFolder.parent]: true }))
      setParent(result.node.path); setNewFolder(null)
    } finally { setBusy(false) }
  }
  const selectable = (node: DestinationNode): boolean => replacing
    ? node.kind === 'file' && fileSuffix(node.name) === sourceSuffix &&
      node.origin !== 'link' && node.version?.managementState === 'managed' && !node.version.needsReview
    : node.kind === 'dir'
  const recordControls = supportsRecords ? <div><Checkbox data-testid="literature-copy-records" label={t('attachment.copyRecords')} checked={copyRecords} onCheckedChange={(value) => { setCopyRecords(value); setConfirmedRecords(false) }} disabled={busy} /><div className="ml-[var(--vds-space-5)] text-[var(--vds-text-secondary)]">{t('import.recordsHint')}</div>{replacing && copyRecords ? <Checkbox className="mt-[var(--vds-space-2)]" label={t('import.confirmRecords')} checked={confirmedRecords} onCheckedChange={setConfirmedRecords} disabled={busy} /> : null}</div> : null
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value) }}>
      <DialogPortal><DialogContent className={IMPORT_DIALOG_CLASS} aria-labelledby={titleId} aria-describedby={descriptionId} hideCloseButton={busy}>
        <DialogHeader className="shrink-0 min-w-0">
          <DialogTitle id={titleId}>{t('attachment.copyToProject')}</DialogTitle>
          <DialogDescription id={descriptionId}>{t('import.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea orientation="both" className="min-h-0 min-w-0 flex-1 flex flex-col overflow-hidden" viewportClassName="!min-h-0 !max-h-none min-w-0 flex-1 w-full pb-[var(--vds-space-1)] [scrollbar-gutter:stable] ![scrollbar-width:auto] ![scrollbar-color:auto]" viewportProps={{ 'data-testid': 'literature-import-scroll' }}>
          <div className="grid min-w-0 grid-cols-1 gap-[var(--vds-space-3)]">
            <div className="flex min-w-0 items-center gap-[calc(var(--vds-space-3)/2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-default)] p-[var(--vds-space-3)]">
              <AttachmentIcon size={16} className="shrink-0" aria-hidden="true" />
              <div className="min-w-0 break-all font-medium">{attachment.name}</div>
            </div>
            <Select aria-label={t('attachment.targetProject')} value={project} onValueChange={setProject} disabled={busy} data-testid="literature-copy-project">
              <span className="block mb-[var(--vds-space-1)]">{t('attachment.targetProject')}</span>
              <SelectTrigger><SelectValue placeholder={t('attachment.selectTargetProject')} /></SelectTrigger>
              <SelectContent>{projects.filter((entry) => !entry.project_id).map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}</SelectContent>
            </Select>
            <Tabs value={action} onValueChange={changeAction} disabled={busy}><TabsList className="w-full"><TabsTrigger className="flex-1" value={ACTION.create}>{t('import.create')}</TabsTrigger><TabsTrigger className="flex-1" value={ACTION.replace}>{t('import.replace')}</TabsTrigger></TabsList></Tabs>
            <div>
              <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)] mb-[var(--vds-space-1)]"><span>{t(replacing ? 'import.chooseFile' : 'import.location')}</span>{!replacing ? <Button variant="ghost" disabled={!project || busy || treeBusy || newFolder !== null} icon={<Icon name="folder-plus" size={14} />} onClick={() => void beginFolder()}>{resourceText('destination.newFolder')}</Button> : null}</div>
              <div className="rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] p-[var(--vds-space-2)]">
                <Button variant={!replacing && parent === root ? 'secondary' : 'ghost'} className="w-full !justify-start" disabled={busy || !project} onClick={() => { if (!replacing) { setNewFolder(null); setParent(root) } }} icon={treeBusy ? <Spinner aria-label={t('import.loading')} size="sm" /> : <Icon name="folder" size={14} />}>{t('import.root')}</Button>
                <DestinationTree rootPath={root} folderDraft={newFolder && !replacing ? { ...newFolder, onChange: (value) => setNewFolder({ ...newFolder, name: value }), onCommit: () => void createFolder(), onCancel: () => setNewFolder(null) } : undefined} nodes={nodes} selected={replacing ? target : parent} expanded={expanded} onToggle={toggle} onSelect={(path) => { setNewFolder(null); if (replacing) setTarget(path); else setParent(path) }} selectable={selectable} showFiles={replacing} disabled={busy || treeBusy} remaining={remaining} onLoadMore={(path) => void loadDirectory(path, true)} />
                {(remaining[root] ?? 0) > 0 ? <Button variant="ghost" disabled={treeBusy || busy} onClick={() => void loadDirectory(root, true)}>{resourceText('panel.loadMore', { count: remaining[root] })}</Button> : null}
              </div>
              <div className="mt-[var(--vds-space-1)] break-all text-[var(--vds-text-secondary)]">{replacing ? target || t('import.noTarget') : parent || t('import.root')}</div>
            </div>
            {!replacing ? <Input label={t('import.name')} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /> : null}
            {recordControls}
            {replacing ? <Alert tone="warning" title={t('import.replaceHint')} description={t('import.replaceLimit')} /> : null}
            {preview?.conflict && !replacing ? <Alert tone="warning"><AlertTitle>{t('import.conflict')}</AlertTitle><div className="grid gap-[var(--vds-space-2)]"><span>{preview.path}</span><Button variant="secondary" onClick={() => setName(preview.suggested_name ?? name)}>{t('import.rename', { name: preview.suggested_name ?? name })}</Button><Button variant="secondary" disabled={!preview.can_replace} onClick={() => { changeAction(ACTION.replace); setTarget(preview.path) }}>{t('import.replace')}</Button></div></Alert> : null}
          </div>
        </ScrollArea>
        <DialogFooter className="min-w-0 shrink-0 flex-wrap">
          <EllipsisText wrapperClassName="flex-1" className="text-[var(--vds-text-secondary)]" tooltipPortalled>{preview?.path ?? ''}</EllipsisText>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('import.cancel')}</Button>
          <Button data-testid="literature-import-submit" loading={busy || preparing} disabled={newFolder !== null || !preview || treeBusy || (preview.conflict && !replacing) || (replacing && !preview.can_replace)} onClick={() => void submit()}>{t(replacing ? 'import.submitReplace' : 'import.submitCopy')}</Button>
        </DialogFooter>
      </DialogContent></DialogPortal>
    </Dialog>
  )
}
