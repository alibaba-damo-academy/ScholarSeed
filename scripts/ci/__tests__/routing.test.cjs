const test = require('node:test')
const assert = require('node:assert/strict')
const { adjacentTest, plan } = require('../affected.cjs')

test('affected resolves migrated Desktop tests in their owning __tests__ directory', () => {
  assert.equal(adjacentTest('apps/desktop/scripts/cd/cache.cjs'), 'apps/desktop/scripts/cd/__tests__/cache.test.cjs')
  const result = plan(['apps/desktop/scripts/cd/cache.cjs'])
  assert.deepEqual(result.unmatched, [])
  assert.equal(result.fallback, null)
  assert.match(result.commands[0].command, /scripts\/cd\/__tests__\/cache.test.cjs/)
})

test('affected retains unmatched files alongside a successfully resolved file', () => {
  const missing = 'apps/desktop/scripts/absent-routing-regression-module.cjs'
  const result = plan(['apps/desktop/scripts/cd/cache.cjs', missing])
  assert.deepEqual(result.unmatched, [missing])
  assert.equal(result.fallback, 'pnpm ops ci test --profile quality')
})
