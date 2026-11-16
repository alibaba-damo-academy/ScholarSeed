import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { createServer, type Plugin } from 'vite'
import { renderFixture } from '../../../../test-helpers/render.ts'
import componentsZh from '../../../../localization/locales/zh/components.json' with { type: 'json' }

const ROOT = path.resolve(import.meta.dirname, '../..')
const ENTRY = '\0confirmation-example'
const plugin: Plugin = {
  name: 'confirmation-example',
  resolveId: (source) => (source === 'confirmation-example' ? ENTRY : undefined),
  load(id) {
    if (id !== ENTRY) return
    if (process.env.CONFIRMATION_BUSINESS_FIXTURE === '1')
      return `
      import React, {useState} from 'react'
      import {createRoot} from 'react-dom/client'
      import {I18nextProvider} from 'react-i18next'
      import {createLocalization} from '/@fs/${path.resolve(ROOT, '../../localization/engine.ts')}'
      import {resources} from '/@fs/${path.resolve(ROOT, '../../localization/resources.ts')}'
      import {HilCard} from '/components/business/Stream.tsx'
      import {InteractionPolicyProvider} from '/components/business/Interactions.tsx'
      import {fileRecovery, saveRecovery} from '/features/assistant/recovery.ts'
      import {TooltipProvider} from '/components/ui'
      import '/styles.css'
      const localization = createLocalization('zh', resources, {report: () => undefined})
      const scenario = new URLSearchParams(location.search).get('case')
      const target = 'C:\\\\研究资料\\\\' + '长路径'.repeat(32) + '\\\\研究简报.md'
      const question = {id: 'file-recovery:fixture', header: scenario === 'read' ? 'file_read_failed' : 'file_write_denied', question: 'broken.pdf', options: [{label:'retry_file'},{label:scenario === 'read' ? 'remove_file' : 'cancel_save'}]}
      const initial = {kind:'hil', requestId:'request', turnId:'turn', body:'', hilState:'pending',
        hilKind:scenario === 'file' ? 'file_approval' : scenario === 'command' ? 'command_approval' : ['permission','destructive'].includes(scenario) ? 'permission' : 'question',
        ...(scenario === 'file' ? {changes:[{path:target,kind:'add'}]} : scenario === 'command' ? {command:'echo text > /outside.md'} : ['permission','destructive'].includes(scenario) ? {safetyTags:scenario === 'destructive' ? ['destructive'] : []} : {questions:[question]})}
      window.responses = []
      window.settingsOpened = 0
      window.scholarseed = {openSystemPermission:async () => {window.settingsOpened += 1;return true}}
      function Fixture() {
        const [item,setItem] = useState(initial)
        const controller = {sessionId:'session',threadId:'thread',
          patchThread:(_thread,update) => setItem(current => (typeof update === 'function' ? update({conversation:[current]}) : update).conversation?.[0] ?? current),
          respond:async (_session,_request,body) => {window.responses.push(body);return {ok:false,outcome:'failed',error:'fixture-rejected'}},
          interrupt:async () => ({})}
        return React.createElement(InteractionPolicyProvider,{policies:[fileRecovery,saveRecovery]},React.createElement(HilCard,{item,presentation:'dock',controller}))
      }
      createRoot(document.getElementById('root')).render(React.createElement(I18nextProvider,{i18n:localization},React.createElement(TooltipProvider,null,React.createElement(Fixture))))
    `
    return `
      import React, {useState} from 'react'
      import {createRoot} from 'react-dom/client'
      import {I18nextProvider} from 'react-i18next'
      import {createLocalization} from '/@fs/${path.resolve(ROOT, '../../localization/engine.ts')}'
      import {resources} from '/@fs/${path.resolve(ROOT, '../../localization/resources.ts')}'
      import {ConfirmationExample} from '/components/examples/Confirmation.tsx'
      import {LiteratureAuthorizationCard} from '/features/literature/Scope.tsx'
      import {TooltipProvider} from '/components/ui'
      import '/styles.css'
      const localization = createLocalization('zh', resources, {report: () => undefined})
      function LongSelection() {
        const papers = Array.from({length: 30}, (_, index) => ({id: String(index), label: 'Paper ' + index}))
        const [selected, setSelected] = useState(papers.map(paper => paper.id))
        return React.createElement(LiteratureAuthorizationCard, {
          selectable: true, papers, selectedPaperIds: selected, expanded: true,
          onExpandedChange: () => undefined, onSelectionChange: setSelected,
          onAllow: () => undefined, onDeny: () => undefined,
        })
      }
      createRoot(document.getElementById('root')).render(
        React.createElement(I18nextProvider, {i18n: localization},
          React.createElement(TooltipProvider, null, React.createElement(
            location.search.includes('long-selection') ? LongSelection : ConfirmationExample))))
    `
  },
  configureServer(server) {
    server.middlewares.use('/confirmation-example.html', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        await server.transformIndexHtml(
          '/confirmation-example.html',
          '<div id="root"></div><script type="module">import "confirmation-example"</script>'
        )
      )
    })
  },
}

test(
  'file approval and recovery use custom confirmation without changing decisions',
  { timeout: 90_000 },
  async (context) => {
    process.env.CONFIRMATION_BUSINESS_FIXTURE = '1'
    context.after(() => {
      delete process.env.CONFIRMATION_BUSINESS_FIXTURE
    })
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
      create: (config) => createServer({ ...config, plugins: [...(config.plugins ?? []), plugin] }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const scenario of ['file', 'read', 'write', 'command', 'permission', 'destructive']) {
      await page.goto(new URL('/confirmation-example.html?case=' + scenario, fixture.url).href)
      const card = page.getByTestId('hil-card')
      const confirmation = card.getByRole('group').first()
      await expect(confirmation).toBeVisible()
      if (scenario === 'file') {
        await expect(confirmation).toHaveAttribute('aria-label', '请求文件访问权限')
        await expect(confirmation).toContainText('路径')
        await expect(confirmation).toContainText('创建并写入文件')
        await expect(confirmation).toContainText('仅本次文件变更、仅上述路径')
        await expect(
          confirmation.getByRole('button', { name: '允许本次访问', exact: true })
        ).toBeVisible()
        await page.setViewportSize({ width: 480, height: 720 })
        assert.equal(
          await confirmation.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true
        )
        const detail = confirmation.locator('dd').first()
        assert.equal(
          await detail.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true
        )
        await confirmation.getByRole('button', { name: '允许本次访问', exact: true }).click()
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { responses: unknown[] }).responses)
          )
          .toEqual([{ option_id: 'accept' }])
        await expect(card.getByTestId('hil-submit-error')).toBeVisible()
        await expect(
          confirmation.getByRole('button', { name: '允许本次访问', exact: true })
        ).toBeEnabled()
        await card.focus()
        await page.keyboard.press('Escape')
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { responses: unknown[] }).responses)
          )
          .toEqual([{ option_id: 'accept' }, { option_id: 'decline' }])
      } else if (scenario === 'permission' || scenario === 'destructive') {
        await expect(confirmation.locator('.lucide-triangle-alert')).toHaveCount(
          scenario === 'destructive' ? 1 : 0
        )
        await expect(confirmation.locator('kbd')).toHaveCount(0)
        await confirmation.locator('[data-hil-decision="allow-once"]').click()
        await expect(card.getByTestId('hil-submit-error')).toBeVisible()
        await expect(confirmation.locator('[data-hil-decision="deny"]')).toBeEnabled()
        await confirmation.locator('[data-hil-decision="deny"]').click()
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { responses: unknown[] }).responses)
          )
          .toEqual([{ option_id: 'accept' }, { option_id: 'decline' }])
      } else if (scenario === 'command') {
        await expect(confirmation).toHaveAccessibleName(componentsZh.stream.hil.access.commandTitle)
        await expect(confirmation).not.toContainText('仅本次文件变更')
        await expect(confirmation).toContainText(componentsZh.stream.hil.access.commandScope)
        await expect(confirmation.getByTestId('hil-command-details')).toHaveText(
          'echo text > /outside.md'
        )
        await expect(confirmation.locator('dd')).toHaveCount(3)
      } else {
        const primary = confirmation.getByTestId('hil-question-option-0-0')
        if (scenario === 'write') {
          await expect(primary).toHaveText('去授权')
          await primary.click()
          await expect
            .poll(() =>
              page.evaluate(() => (window as unknown as { settingsOpened: number }).settingsOpened)
            )
            .toBe(1)
          assert.deepEqual(
            await page.evaluate(() => (window as unknown as { responses: unknown[] }).responses),
            []
          )
        }
        await expect(primary).toHaveText('重试')
        await primary.click()
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { responses: unknown[] }).responses)
          )
          .toEqual([{ answers: { 'file-recovery:fixture': 'retry_file' } }])
        await expect(card.getByTestId('hil-submit-error')).toBeVisible()
        await expect(primary).toBeEnabled()
        await confirmation.getByTestId('hil-question-option-0-1').click()
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { responses: unknown[] }).responses.length)
          )
          .toBe(2)
        const responses = await page.evaluate(
          () => (window as unknown as { responses: unknown[] }).responses
        )
        assert.deepEqual(responses[1], {
          answers: { 'file-recovery:fixture': scenario === 'read' ? 'remove_file' : 'cancel_save' },
        })
      }
    }
    assert.deepEqual(errors, [])
  }
)

test(
  'authorization selection scrolls papers without moving select all',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
      create: (config) => createServer({ ...config, plugins: [...(config.plugins ?? []), plugin] }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(new URL('/confirmation-example.html?long-selection', fixture.url).href)
    const viewport = page.getByTestId('hil-question-scroll-area')
    const selectAll = page.getByTestId('hil-subset-all-0')
    await expect(selectAll).toBeVisible()
    assert.equal(await viewport.getByTestId('hil-subset-all-0').count(), 0)
    const before = await selectAll.boundingBox()
    await viewport.hover()
    await page.mouse.wheel(0, 1000)
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    assert.deepEqual(await selectAll.boundingBox(), before)
    await selectAll.click()
    await expect(page.getByRole('button', { name: '确认授权', exact: true })).toBeDisabled()
    await selectAll.click()
    await expect(page.getByTestId('hil-subset-paper-0-29')).toBeChecked()
  }
)

test(
  'confirmation material shares four variants, collapsed selection and custom content',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      create: (config) => createServer({ ...config, plugins: [...(config.plugins ?? []), plugin] }),
      launch: () => chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(new URL('/confirmation-example.html', fixture.url).href)
    await expect(page.getByRole('button', { name: '带勾选功能', exact: true }))
      .toBeVisible()
      .catch((error) => {
        throw new Error(`${error.message}\n${errors.join('\n')}`)
      })
    const toggle = page.getByTestId('hil-question-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await toggle.focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('hil-subset-all-0').click()
    await expect(page.getByRole('button', { name: '确认授权', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
    await page.getByTestId('hil-subset-paper-0-paper-a').click()
    await toggle.click()
    await toggle.click()
    await expect(page.getByTestId('hil-subset-paper-0-paper-a')).toBeChecked()
    for (const label of ['普通权限', '高风险权限']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await expect(page.getByRole('group', { name: '请求权限', exact: true })).toBeVisible()
    }
    await expect(page.locator('svg.lucide-triangle-alert')).toBeVisible()
    await page.getByRole('button', { name: '自定义内容', exact: true }).click()
    await expect(page.getByRole('group', { name: '请求文件访问权限', exact: true })).toBeVisible()
    await expect(page.getByText('~/Documents/组会材料/研究简报.md', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '允许本次访问', exact: true }).click()
    await expect(page.getByRole('group', { name: '请求文件访问权限', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '重置交互演示', exact: true }).click()
    await expect(page.getByRole('group', { name: '请求文件访问权限', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 480, height: 720 })
    const bounds = await page
      .getByRole('group', { name: '请求文件访问权限', exact: true })
      .boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 480)
    assert.deepEqual(errors, [])
  }
)
