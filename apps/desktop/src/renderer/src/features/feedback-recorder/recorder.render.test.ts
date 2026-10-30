import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { chromium, expect, type Browser } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = path.resolve(root, '../../../../tmp/feedback-ui')
test('recorder pagination, pause, annotation undo and failure recovery', async () => {
  const server = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    await page.goto(
      new URL(
        '/src/features/feedback-recorder/recorder.render.fixture.html',
        server.resolvedUrls!.local[0]
      ).toString()
    )
    const iconFonts = await page.evaluate(
      async () => (await document.fonts.load('14px iconfont')).length
    )
    assert.ok(iconFonts > 0)
    const rows = page.getByTestId('feedback-recorder-steps').getByRole('listitem')
    const note = page.getByTestId('feedback-recorder-note')
    await expect(page.getByTestId('feedback-recorder-note-submit')).toHaveCount(0)
    await expect(note).toHaveAttribute('maxlength', '500')
    await expect(page.getByTestId('feedback-recorder-screenshot')).toHaveClass(
      /vds-button--tertiary/
    )
    const stop = page.getByTestId('feedback-recorder-stop')
    await expect(stop).toHaveText('提交')
    await expect(stop).toHaveClass(/vds-button--primary/)
    await expect(
      page.getByTestId('feedback-recorder-status-bar').getByTestId('feedback-recorder-stop')
    ).toHaveCount(0)
    const exit = page.getByTestId('feedback-recorder-exit')
    await expect(exit).toHaveText('退出')
    await expect(exit).toHaveClass(/vds-button--outline/)
    const exitBounds = (await exit.boundingBox())!
    const inputBounds = (await page.getByTestId('feedback-recorder-note-section').boundingBox())!
    assert.ok(exitBounds.y >= inputBounds.y + inputBounds.height)
    assert.ok(exitBounds.x > inputBounds.x + inputBounds.width / 2)
    const stopBounds = (await stop.boundingBox())!
    assert.equal(stopBounds.y, exitBounds.y)
    assert.ok(stopBounds.x >= exitBounds.x + exitBounds.width)

    await expect(page.getByTestId('feedback-recorder-cancel')).toHaveCount(0)
    await expect(page.getByTestId('feedback-recorder-note-section')).toHaveCSS(
      'border-top-width',
      '0px'
    )
    assert.equal(
      await note.evaluate((node) => getComputedStyle(node, '::placeholder').fontWeight),
      '400'
    )

    await expect(page.getByTestId('feedback-recorder-status-bar')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)'
    )
    await expect(page.getByTestId('feedback-recorder-status-dot')).toHaveCount(0)
    await expect(page.getByTestId('feedback-recorder-header-count')).toHaveText('已记录 1 步')

    await expect(page.getByTestId('feedback-recorder-steps-toggle')).toHaveCSS('font-size', '12px')
    await expect(page.getByText('已记录 1 步', { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('feedback-recorder-steps-toggle')).toHaveCSS('column-gap', '6px')
    await expect(rows.first()).toHaveCSS('font-weight', '400')
    const pager = page.getByTestId('feedback-recorder-step-pager')
    await expect(pager).toHaveCount(0)
    await page.getByTestId('feedback-recorder-steps-toggle').click()
    await expect(pager).toHaveCount(0)
    await page.getByTestId('feedback-recorder-steps-toggle').click()

    const statusBottom = await page
      .getByTestId('feedback-recorder-status-bar')
      .evaluate((node) => node.getBoundingClientRect().bottom)
    const inputTop = await page
      .getByTestId('feedback-recorder-note-section')
      .locator(':scope > div')
      .first()
      .evaluate((node) => node.getBoundingClientRect().top)
    const stepBounds = (await page.getByTestId('feedback-recorder-step-section').boundingBox())!
    assert.ok(stepBounds.y >= statusBottom)
    assert.equal(inputTop - stepBounds.y - stepBounds.height, 16)
    await note.fill('第一行\n第二行\n第三行')
    assert.ok(
      await note.evaluate((node: HTMLTextAreaElement) => node.scrollHeight <= node.clientHeight)
    )
    await note.fill('第一行\n第二行\n第三行\n第四行')
    assert.ok(
      await note.evaluate((node: HTMLTextAreaElement) => node.scrollHeight > node.clientHeight)
    )
    await expect(note).toHaveAttribute('placeholder', '请输入当前步骤的问题描述，后台将自动记录')
    await page.getByTestId('feedback-recorder-submitted-note').hover()
    await expect(page.getByRole('tooltip')).toHaveText('第一行\n第二行\n第三行\n第四行')
    await note.fill('自动记录说明')
    await note.press('Enter')
    await expect(note).toHaveValue('自动记录说明\n')
    await page.getByTestId('feedback-recorder-submitted-note').hover()
    await expect(page.getByRole('tooltip')).toContainText('自动记录说明')
    await note.fill('自动保留的草稿')
    await note.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await page.getByTestId('feedback-recorder-submitted-note').hover()
    await expect(page.getByRole('tooltip')).toContainText('自动保留的草稿')
    await note.press('Shift+Enter')
    await expect(note).toHaveValue('自动保留的草稿\n')
    await note.fill('第二次提交')
    await page.getByRole('button', { name: '暂停记录', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toContainText('暂停记录')
    const fixedRow = await rows.elementHandle()
    for (const name of ['新任务', '搜索文献', '项目文件', '文献库', '任务列表', '项目总览']) {
      await page.getByRole('button', { name, exact: true }).click()
      await expect(rows).toHaveCount(1)
      await expect(rows).toContainText(name)
    }
    assert.ok(await fixedRow!.evaluate((node) => node.isConnected))
    assert.equal(await rows.evaluate((node) => getComputedStyle(node).animationName), 'none')
    await expect(pager).toHaveCount(0)
    await page.getByTestId('feedback-recorder-steps-toggle').click()
    await expect(pager).toBeVisible()
    const countBounds = (await page.getByTestId('feedback-recorder-steps-toggle').boundingBox())!
    const pagerBounds = (await pager.boundingBox())!
    assert.ok(pagerBounds.x > countBounds.x + countBounds.width)
    assert.ok(
      Math.abs(pagerBounds.y + pagerBounds.height / 2 - countBounds.y - countBounds.height / 2) < 1
    )
    await expect(page.getByRole('button', { name: '上一页操作步骤' })).toBeDisabled()
    await expect(rows).toHaveCount(5)
    const truncatedStep = rows.first().locator('[data-slot="ellipsis-text"]')
    await truncatedStep.evaluate((node: HTMLElement) => {
      node.style.maxWidth = '160px'
    })
    await expect
      .poll(() => truncatedStep.evaluate((node) => node.scrollWidth > node.clientWidth))
      .toBe(true)
    await truncatedStep.hover()
    const stepTooltip = page.getByRole('tooltip')
    await expect(stepTooltip).toContainText('navigation')
    assert.ok(Number(await stepTooltip.evaluate((node) => getComputedStyle(node).zIndex)) > 9001)
    assert.equal(
      await stepTooltip.evaluate((node: HTMLElement) => {
        // Tooltips pass through pointers; temporarily enable hit testing without changing stacking.
        const previous = node.style.pointerEvents
        node.style.pointerEvents = 'auto'
        try {
          const bounds = node.getBoundingClientRect()
          return node.contains(
            document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 4)
          )
        } finally {
          node.style.pointerEvents = previous
        }
      }),
      true
    )
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ animations: 'disabled', path: path.join(evidence, 'step-tooltip.png') })
    await truncatedStep.evaluate((node: HTMLElement) => node.style.removeProperty('max-width'))

    await rows.first().getByRole('button', { name: '查看问题说明' }).hover()
    await expect(page.getByRole('tooltip')).toContainText('第二次提交')
    await expect(page.getByRole('button', { name: '上一页操作步骤' })).toBeDisabled()
    await page.getByRole('button', { name: '下一页操作步骤' }).click()
    await expect(rows).toHaveCount(2)
    await page.getByTestId('feedback-recorder-steps-toggle').click()
    await expect(rows).toHaveCount(1)
    await expect(pager).toHaveCount(0)
    await page.getByTestId('feedback-recorder-steps-toggle').click()
    await expect(rows).toHaveCount(5)
    await expect(rows.first()).toContainText('1.')
    await expect(page.getByRole('button', { name: '上一页操作步骤' })).toBeDisabled()
    await page.getByRole('button', { name: '下一页操作步骤' }).click()
    await expect(rows).toHaveCount(2)
    await page.getByRole('button', { name: '暂停记录', exact: true }).click()
    await expect(page.getByTestId('feedback-recorder-status-dot')).toHaveCount(0)
    await expect(page.getByTestId('feedback-recorder-header-count')).toHaveText('已记录 7 步')

    await page.getByRole('button', { name: '新任务', exact: true }).click()
    await expect(page.getByTestId('feedback-recorder-header-count')).toBeVisible()
    await page.getByRole('button', { name: '继续记录', exact: true }).click()
    await page.getByRole('button', { name: '新任务', exact: true }).click()
    await expect(page.getByTestId('feedback-recorder-header-count')).toHaveText('已记录 8 步')
    await page.getByRole('button', { name: '上一页操作步骤' }).click()
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ animations: 'disabled', path: path.join(evidence, 'steps.png') })
    await page.getByRole('button', { name: '模拟提交成功' }).click()
    const shutterStarted = Date.now()
    await page.getByTestId('feedback-recorder-screenshot').click()
    const shutter = page.getByTestId('feedback-recorder-shutter')
    await expect(shutter).toBeVisible()
    await expect(page.getByTestId('feedback-recorder-screenshot')).toBeDisabled()
    await expect(exit).toBeDisabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const flash = shutter.locator('div').first()
    await expect(flash).toHaveCSS('animation-duration', '1s')
    await shutter.evaluate((node) =>
      node.getAnimations({ subtree: true }).forEach((animation) => {
        animation.pause()
        animation.currentTime = 180
      })
    )
    await page.screenshot({ path: path.join(evidence, 'shutter.png') })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    assert.ok(Date.now() - shutterStarted >= 900 && Date.now() - shutterStarted < 2500)
    await expect(shutter).toHaveCount(0)
    await dialog.getByRole('button', { name: '文字', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveText('文字')
    await dialog.getByRole('button', { name: '复制图片', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveText('复制图片')
    const screenshotNote = dialog.getByRole('textbox', { name: '问题说明', exact: true })
    await screenshotNote.fill('第一行\n第二行\n第三行')
    assert.ok(
      await screenshotNote.evaluate(
        (node: HTMLTextAreaElement) => node.scrollHeight <= node.clientHeight
      )
    )
    const labelStyle = await dialog
      .locator('label[for="feedback-screenshot-note"]')
      .evaluate((node) => ({
        weight: getComputedStyle(node).fontWeight,
        size: getComputedStyle(node).fontSize,
      }))
    assert.deepEqual(labelStyle, { weight: '400', size: '14px' })
    const bounds = await dialog.boundingBox()
    assert.ok(bounds && bounds.width < 1280 && bounds.height < 900)
    await page.getByRole('textbox', { name: '问题说明', exact: true }).fill('保留标注说明')
    const canvasElement = dialog.locator('canvas')
    const fitBounds = await canvasElement.boundingBox()
    assert.ok(fitBounds)
    const viewport = dialog.getByTestId('feedback-annotator-viewport')
    for (const name of ['矩形', '文字', '画笔', '箭头', '遮挡'])
      await expect(dialog.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    await expect(viewport).toHaveCSS('cursor', 'grab')
    const area = (await viewport.boundingBox())!
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
    await page.mouse.down()
    await page.mouse.move(area.x + area.width / 2 + 40, area.y + area.height / 2 + 25)
    await expect(viewport).toHaveCSS('cursor', 'grabbing')
    await page.mouse.up()
    const panned = (await canvasElement.boundingBox())!
    assert.ok(
      Math.abs(panned.x - fitBounds.x - 40) < 1 && Math.abs(panned.y - fitBounds.y - 25) < 1
    )
    await expect(dialog.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
    const anchor = { x: area.x + area.width / 2 + 60, y: area.y + area.height / 2 + 30 }
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.wheel(0, -140)
    await expect
      .poll(async () => (await canvasElement.boundingBox())!.width)
      .toBeGreaterThan(panned.width)
    const wheeled = (await canvasElement.boundingBox())!
    assert.ok(
      Math.abs((anchor.x - wheeled.x) / wheeled.width - (anchor.x - panned.x) / panned.width) <
        0.002
    )
    assert.ok(
      Math.abs((anchor.y - wheeled.y) / wheeled.height - (anchor.y - panned.y) / panned.height) <
        0.002
    )
    await page.mouse.wheel(0, 140)
    await expect
      .poll(async () => (await canvasElement.boundingBox())!.width)
      .toBeLessThan(wheeled.width)
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    const recentered = (await canvasElement.boundingBox())!
    assert.ok(Math.abs(recentered.x - fitBounds.x) < 1 && Math.abs(recentered.y - fitBounds.y) < 1)
    await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
    await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
    const zoomBounds = await canvasElement.boundingBox()
    assert.ok(zoomBounds && zoomBounds.width > fitBounds.width)
    assert.deepEqual(
      await canvasElement.evaluate((node: HTMLCanvasElement) => [node.width, node.height]),
      [1440, 740]
    )
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2)
    await page.mouse.down()
    await page.mouse.move(area.x + area.width / 2 + 20, area.y + area.height / 2 + 15)
    await page.mouse.up()
    await dialog.getByRole('button', { name: '矩形', exact: true }).click()
    const settings = page.getByTestId('feedback-annotator-tool-settings')
    await expect(settings).toBeVisible()
    await expect(settings.locator('select')).toHaveCount(0)
    await expect(settings).toHaveCSS('flex-direction', 'row')
    const toolBounds = (await dialog
      .getByRole('button', { name: '矩形', exact: true })
      .boundingBox())!
    const settingsBounds = (await settings.boundingBox())!
    assert.ok(settingsBounds.y >= toolBounds.y + toolBounds.height)
    assert.ok(settingsBounds.width > settingsBounds.height * 4)
    await settings.getByRole('button', { name: '描边 12px', exact: true }).click()
    await settings.getByRole('button', { name: '蓝色', exact: true }).click()
    await expect(settings.getByRole('button', { name: '蓝色', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'annotation-tools.png'),
    })
    const drawAt = { x: area.x + 100, y: area.y + 130 }
    await page.mouse.move(drawAt.x, drawAt.y)
    await page.mouse.down()
    await page.mouse.move(drawAt.x + 100, drawAt.y + 50)
    await page.mouse.up()
    const zoomStroke = await canvasElement.evaluate((node: HTMLCanvasElement, position) => {
      const bounds = node.getBoundingClientRect()
      const x = Math.round(((position.x + 50 - bounds.x) * node.width) / bounds.width)
      const y = Math.round(((position.y - bounds.y) * node.height) / bounds.height)
      return [...node.getContext('2d')!.getImageData(x, y, 1, 1).data]
    }, drawAt)
    assert.ok(zoomStroke[2] > zoomStroke[0] && zoomStroke[2] > zoomStroke[1])
    const wideStroke = await canvasElement.evaluate((node: HTMLCanvasElement, position) => {
      const bounds = node.getBoundingClientRect()
      const x = Math.round(((position.x + 50 - bounds.x) * node.width) / bounds.width)
      const y = Math.round(((position.y - bounds.y) * node.height) / bounds.height) + 4
      return [...node.getContext('2d')!.getImageData(x, y, 1, 1).data]
    }, drawAt)
    assert.ok(wideStroke[2] > wideStroke[0] && wideStroke[2] > wideStroke[1])
    await expect(settings).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'annotator-zoom.png'),
    })
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await dialog.getByRole('button', { name: '缩小图片', exact: true }).click()
    const smallerBounds = await canvasElement.boundingBox()
    assert.ok(smallerBounds && smallerBounds.width < zoomBounds.width)
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    const resetBounds = await canvasElement.boundingBox()
    assert.ok(resetBounds && Math.abs(resetBounds.width - fitBounds.width) < 1)
    const canvas = await dialog.locator('canvas').boundingBox()
    assert.ok(canvas)
    await page.mouse.move(canvas.x + 100, canvas.y + 80)
    await page.mouse.down()
    await page.mouse.move(canvas.x + 200, canvas.y + 130)
    await page.mouse.up()
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '矩形', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '矩形', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    await expect(viewport).toHaveCSS('cursor', 'grab')

    await page.getByRole('button', { name: '保存截图', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('截图提交失败')
    await expect(page.getByRole('textbox', { name: '问题说明', exact: true })).toHaveValue(
      '保留标注说明'
    )
    await dialog.getByRole('button', { name: '取消', exact: true }).last().click()
    await page.getByRole('button', { name: '模拟提交失败' }).click()
    await page.getByTestId('feedback-recorder-screenshot').click()
    await expect(dialog).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: path.join(evidence, 'annotator.png') })
    await expect(dialog.getByRole('textbox', { name: '问题说明', exact: true })).toHaveAttribute(
      'maxlength',
      '500'
    )
    const newCanvas = dialog.locator('canvas')
    const newBounds = (await newCanvas.boundingBox())!
    await dialog.getByRole('button', { name: '文字', exact: true }).click()
    await page
      .getByTestId('feedback-annotator-tool-settings')
      .getByRole('combobox', { name: '文本字号', exact: true })
      .click()
    await page.getByRole('option', { name: '48px', exact: true }).click()
    const textSettings = page.getByTestId('feedback-annotator-tool-settings')
    const fontBounds = (await textSettings
      .getByRole('combobox', { name: '文本字号', exact: true })
      .boundingBox())!
    const redBounds = (await textSettings
      .getByRole('button', { name: '红色', exact: true })
      .boundingBox())!
    assert.ok(redBounds.x >= fontBounds.x + fontBounds.width)
    const chevronBounds = (await textSettings.locator('.vds-select__trigger-icon').boundingBox())!
    assert.ok(fontBounds.x + fontBounds.width - chevronBounds.x - chevronBounds.width <= 10)
    const valueBounds = (await textSettings.locator('.vds-select__trigger-value').boundingBox())!
    await expect
      .poll(async () => {
        const arrow = (await textSettings.locator('.vds-select__trigger-icon').boundingBox())!
        return Math.round(arrow.x - valueBounds.x - valueBounds.width)
      })
      .toBe(8)

    await expect(textSettings.getByRole('button', { name: '白色', exact: true })).toHaveCount(0)
    await expect(textSettings.getByRole('button', { name: '灰色', exact: true })).toBeInViewport()
    assert.equal(await textSettings.evaluate((node) => node.scrollWidth <= node.clientWidth), true)
    await textSettings.getByRole('combobox', { name: '文本字号', exact: true }).click()
    const sizes = page.getByRole('listbox')
    await expect(sizes).toHaveCSS('border-radius', '8px')
    await expect(sizes.getByRole('option')).toHaveCount(7)
    assert.equal(await sizes.evaluate((node) => node.scrollHeight <= node.clientHeight), true)
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'annotation-font-menu.png'),
    })
    await sizes.getByRole('option', { name: '48px', exact: true }).click()
    await expect(page.getByTestId('feedback-annotator-surface')).toHaveCSS(
      'background-image',
      'none'
    )
    await expect(page.getByTestId('feedback-annotator-surface')).toHaveCSS(
      'background-color',
      'rgba(103, 73, 15, 0.14)'
    )
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'annotation-text-tools.png'),
    })
    await page
      .getByTestId('feedback-annotator-tool-settings')
      .getByRole('button', { name: '绿色', exact: true })
      .click()
    await page.mouse.click(newBounds.x + 300, newBounds.y + 200)
    await expect(page.getByTestId('feedback-recorder-annotation-text')).toHaveAttribute(
      'maxlength',
      '500'
    )
    await page.getByTestId('feedback-recorder-annotation-text').fill('字号与颜色保留')
    await page.getByTestId('feedback-recorder-annotation-text').press('Enter')
    await dialog.getByRole('button', { name: '遮挡', exact: true }).click()
    await expect(page.getByTestId('feedback-annotator-tool-settings')).toHaveCount(0)
    await page.mouse.move(newBounds.x + 50, newBounds.y + 150)
    await page.mouse.down()
    await page.mouse.move(newBounds.x + 120, newBounds.y + 190)
    await page.mouse.up()
    assert.deepEqual(
      await newCanvas.evaluate(
        (node: HTMLCanvasElement, position) => {
          const bounds = node.getBoundingClientRect()
          const x = Math.round(((position.x - bounds.x) * node.width) / bounds.width)
          const y = Math.round(((position.y - bounds.y) * node.height) / bounds.height)
          return [...node.getContext('2d')!.getImageData(x, y, 1, 1).data]
        },
        { x: newBounds.x + 80, y: newBounds.y + 170 }
      ),
      [255, 255, 255, 255]
    )
    const styledPixels = await newCanvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())

    await page.getByRole('button', { name: '保存截图', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('截图已记录，继续记录中', { exact: true })).toBeVisible()
    await expect(rows.last().getByTestId('feedback-recorder-submitted-note')).toBeVisible()
    await rows.last().getByTestId('feedback-recorder-submitted-note').hover()
    await expect(page.getByRole('tooltip')).toContainText('已提交 1 张截图标记')
    await page.mouse.move(50, 300)

    for (let image = 0; image < 3; image += 1) {
      if (image === 0) {
        const mac = await page.evaluate(() => /Mac/i.test(navigator.platform))
        await page.keyboard.press(mac ? 'Meta+Shift+S' : 'Control+Shift+S')
        await expect(page.getByTestId('feedback-recorder-shutter')).toBeVisible()
      } else await page.getByTestId('feedback-recorder-screenshot').click()
      await page.getByRole('button', { name: '保存截图', exact: true }).click()
    }
    await page.getByRole('button', { name: '模拟提交成功' }).click()
    await page.getByTestId('feedback-recorder-stop').click()
    const review = page.getByTestId('feedback-recorder-review')
    const reviewRows = page.getByTestId('feedback-review-steps').getByRole('listitem')
    await expect(review).toBeVisible()
    await expect(reviewRows).toHaveCount(5)
    const reviewBounds = await review.boundingBox()
    assert.ok(reviewBounds && reviewBounds.width < 1280 && reviewBounds.height <= 868)
    await expect(review.getByTestId('feedback-recorder-diagnostics-notice')).toContainText(
      '运行诊断日志'
    )
    const summary = review.getByRole('textbox', { name: '补充说明', exact: true })
    await expect(summary).toHaveAttribute('maxlength', '500')
    await summary.fill('第一行\n第二行\n第三行')
    assert.ok(
      await summary.evaluate((node: HTMLTextAreaElement) => node.scrollHeight <= node.clientHeight)
    )
    await reviewRows.first().getByRole('button', { name: '编辑说明' }).click()
    await review.getByRole('textbox', { name: '编辑说明', exact: true }).fill('检查时修改的说明')
    await review.getByRole('button', { name: '确认', exact: true }).click()
    await expect(reviewRows.first()).toContainText('检查时修改的说明')
    await reviewRows.first().getByRole('button', { name: '编辑说明' }).click()
    const inlineNote = review.getByRole('textbox', { name: '编辑说明', exact: true })
    assert.equal(await inlineNote.evaluate((node) => node.tagName), 'TEXTAREA')
    await expect(inlineNote).toHaveAttribute('maxlength', '500')
    const editor = review.getByTestId('feedback-review-note-editor')
    await expect(
      reviewRows.first().getByTestId('feedback-review-note-row').getByRole('button')
    ).toHaveCount(0)
    await expect(editor.getByRole('button', { name: '确认', exact: true })).toBeVisible()
    await expect(editor.getByRole('button', { name: '取消', exact: true })).toBeVisible()
    const editorBounds = (await editor.boundingBox())!
    const confirmBounds = (await editor
      .getByRole('button', { name: '确认', exact: true })
      .boundingBox())!
    const textareaBounds = (await inlineNote.boundingBox())!
    assert.ok(confirmBounds.x > editorBounds.x + editorBounds.width / 2)
    assert.ok(confirmBounds.y >= textareaBounds.y + textareaBounds.height)
    assert.ok(confirmBounds.x + confirmBounds.width < editorBounds.x + editorBounds.width)
    assert.ok(confirmBounds.y + confirmBounds.height < editorBounds.y + editorBounds.height)

    await inlineNote.fill('取消的修改')
    await inlineNote.press('Enter')
    await expect(inlineNote).toHaveValue('取消的修改\n')
    await review.getByRole('textbox', { name: '补充说明', exact: true }).click()
    await expect(inlineNote).toBeVisible()
    await expect(reviewRows.first().getByTestId('feedback-review-note-row')).not.toContainText(
      '取消的修改'
    )
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'review-note-editor.png'),
    })
    await review
      .getByTestId('feedback-review-note-editor')
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await reviewRows.first().getByRole('button', { name: '编辑说明' }).click()
    await review.getByRole('textbox', { name: '编辑说明', exact: true }).fill('Esc 不保存')
    await review.getByRole('textbox', { name: '编辑说明', exact: true }).press('Escape')
    await expect(review.getByRole('textbox', { name: '编辑说明', exact: true })).toHaveCount(0)

    await expect(review).toBeVisible()
    await expect(reviewRows.first()).toContainText('检查时修改的说明')
    const summaryGap = await review
      .locator('label[for="feedback-review-summary"]')
      .evaluate(
        (node) =>
          node.nextElementSibling!.getBoundingClientRect().top - node.getBoundingClientRect().bottom
      )
    assert.equal(summaryGap, 8)
    assert.equal(
      await review
        .getByTestId('feedback-recorder-diagnostics-notice')
        .evaluate(
          (node) => getComputedStyle(node.querySelector('.vds-alert__content')!).fontWeight
        ),
      '400'
    )
    const footerGap = await review
      .getByTestId('feedback-review-footer')
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          node.previousElementSibling!.getBoundingClientRect().bottom
      )
    assert.equal(footerGap, 16)
    const noteRow = reviewRows.first().getByTestId('feedback-review-note-row')
    await expect(noteRow).toHaveCSS('font-weight', '400')
    await expect(noteRow.locator('p')).toHaveCSS('font-weight', '400')
    const noteLeft = await noteRow.evaluate((node) => node.getBoundingClientRect().left)
    const titleLeft = await reviewRows
      .first()
      .getByTestId('feedback-review-step-title')
      .evaluate((node) => node.getBoundingClientRect().left)
    const numberLeft = await reviewRows
      .first()
      .getByTestId('feedback-review-step-number')
      .evaluate((node) => node.getBoundingClientRect().left)
    assert.equal(noteLeft, titleLeft)
    assert.ok(noteLeft > numberLeft)

    await review.getByRole('button', { name: '下一页操作步骤' }).click()
    await expect(reviewRows).toHaveCount(3)
    await reviewRows.last().getByRole('button', { name: '编辑说明' }).click()
    await review.getByRole('textbox', { name: '编辑说明', exact: true }).fill('当前步骤的问题说明')
    await review.getByRole('button', { name: '确认', exact: true }).click()
    const thumbnails = review.getByTestId('feedback-review-screenshot')
    await expect(thumbnails).toHaveCount(3)
    const imageNoteRow = reviewRows.last().getByTestId('feedback-review-note-row')
    await expect(imageNoteRow).toHaveCSS('column-gap', '4px')
    const imageBottom =
      (await thumbnails.first().boundingBox())!.y + (await thumbnails.first().boundingBox())!.height
    const noteTextBounds = (await imageNoteRow.locator('p').boundingBox())!
    assert.ok(Math.abs(noteTextBounds.y + noteTextBounds.height - imageBottom) <= 1)

    const squares = await thumbnails.evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = node.getBoundingClientRect()
        return [bounds.width, bounds.height, bounds.y]
      })
    )
    assert.ok(squares.every(([width, height, y]) => width === height && y === squares[0][2]))
    await expect(review.getByRole('button', { name: '上一组截图' })).toBeDisabled()
    await review.getByRole('button', { name: '下一组截图' }).click()
    await expect(review.getByRole('button', { name: '下一组截图' })).toBeDisabled()
    await expect(thumbnails).toHaveCount(3)
    await review.getByRole('button', { name: '上一组截图' }).click()
    const thumbnail = thumbnails.first()
    const actions = thumbnail.getByTestId('feedback-review-screenshot-actions')
    const closeBubble = thumbnail.getByRole('button', { name: '删除截图' })
    const bubbleWrapper = closeBubble.locator('..')
    await summary.hover()
    await expect(bubbleWrapper).toHaveCSS('opacity', '0')
    await closeBubble.focus()
    await expect(bubbleWrapper).toHaveCSS('opacity', '1')
    await summary.focus()
    await expect(bubbleWrapper).toHaveCSS('opacity', '0')
    await thumbnail.hover()
    await expect(bubbleWrapper).toHaveCSS('opacity', '1')
    await expect(closeBubble).toHaveCSS('width', '16px')
    await expect(closeBubble).toHaveCSS('height', '16px')
    await expect(closeBubble).toHaveCSS('background-color', 'rgba(51, 51, 51, 0.9)')
    await expect(closeBubble).toHaveCSS('color', 'rgb(255, 255, 255)')
    await expect(actions).toHaveCSS('opacity', '1')
    await expect(actions.getByRole('button')).toHaveCount(1)
    await expect(actions.getByRole('button', { name: '删除截图' })).toHaveCount(0)
    const deleteBubble = thumbnail.getByRole('button', { name: '删除截图' })
    const bubbleBounds = await deleteBubble.boundingBox()
    const thumbBounds = await thumbnail.boundingBox()
    assert.ok(
      bubbleBounds &&
        thumbBounds &&
        bubbleBounds.y < thumbBounds.y &&
        bubbleBounds.x + bubbleBounds.width > thumbBounds.x + thumbBounds.width
    )

    await expect(actions).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.5)')
    assert.equal(await thumbnail.evaluate((node) => getComputedStyle(node).borderTopWidth), '1px')
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'review-thumbnail-hover.png'),
    })
    const editImage = actions.getByRole('button', { name: '点击重新编辑' })
    await editImage.hover()
    await expect(editImage).toHaveCSS('background-color', 'rgba(103, 73, 15, 0.04)')
    await expect(editImage).toHaveCSS('color', 'rgb(255, 255, 255)')
    await editImage.click()
    await expect(page.getByRole('dialog')).toContainText('截图标记问题')
    await expect
      .poll(() =>
        page
          .getByRole('dialog')
          .locator('canvas')
          .evaluate((node: HTMLCanvasElement) => node.toDataURL())
      )
      .toBe(styledPixels)
    await expect(page.getByRole('textbox', { name: '问题说明', exact: true })).toHaveValue(
      '当前步骤的问题说明'
    )
    await page.getByRole('textbox', { name: '问题说明', exact: true }).fill('检查时修改截图')
    await page.getByRole('button', { name: '保存截图', exact: true }).click()
    await expect(reviewRows.last()).toContainText('检查时修改截图')
    await reviewRows.last().getByRole('button', { name: '编辑说明' }).click()
    await expect(review.getByRole('textbox', { name: '编辑说明', exact: true })).toHaveValue(
      '检查时修改截图'
    )
    await review.getByRole('button', { name: '确认', exact: true }).click()
    await thumbnail.hover()
    await thumbnail.getByRole('button', { name: '删除截图' }).click()
    await expect(thumbnails).toHaveCount(3)
    await expect(review.getByRole('button', { name: '下一组截图' })).toHaveCount(0)
    await expect(reviewRows.last()).toContainText('检查时修改截图')

    await review.getByRole('button', { name: '上一页操作步骤' }).click()
    const fifthStepBottom = await reviewRows
      .last()
      .evaluate((node) => node.getBoundingClientRect().bottom)
    const footerTop = await review
      .getByTestId('feedback-review-footer')
      .evaluate((node) => node.getBoundingClientRect().top)
    assert.ok(fifthStepBottom <= footerTop - 16)
    await page.screenshot({ animations: 'disabled', path: path.join(evidence, 'review.png') })
    await review.getByRole('button', { name: '复制为 Markdown', exact: true }).click()
    await expect(review.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /检查时修改的说明/)
    await review.getByTestId('feedback-recorder-submit').click()
    await expect(review.getByTestId('feedback-recorder-submit-error')).toBeVisible()
    await expect(summary).toHaveValue('第一行\n第二行\n第三行')
    await review.getByRole('button', { name: '取消', exact: true }).last().click()
    await page.getByRole('button', { name: '模拟提交失败' }).click()
    await page.getByTestId('feedback-recorder-stop').click()
    await review.getByTestId('feedback-recorder-submit').click()
    await expect(review).toHaveCount(0)
    await page.getByRole('button', { name: '切换主题', exact: true }).click()
    await page.getByRole('button', { name: '中 / EN', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause logging', exact: true })).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: path.join(evidence, 'dark-english.png') })
    await page.setViewportSize({ width: 760, height: 650 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByTestId('feedback-recorder-screenshot').click()
    await expect(shutter).toBeVisible()
    await expect(shutter.locator('div').first()).toHaveCSS('display', 'none')
    await expect(dialog).toBeVisible()
    await expect(shutter).toHaveCount(0)
    await page.screenshot({ animations: 'disabled', path: path.join(evidence, 'narrow.png') })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await page.getByTestId('feedback-recorder-stop').click()
    const narrowReview = await review.boundingBox()
    assert.ok(
      narrowReview &&
        narrowReview.x >= 0 &&
        narrowReview.y >= 0 &&
        narrowReview.width <= 760 &&
        narrowReview.height <= 650
    )
    await expect(review.getByTestId('feedback-recorder-submit')).toBeInViewport()
    assert.ok(await review.evaluate((node) => node.scrollWidth <= node.clientWidth))
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'review-dark-narrow.png'),
    })
    await review.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await expect(exit).toHaveText('Exit')
    await exit.click()
    await expect(page.getByTestId('feedback-recorder-controls')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await browser?.close()
    await server.close()
  }
})
