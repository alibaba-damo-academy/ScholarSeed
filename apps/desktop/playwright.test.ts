import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('Playwright configuration disables retries for local and CI execution', () => {
  for (const ci of ['', '1']) {
    const configuration = spawnSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '-e',
        "process.stdout.write(JSON.stringify(require('./playwright.config.ts').default.retries))",
      ],
      {
        cwd: import.meta.dirname,
        env: { ...process.env, CI: ci },
        encoding: 'utf8',
      }
    )
    assert.equal(configuration.status, 0, configuration.stderr)
    assert.equal(JSON.parse(configuration.stdout), 0)
  }
})
