import type { DomainNative } from './domains.cjs'

export interface ReclamationNative extends DomainNative {
  reclaimAt(pin: unknown, identity: string): { removed: number; busy: boolean; retained: boolean }
}
export interface ReclamationResult {
  removed: number
  busy: number
  retained: number
  examined: number
  complete: boolean
  absent: boolean
  errors: { code: string; systemCode: number | null }[]
}
export function reclaimCoordination(native: ReclamationNative, directory: string): ReclamationResult
export function uncertainRelease(error: unknown): boolean
