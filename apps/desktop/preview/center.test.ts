import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { expect, type Response } from '@playwright/test'
import { createServer } from 'vite'
import { renderFixture } from '../src/test-helpers/render.ts'
import { RENDERER_OPTIMIZE_DEPS, supportedFontSources } from '../renderer.ts'
import { WORKSPACE_WINDOW_SIZE } from '../src/window.ts'
import { createPreviewService } from './service.ts'
import { servePreviewOfficeFrame } from './plugin.ts'
import { PREVIEW_HOME } from './home.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }
import { PREVIEW_CATALOG } from './catalog.ts'
import { styles } from '../scripts/shared/styles.cjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENTRY = '/__center-consumer.ts'
const OUTPUT = join(ROOT, 'test-results', 'pdfe-center-headless')

test('headless project center consumes declared scenarios, page actions and shared Mock controls', { timeout: 180_000 }, async context => {
  const service = createPreviewService()
  const source = (file: string) => '/@fs/' + join(ROOT, file).split('\\').join('/')
  const fixture = await renderFixture(join(ROOT, 'src/renderer'), {
    create: config => createServer({ ...config, css: { postcss: styles('pdfe') }, plugins: [...config.plugins ?? [], supportedFontSources(), {
      name: 'pdfe-project-center-consumer',
      resolveId(id) { if (id === ENTRY) return id },
      load(id) {
        if (id !== ENTRY) return
        return `
          import { installPreviewBridge } from ${JSON.stringify(source('preview/bridge.ts'))};
          const controls = new URL(location.href).searchParams.has('testControls');
          if (controls) window.pdfe = {
            kind: 'controls', dock: 'detached', platform: 'browser', version: 'test',
            onDockChange: () => () => {},
            reload: async () => {
              const count = Number(document.documentElement.dataset.testReloads ?? 0) + 1;
              document.documentElement.dataset.testReloads = String(count);
              if (new URL(location.href).searchParams.has('testReloadFailure') && count === 1) throw new Error('Test host reload failure');
            },
          };
          await installPreviewBridge();
          if (controls) {
            const { mountConsole } = await import(${JSON.stringify(source('preview/Console.tsx'))});
            mountConsole();
          } else {
            const { mountPreviewHost } = await import(${JSON.stringify(source('preview/host.tsx'))});
            mountPreviewHost('page-home');
          }
        `
      },
      transformIndexHtml(html) { return html.replace('/src/main.tsx', ENTRY) },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!servePreviewOfficeFrame(request, response)) service.middleware(request, response, next)
        })
      },
    }], optimizeDeps: RENDERER_OPTIMIZE_DEPS, server: { ...config.server, fs: { allow: [ROOT] } } }),
  })
  context.after(async () => { await fixture.close(); service.dispose() })
  mkdirSync(OUTPUT, { recursive: true })
  const page = await fixture.page(context)
  await page.setViewportSize(WORKSPACE_WINDOW_SIZE)
  const errors: string[] = []
  const requests: { event: string; path: string; at: number; status?: number }[] = []
  page.on('request', request => {
    if (request.url().startsWith(fixture.url)) requests.push({ event: 'request', path: new URL(request.url()).pathname, at: Date.now() })
  })
  const unhandled = new Set<string>()
  page.on('response', response => {
    if (response.url().startsWith(fixture.url)) requests.push({ event: 'response', path: new URL(response.url()).pathname, status: response.status(), at: Date.now() })
    if (response.status() === 501) unhandled.add(response.request().method() + ' ' + new URL(response.url()).pathname)
  })
  page.on('pageerror', error => { errors.push(error.message); context.diagnostic(error.stack ?? error.message) })
  page.on('console', message => { if (message.type() === 'error') context.diagnostic(message.text()) })
  page.on('requestfailed', request => context.diagnostic(request.url() + ': ' + request.failure()?.errorText))
  const open = async (scene: string) => {
    requests.length = 0
    const reset = await page.request.post(fixture.url + '__preview/reset?previewInstance=center-ui', { data: { pageId: 'page-home', scene } })
    assert.equal(reset.status(), 200)
    const policy = PREVIEW_CATALOG.find(page => page.id === 'page-home')!.scenarios.find(entry => entry.id === scene)?.home
    const projectRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/content/projects' && response.request().method() === 'GET')
    await page.goto(fixture.url + '?previewInstance=center-ui&page=page-home&scene=' + scene)
    // Navigation finishes before the dynamically imported renderer bootstraps.
    // Observe its real startup read (including declared failures) before checking UI.
    await (await projectRead).finished()
    if (policy?.projectRead === 'failed') {
      await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible()
      await expect(page.getByTestId('home-projects-empty')).toHaveCount(0)
      await control.goto(fixture.url + '?previewInstance=center-ui&page=page-home&scene=' + scene + '&testControls')
      await control.getByTestId('preview-home-projects-recover').click()
      await page.getByRole('button', { name: '重新加载', exact: true }).click()
    }
    try { await expect(page.getByTestId('project-center')).toBeVisible() }
    catch (error) {
      writeFileSync(join(OUTPUT, 'startup-failure.json'), JSON.stringify({ scene, url: page.url(), errors, requests, text: await page.locator('body').innerText() }, null, 2))
      await page.screenshot({ path: join(OUTPUT, 'startup-failure.png') })
      throw error
    }
  }
  const expectTasksHidden = async () => {
    await expect(page.locator('#home-tasks-heading')).toHaveCount(0)
    await expect(page.getByTestId('home-tasks-list')).toHaveCount(0)
    await expect(page.getByTestId('home-tasks-previous')).toHaveCount(0)
    await expect(page.getByTestId('home-tasks-next')).toHaveCount(0)
  }
  await open('home-empty')
  await expect(page.getByTestId('home-projects-empty')).toBeVisible()
  await expectTasksHidden()
  await expect(page.getByTestId('home-project-create-empty')).toBeVisible()
  await page.screenshot({ path: join(OUTPUT, 'empty-project-guidance.png') })
  await open('home-create')
  await page.getByTestId('home-project-create-empty').click()
  await expect(page.getByTestId('project-new-modal')).toBeVisible()
  await page.getByTestId('project-create-name').fill('项目中心创建闭环')
  await page.getByTestId('project-create').click()
  await expect(page.getByTestId('project-new-modal')).toHaveCount(0)
  const created = await page.request.get(fixture.url + 'api/content/projects?previewInstance=center-ui')
  assert.equal(created.status(), 200)
  const createdProjects = (await created.json()).projects
  assert.equal(createdProjects.length, 1)
  assert.equal(createdProjects[0].name, '项目中心创建闭环')
  await page.reload()
  const retained = await page.request.get(fixture.url + 'api/content/projects?previewInstance=center-ui')
  assert.equal((await retained.json()).projects[0].id, createdProjects[0].id)
  await open('home-empty')
  await expect(page.getByTestId('home-projects-empty')).toBeVisible()
  await expectTasksHidden()

  await open('home-no-tasks')
  await expect(page.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')).toHaveCount(3)
  await expectTasksHidden()
  await expect(page.getByTestId('home-projects-grid').locator('../..')).toHaveClass(/grid-cols-1/)
  await page.screenshot({ path: join(OUTPUT, 'projects-expanded-without-tasks.png') })

  await open('home-long-content')
  await expect(page.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')).toHaveCount(3)
  await expect(page.locator('[data-testid^="home-task-"]')).toHaveCount(PREVIEW_HOME.taskPage)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.getByTestId('home-tasks-next').click()
  await expect(page.getByTestId('home-tasks-next')).toBeDisabled()
  const lastLongTask = page.getByTestId('home-task-preview-session-' + (PREVIEW_HOME.taskPage + 1))
  await expect(lastLongTask).toBeVisible()
  assert.equal(await lastLongTask.evaluate(button => [...button.querySelectorAll('[data-slot="ellipsis-text"]')].every(text => text.getBoundingClientRect().right <= button.getBoundingClientRect().right)), true, 'long task title and project name must fit inside the task button')
  await page.screenshot({ path: join(OUTPUT, 'long-content-last-task.png') })
  await lastLongTask.click()
  await expect(page.getByTestId('composer-input')).toBeVisible()

  await open('home-dense')
  const projects = page.getByTestId('home-projects-grid').locator('button[data-testid^="home-project-"]:not([aria-haspopup])')
  const tasks = page.locator('[data-testid^="home-task-"]')
  await expect(projects).toHaveCount(PREVIEW_HOME.projectPage)
  await expect(tasks).toHaveCount(PREVIEW_HOME.taskPage)
  await page.getByRole('searchbox', { name: '搜索项目', exact: true }).fill('not-a-matching-project')
  await expect(page.getByTestId('home-projects-no-results')).toBeVisible()
  await expect(page.getByTestId('home-projects-empty')).toHaveCount(0)
  await expect(tasks).toHaveCount(PREVIEW_HOME.taskPage)
  await page.getByRole('searchbox', { name: '搜索项目', exact: true }).fill('')
  for (let offset = PREVIEW_HOME.projectPage; offset < PREVIEW_HOME.projects; offset += PREVIEW_HOME.projectPage) await page.getByTestId('home-projects-next').click()
  await expect(page.getByTestId('home-projects-next')).toBeDisabled()
  await expect(page.getByTestId('home-project-模拟项目 ' + PREVIEW_HOME.projects)).toBeVisible()
  for (let offset = PREVIEW_HOME.taskPage; offset < PREVIEW_HOME.tasks; offset += PREVIEW_HOME.taskPage) await page.getByTestId('home-tasks-next').click()
  await expect(page.getByTestId('home-tasks-next')).toBeDisabled()
  await expect(page.getByTestId('home-task-preview-session-' + PREVIEW_HOME.tasks)).toBeVisible()
  await page.screenshot({ path: join(OUTPUT, 'dense-last-projects-and-tasks.png') })
  const denseSnapshot = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const denseBefore = await denseSnapshot.json()
  const lastProject = denseBefore.projects.at(-1)
  const lastTask = denseBefore.sessions.find((session: { session_id: string }) => session.session_id === 'preview-session-' + PREVIEW_HOME.tasks)
  const taskProject = denseBefore.projects.find((project: { root: string }) => project.root === lastTask.project_path)
  assert.ok(lastProject && taskProject)
  const readyComposer = async (draft: string) => {
    const input = page.getByTestId('composer-input')
    await expect(input).toBeEditable()
    await input.fill(draft)
    await expect(input).toHaveValue(draft)
    await expect(page.getByTestId('ai-context-loading')).toHaveCount(0)
  }
  await page.getByTestId('home-project-' + lastProject.name).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('project-navigation-selector')).toContainText(lastProject.name)
  await readyComposer('核对末页项目的输入能力')
  await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'dense-open-last-project.png') })
  await page.getByTestId('composer-input').clear()
  await page.getByTestId('project-navigation-home').click()
  await expect(page.getByTestId('project-center')).toBeVisible()
  await expect(page.getByTestId('home-tasks-previous')).toBeDisabled()
  for (let offset = PREVIEW_HOME.taskPage; offset < PREVIEW_HOME.tasks; offset += PREVIEW_HOME.taskPage) await page.getByTestId('home-tasks-next').click()
  await page.getByTestId('home-task-preview-session-' + PREVIEW_HOME.tasks).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('project-navigation-selector')).toContainText(taskProject.name)
  await readyComposer('核对末页任务的输入能力')
  await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'dense-open-last-task.png') })
  await page.getByTestId('composer-input').clear()
  await page.getByTestId('project-navigation-home').click()
  await expect(page.getByTestId('project-center')).toBeVisible()
  const denseReentry = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const denseAfter = await denseReentry.json()
  assert.deepEqual(denseAfter.projects, denseBefore.projects)
  const identities = (sessions: { session_id: string; project_path: string }[]) => sessions.map(session => ({ id: session.session_id, project: session.project_path }))
  assert.deepEqual(identities(denseAfter.sessions), identities(denseBefore.sessions))

  await page.goto('about:blank')
  const batches: number[] = []
  const receiveBatch = async (response: Response) => {
    const url = new URL(response.url())
    if (url.pathname === '/api/serve/sessions' && url.searchParams.get('scope') === 'all' && url.searchParams.get('limit') === String(PREVIEW_HOME.sessionPage) && response.ok()) batches.push((await response.json()).sessions.length)
  }
  page.on('response', receiveBatch)
  await open('home-cross-batch')
  await expect(tasks).toHaveCount(PREVIEW_HOME.taskPage)
  await expect.poll(() => batches.includes(PREVIEW_HOME.sessionPage) && batches.includes(1)).toBe(true)
  for (let offset = PREVIEW_HOME.taskPage; offset < PREVIEW_HOME.sessionPage + 1; offset += PREVIEW_HOME.taskPage) await page.getByTestId('home-tasks-next').click()
  await expect(tasks).toHaveCount((PREVIEW_HOME.sessionPage + 1) % PREVIEW_HOME.taskPage)
  await expect(page.getByTestId('home-task-preview-session-' + (PREVIEW_HOME.sessionPage + 1))).toBeVisible()
  await expect(page.getByTestId('home-tasks-next')).toBeDisabled()
  await page.screenshot({ path: join(OUTPUT, 'cross-batch-last-task.png') })
  page.off('response', receiveBatch)
  const crossSnapshot = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const crossBefore = await crossSnapshot.json()
  const crossTask = crossBefore.sessions.find((session: { session_id: string }) => session.session_id === 'preview-session-' + (PREVIEW_HOME.sessionPage + 1))
  const crossProject = crossBefore.projects.find((project: { root: string }) => project.root === crossTask.project_path)
  assert.ok(crossProject)
  await page.getByTestId('home-task-' + crossTask.session_id).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByTestId('project-navigation-selector')).toContainText(crossProject.name)
  await readyComposer('核对跨批末条任务的输入能力')
  await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'cross-batch-open-last-task.png') })
  await page.getByTestId('composer-input').clear()
  await page.getByTestId('project-navigation-home').click()
  await expect(page.getByTestId('project-center')).toBeVisible()
  const crossReentry = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const crossAfter = await crossReentry.json()
  assert.deepEqual(crossAfter.projects, crossBefore.projects)
  assert.deepEqual(identities(crossAfter.sessions), identities(crossBefore.sessions))
  await open('home-project-actions')
  const initialProjects = await page.request.get(fixture.url + 'api/content/projects?previewInstance=center-ui')
  const editableProjects = (await initialProjects.json()).projects
  const editedProject = editableProjects[PREVIEW_HOME.projectPage]
  const archivedProject = editableProjects[PREVIEW_HOME.projectPage - 1]
  await page.getByTestId('home-projects-next').click()
  await page.getByTestId('home-project-' + editedProject.name).hover()
  await page.getByTestId('home-project-menu-' + editedProject.id).click()
  await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'project-actions-menu.png') })
  await page.getByTestId('home-rename-' + editedProject.id).click()
  await expect(page.getByTestId('project-edit-modal')).toBeVisible()
  const renamedProject = '项目中心编辑后的项目'
  await page.getByTestId('project-edit-name').fill(renamedProject)
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-edit-modal')).toHaveCount(0)
  await expect(page.getByTestId('home-project-' + renamedProject)).toBeVisible()
  await page.getByTestId('home-project-' + renamedProject).hover()
  await page.getByTestId('home-project-menu-' + editedProject.id).click()
  await page.getByTestId('home-pin-' + editedProject.id).click()
  await expect(page.getByTestId('home-project-' + archivedProject.name)).toBeVisible()
  await page.getByTestId('home-projects-previous').click()
  await expect(projects.first()).toContainText(renamedProject)
  await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'project-pinned-first-page.png') })
  await page.getByTestId('home-project-' + renamedProject).click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect(page.getByRole('navigation', { name: '任务', exact: true }).getByRole('button', { name: renamedProject, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(page.getByTestId('project-center')).toBeVisible()
  await page.getByTestId('home-task-preview-session').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await page.getByRole('button', { name: '返回项目中心', exact: true }).click()
  await expect(page.getByTestId('project-center')).toBeVisible()
  await page.getByTestId('home-projects-next').click()
  await page.getByTestId('home-project-' + archivedProject.name).hover()
  await page.getByTestId('home-project-menu-' + archivedProject.id).click()
  await page.getByTestId('home-archive-' + archivedProject.id).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByTestId('home-archive-confirm').click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(projects).toHaveCount(PREVIEW_HOME.projectPage)
  await expect(page.getByTestId('home-projects-previous')).toBeDisabled()
  await expect(page.getByTestId('home-projects-next')).toBeDisabled()
  await expect(page.getByTestId('home-project-' + archivedProject.name)).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'archive-last-page-clamped.png') })
  for (const scene of ['home-open-project', 'home-open-task']) {
    await open(scene)
    const snapshot = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
    const original = await snapshot.json()
    await expect(projects).toHaveCount(Math.min(original.projects.length, PREVIEW_HOME.projectPage))
    for (let visit = 0; visit < 2; visit += 1) {
      if (scene === 'home-open-task') await page.getByTestId('home-task-preview-session').click()
      else await projects.first().click()
      await expect(page.getByTestId('composer-input')).toBeVisible()
      await expect(page.getByTestId('project-navigation-selector')).toContainText(original.projects[0].name)
      await page.getByTestId('project-navigation-home').click()
      await expect(page.getByTestId('project-center')).toBeVisible()
    }
    const reentered = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
    const retained = await reentered.json()
    assert.deepEqual(retained.sessions.map((session: { session_id: string }) => session.session_id), original.sessions.map((session: { session_id: string }) => session.session_id))
    assert.deepEqual(retained.projects, original.projects)
  }
  await open('home-no-tasks')
  const control = await fixture.page(context)
  control.on('pageerror', error => errors.push(error.message))
  await control.setViewportSize({ width: 420, height: WORKSPACE_WINDOW_SIZE.height })
  await control.goto(fixture.url + '?previewInstance=center-ui&page=page-home&scene=home-no-tasks&testControls')
  const beforeControls = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const originalProjects = (await beforeControls.json()).projects
  let dictionary = zh
  const choose = async (label: string, option: string) => {
    await control.getByRole('combobox', { name: label, exact: true }).click()
    await control.getByRole('option', { name: option, exact: true }).click()
    await expect(control.locator('html')).toHaveAttribute('data-test-reloads', '1')
    await control.reload()
  }
  for (const combination of [
    { login: 'anonymous', theme: 'dark', language: 'en' },
    { login: 'ready', theme: 'light', language: 'zh' },
  ] as const) {
    await expect(control.getByRole('combobox', { name: dictionary.loginState })).toBeEnabled()
    await choose(dictionary.loginState, combination.login === 'ready' ? dictionary.mockLoggedIn : dictionary.mockLoggedOut)
    await choose(dictionary.theme, dictionary[combination.theme])
    await choose(dictionary.language, combination.language === 'en' ? dictionary.english : dictionary.chinese)
    dictionary = combination.language === 'en' ? en : zh
    await expect(control.getByRole('group', { name: dictionary.publicControls })).toBeVisible()
    await expect(control.getByTestId('preview-current-scene')).toContainText(dictionary.pageProjectCenter)
    await expect(control.getByRole('combobox', { name: dictionary.loginState })).toContainText(combination.login === 'ready' ? dictionary.mockLoggedIn : dictionary.mockLoggedOut)
    await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-' + combination.login + '-' + combination.theme + '-' + combination.language + '.png') })
    const helpButton = control.getByRole('button', { name: dictionary.guide, exact: true })
    await helpButton.click()
    const guide = control.getByRole('dialog', { name: dictionary.guide, exact: true })
    await expect(guide).toBeVisible()
    await expect(guide.getByText(dictionary.homeNoTasksExpected, { exact: true })).toBeVisible()
    const commonGuide = guide.getByRole('button', { name: dictionary.guideCommon, exact: true })
    await expect(commonGuide).toHaveAttribute('aria-expanded', 'false')
    await commonGuide.click()
    await expect(guide).toContainText(dictionary.publicControlScope)
    if (combination.language === 'en') assert.doesNotMatch(await guide.innerText(), /[\u3400-\u9fff]/u, 'project center English guidance must not fall back to Chinese catalog prose')
    await commonGuide.click()
    await expect(commonGuide).toHaveAttribute('aria-expanded', 'false')
    await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'guide-' + combination.language + '.png') })
    await guide.press('Escape')
    await expect(guide).toHaveCount(0)
    await expect(helpButton).toBeFocused()
    assert.equal(await control.evaluate(() => document.documentElement.dataset.testReloads ?? null), null)
    const search = control.getByRole('searchbox', { name: dictionary.discovery, exact: true })
    await search.fill('home-project-actions')
    const homeNavigation = control.getByTestId('preview-capabilities-page-home')
    await expect(homeNavigation.locator('[data-testid^="preview-scene-page-home-"]')).toHaveCount(1)
    await expect(control.getByTestId('preview-section-page-home-areaBoundaries')).toHaveAttribute('aria-expanded', 'true')
    await expect(control.getByTestId('preview-scene-page-home-home-project-actions')).toBeVisible()
    await expect(control.getByTestId('preview-section-page-home-areaDaily')).toHaveCount(0)
    assert.equal(await control.evaluate(() => document.documentElement.dataset.testReloads ?? null), null)
    await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-search-' + combination.language + '.png') })
    await search.fill('')
    await expect(control.getByTestId('preview-section-page-home-areaDaily')).toHaveAttribute('aria-expanded', 'true')
    await expect(control.getByTestId('preview-section-page-home-areaBoundaries')).toHaveAttribute('aria-expanded', 'false')
    await control.getByTestId('preview-section-page-home-areaDaily').press('Space')
    await expect(control.getByTestId('preview-section-page-home-areaDaily')).toHaveAttribute('aria-expanded', 'false')
    await control.getByTestId('preview-section-page-home-areaBoundaries').click()
    await control.getByTestId('preview-family-page-home-homeProjectBoundaryGroup').click()
    await expect(control.getByTestId('preview-scene-page-home-home-projects-' + (PREVIEW_HOME.projectPage + 1))).toBeVisible()
    const overflow = await homeNavigation.evaluate(root => [...root.querySelectorAll('p, button')].filter(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.width > 0 && (Math.ceil(bounds.right) > Math.ceil(root.getBoundingClientRect().right) || element.scrollWidth > element.clientWidth)
    }).map(element => ({
      text: element.textContent,
      rootRight: root.getBoundingClientRect().right,
      right: element.getBoundingClientRect().right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      children: [...element.querySelectorAll('span')].map(child => ({ text: child.textContent, width: child.getBoundingClientRect().width, right: child.getBoundingClientRect().right, clientWidth: child.clientWidth, scrollWidth: child.scrollWidth, whitespace: getComputedStyle(child).whiteSpace, columns: getComputedStyle(child).gridTemplateColumns })),
    })))
    assert.deepEqual(overflow, [], 'navigation hints and actions must wrap within their container')
    assert.equal(await control.evaluate(() => document.documentElement.dataset.testReloads ?? null), null)
    await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-operations-' + combination.language + '.png') })
    await page.reload()
    await expectTasksHidden()
    await expect(page.locator('html')).toHaveAttribute('data-theme', combination.theme)
    await page.getByTestId('activity-account').click()
    if (combination.login === 'anonymous') await expect(page.getByTestId('account-menu-anonymous-login')).toBeVisible()
    else await expect(page.getByTestId('account-menu-name')).toContainText('模拟协作账号')
    await page.getByTestId('activity-account').click()
    const afterControls = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
    const state = await afterControls.json()
    assert.deepEqual(state.projects, originalProjects)
    assert.equal(state.sessions.length, 0)
    assert.equal(state.account.mode, combination.login)
    assert.equal(state.preferences.theme, combination.theme)
    assert.equal(state.preferences.language, combination.language)
    await page.screenshot({ path: join(OUTPUT, 'center-' + combination.login + '-' + combination.theme + '-' + combination.language + '.png') })
  }
  await open('home-no-tasks')
  await control.goto(fixture.url + '?previewInstance=center-ui&page=page-home&scene=home-no-tasks&testControls&testReloadFailure')
  const beforeFailureResponse = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const beforeFailure = await beforeFailureResponse.json()
  const failedLoginControl = control.getByRole('combobox', { name: zh.loginState, exact: true })
  await expect(failedLoginControl).toBeEnabled()
  await failedLoginControl.click()
  await control.getByRole('option', { name: zh.mockLoggedOut, exact: true }).click()
  await expect(control.getByRole('alert')).toContainText(zh.requestFailed)
  await expect(failedLoginControl).toBeEnabled()
  await expect(failedLoginControl).toContainText(zh.mockLoggedOut)
  const failedStateResponse = await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')
  const failedState = await failedStateResponse.json()
  assert.equal(failedState.account.mode, 'anonymous')
  assert.deepEqual(failedState.projects, beforeFailure.projects)
  assert.deepEqual(identities(failedState.sessions), identities(beforeFailure.sessions))
  assert.deepEqual(failedState.preferences, beforeFailure.preferences)
  await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-reload-failure.png') })
  await control.getByRole('button', { name: zh.reload, exact: true }).click()
  await expect(control.locator('html')).toHaveAttribute('data-test-reloads', '2')
  await expect(control.getByRole('alert')).toHaveCount(0)
  await control.reload()
  await expect(control.getByRole('combobox', { name: zh.loginState, exact: true })).toContainText(zh.mockLoggedOut)
  await page.reload()
  await page.getByTestId('activity-account').click()
  await expect(page.getByTestId('account-menu-anonymous-login')).toBeVisible()
  await page.getByTestId('activity-account').click()
  await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-reload-recovered.png') })
  await choose(zh.theme, zh.dark)
  await choose(zh.language, zh.english)
  for (const pageId of ['page-conversation', 'page-resource', 'page-home']) {
    const target = PREVIEW_CATALOG.find(candidate => candidate.id === pageId)!
    const reset = await page.request.post(fixture.url + '__preview/reset?previewInstance=center-ui', { data: { pageId, scene: target.scenarios[0].id } })
    assert.equal(reset.status(), 200)
    await control.goto(fixture.url + '?previewInstance=center-ui&page=' + pageId + '&scene=' + target.scenarios[0].id + '&testControls')
    await expect(control.getByRole('combobox', { name: en.loginState, exact: true })).toContainText(en.mockLoggedOut)
    await expect(control.getByRole('combobox', { name: en.theme, exact: true })).toContainText(en.dark)
    await expect(control.getByRole('combobox', { name: en.language, exact: true })).toContainText(en.english)
    await expect(control.locator('html')).toHaveAttribute('data-theme', 'dark')
  }
  await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-global-preserved.png') })
  await choose(en.theme, en.light)
  await choose(en.language, en.chinese)
  const beforeSystemTheme = await (await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')).json()
  await control.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await choose(zh.theme, zh.system)
  await page.reload()
  await expect(projects).toHaveCount(Math.min(beforeSystemTheme.projects.length, PREVIEW_HOME.projectPage))
  await expect(tasks).toHaveCount(Math.min(beforeSystemTheme.sessions.length, PREVIEW_HOME.taskPage))
  for (const colorScheme of ['dark', 'light'] as const) {
    await control.emulateMedia({ colorScheme })
    await page.emulateMedia({ colorScheme })
    await expect(control.locator('html')).toHaveAttribute('data-theme', colorScheme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme)
    await expect(control.getByRole('combobox', { name: zh.theme, exact: true })).toContainText(zh.system)
    const state = await (await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')).json()
    assert.equal(state.preferences.theme, 'system')
    assert.equal(state.preferences.language, beforeSystemTheme.preferences.language)
    assert.equal(state.login, beforeSystemTheme.login)
    assert.deepEqual(state.projects, beforeSystemTheme.projects)
    assert.deepEqual(state.sessions, beforeSystemTheme.sessions)
    await control.screenshot({ animations: 'disabled', path: join(OUTPUT, 'controls-system-' + colorScheme + '.png') })
    await page.screenshot({ animations: 'disabled', path: join(OUTPUT, 'center-system-' + colorScheme + '.png') })
  }
  await open('home-empty')
  await control.goto(fixture.url + '?previewInstance=center-ui&page=page-home&scene=home-empty&testControls')
  await expect(control.getByRole('combobox', { name: zh.theme, exact: true })).toContainText(zh.system)
  await expect(page.getByTestId('home-projects-empty')).toBeVisible()
  for (const surface of [page, control]) {
    await surface.emulateMedia({ colorScheme: 'dark' })
    await expect(surface.locator('html')).toHaveAttribute('data-theme', 'dark')
  }
  const resetSystemTheme = await (await page.request.get(fixture.url + '__preview/state?previewInstance=center-ui')).json()
  assert.equal(resetSystemTheme.preferences.theme, 'system')
  assert.equal(resetSystemTheme.projects.length, 0)
  assert.equal(resetSystemTheme.sessions.length, 0)
  await choose(zh.theme, zh.light)
  await page.reload()
  for (const surface of [page, control]) {
    await expect(surface.locator('html')).toHaveAttribute('data-theme', 'light')
    await surface.emulateMedia({ colorScheme: null })
  }
  const observations = []
  for (const scenario of PREVIEW_CATALOG.find(page => page.id === 'page-home')!.scenarios) {
    await open(scenario.id)
    const policy = scenario.home!
    if (policy.read === 'fail-once') {
      await expect(page.getByTestId('project-center').getByRole('status').filter({ hasText: '无法读取任务，请重试' })).toBeVisible()
      await expect(page.getByTestId('home-tasks-empty')).toHaveCount(0)
      await page.getByRole('button', { name: '重试', exact: true }).click()
    }
    if (policy.projects === 0) await expect(page.getByTestId('home-projects-empty')).toBeVisible()
    await expect(projects).toHaveCount(Math.min(policy.projects, PREVIEW_HOME.projectPage))
    const showTasks = policy.projects > 0 && policy.tasks > 0
    if (!showTasks) await expectTasksHidden()
    if (policy.projects > 0) await expect(page.getByTestId('home-projects-grid').locator('../..')).toHaveClass(showTasks ? /grid-cols-2/ : /grid-cols-1/)
    await expect(page.getByTestId('home-tasks-list')).toHaveCount(showTasks ? 1 : 0)
    await expect(tasks).toHaveCount(showTasks ? Math.min(policy.tasks, PREVIEW_HOME.taskPage) : 0)
    if (policy.projects > 0) await expect(page.getByTestId('home-projects-previous')).toBeDisabled()
    else await expect(page.getByTestId('home-projects-previous')).toHaveCount(0)
    if (showTasks) await expect(page.getByTestId('home-tasks-previous')).toBeDisabled()
    else await expect(page.getByTestId('home-tasks-previous')).toHaveCount(0)
    if (policy.projects > PREVIEW_HOME.projectPage) await expect(page.getByTestId('home-projects-next')).toBeEnabled()
    else if (policy.projects > 0) await expect(page.getByTestId('home-projects-next')).toBeDisabled()
    else await expect(page.getByTestId('home-projects-next')).toHaveCount(0)
    if (!showTasks) await expect(page.getByTestId('home-tasks-next')).toHaveCount(0)
    else if (policy.tasks > PREVIEW_HOME.taskPage) await expect(page.getByTestId('home-tasks-next')).toBeEnabled()
    else await expect(page.getByTestId('home-tasks-next')).toBeDisabled()
    observations.push({ id: scenario.id, section: scenario.section, policy, visibleProjectRows: await projects.count(), visibleTaskRows: await tasks.count() })
  }
  const formReset = await page.request.post(fixture.url + '__preview/reset?previewInstance=center-ui', { data: { pageId: 'surface-project-form', scene: 'surface-project-form-states' } })
  assert.equal(formReset.status(), 200)
  const formState = await formReset.json()
  await page.goto(fixture.url + '?previewInstance=center-ui&page=surface-project-form&scene=surface-project-form-states')
  await expect(page.getByTestId('project-center')).toBeVisible()
  await page.getByTestId('home-project-create-top').click()
  await expect(page.getByTestId('project-new-modal')).toBeVisible()
  await page.screenshot({ path: join(OUTPUT, 'daily-project-form.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-new-modal')).toHaveCount(0)
  const formProject = formState.projects[0]
  await page.getByTestId('home-project-' + formProject.name).hover()
  await page.getByTestId('home-project-menu-' + formProject.id).click()
  await page.getByTestId('home-rename-' + formProject.id).click()
  await expect(page.getByTestId('project-edit-modal')).toBeVisible()
  await expect(page.getByTestId('project-edit-name')).toHaveValue(formProject.name)
  await page.screenshot({ path: join(OUTPUT, 'daily-project-edit.png') })
  await page.keyboard.press('Escape')
  assert.deepEqual(errors, [])
  assert.deepEqual([...unhandled], [], 'shared project center must only issue adapted Mock requests')
  writeFileSync(join(OUTPUT, 'scenario-observations.json'), JSON.stringify({ layer: 'headless-shared-renderer/mock-http', nativeVerified: false, scope: 'initial page rows and pagination availability; action flows asserted separately in this test', scenarios: observations }, null, 2))
})
