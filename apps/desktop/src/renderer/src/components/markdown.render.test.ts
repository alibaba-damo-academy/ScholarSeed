import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const FIXTURE_URL = '/components/markdown.render.fixture.html'
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
      server.close(() => resolve(address.port))
    })
  })
}

test('Markdown renders GFM safely and preserves AI answer annotations', async () => {
  const port = await reservePort()
  const server = await createServer({
    configFile: false,
    root: ROOT_DIR,
    plugins: [react()],
    server: { host: '127.0.0.1', port, strictPort: true },
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    const sourceRequests: string[] = []
    await page.route('**/sessions/fixture-stream/answers/stream-answer/sources?**', (route) => {
      sourceRequests.push(route.request().url())
      return route.fulfill({ json: { count: 0, sources: [] } })
    })
    await page.goto(new URL(FIXTURE_URL, url).toString())

    const summary = page.getByTestId('reading-summary')
    await summary.locator('details').first().locator('summary').click()
    await summary.locator('details').last().locator('summary').click()
    for (const heading of ['研究贡献', '关键结论', '方法', '依赖LLM生成质量', '超参数敏感性']) {
      assert.equal(await summary.locator('strong', { hasText: heading }).count(), 1)
    }
    assert.equal(await summary.locator('ol li').count(), 2)
    assert.equal((await summary.textContent())?.includes('**超参数敏感性**'), false)
    await summary.getByTitle('source text').click()
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
    await page.getByTestId('cited-source-list').getByRole('button', { name: '1 个来源' }).click()
    const citedList = page.getByRole('list', { name: '1 个来源' })
    assert.equal(await citedList.getByRole('listitem').count(), 1)
    assert.match(await citedList.innerText(), /已引用页面/)
    assert.doesNotMatch(await citedList.innerText(), /候选/)
    assert.equal(await page.getByText('未能关联证据的内容', { exact: true }).count(), 0)
    assert.equal(
      await page
        .getByText('内部核验记录：Direct source support；search/run', { exact: true })
        .count(),
      0
    )
    assert.match(
      await page.getByTestId('cited-source-list').getByRole('status').innerText(),
      /部分内容/
    )
    assert.equal(await page.getByRole('button', { name: '真实候选页面' }).count(), 0)
    await page.keyboard.press('Escape')
    assert.equal(await streamingUrls.locator('a').count(), 0)
    assert.ok((await streamingUrls.textContent())?.includes('。后文保留'))
    assert.equal(await streamingUrls.locator('code').textContent(), 'https://example.com/code')
    await page.getByTestId('url-title-citation').getByRole('button').click()
    const webPreview = page.getByRole('region', { name: '网页来源预览' })
    assert.equal((await webPreview.textContent())?.split('https://example.com/source').length, 2)
    await page.keyboard.press('Escape')
    await page.getByTestId('named-title-citation').getByRole('button').click()
    assert.ok((await webPreview.textContent())?.includes('原始页面标题'))
    assert.ok((await webPreview.textContent())?.includes('https://example.com/named'))
    await page.keyboard.press('Escape')
    await assert.equal(
      (await page.locator('code').first().textContent())?.startsWith('postgres'),
      true
    )
    await assert.equal(await page.locator('ol').first().getAttribute('start'), '3')
    await assert.equal((await page.locator('ul ul').textContent())?.trim(), '内层')
    await assert.equal(await page.locator('table tbody td').first().textContent(), '渲染')
    await assert.equal(await page.locator('.katex').count(), 3)
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
    await assert.equal(await page.locator('img').count(), 0)
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
      await page.getByTestId('interrupted-reference').textContent(),
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
    assert.equal(await page.getByTestId('malformed-mapped').textContent(), '[9](https://a.com/(x')
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
      await page.getByTestId('localized-markdown').locator('.md-image-placeholder').textContent(),
      'Image'
    )
    assert.equal(await page.locator('.md-image-placeholder').first().textContent(), '远程图片')
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
