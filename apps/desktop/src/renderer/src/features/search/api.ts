/**
 * 全局搜索 HTTP 客户端（MVP 0.2）。
 *
 * 归属：全局搜索负责人。
 */

import type { FindTextReveal } from '../../contracts/workbench.ts'

/** 一条跨域命中，字段与 service/platform/search.py 的 SearchHit 对齐。 */
export interface GlobalHit {
  /** 'resource' | 'literature' | 'session'（由 Serve 统一返回）。 */
  domain: string
  /** 域内标识：资料是相对路径，文献是条目 id，对话是 session id。 */
  id: string
  title: string
  subtitle: string
  /** Only resource body hits carry a viewer navigation request. */
  reveal?: FindTextReveal | null
  locator?: {
    turn_id?: string | null
    item_id?: string | null
    role?: string | null
    count?: number
  } | null
}

/**
 * 一个域的计数（PRD「结果组织」19：各分组分别统计合并后的结果数量）。
 *
 * `truncated` 为真表示磁盘/库里可能还有更多，此时 `total` 不是精确值，
 * 面板要把计数显示成「N+」而不是把上限当成真实命中数。
 */
export interface SearchGroupCount {
  total: number
  truncated: boolean
}

export interface SearchEverythingResult {
  hits: GlobalHit[]
  groups: Record<string, SearchGroupCount>
}

const base = (): string => window.scholarseed?.getApiBase() ?? ''

/**
 * 跨域检索资料、文献与会话。失败返回 null，与「确实没命中」区分开。
 * 会话检索同样由 Serve 统一完成，前端只负责展示与跳转定位。
 */
export async function searchEverything(
  query: string,
  project?: string | null,
  signal?: AbortSignal,
): Promise<SearchEverythingResult | null> {
  const params = new URLSearchParams({ q: query })
  if (project) params.set('project', project)
  try {
    const response = await fetch(`${base()}/api/search?${params.toString()}`, {
      credentials: 'include',
      signal,
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      hits?: GlobalHit[]
      groups?: Record<string, SearchGroupCount>
    }
    return { hits: payload.hits ?? [], groups: payload.groups ?? {} }
  } catch {
    return null
  }
}
