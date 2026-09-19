import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionNode } from './model.ts'
import { searchSessionTitles } from './tree.ts'

function session(id: string, title: string, activityAt: number, patch: Partial<SessionNode> = {}): SessionNode {
  return {
    id,
    title,
    activityAt,
    createdAt: activityAt - 1,
    status: 'dormant',
    openable: true,
    ...patch
  }
}

test('searches titles recursively, de-duplicates sessions and sorts by last activity', () => {
  const newest = session('newest', '文献场景：全流程', 30)
  const older = session('older', '文献场景：钙钛矿湿度稳定性', 20)
  const duplicate = session('older', '文献场景：旧目录副本', 10)
  const container = session('container', '不应作为会话出现', 40, {
    container: true,
    openable: false,
    children: [older]
  })

  assert.deepEqual(
    searchSessionTitles([duplicate, container, newest], '文献场景').map((row) => row.id),
    ['newest', 'older']
  )
})

test('empty query shows the complete searchable list and no-match returns an empty result', () => {
  const rows = [
    session('visible', '日常场景 · 读文档出结论', 20),
    session('internal', 'serve:internal', 30),
    session('scheduled', '尚未就绪', 40, { openable: false })
  ]

  assert.deepEqual(searchSessionTitles(rows, '').map((row) => row.id), ['visible'])
  assert.deepEqual(searchSessionTitles(rows, '不存在'), [])
})
