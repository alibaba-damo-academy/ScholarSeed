import { randomUUID } from 'node:crypto'
import type { WorkspaceRootState } from '../src/renderer/src/features/project/api.ts'
import type { StorageConfig } from '../src/storage.ts'
import { PREVIEW_STORAGE_READ } from './directory.ts'
import type { PreviewStorageBootstrap, PreviewStoragePolicy, PreviewStorageRead } from './directory.ts'

export const PREVIEW_STORAGE = {
  path: '/api/serve/workspace-root',
  delayMs: 2_000,
  writeFailure: 'preview_workspace_root_unavailable',
  disposed: 'preview_workspace_root_disposed',
  invalid: 'preview_workspace_root_invalid',
  notFound: 'workspace_root_not_found',
  virtualRoot: '/preview/virtual-workspaces',
  home: '/preview/virtual-home',
  choiceIds: ['workspace-a', 'workspace-b'],
} as const

export class PreviewStorageError extends Error {
  readonly status: number
  constructor(code: string, status: number) { super(code); this.status = status }
}

export class PreviewStorage {
  private readonly effectiveRoot: string
  private readonly mode: PreviewStoragePolicy['write']
  private readonly policy: PreviewStoragePolicy
  private readonly overview: PreviewStorageBootstrap
  private configured = ''
  private failed = false
  private recovered = false
  private disposed = false
  private readonly pending = new Set<() => void>()

  constructor(effectiveRoot: string, simulation: PreviewStoragePolicy = { write: 'normal' }) {
    this.effectiveRoot = effectiveRoot
    this.mode = simulation.write
    this.policy = { ...simulation }
    const scope = randomUUID()
    this.overview = {
      config: { home: PREVIEW_STORAGE.home, runtimeStore: `${PREVIEW_STORAGE.home}/runtime`, configured: false, canChangeDataHome: false, firstLaunchEligible: false },
      choices: PREVIEW_STORAGE.choiceIds.map(id => ({ id, label: id, path: `${PREVIEW_STORAGE.virtualRoot}/${scope}/${id}` })),
    }
  }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewStorageError(PREVIEW_STORAGE.disposed, 410)
  }

  bootstrap(): PreviewStorageBootstrap {
    this.active()
    return structuredClone(this.overview)
  }

  read(): WorkspaceRootState {
    this.active()
    return { root: this.effectiveRoot, configured: this.configured }
  }

  readConfig(): StorageConfig {
    this.active()
    return structuredClone(this.overview.config)
  }

  async beforeRead(kind: PreviewStorageRead, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    const mode = kind === 'home' ? this.policy.homeRead : this.policy.workspaceRead
    if (mode === 'failed' && !this.recovered) throw new PreviewStorageError(PREVIEW_STORAGE_READ.failure, 503)
    if (mode === 'delayed') await this.wait(signal)
    this.active(signal)
  }

  recoverRead(): void {
    this.active()
    if (this.policy.homeRead !== 'failed' && this.policy.workspaceRead !== 'failed') throw new PreviewStorageError(PREVIEW_STORAGE_READ.recoveryUnavailable, 409)
    this.recovered = true
  }

  private wait(signal?: AbortSignal): Promise<void> {
    this.active(signal)
    return new Promise<void>((resolve, reject) => {
      const finish = (cancelled: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewStorageError(PREVIEW_STORAGE.disposed, 410))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_STORAGE.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  async configure(value: unknown, signal?: AbortSignal): Promise<WorkspaceRootState> {
    this.active(signal)
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).root !== 'string') throw new PreviewStorageError(PREVIEW_STORAGE.invalid, 422)
    const root = ((value as Record<string, unknown>).root as string).trim()
    if (root && !this.overview.choices.some(choice => choice.path === root)) throw new PreviewStorageError(PREVIEW_STORAGE.notFound, 422)
    if (this.mode === 'fail-once' && !this.failed) {
      this.failed = true
      throw new PreviewStorageError(PREVIEW_STORAGE.writeFailure, 503)
    }
    if (this.mode === 'delayed') await this.wait(signal)
    this.active(signal)
    this.configured = root
    return { ...this.read(), restartRequired: Boolean(root) && root !== this.effectiveRoot }
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
