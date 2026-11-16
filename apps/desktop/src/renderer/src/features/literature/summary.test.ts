import assert from 'node:assert/strict'
import test from 'node:test'

import { literatureNoteSummary } from './synopsis.ts'

test('note summaries omit the repeated heading and retain plain Markdown content', () => {
  assert.equal(
    literatureNoteSummary({
      title: 'Results',
      text: '# Results\n\nA **bold** and *clear* [finding](https://example.org).\n\n- `Code`\n- ~~old~~ new',
    }),
    'A bold and clear finding. Code old new'
  )
})

test('summaries keep distinct headings, escape HTML as text by not rendering it, and handle empty notes', () => {
  assert.equal(
    literatureNoteSummary({
      title: 'Notes',
      text: '## Findings\n\n<script>unsafe()</script>\n\nVisible',
    }),
    'Findings Visible'
  )
  assert.equal(literatureNoteSummary({ title: 'Empty', text: ' \n ' }), '')
})

test('summaries bound long content without splitting Unicode characters', () => {
  const summary = literatureNoteSummary({ title: '', text: '📚'.repeat(300) })
  assert.equal(summary, `${'📚'.repeat(240)}…`)
})
