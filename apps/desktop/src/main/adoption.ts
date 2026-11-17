export const ADOPTION_STAGE = {
  window: 'window',
  workbench: 'workbench',
  refreshRead: 'refresh-read',
  refreshWrite: 'refresh-write',
  identity: 'identity-notification',
  cookie: 'cookie-write',
  synchronize: 'notification-synchronize',
} as const

export type AdoptionStage = (typeof ADOPTION_STAGE)[keyof typeof ADOPTION_STAGE]

const ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOSPC',
  'EIO',
  'EBUSY',
  'EROFS',
  'ERR_WORKBENCH_NOT_READY',
  'ERR_WINDOW_UNAVAILABLE',
  'ERR_DOMAIN_CHANGED',
  'ERR_DOMAIN_RELEASE',
  'ERR_LEASE_BUSY',
  'ERR_LEASE_MISSING',
  'ERR_LEASE_RELEASE',
  'ERR_LEASE_NATIVE',
  'ERR_LEASE_PERMISSION',
])
const SYSCALLS = new Set(['open', 'write', 'rename', 'unlink', 'chmod', 'close', 'mkdir'])

/** Keep credential errors observable without publishing arbitrary exception text. */
export function reportAdoptionFailure(
  log: (line: string) => void,
  stage: AdoptionStage,
  error: unknown
): void {
  try {
    const detail =
      error && typeof error === 'object'
        ? (error as { code?: unknown; message?: unknown; syscall?: unknown; systemCode?: unknown })
        : {}
    const code =
      typeof detail.code === 'string' && ERROR_CODES.has(detail.code)
        ? detail.code
        : typeof detail.message === 'string' && ERROR_CODES.has(detail.message)
          ? detail.message
          : 'unknown'
    log(
      `[shell] credential adoption failed ${JSON.stringify({
        stage,
        code,
        syscall:
          typeof detail.syscall === 'string' && SYSCALLS.has(detail.syscall)
            ? detail.syscall
            : undefined,
        systemCode:
          typeof detail.systemCode === 'number' && Number.isSafeInteger(detail.systemCode)
            ? detail.systemCode
            : undefined,
      })}\n`
    )
  } catch {
    // Diagnostics must not replace the original authentication failure.
  }
}
