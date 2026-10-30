import type { StorageConfig } from '../src/storage.ts'

export interface PreviewDirectoryChoice { id: string; label: string; path: string }
export interface PreviewStorageBootstrap { config: StorageConfig; choices: readonly PreviewDirectoryChoice[] }

export type PreviewStorageRead = 'home' | 'workspace'
export type PreviewStorageReadPolicy = 'normal' | 'delayed' | 'failed'
export interface PreviewStoragePolicy {
  write: 'normal' | 'delayed' | 'fail-once'
  homeRead?: PreviewStorageReadPolicy
  workspaceRead?: PreviewStorageReadPolicy
}

export const PREVIEW_STORAGE_READ = {
  configPath: '/__preview/storage/config',
  recoveryPath: '/__preview/storage/recover',
  failure: 'preview_storage_read_failed',
  recoveryUnavailable: 'preview_storage_read_recovery_unavailable',
} as const

const INVALID_BOOTSTRAP = 'Invalid preview storage bootstrap'
const VIRTUAL_PREFIX = '/preview/'

export function readPreviewStorageBootstrap(value: unknown): PreviewStorageBootstrap {
  if (!value || typeof value !== 'object') throw new Error(INVALID_BOOTSTRAP)
  const { config, choices } = value as PreviewStorageBootstrap
  if (!config || typeof config.home !== 'string' || !config.home.startsWith(VIRTUAL_PREFIX)
    || (config.runtimeStore !== null && (typeof config.runtimeStore !== 'string' || !config.runtimeStore.startsWith(VIRTUAL_PREFIX)))
    || typeof config.configured !== 'boolean' || config.canChangeDataHome !== false || config.firstLaunchEligible !== false
    || !Array.isArray(choices) || choices.length === 0 || choices.some(choice => !choice || typeof choice.id !== 'string'
      || !/^[a-z][a-z0-9-]*$/.test(choice.id) || typeof choice.label !== 'string' || !choice.label
      || typeof choice.path !== 'string' || !choice.path.startsWith(VIRTUAL_PREFIX) || choice.path.split('/').includes('..'))
    || new Set(choices.map(choice => choice.id)).size !== choices.length
    || new Set(choices.map(choice => choice.path)).size !== choices.length) throw new Error(INVALID_BOOTSTRAP)
  return structuredClone({ config, choices })
}

export function createPreviewDirectoryPicker() {
  let choices: readonly PreviewDirectoryChoice[] = []
  let resolve: ((path: string | null) => void) | undefined
  let pending: Promise<string | null> | undefined
  const listeners = new Set<(choices: readonly PreviewDirectoryChoice[]) => void>()
  const publish = (): void => { for (const listener of listeners) listener(structuredClone(choices)) }
  return {
    subscribe(listener: (choices: readonly PreviewDirectoryChoice[]) => void): () => void {
      listeners.add(listener)
      listener(structuredClone(choices))
      return () => { listeners.delete(listener) }
    },
    pick(candidates: readonly PreviewDirectoryChoice[]): Promise<string | null> {
      if (pending) return Promise.resolve(null)
      if (!listeners.size || !candidates.length) return Promise.resolve(null)
      choices = structuredClone(candidates)
      const result = new Promise<string | null>(complete => { resolve = complete })
      pending = result
      publish()
      return result
    },
    finish(id: string | null): void {
      if (!resolve) return
      const path = id === null ? null : choices.find(choice => choice.id === id)?.path
      if (path === undefined) return
      const complete = resolve
      resolve = undefined
      pending = undefined
      choices = []
      publish()
      complete(path)
    },
  }
}

export const previewDirectoryPicker = createPreviewDirectoryPicker()
