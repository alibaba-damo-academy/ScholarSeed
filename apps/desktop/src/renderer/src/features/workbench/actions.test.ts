import assert from 'node:assert/strict'
import test from 'node:test'

import { SelectionActionRegistry, selectionReplacementFor } from './actions.ts'

test('selection action contributions stay tab-scoped, ordered and disposable', () => {
  const registry = new SelectionActionRegistry()
  const changes: number[] = []
  const unsubscribe = registry.subscribe(() => changes.push(changes.length + 1))
  const dismissals: string[] = []

  const removeLater = registry.register('tab-a', {
    actions: 'later',
    dismiss: () => dismissals.push('later'),
    expanded: false,
    id: 'later',
    order: 20
  })
  const removeFirst = registry.register('tab-a', {
    actions: 'first',
    dismiss: () => dismissals.push('first'),
    expanded: true,
    id: 'first',
    order: 10,
    panel: 'panel'
  })
  registry.register('tab-b', {
    actions: 'other-tab',
    dismiss: () => dismissals.push('other-tab'),
    expanded: false,
    id: 'other-tab',
    order: 0
  })

  assert.deepEqual(registry.get('tab-a').map((item) => item.id), ['first', 'later'])
  assert.equal(registry.get('tab-a')[0]?.panel, 'panel')
  assert.deepEqual(registry.get('tab-b').map((item) => item.id), ['other-tab'])

  registry.dismiss('tab-a')
  assert.deepEqual(dismissals, ['first', 'later'])

  removeFirst()
  assert.deepEqual(registry.get('tab-a').map((item) => item.id), ['later'])
  removeLater()
  assert.deepEqual(registry.get('tab-a'), [])
  assert.equal(changes.length, 5)

  unsubscribe()
})

test('re-registering one contribution updates it without disturbing sibling order', () => {
  const registry = new SelectionActionRegistry()
  const remove = registry.register('tab', {
    actions: 'old', expanded: false, id: 'format', order: 20
  })
  registry.register('tab', {
    actions: 'copy', expanded: false, id: 'copy', order: 30
  })

  registry.update('tab', 'format', {
    actions: 'new', expanded: true, id: 'format', order: 10, panel: 'format-panel'
  })

  assert.deepEqual(registry.get('tab').map((item) => [item.id, item.actions]), [
    ['format', 'new'],
    ['copy', 'copy']
  ])
  assert.equal(registry.get('tab')[0]?.expanded, true)
  remove()
})

test('replacement capability is resolved from the focused tab contribution only', async () => {
  const registry = new SelectionActionRegistry()
  const replaceSelection = async () => ({ ok: true as const })
  registry.register('tab-a', {
    actions: null,
    expanded: false,
    id: 'markdown-replacement',
    order: 30,
    replaceSelection
  })
  registry.register('tab-b', {
    actions: null,
    expanded: false,
    id: 'other-replacement',
    order: 30,
    replaceSelection: async () => ({ ok: false as const, error: 'selection_changed' as const })
  })

  assert.equal(selectionReplacementFor(registry.get('tab-a')), replaceSelection)
  assert.equal(selectionReplacementFor(registry.get('missing')), null)
})
