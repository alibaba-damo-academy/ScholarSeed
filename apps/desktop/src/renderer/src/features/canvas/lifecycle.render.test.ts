import assert from 'node:assert/strict'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { closedOpenUI } from '../../../../../scripts/shared/openui.mjs'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = '/features/canvas/lifecycle.render.fixture.html'

async function openFixture(context: TestContext, search = '') {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    create: (config) =>
      createServer({
        ...config,
        plugins: [
          ...(config.plugins ?? []),
          {
            name: 'canvas-test-store',
            enforce: 'pre',
            resolveId(id, importer) {
              if (id === '../../store' && importer?.endsWith('/features/canvas/Scope.tsx'))
                return path.join(ROOT, 'features/canvas/lifecycle.render.fixture.tsx')
            },
          },
        ],
        optimizeDeps: {
          include: ['@openuidev/react-lang', '@openuidev/react-ui', '@openuidev/lang-core'],
          esbuildOptions: { plugins: [closedOpenUI()] },
        },
        resolve: {
          dedupe: [
            'react',
            'react-dom',
            '@openuidev/react-lang',
            '@openuidev/react-ui',
            '@openuidev/lang-core',
            'zod',
          ],
        },
        server: {
          ...config.server,
          fs: {
            allow: [
              path.resolve(ROOT, '../../..'),
              path.resolve(ROOT, '../../../../../packages/ui'),
            ],
          },
        },
      }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto(new URL(FIXTURE + search, fixture.url).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  return { page, failures }
}

test(
  'a packaged workbench component shares the preview shell and retains its live controls',
  { timeout: 90000 },
  async (context) => {
    const { page, failures } = await openFixture(context, '?plugin')
    const card = page.getByTestId('conversation-plugin-preview')
    const header = card.locator('header')
    const open = header.getByRole('button', { name: '打开', exact: true })
    const collapse = header.getByRole('button', { name: '收起插件预览', exact: true })
    const expand = header.getByRole('button', { name: '展开插件预览', exact: true })
    const inlineFrame = page.locator('iframe')
    const filter = inlineFrame.contentFrame().getByRole('checkbox', { name: '引用关系' })
    const edge = inlineFrame.contentFrame().getByRole('button', { name: '选中连线' })
    const end = inlineFrame.contentFrame().getByText('图谱末尾', { exact: true })
    const preview = card.getByRole('region', { name: '论文关系' })
    await expect(header.getByText('论文关系', { exact: true })).toBeVisible()
    await expect(header.getByRole('button')).toHaveCount(2)
    await expect(card.getByRole('button')).toHaveCount(2)
    await expect(card).toHaveCSS('border-top-width', '1px')
    await expect(card).toHaveCSS('border-top-left-radius', '12px')
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(preview).toHaveCSS('height', '170px')
    await expect(end).not.toBeInViewport()
    await inlineFrame
      .contentFrame()
      .locator('body')
      .hover({ position: { x: 30, y: 60 } })
    await page.mouse.wheel(0, 250)
    await expect(end).toBeInViewport()
    await filter.uncheck()
    await edge.click()
    const guest = await inlineFrame.elementHandle()
    await collapse.press('Space')
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(expand).toBeFocused()
    await expect(open).toBeVisible()
    await expect(inlineFrame).toBeHidden()
    await expand.press('Enter')
    await expect(filter).not.toBeChecked()
    await expect(edge).toHaveAttribute('aria-pressed', 'true')
    await open.press('Enter')
    const workbench = page.getByTestId('workspace-content')
    await expect(workbench.locator('iframe')).toBeVisible()
    await expect(workbench.locator('header')).toHaveCount(0)
    await expect(header.getByText('论文关系', { exact: true })).toBeVisible()
    await expect(open).toBeVisible()
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(card.locator('iframe')).toHaveCount(0)
    await expect(inlineFrame).toHaveCount(1)
    await open.click()
    await expect(workbench.locator('iframe')).toHaveCount(1)
    await expand.press('Enter')
    await expect(card.locator('iframe')).toBeVisible()
    await expect(filter).not.toBeChecked()
    await expect(edge).toHaveAttribute('aria-pressed', 'true')
    await open.click()
    await expect(workbench.locator('iframe')).toBeVisible()
    await expect(filter).not.toBeChecked()
    await expect(edge).toHaveAttribute('aria-pressed', 'true')
    await workbench.getByRole('button', { name: '收起工作台', exact: true }).click()
    await expect(open).toBeVisible()
    await expect(inlineFrame).toBeHidden()
    await expand.press('Enter')
    await expect(filter).not.toBeChecked()
    await expect(edge).toHaveAttribute('aria-pressed', 'true')
    assert.ok(await inlineFrame.evaluate((element, before) => element === before, guest))
    assert.deepEqual(failures, [])
  }
)

test(
  'Canvas previews collapse independently and retain the live iframe across workbench moves',
  { timeout: 90000 },
  async (context) => {
    const { page, failures } = await openFixture(context)
    const canvas = page.getByTestId('conversation-canvas-runtime').first()
    const otherCanvas = page.getByTestId('conversation-canvas-runtime').nth(1)
    const header = canvas.locator('header')
    await expect(canvas).toHaveCSS('border-top-style', 'solid')
    await expect(canvas).toHaveCSS('border-top-width', '1px')
    await expect(canvas).toHaveCSS('border-top-left-radius', '12px')
    await expect(header).toHaveCSS('border-bottom-width', '1px')
    const preview = canvas.locator('iframe').locator('..')
    const inset = await preview.evaluate(
      (element) =>
        element.getBoundingClientRect().left -
        element.closest('section')!.getBoundingClientRect().left
    )
    assert.equal(inset, 13)
    await expect(preview).toHaveCSS('height', '170px')
    const frame = canvas.frameLocator('iframe')
    await frame.getByRole('button', { name: '增加一次', exact: true }).click()
    await frame.getByRole('button', { name: '增加一次', exact: true }).click()
    await expect(frame.locator('#count')).toHaveText('2')
    const original = await canvas
      .locator('iframe')
      .elementHandle()
      .then((element) => element!.contentFrame())
    const open = canvas.getByTestId('artifact-open-default')
    await expect(open).toHaveAccessibleName('打开')
    const collapse = canvas.getByRole('button', { name: '收起画布预览', exact: true })
    await expect(collapse).toHaveAttribute('aria-expanded', 'true')
    await collapse.press('Space')
    const expand = canvas.getByRole('button', { name: '展开画布预览', exact: true })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(expand).toBeFocused()
    await expect(preview).toBeHidden()
    await expect(otherCanvas.locator('iframe')).toBeVisible()
    await open.press('Enter')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    const panel = page.getByTestId('workspace-content')
    const workbench = panel.getByTestId('conversation-canvas-runtime')
    await expect(workbench.locator('header')).toHaveCount(0)
    await expect
      .poll(async () => (await workbench.locator('iframe').boundingBox())?.height ?? 0)
      .toBeGreaterThan(170)
    await expect(workbench).toHaveCSS('border-top-width', '0px')
    await expect(workbench.getByRole('button', { name: /画布预览/ })).toHaveCount(0)
    await panel.getByRole('button', { name: '收起工作台', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect(open).toBeVisible()
    await expect(preview).toBeHidden()
    await expand.press('Enter')
    await expect(preview).toHaveCSS('height', '170px')
    await expect(canvas).toHaveCSS('border-top-width', '1px')
    const returned = await canvas
      .locator('iframe')
      .elementHandle()
      .then((element) => element!.contentFrame())
    assert.equal(
      returned === original,
      true,
      'The live Canvas iframe must survive workbench collapse'
    )
    await canvas.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(frame.locator('#count')).toHaveText('1')
    const end = frame.getByText('画布末尾')
    await expect(end).not.toBeInViewport()
    await frame.locator('body').hover({ position: { x: 25, y: 55 } })
    await page.mouse.wheel(0, 500)
    await expect(end).toBeInViewport()
    await open.click()
    await expect(workbench.frameLocator('iframe').locator('#count')).toHaveText('1')
    await panel.getByRole('button', { name: '收起工作台', exact: true }).click()
    await page.getByRole('button', { name: '切换任务', exact: true }).click()
    await expect(page.locator('iframe')).toHaveCount(0)
    assert.deepEqual(failures, [])
  }
)

test(
  'Canvas workbench follows the selected conversation without resetting either card',
  { timeout: 90000 },
  async (context) => {
    const { page, failures } = await openFixture(context)
    const panel = page.getByTestId('workspace-content')
    const count = panel.frameLocator('iframe').locator('#count')
    const conversation = page.getByTestId('canvas-conversation')
    const inlineFrame = conversation.frameLocator('iframe').first()
    const switchTo = (name: string) => page.getByRole('button', { name, exact: true }).click()
    const openCard = async (increments: number) => {
      const increment = inlineFrame.getByRole('button', { name: '增加一次' })
      await expect(increment).toBeEnabled()
      for (let step = 1; step <= increments; step += 1) {
        await increment.press('Space')
        await expect(inlineFrame.locator('#count')).toHaveText(String(step))
      }
      await conversation.getByTestId('artifact-open-default').first().click()
      await expect(count).toHaveText(String(increments))
    }

    await openCard(1)
    await switchTo('empty')
    await expect(panel).toBeHidden()
    await switchTo('task')
    await expect(count).toHaveText('1')
    await switchTo('other')
    await expect(panel).toBeHidden()
    await openCard(2)
    await switchTo('task')
    await expect(count).toHaveText('1')
    await switchTo('other')
    await expect(count).toHaveText('2')

    await panel.getByRole('button', { name: '收起工作台' }).click()
    await switchTo('task')
    await expect(count).toHaveText('1')
    await switchTo('other')
    await expect(panel).toBeHidden()
    assert.deepEqual(failures, [])
  }
)

test(
  'OpenUI canvas wheel input stays in the preview at both boundaries',
  { timeout: 90000 },
  async (context) => {
    const { page, failures } = await openFixture(context, '?scroll')
    const conversation = page.getByTestId('conversation-scroll')
    const canvas = page.getByTestId('conversation-canvas-runtime')
    const preview = canvas.locator('[data-canvas-ui]').locator('..')
    await expect(canvas.getByText('画布段落 24', { exact: true })).toBeAttached()
    await conversation.evaluate((element) => {
      element.scrollTop = 100
    })
    await preview.hover()

    const positions = () =>
      preview.evaluate((element) => ({
        canvas: element.scrollTop,
        bottom: element.scrollHeight - element.clientHeight,
        conversation: element.closest('[data-testid="conversation-scroll"]')!.scrollTop,
      }))
    const wheel = async (delta: number) => {
      await page.mouse.wheel(0, delta)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
      )
    }

    const { bottom } = await positions()
    assert.ok(bottom > 0)
    await wheel(bottom * 2)
    await expect.poll(positions).toEqual({ canvas: bottom, bottom, conversation: 100 })
    await wheel(70)
    assert.deepEqual(await positions(), { canvas: bottom, bottom, conversation: 100 })
    await wheel(-70)
    await expect.poll(async () => (await positions()).canvas).toBeLessThan(bottom)
    await preview.evaluate((element) => {
      element.scrollTop = 0
    })
    await wheel(-70)
    assert.deepEqual(await positions(), { canvas: 0, bottom, conversation: 100 })

    await conversation.hover({ position: { x: 20, y: 20 } })
    await wheel(70)
    await expect.poll(positions).toEqual({ canvas: 0, bottom, conversation: 170 })
    assert.deepEqual(failures, [])
  }
)
