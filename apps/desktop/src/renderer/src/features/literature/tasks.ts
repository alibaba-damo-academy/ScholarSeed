/**
 * 文献详情里「不是瞬间完成」的动作的进程内登记表。
 *
 * 「获取全文」要走 DOI 发现 + 下载，「同步元数据」要打公开注册库，两者都可能跑好几秒。忙状态
 * 原先只存在组件的 `useState` 里：关掉详情面板再打开，组件重挂、state 归零，按钮立刻变回可点，
 * 而后端那一次请求还在飞 —— 用户会以为没生效而再点一次，同一个 DOI 被重复下载。
 *
 * 这里把「谁在跑」记在渲染进程内存里（与 `features/resources/draft.ts` 的 `reviewDraftStore`
 * 同形，同样通过 `useSyncExternalStore` 消费）：
 *
 * - `run` 登记任务并去重：同一个 (文献, 动作) 已有在飞的就复用同一个 promise，`start` 不会被
 *   再调一次，因此重复点击不会重复打后端；
 * - `attach` 只挂到已在飞的任务上，绝不新建请求，供重开面板后续接结果；
 * - 任务一 settle 就摘掉登记，所以这里的「忙」严格等于「请求还在飞」，不会留下幽灵忙状态。
 *
 * 生命周期只到渲染进程结束：这是忙状态与结果续接，不是持久化任务队列。重启应用后后端那次
 * 请求早已随进程消失，因此也不该继续显示忙。
 */

export type LiteratureTaskKind = 'fulltext' | 'metadata' | 'metadata-batch'

/** 用 NUL 分隔，避免 id 里出现分隔符时两种动作的键撞上。 */
function taskKey(id: string, kind: LiteratureTaskKind): string {
  return `${kind}\0${id}`
}

export class LiteratureTaskStore {
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  /** 登记并执行一个任务；同键已在飞时直接复用现有 promise。 */
  run<T>(id: string, kind: LiteratureTaskKind, start: () => Promise<T>): Promise<T> {
    const key = taskKey(id, kind)
    const existing = this.running.get(key)
    // 键含动作类型，同一个键只可能由同一种任务登记，所以载荷类型是稳定的。
    if (existing) return existing as Promise<T>
    const promise = start()
    this.running.set(key, promise)
    this.emit()
    // settle 用派生链处理，原始 promise 的成败仍由调用方 await；两边都有 handler，
    // 不会因为调用方忘了 catch 而冒出 unhandled rejection。
    void promise.then(
      () => this.settle(key, promise),
      () => this.settle(key, promise)
    )
    return promise
  }

  /** 只挂到已在飞的任务上；没有在飞就返回 null（重开面板时用，不新建请求）。 */
  attach<T>(id: string, kind: LiteratureTaskKind): Promise<T> | null {
    return (this.running.get(taskKey(id, kind)) as Promise<T> | undefined) ?? null
  }

  isRunning(id: string, kind: LiteratureTaskKind): boolean {
    return this.running.has(taskKey(id, kind))
  }

  getSnapshot = (): number => this.revision

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private settle(key: string, promise: Promise<unknown>): void {
    // 只摘自己那一条: 极快的任务 settle 之后，同键可能已经登记了新一轮。
    if (this.running.get(key) !== promise) return
    this.running.delete(key)
    this.emit()
  }

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

export const literatureTasks = new LiteratureTaskStore()
