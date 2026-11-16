import { SCHEMA_UPGRADE_REQUIRED } from '../startup.ts'
import type { UpdateInstallFallback, UpdateSnapshot } from '../updates'
import type { TFunction } from 'i18next'
import { BROWSER_FEATURE_POLICY_ERROR } from './product.ts'

const BROWSER_POLICY_FAILURE_KEYS = {
  [BROWSER_FEATURE_POLICY_ERROR.missing]: 'backendFailure.browserPolicyMissing',
  [BROWSER_FEATURE_POLICY_ERROR.invalid]: 'backendFailure.browserPolicyInvalid',
  [BROWSER_FEATURE_POLICY_ERROR.mismatch]: 'backendFailure.browserPolicyMismatch',
} as const

/** Product-owned startup reasons; raw subprocess/runtime diagnostics remain separate. */
export type BackendFailure =
  | { kind: 'pythonMissing'; path: string }
  | { kind: 'pythonInvalid' | 'startupFailed'; detail: string }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; detail?: string }
  | { kind: 'healthTimeout' }
  | { kind: typeof SCHEMA_UPGRADE_REQUIRED; detail: string }

// Only the product exception's complete, bounded line classifies an upgrade.
// Unknown SQL and arbitrary occurrences of the token remain generic failures.
const SCHEMA_UPGRADE_LINE =
  /^(?:service\.persistence\.revisions\.)?SchemaUpgradeRequired: SCHOLARSEED_SCHEMA_UPGRADE_REQUIRED owner=[a-z][a-z0-9_]{0,63} revision=([1-9][0-9]{0,18}) supported=([1-9][0-9]{0,18})$/m

export function classifyBackendFailure(failure: BackendFailure): BackendFailure {
  if (failure.kind !== 'exited' && failure.kind !== 'startupFailed') return failure
  const match = SCHEMA_UPGRADE_LINE.exec((failure.detail ?? '').replace(/\r\n/g, '\n'))
  if (!match || BigInt(match[1]) <= BigInt(match[2])) return failure
  return { kind: SCHEMA_UPGRADE_REQUIRED, detail: failure.detail ?? '' }
}

export function backendFailureMessage(
  t: TFunction<'foundation'>,
  failure: BackendFailure | null | undefined,
  fallback: 'notReady' | 'recovering'
): string {
  if (!failure)
    return fallback === 'recovering' ? t('backendFailure.recovering') : t('backendFailure.notReady')
  let message: string
  switch (failure.kind) {
    case SCHEMA_UPGRADE_REQUIRED:
      return t('backendFailure.schemaUpgradeRequired')
    case 'pythonMissing':
      return t('backendFailure.pythonMissing', { path: failure.path })
    case 'pythonInvalid':
      message = t('backendFailure.pythonInvalid')
      break
    case 'startupFailed':
      const policyCode = Object.values(BROWSER_FEATURE_POLICY_ERROR).find((code) =>
        failure.detail.includes(code)
      )
      message = policyCode
        ? t(BROWSER_POLICY_FAILURE_KEYS[policyCode])
        : t('backendFailure.startupFailed')
      break
    case 'exited':
      message = t('backendFailure.exited', {
        code: String(failure.code),
        signal: String(failure.signal),
      })
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
export function updateInstallFailure(result: {
  error?: string
  errorFallback?: UpdateInstallFallback
}): Pick<UpdateSnapshot, 'error' | 'errorFallback' | 'errorOrigin'> {
  if (result.errorFallback) {
    return { error: undefined, errorFallback: result.errorFallback, errorOrigin: 'install' }
  }
  return result.error
    ? { error: result.error, errorFallback: undefined, errorOrigin: 'install' }
    : { error: UPDATE_INSTALL_FAILED, errorFallback: 'install_failed', errorOrigin: 'install' }
}
