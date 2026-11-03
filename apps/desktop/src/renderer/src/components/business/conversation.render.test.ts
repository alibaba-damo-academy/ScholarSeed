import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'
import { WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../../../../window.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = '/components/business/conversation.render.fixture.html'

for (const english of [false, true]) {
  test(
    `completed answers expand as immutable history: english=${english}`,
    { timeout: 60_000 },
    async (context) => {
      const fixture = await renderFixture(ROOT, {
        launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
      })
      context.after(() => fixture.close())
      const page = await fixture.page(context)
      const writes: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(request.url())
      })
      await page.goto(new URL(`${FIXTURE}${english ? '?english&dark' : ''}`, fixture.url).href)
      await page.getByRole('button', { name: '已完成回答', exact: true }).click()
      const card = page.getByTestId('interaction-reply')
      const toggle = card.getByRole('button', {
        name: english ? 'Show or hide previous answers' : '展开或收起此前回答',
        exact: true,
      })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle.getByText('持久化记忆机制（推荐）', { exact: true })).toBeVisible()
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(
        card.getByText(english ? 'Previous answers are read-only' : '此前回答仅供查看，无法修改', {
          exact: true,
        })
      ).toBeVisible()
      const radios = card.getByRole('radio')
      const checkboxes = card.getByRole('checkbox')
      await expect(radios).toHaveCount(4)
      await expect(checkboxes).toHaveCount(3)
      const selected = card.getByRole('radio', {
        name: '持久化记忆机制（推荐） 研究跨会话的记忆保持。',
        exact: true,
      })
      await expect(selected).toBeChecked()
      for (const control of await card.locator('[role=radio], [role=checkbox]').all()) {
        await expect(control).toBeDisabled()
      }
      await expect(checkboxes.nth(0)).toBeChecked()
      await expect(checkboxes.nth(1)).toBeChecked()
      await expect(checkboxes.nth(2)).not.toBeChecked()
      await expect(card.getByText('第一行约束\n第二行约束', { exact: true })).toBeVisible()
      await expect(card.getByText('自定义研究方向', { exact: true })).toBeVisible()
      await expect(card.getByText(english ? 'Skipped' : '已跳过', { exact: true })).toBeVisible()
      await expect(card.getByRole('textbox')).toHaveCount(0)
      await expect(card.getByTestId('hil-question-confirm')).toHaveCount(0)
      for (const control of [selected, checkboxes.nth(2)]) {
        const bounds = (await control.boundingBox())!
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      }
      await expect(selected).toBeChecked()
      await expect(checkboxes.nth(2)).not.toBeChecked()
      for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
        await page.setViewportSize(size)
        await toggle.focus()
        await page.keyboard.press('Enter')
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await page.keyboard.press('Space')
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expect(selected).toBeChecked()
        const neutralColor = await selected
          .getByText('持久化记忆机制（推荐）', { exact: true })
          .evaluate((element) => getComputedStyle(element).color)
        await expect(selected.locator(':scope > span').first()).toHaveCSS(
          'background-color',
          neutralColor
        )
        await expect(checkboxes.nth(0).locator(':scope > span').first()).toHaveCSS(
          'background-color',
          neutralColor
        )
      }
      await page.getByRole('button', { name: '短文献确认', exact: true }).click()
      await page.getByRole('button', { name: '已完成回答', exact: true }).click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(selected).toBeChecked()
      assert.deepEqual(writes, [])
    }
  )
}

test('composer-only surfaces retain their full height without a pending confirmation', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(`${FIXTURE}?compact`, fixture.url).href)
  const controls = page.locator('.vds-ai-composer-host')
  assert.equal(await controls.evaluate((element) => getComputedStyle(element).maxHeight), '100%')
  const composer = await page.getByRole('textbox', { name: '消息', exact: true }).boundingBox()
  const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
  const host = await controls.boundingBox()
  assert.ok(composer!.y >= host!.y)
  assert.ok(send!.y + send!.height <= host!.y + host!.height)
})

for (const embedded of [false, true]) {
  test(
    `long confirmation preserves independently scrollable history: embedded=${embedded}`,
    { timeout: 60_000 },
    async (context) => {
      const fixture = await renderFixture(ROOT, {
        launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
      })
      context.after(() => fixture.close())
      const page = await fixture.page(context)
      const submissions: unknown[] = []
      await page.route('**/api/serve/sessions/conversation-layout/hil/**', async (route) => {
        submissions.push(route.request().postDataJSON())
        await route.fulfill({ json: { ok: true } })
      })
      await page.goto(new URL(`${FIXTURE}${embedded ? '?embedded' : ''}`, fixture.url).href)
      await page.getByRole('button', { name: '长文献确认', exact: true }).click()
      const history = page.locator('.conversation-stream')
      const papers = page.getByTestId('hil-question-scroll-area')
      const toggle = page.getByTestId('hil-question-toggle')
      const layout = page.getByTestId('conversation-layout')
      const controls = page.locator('.vds-ai-composer-host')
      for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
        await page.setViewportSize(size)
        await expect(papers).toBeVisible()
        await expect
          .poll(async () => {
            const available = await layout.boundingBox()
            const stream = await history.boundingBox()
            return stream!.height / available!.height
          })
          .toBeGreaterThanOrEqual(0.24)
        assert.equal(
          await controls.evaluate((element) => getComputedStyle(element).overflowY),
          'visible'
        )
        await papers.hover()
        await page.mouse.wheel(0, 10000)
        await expect
          .poll(() =>
            papers.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop
            )
          )
          .toBeLessThanOrEqual(1)
        const papersScroll = await papers.evaluate((element) => element.scrollTop)
        await history.hover()
        await page.mouse.wheel(0, 10000)
        await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        await page.mouse.wheel(0, -10000)
        await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0)
        await expect(
          history.getByText('历史消息 1：保留此前的研究背景和讨论内容。', { exact: true })
        ).toBeInViewport()
        assert.equal(await papers.evaluate((element) => element.scrollTop), papersScroll)
        await toggle.click()
        await expect(papers).toBeHidden()
        await toggle.click()
        await expect(papers).toBeVisible()
      }
      await papers.hover()
      await page.mouse.wheel(0, 10000)
      await page
        .getByTestId('hil-dock')
        .getByRole('button', { name: '一键授权', exact: true })
        .click()
      await expect(page.getByTestId('hil-dock')).toHaveCount(0)
      const reply = page.getByTestId('interaction-reply')
      const replyToggle = reply.getByRole('button', { name: '展开或收起此前回答', exact: true })
      await expect(replyToggle).toHaveAttribute('aria-expanded', 'false')
      await replyToggle.click()
      await expect(replyToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(reply.getByRole('radio')).toHaveCount(2)
      for (const option of await reply.getByRole('radio').all()) await expect(option).toBeDisabled()
      assert.equal(submissions.length, 1)
      assert.deepEqual((submissions[0] as { values: unknown }).values, {
        selected_paper_ids: Array.from({ length: 24 }, (_, index) => `paper-${index + 1}`),
      })
      await page.getByRole('button', { name: '短文献确认', exact: true }).click()
      await expect
        .poll(async () => {
          const stream = await history.boundingBox()
          const available = await layout.boundingBox()
          return stream!.height / available!.height
        })
        .toBeGreaterThan(0.25)
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport()
    }
  )
}
