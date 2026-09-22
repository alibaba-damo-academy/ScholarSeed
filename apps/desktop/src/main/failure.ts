import type { UpdateInstallFallback, UpdateSnapshot } from '../updates'
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

/**
 * 把安装结果投影成快照的失败三元组。
 *
 * 带结构化分类（errorFallback）时**不透出原始 error**：Windows 校验/安装失败的诊断可能是控制台
 * 代码页下的中文 stderr，直接进用户文案会乱码（bug 87042987），原文只落 update.log，界面按分类给
 * 本地化说法。没有分类、但有 error 文本时（例如下载完整性失败这类我方生成的英文串）保留原文；
 * 两者都没有则退到笼统 fallback。来源恒为 install，与相位无关。
 */
export function updateInstallFailure(
  result: { error?: string; errorFallback?: UpdateInstallFallback }
): Pick<UpdateSnapshot, 'error' | 'errorFallback' | 'errorOrigin'> {
  if (result.errorFallback) {
    return { error: undefined, errorFallback: result.errorFallback, errorOrigin: 'install' }
  }
  return result.error
    ? { error: result.error, errorFallback: undefined, errorOrigin: 'install' }
    : { error: UPDATE_INSTALL_FAILED, errorFallback: 'install_failed', errorOrigin: 'install' }
}
