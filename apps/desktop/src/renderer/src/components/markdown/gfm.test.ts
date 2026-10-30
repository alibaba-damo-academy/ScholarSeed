import assert from 'node:assert/strict'
import test from 'node:test'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'
import { unified } from 'unified'
import { VFile } from 'vfile'

import { GFM_PLUGIN } from './gfm.ts'

async function renderTree(source: string): Promise<Root> {
  const processor = unified().use(remarkParse).use(GFM_PLUGIN[0], GFM_PLUGIN[1])
  const file = new VFile(source)
  const tree = await processor.run(processor.parse(file), file)
  assert.equal(String(file), source)
  return tree
}

function nodes(tree: Root, type: RootContent['type']): RootContent[] {
  const matches: RootContent[] = []
  const visit = (node: Root | RootContent): void => {
    if (node.type === type) matches.push(node as RootContent)
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
  return matches
}

function visibleText(tree: Root): string {
  return nodes(tree, 'text')
    .map((node) => (node.type === 'text' ? node.value : ''))
    .join('')
}

test('bare URL boundaries preserve punctuation and following prose without changing source', async () => {
  for (const suffix of ['）。', '，后续正文', '。下一句', '）中文']) {
    const url = 'https://arxiv.org/abs/2411.15114'
    const source = `（来源：${url}${suffix}`
    const tree = await renderTree(source)
    const links = nodes(tree, 'link')
    assert.equal(links.length, 1)
    assert.equal(links[0].type === 'link' && links[0].url, url)
    assert.equal(visibleText(tree), source)
    const paragraph = tree.children[0]
    assert.equal(paragraph.type, 'paragraph')
    if (paragraph.type !== 'paragraph') continue
    const link = paragraph.children[1]
    const trailing = paragraph.children[2]
    assert.equal(link.type, 'link')
    assert.equal(trailing.type, 'text')
    if (link.type !== 'link' || trailing.type !== 'text') continue
    assert.equal(trailing.value, suffix)
    const boundary = source.indexOf(url) + url.length
    assert.equal(link.position?.end.offset, boundary)
    assert.equal(link.children[0].position?.end.offset, boundary)
    assert.equal(trailing.position?.start.offset, boundary)
    assert.equal(trailing.position?.end.offset, source.length)
  }
})

test('bare URL boundaries preserve Chinese paths, queries, balanced ASCII parentheses and encoding', async () => {
  for (const url of [
    'https://example.com/中文路径?q=科研',
    'https://en.wikipedia.org/wiki/Foo_(bar)',
    'https://example.com/x%EF%BC%89%E3%80%82',
  ]) {
    const tree = await renderTree(`${url}）。`)
    const link = nodes(tree, 'link')[0]
    assert.equal(link.type === 'link' && link.url, url)
    assert.equal(visibleText(tree), `${url}）。`)
  }
})

test('explicit and reference links remain unchanged even when their labels equal their URLs', async () => {
  const url = 'https://example.com/条目）。'
  for (const source of [`[${url}](${url})`, `<${url}>`, `[${url}][ref]\n\n[ref]: ${url}`]) {
    const tree = await renderTree(source)
    const link = nodes(tree, 'link')[0]
    if (link) assert.equal(link.type === 'link' && link.url, url)
    else assert.equal(nodes(tree, 'linkReference').length, 1)
    assert.equal(visibleText(tree), url)
  }
})

test('www autolinks split while email, images and code stay untouched', async () => {
  const tree = await renderTree(
    'www.example.com/中文）。 user@example.com ![图](https://example.com/x）。) `https://example.com/x）。`'
  )
  const links = nodes(tree, 'link')
  assert.deepEqual(
    links.map((node) => (node.type === 'link' ? node.url : '')),
    ['http://www.example.com/中文', 'mailto:user@example.com']
  )
  const image = nodes(tree, 'image')[0]
  assert.equal(image.type === 'image' && image.url, 'https://example.com/x）。')
  const code = nodes(tree, 'inlineCode')[0]
  assert.equal(code.type === 'inlineCode' && code.value, 'https://example.com/x）。')
})

test('source offsets account for CRLF, astral characters and character references', async () => {
  const source = '第一段\r\n\r\n😀 https://example.com/中文?q=a&amp;b=2）。'
  const tree = await renderTree(source)
  const link = nodes(tree, 'link')[0]
  assert.equal(link.type, 'link')
  if (link.type !== 'link') return
  assert.equal(link.url, 'https://example.com/中文?q=a&amp;b=2')
  const boundary = source.indexOf('）')
  assert.deepEqual(link.position?.end, {
    line: 3,
    column: boundary - source.lastIndexOf('\n'),
    offset: boundary,
  })
  const trailing = nodes(tree, 'text').find((node) => node.type === 'text' && node.value === '）。')
  assert.equal(trailing?.position?.start.offset, boundary)
  assert.equal(link.children[0].position?.end.offset, boundary)
})

test('bare URLs exclude adjacent numeric citations and preserve text and source positions', async () => {
  for (const url of ['https://aclanthology.org/2024.eacl-demo.16/', 'www.example.com/paper']) {
    for (const suffix of ['[3]', '[12][3]', '[3', '[12', '[3]。后文']) {
      const source = `出版方： ${url}${suffix}`
      const tree = await renderTree(source)
      const link = nodes(tree, 'link')[0]
      assert.equal(link.type, 'link')
      if (link.type !== 'link') continue
      assert.equal(link.url, url.startsWith('www.') ? `http://${url}` : url, source)
      assert.equal(visibleText(tree), source)
      const boundary = source.indexOf(url) + url.length
      assert.equal(link.position?.end.offset, boundary)
      assert.equal(link.children[0].position?.end.offset, boundary)
      const paragraph = tree.children[0]
      assert.equal(paragraph.type, 'paragraph')
      if (paragraph.type !== 'paragraph') continue
      const trailing = paragraph.children[2]
      assert.equal(trailing.type, 'text')
      assert.equal(trailing.position?.start.offset, boundary)
    }
  }
})

test('citation boundaries leave explicit links, encoded brackets and nonnumeric brackets unchanged', async () => {
  const url = 'https://example.com/paper[3]'
  for (const source of [`[${url}](${url})`, `<${url}>`, `[${url}][ref]\n\n[ref]: ${url}`]) {
    const tree = await renderTree(source)
    const link = nodes(tree, 'link')[0]
    if (link) assert.equal(link.type === 'link' && link.url, url)
    else assert.equal(nodes(tree, 'linkReference').length, 1)
    assert.equal(visibleText(tree), url)
  }
  for (const target of [
    'https://example.com/paper%5B3%5D',
    'https://example.com/paper[appendix]/text',
    'https://example.com/?filter[year]=2024',
    'https://example.com/?filter[3]=2024',
    'https://example.com/paper[3]/text',
    'https://example.com/paper[3abc]/text',
  ]) {
    const tree = await renderTree(target)
    const link = nodes(tree, 'link')[0]
    assert.equal(link.type === 'link' && link.url, target)
    assert.equal(visibleText(tree), target)
  }
})

test('GFM preserves single-tilde ranges and retains double-tilde deletion', () => {
  const tree = unified()
    .use(remarkParse)
    .use(GFM_PLUGIN[0], GFM_PLUGIN[1])
    .parse('气温 24~33℃，~~旧值~~。')
  const paragraph = tree.children[0]
  assert.equal(paragraph.type, 'paragraph')
  if (paragraph.type !== 'paragraph') return
  const range = paragraph.children[0]
  assert.equal(range?.type, 'text')
  if (range?.type !== 'text') return
  assert.equal(range.value, '气温 24~33℃，')
  const deletion = paragraph.children[1]
  assert.equal(deletion?.type, 'delete')
  if (deletion?.type !== 'delete') return
  const deletedText = deletion.children[0]
  assert.equal(deletedText?.type, 'text')
  if (deletedText?.type !== 'text') return
  assert.equal(deletedText.value, '旧值')
  const suffix = paragraph.children[2]
  assert.equal(suffix?.type, 'text')
  if (suffix?.type !== 'text') return
  assert.equal(suffix.value, '。')
})
