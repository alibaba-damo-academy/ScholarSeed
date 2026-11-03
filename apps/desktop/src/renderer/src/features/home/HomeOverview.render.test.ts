import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import tailwindcss from '@tailwindcss/postcss'
import { build } from 'esbuild'
import postcss from 'postcss'
import { HOME_PROJECT_PAGE_SIZE, HOME_TASK_PAGE_SIZE } from './catalog.ts'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))
const ORIGIN = 'http://127.0.0.1:18775'

test('home renders fixed project/task pages and project/session navigation', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'home-pagination-'))
  const bundle = join(directory, 'probe.js')
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { I18nextProvider } from 'react-i18next';
        import { createLocalization } from './src/localization/engine';
        import { resources } from './src/localization/resources';
        import { HomeOverview } from './src/renderer/src/features/home/HomeOverview';
        const root = createRoot(document.getElementById('root'));
        const engine = createLocalization('zh', resources);
        window.actions = [];
        window.homeAttention = { by_session: {} };
        window.homeState = { lang: 'zh', backendReady: true, projectForm: null, sessions: [], sessionActivitySeen: {}, activeSession: null, projects: [
          { id: 'first', name: 'First', path: '/first', available: true },
          { id: 'second', name: 'Second', path: '/second', available: true }
        ] };
        window.probe = {
          projects: projects => {
            window.homeState.projects = projects;
            flushSync(() => root.render(<I18nextProvider i18n={engine}><HomeOverview key="23en" /></I18nextProvider>));
          },
          update: (rows, sessions = [], seen = {}, unread = {}) => {
            window.rows = rows;
            window.homeAttention = { by_session: unread };
            Object.assign(window.homeState, { sessions, sessionActivitySeen: seen,
              sessionCatalogRevision: (window.homeState.sessionCatalogRevision || 0) + 1 });
            flushSync(() => root.render(<I18nextProvider i18n={engine}><HomeOverview key="23en" /></I18nextProvider>));
          },
          render: async (count, language = 'zh') => {
            window.rows = Array.from({ length: count }, (_, index) => ({
              session_id: 'task-' + index, title: 'Task ' + index,
              project_path: index % 2 ? '/second' : '/first', mtime: count - index
            }));
            window.homeState.lang = language;
            await engine.changeLanguage(language);
            flushSync(() => root.render(<I18nextProvider i18n={engine}><HomeOverview key={count + language} /></I18nextProvider>));
          }
        };
      `,
      resolveDir: DESKTOP,
      loader: 'tsx',
    },
    outfile: bundle,
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
    plugins: [
      {
        name: 'home-test-boundaries',
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^\.\.\/\.\.\/(api|store|components\/business\/ProjectActions)$|^\.\.\/project\/Recovery$|^\.\.\/assistant\/attention$/,
            },
            (args) => ({ path: args.path, namespace: 'home-test' })
          )
          builder.onLoad({ filter: /.*/, namespace: 'home-test' }, (args) => ({
            loader: 'js',
            contents: args.path.endsWith('/api')
              ? 'export async function listAllSessions() { return window.rows }; export async function listProjects() { return null }; export async function revealSystemPath() { return { ok: false, error: "desktop bridge unavailable", applicationFailure: { code: "desktop_bridge_unavailable" } } }'
              : args.path.endsWith('/store')
                ? `export function useApp() { return { state: window.homeState, set: patch => window.actions.push(['set', patch]), act: {
                  selectProject: id => window.actions.push(['project', id]),
                  openWorkbenchView: view => window.actions.push(['view', view]),
                  openSession: id => window.actions.push(['session', id])
                } } }`
                : args.path.endsWith('/attention')
                  ? 'export function useAttention() { return window.homeAttention }'
                  : 'export function ProjectActionsMenu() { return null }; export function CreationRecoveryPanel() { return null }',
          }))
        },
      },
    ],
  })
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  context.after(async () => {
    await browser.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
  )
  await page.goto(ORIGIN)
  await page.addScriptTag({ path: bundle })
  await context.test(
    'project actions belong to the welcome content, not the window header',
    async () => {
      await page.evaluate(() => Reflect.get(window, 'probe').render(1))
      await expect(page.locator('header').getByTestId('home-project-create-top')).toHaveCount(0)
      await expect(
        page.getByRole('heading', { level: 1 }).locator('..').getByTestId('home-project-create-top')
      ).toBeVisible()
      await expect(
        page.getByRole('heading', { level: 1 }).locator('..').getByRole('searchbox')
      ).toBeVisible()
    }
  )
  await context.test(
    'empty project catalog shows creation guidance, not a search empty state',
    async () => {
      await page.evaluate(() => {
        Reflect.get(window, 'homeState').projects = []
        Reflect.get(window, 'probe').render(0)
      })
      await expect(page.getByTestId('home-projects-empty')).toBeVisible()
      await expect(page.getByText('创建你的第一个项目', { exact: true })).toBeVisible()
      await expect(page.getByTestId('home-projects-next')).toHaveCount(0)
      await page.getByTestId('home-project-create-empty').click()
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'actions').at(-1)), [
        'set',
        { projectForm: { mode: 'create' } },
      ])
      await page.evaluate(() => {
        Reflect.get(window, 'homeState').projects = [
          { id: 'first', name: 'First', path: '/first', available: true },
        ]
        Reflect.get(window, 'probe').render(1)
      })
      await expect(page.getByTestId('home-projects-empty')).toHaveCount(0)
      await page.getByRole('searchbox').fill('no matching project')
      await expect(page.getByTestId('home-projects-no-results')).toBeVisible()
      await expect(page.getByText('暂无结果', { exact: true })).toBeVisible()
      await expect(page.getByTestId('home-projects-empty')).toHaveCount(0)
      await page.getByRole('searchbox').fill('')
    }
  )
  await context.test(
    'empty tasks expand projects; populated and failed tasks retain their column',
    async () => {
      const columns = page.getByTestId('home-projects-grid').locator('../..')
      await page.evaluate(() => Reflect.get(window, 'probe').render(0))
      await expect(page.getByTestId('home-tasks-empty')).toHaveCount(0)
      await expect(page.locator('#home-tasks-heading')).toHaveCount(0)
      await expect(columns).toHaveClass(/grid-cols-1/)
      await page.evaluate(() => Reflect.get(window, 'probe').render(1))
      await expect(page.locator('#home-tasks-heading')).toBeVisible()
      await expect(columns).toHaveClass(/grid-cols-2/)
      await page.evaluate(() => Reflect.get(window, 'probe').update(null))
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
      await expect(columns).toHaveClass(/grid-cols-2/)
    }
  )
  const tasks = page.locator('[data-testid^="home-task-"]')
  const previousTasks = page.getByTestId('home-tasks-previous')
  const nextTasks = page.getByTestId('home-tasks-next')
  const taskIds = () =>
    tasks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
  await page.evaluate(() => {
    Reflect.get(window, 'homeState').projects = [
      { id: 'first', name: 'First', path: '/first', available: true },
      { id: 'second', name: 'Second', path: '/second', available: true },
    ]
  })
  const render = async (count: number, language = 'zh') => {
    await page.evaluate(
      ({ count, language }) => Reflect.get(window, 'probe').render(count, language),
      { count, language }
    )
    await expect(tasks).toHaveCount(Math.min(count, HOME_TASK_PAGE_SIZE))
    await expect(
      page.getByRole('heading', {
        name: language === 'zh' ? '欢迎来到书深' : 'Welcome to ScholarSeed',
      })
    ).toBeVisible()
    await expect(page.getByRole('searchbox')).toHaveCount(1)
    await expect(page.locator('[data-feedback-entry-host]')).toHaveCount(0)
  }
  for (const count of [
    0,
    1,
    HOME_TASK_PAGE_SIZE - 1,
    HOME_TASK_PAGE_SIZE,
    HOME_TASK_PAGE_SIZE + 1,
    HOME_TASK_PAGE_SIZE * 2,
    HOME_TASK_PAGE_SIZE * 2 + 3,
    200,
    501,
  ]) {
    await render(count)
    if (!count) {
      await expect(page.getByTestId('home-tasks-empty')).toHaveCount(0)
      await expect(page.locator('#home-tasks-heading')).toHaveCount(0)
      await expect(nextTasks).toHaveCount(0)
      continue
    }
    await expect(previousTasks).toBeDisabled()
    const collected = await taskIds()
    for (let offset = HOME_TASK_PAGE_SIZE; offset < count; offset += HOME_TASK_PAGE_SIZE) {
      await expect(nextTasks).toBeEnabled()
      await nextTasks.focus()
      await page.keyboard.press('Enter')
      await expect(tasks).toHaveCount(Math.min(HOME_TASK_PAGE_SIZE, count - offset))
      await expect(previousTasks).toBeEnabled()
      collected.push(...(await taskIds()))
    }
    await expect(nextTasks).toBeDisabled()
    assert.deepEqual(
      collected,
      Array.from({ length: count }, (_, index) => `home-task-task-${index}`)
    )
    for (let offset = Math.floor((count - 1) / HOME_TASK_PAGE_SIZE); offset > 0; offset--) {
      await previousTasks.click()
    }
    await expect(previousTasks).toBeDisabled()
    await expect(tasks.first()).toHaveAttribute('data-testid', 'home-task-task-0')
  }
  await render(HOME_TASK_PAGE_SIZE * 2 + 3, 'en')
  const firstNode = await tasks.first().elementHandle()
  const firstIds = await taskIds()
  const search = page.getByRole('searchbox', { name: 'Search projects', exact: true })
  await search.fill('Second')
  await expect(page.getByTestId('home-project-First')).toHaveCount(0)
  await expect(page.getByTestId('home-project-Second')).toBeVisible()
  assert.deepEqual(await taskIds(), firstIds)
  assert.equal(await tasks.first().evaluate((node, original) => node === original, firstNode), true)
  await nextTasks.click()
  await expect(tasks).toHaveCount(HOME_TASK_PAGE_SIZE)
  await tasks.last().click()
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'actions').slice(-3)), [
    ['project', 'second'],
    ['view', 'resource'],
    ['session', `task-${HOME_TASK_PAGE_SIZE * 2 - 1}`],
  ])
  const secondIds = await taskIds()
  await search.fill('missing')
  await expect(page.getByTestId('home-projects-no-results')).toBeVisible()
  await expect(page.getByText('No results', { exact: true })).toBeVisible()
  assert.deepEqual(await taskIds(), secondIds)
  await expect(nextTasks).toBeEnabled()
  await search.fill('')
  await previousTasks.click()
  await expect(tasks).toHaveCount(HOME_TASK_PAGE_SIZE)
  await page.evaluate(() =>
    Reflect.get(window, 'probe').update(
      [
        { session_id: 'running', project_path: '/first', title: 'Running', running: true },
        { session_id: 'waiting', project_path: '/first', title: 'Waiting', waiting: true },
        {
          session_id: 'paused',
          project_path: '/first',
          title: 'Paused',
          last_turn_status: 'interrupted',
        },
        {
          session_id: 'failed',
          project_path: '/first',
          title: 'Failed',
          last_turn_status: 'failed',
        },
        {
          session_id: 'done',
          project_path: '/first',
          title: 'Done',
          last_turn_status: 'completed',
          mtime: 10,
        },
        {
          session_id: 'viewed',
          project_path: '/first',
          title: 'Viewed',
          last_turn_status: 'completed',
          mtime: 10,
        },
      ],
      [],
      { viewed: 10 },
      { done: 2 }
    )
  )
  await expect(tasks).toHaveCount(6)
  for (const [id, label] of [
    ['running', 'In progress'],
    ['waiting', 'Waiting'],
    ['failed', 'Failed'],
    ['done', 'Completed · Unread'],
  ]) {
    await expect(
      page.getByTestId(`home-task-${id}`).getByLabel(label, { exact: true })
    ).toHaveCount(1)
  }
  const interrupted = page.getByTestId('home-task-paused')
  await expect(interrupted).toBeVisible()
  await expect(interrupted.getByText('Paused', { exact: true })).toBeVisible()
  await expect(interrupted.locator('[aria-label]')).toHaveCount(0)
  await interrupted.click()
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'actions').at(-1)), [
    'session',
    'paused',
  ])
  await expect(
    page.getByTestId('home-task-viewed').getByLabel('Completed · Viewed', { exact: true })
  ).toHaveCount(0)
  await page.evaluate(() =>
    Reflect.get(window, 'probe').update(
      Reflect.get(window, 'rows'),
      [{ id: 'running', status: 'waiting', title: 'Running' }],
      { done: 10, viewed: 10 },
      { viewed: 1 }
    )
  )
  await expect(
    page.getByTestId('home-task-running').getByLabel('Waiting', { exact: true })
  ).toHaveCount(1)
  await expect(
    page.getByTestId('home-task-done').getByLabel('Completed · Viewed', { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByTestId('home-task-viewed').getByLabel('Completed · Unread', { exact: true })
  ).toHaveCount(1)
  await page.evaluate(() => {
    Reflect.get(window, 'homeState').activeSession = 'viewed'
    Reflect.get(window, 'probe').update(
      Reflect.get(window, 'rows'),
      Reflect.get(window, 'homeState').sessions,
      { done: 10, viewed: 10 },
      { viewed: 1 }
    )
  })
  await expect(
    page.getByTestId('home-task-viewed').getByLabel('Completed · Unread', { exact: true })
  ).toHaveCount(1)
  await page.evaluate(() =>
    Reflect.get(window, 'probe').update(
      Reflect.get(window, 'rows'),
      Reflect.get(window, 'homeState').sessions,
      { done: 10, viewed: 10 },
      {}
    )
  )
  await expect(
    page.getByTestId('home-task-viewed').getByLabel('Completed · Viewed', { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByTestId('home-task-failed').getByLabel('Failed', { exact: true })
  ).toHaveCount(1)
  await expect(previousTasks).toBeDisabled()
  await expect(nextTasks).toBeDisabled()
  await expect(page.getByRole('searchbox')).toHaveCount(1)
  await page.evaluate(
    (pageSize) =>
      Reflect.get(window, 'probe').projects(
        Array.from({ length: pageSize + 1 }, (_, index) => ({
          id: `project-${index}`,
          name: `Project ${index}`,
          path: `/project-${index}`,
          pinned: index < pageSize,
        }))
      ),
    HOME_PROJECT_PAGE_SIZE
  )
  const cards = page.getByTestId('home-projects-grid').getByTestId(/^home-project-/)
  const previousProjects = page.getByTestId('home-projects-previous')
  const nextProjects = page.getByTestId('home-projects-next')
  await expect(cards).toHaveCount(HOME_PROJECT_PAGE_SIZE)
  await expect(previousProjects).toBeDisabled()
  await expect(nextProjects).toBeEnabled()
  await nextProjects.focus()
  await page.keyboard.press('Enter')
  await expect(cards).toHaveCount(1)
  await expect(cards).toHaveAttribute(
    'data-testid',
    `home-project-Project ${HOME_PROJECT_PAGE_SIZE}`
  )
  await expect(nextProjects).toBeDisabled()
  await cards.click()
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'actions').slice(-2)), [
    ['project', `project-${HOME_PROJECT_PAGE_SIZE}`],
    ['view', 'resource'],
  ])
  await search.fill('Project 0')
  await expect(cards).toHaveCount(1)
  await expect(cards).toHaveAttribute('data-testid', 'home-project-Project 0')
  await expect(previousProjects).toBeDisabled()
  await expect(nextProjects).toBeDisabled()
  await search.fill('')
  await nextProjects.click()
  await page.evaluate(() =>
    Reflect.get(window, 'probe').projects(Reflect.get(window, 'homeState').projects.slice(0, 2))
  )
  await expect(cards).toHaveCount(2)
  await expect(previousProjects).toBeDisabled()
  await expect(nextProjects).toBeDisabled()
  assert.deepEqual(
    await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
    ['home-project-Project 0', 'home-project-Project 1']
  )

  const now = Math.floor(Date.now() / 1000)
  await page.evaluate(
    (clock) =>
      Reflect.get(window, 'probe').update([
        {
          session_id: 'new-user-message',
          project_path: '/project-0',
          title: 'New user message',
          mtime: clock - 10,
          last_agent_reply_at: clock - 3600,
        },
        {
          session_id: 'new-agent-reply',
          project_path: '/project-0',
          title: 'New Agent reply',
          mtime: clock - 600,
          last_agent_reply_at: clock - 600,
        },
        {
          session_id: 'no-agent-reply',
          project_path: '/project-0',
          title: 'No Agent reply',
          mtime: clock,
          last_agent_reply_at: null,
        },
      ]),
    now
  )
  await expect(tasks).toHaveCount(3)
  assert.deepEqual(
    await tasks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
    ['home-task-no-agent-reply', 'home-task-new-user-message', 'home-task-new-agent-reply']
  )
  await expect(page.getByTestId('home-task-new-agent-reply')).toContainText('10 minutes ago')
  await expect(page.getByTestId('home-task-no-agent-reply')).toContainText('now')
  await expect(page.getByTestId('home-task-new-user-message')).toContainText('now')
  await page.evaluate((clock) => {
    Reflect.get(window, 'probe').projects([
      { id: 'project-0', name: 'Older', path: '/project-0', added_at: clock - 7200 },
      { id: 'project-1', name: 'Newer', path: '/project-1', added_at: clock - 3600 },
    ])
    Reflect.get(window, 'probe').update([
      {
        session_id: 'newer-activity',
        project_path: '/project-1',
        title: 'Newer activity',
        mtime: clock,
      },
    ])
  }, now)
  await expect(page.getByTestId('home-task-newer-activity')).toBeVisible()
  await expect(cards.first()).toHaveAttribute('data-testid', 'home-project-Newer')
  await page.evaluate((clock) => {
    Reflect.get(window, 'probe').update([
      {
        session_id: 'latest-activity',
        project_path: '/project-0',
        title: 'Latest activity',
        mtime: clock + 60,
        last_agent_reply_at: clock + 60,
      },
    ])
  }, now)
  await expect(page.getByTestId('home-task-latest-activity')).toBeVisible()
  await expect(cards.first()).toHaveAttribute('data-testid', 'home-project-Older')
  await expect(cards.last()).toHaveAttribute('data-testid', 'home-project-Newer')
  await page.evaluate((clock) => {
    Reflect.get(window, 'probe').projects([
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `inactive-${index}`,
        name: `Inactive ${index}`,
        path: `/inactive-${index}`,
        added_at: clock,
      })),
      { id: 'project-0', name: 'Older', path: '/project-0', added_at: clock - 7200 },
    ])
  }, now)
  await page.getByTestId('home-projects-previous').click()
  await expect(cards).toHaveCount(5)
  await expect(cards.first()).toHaveAttribute('data-testid', 'home-project-Older')
  await expect(cards.first()).toContainText('now')
  await context.test('long metadata cannot expand the task title grid track', async () => {
    const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
    const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
      readFileSync(stylesheet, 'utf8'),
      { from: stylesheet }
    )
    await page.addStyleTag({ content: compiled.css })
    const longProject = 'test-超长标题-VeryLongProjectName'.repeat(80)
    const longTitle = '请读取 Windows 项目 PDF test.pdf 并说明核心发现。'.repeat(20)
    await page.evaluate(
      ({ project, title }) => {
        Reflect.get(window, 'probe').projects([
          { id: 'long', name: project, path: '/long', available: true },
          { id: 'short', name: 'Short', path: '/short', available: true },
        ])
        Reflect.get(window, 'probe').update([
          { session_id: 'long', title, project_path: '/long', mtime: 2 },
          { session_id: 'short', title: 'Short', project_path: '/short', mtime: 1 },
        ])
      },
      { project: longProject, title: longTitle }
    )
    const row = page.getByTestId('home-task-long')
    await expect(row).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      for (const width of [1040, 1440]) {
        await page.setViewportSize({ width, height: 840 })
        const contained = await row.evaluate((element) => {
          const bounds = element.getBoundingClientRect()
          const texts = Array.from(
            element.querySelectorAll<HTMLElement>('[data-slot="ellipsis-text"]')
          )
          const date = texts[0].parentElement!.nextElementSibling!
          return (
            element.scrollWidth <= element.clientWidth &&
            date.getBoundingClientRect().right <= bounds.right &&
            texts.length === 2 &&
            texts.every(
              (text) =>
                text.clientWidth > 0 &&
                text.scrollWidth > text.clientWidth &&
                text.getBoundingClientRect().right <= bounds.right &&
                getComputedStyle(text).textOverflow === 'ellipsis'
            )
          )
        })
        assert.ok(contained, `${theme} at ${width}px must truncate both lines and retain the date`)
        const shortText = page.getByTestId('home-task-short').locator('[data-slot="ellipsis-text"]')
        assert.ok(
          await shortText.evaluateAll((texts) =>
            texts.every((text) => text.scrollWidth === text.clientWidth)
          )
        )
        await row.locator('[data-slot="ellipsis-text"]').last().hover()
        await expect(page.getByRole('tooltip')).toHaveText(longProject)
        await page.mouse.move(0, 0)
        await expect(page.getByRole('tooltip')).toHaveCount(0)
      }
    }
  })
})
