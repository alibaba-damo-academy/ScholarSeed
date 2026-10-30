import assert from 'node:assert/strict'
import test from 'node:test'
import { Clock, Container, Ctx } from '@milkdown/kit/ctx'
import { editorViewCtx, schemaCtx } from '@milkdown/kit/core'
import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip'
import { linkAttr } from '@milkdown/kit/preset/commonmark'
import { Schema, type Mark } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { configureCitationLinks, editDocumentLink, projectNumericCitations } from './citations.ts'

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  marks: { link: { attrs: { href: {}, title: { default: null } } }, strong: {} },
})

test('plain numeric citations link to matching bibliography entries without changing source', () => {
  const source = [
    '# Research review',
    '正文[1]，以及组合引用[3,4]。`代码[1]` 和已有链接 [[1]](#existing) 不应改变。',
    '',
    '## 参考文献',
    '[1] First paper.',
    '',
    '[3] Third paper.',
    '',
    '[4] Fourth paper.',
  ].join('\n')
  const tree = unified().use(remarkParse).parse(source)
  projectNumericCitations(tree)
  const paragraph = tree.children[1]
  assert.equal(paragraph.type, 'paragraph')
  assert.deepEqual(
    paragraph.children.filter((child) => child.type === 'link').map((child) => child.url),
    ['#ref-1', '#ref-3', '#ref-4', '#existing']
  )
  assert.equal(tree.children.some((child) => child.type === 'html'), false)
  assert.equal(paragraph.children.find((child) => child.type === 'inlineCode')?.value, '代码[1]')
  assert.equal(source.includes('](#ref-1)'), false)
})

test('unmatched numbers and documents without a bibliography remain ordinary text', () => {
  for (const source of ['正文[1]。', '正文[2]。\n\n## References\n\n[1] First paper.']) {
    const tree = unified().use(remarkParse).parse(source)
    projectNumericCitations(tree)
    assert.equal(tree.children[0].type, 'paragraph')
    assert.equal(tree.children[0].children.some((child) => child.type === 'link'), false)
    assert.equal(tree.children.some((child) => child.type === 'html'), false)
  }
})

test('link projection keeps original citation and fragment URLs outside the sanitized href', () => {
  const ctx = new Ctx(new Container(), new Clock())
  ctx.inject(linkAttr.key, () => ({ rel: 'noopener' }))
  configureCitationLinks(ctx)
  for (const href of [
    'https://example.org',
    'scholarseed-cite:receipt',
    '#ref',
    'javascript:alert(1)',
  ]) {
    const mark = schema.marks.link.create({ href, title: 'Original title' })
    assert.deepEqual(ctx.get(linkAttr.key)(mark), {
      rel: 'noopener',
      'data-document-link': href,
      contenteditable: 'false',
      tabindex: 0,
    })
    assert.deepEqual({ ...mark.attrs }, { href, title: 'Original title' })
  }
})

test('link editing spans formatting boundaries and preserves the original target', () => {
  const mark = schema.marks.link.create({ href: 'https://example.org/paper' })
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('pre '),
      schema.text('one', [mark]),
      schema.text('two', [mark, schema.marks.strong.create()]),
      schema.text(' after'),
    ]),
  ])
  for (const position of [5, 6, 8, 10, 11]) {
    const ctx = new Ctx(new Container(), new Clock())
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, position) })
    ctx.inject(schemaCtx, schema).inject(editorViewCtx, { state } as EditorView)
    const edited: Array<{ mark: Mark; from: number; to: number }> = []
    ctx.inject(linkTooltipAPI.key, {
      addLink: () => {
        throw new Error('existing links must not be removed or replaced')
      },
      removeLink: () => {
        throw new Error('editing does not delete the mark')
      },
      editLink: (selectedMark, from, to) => {
        edited.push({ mark: selectedMark, from, to })
      },
    })
    editDocumentLink(ctx)
    assert.deepEqual(edited, [{ mark, from: 5, to: 11 }])
  }
})

test('toolbar can add a link to ordinary selected text', () => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('ordinary text')]),
  ])
  const ctx = new Ctx(new Container(), new Clock())
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 9) })
  ctx.inject(schemaCtx, schema).inject(editorViewCtx, { state } as EditorView)
  const added: number[][] = []
  ctx.inject(linkTooltipAPI.key, {
    addLink: (from, to) => {
      added.push([from, to])
    },
    editLink: () => {
      throw new Error('ordinary text has no link')
    },
    removeLink: () => {
      throw new Error('ordinary text has no link')
    },
  })
  editDocumentLink(ctx)
  assert.deepEqual(added, [[1, 9]])
})
