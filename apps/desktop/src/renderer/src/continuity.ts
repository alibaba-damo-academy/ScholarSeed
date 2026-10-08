import type { SessionNode } from './model'

/**
 * 进入项目/全局文献库时恢复上次打开的对话（需求「进入项目时恢复上次打开的
 * 对话状态」）。
 *
 * 记录是一张 `作用域 → 会话` 映射：作用域 key 是项目 id（按需求按项目隔离），
 * 无项目的全局文献库用固定 key；值为 sessionId，null 表示「新对话」。只在用户
 * 显式导航（打开会话 / 新建对话 / 离开作用域）时写入，消息时间与创建时间不参与，
 * 满足「以最后打开的对话为准」。
 */

/** 全局文献库的作用域 key，也是其 mainView 值（同一标识在视图空间的呈现）。 */
export const LITERATURE_SCOPE_KEY = 'literature'

const STORAGE_KEY = 'scholarseed.lastConversations'

export type ContinuityRecord = Record<string, string | null>

/** localStorage 的最小切片：注入内存实现即可单测，无需 DOM。 */
export interface ContinuityStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ContinuityScopeInput {
  activeSession: string | null
  threadProjectPath: string | null | undefined
  homeSelectedProjectId: string | null
  mainView: string
  projects: readonly { id: string; path: string }[]
}

export function readContinuityRecord(storage: ContinuityStorage): ContinuityRecord {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record: ContinuityRecord = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key) record[key] = typeof value === 'string' ? value : null
    }
    return record
  } catch {
    return {}
  }
}

export function writeContinuityRecord(storage: ContinuityStorage, record: ContinuityRecord): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(record))
}

/** 同值不产生新对象，调用方借此避免无意义的重写。 */
export function rememberContinuity(
  record: ContinuityRecord,
  scopeKey: string,
  sessionId: string | null
): ContinuityRecord {
  if ((record[scopeKey] ?? null) === sessionId) return record
  return { ...record, [scopeKey]: sessionId }
}

/** 失效记录在恢复时清除（会话已删 / 不可打开 / 不属于该作用域）。 */
export function clearContinuity(record: ContinuityRecord, scopeKey: string): ContinuityRecord {
  if (!(scopeKey in record)) return record
  const next = { ...record }
  delete next[scopeKey]
  return next
}

/**
 * 当前作用域的记录 key。无法归属时返回 null，调用方跳过写入 —— 例如会话的
 * projectPath 是 undefined（目录外会话）、项目已从列表消失、或无项目会话并不在
 * 文献库视图里：这些情况都不能把记录误写到文献库 key 下。
 */
export function continuityScopeKey(input: ContinuityScopeInput): string | null {
  const { activeSession, threadProjectPath, homeSelectedProjectId, mainView, projects } = input
  if (activeSession) {
    if (threadProjectPath === undefined) return null
    // 无项目会话不等于文献库会话：首页/对话面的全局对话没有作用域归属，只有在
    // 文献库视图里进行的才记文献库 key，否则「文献库上次打开的对话」会退化成
    // 「全应用最后一个无项目对话」。
    if (threadProjectPath === null) {
      return mainView === LITERATURE_SCOPE_KEY ? LITERATURE_SCOPE_KEY : null
    }
    return projects.find((project) => project.path === threadProjectPath)?.id ?? null
  }
  if (homeSelectedProjectId) return homeSelectedProjectId
  if (mainView === LITERATURE_SCOPE_KEY) return LITERATURE_SCOPE_KEY
  return null
}

export interface ContinuityRestoreCandidate {
  /** 通过校验的会话节点；null 表示恢复为新对话。 */
  node: SessionNode | null
  /** 校验失败时会清掉失效条目，调用方需要把它写回存储。 */
  record: ContinuityRecord
}

export function restoreContinuityCandidate(
  record: ContinuityRecord,
  scopeKey: string,
  lookup: (sessionId: string) => SessionNode | undefined,
  expectedProjectPath: string | null
): ContinuityRestoreCandidate {
  const sessionId = record[scopeKey] ?? null
  if (sessionId === null) return { node: null, record }
  const node = lookup(sessionId)
  const valid = node !== undefined
    && !node.container
    && node.openable !== false
    && (node.projectPath ?? null) === expectedProjectPath
  if (valid) return { node, record }
  return { node: null, record: clearContinuity(record, scopeKey) }
}
