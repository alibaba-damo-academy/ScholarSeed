import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

import type {
  ResourceCapability,
  ResourceVersion,
  ResourceVersionDeletePreview,
} from '../../contracts/resources.ts'
import { parseVersionDiffTab } from './tabs.ts'

const servers = renderServers({ after })

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE_URL = '/features/workbench/history.render.fixture.html'
const FILE_PATH = 'resources/history.md'
const INTERACTION_TIMEOUT_MS = 5000
const NAVIGATION_TIMEOUT_MS = 30000
const VERSION: ResourceVersion = {
  id: 'version-test',
  file_id: 'file-test',
  sequence: 1,
  object_id: 'object-test',
  annotation_object_id: null,
  state: 'present',
  path: FILE_PATH,
  origin: 'user',
  created_at_ms: 1789862400000,
  session_id: null,
  turn_id: null,
  source_delivery_id: null,
  restored_from_id: null,
  restored_from_sequence: null,
  alias: null,
  metadata_revision: 1,
}
const CAPABILITY: ResourceCapability = {
  file_id: 'file-test',
  version_id: 'version-current',
  working_revision: 'working-test',
  disk_revision: 'disk-test',
  can_version: true,
  can_diff: true,
  can_preview_history: true,
  management_state: 'managed',
  drifted: false,
  snapshot_state: 'pending',
  pending: {
    file_id: 'file-test',
    revision: 1,
    origin: 'agent',
    review: {
      id: 'review-test',
      group_id: 'group-test',
      session_id: 'session-test',
      first_turn_id: 'turn-test',
      turn_id: 'turn-test',
      terminal_outcome: 'completed',
      origin: 'agent',
      base: {
        object_id: 'object-base',
        state: 'present',
        path: FILE_PATH,
        mode_bits: null,
        annotation_object_id: null,
      },
      candidate: {
        object_id: 'object-candidate',
        state: 'present',
        path: FILE_PATH,
        mode_bits: null,
        annotation_object_id: null,
      },
      base_revision: 'base-test',
      candidate_revision: 'candidate-test',
      edited_by_user: false,
    },
  },
}
const DELETE_PREVIEW: ResourceVersionDeletePreview = {
  version_id: VERSION.id,
  file_id: VERSION.file_id,
  sequence: 1,
  deletable: true,
  blockers: [],
  affected_delivery_ids: [],
  preflight_token: 'preflight-test',
}

async function withHistory(
  run: (page: Page) => Promise<void>,
  options: {
    version?: ResourceVersion
    capability?: ResourceCapability
    resourceSurface?: boolean
  } = {}
): Promise<void> {
  const server = await servers.create({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    cacheKey: 'history',
    server: { host: '127.0.0.1', port: 0 },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.setDefaultTimeout(INTERACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
    const mutations: string[] = []
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request()
        const pathname = new URL(request.url()).pathname
        const deletePreview = pathname === '/api/resource/versions/version-test/delete/preview'
        if (request.method() !== 'GET' && !deletePreview)
          mutations.push(`${request.method()} ${request.url()}`)
        const payload =
          pathname === '/api/resource/capability'
            ? (options.capability ?? CAPABILITY)
            : pathname === '/api/resource/files/file-test/versions'
              ? { versions: [options.version ?? VERSION], next_cursor: null, total: 1 }
              : deletePreview
                ? DELETE_PREVIEW
                : pathname === '/api/literature/searches' || pathname === '/api/v1/literatures'
                  ? { items: [], total: 0 }
                  : null
        if (payload === null)
          throw new Error(`Unexpected history fixture request: ${request.method()} ${pathname}`)
        await route.fulfill({ json: payload })
      }
    )
    try {
      const fixture = new URL(FIXTURE_URL, server.resolvedUrls!.local[0])
      if (options.resourceSurface) fixture.searchParams.set('resource', 'true')
      await page.goto(fixture.toString())
      await page.getByRole('button', { name: '查看版本记录', exact: true }).click()
      await page.getByRole('button', { name: '更多版本操作', exact: true }).waitFor()
      await run(page)
    } catch (error) {
      console.error('Version history fixture failure', {
        errors,
        body: await page.locator('body').innerText(),
      })
      throw error
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(mutations, [], 'opening and cancelling overlays must not mutate a version')
  } finally {
    await browser?.close()
    await server.close()
  }
}

async function assertReceivesPointer(target: Locator): Promise<void> {
  assert.equal(
    await target.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return element.contains(
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      )
    }),
    true,
    'the visible control must receive pointer events above the drawer'
  )
}

test('resource history opens and reopens without mounting the resource sidebar', async () => {
  await withHistory(
    async (page) => {
      const heading = page.getByRole('heading', { name: '文件版本与审阅' })
      assert.equal(await heading.count(), 1)
      await page.getByRole('button', { name: '关闭版本历史', exact: true }).click()
      await heading.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '查看版本记录', exact: true }).click()
      await heading.waitFor({ state: 'visible' })
      assert.equal(await heading.count(), 1)
      await page.getByRole('button', { name: '查看 v1 版本', exact: true }).click()
      await heading.waitFor({ state: 'hidden' })
      assert.equal(
        parseVersionDiffTab(await page.getByTestId('history-active-tab').innerText())?.path,
        FILE_PATH
      )
    },
    { resourceSurface: true, capability: { ...CAPABILITY, snapshot_state: 'saved', pending: null } }
  )
})

test('closing history retains its content for the rightward exit animation', async () => {
  await withHistory(async (page) => {
    const drawer = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: '文件版本与审阅' }) })
    await drawer.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    await page.getByRole('button', { name: '关闭版本历史', exact: true }).click()
    await drawer.waitFor({ state: 'attached' })
    assert.equal(await drawer.getAttribute('data-state'), 'closed')
    assert.equal(
      await drawer.evaluate((element) => getComputedStyle(element).animationName),
      'vds-sheet-out-right'
    )
    assert.equal(
      await drawer.evaluate((element) => {
        const animation = element.getAnimations()[0]
        animation.pause()
        animation.currentTime = 0
        const start = element.getBoundingClientRect().left
        animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
        const middle = element.getBoundingClientRect().left
        animation.play()
        return middle > start
      }),
      true
    )
    await drawer.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '查看版本记录', exact: true }).click()
    await drawer.waitFor({ state: 'visible' })
    assert.equal(await drawer.getAttribute('data-state'), 'open')
  })
})

test('reduced motion closes history without waiting for an animation', async () => {
  await withHistory(async (page) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: '文件版本与审阅' }).waitFor({ state: 'detached' })
  })
})

test('version arrow opens the selected comparison and closes history', async () => {
  await withHistory(
    async (page) => {
      const arrow = page.getByRole('button', { name: '查看 v1 版本', exact: true })
      await arrow.click()
      await page.getByRole('heading', { name: '文件版本与审阅' }).waitFor({ state: 'hidden' })
      assert.deepEqual(
        parseVersionDiffTab(await page.getByTestId('history-active-tab').innerText()),
        {
          project: 'history-test',
          fileId: 'file-test',
          path: FILE_PATH,
          historicalVersionId: 'version-test',
          currentVersionId: 'version-current',
          historicalSequence: 1,
          processor: null,
        }
      )
    },
    { capability: { ...CAPABILITY, snapshot_state: 'saved', pending: null } }
  )
})

test('version arrow is keyboard reachable and can inspect the current version', async () => {
  await withHistory(
    async (page) => {
      for (const key of ['Enter', 'Space']) {
        await page.getByRole('button', { name: '更多版本操作', exact: true }).focus()
        await page.keyboard.press('Tab')
        const arrow = page.getByRole('button', { name: '查看 v1 版本', exact: true })
        assert.equal(await arrow.evaluate((element) => element === document.activeElement), true)
        await page.keyboard.press(key)
        await page.getByRole('heading', { name: '文件版本与审阅' }).waitFor({ state: 'hidden' })
        assert.deepEqual(
          parseVersionDiffTab(await page.getByTestId('history-active-tab').innerText()),
          {
            project: 'history-test',
            fileId: 'file-test',
            path: FILE_PATH,
            historicalVersionId: 'version-test',
            currentVersionId: 'version-test',
            historicalSequence: 1,
            processor: null,
          }
        )
        await page.getByRole('button', { name: '查看版本记录', exact: true }).click()
        await page.getByRole('button', { name: '更多版本操作', exact: true }).waitFor()
      }
    },
    {
      capability: { ...CAPABILITY, snapshot_state: 'saved', pending: null, version_id: VERSION.id },
    }
  )
})

test('unavailable versions do not expose an active inspect arrow', async () => {
  for (const options of [
    { capability: { ...CAPABILITY, can_preview_history: false } },
    { version: { ...VERSION, state: 'tombstone' as const } },
    { version: { ...VERSION, path: 'resources/history.pdf' } },
  ]) {
    await withHistory(async (page) => {
      assert.equal(await page.getByRole('button', { name: '查看 v1 版本', exact: true }).count(), 0)
      assert.equal(await page.getByTestId('version-history-row-action').isDisabled(), true)
      assert.equal(
        parseVersionDiffTab(await page.getByTestId('history-active-tab').innerText()),
        null
      )
    }, options)
  }
})

test('version actions remain clickable above the drawer and Escape preserves history', async () => {
  await withHistory(async (page) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 600, height: 700 },
    ]) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: viewport.width === 600 ? 'dark' : 'light' })
      const trigger = page.getByRole('button', { name: '更多版本操作', exact: true })
      await trigger.click()
      const alias = page.getByRole('menuitem', { name: '设置别名', exact: true })
      await alias.waitFor()
      await assertReceivesPointer(alias)
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
      assert.equal(await page.getByRole('heading', { name: '文件版本与审阅' }).isVisible(), true)
    }
    await page.getByRole('button', { name: '更多版本操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置别名', exact: true }).click()
    await page.getByRole('heading', { name: '设置 v1 的别名' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('heading', { name: '文件版本与审阅' }).isVisible(), true)
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: '文件版本与审阅' }).waitFor({ state: 'hidden' })
  })
})

test('Escape on an expanded version menu trigger dismisses only its menu', async () => {
  await withHistory(async (page) => {
    const trigger = page.getByRole('button', { name: '更多版本操作', exact: true })
    await trigger.click()
    await page.getByRole('menuitem', { name: '设置别名', exact: true }).waitFor()
    await trigger.focus()
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('heading', { name: '文件版本与审阅' }).isVisible(), true)
  })
})

test('history filters stay clickable above the drawer and dismiss independently', async () => {
  await withHistory(async (page) => {
    for (const name of ['版本来源', '版本排序']) {
      const trigger = page.getByRole('combobox', { name, exact: true })
      await trigger.click()
      const option = page.getByRole('option').first()
      await option.waitFor()
      await assertReceivesPointer(option)
      await page.keyboard.press('Escape')
      await page.getByRole('listbox').waitFor({ state: 'hidden' })
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
      assert.equal(await page.getByRole('heading', { name: '文件版本与审阅' }).isVisible(), true)
    }
  })
})

test('version alias dialog escapes its workspace stacking context', async () => {
  await withHistory(async (page) => {
    await page.getByRole('button', { name: '更多版本操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '设置别名', exact: true }).focus()
    await page.keyboard.press('Enter')
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('heading', { name: '设置 v1 的别名' }) })
    await dialog.waitFor()
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    await assertReceivesPointer(cancel)
    await cancel.click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('heading', { name: '文件版本与审阅' }).isVisible(), true)
  })
})

test('version delete confirmation escapes its workspace stacking context', async () => {
  await withHistory(async (page) => {
    await page.getByRole('button', { name: '更多版本操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '删除版本', exact: true }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('alertdialog')
    await dialog.waitFor()
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    await assertReceivesPointer(cancel)
    await cancel.click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('heading', { name: '文件版本与审阅' }).isVisible(), true)
  })
})

test('pending review is a single neutral hint without duplicate review actions', async () => {
  await withHistory(async (page) => {
    const hint = page.getByTestId('version-history-pending-review')
    await hint.waitFor()
    assert.equal(await hint.innerText(), '待审阅')
    assert.equal(await page.getByTestId('snapshot-review').count(), 0)
    for (const name of ['接受', '拒绝', '保存并采纳修改', '查看修改前内容', '下载修改前快照']) {
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0)
    }
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 600, height: 700 },
    ]) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: viewport.width === 600 ? 'dark' : 'light' })
      assert.equal(await hint.isVisible(), true)
      assert.equal(
        await hint.evaluate((element) => element.scrollHeight <= element.clientHeight),
        true
      )
    }
  })
})

test('saved files omit the review hint and ordinary pending saves keep their action', async () => {
  await withHistory(
    async (page) => {
      assert.equal(await page.getByTestId('version-history-pending-review').count(), 0)
      assert.equal(await page.getByTestId('snapshot-pending').count(), 0)
    },
    { capability: { ...CAPABILITY, snapshot_state: 'saved', pending: null } }
  )
  await withHistory(
    async (page) => {
      await page.getByTestId('snapshot-pending').waitFor()
      assert.equal(await page.getByTestId('version-history-pending-review').count(), 0)
      assert.equal(await page.getByTestId('snapshot-save-pending').isVisible(), true)
    },
    {
      capability: {
        ...CAPABILITY,
        pending: { ...CAPABILITY.pending!, origin: 'user', review: null },
      },
    }
  )
})
