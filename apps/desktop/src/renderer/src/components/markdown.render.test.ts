import assert from 'node:assert/strict'
import net from 'node:net'
import test, { after } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser, type Locator } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../test-helpers/render.ts'

const FIXTURE_URL = '/components/markdown.render.fixture.html'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const servers = renderServers({ after })

async function contentText(locator: Locator): Promise<string | null> {
  return locator.evaluate((element) => {
    const content = element.cloneNode(true) as HTMLElement
    content.querySelectorAll('button, [role="tooltip"]').forEach((control) => control.remove())
    return content.textContent
  })
}

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
      server.close(() => resolve(address.port))
    })
  })
}

test('formula selection copy removes layout breaks without expanding the selection', async () => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ permissions: ['clipboard-read', 'clipboard-write'] })
    await page.goto(new URL(FIXTURE_URL, server.resolvedUrls!.local[0]).toString())
    const sample = page.getByTestId('formula-selection-copy')
    const formula = sample.locator('.katex-html').first()
    const copy = async (): Promise<string> => {
      await page.keyboard.press('ControlOrMeta+c')
      return page.evaluate(() => navigator.clipboard.readText())
    }
    const selectContents = (locator: Locator): Promise<string> =>
      locator.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return selection.toString()
      })
    await formula.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let start: Node | undefined
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!start && node.textContent === 'ρ') start = node
        if (start && node.textContent === 'R') {
          window.getSelection()!.setBaseAndExtent(start, 0, node, 1)
          return
        }
      }
      throw new Error('NDVI subscript not found')
    })
    assert.equal(await copy(), 'ρNIR')
    await selectContents(formula)
    const full = await copy()
    assert.match(full, /^NDVI=/)
    assert.match(full, /ρNIR/)
    assert.doesNotMatch(full, /[\r\n]/)
    await sample.evaluate((element) => {
      const [before, after] = element.querySelectorAll('p')
      const end = after.firstChild!
      window.getSelection()!.setBaseAndExtent(before.firstChild!, 0, end, end.textContent!.length)
    })
    assert.match(await copy(), /^Before the formula\n[\s\S]*\nAfter the formula$/)
    const nativeMultiline = await selectContents(sample.locator('.katex-html').last())
    assert.match(nativeMultiline, /\n/)
    assert.equal(await copy(), nativeMultiline)
  } finally {
    await browser.close()
    await server.close()
  }
})

test('answer remote images load inline automatically and open the existing Gallery', async (context) => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown-remote',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => context.diagnostic(`page error: ${error.message}`))
    await page.goto(new URL(FIXTURE_URL, server.resolvedUrls!.local[0]).href)
    await expect(page.getByTestId('remote-answer-image')).toBeVisible({ timeout: 30_000 })
    const image = page
      .getByTestId('remote-answer-image')
      .getByRole('img', { name: 'Remote figure' })
    await expect(image).toBeVisible()
    assert.ok(await image.evaluate((element: HTMLImageElement) => element.naturalWidth > 0))
    assert.match((await image.getAttribute('src'))!, /^blob:/)
    await image.click()
    await expect(page.getByTestId('image-preview')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('image-preview')).toHaveCount(0)
    await expect(
      page
        .getByTestId('remote-answer-image')
        .getByRole('button', { name: '预览图片：Remote figure', exact: true })
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('image-preview')).toBeVisible()
    await page.keyboard.press('Escape')
    const initial = (await image.getAttribute('src'))!
    await page.getByRole('button', { name: 'Slow remote', exact: true }).click()
    await expect(page.getByTestId('remote-answer-image').getByRole('img')).toHaveCount(0)
    await page.getByRole('button', { name: 'Replace remote', exact: true }).click()
    await expect(image).toBeVisible()
    const replacement = await image.getAttribute('src')
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.remoteCompleted))
      .toBe('https://example.com/slow')
    assert.equal(await image.getAttribute('src'), replacement)
    await page.getByRole('button', { name: 'Invalid remote', exact: true }).click()
    await expect(
      page.getByTestId('remote-answer-image').getByTestId('answer-image-fallback')
    ).toContainText('图片无法加载')
    await page.getByRole('button', { name: 'Replace remote', exact: true }).click()
    await expect(image).toBeVisible()
    assert.equal(
      await page.evaluate(
        async (url) =>
          fetch(url).then(
            () => true,
            () => false
          ),
        initial
      ),
      false
    )
    await page.getByRole('button', { name: 'Failed remote', exact: true }).click()
    await expect(
      page.getByTestId('remote-answer-image').getByTestId('answer-image-fallback')
    ).toContainText('图片无法加载')
    const beforeRetry = await page.evaluate(() => Number(document.body.dataset.remoteReads))
    await page
      .getByTestId('remote-answer-image')
      .getByRole('button', { name: '重试', exact: true })
      .click()
    await expect
      .poll(() => page.evaluate(() => Number(document.body.dataset.remoteReads)))
      .toBe(beforeRetry + 1)
    await page.getByRole('button', { name: 'Unsafe remote', exact: true }).click()
    await expect(
      page.getByTestId('remote-answer-image').getByTestId('answer-image-fallback')
    ).toContainText('此图片无法直接预览')
    assert.equal(
      await page.evaluate(() => Number(document.body.dataset.remoteReads)),
      beforeRetry + 1
    )
    await page.getByRole('button', { name: 'Replace remote', exact: true }).click()
    await expect(image).toBeVisible()
    const activeUrl = (await image.getAttribute('src'))!
    await page.getByRole('button', { name: 'Remove remote', exact: true }).click()
    assert.equal(
      await page.evaluate(
        async (url) =>
          fetch(url).then(
            () => true,
            () => false
          ),
        activeUrl
      ),
      false
    )
    const local = page.getByTestId('fallback-image')
    await local.getByRole('button', { name: '打开原文件', exact: true }).click()
    assert.equal(
      await page.evaluate(() => document.body.dataset.openedFallbackImage),
      'outputs/missing-figure.png'
    )
    await local.getByRole('button', { name: '更新图片来源', exact: true }).click()
    await expect(local.getByRole('img', { name: '研究图', exact: true })).toBeVisible()
    assert.ok(
      await local.getByRole('img').evaluate((element: HTMLImageElement) => element.naturalWidth > 0)
    )
    await expect(
      page.getByTestId('localized-markdown').getByTestId('answer-image-fallback')
    ).toBeVisible()
  } finally {
    await browser.close()
    await server.close()
  }
})

test('standalone formula lines reuse the centered, horizontally scrollable formula card', async (context) => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => context.diagnostic(`page error: ${error.message}`))
    await page.goto(new URL(FIXTURE_URL, server.resolvedUrls!.local[0]).toString())
    const container = page.getByTestId('standalone-formula-layout')
    const formulas = container.getByTestId('conversation-formula')
    await expect(formulas).toHaveCount(2, { timeout: 30_000 })
    const short = formulas.first().getByTestId('formula-render')
    const shortBounds = await short.boundingBox()
    const glyphBounds = await short.locator('.katex-base').boundingBox()
    assert.ok(shortBounds && glyphBounds)
    assert.ok(
      Math.abs(shortBounds.x + shortBounds.width / 2 - glyphBounds.x - glyphBounds.width / 2) < 2
    )
    const long = formulas.last().getByTestId('formula-render')
    await expect(long.locator('math mtable mtr')).toHaveCount(2)
    const overflow = await long.evaluate((node) => node.scrollWidth - node.clientWidth)
    assert.ok(overflow > 0)
    await formulas.last().getByRole('scrollbar').press('End')
    await expect.poll(() => long.evaluate((node) => node.scrollLeft)).toBe(overflow)
  } finally {
    await browser.close()
  }
})

test('Conversation card headers share compact typography and hover or focus actions', async () => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(new URL(FIXTURE_URL, server.resolvedUrls!.local[0]).toString())
    const cards = page.getByTestId('card-headers')
    for (const kind of ['formula', 'code', 'diagram', 'plot']) {
      const card = cards.getByTestId(`conversation-${kind}`)
      const header =
        kind === 'plot'
          ? card.getByTestId('plot-header')
          : kind === 'code'
            ? card.locator(':scope > div').first()
            : card.getByTestId(`${kind}-toolbar`)
      const actions = header.locator(':scope > :last-child')
      await expect(header).toHaveCSS('font-size', '12px')
      await expect(header).toHaveCSS('height', '40px')
      await page.mouse.move(0, 0)
      await expect(actions).toHaveCSS('opacity', '0')
      await expect(actions).toHaveCSS('pointer-events', 'none')
      await card.hover()
      await expect(actions).toHaveCSS('opacity', '1')
      if (kind !== 'code') {
        const tablist = header.getByRole('tablist')
        await expect(tablist).toHaveCSS('height', '28px')
        await expect(tablist).toHaveCSS('padding-left', '3px')
        await expect(tablist).toHaveCSS('padding-right', '3px')
        for (const trigger of await tablist.getByRole('tab').all()) {
          await trigger.click()
          await expect(trigger).toHaveAttribute('aria-selected', 'true')
          await expect
            .poll(async () =>
              tablist.evaluate((element) => {
                const listBounds = element.getBoundingClientRect()
                const indicatorBounds = element
                  .querySelector('.vds-tabs__indicator')!
                  .getBoundingClientRect()
                return Math.min(
                  indicatorBounds.left - listBounds.left,
                  listBounds.right - indicatorBounds.right
                )
              })
            )
            .toBeCloseTo(3)
        }
      }
      for (const trigger of await header.getByRole('tab').all()) {
        await expect(trigger).toHaveCSS('height', '28px')
        await expect(trigger).toHaveCSS('font-size', '12px')
        await expect(trigger).toHaveCSS(
          'font-weight',
          (await trigger.getAttribute('aria-selected')) === 'true' ? '500' : '400'
        )
      }
      await header.getByRole('button', { name: '复制', exact: true }).focus()
      await page.mouse.move(0, 0)
      await expect(actions).toHaveCSS('opacity', '1')
      await header.getByRole('button', { name: '复制', exact: true }).blur()
      await expect(actions).toHaveCSS('opacity', '0')
    }
    const code = cards.getByTestId('conversation-code')
    const disclosure = code.locator('button[aria-expanded]')
    await expect(disclosure).toHaveText('展开全部 23 行')
    await expect(disclosure).toHaveCSS('font-size', '12px')
    await expect(disclosure).toHaveCSS('color', 'rgb(109, 109, 109)')
    const title = code.locator(':scope > div').first().locator(':scope > span').first()
    const textLeft = await disclosure.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect().left
    })
    assert.equal(textLeft, (await title.boundingBox())!.x)
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(disclosure).toHaveText('收起代码')
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    const plot = cards.getByTestId('conversation-plot')
    await plot.hover()
    const dataTab = plot.getByRole('tab', { name: '查看原始数据', exact: true })
    const figureTab = plot.getByRole('tab', { name: '查看图形', exact: true })
    await dataTab.click()
    await expect(dataTab).toHaveCSS('font-weight', '500')
    await expect(figureTab).toHaveCSS('font-weight', '400')
    await expect(dataTab).toHaveAttribute('aria-selected', 'true')
    await figureTab.click()
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    for (const toolbar of await cards
      .locator('[data-testid$="toolbar"], [data-testid="plot-header"]')
      .all()) {
      await expect(toolbar).toHaveCSS('font-size', '12px')
      await expect(toolbar).toHaveCSS('height', '40px')
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test('Tabulation uses the design typography, spacing and dividers', async (context) => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  context.diagnostic(`optimizer cache: ${server.config.cacheDir}`)
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    await page.goto(new URL(FIXTURE_URL, url).toString())
    const copyExample = page.getByTestId('tabulation-copy')
    const copyButton = copyExample.getByRole('button', { name: '复制', exact: true })
    await expect(copyExample.getByText('Table content')).toBeVisible()
    await expect(copyExample.getByText('Table caption', { exact: true })).toHaveCount(0)
    await expect(copyButton).toHaveClass(/vds-button--icon/)
    const copyControl = copyExample.getByTestId('table-copy-control')
    await expect(copyControl).toHaveCSS('position', 'absolute')
    await expect(copyControl).toHaveCSS('right', '8px')
    await expect(copyControl).toHaveCSS('bottom', '8px')
    await expect(copyControl).toHaveCSS('opacity', '0')
    await copyExample.getByTestId('conversation-table').hover()
    await expect(copyControl).toHaveCSS('opacity', '1')
    await copyButton.click()
    await expect(copyExample.locator('output')).toHaveText('Original table')
    await expect(copyExample.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    const table = page.getByTestId('native-table-citation')
    const appearance = await table
      .locator('thead th')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          padding: style.padding,
          borderRightWidth: style.borderRightWidth,
          borderBottomWidth: style.borderBottomWidth,
          dividerWidth: style.getPropertyValue('--vds-conversation-table-divider-width').trim(),
        }
      })
    assert.deepEqual(appearance, {
      fontSize: '14px',
      fontWeight: '500',
      lineHeight: '22px',
      padding: '8px 12px',
      borderRightWidth: '1px',
      borderBottomWidth: '1px',
      dividerWidth: '0.5px',
    })
    for (const header of await table.locator('thead th').all()) {
      await expect(header).toHaveCSS('font-weight', '500')
    }
    for (const cell of await table.locator('tbody td').all()) {
      await expect(cell).toHaveCSS('font-weight', '400')
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('citation hover preserves previews while clicks navigate directly and missing files retain excerpts', async () => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'citation-navigation',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    const urls: string[] = []
    await page.exposeFunction('recordOpenedSource', (url: string) => urls.push(url))
    await page.goto(new URL(FIXTURE_URL, server.resolvedUrls!.local![0]).toString())
    const papers = page.getByTestId('literature-citation').getByRole('button')
    const paper = papers.first()
    await expect(paper).toContainText('Alexandria Example-With-A-Very-Long-Name')
    await expect(paper).toContainText('2024')
    await expect(paper.getByText('+1', { exact: true })).toBeVisible()
    await expect(paper).toHaveCSS('max-width', 'min(100%, 160px)')
    await expect(papers.nth(1)).toContainText('Paper 2')
    await expect(papers.nth(1)).toContainText('2025')
    await expect(papers.nth(2)).toContainText('Paper 3')
    await paper.hover()
    const paperPreview = page.getByRole('region', { name: '引用预览', exact: true })
    await expect(paperPreview).toContainText('等 · 2024')
    await page.mouse.move(0, 0)
    await expect(paperPreview).toBeHidden()
    await page.getByTestId('grouped-file-citation').getByRole('button').hover()
    const groupedPreview = page.getByRole('region', { name: '引用预览', exact: true })
    await expect(groupedPreview).toContainText('Source 1.pdf')
    await page.waitForTimeout(350)
    const geometry = await groupedPreview.evaluate((element) => {
      const style = getComputedStyle(element)
      const title = element.querySelector('button[title="Source 1.pdf"]')!
      const excerpt = element.querySelector('[data-citation-excerpt]')!
      const navigation = element.firstElementChild!
      const count = navigation.lastElementChild!
      return {
        width: element.getBoundingClientRect().width,
        radius: style.borderRadius,
        padding: style.padding,
        border: style.borderTopWidth,
        titleFont: getComputedStyle(title).fontSize,
        titleWeight: getComputedStyle(title).fontWeight,
        titleTop: Math.round(
          title.getBoundingClientRect().top - element.getBoundingClientRect().top
        ),
        titleColor: getComputedStyle(title).color,
        excerptFont: getComputedStyle(excerpt).fontSize,
        excerptColor: getComputedStyle(excerpt).color,
        excerptLine: getComputedStyle(excerpt).lineHeight,
        countFont: getComputedStyle(count).fontSize,
        countLine: getComputedStyle(count).lineHeight,
        countColor: getComputedStyle(count).color,
      }
    })
    assert.deepEqual(geometry, {
      width: 340,
      radius: '12px',
      padding: '12px',
      border: '0px',
      titleFont: '14px',
      titleWeight: '500',
      titleTop: 47,
      titleColor: 'rgb(39, 39, 39)',
      excerptFont: '12px',
      excerptColor: 'rgb(76, 76, 76)',
      excerptLine: '18px',
      countFont: '12px',
      countLine: '18px',
      countColor: 'rgb(146, 146, 146)',
    })
    await expect(groupedPreview.locator('[data-citation-excerpt]')).toHaveCount(3)
    const excerptBlocks = groupedPreview.locator('blockquote')
    await expect(excerptBlocks).toHaveText([
      /第\s*1\s*页\s*First cited excerpt\./,
      /第\s*2\s*页\s*Second cited excerpt\./,
      'Third cited excerpt.',
    ])
    for (const excerptBlock of await excerptBlocks.filter({ hasText: /第\s*\d+\s*页/ }).all()) {
      await expect(excerptBlock).toHaveCSS('border-left-width', '0px')
      await expect(excerptBlock.locator('[data-citation-excerpt]')).toHaveCSS(
        'border-left-width',
        '2px'
      )
    }
    const groupedTitle = groupedPreview.getByRole('button', { name: 'Source 1.pdf', exact: true })
    await groupedTitle.hover()
    await expect(groupedTitle).toHaveCSS('color', 'rgb(35, 68, 56)')
    for (const name of ['下一个来源', '下一个来源', '上一个来源', '上一个来源']) {
      await groupedPreview.getByRole('button', { name }).click()
      await page.waitForTimeout(350)
      await expect(groupedPreview).toBeVisible()
    }
    await excerptBlocks.nth(1).getByRole('button').click()
    await expect(page.locator('body')).toHaveAttribute(
      'data-grouped-citation',
      'source-0-excerpt-1'
    )
    await page.mouse.move(0, 0)
    await expect(groupedPreview).toBeHidden()
    const file = page.getByTestId('direct-file-citation').getByRole('button')
    await expect(file).toHaveText('Initial.pdf')
    await expect(file.locator('[data-citation-icon="file"]')).toBeVisible()
    const initialBounds = await file.boundingBox()
    await file.hover()
    await expect(page.getByRole('region', { name: '引用预览', exact: true })).toContainText(
      /第\s*2\s*页\s*Deferred evidence/
    )
    await expect(file).toHaveText('Initial.pdf')
    await expect(file.locator('[data-citation-icon="file"]')).toBeVisible()
    expect(await file.boundingBox()).toEqual(initialBounds)
    await file.click()
    await expect
      .poll(() => page.locator('body').getAttribute('data-direct-citation'))
      .toBe('directory-receipt')
    await page.getByTestId('missing-file-citation').getByRole('button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('文件不存在')
    await expect(dialog).toContainText('Deferred evidence')
    await expect(dialog.getByRole('button', { name: '查看原文', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      Object.assign(window.scholarseed, {
        browser: {
          dispatch: async ({ input }: { input: string }) => {
            await (
              window as unknown as { recordOpenedSource: (url: string) => Promise<void> }
            ).recordOpenedSource(input)
            return { ok: true, snapshot: { activeTabId: 'opened-source' } }
          },
        },
      })
    })
    await page.getByTestId('url-title-citation').getByRole('button').click()
    await expect
      .poll(() => urls)
      .toEqual(['https://example.com/%E4%B8%AD%E6%96%87?q=%E6%9D%A5%E6%BA%90#%E7%89%87%E6%AE%B5'])
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('citation excerpts clamp to three rendered lines and expand without navigating', async () => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'citation-boundary',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage({ viewport: { width: 700, height: 600 } })
    await page.goto(
      new URL(`${FIXTURE_URL}?citationBoundary`, server.resolvedUrls!.local![0]).toString()
    )
    await page.getByTestId('citation-boundary-0').getByRole('button').hover()
    const preview = page.getByRole('region', { name: '引用预览', exact: true })
    const excerpt = preview.locator('[data-citation-excerpt]').first()
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', '3')
    await expect(preview.getByRole('button', { name: '展开全文' })).toHaveCount(0)
    assert.equal(
      await excerpt.evaluate((element) => element.scrollHeight <= element.clientHeight),
      true
    )
    await page.mouse.move(0, 0)
    await expect(preview).toBeHidden()
    await page.getByTestId('citation-boundary-1').getByRole('button').hover()
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', '3')
    assert.ok(await excerpt.evaluate((element) => element.scrollHeight > element.clientHeight))
    const expand = preview.getByRole('button', { name: '展开全文', exact: true })
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    for (const property of ['font-size', 'font-weight', 'color', 'line-height']) {
      await expect(expand).toHaveCSS(
        property,
        await excerpt.evaluate(
          (element, name) => getComputedStyle(element).getPropertyValue(name),
          property
        )
      )
    }
    await expect(expand).toHaveCSS('text-decoration-line', 'none')
    await expect(expand.locator('svg[aria-hidden="true"]')).toBeVisible()
    await expand.focus()
    await page.keyboard.press('Enter')
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', 'none')
    await expect(preview.getByRole('button', { name: '收起全文', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    assert.equal(await page.locator('body').getAttribute('data-boundary-opened'), null)
    await expect(preview.locator('button button')).toHaveCount(0)
    await preview.getByRole('button', { name: '收起全文', exact: true }).click()
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', '3')
    await preview.getByRole('button', { name: '展开全文', exact: true }).click()
    await preview.getByRole('button', { name: '下一个来源', exact: true }).click()
    await expect(preview).toContainText('Local source')
    await expect(preview.getByRole('button', { name: '收起全文', exact: true })).toHaveCount(0)
    await preview.getByRole('button', { name: '上一个来源', exact: true }).click()
    await expect(excerpt).toHaveCSS('-webkit-line-clamp', '3')
    await preview.getByRole('button', { name: 'Boundary 1.pdf', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-boundary-opened', 'boundary-1')
    await page.mouse.move(0, 0)
    await expect(preview).toBeHidden()
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByTestId('citation-boundary-2').getByRole('button').hover()
    const englishPreview = page.getByRole('region', { name: 'Citation preview', exact: true })
    await englishPreview.getByRole('button', { name: 'Show full excerpt', exact: true }).click()
    const longExcerpt = englishPreview.locator('[data-citation-excerpt]')
    assert.equal((await longExcerpt.textContent())!.length, 4800)
    await expect(longExcerpt).toHaveCSS('-webkit-line-clamp', 'none')
    const panel = await englishPreview.boundingBox()
    assert.ok(panel && panel.height <= 600 * 0.7)
    const before = await englishPreview.evaluate((element) => element.scrollTop)
    await englishPreview.hover()
    await page.mouse.wheel(0, 240)
    await expect
      .poll(() => englishPreview.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before)
    await expect(englishPreview.getByRole('button', { name: 'Collapse excerpt' })).toHaveCount(1)
    await expect(englishPreview.locator('button button')).toHaveCount(0)
  } finally {
    await browser?.close()
    await server.close()
  }
})

test('Markdown renders GFM safely and preserves AI answer annotations', async (context) => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    // Other render suites write fixtures in this root; those writes must not
    // navigate this suite's page while it checks retained DOM identities.
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  })
  context.diagnostic(`optimizer cache: ${server.config.cacheDir}`)
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage()
    const openedUrls: string[] = []
    await page.exposeFunction('recordOpenedSource', (url: string) => openedUrls.push(url))
    const encodedCitationUrl =
      'https://example.com/%E4%B8%AD%E6%96%87?q=%E6%9D%A5%E6%BA%90#%E7%89%87%E6%AE%B5'
    const readableCitationUrl = 'https://example.com/中文?q=来源#片段'
    const encodedListedCitationUrl = 'https://example.com/cited/%E4%B8%AD%E6%96%87'
    const sourceRequests: string[] = []
    await page.route('**/sessions/fixture-stream/answers/stream-answer/sources?**', (route) => {
      sourceRequests.push(route.request().url())
      return route.fulfill({ json: { count: 0, sources: [] } })
    })
    let staleRequests = 0
    await page.route('**/sessions/fixture-stale/answers/stale-answer/sources?**', (route) => {
      staleRequests += 1
      return route.abort()
    })
    await page.goto(new URL(FIXTURE_URL, url).toString())

    const openSourceDirectory = async (trigger: Locator, name: string): Promise<Locator> => {
      await trigger.hover()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const panelId = await trigger.getAttribute('aria-controls')
      assert.ok(panelId)
      const panel = page.locator(`[data-citation-source-panel][id=${JSON.stringify(panelId)}]`)
      const list = panel.getByRole('list', { name, exact: true })
      await expect(list).toBeVisible()
      return list
    }
    const closeSourceDirectory = async (list: Locator): Promise<void> => {
      const viewport = page.viewportSize()
      assert.ok(viewport)
      await page.mouse.move(viewport.width - 1, 1)
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
      await expect(page.locator('[data-citation-source-panel][data-state="open"]')).toHaveCount(0)
    }

    const mixedSources = page.getByTestId('mixed-project-source-directory')
    const projectDirectory = await openSourceDirectory(
      mixedSources.getByRole('button', { name: '2 个来源', exact: true }),
      '2 个来源'
    )
    await expect(projectDirectory.getByRole('listitem')).toHaveCount(2)
    await expect(
      projectDirectory.getByText('项目来源导航；不代表已逐句核验或绑定历史文件版本')
    ).toBeVisible()
    await projectDirectory.getByRole('button', { name: 'report.md' }).first().click()
    assert.equal(
      await page.locator('body').getAttribute('data-directory-open'),
      '/api/resource/raw?project=p&path=report.md'
    )
    await closeSourceDirectory(projectDirectory)

    const directory = page.getByTestId('mixed-citation-directory')
    const directoryResolveCount = async (): Promise<number> =>
      Number(await page.locator('body').getAttribute('data-directory-resolves'))
    const mixedList = await openSourceDirectory(
      directory.getByRole('button', { name: '2 个来源', exact: true }),
      '2 个来源'
    )
    await expect(mixedList.getByRole('listitem')).toHaveCount(2)
    await expect(
      mixedList.getByRole('button', { name: '查看引用：Web source', exact: true })
    ).toBeVisible()
    assert.equal(await directoryResolveCount(), 0)
    await mixedList.focus()
    await expect(mixedList).toBeFocused()
    assert.equal(await directoryResolveCount(), 0)
    const receipt = mixedList.getByRole('button', {
      name: '查看引用：Local source',
      exact: true,
    })
    await expect(receipt).toBeVisible()
    await expect(receipt.locator('[data-citation-excerpt]')).toHaveText('Deferred evidence')
    await receipt.hover()
    assert.equal(await directoryResolveCount(), 0)
    await receipt.focus()
    assert.equal(await directoryResolveCount(), 0)
    assert.equal(await page.locator('body').getAttribute('data-directory-handle'), null)
    await receipt.click()
    const directoryEvidence = page.getByRole('dialog')
    await expect(
      directoryEvidence.getByRole('heading', { name: 'Local source', exact: true })
    ).toBeVisible()
    await expect(directoryEvidence.getByText('Deferred evidence', { exact: true })).toBeVisible()
    assert.equal(await directoryResolveCount(), 1)
    assert.equal(
      await page.locator('body').getAttribute('data-directory-handle'),
      'directory-receipt'
    )
    await page.keyboard.press('Escape')
    await expect(directoryEvidence).toHaveCount(0)
    await expect(receipt).toBeFocused()
    await closeSourceDirectory(mixedList)

    const publisher = page.getByTestId('publisher-citation-boundary')
    await expect(publisher).toBeVisible()
    assert.deepEqual(
      await publisher
        .getByRole('link')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
      ['https://aclanthology.org/2024.eacl-demo.16/']
    )
    assert.equal(
      await contentText(publisher.locator('p').first()),
      '出版方：https://aclanthology.org/2024.eacl-demo.16/[3]'
    )
    assert.equal(await publisher.locator('p').last().getByRole('link').count(), 0)

    const projectSource = page.getByTestId('project-source-markdown')
    assert.equal(await projectSource.getByRole('button').count(), 1)
    assert.equal(await projectSource.getByRole('link').count(), 0)
    await projectSource.getByRole('button', { name: 'Project file', exact: true }).click()
    assert.equal(
      await page.locator('body').getAttribute('data-opened-project-source'),
      '/api/resource/raw?project=project&path=resources%2Fa.md'
    )

    const localSources = page.getByTestId('local-project-source-markdown')
    const formulaBlock = page
      .getByTestId('formula-style')
      .getByTestId('conversation-formula')
      .first()
    await expect(formulaBlock).toHaveCSS('border-color', 'rgb(232, 232, 232)')
    await expect(formulaBlock.getByTestId('formula-toolbar')).toHaveCSS('height', '40px')
    await expect(formulaBlock.getByTestId('formula-toolbar')).toHaveCSS('font-size', '12px')
    await expect(formulaBlock.getByRole('tablist')).toHaveCSS('height', '28px')
    for (const trigger of await formulaBlock.getByRole('tab').all()) {
      await expect(trigger).toHaveCSS('font-size', '12px')
    }
    const formulaActions = formulaBlock.getByRole('tablist').locator('..')
    await page.mouse.move(0, 0)
    await expect(formulaActions).toHaveCSS('opacity', '0')
    await formulaBlock.hover()
    await expect(formulaActions).toHaveCSS('opacity', '1')
    await formulaBlock.getByRole('tab', { name: 'LaTeX', exact: true }).click()
    await expect(formulaBlock.locator('pre')).toHaveText('a+b')
    await formulaBlock.getByRole('tab', { name: '公式', exact: true }).click()
    const standaloneFormula = page.getByTestId('standalone-formula-copy')
    await expect(standaloneFormula.getByTestId('conversation-formula')).toBeVisible()
    await standaloneFormula.hover()
    await standaloneFormula.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal(
      await page.locator('body').getAttribute('data-copied-formula-text'),
      '\\[\\frac{F}{k}=x\\]'
    )
    const formulaHtml = await page.locator('body').getAttribute('data-copied-formula-html')
    assert.match(formulaHtml ?? '', /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/)
    assert.match(formulaHtml ?? '', /<mfrac>/)
    assert.doesNotMatch(formulaHtml ?? '', /<img/)
    await standaloneFormula.getByRole('tab', { name: 'LaTeX', exact: true }).click()
    await expect(standaloneFormula.locator('pre')).toHaveText('\\frac{F}{k}=x')
    await standaloneFormula.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal(
      await page.locator('body').getAttribute('data-copied-formula-text'),
      '\\frac{F}{k}=x'
    )
    assert.match(
      (await page.locator('body').getAttribute('data-copied-formula-html')) ?? '',
      /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/
    )
    const codeBlock = localSources.getByTestId('conversation-code')
    await expect(codeBlock).toHaveCSS('border-color', 'rgb(232, 232, 232)')
    await expect(codeBlock.locator('pre')).toHaveCSS('font-size', '12px')
    await expect(codeBlock.locator('pre')).toHaveCSS('line-height', '14px')
    await expect(codeBlock.locator('pre')).toHaveCSS('padding-left', '12px')
    assert.equal(
      await codeBlock
        .locator('[data-code-line]')
        .first()
        .evaluate((element) => getComputedStyle(element, '::before').content),
      '"1"'
    )
    await expect(codeBlock.locator(':scope > div').first()).toHaveCSS('height', '40px')
    await expect(codeBlock.locator(':scope > div').first()).toHaveCSS('font-size', '12px')
    assert.equal(
      await localSources
        .getByRole('button')
        .evaluateAll(
          (buttons) =>
            buttons.filter((button) => !button.closest('[data-testid="conversation-code"]')).length
        ),
      4
    )
    assert.equal(
      await localSources
        .getByTestId('conversation-code')
        .getByRole('button', { name: '复制', exact: true })
        .count(),
      1
    )
    await localSources
      .getByRole('button', { name: 'resources/项目A/calibration.md#L5', exact: true })
      .click()
    assert.equal(
      await page.locator('body').getAttribute('data-opened-local-project-source'),
      'resources/项目A/calibration.md'
    )
    await localSources
      .getByRole('button', {
        name: 'D:\\work space\\项目A\\resources\\项目A\\calibration.md',
        exact: true,
      })
      .click()
    assert.equal(
      await page.locator('body').getAttribute('data-opened-local-project-source'),
      'resources/项目A/calibration.md'
    )
    assert.equal(await localSources.locator('pre button').count(), 0)
    assert.equal((await localSources.locator('button [data-md-source-start]').count()) > 0, true)

    const summary = page.getByTestId('reading-summary')
    const disclosure = summary.getByRole('button').first()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await disclosure.click()
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    for (const heading of ['研究贡献', '关键结论', '方法', '依赖LLM生成质量', '超参数敏感性']) {
      assert.equal(await summary.locator('strong', { hasText: heading }).count(), 1)
    }
    assert.equal(await summary.locator('ol li').count(), 2)
    assert.equal((await summary.textContent())?.includes('**超参数敏感性**'), false)
    const summaryCitation = summary.getByRole('button', { name: /\[1\]/ })
    await expect(summaryCitation).toHaveText('[1]')
    await expect(summaryCitation).toHaveCSS('font-size', '12px')
    await expect(summaryCitation).toHaveCSS('color', 'rgb(35, 68, 56)')
    await expect(summaryCitation).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await summaryCitation.hover()
    const sourcePreview = page.getByRole('region', { name: '引用来源', exact: true })
    await expect(sourcePreview.getByRole('heading', { name: '引用来源' })).toBeVisible()
    await expect(sourcePreview.getByText('[1] 第5页', { exact: true })).toBeVisible()
    await expect(sourcePreview.locator('blockquote')).toHaveText('source text')
    await expect(sourcePreview.locator('mark')).toHaveCount(0)
    await expect(sourcePreview).toHaveCSS('width', '340px')
    await expect(sourcePreview).toHaveCSS('padding', '12px')
    await expect(sourcePreview).toHaveCSS('border-radius', '12px')
    await expect(sourcePreview).toHaveCSS('row-gap', '8px')
    await expect(sourcePreview).toHaveCSS('border-top-width', '0px')
    await expect(sourcePreview.getByRole('heading')).toHaveCSS('font-size', '12px')
    await expect(sourcePreview.getByRole('heading')).toHaveCSS('font-weight', '400')
    await expect(sourcePreview.getByText('[1] 第5页', { exact: true })).toHaveCSS(
      'font-size',
      '10px'
    )
    await expect(sourcePreview.locator('blockquote')).toHaveCSS('font-size', '12px')
    await expect(sourcePreview.locator('blockquote')).toHaveCSS('line-height', '18px')
    await expect(sourcePreview.locator('blockquote')).toHaveCSS('border-left-width', '2px')
    await expect(sourcePreview.locator('blockquote')).toHaveCSS('padding-left', '6px')
    const locateSource = sourcePreview.getByRole('button', { name: '定位原文' })
    const titleBox = await sourcePreview.getByRole('heading').boundingBox()
    const locateBox = await locateSource.boundingBox()
    assert.ok(titleBox && locateBox)
    assert.ok(locateBox.x > titleBox.x + titleBox.width)
    assert.ok(Math.abs(locateBox.y + locateBox.height / 2 - titleBox.y - titleBox.height / 2) < 2)
    await locateSource.click()
    assert.equal(await page.locator('body').getAttribute('data-summary-source'), '5:source text')
    assert.equal(await summary.evaluate((element) => getComputedStyle(element).userSelect), 'text')

    await assert.equal(await page.locator('h1').textContent(), '标题')
    const native = page.getByTestId('native-citation')
    assert.equal(await native.getByTestId('native-marker').count(), 2)
    assert.equal(await native.getByTestId('native-marker').first().getAttribute('data-start'), '7')
    assert.equal(await native.getByTestId('native-marker').last().getAttribute('data-end'), '13')
    assert.equal(await native.locator('strong').textContent(), '粗体')
    assert.equal((await native.textContent())?.includes('😀原生结论。[1]粗体[1]'), true)
    const nativeTable = page.getByTestId('native-table-citation')
    assert.equal(await nativeTable.getByTestId('native-table-marker').count(), 1)
    assert.equal(await nativeTable.locator('tbody tr td').last().textContent(), '阵雨[1]')
    assert.equal(await nativeTable.locator('tbody tr').last().locator(':scope > *').count(), 2)
    const nativeUrls = page.getByTestId('native-url-citations')
    assert.equal(await nativeUrls.getByTestId('native-url-marker').count(), 3)
    assert.equal(
      await nativeUrls
        .getByRole('link', { name: 'https://example.com/native', exact: true })
        .count(),
      0
    )
    assert.equal(await nativeUrls.getByRole('link', { name: '官网', exact: true }).count(), 1)
    assert.equal(
      await nativeUrls
        .getByRole('link', { name: 'https://example.com/unrelated', exact: true })
        .count(),
      1
    )
    assert.equal(await nativeUrls.locator('code').textContent(), 'https://example.com/native')
    for (const [sourceIndex, text] of [
      '来源：https://example.com/source',
      '来源：www.example.com/source',
    ].entries()) {
      for (let length = 0; length <= text.length; length += 1) {
        const frame = page.getByTestId(`url-frame-${sourceIndex}-${length}`)
        assert.equal(
          await frame.locator('a').count(),
          0,
          `raw URL at ${sourceIndex}:${length}: ${await frame.innerHTML()}`
        )
        assert.doesNotMatch((await frame.textContent()) ?? '', /https?:|www\./)
      }
    }
    const streamingUrls = page.getByTestId('streaming-url-prose')
    const candidates = page.getByTestId('candidate-only')
    await page.getByRole('button', { name: '追加引用文本' }).click()
    await page.getByRole('button', { name: '追加引用文本' }).click()
    assert.equal(sourceRequests.length, 0)
    await Promise.all([
      page.waitForResponse('**/sessions/fixture-stream/answers/stream-answer/sources?**'),
      page.getByRole('button', { name: '结束引用流式' }).click(),
    ])
    assert.equal(sourceRequests.length, 1)
    assert.equal(await page.getByTestId('nested-pending-url').locator('a').count(), 0)
    assert.equal(await page.getByTestId('slash-citation').count(), 1)
    assert.match(await candidates.getByRole('status').innerText(), /部分内容/)
    assert.equal(await candidates.getByRole('button', { name: /查看引用/ }).count(), 0)
    assert.equal(await candidates.getByRole('button').count(), 0)
    assert.doesNotMatch(await candidates.innerText(), /候选来源/)
    assert.equal(await page.getByTestId('no-source-list').innerText(), '')
    const citedList = await openSourceDirectory(
      page.getByTestId('cited-source-list').getByRole('button', { name: '2 个来源' }),
      '2 个来源'
    )
    await expect(citedList.getByRole('listitem')).toHaveCount(2)
    const namedSource = citedList.getByRole('button', { name: '查看引用：已引用页面', exact: true })
    await expect(namedSource.locator('[data-citation-source-domain]')).toHaveText('example.com')
    await expect(namedSource.locator('[data-citation-source-title]')).toHaveText('已引用页面')
    const sourceType = namedSource.locator('.vds-badge')
    await expect(sourceType).toHaveText('网页')
    await expect(sourceType).toHaveCSS('height', '20px')
    await expect(sourceType).toHaveAttribute('title', '网页搜索来源')
    const originalBridge = await page.evaluateHandle(() => window.scholarseed)
    await page.evaluate(() => {
      Object.assign(window, {
        scholarseed: {
          ...window.scholarseed,
          browser: {
            ...window.scholarseed.browser,
            dispatch: async ({ input }: { input: string }) => {
              await (
                window as unknown as { recordOpenedSource: (url: string) => Promise<void> }
              ).recordOpenedSource(input)
              return { ok: true, snapshot: { activeTabId: 'opened-web-source' } }
            },
          },
        },
      })
    })
    await namedSource.click()
    await expect.poll(() => openedUrls).toEqual([encodedListedCitationUrl])
    await expect
      .poll(() => page.locator('body').getAttribute('data-opened-browser-page'))
      .toBe('opened-web-source')
    await expect(page.getByRole('region', { name: '网页来源预览' })).toHaveCount(0)
    const fallbackTitle = citedList.getByRole('button', {
      name: `查看引用：${readableCitationUrl}`,
      exact: true,
    })
    assert.equal(
      await fallbackTitle.getByText(readableCitationUrl, { exact: true }).textContent(),
      readableCitationUrl
    )
    assert.equal((await citedList.innerText()).split(readableCitationUrl).length, 2)
    assert.doesNotMatch(await citedList.innerText(), /%E4%B8%AD/)
    assert.match(await citedList.innerText(), /已引用页面/)
    assert.doesNotMatch(await citedList.innerText(), /候选/)
    assert.equal(await page.getByText('未能关联证据的内容', { exact: true }).count(), 0)
    assert.equal(
      await page
        .getByText('内部核验记录：Direct source support；search/run', { exact: true })
        .count(),
      0
    )
    assert.equal(await page.getByTestId('cited-source-list').getByRole('status').count(), 0)
    assert.equal(await page.getByRole('heading', { name: '来源关联详情' }).count(), 0)
    assert.equal(
      await citedList.evaluate((list) => list.parentElement?.firstElementChild === list),
      true
    )
    assert.equal(await page.getByRole('button', { name: '真实候选页面' }).count(), 0)
    await closeSourceDirectory(citedList)
    const coverageDetails = page.getByTestId('coverage-source-list')
    assert.equal(await coverageDetails.getByRole('status').count(), 0)
    const coverageList = await openSourceDirectory(
      coverageDetails.getByRole('button', { name: '1 个来源' }),
      '1 个来源'
    )
    await expect(coverageList.getByRole('listitem')).toHaveCount(1)
    assert.equal(
      await coverageList.evaluate((list) => list.parentElement?.firstElementChild === list),
      true
    )
    assert.equal(await page.getByText('未关联来源的内容', { exact: true }).count(), 0)
    assert.equal(await page.getByText('尚未找到依据的事实。', { exact: true }).count(), 0)
    const coverageNote = page.getByRole('note')
    await expect(coverageNote).toHaveCount(1)
    assert.equal(
      await coverageNote
        .getByText('部分内容尚未关联来源，请自行核对关键事实', { exact: true })
        .count(),
      1
    )
    assert.equal(
      await coverageNote
        .getByText('还有 14 个检索候选网页未纳入核验，不影响已列出的来源。', { exact: true })
        .count(),
      1
    )
    await closeSourceDirectory(coverageList)
    assert.equal(await coverageDetails.getByRole('status').count(), 0)
    for (const [status, message, unread] of [
      [
        'reviewed',
        '已自动关联检索证据，关键事实请核对原文',
        '还有 3 个检索候选网页未纳入核验，不影响已列出的来源。',
      ],
      ['unavailable', '回答已生成，但来源核验未完成；关键事实请自行核对原文', undefined],
      ['interrupted', '来源核验已中断，部分内容可能没有引用', undefined],
    ] as const) {
      const terminal = page.getByTestId(`coverage-${status}-list`)
      assert.equal(await terminal.getByRole('status').count(), 0, status)
      const terminalList = await openSourceDirectory(
        terminal.getByRole('button', { name: '1 个来源' }),
        '1 个来源'
      )
      await expect(terminalList.getByRole('listitem')).toHaveCount(1)
      assert.equal(
        await terminalList.evaluate((list) => list.parentElement?.firstElementChild === list),
        true,
        status
      )
      assert.match(await terminalList.innerText(), new RegExp(`终态来源 ${status}`))
      const terminalNote = page.getByRole('note')
      await expect(terminalNote).toHaveCount(1)
      assert.equal(
        await terminalNote.evaluate((note) => note.previousElementSibling?.getAttribute('role')),
        'list',
        status
      )
      assert.deepEqual(
        await terminalNote.locator('p').allInnerTexts(),
        unread ? [message, unread] : [message],
        status
      )
      assert.equal(await page.getByRole('heading', { name: '来源关联详情' }).count(), 0, status)
      assert.equal(await page.getByText('未关联来源的内容', { exact: true }).count(), 0, status)
      assert.equal(await page.getByText('未关联的终态原文。', { exact: true }).count(), 0, status)
      await closeSourceDirectory(terminalList)
    }
    const stale = page.getByTestId('stale-source-list')
    const staleList = await openSourceDirectory(
      stale.getByRole('button', { name: '1 个来源' }),
      '1 个来源'
    )
    await expect(staleList.getByRole('listitem')).toHaveCount(1)
    const staleStatus = page.getByRole('status').filter({ hasText: '暂时无法更新来源状态' })
    await staleStatus.waitFor()
    assert.ok(staleRequests > 0)
    assert.equal(
      await staleStatus.innerText(),
      '暂时无法更新来源状态，已保留上次信息；可点击引用重试。'
    )
    assert.equal(
      await staleList.evaluate((list) => list.parentElement?.firstElementChild === list),
      true
    )
    assert.match(await staleList.innerText(), /保留的来源/)
    await expect
      .poll(() =>
        staleStatus.evaluate((status) => status.previousElementSibling?.getAttribute('role'))
      )
      .toBe('list')
    assert.equal(await stale.getByText('来源列表暂时无法加载', { exact: false }).count(), 0)
    await closeSourceDirectory(staleList)
    assert.equal(await streamingUrls.locator('a').count(), 0)
    assert.ok((await streamingUrls.textContent())?.includes('。后文保留'))
    assert.equal(await streamingUrls.locator('code').textContent(), 'https://example.com/code')
    await page.getByTestId('url-title-citation').getByRole('button').hover()
    const webPreview = page.getByRole('region', { name: '网页来源预览' })
    assert.equal((await webPreview.textContent())?.split(readableCitationUrl).length, 2)
    assert.doesNotMatch((await webPreview.textContent()) ?? '', /%E4%B8%AD/)
    await page.getByTestId('url-title-citation').getByRole('button').click()
    await expect.poll(() => openedUrls).toEqual([encodedListedCitationUrl, encodedCitationUrl])
    await expect(webPreview).toHaveCount(0)
    await page.evaluate((bridge) => Object.assign(window, { scholarseed: bridge }), originalBridge)
    await originalBridge.dispose()
    await page.keyboard.press('Escape')
    await page
      .getByTestId('named-title-citation')
      .getByRole('button', { name: '查看引用：原始页面标题 100% %E4%B8%AD', exact: true })
      .hover()
    assert.ok((await webPreview.textContent())?.includes('原始页面标题 100% %E4%B8%AD'))
    assert.ok((await webPreview.textContent())?.includes(new URL(encodedCitationUrl).hostname))
    await page.keyboard.press('Escape')
    await assert.equal(
      (await page.locator('code').first().textContent())?.startsWith('postgres'),
      true
    )
    await assert.equal(await page.locator('ol').first().getAttribute('start'), '3')
    await assert.equal((await page.locator('ul ul').textContent())?.trim(), '内层')
    await assert.equal(await page.locator('table tbody td').first().textContent(), '渲染')
    const gfm = page.locator('.md').filter({ has: page.getByTestId('pdf-citation') })
    await expect(gfm).toHaveCount(1)
    await expect(gfm.locator('.katex')).toHaveCount(1)
    await expect(page.getByTestId('formula-style').locator('.katex')).toHaveCount(1)
    await expect(page.getByTestId('card-headers').locator('.katex')).toHaveCount(1)
    await expect(page.getByTestId('standalone-formula-copy').locator('.katex')).toHaveCount(0)
    await assert.equal(await page.getByTestId('tex-delimiter-math').locator('.katex').count(), 2)
    const currency = page.getByTestId('currency-markdown')
    assert.equal(await currency.locator('.katex').count(), 0)
    assert.equal(await currency.locator('strong').textContent(), '$16.60 – $71.48')
    assert.equal(
      await currency.getByTestId('currency-citation').getAttribute('data-original'),
      '[1](https://example.com/source)'
    )
    assert.equal(
      await currency.getByTestId('currency-citation').getAttribute('href'),
      'https://example.com/source'
    )
    assert.equal((await currency.textContent())?.includes('https://'), false)
    await assert.equal(await page.locator('.md script').count(), 0)
    await assert.equal(await page.locator('img[src^="https:"]').count(), 0)
    await assert.equal(await page.locator('img[src^="http:"]').count(), 0)
    await assert.equal(await page.locator('a[href^="javascript:"]').count(), 0)
    const fileMarkdown = page.getByTestId('session-file-markdown')
    assert.equal(await fileMarkdown.getByTestId('session-file-link').count(), 1)
    assert.equal(await fileMarkdown.getByRole('button', { name: '越界' }).count(), 0)
    assert.equal(await fileMarkdown.getByRole('button', { name: '伪协议' }).count(), 0)
    assert.equal(await fileMarkdown.getByRole('link', { name: '网页' }).count(), 1)
    await fileMarkdown.getByRole('button', { name: '报告' }).click()
    assert.equal(
      await page.locator('body').getAttribute('data-opened-session-file'),
      'outputs/report one.md'
    )
    await assert.equal(
      (await page.locator('body').textContent())?.includes('scholarseed-ref'),
      false
    )
    assert.equal(
      await page.getByTestId('wrapped-web-citation').textContent(),
      '网页来源（新华网、银联）'
    )
    assert.equal(await page.getByTestId('wrapped-web-citation').locator('strong').count(), 0)
    assert.equal(await page.getByTestId('web-citation').count(), 0)
    assert.equal(await page.getByTestId('wrapped-web-citation').getByRole('link').count(), 2)
    const mixed = page.getByTestId('mixed-references')
    assert.equal(await mixed.getByTestId('mapped-citation').count(), 3)
    assert.deepEqual(
      await mixed
        .getByTestId('mapped-citation')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-original'))),
      ['[9]', '[48](https://example.com/source)', '[9] https://example.com/source']
    )
    assert.equal(await mixed.locator('p').nth(1).textContent(), '[1]')
    assert.equal(await mixed.getByRole('link', { name: '网站', exact: true }).count(), 1)
    assert.equal(
      await mixed.getByRole('link', { name: 'https://example.com/source', exact: true }).count(),
      0
    )
    assert.equal(await mixed.locator('code').textContent(), '[9]')
    assert.equal(
      await page.getByTestId('adjacent-references').getByTestId('adjacent-marker').count(),
      5
    )
    assert.equal(
      await page
        .getByTestId('adjacent-references')
        .getByTestId('adjacent-marker')
        .nth(2)
        .getAttribute('data-length'),
      '9'
    )
    assert.equal(
      await page.getByTestId('adjacent-links').getByTestId('adjacent-link-marker').count(),
      1
    )
    const styledPostfix = page.getByTestId('styled-postfix-reference')
    assert.equal(await styledPostfix.getByTestId('styled-postfix-marker').count(), 3)
    assert.equal(
      await styledPostfix.getByTestId('styled-postfix-marker').first().getAttribute('data-length'),
      String('**https://example.com/source** [9]'.length)
    )
    assert.equal(await styledPostfix.locator('strong').textContent(), '保留文字')
    assert.equal(
      await styledPostfix.locator('code').textContent(),
      'https://example.com/source [9]'
    )
    assert.equal(
      await page.getByTestId('url-and-reference').getByTestId('url-reference-marker').count(),
      1
    )
    assert.equal(
      await page
        .getByTestId('url-and-reference')
        .getByTestId('url-reference-marker')
        .getAttribute('data-length'),
      String('https://example.com/source [2](https://example.com/source)'.length)
    )
    assert.equal(
      await page
        .getByTestId('adjacent-links')
        .getByTestId('adjacent-link-marker')
        .getAttribute('data-length'),
      String('[2](https://example.com/source)[2](https://example.com/source)'.length)
    )
    const appendix = page.getByTestId('appendix-references')
    assert.deepEqual(await appendix.locator('li').allTextContents(), ['[1]', '[2]'])
    assert.deepEqual(
      await appendix
        .getByTestId('appendix-marker')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-original'))),
      [
        '[9] https://example.com/source',
        '[10] <https://example.com/second>',
        '[9]',
        'https://example.com/second',
        '[9]',
      ]
    )
    assert.equal(await appendix.getByRole('link', { name: '官网' }).count(), 1)
    assert.equal(await appendix.locator('code').textContent(), '[9] https://example.com/source')
    const streamingReference = '结论[49](https://example.com/source)'
    for (let length = 0; length <= streamingReference.length; length += 1) {
      const frame = page.getByTestId(`citation-frame-${length}`)
      assert.equal(await frame.locator('a').count(), 0, `no raw anchor at prefix ${length}`)
      assert.equal(
        (await frame.textContent())?.includes('https:'),
        false,
        `no destination at prefix ${length}`
      )
    }
    assert.equal(
      await contentText(page.getByTestId('interrupted-reference')),
      streamingReference.slice(0, -1)
    )
    const bracketedReference = '结论[[49]](https://example.com/source)'
    assert.equal(await page.getByTestId('bracketed-citation').count(), 1)
    assert.equal(
      await page.getByTestId('bracketed-citation').getAttribute('data-original'),
      '[[49]](https://example.com/source)'
    )
    for (let length = 0; length <= bracketedReference.length; length += 1) {
      const frame = page.getByTestId(`bracketed-frame-${length}`)
      assert.equal(await frame.locator('a').count(), 0, `no bracketed anchor at prefix ${length}`)
      assert.equal(
        (await frame.textContent())?.includes('https:'),
        false,
        `no bracketed destination at prefix ${length}`
      )
    }
    assert.equal(
      await page.getByTestId('streaming-code').locator('code').textContent(),
      '[49](https://example.com/source'
    )
    assert.equal(
      await page.getByTestId('streaming-ordinary').getByRole('link', { name: '网站' }).count(),
      1
    )
    assert.equal(
      (await page.getByTestId('streaming-escaped').textContent())?.includes('https:'),
      true
    )
    const pendingPrefix = page.getByTestId('streaming-parentheses')
    const siblings = page.getByTestId('streaming-siblings')
    assert.equal(await siblings.textContent(), '参见 … 与 重点')
    assert.equal(await siblings.locator('strong').textContent(), '重点')
    assert.equal(await siblings.locator('a').count(), 0)
    assert.equal(await page.getByTestId('streaming-text-tail').textContent(), '参见 … 与正文')
    assert.equal(
      await siblings.locator('strong [data-md-source-start]').getAttribute('data-md-source-start'),
      '51'
    )
    const prefix = page.getByTestId('streaming-prefix')
    assert.equal(await prefix.getByTestId('prefix-citation').count(), 2)
    assert.deepEqual(
      await prefix
        .getByTestId('prefix-citation')
        .evaluateAll((nodes) =>
          nodes.map((node) => [node.getAttribute('data-start'), node.getAttribute('data-end')])
        ),
      [
        ['6', '9'],
        ['13', '16'],
      ]
    )
    assert.equal(await prefix.locator('[data-citation-pending]').count(), 1)
    assert.equal((await prefix.textContent())?.includes('https:'), false)
    assert.equal(await contentText(page.getByTestId('malformed-mapped')), '[9](https://a.com/(x')
    assert.equal(await page.getByTestId('incorrect-citation').count(), 0)
    assert.equal((await pendingPrefix.textContent())?.includes('https:'), false)
    assert.equal(await pendingPrefix.locator('[data-md-source-start="0"]').textContent(), '正文 ')
    assert.equal(
      await pendingPrefix.locator('[data-md-source-start="0"]').getAttribute('data-md-source-end'),
      '3'
    )
    await assert.equal(await page.getByTestId('evidence-reference').count(), 1)
    await assert.equal(await page.getByTestId('answer-marker').count(), 1)
    const answerMark = page.locator(
      '[data-scholarseed-answer-annotation-id="annotation:inline-code"]'
    )
    await assert.equal(await answerMark.count(), 1)
    await assert.equal((await answerMark.getAttribute('class'))?.includes('ring-2'), true)

    assert.equal(await page.getByTestId('pdf-citation').count(), 1)
    assert.equal(
      await page.getByTestId('pdf-citation').getAttribute('data-original'),
      '[1](scholarseed-cite:fixture)'
    )
    assert.equal(await page.locator('strong').filter({ hasText: '待验证假设：' }).count(), 1)
    assert.equal(await page.locator('strong').filter({ hasText: '“中文方案”' }).count(), 1)
    assert.equal(await page.locator('code').filter({ hasText: '**代码：**BERT' }).count(), 1)

    const citationContent = page.getByTestId('citation-content')
    assert.equal(await citationContent.locator('[data-scholarseed-citation-claim]').count(), 0)
    assert.deepEqual(await citationContent.locator('strong').allTextContents(), ['句子对'])
    assert.equal(await citationContent.getByTestId('claim-link').count(), 7)
    assert.equal(
      await citationContent.getByTestId('claim-link').first().getAttribute('data-original'),
      '[1](scholarseed-cite:numeric)'
    )
    assert.equal(
      await citationContent.getByTestId('claim-link').last().getAttribute('data-original'),
      '[7](scholarseed-cite:list)'
    )

    const originalCitation = await page.getByTestId('pdf-citation').elementHandle()
    await page.getByRole('button', { name: '刷新父组件 0' }).click()
    assert.equal(await originalCitation?.evaluate((node) => node.isConnected), true)
    assert.equal(await page.getByRole('button', { name: '刷新父组件 1' }).count(), 1)

    const sourceLeaf = page.locator('code [data-md-source-start]').first()
    await assert.equal(await sourceLeaf.getAttribute('data-md-source-start'), '9')
    await assert.equal(await sourceLeaf.getAttribute('data-md-source-end'), '17')
    const focusedSource = await sourceLeaf.evaluate((leaf) => {
      const resolve = (
        window as unknown as {
          sourceOffsetRect: (root: HTMLElement, offset: number) => DOMRect | null
        }
      ).sourceOffsetRect
      const root = leaf.closest<HTMLElement>('.md')!
      const range = document.createRange()
      range.setStart(leaf.firstChild!, 2)
      range.setEnd(leaf.firstChild!, 3)
      const expected = range.getBoundingClientRect()
      const actual = resolve(root, 11)
      return {
        expected: { top: expected.top, left: expected.left },
        actual: actual && { top: actual.top, left: actual.left },
        missing: resolve(root, -1),
      }
    })
    assert.deepEqual(focusedSource.actual, focusedSource.expected)
    assert.equal(focusedSource.missing, null)

    const evidence = page.getByTestId('evidence-reference')
    assert.equal(await evidence.getAttribute('aria-label'), '支持充分，引用 [1]')
    await evidence.click()
    const originalEvidence = await evidence.elementHandle()
    const card = page.getByRole('region', { name: '关联论断卡片' })
    assert.ok((await card.textContent())?.includes('外部网页来源；未下载本地副本。'))
    assert.equal(
      await page.getByRole('checkbox', { name: '已完成', exact: true }).isChecked(),
      true
    )
    assert.equal(
      await page.getByRole('checkbox', { name: '未完成', exact: true }).isChecked(),
      false
    )
    await page.getByRole('button', { name: 'Switch to English' }).click()
    assert.equal(await originalEvidence?.evaluate((node) => node.isConnected), true)
    assert.equal(await evidence.getAttribute('aria-expanded'), 'true')
    assert.equal(await evidence.getAttribute('aria-label'), 'Well supported, citation [1]')
    const englishCard = page.getByRole('region', { name: 'Related claim card' })
    assert.ok(
      (await englishCard.textContent())?.includes(
        'External web source; no local copy has been downloaded.'
      )
    )
    assert.ok((await englishCard.textContent())?.includes('example.com'))
    assert.ok((await englishCard.textContent())?.includes('postgres'))
    assert.equal(await englishCard.getByRole('button', { name: 'Open original' }).count(), 1)
    assert.equal(
      await page.getByRole('checkbox', { name: 'Completed', exact: true }).isChecked(),
      true
    )
    assert.equal(
      await page.getByRole('checkbox', { name: 'Not completed', exact: true }).isChecked(),
      false
    )
    assert.equal(
      await contentText(
        page.getByTestId('localized-markdown').getByTestId('answer-image-fallback')
      ),
      'This image cannot be previewed directlyempty.png'
    )
    assert.equal(
      await contentText(page.getByTestId('answer-image-fallback').first()),
      'This image cannot be previewed directlyimage.png'
    )
    assert.equal(
      await page
        .getByTestId('localized-markdown')
        .getByRole('button', { name: 'Open original', exact: true })
        .count(),
      1
    )
    await evidence.hover()
    assert.ok((await page.getByRole('tooltip').textContent())?.includes('1 source'))
    await page.getByRole('button', { name: 'Open floating window' }).click()
    const floating = page.getByRole('dialog', { name: '用户标题' })
    const beforeResize = await floating.boundingBox()
    await page.getByRole('separator', { name: 'Resize floating window' }).press('ArrowRight')
    const afterResize = await floating.boundingBox()
    assert.equal(afterResize!.width, beforeResize!.width + 16)
    await page.getByRole('button', { name: 'Switch to Chinese' }).click()
    assert.equal(await floating.boundingBox().then((box) => box?.width), afterResize!.width)
    assert.equal(await page.getByRole('separator', { name: '调整浮层大小' }).count(), 1)
    await page.getByRole('button', { name: '关闭用户标题', exact: true }).click()
    assert.equal(await floating.count(), 0)
    assert.equal(await evidence.getAttribute('aria-expanded'), 'true')
  } finally {
    await browser?.close()
    await server.close()
  }
})
