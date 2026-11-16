import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

test('paper previews and result links use workspace navigation after fulltext refusal', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from 'react'
        import {createRoot} from 'react-dom/client'
        import {I18nextProvider} from 'react-i18next'
        import {createLocalization} from '../../../../localization/engine'
        import {resources} from '../../../../localization/resources'
        import {StoreContext} from '../../storeContext'
        import {WebNavigationContext} from '../../contracts/navigation'
        import {Button, ToastProvider} from '../../components/ui'
        import {LiteratureCard} from './Card'
        import {LiteratureResults} from './Summary'
        import {LiteratureSearchView} from './Search'
        const papers = Array.from({length: 8}, (_, index) => ({
          id: 'paper-' + index, title: 'Paper ' + index, authors: [], year: 2025,
          url: index === 7 ? 'javascript:alert(1)' : 'https://example.com/paper-' + index,
          reasons: [], sources: [], access: 'unknown'
        }))
        const content = {schema_version: '1.0', session_id: 'session', run_id: 'run', round: 1,
          status: 'success', retained: 8, papers: papers.slice(0, 3), criteria: [], sources: [], warnings: [],
          metadata: {artifact_id: 'metadata'}, selection: {artifact_id: 'selection'}}
        let failures = 0
        window.fetch = async url => {
          if (url.endsWith('/stale')) {
            await new Promise(resolve => setTimeout(resolve, 200))
            window.staleReturned = true
          }
          if (url.endsWith('/broken') && failures++ === 0) return new Response('', {status: 503})
          if (url.endsWith('/mismatched')) return new Response(JSON.stringify({...content, papers, run_id: 'another-run'}))
          return new Response(JSON.stringify({...content, papers}))
        }
        window.scholarseed = {getApiBase: () => 'https://example.com',
          openExternal: () => {throw new Error('external_navigation_forbidden')}}
        function SwitchingCard() {
          const [current, setCurrent] = React.useState(content)
          return <section aria-label="Changed snapshot">
            <Button onClick={() => setCurrent({...content, run_id: 'replacement', retained: 1, papers: papers.slice(0, 1)})}>Replace snapshot</Button>
            <LiteratureCard type="literature-search" cardId="stale" content={current} />
          </section>
        }
        function Fixture() {
          const [opened, setOpened] = React.useState('')
          return <I18nextProvider i18n={createLocalization('en', resources)}>
            <StoreContext.Provider value={{state: {activeSession: 'thread', projects: [],
              threads: {thread: {sessionId: 'session', running: false, conversation: [
                {kind: 'display_card', turnId: 'turn', card: {cardId: 'result', type: 'literature-search', content}},
                {kind: 'hil', turnId: 'turn', requestId: 'authorization', hilKind: 'question', hilState: 'resolved',
                  questions: [{id: 'precise-search-fulltext:q', question: 'Read?', resultCardId: 'result',
                    options: [{label: '一键授权'}, {label: '拒绝'}]}],
                  answers: {'precise-search-fulltext:q': '拒绝'}, decisionSource: 'user_explicit'}
              ]}}}, act: {}}}>
              <WebNavigationContext.Provider value={setOpened}>
                <ToastProvider>
                  <section aria-label="Conversation"><LiteratureCard type="literature-search" cardId="result" content={content} /></section>
                  <section aria-label="Load failure"><LiteratureCard type="literature-search" cardId="broken" content={content} /></section>
                  <section aria-label="Mismatched snapshot"><LiteratureCard type="literature-search" cardId="mismatched" content={content} /></section>
                  <SwitchingCard />
                  <section aria-label="Failure"><LiteratureResults content={content} ports={{openResults: async () => {}, openSource: async () => {throw new Error('unavailable')}}} /></section>
                  <section aria-label="Results"><LiteratureSearchView papers={papers} columnSet="search" /></section>
                  <output aria-label="Opened">{opened}</output>
                </ToastProvider>
              </WebNavigationContext.Provider>
            </StoreContext.Provider>
          </I18nextProvider>
        }
        createRoot(document.getElementById('root')).render(<Fixture />)
      `,
    },
    bundle: true,
    nodePaths: [fileURLToPath(new URL('../../../../../node_modules', import.meta.url))],
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: {
      '.css': 'empty',
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.webp': 'dataurl',
      '.gif': 'dataurl',
    },
  })
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole('button', { name: 'Replace snapshot', exact: true }).click()
    const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
    await expect(conversation.getByRole('listitem')).toHaveCount(8)
    await expect(conversation).toContainText('Full-text authorization was declined')
    const first = conversation.getByRole('link', { name: 'Paper 0', exact: true })
    await first.focus()
    await first.press('Enter')
    await expect(page.getByLabel('Opened')).toHaveText('https://example.com/paper-0')
    await expect(conversation.getByRole('link', { name: 'Paper 7', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    await page
      .getByRole('region', { name: 'Results', exact: true })
      .getByRole('link', { name: 'Paper 1', exact: true })
      .click()
    await expect(page.getByLabel('Opened')).toHaveText('https://example.com/paper-1')
    const failure = page.getByRole('region', { name: 'Failure', exact: true })
    await failure.getByRole('link', { name: 'Paper 0', exact: true }).click()
    await expect(failure.getByRole('alert')).toBeVisible()
    await expect(conversation.getByRole('listitem')).toHaveCount(8)
    const loadFailure = page.getByRole('region', { name: 'Load failure', exact: true })
    await expect(
      loadFailure.getByText('These search results are currently unavailable. Try again.')
    ).toBeVisible()
    await loadFailure.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(loadFailure.getByRole('listitem')).toHaveCount(8)
    const mismatch = page.getByRole('region', { name: 'Mismatched snapshot', exact: true })
    await expect(
      mismatch.getByText('These search results are currently unavailable. Try again.')
    ).toBeVisible()
    await expect(mismatch.getByRole('listitem')).toHaveCount(3)
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'staleReturned'))).toBe(true)
    await expect(
      page.getByRole('region', { name: 'Changed snapshot', exact: true }).getByRole('listitem')
    ).toHaveCount(1)
  } finally {
    await browser.close()
  }
})
