import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import type { ViteDevServer } from 'vite'
import type { PluginMount } from '../../../../plugins.ts'
import { createPreviewSession } from './preview.ts'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

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
let server: ViteDevServer | undefined
after(async () => {
  await server?.close()
})

async function openPreview(
  page: Page,
  name: string,
  configure?: (mount: PluginMount) => void
): Promise<PluginMount> {
  if (!server) {
    server = await servers.create({
      cacheKey: 'preview',
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
  configure?.(mount)
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
        const release = page.getByTestId('preview-ui-release')
        await expect(release).toBeVisible()
        await expect(page.getByTestId('plugin-conversation-preview')).not.toContainText(
          mount.ui!.fingerprint
        )
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
  'result details navigate within one page and revisiting restores default selection',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const mount = await openPreview(page, 'agentic-search')
      const receipt = page.getByRole('button', { name: '打开检索结果', exact: true })
      await expect(receipt.getByText(/^检索结果/)).toHaveCSS('font-weight', '500')
      const selection = page.getByRole('checkbox', { name: '选择当前筛选的全部结果', exact: true })
      await expect(selection).toHaveCount(0)
      await receipt.click()
      await expect(page.getByTestId('preview-component')).toHaveCount(1)
      await expect(page.getByTestId('preview-component')).toHaveAttribute(
        'data-component',
        'results'
      )
      const detail = createPreviewSession(mount.scenarios.results).execute('open-results', {}).data
        .target as { data: { papers: { title: string }[] } }
      for (const paper of detail.data.papers)
        await expect(page.getByRole('link', { name: paper.title, exact: true })).toBeVisible()
      await expect(selection).toBeChecked()
      await selection.uncheck()
      await expect(selection).not.toBeChecked()
      const pagination = page.getByRole('navigation', { name: '预览组件分页' })
      await page.getByRole('button', { name: '返回结果摘要', exact: true }).click()
      await expect(page.getByTestId('preview-page')).toHaveText(
        `组件 1 / ${mount.descriptor.components.length}`
      )
      await expect(selection).toHaveCount(0)
      await receipt.click()
      await expect(selection).toBeChecked()
      await expect(page.getByTestId('preview-page')).toHaveText(
        `组件 1 / ${mount.descriptor.components.length}`
      )
      await pagination.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(page.getByTestId('preview-component')).not.toHaveAttribute(
        'data-component',
        'results'
      )
      assert.deepEqual(errors, [])
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
            : page.getByRole('button', { name: '确认授权', exact: true })
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
  'authorization actions distinguish primary confirmation and rejection at matching density',
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
      const authorize = page.getByRole('button', { name: '确认授权', exact: true })
      const reject = page.getByRole('button', { name: '拒绝', exact: true })
      await expect(authorize).toBeVisible()
      await expect(reject).toBeVisible()
      assert.notEqual(await reject.getAttribute('class'), await authorize.getAttribute('class'))
      const authorizeBox = await authorize.boundingBox()
      const rejectBox = await reject.boundingBox()
      assert.ok(authorizeBox)
      assert.ok(rejectBox)
      assert.equal(authorizeBox.height, rejectBox.height)
    } finally {
      await browser.close()
    }
  }
)

test(
  'literature result source opens a local sample viewer and closes without navigation',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPreview(page, 'research-idea-partner')
      const initialUrl = page.url()
      await page.getByRole('button', { name: '打开检索结果', exact: true }).click()
      const paper = page.getByTestId('search-paper-sample-0')
      const source = paper.getByRole('link', { name: '样例 1：长上下文方法对比', exact: true })
      await source.click()
      await expect(page.getByTestId('preview-viewer')).toBeVisible()
      await expect(page.getByTestId('preview-viewer')).toContainText('sample-0')
      await page
        .getByTestId('preview-viewer')
        .getByRole('button', { name: '关闭样例内容', exact: true })
        .click()
      await expect(page.getByTestId('preview-viewer')).toHaveCount(0)
      await expect(source).toBeVisible()
      await expect(page.getByRole('button', { name: '返回结果摘要', exact: true })).toBeVisible()
      assert.equal(page.url(), initialUrl)
      assert.equal(page.context().pages().length, 1)
    } finally {
      await browser.close()
    }
  }
)

test(
  'literature result menus and create dialog complete sample actions, reset and re-entry discard state',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPreview(page, 'research-idea-partner', (mount) => {
        const details = mount.scenarios.details
        const collections = details.state?.collections
        assert.ok(Array.isArray(collections) && collections.length === 1)
        const [sample] = collections as { id: string; project_id: string }[]
        const branch = {
          id: 'long-context',
          name: '长上下文',
          parent_id: sample.id,
          project_id: sample.project_id,
        }
        const leaf = {
          id: 'evidence',
          name: '证据对比',
          parent_id: branch.id,
          project_id: sample.project_id,
        }
        details.state = { ...details.state, collections: [...collections, branch, leaf] }
      })
      const pages = page.getByRole('navigation', { name: '预览组件分页' })
      const receipt = page.getByRole('button', { name: '打开检索结果', exact: true })
      const paper = page.getByTestId('search-paper-sample-0')
      const joined = paper.getByTestId('literature-joined')
      const add = page.getByTestId('join-library-trigger')
      const collection = page.getByRole('menuitem', { name: '加入我的分类', exact: true })
      const create = page.getByRole('menuitem', { name: '新建分类…', exact: true })
      await receipt.click()
      await add.click()
      await expect(collection).toBeEnabled()
      await collection.hover()
      await page.getByRole('menuitem', { name: '样例分类', exact: true }).hover()
      await page.getByRole('menuitem', { name: '长上下文', exact: true }).hover()
      await page.getByRole('menuitem', { name: '证据对比', exact: true }).click()
      await expect(joined).toHaveCount(0)
      await expect(paper.getByRole('checkbox')).toBeChecked()
      await expect(paper.getByRole('checkbox')).toBeDisabled()
      await page.getByRole('button', { name: '重置预览', exact: true }).click()
      await receipt.click()
      await expect(joined).toHaveCount(0)
      await add.click()
      await expect(collection).toBeEnabled()
      await collection.focus()
      await page.keyboard.press('ArrowRight')
      await create.click()
      const name = page.getByRole('textbox', { name: '名称', exact: true })
      await expect(name).toBeFocused()
      await name.fill('预览临时分类')
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(name).toHaveCount(0)
      await add.click()
      await expect(collection).toBeEnabled()
      await collection.hover()
      await create.click()
      await name.fill('预览临时分类')
      await page.getByRole('button', { name: '创建分类', exact: true }).click()
      await expect(joined).toHaveCount(0)
      await expect(paper.getByRole('checkbox')).toBeChecked()
      await expect(paper.getByRole('checkbox')).toBeDisabled()
      await pages.getByRole('button', { name: '下一页', exact: true }).click()
      await pages.getByRole('button', { name: '上一页', exact: true }).click()
      await receipt.click()
      await expect(joined).toHaveCount(0)
      await add.click()
      await expect(collection).toBeEnabled()
      await collection.hover()
      await expect(create).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '预览临时分类', exact: true })).toHaveCount(0)
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
