import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

test('authorization card matches the design geometry and hides after either decision', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { ConfirmationCard } from './Confirmation'
        import { LiteratureResults } from '../../features/literature/Summary'
        function Fixture() {
          const [open, setOpen] = useState(true)
          const [long, setLong] = useState(false)
          const [compact, setCompact] = useState(false)
          const [busy, setBusy] = useState(false)
          const [allowVisible, setAllowVisible] = useState(true)
          const [singleAction, setSingleAction] = useState(false)
          const [customIcon, setCustomIcon] = useState(false)
          const [highRisk, setHighRisk] = useState(false)
          const [decisions, setDecisions] = useState(0)
          const decide = () => { setDecisions(count => count + 1); setOpen(false) }
          return <>
            <ConfirmationCard title="Request permission" description={'echo preview '.repeat(long ? 40 : 1)}
              open={open} compact={compact} allowLabel="允许一次" denyLabel={singleAction ? undefined : '拒绝'}
              disabled={busy} allowVisible={allowVisible}
              risk={highRisk ? 'high' : 'normal'}
              icon={customIcon ? <span data-testid="custom-confirmation-icon">积分</span> : undefined}
              onAllow={decide} onDeny={singleAction ? undefined : decide} />
            {compact && <LiteratureResults content={{
              schema_version: '1.0', session_id: 'fixture', status: 'success',
              retained: 40, papers: [], criteria: [], sources: [], warnings: [],
            }} ports={{ openResults: async () => setDecisions(count => count + 1) }} />}
            <output aria-label="Decisions">{decisions}</output>
            <button onClick={() => setOpen(true)}>Reset</button>
            <button onClick={() => setLong(true)}>Long description</button>
            <button onClick={() => setCompact(true)}>Compact</button>
            <button onClick={() => setBusy(value => !value)}>Busy</button>
            <button onClick={() => setAllowVisible(false)}>Scope only</button>
            <button onClick={() => setSingleAction(value => !value)}>Single action</button>
            <button onClick={() => setCustomIcon(value => !value)}>Custom icon</button>
            <button onClick={() => setHighRisk(value => !value)}>High risk</button>
          </>
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  })
  const stylesheet = fileURLToPath(new URL('../../styles.css', import.meta.url))
  const compiled = await postcss([
    tailwindcss({ base: fileURLToPath(new URL('../../../', import.meta.url)) }),
  ]).process(readFileSync(stylesheet, 'utf8'), { from: stylesheet })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    await page.setContent('<div id="root" style="width:900px;max-width:100%"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const card = page.getByRole('group', { name: 'Request permission' })
    await expect(card).toContainText('echo preview')
    const geometry = await card.evaluate((element) => {
      const icon = element.firstElementChild!.firstElementChild!
      const buttons = Array.from(element.querySelectorAll('button'))
      return {
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        radius: getComputedStyle(element).borderRadius,
        iconRadius: getComputedStyle(icon).borderRadius,
        buttons: buttons.map((button) => ({
          paddingInline: getComputedStyle(button).paddingInline,
          height: button.getBoundingClientRect().height,
          radius: getComputedStyle(button).borderRadius,
          font: getComputedStyle(button).fontSize,
          color: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
          border: getComputedStyle(button).borderTopColor,
        })),
      }
    })
    assert.equal(geometry.height, 66)
    assert.equal(geometry.width, 760)
    assert.equal(geometry.radius, '12px')
    assert.equal(geometry.iconRadius, '8px')
    assert.deepEqual(geometry.buttons, [
      {
        paddingInline: '16px',
        height: 32,
        radius: '8px',
        font: '14px',
        color: 'rgb(39, 39, 39)',
        background: 'rgb(255, 255, 255)',
        border: 'rgb(234, 230, 221)',
      },
      {
        paddingInline: '16px',
        height: 32,
        radius: '8px',
        font: '14px',
        color: 'rgb(255, 255, 255)',
        background: 'rgb(44, 85, 69)',
        border: 'rgb(166, 190, 179)',
      },
    ])
    await expect(card.locator('.lucide-triangle-alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'High risk', exact: true }).click()
    await expect(card.locator('.lucide-triangle-alert')).toHaveCount(1)
    await page.getByRole('button', { name: 'Custom icon', exact: true }).click()
    await expect(card.getByTestId('custom-confirmation-icon')).toBeVisible()
    await expect(card.locator('.lucide-triangle-alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Custom icon', exact: true }).click()
    await expect(card.locator('.lucide-triangle-alert')).toHaveCount(1)
    await page.getByRole('button', { name: 'High risk', exact: true }).click()
    await expect(card.locator('.lucide-triangle-alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Single action', exact: true }).click()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button')).toHaveCount(1)
    await expect(card.getByRole('button', { name: '允许一次', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Single action', exact: true }).click()
    await page.getByRole('button', { name: 'Compact', exact: true }).click()
    assert.equal((await card.boundingBox())!.height, 60)
    const receipt = page.locator('[data-artifact-receipt]')
    const resultIcon = receipt.getByTestId('artifact-open').locator('span[aria-hidden]').first()
    const open = receipt.getByTestId('artifact-open-default')
    await expect(receipt).toHaveCSS('height', '64px')
    await expect(resultIcon).toHaveCSS('width', '36px')
    await expect(resultIcon).toHaveCSS('border-radius', '8px')
    await expect(resultIcon.locator('svg')).toHaveCSS('width', '16px')
    await expect(resultIcon).toHaveCSS('background-color', 'rgb(233, 238, 235)')
    await expect(open).toHaveCSS('height', '28px')
    await expect(open).toHaveCSS('font-size', '14px')
    await expect(open).toHaveCSS('border-radius', '8px')
    await expect(open).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(open).toHaveCSS('border-top-color', 'rgb(234, 230, 221)')
    await expect
      .poll(() =>
        card
          .getByRole('button', { name: '拒绝', exact: true })
          .evaluate((element) => getComputedStyle(element).backgroundColor)
      )
      .toBe('rgba(0, 0, 0, 0.03)')
    await page.setViewportSize({ width: 420, height: 600 })
    await page.getByRole('button', { name: 'Long description' }).click()
    assert.equal(await card.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
    await expect(card.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
    await expect(page.getByRole('status', { name: 'Decisions' })).toHaveText('0')
    await card.getByRole('button', { name: '允许一次', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(card).toHaveCount(0)
    await expect(page.getByRole('status', { name: 'Decisions' })).toHaveText('1')
    await page.getByRole('button', { name: 'Reset' }).click()
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect(card).toHaveCount(0)
    assert.equal(await page.getByRole('status', { name: 'Decisions' }).textContent(), '2')
    await page.getByRole('button', { name: 'Reset' }).click()
    await page.getByRole('button', { name: 'Busy', exact: true }).click()
    await expect(card.getByRole('button', { name: '允许一次', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Busy', exact: true }).click()
    await page.getByRole('button', { name: 'Scope only', exact: true }).click()
    await expect(card.getByRole('button', { name: '允许一次', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
    assert.equal(
      await receipt.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true
    )
    await open.click()
    await expect(page.getByRole('status', { name: 'Decisions' })).toHaveText('3')
  } finally {
    await browser.close()
  }
})
