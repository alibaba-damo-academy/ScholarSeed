import assert from 'node:assert/strict'
import test from 'node:test'

import { libraryFileType, libraryUpdatedAt, userMessageParts, userMessageTime } from './utils.ts'

test('user message time includes the local date and 24-hour minute in both languages', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    assert.equal(
      userMessageTime(new Date(2026, 9, 22, 10, 42).getTime(), locale),
      '2026-10-22 10:42'
    )
    assert.equal(userMessageTime(new Date(2026, 0, 2, 0, 5).getTime(), locale), '2026-01-02 00:05')
  }
})

test('user message links preserve literal text, queries and balanced URL punctuation', () => {
  const source = '# 标题\n*β* `code` https://example.com/a_(b)?x=1&y=%20。下一段'
  const parts = userMessageParts(source)
  assert.equal(parts.map((part) => part.text).join(''), source)
  assert.deepEqual(
    parts.filter((part) => part.href),
    [{ text: 'https://example.com/a_(b)?x=1&y=%20', href: 'https://example.com/a_(b)?x=1&y=%20' }]
  )
  assert.deepEqual(userMessageParts('(https://example.com/path).'), [
    { text: '(' },
    { text: 'https://example.com/path', href: 'https://example.com/path' },
    { text: ').' },
  ])
})

test('user message link detection never enables unsafe schemes or interprets Markdown', () => {
  for (const source of [
    '',
    '**bold**\n<script>hello</script>',
    'javascript:alert(1)',
    'file:///tmp/a',
    'https://',
  ]) {
    const parts = userMessageParts(source)
    assert.equal(parts.map((part) => part.text).join(''), source)
    assert.equal(
      parts.some((part) => part.href),
      false
    )
  }
  const source = 'https://example.com/?q=%2F#raw https://example.com/second'
  assert.deepEqual(
    userMessageParts(source)
      .filter((part) => part.href)
      .map((part) => part.href),
    ['https://example.com/?q=%2F#raw', 'https://example.com/second']
  )
})

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
