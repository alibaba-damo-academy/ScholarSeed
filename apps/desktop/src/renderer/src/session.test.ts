import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Trans } from 'react-i18next'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/assistant.json' with { type: 'json' }
import en from '../../localization/locales/en/assistant.json' with { type: 'json' }
import {
  draftSessionTitle,
  mergedSessionTitle,
  openedSessionTitle,
  sessionDisplayTime,
  sessionDisplayTitle,
  sessionProjectName,
  archivedTaskForProject,
} from './session.ts'
import { serveSessionNode, searchSessionTitles } from './tree.ts'
import type { ServeSession } from './api'

test('archived task previews belong only to their exact project and preserve the selection', () => {
  const task = { session_id: 'archived', title: 'History', project_path: 'C:\\项目' }
  assert.equal(archivedTaskForProject(task, 'C:\\项目'), task)
  assert.equal(archivedTaskForProject(task, '/other'), null)
  assert.equal(archivedTaskForProject(task, null), null)
  assert.equal(archivedTaskForProject(null, 'C:\\项目'), null)
  assert.equal(task.project_path, 'C:\\项目')
})

test('session project names use the project catalog and preserve unresolved paths', () => {
  const projects = [
    { path: '/workspace/first', name: '项目甲' },
    { path: '/workspace/second', name: '已归档并重命名的项目' },
    { path: 'C:\\workspace\\项目', name: 'Windows 项目' },
  ]
  assert.equal(
    sessionProjectName({ project_path: '/workspace/first' }, projects, '未分配项目'),
    '项目甲'
  )
  assert.equal(
    sessionProjectName({ project_path: '/workspace/second' }, projects, '未分配项目'),
    '已归档并重命名的项目'
  )
  assert.equal(
    sessionProjectName({ project_path: 'C:\\workspace\\项目' }, projects, '未分配项目'),
    'Windows 项目'
  )
  assert.equal(
    sessionProjectName({ project_path: '/workspace/missing' }, projects, '未分配项目'),
    '/workspace/missing'
  )
  assert.equal(
    sessionProjectName({ project_path: '/workspace/first' }, [], '未分配项目'),
    '/workspace/first'
  )
  assert.equal(sessionProjectName({ project_path: null }, projects, '未分配项目'), '未分配项目')
  assert.equal(sessionProjectName({}, projects, 'Unassigned project'), 'Unassigned project')
})

async function localization() {
  const instance = createInstance()
  await instance.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: { assistant: zh },
      en: { assistant: en },
    },
  })
  return instance
}

test('catalog defaults redraw while user names, legacy same-name titles and unknown provenance remain literal', async () => {
  const locale = await localization()
  const t = locale.getFixedT(null, 'assistant')
  const generated = { title: '新对话', title_fallback: 'new_session' as const }
  const user = { title: '新对话', title_fallback: null }
  const legacy = { title: '新对话' }
  const unknown = { title: 'User / & <中英>', title_fallback: 'future' }
  const before = JSON.stringify([generated, user, legacy, unknown])
  assert.equal(sessionDisplayTitle(generated, t), '新任务')
  await locale.changeLanguage('en')
  assert.equal(sessionDisplayTitle(generated, t), 'New task')
  assert.equal(sessionDisplayTitle(user, t), '新对话')
  assert.equal(sessionDisplayTitle(legacy, t), '新对话')
  assert.equal(sessionDisplayTitle(unknown as typeof generated, t), unknown.title)
  assert.equal(JSON.stringify([generated, user, legacy, unknown]), before)
})

test('all drafts keep the authoritative default until the generated title arrives', () => {
  assert.deepEqual(draftSessionTitle({ title: '新对话', title_fallback: 'new_session' }), {
    title: '新对话',
    title_fallback: 'new_session',
  })
  assert.deepEqual(draftSessionTitle({ title: '新对话', title_fallback: null }), {
    title: '新对话',
    title_fallback: null,
  })
  assert.deepEqual(draftSessionTitle({ title: '提炼任务目标', title_fallback: null }), {
    title: '提炼任务目标',
    title_fallback: null,
  })
  assert.deepEqual(draftSessionTitle({}), { title: '新对话', title_fallback: 'new_session' })
})

test('open recovery updates both fields, clears replaced provenance and tolerates legacy absent titles', () => {
  const local = { title: '新对话', title_fallback: 'new_session' as const }
  assert.deepEqual(
    { ...local, ...openedSessionTitle({ title: '新对话', title_fallback: null }) },
    { title: '新对话', title_fallback: null }
  )
  assert.deepEqual(
    { ...local, ...openedSessionTitle({ title: 'actual name' }) },
    { title: 'actual name', title_fallback: null }
  )
  assert.deepEqual({ ...local, ...openedSessionTitle({}) }, local)
  assert.deepEqual(openedSessionTitle({ title: '', title_fallback: 'unknown' }), {
    title: '',
    title_fallback: null,
  })
})

test('catalog/local merge keeps original title precedence and takes metadata from the selected title', () => {
  const marked = { title: '新对话', title_fallback: 'new_session' as const }
  assert.deepEqual(mergedSessionTitle(marked, { title: 'local prompt' }, 'session-id'), {
    title: 'local prompt',
    title_fallback: null,
  })
  assert.deepEqual(mergedSessionTitle({ title: 'renamed by user' }, marked, 'session-id'), {
    title: 'renamed by user',
    title_fallback: null,
  })
  assert.deepEqual(mergedSessionTitle({ title: '新对话' }, marked, 'session-id'), marked)
  assert.deepEqual(
    mergedSessionTitle(
      { title: '新对话', title_fallback: null },
      { title: 'stale generated name' },
      'session-id'
    ),
    { title: '新对话', title_fallback: null }
  )
  assert.deepEqual(mergedSessionTitle(marked, { title: '' }, 'session-id'), marked)
  assert.deepEqual(mergedSessionTitle(undefined, { title: '' }, 'session-id'), {
    title: 'session-',
    title_fallback: null,
  })
})

test('catalog projection preserves provenance without changing canonical search', async () => {
  const locale = await localization()
  const node = serveSessionNode(
    {
      session_id: 'new-session',
      title: '新对话',
      title_fallback: 'new_session',
      runtime_id: 'codex',
      workdir: '/workspace',
      mtime: 5,
    } as ServeSession,
    {},
    null
  )
  assert.equal(node.title_fallback, 'new_session')
  await locale.changeLanguage('en')
  assert.equal(sessionDisplayTitle(node, locale.getFixedT(null, 'assistant')), 'New task')
  assert.equal(searchSessionTitles([node], '新对话').length, 1)
  assert.equal(searchSessionTitles([node], 'New conversation').length, 0)
  assert.equal(node.title, '新对话')
})

test('delete confirmation redraws stored error keys and interpolates original conversation names in both languages', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: Object.fromEntries(
      ['zh', 'en'].map((language) => [
        language,
        {
          shell: JSON.parse(
            readFileSync(
              new URL(`../../localization/locales/${language}/shell.json`, import.meta.url),
              'utf8'
            )
          ),
        },
      ])
    ),
  })
  const storedError = 'delete.stopFailed'
  const t = locale.getFixedT(null, 'shell')
  assert.match(t(storedError), /尚未删除任务/)
  await locale.changeLanguage('en')
  assert.equal(storedError, 'delete.stopFailed')
  assert.match(t(storedError), /has not been deleted/)
  for (const language of ['zh', 'en']) {
    await locale.changeLanguage(language)
    for (const name of [
      '原始 & <unknown>title</unknown> {{name}}',
      '<name>会话名</name>',
      '<strong>原始标题</strong><br/>下一行',
      '</name><br><name>原始标题',
    ]) {
      const rendered = renderToStaticMarkup(
        createElement(Trans, {
          i18n: locale,
          ns: 'shell',
          i18nKey: 'delete.irreversible',
          components: { name: createElement('b', null, name) },
        })
      )
      const titleNode = renderToStaticMarkup(createElement('b', null, name))
      assert.equal(
        rendered,
        language === 'zh'
          ? `确定要删除「${titleNode}」吗？任务及其全部产物会被一并删除，且不可恢复。`
          : `Are you sure you want to delete “${titleNode}”? The task and all its artifacts will be deleted. This cannot be undone.`
      )
    }
  }
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const dialog = source.slice(source.indexOf('function ConfirmDialog()'))
  assert.match(dialog, /if \(r.status === 409\) setErr\('delete.stopFailed'\)/)
  assert.match(dialog, /act.removeSession\(cd.sessionId, cd.surface\)/)
  assert.match(dialog, /<AlertDialog\s+open\s+onOpenChange=/)
  assert.match(dialog, /<AlertDialogAction\s+variant="danger"\s+disabled=\{busy\}/)
  assert.match(dialog, /event\.preventDefault\(\);?\s+void onDelete\(\)/)
  assert.doesNotMatch(dialog, /<button/)
  assert.doesNotMatch(dialog, /values=\{\{ name:/)
})

test('catalog timestamps redraw in both languages while explicit time labels remain unchanged', () => {
  const now = new Date(2026, 8, 14, 12)
  const timestamp = new Date(2026, 8, 13, 18).getTime() / 1_000
  const node = serveSessionNode(
    { session_id: 'dated-session', title: 'Original title', created_at: timestamp } as ServeSession,
    {},
    null
  )
  const format = (locale: string) => ({
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, options).format(value),
    relative: (
      value: number,
      unit: Intl.RelativeTimeFormatUnit,
      options?: Intl.RelativeTimeFormatOptions
    ) => new Intl.RelativeTimeFormat(locale, options).format(value, unit),
    number: (value: number) => String(value),
    bytes: (value: number) => String(value),
  })
  assert.equal(node.timeLabel, undefined)
  assert.equal(sessionDisplayTime(node, format('zh-CN'), now), '昨天')
  assert.equal(sessionDisplayTime(node, format('en-US'), now), 'yesterday')
  assert.equal(node.createdAt, timestamp)
  assert.equal(
    sessionDisplayTime({ ...node, timeLabel: '上游原文 Yesterday' }, format('en-US'), now),
    '上游原文 Yesterday'
  )
  assert.equal(sessionDisplayTime({}, format('en-US'), now), '')
  assert.equal(sessionDisplayTime({ createdAt: Number.NaN }, format('en-US'), now), '')
  const today = new Date(2026, 8, 14, 9, 5)
  assert.equal(
    sessionDisplayTime({ createdAt: today.getTime() / 1_000 }, format('en-US'), now),
    new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(today)
  )
  const older = new Date(2026, 8, 12, 18)
  assert.equal(
    sessionDisplayTime({ createdAt: older.getTime() / 1_000 }, format('zh-CN'), now),
    new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(older)
  )
})
