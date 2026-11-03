import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { block } from '../../../../test-helpers/source-contract.ts'
import { createLocalization } from '../../../../localization/engine.ts'
import en from '../../../../localization/locales/en/literature.json' with { type: 'json' }
import zh from '../../../../localization/locales/zh/literature.json' with { type: 'json' }

import {
  conversationProject,
  claimDownloadRefresh,
  DOWNLOAD_REFRESH_CACHE_LIMIT,
  downloadOutcome,
  downloadRefreshKey,
  downloadSupersessionKey,
  openDownloadedFulltext,
  parseDownloadCard,
} from './admission.ts'

test('card project follows its conversation rather than the visible workbench', () => {
  const projects = [
    { id: 'first', path: '/first' },
    { id: 'second', path: '/second' },
  ]
  assert.equal(conversationProject(projects, '/first')?.id, 'first')
  assert.equal(conversationProject(projects, '/missing'), undefined)
  assert.equal(conversationProject(projects, null), undefined)
})
import type { ConvItem } from '../../model.ts'
import { latestDisplayCardItems, projectDisplayCardEvent } from '../../transcript.ts'
import { literatureNavigation } from '../workbench/tabs.ts'

const content = {
  schema_version: '1.0',
  session_id: 'session',
  run: 'run',
  project_id: 'project',
  papers: [
    {
      paper_id: 'p1',
      literature_id: 'literature',
      attachment_id: 'attachment',
      title: 'Paper',
      revision: 'sha256:revision',
    },
  ],
  failures: [],
}

test('download messages use English singular and plural forms without changing Chinese counts', () => {
  for (const language of ['en', 'zh'] as const) {
    const localization = createLocalization(
      language,
      { en: { literature: en }, zh: { literature: zh } },
      { report: () => {} }
    )
    for (const count of [0, 1, 2]) {
      const noun = count === 1 ? 'paper' : 'papers'
      const expected =
        language === 'en'
          ? {
              heading: `${count} ${noun} saved to library`,
              partialHeading: `${count} ${noun} saved; 1 could not be saved`,
              viewLibrary: `View the other ${count} ${noun} in the library`,
              failed: `${count} ${noun} downloaded but could not be saved to the library. Retry admission without downloading again.`,
            }
          : {
              heading: `已入库 ${count} 篇论文`,
              partialHeading: `已入库 ${count} 篇，1 篇入库失败`,
              viewLibrary: `在文献库查看其余 ${count} 篇`,
              failed: `${count} 篇论文已下载，但入库失败。可重试入库，无需重新下载。`,
            }
      for (const key of ['heading', 'partialHeading', 'viewLibrary', 'failed'] as const) {
        assert.equal(
          localization.t(`literature:downloads.${key}`, { count, failed: 1 }),
          expected[key]
        )
      }
    }
  }
})

test('download receipts refresh only once across card remounts', () => {
  const key = downloadRefreshKey('card-one', parseDownloadCard(content))
  assert.equal(claimDownloadRefresh(key), true)
  assert.equal(claimDownloadRefresh(key), false)
  assert.equal(
    claimDownloadRefresh(downloadRefreshKey('card-one', parseDownloadCard({ ...content }))),
    false
  )
  assert.equal(claimDownloadRefresh(downloadRefreshKey('invalid-card', null)), false)
  assert.equal(
    claimDownloadRefresh(
      downloadRefreshKey('empty-card', parseDownloadCard({ ...content, papers: [] }))
    ),
    false
  )
})

test('download refresh identity includes scope, attachment revision and omitted successes', () => {
  const original = downloadRefreshKey('card-one', parseDownloadCard(content))
  const anotherDelivery = downloadRefreshKey('card-two', parseDownloadCard(content))
  assert.notEqual(anotherDelivery, original)
  assert.equal(claimDownloadRefresh(anotherDelivery), true)
  assert.equal(claimDownloadRefresh(anotherDelivery), false)
  const variants = [
    { ...content, session_id: 'another-session' },
    { ...content, run: 'another-run' },
    { ...content, project_id: 'another-project' },
    { ...content, papers: [{ ...content.papers[0], revision: 'sha256:another-revision' }] },
    { ...content, omitted_papers: 1 },
  ]
  for (const variant of variants) {
    const key = downloadRefreshKey('card-one', parseDownloadCard(variant))
    assert.notEqual(key, original)
    assert.equal(claimDownloadRefresh(key), true)
    assert.equal(claimDownloadRefresh(key), false)
  }
})

test('download refresh deduplication keeps a bounded renderer-local cache', () => {
  const first = 'cache-bound-first'
  assert.equal(claimDownloadRefresh(first), true)
  for (let index = 0; index < DOWNLOAD_REFRESH_CACHE_LIMIT; index += 1) {
    claimDownloadRefresh(`cache-bound-${index}`)
  }
  assert.equal(claimDownloadRefresh(first), true)
})

test('download fulltext uses existing literature navigation before opening the attachment', async () => {
  const calls: unknown[] = []
  const card = parseDownloadCard(content)!
  const opened = await openDownloadedFulltext(
    {
      openLiteratureItem: async (...args) => {
        calls.push(['item', ...args])
        return true
      },
      openLiteratureAttachment: async (...args) => {
        calls.push(['attachment', ...args])
        return true
      },
    },
    card,
    card.papers[0]
  )
  assert.equal(opened, true)
  assert.deepEqual(calls, [
    ['item', 'literature', 'project'],
    ['attachment', 'literature', 'attachment', undefined, { projectId: 'project' }],
  ])
})

test('global download fulltext uses the existing empty-string global workspace identity', async () => {
  const calls: unknown[] = []
  const card = parseDownloadCard({ ...content, project_id: '' })!
  await openDownloadedFulltext(
    {
      openLiteratureItem: async (_id, projectId) => {
        calls.push(projectId)
        return true
      },
      openLiteratureAttachment: async (_id, _attachment, _page, options) => {
        calls.push(options?.projectId)
        return false
      },
    },
    card,
    card.papers[0]
  )
  assert.deepEqual(calls, ['', ''])
})

test('download fulltext does not open an attachment when existing literature navigation fails', async () => {
  const card = parseDownloadCard(content)!
  let attachmentCalls = 0
  const opened = await openDownloadedFulltext(
    {
      openLiteratureItem: async () => false,
      openLiteratureAttachment: async () => {
        attachmentCalls += 1
        return true
      },
    },
    card,
    card.papers[0]
  )
  assert.equal(opened, false)
  assert.equal(attachmentCalls, 0)
})

test('download fulltext resolves the current attachment after explicit restoration', async () => {
  const card = parseDownloadCard({
    ...content,
    papers: [{ ...content.papers[0], operation_id: 'download-operation' }],
  })!
  const calls: unknown[] = []
  const opened = await openDownloadedFulltext(
    {
      openLiteratureItem: async (...args) => {
        calls.push(['item', ...args])
        return true
      },
      openLiteratureAttachment: async (...args) => {
        calls.push(['attachment', ...args])
        return true
      },
    },
    card,
    card.papers[0],
    async (...args) => {
      calls.push(['resolve', ...args])
      return { literature_id: 'restored-literature', attachment_id: 'restored-attachment' }
    }
  )
  assert.equal(opened, true)
  assert.deepEqual(calls, [
    ['resolve', 'session', 'download-operation'],
    ['item', 'restored-literature', 'project'],
    [
      'attachment',
      'restored-literature',
      'restored-attachment',
      undefined,
      { projectId: 'project' },
    ],
  ])
})

test('invalid operation identity is rejected instead of selecting a stale attachment', () => {
  assert.equal(
    parseDownloadCard({
      ...content,
      papers: [{ ...content.papers[0], operation_id: 42 }],
    }),
    null
  )
})

function downloadNavigation(
  selectedProjectId: string | null,
  ports: { get?: () => Promise<unknown>; fetch?: () => Promise<unknown> } = {}
) {
  const source = readFileSync(new URL('../../store.tsx', import.meta.url), 'utf8')
  const action = block(
    source,
    'openLiteratureItem: async (id, projectId) => {',
    '    markLiteratureFulltext:'
  )
    .trim()
    .replace(/^openLiteratureItem: /, '')
    .replace(/,$/, '')
  const panel = { open: true, messageFocus: { sessionId: 'session', seq: 9 } }
  const stateRef = {
    current: {
      activeSession: 'session',
      homeSelectedProjectId: selectedProjectId,
      aiPanel: panel,
      composerText: 'Please compare these papers',
      tabs: [],
      recentLiterature: [],
      literature: { items: [{ id: 'existing-item' }] },
    },
  }
  const calls: unknown[][] = []
  const navigation = { action: 'literature-item', request: 1, startedGeneration: 0 }
  const openItem = Function(
    'stateRef',
    'getLiterature',
    'fetchLiterature',
    'setState',
    'openFixedTab',
    'LITERATURE_TAB',
    'touchRecentLiterature',
    'INITIAL_LITERATURE_STATE',
    'catalogue',
    'beginNavigation',
    'actRef',
    'literatureNavigation',
    `return (${action})`
  )(
    stateRef,
    async (...args: unknown[]) => {
      calls.push(['get', ...args])
      return ports.get ? ports.get() : {}
    },
    async (...args: unknown[]) => {
      calls.push(['fetch', ...args])
      return ports.fetch ? ports.fetch() : { items: [] }
    },
    (update: (current: typeof stateRef.current) => typeof stateRef.current, cause: unknown) => {
      assert.equal(cause, navigation)
      calls.push(['state'])
      stateRef.current = update(stateRef.current)
    },
    (tabs: unknown) => tabs,
    { id: 'literature' },
    (recent: unknown) => recent,
    {},
    {
      scope: (projectId: string) => calls.push(['scope', projectId]),
      focus: (id: string) => calls.push(['focus', id]),
    },
    (action: string) => {
      assert.equal(action, 'literature-item')
      calls.push(['begin', action])
      return navigation
    },
    { current: { noticeLiterature: (...args: unknown[]) => calls.push(['notice', ...args]) } },
    literatureNavigation
  )
  return { stateRef, panel, openItem, calls }
}

for (const selectedProjectId of [null, 'another-project', '']) {
  test(`download navigation preserves the real literature action's conversation and draft from ${selectedProjectId}`, async () => {
    const card = parseDownloadCard({
      ...content,
      project_id: selectedProjectId === '' ? '' : 'project',
    })!
    const { stateRef, panel, openItem, calls } = downloadNavigation(selectedProjectId)
    let openedProject: string | null | undefined
    const opened = await openDownloadedFulltext(
      {
        openLiteratureItem: openItem,
        openLiteratureAttachment: async (_id, _attachment, _page, options) => {
          openedProject = options?.projectId
          return stateRef.current.homeSelectedProjectId === openedProject
        },
      },
      card,
      card.papers[0]
    )
    assert.equal(opened, true)
    assert.equal(openedProject, card.project_id)
    assert.equal(stateRef.current.activeSession, 'session')
    assert.equal(stateRef.current.aiPanel, panel)
    assert.equal(stateRef.current.composerText, 'Please compare these papers')
    assert.deepEqual(stateRef.current.literature, { items: [{ id: 'existing-item' }] })
    assert.deepEqual(calls, [
      ['begin', 'literature-item'],
      ['get', 'literature', card.project_id],
      ['scope', card.project_id],
      ['focus', 'literature'],
      ['state'],
    ])
  })
}

test('literature navigation does not depend on the legacy list endpoint', async () => {
  const fixture = downloadNavigation('project', {
    fetch: async () => {
      throw new Error('legacy list unavailable')
    },
  })
  assert.equal(await fixture.openItem('literature', 'project'), true)
  assert.equal(
    fixture.calls.some(([operation]) => operation === 'fetch'),
    false
  )
})

for (const failure of ['missing-item', 'changed-session'] as const) {
  test(`download navigation rejects ${failure} without opening an attachment or changing state`, async () => {
    const fixture = downloadNavigation('another-project', {
      get: async () => {
        if (failure === 'missing-item') throw new Error('unavailable')
        if (failure === 'changed-session') fixture.stateRef.current.activeSession = 'new-session'
        return {}
      },
    })
    const before = structuredClone(fixture.stateRef.current)
    let attachments = 0
    assert.equal(
      await openDownloadedFulltext(
        {
          openLiteratureItem: fixture.openItem,
          openLiteratureAttachment: async () => {
            attachments += 1
            return true
          },
        },
        parseDownloadCard(content)!,
        content.papers[0]
      ),
      false
    )
    assert.equal(attachments, 0)
    assert.deepEqual(fixture.stateRef.current, {
      ...before,
      activeSession: failure === 'changed-session' ? 'new-session' : 'session',
    })
    assert.deepEqual(fixture.calls, [
      ['begin', 'literature-item'],
      ['get', 'literature', 'project'],
      ...(failure === 'changed-session'
        ? []
        : [['notice', 'error', '这条文献当前不可用，请刷新关联。']]),
    ])
  })
}

test('download card retains canonical attachment identity and project', () => {
  const card = parseDownloadCard(content)
  assert.equal(card?.project_id, 'project')
  assert.equal(card?.papers[0].literature_id, 'literature')
  assert.equal(card?.papers[0].attachment_id, 'attachment')
})

test('missing identities and duplicate papers cannot become full-text buttons', () => {
  assert.equal(
    parseDownloadCard({ ...content, papers: [{ ...content.papers[0], attachment_id: '' }] }),
    null
  )
  assert.equal(
    parseDownloadCard({ ...content, papers: [...content.papers, ...content.papers] }),
    null
  )
  assert.equal(parseDownloadCard({ ...content, failures: [{ paper_id: 'p2' }] }), null)
})

test('download card parsing rejects invalid scope and constructs only validated fields', () => {
  assert.equal(parseDownloadCard({ ...content, project_id: undefined }), null)
  assert.equal(
    parseDownloadCard({ ...content, papers: [{ ...content.papers[0], revision: 1 }] }),
    null
  )
  const card = parseDownloadCard({
    ...content,
    extra: 'unused',
    papers: [{ ...content.papers[0], extra: 'unused' }],
  })!
  assert.equal('extra' in card, false)
  assert.equal('extra' in card.papers[0], false)
  assert.notEqual(card, content)
})

test('cumulative recovery replaces only its own run download card', () => {
  assert.equal(downloadSupersessionKey(content), downloadSupersessionKey({ ...content }))
  assert.notEqual(
    downloadSupersessionKey(content),
    downloadSupersessionKey({ ...content, run: 'another-run' })
  )
  assert.equal(
    downloadSupersessionKey(content),
    downloadSupersessionKey({ ...content, papers: [{ ...content.papers[0], paper_id: 'p2' }] })
  )
})

test('partial admission keeps successful identities and explicit failures separate', () => {
  const card = parseDownloadCard({
    ...content,
    failures: [{ paper_id: 'p2', code: 'invalid_pdf' }],
  })
  assert.equal(card?.papers.length, 1)
  assert.equal(card?.failures.length, 1)
})

test('download outcome distinguishes saved partial failed and empty without false success', () => {
  const saved = parseDownloadCard(content)!
  assert.equal(downloadOutcome(saved).descriptionKey, 'downloads.projectLinked')
  const partial = parseDownloadCard({
    ...content,
    failures: [{ paper_id: 'p2', code: 'invalid_pdf' }],
  })!
  assert.equal(downloadOutcome(partial).heading, 'downloads.partialHeading')
  assert.equal(downloadOutcome(partial).descriptionKey, 'downloads.partialSaved')
  const failed = parseDownloadCard({ ...content, papers: [], failures: partial.failures })!
  assert.equal(downloadOutcome(failed).heading, 'downloads.failedHeading')
  assert.equal(downloadOutcome(failed).descriptionKey, 'downloads.noneSaved')
  const empty = parseDownloadCard({ ...content, papers: [] })!
  assert.equal(downloadOutcome(empty).descriptionKey, 'downloads.empty')
})

test('bounded card counts include omitted entries and reject invalid counts', () => {
  const card = parseDownloadCard({ ...content, omitted_papers: 997, omitted_failures: 4 })!
  const outcome = downloadOutcome(card)
  assert.equal(outcome.saved, 998)
  assert.equal(outcome.failed, 4)
  assert.equal(outcome.heading, 'downloads.partialHeading')
  assert.equal(parseDownloadCard({ ...content, omitted_papers: -1 }), null)
  assert.equal(parseDownloadCard({ ...content, omitted_failures: 0.5 }), null)
})

test('failed success failed revisions keep only the latest failure without stale full-text buttons', () => {
  const failed = {
    ...content,
    papers: [],
    failures: [{ paper_id: 'p1', code: 'download_admission_unavailable' }],
  }
  let projected: ConvItem[] = []
  for (const [index, snapshot] of [failed, content, failed].entries()) {
    projected = projectDisplayCardEvent(projected, {
      v: 2,
      seq: index + 1,
      ts: index + 1,
      type: 'display_card',
      session_id: 'session',
      turn_id: 'turn',
      data: { card_id: `revision-${index}`, type: 'literature-downloads', content: snapshot },
    })
  }
  const visible = latestDisplayCardItems(projected, (card) => downloadSupersessionKey(card.content))
  assert.equal(visible.length, 1)
  assert.equal(visible[0].kind, 'display_card')
  if (visible[0].kind !== 'display_card') return
  assert.deepEqual(parseDownloadCard(visible[0].card.content)?.papers, [])
  assert.equal(visible[0].card.cardId, 'revision-2')
})
