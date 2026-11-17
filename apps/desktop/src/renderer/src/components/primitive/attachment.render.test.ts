import path from 'node:path'
import test from 'node:test'
import { expect } from '@playwright/test'
import { createServer, type Plugin } from 'vite'
import { renderFixture } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const ENTRY = '\0attachment-hover'
const plugin: Plugin = {
  name: 'attachment-hover',
  resolveId: (source) => (source === 'attachment-hover' ? ENTRY : undefined),
  load(id) {
    if (id !== ENTRY) return
    return `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {ReferenceAttachment, SentReferenceAttachment, SelectionPreview} from '/components/primitive/Attachment'
      import {HoverCard} from '/components/ui'
      import '/styles.css'
      const details = React.createElement('div', {'data-testid': 'reference-details'}, 'Selected content')
      const props = {
        'data-testid': 'reference-card',
        label: '3 selections', description: 'Source document',
        icon: React.createElement('span', {'data-testid': 'reference-icon'}, 'icon'),
      }
      createRoot(document.getElementById('root')).render(location.search.includes('draft')
        ? React.createElement(HoverCard, null,
          React.createElement(ReferenceAttachment, {...props, previewTrigger: true}),
          React.createElement(SelectionPreview, null, details))
        : React.createElement(SentReferenceAttachment, {...props, details}))
    `
  },
  configureServer(server) {
    server.middlewares.use('/attachment-hover.html', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        await server.transformIndexHtml(
          '/attachment-hover.html',
          '<div id="root" style="padding:32px"></div><script type="module">import "attachment-hover"</script>'
        )
      )
    })
  },
}

test('reference details are triggered by the entire card', { timeout: 60_000 }, async (context) => {
  const fixture = await renderFixture(ROOT, {
    create: (config) => createServer({ ...config, plugins: [...(config.plugins ?? []), plugin] }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  for (const mode of ['draft', 'sent']) {
    await page.goto(new URL(`/attachment-hover.html?${mode}`, fixture.url).href)
    const details = page.getByTestId('reference-details')
    const label = page.getByRole('button', { name: '3 selections', exact: true })
    await page.getByText('Source document', { exact: true }).hover()
    await expect(details).toBeVisible()
    await page.getByTestId('reference-icon').hover()
    await expect(details).toBeVisible()
    await page.getByTestId('reference-card').hover({ position: { x: 2, y: 2 } })
    await expect(details).toBeVisible()
    await expect(label).toHaveCSS('cursor', 'pointer')
    await label.hover()
    await expect(details).toBeVisible()
    await expect
      .poll(async () => {
        const card = await page.getByTestId('reference-card').boundingBox()
        const popup = await details.locator('xpath=ancestor::*[@role="region"]').boundingBox()
        return Math.abs(popup!.x - card!.x)
      })
      .toBeLessThan(1)
    await details.hover()
    await expect(details).toBeVisible()
    await page.mouse.move(0, 0)
    await expect(details).toBeHidden()
    await label.focus()
    await expect(details).toBeVisible()
  }
})
