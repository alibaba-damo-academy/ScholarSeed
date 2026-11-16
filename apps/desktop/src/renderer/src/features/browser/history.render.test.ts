import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })

async function openHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: '更多历史记录操作' }).click()
  await page.getByRole('menuitem', { name: '打开页面', exact: true }).click()
}

test('opening clear browsing data dismisses the history row menu', { timeout: 60_000 }, async () =>
  fixture(async (page) => {
    await resolveQuery(page, 0, 'Visited page')
    const actions = page.getByRole('button', { name: '更多历史记录操作' })
    const menuItem = page.locator('[role="menuitem"]').filter({ hasText: '打开页面' })
    const clear = page.getByRole('button', { name: '清除浏览数据', exact: true })
    await actions.click()
    await expect(menuItem).toBeVisible()
    await clear.press('Enter')
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(menuItem).toHaveCount(0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(menuItem).toHaveCount(0)
    await expect(clear).toBeFocused()
    await actions.click()
    await expect(menuItem).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(actions).toBeFocused()
  })
)

test(
  'history title, URL, and keyboard activation reopen once outside bulk selection',
  { timeout: 60_000 },
  async () => {
    await Promise.all(
      ['title', 'url', 'keyboard'].map((entry) =>
        fixture(async (page) => {
          const title = 'Reopen visit'
          await resolveQuery(page, 0, title)
          const target = page.getByTestId('browser-history-open')
          await page.getByRole('button', { name: '批量清除记录' }).click()
          await expect(target).toHaveCount(0)
          await page.getByText(title, { exact: true }).click()
          await page.getByText(row(title).url, { exact: true }).click()
          await count(page, 1)
          await page.getByRole('button', { name: '取消', exact: true }).click()
          if (entry === 'title') {
            await target.getByText(title, { exact: true }).hover()
            await expect(target).toHaveCSS('cursor', 'pointer')
          }
          if (entry === 'keyboard') await target.press('Enter')
          else {
            await target
              .getByText(entry === 'title' ? title : row(title).url, { exact: true })
              .click()
          }
          await count(page, 2)
          const request = await page.evaluate(
            () => (window as unknown as { historyRequests: unknown[] }).historyRequests[1]
          )
          assert.deepEqual(request, { kind: 'reopen', id: row(title).id })
        })
      )
    )
  }
)

test(
  'archive selection is opt-in and icon deletion still requires confirmation',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      let deletions = 0
      await page.route('**/api/content/projects**', (route) => {
        if (route.request().method() === 'DELETE') deletions += 1
        return route.fulfill({
          json: {
            projects: [
              {
                id: 'archived-one',
                name: 'Archived project',
                root: '/fixture/archive',
                archived_at: 1,
              },
              {
                id: 'archived-two',
                name: 'Another archive',
                root: '/fixture/another',
                archived_at: 1,
              },
            ],
            current: '',
            workspaceRoot: '/fixture',
          },
        })
      })
      await page.getByTestId('account-settings-nav-archives').click()
      const archive = page.getByTestId('account-settings-archives')
      await expect(archive.getByTestId('account-archived-archived-one')).toBeVisible()
      await expect(archive.getByTestId('account-archived-batch-bar')).toBeHidden()
      await expect(archive.getByText('Archived project', { exact: true })).toHaveCount(1)
      const remove = archive.getByTestId('account-archived-delete-archived-one')
      await expect(remove).toHaveText('')
      await archive.getByTestId('account-archived-restore-archived-one').hover()
      await expect(page.getByRole('tooltip', { name: '取消归档', exact: true })).toBeVisible()
      await remove.hover()
      await expect(page.getByRole('tooltip', { name: '永久删除', exact: true })).toBeVisible()
      await remove.click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      assert.equal(deletions, 0)
      await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
      await expect(archive.getByTestId('account-archived-selection-mode')).toHaveText('批量管理')
      await archive.getByTestId('account-archived-selection-mode').click()
      await expect(archive.getByTestId('account-archived-selection-mode')).toHaveText(
        '退出批量管理'
      )
      await expect(archive.getByTestId('account-archived-batch-bar')).toBeVisible()
      const selectAllBox = await archive.getByTestId('account-archived-select-all').boundingBox()
      const projectBox = await archive
        .getByTestId('account-archived-select-archived-one')
        .boundingBox()
      assert.ok(selectAllBox && projectBox)
      assert.equal(selectAllBox.x, projectBox.x)
      const selectAllText = await archive
        .getByTestId('account-archived-select-all')
        .locator('.vds-checkbox__label')
        .boundingBox()
      const projectText = await archive.getByText('Archived project', { exact: true }).boundingBox()
      assert.ok(selectAllText && projectText)
      assert.equal(selectAllText.x, projectText.x)
      await archive.getByTestId('account-archived-select-all').click()
      await expect(archive.getByTestId('account-archived-selected-count')).toHaveText('已选 2 项')
      await archive.getByTestId('account-archived-selection-mode').click()
      await expect(archive.getByTestId('account-archived-batch-bar')).toBeHidden()
      assert.equal(deletions, 0)
    }, '?store')
)

test(
  'model service keeps connection actions in its footer and removes duplicate provider controls',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.route('**/api/serve/model-providers', (route) =>
        route.fulfill({
          json: {
            providers: [
              {
                id: 'first',
                label: 'First provider',
                base_url: 'https://first.example.invalid/v1',
                wire_api: 'responses',
                note: '',
                credential_hint: '',
              },
              {
                id: 'second',
                label: 'Second provider',
                base_url: 'https://second.example.invalid/v1',
                wire_api: 'responses',
                note: '',
                credential_hint: '',
              },
            ],
          },
        })
      )
      await page.route('**/api/serve/model-profiles', (route) =>
        route.fulfill({ json: { path: '', profiles: [], enabled_profile_ids: [] } })
      )
      await page.getByTestId('account-settings-nav-models').click()
      const models = page.getByTestId('account-settings-models')
      await expect(models.getByTestId('model-endpoint-form')).toBeVisible()
      await expect(models.getByTestId('model-endpoint-title')).toHaveText('First provider')
      await expect(models.getByTestId('model-endpoint-provider')).toHaveCount(0)
      await expect(models.getByTestId('model-endpoint-cancel')).toHaveCount(0)
      await expect(models.locator('.vds-avatar')).toHaveCount(0)
      const footer = models.getByTestId('model-endpoint-footer')
      await expect(footer.getByTestId('model-endpoint-probe')).toHaveClass(/vds-button--outline/)
      await expect(footer.getByTestId('model-endpoint-status')).toContainText('未验证')
      await models.getByTestId('model-vendor-empty-second').click()
      await expect(models.getByTestId('model-endpoint-title')).toHaveText('Second provider')
      const addProvider = page.getByTestId('model-connection-add')
      await expect(addProvider).toHaveClass(/vds-button--outline/)
      await expect(models.locator('aside').getByTestId('model-connection-add')).toHaveCount(0)
      const serviceTab = await page
        .getByRole('tab', { name: '模型服务', exact: true })
        .boundingBox()
      const addBounds = await addProvider.boundingBox()
      assert.ok(serviceTab && addBounds)
      assert.ok(
        Math.abs(serviceTab.y + serviceTab.height / 2 - addBounds.y - addBounds.height / 2) < 1
      )
      assert.ok(addBounds.x > serviceTab.x + serviceTab.width)
      await addProvider.click()
      await expect(models.getByTestId('model-endpoint-name')).toHaveValue('')
      await expect(models.getByTestId('model-endpoint-base-url')).toHaveValue('')
      await page.getByRole('tab', { name: '模型配置', exact: true }).click()
      await expect(addProvider).toBeHidden()
      const tabBounds = await page.getByRole('tab', { name: '模型配置', exact: true }).boundingBox()
      const saveBounds = await page.getByTestId('model-settings-save').boundingBox()
      assert.ok(tabBounds && saveBounds)
      assert.ok(
        Math.abs(tabBounds.y + tabBounds.height / 2 - saveBounds.y - saveBounds.height / 2) < 1
      )
    }, '?store')
)

for (const outcome of ['disabled', 'deleted', 'unreadable'] as const) {
  test(
    `model toggle failure reconciles ${outcome} inventory without replaying the write`,
    { timeout: 60_000 },
    async () =>
      fixture(async (page) => {
        let writes = 0
        let reads = 0
        const profile = {
          id: 'reconcile',
          preview_name: 'Reconcile subscription',
          provider: 'openai',
          authentication: 'oauth',
          oauth_provider: 'chatgpt',
          enabled: true,
          selected_models: [],
          oauth: { state: 'disconnected', registered: true },
        }
        await page.route('**/api/serve/model-providers', (route) =>
          route.fulfill({ json: { providers: [] } })
        )
        await page.route('**/api/serve/models**', (route) =>
          route.fulfill({ status: 503, json: { detail: 'update_maintenance' } })
        )
        await page.route('**/api/serve/model-profiles', (route) => {
          reads++
          if (writes && outcome === 'unreadable') return route.fulfill({ status: 503, json: {} })
          return route.fulfill({
            json: {
              path: '',
              profiles: writes && outcome === 'deleted' ? [] : [{ ...profile, enabled: !writes }],
              enabled_profile_ids: writes ? [] : [profile.id],
            },
          })
        })
        await page.route('**/api/serve/model-profiles/reconcile/enabled', (route) => {
          writes++
          return route.fulfill({
            status: outcome === 'deleted' ? 404 : 503,
            json: { detail: 'request failed' },
          })
        })
        await page.getByTestId('account-settings-nav-models').click()
        const toggle = page.getByTestId('model-connection-enabled-reconcile')
        await expect(toggle).toBeChecked()
        const before = reads
        await toggle.click()
        await expect.poll(() => reads).toBeGreaterThan(before)
        if (outcome === 'deleted') await expect(toggle).toHaveCount(0)
        else if (outcome === 'disabled') await expect(toggle).not.toBeChecked()
        else await expect(toggle).toBeChecked()
        assert.equal(writes, 1)
      }, '?store')
  )
}

test('settings use grouped surfaces and regular field typography', { timeout: 60_000 }, async () =>
  fixture(async (page) => {
    const navigation = page
      .getByTestId('account-settings-shell')
      .getByRole('navigation', { name: '账号设置', exact: true })
    for (const button of await navigation.getByRole('button').all()) {
      await expect(button).toHaveCSS('font-size', '14px')
      await expect(button.locator(':scope > span').last()).toHaveCSS('font-size', '14px')
    }
    await page.getByTestId('account-settings-nav-notifications').click()
    const settings = page.getByTestId('account-settings-notifications')
    const title = settings.getByText('桌面通知', { exact: true })
    await expect(title).toHaveCSS('font-size', '14px')
    await expect(title).toHaveCSS('font-weight', '400')
    const description = title.locator('..').locator(':scope > div').nth(1)
    await expect(description).toHaveCSS('font-size', '12px')
    await expect(description).toHaveCSS('font-weight', '400')
    const colors = await page.getByTestId('account-settings-shell').evaluate((shell) => {
      const style = getComputedStyle(shell)
      return {
        nav: getComputedStyle(shell.querySelector('aside')!).backgroundColor,
        main: getComputedStyle(shell.querySelector('main')!).backgroundColor,
        fill3: style.getPropertyValue('--vds-fill-3').trim(),
        fill1: style.getPropertyValue('--vds-fill-1').trim(),
      }
    })
    const normalize = async (color: string) =>
      page.evaluate((value) => {
        const element = document.createElement('span')
        element.style.color = value
        document.body.append(element)
        const resolved = getComputedStyle(element).color
        element.remove()
        return resolved
      }, color)
    assert.equal(colors.nav, await normalize(colors.fill3))
    assert.equal(colors.main, await normalize(colors.fill1))
    const row = title.locator('../..')
    const operation = settings.getByTestId('notification-desktop')
    const copyBounds = await title.boundingBox()
    const operationBounds = await operation.boundingBox()
    assert.ok(copyBounds && operationBounds && copyBounds.x < operationBounds.x)
    await expect(row).toHaveCSS('border-bottom-width', '1px')
    await page.getByTestId('account-settings-nav-prompts').click()
    const restore = page.getByTestId('selection-prompt-restore-explain')
    await expect(restore).toHaveText('')
    await expect(restore.locator('svg')).toHaveCount(1)
    await restore.locator('..').hover()
    await expect(page.getByRole('tooltip')).toHaveText('恢复初始配置')
    const prompt = page.getByTestId('selection-prompt-explain')
    const original = await prompt.inputValue()
    await prompt.fill(`${original} test`)
    await expect(restore).toBeEnabled()
    await restore.click()
    await expect(prompt).toHaveValue(original)
    await expect(restore).toBeDisabled()
    const restoreBounds = await restore.boundingBox()
    const promptBounds = await prompt.boundingBox()
    assert.ok(
      restoreBounds && promptBounds && restoreBounds.y + restoreBounds.height <= promptBounds.y
    )
    await expect(prompt).toHaveCSS('height', '96px')
    await page.getByTestId('account-settings-nav-translation').click()
    const translation = page.getByTestId('account-settings-translation')
    const scrollBounds = await translation.locator('[data-slot="page-body"]').boundingBox()
    const mainBounds = await translation.locator('..').boundingBox()
    assert.ok(
      scrollBounds &&
        mainBounds &&
        Math.abs(scrollBounds.x + scrollBounds.width - mainBounds.x - mainBounds.width) < 2
    )
    const sectionTitle = translation.getByRole('heading', { name: '默认翻译服务', exact: true })
    await expect(sectionTitle).toHaveCSS('font-size', '14px')
    await expect(sectionTitle).toHaveCSS('font-weight', '400')
    const configuration = sectionTitle.locator('..').locator('.vds-card')
    await expect(configuration).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    const field = configuration.getByText('PDF 划词即翻译', { exact: true })
    await expect(field).toHaveCSS('font-size', '14px')
    await expect(field).toHaveCSS('font-weight', '400')
    const translationRestore = translation.getByRole('button', { name: '恢复默认', exact: true })
    await expect(translationRestore).toHaveText('')
    await translationRestore.locator('..').hover()
    await expect(page.getByRole('tooltip')).toHaveText('恢复默认')
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      const shell = page.getByTestId('account-settings-shell')
      const semanticColors = await shell.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          nav: getComputedStyle(element.querySelector('aside')!).backgroundColor,
          main: getComputedStyle(element.querySelector('main')!).backgroundColor,
          navToken: style.getPropertyValue('--vds-bg-component').trim(),
          mainToken: style.getPropertyValue('--vds-bg-gray-light-default').trim(),
        }
      })
      assert.equal(semanticColors.nav, await normalize(semanticColors.navToken))
      assert.equal(semanticColors.main, await normalize(semanticColors.mainToken))
    }
  }, '?store')
)

test(
  'history groups visits by date and exposes selection and row actions',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Grouped visit')
      const history = page.getByTestId('browser-settings-history')
      await expect(history.getByTestId('browser-history-list').locator('hr')).toHaveCount(0)
      const search = await history.getByRole('searchbox').boundingBox()
      const clear = await history
        .getByRole('button', { name: '清除浏览数据', exact: true })
        .boundingBox()
      assert.ok(search && clear && Math.abs(search.y - clear.y) < 2)
      await expect(history.getByRole('checkbox')).toHaveCount(0)
      await history.getByRole('button', { name: '批量清除记录' }).click()
      await expect(history.getByRole('checkbox')).toHaveCount(1)
      await expect(history.getByRole('button', { name: '全选', exact: true })).toBeVisible()
      await expect(history.getByRole('button', { name: '移除所选记录' })).toHaveCount(0)
      await history.getByRole('checkbox').check()
      await expect(history.getByRole('button', { name: '移除所选记录' })).toBeEnabled()
      await history.getByRole('button', { name: '更多历史记录操作' }).click()
      await expect(page.getByRole('menuitem', { name: '打开页面' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '删除记录' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: '打开页面' }).locator('svg')).toHaveCount(1)
      await expect(page.getByRole('menuitem', { name: '删除记录' }).locator('svg')).toHaveCount(1)
      const deletion = page.getByRole('menuitem', { name: '删除记录' })
      const deletionColor = await deletion.evaluate((element) => getComputedStyle(element).color)
      await expect(deletion.locator('svg')).toHaveCSS('color', deletionColor)
      await page.keyboard.press('Escape')
      await history.getByRole('button', { name: '取消', exact: true }).click()
      await expect(history.getByRole('checkbox')).toHaveCount(0)
      const group = history.getByRole('button', { expanded: true })
      await group.click()
      await expect(history.getByText('Grouped visit')).not.toBeVisible()
    })
)

test('browser settings are reachable from the settings sidebar and direct history links', async () => {
  await fixture(async (page) => {
    await expect(page.getByTestId('account-settings-shell')).toBeVisible()
    await expect(page.getByTestId('account-settings-nav-browser')).toBeVisible()
    await expect(page.getByTestId('account-settings-nav-notifications')).toBeVisible()
    await expect(page.getByTestId('account-settings-browser-history')).toBeVisible()
    await page.getByTestId('account-settings-nav-notifications').click()
    await expect(page.getByTestId('account-settings-browser-history')).toHaveCount(0)
    await page.getByTestId('account-settings-nav-browser').click()
    await expect(page.getByTestId('account-settings-browser')).toBeVisible()
  }, '?store')
})

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('collapsed history dates stack without reserving space and empty results show no dates', async () => {
  await fixture(async (page) => {
    await page.evaluate(
      (items) => {
        const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
        host.historyResolve(0, { ok: true, page: { items, total: items.length } })
      },
      [
        { ...row('Recent visit'), visitedAt: 172800000 },
        { ...row('Older visit'), id: 'older-visit' },
      ]
    )
    const history = page.getByTestId('browser-settings-history')
    const dates = history.locator('.vds-collapsible__trigger')
    await expect(dates).toHaveCount(2)
    await dates.first().click()
    await expect(dates.first()).toHaveAttribute('aria-expanded', 'false')
    const list = history.getByTestId('browser-history-list')
    const expectedGap = await list.evaluate((element) =>
      parseFloat(getComputedStyle(element).rowGap)
    )
    const first = await dates.first().boundingBox()
    const second = await dates.last().boundingBox()
    assert.ok(first && second)
    assert.ok(Math.abs(second.y - first.y - first.height - expectedGap) < 1)
    await expect(history.getByText('Recent visit', { exact: true })).toBeHidden()
    await history.getByRole('searchbox').fill('no matching visit')
    await count(page, 2)
    await resolveQuery(page, 1, '', 0)
    await expect(history.getByText('没有浏览记录', { exact: true })).toBeVisible()
    await expect(dates).toHaveCount(0)
  }, '?store')
})

async function openClearDialog(page: Page) {
  await page.getByRole('button', { name: '清除浏览数据', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
  await expect(dialog.locator('.vds-dialog__description')).toHaveCSS('font-weight', '400')
  await page
    .getByRole('alertdialog')
    .getByRole('checkbox', { name: '浏览历史', exact: true })
    .check()
}

test(
  'bulk removal stops at a failed reply and refreshes without replay',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.evaluate(() => {
        const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
        host.historyResolve(0, {
          ok: true,
          page: {
            total: 3,
            items: ['first', 'second', 'third'].map((id, index) => ({
              id,
              title: id,
              url: 'https://example.org/' + id,
              visitedAt: 100000000 - index * 86400000,
            })),
          },
        })
      })
      const history = page.getByTestId('browser-settings-history')
      const dateTriggers = history.locator('.vds-collapsible__trigger')
      const dates = dateTriggers.and(history.getByRole('button', { expanded: false }))
      await expect(dateTriggers.and(history.getByRole('button', { expanded: true }))).toHaveCount(1)
      await expect(dates).toHaveCount(2)
      await dateTriggers.first().click()
      await expect(dates).toHaveCount(3)
      await history.getByRole('button', { name: '批量清除记录' }).click()
      await expect(dates).toHaveCount(0)
      const checks = history.getByRole('checkbox')
      await expect(checks).toHaveCount(3)
      await expect(checks.and(history.getByRole('checkbox', { checked: true }))).toHaveCount(0)
      await history.getByRole('button', { name: '全选', exact: true }).click()
      await expect(checks.and(history.getByRole('checkbox', { checked: true }))).toHaveCount(3)
      await page.getByRole('button', { name: '移除所选记录' }).click()
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(1, { ok: true, deleted: true })
      )
      await count(page, 3)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(2, { ok: false, error: 'operation_failed' })
      )
      await count(page, 4)
      const kinds = await page.evaluate(() =>
        (window as unknown as { historyRequests: { kind: string }[] }).historyRequests.map(
          (request) => request.kind
        )
      )
      assert.deepEqual(kinds, ['query', 'delete', 'delete', 'query'])
      await resolveQuery(page, 3, 'second', 2)
      await expect(page.getByTestId('browser-settings-history').getByRole('alert')).toBeVisible()
      await expect(history.getByRole('button', { name: '移除所选记录' })).toHaveCount(0)
      await expect(history.getByRole('button', { name: '全选', exact: true })).toBeEnabled()
    })
)
test('history separators appear only between records in a date group', async () => {
  await fixture(async (page) => {
    await page.evaluate(
      (items) => {
        const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
        host.historyResolve(0, { ok: true, page: { items, total: items.length } })
      },
      [row('First'), { ...row('Last'), id: '12345678-1234-1234-1234-123456789abd' }]
    )
    const rows = page.getByTestId('browser-history-list').locator('ul > li')
    await expect(rows).toHaveCount(2)
    await expect(rows.first().locator('hr')).toHaveCount(1)
    await expect(rows.last().locator('hr')).toHaveCount(0)
  })
})

const row = (title: string) => ({
  id: '12345678-1234-1234-1234-123456789abc',
  title,
  url: 'https://example.org/paper',
  visitedAt: 1,
})
async function resolveQuery(page: Page, index: number, title: string, total = 1) {
  await page.evaluate(
    ({ index, title, total, visit }) => {
      const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
      host.historyResolve(index, {
        ok: true,
        page: { items: title ? [{ ...visit, title }] : [], total },
      })
    },
    { index, title, total, visit: row(title) }
  )
}
async function count(page: Page, expected: number) {
  await page
    .waitForFunction(
      (expected) =>
        (window as unknown as { historyRequests: unknown[] }).historyRequests.length === expected,
      expected,
      { timeout: 10_000 }
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        requests: (window as unknown as { historyRequests: unknown[] }).historyRequests,
        body: document.body.innerText,
      }))
      throw Object.assign(
        new Error(`Expected ${expected} history requests: ${JSON.stringify(state)}`),
        { cause: error }
      )
    })
}
async function fixture(run: (page: Page) => Promise<void>, mode = '') {
  const baseline = process.env.T6A_HISTORY_BASELINE
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [
      ...(baseline
        ? [
            {
              name: 'exact-before-settings',
              enforce: 'pre' as const,
              load(id: string) {
                if (id === path.join(ROOT, 'features/browser/Settings.tsx'))
                  return readFileSync(baseline, 'utf8')
              },
            },
          ]
        : []),
      react(),
    ],
    cacheKey: `browser-history-${baseline ? 'before' : 'current'}`,
    server: { host: '127.0.0.1', port: 0, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(
      new URL(`/features/browser/history.render.fixture.html${mode}`, server.resolvedUrls!.local[0])
        .href
    )
    await page.getByRole('button', { name: '管理', exact: true }).click()
    await count(page, 1)
    await run(page)
  } finally {
    await browser.close()
    await server.close()
  }
}

test(
  'history section replaces overview with shared search, results and a return action',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Overview visit')
      await page.getByRole('button', { name: 'Switch section' }).click()
      await expect(page.getByTestId('browser-settings-history')).toHaveCount(0)
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      const descriptions = page.getByTestId('browser-settings-advanced').locator('p')
      assert.ok(await descriptions.count())
      for (const description of await descriptions.all()) {
        await expect(description).toHaveCSS('font-size', '12px')
        await expect(description).toHaveCSS('line-height', '18px')
      }
      const titleTypography = (element: Element) => {
        const { fontSize, lineHeight } = getComputedStyle(element)
        return { fontSize, lineHeight }
      }
      const overviewTitle = await page
        .getByTestId('account-settings-browser')
        .getByRole('heading', { level: 1 })
        .evaluate(titleTypography)
      await page.getByRole('button', { name: '管理', exact: true }).click()
      await count(page, 2)
      const breadcrumb = page.getByRole('navigation', { name: '面包屑导航' })
      await expect(breadcrumb.getByText('浏览历史', { exact: true })).toBeVisible()
      assert.deepEqual(await breadcrumb.evaluate(titleTypography), overviewTitle)
      const inactive = breadcrumb.getByRole('link', { name: '浏览器设置', exact: true })
      const tertiary = await inactive.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--vds-text-tertiary)'
        element.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      })
      await expect(inactive).toHaveCSS('color', tertiary)
      await expect(page.getByTestId('browser-settings-cdp')).toHaveCount(0)
      await expect(page.getByTestId('browser-settings-history')).toHaveCount(1)
      await resolveQuery(page, 1, 'History visit')
      await expect(page.getByText('History visit')).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0)
      await page
        .getByRole('navigation', { name: '面包屑导航' })
        .getByRole('link', { name: '浏览器设置', exact: true })
        .click()
      await expect(page.getByRole('button', { name: '管理', exact: true })).toBeVisible()
    }, '?advanced')
)

test(
  'clear success preserves search, corrects the last page and shares the mutation slot',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Initial', 41)
      await page.getByRole('searchbox').fill('paper')
      await count(page, 2)
      await resolveQuery(page, 1, 'Filtered', 41)
      await page.getByRole('button', { name: '第 3 页', exact: true }).click()
      await count(page, 3)
      await resolveQuery(page, 2, 'Last page', 41)
      await openClearDialog(page)
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: '清除所选数据', exact: true })
        .click()
      await expect(page.getByRole('button', { name: '更多历史记录操作' })).toBeDisabled()
      await page.evaluate(() =>
        (
          window as unknown as { historyClearResolve(index: number, reply: unknown): void }
        ).historyClearResolve(0, { ok: true })
      )
      await count(page, 4)
      await resolveQuery(page, 3, '', 0)
      await count(page, 5)
      await resolveQuery(page, 4, '', 0)
      await expect(page.getByRole('searchbox')).toHaveValue('paper')
      const query = await page.evaluate(
        () =>
          (
            window as unknown as {
              historyRequests: { query: { offset: number; search: string } }[]
            }
          ).historyRequests.at(-1)!.query
      )
      assert.deepEqual(
        { offset: query.offset, search: query.search },
        { offset: 0, search: 'paper' }
      )
      await expect(page.getByText('浏览数据已清除。')).toBeVisible()
      await expect(
        page.locator('p[role="status"]').filter({ hasText: '浏览数据已清除。' })
      ).toHaveCount(0)
    })
)

test(
  'history pending blocks clear and stale section reopen cannot navigate',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await openHistory(page)
      await count(page, 2)
      await expect(page.getByRole('button', { name: '清除浏览数据', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: 'Switch section' }).click()
      await page.getByRole('button', { name: '管理', exact: true }).click()
      await expect(
        page.getByRole('navigation', { name: '面包屑导航' }).getByText('浏览历史', { exact: true })
      ).toBeVisible()
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { historyRequests: unknown[] }).historyRequests.length
        ),
        2
      )
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(1, { ok: true })
      )
      await count(page, 3)
      await expect(page.getByTestId('reopened-count')).toHaveText('0')
    })
)

test(
  'synchronous close retirement rejects results before React cleanup',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await page.evaluate(() => {
        const host = window as unknown as {
          historyRetire(): void
          historyResolve(index: number, reply: unknown): void
        }
        host.historyRetire()
        host.historyResolve(0, {
          ok: true,
          page: {
            items: [
              { id: 'old', url: 'https://old.test', title: 'Forbidden late query', visitedAt: 1 },
            ],
            total: 1,
          },
        })
      })
      await expect(page.getByText('Forbidden late query')).toHaveCount(0)
    })
)

test(
  'clear generation rejects pre-cleanup old total without resetting the selected page',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Initial', 41)
      await page.getByRole('button', { name: '第 3 页', exact: true }).click()
      await count(page, 2)
      await openClearDialog(page)
      await page.evaluate(() => {
        const dialog = document.querySelector('[role="alertdialog"]')!
        const action = [...dialog.querySelectorAll('button')].find(
          (element) => element.textContent === '清除所选数据'
        )!
        action.click()
        const host = window as unknown as {
          historyClearResolve(index: number, reply: unknown): void
          historyResolve(index: number, reply: unknown): void
        }
        host.historyClearResolve(0, { ok: true, deleted: 0 })
        queueMicrotask(() => host.historyResolve(1, { ok: true, page: { items: [], total: 0 } }))
      })
      await count(page, 3)
      const query = await page.evaluate(
        () =>
          (
            window as unknown as { historyRequests: { query: { offset: number } }[] }
          ).historyRequests.at(-1)!.query
      )
      assert.equal(query.offset, 40)
      await resolveQuery(page, 2, 'Current page', 41)
      await expect(page.getByText('Current page')).toBeVisible()
    })
)

test(
  'clear failure keeps the filter, rereads without success and does not fabricate deletion',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('searchbox').fill('paper')
      await count(page, 2)
      await resolveQuery(page, 1, 'Filtered visit')
      await openClearDialog(page)
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: '清除所选数据', exact: true })
        .click()
      await page.evaluate(() =>
        (
          window as unknown as { historyClearResolve(index: number, reply: unknown): void }
        ).historyClearResolve(0, { ok: false, error: 'operation_failed' })
      )
      await count(page, 3)
      await resolveQuery(page, 2, 'Still saved')
      await expect(page.getByText('Still saved')).toBeVisible()
      await expect(page.getByRole('searchbox')).toHaveValue('paper')
      await expect(page.getByText('浏览数据已清除。')).toHaveCount(0)
      await expect(page.getByTestId('browser-clear-error')).toBeVisible()
    })
)

test(
  'delete and reopen synchronously refuse duplicate clicks before disabled render',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('button', { name: '批量清除记录' }).click()
      await page.getByRole('checkbox').check()
      await page.evaluate(() => {
        const button = [
          ...document.querySelectorAll('[data-testid="browser-settings-history"] button'),
        ].find((element) => element.textContent === '移除所选记录') as HTMLButtonElement
        button.click()
        button.click()
      })
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(1, { ok: true, deleted: true })
      )
      await count(page, 3)
      await resolveQuery(page, 2, 'Another visit')
      await page.getByRole('button', { name: '更多历史记录操作' }).click()
      await page.evaluate(() => {
        const button = document.querySelector('[role="menuitem"]') as HTMLElement
        button.click()
        button.click()
      })
      await count(page, 4)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(3, {
          ok: true,
          snapshot: {
            tabs: [],
            activeTabId: 'history-page',
            automation: { enabled: false, port: null },
          },
        })
      )
      await expect(page.getByTestId('reopened-count')).toHaveText('1')
    })
)

test(
  'close intent rejects a mounted reopen before React commits and cannot affect a new settings instance',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await openHistory(page)
      await count(page, 2)
      await page.evaluate(() => {
        const host = window as unknown as {
          historyRetire(): void
          historyResolve(index: number, reply: unknown): void
        }
        host.historyRetire()
        host.historyResolve(1, { ok: true })
      })
      await expect(page.getByTestId('reopened-count')).toHaveText('0')
      await page.evaluate(() => (window as unknown as { historyClose(): void }).historyClose())
      await expect(page.getByTestId('account-settings-browser-history')).toHaveCount(0)
      await page.evaluate(() => (window as unknown as { historyOpen(): void }).historyOpen())
      // The retired reopen cannot trigger a reread; only the new instance queries again.
      await count(page, 3)
      await resolveQuery(page, 2, 'New instance')
      await expect(page.getByText('New instance')).toBeVisible()
      await expect(page.getByTestId('reopened-count')).toHaveText('0')
    })
)

test(
  'late clear failure cannot write to a newly mounted settings instance',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await openClearDialog(page)
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: '清除所选数据', exact: true })
        .click()
      await page.evaluate(() => (window as unknown as { historyClose(): void }).historyClose())
      await expect(page.getByTestId('account-settings-browser-history')).toHaveCount(0)
      await page.evaluate(() => (window as unknown as { historyOpen(): void }).historyOpen())
      await count(page, 2)
      await resolveQuery(page, 1, 'New instance')
      await page.evaluate(() =>
        (
          window as unknown as { historyClearResolve(index: number, reply: unknown): void }
        ).historyClearResolve(0, { ok: false, error: 'operation_failed' })
      )
      await expect(page.getByTestId('browser-clear-error')).toHaveCount(0)
      await expect(page.getByText('New instance')).toBeVisible()
    })
)

test(
  'real StoreProvider and AccountPanel reject close-before-render reopen and preserve one normal callback',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Actual AccountPanel visit')
      await openHistory(page)
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyStoreCloseAndResolve(index: number): void }
        ).historyStoreCloseAndResolve(1)
      )
      await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
      await expect(page.getByTestId('store-view')).toHaveText('home')
      await expect(page.getByTestId('store-close-count')).toHaveText('0')
      await page.evaluate(() =>
        (window as unknown as { historyStoreOpen(section: string): void }).historyStoreOpen(
          'history'
        )
      )
      await count(page, 3)
      await resolveQuery(page, 2, 'New actual host')
      await openHistory(page)
      await count(page, 4)
      await page.evaluate(() =>
        (
          window as unknown as { historyResolve(index: number, reply: unknown): void }
        ).historyResolve(3, {
          ok: true,
          snapshot: {
            tabs: [],
            activeTabId: 'history-page',
            automation: { enabled: false, port: null },
          },
        })
      )
      await expect(page.getByTestId('account-settings-shell')).toHaveCount(0)
      await expect(page.getByTestId('store-view')).toHaveText('browser')
      await expect(page.getByTestId('store-browser-page')).toHaveText('history-page')
      await expect(page.getByTestId('store-close-count')).toHaveText('1')
    }, '?store')
)

test(
  'actual Store settings intents retire before commit, normalize direct patches and retain batched identity',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      const results = await page.evaluate(() => {
        const host = window as unknown as {
          historyStoreCapture(): void
          historyStoreIsCapturedCurrent(): boolean
          historyStoreOpen(section?: string): void
          historyStoreClose(): void
          historyStorePatch(patch: object): void
        }
        host.historyStoreCapture()
        host.historyStoreOpen('history')
        const same = host.historyStoreIsCapturedCurrent()
        host.historyStoreOpen('overview')
        const retired = host.historyStoreIsCapturedCurrent()
        host.historyStoreOpen('history')
        const returned = host.historyStoreIsCapturedCurrent()
        host.historyStorePatch({ browserSettingsSection: 'downloads' })
        return { same, retired, returned }
      })
      assert.deepEqual(results, { same: true, retired: false, returned: false })
      await expect(page.getByTestId('store-section')).toHaveText('overview')
      await page.evaluate(() =>
        (window as unknown as { historyStorePatch(patch: object): void }).historyStorePatch({
          accountSettingsPage: 'models',
          browserSettingsSection: 'history',
        })
      )
      await expect(page.getByTestId('store-section')).toHaveText('null')
      await page.evaluate(() =>
        (window as unknown as { historyStoreOpen(section: string): void }).historyStoreOpen(
          'history'
        )
      )
      await expect(page.getByTestId('store-section')).toHaveText('history')
      await page.evaluate(() =>
        (window as unknown as { historyStoreClose(): void }).historyStoreClose()
      )
      await expect(page.getByTestId('store-section')).toHaveText('null')
    }, '?store')
)

test(
  'real AccountPanel close-open batched roundtrip rejects the old reopen lease',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Actual visit')
      await openHistory(page)
      await count(page, 2)
      await page.evaluate(() =>
        (
          window as unknown as { historyStoreRoundtripAndResolve(index: number): void }
        ).historyStoreRoundtripAndResolve(1)
      )
      await expect(page.getByTestId('account-settings-shell')).toBeVisible()
      await expect(page.getByTestId('store-view')).toHaveText('home')
      await expect(page.getByTestId('store-close-count')).toHaveText('0')
    }, '?store')
)

test(
  'actual settings navigation leaves composer-only patches isolated and functional section patches authoritative',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await page.getByRole('searchbox').fill('paper')
      await count(page, 2)
      await resolveQuery(page, 1, 'Filtered visit')
      const result = await page.evaluate(() => {
        const host = window as unknown as {
          historyStorePatch(
            patch: object | ((state: { browserSettingsSection: string }) => object)
          ): void
          historyStoreCapture(): void
          historyStoreIsCapturedCurrent(): boolean
          historyStoreDraft(): string
        }
        host.historyStoreCapture()
        host.historyStorePatch({ composerText: 'isolated draft' })
        return { current: host.historyStoreIsCapturedCurrent() }
      })
      assert.equal(result.current, true)
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as unknown as { historyStoreDraft(): string }).historyStoreDraft()
          )
        )
        .toBe('isolated draft')
      await expect(page.getByRole('searchbox')).toHaveValue('paper')
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { historyRequests: unknown[] }).historyRequests.length
        ),
        2
      )
      await page.evaluate(() => {
        const host = window as unknown as {
          historyStorePatch(patch: (state: { browserSettingsSection: string }) => object): void
        }
        host.historyStorePatch(() => ({ browserSettingsSection: 'history' }))
        host.historyStorePatch((state) => ({
          browserSettingsSection:
            state.browserSettingsSection === 'history' ? 'overview' : 'history',
        }))
      })
      await expect(page.getByTestId('store-section')).toHaveText('overview')
    }, '?store')
)

test(
  'section retirement does not resurrect an earlier clear confirmation on return',
  { timeout: 60_000 },
  async () =>
    fixture(async (page) => {
      await resolveQuery(page, 0, 'Visit')
      await openClearDialog(page)
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.evaluate(() =>
        (window as unknown as { historyNavigate(section: string): void }).historyNavigate(
          'overview'
        )
      )
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await page.getByRole('button', { name: '管理', exact: true }).click()
      await expect(
        page.getByRole('navigation', { name: '面包屑导航' }).getByText('浏览历史', { exact: true })
      ).toBeVisible()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
    })
)

test(
  'invalid history bridge replies retain the operation failure state',
  { timeout: 60_000 },
  async () => {
    for (const reply of [null, undefined]) {
      await fixture(async (page) => {
        await page.evaluate((value) => {
          const host = window as unknown as { historyResolve(index: number, reply: unknown): void }
          host.historyResolve(0, value)
        }, reply)
        const history = page.getByTestId('browser-settings-history')
        await expect(history.getByRole('alert')).toBeVisible()
        await expect(history.getByRole('status')).toHaveCount(0)
        await count(page, 1)
      })
    }
  }
)
