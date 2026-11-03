import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { transformWithEsbuild, type Plugin } from 'vite'
import { renderServers } from '../../../../test-helpers/render.ts'

const servers = renderServers({ after })
const ROOT = path.resolve(import.meta.dirname, '../..')
const ENTRY = '/nextsteps-probe.tsx'
const STORE = '\0nextsteps-store'
const TRANSLATION = '\0nextsteps-translation'
const WIDTHS = [320, 600]
const CASES = [
  {
    label: 'Deep · Literature support',
    description:
      'Search related work for these ideas, add a literature map and traceable citations, and check the novelty of each proposed research direction.',
  },
  { label: 'ResearchDirection'.repeat(10), description: 'outputs/research_ideas/'.repeat(30) },
  {
    label: '文献支撑',
    description: '检索相关工作并补充可追溯引用，检查每个研究方向的新颖性。'.repeat(8),
  },
]
const plugin: Plugin = {
  name: 'nextsteps-probe',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === ENTRY) return ENTRY
    if (source === 'react-i18next') return TRANSLATION
    if (source === '../../store' && importer?.endsWith('/assistant/NextSteps.tsx')) return STORE
    return null
  },
  async load(id) {
    if (id === TRANSLATION)
      return `export const useTranslation = () => ({t: key => key, i18n: {language: 'en'}})`
    if (id === STORE)
      return `
      const thread = {sessionId: 'session', turnOutcomes: {turn: 'completed'}, conversation: [
        {kind: 'display_card', turnId: 'turn', card: {cardId: 'card'}}
      ]}
      export const activeThread = () => thread
      export const useApp = () => ({state: {}, composerSubmission: {
        subscribe: () => () => {}, getSnapshot: () => 'session', consumed: () => false,
        submit: async (...args) => {window.submissions.push(args); return true}
      }})
    `
    if (id !== ENTRY) return null
    return (
      await transformWithEsbuild(
        `
      import React from 'react'
      import {createRoot} from 'react-dom/client'
      import {NextSteps} from '/features/assistant/NextSteps.tsx'
      import '/styles.css'
      const params = new URLSearchParams(location.search)
      const option = ${JSON.stringify(CASES)}[Number(params.get('sample'))]
      const content = {title: 'What would you like to do next?', options: [option,
        {label: 'Validation · Validation plan', description: 'Develop an experiment protocol.'}],
        free_text_label: 'Other requests', submit_label: 'Send'}
      window.submissions = []
      createRoot(document.getElementById('root')).render(
        <div style={{width: Number(params.get('width'))}}>
          <NextSteps cardId="card" turnId="turn" content={content}/>
        </div>)
    `,
        'nextsteps-probe.tsx',
        { loader: 'tsx', jsx: 'automatic', tsconfigRaw: {} }
      )
    ).code
  },
  configureServer(server) {
    server.middlewares.use('/__nextsteps', (_request, response, next) => {
      server
        .transformIndexHtml(
          '/__nextsteps',
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

test('next-step options wrap complete text inside their buttons and preserve submission', async () => {
  const server = await servers.create({
    configFile: false,
    root: ROOT,
    plugins: [plugin, react()],
    cacheKey: 'nextsteps',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => process.stderr.write(error.stack + '\n'))
    page.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(message.text() + '\n')
    })
    for (const width of WIDTHS) {
      for (const [sample, option] of CASES.entries()) {
        await page.goto(
          `${server.resolvedUrls!.local[0]}__nextsteps?width=${width}&sample=${sample}`,
          { waitUntil: 'domcontentloaded' }
        )
        const card = page.getByTestId('next-steps-card')
        const button = card.getByRole('button').first()
        await expect(button).toBeEnabled()
        const geometry = await button.evaluate((element) => ({
          whiteSpace: getComputedStyle(element).whiteSpace,
          client: element.clientWidth,
          scroll: element.scrollWidth,
          children: Array.from(element.children).map((child) => {
            const rect = child.getBoundingClientRect()
            const parent = element.getBoundingClientRect()
            return {
              inside: rect.left >= parent.left && rect.right <= parent.right,
              client: child.clientWidth,
              scroll: child.scrollWidth,
            }
          }),
        }))
        assert.equal(geometry.whiteSpace, 'normal', JSON.stringify({ width, sample, geometry }))
        assert.ok(geometry.scroll <= geometry.client, JSON.stringify({ width, sample, geometry }))
        assert.ok(
          geometry.children.every((child) => child.inside && child.scroll <= child.client),
          JSON.stringify({ width, sample, geometry })
        )
        await expect(button.locator('span').first()).toHaveText(option.label)
        await expect(button.locator('span').last()).toHaveText(option.description)
        await button.focus()
        await page.keyboard.press('Enter')
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as { submissions: unknown[] }).submissions),
          [['session', 'card', `${option.label}\n${option.description}`]]
        )
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})
