import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DesktopSession } from './fixtures/electron'
import { createRuntime } from './fixtures/runtime'
import { skipQuarantined } from './fixtures/quarantine'

test.beforeEach(async ({}, testInfo) => { skipQuarantined(testInfo) })

const PROJECT_NAME = '资料树稳定性回归'
const DIRECTORY_NAMES = ['目录', '第二层', '第三层', '第四层']
const FILE_COUNT = 140
const OPEN_FILE_INDICES = [118, 119, 120, 119]
const RESOURCE_DIRECTORY = 'resources'
const INTERACTION_TIMEOUT_MS = 15_000
const FILE_INDEX_WIDTH = 3
const fileName = (index: number): string => `文档${String(index).padStart(FILE_INDEX_WIDTH, '0')}.md`
const fileText = (index: number): string => `文件内容 ${index}`

test('resource tree keeps expanded rows and scroll position while opening and refreshing files', async ({}, testInfo) => {
  const runtime = createRuntime(testInfo)
  runtime.workspace = join(runtime.home, 'workspace')
  mkdirSync(runtime.workspace, { recursive: true })
  const desktop = new DesktopSession(runtime, testInfo, {
    nativeWindowLifecycle: true,
    preserveNavigation: true,
  })
  try {
    const page = await desktop.launch()
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    if (await page.getByTestId('landing-dialog').isVisible()) {
      await page.getByTestId('landing-skip').click()
    }
    await page.getByTestId('home-project-empty').click()
    await page.getByRole('textbox', { name: '项目名 *' }).fill(PROJECT_NAME)
    const created = page.waitForResponse(response =>
      response.url().endsWith('/api/content/projects') && response.request().method() === 'POST')
    const committed = page.waitForResponse(async response =>
      response.url().includes('/api/content/operations/') && response.ok() &&
      (await response.json()).state === 'succeeded')
    await page.getByTestId('project-create').click()
    expect((await created).status()).toBe(202)
    const { result: project } = await (await committed).json() as { result: { root: string } }
    const directory = join(project.root, RESOURCE_DIRECTORY, ...DIRECTORY_NAMES)
    mkdirSync(directory, { recursive: true })
    for (let index = 0; index < FILE_COUNT; index += 1) {
      writeFileSync(join(directory, fileName(index)), fileText(index))
    }
    await page.getByTestId('resource-refresh').click()
    let relative = RESOURCE_DIRECTORY
    for (const name of DIRECTORY_NAMES) {
      relative += `/${name}`
      await page.getByTestId(`tree-${relative}`).click()
    }
    const tree = page.getByTestId('resource-tree-root')
    const firstPageCount = await tree.locator('.vds-tree-row[data-testid$=".md"]').count()
    await page.getByTestId(`tree-load-more-${DIRECTORY_NAMES.length}`).click()
    await expect(page.getByTestId(`tree-load-more-${DIRECTORY_NAMES.length}`)).toHaveCount(0)
    const firstPath = `${relative}/${fileName(OPEN_FILE_INDICES[0])}`
    await page.getByTestId(`tree-${firstPath}`).scrollIntoViewIfNeeded()
    await tree.evaluate(element => {
      const scroll = element
      const rows = [...element.querySelectorAll('.vds-tree-row[data-testid]')]
        .map(row => row.getAttribute('data-testid')!)
      const samples: { scroll: number; missing: string[] }[] = []
      Object.assign(window, { resourceTreeProbe: { samples, scroll: scroll.scrollTop, rows } })
      const sample = (): void => {
        samples.push({ scroll: scroll.scrollTop, missing: rows.filter(id => !document.querySelector(`[data-testid="${id}"]`)) })
      }
      sample()
      new MutationObserver(sample).observe(element, { childList: true, subtree: true })
      scroll.addEventListener('scroll', sample)
    })
    const requests: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/resource/tree') requests.push(request.url())
    })
    for (const index of OPEN_FILE_INDICES) {
      await page.getByTestId(`tree-${relative}/${fileName(index)}`).click()
      await expect(page.getByTestId('markdown-paper').getByRole('textbox')).toHaveText(fileText(index))
    }
    await page.screenshot({ path: testInfo.outputPath('opened-files.png') })
    const openingRequests = [...requests]
    const openingProbe = await page.evaluate(() => (window as unknown as {
      resourceTreeProbe: { scroll: number; samples: { scroll: number; missing: string[] }[] }
    }).resourceTreeProbe)
    expect(openingProbe.samples.flatMap(sample => sample.missing)).toEqual([])
    expect(openingProbe.samples.map(sample => sample.scroll)).toEqual(openingProbe.samples.map(() => openingProbe.scroll))
    await page.getByTestId(`tree-${relative}/${fileName(FILE_COUNT - 1)}`).scrollIntoViewIfNeeded()
    await tree.evaluate(element => {
      const probe = (window as unknown as {
        resourceTreeProbe: { scroll: number; samples: unknown[] }
      }).resourceTreeProbe
      probe.scroll = element.scrollTop
      probe.samples.length = 0
    })
    const refreshed = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/resource/tree' &&
      new URL(response.url()).searchParams.get('path') === relative &&
      Number(new URL(response.url()).searchParams.get('offset')) === firstPageCount)
    await page.getByTestId('resource-refresh').click()
    await refreshed
    await expect(page.getByTestId(`tree-${firstPath}`)).toHaveCount(1)
    await expect(page.getByTestId('markdown-paper').getByRole('textbox')).toHaveText(fileText(OPEN_FILE_INDICES.at(-1)!))
    await page.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const probe = await page.evaluate(() => (window as unknown as {
      resourceTreeProbe: { scroll: number; samples: { scroll: number; missing: string[] }[] }
    }).resourceTreeProbe)
    const observations = testInfo.outputPath('tree-observations.json')
    writeFileSync(observations, JSON.stringify({ openingRequests, openingProbe, requests, probe }, null, 2))
    await testInfo.attach('tree-observations', { path: observations, contentType: 'application/json' })
    await page.screenshot({ path: testInfo.outputPath('refreshed-tree.png') })
    expect(await tree.evaluate(element => element.scrollTop)).toBe(probe.scroll)
    await expect(tree.locator('.vds-tree-row[data-testid$=".md"]')).toHaveCount(FILE_COUNT)
    expect(probe.scroll).toBeGreaterThan(0)
    expect(probe.samples.flatMap(sample => sample.missing)).toEqual([])
    expect(probe.samples.map(sample => sample.scroll)).toEqual(probe.samples.map(() => probe.scroll))
  } finally {
    await desktop.close()
  }
})
