import { CircleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DestinationTree, type DestinationNode } from '../../components/business/Destination'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  EllipsisText,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../components/ui'
import type { LiteratureDeliveryBatch, LiteratureDeliveryChoice } from '../../contracts/literature'
import { useApp } from '../../store'
import { Icon } from '../../icons'
import { fetchResourceTree } from '../resources/api'
import { listLiteratureCollections, requestLiteratureDelivery, type LibraryCollection } from './api'
import { catalogue } from './catalog'
import { RESOURCE_ROOT, deliveryChoiceMatches, resourceFolderNodes } from './utils'

export const LITERATURE_DELIVERY_CARD = 'literature-delivery'
const DELIVERY_SCHEMA = '1.0'
const DESTINATION = { project: 'project', directory: 'directory' } as const
const ACTION = { cancel: 'cancel' } as const
const UNFILED = '__unfiled__'
const NO_FOLDER = '__none__'
const ERROR_MESSAGE = 'delivery.failed'
const VERSION_UNDECIDED = '__undecided__'
const VERSION_ACTIONS = { keep: 'keep_both', skip: 'skip' } as const
const STATUS_KEYS = {
  acquiring: 'delivery.status.acquiring',
  pending: 'delivery.status.pending',
  saving: 'delivery.status.saving',
  saved: 'delivery.status.saved',
  partial: 'delivery.status.partial',
  canceled: 'delivery.status.canceled',
} as const

function replaceChildren(
  nodes: DestinationNode[],
  path: string,
  children: DestinationNode[]
): DestinationNode[] {
  return nodes.map((node) =>
    node.path === path
      ? { ...node, children }
      : {
          ...node,
          ...(node.children ? { children: replaceChildren(node.children, path, children) } : {}),
        }
  )
}

export function LiteratureDeliveryCard({
  content,
}: {
  content: Record<string, unknown>
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { state, act } = useApp()
  const [batch, setBatch] = useState<LiteratureDeliveryBatch | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [target, setTarget] = useState<LiteratureDeliveryChoice['target']>(DESTINATION.project)
  const [parent, setParent] = useState('')
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [ticket, setTicket] = useState('')
  const [directory, setDirectory] = useState('')
  const [addToLibrary, setAddToLibrary] = useState(false)
  const [versions, setVersions] = useState<NonNullable<LiteratureDeliveryChoice['versions']>>({})
  const [collection, setCollection] = useState(UNFILED)
  const [collections, setCollections] = useState<LibraryCollection[]>([])
  const [nodes, setNodes] = useState<DestinationNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [remaining, setRemaining] = useState<Record<string, number>>({})
  const [offsets, setOffsets] = useState<Record<string, number>>({})
  const [treeBusy, setTreeBusy] = useState(false)
  const choice: LiteratureDeliveryChoice = {
    target,
    parent,
    ticket,
    add_to_library: addToLibrary,
    collection_id: addToLibrary && collection !== UNFILED ? collection : '',
  }
  const choiceMatches = deliveryChoiceMatches(batch?.choice, choice)
  const generation = useRef(0)
  const sessionId = typeof content.session_id === 'string' ? content.session_id : ''
  const deliveryId = typeof content.delivery_id === 'string' ? content.delivery_id : ''
  const valid = content.schema_version === DELIVERY_SCHEMA && Boolean(sessionId && deliveryId)

  const refresh = async (): Promise<LiteratureDeliveryBatch> => {
    const value = await requestLiteratureDelivery(sessionId, deliveryId)
    setBatch(value)
    return value
  }

  useEffect(() => {
    if (!valid) return
    let active = true
    void requestLiteratureDelivery(sessionId, deliveryId)
      .then((value) => {
        if (active) setBatch(value)
      })
      .catch(() => {
        if (active) setError(t(ERROR_MESSAGE))
      })
    return () => {
      active = false
    }
  }, [sessionId, deliveryId, valid])

  useEffect(() => {
    setVersions({})
  }, [target, parent, ticket, addToLibrary, collection])

  useEffect(() => {
    const current = ++generation.current
    if (!open || !batch) return
    setTicket('')
    setFoldersOpen(false)
    setVersions({})
    if (batch.choice) {
      setTarget(batch.choice.target)
      setParent(batch.choice.parent)
      setAddToLibrary(batch.choice.add_to_library)
      setCollection(batch.choice.collection_id || UNFILED)
      setDirectory(batch.choice.directory || '')
    } else {
      setTarget(DESTINATION.project)
      setParent('')
      setAddToLibrary(false)
      setCollection(UNFILED)
      setDirectory('')
    }
    setTreeBusy(true)
    void fetchResourceTree(batch.project_id)
      .then((page) => {
        if (current !== generation.current) return
        if (!page || typeof page.resourceRoot !== 'string') {
          setError(t(ERROR_MESSAGE))
          return
        }
        setNodes(resourceFolderNodes(page.nodes, page.resourceRoot))
        setRemaining({ '': page.total - page.nodes.length })
        setOffsets({ '': page.nodes.length })
      })
      .finally(() => {
        if (current === generation.current) setTreeBusy(false)
      })
    void listLiteratureCollections(batch.project_id)
      .then((value) => {
        if (current === generation.current) setCollections(value)
      })
      .catch(() => {
        if (current === generation.current) setError(t(ERROR_MESSAGE))
      })
    return () => {
      generation.current++
    }
  }, [open, batch?.id])

  const loadDirectory = async (path: string, more = false): Promise<void> => {
    if (!batch) return
    const current = generation.current
    const page = await fetchResourceTree(batch.project_id, path, more ? (offsets[path] ?? 0) : 0)
    if (current !== generation.current) return
    if (!page || typeof page.resourceRoot !== 'string') {
      setError(t(ERROR_MESSAGE))
      return
    }
    setNodes((value) => {
      let previous: DestinationNode[] = []
      const find = (items: DestinationNode[]): void => {
        for (const node of items) {
          if (node.path === path) previous = node.children ?? []
          else if (node.children) find(node.children)
        }
      }
      find(value)
      const incoming = resourceFolderNodes(page.nodes, page.resourceRoot, path)
      const children = more
        ? [...new Map([...previous, ...incoming].map((node) => [node.path, node])).values()]
        : incoming
      return path
        ? replaceChildren(value, path, children)
        : more
          ? [...new Map([...value, ...incoming].map((node) => [node.path, node])).values()]
          : incoming
    })
    const count = page.offset + page.nodes.length
    setOffsets((value) => ({ ...value, [path]: count }))
    setRemaining((value) => ({ ...value, [path]: Math.max(0, page.total - count) }))
  }

  const chooseDirectory = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.scholarseed?.pickDeliveryDirectory({ sessionId, deliveryId })
      if (result?.ok && result.ticket && result.label) {
        setTicket(result.ticket)
        setDirectory(result.label)
        setTarget(DESTINATION.directory)
      } else if (!result?.canceled) setError(t('delivery.chooseFailed'))
    } catch {
      setError(t('delivery.chooseFailed'))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!batch) return
    setBusy(true)
    setError('')
    try {
      const result = await window.scholarseed?.saveDelivery({
        sessionId,
        deliveryId,
        choice: {
          ...choice,
          versions: choiceMatches ? versions : {},
        },
      })
      if (!result?.ok || !result.value) throw new Error(ERROR_MESSAGE)
      const value = result.value as LiteratureDeliveryBatch
      setBatch(value)
      setVersions({})
      if (value.papers.some((paper) => paper.library === 'saved')) catalogue.reload()
      if (state.homeSelectedProjectId === value.project_id) {
        await act.reloadResourceTree(undefined, value.project_id)
        await act.reloadLiterature()
      }
      if (value.state === 'saved') setOpen(false)
    } catch {
      setError(t(ERROR_MESSAGE))
    } finally {
      setBusy(false)
    }
  }

  const close = async (): Promise<void> => {
    if (busy) return
    setOpen(false)
    try {
      setBatch(await requestLiteratureDelivery(sessionId, deliveryId, ACTION.cancel))
    } catch {
      setError(t(ERROR_MESSAGE))
    }
  }

  const reopen = async (): Promise<void> => {
    setError('')
    try {
      await refresh()
      setOpen(true)
    } catch {
      setError(t(ERROR_MESSAGE))
    }
  }

  const openDirectory = async (): Promise<void> => {
    const result = await window.scholarseed?.openDeliveryDirectory({ sessionId, deliveryId })
    if (!result?.ok) setError(t('delivery.openFailed'))
  }

  if (!valid)
    return (
      <Alert tone="warning">
        <AlertDescription>{t('delivery.invalid')}</AlertDescription>
      </Alert>
    )
  const acquired = batch?.papers.length ?? Number(content.count ?? 0)
  const saved = batch?.papers.filter((paper) => paper.saved === 'saved').length ?? 0
  const admitted = batch?.papers.filter((paper) => paper.library === 'saved').length ?? 0
  const reused =
    batch?.papers.filter((paper) => paper.save_reused || paper.library_reused).length ?? 0
  const skipped = batch?.papers.filter((paper) => paper.saved === 'skipped').length ?? 0
  const librarySkipped =
    batch?.papers.filter((paper) => paper.saved === 'saved' && paper.library === 'skipped')
      .length ?? 0
  const conflicts = choiceMatches
    ? (batch?.papers.filter((paper) => paper.versions?.length) ?? [])
    : []
  const projectName =
    state.projects.find((project) => project.id === batch?.project_id)?.name ??
    t('delivery.project')
  const projectPath = t('delivery.projectPath', { path: parent })
  return (
    <>
      <Card data-testid="literature-delivery-card">
        <CardHeader>
          <CardTitle>{t('delivery.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-[var(--vds-space-3)]">
          <p>{t('delivery.counts', { acquired, saved, admitted })}</p>
          {batch && (
            <p>
              {t(
                batch.state === 'saved' && skipped === acquired
                  ? 'delivery.allSkipped'
                  : STATUS_KEYS[batch.state]
              )}
            </p>
          )}
          {reused > 0 && (
            <p data-testid="delivery-reused">{t('delivery.reused', { count: reused })}</p>
          )}
          {skipped > 0 && <p>{t('delivery.skipped', { count: skipped })}</p>}
          {librarySkipped > 0 && <p>{t('delivery.librarySkipped', { count: librarySkipped })}</p>}
          {error && (
            <Alert tone="warning">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-[var(--vds-space-2)]">
            <Button variant="outline" disabled={!acquired || busy} onClick={() => void reopen()}>
              {t('delivery.save')}
            </Button>
            {saved > 0 && (
              <Button variant="secondary" onClick={() => void openDirectory()}>
                {t('delivery.openFolder')}
              </Button>
            )}
          </div>
          {batch?.papers
            .filter((paper) => paper.literature_id)
            .map((paper) => (
              <Button
                key={paper.paper_id}
                variant="ghost"
                className="w-full min-w-0 !justify-start text-left"
                onClick={() => void act.openLiteratureItem(paper.literature_id, batch.project_id)}
              >
                <EllipsisText
                  wrapperClassName="min-w-0 flex-1"
                  className="text-left"
                  tooltipPortalled
                >
                  {paper.title}
                </EllipsisText>
              </Button>
            ))}
        </CardContent>
      </Card>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close()
        }}
      >
        <DialogPortal>
          <DialogContent
            className="flex min-w-0 flex-col overflow-hidden max-h-[calc(100dvh-var(--vds-space-6))]"
            hideCloseButton={busy}
            data-testid="literature-delivery-dialog"
          >
            <DialogHeader className="shrink-0">
              <DialogTitle>{t('delivery.title')}</DialogTitle>
              <DialogDescription>
                {t('delivery.description', { count: acquired })}
              </DialogDescription>
            </DialogHeader>
            <ScrollArea
              className="flex min-h-0 flex-1 flex-col"
              viewportClassName="min-h-0 flex-1"
              viewportProps={{ 'data-testid': 'literature-delivery-body' }}
            >
              <div className="grid grid-cols-1 gap-[var(--vds-space-3)] [&>*]:min-w-0">
                <Popover open={foldersOpen} onOpenChange={setFoldersOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full min-w-0 !justify-between"
                      data-testid="delivery-project-folder"
                      disabled={busy || treeBusy}
                      aria-label={t('delivery.chooseProjectFolder')}
                    >
                      <EllipsisText wrapperClassName="min-w-0 flex-1" tooltipPortalled>
                        {target === DESTINATION.project
                          ? projectPath
                          : t('delivery.chooseProjectFolder')}
                      </EllipsisText>
                      <Icon name="chevron-down" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[var(--vds-popover-width-md)] max-w-full"
                    data-testid="delivery-project-tree"
                  >
                    <DestinationTree
                      nodes={[
                        {
                          path: RESOURCE_ROOT,
                          name: t('delivery.projectRoot'),
                          kind: 'dir',
                          children: nodes,
                        },
                      ]}
                      selected={target === DESTINATION.project ? parent : NO_FOLDER}
                      expanded={{ [RESOURCE_ROOT]: true, ...expanded }}
                      disabled={busy || treeBusy}
                      onSelect={(path) => {
                        setParent(path)
                        setTarget(DESTINATION.project)
                        setFoldersOpen(false)
                      }}
                      onToggle={(path) => {
                        setExpanded((value) => ({
                          ...value,
                          [path]: !(value[path] ?? path === RESOURCE_ROOT),
                        }))
                        void loadDirectory(path)
                      }}
                      remaining={remaining}
                      onLoadMore={(path) => void loadDirectory(path, true)}
                    />
                  </PopoverContent>
                </Popover>
                {target === DESTINATION.directory && (
                  <EllipsisText tooltipPortalled>
                    {t('delivery.localDestination', {
                      path: directory || t('delivery.noDirectory'),
                    })}
                  </EllipsisText>
                )}
                <Button variant="secondary" disabled={busy} onClick={() => void chooseDirectory()}>
                  {t('delivery.chooseDirectory')}
                </Button>
                <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)]">
                  <Checkbox
                    checked={addToLibrary}
                    onCheckedChange={setAddToLibrary}
                    disabled={busy}
                    label={t('delivery.addToLibrary', { project: projectName })}
                  />
                  <Tooltip portalled side="bottom">
                    <TooltipTrigger asChild>
                      <IconButton
                        icon={<CircleAlert />}
                        label={t('delivery.help')}
                        variant="ghostIcon"
                        size="sm"
                        data-testid="delivery-help"
                      />
                    </TooltipTrigger>
                    <TooltipContent data-testid="delivery-help-content">
                      <span className="grid gap-[var(--vds-space-2)]">
                        {target === DESTINATION.project && (
                          <span>{t('delivery.projectNotice')}</span>
                        )}
                        <span>{t('delivery.libraryScope')}</span>
                        <span>{t('delivery.noOverwrite')}</span>
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </div>
                {addToLibrary && (
                  <Select value={collection} onValueChange={setCollection} disabled={busy}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNFILED}>{t('delivery.unfiled')}</SelectItem>
                      {collections.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {error && (
                  <Alert tone="warning">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                {conflicts.length > 0 && (
                  <div
                    className="grid gap-[var(--vds-space-3)]"
                    data-testid="delivery-version-conflicts"
                  >
                    <Alert tone="warning">
                      <AlertDescription truncate={false}>
                        {t('delivery.versionConflict')}
                      </AlertDescription>
                    </Alert>
                    {conflicts.map((paper) => (
                      <div
                        key={paper.paper_id}
                        className="grid min-w-0 gap-[var(--vds-space-2)]"
                        data-testid="delivery-version-conflict"
                      >
                        <EllipsisText tooltipPortalled>{paper.title}</EllipsisText>
                        <Select
                          value={versions[paper.paper_id] ?? VERSION_UNDECIDED}
                          disabled={busy}
                          onValueChange={(value) => {
                            if (value === VERSION_ACTIONS.keep || value === VERSION_ACTIONS.skip)
                              setVersions((current) => ({ ...current, [paper.paper_id]: value }))
                          }}
                        >
                          <SelectTrigger
                            aria-label={t('delivery.versionChoice', { title: paper.title })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={VERSION_UNDECIDED} disabled>
                              {t('delivery.versionUndecided')}
                            </SelectItem>
                            <SelectItem value={VERSION_ACTIONS.keep}>
                              {t('delivery.keepBoth')}
                            </SelectItem>
                            <SelectItem value={VERSION_ACTIONS.skip}>
                              {t('delivery.skipVersion')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
                {batch?.state === 'partial' && !conflicts.length && (
                  <Alert tone="warning">
                    <AlertDescription>{t('delivery.partial')}</AlertDescription>
                  </Alert>
                )}
              </div>
            </ScrollArea>
            <DialogFooter className="shrink-0" data-testid="literature-delivery-footer">
              <Button variant="secondary" disabled={busy} onClick={() => void close()}>
                {t('delivery.later')}
              </Button>
              <Button
                disabled={
                  busy ||
                  treeBusy ||
                  !batch ||
                  conflicts.some((paper) => !versions[paper.paper_id]) ||
                  (target === DESTINATION.directory && !ticket)
                }
                onClick={() => void save()}
              >
                {t(
                  busy
                    ? 'delivery.saving'
                    : batch?.state === 'partial' && choiceMatches
                      ? 'delivery.retry'
                      : 'delivery.confirm'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  )
}
