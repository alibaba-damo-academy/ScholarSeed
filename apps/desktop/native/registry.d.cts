export const REGISTRY_DIRECTORY: string
export function removeLegacyCoordination(coordinator: string): void
export interface RegistryTiming {
  timestampMs: number
  beginMs: number
  operationMs: number
  commitMs: number
  rollbackMs: number
  result: 'failed' | 'committed' | 'rolled-back'
  failedPhase?: 'begin' | 'operation' | 'commit' | 'rollback'
  errorCode?: string
  sqliteCode?: number
}
export function observeRegistry(observer: (event: Readonly<RegistryTiming>) => void): () => void
export function withRegistryObserver<Value>(
  observer: (event: Readonly<RegistryTiming>) => void,
  operation: () => Value
): Value
