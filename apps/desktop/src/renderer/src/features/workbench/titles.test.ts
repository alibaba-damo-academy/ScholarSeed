import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/literature.json' with { type: 'json' }
import en from '../../../../localization/locales/en/literature.json' with { type: 'json' }
import zhWorkbench from '../../../../localization/locales/zh/workbench.json' with { type: 'json' }
import enWorkbench from '../../../../localization/locales/en/workbench.json' with { type: 'json' }
import {
  PROJECTS_TAB,
  literatureResultTab,
  literatureSearchTab,
  openFixedTab,
  openReviewTab,
  openVersionDiffTab,
  parseVersionDiffTab,
  reviewTab,
  versionDiffTab,
  workbenchTabTitle
} from './tabs.ts'

test('literature result labels change language without rewriting criteria or tab identity', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: { zh: { literature: zh, workbench: zhWorkbench }, en: { literature: en, workbench: enWorkbench } } })
  const t = locale.getFixedT(null, 'literature')
  const workbench = locale.getFixedT(null, 'workbench')
  const empty = literatureResultTab({ session_id: 'session/a', card_id: 'card/b', title: '' })
  const criteria = literatureResultTab({ session_id: 'session/a', card_id: 'criteria', title: '量子计算' })
  const tabs = [empty, criteria]
  assert.equal(workbenchTabTitle(empty, t, workbench), '检索：文献检索')
  assert.equal(workbenchTabTitle(criteria, t, workbench), '检索：量子计算')
  await locale.changeLanguage('en')
  assert.equal(workbenchTabTitle(empty, t, workbench), 'Search: Literature search')
  assert.equal(workbenchTabTitle(criteria, t, workbench), 'Search: 量子计算')
  assert.equal(criteria.title, '量子计算')
  assert.equal(empty.title, '')
  assert.equal(empty.id, 'literature-result:session%2Fa/card%2Fb')
  assert.equal(openFixedTab(tabs, literatureResultTab({ session_id: 'session/a', card_id: 'card/b', title: '' })), tabs)
  assert.equal(workbenchTabTitle({ id: 'file', kind: 'file', title: '研究.md', closable: true }, t, workbench), '研究.md')
})

test('version diff tabs freeze both version identities and deduplicate the same comparison', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: { zh: { literature: zh, workbench: zhWorkbench }, en: { literature: en, workbench: enWorkbench } } })
  const literature = locale.getFixedT(null, 'literature')
  const workbench = locale.getFixedT(null, 'workbench')
  const reference = {
    project: 'project / 甲',
    fileId: 'file:1',
    path: 'reports/年度 总结.docx',
    historicalVersionId: 'version:12',
    currentVersionId: 'version:13',
    historicalSequence: 12,
    processor: null
  }
  const tab = versionDiffTab(reference)
  const tabs = [tab]

  assert.equal(tab.kind, 'version_diff')
  assert.deepEqual(parseVersionDiffTab(tab.id), reference)
  assert.equal(openVersionDiffTab(tabs, reference), tabs)
  assert.equal(workbenchTabTitle(tab, literature, workbench), '版本对比 · v12 · 年度 总结.docx')
  await locale.changeLanguage('en')
  assert.equal(workbenchTabTitle(tab, literature, workbench), 'Compare versions · v12 · 年度 总结.docx')
  assert.equal(parseVersionDiffTab('version-diff:broken'), null)
})

test('project, review and AI search tabs redraw while preserving canonical titles and identities', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: { zh: { literature: zh, workbench: zhWorkbench }, en: { literature: en, workbench: enWorkbench } } })
  const literature = locale.getFixedT(null, 'literature')
  const workbench = locale.getFixedT(null, 'workbench')
  const review = reviewTab('project / 甲', 'batch:1', 3)
  const search = literatureSearchTab('task:1', '量子计算 / AI', 'project / 甲')
  const tabs = [PROJECTS_TAB, review, search]
  const before = structuredClone(tabs)
  assert.deepEqual(tabs.map(tab => workbenchTabTitle(tab, literature, workbench)), ['项目', '审阅修改 · 3', 'AI检索：量子计算 / AI'])
  await locale.changeLanguage('en')
  assert.deepEqual(tabs.map(tab => workbenchTabTitle(tab, literature, workbench)), ['Projects', 'Review changes · 3', 'AI search: 量子计算 / AI'])
  assert.deepEqual(tabs, before)
  assert.equal(review.id, 'review:project%20%2F%20%E7%94%B2:batch%3A1')
  assert.equal(search.id, 'literature-search:task:1')
  assert.equal(search.projectId, 'project / 甲')
  assert.equal(search.title, 'AI检索：量子计算 / AI')
  assert.equal(review.title, '审阅修改 · 3')
  assert.equal(openReviewTab(tabs, 'project / 甲', 'batch:1', 3), tabs)
  assert.equal(workbenchTabTitle(reviewTab('p', 'b', 0), literature, workbench), 'Review changes · 0')
  assert.equal(workbenchTabTitle(literatureSearchTab('empty', ''), literature, workbench), 'AI search: ')
})
