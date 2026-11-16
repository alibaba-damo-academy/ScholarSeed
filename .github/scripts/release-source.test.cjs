const assert = require('node:assert/strict')
const { test } = require('node:test')
const { validateSourceRun } = require('./release-source.cjs')
const repository = 'alibaba-damo-academy/ScholarSeed'
const fixture = () => ({
  id: 123, repository: { full_name: repository }, head_repository: { full_name: repository },
  path: '.github/workflows/signed-macos.yml', head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40),
})

test('accepts successful main builds from automatic and manual triggers', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const run = { ...fixture(), event }
    assert.equal(validateSourceRun(run, repository, '123'), run.head_sha)
  }
})

for (const [field, value] of [
  ['id', 124], ['repository', { full_name: 'other/repo' }],
  ['head_repository', { full_name: 'fork/repo' }],
  ['path', '.github/workflows/ci.yml'], ['head_branch', 'feature/test'],
  ['event', 'pull_request'], ['status', 'in_progress'], ['conclusion', 'failure'],
  ['conclusion', 'cancelled'], ['head_sha', 'bad\ncommit'],
]) {
  test(`rejects an invalid source build: ${field}=${JSON.stringify(value)}`, () => {
    assert.throws(() => validateSourceRun({ ...fixture(), [field]: value }, repository, '123'))
  })
}

test('rejects malformed run IDs', () => {
  for (const id of ['123/attempts/1', '0', '123\n', '']) {
    assert.throws(() => validateSourceRun(fixture(), repository, id))
  }
})
