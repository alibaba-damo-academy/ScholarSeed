// Scheduling only. The native installer owns the journal, locks and deletion authority.
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const CLEANUP_MODE = '___cleanup___'
const HELPER = ['Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt']
const RETRY_DELAYS_MS = [0, 30_000, 120_000]
const PROCESS_TIMEOUT_MS = 5 * 60_000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_LOG_LINE = 512

interface CleanupRequest {
  platform: NodeJS.Platform
  packaged: boolean
  application: string
  bundle: string
}
interface CleanupDependencies {
  execute: (executable: string, args: string[]) => Promise<{ code: number; stderr: string }>
  delay: (milliseconds: number) => Promise<void>
  log: (line: string) => void
}

function execute(executable: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      },
      (error, _stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stderr })
      }
    )
  })
}

function delay(milliseconds: number): Promise<void> {
  if (!milliseconds) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref()
  })
}

/** Call without awaiting after product readiness. A future startup retries remaining work. */
export async function retryMacCleanup(
  request: CleanupRequest,
  log: (line: string) => void,
  dependencies: CleanupDependencies = { execute, delay, log }
): Promise<boolean> {
  if (request.platform !== 'darwin' || !request.packaged) return true
  if (!/^[A-Za-z0-9.-]+$/.test(request.bundle) || !request.application.endsWith('.app')) {
    dependencies.log('[update-cleanup] event=invalid-request\n')
    return false
  }
  for (const [index, milliseconds] of RETRY_DELAYS_MS.entries()) {
    await dependencies.delay(milliseconds)
    try {
      const result = await dependencies.execute(join(request.application, ...HELPER), [
        CLEANUP_MODE,
        `${request.bundle}.ShipIt`,
        request.application,
      ])
      // Forward only bounded native diagnostics, never arbitrary helper stderr/paths.
      for (const line of result.stderr.slice(-MAX_OUTPUT_BYTES).split(/\r?\n/)) {
        const marker = line.indexOf('[shipit-cleanup]')
        if (marker >= 0) dependencies.log(line.slice(marker, marker + MAX_LOG_LINE) + '\n')
      }
      dependencies.log(`[update-cleanup] event=attempt attempt=${index + 1} code=${result.code}\n`)
      if (result.code === 0) return true
    } catch {
      dependencies.log(`[update-cleanup] event=attempt attempt=${index + 1} result=failed\n`)
    }
  }
  dependencies.log('[update-cleanup] event=retry-on-next-startup\n')
  return false
}
