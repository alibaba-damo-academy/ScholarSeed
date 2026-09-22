import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatTextOnSave,
  supportsFormatOnSave
} from './format.ts'

const UTF8 = new TextEncoder()

test('format-on-save only advertises the Prettier formats editable by Workbench', () => {
  for (const path of [
    'README.md', 'notes.markdown', 'app.js', 'view.jsx', 'app.ts', 'view.tsx',
    'data.json', 'site.css', 'index.html', 'config.yaml', 'config.yml'
  ]) assert.equal(supportsFormatOnSave(path), true, path)

  for (const path of [
    'script.py', 'main.c', 'main.cpp', 'Main.java', 'script.sh', 'config.toml',
    'events.jsonl', 'page.xml', 'notes.txt', 'app.vue', 'theme.scss', 'query.graphql'
  ]) assert.equal(supportsFormatOnSave(path), false, path)
})

test('format-on-save formats TypeScript and preserves the original CRLF convention', async () => {
  const source = 'const value={answer:42}\r\n'
  const result = await formatTextOnSave({
    path: 'src/value.ts',
    text: source,
    savedBytes: UTF8.encode(source),
    cursorOffset: source.indexOf('42')
  })

  assert.equal(result.status, 'formatted')
  if (result.status !== 'formatted') return
  assert.equal(result.text, 'const value = { answer: 42 };\r\n')
  assert.equal(result.text.split('\r\n').join('').includes('\n'), false)
  assert.ok(result.cursorOffset !== null)
  assert.ok(result.cursorOffset >= result.text.indexOf('42'))
})

test('format-on-save formats Markdown while preserving LF', async () => {
  const source = '# Title\n\n-   first\n-   second\n'
  const result = await formatTextOnSave({
    path: 'README.md',
    text: source,
    savedBytes: UTF8.encode(source)
  })

  assert.equal(result.status, 'formatted')
  if (result.status !== 'formatted') return
  assert.equal(result.text, '# Title\n\n- first\n- second\n')
})

test('unsupported and invalid syntax return explicit non-destructive results', async () => {
  const unsupported = await formatTextOnSave({
    path: 'script.py',
    text: 'value={"answer":42}\n',
    savedBytes: UTF8.encode('value={"answer":42}\n')
  })
  assert.deepEqual(unsupported, { status: 'unsupported' })

  const failed = await formatTextOnSave({
    path: 'broken.ts',
    text: 'const =',
    savedBytes: UTF8.encode('const =')
  })
  assert.equal(failed.status, 'failed')
})
