import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adjacentLeaf,
  adjacentLeaves,
  firstLeaf,
  hasHorizontalSplit,
  initialLayout,
  moveTargets,
  placeTab,
  resizeSplit,
  type DockLayout,
  type DockNode
} from './layout.ts'

function layoutOf(node: DockNode): DockLayout {
  return {
    areas: {
      primary: node,
      secondary: { kind: 'leaf', id: 'secondary-root', tabIds: [], activeTabId: null }
    },
    areaRatio: 0.5
  }
}

function leaf(id: string): DockNode {
  return { kind: 'leaf', id, tabIds: [id], activeTabId: id }
}

function split(
  id: string,
  direction: 'horizontal' | 'vertical',
  first: DockNode,
  second: DockNode
): DockNode {
  return { kind: 'split', id, direction, ratio: 0.5, first, second }
}

test('horizontal split detection follows visible columns across dock areas', () => {
  assert.equal(hasHorizontalSplit(layoutOf(leaf('single'))), false)
  assert.equal(hasHorizontalSplit(layoutOf(split('rows', 'vertical', leaf('top'), leaf('bottom')))), false)
  assert.equal(hasHorizontalSplit(layoutOf(split('columns', 'horizontal', leaf('left'), leaf('right')))), true)

  const crossArea = layoutOf(leaf('left'))
  crossArea.areas.secondary = leaf('right')
  assert.equal(hasHorizontalSplit(crossArea), true)
})

test('splits are limited to two rows and columns and reject without losing tabs', () => {
  let layout = placeTab(initialLayout(), 'a', 'primary')
  layout = placeTab(layout, 'b', 'primary', firstLeaf(layout.areas.primary).id, 'right')
  const horizontal = layout.areas.primary
  assert.equal(horizontal.kind, 'split')
  if (horizontal.kind !== 'split') return
  assert.equal(placeTab(layout, 'c', 'primary', firstLeaf(horizontal.first).id, 'right'), layout)
  layout = placeTab(layout, 'c', 'primary', firstLeaf(horizontal.first).id, 'bottom')
  layout = placeTab(layout, 'd', 'primary', firstLeaf(horizontal.second).id, 'bottom')
  assert.equal(placeTab(layout, 'e', 'primary', firstLeaf(layout.areas.primary).id, 'bottom'), layout)
  assert.equal(placeTab(layout, 'e', 'secondary'), layout)
  const root = layout.areas.primary
  assert.equal(root.kind, 'split')
  if (root.kind !== 'split' || root.first.kind !== 'split' || root.second.kind !== 'split') return
  const resized = resizeSplit(layout, 'primary', root.first.id, 0.65).areas.primary
  assert.equal(resized.kind, 'split')
  if (resized.kind !== 'split' || resized.first.kind !== 'split' || resized.second.kind !== 'split') return
  assert.equal(resized.first.ratio, 0.65)
  assert.equal(resized.second.ratio, 0.65)
})

test('the secondary area counts as a column and disallows third columns', () => {
  let layout = placeTab(initialLayout(), 'a', 'primary')
  layout = placeTab(layout, 'b', 'secondary')
  assert.equal(placeTab(layout, 'c', 'primary', firstLeaf(layout.areas.primary).id, 'right'), layout)
  layout = placeTab(layout, 'c', 'primary', firstLeaf(layout.areas.primary).id, 'bottom')
  layout = placeTab(layout, 'd', 'secondary', firstLeaf(layout.areas.secondary).id, 'bottom')
  assert.equal(placeTab(layout, 'e', 'secondary', firstLeaf(layout.areas.secondary).id, 'bottom'), layout)
})

test('adjacent leaves follow the rendered grid across nested splits', () => {
  const paneIds = ['right-leaf', 'right-split', 'bottom-left-leaf', 'bottom-left-split', 'bottom-right-leaf', 'bottom-right-split']
  const nextPaneId = (): string => paneIds.shift() ?? 'unexpected-pane'
  let layout = placeTab(initialLayout(), 'top-left', 'primary')
  const left = firstLeaf(layout.areas.primary)
  layout = placeTab(layout, 'top-right', 'primary', left.id, 'right', nextPaneId)
  layout = placeTab(layout, 'bottom-left', 'primary', left.id, 'bottom', nextPaneId)
  layout = placeTab(layout, 'bottom-right', 'primary', 'right-leaf', 'bottom', nextPaneId)

  assert.equal(adjacentLeaf(layout, 'primary', left.id, 'right')?.leaf.id, 'right-leaf')
  assert.equal(adjacentLeaf(layout, 'primary', left.id, 'bottom')?.leaf.id, 'bottom-left-leaf')
  assert.equal(adjacentLeaf(layout, 'primary', 'bottom-left-leaf', 'right')?.leaf.id, 'bottom-right-leaf')
  assert.equal(adjacentLeaf(layout, 'primary', 'right-leaf', 'bottom')?.leaf.id, 'bottom-right-leaf')
  assert.equal(adjacentLeaf(layout, 'primary', 'right-leaf', 'right'), null)
  assert.equal(adjacentLeaf(layout, 'primary', 'bottom-right-leaf', 'bottom'), null)
})

test('adjacent leaves cross area boundaries when both areas are visible', () => {
  let layout = placeTab(initialLayout(), 'left', 'primary')
  layout = placeTab(layout, 'right', 'secondary')

  assert.equal(adjacentLeaf(layout, 'primary', 'primary-root', 'right')?.area, 'secondary')
  assert.equal(adjacentLeaf(layout, 'primary', 'primary-root', 'right')?.leaf.id, 'secondary-root')
})

test('four-pane move targets expose the two direct cardinal neighbors for every corner', () => {
  const layout = layoutOf(split(
    'columns',
    'horizontal',
    split('left-column', 'vertical', leaf('top-left'), leaf('bottom-left')),
    split('right-column', 'vertical', leaf('top-right'), leaf('bottom-right'))
  ))

  assert.deepEqual(moveTargets(layout, 'primary', 'top-left').map(({ leaf: target, position }) => [target.id, position]), [
    ['top-right', 'right'],
    ['bottom-left', 'bottom']
  ])
  assert.deepEqual(moveTargets(layout, 'primary', 'top-right').map(({ leaf: target, position }) => [target.id, position]), [
    ['top-left', 'left'],
    ['bottom-right', 'bottom']
  ])
  assert.deepEqual(moveTargets(layout, 'primary', 'bottom-left').map(({ leaf: target, position }) => [target.id, position]), [
    ['bottom-right', 'right'],
    ['top-left', 'top']
  ])
  assert.deepEqual(moveTargets(layout, 'primary', 'bottom-right').map(({ leaf: target, position }) => [target.id, position]), [
    ['bottom-left', 'left'],
    ['top-right', 'top']
  ])
})

test('T-shaped layouts name both candidates by their precise corner', () => {
  const leftFull = layoutOf(split(
    'columns',
    'horizontal',
    leaf('left'),
    split('right-column', 'vertical', leaf('top-right'), leaf('bottom-right'))
  ))
  assert.deepEqual(adjacentLeaves(leftFull, 'primary', 'left', 'right').map(({ leaf: target, position }) => [target.id, position]), [
    ['top-right', 'rightTop'],
    ['bottom-right', 'rightBottom']
  ])
  assert.deepEqual(moveTargets(leftFull, 'primary', 'top-right').map(({ leaf: target, position }) => [target.id, position]), [
    ['left', 'left'],
    ['bottom-right', 'bottom']
  ])

  const rightFull = layoutOf(split(
    'columns',
    'horizontal',
    split('left-column', 'vertical', leaf('top-left'), leaf('bottom-left')),
    leaf('right')
  ))
  assert.deepEqual(adjacentLeaves(rightFull, 'primary', 'right', 'left').map(({ leaf: target, position }) => [target.id, position]), [
    ['top-left', 'leftTop'],
    ['bottom-left', 'leftBottom']
  ])

  const topFull = layoutOf(split(
    'rows',
    'vertical',
    leaf('top'),
    split('bottom-row', 'horizontal', leaf('bottom-left'), leaf('bottom-right'))
  ))
  assert.deepEqual(adjacentLeaves(topFull, 'primary', 'top', 'bottom').map(({ leaf: target, position }) => [target.id, position]), [
    ['bottom-left', 'bottomLeft'],
    ['bottom-right', 'bottomRight']
  ])

  const bottomFull = layoutOf(split(
    'rows',
    'vertical',
    split('top-row', 'horizontal', leaf('top-left'), leaf('top-right')),
    leaf('bottom')
  ))
  assert.deepEqual(adjacentLeaves(bottomFull, 'primary', 'bottom', 'top').map(({ leaf: target, position }) => [target.id, position]), [
    ['top-left', 'topLeft'],
    ['top-right', 'topRight']
  ])
})
