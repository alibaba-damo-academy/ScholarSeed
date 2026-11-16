import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const DESKTOP = fileURLToPath(new URL('../../../../../', import.meta.url))

test('bibliography card renders untrusted metadata as text and supports links, missing data and stale resolutions', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, { useRef, useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { BibliographyCard } from './src/renderer/src/features/workbench/ReferencePreview'
        const metadata = {version:1,title:'Title <script>window.bad=true</script> 中文',authors:'Ada; 李明',year:'2025',publication:'Journal',url:'https://example.org/paper',doi:''}
        window.opened=[]
        window.pending={}
        const resolve = handle => new Promise((done, fail) => {window.pending[handle]={done,fail}})
        function Fixture() {
          const anchor = useRef(null)
          const [open,setOpen]=useState(false)
          const [handle,setHandle]=useState(undefined)
          const [referenceHref,setReferenceHref]=useState(undefined)
          const [preview,setPreview]=useState({metadata,reference:'original reference'})
          window.display=(next)=>{setHandle(next);setOpen(true)}
          window.split=()=>{setHandle(undefined);setReferenceHref('references.md#ref-key');setOpen(true)}
          window.legacy=()=>{setHandle(undefined);setPreview({metadata:null,reference:'[1] Original citation, not guessed fields.'});setOpen(true)}
          return <><button ref={anchor} onFocus={()=>setOpen(true)}>reference</button>{open&&<BibliographyCard anchorRef={anchor} preview={preview} handle={handle} referenceHref={referenceHref} resolveReference={resolve} resolve={resolve} onClose={()=>setOpen(false)} onEnter={()=>{}} onLeave={()=>{}} onOpen={url=>window.opened.push(url)}/>}</>
        }
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'import.meta.env.DEV': 'false' },
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        name: 'bibliography-test-i18n',
        setup(builder) {
          builder.onResolve({ filter: /^react-i18next$/ }, () => ({
            path: 'i18n',
            namespace: 'test',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const useTranslation = () => ({t:key=>key})',
            loader: 'js',
          }))
        },
      },
    ],
  })
  const stylesheet = join(DESKTOP, 'src/renderer/src/styles.css')
  const compiled = await postcss([tailwindcss({ base: join(DESKTOP, 'src/renderer') })]).process(
    readFileSync(stylesheet, 'utf8'),
    { from: stylesheet }
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: compiled.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole('button', { name: 'reference', exact: true }).focus()
    await page.evaluate(() => Reflect.get(window, 'display')(undefined))
    const card = page.getByTestId('bibliography-preview')
    await expect(card).toHaveCSS('width', '320px')
    await expect(card).toContainText('Ada; 李明')
    await expect(card).toContainText('Journal')
    await expect(card.locator('script')).toHaveCount(0)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'bad')), undefined)
    await card.getByRole('button').click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'opened')), [
      'https://example.org/paper',
    ])
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'legacy')())
    await expect(card).toContainText('[1] Original citation, not guessed fields.')
    await expect(card.getByRole('button')).toHaveCount(0)
    await page.evaluate(() => Reflect.get(window, 'display')('old'))
    await expect(card.getByRole('status', { name: 'bibliography.loading' })).toBeVisible()
    await page.evaluate(() => Reflect.get(window, 'display')('new'))
    await page.evaluate(() => Reflect.get(window, 'pending').old.done({ title: 'Stale title' }))
    await expect(card).not.toContainText('Stale title')
    await page.evaluate(() => Reflect.get(window, 'pending').new.fail(new Error('unavailable')))
    await expect(card).toContainText('bibliography.failed')
    await page.evaluate(() => Reflect.get(window, 'split')())
    await expect(card.getByRole('status', { name: 'bibliography.loading' })).toBeVisible()
    await page.evaluate(() =>
      Reflect.get(window, 'pending')['references.md#ref-key'].done({
        metadata: {
          version: 1,
          title: 'Sibling reference',
          authors: 'Stored author',
          year: '2026',
          publication: 'Stored journal',
          url: '',
          doi: '',
        },
        reference: '[1] Sibling reference',
      })
    )
    await expect(card).toContainText('Sibling reference')
    await expect(card).toContainText('Stored author')
    await page.setViewportSize({ width: 480, height: 640 })
    await expect(card).toHaveCount(0)
  } finally {
    await browser.close()
  }
})
