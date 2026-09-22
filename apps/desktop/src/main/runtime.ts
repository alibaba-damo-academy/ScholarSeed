import { resolve } from 'path'

import type { CodexRuntimePolicy } from './product.ts'

export interface CodexRuntimeEnvironmentProjection {
  environment: NodeJS.ProcessEnv
  applied: boolean
}

export function projectCodexRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  policy: CodexRuntimePolicy,
  packaged: boolean,
  selectedExecutable: string,
  bundledExecutable: string
): CodexRuntimeEnvironmentProjection {
  const environment = { ...source }
  const applied = Boolean(
    packaged
    && selectedExecutable
    && bundledExecutable
    && resolve(selectedExecutable) === resolve(bundledExecutable)
  )
  if (!applied) return { environment, applied }

  return { environment, applied }
}
