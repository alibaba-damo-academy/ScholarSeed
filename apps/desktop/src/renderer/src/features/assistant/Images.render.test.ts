import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { expect, type Page } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'
import { IMAGE_MAX_SCALE, IMAGE_ZOOM_FACTOR } from '../../components/primitive/geometry.ts'
import type { OpenDocumentResult } from '../../contracts/workbench.ts'

const RESOURCE_LIFECYCLE_TIMEOUT_MS = 30_000

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=',
  'base64'
)

async function allowImageArtifactPreview(page: Page): Promise<void> {
  const projection: Pick<
    OpenDocumentResult,
    'viewer' | 'processor' | 'content_kind' | 'capabilities' | 'media_type' | 'size' | 'revision'
  > = {
    viewer: 'image',
    processor: null,
    content_kind: 'binary',
    capabilities: {
      can_preview: true,
      can_edit: false,
      can_select: false,
      can_annotate: false,
      can_save: false,
      can_version: false,
      can_diff: false,
      pending: [],
    },
    media_type: 'image/png',
    size: PIXEL.length,
    revision: `sha256:${createHash('sha256').update(PIXEL).digest('hex')}`,
  }
  await page.route('**/api/serve/sessions/fixture/artifacts/*/open', (route) =>
    route.fulfill({ json: projection })
  )
}

test('sent image sources label imported images without labeling uploads or draft thumbnails', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.route('**/api/serve/sessions/fixture/files/raw?*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  )
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?sources&count=3`)
  const cards = page.locator('[data-slot="image-strip-item"]')
  await expect(cards.nth(0).locator('[data-slot="image-source-label"]')).toHaveCount(0)
  await expect(cards.nth(1).locator('[data-slot="image-source-label"]')).toHaveText('资料')
  await expect(cards.nth(2).locator('[data-slot="image-source-label"]')).toHaveText('文献')
  await cards.nth(1).click()
  await expect(page.getByTestId('attachment-image-viewer').getByRole('heading')).toHaveText(
    'image-1.png'
  )
  await page.keyboard.press('Escape')
  await page.goto(
    `${fixture.url}features/assistant/Images.render.fixture.html?sources&draft&count=3`
  )
  await expect(page.locator('[data-slot="image-source-label"]')).toHaveCount(0)
})

test('generated preview reloads only the selected image and keeps invalid bytes visible as an error', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const reads = new Map<string, number>()
  await allowImageArtifactPreview(page)
  await page.route('**/api/serve/sessions/fixture/artifacts/*/raw', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!
    const attempt = (reads.get(id) ?? 0) + 1
    reads.set(id, attempt)
    if (id === '1' && attempt === 1) {
      await route.fulfill({ status: 404, body: 'missing' })
      return
    }
    await route.fulfill({ contentType: 'image/png', body: id === '2' ? 'not a PNG' : PIXEL })
  })
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?generated&count=3`)
  const firstImage = page.getByRole('img', { name: 'image-0.png', exact: true })
  await expect(firstImage).toBeVisible()
  const firstSource = await firstImage.getAttribute('src')
  await page.getByRole('button', { name: 'image-1.png', exact: true }).click()
  const viewer = page.getByTestId('image-preview')
  const reload = viewer.getByRole('button', { name: '重新加载图片', exact: true })
  await expect(viewer.getByRole('alert')).toContainText('图片加载失败')
  await reload.click()
  await expect(viewer.getByRole('img', { name: 'image-1.png', exact: true })).toBeVisible()
  await expect(reload).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(firstImage).toHaveAttribute('src', firstSource!)

  await page.getByRole('button', { name: 'image-2.png', exact: true }).click()
  await expect(viewer.getByRole('alert')).toContainText('图片解码失败')
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/2/raw')),
    reload.click(),
  ])
  await expect(viewer.getByRole('alert')).toContainText('图片解码失败')
  await expect(viewer.getByRole('img', { name: 'image-2.png', exact: true })).toHaveCount(0)
  assert.deepEqual(Object.fromEntries(reads), { 0: 1, 1: 2, 2: 2 })
})

test(
  'generated gallery releases loaded URLs and ignores responses completed after unmount',
  { timeout: RESOURCE_LIFECYCLE_TIMEOUT_MS },
  async (context) => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.addInitScript(() => {
      const created: string[] = []
      const revoked: string[] = []
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (blob) => {
        const url = create(blob)
        created.push(url)
        return url
      }
      URL.revokeObjectURL = (url) => {
        revoked.push(url)
        revoke(url)
      }
      Reflect.set(window, 'imageResources', { created, revoked })
    })
    let release!: () => void
    let requested!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const arrived = new Promise<void>((resolve) => {
      requested = resolve
    })
    context.after(release)
    await allowImageArtifactPreview(page)
    await page.route('**/api/serve/sessions/fixture/artifacts/*/raw', async (route) => {
      if (route.request().url().endsWith('/1/raw')) {
        requested()
        await held
      }
      await route.fulfill({ contentType: 'image/png', body: PIXEL })
    })
    try {
      await page.goto(
        `${fixture.url}features/assistant/Images.render.fixture.html?generated&count=2`
      )
      await arrived
      await expect(page.getByRole('img', { name: 'image-0.png', exact: true })).toBeVisible()
      await expect(page.getByText('image-0.png', { exact: true })).toBeVisible()
      const loaded = await page.evaluate(() => Reflect.get(window, 'imageResources').created)
      assert.equal(loaded.length, 1)
      assert.match(loaded[0], /^blob:/)
      await page.getByRole('button', { name: 'Hide generated images', exact: true }).click()
      await expect(page.getByRole('button', { name: 'image-0.png', exact: true })).toHaveCount(0)
      assert.deepEqual(
        await page.evaluate(() => Reflect.get(window, 'imageResources').revoked),
        loaded
      )
      const completed = page.waitForResponse('**/artifacts/1/raw')
      release()
      const response = await completed
      assert.equal(response.status(), 200)
      assert.equal(await response.finished(), null)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'imageResources')), {
        created: loaded,
        revoked: loaded,
      })
    } finally {
      release()
    }
  }
)

test('generated images show actions for small groups and retain actions for each preview', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await allowImageArtifactPreview(page)
  await page.route('**/api/serve/sessions/fixture/artifacts/*/raw', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  )
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?generated&count=2`)
  await expect(page.getByRole('button', { name: /^Thumbnail actions/ })).toHaveCount(2)
  await page.getByRole('button', { name: 'image-0.png', exact: true }).click()
  const viewer = page.getByTestId('image-preview')
  await expect(viewer.getByRole('button', { name: 'Preview actions 0', exact: true })).toBeVisible()
  await viewer.getByRole('button', { name: '下一张', exact: true }).click()
  await expect(viewer.getByRole('button', { name: 'Preview actions 1', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).not.toBeVisible()
  await expect(page.getByRole('button', { name: /^Thumbnail actions/ })).toHaveCount(2)
})

test('generic preview works without conversation data and delegates image actions', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?generic`)
  const viewer = page.getByTestId('image-preview')
  await expect(viewer.getByRole('img')).toBeVisible()
  await expect(viewer.getByText('custom action')).toBeVisible()
  for (const name of ['复制图片', '关闭图片查看器', '下一张']) {
    const button = viewer.getByRole('button', { name, exact: true })
    assert.equal(
      await button.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return [0.05, 0.25, 0.5, 0.75, 0.95].every((horizontal) =>
          [0.05, 0.25, 0.5, 0.75, 0.95].every(
            (vertical) =>
              document.elementFromPoint(
                bounds.x + bounds.width * horizontal,
                bounds.y + bounds.height * vertical
              ) === element
          )
        )
      }),
      true,
      `${name}: the entire rectangular control must hit the button itself`
    )
  }
  await viewer
    .getByRole('button', { name: '复制图片', exact: true })
    .click({ position: { x: 4, y: 4 } })
  await expect(page.getByTestId('copied-size')).toHaveText('400')
  await viewer
    .getByRole('button', { name: '下一张', exact: true })
    .click({ position: { x: 4, y: 4 } })
  await expect(viewer.getByRole('img', { name: 'duplicate.svg' })).toBeVisible()
  await expect(viewer.getByRole('button', { name: '复制图片', exact: true })).toBeEnabled()
  await viewer.getByRole('button', { name: '下一张', exact: true }).click()
  await expect(viewer.getByRole('alert')).toContainText('missing.png')
  await expect(viewer.getByRole('button', { name: '复制图片', exact: true })).toBeDisabled()
  await viewer
    .getByRole('button', { name: '关闭图片查看器', exact: true })
    .click({ position: { x: 4, y: 4 } })
  await expect(viewer).not.toBeVisible()
})

test('image groups keep all thumbnails scrollable and navigate, zoom, pan and dismiss the same group', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.route('**/api/serve/sessions/fixture/files/raw?*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  )
  for (const count of [1, 3, 4, 11, 20]) {
    await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?count=${count}`)
    const thumbnails = page
      .locator('[data-slot="image-strip"]')
      .getByRole('button', { name: /^查看图片/ })
    await expect(thumbnails).toHaveCount(count)
    await expect(page.getByText('image-0.png', { exact: true })).toHaveCount(count <= 3 ? 1 : 0)
    await thumbnails.first().hover()
    await expect(page.getByRole('button', { name: /\.png 的更多操作$/ })).toHaveCount(0)
    assert.equal((await thumbnails.first().boundingBox())?.width, 120)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html`)
  const group = page.locator('[data-slot="image-strip"]')
  await expect(group.getByRole('img')).toHaveCount(23)
  await expect(page.getByRole('button', { name: '向右查看图片', exact: true })).toBeVisible()
  await group.getByRole('button', { name: '查看图片 image-0.png（1 / 23）', exact: true }).click()
  const viewer = page.getByTestId('attachment-image-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.getByRole('button', { name: '上一张', exact: true })).toBeDisabled()
  await expect(viewer.getByRole('img')).toBeVisible()
  const stage = page.getByTestId('image-preview-stage')
  const fit = Number(await stage.getAttribute('data-scale'))
  await viewer.getByRole('img').dblclick()
  assert.ok(Number(await stage.getAttribute('data-scale')) > fit)
  const bounds = await viewer.getByRole('img').boundingBox()
  assert.ok(bounds)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 20)
  await page.mouse.up()
  await expect(stage).toHaveAttribute('data-pan-x', '30')
  await expect(stage).toHaveAttribute('data-pan-y', '20')
  const beforeWheel = Number(await stage.getAttribute('data-scale'))
  await stage.hover()
  await page.mouse.wheel(0, -120)
  await expect(stage).toHaveAttribute(
    'data-scale',
    String(Math.min(IMAGE_MAX_SCALE, beforeWheel * IMAGE_ZOOM_FACTOR))
  )
  await viewer.getByRole('button', { name: '下一张', exact: true }).click()
  await expect(viewer.getByText(/2 \/ 23/)).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(viewer.getByText(/1 \/ 23/)).toBeVisible()
  await viewer.getByRole('button', { name: '转到第 23 张', exact: true }).click()
  await expect(viewer.getByRole('button', { name: '下一张', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(viewer).not.toBeVisible()
  await group.getByRole('button', { name: '查看图片 image-0.png（1 / 23）', exact: true }).click()
  await stage.click({ position: { x: 1, y: 1 } })
  await expect(viewer).not.toBeVisible()
  await group.getByRole('button', { name: '查看图片 image-0.png（1 / 23）', exact: true }).click()
  await viewer
    .getByRole('button', { name: '图片更多操作', exact: true })
    .click({ position: { x: 4, y: 4 } })
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText([
    '另存为…',
    '在书深工作台中打开',
    '打开方式',
    '导入资料库',
    '打开所在文件夹',
  ])
  await page.getByRole('menuitem', { name: '导入资料库', exact: true }).click()
  await expect(page.getByTestId('imported-image')).toHaveText('0')
  await expect(viewer).not.toBeVisible()
})

test('image menu uses current-file applications in a submenu and opens the workbench with its source', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'scholarseed', {
      value: {
        getApiBase: () => '',
        addAuthorizedRoot: async () => true,
        appsForFile: async (path: string) => [
          {
            name: `Viewer for ${path}`,
            path: '/applications/viewer',
            isDefault: true,
            icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=',
          },
          { name: 'Same Viewer', path: '/applications/one/viewer', isDefault: false },
          { name: 'Same Viewer', path: '/applications/two/viewer', isDefault: false },
          { name: 'Same Viewer', path: '/applications/one/viewer', isDefault: false },
        ],
        openPathWith: async (path: string, appPath: string) => {
          sessionStorage.setItem('opened-image', JSON.stringify({ path, appPath }))
          return { ok: true }
        },
        saveFileCopy: async (request: { suggestedName: string; bytes: Uint8Array }) => {
          sessionStorage.setItem(
            'saved-image',
            JSON.stringify({
              suggestedName: request.suggestedName,
              bytes: Array.from(request.bytes),
            })
          )
          return { ok: true }
        },
      },
    })
  })
  await page.route('**/api/serve/sessions/fixture/files/raw?*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  )
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?count=2`)
  await page.getByRole('button', { name: '查看图片 image-1.png（2 / 2）', exact: true }).click()
  const viewer = page.getByTestId('attachment-image-viewer')
  await expect(viewer).toBeVisible()
  await viewer.getByRole('button', { name: '图片更多操作', exact: true }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Viewer for image-1.png', exact: true })
  ).not.toBeVisible()
  await page.getByRole('menuitem', { name: '打开方式', exact: true }).click()
  const defaultApp = page.getByRole('menuitem', {
    name: 'Viewer for image-1.png 默认',
    exact: true,
  })
  await expect(defaultApp)
    .toBeVisible()
    .catch(async (error) => {
      throw new Error(`${await page.locator('body').innerText()}\n${String(error)}`)
    })
  await expect(defaultApp.locator('img')).toHaveCount(1)
  await expect(page.getByRole('menuitem', { name: /Same Viewer/ })).toHaveCount(2)
  await expect(
    page.getByRole('menuitem', { name: 'Same Viewer /applications/one/viewer', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Same Viewer /applications/two/viewer', exact: true })
  ).toBeVisible()
  assert.equal(
    await page
      .getByRole('menuitem', { name: /Same Viewer/ })
      .evaluateAll((items) => items.every((item) => item.scrollHeight <= item.clientHeight)),
    true
  )
  await defaultApp.click()
  await expect
    .poll(async () => {
      const opened = await page.evaluate(() => sessionStorage.getItem('opened-image'))
      return opened ? JSON.parse(opened) : null
    })
    .toEqual({ path: 'image-1.png', appPath: '/applications/viewer' })
  await page.keyboard.press('Escape')
  if (!(await viewer.isVisible()))
    await page.getByRole('button', { name: '查看图片 image-1.png（2 / 2）', exact: true }).click()
  await viewer.getByRole('button', { name: '图片更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '另存为…', exact: true }).click()
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => sessionStorage.getItem('saved-image'))
      return saved ? JSON.parse(saved) : null
    })
    .toEqual({ suggestedName: 'image-1.png', bytes: Array.from(PIXEL) })
  await viewer.getByRole('button', { name: '图片更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '在书深工作台中打开', exact: true }).click()
  await expect(viewer).not.toBeVisible()
  await expect(page.getByTestId('imported-image')).toContainText('"path":"image-1.png"')
  await expect(page.getByTestId('imported-image')).toContainText('"sessionId":"fixture"')
})

test('draft image removal appears only for the hovered or keyboard-focused thumbnail', async (context) => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.route('**/api/serve/sessions/fixture/files/raw?*', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  )
  await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?count=2&draft`)
  const first = page.getByRole('button', { name: '查看图片 image-0.png（1 / 2）', exact: true })
  const second = page.getByRole('button', { name: '查看图片 image-1.png（2 / 2）', exact: true })
  const firstRemove = page.getByRole('button', { name: '移除图片 image-0.png', exact: true })
  const secondRemove = page.getByRole('button', { name: '移除图片 image-1.png', exact: true })
  await expect(firstRemove).toHaveCSS('opacity', '0')
  await expect(firstRemove).toHaveCSS('width', '16px')
  await expect(firstRemove).toHaveCSS('border-top-width', '0px')
  await expect(firstRemove).toHaveCSS('pointer-events', 'none')
  await first.hover()
  await expect(firstRemove).toHaveCSS('opacity', '1')
  await expect(secondRemove).toHaveCSS('opacity', '0')
  await second.hover()
  await expect(firstRemove).toHaveCSS('opacity', '0')
  await expect(secondRemove).toHaveCSS('opacity', '1')
  await page.mouse.move(300, 300)
  await first.focus()
  await expect(firstRemove).toHaveCSS('opacity', '1')
  await page.keyboard.press('Tab')
  await expect(firstRemove).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('imported-image')).toHaveText('0')
})

for (const failure of [
  { name: 'missing', status: 404 },
  { name: 'forbidden', status: 403 },
  { name: 'invalid image', status: 200 },
]) {
  test(`failed images explain ${failure.name} without claiming deletion and retain the original-file action`, async (context) => {
    const fixture = await renderFixture(path.resolve(import.meta.dirname, '../..'))
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.route('**/api/serve/sessions/fixture/files/raw?*', (route) =>
      route.fulfill({ status: failure.status, contentType: 'image/png', body: 'not an image' })
    )
    await page.goto(`${fixture.url}features/assistant/Images.render.fixture.html?count=1`)
    const image = page.getByRole('button', { name: '查看图片 image-0.png（1 / 1）', exact: true })
    await expect(image).toContainText('image-0.png')
    await expect(image).toContainText('图片加载失败')
    await expect(image).toHaveAttribute('aria-description', '图片加载失败')
    await image.click()
    await expect(page.getByTestId('attachment-image-viewer').getByRole('alert')).toContainText(
      'image-0.png'
    )
    await expect(
      page.getByRole('button', { name: '使用系统程序打开原文件', exact: true })
    ).toBeVisible()
  })
}
