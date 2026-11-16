import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../test-helpers/render.ts'

test('restored clipboard metadata is unavailable without damaging current File objects or reference identity', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  try {
    const page = await fixture.browser.newPage()
    const requests: string[] = []
    page.on('request', (request) => {
      if (
        request.url().includes('/api/workbench/') ||
        request.url().includes('clip-text') ||
        request.url().includes('clip-image')
      )
        requests.push(request.url())
    })
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const draft = page.getByTestId('clipboard-draft')
    const text = draft.getByTestId('message-attachment-clip-text')
    await expect(text).toBeVisible()
    await expect(text.getByText('文件不可用')).toHaveCount(0)
    await expect(draft.getByRole('img', { name: 'clipboard.svg', exact: true })).toBeVisible()
    await draft.getByRole('button', { name: 'Restore clipboard metadata', exact: true }).click()
    await expect(text.getByText('文件不可用')).toBeVisible()
    await expect(draft.getByRole('img', { name: 'clipboard.svg', exact: true })).toHaveCount(0)
    await text.hover()
    await text.getByRole('button', { name: '移除附件 clipboard.txt', exact: true }).click()
    await expect(text).toHaveCount(0)
    await draft.getByRole('button', { name: 'Readd clipboard files', exact: true }).click()
    await expect(text).toBeVisible()
    await expect(text.getByText('文件不可用')).toHaveCount(0)
    await expect(draft.getByRole('img', { name: 'clipboard.svg', exact: true })).toBeVisible()
    assert.deepEqual(requests, [])
  } finally {
    await fixture.close()
  }
})

test('restored draft validates the same reference and retains removal and recovery', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  try {
    const page = await fixture.browser.newPage()
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const draft = page.getByTestId('draft-validation')
    const card = draft.getByTestId('message-attachment-1')
    await expect(card).toBeVisible()
    await expect(card.getByText('文件不可用')).toHaveCount(0)
    for (const session of ['missing', 'mismatch', 'wrong-kind']) {
      await draft.getByRole('button', { name: `${session} draft`, exact: true }).click()
      await expect(card.getByText('文件不可用')).toBeVisible()
      await expect(
        card.getByRole('button', { name: 'experiment-1.pdf', exact: true })
      ).toBeEnabled()
    }
    await card.hover()
    await card.getByRole('button', { name: '移除附件 experiment-1.pdf' }).click()
    await expect(card).toHaveCount(0)
    await draft.getByRole('button', { name: 'valid draft', exact: true }).click()
    await draft.getByRole('button', { name: 'Readd draft', exact: true }).click()
    await expect(card).toBeVisible()
    await expect(card.getByText('文件不可用')).toHaveCount(0)
    await card.getByRole('button', { name: 'experiment-1.pdf', exact: true }).click()
    await expect(page.getByTestId('opened')).toHaveText('/experiment/1.pdf')
  } finally {
    await fixture.close()
  }
})

test('late validation cannot mark a different restored draft unavailable', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  let release: (() => void) | undefined
  try {
    const page = await fixture.browser.newPage()
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/sessions/delayed/file-references/location?*', async (route) => {
      await delayed
      await route.fulfill({
        status: 404,
        json: { ok: false, error: 'session_attachment_not_found' },
      })
    })
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const draft = page.getByTestId('draft-validation')
    const request = page.waitForRequest('**/sessions/delayed/file-references/location?*')
    await draft.getByRole('button', { name: 'delayed draft', exact: true }).click()
    await request
    await draft.getByRole('button', { name: 'valid draft', exact: true }).click()
    const response = page.waitForResponse('**/sessions/delayed/file-references/location?*')
    release?.()
    await response
    await expect(draft.getByTestId('message-attachment-1')).toBeVisible()
    await expect(draft.getByText('文件不可用')).toHaveCount(0)
  } finally {
    release?.()
    await fixture.close()
  }
})

test('draft file, annotation and selection cards share top and bottom edges', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  try {
    const page = await fixture.browser.newPage()
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const row = page.getByTestId('draft-alignment')
    await expect(row.getByText('Annotation', { exact: true })).toBeVisible()
    const composer = readFileSync(new URL('./business/Composer.tsx', import.meta.url), 'utf8')
    const trayClasses = composer.match(/!home && !inline \? '(\[&_[^']+)'/)
    assert.ok(trayClasses)
    await row.evaluate(
      (element, classes) => element.classList.add(...classes.split(' ')),
      trayClasses[1]
    )
    const bounds = await row.locator('.group\\/attachment').evaluateAll((elements) =>
      elements.map((element) => {
        const card = element.getBoundingClientRect()
        return { top: card.top, bottom: card.bottom, height: card.height }
      })
    )
    assert.equal(bounds.length, 5)
    for (const reference of bounds.slice(1)) assert.deepEqual(bounds[0], reference)
  } finally {
    await fixture.close()
  }
})

test('draft and sent reference typography and text insets match file cards', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  try {
    const page = await fixture.browser.newPage()
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const row = page.getByTestId('draft-alignment')
    await expect(row.getByText('Sent selection', { exact: true })).toBeVisible()
    const styles = await row.locator('.group\\/attachment').evaluateAll((elements) =>
      elements.map((element, index) => {
        const title =
          index === 0
            ? element.querySelector('[data-slot="attachment-name-end"]')!
            : element.querySelector('.flex-col > span:first-child')!
        const description =
          index === 0
            ? element.querySelector('[data-slot="attachment-format"]')!
            : element.querySelector('.flex-col > span:last-child')!
        const card = element.getBoundingClientRect()
        return [title, description].map((text) => {
          const computed = getComputedStyle(text)
          const rect = text.getBoundingClientRect()
          return {
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            lineHeight: computed.lineHeight,
            color: computed.color,
            top: rect.top - card.top,
            left: rect.left - card.left,
          }
        })
      })
    )
    assert.equal(styles.length, 5)
    for (const reference of styles.slice(1)) assert.deepEqual(styles[0], reference)
  } finally {
    await fixture.close()
  }
})

test('sent attachment rows reuse composer horizontal overflow controls in the transcript and preview', () => {
  for (const [file, marker] of [
    ['business/Stream.tsx', 'sent-context-layer-references'],
    ['business/Stream.tsx', 'sent-context-layer-selections'],
    ['examples/ComponentsPage.tsx', 'sent-attachments-preview'],
  ]) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    let controlled = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(source) === 'ScrollArea' &&
        node.getText(source).includes(marker)
      ) {
        controlled = node.openingElement.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === 'horizontalControls' &&
            attribute.getText(source).includes('attachments.scrollPrevious') &&
            attribute.getText(source).includes('attachments.scrollNext')
        )
      }
      node.forEachChild(visit)
    }
    visit(source)
    assert.ok(controlled, `${file} must reuse the composer attachment overflow controls`)
  }
})

test('transcript wiring keeps selections, images and files in separate ordered rows before text', () => {
  const source = ts.createSourceFile(
    'Stream.tsx',
    readFileSync(new URL('./business/Stream.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let user: ts.FunctionDeclaration | undefined
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'UserBubble') user = node
  })
  assert.ok(user)
  let bubble: ts.JsxElement | undefined
  let text: ts.JsxSelfClosingElement | undefined
  const attachments: ts.JsxSelfClosingElement[] = []
  let references: ts.JsxElement | undefined
  let selections: ts.JsxSelfClosingElement | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.attributes.properties.some(
        (property) =>
          ts.isJsxAttribute(property) &&
          property.name.getText(source) === 'data-testid' &&
          property.initializer &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === 'sent-context-layer-references'
      )
    )
      references = node
    if (
      ts.isJsxElement(node) &&
      node.openingElement.attributes.properties.some(
        (property) =>
          ts.isJsxAttribute(property) &&
          property.name.getText(source) === 'data-testid' &&
          property.initializer &&
          ts.isJsxExpression(property.initializer) &&
          property.initializer.expression &&
          ts.isConditionalExpression(property.initializer.expression) &&
          ts.isStringLiteral(property.initializer.expression.whenTrue) &&
          property.initializer.expression.whenTrue.text === 'user-bubble'
      )
    )
      bubble = node
    if (ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(source) === 'UserMessageText') text = node
      if (node.tagName.getText(source) === 'SentAttachments') attachments.push(node)
      if (node.tagName.getText(source) === 'SelectionReferences') selections = node
    }
    node.forEachChild(visit)
  }
  visit(user)
  assert.ok(bubble && text)
  assert.equal(attachments.length, 2)
  assert.ok(references && selections)
  assert.ok(attachments[0].end < references.pos)
  assert.ok(selections.end < attachments[0].pos)
  assert.ok(
    attachments[1].pos > references.openingElement.end &&
      attachments[1].end < references.closingElement.pos
  )
  assert.ok(attachments[0].end < attachments[1].pos)
  assert.ok(attachments[1].end < bubble.pos)
  assert.ok(text.pos > bubble.openingElement.end && text.end < bubble.closingElement.pos)
})

test('file references wrap without caps, preserve filename endings and expose directory actions', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  const context = await fixture.browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const tray = page.getByTestId('files')
    await expect(
      page.getByTestId('resource-files').locator('[data-slot="attachment-format"]')
    ).toHaveText('PDF ·资料')
    await expect(
      page.getByTestId('local-files').locator('[data-slot="attachment-format"]')
    ).toHaveText('PDF')
    await expect(
      page.getByTestId('literature-files').locator('[data-slot="attachment-format"]')
    ).toHaveText('PDF ·文献')
    for (const testId of ['resource-files', 'literature-files', 'local-files']) {
      await expect(page.getByTestId(testId).getByRole('button', { name: /^附件操作/ })).toHaveCount(
        0
      )
    }
    await expect(
      page
        .getByTestId('literature-files')
        .getByRole('button', { name: 'A paper without an extension', exact: true })
    ).toBeVisible()
    const cards = tray.locator('[data-testid^="message-attachment-"]')
    await expect(cards).toHaveCount(41)
    assert.equal(await tray.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    const first = (await cards.first().boundingBox())!
    const last = (await cards.last().boundingBox())!
    assert.ok(last.y > first.y)
    const longName = tray.getByTestId('message-attachment-0')
    await expect(longName.locator('.group').first()).toHaveCSS('height', '44px')
    await expect(longName.locator('img')).toHaveCSS('width', '32px')
    await expect(longName.getByText('Excel', { exact: true })).toBeVisible()
    const remove = longName.getByRole('button', { name: /移除附件/ })
    await expect(remove).toHaveCSS('opacity', '0')
    await longName.hover()
    await expect(remove).toHaveCSS('opacity', '1')
    await expect(remove).toHaveCSS('border-radius', '50%')
    await expect(remove).toHaveCSS('width', '16px')
    await expect(remove.locator('svg')).toHaveCSS('width', '12px')
    await expect(remove.locator('svg')).toHaveCSS('height', '12px')
    const cardBounds = (await longName.boundingBox())!
    const removeBounds = (await remove.boundingBox())!
    assert.ok(removeBounds.y < cardBounds.y)
    assert.ok(removeBounds.x + removeBounds.width > cardBounds.x + cardBounds.width)
    await expect(longName.locator('[data-slot="attachment-name-end"]')).toHaveText(/\.results$/)
    await tray.getByRole('button', { name: '实验资料.v2', exact: true }).press('Enter')
    await expect(page.getByTestId('opened')).toHaveText('/experiment')
    await expect(tray.getByRole('button', { name: 'notes#hash?.txt', exact: true })).toBeAttached()
    await page.setViewportSize({ width: 260, height: 900 })
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    assert.equal(await tray.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    await expect(tray.getByRole('button', { name: 'Menu folder', exact: true })).toBeAttached()
    await tray.getByRole('button', { name: '实验资料.v2', exact: true }).hover()
    await tray.getByRole('button', { name: '移除附件 实验资料.v2' }).click()
    await expect(cards).toHaveCount(40)
    await expect(page.getByTestId('opened')).toHaveText('/experiment')
  } finally {
    await context.close()
    await fixture.close()
  }
})

test('sent file and folder references stay in one scrollable row without remove buttons', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  const context = await fixture.browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const strip = page.getByTestId('sent-files')
    const cards = strip.locator('[data-testid^="message-attachment-"]')
    await expect(cards).toHaveCount(41)
    const first = (await cards.first().boundingBox())!
    const last = (await cards.last().boundingBox())!
    assert.equal(first.y, last.y)
    assert.ok(last.x > first.x + first.width)
    await expect(strip.getByRole('button', { name: /移除附件/ })).toHaveCount(0)
    await expect(strip.locator('[data-slot="attachment-format"]')).toHaveCount(0)
    await strip.getByRole('button', { name: 'experiment-39.pdf', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('opened')).toHaveText('/experiment/39.pdf')
    await strip.getByRole('button', { name: '实验资料.v2', exact: true }).click()
    await expect(page.getByTestId('opened')).toHaveText('/experiment')
  } finally {
    await context.close()
    await fixture.close()
  }
})

test('sent menus are type-specific, native actions use verified originals and cancellation is not success', async () => {
  const fixture = await renderFixture(path.resolve(import.meta.dirname, '..'))
  const context = await fixture.browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(`${fixture.url}components/files.render.fixture.html`)
    const menu = page.getByTestId('menus')
    const attachment = menu.getByTestId('message-attachment-folder')
    const name = attachment.locator('[data-slot="attachment-name-end"]')
    const idleBounds = (await attachment.boundingBox())!
    const textBounds = (await name.boundingBox())!
    const iconBounds = (await attachment.locator('svg').first().boundingBox())!
    assert.ok(textBounds.x - (iconBounds.x + iconBounds.width) < 10)
    await menu.getByTestId('message-attachment-folder').hover()
    const hoverBounds = (await attachment.boundingBox())!
    const hoverTextBounds = (await name.boundingBox())!
    assert.equal(hoverBounds.width, idleBounds.width)
    assert.ok(hoverTextBounds.width < textBounds.width)
    await menu.getByRole('button', { name: '附件操作 实验资料.v2', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '另存为…', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: '打开方式', exact: true })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '导入资料库', exact: true }).click()
    await expect(page.getByTestId('opened')).toHaveText('import:folder')
    await menu.getByTestId('message-attachment-1').hover()
    await menu.getByRole('button', { name: '附件操作 experiment-1.pdf', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '导入资料库', exact: true })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '复制路径', exact: true }).click()
    await expect(page.getByTestId('opened')).toHaveText('copy:/experiment/1.pdf')
    await page.getByRole('button', { name: '关闭通知' }).click()
    await menu.getByTestId('message-attachment-1').hover()
    await menu.getByRole('button', { name: '附件操作 experiment-1.pdf', exact: true }).click()
    await page.getByRole('menuitem', { name: '另存为…', exact: true }).click()
    await expect(page.getByTestId('opened')).toHaveText('canceled')
    await expect(page.getByText('文件操作成功', { exact: true })).toHaveCount(0)
    await page.getByTestId('fallback').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.getByTestId('opened')).toHaveText('open:/experiment/1.pdf')
    await page.getByRole('button', { name: 'Unavailable', exact: true }).click()
    await menu.getByRole('button', { name: '实验资料.v2', exact: true }).click()
    await expect(page.getByText(/文件操作失败/)).toBeVisible()
    await expect(menu.locator('[data-testid^="message-attachment-"]')).toHaveCount(2)
    await expect(page.getByTestId('opened')).toHaveText('open:/experiment/1.pdf')
  } finally {
    await context.close()
    await fixture.close()
  }
})
