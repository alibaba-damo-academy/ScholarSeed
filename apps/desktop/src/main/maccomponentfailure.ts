import { UpdateTransportError } from './retry.ts'

const fallbackCodes = {
  'manifest-request': 'transfer-failed',
  manifest: 'invalid-manifest',
  cache: 'cache-unavailable',
  download: 'transfer-failed',
  assembly: 'invalid-layout',
} as const
type ComponentStage = keyof typeof fallbackCodes
const fileCodes = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'EIO', 'ELOOP'])

export class MacZipIntegrityError extends Error {}
export class UnsafeMacCacheError extends Error {}

class ComponentFailure extends Error {
  readonly stage: ComponentStage
  readonly code: string
  readonly httpStatus?: number

  constructor(stage: ComponentStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'ZIP component operation failed', { cause })
    this.stage = stage
    const code = (cause as NodeJS.ErrnoException | null)?.code
    if (cause instanceof UpdateTransportError) {
      this.code = 'http-status'
      this.httpStatus = cause.status
    } else if (cause instanceof MacZipIntegrityError) this.code = 'integrity-mismatch'
    else if (cause instanceof UnsafeMacCacheError) this.code = 'unsafe-cache'
    else if (cause instanceof Error && cause.name === 'TimeoutError') this.code = 'timeout'
    else this.code = code && fileCodes.has(code) ? code : fallbackCodes[stage]
  }
}

export async function componentStep<T>(
  stage: ComponentStage,
  operation: () => T | Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new ComponentFailure(stage, error)
  }
}

/** Only bounded fields may reach update.log. Causes can contain paths and signed URLs. */
export function macComponentDiagnostic(error: unknown, stage: ComponentStage = 'cache') {
  const failure = error instanceof ComponentFailure ? error : new ComponentFailure(stage, error)
  return { stage: failure.stage, errorCode: failure.code, httpStatus: failure.httpStatus }
}
