import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page, type Route } from '@playwright/test'
import react from '@vitejs/plugin-react'

import { PROJECT_ENTRY_DRAG_TYPE } from '../../drag.ts'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TREE = '**/api/content/projects/*/tree?*'
const INITIAL_COUNT = 100

function nodes(prefix: string, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `${prefix}-${index}.md`,
    name: `${prefix}-${index}.md`,
    kind: index === INITIAL_COUNT - 1 ? 'dir' : 'file',
    available: true,
    count: null,
  }))
}

async function reply(
  route: Route,
  prefix: string,
  count = INITIAL_COUNT,
  total = INITIAL_COUNT + 1
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      root: '/fixture',
      nodes: nodes(prefix, count),
      total,
      offset: Number(new URL(route.request().url()).searchParams.get('offset')),
    }),
  })
}

async function settleRender(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

for (const departure of ['unmount', 'failed-peer', 'late-expansion'] as const) {
  test(
    'coordinated directory refresh preserves active results and retry after ' + departure,
    { timeout: 60_000 },
    async () => {
      const server = await servers.create({
        cacheKey: 'explorer',
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        const page = await browser.newPage()
        const candidatePending = Promise.withResolvers<void>()
        const peerPending = Promise.withResolvers<Route>()
        let refreshing = false
        let retry = false
        await page.route(TREE, async (route) => {
          const directory = new URL(route.request().url()).searchParams.get('path')
          if (departure === 'unmount' && refreshing && directory === 'candidate') {
            candidatePending.resolve()
            return
          }
          if (departure === 'late-expansion' && refreshing && directory === 'peer') {
            peerPending.resolve(route)
            return
          }
          if (
            departure === 'failed-peer' &&
            ((!refreshing && directory === 'candidate') ||
              (refreshing && !retry && directory === 'peer'))
          ) {
            await route.fulfill({ status: 503, json: {} })
            return
          }
          const entries = directory
            ? [{ path: directory + (refreshing ? '/new.md' : '/old.md'), kind: 'file' }]
            : [
                { path: 'candidate', kind: 'dir' },
                { path: 'peer', kind: 'dir' },
              ]
          await route.fulfill({
            json: {
              root: '/fixture',
              nodes: entries.map((node) => ({ ...node, name: node.path, available: true })),
              total: entries.length,
              offset: 0,
            },
          })
        })
        await page.goto(
          new URL('/features/project/explorer.render.fixture.html', server.resolvedUrls!.local[0])
            .href
        )
        const toggle = page.getByTestId('explorer-select-candidate')
        const candidateError = page.getByTestId('explorer-directory-error-candidate')
        if (departure !== 'late-expansion') await toggle.click()
        await page.getByTestId('explorer-select-peer').click()
        await expect(page.getByTestId('explorer-node-peer/old.md')).toBeVisible()
        if (departure === 'unmount') {
          await expect(page.getByTestId('explorer-node-candidate/old.md')).toBeVisible()
        } else if (departure === 'failed-peer') {
          await expect(candidateError).toBeVisible()
        }

        refreshing = true
        await page.getByTestId('fixture-refresh').click()
        if (departure === 'unmount') {
          await candidatePending.promise
          await expect(page.getByTestId('explorer-node-peer/old.md')).toBeVisible()
          await toggle.click()
          await expect(page.getByTestId('explorer-node-peer/new.md')).toBeVisible()
          await expect(candidateError).toHaveCount(0)
        } else if (departure === 'failed-peer') {
          await expect(page.getByTestId('explorer-directory-error-peer')).toBeVisible()
          await expect(candidateError).toBeVisible()
          await expect(page.getByTestId('explorer-node-candidate/new.md')).toHaveCount(0)
          await expect(page.getByTestId('explorer-node-peer/old.md')).toBeVisible()
          retry = true
          await page.getByTestId('explorer-directory-retry-candidate').click()
          await expect(page.getByTestId('explorer-node-candidate/new.md')).toBeVisible()
          await expect(page.getByTestId('explorer-node-peer/new.md')).toBeVisible()
          await expect(candidateError).toHaveCount(0)
        } else {
          const pending = await peerPending.promise
          await toggle.click()
          await expect(page.getByTestId('explorer-node-candidate/new.md')).toBeVisible()
          await expect(page.getByTestId('explorer-node-peer/old.md')).toBeVisible()
          await pending.fulfill({ status: 503, json: {} })
          await expect(page.getByTestId('explorer-directory-error-peer')).toBeVisible()
          await expect(page.getByTestId('explorer-node-candidate/new.md')).toBeVisible()
          await expect(candidateError).toHaveCount(0)
        }
      } finally {
        await browser.close()
        await server.close()
      }
    }
  )
}

test('Directory moves both folders and files through native drag and drop', async () => {
  const server = await servers.create({
    cacheKey: 'explorer',
    configFile: false,
    root: ROOT,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.route(TREE, (route) =>
      route.fulfill({
        json: {
          root: '/fixture',
          nodes: [
            { path: 'source', name: 'source', kind: 'dir', available: true },
            { path: 'target', name: 'target', kind: 'dir', available: true },
            { path: 'file.md', name: 'file.md', kind: 'file', available: true },
          ],
          total: 3,
          offset: 0,
        },
      })
    )
    await page.goto(
      new URL('/features/project/explorer.render.fixture.html', server.resolvedUrls!.local[0]).href
    )
    await page.evaluate((referenceType) => {
      document.addEventListener('dragstart', (event) => {
        document.getElementById('root')!.dataset.drag = JSON.stringify({
          effectAllowed: event.dataTransfer?.effectAllowed,
          reference: JSON.parse(event.dataTransfer!.getData(referenceType)),
        })
      })
    }, PROJECT_ENTRY_DRAG_TYPE)
    for (const source of ['source', 'file.md']) {
      await page
        .getByTestId(`explorer-select-${source}`)
        .dragTo(page.getByTestId('explorer-node-target'))
      await expect(page.getByTestId('fixture-drop')).toHaveText(
        JSON.stringify({ source, destination: 'target' })
      )
      await expect(page.locator('#root')).toHaveAttribute(
        'data-drag',
        JSON.stringify({
          effectAllowed: 'copyMove',
          reference: {
            projectId: 'first',
            entry: { kind: source === 'source' ? 'dir' : 'file', path: source, name: source },
          },
        })
      )
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test(
  'Directory preserves failed pages, fences stale reads and exposes empty directories',
  { timeout: 120_000 },
  async () => {
    const artifacts = mkdtempSync(path.join(tmpdir(), 'explorer-render-'))
    const server = await servers.create({
      cacheKey: 'explorer',
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      await page.addInitScript(() => {
        const createTimeout = AbortSignal.timeout.bind(AbortSignal)
        const deadlines: AbortController[] = []
        Reflect.set(window, 'treeDeadlines', deadlines)
        AbortSignal.timeout = (ms) => {
          if (ms !== 15_000) return createTimeout(ms)
          const controller = new AbortController()
          deadlines.push(controller)
          return controller.signal
        }
      })
      page.on('pageerror', (error) => {
        errors.push(error.message)
        process.stderr.write(`${error.stack}\n`)
      })
      page.on('console', (message) => {
        if (message.type() === 'error') process.stderr.write(`${message.text()}\n`)
      })
      let failMore = true
      let failInitial = false
      let hold = false
      let empty = false
      let prefix = 'initial'
      const pending: { route: Route; prefix: string }[] = []
      const offsets: number[] = []
      await page.route(TREE, async (route) => {
        const offset = Number(new URL(route.request().url()).searchParams.get('offset'))
        offsets.push(offset)
        if (hold) {
          pending.push({ route, prefix })
          return
        }
        if ((offset > 0 && failMore) || (offset === 0 && failInitial)) {
          await route.fulfill({ status: 503, body: '{}' })
          return
        }
        await reply(
          route,
          offset && prefix === 'retry-after-deadline' ? 'retry-after-deadline-next' : prefix,
          empty ? 0 : offset ? 1 : INITIAL_COUNT,
          empty ? 0 : INITIAL_COUNT + 1
        )
      })
      await page.goto(
        new URL('/features/project/explorer.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT)
      const firstRow = page.getByTestId('explorer-node-initial-0.md')
      const actions = firstRow.getByRole('button').last()
      await page.getByTestId('fixture-refresh').hover()
      await expect(actions).toHaveCSS('opacity', '0')
      await firstRow.hover()
      await expect(actions).toHaveCSS('opacity', '1')
      await expect(actions.locator('.lucide-ellipsis-vertical')).toHaveCount(1)
      await actions.click()
      await page.getByTestId('fixture-refresh').hover()
      await expect(actions).toHaveCSS('opacity', '1')
      await page.getByTestId('fixture-close-menu').click()
      await expect(actions).toHaveCSS('opacity', '0')
      const folder = page.getByTestId(`explorer-node-initial-${INITIAL_COUNT - 1}.md`).first()
      const folderActions = folder.getByRole('button').last()
      await expect(folder.locator('.lucide-folder')).toHaveCount(1)
      await folder
        .getByTestId(`explorer-select-initial-${INITIAL_COUNT - 1}.md`)
        .first()
        .click()
      await expect(folder.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true')
      await expect(
        folder
          .getByTestId(`explorer-select-initial-${INITIAL_COUNT - 1}.md`)
          .first()
          .locator('.lucide-folder-open')
      ).toHaveCount(1)
      await folder
        .getByTestId(`explorer-select-initial-${INITIAL_COUNT - 1}.md`)
        .first()
        .click()
      await expect(folder.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false')
      assert.equal(
        await folder.evaluate((element) =>
          element.classList.contains('bg-[var(--vds-bg-white-active)]')
        ),
        false
      )
      await expect(folderActions).toHaveCSS('opacity', '1')
      await page.getByTestId('fixture-refresh').focus()
      await firstRow.hover()
      await expect(actions).toHaveCSS('opacity', '1')
      await expect(folderActions).toHaveCSS('opacity', '0')
      await folder.hover()
      await expect(folderActions).toHaveCSS('opacity', '1')
      await expect(actions).toHaveCSS('opacity', '0')
      await page.getByTestId('fixture-refresh').hover()
      await expect(folderActions).toHaveCSS('opacity', '0')
      hold = true
      await folder.getByRole('button').first().click()
      await expect.poll(() => pending.length).toBeGreaterThan(0)
      await expect(
        folder.getByTestId(`explorer-directory-loading-initial-${INITIAL_COUNT - 1}.md`)
      ).toBeVisible()
      await expect(page.locator('[data-testid^="explorer-directory-loading-"]')).toHaveCount(1)
      hold = false
      for (const request of pending) await reply(request.route, 'nested', 0, 0)
      await expect(folder.locator('[aria-busy="true"]')).toHaveCount(0)
      await folder.getByRole('button').first().click()
      await expect(page.getByTestId('explorer-select-initial-0.md').locator('img')).toHaveCount(1)
      await expect(
        page.getByTestId(`explorer-select-initial-${INITIAL_COUNT - 1}.md`).locator('img')
      ).toHaveCount(0)
      assert.equal((await firstRow.boundingBox())?.height, 36)
      await expect(page.getByTestId('explorer-select-initial-0.md')).toHaveCSS(
        'color',
        'rgb(109, 109, 109)'
      )
      await expect(page.getByTestId('explorer-select-initial-0.md')).toHaveCSS(
        'line-height',
        '20px'
      )
      await page.getByRole('button', { name: '加载更多', exact: true }).click()
      await expect(page.getByTestId('explorer-more-error-/')).toBeVisible()
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT)
      await page.screenshot({ path: path.join(artifacts, 'pagination-error.png'), fullPage: true })
      failMore = false
      prefix = 'next'
      await page.getByTestId('explorer-more-/').click()
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT + 1)
      assert.deepEqual(
        offsets.filter((offset) => offset > 0),
        [INITIAL_COUNT, INITIAL_COUNT]
      )
      await expect(page.getByTestId('explorer-more-error-/')).toHaveCount(0)
      hold = true
      const refreshStart = pending.length
      await page.getByTestId('fixture-refresh').click()
      await expect.poll(() => pending.length).toBe(refreshStart + 1)
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT + 1)
      assert.equal(await firstRow.evaluate((element) => element.isConnected), true)
      await reply(pending[refreshStart].route, 'replacement', INITIAL_COUNT)
      await expect.poll(() => pending.length).toBe(refreshStart + 2)
      await expect(page.getByTestId('explorer-node-initial-0.md')).toBeVisible()
      await reply(pending[refreshStart + 1].route, 'replacement-next', 1)
      await expect(page.getByTestId('explorer-node-replacement-next-0.md')).toBeVisible()
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT + 1)
      const nestedRead = pending.length
      await page.getByTestId('explorer-node-replacement-99.md').getByRole('button').first().click()
      await expect.poll(() => pending.length).toBeGreaterThan(nestedRead)
      await settleRender(page)
      for (const { route } of pending.slice(nestedRead))
        await reply(route, 'nested-before-refresh', 1, 1)
      await expect(page.getByTestId('explorer-node-nested-before-refresh-0.md')).toBeVisible()
      const deadlineCount = await page.evaluate(() => Reflect.get(window, 'treeDeadlines').length)
      const timedRefresh = pending.length
      await page.getByTestId('fixture-refresh').click()
      await expect.poll(() => pending.length).toBe(timedRefresh + 2)
      const readPath = (route: Route): string | null =>
        new URL(route.request().url()).searchParams.get('path')
      const first = pending.slice(timedRefresh).find(({ route }) => !readPath(route))
      const child = pending.slice(timedRefresh).find(({ route }) => readPath(route))
      assert(first && child)
      await reply(child.route, 'nested-refresh-candidate', 1, 1)
      await reply(first.route, 'expired-first', INITIAL_COUNT)
      await expect.poll(() => pending.length).toBe(timedRefresh + 3)
      await expect(page.getByTestId('explorer-node-nested-refresh-candidate-0.md')).toHaveCount(0)
      assert.equal(
        await page.evaluate(() => Reflect.get(window, 'treeDeadlines').length),
        deadlineCount + 1
      )
      await page.evaluate(() =>
        Reflect.get(window, 'treeDeadlines')
          .at(-1)
          .abort(new DOMException('deadline', 'TimeoutError'))
      )
      await expect(page.getByTestId('explorer-directory-error-/')).toBeVisible()
      await expect(page.getByTestId('explorer-directory-error-replacement-99.md')).toHaveCount(0)
      await expect(page.getByTestId('fixture-refresh')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('explorer-node-replacement-next-0.md')).toBeVisible()
      await expect(page.getByTestId('explorer-node-nested-before-refresh-0.md')).toBeVisible()
      await expect(page.getByTestId('explorer-node-expired-first-0.md')).toHaveCount(0)
      hold = false
      prefix = 'retry-after-deadline'
      await page.getByTestId('explorer-directory-retry-/').click()
      await expect(
        page.getByTestId('explorer-node-retry-after-deadline-0.md').first()
      ).toBeVisible()
      await expect(page.getByTestId('explorer-directory-error-/')).toHaveCount(0)
      for (const action of ['refresh', 'project', 'path', 'mount']) {
        // Fence each scenario from a fresh directory; refresh now preserves loaded pagination.
        await page.getByTestId('fixture-mount').click()
        await page.getByTestId('fixture-mount').click()
        await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT)
        prefix = `before-${action}`
        await page.getByTestId('fixture-refresh').click()
        await expect(page.getByTestId(`explorer-node-${prefix}-0.md`)).toBeVisible()
        hold = true
        const before = pending.length
        await page
          .getByTestId(
            action === 'path'
              ? 'explorer-more-/'
              : action === 'mount'
                ? 'explorer-more-root'
                : 'explorer-more-/'
          )
          .evaluate((button: HTMLButtonElement) => {
            button.click()
            button.click()
          })
        await expect.poll(() => pending.length).toBe(before + 1)
        hold = false
        prefix = `after-${action}`
        await page.getByTestId(`fixture-${action}`).click()
        if (action === 'mount') await page.getByTestId('fixture-mount').click()
        await expect(page.getByTestId(`explorer-node-${prefix}-0.md`)).toBeVisible()
        if (action === 'refresh') {
          hold = true
          await page.getByTestId('explorer-more-/').click()
          await expect.poll(() => pending.length).toBe(before + 2)
        }
        await reply(pending[before].route, 'stale-page', 1)
        await settleRender(page)
        await expect(page.getByTestId('explorer-node-stale-page-0.md')).toHaveCount(0)
        await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(INITIAL_COUNT)
        if (action === 'refresh') {
          await expect(page.getByTestId('explorer-more-/')).toBeDisabled()
          hold = false
          await reply(pending[before + 1].route, 'current-page', 1)
          await expect(page.getByTestId('explorer-node-current-page-0.md')).toBeVisible()
        }
      }
      hold = true
      const firstRead = pending.length
      await page.getByTestId('fixture-refresh').click()
      await expect(page.getByTestId('fixture-refresh')).toHaveAttribute('aria-busy', 'true')
      await expect.poll(() => pending.length).toBeGreaterThan(firstRead)
      hold = false
      prefix = 'fresh-initial'
      await page.getByTestId('fixture-project').click()
      await expect(page.getByTestId(`explorer-node-${prefix}-0.md`)).toBeVisible()
      for (const stale of pending.slice(firstRead)) await reply(stale.route, 'stale-initial', 1)
      await settleRender(page)
      await expect(page.getByTestId('explorer-node-stale-initial-0.md')).toHaveCount(0)
      hold = true
      const unmountedRead = pending.length
      await page.getByTestId('fixture-refresh').click()
      await expect.poll(() => pending.length).toBeGreaterThan(unmountedRead)
      await page.getByTestId('fixture-mount').click()
      for (const stale of pending.slice(unmountedRead))
        await reply(stale.route, 'unmounted-initial', 1)
      await settleRender(page)
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(0)
      hold = false
      await page.getByTestId('fixture-mount').click()
      await expect(page.getByTestId(`explorer-node-${prefix}-0.md`)).toBeVisible()
      failInitial = true
      await page.getByTestId('fixture-refresh').click()
      await expect(page.getByTestId('explorer-directory-error-root')).toBeVisible()
      failInitial = false
      empty = true
      await page.getByTestId('explorer-directory-retry-root').click()
      await expect(page.getByTestId('fixture-refresh')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('explorer-directory-empty-root')).toHaveCount(0)
      await expect(page.locator('#root > div')).toHaveCount(0)
      // A retained empty directory still reports a failed refresh and permits retry.
      failInitial = true
      await page.getByTestId('fixture-refresh').click()
      await expect(page.getByTestId('explorer-directory-error-root')).toBeVisible()
      await expect(page.locator('[data-testid^="explorer-node-"]')).toHaveCount(0)
      failInitial = false
      await page.getByTestId('explorer-directory-retry-root').click()
      await expect(page.getByTestId('explorer-directory-error-root')).toHaveCount(0)
      await expect(page.locator('#root > div')).toHaveCount(0)
      await page.getByTestId('fixture-draft').click()
      await expect(page.getByTestId('fixture-draft-row')).toBeVisible()
      await page.getByTestId('fixture-draft').click()
      await expect(page.getByTestId('fixture-draft-row')).toHaveCount(0)
      await page.getByTestId('fixture-path').click()
      await expect(page.getByTestId('fixture-refresh')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('explorer-directory-empty-/')).toHaveCount(0)
      await expect(page.locator('#root > div')).toHaveCount(0)
      await page.getByTestId('fixture-english').click()
      await expect(page.getByTestId('explorer-directory-empty-/')).toHaveCount(0)
      await expect(page.locator('#root > div')).toHaveCount(0)
      await page.screenshot({ path: path.join(artifacts, 'empty-english.png'), fullPage: true })
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
      await server.close()
      rmSync(artifacts, { recursive: true, force: true })
    }
  }
)
