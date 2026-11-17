import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { renderServers } from '../../../../test-helpers/render.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const ENTRY = '\0authorization-entry'
const STORE = '\0authorization-store'
const servers = renderServers({ after })

test('execution logs fold independently without hiding or remounting the authorization status and conversation card', async () => {
  const server = await servers.create({
    root: ROOT,
    cacheKey: 'authorization-visibility',
    configFile: false,
    plugins: [
      {
        name: 'authorization-visibility',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === 'authorization-entry') return ENTRY
          if (source === '../../store' && importer?.endsWith('/Authorization.tsx')) return STORE
        },
        load(id) {
          if (id === STORE)
            return `
              const state = {activeSession: 'thread', threads: {thread: {
                sessionId: 'session', running: false, readOnly: false,
                conversation: [
                  {kind: 'display_card', turnId: 'turn', card: {cardId: 'result'}},
                  {kind: 'hil', requestId: 'authorization', hilKind: 'question', hilState: 'resolved',
                    questions: [{id: 'precise-search-fulltext:q', header: '精准检索授权',
                      question: 'Read?', resultCardId: 'result', options: [{label: '一键授权'}, {label: '拒绝'}]}],
                    answers: {'precise-search-fulltext:q': '拒绝'}},
                  {kind: 'display_card', turnId: 'turn', card: {cardId: 'approved-result'}},
                  {kind: 'hil', requestId: 'approved-authorization', hilKind: 'question', hilState: 'resolved',
                    questions: [{id: 'precise-search-fulltext:approved', question: 'Read?',
                      resultCardId: 'approved-result', papers: [
                        {id: 'chosen', label: 'Selected paper'}, {id: 'other', label: 'Unselected paper'}
                      ]}],
                    selectedPaperIds: ['chosen'], decisionSource: 'user_explicit',
                    answers: {'precise-search-fulltext:approved': '一键授权'}},
                  {kind: 'display_card', turnId: 'turn', card: {cardId: 'timed-out-result'}},
                  {kind: 'hil', requestId: 'timed-out-authorization', hilKind: 'question', timedOut: true,
                    questions: [{id: 'precise-search-fulltext:timed-out', question: 'Read?',
                      resultCardId: 'timed-out-result'}]}
                ], turnOutcomes: {turn: 'completed'}
              }}}
              export const useApp = () => ({state, act: {}})
              export const activeThread = value => value.threads[value.activeSession]
            `
          if (id === ENTRY)
            return `
              import '/src/renderer/src/styles.css'
              import React from 'react'
              import {createRoot} from 'react-dom/client'
              import {I18nextProvider} from 'react-i18next'
              import {createLocalization} from '/src/localization/engine.ts'
              import {resources} from '/src/localization/resources.ts'
              import {Button} from '/src/renderer/src/components/ui/index.ts'
              import {ExecutionBatch} from '/src/renderer/src/components/business/Execution.tsx'
              import {LiteratureAuthorizationNode, LiteratureAuthorizationReceipt} from '/src/renderer/src/features/literature/Authorization.tsx'
              function Card() {
                const [count, setCount] = React.useState(0)
                return React.createElement(Button, {onClick: () => setCount(value => value + 1)}, 'Card action ' + count)
              }
              function Authorization() {
                const [expanded, setExpanded] = React.useState(true)
                return React.createElement(React.Fragment, null,
                  React.createElement(ExecutionBatch, {label: 'Tool execution', failureCount: 1, expanded, onExpandedChange: setExpanded}, 'Execution log detail'),
                  React.createElement(LiteratureAuthorizationNode, {cardId: 'result'}, React.createElement(Card)),
                  React.createElement(LiteratureAuthorizationNode, {cardId: 'approved-result'}),
                  React.createElement(LiteratureAuthorizationNode, {cardId: 'timed-out-result'}),
                  ...['approved', 'rejected', 'timed-out'].map(status => {
                    const question = {id: 'precise-search-fulltext:standalone', question: 'Read?',
                      options: [{label: '一键授权'}, {label: '拒绝'}],
                      papers: [{id: 'chosen', label: 'Standalone selected paper'}, {id: 'other', label: 'Standalone unselected paper'}]}
                    return React.createElement('section', {'data-testid': 'standalone-' + status, key: status},
                      React.createElement(LiteratureAuthorizationReceipt, {
                        requestId: 'standalone-' + status, questions: [question],
                        answers: {[question.id]: status === 'approved' ? '一键授权' : '拒绝'},
                        selectedPaperIds: ['chosen'], decisionSource: 'user_explicit', timedOut: status === 'timed-out'
                      }))
                  }))
              }
              createRoot(document.getElementById('root')).render(React.createElement(I18nextProvider,
                {i18n: createLocalization('zh', resources)},
                React.createElement(Authorization)))
            `
        },
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url?.startsWith('/src/components/primitive/Iconfont/download/')) {
              request.url = request.url.replace('/src/components/', '/src/renderer/src/components/')
            }
            next()
          })
          server.middlewares.use('/__authorization', (_request, response, next) => {
            void server
              .transformIndexHtml(
                '/__authorization',
                '<div id="root"></div><script type="module" src="/@id/__x00__authorization-entry"></script>'
              )
              .then((html) => {
                response.setHeader('Content-Type', 'text/html')
                response.end(html)
              })
              .catch(next)
          })
        },
      },
      react(),
    ],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}__authorization`)
    const toggle = page.getByRole('button', { name: 'Tool execution', exact: true })
    const contentId = await toggle.getAttribute('aria-controls')
    assert.ok(contentId)
    const logs = page.locator('[id="' + contentId + '"]')
    const authorization = page.getByTestId('literature-authorization-node').first()
    const status = authorization.getByRole('button', { name: '用户未授权文献', exact: true })
    const detail = page.getByText('Execution log detail', { exact: true })
    await expect(status).toHaveText('用户未授权文献')
    await expect(authorization.getByTestId('turn-activity-trigger')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await expect(detail).toBeVisible()
    const card = page.getByRole('button', { name: 'Card action 0', exact: true })
    await expect(card).toBeVisible()
    await card.click()
    const changed = page.getByRole('button', { name: 'Card action 1', exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(logs).toHaveAttribute('data-state', 'closed')
    await expect(logs).toHaveAttribute('aria-hidden', 'true')
    await expect(logs).toHaveJSProperty('inert', true)
    await expect(logs.locator(':scope > div')).toHaveCSS('overflow', 'hidden')
    await expect
      .poll(() => logs.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(0)
    await expect(logs).toHaveCSS('grid-template-rows', '0px')
    await expect(status).toBeVisible()
    await expect(changed).toBeVisible()
    await expect(page.getByTestId('literature-reauthorize').first()).toBeVisible()
    assert.equal(
      await changed.evaluate((element) =>
        Boolean(element.closest('[data-testid="turn-activity"]'))
      ),
      false
    )
    await changed.click()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(logs).toHaveAttribute('data-state', 'open')
    await expect(logs).toHaveAttribute('aria-hidden', 'false')
    await expect(logs).toHaveJSProperty('inert', false)
    await expect
      .poll(() => logs.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(0)
    await expect(detail).toBeVisible()
    await expect(status).toBeVisible()
    await expect(page.getByRole('button', { name: 'Card action 2', exact: true })).toBeVisible()
    const approved = page
      .getByTestId('literature-authorization-node')
      .getByRole('button', { name: '用户已授权文献', exact: true })
    const history = page
      .getByTestId('literature-authorization-node')
      .filter({ has: page.getByRole('button', { name: '用户已授权文献', exact: true }) })
      .getByTestId('literature-authorization-history')
    await expect(approved).toHaveAttribute('aria-expanded', 'false')
    await approved.press('Enter')
    await expect(approved).toHaveAttribute('aria-expanded', 'true')
    await expect(history.getByRole('group', { name: '请求授权文献' })).toBeVisible()
    await expect(history.getByRole('button', { name: '调整授权范围' })).toBeDisabled()
    await expect(history.getByRole('checkbox', { name: '全选' })).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
    const selected = history.getByRole('checkbox', { name: 'Selected paper', exact: true })
    const unselected = history.getByRole('checkbox', { name: 'Unselected paper', exact: true })
    await expect(selected).toBeChecked()
    await expect(selected).toBeDisabled()
    await expect(unselected).not.toBeChecked()
    await expect(unselected).toBeDisabled()
    await expect(history.getByRole('button', { name: '确认授权' })).toBeDisabled()
    await expect(history.getByRole('button', { name: '拒绝' })).toBeDisabled()
    for (const [status, label] of [
      ['approved', '用户已授权文献'],
      ['rejected', '用户未授权文献'],
      ['timed-out', '文献授权超时'],
    ]) {
      const receipt = page.getByTestId('standalone-' + status)
      const trigger = receipt.getByRole('button', { name: label, exact: true })
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      await expect(receipt.getByRole('group', { name: '请求授权文献' })).not.toBeVisible()
      await trigger.press('Enter')
      await expect(receipt.getByRole('group', { name: '请求授权文献' })).toBeVisible()
      await expect(
        receipt.getByRole('checkbox', { name: 'Standalone selected paper', exact: true })
      ).toBeChecked()
      await expect(
        receipt.getByRole('checkbox', { name: 'Standalone unselected paper', exact: true })
      ).not.toBeChecked()
      for (const checkbox of await receipt.getByRole('checkbox').all())
        await expect(checkbox).toBeDisabled()
      await expect(receipt.getByRole('button', { name: '确认授权', exact: true })).toBeDisabled()
      await expect(receipt.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled()
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    }
    const timeout = page
      .getByTestId('literature-authorization-node')
      .getByRole('alert')
      .filter({ hasText: '文献授权超时' })
    const warning = timeout.getByRole('img')
    await expect(warning).toBeVisible()
    await expect(status.getByRole('img')).toHaveCount(0)
    await expect(approved.getByRole('img')).toHaveCount(0)
    assert.equal(
      await warning.locator('svg').evaluate((icon) => icon.outerHTML),
      await page
        .getByTestId('tool-batch-warning')
        .first()
        .locator('svg')
        .evaluate((icon) => icon.outerHTML)
    )
    const screenshots = process.env.SCHOLARSEED_AUTHORIZATION_SCREENSHOTS
    if (screenshots) {
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      await status.screenshot({ path: path.join(screenshots, 'not-authorized.png') })
      await timeout.screenshot({ path: path.join(screenshots, 'timed-out.png') })
    }
    await approved.click()
    await expect(approved).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await browser.close()
    await server.close()
  }
})
