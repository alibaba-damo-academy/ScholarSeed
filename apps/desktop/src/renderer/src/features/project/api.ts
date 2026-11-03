/**
 * 项目 HTTP 客户端（开发 1 拥有）。
 *
 * 只打 content 域的项目端点与 chat 域的工作区根设置端点。**不**提交绝对路径
 * 作为项目身份：新建只交显示名，目录名与身份键都由后端生成（proposal 47 §5.2）。
 *
 * 错误约定与资料库一致：读失败返回 null（与「确实为空」区分），写操作回
 * `{ ok, error }` 并把后端 detail 码原样带回，让 UI 按码提示。
 */

import { resolveContentResponse } from '../../app/api/content.ts'
import { LIVE_CATALOG_REQUEST } from '../../app/api/client.ts'

import type { ContentErrorCode, ExternalRootRef, ProjectRef } from '../../contracts/content'

const FAILURE_CODES = {
  networkError: 'network_error',
} as const

/** 项目列表 + 当前项目 + 生效工作区根。 */
export interface ProjectListing {
  projects: ProjectRef[]
  current: string
  workspaceRoot: string
}

/** 工作区根：生效值与用户显式设置值分开回报。 */
export interface WorkspaceRootState {
  root: string
  configured: string
  restartRequired?: boolean
}

/** 写操作结果。error 是后端 detail 码。 */
export interface ProjectMutation {
  ok: boolean
  error?: ContentErrorCode | string
  project?: ProjectRef
}

export interface CreationRecovery {
  operation: string
  project: { project_id: string; display_name: string; dir_root: string }
  outcome: { state: string; error: string | null }
}

export async function listCreationRecoveries(): Promise<CreationRecovery[] | null> {
  const result = await readJson<{ creations: CreationRecovery[] }>(
    '/api/content/projects/recoveries'
  )
  return result?.creations ?? null
}

export async function retryCreation(operation: string): Promise<ProjectMutation> {
  const result = await sendJson(
    `/api/content/projects/recoveries/${encodeURIComponent(operation)}/retry`,
    'POST',
    {}
  )
  return { ok: result.ok, error: result.error, project: result.payload as ProjectRef | undefined }
}

export async function preserveCreation(operation: string): Promise<ProjectMutation> {
  const result = await sendJson(
    `/api/content/projects/recoveries/${encodeURIComponent(operation)}/preserve`,
    'POST',
    {}
  )
  return { ok: result.ok, error: result.error }
}

const base = (): string => window.scholarseed?.getApiBase() ?? ''

export interface ProjectTreeNode {
  path: string
  name: string
  kind: 'file' | 'dir'
  available: boolean
  count: number | null
  artifact?: boolean
}

export interface ProjectTreePage {
  root: string
  nodes: ProjectTreeNode[]
  total: number
  offset: number
}

export async function readProjectTree(
  project: string,
  path = '',
  offset = 0,
  signal?: AbortSignal
): Promise<ProjectTreePage | null> {
  const query = new URLSearchParams({ path, offset: String(offset) })
  return readJson<ProjectTreePage>(
    `/api/content/projects/${encodeURIComponent(project)}/tree?${query}`,
    { signal }
  )
}

export async function listProjectFiles(
  project: string,
  signal: AbortSignal
): Promise<ProjectTreeNode[] | null> {
  const directories = ['']
  const visited = new Set<string>()
  const files = new Map<string, ProjectTreeNode>()
  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const directory = directories[directoryIndex]
    if (visited.has(directory)) continue
    visited.add(directory)
    let offset = 0
    while (!signal.aborted) {
      const page = await readProjectTree(project, directory, offset, signal)
      if (!page || signal.aborted) return null
      for (const node of page.nodes) {
        if (node.kind === 'file') files.set(node.path, node)
        else if (node.available && !visited.has(node.path)) directories.push(node.path)
      }
      offset += page.nodes.length
      if (offset >= page.total) break
      if (page.nodes.length === 0) return null
    }
    if (signal.aborted) return null
  }
  return [...files.values()]
}

export type ProjectNodeAction = 'create_document' | 'create_folder' | 'rename' | 'move' | 'copy'

export interface ProjectNodeMutation {
  ok: boolean
  error?: string
  node?: Pick<ProjectTreeNode, 'path' | 'name' | 'kind'>
}

export async function mutateProjectNode(
  project: string,
  action: ProjectNodeAction,
  input: { path?: string; parent?: string; name?: string; targetDir?: string }
): Promise<ProjectNodeMutation> {
  const result = await sendJson(
    `/api/content/projects/${encodeURIComponent(project)}/nodes`,
    'POST',
    {
      action,
      path: input.path ?? '',
      parent: input.parent ?? '',
      name: input.name ?? '',
      target_dir: input.targetDir ?? '',
    }
  )
  return { ok: result.ok, error: result.error, node: result.payload as ProjectNodeMutation['node'] }
}

export async function importProjectFiles(
  project: string,
  sources: string[],
  targetDir: string
): Promise<{ ok: boolean; error?: string; paths?: string[] }> {
  const result = await sendJson(
    `/api/content/projects/${encodeURIComponent(project)}/import`,
    'POST',
    {
      sources,
      target_dir: targetDir,
    }
  )
  return {
    ok: result.ok,
    error: result.error,
    paths: (result.payload as { paths?: string[] } | undefined)?.paths,
  }
}

async function readJson<T>(
  path: string,
  options?: Pick<RequestInit, 'cache' | 'signal'>
): Promise<T | null> {
  try {
    const response = await fetch(`${base()}${path}`, { credentials: 'include', ...options })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

async function sendJson(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT',
  body: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; payload?: unknown }> {
  try {
    let response = await fetch(`${base()}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    response = await resolveContentResponse(response)
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && 'detail' in payload
          ? String((payload as { detail: unknown }).detail)
          : `http_${response.status}`
      return { ok: false, error: detail }
    }
    return { ok: true, payload }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : FAILURE_CODES.networkError }
  }
}

export async function listProjects(includeArchived = false): Promise<ProjectListing | null> {
  const query = includeArchived ? '?includeArchived=true' : ''
  return readJson<ProjectListing>(`/api/content/projects${query}`, LIVE_CATALOG_REQUEST)
}

/** 归档/解归档项目：只影响默认列表可见性，目录与会话数据不动。 */
export async function setProjectArchived(id: string, archived: boolean): Promise<ProjectMutation> {
  const result = await sendJson(`/api/content/projects/${encodeURIComponent(id)}/archive`, 'POST', {
    archived,
  })
  return { ok: result.ok, error: result.error, project: result.payload as ProjectRef | undefined }
}

/**
 * 永久删除项目：只摘登记，**不删除本机目录与文件**。
 * 已归档项目不可能当前打开，因此不会撞 cannot_forget_current_project。
 */
export async function forgetProject(id: string): Promise<ProjectMutation> {
  try {
    let response = await fetch(`${base()}/api/content/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    response = await resolveContentResponse(response)
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && 'detail' in payload
          ? String((payload as { detail: unknown }).detail)
          : `http_${response.status}`
      return { ok: false, error: detail }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : FAILURE_CODES.networkError }
  }
}

/** 新建项目：只填名字。 */
export async function createProject(name: string): Promise<ProjectMutation> {
  const result = await sendJson('/api/content/projects', 'POST', { name })
  return { ok: result.ok, error: result.error, project: result.payload as ProjectRef | undefined }
}

/** 改显示名：目录名不跟随，已开会话与关联登记都不受影响。 */
export async function renameProject(
  id: string,
  name: string,
  metadata: { description?: string; pinned?: boolean } = {}
): Promise<ProjectMutation> {
  const result = await sendJson('/api/content/projects', 'PATCH', { id, name, ...metadata })
  return { ok: result.ok, error: result.error, project: result.payload as ProjectRef | undefined }
}

export async function loadWorkspaceRoot(): Promise<WorkspaceRootState | null> {
  return readJson<WorkspaceRootState>('/api/serve/workspace-root')
}

export async function previewProjectDirectory(name: string): Promise<{ root: string } | null> {
  return readJson<{ root: string }>(
    `/api/content/projects/directory?${new URLSearchParams({ name })}`
  )
}

/** 设置新建项目的落地根。已登记项目不搬动；生效需重启后端。 */
export async function saveWorkspaceRoot(
  root: string
): Promise<{ ok: boolean; error?: string; state?: WorkspaceRootState }> {
  const result = await sendJson('/api/serve/workspace-root', 'PUT', { root })
  return {
    ok: result.ok,
    error: result.error,
    state: result.payload as WorkspaceRootState | undefined,
  }
}

/** 关联根列表 + 可写根集合（后者与 Agent 沙箱同源）。 */
export interface ExternalRootListing {
  roots: ExternalRootRef[]
  writableRoots: string[]
}

interface ExternalRootPayload {
  root_id: string
  project_id: string
  mount_path: string
  source_path: string
  kind: ExternalRootRef['kind']
  authorized_at: number
  available: boolean
}

interface ExternalRootSyncOperation {
  projectId: string
  promise: Promise<ExternalRootListing | null>
}

let externalRootSyncOperation: ExternalRootSyncOperation | null = null
let externalRootProject: string | null = null

export function selectExternalRootProject(projectId: string | null): void {
  if (externalRootProject === projectId) return
  externalRootProject = projectId
  externalRootSyncOperation = null
  void window.scholarseed.syncAuthorizedRoots('external', []).catch((error) => {
    console.error('External root authorization reset failed', error)
  })
}

function toRoot(payload: ExternalRootPayload): ExternalRootRef {
  return {
    rootId: payload.root_id,
    projectId: payload.project_id,
    mountPath: payload.mount_path,
    sourcePath: payload.source_path,
    kind: payload.kind,
    authorizedAt: payload.authorized_at,
    available: payload.available,
  }
}

/**
 * 列出关联根，并把 OS 级动作的授权白名单同步到主进程。
 *
 * 同步放在这里而不是各调用点：撤销后必须立刻收回废纸篓/访达的权限，漏一个
 * 调用点就等于撤销在 OS 面没生效（`writableRoots` 是唯一来源，见 §6.9）。
 */
export function listExternalRoots(projectId: string): Promise<ExternalRootListing | null> {
  const synchronize = projectId === externalRootProject
  if (synchronize && externalRootSyncOperation?.projectId === projectId) {
    return externalRootSyncOperation.promise
  }

  const operation: ExternalRootSyncOperation = {
    projectId,
    promise: Promise.resolve(null),
  }
  operation.promise = (async () => {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
    const payload = await readJson<{ roots: ExternalRootPayload[]; writableRoots: string[] }>(
      `/api/content/roots${query}`
    )
    if (!payload) return null
    const listing = { roots: payload.roots.map(toRoot), writableRoots: payload.writableRoots }
    if (!synchronize) return listing
    if (projectId !== externalRootProject || externalRootSyncOperation !== operation) return null
    const synchronized = await window.scholarseed.syncAuthorizedRoots(
      'external',
      payload.writableRoots
    )
    if (!synchronized || externalRootSyncOperation !== operation) return null
    return listing
  })()
  if (synchronize) externalRootSyncOperation = operation
  const clear = (): void => {
    if (externalRootSyncOperation === operation) externalRootSyncOperation = null
  }
  void operation.promise.then(clear, clear)
  return operation.promise
}

/** 授权一处项目外文件或目录，登记成项目内挂载点。
 *
 * `supersede` 用于反方向关联 (先子后父): 新源是已生效子关联的父目录时, 后端会在
 * **同一事务**里原子撤销被覆盖的子关联再挂载父目录, 不留双身份窗口。默认 false。
 */
export async function authorizeRoot(
  projectId: string,
  source: string,
  mount: string,
  supersede = false
): Promise<{ ok: boolean; error?: ContentErrorCode | string; root?: ExternalRootRef }> {
  const result = await sendJson('/api/content/roots', 'POST', {
    project: projectId,
    source,
    mount,
    ...(supersede ? { supersede: true } : {}),
  })
  if (!result.ok) return { ok: false, error: result.error }
  await listExternalRoots(projectId)
  return { ok: true, root: toRoot(result.payload as ExternalRootPayload) }
}

/** 撤销授权。产品面与 OS 面即时生效，Agent 面在下一个 turn 生效。 */
export async function revokeRoot(
  projectId: string,
  rootId: string
): Promise<{ ok: boolean; error?: string; agentSessionsAffected: string[] }> {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
  try {
    let response = await fetch(
      `${base()}/api/content/roots/${encodeURIComponent(rootId)}${query}`,
      { method: 'DELETE', credentials: 'include' }
    )
    response = await resolveContentResponse(response)
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && 'detail' in payload
          ? String((payload as { detail: unknown }).detail)
          : `http_${response.status}`
      return { ok: false, error: detail, agentSessionsAffected: [] }
    }
    await listExternalRoots(projectId)
    const affected =
      payload &&
      typeof payload === 'object' &&
      'agentSessionsAffected' in payload &&
      Array.isArray(payload.agentSessionsAffected)
        ? (payload.agentSessionsAffected as string[])
        : []
    return { ok: true, agentSessionsAffected: affected }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : FAILURE_CODES.networkError,
      agentSessionsAffected: [],
    }
  }
}

/** 迁移计划里的一条。`conflict` 表示目标已存在，搬过去会同名避让。 */
export interface MigrationEntry {
  source: string
  target: string
  size: number
  conflict: boolean
}

/** 迁移 dry-run 结果。`blocked` 非空表示不可迁移（已是内置布局等）。 */
export interface MigrationPlan {
  project_id: string
  name: string
  root: string
  blocked: string
  totalSize: number
  entries: MigrationEntry[]
}

/** 迁移结果。失败项逐条回报，不汇总成一句「部分失败」。 */
export interface MigrationOutcome {
  project_id: string
  moved: string[]
  failed: { source: string; reason: string }[]
  layout: 'managed' | 'legacy'
}

/** 迁移 dry-run：只看清单，不动文件。 */
export async function loadMigrationPlan(projectId: string): Promise<MigrationPlan | null> {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
  return readJson<MigrationPlan>(`/api/content/migration${query}`)
}

/** 执行迁移。`skip` 里的条目保持原位（用户选了「暂不迁移」）。 */
export async function runMigration(
  projectId: string,
  skip: string[]
): Promise<{ ok: boolean; error?: string; outcome?: MigrationOutcome }> {
  const result = await sendJson('/api/content/migration', 'POST', { project: projectId, skip })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, outcome: result.payload as MigrationOutcome }
}

/** 最近被移入废纸篓的资料（原位置 + 时间）。 */
export async function loadTrashHistory(projectId: string): Promise<{ at: number; path: string }[]> {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
  const payload = await readJson<{ entries: { at: number; path: string }[] }>(
    `/api/content/trash${query}`
  )
  return payload?.entries ?? []
}
