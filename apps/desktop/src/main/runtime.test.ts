import assert from 'node:assert/strict'
import test from 'node:test'

import type { CodexRuntimePolicy } from './product.ts'
import { projectCodexRuntimeEnvironment } from './runtime.ts'

const POLICY: CodexRuntimePolicy = {
  profile: 'official',
  executableSha256: 'a'.repeat(64),
  reportedVersion: '0.147.0'
}

test('packaged bundled upstream Codex keeps caller environment unchanged', () => {
  const bundled = '/Applications/ScholarSeed.app/Contents/Resources/backend/bin/codex'
  const projection = projectCodexRuntimeEnvironment(
    { EXISTING: 'kept' },
    POLICY,
    true,
    bundled,
    bundled
  )
  assert.equal(projection.applied, true)
  assert.equal(projection.environment.EXISTING, 'kept')
})

test('development and external overrides keep caller-owned runtime configuration', () => {
  const source = { CODEX_HOME: '/caller-owned' }
  const development = projectCodexRuntimeEnvironment(
    source,
    POLICY,
    false,
    '/repo/codex',
    ''
  )
  const external = projectCodexRuntimeEnvironment(
    source,
    POLICY,
    true,
    '/external/codex',
    '/Applications/ScholarSeed.app/Contents/Resources/backend/bin/codex'
  )
  assert.equal(development.applied, false)
  assert.equal(external.applied, false)
  assert.equal(development.environment.CODEX_HOME, '/caller-owned')
  assert.equal(external.environment.CODEX_HOME, '/caller-owned')
})
