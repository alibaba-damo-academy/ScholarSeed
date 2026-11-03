import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { PluginMount } from '../../../../plugins.ts'
import { createPreviewSession } from './preview.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGES = path.resolve(ROOT, '../../../../../skills/community')
const OFFICIAL = JSON.parse(
  readFileSync(path.resolve(PACKAGES, '../../packages/ui/manifest.json'), 'utf8')
) as { compatibility: string; version: string; components: { slot: string }[] }
const BUILTINS = [
  'agentic-search',
  'precise-literature-search',
  'literature-review',
  'research-idea-partner',
]
let server: Awaited<ReturnType<typeof createServer>> | undefined
after(async () => {
  await server?.close()
})

async function openPreview(page: Page, name: string): Promise<PluginMount> {
  if (!server) {
    server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
  }
  const root = path.join(PACKAGES, name)
  const descriptor = JSON.parse(
    readFileSync(path.join(root, '.scholarseed-plugin.json'), 'utf8')
  ) as PluginMount['descriptor']
  const mount: PluginMount = {
    descriptor,
    fingerprint: 'fixture',
    frames: {},
    scenarios: Object.fromEntries(
      descriptor.components.map((component) => [
        component.id,
        JSON.parse(readFileSync(path.join(root, component.preview), 'utf8')),
      ])
    ),
    ui: {
      compatibility: OFFICIAL.compatibility,
      version: OFFICIAL.version,
      fingerprint: 'official-fixture',
    },
  }
  const results = mount.scenarios.results.data
  assert.equal(
    (results.papers as unknown[]).length,
    3,
    'summary follows the product three-paper contract'
  )
  const opened = createPreviewSession(mount.scenarios.results).execute('open-results', {})
  const detail = opened.data.target as { data: { papers: unknown[] } }
  assert.equal(
    detail.data.papers.length,
    results.retained,
    'opening details must retain the complete result set'
  )
  for (const component of descriptor.components.filter(
    (component) => !component.public || component.slot === 'literature.selection'
  ))
    mount.frames[component.id] = { lease: component.id, url: `http://preview.test/${component.id}` }
  await page.route('http://preview.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<details><summary>隔离组件</summary><p>展开内容</p></details>',
    })
  )
  await page.addInitScript(
    (mount) => Object.assign(window, { previewFixture: { mount, requests: [] } }),
    mount
  )
  await page.goto(
    new URL('/components/business/preview.render.fixture.html', server.resolvedUrls!.local[0]).href
  )
  return mount
}

for (const name of BUILTINS)
  test(
    `${name}: one registered component per page with clean re-entry`,
    { timeout: 60_000 },
    async () => {
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        const page = await browser.newPage()
        const mount = await openPreview(page, name)
        const pagination = page.getByRole('navigation', { name: '预览组件分页' })
        for (const [index, component] of mount.descriptor.components.entries()) {
          if (index) await pagination.getByRole('button', { name: '下一页', exact: true }).click()
          await expect(page.getByTestId('preview-component')).toHaveCount(1)
          await expect(page.getByTestId('preview-component')).toHaveAttribute(
            'data-component',
            component.id
          )
          await expect(page.getByTestId('preview-origin')).toHaveText(
            component.public
              ? mount.frames[component.id]
                ? '官方公共组件'
                : '宿主公共组件'
              : '插件自定义组件'
          )
          await expect(page.getByTestId('preview-page')).toHaveText(
            `组件 ${index + 1} / ${mount.descriptor.components.length}`
          )
          const title = await page
            .getByRole('heading', { name: component.id, exact: true })
            .boundingBox()
          const reset = page.getByRole('button', { name: '重置预览', exact: true })
          const resetBox = await reset.boundingBox()
          assert.ok(
            title &&
              resetBox &&
              resetBox.x > title.x + title.width &&
              resetBox.y < title.y + title.height
          )
          assert.notEqual(
            await reset.evaluate((element) => getComputedStyle(element).backgroundColor),
            'rgba(0, 0, 0, 0)'
          )
          await expect(page.getByText(/状态：|样例操作回执/)).toHaveCount(0)
          await expect(page.getByText('对话预览 · 样例数据，不执行真实操作')).toBeVisible()
        }
        await expect(pagination.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
        assert.ok(
          (
            (await page.evaluate('window.previewFixture.requests')) as { operation: string }[]
          ).every((request) =>
            [
              'plugin-preview-installed',
              'plugin-release',
              'plugin-valid',
              'plugin-validate',
            ].includes(request.operation)
          )
        )
      } finally {
        await browser.close()
      }
    }
  )

test(
  'delivery dialog is pointer reachable above the preview and returns focus on cancel',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPreview(page, 'research-idea-partner')
      const pagination = page.getByRole('navigation', { name: '预览组件分页' })
      await pagination.getByRole('button', { name: '第 4 页', exact: true }).click()
      await page.getByRole('button', { name: '选择保存位置', exact: true }).click()
      const dialog = page.getByTestId('literature-delivery-dialog')
      await dialog
        .getByRole('button', { name: '选择当前资料库中的文件夹', exact: true })
        .click({ timeout: 3000 })
      await expect(page.getByRole('button', { name: '稍后保存', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: '稍后保存', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: '选择保存位置', exact: true })).toBeFocused()
    } finally {
      await browser.close()
    }
  }
)

test(
  'result details navigate within one page and revisiting discards selected rows',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const mount = await openPreview(page, 'agentic-search')
      await page.getByRole('button', { name: '查看全部结果', exact: true }).click()
      await expect(page.getByTestId('preview-component')).toHaveCount(1)
      await expect(page.getByTestId('preview-component')).toHaveAttribute(
        'data-component',
        'results'
      )
      const selection = page.getByRole('checkbox', { name: '选择当前筛选的全部结果', exact: true })
      await selection.check()
      await expect(selection).toBeChecked()
      const pagination = page.getByRole('navigation', { name: '预览组件分页' })
      await page.getByRole('button', { name: '返回结果摘要', exact: true }).click()
      await expect(page.getByTestId('preview-page')).toHaveText(
        `组件 1 / ${mount.descriptor.components.length}`
      )
      await page.getByRole('button', { name: '查看全部结果', exact: true }).click()
      await expect(selection).not.toBeChecked()
      await expect(page.getByTestId('preview-page')).toHaveText(
        `组件 1 / ${mount.descriptor.components.length}`
      )
      await pagination.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(page.getByTestId('preview-component')).not.toHaveAttribute(
        'data-component',
        'results'
      )
    } finally {
      await browser.close()
    }
  }
)

test(
  'question and authorization retry in the original action area with preserved choices',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const mount = await openPreview(page, 'research-idea-partner')
      for (const id of ['question', 'authorization']) {
        const index = mount.descriptor.components.findIndex((component) => component.id === id)
        await page
          .getByRole('navigation', { name: '预览组件分页' })
          .getByRole('button', { name: `第 ${index + 1} 页`, exact: true })
          .click()
        await page.getByRole('button', { name: '确认失败后重试', exact: true }).click()
        const confirm =
          id === 'question'
            ? page.getByTestId('hil-question-confirm')
            : page.getByTestId('hil-question-option-0-0')
        if (id === 'question') await page.getByRole('radio').first().click()
        await confirm.click()
        await expect(page.getByTestId('hil-submit-error')).toBeVisible()
        await expect(page.getByTestId('hil-retry')).toHaveCount(0)
        await expect(confirm).toBeEnabled()
        await confirm.click()
        await expect(page.getByTestId('hil-submit-error')).toHaveCount(0)
        await expect(confirm).toHaveCount(0)
      }
    } finally {
      await browser.close()
    }
  }
)

test(
  'authorization actions retain matching v0.3 button styles and dimensions',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const mount = await openPreview(page, 'research-idea-partner')
      const index = mount.descriptor.components.findIndex(
        (component) => component.id === 'authorization'
      )
      await page
        .getByRole('navigation', { name: '预览组件分页' })
        .getByRole('button', { name: `第 ${index + 1} 页`, exact: true })
        .click()
      const authorize = page.getByTestId('hil-question-option-0-0')
      const reject = page.getByTestId('hil-question-option-0-1')
      await expect(authorize).toBeVisible()
      await expect(reject).toHaveClass((await authorize.getAttribute('class')) ?? '')
      const authorizeBox = await authorize.boundingBox()
      const rejectBox = await reject.boundingBox()
      assert.ok(authorizeBox)
      assert.ok(rejectBox)
      assert.ok(Math.abs(authorizeBox.width - rejectBox.width) <= 1)
      assert.equal(authorizeBox.height, rejectBox.height)
    } finally {
      await browser.close()
    }
  }
)

test(
  'references source opens a local sample viewer and closes without navigation',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const mount = await openPreview(page, 'research-idea-partner')
      const index = mount.descriptor.components.findIndex(
        (component) => component.id === 'references'
      )
      await page
        .getByRole('navigation', { name: '预览组件分页' })
        .getByRole('button', { name: `第 ${index + 1} 页`, exact: true })
        .click()
      await page.getByRole('button', { name: '打开原文', exact: true }).first().click()
      await expect(page.getByTestId('preview-viewer')).toBeVisible()
      await expect(page.getByTestId('preview-viewer')).toContainText('sample-0')
      await page
        .getByTestId('preview-viewer')
        .getByRole('button', { name: '关闭样例内容', exact: true })
        .click()
      await expect(page.getByTestId('preview-viewer')).toHaveCount(0)
      await expect(page.getByTestId('preview-component')).toHaveAttribute(
        'data-component',
        'references'
      )
      assert.equal(page.context().pages().length, 1)
    } finally {
      await browser.close()
    }
  }
)

test(
  'references deep menus and create dialog complete sample actions, reset and re-entry discard state',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPreview(page, 'research-idea-partner')
      const pages = page.getByRole('navigation', { name: '预览组件分页' })
      await pages.getByRole('button', { name: '第 2 页', exact: true }).click()
      const add = page.getByRole('button', {
        name: '添加到文献库：样例 1：长上下文方法对比',
        exact: true,
      })
      await add.click()
      await page.getByRole('menuitem', { name: '加入我的分类', exact: true }).hover()
      await page.getByRole('menuitem', { name: '研究方法', exact: true }).hover()
      await page.getByRole('menuitem', { name: '长上下文', exact: true }).hover()
      await page.getByRole('menuitem', { name: '证据对比', exact: true }).click()
      await expect(page.getByText('已添加', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '重置预览', exact: true }).click()
      await expect(page.getByText('已添加', { exact: true })).toHaveCount(0)
      await add.click()
      await page.getByRole('menuitem', { name: '加入我的分类', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      await page.getByRole('menuitem', { name: '新建分类…', exact: true }).click()
      const name = page.getByRole('textbox', { name: '分类名称', exact: true })
      await expect(name).toBeFocused()
      await name.fill('预览临时分类')
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(name).toHaveCount(0)
      await add.click()
      await page.getByRole('menuitem', { name: '加入我的分类', exact: true }).hover()
      await page.getByRole('menuitem', { name: '新建分类…', exact: true }).click()
      await name.fill('预览临时分类')
      await page.getByRole('button', { name: '创建并添加', exact: true }).click()
      await expect(page.getByText('已添加', { exact: true })).toBeVisible()
      await page.getByRole('searchbox', { name: '搜索文献标题' }).fill('样例 1')
      await pages.getByRole('button', { name: '下一页', exact: true }).click()
      await pages.getByRole('button', { name: '上一页', exact: true }).click()
      await expect(page.getByRole('searchbox', { name: '搜索文献标题' })).toHaveValue('')
      await expect(page.getByText('已添加', { exact: true })).toHaveCount(0)
      assert.ok(
        ((await page.evaluate('window.previewFixture.requests')) as { operation: string }[]).every(
          (request) =>
            ['plugin-preview-installed', 'plugin-release', 'plugin-validate'].includes(
              request.operation
            )
        )
      )
    } finally {
      await browser.close()
    }
  }
)

test(
  'delivery saves sample choice, cancel preserves it and reset removes it',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPreview(page, 'precise-literature-search')
      await page
        .getByRole('navigation', { name: '预览组件分页' })
        .getByRole('button', { name: '第 3 页', exact: true })
        .click()
      await page.getByRole('button', { name: '选择保存位置', exact: true }).click()
      const dialog = page.getByTestId('literature-delivery-dialog')
      await dialog.getByRole('button', { name: '选择其他本地文件夹…', exact: true }).click()
      await expect(dialog.getByText(/样例目录/)).toBeVisible()
      await dialog.getByRole('button', { name: '保存全文', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByText('全文保存完成', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '重置预览', exact: true }).click()
      await expect(page.getByText('全文保存完成', { exact: true })).toHaveCount(0)
      await expect(page.getByText('已获取，尚未保存到资料库', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '取消目录选择', exact: true }).click()
      await page.getByRole('button', { name: '选择保存位置', exact: true }).click()
      await dialog.getByRole('button', { name: '选择其他本地文件夹…', exact: true }).click()
      await expect(dialog.getByText(/样例目录/)).toHaveCount(0)
      await dialog.getByRole('button', { name: '稍后保存', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      assert.ok(
        ((await page.evaluate('window.previewFixture.requests')) as { operation: string }[]).every(
          (request) =>
            ['plugin-preview-installed', 'plugin-release', 'plugin-validate'].includes(
              request.operation
            )
        )
      )
    } finally {
      await browser.close()
    }
  }
)
