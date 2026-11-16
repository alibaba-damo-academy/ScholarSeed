const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { test, before, after } = require('node:test')
const { chromium, expect } = require('@playwright/test')
const rendering = import('../../../../test-helpers/render.ts')
const evidence = path.resolve(__dirname, '../../../../../../../work/ui-sdk')
let fixture

before(async () => {
  await fs.mkdir(evidence, { recursive: true })
  const { renderFixture } = await rendering
  fixture = await renderFixture(path.resolve(__dirname, '../..'), {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
})
after(async () => { await fixture?.close() })

async function openComponent(entry, state) {
  const page = await fixture.browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(fixture.url + 'components/primitive/images.fixture.html')
  await page.waitForFunction(() => Boolean(window.nativeImages))
  await page.evaluate(state => { window.fixture.state = state }, state)
  return { page, errors }
}

for (const imageCount of [3, 10, 20]) test(`image group retains order and identity through viewer navigation and close: ${imageCount}`, async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    assert.equal(await page.evaluate(() => typeof window.nativeImages.Conversation.Images), 'function')
    await page.evaluate(count => {
      const { React, Conversation, mount } = window.nativeImages
      const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="green"/></svg>')
      const items = Array.from({ length: count }, (_, index) => ({ id: `asset-${index}`, title: `figure-${index}.svg`, url }))
      window.fixture.opened = []
      mount(() => React.createElement(Conversation.Images, { items, renderActions: item => React.createElement(window.nativeImages.Button, { onClick: () => window.fixture.opened.push(item.id) }, '打开原图') }))
    }, imageCount)
    await page.getByRole('button', { name: 'figure-0.svg', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText('figure-0.svg')
    await expect(dialog.getByTestId('image-preview-stage').getByRole('img')).toHaveJSProperty('naturalWidth', 800)
    await expect(dialog).toHaveAttribute('data-testid', 'image-preview')
    await dialog.getByRole('button', { name: '下一张', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText('figure-1.svg')
    await expect(dialog.locator('output')).toContainText(`2 / ${imageCount}`)
    await dialog.getByRole('button', { name: '打开原图', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['asset-1'])
    for (let index = 2; index < imageCount; index++) await dialog.getByRole('button', { name: '下一张', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText(`figure-${imageCount - 1}.svg`)
    await expect(dialog.getByRole('button', { name: '下一张', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'figure-0.svg', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('figure-0.svg')
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('artifact image groups omit thumbnail captions but retain accessible names and viewer titles', async () => {
  const { page, errors } = await openComponent(null, {})
  try {
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.nativeImages
      const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')
      mount(() => React.createElement(Conversation.ArtifactGroup, {
        images: [{ id: 'artifact-image', title: 'Artifact image caption', url }],
      }))
    })
    const group = page.getByTestId('artifact-image-group')
    await expect(group.getByText('Artifact image caption', { exact: true })).toHaveCount(0)
    await group.getByRole('button', { name: 'Artifact image caption', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Artifact image caption')
    await page.evaluate(() => {
      window.fixture.copied = []
      window.scholarseed = { writeClipboardImage: async bytes => {
        window.fixture.copied = Array.from(bytes)
        return { ok: true }
      } }
    })
    await page.getByRole('dialog').getByRole('button', { name: '复制图片', exact: true }).click()
    await expect(page.getByRole('dialog').locator('[role="status"]')).toHaveText('已复制')
    assert.deepEqual((await page.evaluate(() => window.fixture.copied)).slice(0, 4), [137, 80, 78, 71])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('overflowing artifact images use hover controls and image-aligned paging', async () => {
  const { page } = await openComponent(null, {})
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.nativeImages
      const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')
      mount(() => React.createElement(Conversation.ArtifactGroup, {
        images: Array.from({ length: 10 }, (_, index) => ({ id: String(index), title: `Image ${index}`, url })),
      }))
    })
    const group = page.getByTestId('artifact-image-group')
    const viewport = group.locator('[data-slot="conversation-images-viewport"]')
    const next = group.getByRole('button', { name: '向右查看图片', exact: true })
    const previous = group.getByRole('button', { name: '向左查看图片', exact: true })
    await expect(next).toHaveCSS('opacity', '0')
    await expect(previous).toHaveCount(0)
    await expect(viewport).toHaveCSS('scrollbar-width', 'none')
    await group.hover()
    await expect(next).toHaveCSS('opacity', '1')
    await expect(next).toHaveCSS('width', '24px')
    await expect(next).toHaveCSS('height', '24px')
    await expect(next).toHaveCSS('border-radius', '6px')
    await expect(next.locator('..')).toHaveClass(/from-\[var\(--vds-fill-2\)\]/)
    await next.click()
    await expect(previous).toHaveCount(1)
    await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await previous.click()
    await expect(previous).toHaveCount(0)
    await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBe(0)
  } finally { await page.close() }
})

test('controlled image viewer opens from a separate card and returns the selected source', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: {} })
  try {
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.nativeImages
      const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')
      const items = [{ id: 'revision-a', title: 'A.svg', url }, { id: 'revision-b', title: 'B.svg', url }]
      window.fixture.opened = []
      function Example() {
        const [id, onChange] = React.useState(null)
        return React.createElement(React.Fragment, null, React.createElement(Button, { onClick: () => onChange('revision-a') }, '打开卡片 A'), React.createElement(Conversation.Images, { items, thumbnails: false, selection: { id, onChange }, renderActions: item => React.createElement(Button, { onClick: () => window.fixture.opened.push(item.id) }, '打开原图') }))
      }
      mount(() => React.createElement(Example))
    })
    await expect(page.getByRole('button', { name: 'A.svg', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '打开卡片 A', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading')).toHaveText('A.svg')
    await dialog.getByRole('button', { name: '下一张', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText('B.svg')
    await dialog.getByRole('button', { name: '打开原图', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['revision-b'])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '打开卡片 A', exact: true })).toBeFocused()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('single failed image keeps its original action and empty groups render nothing', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: { items: [{ id: 'failed-original', title: 'missing.png', failed: true }] } })
  try {
    await page.evaluate(() => {
      const { React, Conversation, Button, mount } = window.nativeImages
      window.fixture.opened = []
      mount(state => React.createElement(Conversation.Images, { items: state.data.items, renderActions: item => React.createElement(Button, { onClick: () => window.fixture.opened.push(item.id) }, '打开原图') }))
    })
    await page.getByRole('button', { name: 'missing.png', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('alert')).toContainText('图片加载失败')
    await expect(dialog.getByRole('button', { name: '上一张', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '下一张', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '打开原图', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixture.opened), ['failed-original'])
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.fixture.state.data.items = []; window.fixture.publish() })
    await expect(page.getByRole('button')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test('cached image stays visible across StrictMode first mounts without a user interaction', async () => {
  const url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="green"/></svg>')
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: { url, generation: 0 } })
  try {
    await page.evaluate(async url => {
      const preload = new Image()
      preload.src = url
      await preload.decode()
      const { React, Conversation, mount } = window.nativeImages
      window.fixture.frames = []
      const observe = phase => {
        const image = document.querySelector('[data-testid="image-viewer"] img')
        window.fixture.frames.push({ phase, generation: window.fixture.state.data.generation, complete: image?.complete, width: image?.naturalWidth, dimensions: document.querySelector('[data-testid="image-dimensions"]')?.textContent, visibility: image?.style.visibility })
      }
      document.addEventListener('load', event => {
        if (event.target instanceof HTMLImageElement && event.target.closest('[data-testid="image-viewer"]')) observe('load')
      }, true)
      new MutationObserver(() => observe('mutation')).observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true, characterData: true })
      mount(state => React.createElement('div', { style: { height: 500 } }, React.createElement(Conversation.ImageView, { key: state.data.generation, url: state.data.url, title: 'cached.svg', onViewChange: () => {} })))
    }, url)
    for (let generation = 0; generation < 24; generation++) {
      await page.evaluate(generation => { window.fixture.state.data.generation = generation; window.fixture.publish() }, generation)
      await expect(page.getByTestId('image-dimensions')).toHaveText('800 × 400')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await expect(page.getByTestId('image-viewer').getByRole('img')).toBeVisible()
      await expect(page.getByRole('button', { name: '放大图片', exact: true })).toBeEnabled()
    }
    assert.deepEqual(errors, [])
  } catch (error) {
    await fs.writeFile(path.join(evidence, 'image-cache-regression.json'), JSON.stringify({ frames: await page.evaluate(() => window.fixture.frames) }, null, 2))
    throw error
  } finally { await page.close() }
})

test('shared image view preserves zoom and pan, reports invalid content and recovers on a new resource', async () => {
  const { page, errors } = await openComponent(null, { language: 'zh', status: 'pending', data: { url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="green"/></svg>') } })
  try {
    await page.evaluate(async () => {
      const cached = new Image()
      cached.src = window.fixture.state.data.url
      await cached.decode()
    })
    assert.equal(await page.evaluate(() => typeof window.nativeImages.Conversation.ImageView), 'function')
    await page.evaluate(() => {
      const { React, Conversation, mount } = window.nativeImages
      window.fixture.views = []
      function Example({ url }) {
        const [viewState, setView] = React.useState({})
        return React.createElement('div', { style: { height: 500 } }, React.createElement(Conversation.ImageView, { url, title: 'figure.svg', failed: false, viewState, onViewChange: next => { window.fixture.views.push(next); setView(next) } }))
      }
      mount(state => React.createElement(Example, { url: state.data.url }))
    })
    await expect(page.getByTestId('image-viewport').locator('img')).toHaveJSProperty('naturalWidth', 800)
    await expect(page.getByTestId('image-dimensions')).toHaveText('800 × 400')
    await page.getByRole('tab', { name: '实际大小', exact: true }).click()
    await expect(page.getByTestId('image-zoom')).toHaveText('100%')
    await page.getByRole('button', { name: '放大图片', exact: true }).click()
    await expect(page.getByTestId('image-zoom')).toHaveText('125%')
    const surface = page.getByTestId('image-viewport')
    const bounds = await surface.boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 30); await page.mouse.up()
    await expect(surface).toHaveAttribute('data-pan-x', '40')
    await page.getByRole('tab', { name: '适应窗口', exact: true }).click()
    await expect(surface).toHaveAttribute('data-pan-x', '0')
    const fittedScale = Number(await surface.getAttribute('data-scale'))
    await surface.dblclick()
    await expect(surface).toHaveAttribute('data-scale', String(fittedScale * 2))
    await surface.dblclick()
    await expect(surface).toHaveAttribute('data-mode', 'fit')
    const pageScroll = await page.evaluate(() => window.scrollY)
    await surface.hover()
    await page.mouse.wheel(0, -100)
    await expect(surface).toHaveAttribute('data-scale', String(fittedScale * 1.25))
    assert.equal(await page.evaluate(() => window.scrollY), pageScroll)
    await page.mouse.wheel(0, 100)
    await expect(surface).toHaveAttribute('data-scale', String(fittedScale))
    await page.evaluate(() => { window.fixture.state.data.url = 'data:image/png;base64,invalid'; window.fixture.publish() })
    await expect(page.getByRole('alert')).toHaveText('无法显示此图片，请检查文件是否完整。')
    await expect(page.getByRole('button', { name: '放大图片', exact: true })).toBeDisabled()
    const failedViewCount = await page.evaluate(() => window.fixture.views.length)
    await surface.dblclick()
    await page.mouse.wheel(0, -100)
    assert.equal(await page.evaluate(() => window.fixture.views.length), failedViewCount)
    await page.evaluate(() => { window.fixture.state.data.url = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="40"/>'); window.fixture.publish() })
    await expect(page.getByTestId('image-dimensions')).toHaveText('20 × 40')
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.deepEqual(errors, [])
  } catch (error) {
    const evidence = await page.evaluate(() => ({
      images: [...document.querySelectorAll('[data-testid="image-viewer"] img')].map(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, source: image.currentSrc })),
      surface: document.querySelector('[data-testid="image-viewer"]')?.textContent,
      views: window.fixture.views,
    }))
    await fs.writeFile(path.join(evidence, 'image-regression.json'), JSON.stringify(evidence, null, 2))
    throw error
  } finally { await page.close() }
})
