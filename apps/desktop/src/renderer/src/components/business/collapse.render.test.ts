import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = '/components/business/conversation.render.fixture.html'

test(
  'confirmed question copy stays with its disclosure without changing either payload',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT)
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    for (const mode of ['completed', 'interrupted', 'running', 'mixed', 'multi', 'other']) {
      await page.goto(new URL(`${FIXTURE}?copyCollapse=${mode}`, fixture.url).href)
      await page.getByRole('button', { name: '已完成回答', exact: true }).click()
      const triggers = page.getByRole('button', {
        name: '明确研究关键问题，用户已确认',
        exact: true,
      })
      const trigger = triggers.last()
      const aggregate = page.getByTestId('reply-copy-with-cards')
      const externallyOwned = mode === 'mixed' || mode === 'other'
      const accessibleCopy = aggregate.and(page.getByRole('button'))
      await expect(accessibleCopy).toHaveCount(externallyOwned ? 1 : 0)
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const receipt = page.getByTestId('interaction-reply').last()
      const answerCopy = receipt.getByTestId('interaction-reply-copy')
      await answerCopy.click()
      await expect(answerCopy).toHaveAttribute('data-copy-status', 'success')
      const answers = await page.evaluate(() => navigator.clipboard.readText())
      assert.ok(answers.includes('持久化记忆机制（推荐）\n聚焦跨会话'))
      assert.ok(!answers.includes('希望以哪种研究方向为主？'))
      if (mode !== 'running') {
        await expect(accessibleCopy).toHaveCount(1)
        await aggregate.click()
        await expect(aggregate).toHaveAttribute('data-copy-status', 'success')
        const whole = await page.evaluate(() => navigator.clipboard.readText())
        assert.ok(whole.includes('希望以哪种研究方向为主？'))
        assert.ok(whole.includes('持久化记忆机制（推荐）\n聚焦跨会话'))
        if (mode === 'mixed') assert.ok(whole.includes('保留普通回答正文。'))
        if (mode === 'other') assert.ok(whole.includes('output/report.md'))
        if (mode === 'multi') assert.equal(whole.split('希望以哪种研究方向为主？').length, 3)
      } else await expect(aggregate).toHaveCount(0)
      await answerCopy.focus()
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      const content = trigger.locator('..').locator('[id$="-content"][aria-hidden]')
      await expect(content).toHaveAttribute('aria-hidden', 'true')
      await expect(content).toHaveCSS('grid-template-rows', '0px')
      await expect(content).toHaveAttribute('inert', '')
      await expect(answerCopy.and(page.getByRole('button'))).toHaveCount(0)
      await expect(accessibleCopy).toHaveCount(externallyOwned ? 1 : 0)
      await trigger.focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.locator('[inert] :focus').count(), 0)
      await trigger.focus()
      await page.keyboard.press('Space')
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      await expect(answerCopy).toBeVisible()
    }
  }
)
