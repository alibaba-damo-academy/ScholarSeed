import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../store'
import { Joining } from './Joining'
import type { LiteratureSearchPaper } from '../../contracts/literature'
import { Button, useToast } from '../../components/ui'
import { JoinScopeDialog, type JoinScopeOption } from './JoinDialog'
import {
  createLiteratureCollection,
  getLiteratureProjects,
  listLiteratureCollections,
  loadHeldFulltext,
  type HeldFulltextStorage,
} from './api'
import { heldFulltextJoin, pushLibItem, type HeldFulltextSource, type JoinScope } from './join'
import { runLiteratureJoinTask } from './admission'
import {
  collectionNodes,
  joinCollectionOptions,
  paperJoinKey,
  type JoinDestination,
} from './hierarchy'
import { joinedCollectionCreated, recordJoined, useJoinedPapers } from './joinState'

const SELECTION_KEY_SEPARATOR = '\u0000'

export function JoinLibraryMenu(
  props: Omit<React.ComponentProps<typeof Joining>, 'ports'>
): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  const receipts = useJoinedPapers()
  return (
    <Joining
      {...props}
      ports={{
        projectId,
        receipts,
        destinations: async () => {
          const [collections, projects] = await Promise.all([
            listLiteratureCollections(projectId),
            getLiteratureProjects(),
          ])
          return {
            collections: collectionNodes(collections, projectId),
            projects: projects.projects.map((project) => ({
              key: `project:${project.id}`,
              name: project.name,
              projectId: project.id,
              path: [project.name],
              children: collectionNodes(project.collections, project.id, [project.name]),
            })),
          }
        },
        admit: async (papers, destination) => {
          await pushLibItem(papers, destination, projectId)
          recordJoined(
            papers.flatMap((paper) => [
              paperJoinKey(paper),
              paperJoinKey(paper, destination.projectId),
            ]),
            destination
          )
        },
        createCollection: (name, destination) =>
          createLiteratureCollection(name, destination.projectId, destination.collectionId),
        created: joinedCollectionCreated,
      }}
    />
  )
}

export function JoinLibraryBatch({
  papers,
  source,
  selection,
  onJoined,
}: {
  papers: LiteratureSearchPaper[]
  /** 只有精确检索卡片带这个来源; 缺省时这批结果只能仅元信息入库。 */
  source?: HeldFulltextSource
  selection?: { count: number; total: number }
  onJoined?: (papers: LiteratureSearchPaper[], destination: JoinDestination) => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { state } = useApp()
  const { toast } = useToast()
  const projectId = state.homeSelectedProjectId ?? undefined
  const sessionId = source?.sessionId
  const cardId = source?.cardId
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [options, setOptions] = useState<JoinScopeOption[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  /** 已下载完成的论文; null 是「还没问回来」, 与「问回来但没有」({}) 不是一回事。 */
  const [held, setHeld] = useState<Record<string, HeldFulltextStorage> | null>(null)
  // 勾选集合每帧都是新数组, 只有 id 串才是稳定的 effect 依赖。
  const selectionKey = papers.map((paper) => paper.paper_id).join(SELECTION_KEY_SEPARATOR)
  useEffect(() => {
    setOpen(false)
    setOptions(null)
    setHeld(null)
  }, [projectId])
  useEffect(() => {
    if (!open) return
    let active = true
    setOptions(null)
    setLoadFailed(false)
    setHeld(null)
    Promise.all([
      listLiteratureCollections(),
      projectId ? listLiteratureCollections(projectId) : Promise.resolve([]),
    ])
      .then(([globalCollections, projectCollections]) => {
        if (!active) return
        setOptions(
          joinCollectionOptions(globalCollections, projectCollections, projectId, {
            global: t('joinScope.globalCollections'),
            project: t('joinScope.projectCollections'),
          })
        )
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
    if (sessionId && cardId) {
      loadHeldFulltext(
        sessionId,
        cardId,
        selectionKey.split(SELECTION_KEY_SEPARATOR).filter(Boolean)
      )
        .then((value) => {
          if (active) setHeld(value)
        })
        .catch(() => {
          // 问不到就当作没有: 界面退回仅元信息, 不承诺一个查不到的全文。
          if (active) setHeld({})
        })
    }
    return () => {
      active = false
    }
  }, [open, projectId, t, sessionId, cardId, selectionKey])
  // 只有精确检索卡片且这批里真的有已下载全文时, 才存在「元信息和全文」这条腿。
  const fulltext = heldFulltextJoin(source, papers, held)
  const confirm = async (scope: JoinScope, option?: JoinScopeOption): Promise<void> => {
    if (busy || options === null || loadFailed) return
    setBusy(true)
    setOpen(false)
    const destination: JoinDestination = {
      projectId: option ? option.projectId : projectId,
      collectionId: option?.collectionId,
      path: option?.path ?? [],
    }
    const projectName = state.projects.find((project) => project.id === destination.projectId)?.name
    try {
const outcome = await runLiteratureJoinTask(
        papers,
        scope,
        destination,
        projectName ?? '',
        fulltext
      )
      if (scope === 'fulltext') {
        toast({
          title: t('joinScope.summary', {
            total: outcome.ids.length,
            fulltext: outcome.fulltext,
          }),
          tone: outcome.fulltextFailed ? 'warning' : 'success',
        })
        if (outcome.fulltextFailed)
          toast({
            title: t('joinScope.heldFailed', { count: outcome.fulltextFailed }),
            tone: 'error',
          })
      }
    } catch {
      return
    } finally {
      setBusy(false)
    }
    recordJoined(
      papers.map((paper) => paperJoinKey(paper, destination.projectId)),
      destination
    )
    onJoined?.(papers, destination)
  }
  return (
    <>
      <Button
        size="md"
        variant="primary"
        data-testid="join-library-trigger"
        disabled={busy || papers.length === 0}
        onClick={() => setOpen(true)}
      >
        {t('joinScope.title')}
        {selection ? ` (${selection.count}/${selection.total})` : null}
      </Button>
      <JoinScopeDialog
        open={open}
        busy={busy}
        count={papers.length}
        heldCount={fulltext ? fulltext.paperIds.length : undefined}
        options={options ?? []}
        loadFailed={loadFailed}
        loading={options === null || (sessionId !== undefined && held === null)}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
      />
    </>
  )
}
