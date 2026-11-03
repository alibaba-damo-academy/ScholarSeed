import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type Page } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import { PLUGIN_MESSAGE_CHANNEL } from '../../../../plugins.ts'
import { createPreviewSession } from './preview.ts'
import type { PluginScenario } from '../../../../plugins.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REVIEW_PACKAGE = path.resolve(
  ROOT,
  '../../../../../skills/community/literature-review/components'
)
const PACKAGE_ROOT = path.resolve(REVIEW_PACKAGE, '../..')
const { buildOfficialUI } = createRequire(import.meta.url)(
  path.resolve(PACKAGE_ROOT, '../../packages/ui/build.cjs')
)
const BUILTIN_PACKAGES = [
  'agentic-search',
  'precise-literature-search',
  'literature-review',
  'research-idea-partner',
]
test(
  'authorization selection validation remains independent of button appearance',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      for (const decision of ['authorize', 'reject']) {
        const page = await browser.newPage()
        await page.goto(
          new URL(
            '/components/business/plugin.render.fixture.html?mode=authorization',
            server.resolvedUrls!.local[0]
          ).href
        )
        const authorize = page.getByTestId('hil-question-option-0-0')
        const reject = page.getByTestId('hil-question-option-0-1')
        const selectAll = page.getByTestId('hil-subset-all-0')
        await expect(page.getByTestId('plugin-copy')).toHaveCount(0)
        await expect(authorize).toBeEnabled()
        await expect(selectAll).toBeChecked()
        await selectAll.click()
        await expect(authorize).toBeDisabled()
        await expect(reject).toBeEnabled()
        await page.getByTestId('hil-subset-paper-0-one').click()
        await expect(authorize).toBeEnabled()
        await expect(reject).toHaveClass((await authorize.getAttribute('class')) ?? '')
        if (decision === 'reject') {
          await page.getByTestId('hil-subset-paper-0-one').click()
          await expect(authorize).toBeDisabled()
          await expect(reject).toBeEnabled()
        }
        await (decision === 'authorize' ? authorize : reject).click()
        assert.deepEqual(await page.evaluate('window.fixture.requests.at(-1)'), {
          answers: {
            'precise-search-fulltext:fixture': decision === 'authorize' ? '一键授权' : '拒绝',
          },
          values: { selected_paper_ids: decision === 'authorize' ? ['one'] : [] },
        })
        await expect(authorize).toHaveCount(0)
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'isolated cards register text without clipboard access and replies copy persisted content without a frame',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<p>证据卡正文</p><button id="register">登记文本</button><output></output><script>
        let revision = 0;
        addEventListener('message', event => { if (event.data.state) revision = event.data.state.revision; if (event.data.requestId) document.querySelector('output').textContent = event.data.error || '已登记'; });
        document.querySelector('button').onclick = () => parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',requestId:'copy-current',revision,copy:{text:'证据卡正文'}}, '*');
      </script>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=copy',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
      await page.evaluate('window.fixture.resolve()')
      const guest = page.frameLocator('iframe')
      await expect(guest.getByText('证据卡正文')).toBeVisible()
      await expect(page.getByTestId('plugin-copy')).toHaveCount(0)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect.poll(() => page.evaluate('window.fixture.copied.at(-1)')).toContain('阅读开始')
      const copiedBeforeRegistration = await page.evaluate<number>('window.fixture.copied.length')
      await guest.getByRole('button', { name: '登记文本' }).click()
      await expect(guest.locator('output')).toHaveText('已登记')
      assert.equal(await page.evaluate('window.fixture.copied.length'), copiedBeforeRegistration)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect
        .poll(() => page.evaluate('window.fixture.copied.at(-1)'))
        .toBe('阅读开始\n\n证据卡正文\n\n阅读结论')
      assert.equal(
        await page.evaluate('window.fixture.copied.length'),
        copiedBeforeRegistration + 1
      )
      await page.getByRole('button', { name: '切换卡片' }).click()
      await expect(page.locator('iframe')).toHaveCount(0)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect
        .poll(() => page.evaluate('window.fixture.copied.at(-1)'))
        .toBe('阅读开始\n\n证据卡正文\n\n阅读结论')
      assert.deepEqual(errors, [])
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=copy&clipboard-failed=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBeGreaterThan(0)
      await page.evaluate('window.fixture.resolve()')
      await page.frameLocator('iframe').getByRole('button', { name: '登记文本' }).click()
      await expect(page.frameLocator('iframe').locator('output')).toHaveText('已登记')
      await expect(page.getByTestId('plugin-copy')).toHaveCount(0)
      await page.getByTestId('reply-copy-with-cards').click()
      await expect(page.getByTestId('reply-copy-with-cards')).toHaveAttribute(
        'data-copy-status',
        'error'
      )
      assert.deepEqual(await page.evaluate('window.fixture.copied'), [])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
test(
  'question pages preserve choices and submit all answers together',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=pagination',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByText('选择阅读目标', { exact: true })).toBeVisible()
      await expect(page.getByText('选择阅读深度', { exact: true })).toBeHidden()
      const first = page.getByRole('radio', { name: '理解方法 关注假设和方法细节' })
      await expect(first).not.toBeChecked()
      await first.click()
      await expect(page.getByTestId('hil-question-confirm')).toBeDisabled()
      const pages = page.getByTestId('hil-question-pages')
      await pages.getByRole('button', { name: '第 2 页', exact: true }).click()
      await page.getByRole('radio', { name: '深入阅读', exact: true }).click()
      await pages.getByRole('button', { name: '第 1 页', exact: true }).click()
      await expect(first).toBeChecked()
      await page.getByTestId('hil-question-confirm').click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      assert.deepEqual(await page.evaluate('window.fixture.requests.at(-1).answers'), {
        goal: '理解方法',
        depth: '深入阅读',
      })
      await expect(pages).toHaveCount(0)
      await expect(page.getByText('深入阅读', { exact: true })).toBeVisible()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
for (const changeScope of [false, true])
  test(
    `parent renders preserve local edits without weakening changed scope rejection: ${changeScope}`,
    { timeout: 60_000 },
    async () => {
      const server = await createServer({
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        const page = await browser.newPage()
        const submissionDiagnostics: string[] = []
        page.on('console', (message) => {
          if (message.text().startsWith('[plugin-submit]'))
            submissionDiagnostics.push(message.text())
        })
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<input aria-label="编辑"><button id="submit">确认编辑</button><button id="request">调用能力</button><output></output><p id="status"></p><script>
        const send = payload => parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',...payload}, '*');
        addEventListener('message', event => {
          if (event.data.state) { document.querySelector('input').value = event.data.state.data.initial; document.querySelector('#status').textContent = event.data.state.status; }
          if (event.data.requestId) document.querySelector('output').textContent = event.data.error || event.data.result.value;
        });
        document.querySelector('#submit').onclick = () => send({action:'select', values:{value:document.querySelector('input').value}});
        document.querySelector('#request').onclick = () => send({requestId:'request-one',action:'select',values:{value:'completed'}});
      </script>`,
          })
        })
        await page.goto(
          new URL(
            '/components/business/plugin.render.fixture.html?mode=state-refresh',
            server.resolvedUrls!.local[0]
          ).href
        )
        const guest = page.frameLocator('iframe')
        await expect(guest.getByRole('textbox')).toHaveValue('original')
        await guest.getByRole('textbox').fill('edited')
        await guest.getByRole('button', { name: '调用能力' }).click()
        await expect
          .poll(() =>
            page.evaluate(
              'window.fixture.requests.filter(item => item.operation === "plugin-valid").length'
            )
          )
          .toBeGreaterThan(0)
        await page.getByRole('button', { name: '父级重绘' }).click()
        await expect(page.getByTestId('refresh')).toHaveText('1')
        await expect(guest.getByRole('textbox')).toHaveValue('edited')
        if (changeScope) {
          await page.getByRole('button', { name: '修改业务数据' }).click()
          await expect(guest.getByRole('textbox')).toHaveValue('changed')
        }
        await page.evaluate('window.fixture.resolve()')
        await expect(guest.locator('output')).toHaveText(
          changeScope ? 'plugin_card_scope_changed' : 'completed'
        )
        await guest.getByRole('button', { name: '确认编辑' }).click()
        await expect(page.getByTestId('selected')).toHaveText('true')
        assert.deepEqual(await page.evaluate('window.submittedValues'), {
          value: changeScope ? 'changed' : 'edited',
        })
        for (const stage of ['received', 'authorized', 'dispatched']) {
          assert.ok(
            submissionDiagnostics.some((message) => message.includes(`"stage":"${stage}"`)),
            stage
          )
        }
        assert.ok(
          submissionDiagnostics.every(
            (message) => !message.includes('edited') && !message.includes('original')
          )
        )
        await page.getByRole('button', { name: '更新状态' }).click()
        await expect(guest.locator('#status')).toHaveText('resolved')
      } finally {
        await browser.close()
        await server.close()
      }
    }
  )
test(
  'preview validates before resolving and retries the same retained answer',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{feedback:'keep scope'}},'*')">提交范围</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installed&fail-validation=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe'), await page.locator('body').innerText()).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '提交范围' }).click()
      await expect(page.getByTestId('hil-card'))
        .toHaveAttribute('data-hil-state', 'failed')
        .catch(async (error) => {
          throw new Error(
            `${String(error)}\nRequests: ${JSON.stringify(await page.evaluate('window.fixture.requests'))}`
          )
        })
      await expect(page.getByTestId('hil-card')).toContainText('component.output_schema')
      await page.frameLocator('iframe').getByRole('button', { name: '提交范围' }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-validate").map(request => request.values)'
        ),
        [{ feedback: 'keep scope' }, { feedback: 'keep scope' }]
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
test(
  'revision-pinned public resources use the isolated frame and persist selection under StrictMode',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{selected_paper_ids:['one']}},'*')">选择论文</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=external-public',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
      await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
      await expect(page.getByTestId('external-selection')).toHaveText('true')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").at(-1).values'
        ),
        { selected_paper_ids: ['one'] }
      )
      assert.equal(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-open")[0].reference.fingerprint'
        ),
        'ui-release-one'
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)
let publicServer: Awaited<ReturnType<typeof createServer>> | undefined
let officialResources: string | undefined
after(async () => {
  await publicServer?.close()
  if (officialResources) await rm(officialResources, { recursive: true, force: true })
})

async function loadOfficialRuntime(page: Page): Promise<void> {
  if (!officialResources) {
    officialResources = await mkdtemp(path.join(os.tmpdir(), 'official-preview-'))
    await buildOfficialUI(officialResources)
  }
  await page.route('http://plugin.test/__ui__/**', (route) => {
    const asset = new URL(route.request().url()).pathname.slice('/__ui__/'.length)
    return route.fulfill({
      body: readFileSync(path.join(officialResources!, asset)),
      contentType: asset.endsWith('.js')
        ? 'text/javascript'
        : asset.endsWith('.css')
          ? 'text/css'
          : 'font/woff2',
    })
  })
  await page.addScriptTag({ url: 'http://plugin.test/__ui__/ui.js' })
}

async function openPackagedScenario(
  page: Page,
  name: string,
  id: string,
  variant?: string
): Promise<void> {
  page.on('pageerror', (error) => console.error(`${name}/${id}: ${error.stack}`))
  const directory = path.join(PACKAGE_ROOT, name)
  const descriptor = JSON.parse(
    readFileSync(path.join(directory, '.scholarseed-plugin.json'), 'utf8')
  )
  const component = descriptor.components.find((entry: { id: string }) => entry.id === id)
  const scenario = JSON.parse(
    readFileSync(path.join(directory, component.preview), 'utf8')
  ) as PluginScenario
  const selected = scenario.cases?.find((entry) => entry.label === variant)
  const session = createPreviewSession({
    ...scenario,
    ...selected,
    responses: { ...scenario.responses, ...selected?.responses },
  })
  await page.exposeFunction('previewRequest', (action: string, values: Record<string, unknown>) => {
    const response = session.execute(action, values)
    if (response.state === 'failed') throw new Error(String(response.data.error))
    return response.data.result
  })
  if (component.public && component.slot === 'literature.selection') {
    if (!officialResources) {
      officialResources = await mkdtemp(path.join(os.tmpdir(), 'official-selection-'))
      await buildOfficialUI(officialResources)
    }
    await page.route('http://plugin.test/**', (route) => {
      const asset = new URL(route.request().url()).pathname.slice(1)
      if (!asset)
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<div id="root"></div>',
        })
      if (asset === 'component.html')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<div id="root"></div><script>
        let state; const listeners = new Set();
        window.plugin = { onState(callback) { listeners.add(callback); if (state) callback(state); return () => listeners.delete(callback); }, submit(action, values) { parent.postMessage({ action, values }, '*'); } };
        addEventListener('message', event => { if (event.source !== parent) return; state = event.data; for (const listener of listeners) listener(state); });
        parent.postMessage({ ready: true }, '*');
      </script><script src="/__ui__/ui.js"></script><script src="/__ui__/selection.js"></script>`,
        })
      return route.fulfill({
        body: readFileSync(path.join(officialResources!, asset.replace(/^__ui__\//, ''))),
        contentType: asset.endsWith('.js')
          ? 'text/javascript'
          : asset.endsWith('.css')
            ? 'text/css'
            : 'font/woff2',
      })
    })
    await page.goto('http://plugin.test/')
    await page.evaluate(
      ({ data, slot }) => {
        const state = { data, slot, language: 'zh', status: 'pending' }
        const calls: { action: string; values: Record<string, unknown> }[] = []
        const frame = document.createElement('iframe')
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.src = '/component.html'
        Object.assign(window, { previewCalls: calls })
        addEventListener('message', (event) => {
          if (event.source !== frame.contentWindow) return
          if (event.data.action) {
            calls.push(event.data)
            state.data = { ...state.data, ...event.data.values }
          }
          frame.contentWindow!.postMessage(state, '*')
        })
        document.getElementById('root')!.append(frame)
      },
      { data: { ...scenario.data, ...selected?.data }, slot: component.slot }
    )
    await expect(page.frameLocator('iframe').getByRole('checkbox').first()).toBeVisible()
    return
  }
  if (component.public) {
    if (!publicServer) {
      publicServer = await createServer({
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await publicServer.listen()
    }
    await page.addInitScript(
      ({ data, slot, question }) => {
        const calls: { action: string; values: Record<string, unknown> }[] = []
        Object.assign(window, {
          previewCalls: calls,
          publicFixture: {
            slot,
            data: {
              ...data,
              ...(question ? { options: question.options, multiSelect: question.multiSelect } : {}),
            },
            request(action: string, values: Record<string, unknown>) {
              calls.push({ action, values })
              return (
                window as unknown as {
                  previewRequest: (
                    action: string,
                    values: Record<string, unknown>
                  ) => Promise<unknown>
                }
              ).previewRequest(action, values)
            },
          },
        })
      },
      {
        data: { ...scenario.data, ...selected?.data },
        slot: component.slot,
        question: scenario.interaction?.questions[0],
      }
    )
    await page.goto(
      new URL(
        '/components/business/plugin.render.fixture.html?mode=public',
        publicServer.resolvedUrls!.local[0]
      ).href
    )
    return
  }
  await page.route('http://plugin.test/**', (route) => {
    const asset = new URL(route.request().url()).pathname.slice(1)
    return route.fulfill(
      asset
        ? {
            body: readFileSync(path.join(directory, asset)),
            contentType: asset.endsWith('.js') ? 'text/javascript' : 'text/css',
          }
        : { body: '<div id="root"></div>', contentType: 'text/html' }
    )
  })
  await page.goto('http://plugin.test/')
  await page.evaluate(
    ({ data, slot }) => {
      let listener: ((state: unknown) => void) | undefined
      const state = { data, slot, language: 'zh', status: 'pending' }
      const calls: { action: string; values: Record<string, unknown> }[] = []
      Object.assign(window, {
        previewCalls: calls,
        plugin: {
          onState(callback: (state: unknown) => void) {
            listener = callback
            listener(state)
          },
          async request(action: string, values: Record<string, unknown> = {}) {
            calls.push({ action, values })
            const result = await (
              window as unknown as {
                previewRequest: (
                  action: string,
                  values: Record<string, unknown>
                ) => Promise<unknown>
              }
            ).previewRequest(action, values)
            listener?.({ ...state, status: 'resolved' })
            return result
          },
          submit() {},
          async setCopyContent(content: unknown) {
            Object.assign(window, { previewCopy: content })
            return { saved: true }
          },
        },
      })
    },
    { data: { ...scenario.data, ...selected?.data }, slot: component.slot }
  )
  await loadOfficialRuntime(page)
  await page.addScriptTag({ url: `http://plugin.test/${component.entry}` })
}

test(
  'packaged delivery retries a failure and retains saved state when reopened',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPackagedScenario(page, 'precise-literature-search', 'delivery', '保存失败后重试')
      await page.getByRole('button', { name: '选择保存位置', exact: true }).click()
      await page.getByRole('button', { name: '保存全文', exact: true }).click()
      await expect(
        page
          .getByTestId('literature-delivery-body')
          .getByText('保存操作未完成，请检查目标目录后重试。')
      ).toBeVisible()
      await page.getByRole('button', { name: '保存全文', exact: true }).click()
      await expect(page.getByText('全文保存完成', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '选择保存位置', exact: true }).click()
      await expect(page.getByTestId('literature-delivery-dialog')).toBeVisible()
      await expect(page.getByText('全文保存完成', { exact: true })).toBeVisible()
    } finally {
      await browser.close()
    }
  }
)

test(
  'packaged delivery keeps conflict open until a version is chosen',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPackagedScenario(
        page,
        'precise-literature-search',
        'delivery',
        '保存冲突后选择版本'
      )
      await page.getByRole('button', { name: '选择保存位置', exact: true }).click()
      await page.getByRole('button', { name: '保存全文', exact: true }).click()
      await expect(page.getByTestId('delivery-version-conflicts')).toBeVisible()
      await page.getByRole('combobox', { name: '选择《样例：长上下文论文》的版本处理方式' }).click()
      await page.getByRole('option', { name: '跳过本次版本' }).click()
      await page.getByRole('button', { name: '重试未完成项', exact: true }).click()
      await expect(page.getByText('已按选择跳过本次版本，未新增保存文件')).toBeVisible()
    } finally {
      await browser.close()
    }
  }
)

test(
  'packaged result details retain focus through asynchronous menu and admission',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPackagedScenario(page, 'agentic-search', 'details')
      const row = page.getByTestId('search-paper-sample-0')
      await row.click()
      await expect(row).toHaveAttribute('data-active', 'true')
      await row.getByRole('checkbox').check()
      await page.getByTestId('join-library-trigger').first().click()
      await expect(page.getByRole('menuitem', { name: '直接加入', exact: true })).toBeVisible()
      await expect(row).toHaveAttribute('data-active', 'true')
      await page.getByRole('menuitem', { name: '直接加入', exact: true }).click()
      await expect(page.getByTestId('literature-joined').first()).toBeVisible()
      await expect(row).toHaveAttribute('data-active', 'true')
    } finally {
      await browser.close()
    }
  }
)

test(
  'review result preview covers citations, evidence limits, checks and body navigation',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPackagedScenario(page, 'literature-review', 'review')
      await expect(
        page.getByText('1. 样例：长上下文信息利用 · Example Author · 2024', { exact: true })
      ).toBeVisible()
      await expect(page.getByText('样例限制：仅获得摘要，不用于支持具体实验数值。')).toBeVisible()
      await page.getByRole('button', { name: '查看引用核对状态' }).click()
      await expect(page.getByText('样例：一篇论文只有摘要证据，需要补读全文。')).toBeVisible()
      await page.getByRole('button', { name: '打开正文', exact: true }).click()
      assert.deepEqual(await page.evaluate('window.previewCalls'), [
        { action: 'open-artifact', values: { artifactId: 'sample-body' } },
      ])
    } finally {
      await browser.close()
    }
  }
)

test(
  'download preview shows an open failure and allows the same paper to retry',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await openPackagedScenario(
        page,
        'precise-literature-search',
        'downloads',
        '打开全文失败后重试'
      )
      await page.getByRole('button', { name: '打开全文', exact: true }).click()
      await expect(
        page.getByText('此全文暂不可用。如果文献已删除，可在保存卡中勾选加入文献库后恢复。')
      ).toBeVisible()
      await page.getByRole('button', { name: '打开全文', exact: true }).click()
      await expect(
        page.getByText('此全文暂不可用。如果文献已删除，可在保存卡中勾选加入文献库后恢复。')
      ).toHaveCount(0)
      assert.deepEqual(await page.evaluate('window.previewCalls'), [
        { action: 'open-fulltext', values: { paperId: 'sample-0' } },
        { action: 'open-fulltext', values: { paperId: 'sample-0' } },
      ])
    } finally {
      await browser.close()
    }
  }
)

for (const name of BUILTIN_PACKAGES) {
  test(
    `${name} renders every packaged preview without runtime errors`,
    { timeout: 60_000 },
    async () => {
      const directory = path.join(PACKAGE_ROOT, name)
      const descriptor = JSON.parse(
        readFileSync(path.join(directory, '.scholarseed-plugin.json'), 'utf8')
      )
      const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      try {
        for (const component of descriptor.components) {
          const page = await browser.newPage()
          const errors: string[] = []
          page.on('pageerror', (error) => errors.push(error.message))
          await openPackagedScenario(page, name, component.id)
          if (component.public && component.slot === 'literature.selection') {
            await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
            await expect(page.frameLocator('iframe').locator('#root')).not.toBeEmpty()
          } else await expect(page.locator('#root')).not.toBeEmpty()
          assert.deepEqual(errors, [], `${name}/${component.id}`)
          await page.close()
        }
      } finally {
        await browser.close()
      }
    }
  )
}

test(
  'preview HIL failure can retry but unknown and stale outcomes cannot resubmit',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'choose',values:{answers:['继续检索']}},'*')">继续检索</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=interaction',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await page.getByRole('button', { name: '失败重试', exact: true }).click()
      await expect
        .poll(async () => {
          assert.deepEqual(errors, [])
          return page.locator('iframe').count()
        })
        .toBe(1)
      await page.frameLocator('iframe').getByRole('button', { name: '继续检索' }).click()
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'failed')
      await expect(page.getByText('sample_failure', { exact: false })).toBeVisible()
      await expect(page.getByTestId('hil-retry')).toHaveCount(0)
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      await expect(page.getByText('继续检索', { exact: true })).toBeVisible()
      for (const name of ['结果未知', '请求过期']) {
        await page.getByRole('button', { name, exact: true }).click()
        await page.frameLocator('iframe').getByRole('button', { name: '继续检索' }).click()
        await page.getByRole('button', { name: '确认', exact: true }).click()
        await expect(page.getByRole('button', { name: '确认', exact: true })).toHaveCount(0)
        await expect(page.getByTestId('hil-retry')).toHaveCount(0)
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'cancelled preview responses retain cancellation semantics including after failed retry',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      for (const mode of ['action-cancel', 'action-cancel-retry']) {
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{}},'*')">取消阅读</button><p id="status"></p><script>addEventListener('message', event => { if (event.data.state) document.getElementById('status').textContent = event.data.state.status; })</script>`,
          })
        })
        await page.goto(
          new URL(
            `/components/business/plugin.render.fixture.html?mode=${mode}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
        await page.evaluate('window.fixture.resolve()')
        await expect(page.frameLocator('iframe').locator('#status')).toHaveText('pending')
        await page.frameLocator('iframe').getByRole('button', { name: '取消阅读' }).click()
        await expect.poll(() => errors).toEqual([])
        if (mode === 'action-cancel-retry') {
          await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'failed')
          await expect(page.getByText(/sample_failure/)).toBeVisible()
          await page.getByTestId('hil-retry').click()
        }
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'cancelled')
        await expect(page.frameLocator('iframe').locator('#status')).toHaveText('cancelled')
        await expect(page.getByTestId('hil-retry')).toHaveCount(0)
        await expect(page.getByText(/plugin_preview_failed/)).toHaveCount(0)
        await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
        await page.getByRole('button', { name: '重置预览', exact: true }).click()
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'pending')
        await page.close()
      }
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'installation cards keep preview hidden across conversation timer renders',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<input aria-label="阅读目标">',
        })
      )
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installation',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByTestId('plugin-installation-card')).toBeVisible()
      await expect(page.getByRole('button', { name: '对话交互预览', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '安装到书深', exact: true })).toBeEnabled()
      const before = await page.evaluate(
        'window.fixture.requests.filter(request => request.operation === "plugin-preview").length'
      )
      await page.waitForTimeout(2200)
      const after = await page.evaluate(
        'window.fixture.requests.filter(request => request.operation === "plugin-preview").length'
      )
      assert.equal(after, before)
      assert.equal(after, 0)
      await expect(page.locator('iframe')).toHaveCount(0)
      await page.getByRole('button', { name: '安装到书深', exact: true }).click()
      await expect(page.getByTestId('skill-add-modal')).toBeVisible()
      await expect(page.getByRole('button', { name: '对话交互预览', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '授权并安装', exact: true })).toBeEnabled()
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'generated plugin installation card returns only the host receipt',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installation',
          server.resolvedUrls!.local[0]
        ).href
      )
      await page.getByRole('button', { name: '安装到书深', exact: true }).click()
      await expect(page.getByTestId('skill-add-modal')).toBeVisible()
      await page.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      await expect(page.getByRole('status')).toHaveText('安装成功')
      const calls = (await page.evaluate('window.fixture.requests')) as Array<
        Record<string, unknown>
      >
      assert.ok(calls.some((call) => call.operation === 'plugin-confirm'))
      const response = calls.find((call) => call.answers) as { answers: Record<string, string> }
      assert.deepEqual(JSON.parse(response.answers.question), {
        name: 'generated-plugin',
        version: '1.0.0',
        enabled: true,
        sha256: 'a'.repeat(64),
      })
      await expect(page.getByTestId('hil-retry')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'skipped installation remains actionable and failed installation can retry without another answer',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=installation&fail-install=1',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('status')).toContainText('尚未安装')
      await page.getByRole('button', { name: 'generated-plugin · 1.0.0', exact: true }).click()
      await page.getByRole('button', { name: '暂不安装', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('已跳过安装')
      await expect(page.getByText('已取消任务', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '安装到书深', exact: true }).click()
      await page.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('安装失败')
      await page.getByRole('button', { name: '重试安装', exact: true }).click()
      await page.getByRole('button', { name: '授权并安装', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('安装成功')
      await expect(page.getByText('安装目录', { exact: false })).toBeVisible()
      const calls = (await page.evaluate('window.fixture.requests')) as Array<
        Record<string, unknown>
      >
      assert.equal(calls.filter((call) => call.cancelled).length, 1)
      assert.equal(calls.filter((call) => call.answers).length, 0)
      assert.equal(calls.filter((call) => call.operation === 'plugin-confirm').length, 2)
      assert.ok(
        calls.some((call) => call.operation === 'plugin-delivery' && call.action === 'directory')
      )
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'packaged outline renders real descriptions and proposes original options only',
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      const scenario = JSON.parse(readFileSync(path.join(REVIEW_PACKAGE, 'outline.json'), 'utf8'))
      await page.route('http://plugin.test/**', (route) => {
        const asset = new URL(route.request().url()).pathname.slice(1)
        return route.fulfill(
          asset
            ? {
                body: readFileSync(path.join(REVIEW_PACKAGE, asset)),
                contentType: asset.endsWith('.js') ? 'text/javascript' : 'text/css',
              }
            : { body: '<div id="root"></div>', contentType: 'text/html' }
        )
      })
      await page.goto('http://plugin.test/')
      await page.evaluate(
        (data) => {
          const fixture = {
            data,
            actions: [] as { action: string; values: Record<string, unknown> }[],
            listener: null as ((state: unknown) => void) | null,
          }
          Object.assign(window, {
            fixture,
            plugin: {
              onState(listener: (state: unknown) => void) {
                fixture.listener = listener
                listener({ data, status: 'pending', language: 'zh', slot: 'literature.outline' })
              },
              submit(action: string, values: Record<string, unknown>) {
                fixture.actions.push({ action, values })
                Object.assign(fixture.data, values)
                fixture.listener?.({
                  data: fixture.data,
                  status: 'pending',
                  language: 'zh',
                  slot: 'literature.outline',
                })
              },
              async setCopyContent(content: unknown) {
                Object.assign(window, { previewCopy: content })
                return { saved: true }
              },
            },
          })
        },
        { ...scenario.data, options: scenario.interaction.questions[0].options }
      )
      await loadOfficialRuntime(page)
      await page.addScriptTag({ url: 'http://plugin.test/cards.js' })
      await page.getByText(scenario.data.sections[0].title, { exact: true }).click()
      await expect(
        page.getByText(scenario.data.sections[0].description, { exact: true })
      ).toBeVisible()
      await page.getByRole('radio').first().check()
      await expect(page.getByRole('radio').first()).toBeChecked()
      const option = scenario.interaction.questions[0].options[0]
      await expect(page.getByRole('radio').first()).toHaveAttribute(
        'aria-label',
        `${option.label} ${option.description}`
      )
      assert.deepEqual(await page.evaluate('window.fixture.actions'), [
        {
          action: 'choose',
          values: { answers: [scenario.interaction.questions[0].options[0].label] },
        },
      ])
      await page.evaluate(
        'window.fixture.listener({data:window.fixture.data,status:"resolved",language:"zh",slot:"literature.outline"})'
      )
      await expect(page.getByRole('radio').first()).toBeDisabled()
    } finally {
      await browser.close()
    }
  }
)
test(
  'preview action confirmation can retry a failed response without resetting input',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{selected_paper_ids:['paper']}},'*')">选择论文</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=action-retry',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'failed')
      await page.getByTestId('hil-retry').click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      await expect(page.getByRole('button', { name: '确认选择', exact: true })).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'StrictMode replay keeps the owner lease live through selection and confirmation',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'fixture-lease',action:'select',values:{selected_paper_ids:['paper']}},'*')">选择论文</button>`,
        })
      )
      await page.goto(
        new URL('/components/business/plugin.render.fixture.html', server.resolvedUrls!.local[0])
          .href
      )
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
      await page.getByRole('button', { name: '确认', exact: true }).click()
      await expect(page.getByTestId('status')).toHaveText('resolved')
      assert.deepEqual(await page.evaluate('window.fixture.released'), [])
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)

test(
  'fixed binding survives catalog changes and generic component submission resolves the waiting request',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) => {
        const lease = new URL(route.request().url()).searchParams.get('lease')
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{method:'evidence'}},'*')">使用方法</button>`,
        })
      })
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=generic',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('scholarseed:skill-catalog-changed', { detail: { name: 'fixture' } })
        )
      )
      await expect(page.locator('iframe')).toHaveCount(1)
      await page.frameLocator('iframe').getByRole('button', { name: '使用方法' }).click()
      await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
      assert.deepEqual(
        await page.evaluate('window.fixture.requests.filter(request => request.answers)'),
        [
          {
            answers: {
              question: JSON.stringify({ action: 'select', values: { method: 'evidence' } }),
            },
          },
        ]
      )
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.find(request => request.operation === "plugin-open").reference'
        ),
        {
          plugin: 'fixture',
          component: 'selection',
          fingerprint: 'fixture',
          binding: 'fixed-binding',
        }
      )
      assert.deepEqual(await page.evaluate('window.fixture.released'), ['lease-0'])
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'public component persists its selection and restores the same binding after remount',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=public-bound',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await page.getByRole('radio', { name: '方法二', exact: true }).check()
      await expect(page.getByTestId('public-selection')).toHaveText('方法二')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").map(request=>({values:request.values,revision:request.expected_revision}))'
        ),
        [{ values: { answers: ['方法二'] }, revision: 0 }]
      )
      await page.getByRole('textbox', { name: '说明' }).fill('保留科研范围')
      await expect
        .poll(() =>
          page.evaluate(
            'window.fixture.requests.filter(request => request.operation === "plugin-draft").length'
          )
        )
        .toBe(2)
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").at(-1).values'
        ),
        { answers: ['方法二'], text: '保留科研范围' }
      )
      await page.getByRole('button', { name: '重新挂载' }).click()
      await page.getByRole('button', { name: '重新挂载' }).click()
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(4)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.getByRole('radio', { name: '方法二', exact: true })).toBeChecked()
      await expect(page.getByTestId('public-selection')).toHaveText('方法二')
      await expect(page.getByRole('textbox', { name: '说明' })).toHaveValue('保留科研范围')
      await expect(page.locator('iframe')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'legacy host-v1 selection retains existing choices, persists changes and restores its pinned binding',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=legacy-bound',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.getByRole('checkbox', { name: /旧论文一\s*旧证据说明/ })).toBeChecked()
      await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toHaveAttribute(
        'aria-checked',
        'mixed'
      )
      await page.getByRole('checkbox', { name: '旧论文二', exact: true }).check()
      await expect(page.getByTestId('legacy-selection')).toHaveText('one,two')
      assert.deepEqual(
        await page.evaluate(
          'window.fixture.requests.filter(request => request.operation === "plugin-draft").map(request => ({reference:request.reference,values:request.values,revision:request.expected_revision}))'
        ),
        [
          {
            reference: {
              plugin: 'host',
              fingerprint: 'host-v1',
              component: 'literature.selection',
              binding: 'legacy-binding',
            },
            values: { selected_paper_ids: ['one', 'two'] },
            revision: 0,
          },
        ]
      )
      await page.getByRole('button', { name: '重新挂载', exact: true }).click()
      await page.getByRole('button', { name: '重新挂载', exact: true }).click()
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(4)
      await page.evaluate('window.fixture.resolve()')
      await expect(page.getByRole('checkbox', { name: /旧论文一\s*旧证据说明/ })).toBeChecked()
      await expect(page.getByRole('checkbox', { name: '旧论文二', exact: true })).toBeChecked()
      await expect(page.getByRole('checkbox', { name: '全选', exact: true })).toBeChecked()
      assert.ok(
        (
          (await page.evaluate(
            'window.fixture.requests.filter(request => request.operation === "plugin-open")'
          )) as { reference: { fingerprint: string; binding: string } }[]
        ).every(
          (request) =>
            request.reference.fingerprint === 'host-v1' &&
            request.reference.binding === 'legacy-binding'
        )
      )
      await expect(page.locator('iframe')).toHaveCount(0)
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'legacy host-v1 preview without an existing binding cannot render a selection fallback',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
    try {
      const page = await browser.newPage()
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=legacy-unbound',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('checkbox')).toHaveCount(0)
      await expect(page.locator('iframe')).toHaveCount(0)
      assert.deepEqual(await page.evaluate('window.fixture.requests'), [])
    } finally {
      await browser.close()
      await server.close()
    }
  }
)

test(
  'read-only preview exposes local details without a pretend confirmation',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      configFile: false,
      root: ROOT,
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
      const page = await browser.newPage()
      await page.route('**/guest.html?*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<details><summary>Paper</summary><p>Evidence</p></details><script>addEventListener("message", () => document.querySelector("details").open = false)</script>',
        })
      )
      await page.goto(
        new URL(
          '/components/business/plugin.render.fixture.html?mode=readonly',
          server.resolvedUrls!.local[0]
        ).href
      )
      await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
      await page.evaluate('window.fixture.resolve()')
      await page.frameLocator('iframe').getByText('Paper', { exact: true }).click()
      await expect(page.frameLocator('iframe').getByText('Evidence')).toBeVisible()
      await expect(page.getByRole('button', { name: '确认选择', exact: true })).toHaveCount(0)
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
      await page.getByRole('button', { name: '重置预览' }).click()
      await expect(page.frameLocator('iframe').getByText('Evidence')).toBeHidden()
      await page.getByRole('button', { name: '开关预览' }).click()
      await expect.poll(() => page.evaluate('window.fixture.released.length')).toBe(2)
    } finally {
      await browser?.close()
      await server.close()
    }
  }
)

for (const mode of ['installed', 'candidate']) {
  test(
    `${mode} preview owns StrictMode generations, late completion and actual close`,
    { timeout: 60_000 },
    async () => {
      const server = await createServer({
        configFile: false,
        root: ROOT,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
        const page = await browser.newPage()
        await page.route('**/guest.html?*', (route) => {
          const lease = new URL(route.request().url()).searchParams.get('lease')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<button onclick="parent.postMessage({channel:'${PLUGIN_MESSAGE_CHANNEL}',lease:'${lease}',action:'select',values:{selected_paper_ids:['paper']}},'*')">选择论文</button>`,
          })
        })
        await page.goto(
          new URL(
            `/components/business/plugin.render.fixture.html?mode=${mode}`,
            server.resolvedUrls!.local[0]
          ).href
        )
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(2)
        await page.evaluate('window.fixture.resolve()')
        await page.frameLocator('iframe').getByRole('button', { name: '选择论文' }).click()
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'resolved')
        assert.deepEqual(await page.evaluate('window.fixture.released'), ['lease-0'])
        await page.getByRole('button', { name: '重置预览' }).click()
        await expect(page.getByTestId('hil-card')).toHaveAttribute('data-hil-state', 'pending')
        await page.evaluate('window.fixture.revoke()')
        await expect(page.getByRole('alert')).toBeVisible()
        await page.getByRole('button', { name: '开关预览' }).click()
        assert.deepEqual(await page.evaluate('window.fixture.released'), ['lease-0', 'lease-1'])
        await page.getByRole('button', { name: '开关预览' }).click()
        await expect.poll(() => page.evaluate('window.fixture.created.length')).toBe(4)
        await page.getByRole('button', { name: '开关预览' }).click()
        await page.evaluate('window.fixture.resolve()')
        await expect.poll(() => page.evaluate('window.fixture.released.length')).toBe(4)
        await expect(page.locator('iframe')).toHaveCount(0)
      } finally {
        await browser?.close()
        await server.close()
      }
    }
  )
}
