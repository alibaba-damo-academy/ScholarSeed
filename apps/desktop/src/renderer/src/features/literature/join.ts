import type { LiteratureSearchPaper } from '../../contracts/literature'
import {
  attachHeldFulltext,
  importBibliography,
  type HeldAttachmentPaper,
} from './api.ts'
import { searchPapersBibtex } from './result.ts'
import { paperJoinKey, type JoinDestination } from './hierarchy.ts'

const pending = new Set<string>()
/** The only admission path for search rows, batch actions and conversation hit cards.
 * Existing bibliography API saves the entire batch and its destination atomically.
 * Local file/Zotero/BibTeX dialogs remain untouched.
 */
export async function pushLibItem(
  papers: LiteratureSearchPaper[],
  destination: JoinDestination,
  contextProjectId?: string,
  admit: typeof importBibliography = importBibliography
): Promise<string[]> {
  if (!papers.length) return []
  const projectId = contextProjectId || destination.projectId
  if (contextProjectId && destination.projectId !== contextProjectId)
    throw new Error('join_destination_scope_mismatch')
  const keys = papers.map((paper) => paperJoinKey(paper, contextProjectId))
  if (keys.some((key) => pending.has(key))) throw new Error('join_in_progress')
  keys.forEach((key) => pending.add(key))
  try {
    const file = new File([searchPapersBibtex(papers)], 'ai-search-results.bib', {
      type: 'application/x-bibtex',
    })
    const result = await admit([file], { projectId, collectionId: destination.collectionId })
    if (result.items.length !== papers.length) throw new Error('join_incomplete')
    return result.items.map((item) => item.id)
  } finally {
    keys.forEach((key) => pending.delete(key))
  }
}

export type JoinScope = 'metadata' | 'fulltext'

/**
 * 精确检索卡片这一批结果: 只有它可能已经有下载完成的全文可以复用。
 *
 * 会话与卡片定位到 serve 侧那一次检索运行, 具体字节在哪 (产品托管存储还是 run 目录)
 * 由 serve 判定, 渲染层只负责把「哪几篇已经下好了」带回来。
 */
export interface HeldFulltextSource {
  sessionId: string
  cardId: string
}

/** 「元信息和全文」这条腿需要的全部输入: 卡片来源加上已下载完成的 paper_id。 */
export interface HeldFulltextJoin {
  source: HeldFulltextSource
  paperIds: readonly string[]
}

/**
 * 这批选中论文里已经下载完成、可以复用字节的 paper_id。
 *
 * `held` 是 null 表示状态还没问回来 (与「问回来但没有」区分开), 此时不给全文选项,
 * 免得先渲染一个可点的选项再把它抽走。
 */
export function heldPaperIds(
  papers: readonly LiteratureSearchPaper[],
  held: Readonly<Record<string, unknown>> | null
): string[] {
  if (!held) return []
  return papers
    .filter((paper) => held[paper.paper_id] !== undefined)
    .map((paper) => paper.paper_id)
}

/**
 * 「元信息和全文」这条腿的完整输入; 不具备条件时返回 undefined, 界面就不给这个选项。
 *
 * 两个条件缺一不可: 结果来自精确检索卡片 (`source`), 且这批勾选里至少有一篇已经下载
 * 完成。其余情况一律按仅元信息处理。
 */
export function heldFulltextJoin(
  source: HeldFulltextSource | undefined,
  papers: readonly LiteratureSearchPaper[],
  held: Readonly<Record<string, unknown>> | null
): HeldFulltextJoin | undefined {
  if (!source) return undefined
  const paperIds = heldPaperIds(papers, held)
  return paperIds.length ? { source, paperIds } : undefined
}

export interface JoinScopeOutcome {
  ids: string[]
  /** 入库后确实带原文的篇数 (含本来就已有主附件的)。 */
  fulltext: number
  /** 想带原文但最终没有的篇数。 */
  fulltextFailed: number
}

/** 任务中心使用的入库进度: 元信息落库回报一次, 全文按篇回报。 */
export type JoinProgress =
  | { kind: 'admitted'; count: number }
  | { kind: 'fulltext'; index: number; succeeded: boolean }

/**
 * 按选择范围批量入库: 元信息一定入, 全文只复用已经下载好的字节。
 *
 * 全文腿不再触发任何下载: serve 侧要么挂 bridge 已托管的 PDF, 要么挂技能自己下进 run
 * 目录的 PDF, 两者都走附件域唯一入口。挂载失败不能把已经成功的元信息入库说成失败,
 * 所以这里吞掉附件腿的异常, 只在计数与进度里如实反映。
 */
export async function joinWithScope(
  papers: LiteratureSearchPaper[],
  scope: JoinScope,
  destination: JoinDestination,
  contextProjectId?: string,
  fulltext?: HeldFulltextJoin,
  admit: typeof pushLibItem = pushLibItem,
  attach: typeof attachHeldFulltext = attachHeldFulltext,
  report?: (progress: JoinProgress) => void
): Promise<JoinScopeOutcome> {
  const ids = await admit(papers, destination, contextProjectId)
  report?.({ kind: 'admitted', count: ids.length })
  if (scope === 'metadata' || !fulltext) return { ids, fulltext: 0, fulltextFailed: 0 }
  const held = new Set(fulltext.paperIds)
  const targets: HeldAttachmentPaper[] = []
  const targetIndexes = new Map<string, number>()
  papers.forEach((paper, index) => {
    const literatureId = ids[index]
    if (literatureId && held.has(paper.paper_id)) {
      targets.push({ literature_id: literatureId, paper_id: paper.paper_id })
      targetIndexes.set(paper.paper_id, index)
    }
  })
  if (!targets.length) return { ids, fulltext: 0, fulltextFailed: 0 }
  const reportItems = (items: readonly { paper_id: string; fulltext: boolean }[]): void => {
    for (const item of items)
      report?.({
        kind: 'fulltext',
        index: targetIndexes.get(item.paper_id) ?? -1,
        succeeded: item.fulltext,
      })
  }
  try {
    const outcome = await attach(fulltext.source.sessionId, fulltext.source.cardId, targets)
    reportItems(outcome.items)
    return { ids, fulltext: outcome.fulltext, fulltextFailed: outcome.failed }
  } catch {
    reportItems(targets.map((target) => ({ paper_id: target.paper_id, fulltext: false })))
    return { ids, fulltext: 0, fulltextFailed: targets.length }
  }
}
