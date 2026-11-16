import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createResourceServer } from 'node:http'
import net from 'node:net'
import test, { after } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const FIXTURE_URL = '/components/markdown.render.fixture.html'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const servers = renderServers({ after })

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

test('Markdown preserves fallback source, scoped actions and streaming states alongside valid GFM', async (context) => {
  const port = await reservePort()
  const server = await servers.create({
    cacheKey: 'markdown-gfm',
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  })
  context.diagnostic(`optimizer cache: ${server.config.cacheDir}`)
  const imageBytes = readFileSync(path.join(ROOT_DIR, 'assets/icon-img.png'))
  const imageServer = createResourceServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Access-Control-Allow-Origin': `http://127.0.0.1:${port}`,
    })
    response.end(imageBytes)
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    await new Promise<void>((resolve) => imageServer.listen(0, '127.0.0.1', resolve))
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    const address = imageServer.address()
    assert.ok(address && typeof address !== 'string')
    const fixtureUrl = new URL(FIXTURE_URL, url)
    fixtureUrl.searchParams.set('imageSource', `http://127.0.0.1:${address.port}/image.png`)
    browser = await chromium.launch()
    const page = await browser.newPage()
    page.on('pageerror', (error) => context.diagnostic(`page error: ${error.message}`))
    page.on('requestfailed', (request) =>
      context.diagnostic(`request failed: ${request.url()} ${request.failure()?.errorText}`)
    )
    page.on('response', (response) => {
      if (response.status() >= 400)
        context.diagnostic(`HTTP ${response.status()}: ${response.url()}`)
    })
    await page.goto(fixtureUrl.toString())

    const fallback = page.getByTestId('fallback-table')
    assert.equal(
      await fallback.locator('pre').textContent(),
      '| 研究 | 效率变化 |\n| --- |\n| Noy & Zhang | -40% |'
    )
    assert.equal(await fallback.getByRole('status').textContent(), '表格格式不完整，已按原文显示')
    const positions = await fallback.evaluate((element) => {
      const source = element.querySelector('pre')!.getBoundingClientRect()
      const notice = element.querySelector('[role="status"]')!.getBoundingClientRect()
      return { sourceBottom: source.bottom, noticeTop: notice.top }
    })
    assert.ok(
      positions.noticeTop >= positions.sourceBottom,
      'fallback explanation follows the preserved source'
    )

    const links = page.getByTestId('fallback-links')
    const bare = links.getByTestId('answer-link')
    assert.equal(await bare.count(), 1, 'only bare URLs have a copy action')
    assert.equal(
      await links.getByRole('link', { name: '原文', exact: true }).getAttribute('title'),
      '来源标题'
    )
    const fullUrl = 'https://example.com/research/appendix?query=' + 'long'.repeat(80)
    assert.equal(await bare.locator('a').getAttribute('href'), fullUrl)
    const layout = await bare.evaluate((element) => {
      const anchor = element.querySelector('a')!
      const button = element.querySelector('button')!.getBoundingClientRect()
      const link = element.getBoundingClientRect()
      const style = getComputedStyle(anchor)
      return {
        width: link.width,
        parent: element.parentElement!.getBoundingClientRect().width,
        lines: anchor.getClientRects().length,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        clipped: anchor.scrollWidth > anchor.clientWidth,
        decoration: style.textDecorationStyle,
        buttonBottom: button.bottom,
        linkBottom: link.bottom,
        buttonRight: button.right,
        linkRight: link.right,
      }
    })
    assert.ok(layout.width <= layout.parent)
    assert.equal(layout.lines, 1, 'bare URLs stay on one line')
    assert.equal(layout.whiteSpace, 'nowrap')
    assert.equal(layout.textOverflow, 'ellipsis')
    assert.ok(layout.clipped, 'the complete URL overflows the visible single line')
    assert.equal(layout.decoration, 'dotted')
    assert.equal(layout.buttonBottom, layout.linkBottom)
    assert.equal(layout.buttonRight, layout.linkRight)
    const copy = bare.getByRole('button')
    await expect(copy).toHaveCSS('opacity', '0')
    await bare.locator('a').focus()
    await expect(page.getByRole('tooltip')).toHaveText(fullUrl)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.keyboard.press('Tab')
    await expect(copy).toBeFocused()
    await expect(copy).toHaveCSS('opacity', '1')
    await page.keyboard.press('Tab')
    await expect(copy).toHaveCSS('opacity', '0')
    await bare.locator('a').hover()
    await expect(page.getByRole('tooltip')).toHaveText(fullUrl)
    await expect(copy).toHaveCSS('opacity', '1')
    await copy.click()
    assert.equal(await page.locator('body').getAttribute('data-copied-fallback-link'), fullUrl)
    await bare.locator('a').click()
    assert.equal(await page.locator('body').getAttribute('data-opened-fallback-link'), fullUrl)
    const image = page.getByTestId('fallback-image')
    await expect(image.getByTestId('answer-image-fallback')).toContainText('图片无法加载')
    await expect(image).toContainText('missing-figure.png')
    await image.getByRole('button', { name: '打开原文件' }).click()
    assert.equal(
      await page.locator('body').getAttribute('data-opened-fallback-image'),
      'outputs/missing-figure.png'
    )
    await image.getByRole('button', { name: '更新图片来源' }).click()
    await expect(image.getByTestId('answer-image-fallback')).toHaveCount(0)
    await expect
      .poll(() =>
        image.locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)

    const nonstandard = page.getByTestId('fallback-nonstandard')
    await expect(nonstandard).toContainText('unknown-research-language')
    assert.equal(await nonstandard.locator('pre').textContent(), '<unsafe>value</unsafe>')
    await expect(nonstandard.getByTestId('conversation-code')).toBeVisible()
    const mapped = nonstandard.locator('pre [data-md-source-start]')
    assert.equal(await mapped.count(), 1)
    const mappedStart = Number(await mapped.getAttribute('data-md-source-start'))
    const mappedEnd = Number(await mapped.getAttribute('data-md-source-end'))
    assert.equal(mappedEnd - mappedStart, '<unsafe>value</unsafe>'.length)
    assert.equal(await nonstandard.locator('pre code span span[class]').count(), 0)
    await nonstandard.hover()
    await nonstandard.getByRole('button').click()
    assert.equal(
      await page.locator('body').getAttribute('data-copied-fallback-code'),
      '<unsafe>value</unsafe>\n'
    )
    await expect(nonstandard).toContainText('<div class="note">仅供参考</div>')
    await expect(nonstandard).toContainText('<script>window.__formatExecuted = true</script>')
    assert.equal(await nonstandard.locator('script, .note, unsafe').count(), 0)
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { __formatExecuted?: boolean }).__formatExecuted
      ),
      undefined
    )
    assert.ok(await nonstandard.evaluate((element) => element.scrollWidth <= element.clientWidth))

    const empty = page.getByTestId('fallback-empty')
    await expect(empty).toContainText('模型没有返回内容。')
    const emptyColors = await empty.getByTestId('empty-answer').evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        actual: style.getPropertyValue('--vds-alert-border').trim(),
        neutral: style.getPropertyValue('--vds-border-default').trim(),
      }
    })
    assert.equal(
      emptyColors.actual,
      emptyColors.neutral,
      'empty answers use the prototype neutral border'
    )
    await empty.getByRole('button', { name: '重新生成' }).click()
    await expect(empty.getByRole('alert')).toHaveText('尚未确认重新生成，请重试。')
    await empty.getByRole('button', { name: '重新生成' }).click()
    await expect(empty.locator('output')).toHaveText('2')
    const unavailable = page.getByTestId('fallback-unavailable')
    await expect(unavailable.getByRole('button', { name: '重新生成' })).toBeDisabled()
    await expect(unavailable).toContainText('仅可在会话空闲且草稿为空时')

    const streaming = page.getByTestId('fallback-streaming')
    await expect(streaming.locator('[role="status"], [role="alert"]')).toHaveCount(0)
    await expect(streaming).toContainText('missingCommand')
    await streaming.getByRole('button', { name: '完成格式测试轮次' }).click()
    await expect(streaming.getByText('表格格式不完整，已按原文显示', { exact: true })).toBeVisible()
    assert.equal(
      await streaming.getByTestId('inline-formula-fallback').count(),
      1,
      await streaming.innerHTML()
    )
    await expect(streaming.locator('[role="alert"]')).toBeVisible()
    await expect(streaming.locator('details')).not.toHaveAttribute('open', '')

    for (const testId of ['tilde-markdown', 'tilde-markdown-math']) {
      const tildeMarkdown = page.getByTestId(testId)
      const renderedText = await tildeMarkdown.textContent()
      assert.ok(renderedText?.includes('24~33℃；次日 23~31℃'), `${testId} preserves numeric ranges`)
      assert.ok(renderedText?.includes('代码：24~33℃'), `${testId} preserves inline code ranges`)
      assert.equal(await tildeMarkdown.locator('del').count(), 1)
      assert.equal(await tildeMarkdown.locator('del').textContent(), '已取消')
    }

    const recovery = page.getByTestId('fallback-highlighter')
    await recovery.getByRole('button', { name: '触发高亮异常' }).click()
    await expect(recovery).toContainText('代码高亮失败，已按原文显示。')
    await expect(recovery.locator('pre')).toHaveText('render-failure-probe')
    await recovery.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal(
      await page.locator('body').getAttribute('data-copied-recovery'),
      'render-failure-probe'
    )
    await expect(fallback).toContainText('Noy & Zhang')
    await recovery.getByRole('button', { name: '恢复正常代码' }).click()
    await expect(recovery).not.toContainText('代码高亮失败，已按原文显示。')
    await expect(recovery.locator('pre')).toHaveText('print(1)')

    const renderer = page.getByTestId('fallback-renderer')
    await renderer.getByRole('button', { name: '触发解析异常' }).click()
    await expect(renderer).toContainText('内容格式无法渲染，已按原文显示。')
    await expect(renderer.locator('pre')).toContainText(
      '回答原文 [来源](https://example.com/recovery)'
    )
    await expect(renderer).not.toContainText('scholarseed-ref')
    assert.equal(await renderer.locator('script').count(), 0)
    await renderer.getByRole('button', { name: '复制', exact: true }).click()
    const copiedSource = await page.locator('body').getAttribute('data-copied-recovery-source')
    assert.ok(copiedSource?.includes('<script>window.__recoveryExecuted = true</script>'))
    assert.ok(!copiedSource?.includes('scholarseed-ref'))
    await renderer.getByRole('button', { name: '恢复正常正文' }).click()
    await expect(renderer).not.toContainText('内容格式无法渲染，已按原文显示。')
    await expect(renderer).toContainText('正常内容已恢复。')

    const themedDiagram = page.getByTestId('fallback-theme').locator('img')
    await expect(themedDiagram).toBeVisible()
    const diagramStyle = async () => {
      const source = await themedDiagram.getAttribute('src')
      return (
        source &&
        decodeURIComponent(source.slice(source.indexOf(',') + 1))
          .match(/<style>([\s\S]*?)<\/style>/)?.[1]
          .replace(/scholarseed-diagram-\d+/g, 'diagram')
      )
    }
    const lightDiagram = await diagramStyle()
    assert.ok(lightDiagram)
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await expect.poll(async () => (await diagramStyle()) === lightDiagram).toBe(false)
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await expect.poll(async () => (await diagramStyle()) === lightDiagram).toBe(true)
  } finally {
    await browser?.close()
    await new Promise<void>((resolve, reject) =>
      imageServer.close((error) => (error ? reject(error) : resolve()))
    )
    await server.close()
  }
})
