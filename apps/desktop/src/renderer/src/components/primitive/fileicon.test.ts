import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as FileIcons from './FileIcon'
import { fileIconKind } from './utils.ts'

test('file names select the available design assets', () => {
  for (const [name, kind] of [
    ['report.PDF', 'pdf'],
    ['slides.pptx', 'ppt'],
    ['paper.docx', 'word'],
    ['data.xlsx', 'excel'],
    ['data.csv', 'excel'],
    ['photo.jpeg', 'image'],
    ['note.md', 'text'],
    ['page.htm', 'html'],
    ['view.tsx', 'tsx'],
    ['movie.mp4', 'mov'],
    ['archive.tar.gz', 'zip'],
    ['code.py', 'html'],
    ['https://host/report.PDF?download=1#page=2', 'pdf'],
    ['C:\\folder.pdf\\README', undefined],
    ['folder.pdf/README', undefined],
    ['.pdf', undefined],
    ['README', undefined],
    ['file.', undefined],
    ['unknown.xyz', undefined],
    ['music.MP3', 'music'],
    ['sound.flac', 'music'],
    ['', undefined],
  ] as const)
    assert.equal(fileIconKind(name), kind, name)
})

test('shared file icons render imported assets and preserve the document fallback', () => {
  const compiled = buildSync({
    entryPoints: [fileURLToPath(new URL('./FileIcon.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    loader: { '.webp': 'dataurl', '.png': 'dataurl' },
    jsx: 'transform',
  }).outputFiles[0].text
  const loaded = { exports: {} as typeof FileIcons }
  runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    require: createRequire(import.meta.url),
  })
  for (const [name, icon] of [
    ['note.txt', 'file-text'],
    ['data.xlsx', 'file-spreadsheet'],
    ['image.png', 'file-image'],
    ['code.json', 'file-code'],
    ['unknown.extension', 'file'],
  ]) {
    const markup = renderToStaticMarkup(
      createElement(loaded.exports.FileFormatIcon, { name, appearance: 'outline' })
    )
    assert.match(markup, new RegExp(`lucide-${icon}(?: |")`))
    assert.doesNotMatch(markup, /<img/)
  }
  for (const extension of [
    'pdf',
    'pptx',
    'docx',
    'xlsx',
    'png',
    'txt',
    'html',
    'tsx',
    'mp4',
    'zip',
    'mp3',
  ]) {
    const markup = renderToStaticMarkup(
      createElement(loaded.exports.FileFormatIcon, {
        name: `file.${extension}`,
        size: 20,
        className: 'consumer-icon',
      })
    )
    assert.match(markup, /<img[^>]+src="data:image\/(?:webp|png);base64,/)
    assert.match(markup, /width:20px;height:20px/)
    assert.match(markup, /consumer-icon/)
  }
  const directory = renderToStaticMarkup(
    createElement(loaded.exports.FileFormatIcon, { name: 'folder.pdf', kind: 'dir' })
  )
  assert.match(directory, /<img[^>]+src="data:image\/webp;base64,/)
  assert.notEqual(
    loaded.exports.fileIconForName('folder.pdf', 'dir'),
    loaded.exports.fileIconForName('folder.pdf')
  )
  for (const name of ['README', 'file.xyz', 'file.unknown']) {
    const markup = renderToStaticMarkup(createElement(loaded.exports.fileIconForName(name)))
    assert.doesNotMatch(markup, /<img/)
    assert.match(markup, /lucide-file/)
  }
  assert.equal(loaded.exports.fileIconForName('one.pdf'), loaded.exports.fileIconForName('two.PDF'))
})
