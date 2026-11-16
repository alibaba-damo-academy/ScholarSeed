const assert = require('node:assert/strict')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { resolveCommand } = require('../shared/commands.cjs')

test('private engineering workflows and evidence are absent from the public tracked tree', () => {
  const root = path.resolve(__dirname, '../..')
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const forbidden = files.filter(filename => filename.startsWith('.agents/skills/') || filename.startsWith('scripts/public/') || ['.codex/skills', 'apps/serve/service/chat/prompts/README.md', 'apps/desktop/docs/architecture/design-map.md'].includes(filename))
  assert.deepEqual(forbidden, [])
})

test('the public tracked tree excludes Claude integration entries at every depth', () => {
  const root = path.resolve(__dirname, '../..')
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const forbidden = files.filter(filename => filename.split('/').includes('.claude') || path.posix.basename(filename) === 'CLAUDE.md')
  assert.deepEqual(forbidden, [])
})

test('public engineering commands resolve locally without a document parent', () => {
  for (const args of [
    ['ci', 'check', 'docs', 'workspace'],
    ['ci', 'check', 'docs', 'desktop'],
    ['pre', 'repair', 'links'],
    ['pre', 'doctor', '--scope', 'links'],
  ]) {
    const command = resolveCommand(args)
    assert.ok(command.steps.length > 0)
    for (const step of command.steps) assert.doesNotMatch(JSON.stringify(step), /DeepR_D_harness|ScholarSeed-fork|\.\.\//)
  }
  assert.equal(resolveCommand(['ci', 'check', 'skills', 'product']).steps[0].method, 'skillsVerify')
  assert.equal(resolveCommand(['ci', 'check', 'ui']).steps[0].file, 'apps/desktop/scripts/ci/reuse.mjs')
  assert.throws(() => resolveCommand(['ci', 'check', 'skills', 'host', '--mode', 'links']), /private documentation repository/)
})
