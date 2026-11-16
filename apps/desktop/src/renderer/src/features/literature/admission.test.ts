import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'

import tasksZh from '../../../../localization/locales/zh/tasks.json' with { type: 'json' }
import type { LiteratureSearchPaper } from '../../contracts/literature'
import type { ProductTask } from '../../contracts/tasks'
import { TaskFeed } from '../../components/business/taskfeed.ts'
import { literatureJoinTasks, runLiteratureJoinTask } from './admission.ts'
import type { HeldAttachmentOutcome } from './api.ts'
import { joinWithScope, type HeldFulltextJoin } from './join.ts'

function paper(title: string, id = title.toLowerCase()): LiteratureSearchPaper {
  return { title, paper_id: id, access: 'open' } as LiteratureSearchPaper
}

test('batch join publishes real progress and a partial result even when the feed reopens', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    resources: { zh: { tasks: tasksZh } },
    interpolation: { escapeValue: false },
  })
  const t = locale.getFixedT('zh', 'tasks')
  const admit = Promise.withResolvers<string[]>()
  const attach = Promise.withResolvers<HeldAttachmentOutcome>()
  const snapshots: ProductTask[] = []
  const unsubscribe = literatureJoinTasks.subscribe!((task) => snapshots.push(task))
  const selected = [paper('First', 'first'), paper('Metadata only', 'metadata'), paper('Third', 'third')]
  const destination = { projectId: 'project-a', collectionId: 'collection-a', path: ['Reading'] }
  const fulltext: HeldFulltextJoin = {
    source: { sessionId: 'session-a', cardId: 'card-a' },
    paperIds: ['first', 'third'],
  }
  try {
    const operation = runLiteratureJoinTask(
      selected,
      'fulltext',
      destination,
      'Project A',
      fulltext,
      (report) =>
        joinWithScope(
          selected,
          'fulltext',
          destination,
          destination.projectId,
          fulltext,
          () => admit.promise,
          () => attach.promise,
          report
        )
    )
    assert.equal(snapshots[0].status, 'running')
    assert.equal(snapshots[0].projectId, 'project-a')
    assert.equal(snapshots[0].totalItems, 2)
    assert.equal(snapshots[0].completedItems, 0)
    admit.resolve(['first', 'metadata', 'third'])
    await Promise.resolve()
    attach.resolve({
      items: [
        { paper_id: 'first', literature_id: 'first', storage: 'managed', attached: true, fulltext: true, code: '' },
        { paper_id: 'third', literature_id: 'third', storage: 'managed', attached: false, fulltext: false, code: 'held_fulltext_unreadable' },
      ],
      acquired: 1,
      fulltext: 1,
      failed: 1,
    })
    assert.deepEqual(await operation, {
      ids: ['first', 'metadata', 'third'],
      fulltext: 1,
      fulltextFailed: 1,
    })
    const halfway = snapshots.find((task) => task.completedItems === 1)
    assert.deepEqual(halfway && literatureJoinTasks.present(halfway, t).progress, {
      determinate: true,
      value: 50,
      label: '已处理全文 1/2 篇',
    })
    const terminal = snapshots.at(-1)!
    assert.equal(terminal.status, 'partial')
    assert.equal(terminal.completedItems, 2)
    assert.deepEqual(literatureJoinTasks.present(terminal, t).row, {
      summary: '已加入 3/3 篇 · 其中 1 篇含全文，1 篇未附上',
      context: '元信息和全文 · 目标：Project A / Reading',
      sourceListLabel: '论文清单（3 篇）',
    })
    assert.deepEqual(
      terminal.outcome.results.map(({ name, status }) => [name, status]),
      [
        ['First', 'succeeded'],
        ['Third', 'failed'],
      ]
    )
    assert.ok(snapshots.every((task, index) => task.eventSeq === index + 1))

    let restored: ProductTask[] = []
    const feed = new TaskFeed(
      [literatureJoinTasks],
      (tasks) => {
        restored = tasks
      },
      () => {
        assert.fail('opening a feed must not announce a historical result')
      }
    )
    feed.start()
    await feed.refresh()
    assert.equal(
      restored.find((task) => task.id === terminal.id),
      terminal
    )
    feed.stop()
  } finally {
    unsubscribe()
  }
})

test('metadata-only admission reports its terminal state without exposing unsafe retries', async () => {
  assert.equal(literatureJoinTasks.retry, undefined)
  assert.equal(literatureJoinTasks.cancel, undefined)
  const rejected = new Error('request failed')
  await assert.rejects(
    runLiteratureJoinTask(
      [paper('Rejected')],
      'metadata',
      { path: [] },
      '',
      undefined,
      async () => {
        throw rejected
      }
    ),
    rejected
  )
  assert.equal(
    (await literatureJoinTasks.list()).find((task) => task.sourceNames.includes('Rejected'))
      ?.status,
    'failed'
  )

  const selected = [paper('Accepted')]
  const destination = { path: [] }
  await runLiteratureJoinTask(selected, 'metadata', destination, '', undefined, (report) =>
    joinWithScope(
      selected,
      'metadata',
      destination,
      undefined,
      undefined,
      async () => ['accepted'],
      undefined,
      report
    )
  )
  const accepted = (await literatureJoinTasks.list()).find((task) =>
    task.sourceNames.includes('Accepted')
  )
  assert.equal(accepted?.status, 'completed')
  assert.equal(accepted?.totalItems, 0)
})
