import assert from 'node:assert/strict'
import test from 'node:test'

import { libraryFileType, libraryUpdatedAt } from './utils.ts'

test('library file types preserve the final extension and handle extensionless names', () => {
  assert.equal(libraryFileType('research.summary.md'), 'MD')
  assert.equal(libraryFileType('report.PDF'), 'PDF')
  assert.equal(libraryFileType('.gitignore'), '—')
  assert.equal(libraryFileType('README'), '—')
  assert.equal(libraryFileType('report.'), '—')
})

test('library update time uses relative dates before seven days and dates thereafter', () => {
  const now = new Date('2026-10-19T12:00:00Z').getTime()
  const seconds = now / 1000
  assert.equal(libraryUpdatedAt(undefined, 'en', now), '—')
  assert.equal(libraryUpdatedAt(Number.NaN, 'en', now), '—')
  for (const elapsed of [0, 1, 58, 59.999]) {
    assert.equal(libraryUpdatedAt(seconds - elapsed, 'zh', now, '刚刚'), '刚刚')
    assert.equal(libraryUpdatedAt(seconds - elapsed, 'en', now, 'Just now'), 'Just now')
  }
  assert.equal(libraryUpdatedAt(seconds - 60, 'en', now), '1 minute ago')
  assert.equal(libraryUpdatedAt(seconds - 6 * 86400, 'en', now), '6 days ago')
  const weekAgo = seconds - 7 * 86400
  assert.equal(
    libraryUpdatedAt(weekAgo, 'en', now),
    new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      weekAgo * 1000
    )
  )
})
