import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const ENTRY = '/overview-probe.tsx'
const plugin: Plugin = {
  name: 'overview-probe',
  resolveId(source) {
    return source === ENTRY ? ENTRY : null
  },
  async load(id) {
    if (id !== ENTRY) return null
    return (
      await transformWithEsbuild(
        `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {I18nextProvider} from 'react-i18next'
      import {createLocalization} from '/../../localization/engine'
      import {resources} from '/../../localization/resources'
      import {OverviewGroup, OverviewSection} from '/components/business/SessionArtifacts.tsx'
      import {Button, ScrollArea} from '/components/ui'
      import '/styles.css'
      createRoot(document.getElementById('root')).render(
        <I18nextProvider i18n={createLocalization('zh', resources)}><div style={{width: 'var(--vds-task-overview-width)', marginLeft: 300}}>
          <OverviewSection title="Artifacts"><span>Section content</span></OverviewSection>
          {[0, 5, 6].map(count => <OverviewGroup key={count} title={'Group ' + count}
            testId={'group-' + count} items={Array.from({length: count}, (_, index) =>
              <Button key={index} onClick={event => event.currentTarget.textContent = 'Opened'}>
                {'Artifact ' + index}
              </Button>)} />)}
          <ScrollArea shadow="auto" data-testid="scroll" className="max-h-[var(--vds-task-overview-max-height)]">
            <OverviewGroup title="Group 40" testId="group-40" items={Array.from({length: 40}, (_, index) => <Button key={index}>{'Artifact ' + index}</Button>)}/>
          </ScrollArea>
          <OverviewGroup title="Sources" testId="sources" previewLimit={0}
            items={[<Button key="source">Referenced source</Button>]} />
          <OverviewGroup title="Empty sources" testId="empty-sources" previewLimit={0} items={[]} />
        </div></I18nextProvider>
      )
    `,
        'overview-probe.tsx',
        { loader: 'tsx', jsx: 'automatic', tsconfigRaw: {} }
      )
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__overview', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__overview',
          `<div id="root"></div><script type="module" src="${ENTRY}"></script>`
        )
        .then((html) => {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
        .catch(next)
    })
  },
}

test('overview previews five artifacts, expands inline and fades only overflowing scroll edges', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'overview',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
    await page.goto(`${server.resolvedUrls!.local[0]}__overview`)
    const section = page.getByRole('button', { name: 'Artifacts', exact: true })
    assert.deepEqual(
      await section.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          height: element.getBoundingClientRect().height,
          border: style.borderTopWidth,
          font: style.fontSize,
        }
      }),
      { height: 30, border: '0px', font: '12px' }
    )
    await section.click()
    await expect(page.getByText('Section content')).not.toBeVisible()
    await section.press('Enter')
    await expect(page.getByText('Section content')).toBeVisible()
    await expect(page.getByTestId('group-0')).toContainText('暂无')
    await expect(page.getByTestId('group-5').getByRole('button')).toHaveCount(6)
    await expect(page.getByTestId('group-5-more')).toHaveCount(0)
    await expect(page.getByTestId('group-6').getByRole('button')).toHaveCount(7)
    await expect(page.getByTestId('group-6-more')).toHaveText('查看更多（1）')
    assert.equal(
      await page.getByTestId('group-6-more').evaluate((element) => getComputedStyle(element).color),
      await page
        .getByTestId('group-0')
        .locator('p')
        .evaluate((element) => getComputedStyle(element).color)
    )
    await expect(page.getByTestId('sources').getByRole('button')).toHaveCount(1)
    await expect(page.getByTestId('empty-sources')).toHaveCount(0)
    assert.deepEqual(
      await page.getByTestId('group-5-trigger').evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          line: style.lineHeight,
          weight: style.fontWeight,
          color: style.color,
          gap: style.columnGap,
        }
      }),
      { line: '18px', weight: '400', color: 'rgb(76, 76, 76)', gap: '6px' }
    )
    await page.getByTestId('group-6-trigger').hover()
    await expect(page.getByTestId('group-6-all')).toHaveCount(0)
    const more = page.getByTestId('group-6-more')
    await more.focus()
    await more.press('Enter')
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(more).toHaveText('收起')
    await expect(page.getByTestId('group-6-expansion')).toHaveCSS(
      'transition-property',
      'grid-template-rows, opacity'
    )
    await page
      .getByTestId('group-6')
      .getByRole('button', { name: 'Artifact 5', exact: true })
      .click()
    await expect(
      page.getByTestId('group-6').getByRole('button', { name: 'Opened', exact: true })
    ).toBeVisible()
    await more.press('Space')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    const scroll = page.getByTestId('scroll')
    await expect(scroll).toHaveAttribute('data-fade-top', 'false')
    await expect(scroll).toHaveAttribute('data-fade-bottom', 'false')
    await page.getByTestId('group-40-more').click()
    await expect(scroll).toHaveAttribute('data-fade-bottom', 'true')
    await scroll.locator('.vds-scroll-area__viewport').evaluate((element) => {
      element.scrollTop = 80
    })
    await expect(scroll).toHaveAttribute('data-fade-top', 'true')
    await expect(scroll).toHaveAttribute('data-fade-bottom', 'true')
    await expect
      .poll(() => scroll.evaluate((element) => getComputedStyle(element, '::before').opacity))
      .toBe('1')
    await expect
      .poll(() => scroll.evaluate((element) => getComputedStyle(element, '::after').opacity))
      .toBe('1')
    assert.equal(
      await scroll.evaluate((element) => getComputedStyle(element, '::before').pointerEvents),
      'none'
    )
    await page.setViewportSize({ width: 1040, height: 660 })
    assert.ok((await scroll.boundingBox())!.height < 660)
    await scroll.locator('.vds-scroll-area__viewport').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(scroll).toHaveAttribute('data-fade-bottom', 'false')
    await expect(
      page.getByTestId('group-40').getByRole('button', { name: 'Artifact 39', exact: true })
    ).toBeVisible()
    await page.getByTestId('group-40-more').click()
    await expect(scroll).toHaveAttribute('data-fade-top', 'false')
    await expect(scroll).toHaveAttribute('data-fade-bottom', 'false')
    await page.getByTestId('sources-trigger').hover()
    await expect(page.getByTestId('sources-all')).toContainText('Referenced source')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('group-6-expansion')).toHaveCSS('transition-property', 'none')
  } finally {
    await browser.close()
    await server.close()
  }
})
