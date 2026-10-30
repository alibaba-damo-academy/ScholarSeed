import { HOME_PROJECT_PAGE_SIZE, HOME_TASK_PAGE_SIZE, HOME_TASK_LIMIT } from '../src/renderer/src/features/home/catalog.ts'
import { PROJECT_NAME_MAX } from '../src/renderer/src/contracts/content.ts'
import type { PreviewProject } from './project.ts'

export interface PreviewHomePolicy { projects: number; tasks: number; content?: 'standard' | 'long'; read?: 'delayed' | 'fail-once'; projectRead?: 'delayed' | 'failed' }
export const PREVIEW_HOME = { projects: 50, tasks: 200, maximumProjects: 200, maximumTasks: 1000, projectPage: HOME_PROJECT_PAGE_SIZE, taskPage: HOME_TASK_PAGE_SIZE, sessionPage: HOME_TASK_LIMIT, seedTime: 1_700_000_000, readDelayMs: 2_000, readFailure: 'preview_home_tasks_unavailable', projectReadFailure: 'preview_home_projects_unavailable', recoveryPath: '/__preview/home/projects/recover', recoveryUnavailable: 'preview_home_recovery_unavailable' } as const

export class PreviewHomeError extends Error {
  constructor(readonly status: number) { super(PREVIEW_HOME.recoveryUnavailable) }
}

export class PreviewHomeRead {
  private failed = false
  private disposed = false
  private recovered = false
  private readonly pending = new Set<() => void>()

  constructor(private readonly mode: PreviewHomePolicy['read'] | PreviewHomePolicy['projectRead']) {}

  async read(signal: AbortSignal): Promise<'ready' | 'failed' | 'cancelled'> {
    if (this.disposed || signal.aborted) return 'cancelled'
    if (this.mode === 'failed') return this.recovered ? 'ready' : 'failed'
    const fail = this.mode === 'fail-once' && !this.failed
    if (this.mode !== 'delayed' && !fail) return 'ready'
    const outcome = await new Promise<'ready' | 'cancelled'>(resolve => {
      const finish = (outcome: 'ready' | 'cancelled'): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal.removeEventListener('abort', cancel)
        resolve(outcome)
      }
      const cancel = (): void => finish('cancelled')
      const timer = setTimeout(() => finish('ready'), PREVIEW_HOME.readDelayMs)
      this.pending.add(cancel)
      signal.addEventListener('abort', cancel, { once: true })
    })
    if (this.disposed || signal.aborted || outcome === 'cancelled') return 'cancelled'
    if (fail) {
      this.failed = true
      return 'failed'
    }
    return 'ready'
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
  }

  recover(): void {
    if (this.disposed) throw new PreviewHomeError(410)
    if (this.mode !== 'failed') throw new PreviewHomeError(409)
    this.recovered = true
  }
}

export function homeSeed(base: PreviewProject, policy: PreviewHomePolicy) {
  if (!Number.isInteger(policy.projects) || policy.projects < 0 || policy.projects > PREVIEW_HOME.maximumProjects || !Number.isInteger(policy.tasks) || policy.tasks < 0 || policy.tasks > PREVIEW_HOME.maximumTasks || (!policy.projects && policy.tasks) || (policy.content !== undefined && !['standard', 'long'].includes(policy.content))) throw new Error('Invalid project center sample policy')
  const projects = Array.from({ length: policy.projects }, (_, index) => ({
    ...base, id: index === 0 ? base.id : base.id + '-' + (index + 1), root: index === 0 ? base.root : base.root + '-' + (index + 1),
    name: policy.content === 'long' ? ((index + 1) + ' · ' + '跨团队产品设计与前端交付协作项目'.repeat(PROJECT_NAME_MAX)).slice(0, PROJECT_NAME_MAX) : index === 0 ? base.name : '模拟项目 ' + (index + 1),
    description: '项目中心边界演示项目 ' + (index + 1), created_at: PREVIEW_HOME.seedTime - index,
  }))
  const tasks = Array.from({ length: policy.tasks }, (_, index) => ({
    created_at: PREVIEW_HOME.seedTime - index,
    index, project: projects[index % projects.length].root,
    title: policy.content === 'long' ? (index + 1) + ' · ' + '核对产品需求、交互细节、视觉状态与前端实现的一致性 · '.repeat(4) : index === 0 ? '设计协作演示' : '模拟任务 ' + (index + 1) + ' · 项目中心分页与长标题展示',
  }))
  return { projects, tasks }
}

export function homeSessionPage<T>(sessions: readonly T[], limit: string | null, cursor: string | null, epoch: string) {
  const requested = limit === null ? Math.max(1, sessions.length) : Number(limit)
  const prefix = epoch + ':'
  const offset = cursor === null ? 0 : cursor.startsWith(prefix) && /^\d+$/.test(cursor.slice(prefix.length)) ? Number(cursor.slice(prefix.length)) : NaN
  if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > sessions.length) throw new Error('Invalid preview session page')
  const end = offset + Math.min(requested, PREVIEW_HOME.sessionPage)
  return { sessions: sessions.slice(offset, end), total: sessions.length, next_cursor: end < sessions.length ? prefix + end : null }
}
