import type { TaskSourceContribution } from '../../contracts/features'
import type { LiteratureSearchPaper } from '../../contracts/literature'
import { taskTitleText, type ProductTask, type ProductTaskResult } from '../../contracts/tasks.ts'
import type { JoinDestination } from './hierarchy'
import {
  joinWithScope,
  type HeldFulltextJoin,
  type JoinProgress,
  type JoinScope,
  type JoinScopeOutcome,
} from './join.ts'

const SOURCE_ID = 'literature-joins'
const PHASE = { admitting: 'admitting', fulltext: 'fulltext' } as const
const ERROR = { admission: 'admission_unconfirmed', fulltext: 'fulltext_failed' } as const
const MILLISECONDS_PER_SECOND = 1_000
const PERCENT_MAX = 100

type JoinRecord = {
  task: ProductTask
  category: string
  projectName: string
  admitted: number
}

const records = new Map<string, JoinRecord>()
const listeners = new Set<(task: ProductTask) => void>()

export const literatureJoinTasks: TaskSourceContribution = {
  id: SOURCE_ID,
  list: async () => [...records.values()].map(({ task }) => task),
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  present(task, t) {
    const record = records.get(task.id)
    const scope = task.operation === 'fulltext' ? 'fulltext' : 'metadata'
    const library =
      record?.projectName || t(task.projectId ? 'literatureJoin.project' : 'literatureJoin.library')
    const target = record?.category ? [library, record.category].join(' / ') : library
    const description = t('literatureJoin.destination', {
      method: t(scope === 'fulltext' ? 'literatureJoin.fulltext' : 'literatureJoin.metadata'),
      target,
    })
    const admitted = t('literatureJoin.admitted', {
      completed: record?.admitted ?? 0,
      total: task.sourceNames.length,
    })
    const acquired =
      scope === 'fulltext' && task.status !== 'failed' && task.phase === PHASE.fulltext
        ? t('literatureJoin.acquired', {
            succeeded: task.outcome.succeeded,
            failed: task.outcome.failed,
          })
        : ''
    const error = task.error === ERROR.admission ? t('literatureJoin.admissionUnconfirmed') : ''
    const summary = error || [admitted, acquired].filter(Boolean).join(' · ')
    const detail = error ? description : [description, summary].join(' · ')
    return {
      title: taskTitleText(task.title, t),
      detail,
      row: {
        summary,
        context: description,
        sourceListLabel: t('literatureJoin.paperList', { count: task.sourceNames.length }),
      },
      announcement: detail,
      error,
      failures: task.outcome.results
        .filter((result) => result.status === 'failed')
        .map(({ name }) => ({ name, reason: t('literatureJoin.fulltextFailed') })),
      progress:
        task.status !== 'running'
          ? undefined
          : task.phase === PHASE.fulltext && task.totalItems > 0
            ? {
                determinate: true,
                value: (task.completedItems / task.totalItems) * PERCENT_MAX,
                label: t('literatureJoin.progress', {
                  completed: task.completedItems,
                  total: task.totalItems,
                }),
              }
            : { determinate: false, value: 0, label: t('literatureJoin.admitting') },
    }
  },
}

export async function runLiteratureJoinTask(
  papers: LiteratureSearchPaper[],
  scope: JoinScope,
  destination: JoinDestination,
  projectName: string,
  fulltext?: HeldFulltextJoin,
  execute = (report: (progress: JoinProgress) => void) =>
    joinWithScope(
      papers,
      scope,
      destination,
      destination.projectId,
      fulltext,
      undefined,
      undefined,
      report
    )
): Promise<JoinScopeOutcome> {
  const id = crypto.randomUUID()
  const createdAt = Date.now() / MILLISECONDS_PER_SECOND
  const sourceNames = papers.map((paper) => paper.title)
  const category = destination.path.join(' / ')
  let admitted = 0
  const heldIds = new Set(fulltext?.paperIds ?? [])
  let results: ProductTaskResult[] =
    scope === 'fulltext'
      ? papers.flatMap((paper, index) =>
          heldIds.has(paper.paper_id)
            ? [{ index, name: paper.title, status: 'pending', error: '', retryable: false }]
            : []
        )
      : []
  let eventSeq = 0
  let phase: ProductTask['phase'] = PHASE.admitting
  const publish = (status: ProductTask['status'], error = ''): void => {
    const succeeded = results.filter((result) => result.status === 'succeeded').length
    const failed = results.filter((result) => result.status === 'failed').length
    const task: ProductTask = {
      id,
      sourceId: SOURCE_ID,
      projectId: destination.projectId ?? '',
      operation: scope,
      title: { key: 'title.literatureJoin', names: [] },
      detail: '',
      sourceNames,
      status,
      phase,
      discoveredItems: papers.length,
      completedItems: succeeded + failed,
      totalItems: results.length,
      completedBytes: 0,
      totalBytes: 0,
      versionDiscoveredItems: 0,
      versionCompletedItems: 0,
      versionTotalItems: 0,
      outcome: { available: true, total: results.length, succeeded, failed, cancelled: 0, results },
      eventSeq: ++eventSeq,
      error,
      createdAt,
      updatedAt: Date.now() / MILLISECONDS_PER_SECOND,
    }
    records.set(id, { task, projectName, category, admitted })
    for (const listener of listeners) listener(task)
  }

  publish('running')
  try {
    const outcome = await execute((progress) => {
      if (progress.kind === 'admitted') {
        admitted = progress.count
        if (scope === 'fulltext') phase = PHASE.fulltext
        if (results.length > 0) publish('running')
        return
      }
      results = results.map((result) =>
        result.index === progress.index
          ? {
              ...result,
              status: progress.succeeded ? 'succeeded' : 'failed',
              error: progress.succeeded ? '' : ERROR.fulltext,
            }
          : result
      )
      publish('running')
    })
    publish(outcome.fulltextFailed > 0 ? 'partial' : 'completed')
    return outcome
  } catch (error) {
    publish('failed', ERROR.admission)
    throw error
  }
}
