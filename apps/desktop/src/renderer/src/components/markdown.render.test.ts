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
    server: { host: '127.0.0.1', port, strictPort: true }
  })
  let browser: Browser | undefined
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    assert.ok(url)
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(new URL(FIXTURE_URL, url).toString())

    await assert.equal(await page.locator('h1').textContent(), '标题')
    await assert.equal((await page.locator('code').first().textContent())?.startsWith('postgres'), true)
    await assert.equal(await page.locator('ol').getAttribute('start'), '3')
    await assert.equal((await page.locator('ul ul').textContent())?.trim(), '内层')
    await assert.equal(await page.locator('table tbody td').first().textContent(), '渲染')
    await assert.equal(await page.locator('.katex').count(), 1)
    await assert.equal(await page.locator('.md script').count(), 0)
    await assert.equal(await page.locator('img').count(), 0)
    await assert.equal(await page.locator('a[href^="javascript:"]').count(), 0)
    await assert.equal((await page.locator('body').textContent())?.includes('scholarseed-ref'), false)
    assert.equal(await page.getByTestId('wrapped-web-citation').textContent(), '网页来源新华网银联')
    assert.deepEqual(await page.getByTestId('web-citation').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-original'))), [
      '[新华网](https://example.com/source)',
      '[银联](https://example.com/unionpay)'
    ])
    await assert.equal(await page.getByTestId('evidence-reference').count(), 1)
    await assert.equal(await page.getByTestId('answer-marker').count(), 1)
    const answerMark = page.locator('[data-scholarseed-answer-annotation-id="annotation:inline-code"]')
    await assert.equal(await answerMark.count(), 1)
    await assert.equal(
      (await answerMark.getAttribute('class'))?.includes('ring-2'),
      true
    )

    assert.equal(await page.getByTestId('pdf-citation').count(), 1)
    assert.equal(await page.getByTestId('pdf-citation').getAttribute('data-original'), '[1](scholarseed-cite:fixture)')
    assert.equal(await page.locator('strong').filter({ hasText: '待验证假设：' }).count(), 1)
    assert.equal(await page.locator('strong').filter({ hasText: '“中文方案”' }).count(), 1)
    assert.equal(await page.locator('code').filter({ hasText: '**代码：**BERT' }).count(), 1)

    const claims = page.getByTestId('citation-claims')
    const emphasized = await claims.locator('[data-scholarseed-citation-claim]').allTextContents()
    const emphasizedText = emphasized.join('')
    for (const expected of ['样本量为 30；损失为 2.8 dB', '另一个结论', 'The result is 0.42.', '原文第一句。原文包含 ', '[CLS]', '句子对', '使用编码器', '论文报告有提升']) {
      assert.ok(emphasizedText.includes(expected), expected)
    }
    for (const excluded of ['未验证的推断', '仍需实验', 'Unverified assumption', '实验尚未完成', '普通', '代码中的']) {
      assert.equal(emphasizedText.includes(excluded), false, excluded)
    }
    assert.equal(await claims.getByTestId('claim-link').count(), 7)
    assert.equal(await claims.getByTestId('claim-link').first().getAttribute('data-original'), '[1](scholarseed-cite:numeric)')
    assert.equal(await claims.getByTestId('claim-link').last().getAttribute('data-original'), '[7](scholarseed-cite:list)')
    assert.equal(await claims.locator('[data-scholarseed-citation-claim]').first().evaluate(node => getComputedStyle(node).fontWeight), '700')

    const originalCitation = await page.getByTestId('pdf-citation').elementHandle()
    await page.getByRole('button', { name: '刷新父组件 0' }).click()
    assert.equal(await originalCitation?.evaluate(node => node.isConnected), true)
    assert.equal(await page.getByRole('button', { name: '刷新父组件 1' }).count(), 1)

    const sourceLeaf = page.locator('code [data-md-source-start]').first()
    await assert.equal(await sourceLeaf.getAttribute('data-md-source-start'), '9')
    await assert.equal(await sourceLeaf.getAttribute('data-md-source-end'), '17')

    const evidence = page.getByTestId('evidence-reference')
    assert.equal(await evidence.getAttribute('aria-label'), '支持充分，引用 [1]')
    await evidence.click()
    const originalEvidence = await evidence.elementHandle()
    const card = page.getByRole('region', { name: '关联论断卡片' })
    assert.ok((await card.textContent())?.includes('外部网页来源；未下载本地副本。'))
    assert.equal(await page.getByRole('checkbox', { name: '已完成', exact: true }).isChecked(), true)
    assert.equal(await page.getByRole('checkbox', { name: '未完成', exact: true }).isChecked(), false)
    await page.getByRole('button', { name: 'Switch to English' }).click()
    assert.equal(await originalEvidence?.evaluate(node => node.isConnected), true)
    assert.equal(await evidence.getAttribute('aria-expanded'), 'true')
    assert.equal(await evidence.getAttribute('aria-label'), 'Well supported, citation [1]')
    const englishCard = page.getByRole('region', { name: 'Related claim card' })
    assert.ok((await englishCard.textContent())?.includes('External web source; no local copy has been downloaded.'))
    assert.ok((await englishCard.textContent())?.includes('example.com'))
    assert.ok((await englishCard.textContent())?.includes('postgres'))
    assert.equal(await englishCard.getByRole('button', { name: 'Open original' }).count(), 1)
    assert.equal(await page.getByRole('checkbox', { name: 'Completed', exact: true }).isChecked(), true)
    assert.equal(await page.getByRole('checkbox', { name: 'Not completed', exact: true }).isChecked(), false)
    assert.equal(await page.getByTestId('localized-markdown').locator('.md-image-placeholder').textContent(), 'Image')
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
    assert.equal(await floating.boundingBox().then(box => box?.width), afterResize!.width)
    assert.equal(await page.getByRole('separator', { name: '调整浮层大小' }).count(), 1)
    await page.getByRole('button', { name: '关闭用户标题', exact: true }).click()
    assert.equal(await floating.count(), 0)
    assert.equal(await evidence.getAttribute('aria-expanded'), 'true')

  } finally {
    await browser?.close()
    await server.close()
  }
})
