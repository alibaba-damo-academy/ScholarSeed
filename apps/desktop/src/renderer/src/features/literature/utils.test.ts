import assert from 'node:assert/strict'
import test from 'node:test'

import type { LiteratureDeliveryChoice } from '../../contracts/literature.ts'
import { deliveryChoiceMatches, deliveryProjectMatches, resourceFolderNodes } from './utils.ts'

test('global delivery accepts an unbound conversation without weakening project isolation', () => {
  assert.equal(deliveryProjectMatches('', undefined, null), true)
  assert.equal(deliveryProjectMatches('', undefined, undefined), true)
  assert.equal(deliveryProjectMatches('project', 'project', '/project'), true)
  assert.equal(deliveryProjectMatches('other', 'project', '/project'), false)
  assert.equal(deliveryProjectMatches('project', undefined, null), false)
  assert.equal(deliveryProjectMatches('', 'project', '/project'), false)
  assert.equal(deliveryProjectMatches('', undefined, '/missing-project'), false)
})

test('version decisions belong to the recorded destination and library choices', () => {
  const recorded: LiteratureDeliveryChoice = {
    target: 'project',
    parent: '',
    ticket: '',
    add_to_library: true,
    collection_id: '',
  }
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded }), true)
  assert.equal(deliveryChoiceMatches(null, recorded), false)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, parent: 'another' }), false)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, project_id: 'another' }), false)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, add_to_library: false }), false)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, collection_id: 'new' }), false)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, target: 'directory' }), false)
})

test('reselecting a local directory requires fresh conflict verification', () => {
  const recorded: LiteratureDeliveryChoice = {
    target: 'directory',
    parent: '',
    ticket: 'original-ticket',
    add_to_library: false,
    collection_id: '',
  }
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded }), true)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, ticket: '' }), false)
  assert.equal(deliveryChoiceMatches(recorded, { ...recorded, ticket: 'fresh-ticket' }), false)
})

test('managed resource files at root do not invent a resources subfolder', () => {
  assert.deepEqual(
    resourceFolderNodes(
      [
        { path: 'resources/first.pdf', name: 'first.pdf', kind: 'file' },
        { path: 'resources/second.pdf', name: 'second.pdf', kind: 'file' },
        { path: 'root.pdf', name: 'root.pdf', kind: 'file' },
        { path: 'resources-other/file.pdf', name: 'file.pdf', kind: 'file' },
      ],
      'resources'
    ),
    []
  )
})

test('resource folder expansion uses root-relative paths and a parent boundary', () => {
  assert.deepEqual(
    resourceFolderNodes(
      [
        { path: 'resources/papers/theory/proof.pdf', name: 'proof.pdf', kind: 'file' },
        { path: 'resources/papers/report.pdf', name: 'report.pdf', kind: 'file' },
        { path: 'resources/papers-other/file.pdf', name: 'file.pdf', kind: 'file' },
      ],
      'resources',
      'papers'
    ),
    [{ path: 'papers/theory', name: 'theory', kind: 'dir' }]
  )
})

test('explicit directories and nested children are normalized, excluding files and links', () => {
  assert.deepEqual(
    resourceFolderNodes(
      [
        {
          path: 'resources/papers',
          name: 'papers',
          kind: 'dir',
          children: [
            { path: 'resources/papers/theory', name: 'theory', kind: 'dir', children: [] },
            { path: 'resources/papers/file.pdf', name: 'file.pdf', kind: 'file' },
            { path: 'resources/papers/external', name: 'external', kind: 'dir', origin: 'link' },
          ],
        },
        { path: 'resources/external', name: 'external', kind: 'dir', origin: 'link' },
      ],
      'resources'
    ),
    [
      {
        path: 'papers',
        name: 'papers',
        kind: 'dir',
        children: [{ path: 'papers/theory', name: 'theory', kind: 'dir', children: [] }],
      },
    ]
  )
})

test('legacy root preserves a genuine resources child instead of stripping its name', () => {
  assert.deepEqual(
    resourceFolderNodes(
      [
        { path: 'resources', name: 'resources', kind: 'dir', children: [] },
        { path: 'papers/file.pdf', name: 'file.pdf', kind: 'file' },
      ],
      ''
    ),
    [
      { path: 'resources', name: 'resources', kind: 'dir', children: [] },
      { path: 'papers', name: 'papers', kind: 'dir' },
    ]
  )
})

test('paged folders have stable resource-relative selection keys', () => {
  const first = resourceFolderNodes(
    [{ path: 'resources/papers/first.pdf', name: 'first.pdf', kind: 'file' }],
    'resources'
  )
  const next = resourceFolderNodes(
    [{ path: 'resources/papers/second.pdf', name: 'second.pdf', kind: 'file' }],
    'resources'
  )
  assert.equal(first[0].path, next[0].path)
  assert.equal(first[0].path, 'papers')
})
