import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureSearchPaper } from '../../contracts/literature'
import { Button, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger, useToast, type ButtonSize, type ButtonVariant } from '../../components/ui'
import { useApp } from '../../store'
import { CreateCollectionDialog } from './CreateCollectionDialog'
import { DestinationRows, MENU_BOUNDS } from './DestinationTree'
import { createLiteratureCollection, getLiteratureProjects, listLiteratureCollections } from './api'
import { collectionNodes, flattenDestinations, paperJoinKey, pushLibItem, type JoinDestination, type JoinNode } from './join'
import { joinedCollectionCreated, recordJoined, useJoinedPapers } from './joinState'

export function JoinedLabel(): React.JSX.Element {
  const { t } = useTranslation('literature')
  return <span className="inline-flex flex-wrap items-center gap-[var(--vds-space-1)] text-[var(--vds-text-secondary)]" data-testid="literature-joined">
    <Check size="1em" aria-hidden="true" /><span>{t('join.added')}</span>
  </span>
}
export function JoinLibraryMenu({ papers, onJoined, className, size = 'sm', variant = 'secondary' }: {
  papers: LiteratureSearchPaper[]; onJoined?: (papers: LiteratureSearchPaper[], destination: JoinDestination) => void; className?: string; size?: ButtonSize; variant?: ButtonVariant
}): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  const { t } = useTranslation('literature')
  const { toast } = useToast()
  const receipts = useJoinedPapers()
  const [open, setOpen] = useState(false)
  const [branch, setBranch] = useState('')
  const [tree, setTree] = useState<{ collections: JoinNode[]; projects: JoinNode[] } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const targets = useRef<LiteratureSearchPaper[]>([])
  const [creation, setCreation] = useState<JoinDestination | null>(null)
  const [name, setName] = useState('')
  const [parentKey, setParentKey] = useState('root')
  const [formError, setFormError] = useState(false)
  const created = useRef<JoinDestination | null>(null)
  const root: JoinDestination = { projectId, path: [] }
  useEffect(() => { setOpen(false); setCreation(null); setTree(null) }, [projectId])
  useEffect(() => {
    if (!open) return
    let active = true
    setLoadError(false); setTree(null); setBranch('')
    Promise.all([listLiteratureCollections(projectId), getLiteratureProjects()]).then(([collections, projects]) => {
      if (active) setTree({ collections: collectionNodes(collections, projectId), projects: projects.projects.map(project => ({
        key: `project:${project.id}`, name: project.name, projectId: project.id, path: [project.name],
        children: collectionNodes(project.collections, project.id, [project.name])
      })) })
    }).catch(() => { if (active) setLoadError(true) })
    return () => { active = false }
  }, [open, projectId])
  const admit = async (destination: JoinDestination): Promise<void> => {
    const items = targets.current
    await pushLibItem(items, destination, projectId)
    recordJoined(items.flatMap(paper => [paperJoinKey(paper), paperJoinKey(paper, destination.projectId)]), destination)
    onJoined?.(items, destination)
    toast({ title: t('join.success', { count: items.length }), tone: 'success' })
  }
  const choose = async (destination: JoinDestination): Promise<void> => {
    if (locked.current) return
    locked.current = true; setBusy(true); setOpen(false)
    try { await admit(destination) } catch { toast({ title: t('join.failed'), tone: 'error' }) }
    finally { locked.current = false; setBusy(false) }
  }
  const creationProject = tree?.projects.find(project => project.projectId === creation?.projectId)
  const creationRoot: JoinDestination = { projectId: creation?.projectId, path: !projectId && creationProject ? creationProject.path : [] }
  const options = tree ? flattenDestinations(!projectId && creation?.projectId ? creationProject?.children ?? [] : tree.collections) : []
  const create = (parent: JoinDestination): void => {
    setParentKey(parent.collectionId ? `collection:${parent.collectionId}` : 'root')
    setName(t('join.untitled')); setFormError(false); created.current = null; setCreation(parent); setOpen(false)
  }
  const submit = async (): Promise<void> => {
    if (locked.current || !name.trim()) return
    locked.current = true; setBusy(true); setFormError(false)
    try {
      if (!created.current) {
        const parent = options.find(option => option.node.key === parentKey)?.node ?? creationRoot
        const collection = await createLiteratureCollection(name.trim(), parent.projectId, parent.collectionId)
        created.current = { projectId: parent.projectId, collectionId: collection.id, path: [...parent.path, collection.name] }
        const ancestors: string[] = []
        const find = (nodes: JoinNode[], path: string[]): boolean => nodes.some(node => {
          const next = node.collectionId ? [...path, node.collectionId] : path
          if (node.collectionId === parent.collectionId && node.projectId === parent.projectId) { ancestors.push(...next); return true }
          return find(node.children, next)
        })
        if (parent.collectionId && tree) find([...tree.collections, ...tree.projects], [])
        joinedCollectionCreated({ id: collection.id, projectId: parent.projectId, ancestors })
      }
      await admit(created.current)
      setCreation(null); setOpen(false)
    } catch { setFormError(true) }
    finally { locked.current = false; setBusy(false) }
  }
  const selectedReceipt = papers.length === 1 ? receipts.get(paperJoinKey(papers[0], projectId)) : undefined
  if (selectedReceipt) return <JoinedLabel />
  return <>
    <DropdownMenu open={open} onOpenChange={value => {
      if (busy) return
      if (value) targets.current = papers.filter(paper => !receipts.has(paperJoinKey(paper, projectId)))
      setOpen(value)
    }}>
      <DropdownMenuTrigger asChild><Button className={className} variant={variant} size={size} loading={busy} disabled={!papers.length || busy}
        onClick={event => event.stopPropagation()} data-testid="join-library-trigger">{t('join.button')}<ChevronDown size="1em" aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent className={MENU_BOUNDS} onClick={event => event.stopPropagation()} onKeyDownCapture={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
      }}>
        <DropdownMenuItem onPointerEnter={() => setBranch('')} onSelect={() => { void choose(root) }}>{t('join.direct')}</DropdownMenuItem>
        <DropdownMenuSub open={branch === 'collections'} onOpenChange={value => setBranch(value ? 'collections' : '')}>
          <DropdownMenuSubTrigger openOnHover disabled={!tree}>{t('join.collection')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={MENU_BOUNDS} autoFocus={false}><DestinationRows nodes={tree?.collections ?? []} parent={root} choose={node => { void choose(node) }} create={create} /></DropdownMenuSubContent>
        </DropdownMenuSub>
        {!projectId && Boolean(tree?.projects.length) && <DropdownMenuSub open={branch === 'projects'} onOpenChange={value => setBranch(value ? 'projects' : '')}>
          <DropdownMenuSubTrigger openOnHover>{t('join.project')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={MENU_BOUNDS} autoFocus={false}><DestinationRows nodes={tree!.projects} choose={node => { void choose(node) }} create={create} /></DropdownMenuSubContent>
        </DropdownMenuSub>}
        {loadError && <DropdownMenuItem disabled>{t('join.loadFailed')}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <CreateCollectionDialog open={Boolean(creation)} name={name} parentKey={parentKey} options={options} busy={busy}
      fieldsLocked={Boolean(created.current)} error={formError ? t(created.current ? 'join.createdImportFailed' : 'join.createFailed') : undefined}
      confirmLabel={created.current ? t('join.button') : undefined} onClose={() => setCreation(null)}
      onNameChange={setName} onParentChange={setParentKey} onSubmit={() => { void submit() }} />
  </>
}
