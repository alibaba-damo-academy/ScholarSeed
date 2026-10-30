import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformFileAsync } from '@babel/core'

import localizationDom from './dom.mjs'

const SOURCE_ROOT = fileURLToPath(new URL('../../../src/renderer/src/', import.meta.url))
const SOURCE_EXTENSION = /\.[jt]sx?$/
const EXCLUDED_SOURCE = /\.(?:fixture|test)\.[jt]sx?$/
const EXCLUDED_DIRECTORIES = new Set(['node_modules'])

async function collectSources(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('.') || EXCLUDED_DIRECTORIES.has(entry.name))) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await collectSources(target, files)
    else if (SOURCE_EXTENSION.test(entry.name) && !EXCLUDED_SOURCE.test(entry.name)) files.push(target)
  }
}

const files = []
await collectSources(SOURCE_ROOT, files)
const gaps = []
for (const file of files.sort()) {
  const result = await transformFileAsync(file, {
    ast: false,
    babelrc: false,
    code: false,
    configFile: false,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [localizationDom]
  })
  for (const item of result?.metadata.localizationDomGaps ?? []) {
    gaps.push({ file: path.relative(SOURCE_ROOT, file), ...item })
  }
}

const counts = Object.groupBy(gaps, (item) => item.reason)
console.log(`total ${gaps.length}`)
for (const [reason, items] of Object.entries(counts).sort()) console.log(`${reason} ${items.length}`)
console.log('')
for (const item of gaps) console.log(`${item.file}:${item.line}:${item.column + 1} ${item.slot} ${item.reason}`)
