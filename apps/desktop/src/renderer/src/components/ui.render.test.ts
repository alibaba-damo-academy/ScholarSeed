import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { chromium, type Browser, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_URL = '/components/ui.render.fixture.html'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('Unable to reserve a local test port')))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function withFixture(run: (page: Page) => Promise<void>): Promise<void> {
  let browser: Browser | undefined
  let server: ViteDevServer | undefined

  try {
    const port = await reservePort()
    server = await createServer({
      configFile: false,
      // Concurrent Vite fixtures must not invalidate each other's optimized chunks.
      cacheDir: path.join(ROOT_DIR, 'node_modules/.vite-tests', `${path.basename(FIXTURE_URL)}-${process.pid}`),
      root: ROOT_DIR,
      plugins: [react()],
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true
      }
    })
    await server.listen()

    const url = server.resolvedUrls?.local[0]
    assert.ok(url, 'Vite test server should expose a local URL')

    browser = await chromium.launch()
    const page = await browser.newPage()
    const startupErrors: string[] = []
    page.on('pageerror', error => startupErrors.push(`pageerror: ${error.message}`))
    page.on('requestfailed', request => startupErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`))
    page.on('response', response => {
      if (response.status() >= 400) startupErrors.push(`response: ${response.status()} ${response.url()}`)
    })
    try {
      await page.goto(new URL(FIXTURE_URL, url).toString())
      await run(page)
    } catch (error) {
      console.error('UI fixture failure evidence', { url: page.url(), startupErrors, body: (await page.locator('body').innerText()).slice(0, 2000) })
      throw error
    }
  } finally {
    await browser?.close()
    await server?.close()
  }
}

test('icon-only copy buttons retain 24px targets, 14px glyphs and clipboard feedback', async () => {
  await withFixture(async (page) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => window.localStorage.setItem('copied-text', text) }
      })
    })
    const button = page.getByTestId('render-copy-icon')
    const geometry = () => button.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const iconBounds = element.querySelector('svg')!.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height, padding: style.padding, iconWidth: iconBounds.width, iconHeight: iconBounds.height }
    })
    const expectedGeometry = { width: 24, height: 24, padding: '0px', iconWidth: 14, iconHeight: 14 }
    assert.equal(await button.getAttribute('aria-label'), '复制')
    assert.deepEqual(await geometry(), expectedGeometry)
    await button.hover()
    assert.deepEqual(await geometry(), expectedGeometry)
    await button.focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.localStorage.getItem('copied-text')), 'icon-copy-value')
    assert.equal(await button.getAttribute('data-copy-status'), 'success')
    assert.equal(await button.getAttribute('aria-label'), '已复制')
    assert.equal(await button.locator('[aria-live="polite"]').textContent(), '已复制')
    assert.deepEqual(await geometry(), expectedGeometry)
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('clipboard rejected') } }
      })
    })
    await button.click()
    assert.equal(await button.getAttribute('data-copy-status'), 'error')
    assert.equal(await button.getAttribute('aria-label'), '复制失败')
    assert.deepEqual(await geometry(), expectedGeometry)
  })
})

test('image spinners load their asset without rotating it or changing default spinners', async () => {
  await withFixture(async (page) => {
    const defaultSpinner = page.getByTestId('render-spinner-default')
    const imageSpinner = page.getByTestId('render-spinner-image')
    const image = imageSpinner.locator('img')
    await image.waitFor()
    await image.evaluate(async (element: HTMLImageElement) => element.decode())
    assert.equal(await image.evaluate((element: HTMLImageElement) => element.naturalWidth), 320)
    assert.equal(await image.getAttribute('alt'), '')
    assert.equal(await image.getAttribute('aria-hidden'), 'true')
    assert.equal(await imageSpinner.getAttribute('role'), 'status')
    assert.equal(await imageSpinner.getAttribute('aria-label'), await defaultSpinner.getAttribute('aria-label'))
    assert.equal(await imageSpinner.evaluate(element => getComputedStyle(element).animationName), 'none')
    assert.equal(await imageSpinner.evaluate(element => getComputedStyle(element).borderTopWidth), '0px')
    assert.equal(await defaultSpinner.locator('img').count(), 0)
    assert.equal(await defaultSpinner.evaluate(element => getComputedStyle(element).animationName), 'vds-spin')
    assert.equal(await imageSpinner.evaluate(element => getComputedStyle(element).width),
      await defaultSpinner.evaluate(element => getComputedStyle(element).width))
    const imageButton = page.getByTestId('render-button-loading-image')
    const defaultButton = page.getByTestId('render-button-loading-default')
    assert.equal(await imageButton.isDisabled(), true)
    assert.equal(await imageButton.getAttribute('data-loading'), 'true')
    assert.equal(await imageButton.locator('img').getAttribute('src'), await image.getAttribute('src'))
    assert.equal(await defaultButton.isDisabled(), true)
    assert.equal(await defaultButton.locator('img').count(), 0)
  })
})

test('closed Sheet portals remove both content and overlay from the page', async () => {
  await withFixture(async (page) => {
    assert.equal(await page.getByTestId('render-sheet-content').count(), 0)
    assert.equal(await page.getByTestId('render-sheet-overlay').count(), 0)
    await page.getByTestId('render-sheet-open').click()
    assert.equal(await page.getByTestId('render-sheet-content').count(), 1)
    await page.getByTestId('render-sheet-close').click()
    assert.equal(await page.getByTestId('render-sheet-content').count(), 0)
    assert.equal(await page.getByTestId('render-sheet-overlay').count(), 0)
  })
})

test('Sheet trigger restores focus after a modal sheet closes', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-sheet-trigger')
    await trigger.click()
    const content = page.getByTestId('render-sheet-trigger-content')
    assert.equal(await content.evaluate(el => el.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await content.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
  })
})

test('Escape dismisses a child Sheet without closing its ancestor modal Sheet', async () => {
  await withFixture(async page => {
    await page.getByTestId('render-sheet-trigger').click()
    await page.getByTestId('nested-sheet-trigger').click()
    await page.getByTestId('nested-sheet-close').focus()
    await page.keyboard.press('Escape')
    await page.getByTestId('nested-sheet-content').waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('render-sheet-trigger-content').isVisible(), true)
  })
})

test('DialogClose asChild preserves child classes and composes its click handler', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('render-dialog-open').click()
    const close = page.getByTestId('render-dialog-close-child')
    await assert.equal(await close.getAttribute('class').then((value) => value?.includes('absolute')), true)
    await assert.equal(await close.getAttribute('class').then((value) => value?.includes('right-3')), true)
    await close.click()
    await assert.equal(await page.getByTestId('render-dialog-content').count(), 0)
    await assert.equal(await page.getByTestId('render-dialog-child-clicks').textContent(), '1')
  })
})

test('assistant host constrains the transcript to its own scroll viewport', async () => {
  await withFixture(async (page) => {
    const source = await readFile(path.join(ROOT_DIR, 'features/assistant/AiPanel.tsx'), 'utf8')
    const hostClass = source.match(/className="([^"]+)" data-testid="ai-stream"/)?.[1]
    assert.ok(hostClass)
    await page.locator('#root').evaluate((root, className) => {
      root.innerHTML = `<div style="height:300px;display:flex;flex-direction:column"><div class="${className}"><div class="conversation-stream" style="flex:1;min-height:0;overflow-y:auto"><div style="height:1200px">Long transcript</div></div></div></div>`
    }, hostClass)
    const dimensions = await page.locator('.conversation-stream').evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }))
    assert.ok(dimensions.height < 300, 'Stream must receive a bounded height from its flex host')
    assert.ok(dimensions.content > dimensions.height, 'Stream, not its host, owns scrolling')
    assert.equal(await page.locator('.vds-ai-stream').evaluate(el => getComputedStyle(el).overflowY), 'hidden')
  })
})

test('question option check mark uses centered checkbox geometry', async () => {
  await withFixture(async (page) => {
    const stream = await readFile(path.join(ROOT_DIR, 'components/business/Stream.tsx'), 'utf8')
    const markClass = stream.match(/const QUESTION_OPTION_MARK_CLASS =\s*'([^']+)'/)?.[1]
    assert.ok(markClass, 'question options should own a geometric check mark class')
    assert.doesNotMatch(stream, /\{on \? '✓' : ''\}/)
    await page.locator('#root').evaluate((root, className) => {
      root.innerHTML = `<span data-testid="question-option-box" style="display:grid;place-items:center;width:14px;height:14px"><span data-testid="question-option-mark" class="${className}"></span></span>`
    }, markClass)
    const centers = await page.getByTestId('question-option-box').evaluate((box) => {
      const mark = box.querySelector<HTMLElement>('[data-testid="question-option-mark"]')
      if (!mark) throw new Error('missing question option mark')
      const boxRect = box.getBoundingClientRect()
      const markRect = mark.getBoundingClientRect()
      return {
        horizontal: Math.abs(boxRect.x + boxRect.width / 2 - (markRect.x + markRect.width / 2)),
        vertical: Math.abs(boxRect.y + boxRect.height / 2 - (markRect.y + markRect.height / 2))
      }
    })
    assert.ok(centers.horizontal <= 1)
    assert.ok(centers.vertical <= 1)
  })
})

test('permission dock uses the full-access icon and text-only actions', async () => {
  const stream = await readFile(path.join(ROOT_DIR, 'components/business/Stream.tsx'), 'utf8')
  const permissionDock = stream.slice(
    stream.indexOf("if (presentation === 'dock' && !isQuestion && !done)"),
    stream.indexOf("const scrollableQuestion = presentation === 'dock' && isQuestion && !done")
  )
  assert.match(permissionDock, /<IconFont[\s\S]*?type="icon-wanquanfangwen"/)
  assert.match(permissionDock, /<Button\s+variant="secondary"\s+size="sm"/)
  assert.match(permissionDock, /<Button\s+variant="primary"\s+size="sm"/)
  assert.doesNotMatch(permissionDock, /<kbd>/)
})

test('conversation and controls share a centered capped column at every panel width', async () => {
  const PANEL_WIDTHS = [480, 760, 900, 1440]
  const CONTENT_WIDTH = 760
  const VIEWPORT_HEIGHT = 300
  const TRANSCRIPT_HEIGHTS = [100, 1200]
  const PIXEL_TOLERANCE = 1
  await withFixture(async (page) => {
    const stream = await readFile(path.join(ROOT_DIR, 'components/business/Stream.tsx'), 'utf8')
    const columnClass = stream.match(/const READING_COLUMN_CLASS =\s*'([^']+)'/)?.[1]
    const streamClass = stream.match(/className="(conversation-stream[^"]*)"/)?.[1]
    const controlsClass = stream.match(/className="(vds-ai-composer-host[^"]*)"/)?.[1]
    assert.ok(columnClass && streamClass && controlsClass)
    for (const width of PANEL_WIDTHS) {
      for (const height of TRANSCRIPT_HEIGHTS) {
        await page.locator('#root').evaluate((root, layout) => {
          root.innerHTML = `<div data-layout="panel" style="width:${layout.width}px"><div class="${layout.streamClass}" style="height:${layout.viewportHeight}px;overflow-y:auto;padding-inline:var(--vds-conversation-inline-gutter)"><div data-layout="transcript" class="${layout.columnClass}" style="height:${layout.height}px">Transcript</div></div><div class="${layout.controlsClass}"><div style="padding-inline:var(--vds-conversation-inline-gutter)"><div data-layout="composer" class="${layout.columnClass}">Composer</div></div></div></div>`
        }, { width, height, viewportHeight: VIEWPORT_HEIGHT, columnClass, streamClass, controlsClass })
        const panel = await page.locator('[data-layout="panel"]').boundingBox()
        const transcript = await page.locator('[data-layout="transcript"]').boundingBox()
        const composer = await page.locator('[data-layout="composer"]').boundingBox()
        assert.ok(panel && transcript && composer)
        assert.ok(Math.abs(transcript.width - composer.width) < PIXEL_TOLERANCE)
        assert.ok(Math.abs(transcript.x - composer.x) < PIXEL_TOLERANCE)
        assert.ok(Math.abs(transcript.x + transcript.width / 2 - panel.x - panel.width / 2) < PIXEL_TOLERANCE)
        assert.ok(transcript.width <= CONTENT_WIDTH)
        if (width > CONTENT_WIDTH) assert.equal(transcript.width, CONTENT_WIDTH)
      }
    }
  })
})

test('answer selection comment fits the toolbar width in a narrow assistant', async () => {
  const TOOLBAR_WIDTH = 260
  await withFixture(async (page) => {
    const source = await readFile(path.join(ROOT_DIR, 'features/assistant/Annotations.tsx'), 'utf8')
    const draft = source.slice(source.indexOf("{draft.mode === 'actions'"))
    const commentClass = draft.match(/\) : \(\s*<div className="([^"]+)"/)?.[1]
    assert.ok(commentClass)
    await page.locator('#root').evaluate((root, layout) => {
      root.innerHTML = `<div data-layout="anchor" style="width:${layout.width}px"><div data-layout="comment" class="${layout.commentClass}"><input style="min-width:0;width:100%" /></div></div>`
    }, { width: TOOLBAR_WIDTH, commentClass })
    const anchor = await page.locator('[data-layout="anchor"]').boundingBox()
    const comment = await page.locator('[data-layout="comment"]').boundingBox()
    assert.ok(anchor && comment)
    assert.ok(comment.x >= anchor.x && comment.x + comment.width <= anchor.x + anchor.width)
  })
})

test('split handle remains transparent when a host view supplies a background', async () => {
  await withFixture(async (page) => {
    const handle = page
      .getByTestId('render-resizable-right-split')
      .getByRole('button', { name: /^(Resize panels|调整面板大小)$/ })
    await handle.evaluate((element) => {
      element.style.background = 'rgb(250, 248, 244)'
    })
    assert.match((await handle.getAttribute('class')) ?? '', /!bg-transparent/)
    assert.equal(
      await handle.evaluate((element) => getComputedStyle(element).backgroundColor),
      'rgba(0, 0, 0, 0)'
    )
  })
})

test('alert descriptions can show full instructions without changing default clamping', async () => {
  await withFixture(async (page) => {
    assert.equal(await page.getByTestId('render-alert-full').evaluate(el => getComputedStyle(el).webkitLineClamp), 'none')
    assert.equal(await page.getByTestId('render-alert-default').evaluate(el => getComputedStyle(el).webkitLineClamp), '2')
  })
})

test('NavigationTabs overview fills its allocated width in active and inactive states', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs')
    const overview = navigationTabs.getByRole('tab', { name: '总览', exact: true })
    const assertFilledWidth = async (): Promise<void> => {
      const dimensions = await overview.evaluate(element => ({
        tab: element.getBoundingClientRect().width,
        slot: element.parentElement!.getBoundingClientRect().width
      }))
      assert.ok(dimensions.slot > 0)
      assert.equal(dimensions.tab, dimensions.slot)
    }
    await assertFilledWidth()
    await navigationTabs.getByRole('tab', { name: 'Beta.md' }).click()
    assert.equal(await overview.getAttribute('aria-selected'), 'false')
    await assertFilledWidth()
  })
})

test('NavigationTabs opens supplied context menu for the targeted document tab', async () => {
  await withFixture(async (page) => {
    await page.getByRole('tab', { name: 'Beta.md' }).click({ button: 'right' })
    await assert.equal(await page.getByTestId('render-navigation-context-tab').textContent(), 'beta')
    await assert.equal(await page.getByTestId('render-navigation-context-menu').isVisible(), true)
    await assert.equal(await page.getByTestId('render-navigation-context-menu').textContent(), 'Beta.md')
    await assert.equal(await page.getByRole('tab', { name: 'Alpha.md' }).getAttribute('aria-expanded'), null)
  })
})

test('NavigationTabs makes the draggable blank area interactive while a context menu is open', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs')
    await page.getByRole('tab', { name: 'Beta.md' }).click({ button: 'right' })
    await assert.equal(
      await navigationTabs.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
      'no-drag'
    )
    const navigationTabsBox = await navigationTabs.boundingBox()
    assert.ok(navigationTabsBox)
    await navigationTabs.click({ position: { x: navigationTabsBox.width - 2, y: navigationTabsBox.height / 2 } })
    await assert.equal(await page.getByTestId('render-navigation-context-menu').count(), 0)
  })
})

test('NavigationTabs can represent a split pane without duplicating the overview tab', async () => {
  await withFixture(async (page) => {
    const splitTabs = page.getByTestId('render-navigation-tabs-without-overview')
    await assert.equal(await splitTabs.getByRole('tab', { name: '总览' }).count(), 0)
    await assert.equal(await splitTabs.getByRole('tab', { name: '右侧文件.md' }).count(), 1)
  })
})

test('EllipsisText shows tooltip only when the text is truncated', async () => {
  await withFixture(async (page) => {
    const shortText = page.getByTestId('render-ellipsis-short')
    await shortText.hover()
    await assert.equal(await page.getByRole('tooltip', { name: '短标题' }).count(), 0)

    const longText = page.getByTestId('render-ellipsis-long')
    await longText.hover()
    await assert.equal(await page.getByRole('tooltip', { name: '这是一段一定会超过容器宽度并被省略的长标题' }).isVisible(), true)
  })
})

test('EllipsisText caps long tooltip content and keeps it scrollable', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-ellipsis-scrollable')
    await trigger.hover()
    const contentId = await trigger.getAttribute('aria-describedby')
    assert.ok(contentId)
    const tooltip = page.locator(`[id="${contentId}"]`)
    const metrics = await tooltip.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        clientHeight: element.clientHeight,
        maxHeight: style.maxHeight,
        overflowY: style.overflowY,
        pointerEvents: style.pointerEvents,
        scrollHeight: element.scrollHeight,
        viewportHeight: window.innerHeight
      }
    })
    await assert.equal(metrics.maxHeight, `${metrics.viewportHeight * 0.8}px`)
    await assert.equal(metrics.overflowY, 'auto')
    await assert.equal(metrics.pointerEvents, 'auto')
    await assert.ok(metrics.clientHeight <= metrics.viewportHeight * 0.8)
    await assert.ok(metrics.scrollHeight > metrics.clientHeight)

    await tooltip.hover()
    await page.mouse.wheel(0, 240)
    await page.waitForTimeout(100)
    await assert.ok(await tooltip.evaluate((element) => element.scrollTop > 0))
    await assert.equal(await tooltip.isVisible(), true)
  })
})

test('NavigationTabs caps each document tab and truncates long labels', async () => {
  await withFixture(async (page) => {
    const longLabel = 'Multimodal Fusion and Vision-Language Models for Robot Learning.md'
    const longTab = page.getByTestId('render-navigation-tabs-long-label').getByRole('tab')
    const label = longTab.locator('[data-slot="ellipsis-text"]')
    await assert.ok(await longTab.evaluate((element) => element.getBoundingClientRect().width <= 190))
    await assert.equal(await label.evaluate((element) => getComputedStyle(element).textOverflow), 'ellipsis')
    await longTab.hover()
    const tooltip = page.getByRole('tooltip', { name: longLabel })
    await assert.equal(await tooltip.isVisible(), true)
    const positions = await Promise.all([
      label.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { bottom: rect.bottom, left: rect.left }
      }),
      tooltip.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, top: rect.top }
      })
    ])
    await assert.ok(Math.abs(positions[1].left - positions[0].left) <= 1)
    await assert.ok(Math.abs(positions[1].top - positions[0].bottom - 10) <= 1)
  })
})

test('NavigationTabs marks only tabs with unsaved edits', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs')
    await assert.equal(await navigationTabs.getByRole('tab').locator('i[aria-label="未保存"]').count(), 1)
    await assert.equal(
      await page.getByRole('tab', { name: 'Beta.md' }).locator('i[aria-label="未保存"]').count(),
      1
    )
    await assert.equal(
      await page.getByRole('tab', { name: 'Alpha.md' }).locator('i[aria-label="未保存"]').count(),
      0
    )
  })
})

test('NavigationTabs preserves manual horizontal scrolling across parent rerenders', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs-scroll')
    const rightmostScroll = await navigationTabs.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      return element.scrollLeft
    })
    assert.ok(rightmostScroll > 0)

    await page.getByTestId('render-navigation-tabs-rerender').click()
    await page.waitForTimeout(600)

    assert.equal(await navigationTabs.evaluate((element) => element.scrollLeft), rightmostScroll)
  })
})

test('NavigationTabs reveals a newly activated tab', async () => {
  await withFixture(async (page) => {
    const navigationTabs = page.getByTestId('render-navigation-tabs-scroll')
    assert.equal(await navigationTabs.evaluate((element) => element.scrollLeft), 0)

    await page.getByTestId('render-navigation-tabs-activate-last').click()
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>('[data-testid="render-navigation-tabs-scroll"]')
      return Boolean(element && element.scrollLeft > 0)
    })

    assert.ok(await navigationTabs.evaluate((element) => element.scrollLeft > 0))
  })
})

test('ui primitives render accessible DOM and dispatch user events', async () => {
  await withFixture(async (page) => {
    const button = page.getByTestId('render-button')
    await assert.equal(await button.getAttribute('type'), 'button')
    await assert.equal(await button.isDisabled(), false)
    await button.click()
    await assert.equal(await button.isDisabled(), true)
    await assert.equal(await page.getByTestId('render-button-clicks').textContent(), '1')

    const navigationTabs = page.getByTestId('render-navigation-tabs')
    await assert.equal(await navigationTabs.locator('[data-slot="navigation-tab-divider"]').count(), 2)
    await assert.equal(
      await page.getByRole('tab', { name: 'Beta.md' }).locator('[data-slot="navigation-tab-divider"]').count(),
      1
    )
    await assert.equal(
      await page.getByRole('tab', { name: 'Gamma.md' }).locator('[data-slot="navigation-tab-divider"]').count(),
      0
    )
    const card = page.getByTestId('render-card')
    await assert.equal(await card.evaluate((element) => element.tagName), 'DIV')
    await assert.equal(await card.textContent(), '原子卡片')
    const structuredCard = page.getByTestId('render-card-structure')
    await assert.equal(await structuredCard.getByRole('heading', { name: '研究项目' }).evaluate((element) => element.tagName), 'H3')
    await assert.equal(await page.getByTestId('render-card-header').getByText('用于验证 Card 子组件语义。').textContent(), '用于验证 Card 子组件语义。')
    await assert.equal(await page.getByTestId('render-card-content').textContent(), '核心内容')
    await assert.equal(await page.getByTestId('render-card-footer').getByRole('button', { name: '查看' }).textContent(), '查看')

    const divider = page.getByTestId('render-divider')
    await assert.equal(await divider.evaluate((element) => element.tagName), 'HR')
    await assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await page.getByTestId('render-separator').evaluate((element) => element.tagName), 'HR')
    await assert.equal(await page.getByTestId('render-separator').getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await page.getByTestId('render-divider-vertical').getAttribute('aria-orientation'), 'vertical')

    const input = page.getByTestId('render-input')
    const messageId = await input.getAttribute('aria-describedby')
    assert.ok(messageId, 'Input error should be linked by aria-describedby')
    await assert.equal(await input.getAttribute('aria-invalid'), 'true')
    await assert.equal(await page.locator(`[id="${messageId}"]`).textContent(), '请输入有效名称')
    await assert.equal(await input.getAttribute('data-i18n-placeholder'), 'examples:input.placeholder')
    await assert.equal(await input.locator('..').getByText('名称', { exact: true }).getAttribute('data-i18n-text'), 'examples:input.label')
    await assert.equal(await page.locator(`[id="${messageId}"]`).getAttribute('data-i18n-text'), 'examples:input.error')
    const helperInput = page.getByTestId('render-input-helper')
    const helperInputMessageId = await helperInput.getAttribute('aria-describedby')
    assert.ok(helperInputMessageId, 'Input helperText should be linked by aria-describedby')
    await assert.equal(await helperInput.getAttribute('aria-invalid'), null)
    await assert.equal(await page.locator(`[id="${helperInputMessageId}"]`).textContent(), '请输入项目公开名称。')
    const invalidHelperInput = page.getByTestId('render-input-invalid-helper')
    const invalidHelperInputMessageId = await invalidHelperInput.getAttribute('aria-describedby')
    assert.ok(invalidHelperInputMessageId, 'Input invalid helperText should be linked by aria-describedby')
    await assert.equal(await invalidHelperInput.getAttribute('aria-invalid'), 'true')
    await assert.equal(await page.locator(`[id="${invalidHelperInputMessageId}"]`).textContent(), '名称将展示给团队成员。')
    const errorPriorityInput = page.getByTestId('render-input-error-priority')
    const errorPriorityInputMessageId = await errorPriorityInput.getAttribute('aria-describedby')
    assert.ok(errorPriorityInputMessageId, 'Input error should keep aria-describedby when helperText also exists')
    await assert.equal(await page.locator(`[id="${errorPriorityInputMessageId}"]`).textContent(), '错误文案优先。')
    await assert.equal(await page.getByText('辅助文案不应展示。').count(), 0)

    const textarea = page.getByTestId('render-textarea')
    const textareaMessageId = await textarea.getAttribute('aria-describedby')
    assert.ok(textareaMessageId, 'Textarea error should be linked by aria-describedby')
    await assert.equal(await textarea.getAttribute('aria-invalid'), 'true')
    await assert.equal(await page.locator(`[id="${textareaMessageId}"]`).textContent(), '请输入至少 10 个字')
    const helperTextarea = page.getByTestId('render-textarea-helper')
    const helperTextareaMessageId = await helperTextarea.getAttribute('aria-describedby')
    assert.ok(helperTextareaMessageId, 'Textarea helperText should be linked by aria-describedby')
    await assert.equal(await helperTextarea.getAttribute('aria-invalid'), null)
    await assert.equal(await page.locator(`[id="${helperTextareaMessageId}"]`).textContent(), '支持 Markdown 简述。')
    const invalidHelperTextarea = page.getByTestId('render-textarea-invalid-helper')
    const invalidHelperTextareaMessageId = await invalidHelperTextarea.getAttribute('aria-describedby')
    assert.ok(invalidHelperTextareaMessageId, 'Textarea invalid helperText should be linked by aria-describedby')
    await assert.equal(await invalidHelperTextarea.getAttribute('aria-invalid'), 'true')
    await assert.equal(await page.locator(`[id="${invalidHelperTextareaMessageId}"]`).textContent(), '说明暂不可为空。')
    const errorPriorityTextarea = page.getByTestId('render-textarea-error-priority')
    const errorPriorityTextareaMessageId = await errorPriorityTextarea.getAttribute('aria-describedby')
    assert.ok(errorPriorityTextareaMessageId, 'Textarea error should keep aria-describedby when helperText also exists')
    await assert.equal(await page.locator(`[id="${errorPriorityTextareaMessageId}"]`).textContent(), '错误说明优先。')
    await assert.equal(await page.getByText('辅助说明不应展示。').count(), 0)

    const switchControl = page.getByTestId('render-switch')
    await assert.equal(await switchControl.getAttribute('role'), 'switch')
    await assert.equal(await switchControl.getAttribute('aria-checked'), 'false')
    await switchControl.click()
    await assert.equal(await switchControl.getAttribute('aria-checked'), 'true')
    await assert.equal(await page.getByTestId('render-switch-value').textContent(), 'on')

    const checkbox = page.getByTestId('render-checkbox')
    await assert.equal(await checkbox.getAttribute('role'), 'checkbox')
    await assert.equal(await checkbox.getAttribute('aria-checked'), 'false')
    await checkbox.getByText('同意条款').click()
    await assert.equal(await checkbox.getAttribute('aria-checked'), 'true')
    await assert.equal(await page.getByTestId('render-checkbox-value').textContent(), 'yes')
    await assert.equal(await page.getByTestId('render-checkbox-mixed').getAttribute('aria-checked'), 'mixed')

    const radio = page.getByTestId('render-radio')
    await assert.equal(await radio.getAttribute('role'), 'radio')
    await assert.equal(await radio.getAttribute('aria-checked'), 'false')
    await radio.getByText('自动模式').click()
    await assert.equal(await radio.getAttribute('aria-checked'), 'true')
    await assert.equal(await page.getByTestId('render-radio-value').textContent(), 'auto')

    const radioGroup = page.getByTestId('render-radio-group')
    await assert.equal(await radioGroup.getAttribute('role'), 'radiogroup')
    await assert.equal(await radioGroup.getAttribute('aria-orientation'), 'vertical')
    await assert.equal(await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('aria-checked'), 'true')
    await assert.equal(await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('tabindex'), '0')
    await assert.equal(await radioGroup.getByRole('radio', { name: '自动模式' }).getAttribute('tabindex'), '-1')
    await assert.equal(await radioGroup.getByRole('radio', { name: '禁用模式' }).getAttribute('tabindex'), null)
    await radioGroup.getByRole('radio', { name: '自动模式' }).click()
    await assert.equal(await page.getByTestId('render-radio-group-value').textContent(), 'auto')
    await assert.equal(await radioGroup.getByRole('radio', { name: '自动模式' }).getAttribute('aria-checked'), 'true')
    await assert.equal(await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('tabindex'), '-1')
    await assert.equal(await radioGroup.getByRole('radio', { name: '自动模式' }).getAttribute('tabindex'), '0')
    await radioGroup.getByRole('radio', { name: '自动模式' }).focus()
    await radioGroup.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-radio-group-value').textContent(), 'manual')
    await assert.equal(await radioGroup.getByRole('radio', { name: '手动模式' }).getAttribute('tabindex'), '0')
    await assert.equal(await radioGroup.getByRole('radio', { name: '手动模式' }).evaluate((element) => document.activeElement === element), true)
    await radioGroup.press('ArrowUp')
    await assert.equal(await page.getByTestId('render-radio-group-value').textContent(), 'auto')
    await assert.equal(await radioGroup.getByRole('radio', { name: '自动模式' }).evaluate((element) => document.activeElement === element), true)

    const disabledRadioGroup = page.getByTestId('render-radio-group-disabled')
    await assert.equal(await disabledRadioGroup.getAttribute('aria-disabled'), 'true')
    await assert.equal(await disabledRadioGroup.getByRole('radio', { name: '极速模式' }).isDisabled(), true)
    await disabledRadioGroup.getByRole('radio', { name: '极速模式' }).click({ force: true })
    await assert.equal(await page.getByTestId('render-radio-group-disabled-value').textContent(), 'safe')

    const select = page.getByTestId('render-select')
    const selectMessageId = await select.getAttribute('aria-describedby')
    assert.ok(selectMessageId, 'Select error should be linked by aria-describedby')
    await assert.equal(await select.getAttribute('aria-invalid'), 'true')
    await select.selectOption('all')
    await assert.equal(await select.getAttribute('aria-invalid'), null)
    await assert.equal(await page.getByTestId('render-select-value').textContent(), 'all')

    const alert = page.getByTestId('render-alert')
    await assert.equal(await alert.getAttribute('role'), 'alert')
    await assert.equal(await alert.getByText('保存失败').textContent(), '保存失败')
    await assert.equal(await alert.getByText('请检查填写内容后重试。').textContent(), '请检查填写内容后重试。')
    await assert.equal(await alert.getByText('保存失败').getAttribute('data-i18n-text'), 'examples:alert.title')
    await assert.equal(await alert.getByText('请检查填写内容后重试。').getAttribute('data-i18n-text'), 'examples:alert.description')

    const progress = page.getByTestId('render-progress')
    const progressTrack = progress.getByRole('progressbar')
    await assert.equal(await progressTrack.getAttribute('aria-valuemin'), '0')
    await assert.equal(await progressTrack.getAttribute('aria-valuemax'), '100')
    await assert.equal(await progressTrack.getAttribute('aria-valuenow'), '60')
    assert.ok(
      (await progress.getAttribute('style'))?.includes('color: rgb(1, 2, 3);'),
      'ProgressBar should keep caller styles on its root element'
    )
    await assert.equal(await progress.getByText('上传进度').textContent(), '上传进度')
    await assert.equal(
      await page.getByTestId('render-progress-indeterminate').getByRole('progressbar').getAttribute('aria-valuenow'),
      null
    )

    const avatar = page.getByTestId('render-avatar')
    await assert.equal(await avatar.locator('img').count(), 1)
    await avatar.locator('img').dispatchEvent('error')
    await assert.equal(await avatar.locator('img').count(), 0)
    await assert.equal(await avatar.getByText('书').textContent(), '书')

    const formControl = page.getByTestId('render-form-control')
    const formField = page.getByTestId('render-form-field')
    const formLabel = formField.locator('label')
    const description = formField.getByText('用于展示在项目列表中。')
    const message = formField.getByText('项目名称不能为空。')
    const controlId = await formControl.getAttribute('id')
    assert.ok(controlId, 'FormControl should receive a stable id')
    await assert.equal(await formLabel.getAttribute('for'), controlId)
    await assert.equal(await formControl.getAttribute('aria-describedby'), `${await description.getAttribute('id')} ${await message.getAttribute('id')}`)
    await assert.equal(await formControl.getAttribute('aria-invalid'), 'true')

    await assert.equal(
      await page.getByTestId('render-form-control-without-help').getAttribute('aria-describedby'),
      null
    )

    const emptyState = page.getByTestId('render-empty-state')
    await assert.equal(await emptyState.getByText('暂无项目').textContent(), '暂无项目')
    await assert.equal(await emptyState.getByText('当前没有项目。').textContent(), '当前没有项目。')
    await assert.equal(await emptyState.getByText('暂无项目').getAttribute('data-i18n-text'), 'examples:empty.title')
    await assert.equal(await emptyState.getByText('当前没有项目。').getAttribute('data-i18n-text'), 'examples:empty.description')
    await assert.equal(await emptyState.locator('.vds-empty-state__image').getAttribute('src'), '/assets/empty-test.webp')
    await assert.equal(await emptyState.getByRole('button', { name: '创建项目' }).textContent(), '创建项目')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            const mode = window.localStorage.getItem('copy-mode')
            window.localStorage.setItem('copy-attempts', String(Number(window.localStorage.getItem('copy-attempts') ?? '0') + 1))
            window.localStorage.setItem('copied-text', text)
            if (mode === 'reject') {
              return Promise.reject(new Error('clipboard rejected'))
            }
            return Promise.resolve()
          }
        }
      })
    })
    const copyButton = page.getByTestId('render-copy-button')
    await assert.equal(await copyButton.getAttribute('aria-label'), '复制')
    await copyButton.click()
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copied-text')), 'copy-value')
    await assert.equal(await copyButton.getAttribute('aria-label'), '已复制')
    await assert.equal(await copyButton.getAttribute('data-copy-status'), 'success')
    await page.waitForFunction(() => document.querySelector('[data-testid="render-copy-button"]')?.getAttribute('aria-label') === '复制')
    await assert.equal(await copyButton.getAttribute('data-copy-status'), 'idle')

    await page.evaluate(() => {
      window.localStorage.setItem('copy-mode', 'reject')
    })
    const rejectedCopyButton = page.getByTestId('render-copy-reject')
    await rejectedCopyButton.click()
    await assert.equal(await rejectedCopyButton.getAttribute('aria-label'), '复制失败')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined
      })
      window.localStorage.setItem('copy-mode', 'resolve')
    })
    const missingClipboardButton = page.getByTestId('render-copy-missing')
    await missingClipboardButton.click()
    await assert.equal(await missingClipboardButton.getAttribute('aria-label'), '复制失败')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            window.localStorage.setItem('copy-attempts', String(Number(window.localStorage.getItem('copy-attempts') ?? '0') + 1))
            window.localStorage.setItem('copied-text', text)
            return Promise.resolve()
          }
        }
      })
      window.localStorage.setItem('copy-attempts', '0')
      window.localStorage.removeItem('copied-text')
    })
    const disabledCopyButton = page.getByTestId('render-copy-disabled')
    await assert.equal(await disabledCopyButton.isDisabled(), true)
    await disabledCopyButton.click({ force: true })
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copy-attempts')), '0')
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copied-text')), null)

    const preventedCopyButton = page.getByTestId('render-copy-prevented')
    await preventedCopyButton.click()
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copy-attempts')), '0')
    await assert.equal(await page.evaluate(() => window.localStorage.getItem('copied-text')), null)

    const loadingOverlay = page.getByTestId('render-loading-overlay')
    await assert.equal(await loadingOverlay.getAttribute('role'), 'status')
    await assert.equal(await loadingOverlay.getAttribute('aria-busy'), 'true')
    await assert.equal(await loadingOverlay.getByText('同步中').textContent(), '同步中')
    await assert.equal(await page.getByTestId('render-loading-hidden').count(), 0)

    const table = page.getByTestId('render-table')
    await assert.equal(await table.evaluate((element) => element.tagName), 'TABLE')
    await assert.equal(await table.locator('caption').textContent(), '项目列表')
    await assert.equal(await table.locator('th').first().getAttribute('scope'), 'col')
    await assert.equal(await table.getByText('DeepRD').textContent(), 'DeepRD')

    const pagination = page.getByTestId('render-pagination')
    await assert.equal(await pagination.getAttribute('aria-label'), '分页')
    await assert.equal(await pagination.getByRole('button', { name: '第 4 页' }).getAttribute('aria-current'), 'page')
    await pagination.getByRole('button', { name: '下一页' }).click()
    await assert.equal(await page.getByTestId('render-pagination-value').textContent(), '5')
    await assert.equal(await pagination.getByRole('button', { name: '第 5 页' }).getAttribute('aria-current'), 'page')

    const disabledPagination = page.getByTestId('render-pagination-disabled')
    await assert.equal(await disabledPagination.getByRole('button', { name: '上一页' }).isDisabled(), true)
    await assert.equal(await disabledPagination.getByRole('button', { name: '第 3 页' }).isDisabled(), true)
    await disabledPagination.getByRole('button', { name: '第 3 页' }).click({ force: true })
    await assert.equal(await page.getByTestId('render-pagination-disabled-value').textContent(), '2')

    await assert.equal(await page.getByTestId('render-pagination-first').getByRole('button', { name: '上一页' }).isDisabled(), true)
    await assert.equal(await page.getByTestId('render-pagination-last').getByRole('button', { name: '下一页' }).isDisabled(), true)
    await assert.equal(
      await page.getByTestId('render-pagination-overflow').getByRole('button', { name: '第 3 页' }).getAttribute('aria-current'),
      'page'
    )
    await assert.equal(
      await page.getByTestId('render-pagination-overflow').getByRole('button', { name: '下一页' }).isDisabled(),
      true
    )
    await assert.equal(
      await page.getByTestId('render-pagination-underflow').getByRole('button', { name: '第 1 页' }).getAttribute('aria-current'),
      'page'
    )
    await assert.equal(
      await page.getByTestId('render-pagination-underflow').getByRole('button', { name: '上一页' }).isDisabled(),
      true
    )

    const aspectRatio = page.getByTestId('render-aspect-ratio')
    await assert.equal(await aspectRatio.evaluate((element) => getComputedStyle(element).getPropertyValue('--vds-aspect-ratio').trim()), '1.3333333333333333')
    assert.ok(
      (await aspectRatio.getAttribute('style'))?.includes('color: rgb(4, 5, 6);'),
      'AspectRatio should keep caller styles on its root element'
    )
    await assert.equal(await page.getByTestId('render-aspect-content').textContent(), '比例内容')

    const breadcrumb = page.getByTestId('render-breadcrumb')
    await assert.equal(await breadcrumb.evaluate((element) => element.tagName), 'NAV')
    await assert.equal(await breadcrumb.getAttribute('aria-label'), '项目路径')
    await assert.equal(await breadcrumb.getByText('DeepRD').getAttribute('aria-current'), 'page')
    await assert.equal(await breadcrumb.getByLabel('更多路径').textContent(), '...')
    await assert.equal(await breadcrumb.locator('ol').count(), 1)
    await assert.equal(
      await page.getByTestId('render-breadcrumb-custom-ellipsis').getByLabel('展开隐藏路径').textContent(),
      '...'
    )

    const collapsibleTrigger = page.getByTestId('render-collapsible-trigger')
    const collapsibleContent = page.getByTestId('render-collapsible-content')
    const collapsibleContentId = await collapsibleContent.getAttribute('id')
    assert.ok(collapsibleContentId, 'Collapsible content should receive a stable id')
    await assert.equal(await collapsibleTrigger.getAttribute('aria-controls'), collapsibleContentId)
    await assert.equal(await collapsibleTrigger.getAttribute('aria-expanded'), 'false')
    await assert.equal(await collapsibleContent.getAttribute('hidden'), '')
    await collapsibleTrigger.click()
    await assert.equal(await collapsibleTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await collapsibleContent.getAttribute('hidden'), null)

    const keyboardCollapsibleTrigger = page.getByTestId('render-collapsible-keyboard')
    await keyboardCollapsibleTrigger.focus()
    await keyboardCollapsibleTrigger.press('Enter')
    await assert.equal(await page.getByTestId('render-collapsible-controlled-value').textContent(), 'open')
    await keyboardCollapsibleTrigger.press(' ')
    await assert.equal(await page.getByTestId('render-collapsible-controlled-value').textContent(), 'closed')

    const disabledCollapsibleTrigger = page.getByTestId('render-collapsible-disabled-trigger')
    await assert.equal(await disabledCollapsibleTrigger.isDisabled(), true)
    await disabledCollapsibleTrigger.click({ force: true })
    await assert.equal(await page.getByTestId('render-collapsible-disabled-content').getAttribute('hidden'), '')

    const tabs = page.getByTestId('render-tabs')
    const overviewTab = tabs.getByRole('tab', { name: '概览' })
    const tasksTab = tabs.getByRole('tab', { name: '任务' })
    const disabledTab = tabs.getByRole('tab', { name: '禁用' })
    const settingsTab = tabs.getByRole('tab', { name: '设置' })
    await assert.equal(await tabs.getByRole('tablist').getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await overviewTab.getAttribute('aria-selected'), 'true')
    await assert.equal(await overviewTab.getAttribute('tabindex'), '0')
    await assert.equal(await tasksTab.getAttribute('tabindex'), '-1')
    await assert.equal(await disabledTab.isDisabled(), true)
    await tasksTab.click()
    await assert.equal(await page.getByTestId('render-tabs-value').textContent(), 'tasks')
    await assert.equal(await tasksTab.getAttribute('aria-selected'), 'true')
    await assert.equal(await tabs.getByRole('tabpanel', { name: '任务' }).textContent(), '任务面板')
    await tasksTab.focus()
    await tabs.getByRole('tablist').press('ArrowRight')
    await assert.equal(await page.getByTestId('render-tabs-value').textContent(), 'settings')
    await assert.equal(await settingsTab.evaluate((element) => document.activeElement === element), true)
    await tabs.getByRole('tablist').press('ArrowLeft')
    await assert.equal(await page.getByTestId('render-tabs-value').textContent(), 'tasks')
    await assert.equal(await tasksTab.evaluate((element) => document.activeElement === element), true)

    const defaultTabs = page.getByTestId('render-tabs-default')
    await assert.equal(await defaultTabs.getByRole('tab', { name: '甲' }).getAttribute('aria-selected'), 'true')
    await assert.equal(await defaultTabs.getByRole('tab', { name: '甲' }).getAttribute('tabindex'), '0')
    await assert.equal(await defaultTabs.getByRole('tab', { name: '乙' }).getAttribute('aria-selected'), 'false')
    await assert.equal(await defaultTabs.getByRole('tabpanel', { name: '甲' }).textContent(), '甲面板')

    const invalidTabs = page.getByTestId('render-tabs-invalid')
    await assert.equal(await invalidTabs.getByRole('tab', { name: '有效' }).getAttribute('aria-selected'), 'true')
    await assert.equal(await invalidTabs.getByRole('tab', { name: '有效' }).getAttribute('tabindex'), '0')
    await assert.equal(await invalidTabs.getByRole('tab', { name: '其他' }).getAttribute('aria-selected'), 'false')
    await assert.equal(await invalidTabs.getByRole('tabpanel', { name: '有效' }).textContent(), '有效面板')

    const allDisabledTabs = page.getByTestId('render-tabs-all-disabled')
    await assert.equal(await allDisabledTabs.getByRole('tab', { name: '禁用一' }).isDisabled(), true)
    await assert.equal(await allDisabledTabs.getByRole('tab', { name: '禁用二' }).isDisabled(), true)
    await assert.equal(await allDisabledTabs.getByRole('tab', { name: '禁用一' }).getAttribute('aria-selected'), 'false')
    await assert.equal(await allDisabledTabs.getByRole('tab', { name: '禁用二' }).getAttribute('aria-selected'), 'false')
    await assert.equal(await allDisabledTabs.getByText('禁用一面板').getAttribute('hidden'), '')
    await assert.equal(await allDisabledTabs.getByText('禁用二面板').getAttribute('hidden'), '')

    const accordion = page.getByTestId('render-accordion')
    const summaryTrigger = accordion.getByRole('button', { name: '摘要' })
    const detailTrigger = accordion.getByRole('button', { name: '详情' })
    const disabledAccordionTrigger = accordion.getByRole('button', { name: '禁用项' })
    await assert.equal(await summaryTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await accordion.getByText('摘要内容').getAttribute('hidden'), null)
    await detailTrigger.click()
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), 'detail')
    await assert.equal(await summaryTrigger.getAttribute('aria-expanded'), 'false')
    await assert.equal(await detailTrigger.getAttribute('aria-expanded'), 'true')
    await detailTrigger.focus()
    await accordion.press('ArrowUp')
    await assert.equal(await summaryTrigger.evaluate((element) => document.activeElement === element), true)
    await accordion.press('End')
    await assert.equal(await detailTrigger.evaluate((element) => document.activeElement === element), true)
    await accordion.press('Home')
    await assert.equal(await summaryTrigger.evaluate((element) => document.activeElement === element), true)
    await summaryTrigger.press(' ')
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), 'summary')
    await summaryTrigger.press(' ')
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), '')
    await assert.equal(await disabledAccordionTrigger.isDisabled(), true)
    await disabledAccordionTrigger.click({ force: true })
    await assert.equal(await page.getByTestId('render-accordion-value').textContent(), '')

    const multipleAccordion = page.getByTestId('render-accordion-multiple')
    const firstAccordionTrigger = multipleAccordion.getByRole('button', { name: '第一项' })
    const secondAccordionTrigger = multipleAccordion.getByRole('button', { name: '第二项' })
    await assert.equal(await firstAccordionTrigger.getAttribute('aria-expanded'), 'true')
    await secondAccordionTrigger.click()
    await assert.equal(await firstAccordionTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await secondAccordionTrigger.getAttribute('aria-expanded'), 'true')
    await assert.equal(await page.getByTestId('render-accordion-multiple-value').textContent(), 'first,second')
    await firstAccordionTrigger.click()
    await assert.equal(await firstAccordionTrigger.getAttribute('aria-expanded'), 'false')
    await assert.equal(await page.getByTestId('render-accordion-multiple-value').textContent(), 'second')

    const keydownAccordion = page.getByTestId('render-accordion-keydown')
    const keydownFirst = keydownAccordion.getByRole('button', { name: '键盘一' })
    const keydownSecond = keydownAccordion.getByRole('button', { name: '键盘二' })
    await keydownFirst.focus()
    await keydownAccordion.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-accordion-keydown-events').textContent(), '1')
    await assert.equal(await keydownSecond.evaluate((element) => document.activeElement === element), true)

    const blockedKeydownAccordion = page.getByTestId('render-accordion-keydown-prevented')
    const blockedKeydownFirst = blockedKeydownAccordion.getByRole('button', { name: '阻止一' })
    const blockedKeydownSecond = blockedKeydownAccordion.getByRole('button', { name: '阻止二' })
    await blockedKeydownFirst.focus()
    await blockedKeydownAccordion.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-accordion-keydown-prevented-events').textContent(), '1')
    await assert.equal(await blockedKeydownFirst.evaluate((element) => document.activeElement === element), true)
    await assert.equal(await blockedKeydownSecond.evaluate((element) => document.activeElement === element), false)

    const scrollArea = page.getByTestId('render-scroll-area')
    await assert.equal(await scrollArea.getAttribute('data-orientation'), 'both')
    const scrollViewport = page.getByTestId('render-scroll-area-viewport')
    await assert.equal(await scrollViewport.getAttribute('role'), 'region')
    await assert.equal(await scrollViewport.getAttribute('aria-label'), '滚动视口')
    await assert.equal(await scrollViewport.getAttribute('tabindex'), '0')
    await scrollViewport.focus()
    await assert.equal(await scrollViewport.evaluate((element) => document.activeElement === element), true)
    await assert.equal(await scrollViewport.evaluate((element) => getComputedStyle(element).overflowX), 'auto')
    await assert.equal(await scrollViewport.evaluate((element) => getComputedStyle(element).overflowY), 'auto')

    const slider = page.getByTestId('render-slider')
    await assert.equal(await slider.getAttribute('role'), null)
    await assert.equal(await slider.getAttribute('aria-valuemin'), '0')
    await assert.equal(await slider.getAttribute('aria-valuemax'), '100')
    await assert.equal(await slider.getAttribute('aria-valuenow'), '20')
    await slider.focus()
    await slider.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '25')
    await slider.press('PageUp')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '75')
    await slider.press('End')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '100')
    await slider.press('Home')
    await assert.equal(await page.getByTestId('render-slider-value').textContent(), '0')
    const uncontrolledSlider = page.getByTestId('render-slider-uncontrolled')
    await assert.equal(await uncontrolledSlider.inputValue(), '10')
    await uncontrolledSlider.press('ArrowRight')
    await assert.equal(await uncontrolledSlider.inputValue(), '15')
    await assert.equal(await page.getByTestId('render-slider-uncontrolled-changes').textContent(), '1')
    const verticalSlider = page.getByTestId('render-slider-vertical')
    await assert.equal(await verticalSlider.getAttribute('aria-orientation'), 'vertical')
    await verticalSlider.focus()
    await verticalSlider.press('ArrowUp')
    await assert.equal(await verticalSlider.inputValue(), '60')
    await verticalSlider.press('ArrowLeft')
    await assert.equal(await verticalSlider.inputValue(), '70')
    const disabledSlider = page.getByTestId('render-slider-disabled')
    await assert.equal(await disabledSlider.isDisabled(), true)
    await disabledSlider.press('End')
    await assert.equal(await page.getByTestId('render-slider-disabled-value').textContent(), '30')

    const otp = page.getByTestId('render-input-otp')
    const otpGroup = otp.getByRole('group', { name: '验证码' })
    const otpFirst = otp.getByLabel('验证码 1')
    const otpSecond = otp.getByLabel('验证码 2')
    await assert.equal(await otpGroup.count(), 1)
    const otpDescriptionId = await otpFirst.getAttribute('aria-describedby')
    assert.ok(otpDescriptionId, 'InputOTP description should be linked by aria-describedby')
    await assert.equal(await page.locator(`[id="${otpDescriptionId}"]`).textContent(), '输入收到的 6 位验证码。')
    await otpFirst.fill('1')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '1')
    await assert.equal(await otpSecond.evaluate((element) => document.activeElement === element), true)
    await otpSecond.fill('2')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '12')
    await otpSecond.press('Backspace')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '1')
    await assert.equal(await otpSecond.evaluate((element) => document.activeElement === element), true)
    await otpSecond.press('Backspace')
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '')
    await assert.equal(await otpFirst.evaluate((element) => document.activeElement === element), true)
    await otpFirst.evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', '987654')
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
    })
    await assert.equal(await page.getByTestId('render-input-otp-value').textContent(), '987654')
    await assert.equal(await page.getByTestId('render-input-otp-complete').textContent(), '987654')
    await assert.equal(await otp.getByLabel('验证码 6').evaluate((element) => document.activeElement === element), true)

    const textOtp = page.getByTestId('render-input-otp-text')
    await assert.equal(await textOtp.getByLabel('文本代码 1').inputValue(), 'A')
    await assert.equal(await textOtp.getByLabel('文本代码 2').inputValue(), 'Z')
    await textOtp.getByLabel('文本代码 3').fill('x')
    await assert.equal(await page.getByTestId('render-input-otp-text-value').textContent(), 'AZx')
    await assert.equal(await textOtp.locator('.vds-input-otp__separator').textContent(), '-')

    const compositionOtp = page.getByTestId('render-input-otp-composition')
    const compositionFirst = compositionOtp.getByLabel('组合输入 1')
    const compositionSecond = compositionOtp.getByLabel('组合输入 2')
    await compositionFirst.focus()
    await compositionFirst.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'n' }))
        ; (element as HTMLInputElement).value = 'n'
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'n' }))
    })
    await assert.equal(await page.getByTestId('render-input-otp-composition-value').textContent(), '')
    await assert.equal(await page.getByTestId('render-input-otp-composition-changes').textContent(), '0')
    await assert.equal(await compositionFirst.evaluate((element) => document.activeElement === element), true)
    await compositionFirst.evaluate((element) => {
      ; (element as HTMLInputElement).value = '你'
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }))
    })
    await assert.equal(await page.getByTestId('render-input-otp-composition-value').textContent(), '你')
    await assert.equal(await page.getByTestId('render-input-otp-composition-changes').textContent(), '1')
    await assert.equal(await compositionSecond.evaluate((element) => document.activeElement === element), true)

    const stableOtp = page.getByTestId('render-input-otp-stable')
    const stableFirst = stableOtp.getByLabel('稳定槽位 1')
    const stableSecond = stableOtp.getByLabel('稳定槽位 2')
    const stableThird = stableOtp.getByLabel('稳定槽位 3')
    const stableFourth = stableOtp.getByLabel('稳定槽位 4')
    await assert.equal(await stableFirst.inputValue(), '1')
    await assert.equal(await stableSecond.inputValue(), '2')
    await assert.equal(await stableThird.inputValue(), '3')
    await assert.equal(await stableFourth.inputValue(), '4')
    await stableSecond.press('Backspace')
    await assert.equal(await stableFirst.inputValue(), '1')
    await assert.equal(await stableSecond.inputValue(), '')
    await assert.equal(await stableThird.inputValue(), '3')
    await assert.equal(await stableFourth.inputValue(), '4')
    await assert.equal(await page.getByTestId('render-input-otp-stable-value').textContent(), '134')

    const controlledSlotsOtp = page.getByTestId('render-input-otp-controlled-slots')
    const controlledSlotsFirst = controlledSlotsOtp.getByLabel('受控槽位 1')
    const controlledSlotsSecond = controlledSlotsOtp.getByLabel('受控槽位 2')
    const controlledSlotsThird = controlledSlotsOtp.getByLabel('受控槽位 3')
    const controlledSlotsFourth = controlledSlotsOtp.getByLabel('受控槽位 4')
    await controlledSlotsSecond.press('Backspace')
    await assert.equal(await controlledSlotsFirst.inputValue(), '1')
    await assert.equal(await controlledSlotsSecond.inputValue(), '')
    await assert.equal(await controlledSlotsThird.inputValue(), '3')
    await assert.equal(await controlledSlotsFourth.inputValue(), '4')
    await assert.equal(await page.getByTestId('render-input-otp-controlled-slots-value').textContent(), '1_34')

    const customSlot = page.getByTestId('render-input-otp-slot-class').getByLabel('自定义槽位 1')
    const customSlotClass = await customSlot.getAttribute('class')
    assert.ok(customSlotClass?.includes('vds-input-otp__slot'), 'InputOTP should keep its base slot class')
    assert.ok(customSlotClass?.includes('custom-otp-slot'), 'InputOTP should merge slotProps.className')

    const invalidOtp = page.getByTestId('render-input-otp-invalid')
    const invalidOtpFirst = invalidOtp.getByLabel('错误验证码 1')
    const invalidDescription = await invalidOtpFirst.getAttribute('aria-describedby')
    assert.ok(invalidDescription, 'InputOTP error should be linked by aria-describedby')
    await assert.equal(await invalidOtpFirst.getAttribute('aria-invalid'), 'true')
    await assert.equal(await page.locator(`[id="${invalidDescription}"]`).textContent(), '验证码错误。')

    const disabledOtp = page.getByTestId('render-input-otp-disabled')
    const disabledOtpFirst = disabledOtp.getByLabel('禁用验证码 1')
    await assert.equal(await disabledOtp.getAttribute('aria-disabled'), 'true')
    await assert.equal(await disabledOtpFirst.isDisabled(), true)
    await disabledOtpFirst.fill('9', { force: true })
    await assert.equal(await page.getByTestId('render-input-otp-disabled-value').textContent(), '12')

    const command = page.getByTestId('render-command')
    const commandInput = page.getByTestId('render-command-input')
    const commandList = page.getByTestId('render-command-list')
    const openCommand = command.getByRole('option', { includeHidden: true, name: '打开项目' })
    const newCommand = command.getByRole('option', { name: '新建项目' })
    const listCommand = command.getByRole('option', { name: '切换列表' })
    const archiveCommand = command.getByRole('option', { name: '归档视图' })
    await assert.equal(await command.getAttribute('aria-disabled'), null)
    await assert.equal(await commandList.getAttribute('role'), 'listbox')
    await assert.equal(await openCommand.getAttribute('aria-selected'), 'true')
    await assert.equal(await archiveCommand.isDisabled(), true)
    await commandInput.fill('create')
    await assert.equal(await page.getByTestId('render-command-search').textContent(), 'create')
    await page.waitForFunction(() => document.querySelector('[data-testid="render-command"] [value="open"]')?.hasAttribute('hidden'))
    await assert.equal(await openCommand.evaluate((element) => (element as HTMLButtonElement).hidden), true)
    await assert.equal(await newCommand.evaluate((element) => (element as HTMLButtonElement).hidden), false)
    await newCommand.click()
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'new')
    await assert.equal(await page.getByTestId('render-command-selects').textContent(), 'new')
    await commandInput.fill('zzz')
    await assert.equal(await command.getByText('没有匹配命令').textContent(), '没有匹配命令')
    await commandInput.fill('')
    await newCommand.focus()
    await commandList.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'list')
    await assert.equal(await listCommand.evaluate((element) => document.activeElement === element), true)
    await commandList.press('Home')
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'open')
    await assert.equal(await openCommand.evaluate((element) => document.activeElement === element), true)
    await commandList.press('End')
    await assert.equal(await page.getByTestId('render-command-value').textContent(), 'list')

    const defaultCommand = page.getByTestId('render-command-default')
    await assert.equal(
      await defaultCommand.getByRole('option', { name: '新建项目' }).evaluate((element) => (element as HTMLButtonElement).hidden),
      false
    )
    await assert.equal(
      await defaultCommand.getByRole('option', { includeHidden: true, name: '打开项目' }).evaluate((element) => (element as HTMLButtonElement).hidden),
      true
    )
    await assert.equal(await page.getByTestId('render-command-default-input').inputValue(), 'create')

    const disabledCommand = page.getByTestId('render-command-disabled')
    const disabledCommandInput = page.getByTestId('render-command-disabled-input')
    await assert.equal(await disabledCommand.getAttribute('aria-disabled'), 'true')
    await assert.equal(await disabledCommandInput.isDisabled(), true)
    await disabledCommand.getByRole('option', { name: '其他' }).click({ force: true })
    await assert.equal(await page.getByTestId('render-command-disabled-value').textContent(), 'locked')

    const resizable = page.getByTestId('render-resizable')
    const resizableHandle = page.getByTestId('render-resizable-handle')
    await assert.equal(await resizable.getAttribute('data-direction'), 'horizontal')
    await assert.equal(await resizableHandle.getAttribute('role'), 'separator')
    await assert.equal(await resizableHandle.getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await resizableHandle.getAttribute('aria-valuemin'), '20')
    await assert.equal(await resizableHandle.getAttribute('aria-valuemax'), '80')
    await assert.equal(Math.round(Number(await resizableHandle.getAttribute('aria-valuenow'))), 30)
    await resizableHandle.focus()
    await resizableHandle.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-resizable-sizes').textContent(), '35,65')
    await assert.equal(Math.round(Number(await resizableHandle.getAttribute('aria-valuenow'))), 35)
    await resizableHandle.press('Home')
    await assert.equal(await page.getByTestId('render-resizable-sizes').textContent(), '20,80')
    const handleBox = await resizableHandle.boundingBox()
    assert.ok(handleBox, 'Resizable handle should have a visible box')
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2)
    await page.mouse.up()
    const draggedSizes = (await page.getByTestId('render-resizable-sizes').textContent()) ?? ''
    assert.notEqual(draggedSizes, '20,80')

    const defaultResizable = page.getByTestId('render-resizable-default')
    await assert.equal(await defaultResizable.getByLabel('默认左侧').getAttribute('data-panel-size'), '25')
    await page.getByTestId('render-resizable-default-handle').press('ArrowRight')
    await assert.equal(await defaultResizable.getByLabel('默认左侧').getAttribute('data-panel-size'), '30')

    const panelDefaultResizable = page.getByTestId('render-resizable-panel-default')
    await assert.equal(await panelDefaultResizable.getByLabel('面板默认左侧').getAttribute('data-panel-size'), '35')
    await assert.equal(await panelDefaultResizable.getByLabel('面板默认右侧').getAttribute('data-panel-size'), '65')

    const defaultClampedResizable = page.getByTestId('render-resizable-default-clamped')
    await assert.equal(Math.round(Number(await defaultClampedResizable.getByLabel('约束默认左侧').getAttribute('data-panel-size'))), 20)
    await assert.equal(Math.round(Number(await defaultClampedResizable.getByLabel('约束默认右侧').getAttribute('data-panel-size'))), 80)

    const controlledClampedResizable = page.getByTestId('render-resizable-controlled-clamped')
    const controlledClampedHandle = page.getByTestId('render-resizable-controlled-clamped-handle')
    await assert.equal(Math.round(Number(await controlledClampedResizable.getByLabel('受控约束左侧').getAttribute('data-panel-size'))), 20)
    await assert.equal(Math.round(Number(await controlledClampedResizable.getByLabel('受控约束右侧').getAttribute('data-panel-size'))), 80)
    await controlledClampedHandle.press('End')
    await assert.equal(await page.getByTestId('render-resizable-controlled-clamped-sizes').textContent(), '70,30')
    await assert.equal(Math.round(Number(await controlledClampedHandle.getAttribute('aria-valuenow'))), 70)

    const verticalResizable = page.getByTestId('render-resizable-vertical')
    const verticalHandle = page.getByTestId('render-resizable-vertical-handle')
    await assert.equal(await verticalResizable.getAttribute('data-direction'), 'vertical')
    await assert.equal(await verticalHandle.getAttribute('aria-orientation'), 'vertical')
    await verticalHandle.press('ArrowUp')
    await assert.equal(
      Math.round(Number(await verticalResizable.getByLabel('上方面板').getAttribute('data-panel-size'))),
      55
    )

    const disabledResizable = page.getByTestId('render-resizable-disabled')
    const disabledResizableHandle = page.getByTestId('render-resizable-disabled-handle')
    await assert.equal(await disabledResizable.getAttribute('aria-disabled'), 'true')
    await assert.equal(await disabledResizableHandle.getAttribute('tabindex'), null)
    await disabledResizableHandle.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-resizable-disabled-sizes').textContent(), '45,55')

    const rightSplit = page.getByTestId('render-resizable-right-split')
    const rightSplitHandle = rightSplit.getByRole('button', { name: /^(Resize panels|调整面板大小)$/ })
    const rightSplitPanel = page.getByTestId('render-resizable-right-split-right').locator('..')
    await assert.equal(await rightSplitPanel.evaluate((element) => getComputedStyle(element).width), '403px')
    await rightSplitHandle.scrollIntoViewIfNeeded()
    const rightSplitHandleBox = await rightSplitHandle.boundingBox()
    assert.ok(rightSplitHandleBox, 'Right split handle should have a visible box')
    await page.mouse.move(
      rightSplitHandleBox.x + rightSplitHandleBox.width / 2,
      rightSplitHandleBox.y + rightSplitHandleBox.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      rightSplitHandleBox.x + rightSplitHandleBox.width / 2 - 100,
      rightSplitHandleBox.y + rightSplitHandleBox.height / 2
    )
    await page.mouse.up()
    await assert.equal(await page.getByTestId('render-resizable-right-width').textContent(), '503px')
    const expandedRightSplitHandleBox = await rightSplitHandle.boundingBox()
    assert.ok(expandedRightSplitHandleBox, 'Expanded right split handle should have a visible box')
    await page.mouse.move(
      expandedRightSplitHandleBox.x + expandedRightSplitHandleBox.width / 2,
      expandedRightSplitHandleBox.y + expandedRightSplitHandleBox.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      expandedRightSplitHandleBox.x + expandedRightSplitHandleBox.width / 2 - 500,
      expandedRightSplitHandleBox.y + expandedRightSplitHandleBox.height / 2
    )
    await page.mouse.up()
    await assert.equal(await page.getByTestId('render-resizable-right-width').textContent(), '600px')

    const toggle = page.getByTestId('render-toggle')
    await assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    await toggle.click()
    await assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
    await assert.equal(await page.getByTestId('render-toggle-value').textContent(), 'on')
    const uncontrolledToggle = page.getByTestId('render-toggle-uncontrolled')
    await assert.equal(await uncontrolledToggle.getAttribute('aria-pressed'), 'true')
    await uncontrolledToggle.click()
    await assert.equal(await uncontrolledToggle.getAttribute('aria-pressed'), 'false')
    await assert.equal(await page.getByTestId('render-toggle-uncontrolled-changes').textContent(), '1')
    const preventedToggle = page.getByTestId('render-toggle-prevented')
    await assert.equal(await preventedToggle.getAttribute('aria-pressed'), 'false')
    await preventedToggle.click()
    await assert.equal(await preventedToggle.getAttribute('aria-pressed'), 'false')
    await assert.equal(await page.getByTestId('render-toggle-uncontrolled-changes').textContent(), '1')
    const disabledToggle = page.getByTestId('render-toggle-disabled')
    await assert.equal(await disabledToggle.isDisabled(), true)
    await assert.equal(await disabledToggle.getAttribute('aria-pressed'), 'true')
    const disabledCallbackToggle = page.getByTestId('render-toggle-disabled-callback')
    await disabledCallbackToggle.click({ force: true })
    await assert.equal(await disabledCallbackToggle.getAttribute('aria-pressed'), 'false')
    await assert.equal(await page.getByTestId('render-toggle-disabled-changes').textContent(), '0')

    const toggleGroup = page.getByTestId('render-toggle-group')
    const listToggle = toggleGroup.getByRole('button', { name: '列表' })
    const gridToggle = toggleGroup.getByRole('button', { name: '网格' })
    const disabledToggleItem = toggleGroup.getByRole('button', { name: '禁用视图' })
    const chartToggle = toggleGroup.getByRole('button', { name: '图表' })
    await assert.equal(await toggleGroup.getAttribute('aria-orientation'), 'horizontal')
    await assert.equal(await listToggle.getAttribute('aria-pressed'), 'true')
    await assert.equal(await listToggle.getAttribute('tabindex'), '0')
    await assert.equal(await gridToggle.getAttribute('tabindex'), '-1')
    await assert.equal(await disabledToggleItem.isDisabled(), true)
    await gridToggle.click()
    await assert.equal(await page.getByTestId('render-toggle-group-value').textContent(), 'grid')
    await assert.equal(await gridToggle.getAttribute('aria-pressed'), 'true')
    await gridToggle.focus()
    await toggleGroup.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-toggle-group-value').textContent(), 'chart')
    await assert.equal(await chartToggle.evaluate((element) => document.activeElement === element), true)
    await toggleGroup.press('ArrowLeft')
    await assert.equal(await page.getByTestId('render-toggle-group-value').textContent(), 'grid')
    await assert.equal(await gridToggle.evaluate((element) => document.activeElement === element), true)

    const multipleToggleGroup = page.getByTestId('render-toggle-group-multiple')
    await assert.equal(await multipleToggleGroup.getByRole('button', { name: '标签' }).getAttribute('aria-pressed'), 'true')
    await multipleToggleGroup.getByRole('button', { name: '负责人' }).click()
    await assert.equal(await page.getByTestId('render-toggle-group-multiple-value').textContent(), 'tag,owner')
    await multipleToggleGroup.getByRole('button', { name: '标签' }).click()
    await assert.equal(await page.getByTestId('render-toggle-group-multiple-value').textContent(), 'owner')

    const segmentedControl = page.getByTestId('render-segmented-control')
    await assert.equal(await segmentedControl.getByRole('button', { name: '日' }).getAttribute('aria-pressed'), 'true')
    await segmentedControl.getByRole('button', { name: '日' }).click()
    await assert.equal(await page.getByTestId('render-segmented-control-value').textContent(), 'day')
    await assert.equal(await segmentedControl.getByRole('button', { name: '日' }).getAttribute('aria-pressed'), 'true')
    await segmentedControl.getByRole('button', { name: '周' }).click()
    await assert.equal(await page.getByTestId('render-segmented-control-value').textContent(), 'week')

    const defaultToggleGroup = page.getByTestId('render-toggle-group-default')
    const defaultAlpha = defaultToggleGroup.getByRole('button', { name: '甲视图' })
    const defaultBeta = defaultToggleGroup.getByRole('button', { name: '乙视图' })
    await assert.equal(await defaultAlpha.getAttribute('tabindex'), '0')
    await assert.equal(await defaultBeta.getAttribute('tabindex'), '-1')
    await defaultAlpha.click()
    await assert.equal(await page.getByTestId('render-toggle-group-default-value').textContent(), 'alpha')
    await defaultAlpha.click()
    await assert.equal(await page.getByTestId('render-toggle-group-default-value').textContent(), '')

    const invalidToggleGroup = page.getByTestId('render-toggle-group-invalid')
    const validToggle = invalidToggleGroup.getByRole('button', { name: '有效视图' })
    const otherToggle = invalidToggleGroup.getByRole('button', { name: '其他视图' })
    await assert.equal(await validToggle.getAttribute('tabindex'), '0')
    await assert.equal(await otherToggle.getAttribute('tabindex'), '-1')
    await validToggle.focus()
    await invalidToggleGroup.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-toggle-group-invalid-value').textContent(), 'other')
    await assert.equal(await otherToggle.evaluate((element) => document.activeElement === element), true)

    const allDisabledToggleGroup = page.getByTestId('render-toggle-group-all-disabled')
    await assert.equal(await allDisabledToggleGroup.getByRole('button', { name: '禁用甲' }).isDisabled(), true)
    await assert.equal(await allDisabledToggleGroup.getByRole('button', { name: '禁用乙' }).isDisabled(), true)
    await allDisabledToggleGroup.press('ArrowRight')
    await assert.equal(await page.getByTestId('render-toggle-group-all-disabled-value').textContent(), '')

    const verticalToggleGroup = page.getByTestId('render-toggle-group-vertical')
    const topToggle = verticalToggleGroup.getByRole('button', { name: '上方' })
    const middleToggle = verticalToggleGroup.getByRole('button', { name: '中间' })
    await assert.equal(await verticalToggleGroup.getAttribute('aria-orientation'), 'vertical')
    await topToggle.focus()
    await verticalToggleGroup.press('ArrowDown')
    await assert.equal(await page.getByTestId('render-toggle-group-vertical-value').textContent(), 'middle')
    await assert.equal(await middleToggle.evaluate((element) => document.activeElement === element), true)
    await verticalToggleGroup.press('ArrowUp')
    await assert.equal(await page.getByTestId('render-toggle-group-vertical-value').textContent(), 'top')
    await assert.equal(await topToggle.evaluate((element) => document.activeElement === element), true)

    const controlledToaster = page.getByTestId('render-toaster-controlled')
    await assert.equal(await controlledToaster.getAttribute('role'), 'region')
    await assert.equal(await controlledToaster.getAttribute('aria-live'), 'polite')
    await assert.equal(await controlledToaster.getByRole('status').getByText('已保存').textContent(), '已保存')
    await assert.equal(await controlledToaster.getByRole('button', { name: '撤销' }).textContent(), '撤销')
    await assert.equal(
      await page.getByTestId('render-toaster-position').evaluate((element) => window.getComputedStyle(element).top),
      '50px'
    )
    await assert.equal(
      await page.getByTestId('render-toaster-position').evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2) < 1
      }),
      true
    )
    await assert.equal(
      await page.getByTestId('render-toaster-position').evaluate((element) => {
        const styles = window.getComputedStyle(element)
        const rootStyles = window.getComputedStyle(document.documentElement)
        return Number(styles.zIndex) > Number(rootStyles.getPropertyValue('--vds-z-modal').trim())
      }),
      true
    )
    const errorToast = controlledToaster.getByRole('alert')
    await assert.equal(await errorToast.getByText('同步失败').textContent(), '同步失败')
    await assert.equal(await errorToast.evaluate((element) => window.getComputedStyle(element).alignItems), 'flex-start')
    await controlledToaster.getByRole('button', { name: '关闭通知' }).first().click()
    await assert.equal(await page.getByTestId('render-toaster-controlled-count').textContent(), '1')

    const autoToaster = page.getByTestId('render-toaster-auto')
    await page.getByTestId('render-toast-auto-add').click()
    await assert.equal(await autoToaster.getByText('自动关闭').count(), 1)
    await page.waitForFunction(() => document.querySelector('[data-testid="render-toaster-auto-count"]')?.textContent === '0')
    await assert.equal(await autoToaster.getByText('自动关闭').count(), 0)

    await page.getByTestId('render-toast-add').click()
    const queueToaster = page.getByTestId('render-toaster-queue')
    await assert.equal(await queueToaster.getByRole('status').getByText('队列通知').textContent(), '队列通知')
    await assert.equal(await queueToaster.getByRole('button', { name: '查看' }).textContent(), '查看')
    await queueToaster.getByRole('button', { name: '关闭队列通知' }).click()
    await assert.equal(await queueToaster.getByText('队列通知').count(), 0)

    const nestedProviderToaster = page.getByTestId('render-toaster-nested-provider')
    const nestedControlledToaster = page.getByTestId('render-toaster-nested-controlled')
    await assert.equal(await nestedProviderToaster.getByText('Provider 同 id').count(), 1)
    await assert.equal(await nestedControlledToaster.getByText('受控同 id').count(), 1)
    await nestedControlledToaster.getByRole('button', { name: '关闭通知' }).click()
    await assert.equal(await page.getByTestId('render-toaster-nested-controlled-count').textContent(), '0')
    await assert.equal(await nestedControlledToaster.getByText('受控同 id').count(), 0)
    await assert.equal(await nestedProviderToaster.getByText('Provider 同 id').count(), 1)

    const readonlyToaster = page.getByTestId('render-toaster-controlled-readonly')
    await assert.equal(await readonlyToaster.getByText('只读通知').count(), 1)
    await assert.equal(await readonlyToaster.getByRole('button', { name: '关闭通知' }).count(), 0)
    await page.waitForTimeout(80)
    await assert.equal(await readonlyToaster.getByText('只读通知').count(), 1)

    await assert.equal(await page.getByTestId('render-sheet-content').count(), 0)
    await page.getByTestId('render-sheet-open').click()
    const sheet = page.getByTestId('render-sheet-content')
    const sheetOverlay = page.getByTestId('render-sheet-overlay')
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'open')
    await assert.equal(await sheet.getAttribute('role'), 'dialog')
    await assert.equal(await sheet.getAttribute('aria-modal'), null)
    await assert.equal(await sheet.getAttribute('data-side'), 'right')
    await assert.equal((await sheet.getAttribute('class'))?.includes('vds-sheet--right'), true)
    const sheetTitleId = await sheet.getAttribute('aria-labelledby')
    const sheetDescriptionId = await sheet.getAttribute('aria-describedby')
    assert.ok(sheetTitleId, 'Sheet title should be linked by aria-labelledby')
    assert.ok(sheetDescriptionId, 'Sheet description should be linked by aria-describedby')
    await assert.equal(await page.locator(`[id="${sheetTitleId}"]`).textContent(), '项目详情')
    await assert.equal(await page.locator(`[id="${sheetDescriptionId}"]`).textContent(), '展示右侧详情 UI 壳层。')
    await sheet.focus()
    await assert.equal(await sheet.evaluate((element) => document.activeElement === element), true)
    await page.keyboard.press('Escape')
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-sheet-open-changes').textContent(), '1')
    await assert.equal(await sheet.count(), 0)

    await page.getByTestId('render-sheet-modal-open').click()
    const modalSheet = page.getByTestId('render-sheet-modal-content')
    await assert.equal(await modalSheet.getAttribute('aria-modal'), 'true')
    await assert.equal(await modalSheet.getAttribute('data-side'), 'left')
    await page.getByTestId('render-sheet-modal-close').click()
    await assert.equal(await modalSheet.count(), 0)

    await page.getByTestId('render-sheet-open').click()
    await page.getByTestId('render-sheet-overlay').click()
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'closed')
    await assert.equal(await sheetOverlay.count(), 0)

    await page.getByTestId('render-sheet-open').click()
    await page.getByTestId('render-sheet-close').click()
    await assert.equal(await page.getByTestId('render-sheet-open-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-sheet-close-count').textContent(), '1')

    await assert.equal(await page.getByTestId('render-drawer-content').count(), 0)
    await page.getByTestId('render-drawer-open').click()
    const drawer = page.getByTestId('render-drawer-content')
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'open')
    await assert.equal(await drawer.getAttribute('role'), 'dialog')
    await assert.equal(await drawer.getAttribute('aria-modal'), null)
    await assert.equal(await drawer.getAttribute('data-side'), 'bottom')
    await assert.equal((await drawer.getAttribute('class'))?.includes('vds-drawer--bottom'), true)
    const drawerTitleId = await drawer.getAttribute('aria-labelledby')
    const drawerDescriptionId = await drawer.getAttribute('aria-describedby')
    assert.ok(drawerTitleId, 'Drawer title should be linked by aria-labelledby')
    assert.ok(drawerDescriptionId, 'Drawer description should be linked by aria-describedby')
    await assert.equal(await page.locator(`[id="${drawerTitleId}"]`).textContent(), '移动抽屉')
    await assert.equal(await page.locator(`[id="${drawerDescriptionId}"]`).textContent(), '底部抽屉 UI 壳层。')
    await page.keyboard.press('Escape')
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'closed')

    await page.getByTestId('render-drawer-open').click()
    await page.getByTestId('render-drawer-overlay').click()
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'closed')

    await page.getByTestId('render-drawer-open').click()
    await page.getByTestId('render-drawer-close').click()
    await assert.equal(await page.getByTestId('render-drawer-open-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-drawer-close-count').textContent(), '1')

    const tooltip = page.getByTestId('render-tooltip')
    const tooltipTrigger = tooltip.getByRole('button', { name: '保存配置' })
    await assert.equal(await tooltip.getByRole('tooltip').count(), 0)
    await tooltipTrigger.hover()
    const tooltipContent = tooltip.getByRole('tooltip')
    await assert.equal(await tooltipContent.textContent(), '保存当前配置')
    await assert.equal(await tooltipContent.getAttribute('data-i18n-text'), 'examples:tooltip.content')
    await assert.equal(await tooltipContent.getAttribute('data-side'), 'top')
    await assert.equal((await tooltipContent.getAttribute('class'))?.includes('vds-tooltip--top'), true)
    const tooltipContentId = await tooltipContent.getAttribute('id')
    assert.ok(tooltipContentId, 'Tooltip content should receive a stable id')
    await assert.equal(await tooltipTrigger.getAttribute('aria-describedby'), tooltipContentId)
    await page.mouse.move(0, 0)
    await assert.equal(await tooltip.getByRole('tooltip').count(), 0)
    await assert.equal(await tooltipTrigger.getAttribute('aria-describedby'), null)

    const focusTooltip = page.getByTestId('render-tooltip-focus')
    const focusTooltipTrigger = focusTooltip.getByRole('button', { name: '聚焦说明' })
    await focusTooltipTrigger.focus()
    await assert.equal(await focusTooltip.getByRole('tooltip').textContent(), '聚焦时显示提示')
    await assert.equal(await focusTooltip.getByRole('tooltip').getAttribute('data-side'), 'right')
    await focusTooltipTrigger.blur()
    await assert.equal(await focusTooltip.getByRole('tooltip').count(), 0)

    const controlledTooltip = page.getByTestId('render-tooltip-controlled')
    const controlledTooltipTrigger = controlledTooltip.getByRole('button', { name: '受控说明' })
    await assert.equal(await page.getByTestId('render-tooltip-controlled-value').textContent(), 'closed')
    await controlledTooltipTrigger.hover()
    await assert.equal(await page.getByTestId('render-tooltip-controlled-value').textContent(), 'open')
    await assert.equal(await page.getByTestId('render-tooltip-controlled-changes').textContent(), '1')
    await controlledTooltipTrigger.focus()
    await assert.equal(await page.getByTestId('render-tooltip-controlled-changes').textContent(), '1')
    await assert.equal(await controlledTooltip.getByRole('tooltip').textContent(), '受控提示内容')
    await page.mouse.move(0, 0)
    await assert.equal(await page.getByTestId('render-tooltip-controlled-value').textContent(), 'closed')
    await assert.equal(await page.getByTestId('render-tooltip-controlled-changes').textContent(), '2')
    await controlledTooltipTrigger.blur()
    await assert.equal(await page.getByTestId('render-tooltip-controlled-changes').textContent(), '2')
    await assert.equal(await controlledTooltip.getByRole('tooltip').count(), 0)

    const customIdTooltip = page.getByTestId('render-tooltip-custom-id')
    const customIdTrigger = customIdTooltip.getByRole('button', { name: '自定义 ID 说明' })
    await assert.equal(await customIdTrigger.getAttribute('aria-describedby'), 'tooltip-existing-help')
    await customIdTrigger.hover()
    const customIdContent = customIdTooltip.getByRole('tooltip')
    await assert.equal(await customIdContent.getAttribute('id'), 'tooltip-custom-content')
    await assert.equal(await customIdTrigger.getAttribute('aria-describedby'), 'tooltip-existing-help tooltip-custom-content')
    await page.mouse.move(0, 0)
    await assert.equal(await customIdTooltip.getByRole('tooltip').count(), 0)
    await assert.equal(await customIdTrigger.getAttribute('aria-describedby'), 'tooltip-existing-help')

    const wrapperDescriptionTooltip = page.getByTestId('render-tooltip-trigger-wrapper-description')
    const wrapperDescriptionTrigger = wrapperDescriptionTooltip.getByRole('button', { name: '外层描述说明' })
    await assert.equal(await wrapperDescriptionTrigger.getAttribute('aria-describedby'), 'tooltip-trigger-wrapper-help')
    await wrapperDescriptionTrigger.hover()
    const wrapperDescriptionContentId = await wrapperDescriptionTooltip.getByRole('tooltip').getAttribute('id')
    assert.ok(wrapperDescriptionContentId, 'Tooltip content should receive an id')
    await assert.equal(
      await wrapperDescriptionTrigger.getAttribute('aria-describedby'),
      `tooltip-trigger-wrapper-help ${wrapperDescriptionContentId}`
    )
    await page.mouse.move(0, 0)
    await assert.equal(await wrapperDescriptionTooltip.getByRole('tooltip').count(), 0)
    await assert.equal(await wrapperDescriptionTrigger.getAttribute('aria-describedby'), 'tooltip-trigger-wrapper-help')

    const defaultOpenTooltip = page.getByTestId('render-tooltip-default-open')
    await assert.equal(await defaultOpenTooltip.getByRole('tooltip').textContent(), '默认提示内容')
    await assert.equal(await defaultOpenTooltip.getByRole('tooltip').getAttribute('data-side'), 'left')

    const defaultOpenCustomIdTooltip = page.getByTestId('render-tooltip-default-open-custom-id')
    const defaultOpenCustomIdTrigger = defaultOpenCustomIdTooltip.getByRole('button', { name: '默认自定义 ID' })
    await assert.equal(
      await defaultOpenCustomIdTooltip.getByRole('tooltip').getAttribute('id'),
      'tooltip-default-open-custom-content'
    )
    await assert.equal(
      await defaultOpenCustomIdTrigger.getAttribute('aria-describedby'),
      'tooltip-default-open-custom-content'
    )

    const uncontrolledEventsTooltip = page.getByTestId('render-tooltip-uncontrolled-events')
    const uncontrolledEventsTrigger = uncontrolledEventsTooltip.getByRole('button', { name: '非受控事件说明' })
    await uncontrolledEventsTrigger.hover()
    await uncontrolledEventsTrigger.focus()
    await assert.equal(await page.getByTestId('render-tooltip-uncontrolled-changes').textContent(), '1')
    await page.mouse.move(0, 0)
    await uncontrolledEventsTrigger.blur()
    await assert.equal(await page.getByTestId('render-tooltip-uncontrolled-changes').textContent(), '2')

    const disabledTooltip = page.getByTestId('render-tooltip-disabled')
    const disabledTooltipTrigger = disabledTooltip.getByRole('button', { name: '禁用说明' })
    await disabledTooltipTrigger.hover()
    await assert.equal(await disabledTooltip.getByRole('tooltip').count(), 0)
    await assert.equal(await disabledTooltipTrigger.getAttribute('aria-describedby'), null)
  })
})

test('floating toolbar renders an opaque accessible action surface', async () => {
  await withFixture(async (page) => {
    const floatingToolbar = page.getByTestId('render-floating-toolbar')
    await assert.equal(await floatingToolbar.getByRole('toolbar', { name: '选区操作' }).count(), 1)
    const background = await floatingToolbar.evaluate(
      (element) => window.getComputedStyle(element).backgroundColor
    )
    await assert.match(background, /^rgb\(/)
    await assert.notEqual(background, 'rgba(0, 0, 0, 0)')
  })
})


test('modal dialog contains keyboard focus, dismisses only the nested layer and restores focus', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('render-dialog-open')
    const outer = page.getByTestId('render-dialog-content')
    await trigger.click()
    assert.equal(await outer.evaluate(el => el.contains(document.activeElement)), true)
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      assert.equal(await outer.evaluate(el => el.contains(document.activeElement)), true)
    }
    await page.getByTestId('nested-dialog-open').click()
    const inner = page.getByTestId('nested-dialog-content')
    assert.equal(await inner.evaluate(el => el.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await inner.waitFor({ state: 'hidden' })
    assert.equal(await outer.isVisible(), true)
    assert.equal(await page.getByTestId('nested-dialog-open').evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Escape')
    await outer.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
  })
})


test('nonmodal dialog permits Tab to leave and ignores implicit dismissal without a blocking backdrop', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('nonmodal-dialog-open').click()
    const content = page.getByTestId('nonmodal-dialog-content')
    assert.equal(await content.getAttribute('aria-modal'), null)
    await page.getByTestId('nonmodal-dialog-action').focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.getByTestId('nonmodal-after').evaluate(el => el === document.activeElement), true)
    await page.getByTestId('nonmodal-after').click()
    assert.equal(await content.isVisible(), true)
    await page.keyboard.press('Escape')
    assert.equal(await content.isVisible(), true)
    assert.equal(await page.locator('.vds-dialog-overlay').count(), 0)
  })
})


test('popover focuses content after positioning, restores on Escape and permits focus outside', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByTestId('focus-popover-trigger')
    const content = page.getByTestId('focus-popover-content')
    const checkbox = page.getByTestId('focus-popover-checkbox')
    const outside = page.getByTestId('focus-popover-outside')
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'focus-popover-checkbox')
    await page.keyboard.press('Space')
    assert.equal(await checkbox.isChecked(), true)
    await page.keyboard.press('Escape')
    await content.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'focus-popover-checkbox')
    await page.getByTestId('focus-popover-last').focus()
    await page.keyboard.press('Tab')
    assert.equal(await content.evaluate(el => el.contains(document.activeElement)), false)
    await outside.click()
    await content.waitFor({ state: 'hidden' })
    assert.equal(await outside.evaluate(el => el === document.activeElement), true)
  })
})

test('tall floating content stays inside the viewport and exposes its trailing action', async () => {
  await withFixture(async (page) => {
    await page.getByTestId('viewport-hover-card-trigger').hover()
    const content = page.getByTestId('viewport-hover-card-content')
    await content.waitFor({ state: 'visible' })
    await page.waitForTimeout(250)

    const bounds = await content.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        top: rect.top,
        viewportHeight: window.innerHeight
      }
    })
    assert.ok(bounds.top >= 8, JSON.stringify(bounds))
    assert.ok(bounds.bottom <= bounds.viewportHeight - 8, JSON.stringify(bounds))
    assert.ok(bounds.scrollHeight > bounds.clientHeight, JSON.stringify(bounds))

    await content.evaluate(element => element.scrollTo({ top: element.scrollHeight }))
    const action = page.getByTestId('viewport-hover-card-action')
    await assert.equal(await action.isVisible(), true)
    await assert.ok(await action.evaluate(element => {
      const actionRect = element.getBoundingClientRect()
      const contentRect = element.closest('[data-testid="viewport-hover-card-content"]')!.getBoundingClientRect()
      return actionRect.bottom <= contentRect.bottom
    }))
  })
})


test('menu keyboard skips disabled items, wraps and dismisses only the focused submenu', async () => {
  await withFixture(async page => {
    const trigger = page.getByTestId('focus-menu-trigger')
    const menu = page.getByTestId('focus-menu')
    const first = page.getByTestId('focus-menu-first')
    const last = page.getByTestId('focus-menu-last')
    const subtrigger = page.getByTestId('focus-menu-subtrigger')
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'focus-menu-first')
    await page.keyboard.press('ArrowDown')
    assert.equal(await subtrigger.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('End')
    assert.equal(await last.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('ArrowDown')
    assert.equal(await first.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('ArrowUp')
    assert.equal(await last.evaluate(el => el === document.activeElement), true)
    await subtrigger.click()
    const sub = page.getByTestId('focus-menu-sub')
    await sub.getByRole('menuitem').waitFor({ state: 'visible' })
    assert.equal(await sub.evaluate(el => el.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await sub.waitFor({ state: 'hidden' })
    assert.equal(await menu.isVisible(), true)
    assert.equal(await subtrigger.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
  })
})


test('icon buttons keep square geometry without text-button padding and loading replaces the icon', async () => {
  await withFixture(async page => {
    for (const [size, edge, iconEdge] of [['sm', 28, 14], ['md', 32, 16], ['lg', 40, 16]] as const) {
      const button = page.getByTestId(`square-icon-${size}`)
      const geometry = await button.evaluate(el => {
        const bounds = el.getBoundingClientRect()
        const icon = el.querySelector('.vds-icon-button__content')!.getBoundingClientRect()
        return {
          width: bounds.width, height: bounds.height, iconWidth: icon.width, iconHeight: icon.height,
          offsetX: Math.abs((icon.left + icon.right) / 2 - (bounds.left + bounds.right) / 2),
          offsetY: Math.abs((icon.top + icon.bottom) / 2 - (bounds.top + bounds.bottom) / 2)
        }
      })
      assert.equal(geometry.width, edge)
      assert.equal(geometry.height, edge)
      assert.equal(geometry.iconWidth, iconEdge)
      assert.equal(geometry.iconHeight, iconEdge)
      assert.ok(geometry.offsetX < 1 && geometry.offsetY < 1)
    }
    const loading = page.getByTestId('square-icon-loading')
    assert.equal(await loading.isDisabled(), true)
    assert.equal(await loading.locator('.vds-icon-button__content').count(), 0)
    assert.equal(await loading.getByRole('status').count(), 1)
  })
})


test('disabled tooltip forgets previous hover before being enabled again', async () => {
  await withFixture(async (page) => {
    const trigger = page.getByRole('button', { name: '点击禁用提示', exact: true })
    const content = page.getByRole('tooltip').filter({ hasText: '动态禁用提示' })
    await trigger.hover()
    await content.waitFor({ state: 'visible' })
    await trigger.click()
    await content.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '重新启用提示', exact: true }).click()
    assert.equal(await content.count(), 0)
    await trigger.hover()
    await content.waitFor({ state: 'visible' })
  })
})

test('visible tooltip dismisses on Escape without moving focused trigger', async () => {
  await withFixture(async page => {
    const root = page.getByTestId('render-tooltip')
    const trigger = root.getByRole('button')
    await trigger.focus()
    await root.getByRole('tooltip').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await root.getByRole('tooltip').waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
    assert.equal(await trigger.getAttribute('aria-describedby'), null)
    await page.mouse.move(0, 0)
    await trigger.hover()
    await root.getByRole('tooltip').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await root.getByRole('tooltip').waitFor({ state: 'hidden' })
  })
})


test('composed select opens from keyboard, skips disabled options, selects and restores focus', async () => {
  await withFixture(async page => {
    const trigger = page.getByTestId('keyboard-select')
    const list = page.getByTestId('keyboard-options')
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await list.waitFor({ state: 'visible' })
    assert.equal(await list.getByRole('option', { name: '第一项', exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('ArrowDown')
    assert.equal(await list.getByRole('option', { name: '最后项', exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Enter')
    await list.waitFor({ state: 'hidden' })
    assert.match(await trigger.innerText(), /最后项/)
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
    await trigger.click()
    assert.equal(await list.getByRole('option', { name: '最后项', exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Home')
    await page.keyboard.press('Escape')
    await list.waitFor({ state: 'hidden' })
    assert.match(await trigger.innerText(), /最后项/)
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
  })
})
