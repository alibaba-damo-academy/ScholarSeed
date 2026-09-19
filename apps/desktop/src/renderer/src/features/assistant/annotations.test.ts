import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./Annotations.tsx', import.meta.url), 'utf8')

test('inline annotation badges import their rendered component', () => {
  const notesImport = source.match(/import\s*{([^}]*)}\s*from '\.\/Notes'/)
  assert.ok(notesImport)
  assert.match(notesImport[1], /\bAnnotationBadgeNote\b/)
  assert.match(source, /<AnnotationBadgeNote\b/)
})
