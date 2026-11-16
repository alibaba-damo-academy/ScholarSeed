import assert from 'node:assert/strict'
import test from 'node:test'
import { partitionComposerReferences, reconcileReferenceOrder } from './reference.ts'

test('inline conversation references and attachment cards retain independent insertion order', () => {
  const references = [
    { key: 'note', inline: false },
    { key: 'session', inline: true },
    { key: 'image', inline: false },
    { key: 'skill', inline: true },
    { key: 'file', inline: false },
    { key: 'selection', inline: false },
  ]
  const order = ['skill', 'file', 'session', 'image', 'note', 'selection']
  const groups = partitionComposerReferences(references, order)
  assert.deepEqual(
    groups.inline.map((reference) => reference.key),
    ['skill', 'session']
  )
  assert.deepEqual(
    groups.attachments.map((reference) => reference.key),
    ['file', 'image', 'note', 'selection']
  )
  const removed = reconcileReferenceOrder(
    order,
    order.filter((key) => key !== 'skill')
  )
  const readded = reconcileReferenceOrder(
    removed,
    references.map((reference) => reference.key)
  )
  assert.deepEqual(
    partitionComposerReferences(references, readded).inline.map((reference) => reference.key),
    ['session', 'skill']
  )
  assert.deepEqual(
    references.map((reference) => reference.key),
    ['note', 'session', 'image', 'skill', 'file', 'selection']
  )
})

test('references retain insertion order across source groups', () => {
  let order = reconcileReferenceOrder([], ['skill:first'])
  order = reconcileReferenceOrder(order, ['session:first', 'skill:first'])
  order = reconcileReferenceOrder(order, ['session:first', 'skill:first', 'skill:second'])
  order = reconcileReferenceOrder(order, [
    'session:first',
    'session:second',
    'skill:first',
    'skill:second',
  ])
  assert.deepEqual(order, ['skill:first', 'session:first', 'skill:second', 'session:second'])
})

test('removed references lose their position and re-added references append', () => {
  const order = reconcileReferenceOrder(['skill:first', 'session:first'], ['session:first'])
  assert.deepEqual(reconcileReferenceOrder(order, ['session:first', 'skill:first']), [
    'session:first',
    'skill:first',
  ])
  assert.deepEqual(reconcileReferenceOrder(order, []), [])
})

test('refreshes preserve order and replace content without duplicate keys', () => {
  const order = ['skill:first', 'session:first']
  assert.deepEqual(reconcileReferenceOrder(order, ['session:first', 'skill:first']), order)
  assert.deepEqual(reconcileReferenceOrder([], ['session:first', 'skill:first']), [
    'session:first',
    'skill:first',
  ])
})
