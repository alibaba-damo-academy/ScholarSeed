import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

test('empty composer hints do not resize the editor or move its toolbar', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: 388, height: 720 })
  await page.goto(
    new URL('/components/business/editor.render.fixture.html?hints', fixture.url).href
  )
  const input = page.getByTestId('editor')
  const geometry = () =>
    page.evaluate(() => {
      const editor = document.querySelector('[data-testid="editor"]')!
      const toolbar = document.querySelector('[data-testid="toolbar"]')!
      return {
        height: editor.getBoundingClientRect().height,
        toolbarTop: toolbar.getBoundingClientRect().top,
      }
    })
  const initial = await geometry()
  for (const hint of ['running', 'idle', 'prediction', 'idle']) {
    await page.getByTestId(`hint-${hint}`).click()
    await expect(page.getByTestId('layout')).toHaveText(
      JSON.stringify({ multiline: false, above: false, below: false })
    )
    await expect.poll(geometry).toEqual(initial)
    await expect(input).toHaveValue('')
  }
  await input.fill('First line\nSecond line')
  await expect(page.getByTestId('layout')).toContainText('"multiline":true')
  await expect.poll(async () => (await geometry()).height).toBeGreaterThan(initial.height)
  await input.fill('')
  await expect.poll(geometry).toEqual(initial)
})

test('attachment cards stay separate and reachable while the draft scrolls in a narrow composer', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: 420, height: 720 })
  await page.goto(
    new URL('/components/business/editor.render.fixture.html?ordering', fixture.url).href
  )
  for (const kind of ['skill', 'file', 'session', 'image', 'note', 'selection']) {
    await page.getByTestId(`add-${kind}`).click()
  }
  await page
    .getByTestId('editor')
    .fill(Array.from({ length: 25 }, (_, index) => `Draft line ${index}`).join('\n'))
  await page.getByTestId('editor').press('Control+End')
  const attachments = page.getByTestId('fixture-attachments').getByTestId('ordered-reference')
  await expect(attachments.first()).toBeVisible()
  await attachments.last().scrollIntoViewIfNeeded()
  await expect(attachments.last()).toBeInViewport()
  await expect(attachments).toHaveText(['file', 'image', 'note', 'selection'])
})

test('inline and attachment regions each preserve addition order without changing placement', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(
    new URL('/components/business/editor.render.fixture.html?ordering', fixture.url).href
  )
  const kinds = ['skill', 'file', 'session', 'image', 'note', 'selection']
  for (const kind of kinds) await page.getByTestId(`add-${kind}`).click()
  const inline = page.getByTestId('fixture-inline').getByTestId('ordered-reference')
  const attachments = page.getByTestId('fixture-attachments').getByTestId('ordered-reference')
  await expect(inline).toHaveText(['skill', 'session'])
  await expect(attachments).toHaveText(['file', 'image', 'note', 'selection'])
  const inputTop = await page.getByTestId('editor').evaluate((element) => {
    const style = getComputedStyle(element)
    return element.getBoundingClientRect().top + Number.parseFloat(style.paddingTop)
  })
  for (const kind of ['file', 'image', 'note', 'selection']) {
    const bounds = await attachments.filter({ hasText: kind }).boundingBox()
    assert.ok(bounds && bounds.y + bounds.height <= inputTop)
  }
  await page.getByTestId('composer-reference-boundary').nth(1).press('Backspace')
  await expect(inline).toHaveText(['session'])
  await page.getByTestId('add-skill').click()
  await expect(inline).toHaveText(['session', 'skill'])
  await expect(attachments).toHaveText(['file', 'image', 'note', 'selection'])
  await page.getByTestId('editor').fill('Draft text')
  await expect(inline).toHaveText(['session', 'skill'])
  await page.getByTestId('reset-draft').click()
  await page.getByTestId('add-session').click()
  await page.getByTestId('add-skill').click()
  await expect(inline).toHaveText(['session', 'skill'])
})

test('session and skill text share the editor typography and line position on both surfaces', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: 1100, height: 720 })
  for (const surface of ['', '&standard']) {
    await page.goto(
      new URL(`/components/business/editor.render.fixture.html?references${surface}`, fixture.url)
        .href
    )
    for (const text of ['', '正文与引用对齐']) {
      await page.getByTestId('editor').fill(text)
      await expect
        .poll(() =>
          page.getByTestId('editor').evaluate((element) => {
            const inputStyle = getComputedStyle(element)
            const inputTop =
              element.getBoundingClientRect().top + Number.parseFloat(inputStyle.paddingTop)
            const labels = Array.from(
              element.previousElementSibling!.querySelectorAll(
                '[class~="group/attachment"] > span:last-of-type'
              )
            )
            return (
              labels.length === 3 &&
              labels.every((label) => {
                const style = getComputedStyle(label)
                const typography = [
                  'fontFamily',
                  'fontSize',
                  'fontWeight',
                  'lineHeight',
                  'letterSpacing',
                ] as const
                return (
                  typography.every((property) => style[property] === inputStyle[property]) &&
                  Math.abs(label.getBoundingClientRect().top - inputTop) < 1
                )
              })
            )
          })
        )
        .toBe(true)
    }
  }
})

test('reference gaps accept a caret and delete only the adjacent reference', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(
    new URL('/components/business/editor.render.fixture.html?references', fixture.url).href
  )
  const gap = page.getByTestId('composer-reference-boundary').nth(1)
  await gap.click()
  await expect(gap).toBeFocused()
  await gap.press('Backspace')
  await expect(page.getByText('会话滚动按钮与长任务引用换行验证任务', { exact: true })).toHaveCount(
    0
  )
  await expect(page.getByText('精确检索文献', { exact: true })).toBeVisible()
  await page.getByTestId('composer-reference-boundary').first().press('Delete')
  await expect(page.getByText('精确检索文献', { exact: true })).toHaveCount(0)
  await expect(page.getByText('书深产品操作', { exact: true })).toBeVisible()
})

test('both platform select-all shortcuts include references and preserve them until deletion', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  for (const modifier of ['Meta', 'Control']) {
    await page.goto(
      new URL('/components/business/editor.render.fixture.html?references', fixture.url).href
    )
    const input = page.getByTestId('editor')
    await input.fill('保留到按下删除')
    await input.press(`${modifier}+a`)
    await expect(page.getByTestId('composer-selected-reference')).toHaveCount(3)
    await expect(input).toHaveValue('保留到按下删除')
    await input.press('Backspace')
    await expect(input).toHaveValue('')
    await expect(page.getByTestId('composer-reference-boundary')).toHaveCount(0)
  }
})

test('asynchronous clear preserves failed drafts and input or references added while saving', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  for (const outcome of ['failure', 'success', 'new-input', 'new-scope']) {
    await page.goto(
      new URL('/components/business/editor.render.fixture.html?ordering&async-removal', fixture.url)
        .href
    )
    await page.getByTestId('add-skill').click()
    const input = page.getByTestId('editor')
    await input.fill('unsent draft')
    await input.press('Meta+a')
    await input.press('Backspace')
    await expect(input).toHaveValue('unsent draft')
    await expect(page.getByTestId('ordered-reference')).toHaveText(['skill'])
    if (outcome === 'new-input') {
      await input.fill('new text')
      await page.getByTestId('add-file').click()
    } else if (outcome === 'new-scope') {
      await page.evaluate(() => Reflect.get(window, 'editorDraft').reset('unsent draft'))
    }
    await page.evaluate(
      (success) => Reflect.get(window, 'finishRemoval')(success),
      outcome !== 'failure'
    )
    await expect(input).toHaveValue(
      outcome === 'success' ? '' : outcome === 'new-input' ? 'new text' : 'unsent draft'
    )
    await expect(page.getByTestId('ordered-reference')).toHaveText(
      outcome === 'failure' ? ['skill'] : outcome === 'new-input' ? ['file'] : []
    )
  }
})

test('wrapped references expand the compact editor above its toolbar', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: 388, height: 720 })
  await page.goto(
    new URL('/components/business/editor.render.fixture.html?references', fixture.url).href
  )
  await expect(page.getByTestId('layout')).toContainText('"multiline":true')
  await expect(page.locator('[data-slot="attachment-remove"]')).toHaveCount(0)
  const caret = await page.getByTestId('editor').evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      x: bounds.x + Number.parseFloat(style.textIndent) + 2,
      y: bounds.y + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.lineHeight) / 2,
    }
  })
  await page.mouse.click(caret.x, caret.y)
  await expect(page.getByTestId('editor')).toBeFocused()
  await expect
    .poll(() =>
      page.getByTestId('editor').evaluate((element) => {
        const prefix = element.previousElementSibling!
        const style = getComputedStyle(element)
        return (
          Number.parseFloat(style.textIndent) > 0 &&
          Number.parseFloat(style.paddingTop) < prefix.getBoundingClientRect().height
        )
      })
    )
    .toBe(true)
  await expect
    .poll(async () => {
      const input = await page.getByTestId('editor').boundingBox()
      const toolbar = await page.getByTestId('toolbar').boundingBox()
      return toolbar!.y >= input!.y + input!.height
    })
    .toBe(true)
  await page.setViewportSize({ width: 900, height: 720 })
  await expect
    .poll(() =>
      page.getByTestId('editor').evaluate((element) => {
        const style = getComputedStyle(element)
        const prefix = element.previousElementSibling!.getBoundingClientRect()
        const lineCenter =
          element.getBoundingClientRect().top +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.lineHeight) / 2
        return Math.abs(prefix.top + prefix.height / 2 - lineCenter)
      })
    )
    .toBeLessThan(1)
})

test('composer editor caps at ten rows, reports scroll edges and avoids wrapping layout oscillation', async (context) => {
  const fixture = await renderFixture(fileURLToPath(new URL('../..', import.meta.url)))
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: 388, height: 720 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(new URL('/components/business/editor.render.fixture.html', fixture.url).href)
  const input = page.getByTestId('editor')
  const layout = page.getByTestId('layout')
  const height = () => input.evaluate((element) => element.getBoundingClientRect().height)
  await input.fill('短输入')
  const single = await height()
  await expect(layout).toHaveText(JSON.stringify({ multiline: false, above: false, below: false }))
  await input.fill(Array.from({ length: 10 }, (_, index) => `第${index + 1}行`).join('\n'))
  await expect.poll(height).toBeGreaterThan(single)
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const style = getComputedStyle(element)
        return (
          (element.clientHeight -
            Number.parseFloat(style.paddingTop) -
            Number.parseFloat(style.paddingBottom)) /
          Number.parseFloat(style.lineHeight)
        )
      })
    )
    .toBe(10)
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: false, below: false }))
  await input.fill(Array.from({ length: 30 }, (_, index) => `第${index + 1}行`).join('\n'))
  await input.press('Control+Home')
  await input.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: false, below: true }))
  await input.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
  })
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: true, below: true }))
  await input.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(layout).toHaveText(JSON.stringify({ multiline: true, above: true, below: false }))
  await input.fill('内容宽度变化后不应反复切换工具栏位置。'.repeat(2))
  await expect(layout).toContainText('"multiline":true')
  await page.setViewportSize({ width: 520, height: 720 })
  await expect(input).toHaveValue('内容宽度变化后不应反复切换工具栏位置。'.repeat(2))
  await input.fill('')
  await expect.poll(height).toBe(single)
  await expect(layout).toHaveText(JSON.stringify({ multiline: false, above: false, below: false }))
  assert.deepEqual(errors, [])
})
