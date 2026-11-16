import assert from 'node:assert/strict'
import test from 'node:test'
import type { Element, Root } from 'hast'
import {
  CITATION_GROUP,
  CITATION_GROUP_HIDDEN,
  CITATION_MARKER,
  groupParagraphCitations,
} from './citations.ts'

function citation(href: string, offset: number): Element {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href, [CITATION_MARKER]: true },
    children: [{ type: 'text', value: href }],
    position: {
      start: { line: 1, column: offset + 1, offset },
      end: { line: 1, column: offset + 2, offset: offset + 1 },
    },
  }
}

test('groups the same type across intervening prose and other types, but never across paragraphs', () => {
  const first = citation('first', 0)
  const library = citation('library', 5)
  const second = citation('second', 10)
  const next = citation('second', 20)
  const web = citation('web', 25)
  const tree: Root = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [
          first,
          { type: 'text', value: '正文保留' },
          library,
          { type: 'element', tagName: 'strong', properties: {}, children: [second] },
        ],
      },
      { type: 'element', tagName: 'p', properties: {}, children: [next, web] },
    ],
  }
  groupParagraphCitations(tree, { first: 'file', second: 'file', library: 'literature' })
  assert.deepEqual(
    JSON.parse(String(first.properties[CITATION_GROUP])).map(
      (entry: { href: string }) => entry.href
    ),
    ['first', 'second']
  )
  assert.equal(second.properties[CITATION_GROUP_HIDDEN], true)
  assert.equal(library.properties[CITATION_GROUP_HIDDEN], undefined)
  assert.deepEqual(JSON.parse(String(library.properties[CITATION_GROUP])), [
    { href: 'library', start: 5, end: 6, label: 'library' },
  ])
  assert.deepEqual(JSON.parse(String(next.properties[CITATION_GROUP])), [
    { href: 'second', start: 20, end: 21, label: 'second' },
  ])
  assert.equal(next.properties[CITATION_GROUP_HIDDEN], undefined)
  assert.equal(web.properties[CITATION_GROUP], undefined)
  assert.equal(web.properties[CITATION_GROUP_HIDDEN], undefined)
  assert.equal((tree.children[0] as Element).children[1].type, 'text')
})

test('tight list items group their own citations without collecting nested blocks or siblings', () => {
  const first = citation('web', 0)
  const second = citation('web', 5)
  const nested = citation('web', 10)
  const sibling = citation('web', 15)
  const block = (tagName: string, children: Element[]): Element => ({
    type: 'element',
    tagName,
    properties: {},
    children,
  })
  const tree: Root = {
    type: 'root',
    children: [
      block('ul', [
        block('li', [first, second, block('ul', [block('li', [nested])])]),
        block('li', [sibling]),
      ]),
    ],
  }
  groupParagraphCitations(tree, { web: 'searched' })
  assert.equal(JSON.parse(String(first.properties[CITATION_GROUP])).length, 2)
  assert.equal(second.properties[CITATION_GROUP_HIDDEN], true)
  for (const independent of [nested, sibling]) {
    assert.equal(JSON.parse(String(independent.properties[CITATION_GROUP])).length, 1)
    assert.equal(independent.properties[CITATION_GROUP_HIDDEN], undefined)
  }
})

test('unverified links and citations without source positions remain independent', () => {
  const first = citation('first', 0)
  const ordinary = citation('ordinary', 5)
  delete ordinary.properties[CITATION_MARKER]
  const unpositioned = citation('unpositioned', 10)
  delete unpositioned.position
  const tree: Root = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', properties: {}, children: [first, ordinary, unpositioned] },
    ],
  }
  groupParagraphCitations(tree, { first: 'file', ordinary: 'file', unpositioned: 'file' })
  assert.deepEqual(JSON.parse(String(first.properties[CITATION_GROUP])), [
    { href: 'first', start: 0, end: 1, label: 'first' },
  ])
  assert.equal(ordinary.properties[CITATION_GROUP], undefined)
  assert.equal(unpositioned.properties[CITATION_GROUP], undefined)
})
