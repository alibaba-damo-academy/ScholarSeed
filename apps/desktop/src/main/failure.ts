import type { UpdateSnapshot } from '../updates'
import type { TFunction } from 'i18next'

/** Product-owned startup reasons; raw subprocess/runtime diagnostics remain separate. */
export type BackendFailure =
  | { kind: 'pythonMissing'; path: string }
  | { kind: 'pythonInvalid' | 'startupFailed'; detail: string }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; detail?: string }
  | { kind: 'healthTimeout' }

export function backendFailureMessage(
  t: TFunction<'foundation'>,
  failure: BackendFailure | null | undefined,
  fallback: 'notReady' | 'recovering'
): string {
  if (!failure) return fallback === 'recovering'
    ? t('backendFailure.recovering')
    : t('backendFailure.notReady')
  let message: string
  switch (failure.kind) {
    case 'pythonMissing':
      return t('backendFailure.pythonMissing', { path: failure.path })
    case 'pythonInvalid':
      message = t('backendFailure.pythonInvalid')
      break
    case 'startupFailed':
      message = t('backendFailure.startupFailed')
      break
    case 'exited':
      message = t('backendFailure.exited', { code: String(failure.code), signal: String(failure.signal) })
      break
    case 'healthTimeout':
      return t('backendFailure.healthTimeout')
  }
  return failure.detail ? `${message}\n\n${failure.detail}` : message
}


const UPDATE_INSTALL_FAILED = 'update failed'

/** Preserve the install result string while distinguishing a locally generated fallback. */
export function updateInstallFailure(
  error: string | undefined
): Pick<UpdateSnapshot, 'error' | 'errorFallback' | 'errorOrigin'> {
  return error
    ? { error, errorFallback: undefined, errorOrigin: 'install' }
    : { error: UPDATE_INSTALL_FAILED, errorFallback: 'install_failed', errorOrigin: 'install' }
}
