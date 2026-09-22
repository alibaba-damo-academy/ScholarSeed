import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const homeSource = readFileSync(
  new URL('./HomeOverview.tsx', import.meta.url),
  'utf8'
)

test('project card modification label stays on one line without a fixed width', () => {
  assert.match(
    homeSource,
    /<span className="!w-auto flex-none whitespace-nowrap">\s*\{t\('home\.recentlyModified'\)\}/
  )
})
