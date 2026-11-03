import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { transformSync } from 'esbuild'
import { chromium } from '@playwright/test'
import { compile } from 'tailwindcss'

type Element = React.ReactElement<React.PropsWithChildren<Record<string, unknown>>>

function descendants(element: Element): Element[] {
  return [
    element,
    ...React.Children.toArray(element.props.children).flatMap((child) =>
      React.isValidElement(child) ? descendants(child as Element) : []
    ),
  ]
}

test('document breadcrumbs remain visible by default and can be hidden without removing toolbar actions', () => {
  const compiled = transformSync(
    `${readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')}\nexport { DocumentToolbar }`,
    { loader: 'tsx', format: 'cjs', jsx: 'transform' }
  ).code
  const dependencies: Record<string, unknown> = {
    react: { ...React, useState: (value: unknown) => [value, () => undefined] },
    'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
    '../../store': { useApp: () => ({ state: {} }) },
    './workspace': { useWorkspaceController: () => ({}) },
  }
  const loaded = { exports: {} as { DocumentToolbar: (props: Record<string, unknown>) => Element } }
  runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    require: (name: string) =>
      dependencies[name] ?? new Proxy({}, { get: (_target, key) => String(key) }),
  })
  const props = {
    activePanelId: null,
    panels: [],
    session: {
      source: { kind: 'project', path: 'resources/image.jpg' },
      capabilities: { can_save: false, can_preview: true },
      versioning: { management_state: 'ignored' },
    },
    onPanelToggle: () => undefined,
  }
  for (const showBreadcrumb of [undefined, false, true]) {
    const controls = descendants(loaded.exports.DocumentToolbar({ ...props, showBreadcrumb }))
    assert.equal(
      controls.some((child) => child.type === 'Breadcrumb'),
      showBreadcrumb !== false
    )
    assert.ok(controls.some((child) => child.type === 'Badge'))
    assert.ok(
      controls.some(
        (child) => typeof child.type === 'function' && child.type.name === 'DocumentVersionActions'
      )
    )
    assert.ok(controls.some((child) => child.type === 'DocumentExternalOpen'))
  }
})

test('empty toolbar collapses its row and restores it when content appears', async () => {
  const source = readFileSync(new URL('./Dock.tsx', import.meta.url), 'utf8')
  const candidates = source.match(/(?:has-\[|\[&:not\()[^\s"'`]+/g) ?? []
  const compiler = await compile('@tailwind utilities;')
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>
      .vds-document-view { display: grid; height: 400px; grid-template-rows: 48px minmax(0, 1fr); }
      .vds-document-toolbar { display: flex; padding: 8px 16px; border-bottom: 1px solid; }
      ${compiler.build(candidates)}
      </style><div class="vds-document-view ${candidates.filter((candidate) => candidate.startsWith('has-')).join(' ')}">
        <div class="vds-document-toolbar ${candidates.filter((candidate) => candidate.startsWith('[&')).join(' ')}"><div class="vds-document-toolbar-spacer"></div></div>
        <main></main>
      </div>`)
    const toolbar = page.locator('.vds-document-toolbar')
    const content = page.locator('main')
    assert.equal(await toolbar.isVisible(), false)
    assert.equal((await content.boundingBox())?.height, 400)
    for (const tag of ['button', 'span', 'nav']) {
      await toolbar.evaluate(
        (element, tagName) => element.appendChild(document.createElement(tagName)),
        tag
      )
      assert.equal(await toolbar.isVisible(), true)
      assert.equal((await content.boundingBox())?.height, 352)
      await toolbar.locator(tag).evaluate((element) => element.remove())
      assert.equal(await toolbar.isVisible(), false)
      assert.equal((await content.boundingBox())?.height, 400)
    }
  } finally {
    await browser.close()
  }
})
