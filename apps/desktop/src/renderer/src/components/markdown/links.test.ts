import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import type { Element, Root, RootContent } from 'hast'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'

import { absoluteSessionFilePath, messageLinks, relativeSessionFilePath } from './links.ts'
import { rehypeScholarSeedDecorations } from './decorate.ts'

const LONG_TEXT_LENGTH = 60_000
const LONG_TEXT_BUDGET_MS = 1_000

function decoratePaths(source: string): { tree: Root; paths: string[] } {
  const paths: string[] = []
  const tree: Root = {
    type: 'root',
    children: [
      {
        type: 'text',
        value: source,
        position: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: source.length + 1, offset: source.length },
        },
      },
    ],
  }
  rehypeScholarSeedDecorations({
    source,
    sourceMapped: false,
    evidence: [],
    answers: [],
    isSourceLink: (href) => {
      paths.push(href)
      return true
    },
  })()(tree)
  return { tree, paths }
}

test('source path scanning stays bounded for long non-path text and incomplete paths', () => {
  for (const suffix of ['', '/', '\\']) {
    const source = 'a'.repeat(LONG_TEXT_LENGTH) + suffix
    const started = performance.now()
    const { paths } = decoratePaths(source)
    const elapsed = performance.now() - started
    assert.deepEqual(paths, [])
    assert.ok(
      elapsed < LONG_TEXT_BUDGET_MS,
      `Scanning ${source.length} characters took ${elapsed}ms`
    )
  }
})

test('source path boundaries preserve Unicode, platform syntax and UTF-16 positions', () => {
  for (const path of [
    'resources/项目/report.md',
    'resources\\项目\\report.md',
    './resources/report.md',
    '../resources/report.md',
    '.\\resources\\report.md',
    'C:/项目/report.md',
    'C:\\项目\\report.md',
    '/tmp/项目/report.md',
    '𐐀目录/report.md',
    '.../report.md',
  ]) {
    const source = `😀（${path}）`
    const { paths, tree } = decoratePaths(source)
    assert.deepEqual(paths, [path])
    const link = tree.children.find(
      (child): child is Element => child.type === 'element' && child.tagName === 'a'
    )
    assert.ok(link)
    assert.equal(link.position?.start.offset, source.indexOf(path))
    assert.equal(source.slice(link.position?.start.offset, link.position?.end.offset), path)
  }
  assert.deepEqual(decoratePaths('prefix:C:/report.md, tail/file.txt!').paths, [
    'C:/report.md',
    'tail/file.txt',
  ])
})

test('observed source paths become links without linking code blocks or losing source offsets', async () => {
  const relative = 'resources/项目A/calibration.md#L5'
  const absolute = 'D:\\work space\\项目A\\resources\\项目A\\calibration.md'
  const spaced = 'resources/中文目录 空格/note.txt'
  const source = `来源：${relative}（项目资源）\n\n\`${absolute}\`\n\n\`${spaced}\`\n\n[来源](${relative})\n\n\`resources/unknown.md\`\n\n\`\`\`text\n${relative}\n\`\`\``
  const trees: Root[] = []
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: source,
      rehypePlugins: [
        rehypeScholarSeedDecorations({
          source,
          sourceMapped: true,
          evidence: [],
          answers: [],
          isSourceLink: (href) => [relative, absolute, spaced].includes(href),
        }),
        () => (tree: Root) => {
          trees.push(structuredClone(tree))
        },
      ],
    })
  )
  const tree = trees[0]
  assert.ok(tree)
  const links: Element[] = []
  const visit = (node: Root | RootContent): void => {
    if (node.type === 'element' && node.tagName === 'a') links.push(node)
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
  assert.deepEqual(
    links.map((link) => decodeURIComponent(String(link.properties.href))),
    [relative, absolute, spaced, relative]
  )
  const label = links[0].children[0]
  assert.equal(
    label.type === 'element' && label.properties.dataMdSourceStart,
    source.indexOf(relative)
  )
  assert.equal(
    source.slice(links[0].position?.start.offset, links[0].position?.end.offset),
    relative
  )
})

test('session file links accept only working-directory-relative paths', () => {
  assert.equal(relativeSessionFilePath('outputs/report.md'), 'outputs/report.md')
  assert.equal(relativeSessionFilePath('./outputs/report%20one.md'), 'outputs/report one.md')
  for (const href of [
    '',
    '/',
    '../secrets.txt',
    'outputs/../secrets.txt',
    'outputs//report.md',
    '/tmp/report.md',
    'C:\\report.md',
    '\\\\host\\report.md',
    'file:///tmp/report.md',
    'javascript:alert(1)',
    'https://example.com/report.md',
    '%2e%2e/secrets.txt',
    '%2ftmp/report.md',
    'outputs/%00report.md',
    '%invalid',
  ]) {
    assert.equal(relativeSessionFilePath(href), null, href)
  }
})

test('session file paths follow the session root platform separator', () => {
  assert.equal(
    absoluteSessionFilePath('/tmp/session', 'outputs/report.md'),
    '/tmp/session/outputs/report.md'
  )
  assert.equal(
    absoluteSessionFilePath('/tmp/session/', 'outputs/report.md'),
    '/tmp/session/outputs/report.md'
  )
  assert.equal(
    absoluteSessionFilePath('C:\\session', 'outputs/report.md'),
    'C:\\session\\outputs\\report.md'
  )
  assert.equal(
    absoluteSessionFilePath('C:\\session\\', 'outputs/report.md'),
    'C:\\session\\outputs\\report.md'
  )
})
test('user links preserve exact source and destinations without interpreting markup or activating unsafe schemes', () => {
  const source =
    '**说明**\n(https://example.com/a_(b)). https://example.com/?q=a%20b#c，后续文字\nfile:///private/data javascript:alert(1) https://'
  const fragments = messageLinks(source)
  assert.equal(fragments.map((fragment) => fragment.value).join(''), source)
  assert.deepEqual(
    fragments.flatMap((fragment) => (fragment.url ? [fragment.url] : [])),
    ['https://example.com/a_(b)', 'https://example.com/?q=a%20b#c']
  )
})
