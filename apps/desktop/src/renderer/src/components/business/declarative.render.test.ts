import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { closedOpenUI } from '../../../../../scripts/shared/openui.mjs'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = '/components/business/declarative.render.fixture.html'

test(
  'official display updates are isolated from native clarification and reject removed forms',
  { timeout: 90000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
      create: (config) =>
        createServer({
          ...config,
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
    await page.goto(new URL(FIXTURE, fixture.url).href)
    await expect(page.locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'ready', {
      timeout: 45000,
    })
    await expect(page.getByText('研究结果', { exact: true })).toBeVisible()
    await expect(page.getByText('结果解释', { exact: true })).toBeVisible()
    assert.equal(await page.locator('iframe').count(), 0)
    await page.getByRole('button', { name: '更新描述', exact: true }).click()
    await expect(page.getByRole('table')).toContainText('7')
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('table')).toContainText('7')
    await page.getByRole('button', { name: '切换视图', exact: true }).click()
    await page.getByRole('button', { name: '切换视图', exact: true }).click()
    await expect(page.getByRole('table')).toContainText('7')
    const plot = page.getByTestId('conversation-plot')
    await plot.hover()
    await plot.getByRole('tab', { name: '查看原始数据', exact: true }).click()
    await expect(plot.getByRole('table')).toContainText('7')
    const figure = plot.getByRole('tab', { name: '查看图形', exact: true })
    await figure.click()
    await expect(figure).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('submissions')).toHaveText('[]')
    await page.getByRole('button', { name: '移除的表单', exact: true }).click()
    await expect(page.locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'error')
    await page.getByRole('button', { name: '非法描述', exact: true }).click()
    await expect(page.locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'error')
    for (const name of ['CodeBlock', 'Separator', 'Citation']) {
      await page.getByRole('button', { name, exact: true }).click()
      await expect(page.locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'error')
    }
    await page.getByRole('button', { name: '资源入口', exact: true }).click()
    await expect(page.locator('[data-conversation-ui]')).toHaveAttribute('data-state', 'error')
    await expect(page.getByRole('button', { name: '已发布文件', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '原生澄清', exact: true }).click()
    await expect(page.locator('[data-conversation-ui]')).toHaveCount(0)
    await page.getByRole('radio', { name: '继续 原生选项', exact: true }).click()
    await expect(page.getByTestId('submissions')).toContainText('继续')
    await page.getByRole('button', { name: '原生文献选择', exact: true }).click()
    await expect(page.locator('[data-conversation-ui]')).toHaveCount(0)
    await page.getByRole('checkbox', { name: '论文一 证据说明一', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
    await expect(page.getByTestId('submissions')).toContainText('"selected_paper_ids":["one"]')
    await page.getByRole('checkbox', { name: '全选', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.getByRole('checkbox', { name: '全选', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    await page.getByRole('button', { name: '原生提纲确认', exact: true }).click()
    await expect(page.locator('[data-conversation-ui]')).toHaveCount(0)
    await expect(page.getByText('综述核对', { exact: true })).toBeVisible()
    await expect(page.getByTestId('receipt-preview')).toHaveCount(0)
    const choice = page.getByRole('radio', { name: /按当前方案开始撰写/ })
    await choice.click()
    await expect(choice).toBeChecked()
    await page.getByRole('button', { name: '终态', exact: true }).click()
    await expect(choice).toBeDisabled()
    await page.getByRole('button', { name: '原生文献选择', exact: true }).click()
    await expect(
      page.getByRole('checkbox', { name: '论文一 证据说明一', exact: true })
    ).toBeDisabled()
    assert.deepEqual(failures, [])
  }
)
