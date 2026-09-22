import { useSyncExternalStore } from 'react'

import type { LiteratureFacet, LiteratureProject, LiteratureQuery, LiteratureSummary } from '../../contracts/literature'

interface CatalogueState {
  projectId: string | null
  query: LiteratureQuery
  selected: string[]
  focusedId: string | null
  focusedAttachmentId: string | null
  items: LiteratureSummary[]
  reload: number
  panelReload: number
  importRequest: ImportRequest | null
}

/** 导入入口的请求令牌: 左侧面板发出, 列表挂载后消费。 */
export interface ImportRequest { source: string; token: number }

/** 导入落点: 项目与分类必须成对, 因为分类本身是分作用域的。 */
export interface ImportDestination { projectId: string; collectionId: string }

const DEFAULT_QUERY: LiteratureQuery = { attachment: 'any', order: 'desc', sort: 'created_at' }

let state: CatalogueState = {
  projectId: null,
  query: { ...DEFAULT_QUERY },
  selected: [],
  focusedId: null,
  focusedAttachmentId: null,
  items: [],
  reload: 0,
  panelReload: 0,
  importRequest: null,
}
const scopes = new Map<string | null, CatalogueState>()
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((listener) => listener())
const update = (patch: Partial<CatalogueState>): void => { state = { ...state, ...patch }; emit() }

// 列表行/附件的「打开」只经过本模块的 focus 族方法；首页「最近打开」的 MRU
// 由 store 注册 recorder 接收，避免 catalog 反向依赖 app store。
let openRecorder: ((id: string) => void) | null = null

export function registerLiteratureOpenRecorder(recorder: ((id: string) => void) | null): void {
  openRecorder = recorder
}

const recordOpen = (id: string | null): void => {
  if (id && openRecorder) openRecorder(id)
}

export function useCatalogue(): CatalogueState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    () => state,
  )
}

export const catalogue = {
  getSnapshot: (): CatalogueState => state,
  scope(projectId: string | null): void {
    if (state.projectId === projectId) return
    scopes.set(state.projectId, state)
    const saved = scopes.get(projectId)
    // 待消费的导入请求属于「此刻这个界面」, 不跟着作用域存档走。
    update(saved ? { ...saved, importRequest: null, reload: state.reload + 1 } : {
      projectId,
      query: { ...DEFAULT_QUERY, project_id: projectId ?? undefined },
      selected: [], focusedId: null, focusedAttachmentId: null, items: [], importRequest: null, reload: state.reload + 1, panelReload: state.panelReload + 1,
    })
  },
  query(patch: Partial<LiteratureQuery>): void {
    update({
      query: {
        ...state.query,
        ...patch,
        ...(state.projectId ? { project_id: state.projectId } : {})
      },
      selected: [],
      focusedId: null,
      focusedAttachmentId: null
    })
  },
  /**
   * 只收窄筛选条件, 保留勾选与已打开的文献。
   *
   * query() 清 selected/focused 是「换了作用域」的语义: 换分类、换项目之后旧勾选
   * 指向的行已经不在列表里, 留着就是隐患。标签不一样 —— 它是在既有勾选上附加过滤
   * 条件, 用户常常先勾一批文献再用标签收窄视图, 清掉勾选等于丢掉已做的工作。
   *
   * focusedId 一并保留是安全的: 详情面板按 id 独立取数, 不依赖列表 items, 所以
   * 「边看详情边加标签」不会把详情关掉。代价是勾选可能指向被过滤掉的行, 批量条
   * 报的数量会大于可见行数 —— 那是用户要的工作集语义, 批量确认框报的也是这个数。
   */
  filter(patch: Partial<LiteratureQuery>): void {
    update({
      query: {
        ...state.query,
        ...patch,
        ...(state.projectId ? { project_id: state.projectId } : {})
      }
    })
  },
  /**
   * 导入落地后的一次性收口: 清掉新文献一定不满足的窄化筛选, 并
   * bump reload 让左侧计数与 facet 跟着刷新。两件事必须在同一次更新里完成 ——
   * 拆成 query() + reload() 会让列表连拉两次, 只 query() 则计数停在旧值。
   */
  imported(patch: Partial<LiteratureQuery>): void {
    update({
      query: {
        ...state.query,
        ...patch,
        ...(state.projectId ? { project_id: state.projectId } : {})
      },
      selected: [],
      focusedId: null,
      focusedAttachmentId: null,
      reload: state.reload + 1
    })
  },
  /**
   * 请求一次导入。面板常驻而列表会随文档标签卸载, 所以不能靠 DOM 事件把意图递
   * 过去: 交给 store, 列表挂载后自己消费, 由面板负责把标签切回列表。
   */
  requestImport(source: string): void {
    update({ importRequest: { source, token: (state.importRequest?.token ?? 0) + 1 } })
  },
  consumeImportRequest(): void {
    if (state.importRequest === null) return
    update({ importRequest: null })
  },
  focus(focusedId: string | null): void { update({ focusedId, focusedAttachmentId: null }); recordOpen(focusedId) },
  focusAttachment(focusedId: string, focusedAttachmentId: string): void { update({ focusedId, focusedAttachmentId }); recordOpen(focusedId) },
  items(items: LiteratureSummary[]): void { update({ items }) },
  select(id: string, checked: boolean): void {
    const values = new Set(state.selected)
    if (checked) values.add(id); else values.delete(id)
    update({ selected: [...values], focusedId: null, focusedAttachmentId: null })
  },
  selectAll(ids: string[], checked: boolean): void {
    update({
      selected: checked ? ids : [],
      focusedId: null,
      focusedAttachmentId: null
    })
  },
  clear(): void {
    update({ selected: [], focusedId: null, focusedAttachmentId: null })
  },
  reload(): void { update({ reload: state.reload + 1 }) },
  reloadPanel(): void { update({ panelReload: state.panelReload + 1 }) },
}

/**
 * 从左侧当前选择推导导入落点。
 *
 * 「未整理」是收件箱而不是一个分类: 落在它上面时不能带 collection_id, 否则刚导入
 * 的文献会当场从这个列表里消失。契约允许 collection_id 多选而界面只会单选, 因此取
 * 第一个; 标签不参与落点 (导入路径本来也不写标签), 导入后再清掉标签筛选。
 */
export function importDestination(query: LiteratureQuery): ImportDestination {
  const projectId = query.project_id ?? ''
  if (query.without_collection) return { projectId, collectionId: '' }
  return { projectId, collectionId: query.collection_id?.[0] ?? '' }
}

/**
 * 把落点解析成可读名字: 分类名 → 项目名 → 调用方给的作用域名。
 *
 * 「导入到哪」必须在按下导入之前就看得见, 否则落点成了导入完才揭晓的结果。分类是
 * 分作用域的, 因此既要在当前作用域的 facet 里找, 也要在项目树里找 (文献全览下选中
 * 的是某个项目的分类)。
 */
export function importDestinationLabel(
  destination: ImportDestination,
  collections: Iterable<LiteratureFacet>,
  projects: Iterable<LiteratureProject>,
  scopeLabel: string
): string {
  for (const collection of collections) {
    if (collection.id === destination.collectionId) return collection.name
  }
  for (const project of projects) {
    if (project.id === destination.projectId) return project.name
    for (const collection of project.collections) {
      if (collection.id === destination.collectionId) return collection.name
    }
  }
  return scopeLabel
}
