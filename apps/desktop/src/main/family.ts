import { setTimeout as delay } from 'node:timers/promises'
import type { UpdateInstallFallback } from '../updates.ts'

export interface ProcessFamily {
  active(): number
  terminate(): void
  close(): void
}
export interface FamilyNative {
  openFamily(pid: number): ProcessFamily
}
const FAMILY_DRAIN_TIMEOUT_MS = 5_000
const FAMILY_POLL_MS = 50
// Retrying a failed drain must not forget that this family required force.
const forcedFamilies = new WeakSet<ProcessFamily>()

// The one-byte inherited-pipe barrier runs before importing product code. It
// prevents a child from spawning a runtime before its parent attaches the Job.
export const WINDOWS_BACKEND_BOOTSTRAP = [
  'import os,sys,time',
  'def checkpoint(phase):',
  '    try:',
  '        print(f"startup_checkpoint phase={phase} pid={os.getpid()} monotonic_seconds={time.monotonic():.6f} unix_seconds={time.time():.6f}", file=sys.stderr, flush=True)',
  '    except (OSError, ValueError):',
  '        pass',
  'checkpoint("python.wrapper_entered")',
  'token=os.read(sys.stdin.fileno(),1)',
  "sys.exit(125) if token != b'\\x01' else None",
  'checkpoint("python.family_released")',
  'import runpy',
  'sys.argv=sys.argv[1:]',
  'checkpoint("python.module_dispatch")',
  "runpy.run_module(sys.argv[0],run_name='__main__',alter_sys=True)",
].join('\n')
export const FAMILY_START_BYTE = Buffer.from([1])

async function waitForFamilyExit(family: ProcessFamily): Promise<boolean> {
  const deadline = Date.now() + FAMILY_DRAIN_TIMEOUT_MS
  while (family.active() !== 0) {
    if (Date.now() >= deadline) return false
    await delay(FAMILY_POLL_MS)
  }
  return true
}

/** Allow natural exit before forcing descendants; a forced attempt cannot install. */
export async function drainProcessFamily(family: ProcessFamily): Promise<boolean> {
  if (!forcedFamilies.has(family)) {
    await waitForFamilyExit(family)
  }
  if (family.active() !== 0) {
    forcedFamilies.add(family)
    family.terminate()
  }
  if (!(await waitForFamilyExit(family)))
    throw new Error('Owned runtime process family did not exit')
  family.close()
  return !forcedFamilies.has(family)
}

/** Classify the native observation, never infer occupancy from error prose. */
export function installationFailure(error: unknown): UpdateInstallFallback | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  switch (error.code) {
    case 'ERR_UPDATE_INSTALLATION_IN_USE':
      return 'install_in_use'
    case 'ERR_UPDATE_INSTALLATION_QUERY':
    case 'ERR_UPDATE_INSTALLATION_SESSION':
      return 'install_occupancy_unknown'
    default:
      return undefined
  }
}
